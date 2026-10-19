#!/usr/bin/env node
/**
 * 命令行总控制台
 *
 * 一个窗口搞定：启动/停止/状态/签到/用量
 *
 * 用法: node console.mjs
 */
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;

const SERVICES = [
  {
    name: '10Router',
    port: 20128,
    health: 'http://127.0.0.1:20128/api/health',
    cwd: join(HERE, 'packages', 'node_modules', '@techysy', '10router'),
    args: ['cli.js', '--no-tray', '--host', '127.0.0.1', '--port', '20128'],
    env: { INITIAL_PASSWORD: process.env.ROUTER_PASSWORD || '' },
  },
  { name: 'intl-gateway', port: 18996, health: 'http://127.0.0.1:18996/health', cwd: HERE, args: ['intl-gateway.mjs', '18996'], env: {} },
  { name: 'trae-gateway', port: 18997, health: 'http://127.0.0.1:18997/health', cwd: HERE, args: ['trae-gateway.mjs', '18997'], env: {} },
  { name: '监控台', port: 20129, health: 'http://127.0.0.1:20129/api/snapshot', cwd: HERE, args: ['monitor-server.mjs', '20129'], env: {} },
];

function portOpen(port) {
  return new Promise((res) => {
    const s = createConnection({ host: '127.0.0.1', port, timeout: 1200 });
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => { s.destroy(); res(false); });
    s.once('timeout', () => { s.destroy(); res(false); });
  });
}

async function healthOk(svc) {
  try {
    const r = await fetch(svc.health, { signal: AbortSignal.timeout(3500) });
    const j = await r.json().catch(() => ({}));
    return r.ok && j.ok !== false;
  } catch { return false; }
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(NODE, [cmd, ...args], {
      cwd: HERE,
      stdio: 'inherit',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    p.on('exit', (c) => resolve(c ?? 0));
  });
}

function startDetached(svc) {
  const child = spawn(NODE, svc.args, {
    cwd: svc.cwd,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...svc.env },
  });
  child.unref();
  return child.pid;
}

async function showStatus() {
  console.log('\n' + '─'.repeat(60));
  console.log('  服务状态');
  console.log('─'.repeat(60));
  for (const svc of SERVICES) {
    const open = await portOpen(svc.port);
    const ok = open && (await healthOk(svc));
    console.log(`  ${ok ? '●' : '○'} ${svc.name.padEnd(16)} :${svc.port}   ${ok ? '运行中' : '已停止'}`);
  }
  console.log('─'.repeat(60));
}

async function startAll() {
  console.log('\n启动所有服务...');
  for (const svc of SERVICES) {
    if (await portOpen(svc.port)) {
      console.log(`  ${svc.name} 已在运行，跳过`);
      continue;
    }
    const pid = startDetached(svc);
    console.log(`  ${svc.name} 启动中 PID=${pid}`);
    const deadline = Date.now() + 90000;
    let ok = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      if (await healthOk(svc)) { ok = true; break; }
    }
    console.log(`  ${svc.name} ${ok ? '✓ 就绪' : '✗ 超时'}`);
  }
  await showStatus();
}

async function stopAll() {
  console.log('\n停止所有服务...');
  for (const svc of [...SERVICES].reverse()) {
    try {
      const out = execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${svc.port} -State Listen -EA SilentlyContinue | Select-Object -ExpandProperty OwningProcess"`,
        { encoding: 'utf8', windowsHide: true }
      ).trim();
      if (!out) { console.log(`  ${svc.name} 未运行`); continue; }
      for (const pid of out.split(/\s+/).filter(Boolean)) {
        execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore', windowsHide: true });
      }
      console.log(`  ${svc.name} 已停止`);
    } catch {
      console.log(`  ${svc.name} 停止失败`);
    }
  }
  await showStatus();
}

// ---- 主菜单 ----
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

async function main() {
  while (true) {
    console.clear?.();
    console.log('='.repeat(60));
    console.log('  ╔══════════════════════════════════════════════════════╗');
    console.log('  ║        10Router 总控制台  ·  全部账号与服务          ║');
    console.log('  ╚══════════════════════════════════════════════════════╝');
    console.log('='.repeat(60));
    await showStatus();
    console.log(`
  [1] 启动全部服务
  [2] 停止全部服务
  [3] 守护模式（掉线自动重启，Ctrl+C 退出）
  [4] 签到面板（状态）
  [5] 立即签到（全部账号）
  [6] 用量统计（按账号）
  [7] 自动签到任务状态
  [8] 查看仪表盘地址
  [0] 退出
`);

    const ch = (await ask('  请选择: ')).trim();

    if (ch === '1') { await startAll(); await ask('\n  按回车继续...'); }
    else if (ch === '2') { await stopAll(); await ask('\n  按回车继续...'); }
    else if (ch === '3') { rl.close(); await run('guardian.mjs', []); return; }
    else if (ch === '4') { await run('checkin-auto.mjs', ['status']); await ask('\n  按回车继续...'); }
    else if (ch === '5') { await run('checkin-auto.mjs', ['claim']); await ask('\n  按回车继续...'); }
    else if (ch === '6') { await run('usage-by-account.mjs', []); await ask('\n  按回车继续...'); }
    else if (ch === '7') {
      console.log('\n  自动签到任务（Windows 计划任务）');
      console.log('  ' + '─'.repeat(56));
      try {
        const out = execSync(
          'powershell -NoProfile -Command "Get-ScheduledTask -TaskName \'WorkBuddy每日签到\' -EA SilentlyContinue | Select-Object TaskName,State | Format-List; Get-ScheduledTaskInfo -TaskName \'WorkBuddy每日签到\' -EA SilentlyContinue | Select-Object LastRunTime,LastTaskResult,NextRunTime | Format-List"',
          { encoding: 'utf8', windowsHide: true }
        );
        console.log(out.trim() ? out : '  未找到计划任务「WorkBuddy每日签到」');
      } catch (e) {
        console.log('  查询失败: ' + e.message);
      }
      const jf = join(HERE, 'checkin-journal.json');
      if (existsSync(jf)) {
        try {
          const j = JSON.parse(readFileSync(jf, 'utf8'));
          const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
          const recs = Object.entries(j.records || {}).filter(([k]) => k.endsWith('|' + today));
          console.log(`\n  今日记录（${today}）: ${recs.length} 条`);
          for (const [k, v] of recs) {
            console.log(`    ${k.split('|')[0].slice(0, 18)}…  ${v.status}  ${new Date(v.at).toLocaleString()}`);
          }
          const pauses = Object.keys(j.pauses || {});
          if (pauses.length) console.log(`\n  ⚠ 平台暂停: ${pauses.length} 个账号`);
        } catch {}
      }
      await ask('\n  按回车继续...');
    }
    else if (ch === '8') {
      console.log(`
  仪表盘    : http://localhost:20128/dashboard
  API 地址  : http://127.0.0.1:20128/v1
  监控台    : http://127.0.0.1:20129
  国际版网关: http://127.0.0.1:18996
  Trae 网关 : http://127.0.0.1:18997
`);
      await ask('  按回车继续...');
    }
    else if (ch === '0') { rl.close(); return; }
  }
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
