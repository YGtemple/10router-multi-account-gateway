# 10Router 多账号聚合网关

> 把 WorkBuddy（国内版/国际版）、Trae CN 等多个 AI 平台的多个账号，聚合成一个 OpenAI 兼容 API。
> 自带智能调度（免费优先 → 临期优先 → 低价优先）、自动签到、积分实时同步、Web 监控台。

---

## 这个项目解决什么问题

你有多个 AI 编程平台的账号，每个平台都有：

- 独立的 API 协议（有的 OpenAI 兼容，有的私有）
- 独立的积分体系（有的按倍率扣，有的按月配额）
- 独立的签到奖励（每日 100 积分之类）
- 积分会过期（临期没用完就浪费）

手动管理这些非常痛苦。本项目提供一套完整方案：

| 痛点 | 解决方案 |
|---|---|
| 每个平台接口不同 | 统一封装成 OpenAI 兼容 API |
| 不知道哪个账号还有额度 | 实时采集三平台配额，统一展示 |
| 不知道用哪个模型最划算 | 智能调度按「免费 → 临期 → 低价」排序 |
| 忘记签到损失积分 | Windows 计划任务每天自动签到 |
| 积分过期浪费 | 临期积分优先使用 |
| 不知道钱花在哪 | Web 监控台按账号/模型统计用量 |

---

## 架构总览

```
                        ┌─────────────────────────────┐
                        │   DSH / Claude Code / 任意   │
                        │   OpenAI 兼容客户端          │
                        └──────────────┬──────────────┘
                                       │ OpenAI 协议
                                       ▼
                        ┌─────────────────────────────┐
                        │      10Router (20128)       │
                        │  ┌───────────────────────┐  │
                        │  │ 统一路由 auto-* 模型   │  │
                        │  │ kind: fallback        │  │
                        │  └───────────────────────┘  │
                        └───┬─────────┬─────────┬─────┘
                            │         │         │
              ┌─────────────┘         │         └─────────────┐
              ▼                       ▼                       ▼
    ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
    │ WorkBuddy 国内版  │   │  WorkBuddy 国际版 │   │     Trae CN      │
    │ codebuddy-cn     │   │  (intl-gateway)  │   │  (trae-gateway)  │
    │ 协议: 原生 OAuth  │   │  协议: 私有 SSE   │   │  协议: SOLO SSE  │
    └──────────────────┘   └──────────────────┘   └──────────────────┘
              │                       │                       │
              └───────────┬───────────┴───────────┬───────────┘
                          ▼                       ▼
              ┌───────────────────┐   ┌───────────────────────┐
              │  quota-collector  │   │    监控台 (20129)      │
              │  三平台配额采集     │   │  签到 / 积分 / 用量     │
              └─────────┬─────────┘   └───────────────────────┘
                        ▼
              ┌───────────────────┐
              │ auto-dispatch     │
              │ 按策略重排 combo   │
              └───────────────────┘
```

---

## 目录结构

```
07-WorkBuddy网关/
├── 核心网关
│   ├── intl-gateway.mjs        # WorkBuddy 国际版 → OpenAI 协议转换
│   ├── trae-gateway.mjs        # Trae CN → OpenAI 协议转换（含模型校验）
│   ├── quota-collector.mjs     # 三平台配额统一采集
│   └── account-names.mjs       # 账号显示名解析（连接名 ↔ 账号）
│
├── 智能调度
│   └── auto-dispatch.mjs       # 免费→临期→低价 重排统一路由
│
├── 签到
│   ├── checkin-auto.mjs        # WorkBuddy 国内 + Trae 自动签到（含日记去重）
│   └── sync-trae-quota.mjs     # Trae 积分推送到 10Router
│
├── 监控台
│   └── monitor-server.mjs      # Web 界面（签到/积分/用量）
│
├── 控制台
│   └── console.mjs             # 命令行总控制台
│
└── _测试脚本/                   # 170+ 个验证脚本（按需保留）
```

---

## 核心模块详解

### 1. 协议转换网关

#### WorkBuddy 国际版（`intl-gateway.mjs`）

国际版用私有 SSE 协议，需要转换成 OpenAI 格式：

```javascript
// 关键点：必须带 stream_options.include_usage 才能拿到 credit 消耗
b.stream_options = { include_usage: true };

// 解析 SSE 流
for (const line of buf.split('\n')) {
  if (!line.startsWith('data: ')) continue;
  const obj = JSON.parse(line.slice(6));
  if (obj.usage) usage = obj.usage;      // 含 credit 字段
  if (obj.choices?.[0]?.delta?.content) content += obj.choices[0].delta.content;
}
```

