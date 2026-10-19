// WorkBuddy 国际版适配网关（轻量）
//
// 作用：把标准 OpenAI 请求转成 WorkBuddy 国际版所需格式
//   - 补 X-Conversation-ID / X-Conversation-Request-ID / X-Conversation-Message-ID
//   - 补 WorkBuddy 指纹头（X-IDE-Type: WorkBuddy 等）
//   - 强制 stream: true（上游只支持流式）
//   - 补 stream_options.include_usage 拿 credit 消耗
//   - 从 DSH 插件读取 token（多账号轮询）
//
// 用法: node intl-gateway.mjs [port]
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.argv[2] || 18996);
const ACC = join(homedir(), '.dsh', 'multi-router', 'accounts');

// ---------- 账号池 ----------
function jwt(t) {
  try {
    const p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(p + '='.repeat((4 - (p.length % 4)) % 4), 'base64').toString('utf8'));
  } catch { return null; }
}

function loadIntlAccounts() {
  const out = [];
  if (!existsSync(ACC)) return out;
  for (const name of readdirSync(ACC)) {
    const d = join(ACC, name);
    if (!statSync(d).isDirectory()) continue;
    const cf = join(d, 'credential.json');
    if (!existsSync(cf)) continue;
    let cred;
    try { cred = JSON.parse(readFileSync(cf, 'utf8')).credential; } catch { continue; }
    if (!cred?.accessToken) continue;
    const pay = jwt(cred.accessToken) || {};
    // 只认国际版：issuer 含 workbuddy.ai / codebuddy.ai
    if (!/workbuddy\.ai|codebuddy\.ai/.test(pay.iss || '')) continue;
    if ((cred.expiresAtMs || 0) <= Date.now()) continue;
    out.push({
      dir: name,
      token: cred.accessToken,
      uid: pay.sub || cred.uid,
      domain: cred.domain || 'www.workbuddy.ai',
      expiresAt: cred.expiresAtMs || 0,
    });
  }
  // 按 uid 去重取最晚过期
  const m = new Map();
  for (const a of out) {
    const prev = m.get(a.uid);
    if (!prev || a.expiresAt > prev.expiresAt) m.set(a.uid, a);
  }
  return [...m.values()];
}

const accounts = loadIntlAccounts();
if (!accounts.length) {
  console.error('未找到有效的国际版账号');
  process.exit(1);
}

console.log('='.repeat(70));
console.log('WorkBuddy 国际版适配网关');
console.log('='.repeat(70));
console.log(`端口: ${PORT}`);
console.log(`账号池: ${accounts.length} 个`);
for (const a of accounts) {
  console.log(`  ${a.uid.slice(0, 18)}…  domain=${a.domain}  到期=${new Date(a.expiresAt).toISOString().slice(0, 10)}`);
}
console.log('');

// ---------- 轮询 ----------
let rrIdx = 0;
function nextAccount() {
  const a = accounts[rrIdx % accounts.length];
  rrIdx++;
  return a;
}

