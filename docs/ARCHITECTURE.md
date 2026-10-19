# 架构与实现细节

本文深入讲解各模块的设计决策与实现细节，配合源码阅读。

---

## 一、为什么需要协议转换网关

三个平台的 API 协议完全不同：

| 平台 | 协议类型 | 关键差异 |
|---|---|---|
| WorkBuddy 国内版 | 原生 OAuth + REST | 标准 JSON，可直接用 10Router 内置适配 |
| WorkBuddy 国际版 | 私有 SSE | 需要会话三件套头、必须流式、delta 带空占位符 |
| Trae CN | SOLO 私有协议 | 嵌套事件流、content 需要二次 JSON 解析、需要完整设备指纹头 |

10Router 只内置了国内版的适配器，另两个必须自己写协议转换。

---

## 二、WorkBuddy 国际版网关实现

### 2.1 会话三件套

国际版对每个请求强制要求三个 UUID 头，缺任何一个都会被拒：

```javascript
'X-Conversation-ID': randomUUID(),
'X-Conversation-Request-ID': randomUUID(),
'X-Conversation-Message-ID': randomUUID(),
```

这三者必须每次请求都不同，不能复用。

### 2.2 强制流式

国际版 API **只支持 `stream: true`**，传入 `stream: false` 会返回错误。
所以网关内部始终请求流式，若客户端要非流式，则网关自己聚合 SSE 再返回。

```javascript
b.stream = true;
b.stream_options = { include_usage: true };
```

`include_usage: true` 是必须的，否则拿不到 `credit` 消耗量。

### 2.3 delta 空占位符清洗

上游返回的 delta 携带大量空字段，某些客户端（如 DSH）会因此报错：

```json
{"delta": {"content": "好", "reasoning_content": null, "tool_calls": [], "extra_fields": {}}}
```

网关需要清洗：

```javascript
const EMPTY_KEYS = ['function_call', 'refusal', 'tool_calls', 'extra_fields', 'reasoning_content'];

for (const k of EMPTY_KEYS) {
  if (k === 'tool_calls') {
    if (Array.isArray(c.delta[k]) && c.delta[k].length === 0) delete c.delta[k];
  } else if (c.delta[k] === null || c.delta[k] === '') {
    delete c.delta[k];
  }
}
```

### 2.4 非流式聚合

客户端要非流式时，网关必须把 SSE 拼成完整响应：

```javascript
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split('\n');
  buf = lines.pop();                       // 保留不完整的最后一行
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const obj = JSON.parse(line.slice(5).trim());
    content += obj.choices?.[0]?.delta?.content || '';
    if (obj.usage) usage = obj.usage;
  }
}
```

---

## 三、Trae SOLO 网关实现

### 3.1 SOLO 协议的嵌套事件

Trae 的 SSE 事件有多层结构，需要逐层解包：

```javascript
// 第 1 层：直接字段
if (typeof ev.response === 'string') contentBuf += ev.response;
if (typeof ev.reasoning_content === 'string') reasoningBuf += ev.reasoning_content;

// 第 2 层：content 里套 JSON 字符串
if (typeof ev.content === 'string' && ev.content) {
  const inner = JSON.parse(ev.content);
  if (typeof inner.response === 'string') contentBuf += inner.response;
  if (typeof inner.reasoning_content === 'string') reasoningBuf += inner.reasoning_content;
}
```

漏掉任何一层都会导致内容丢失。

### 3.2 usage 的位置

Trae 的 usage 不是标准的 `{usage: {...}}` 嵌套，而是顶层平铺字段：

```javascript
if (typeof ev.usage === 'object' && ev.usage !== null) {
  usage = ev.usage;
} else if (typeof ev.prompt_tokens === 'number' || typeof ev.completion_tokens === 'number') {
  usage = {
    prompt_tokens: Number(ev.prompt_tokens ?? 0),
    completion_tokens: Number(ev.completion_tokens ?? 0),
    total_tokens: Number(ev.total_tokens ?? 0),
    // Trae 特有：推理 token 与缓存命中
    reasoning_tokens: ev.reasoning_tokens,
    cached_tokens: ev.cache_read_input_tokens,
  };
}
```

### 3.3 设备指纹头（缺一不可）