#### Trae CN（`trae-gateway.mjs`）

Trae 走 SOLO 私有协议，有两处必须注意：

**① 模型名校验（重要）**

Trae 网关对**不存在的模型名返回 HTTP 200 + `content: null`**，这会导致上游 fallback 逻辑误判为成功，最终用户收到空回复。

```javascript
// 修复：请求前校验模型是否在目录中
const known = list.find((m) => m.id === modelId);
if (!known) {
  log(`chat 未知模型: ${modelId}`);
  res.writeHead(404, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({
    error: {
      message: `unknown model "${modelId}": not in Trae catalog (${list.length} available)`,
      type: 'invalid_request_error',
      code: 'model_not_found',
      param: 'model',
    },
  }));
}
```

**证据**：修复前直连网关传假模型名：

```json
HTTP 200 (168ms)
{"choices":[{"message":{"content":null},"finish_reason":"stop"}],
 "usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}
```

`usage` 全为 0 是铁证——请求根本没提交给任何模型。

**② SOLO 事件流解析**

Trae 返回的是嵌套事件流，需要逐层提取：

```javascript
// 事件类型：content / reasoning_content / think / 其他
if (ev.type === 'content') contentBuf += ev.response;
else if (ev.type === 'reasoning_content') reasoningBuf += ev.response;
```

### 2. 配额采集（`quota-collector.mjs`）

**为什么不能只用 10Router 的 `/api/usage/quotas`？**

因为 10Router 内部有 provider 白名单限制：

```javascript
// 10Router 源码（chunks/5757.js）
let d = "oauth" === a.authType,                                    // 仅 OAuth 类型
    e = ("apikey" === a.authType) && m.jO.includes(a.provider);    // 或白名单内的 apikey
    i = "cookie" === a.authType && m.wm?.includes(a.provider);

if (!d && !e && !i)
  return { status: 200, body: { message: "Usage not available for this connection" } };
```

Trae 和 WorkBuddy 国际版都是 `openai-compatible-chat-*` 类型，**永远拿不到配额数据**。

所以必须自己采集三个平台：

| 平台 | 接口 | 认证 |
|---|---|---|
| WorkBuddy 国内 | 10Router `/api/usage/quotas`（它已实现） | 10Router 会话 |
| Trae CN | `POST https://api.trae.cn/trae/api/v2/pay/web_user_ent_usage` | `Cloud-IDE-JWT <token>` + 设备头 |
| WorkBuddy 国际版 | `POST https://www.workbuddy.ai/v2/billing/meter/get-user-resource` | `Bearer <token>` + `X-User-Id` |

**Trae 积分接口返回结构**：

```json
{
  "usage_summary": {
    "total_amount": 900,
    "consumed_amount": 558.03,
    "consumption_ratio": 0.62
  },
  "user_entitlement_pack_list": [
    { "display_desc": "免费", "entitlement_base_info": { "end_time": 1793462399 } },
    { "display_desc": "签到奖励", "entitlement_base_info": { "end_time": 1795070700 } }
  ]
}
```

`end_time` 是 Unix 秒，用于计算临期积分。

### 3. 智能调度（`auto-dispatch.mjs`）

**排序策略**：

```
优先级 0：免费模型（倍率 x0）
优先级 1：临期积分（默认 7 天内到期，越早到期越优先）
优先级 2：正常（按倍率从低到高）
优先级 9：额度耗尽 / 账号停用（排最后）
```

**实现关键**：把策略翻译成 combo 的 `models` 数组顺序。

10Router 的 `kind: fallback` 策略会按数组顺序逐个尝试，所以「数组顺序 = 优先级顺序」。

```javascript
ranked.sort((a, b) => {
  if (a.tier !== b.tier) return a.tier - b.tier;
  // 临期层内：越早过期越优先
  if (a.tier === 1 && a.earliestExpiry && b.earliestExpiry) {
    return a.earliestExpiry - b.earliestExpiry;
  }
  if (a.rate !== b.rate) return a.rate - b.rate;
  return 0;
});
```

**输出示例**：

