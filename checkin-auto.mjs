#!/usr/bin/env node
/**
 * 自动签到 —— WorkBuddy 国内版 + Trae CN
 *
 * 设计要点（参考 dsh-multi-router 插件的实现）：
 *   1. 只加载国内版账号，国际版没有签到活动（旧版会报 code=undefined）
 *   2. 本地日记去重：同一天同一账号只提交一次，重启不重复
 *   3. 先查状态再领取，已签/活动结束直接跳过
 *   4. 只读状态查询失败会重试（2s、4s），领取请求不重试（避免重复领）
 *   5. 记录保留 30 天，损坏时备份重建而非清空
 *
 * 用法:
 *   node checkin-auto.mjs status     只看状态
 *   node checkin-auto.mjs claim      立即签到
 *   node checkin-auto.mjs daemon     常驻值守（每 6 小时）
 *   node checkin-auto.mjs once       供计划任务调用
 */
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ACC = join(homedir(), '.dsh', 'multi-router', 'accounts');
const DB_PATH = join(process.env.APPDATA || '', '10router', 'db', 'data.sqlite');
const JOURNAL = join(HERE, 'checkin-journal.json');
const LOG = join(HERE, 'logs', 'checkin.log');

// 北京时间
const BJ_OFFSET = 8 * 60 * 60 * 1000;
function bjDay(ts = Date.now()) {
  return new Date(ts + BJ_OFFSET).toISOString().slice(0, 10);
}
function bjNow() {
  return new Date(Date.now() + BJ_OFFSET).toISOString().slice(11, 16);
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    writeFileSync(LOG, line + '\n', { flag: 'a', encoding: 'utf8' });
  } catch {}
}

function jwt(t) {
  try {
    const p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(p + '='.repeat((4 - (p.length % 4)) % 4), 'base64').toString('utf8'));
  } catch { return null; }
}

// 从 10Router 读取 uid → 自定义连接名 映射
//
// 10Router 把 token 加密存为 enc:v1:...，无法解码出 uid。
// 但它保存了 expiresAt（token 到期时间），而账号目录的 credential.json
// 也有 expiresAtMs —— 两者来自同一份 token，到期时间必然相同。
// 因此用「到期时间」作为关联键，容差 120 秒（刷新会造成 1~2 秒漂移）。
async function loadConnectionNames(accounts) {
  const map = new Map();
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const rows = db.prepare('SELECT name, data FROM providerConnections WHERE provider = ?').all('codebuddy-cn');
    const byExpiry = [];
    for (const r of rows) {
      let d = {};
      try { d = JSON.parse(r.data || '{}'); } catch {}
      const at = d.expiresAt ? Date.parse(d.expiresAt) : NaN;
      if (Number.isFinite(at) && r.name) byExpiry.push({ sec: Math.floor(at / 1000), name: r.name });
    }
    db.close();

    for (const a of accounts) {
      if (!a.exp) continue;
      const sec = Math.floor(a.exp / 1000);
      let best = null, bestDiff = Infinity;
      for (const r of byExpiry) {
        const diff = Math.abs(r.sec - sec);
        if (diff < bestDiff) { bestDiff = diff; best = r; }
      }
      if (best && bestDiff <= 120) map.set(a.uid, best.name);
    }
  } catch {
    // sqlite 不可用：静默降级为目录名
  }

  // Trae 的连接名（openai-compatible 类型没有 token 到期时间，按前缀匹配）
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const rows = db.prepare("SELECT name, data FROM providerConnections WHERE provider LIKE 'openai-compatible%'").all();
    for (const r of rows) {
      let d = {};
      try { d = JSON.parse(r.data || '{}'); } catch {}
      if ((d.providerSpecificData?.prefix || '') === 'trsolo') map.set('trae-conn', r.name);
    }
    db.close();
  } catch {}
  return map;
}