// ---------- 模型列表 ----------
// 国际版实际可用模型（实测得出：标 Pro Only 的套餐不可用，不在此列表）
const INTL_MODELS = [
  { id: 'hy4-preview', name: 'Hy4-Preview' },
  { id: 'hy3', name: 'Hy3' },
  { id: 'space-bunny', name: 'Space-Bunny' },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview' },
  { id: 'gpt-5.5', name: 'GPT-5.5' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
  { id: 'gpt-5.4', name: 'GPT-5.4' },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3-Codex' },
  { id: 'claude-opus-5.5', name: 'Claude-Opus-5.5' },
  { id: 'claude-sonnet-5', name: 'Claude-Sonnet-5' },
];

// ---------- 构造请求头 ----------
function buildHeaders(acct, accept = 'text/event-stream') {
  return {
    Authorization: `Bearer ${acct.token}`,
    Accept: accept,
    'Content-Type': 'application/json',
    'User-Agent': 'workbuddy-ai/5.7.6 workbuddy-ai/5.7.6 CLI/2.156.0',
    'X-User-Id': String(acct.uid),
    'X-Domain': acct.domain,
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': '5.7.6',
    'X-Product': 'SaaS',
    // 国际版必需：会话三件套
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': randomUUID(),
    'X-Conversation-Message-ID': randomUUID(),
  };
}

// ---------- 改造请求体 ----------
function prepareBody(src) {
  const b = { ...src };
  b.stream = true;                              // 上游只支持流式
  b.stream_options = { include_usage: true };   // 要 usage（含 credit）
  if (Array.isArray(b.messages)) {
    b.messages = b.messages.map((m) => (m.role === 'developer' ? { ...m, role: 'system' } : m));
    // 国际版需要前置 system
    if (!b.messages.some((m) => m.role === 'system')) {
      b.messages.unshift({ role: 'system', content: 'You are a helpful assistant.' });
    }
  }
  // tool_choice 对象 → 字符串
  if (b.tool_choice && typeof b.tool_choice === 'object') {
    b.tool_choice = b.tool_choice.type === 'function' ? 'required' : 'auto';
  }
  return b;
}

// ---------- SSE 归一化 ----------
// 上游 delta 带空占位符（null / '' / []），需要剥离，否则部分客户端会报错
const EMPTY_KEYS = ['function_call', 'refusal', 'tool_calls', 'extra_fields', 'reasoning_content'];

function normalizeChunk(obj, model) {
  if (!obj?.choices) return obj;
  for (const c of obj.choices) {
    if (c.delta) {
      for (const k of EMPTY_KEYS) {
        if (k === 'tool_calls') {
          if (Array.isArray(c.delta[k]) && c.delta[k].length === 0) delete c.delta[k];
        } else if (c.delta[k] === null || c.delta[k] === '') {
          delete c.delta[k];
        }
      }
    }
  }
  if (model && !obj.model) obj.model = model;
  return obj;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // ---- /v1/models ----
  if (url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: INTL_MODELS.map((m) => ({ id: m.id, object: 'model', owned_by: 'workbuddy-ai' })),
    }));
    console.log(`[${new Date().toISOString().slice(11, 19)}] GET /v1/models -> ${INTL_MODELS.length} 个`);
    return;
  }

  // ---- /health ----
  if (url.pathname === '/health' || url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, accounts: accounts.length }));
    return;
  }

  // ---- /v1/chat/completions ----
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      let src = null;
      try { src = JSON.parse(raw); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }));
        return;
      }

      const wantStream = src.stream === true;
      const model = src.model || 'hy4-preview';
      const body = prepareBody(src);
      const acct = nextAccount();

      console.log(`[${new Date().toISOString().slice(11, 19)}] POST chat  model=${model} stream=${wantStream} acct=${acct.uid.slice(0, 12)}`);

      let upstream;
      try {
        upstream = await fetch('https://www.codebuddy.ai/v2/chat/completions', {
          method: 'POST',
          headers: buildHeaders(acct),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(300000),
        });
      } catch (e) {
        console.log(`  上游连接失败: ${e.message}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `upstream error: ${e.message}`, type: 'api_error' } }));
        return;
      }

      if (!upstream.ok) {
        const t = await upstream.text().catch(() => '');
        let j = null; try { j = JSON.parse(t); } catch {}
        console.log(`  上游 HTTP ${upstream.status} code=${j?.code} ${String(j?.msg || '').slice(0, 60)}`);
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: `[${upstream.status}]: ${t.slice(0, 400)}`,
            type: 'api_error', code: upstream.status,
          },
        }));
        return;
      }

      // ---- 流式直通（归一化后） ----
      if (wantStream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const reader = upstream.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        const id = 'chatcmpl-' + randomUUID().slice(0, 24);
        const created = Math.floor(Date.now() / 1000);
        let sentFirst = false;

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
              const s = line.trim();
              if (!s.startsWith('data:')) continue;
              const payload = s.slice(5).trim();
              if (payload === '[DONE]') {
                res.write('data: [DONE]\n\n');
                continue;
              }
              try {
                const obj = JSON.parse(payload);
                normalizeChunk(obj, model);
                obj.id = id;
                obj.created = created;
                if (!sentFirst && obj.choices?.[0]?.delta) {
                  obj.choices[0].delta.role = obj.choices[0].delta.role || 'assistant';
                  sentFirst = true;
                }
                res.write(`data: ${JSON.stringify(obj)}\n\n`);
              } catch { /* 跳过坏块 */ }
            }
          }
        } catch (e) {
          console.log(`  流中断: ${e.message}`);
        }
        res.end();
        console.log(`  流结束`);
        return;
      }

      // ---- 非流式：聚合 SSE ----
      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
      let buf = '', content = '', reasoning = '', usage = null, finish = null;
      const toolCalls = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith('data:')) continue;
          const payload = s.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const obj = JSON.parse(payload);
            const ch = obj.choices?.[0];
            if (ch?.delta) {
              content += ch.delta.content || '';
              reasoning += ch.delta.reasoning_content || '';
              if (Array.isArray(ch.delta.tool_calls)) {
                for (const tc of ch.delta.tool_calls) {
                  const i = tc.index ?? 0;
                  toolCalls[i] ||= { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
                  if (tc.id) toolCalls[i].id = tc.id;
                  if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
                  if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
                }
              }
              if (ch.finish_reason) finish = ch.finish_reason;
            }
            if (obj.usage) usage = obj.usage;
          } catch { }
        }
      }

      const message = { role: 'assistant', content };
      if (reasoning) message.reasoning_content = reasoning;
      if (toolCalls.length) message.tool_calls = toolCalls.filter(Boolean);

      const outUsage = usage ? {
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)),
        // 透传积分消耗
        ...(typeof usage.credit === 'number' ? { credit: usage.credit } : {}),
        ...(usage.cached_tokens != null ? { cached_tokens: usage.cached_tokens } : {}),
      } : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-' + randomUUID().slice(0, 24),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message, finish_reason: finish || 'stop' }],
        usage: outUsage,
      }));
      console.log(`  非流式完成  in=${outUsage.prompt_tokens} out=${outUsage.completion_tokens} credit=${outUsage.credit ?? '-'}`);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `not found: ${req.method} ${url.pathname}` } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`已启动: http://127.0.0.1:${PORT}`);
  console.log(`  端点: /v1/models  /v1/chat/completions  /health`);
  console.log(`  在 10Router 里注册为自定义 OpenAI 兼容 provider:`);
  console.log(`    baseUrl = http://127.0.0.1:${PORT}/v1`);
});