```
auto-deepseek-v4.1-flash  ↻ 调整
  ★ wbai/deepseek-v4.1-flash        免费
  · trsolo/deepseek-v4.1-flash      按价 x0.06(余342)
  · codebuddy-cn/deepseek-v4.1-flash 按价 x0.11(余6033)
```

### 4. 自动签到（`checkin-auto.mjs`）

参考 `dsh-multi-router` 插件实现，覆盖两个平台：

#### WorkBuddy 国内版

```javascript
// ① 先查状态
const state = await post('checkin-activity-status', a);
if (state.data.today_checked_in === true) return { status: 'already-claimed' };
if (state.data.active === false) return { status: 'no-campaign' };

// ② 再提交领取
const result = await post('daily-checkin', a);
const claimed = [0, 200].includes(result?.code);
```

#### Trae CN

```javascript
// Trae 签到需要设备头，缺一不可
const headers = {
  Authorization: `Cloud-IDE-JWT ${token}`,
  'X-Ide-Token': token,
  'X-Cloudide-Token': token,
  'x-uid': String(uid),
  'x-plugin-channel': 'icube-ai',
  'x-app-id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
};

const status = await post('/trae/api/v2/ug/checkin_credits/status');
// 返回：{ checked_in: true, credits: 100, extra_credits: 100, enable: true }
```

**去重机制**：本地日记 `checkin-journal.json`

```json
{
  "records": {
    "uid|2026-10-19": { "status": "claimed", "at": 1792370700157, "day": "2026-10-19" }
  },
  "pauses": {}
}
```

同一天同一账号只提交一次，重启不重复。记录保留 30 天，损坏时备份后重建（不清空）。

### 5. 监控台（`monitor-server.mjs`）

**账号显示名解析**是个难点：

10Router 把 token 加密存储（`enc:v1:...`），无法解码出 uid。但账号目录的 `credential.json` 有明文 token。

**解决方案**：用 **token 到期时间**作为关联键。

```javascript
// 10Router 侧
const at = Date.parse(d.expiresAt);
byExpiry.push({ sec: Math.floor(at / 1000), name: r.name });

// 账号目录侧
const sec = Math.floor(a.exp / 1000);

// 容差 120 秒：token 刷新会让秒数有 1~2 秒漂移
let best = null, bestDiff = Infinity;
for (const r of byExpiry) {
  const diff = Math.abs(r.sec - sec);
  if (diff < bestDiff) { bestDiff = diff; best = r; }
}
if (best && bestDiff <= 120) map.set(a.uid, best.name);
```

**Trae 账号的 uid 位置特殊**：不在标准 JWT `sub` 字段，而在 `userId` 或 `payload.data.id`。

```javascript
uid: p.sub || c.userId || p.data?.id || n,
```

---

## 快速开始

### 前置要求

- Node.js ≥ 22（需要内置 `node:sqlite`）
- 10Router v1.5.1（`@techysy/10router`）
- Windows（计划任务部分）

### 1. 安装 10Router

```bash
npm i @techysy/10router
npx 10router cli.js --host 127.0.0.1 --port 20128
```

### 2. 导入账号

WorkBuddy 国内版账号需要从 DSH 插件的账号目录导入：

```bash
node import-cn-accounts.mjs
```

### 3. 启动网关

```bash
# 国际版
node intl-gateway.mjs 18996

# Trae
node trae-gateway.mjs 18997

# 监控台
node monitor-server.mjs 20129
```

或用总控制台一键启动：

```bash
node console.mjs
# 选 [1] 启动全部服务
```

### 4. 配置 Windows 计划任务

```powershell
# 每日签到（10:05）
Register-ScheduledTask -TaskName "WorkBuddy每日签到" `
  -Action (New-ScheduledTaskAction -Execute "node" -Argument "checkin-auto.mjs claim") `
  -Trigger (New-ScheduledTaskTrigger -Daily -At "10:05")

# Trae 积分同步（每 10 分钟）
Register-ScheduledTask -TaskName "10Router-Trae积分同步" `
  -Action (New-ScheduledTaskAction -Execute "node" -Argument "sync-trae-quota.mjs") `
  -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 10))

# 智能调度（每 30 分钟）
Register-ScheduledTask -TaskName "10Router智能调度" `
  -Action (New-ScheduledTaskAction -Execute "node" -Argument "auto-dispatch.mjs apply") `
  -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 30))
```

---

## DSH 接入配置

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 中配置 provider：