```javascript
{
  Authorization: `Cloud-IDE-JWT ${token}`,
  'X-Ide-Token': token,
  'X-Cloudide-Token': token,
  'x-uid': uid,
  'x-plugin-channel': 'icube-ai',
  'User-Agent': 'Trae/1.0',
  'x-app-id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
  'x-app-version-code': '20260716',
  'x-ide-version-code': '20260716',
  'x-custom-trace-id': traceId,
  'x-flow-traceparent': `04-${traceId}-${traceId.slice(0,16)}-01`,
  'request-traffic-type': 'prod',
}
```

### 3.4 未知模型必须返回 404（最重要）

**这是本项目最关键的一个修复。**

Trae 上游对不存在的模型名返回：

```json
HTTP 200 (168ms)
{
  "choices": [{"message": {"content": null}, "finish_reason": "stop"}],
  "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
}
```

`usage` 全为 0 是铁证——请求根本没提交给模型。

**危害**：上层 10Router 的 fallback 看到 HTTP 200 就认为成功，不会切换到下一个模型，用户最终收到空回复。

**修复**：转发前校验模型名，未知模型返回标准 404：

```javascript
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

修复后效果：

```
kimi-k2.8-preview  → 404 (35ms)   ✓ 正确触发降级
space-bunny        → 404 (4ms)    ✓
glm-5.3-flash      → 200 "好" 240 tokens  ✓ 正常模型不受影响
```

---

## 四、配额采集的特殊处理

### 4.1 10Router 的 provider 白名单

10Router 内部对配额查询有硬编码白名单（源码 `chunks/5757.js`）：

```javascript
let d = "oauth" === a.authType,
    e = ("apikey" === a.authType || "api_key" === a.authType) && m.jO.includes(a.provider),
    i = "cookie" === a.authType && m.wm?.includes(a.provider);

if (!d && !e && !i)
  return { status: 200, body: { message: "Usage not available for this connection" } };
```

`openai-compatible-chat-*` 类型不满足任何条件，所以**永远拿不到配额**。

验证：

```
GET /api/usage/quotas
→ 只返回 3 个 codebuddy-cn 连接，Trae 和国际版完全不出现
```

### 4.2 三平台各自的采集方式

#### 国内版：复用 10Router

它已经实现好了，直接用：

```javascript
const q = await fetch(`${BASE}/api/usage/quotas`, { headers: { Cookie: ck } });
// 每个连接返回 quotas 数组，含 name/used/total/resetAt
```

#### Trae：官方积分接口

```javascript
POST https://api.trae.cn/trae/api/v2/pay/web_user_ent_usage
Body: {}

Response:
{
  "usage_summary": {
    "total_amount": 900,
    "consumed_amount": 558.03,
    "consumption_ratio": 0.62
  },
  "user_entitlement_pack_list": [
    {
      "display_desc": "免费",
      "entitlement_base_info": {
        "entitlement_id": "free_utc202610_3141768880068199",
        "end_time": 1793462399        // Unix 秒，积分过期时间
      }
    }
  ]
}
```

**注意**：`entitlement_base_info.quota` 字段里是 `{enable_solo_agent: true}` 这类功能开关，**不是数值余额**，不能拿来算剩余。

#### 国际版：billing 资源接口

```javascript
POST https://www.workbuddy.ai/v2/billing/meter/get-user-resource
Headers: {
  Authorization: `Bearer ${token}`,
  'X-User-Id': uid,
  'X-Domain': 'www.workbuddy.ai',
}
Body: {
  PageNumber: 1,
  PageSize: 100,
  ProductCode: 'p_tcaca',
  Status: [0, 3],
  PackageEndTimeRangeBegin: '2026-10-19 00:00:00',
  PackageEndTimeRangeEnd: '2027-11-16 00:00:00',
}

