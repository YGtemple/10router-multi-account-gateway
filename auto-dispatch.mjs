#!/usr/bin/env node
/**
 * 智能调度器 —— 按「免费 → 临期 → 低价」重排 10Router 统一路由
 *
 * 配额数据来自 quota-collector.mjs 真实采集，覆盖国内版 / Trae / 国际版三个平台。
 *
 * 排序优先级：
 *   0. 免费模型（倍率 0）
 *   1. 积分临期（默认 7 天窗口内有过期积分，越早过期越优先）
 *   2. 正常（按倍率从低到高）
 *   9. 额度耗尽 / 账号停用（排最后）
 *
 * 原理：10Router 的 combo（kind: fallback）会按 models 数组顺序逐个尝试，
 *      所以「数组顺序 = 优先级顺序」。
 *
 * 用法:
 *   node auto-dispatch.mjs plan    只读预览
 *   node auto-dispatch.mjs apply   执行重排
 *   node auto-dispatch.mjs daemon  常驻，每 10 分钟重排
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAll } from './quota-collector.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.ROUTER_BASE || 'http://127.0.0.1:20128';
const PANEL = process.env.ROUTER_PASSWORD || '';
const EXPIRING_DAYS = Number(process.env.EXPIRING_DAYS || 7);
// 倍率表目录（内含 trae-billing.json / wb-config-cn.json / wb-config-ai.json）
const RATES_DIR = process.env.RATES_DIR || HERE;

let ck = '';

async function login() {
  if (!PANEL) throw new Error('未设置 ROUTER_PASSWORD 环境变量');
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PANEL }),
  });
  if (!r.ok) throw new Error(`登录失败 ${r.status}`);
  ck = (r.headers.get('set-cookie') || '').split(';')[0];
}

async function getJson(path) {
  const r = await fetch(BASE + path, { headers: { Cookie: ck } });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

/** 倍率表：从各平台导出的模型清单里读 credits 字段 */
function loadRates() {
  const m = new Map();

  // Trae：trae-billing.json 的 models[].billing.rate
  const tb = join(RATES_DIR, 'trae-billing.json');
  if (existsSync(tb)) {
    try {
      for (const x of JSON.parse(readFileSync(tb, 'utf8')).models || []) {
        m.set(`trsolo/${x.id}`, x.billing?.rate ?? null);
      }
    } catch {}
  }

  // WorkBuddy 国内/国际：wb-config-*.json 的 models[].credits = "x0.06 credits"
  for (const [f, prov] of [['wb-config-cn.json', 'codebuddy-cn'], ['wb-config-ai.json', 'wbai']]) {
    const p = join(RATES_DIR, f);
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      for (const x of (j.data || j).models || []) {
        const mm = String(x.credits || '').match(/x([\d.]+)/);
        m.set(`${prov}/${x.id}`, mm ? parseFloat(mm[1]) : null);
      }
    } catch {}
  }
  return m;
}

/** 单个模型的排序键 */
function rank(id, rates, prefixHealth) {
  const rate = rates.get(id);
  const prefix = id.split('/')[0];
  const h = prefixHealth[prefix];

  // 前缀健康度未知（该平台没有可用账号数据）→ 归为中档，仍按价格排
  const known = !!h && h.error == null;
  const exhausted = known && (h.limitReached || h.active === false || (h.remaining !== null && h.remaining <= 0));
  const expiring = known && (h.expiring || 0) > 0;

  let tier;
  if (exhausted) tier = 9;
  else if (rate === 0) tier = 0;
  else if (expiring) tier = 1;
  else tier = 2;

  return {
    id,
    rate: rate ?? Infinity,
    tier,
    known,
    exhausted,
    expiring,
    remaining: known ? h.remaining : null,
    expiringCredits: known ? (h.expiring || 0) : 0,
    earliestExpiry: known ? h.earliestExpiry : null,
    reason: exhausted
      ? `额度耗尽(${h.remaining ?? 0})`
      : rate === 0
        ? '免费'
        : expiring
          ? `临期优先(剩${Math.round(h.expiring)},${h.earliestExpiry ? new Date(h.earliestExpiry).toLocaleDateString('zh-CN') : '-'}到期)`
          : known
            ? `按价 x${rate ?? '?'}(余${h.remaining != null ? Math.round(h.remaining) : '-'})`
            : `按价 x${rate ?? '?'}(无配额数据)`,
  };
}