// ---- Trae 账号与签到 ----
// Trae 的 uid 在 userId 或 JWT 的 data.id，签到接口需要完整设备头
function loadTraeAccounts() {
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
    const p = jwt(c.accessToken) || {};
    const isTrae = /trae/i.test(c.host || '') || /trae/i.test(p.iss || '');
    if (!isTrae) continue;
    if ((c.expiresAtMs || 0) <= Date.now()) continue;
    out.push({
      uid: c.userId || p.data?.id,
      token: c.accessToken,
      exp: c.expiresAtMs,
      name: c.accountName || n,
      host: c.host || 'https://api.trae.cn',
    });
  }
  // 按 uid 去重取最晚过期
  const m = new Map();
  for (const a of out) {
    const prev = m.get(a.uid);
    if (!prev || a.exp > prev.exp) m.set(a.uid, a);
  }
  return [...m.values()];
}

function traeHeaders(a) {
  return {
    Authorization: `Cloud-IDE-JWT ${a.token}`,
    'X-Ide-Token': a.token,
    'X-Cloudide-Token': a.token,
    'x-uid': String(a.uid),
    'x-plugin-channel': 'icube-ai',
    'User-Agent': 'Trae/1.0',
    'x-app-id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function traeCheckinStatus(a) {
  const r = await fetch('https://api.trae.cn/trae/api/v2/ug/checkin_credits/status', {
    method: 'POST', headers: traeHeaders(a), body: '{}', signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => null);
  if (!j || j.code !== 0) throw new Error(`code=${j?.code} ${j?.message || ''}`);
  return j;
}

async function traeClaim(a) {
  const r = await fetch('https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim', {
    method: 'POST', headers: traeHeaders(a), body: '{}', signal: AbortSignal.timeout(20000),
  });
  return r.json().catch(() => null);
}

async function traeClaimFlow(a, journal) {
  const key = `trae:${a.uid}|${bjDay()}`;
  const rec = journal.records[key];
  if (rec && ['claimed', 'already-claimed'].includes(rec.status)) {
    return { status: 'skipped-today', msg: '今日已处理' };
  }
  try {
    const st = await traeCheckinStatus(a);
    if (st.checked_in === true) {
      journal.records[key] = { status: 'already-claimed', at: Date.now(), day: bjDay() };
      saveJournal(journal);
      return { status: 'already-claimed', msg: '今日已签到' };
    }
    if (st.enable === false) {
      journal.records[key] = { status: 'no-campaign', at: Date.now(), day: bjDay() };
      saveJournal(journal);
      return { status: 'no-campaign', msg: '签到未开放' };
    }
    const result = await traeClaim(a);
    const claimed = result?.code === 0 || result?.checked_in === true;
    if (!claimed) {
      // 9095 = 该设备今天已领取
      const status = result?.code === 9095 ? 'device-used' : 'paused';
      journal.records[key] = { status, at: Date.now(), day: bjDay() };
      saveJournal(journal);
      return { status, msg: `code=${result?.code} ${result?.message || ''}` };
    }
    journal.records[key] = { status: 'claimed', at: Date.now(), day: bjDay() };
    saveJournal(journal);
    return { status: 'claimed', msg: '签到成功', amount: result?.credits };
  } catch (e) {
    journal.records[key] = { status: 'retryable', at: Date.now(), day: bjDay() };
    saveJournal(journal);
    return { status: 'retryable', msg: e.message };
  }
}

// ---- WorkBuddy 国内版账号 ----
function loadAccounts() {
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
    const p = jwt(c.accessToken) || {};
    const iss = p.iss || '';
    // 只认国内版：workbuddy.cn / codebuddy.cn / copilot.tencent.com
    const isCN = /codebuddy\.cn|copilot\.tencent\.com|workbuddy\.cn/.test(iss);
    if (!isCN) continue;
    if ((c.expiresAtMs || 0) <= Date.now()) continue;
    out.push({
      uid: p.sub || c.uid,
      token: c.accessToken,
      refreshToken: c.refreshToken || null,
      exp: c.expiresAtMs,
      name: n,
    });
  }
  const m = new Map();
  for (const a of out) {
    const prev = m.get(a.uid);
    if (!prev || a.exp > prev.exp) m.set(a.uid, a);
  }
  return [...m.values()];
}

// ---- 签到日记 ----
// { records: { "uid|2026-10-19": {status, at, day, amount} }, devices: {}, pauses: {} }
function loadJournal() {
  const empty = { records: {}, devices: {}, pauses: {} };
  if (!existsSync(JOURNAL)) return empty;
  try {
    const j = JSON.parse(readFileSync(JOURNAL, 'utf8'));
    if (!j || typeof j !== 'object') throw new Error('bad');
    if (!j.records || typeof j.records !== 'object') throw new Error('bad');
    // 清理 30 天前（保留重复检测所需的近期记录）
    const cutoff = bjDay(Date.now() - 30 * 86400000);
    for (const k of Object.keys(j.records)) {
      const day = k.split('|')[1];
      if (day && day < cutoff) delete j.records[k];
    }
    return { records: j.records, devices: j.devices || {}, pauses: j.pauses || {} };
  } catch {
    log('⚠ 签到记录损坏，已备份并重建');
    try { renameSync(JOURNAL, JOURNAL + '.broken-' + Date.now()); } catch {}
    return empty;
  }
}

function saveJournal(j) {
  const tmp = JOURNAL + '.tmp';
  writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf8');
  renameSync(tmp, JOURNAL);
}

function headers(a) {
  return {
    Authorization: `Bearer ${a.token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Accept-Encoding': 'identity',
    Host: 'www.workbuddy.cn',
    Origin: 'https://www.workbuddy.cn',
    Referer: 'https://www.workbuddy.cn/profile/growth-center',
    'User-Agent': 'Mozilla/5.0',
    'X-User-Id': String(a.uid),
  };
}

const BASE = 'https://www.workbuddy.cn/v2/billing/meter';

async function post(path, a) {
  const r = await fetch(`${BASE}/${path}`, {
    method: 'POST',
    headers: headers(a),
    body: '{}',
    signal: AbortSignal.timeout(20000),
    redirect: 'error',
  });
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status}`);
    err.status = r.status;
    err.transient = r.status >= 500;
    throw err;
  }
  const body = await r.json().catch(() => null);
  if (body?.code === 401 || body?.code === 40100) {
    const err = new Error('token 失效');
    err.status = 401;
    throw err;
  }
  if ([403, 429].includes(body?.code)) {
    const err = new Error(`平台限制 code=${body.code}`);
    err.status = body.code;
    throw err;
  }
  return body;
}

