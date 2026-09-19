#!/usr/bin/env node
/**
 * 一键验收：build → unit → 起服务 → api-audit → eval → calibrate。
 *
 * 用法（仓库根）：
 *   node scripts/verify.mjs            # 全跑
 *   node scripts/verify.mjs --quick    # 跳过 web 构建与 eval（改后端时用）
 *
 * 设计要点：
 *   - 用独立端口（默认 8791）起服务，避免和正在开发中的 8787 打架；
 *   - 服务从构建产物启动（部署路径），确保测的是 dist 而不是 src；
 *   - 任一步失败即汇总非零退出，方便接 CI。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quick = process.argv.includes('--quick');
const PORT = Number(process.env.VERIFY_PORT || 8791);
const BASE = `http://127.0.0.1:${PORT}`;
const isWin = process.platform === 'win32';
/** Windows 上 npm 是 .cmd，直接用 shell:false 调用，避免 shell 拼接带来的转义问题与告警 */
const NPM = isWin ? 'npm.cmd' : 'npm';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

function run(command, opts = {}) {
  return new Promise((resolve) => {
    // 传单个命令字符串 + shell：避免 Node 对 .cmd 的限制，也不触发 args+shell 的告警
    const child = spawn(command, {
      cwd: root,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function killTree(pid) {
  if (!pid) return;
  if (isWin) await run(`taskkill /PID ${pid} /T /F`);
  else process.kill(-pid, 'SIGTERM');
}

async function main() {
  const t0 = Date.now();
  console.log(`== 一键验收（root=${root} port=${PORT}${quick ? ' quick' : ''}）==\n`);

  // 1) 构建
  const build = await run(quick ? `${NPM} run build -w server` : `${NPM} run build`);
  record('build', build.code === 0, build.code === 0 ? '' : build.out.slice(-400));

  // 2) 单元测试
  const unit = await run(`${NPM} test -w server`);
  const unitLine = (unit.out.match(/^ℹ pass \d+/m) || unit.out.match(/^ℹ tests \d+/m) || [''])[0];
  record('unit', unit.code === 0, unitLine.trim());

  // 3) 检索评测（不写基线，避免污染仓库）
  if (!quick) {
    const ev = await run(`${NPM} run eval:retrieval -- --no-write`);
    const m = ev.out.match(/"top1Rate": ([\d.]+)/);
    const blocked = ev.out.match(/"gateBlockedCount": (\d+)/);
    record(
      'eval:retrieval',
      ev.code === 0 && !!m && Number(m[1]) >= 0.9 && blocked?.[1] === '0',
      m ? `top1=${m[1]} gateBlocked=${blocked?.[1]}` : ev.out.slice(-300),
    );
  }

  // 4) 起服务（构建产物）+ api-audit
  const server = spawn('node', ['server/dist/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !isWin,
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  try {
    const health = await waitForHealth();
    record('server-start', !!health, health ? `chunks=${health.knowledgeChunks} mode=${health.retrieval?.mode}` : serverLog.slice(-400));
    if (health) {
      const audit = await run('node server/scripts/api-audit.mjs', { env: { AUDIT_BASE: BASE } });
      const summary = (audit.out.match(/SUMMARY .*/) || [''])[0];
      record('api-audit', audit.code === 0, summary.trim());
      if (audit.code !== 0) console.log(audit.out.split('\n').filter((l) => l.startsWith('FAIL')).join('\n'));
    }
  } finally {
    await killTree(server.pid);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n== 汇总 ${results.length - failed.length}/${results.length} 通过（${((Date.now() - t0) / 1000).toFixed(1)}s）==`);
  if (failed.length) {
    console.log('未通过：' + failed.map((f) => f.name).join(', '));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