Response:
{
  "code": 0,
  "data": {
    "Response": {
      "Data": {
        "TotalCount": 4,
        "Accounts": [
          {
            "CycleCapacitySize": 1000,
            "CycleCapacityRemain": 380,
            "CycleCapacityUsed": 620,
            "PackageEndTime": "2026-10-29 19:59:59"
          }
        ]
      }
    }
  }
}
```

**关键**：国际版必须用 `www.workbuddy.ai` 域名，用 `copilot.tencent.com` 会返回 401。

---

## 五、智能调度的实现

### 5.1 分层策略

```javascript
function rank(id, rates, prefixHealth) {
  const rate = rates.get(id);
  const h = prefixHealth[id.split('/')[0]];

  const known = !!h && h.error == null;
  const exhausted = known && (h.limitReached || h.active === false || h.remaining <= 0);
  const expiring = known && h.expiring > 0;

  let tier;
  if (exhausted) tier = 9;        // 排最后
  else if (rate === 0) tier = 0;  // 免费优先
  else if (expiring) tier = 1;    // 临期次之
  else tier = 2;                  // 正常按价格

  return { id, rate, tier, exhausted, expiring, earliestExpiry: h?.earliestExpiry };
}
```

### 5.2 排序

```javascript
ranked.sort((a, b) => {
  if (a.tier !== b.tier) return a.tier - b.tier;
  // 临期层内：越早过期越优先（先花掉会过期的积分）
  if (a.tier === 1 && a.earliestExpiry && b.earliestExpiry) {
    return a.earliestExpiry - b.earliestExpiry;
  }
  if (a.rate !== b.rate) return a.rate - b.rate;
  return 0;
});
```

### 5.3 写回 10Router

10Router 的 combo 用 `models` 数组顺序决定 fallback 优先级：

```javascript
PUT /api/combos/<id>
{"models": ["最先试的", "其次", "最后"]}
```

所以「排序结果」直接写入即可生效。

### 5.4 关于「未知」的处理

初版有个 bug：把没有配额数据的平台（Trae/国际版）当成「额度耗尽」，导致它们被排到最后。

修复：引入 `known` 标志，未知不等于耗尽。

```javascript
const known = !!h && h.error == null;
const exhausted = known && (...);   // 只有 known 时才判断耗尽
// 未知的仍按价格参与排序（tier=2）
```

---

## 六、账号显示名解析

### 6.1 问题

10Router 把 token 加密存储：

```
enc:v1:IcxbNfXHqk4m5Il4:MVNsScvJ5zLVtJ5hp6aeXw:0HLP0AS9HWMasP8CkD2b7NL8xWeJwWkjz...
```

无法解码出 uid。而监控台需要显示用户自定义的连接名（如 `wb-me`）。

### 6.2 解决方案：用到期时间关联

两边都有 token 到期时间：

- 10Router：`providerConnections.data.expiresAt`
- 账号目录：`credential.json` 的 `expiresAtMs`

它们来自同一份 token，所以值必然相同（或极接近）。

```javascript
// 10Router 侧
const at = Date.parse(d.expiresAt);
pool.push({ sec: Math.floor(at / 1000), name: r.name });

// 账号目录侧
const sec = Math.floor(a.exp / 1000);

// 容差匹配（token 刷新会造成 1~2 秒漂移）
let best = null, bestDiff = Infinity;
for (const r of pool) {
  const diff = Math.abs(r.sec - sec);
  if (diff < bestDiff) { bestDiff = diff; best = r; }
}
if (best && bestDiff <= 120) map.set(a.uid, best.name);
```

### 6.3 Trae 的特殊情况

**Trae 的 uid 位置不同**：

```javascript
// WorkBuddy：uid 在 JWT 的 sub
const uid = payload.sub;

// Trae：uid 在 credential.userId 或 JWT 的 data.id
const uid = c.userId || payload.data?.id;
```

Trae 的 JWT 结构：

```json
{
  "data": {
    "id": "3141768880068199",
    "source": "refresh_token",
    "type": "user"
  },
  "exp": 1793373696,
  "iat": 1792164096
}
```

没有 `iss` 和 `sub` 字段，所以按 `iss` 判断平台会漏掉 Trae。

---

## 七、签到去重机制

### 7.1 日记结构

```json
{
  "records": {
    "8d786f8e-...|2026-10-19": {
      "status": "already-claimed",
      "at": 1792370700157,
      "day": "2026-10-19"
    },
    "trae:3141768880068199|2026-10-19": {
      "status": "claimed",
      "at": 1792370700481,
      "day": "2026-10-19"
    }
  },
  "devices": {},
  "pauses": {}
}
```

### 7.2 状态机

```
未处理 → 查状态
         ├─ 已签到     → already-claimed（终态，不再提交）
         ├─ 活动未开放 → no-campaign（终态）
         └─ 未签到     → 提交领取
                        ├─ code=0        → claimed（终态）
                        ├─ 今天已签到    → already-claimed（终态）
                        ├─ code=403/429  → paused（进 pauses，需人工恢复）
                        └─ 网络超时      → uncertain（已提交但结果不明，不重试）
