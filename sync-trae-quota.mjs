#!/usr/bin/env node
/**
 * Trae 积分同步到 10Router 配额面板
 *
 * 背景：10Router 的 /api/usage/quotas 有 provider 白名单，
 *       openai-compatible 类型（Trae / 国际版）永远不会被查询。
 *       所以需要外部把积分推送到 /api/external-quota/<source>。
 *
 * 数据源：https://api.trae.cn/trae/api/v2/pay/web_user_ent_usage
 *        只使用 usage_summary（total_amount / consumed_amount），
 *        user_entitlement_pack_list 里的 quota 字段是功能开关不是数值，不能当余额用。
 *
 * 用法:
 *   node sync-trae-quota.mjs          同步一次
 *   node sync-trae-quota.mjs watch    每 30 分钟同步
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const ACC = join(homedir(), '.dsh', 'multi-router', 'accounts');
const BASE = process.env.ROUTER_BASE || 'http://127.0.0.1:20128';
const PANEL = process.env.ROUTER_PASSWORD || '';
const APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';

function loadTraeAccount() {
  if (!existsSync(ACC)) return null;
  for (const n of readdirSync(ACC)) {
    const d = join(ACC, n);
    if (!statSync(d).isDirectory()) continue;
    const cf = join(d, 'credential.json');
    if (!existsSync(cf)) continue;
    let c;
    try { c = JSON.parse(readFileSync(cf, 'utf8')).credential; } catch { continue; }
    if (!c?.accessToken) continue;
    if (!/trae/i.test(c.host || '')) continue;
    if ((c.expiresAtMs || 0) <= Date.now()) continue;
    return { token: c.accessToken, uid: c.userId, name: c.accountName || 'Trae' };
  }
  return null;
}

function traeHeaders(acct) {
  const rid = randomUUID();
  const tid = rid.replaceAll('-', '').slice(0, 32);
  return {
    Authorization: `Cloud-IDE-JWT ${acct.token}`,
    'X-Ide-Token': acct.token,
    'X-Cloudide-Token': acct.token,
    'x-uid': acct.uid,
    'x-plugin-channel': 'icube-ai',
    'User-Agent': 'Trae/1.0',
    'x-app-id': APP_ID,
    'x-app-version-code': '20260716',
    'x-ide-version-code': '20260716',
    'x-custom-trace-id': tid,
    'x-flow-traceparent': `04-${tid}-${tid.slice(0, 16)}-01`,
    'request-traffic-type': 'prod',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function fetchTraeQuota(acct) {
  try {
    const r = await fetch('https://api.trae.cn/trae/api/v2/pay/web_user_ent_usage', {
      method: 'POST', headers: traeHeaders(acct), body: '{}',
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => null);
    if (!j?.usage_summary) return null;
    const s = j.usage_summary;
    const total = Number(s.total_amount) || 0;
    const consumed = Number(s.consumed_amount) || 0;
    if (!total) return null;
    const remaining = Math.max(0, total - consumed);

    return {
      // 这个 provider id 需要替换成本地 10Router 里的 Trae 连接 provider 值
      provider: process.env.TRAE_PROVIDER_ID || 'openai-compatible-chat-e7ae4ae8-85bb-4166-a308-7198d8fd9801',
      name: acct.name,
      label: acct.name,
      plan: j.is_credits_billing ? '积分计费' : '套餐',
      quotas: {
        main: {
          name: 'Trae 积分',
          used: Math.round(consumed * 100) / 100,
          total: Math.round(total * 100) / 100,
          remainingPercentage: Math.round((remaining / total) * 10000) / 100,
          percentScale: 100,
          displayRemaining: true,
          isCreditBalance: true,
        },
      },
    };
  } catch (e) {
    console.log(`拉取失败: ${e.message.slice(0, 60)}`);
    return null;
  }
}

async function login() {
  if (!PANEL) throw new Error('未设置 ROUTER_PASSWORD 环境变量');
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PANEL }),
  });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

async function pushQuota(ck, payload) {
  const r = await fetch(`${BASE}/api/external-quota/trae`, {
    method: 'POST',
    headers: { Cookie: ck, 'x-10r-password': PANEL, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function syncOnce() {
  const acct = loadTraeAccount();
  if (!acct) { console.log('无有效 Trae 账号'); return false; }

  const quota = await fetchTraeQuota(acct);
  if (!quota) { console.log('拉取 Trae 积分失败'); return false; }

  const ck = await login();
  const res = await pushQuota(ck, quota);

  if (res.status === 200 && res.body?.ok) {
    const m = quota.quotas.main;
    console.log(`✓ 已同步 Trae 积分`);
    console.log(`  已用 ${m.used} / 总额 ${m.total}（剩余 ${(m.total - m.used).toFixed(0)}，${m.remainingPercentage}%）`);
    return true;
  }
  console.log(`✗ 推送失败: HTTP ${res.status} ${JSON.stringify(res.body)}`);
  return false;
}

const mode = process.argv[2];
await syncOnce();

if (mode === 'watch') {
  console.log('\n进入监控模式（每 30 分钟同步）');
  setInterval(syncOnce, 30 * 60 * 1000);
}
