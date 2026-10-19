# 补丁说明：Trae `tools[].function.parameters` 必须是字符串

## 问题

任何带 `tools` 的请求返回 400：

```json
{
  "code": "bad_request",
  "message": "trae 400: {\"code\":4001,\"message\":\"bad request: json: cannot unmarshal object into Go struct field FunctionDefinition.tools.function.parameters of type string\"}"
}
```

## 根因

| 谁 | `parameters` 期望类型 |
|---|---|
| OpenAI 标准 | 对象 |
| Trae 上游 | **JSON 字符串** |

`trae-gateway.mjs` 原样透传 `input.tools`，导致 Go 反序列化失败。

## 修复

在 `trae-gateway.mjs` 中新增 `toSoloTools()` 函数，把 `parameters` 从对象转成字符串。

### 1) 在 `pickFunction()` 之后插入

```javascript
// Trae 上游要求 tools[].function.parameters 是【JSON 字符串】，
// 而 OpenAI 标准是【对象】。原样透传会报：
//   cannot unmarshal object into Go struct field FunctionDefinition.tools.function.parameters of type string
function toSoloTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = tools.map((t) => {
    // 兼容两种入参形式：
    //   { type:'function', function:{...} }
    //   { name, description, parameters }  （扁平形式）
    const fn = t?.function || t;
    if (!fn || typeof fn !== 'object') return null;
    const raw = fn.parameters;
    let params;
    if (typeof raw === 'string') {
      params = raw;                                  // 已是字符串，原样
    } else if (raw && typeof raw === 'object') {
      params = JSON.stringify(raw);                  // 对象 → 字符串
    } else {
      params = JSON.stringify({ type: 'object', properties: {} });
    }
    const item = {
      type: 'function',
      function: {
        name: String(fn.name || ''),
        description: String(fn.description || ''),
        parameters: params,
      },
    };
    if (fn.strict !== undefined) item.function.strict = fn.strict;
    return item;
  }).filter(Boolean);
  return out.length ? out : undefined;
}
```

### 2) 修改 `soloBody` 构造处

**修改前：**

```javascript
const fn = pickFunction(modelId, list);

const soloBody = {
  messages: toSoloMessages(input.messages),
  model: modelId,
  config_name: modelId,
  function: fn,
  stream: true,
  ...(Array.isArray(input.tools) ? { tools: input.tools } : {}),
  ...(typeof input.reasoning_effort === 'string' ? { reasoning_effort: input.reasoning_effort } : {}),
};
```

**修改后：**

```javascript
const fn = pickFunction(modelId, list);
const soloTools = toSoloTools(input.tools);

const soloBody = {
  messages: toSoloMessages(input.messages),
  model: modelId,
  config_name: modelId,
  function: fn,
  stream: true,
  ...(soloTools ? { tools: soloTools } : {}),
  ...(typeof input.reasoning_effort === 'string' ? { reasoning_effort: input.reasoning_effort } : {}),
};
```

## 验证结果

| 模型 | 结果 |
|---|---|
| `trsolo/glm-5.3-flash` + tools | 200，成功调用工具 |
| `trsolo/kimi-k2.6` + tools | 200，成功调用工具 |
| `codebuddy-cn/glm-5.3-flash` + tools | 200，调用 `get_weather` |
| `auto-glm-5.3-flash` + tools | 200，调用 `get_weather` |

## 详细分析

见经验仓库：**[TRAE-PROTOCOL.md](https://github.com/YGtemple/10router-gateway-lessons/blob/main/TRAE-PROTOCOL.md)**
