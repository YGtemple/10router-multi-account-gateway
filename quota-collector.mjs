/**
 * 统一配额采集器
 *
 * 10Router 的 /api/usage/quotas 只覆盖它在白名单里的 provider（国内版 codebuddy-cn），
 * openai-compatible 类型的连接（Trae、WorkBuddy AI）永远拿不到配额。
 * 所以这里直接按各平台的官方接口采集：
 *
 *   cn  (WorkBuddy 国内) → 复用 10Router /api/usage/quotas（它已实现）
 *   trae (Trae CN)       → POST https://api.trae.cn/trae/api/v2/pay/web_user_ent_usage
 *   ai  (WorkBuddy AI)   → POST https://www.workbuddy.ai/v2/billing/meter/get-user-resource
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ACC = join(homedir(), '.dsh', 'multi-router', 'accounts');
const BASE = process.env.ROUTER_BASE || 'http://127.0.0.1:20128';
const PANEL = process.env.ROUTER_PASSWORD || '';

function jwtPayload(t) {
  try {
    const p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(p + '='.repeat((4 - (p.length % 4)) % 4), 'base64').toString('utf8'));
  } catch { return null; }
}

/** 读取全部账号，按平台分类 */
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
    let type;
    if (/trae/i.test(iss) || /trae\.(cn|ai)/i.test(c.host || '')) type = 'trae';
    else if (/workbuddy\.ai|codebuddy\.ai/i.test(iss)) type = 'ai';
    else if (/codebuddy\.cn|copilot\.tencent|workbuddy\.cn/i.test(iss)) type = 'cn';
    else if (p.data?.id && /trae/i.test(c.host || '')) type = 'trae';
    else type = '?';

    out.push({
      dir: n,
      type,
      // 国内/国际：uid 在 sub；Trae：在 userId 或 payload.data.id
      uid: p.sub || c.userId || p.data?.id || null,
      token: c.accessToken,
      host: c.host || '',
      region: c.userRegion || '',
      edition: c.edition || '',
      accountName: c.accountName || '',
      exp: c.expiresAtMs || 0,
    });
  }
  // 同 uid 取最晚过期
  const m = new Map();
  for (const a of out) {
    const k = `${a.type}:${a.uid}`;
    const prev = m.get(k);
    if (!prev || a.exp > prev.exp) m.set(k, a);
  }
  return [...m.values()];
}

async function login10Router() {
  if (!PANEL) throw new Error('未设置 ROUTER_PASSWORD 环境变量');
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PANEL }),
  });
  if (!r.ok) throw new Error(`10Router 登录失败 ${r.status}`);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

/** 国内版：直接读 10Router 已实现的配额接口 */
async function collectCn() {
  const ck = await login10Router();
  const q = await (await fetch(`${BASE}/api/usage/quotas`, { headers: { Cookie: ck } })).json();
  const out = { accounts: [], byPrefix: {} };
  const now = Date.now();
  for (const c of q.connections || []) {
    const quotas = c.quotas || [];
    let total = 0, expiring = 0, earliest = Infinity;
    for (const pkg of quotas) {
      const rem = Math.max(0, (pkg.total || 0) - (pkg.used || 0));
      total += rem;
      const at = pkg.resetAt ? Date.parse(pkg.resetAt) : NaN;
      if (Number.isFinite(at) && at > now) {
        if (at < earliest) earliest = at;
        if (at <= now + 7 * 86400000 && rem > 0) expiring += rem;
      }
    }
    const row = {
      name: c.name, provider: c.provider, plan: c.plan,
      active: c.isActive !== false, limitReached: c.limitReached === true,
      remaining: total, expiring, earliestExpiry: Number.isFinite(earliest) ? earliest : null,
      packs: quotas.map((x) => ({ name: x.name, rem: Math.max(0, (x.total || 0) - (x.used || 0)), expiry: x.resetAt })),
      source: '10router',
    };
    out.accounts.push(row);
    if (c.provider === 'codebuddy-cn') out.byPrefix[c.name] = row;
  }
  return out;
}