```

### 7.3 为什么只读查询重试、领取不重试

```javascript
// 只读查询：失败重试安全（幂等）
for (let i = 0; ; i++) {
  try { return await post('checkin-activity-status', a); }
  catch (e) { if (!e.transient || i >= 2) throw e; await sleep((i+1) * 2000); }
}

// 领取：只在明确未提交时才可重试，一旦提交就不能重试
submitted = true;
const result = await post('daily-checkin', a);
// 如果这里超时，状态记为 uncertain，绝不重试（避免重复领取）
```

---

## 八、10Router 侧的关键配置

### 8.1 combo 策略

```javascript
{
  comboStrategy: "fallback",        // 顺序降级（不是 round-robin）
  comboStickyRoundRobinLimit: 1,
  comboRetryOnEmpty: true,          // ⚠ 空响应自动切下一个，强烈建议开
  comboRetryOnEmptyLimit: 3,
}
```

**为什么必须开 `comboRetryOnEmpty`**：

Trae 的部分模型会返回 HTTP 200 但 `content: null`（内容被过滤或推理耗尽 token）。
不开这个开关，fallback 会把空响应当成功，用户收到空回复。

实测数据（`trsolo/deepseek-v4.1-flash`，各 4 次）：

```
effort=不传     成功 3/4 (75%)
effort=low      成功 4/4 (100%)
effort=medium   成功 2/4 (50%)
effort=high     成功 2/4 (50%)
```

对比其他来源同模型：`codebuddy-cn` 和 `wbai` 都是 4/4 100%。

### 8.2 修改设置

```javascript
PATCH /api/settings
{"comboRetryOnEmpty": true, "comboRetryOnEmptyLimit": 3}
```

---

## 九、DSH 接入的坑

### 9.1 reasoningEfforts 校验

DSH 源码（`dsh-llm-pi-ai/lib/index.js:576`）：

```javascript
for (const [level, wire] of declared) if (wire === null) {
  if (level !== "off") invalid(provider, `model "${entry.id}" reasoningEfforts.${level} needs the wire value dispatch should send; only "off" may leave it empty`);
}
```

**规则**：

| 写法 | 合法 | 原因 |
|---|---|---|
| `low: null` | ❌ | 非 off 必须有 wire value |
| `low: low` | ✅ | 发送 `reasoning_effort: "low"` |
| `off: null` | ✅ | off 是唯一允许空值的 |
| `reasoningEfforts: false` | ✅ | 声明不支持推理 |
| 不写该字段 | ✅ | 用上游默认 |

**最坑的地方**：一个模型写错，整个 provider 加载失败，所有模型从选择器里消失，报错信息是：

```
llm-pi-ai: provider "ten-router" model "auto-deepseek-v4-pro"
reasoningEfforts.low needs the wire value dispatch should send;
only "off" may leave it empty
```

看起来像单个模型的问题，实际影响整个 provider。

### 9.2 某些模型的 reasoning 必须显式传

实测发现：

```
codebuddy-cn/glm-5.1       不传 reasoning_effort → 400 (11150)
                           传 low/high 任意值    → 200 ✓

codebuddy-cn/glm-5.0-turbo 不传 → 400
                           传 off → 400（特殊！off 也不行）
                           传 minimal/low/high → 200 ✓
```

所以这两个模型配置里必须写 `reasoningEfforts`，且不能包含 `off`。

---

## 十、部署检查清单

启动前逐项确认：

```
[ ] Node.js ≥ 22（需要 node:sqlite）
[ ] 10Router 运行在 20128
[ ] 账号目录 ~/.dsh/multi-router/accounts/ 有有效 credential.json
[ ] 环境变量 ROUTER_PASSWORD 已设置
[ ] intl-gateway 启动成功（18996）
[ ] trae-gateway 启动成功（18997），/v1/models 有模型
[ ] monitor-server 启动成功（20129）
[ ] 计划任务已创建：
    [ ] WorkBuddy每日签到（10:05）
    [ ] Trae积分同步（每 10 分钟）
    [ ] 智能调度（每 30 分钟）
[ ] DSH 配置里 reasoningEfforts 全部合法
[ ] comboRetryOnEmpty = true
```

验证命令：

```bash
# 网关健康
curl http://127.0.0.1:18997/health
curl http://127.0.0.1:18996/health

# 模型列表
curl http://127.0.0.1:18997/v1/models

# 配额采集
node quota-collector.mjs

# 调度预览（只读）
node auto-dispatch.mjs plan

# 签到状态
node checkin-auto.mjs status
```
