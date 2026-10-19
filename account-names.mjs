/**
 * 账号显示名解析
 *
 * 优先级：
 *   1. 10Router 里的连接名（如 wb-me / wb-biao / wb-ren）
 *   2. credential.json 里的 accountName（Trae 有「竹心」）
 *   3. 目录名兜底
 *
 * 难点：10Router 把 token 加密存储（enc:v1:...），无法解码出 uid。
 * 破解方式：用 token 到期时间作为关联键 —— 两边都存了这个值，
 * 且来自同一份 token 所以必然一致；容差 120 秒（刷新会造成秒级漂移）。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ACC = join(homedir(), '.dsh', 'multi-router', 'accounts');
const DB_PATH = join(process.env.APPDATA || '', '10router', 'db', 'data.sqlite');

export function jwtPayload(t) {
  try {
    const p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(p + '='.repeat((4 - (p.length % 4)) % 4), 'base64').toString('utf8'));
  } catch { return null; }
}

/** 读取账号目录，返回带 region/uid/token/名称 的数组 */
export function loadAccounts() {
  if (!existsSync(ACC)) return [];
  const out = [];
  for (const n of readdirSync(ACC)) {
    const d = join(ACC, n);
    if (!statSync(d).isDirectory()) continue;
    const cf = join(d, 'credential.json');
    if (!existsSync(cf)) continue;
    let c;
    try { c = JSON.parse(readFileSync(cf, 'utf8')).credential; } catch { continue; }
    if (!c?.accessToken) continue;

    const p = jwtPayload(c.accessToken) || {};
    const iss = p.iss || '';
    const host = c.host || '';
    const isTrae = /trae/i.test(host) || /trae/i.test(iss);
    const isAI = !isTrae && /workbuddy\.ai|codebuddy\.ai/.test(iss);
    const isCN = !isTrae && !isAI && /codebuddy\.cn|copilot\.tencent\.com|workbuddy\.cn/.test(iss);
    if (!isCN && !isAI && !isTrae) continue;
    if ((c.expiresAtMs || 0) <= Date.now()) continue;

    out.push({
      // Trae 的 uid 不在标准 sub 字段，而在 userId 或 JWT 的 data.id
      uid: p.sub || c.userId || p.data?.id || n,
      dir: n,
      region: isTrae ? 'trae' : isAI ? 'ai' : 'cn',
      token: c.accessToken,
      refreshToken: c.refreshToken || null,
      domain: c.domain || '',
      host,
      accountName: c.accountName || '',
      exp: c.expiresAtMs,
    });
  }
  // 同 uid 取最晚过期（同一账号可能有多个凭证副本）
  const m = new Map();
  for (const a of out) {
    const k = `${a.region}:${a.uid}`;
    const prev = m.get(k);
    if (!prev || a.exp > prev.exp) m.set(k, a);
  }
  return [...m.values()];
}

/**
 * 从 10Router 读出 uid → 自定义连接名。
 * @returns {Map<string,string>} "region:uid" → name
 */
export function connectionNames() {
  const map = new Map();
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const rows = db.prepare('SELECT provider, name, data FROM providerConnections').all();
    const pool = [];  // { sec, name }
    for (const r of rows) {
      let d = {};
      try { d = JSON.parse(r.data || '{}'); } catch {}
      const at = d.expiresAt ? Date.parse(d.expiresAt) : NaN;
      if (Number.isFinite(at) && r.name) {
        pool.push({ sec: Math.floor(at / 1000), name: r.name });
      }
    }
    db.close();

    for (const a of loadAccounts()) {
      if (!a.exp) continue;
      const sec = Math.floor(a.exp / 1000);
      let best = null, bestDiff = Infinity;
      for (const r of pool) {
        const diff = Math.abs(r.sec - sec);
        if (diff < bestDiff) { bestDiff = diff; best = r; }
      }
      // 容差 120 秒：token 刷新会让秒数产生 1~2 秒漂移
      if (best && bestDiff <= 120) map.set(`${a.region}:${a.uid}`, best.name);
    }
  } catch {
    // sqlite 不可用时静默降级为目录名
  }
  return map;
}

/** 读取 openai-compatible 类型的连接名（Trae / 国际版没有 token 到期时间，只能按前缀匹配） */
function openaiCompatibleNames() {
  const out = [];
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const rows = db.prepare("SELECT name, data FROM providerConnections WHERE provider LIKE 'openai-compatible%'").all();
    for (const r of rows) {
      let d = {};
      try { d = JSON.parse(r.data || '{}'); } catch {}
      out.push({ name: r.name, prefix: d.providerSpecificData?.prefix || '' });
    }
    db.close();
  } catch {}
  return out;
}

/**
 * 给账号数组填充 displayName。
 * 顺序：10Router 连接名 → 凭证 accountName → 目录名
 */
export function withDisplayNames(accounts) {
  const names = connectionNames();
  const oai = openaiCompatibleNames();

  return accounts.map((a) => {
    let display = names.get(`${a.region}:${a.uid}`) || '';
    if (!display && a.region === 'trae') {
      // Trae 只有一条连接，优先用账号自己的名字（如「竹心」）
      display = a.accountName || oai.find((x) => x.prefix === 'trsolo')?.name || '';
    }
    if (!display && a.region === 'ai') {
      display = a.accountName || oai.find((x) => x.prefix === 'wbai')?.name || '';
    }
    if (!display) display = a.accountName || a.dir;
    return { ...a, displayName: display };
  });
}