/** Trae：官方积分接口（需要设备头） */
async function collectTrae() {
  const accs = loadAccounts().filter((a) => a.type === 'trae');
  const out = { accounts: [], byPrefix: {} };
  const now = Date.now();
  for (const a of accs) {
    const row = {
      name: a.accountName || a.dir, uid: a.uid, active: a.exp > now,
      limitReached: false, remaining: null, expiring: 0, earliestExpiry: null,
      packs: [], source: 'trae-api', error: null,
    };
    try {
      const r = await fetch('https://api.trae.cn/trae/api/v2/pay/web_user_ent_usage', {
        method: 'POST',
        headers: {
          Authorization: `Cloud-IDE-JWT ${a.token}`,
          'X-Ide-Token': a.token,
          'X-Cloudide-Token': a.token,
          'x-uid': String(a.uid),
          'x-plugin-channel': 'icube-ai',
          'User-Agent': 'Trae/1.0',
          'x-app-id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: '{}',
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json().catch(() => null);
      if (!j) throw new Error(`HTTP ${r.status}`);
      const us = j.usage_summary || {};
      row.remaining = Math.max(0, (Number(us.total_amount) || 0) - (Number(us.consumed_amount) || 0));
      row.totalAmount = Number(us.total_amount) || 0;
      row.consumed = Number(us.consumed_amount) || 0;
      row.ratio = Number(us.consumption_ratio) || 0;
      let earliest = Infinity;
      for (const p of j.user_entitlement_pack_list || []) {
        const b = p.entitlement_base_info || {};
        const endMs = b.end_time ? b.end_time * 1000 : null;
        if (endMs && endMs > now && endMs < earliest) earliest = endMs;
        row.packs.push({ name: p.display_desc || b.entitlement_id || '?', expiry: endMs ? new Date(endMs).toISOString() : null });
      }
      row.earliestExpiry = Number.isFinite(earliest) ? earliest : null;
      if (row.totalAmount > 0 && row.remaining <= 0) row.limitReached = true;
    } catch (e) {
      row.error = e.message;
    }
    out.accounts.push(row);
    out.byPrefix.trae = row;
  }
  return out;
}

/** WorkBuddy AI 国际版：走 get-user-resource（与国内版同一套 billing 端点，但域名不同） */
async function collectAi() {
  const accs = loadAccounts().filter((a) => a.type === 'ai');
  const out = { accounts: [], byPrefix: {} };
  const now = Date.now();
  const p2 = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;

  for (const a of accs) {
    const row = {
      name: a.accountName || a.dir, uid: a.uid, active: a.exp > now,
      limitReached: false, remaining: null, expiring: 0, earliestExpiry: null,
      packs: [], source: 'get-user-resource', error: null,
    };
    try {
      // 国际版走自己的域，国内版走 copilot.tencent.com
      const dom = /workbuddy\.ai|codebuddy\.ai/.test(a.host || '') || a.type === 'ai'
        ? (a.host && /^https?:\/\//.test(a.host) ? a.host : 'https://www.workbuddy.ai')
        : 'https://copilot.tencent.com';
      const r = await fetch(`${dom}/v2/billing/meter/get-user-resource`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${a.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-User-Id': String(a.uid),
          'X-Domain': /workbuddy\.ai|codebuddy\.ai/.test(a.host || '') || a.type === 'ai'
            ? 'www.workbuddy.ai'
            : 'www.workbuddy.cn',
          'User-Agent': 'CLI/2.108.1 CodeBuddy/2.108.1',
          'X-Product': 'SaaS',
        },
        body: JSON.stringify({
          PageNumber: 1,
          PageSize: 100,
          ProductCode: 'p_tcaca',
          Status: [0, 3],
          PackageEndTimeRangeBegin: fmt(new Date(now)),
          PackageEndTimeRangeEnd: fmt(new Date(now + 3185136e6)),
        }),
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json().catch(() => null);
      if (j?.code !== 0) throw new Error(`code=${j?.code} ${j?.msg || ''}`);
      const arr = j?.data?.Response?.Data?.Accounts || [];
      let remain = 0;
      let earliest = Infinity;
      for (const x of arr) {
        const size = Number(x.CycleCapacitySize ?? 0);
        const cr = Number(x.CycleCapacityRemain ?? 0);
        const cu = Number(x.CycleCapacityUsed ?? 0);
        const capR = Number(x.CapacityRemain ?? 0);
        let rm = size > 0 ? cr : (cr > 0 || cu > 0) ? cr : capR;
        if (rm < 0) rm = 0;
        remain += rm;
        const endRaw = x.PackageEndTime || x.CycleEndTime || x.ExpireTime;
        const endMs = endRaw ? Date.parse(String(endRaw).replace(' ', 'T')) : NaN;
        if (Number.isFinite(endMs) && endMs > now) {
          if (endMs < earliest) earliest = endMs;
          if (endMs <= now + 7 * 86400000) row.expiring += rm;
        }
        row.packs.push({
          name: x.PackageName || x.ProductName || x.PackageId || '?',
          rem: rm,
          expiry: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null,
        });
      }
      row.remaining = remain;
      row.earliestExpiry = Number.isFinite(earliest) ? earliest : null;
      if (arr.length > 0 && remain <= 0) row.limitReached = true;
    } catch (e) {
      row.error = e.message;
    }
    out.accounts.push(row);
    out.byPrefix.wbai = row;
  }
  return out;
}

/** 汇总：返回 { cn, trae, ai, prefixHealth } */
export async function collectAll() {
  const [cn, trae, ai] = await Promise.all([
    collectCn().catch((e) => ({ accounts: [], byPrefix: {}, error: e.message })),
    collectTrae().catch((e) => ({ accounts: [], byPrefix: {}, error: e.message })),
    collectAi().catch((e) => ({ accounts: [], byPrefix: {}, error: e.message })),
  ]);

  const prefixHealth = {};
  // 国内版：多账号取最优（剩余最多且未限额）
  const cnRows = Object.values(cn.byPrefix || {}).filter(Boolean);
  if (cnRows.length) {
    const usable = cnRows.filter((x) => x.active && !x.limitReached);
    const best = (usable.length ? usable : cnRows).sort((a, b) => b.remaining - a.remaining)[0];
    prefixHealth['codebuddy-cn'] = { ...best, all: cnRows };
  }
  if (trae.byPrefix?.trae) prefixHealth['trsolo'] = trae.byPrefix.trae;
  if (ai.byPrefix?.wbai) prefixHealth['wbai'] = ai.byPrefix.wbai;

  return { cn, trae, ai, prefixHealth };
}

// CLI 直接运行：打印三平台配额
if (process.argv[1]?.endsWith('quota-collector.mjs')) {
  const all = await collectAll();
  const pad = (s, n) => String(s ?? '-').padEnd(n);
  for (const [label, resp] of [['国内版', all.cn], ['Trae', all.trae], ['国际版', all.ai]]) {
    console.log(`\n===== ${label} =====`);
    if (resp.error) console.log(`  ✗ ${resp.error}`);
    for (const a of resp.accounts || []) {
      const exp = a.earliestExpiry ? new Date(a.earliestExpiry).toLocaleDateString('zh-CN') : '-';
      console.log(`  ${pad(a.name, 26)} 余=${pad(Math.round(a.remaining ?? -1), 7)} 临期=${pad(Math.round(a.expiring || 0), 6)} 最早到期=${pad(exp, 12)} ${a.limitReached ? '⚠限额' : ''} ${a.error ? '✗ ' + a.error : ''}`);
    }
  }
}
