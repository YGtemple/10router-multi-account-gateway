#!/usr/bin/env node
/**
 * Trae SOLO 适配网关
 *
 * 把 Trae 的 SOLO 私有协议 (/api/agent/v3/llm_utils_chat) 转成标准 OpenAI Chat Completions。
 *
 * SOLO 协议要点（逆向自 dsh-multi-router）：
 *   - 端点:  https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat
 *   - 模型:  https://trae-api-cn.mchost.guru/api/ide/v1/get_detail_param  (POST {function})
 *   - 请求头: x-app-id + X-Ide-Token + X-Cloudide-Token + x-uid + trace 头
 *   - 请求体: { messages, model, config_name, function, stream:true }
 *             content 必须是 [{type:"text",text:"..."}]
 *             tools[].function.parameters 必须是【字符串】（不是对象）
 *   - 响应:  SSE，事件含 { response: "正文增量", reasoning_content: "思考增量", tool_calls }
 *
 * ⚠ 重要修复：Trae 上游对「不存在的模型名」返回 HTTP 200 + content:null + usage全0，
 *   这会让上层 fallback 误判为成功而不切换。本网关在转发前校验模型名，未知模型直接 404。
 *
 * ⚠ 重要修复：Trae 上游要求 tools[].function.parameters 是 JSON 字符串，
 *   而 OpenAI 标准是对象。原样透传会报 400:
 *     cannot unmarshal object into Go struct field FunctionDefinition.tools.function.parameters of type string
 *
 * 用法: node trae-gateway.mjs [port]
 */
import { readFileSync, readdirSync, statSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(HERE, 'logs');
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const LOG = join(LOG_DIR, 'trae-gateway.log');
const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  try { appendFileSync(LOG, line + '\n'); } catch {}
};

const PORT = Number(process.argv[2] || 18997);
const APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
const BASE = 'https://trae-api-cn.mchost.guru';
const CHAT_PATH = '/api/agent/v3/llm_utils_chat';
const MODELS_PATH = '/api/ide/v1/get_detail_param';

const ACC_DIR = join(homedir(), '.dsh', 'multi-router', 'accounts');

// ---------- 账号池 ----------
function loadAccounts() {
  const out = [];
  try {
    for (const n of readdirSync(ACC_DIR)) {
      const d = join(ACC_DIR, n);
      if (!statSync(d).isDirectory()) continue;
      const cf = join(d, 'credential.json');
      if (!existsSync(cf)) continue;
      let c;
      try { c = JSON.parse(readFileSync(cf, 'utf8')).credential; } catch { continue; }
      if (!c?.accessToken) continue;
      if (!/trae/.test(c.host || '')) continue;
      if ((c.expiresAtMs || 0) <= Date.now()) continue;
      out.push({ dir: n, token: c.accessToken, uid: c.userId, edition: c.edition, exp: c.expiresAtMs });
    }
  } catch (e) {
    log('loadAccounts error:', e.message);
  }
  // 按 userId 去重，保留最新
  const m = new Map();
  for (const a of out) {
    const prev = m.get(a.uid);
    if (!prev || a.exp > prev.exp) m.set(a.uid, a);
  }
  return [...m.values()];
}

let accounts = loadAccounts();
let rr = 0;
function nextAccount() {
  if (!accounts.length) return null;
  const a = accounts[rr % accounts.length];
  rr++;
  return a;
}

log(`加载 ${accounts.length} 个 Trae 账号`);
for (const a of accounts) {
  log(`  uid=${a.uid}  edition=${a.edition}  exp=${new Date(a.exp).toISOString().slice(0, 10)}`);
}

// ---------- 请求头 ----------
function buildHeaders(acct, profile = 'agent-task') {
  const requestId = randomUUID();
  const traceId = requestId.replaceAll('-', '').slice(0, 32);
  const common = {
    Authorization: `Cloud-IDE-JWT ${acct.token}`,
    'X-Ide-Token': acct.token,
    'x-plugin-channel': 'icube-ai',
    'User-Agent': 'Trae/1.0',
    'x-app-id': APP_ID,
    'x-app-version-code': '20260716',
    'x-ide-version-code': '20260716',
    'x-custom-trace-id': traceId,
    'x-flow-traceparent': `04-${traceId}-${traceId.slice(0, 16)}-01`,
    'request-traffic-type': 'prod',
    'Content-Type': 'application/json',
  };
  if (profile === 'model-detail') return { ...common, Accept: 'application/json' };
  if (profile === 'raw-chat') return { ...common, Accept: 'text/event-stream' };
  return {
    ...common,
    'X-Cloudide-Token': acct.token,
    'x-uid': acct.uid,
    'x-request-id': requestId,
    'x-trae-request-id': requestId,
    Accept: 'text/event-stream',
  };
}

// ---------- 模型目录 ----------
const DIRECTORY_FUNCTIONS = ['solo_work_remote', 'solo_work_lite', 'solo_agent_remote', 'chat_v3', 'solo_coder'];