async function buildPlan() {
  const quota = await collectAll();
  const rates = loadRates();
  const cj = await getJson('/api/combos');
  const combos = (cj.combos || cj).filter((c) => c.name.startsWith('auto-'));

  const plan = [];
  for (const cb of combos) {
    const ranked = (cb.models || []).map((id) => rank(id, rates, quota.prefixHealth));
    ranked.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      // 临期层：越早过期越优先（先花掉会过期的积分）
      if (a.tier === 1 && a.earliestExpiry && b.earliestExpiry && a.earliestExpiry !== b.earliestExpiry) {
        return a.earliestExpiry - b.earliestExpiry;
      }
      if (a.rate !== b.rate) return a.rate - b.rate;
      return 0;
    });
    plan.push({ id: cb.id, name: cb.name, from: cb.models || [], to: ranked.map((r) => r.id), ranked });
  }
  return { plan, quota };
}

function printQuota(quota) {
  const line = (a) => {
    const exp = a.earliestExpiry ? new Date(a.earliestExpiry).toLocaleDateString('zh-CN') : '-';
    const err = a.error ? `  ✗ ${a.error}` : '';
    return `  ${String(a.name).padEnd(24)} 余=${String(a.remaining == null ? '-' : Math.round(a.remaining)).padStart(6)}  临期=${String(Math.round(a.expiring || 0)).padStart(5)}  最早到期=${exp.padEnd(12)}${a.limitReached ? ' ⚠限额' : ''}${a.active === false ? ' ⚠停用' : ''}${err}`;
  };
  console.log('\n【账号配额 · 真实数据】');
  for (const [label, resp] of [['国内版', quota.cn], ['Trae', quota.trae], ['国际版', quota.ai]]) {
    console.log(` ${label}:`);
    if (resp.error) { console.log(`   ✗ ${resp.error}`); continue; }
    for (const a of resp.accounts || []) console.log(line(a));
    if (!(resp.accounts || []).length) console.log('   （无账号）');
  }
}

function printPlan(plan) {
  console.log('\n【统一路由顺序】');
  for (const p of plan) {
    const changed = p.from.join(',') !== p.to.join(',');
    console.log(`\n  ${p.name}  ${changed ? '↻ 调整' : '✓ 不变'}`);
    for (const r of p.ranked) {
      const mark = r.exhausted ? '✗' : r.tier === 0 ? '★' : r.tier === 1 ? '⏰' : '·';
      console.log(`    ${mark} ${r.id.padEnd(40)} ${r.reason}`);
    }
  }
}

async function applyPlan(plan) {
  let ok = 0, fail = 0;
  for (const p of plan) {
    if (p.from.join(',') === p.to.join(',')) continue;
    const r = await fetch(`${BASE}/api/combos/${p.id}`, {
      method: 'PUT',
      headers: { Cookie: ck, 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: p.to }),
    });
    if (r.ok) { console.log(`  ✓ ${p.name}`); ok++; }
    else { console.log(`  ✗ ${p.name} ${r.status}`); fail++; }
  }
  return { ok, fail };
}

async function main() {
  const cmd = (process.argv[2] || 'plan').toLowerCase();
  await login();

  console.log('='.repeat(96));
  console.log(`  10Router 智能调度  |  临期窗口 ${EXPIRING_DAYS} 天  |  ${new Date().toLocaleString('zh-CN')}`);
  console.log('='.repeat(96));

  const { plan, quota } = await buildPlan();
  printQuota(quota);
  printPlan(plan);

  if (cmd === 'apply') {
    console.log('\n' + '='.repeat(96));
    const { ok, fail } = await applyPlan(plan);
    console.log(`\n已重排 ${ok} 个，失败 ${fail} 个`);
  } else if (cmd === 'daemon') {
    const ms = Number(process.env.INTERVAL_MIN || 10) * 60000;
    console.log(`\n值守模式：每 ${ms / 60000} 分钟重排一次`);
    setInterval(async () => {
      try {
        await login();
        const { plan: p2 } = await buildPlan();
        const { ok } = await applyPlan(p2);
        console.log(`[${new Date().toLocaleString('zh-CN')}] 重排 ${ok} 个`);
      } catch (e) {
        console.log(`[${new Date().toLocaleString('zh-CN')}] 失败: ${e.message}`);
      }
    }, ms);
    await new Promise(() => {});
  } else {
    console.log('\n（只读预览。执行 apply 才会写入）');
  }
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