// 只读状态查询：失败重试 2 次（2s、4s），因为只读操作重试安全
async function queryStatus(a) {
  for (let i = 0; ; i++) {
    try {
      const body = await post('checkin-activity-status', a);
      if (![0, 200].includes(body?.code) || !body.data) throw new Error(`状态异常 code=${body?.code}`);
      return body.data;
    } catch (e) {
      if (!e.transient || i >= 2) throw e;
      await new Promise((r) => setTimeout(r, (i + 1) * 2000));
    }
  }
}

function activity(d) {
  const rawEnd = d.end_time;
  const endsAt = typeof rawEnd === 'string'
    ? Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rawEnd) ? `${rawEnd.replace(' ', 'T')}+08:00` : rawEnd)
    : undefined;
  return { streakDays: d.streak_days, totalCredits: d.total_credits, endsAt };
}

async function claimFor(a, journal) {
  const key = `${a.uid}|${bjDay()}`;
  const rec = journal.records[key];
  // 已成功过：不重复提交
  if (rec && ['claimed', 'already-claimed'].includes(rec.status)) {
    return { status: 'skipped-today', msg: '今日已处理' };
  }
  // 平台暂停：不自动恢复，需人工处理
  if (journal.pauses[a.uid]) {
    return { status: 'paused', msg: '平台暂停中，需人工恢复' };
  }

  let submitted = false;
  try {
    const st = await queryStatus(a);
    const act = activity(st);

    if (st.today_checked_in === true) {
      journal.records[key] = { status: 'already-claimed', at: Date.now(), day: bjDay() };
      saveJournal(journal);
      return { status: 'already-claimed', msg: '今日已签到', act };
    }
    if (st.active === false || (act.endsAt && act.endsAt <= Date.now())) {
      journal.records[key] = { status: 'no-campaign', at: Date.now(), day: bjDay() };
      saveJournal(journal);
      return { status: 'no-campaign', msg: '活动未开放或已结束', act };
    }
    if (st.today_checked_in !== false) {
      throw new Error('签到状态未知');
    }

    submitted = true;
    const result = await post('daily-checkin', a);
    const claimed = [0, 200].includes(result?.code);
    const already = /今天已签到|今日已签到|already\s+(?:checked|signed)/i.test(result?.msg || '');

    if (!claimed && !already) {
      const st2 = Number.isFinite(result?.code) ? 'paused' : 'uncertain';
      if (st2 === 'paused') journal.pauses[a.uid] = { at: Date.now(), code: result?.code };
      journal.records[key] = { status: st2, at: Date.now(), day: bjDay() };
      saveJournal(journal);
      return { status: st2, msg: `code=${result?.code} ${result?.msg || ''}` };
    }

    // 领取后刷新状态拿最新连签天数
    let finalAct = act;
    try {
      const after = await queryStatus(a);
      if (after?.data) finalAct = activity(after.data);
      else if (after) finalAct = activity(after);
    } catch {}

    const amount = claimed && Number.isFinite(result?.data?.credit) ? result.data.credit : undefined;
    journal.records[key] = {
      status: already ? 'already-claimed' : 'claimed',
      at: Date.now(), day: bjDay(),
      ...(amount != null ? { amount } : {}),
    };
    saveJournal(journal);
    return {
      status: already ? 'already-claimed' : 'claimed',
      msg: already ? '今日已签到' : '签到成功',
      act: finalAct, amount,
    };
  } catch (e) {
    const status = e.status === 401 ? 'auth-invalid'
      : [403, 429].includes(e.status) ? 'paused'
      : submitted ? 'uncertain' : 'retryable';
    if (status === 'paused') journal.pauses[a.uid] = { at: Date.now(), code: e.status };
    journal.records[key] = { status, at: Date.now(), day: bjDay() };
    saveJournal(journal);
    return { status, msg: e.message };
  }
}