let catalog = null;
let catalogAt = 0;
const CATALOG_TTL = 10 * 60 * 1000; // 10 分钟

async function fetchCatalog(force = false) {
  if (!force && catalog && Date.now() - catalogAt < CATALOG_TTL) return catalog;
  const acct = nextAccount();
  if (!acct) throw new Error('无可用 Trae 账号');

  const byId = new Map();
  for (const fn of DIRECTORY_FUNCTIONS) {
    try {
      const r = await fetch(`${BASE}${MODELS_PATH}`, {
        method: 'POST',
        headers: buildHeaders(acct, 'model-detail'),
        body: JSON.stringify({ function: fn, agent_type: null }),
        signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) continue;
      const j = await r.json();
      const list = Array.isArray(j?.config_info_list) ? j.config_info_list : [];
      for (const c of list) {
        const id = c?.config_name;
        if (!id || byId.has(id)) continue;
        const disp = c.display_config?.display_name || id;
        const details = Array.isArray(c.model_detail_list) ? c.model_detail_list : [];
        const d = details[0] || {};
        const cw = Number(d.prompt_max_tokens ?? c.context_window_tokens?.dev ?? 200000) || 200000;
        const mt = Number(d.max_tokens ?? 32000) || 32000;
        byId.set(id, { id, name: disp, contextWindow: cw, maxTokens: mt, function: fn });
      }
    } catch (e) {
      log(`catalog ${fn} 失败: ${e.message}`);
    }
  }
  if (!byId.size) throw new Error('模型目录为空');
  catalog = [...byId.values()];
  catalogAt = Date.now();
  log(`模型目录刷新: ${catalog.length} 个`);
  return catalog;
}

// ---------- 请求体转换 ----------
function toSoloMessages(messages) {
  return (messages || []).map((m) => {
    const role = m.role === 'developer' ? 'system' : m.role;
    let content = m.content;
    if (typeof content === 'string') {
      content = [{ type: 'text', text: content }];
    } else if (Array.isArray(content)) {
      content = content.map((p) => {
        if (typeof p === 'string') return { type: 'text', text: p };
        if (p?.type === 'text') return { type: 'text', text: String(p.text ?? '') };
        // 图片等保持原样
        return p;
      });
    } else {
      content = [{ type: 'text', text: '' }];
    }
    return { role, content };
  });
}

function pickFunction(modelId, catalogList) {
  const hit = catalogList.find((m) => m.id === modelId);
  return hit?.function || 'solo_work_remote';
}

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

// ---------- SOLO 事件 → OpenAI ----------
function makeChunk(id, model, delta, finish = null, usage = null) {
  const o = {
    id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  if (usage) o.usage = usage;
  return `data: ${JSON.stringify(o)}\n\n`;
}

// ---------- HTTP 服务 ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (url.pathname === '/health') {
    accounts = loadAccounts();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, accounts: accounts.length, models: catalog?.length || 0 }));
  }

  if (url.pathname === '/v1/models' && req.method === 'GET') {
    try {
      const list = await fetchCatalog();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        object: 'list',
        data: list.map((m) => ({
          id: m.id, object: 'model', owned_by: 'trae',
          name: m.name, context_window: m.contextWindow,
        })),
      }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: e.message } }));
    }
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    let input;
    try { input = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'invalid JSON' } }));
    }

    const wantStream = input.stream === true;
    const acct = nextAccount();
    if (!acct) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'no Trae account available' } }));
    }

    let list;
    try { list = await fetchCatalog(); } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: e.message } }));
    }

    const modelId = input.model || 'Doubao-Seed-2.1-Turbo';

    // ⚠ 关键修复1：模型名校验
    // 上游对未知模型返回 200 + content:null + usage全0，会让 fallback 误判成功。
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

    const fn = pickFunction(modelId, list);
    // ⚠ 关键修复2：tools.parameters 转成 JSON 字符串
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

    const id = `chatcmpl-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const started = Date.now();

    let upstream;
    try {
      upstream = await fetch(`${BASE}${CHAT_PATH}`, {
        method: 'POST',
        headers: buildHeaders(acct),
        body: JSON.stringify(soloBody),
        signal: AbortSignal.timeout(180000),
      });
    } catch (e) {
      log(`chat 传输错误: ${e.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: `upstream: ${e.message}` } }));
    }

    if (!upstream.ok) {
      const t = await upstream.text().catch(() => '');
      log(`chat HTTP ${upstream.status}: ${t.slice(0, 200)}`);
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: `trae ${upstream.status}: ${t.slice(0, 300)}` } }));
    }

    // ---- 流式解析 ----
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();

    let sendStreamHeadersDone = false;
    let contentBuf = '';
    let reasoningBuf = '';
    let usage = null;
    let finishReason = null;
    let toolCalls = [];

    const ensureStreamHeaders = () => {
      if (sendStreamHeadersDone) return;
      sendStreamHeadersDone = true;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(makeChunk(id, modelId, { role: 'assistant', content: '' }));
    };

    if (wantStream) ensureStreamHeaders();

    let buf = '';
    let done = false;
    const deadline = Date.now() + 180000;

    while (!done && Date.now() < deadline) {
      let chunk;
      try { chunk = await reader.read(); } catch (e) { log(`read 错误: ${e.message}`); break; }
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        const s = line.trim();
        if (!s || !s.startsWith('data:')) continue;
        const p = s.slice(5).trim();
        if (p === '[DONE]') { done = true; break; }

        let ev;
        try { ev = JSON.parse(p); } catch { continue; }

        // SOLO 事件: { response, reasoning_content, tool_calls, usage?, phase }
        const resp = typeof ev.response === 'string' ? ev.response : '';
        const think = typeof ev.reasoning_content === 'string' ? ev.reasoning_content : '';

        if (Array.isArray(ev.tool_calls) && ev.tool_calls.length) {
          toolCalls = ev.tool_calls;
        }
        // SOLO 的 usage 可能是顶层平铺字段（独立事件），不是嵌套 usage 对象
        if (typeof ev.usage === 'object' && ev.usage !== null) {
          usage = ev.usage;
        } else if (typeof ev.prompt_tokens === 'number' || typeof ev.completion_tokens === 'number') {
          usage = {
            prompt_tokens: Number(ev.prompt_tokens ?? 0),
            completion_tokens: Number(ev.completion_tokens ?? 0),
            total_tokens: Number(ev.total_tokens ?? 0),
            ...(typeof ev.reasoning_tokens === 'number' ? { reasoning_tokens: ev.reasoning_tokens } : {}),
            ...(typeof ev.cache_read_input_tokens === 'number' ? { cached_tokens: ev.cache_read_input_tokens } : {}),
          };
        }
        // SOLO 的 content 事件里有 {"content": "<json字符串>"}，需要二次解析
        if (typeof ev.content === 'string' && ev.content) {
          try {
            const inner = JSON.parse(ev.content);
            if (typeof inner.response === 'string' && inner.response) {
              contentBuf += inner.response;
              if (wantStream) res.write(makeChunk(id, modelId, { content: inner.response }));
            }
            if (typeof inner.reasoning_content === 'string' && inner.reasoning_content) {
              reasoningBuf += inner.reasoning_content;
              if (wantStream) res.write(makeChunk(id, modelId, { reasoning_content: inner.reasoning_content }));
            }
            if (Array.isArray(inner.tool_calls) && inner.tool_calls.length) toolCalls = inner.tool_calls;
          } catch {}
        }
        if (typeof ev.finish_reason === 'string' && ev.finish_reason) finishReason = ev.finish_reason;

        if (think) {
          reasoningBuf += think;
          if (wantStream) res.write(makeChunk(id, modelId, { reasoning_content: think }));
        }
        if (resp) {
          contentBuf += resp;
          if (wantStream) res.write(makeChunk(id, modelId, { content: resp }));
        }
      }
    }

    // ---- 结束 ----
    const promptTokens = Number(usage?.prompt_tokens ?? 0);
    const completionTokens = Number(usage?.completion_tokens ?? 0);
    const totalTokens = Number(usage?.total_tokens ?? promptTokens + completionTokens);

    if (wantStream) {
      const fr = finishReason || (toolCalls.length ? 'tool_calls' : 'stop');
      res.write(makeChunk(id, modelId, {}, fr, {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      }));
      res.write('data: [DONE]\n\n');
      res.end();
      log(`stream ok ${modelId} ${Date.now() - started}ms out=${contentBuf.length}ch think=${reasoningBuf.length}ch`);
    } else {
      const message = {
        role: 'assistant',
        content: contentBuf || null,
      };
      if (reasoningBuf) message.reasoning_content = reasoningBuf;
      if (toolCalls.length) {
        message.tool_calls = toolCalls.map((t, i) => ({
          id: t.id || `call_${i}`,
          type: 'function',
          function: {
            name: t.function?.name || t.function_call?.name || '',
            arguments: t.function?.arguments || t.function_call?.arguments || '{}',
          },
        }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: modelId,
        choices: [{ index: 0, message, finish_reason: finishReason || (toolCalls.length ? 'tool_calls' : 'stop') }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens },
      }));
      log(`non-stream ok ${modelId} ${Date.now() - started}ms out=${contentBuf.length}ch`);
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(PORT, '127.0.0.1', () => {
  log(`Trae SOLO 适配网关启动: http://127.0.0.1:${PORT}`);
  log(`  账号: ${accounts.length} 个`);
  log(`  /v1/models   /v1/chat/completions   /health`);
  fetchCatalog().catch((e) => log(`首次目录失败: ${e.message}`));
});