```yaml
- id: llm-pi-ai
  config:
    providers:
      ten-router:
        displayName: 10Router 聚合站
        api: openai-completions
        baseURL: http://127.0.0.1:20128/v1
        apiKeyEnv: TEN_ROUTER_KEY
        models:
          - id: auto-deepseek-v4.1-flash
            name: Deepseek-V4.1-Flash · 统一路由
            contextWindow: 1000000
            maxTokens: 131072
            input: [ text, image ]
            reasoningEfforts:
              low: low
              medium: medium
              high: high
```

### 推理档位配置规则（关键）

DSH 的 `reasoningEfforts` 校验非常严格（源码 `dsh-llm-pi-ai/lib/index.js:576`）：

```javascript
for (const [level, wire] of declared) if (wire === null) {
  if (level !== "off") invalid(provider, `model "${entry.id}" reasoningEfforts.${level} needs the wire value dispatch should send; only "off" may leave it empty`);
} else if (wire.length === 0) invalid(provider, `model "${entry.id}" reasoningEfforts.${level} must not be an empty string`);
```

**规则总结**：

| 写法 | 是否合法 | 说明 |
|---|---|---|
| `low: null` | ❌ 非法 | 非 off 档位必须有 wire value |
| `low: low` | ✅ 合法 | 发送 `reasoning_effort: "low"` |
| `off: null` | ✅ 合法 | off 是唯一允许空值的档位 |
| `reasoningEfforts: false` | ✅ 合法 | 声明该模型不支持推理 |
| 字段完全不写 | ✅ 合法 | 使用上游默认能力 |

**一个模型只要有一个档位写错，整个 provider 都会加载失败，模型列表全部消失。**

---

## 已踩过的坑（务必先读）

完整踩坑记录见另一个仓库：**[10router-gateway-lessons](https://github.com/YGtemple/10router-gateway-lessons)**

高频问题速查：

| 现象 | 根因 | 修复 |
|---|---|---|
| 模型列表全消失 | `reasoningEfforts.low: null` | 改为 `low: low` |
| 收到空回复但状态 200 | Trae 网关不校验模型名 | 加 404 校验 |
| Trae 积分不更新 | 同步脚本没定时跑 | 建计划任务 |
| 签到面板显示 uid | 没做连接名关联 | 用到期时间匹配 |
| 中文乱码 | `chcp 936` | 改 `chcp 65001` |
| 额度耗尽不切换 | 上游返 200 空内容 | 开 `comboRetryOnEmpty` |

---

## 关键配置参考

### 10Router 组合策略

```javascript
comboStrategy: "fallback",           // 顺序降级（不是轮询）
comboRetryOnEmpty: true,             // 空响应自动切下一个（重要！）
comboRetryOnEmptyLimit: 3,           // 最多切 3 次
comboStickyRoundRobinLimit: 1,
```

### 10Router 统一路由结构

```javascript
// GET /api/combos
{
  "name": "auto-deepseek-v4.1-flash",
  "kind": "fallback",
  "models": [
    "wbai/deepseek-v4.1-flash",           // 免费，最先试
    "trsolo/deepseek-v4.1-flash",         // x0.06
    "codebuddy-cn/deepseek-v4.1-flash"    // x0.11
  ]
}
```

**更新顺序**：

```bash
PUT /api/combos/<id>
Content-Type: application/json
{"models": ["新顺序的数组"]}
```

---

## 数据安全提醒

- **token 不要提交到 Git**：所有 token 存在 `~/.dsh/multi-router/accounts/*/credential.json`，不要放进仓库
- **监控台只监听 127.0.0.1**：不要暴露到公网
- **10Router 面板密码**：在 `INITIAL_PASSWORD` 环境变量设置，不要硬编码

---

## 已知限制

1. **积分过期参与调度依赖轮询**：本项目每 30 分钟重排一次，无法做到秒级响应
2. **WorkBuddy 国际版无签到**：官方接口返回 `active: false`，该平台确实没有签到活动
3. **Trae 部分模型输出不稳定**：`trsolo/deepseek-v4.1-flash` 实测有 25-50% 概率返回空内容，靠 `comboRetryOnEmpty` 兜底

---

## 相关项目

- [dsh-multi-router](https://github.com/AndroidSix/dsh-multi-router) — DSH 插件版多账号路由，本项目的签到逻辑参考了它
- [10Router](https://github.com/techysy/10router) — 底层的路由与协议转换框架

---

## License

MIT