function fmt(r) {
  const map = {
    claimed: '✓ 签到成功', 'already-claimed': '• 今日已签',
    'skipped-today': '• 今日已处理', 'no-campaign': '• 无活动/已结束',
    retryable: '✗ 查询失败', paused: '⚠ 平台暂停',
    'auth-invalid': '✗ 令牌失效', uncertain: '? 待核对',
    'device-used': '⚠ 设备已领取',
  };
  return (map[r.status] || r.status) + (r.amount ? ` +${r.amount}` : '') + (r.msg && !map[r.status] ? ` (${r.msg})` : '');
}

async function main() {
  const cmd = (process.argv[2] || 'status').toLowerCase();
  const journal = loadJournal();
  const accounts = loadAccounts();

  // 用 10Router 里的自定义连接名覆盖目录名
  const nameMap = await loadConnectionNames(accounts);
  for (const a of accounts) {
    const custom = nameMap.get(a.uid);
    if (custom) a.name = custom;
  }

  if (cmd === 'status') {
    console.log('='.repeat(70));
    console.log('  自动签到状态  ·  WorkBuddy 国内 + Trae CN');
    console.log('='.repeat(70));
    if (!accounts.length) { console.log('\n  无可用国内版账号'); process.exit(1); }
    for (const a of accounts) {
      try {
        const st = await queryStatus(a);
        const key = `${a.uid}|${bjDay()}`;
        const rec = journal.records[key];
        console.log(`\n  ${a.name}  (${String(a.uid).slice(0, 8)}…)`);
        console.log(`    今日      : ${st.today_checked_in ? '✓ 已签到' : '✗ 未签到'}`);
        console.log(`    连续签到  : ${st.streak_days} 天`);
        console.log(`    每日奖励  : ${st.daily_credit} 积分`);
        console.log(`    累计获得  : ${st.total_credits} 积分`);
        console.log(`    活动      : ${st.theme_name || '-'} / ${st.activity_name || '-'}`);
        console.log(`    活动期限  : ${st.start_time} ~ ${st.end_time}`);
        if (rec) console.log(`    今日记录  : ${rec.status} @ ${new Date(rec.at).toLocaleString()}`);
        if (journal.pauses[a.uid]) console.log(`    ⚠ 平台暂停  : ${new Date(journal.pauses[a.uid].at).toLocaleString()}`);
      } catch (e) {
        console.log(`\n  ${a.name}  (${String(a.uid).slice(0, 8)}…)`);
        console.log(`    ✗ 查询失败: ${e.message}`);
      }
    }

    // Trae
    const traes = loadTraeAccounts();
    if (traes.length) {
      console.log('\n' + '─'.repeat(70));
      console.log('  Trae CN');
      console.log('─'.repeat(70));
      const traeConnName = nameMap.get('trae-conn') || '';
      for (const t of traes) {
        const label = traeConnName ? `${traeConnName}（${t.name}）` : t.name;
        try {
          const st = await traeCheckinStatus(t);
          const key = `trae:${t.uid}|${bjDay()}`;
          const rec = journal.records[key];
          console.log(`\n  ${label}  (${String(t.uid).slice(0, 8)}…)`);
          console.log(`    今日      : ${st.checked_in ? '✓ 已签到' : '✗ 未签到'}`);
          console.log(`    签到积分  : ${st.credits ?? '-'}`);
          console.log(`    额外奖励  : ${st.extra_credits ?? '-'}`);
          console.log(`    功能开关  : ${st.enable ? '已开放' : '未开放'}`);
          if (rec) console.log(`    今日记录  : ${rec.status} @ ${new Date(rec.at).toLocaleString()}`);
        } catch (e) {
          console.log(`\n  ${label}  (${String(t.uid).slice(0, 8)}…)`);
          console.log(`    ✗ 查询失败: ${e.message}`);
        }
      }
    }
    return;
  }

  if (cmd === 'claim' || cmd === 'once' || cmd === 'daemon') {
    const target = bjNow();
    console.log('='.repeat(70));
    console.log(`  自动签到  ${cmd}  (北京时间 ${target})`);
    console.log('='.repeat(70));
    if (!accounts.length) { console.log('\n  无可用国内版账号'); process.exit(1); }

    // WorkBuddy 国内版
    console.log('\n[WorkBuddy 国内版]');
    for (const a of accounts) {
      const r = await claimFor(a, journal);
      log(`${a.name} ${fmt(r)}`);
    }

    // Trae
    const traes = loadTraeAccounts();
    if (traes.length) {
      console.log('\n[Trae CN]');
      for (const t of traes) {
        const r = await traeClaimFlow(t, journal);
        log(`${t.name} ${fmt(r)}`);
      }
    }

    const today = Object.entries(journal.records).filter(([k]) => k.endsWith(`|${bjDay()}`));
    const ok = today.filter(([, v]) => ['claimed', 'already-claimed'].includes(v.status)).length;
    log(`汇总: ${ok}/${accounts.length + traes.length} 已签到`);

    if (cmd === 'daemon') {
      log('进入值守模式，每 6 小时检查一次');
      setInterval(async () => {
        const j = loadJournal();
        for (const a of loadAccounts()) {
          const r = await claimFor(a, j);
          log(`${a.name} ${fmt(r)}`);
        }
        for (const t of loadTraeAccounts()) {
          const r = await traeClaimFlow(t, j);
          log(`${t.name} ${fmt(r)}`);
        }
      }, 6 * 60 * 60 * 1000);
      await new Promise(() => {});
    }
    return;
  }

  console.log('用法: node checkin-auto.mjs [status|claim|daemon|once]');
}

main().catch((e) => { log('FATAL ' + e.message); process.exit(1); });
