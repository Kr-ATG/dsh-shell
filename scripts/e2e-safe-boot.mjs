#!/usr/bin/env node
/**
 * e2e-safe-boot.mjs — 安全启动 E2E：真实 dsh 子进程 + 隔离 DSH_HOME
 *
 * 不碰真实 ~/.dsh 与 3080 端口；使用 _tmp/safe-boot-e2e/home 作为独立 DSH_HOME，
 * 端口 3997/3996/3995。
 *
 * 覆盖：
 *  A. cordis.patch.yml 中 webserver 的 disabled 表达式抛错 → 解析为 StartupError，
 *     计划 comment-patch-entry，修复后服务可启动。
 *  B. cordis.patch.yml 语法错误 → 解析为 patch-error，计划 restore-patch-file，
 *     从备份恢复后服务可启动。
 *  C. 坏 bundle 的 patch 语法错误 → 解析为 skippedBundles，服务本身仍能启动
 *     （验证安全启动不误杀、只在需要时兜底移除）。
 *
 * 运行：node scripts/e2e-safe-boot.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const sb = require(path.join(ROOT, 'safe-boot.js'));
const yaml = require(path.join(ROOT, 'dsh-runtime', 'node_modules', 'yaml'));

const HOME = path.join(ROOT, '_tmp', 'safe-boot-e2e', 'home');
const REAL_HOME = path.join(process.env.USERPROFILE || 'C:/Users/Anti', '.dsh');
const REAL_WEB = path.join(REAL_HOME, 'profiles', 'web');
const REAL_POOL = path.join(REAL_HOME, 'profiles', 'node_modules');
const NODE = process.env.NODE_EXE || process.execPath;
const BIN = path.join(ROOT, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const PORT = 3997;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function link(target, dest) {
  try {
    if (fs.existsSync(dest)) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(target, dest, 'junction');
  } catch (error) {
    console.warn('  ! 创建 junction 失败:', dest, String(error && error.message));
  }
}

function prepareHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  const web = path.join(HOME, 'profiles', 'web');
  fs.mkdirSync(web, { recursive: true });
  link(REAL_POOL, path.join(HOME, 'profiles', 'node_modules'));
  // web profile 自己的 node_modules：真实目录 + 依赖 junction（避免污染真实目录）
  fs.mkdirSync(path.join(web, 'node_modules'), { recursive: true });
  const realPkg = JSON.parse(fs.readFileSync(path.join(REAL_WEB, 'package.json'), 'utf8'));
  for (const name of Object.keys(realPkg.dependencies || {})) {
    const src = path.join(REAL_WEB, 'node_modules', name);
    if (fs.existsSync(src)) link(src, path.join(web, 'node_modules', name));
  }
  for (const file of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
    fs.copyFileSync(path.join(REAL_WEB, file), path.join(web, file));
  }
  return web;
}

function resetProfile(web) {
  for (const file of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
    fs.copyFileSync(path.join(REAL_WEB, file), path.join(web, file));
  }
  for (const name of fs.readdirSync(web)) {
    if (name.startsWith('cordis.patch.yml.bak') || name.startsWith('cordis.patch.yml.broken') ||
        name.startsWith('package.json.bak-safe-boot')) {
      fs.rmSync(path.join(web, name), { force: true });
    }
  }
  const nm = path.join(web, 'node_modules', '@test');
  fs.rmSync(nm, { recursive: true, force: true });
}

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function killTree(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* 已退出 */ }
}

async function runService(web, timeoutMs = 30000) {
  const logs = path.join(HOME, 'logs');
  const startedAt = Date.now();
  const child = spawn(NODE, [BIN, 'web', '--port', String(PORT), '--no-open'], {
    cwd: HOME,
    env: { ...process.env, DSH_HOME: HOME },
    windowsHide: true,
  });
  let stderr = '';
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  let exit = null;
  child.on('exit', (code, signal) => { exit = { code, signal }; });
  let up = false;
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(400);
    if (await probe(PORT)) { up = true; break; }
    if (exit) break;
  }
  if (!exit) { killTree(child.pid); }
  await sleep(800);
  // 读取本次启动的 startup 诊断日志
  let startupLogText = '';
  let startupLogPath = null;
  try {
    const names = fs.readdirSync(logs).filter((n) => /^startup-.*\.log$/.test(n));
    let best = null;
    for (const n of names) {
      const fp = path.join(logs, n);
      const mtime = fs.statSync(fp).mtimeMs;
      if (mtime >= startedAt - 2000 && (!best || mtime > best.mtime)) best = { fp, mtime };
    }
    if (best) { startupLogPath = best.fp; startupLogText = fs.readFileSync(best.fp, 'utf8'); }
  } catch { /* 无日志 */ }
  // parseStartupFailure 的 evidence 字段名是 stderrText/stdoutText；
  // 这里同时保留原始 stderr/stdout 便于断言失败时打印。
  return { up, exit, stderr, stdout, stderrText: stderr, stdoutText: stdout, startupLogText, startupLogPath, startedAt };
}

function makeCtx(web) {
  const stateDir = path.join(HOME, 'safe-boot-state');
  fs.mkdirSync(stateDir, { recursive: true });
  return { profileDir: web, dshHome: HOME, stateDir, logDir: stateDir, yaml };
}

function applyFirstPlan(web, diagnosis) {
  const ctx = makeCtx(web);
  const state = sb.readSafeBootState(ctx);
  const plans = sb.planSafeBootFixes(diagnosis, ctx);
  if (plans.length === 0) return { plans, applied: null };
  const applied = sb.applySafeBootFix(ctx, state, plans[0]);
  return { plans, applied };
}

let passed = 0;
async function caseRun(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    console.error('  ✗ ' + name);
    throw error;
  }
}

async function main() {
  console.log('safe-boot E2E（隔离 DSH_HOME: ' + HOME + '，端口 ' + PORT + '）');
  const web = prepareHome();
  const patchPath = path.join(web, 'cordis.patch.yml');

  // ---------------- 案例 A：webserver disabled 表达式抛错 ----------------
  await caseRun('A. disabled 表达式抛错 → comment-patch-entry → 服务恢复', async () => {
    resetProfile(web);
    const original = fs.readFileSync(patchPath, 'utf8');
    fs.writeFileSync(patchPath, original + '\n# E2E: 坏插件配置\n- id: webserver\n  disabled: !!js \'(() => { throw new Error("boom from e2e plugin") })()\'\n', 'utf8');
    const bad = await runService(web);
    assert.equal(bad.up, false, '破坏后服务不应就绪');
    assert.ok(bad.exit, '进程应退出（StartupError）');
    const diag = sb.parseStartupFailure(bad);
    assert.equal(diag.kind, 'startup-error', diag.summary);
    assert.equal(diag.failedPlugins[0].id, 'webserver');
    assert.match(diag.failedPlugins[0].error, /boom from e2e plugin/);
    const { plans, applied } = applyFirstPlan(web, diag);
    assert.ok(plans.length > 0, '应有修复计划');
    assert.equal(plans[0].action, 'comment-patch-entry');
    assert.equal(applied.ok, true, applied.detail);
    const fixed = fs.readFileSync(patchPath, 'utf8');
    assert.match(fixed, /# - id: webserver/);
    const good = await runService(web);
    assert.equal(good.up, true, '修复后服务应可启动；stderr=' + good.stderr.slice(-500));
    // 状态与记录
    const ctx = makeCtx(web);
    const state = sb.readSafeBootState(ctx);
    assert.equal(state.patchEdits.length, 1);
    assert.match(sb.describeSafeBootState(state), /注释 1 个补丁条目/);
  });

  // ---------------- 案例 B：cordis.patch.yml 语法错误 → 从备份恢复 ----------------
  await caseRun('B. patch 语法错误 → restore-patch-file → 服务恢复', async () => {
    resetProfile(web);
    fs.writeFileSync(path.join(web, 'cordis.patch.yml.bak-20260101-000000'), '[]\n', 'utf8');
    fs.writeFileSync(patchPath, '- id: [unclosed\n', 'utf8');
    const bad = await runService(web);
    assert.equal(bad.up, false);
    assert.ok(bad.exit);
    if (process.env.DEBUG_E2E) {
      console.log('--- DEBUG B stderr ---\n' + bad.stderr + '\n--- stdout ---\n' + bad.stdout + '\n--- startupLog ---\n' + bad.startupLogText);
    }
    const diag = sb.parseStartupFailure(bad);
    if (process.env.DEBUG_E2E) console.log('--- DEBUG B diag ---', JSON.stringify({ kind: diag.kind, patchErrors: diag.patchErrors, summary: diag.summary }, null, 2));
    assert.equal(diag.kind, 'patch-error', diag.summary);
    assert.ok(diag.patchErrors.some((e) => e.file.toLowerCase().endsWith('cordis.patch.yml')));
    const { plans, applied } = applyFirstPlan(web, diag);
    assert.ok(plans.length > 0);
    assert.equal(plans[0].action, 'restore-patch-file');
    assert.equal(applied.ok, true, applied.detail);
    const good = await runService(web);
    assert.equal(good.up, true, '恢复后服务应可启动；stderr=' + good.stderr.slice(-500));
  });

  // ---------------- 案例 C：坏 bundle patch 被跳过，服务仍可启动 ----------------
  await caseRun('C. 坏 bundle（skipping）不阻断启动，计划只做兜底移除', async () => {
    resetProfile(web);
    const bundleDir = path.join(web, 'node_modules', '@test', 'broken-bundle');
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'package.json'), JSON.stringify({
      name: '@test/broken-bundle', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(bundleDir, 'cordis.patch.yml'), '- id: [unclosed\n', 'utf8');
    const pkgPath = path.join(web, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.dsh.profile.bundles.push('@test/broken-bundle');
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    const res = await runService(web);
    assert.equal(res.up, true, '坏 bundle 只应被跳过，服务仍能启动；stderr=' + res.stderr.slice(-500));
    const diag = sb.parseStartupFailure(res);
    assert.equal(diag.skippedBundles.length, 1, diag.summary);
    assert.equal(diag.skippedBundles[0].name, '@test/broken-bundle');
    const ctx = makeCtx(web);
    const plans = sb.planSafeBootFixes(diag, ctx);
    const remove = plans.find((p) => p.action === 'remove-bundle');
    assert.ok(remove, '应生成兜底移除计划');
    assert.equal(remove.priority, 10);
  });

  // ---------------- 案例 D：普通可选插件 import 失败不阻断启动 ----------------
  await caseRun('D. 可选插件 import 失败（warning）不阻断启动', async () => {
    resetProfile(web);
    const original = fs.readFileSync(patchPath, 'utf8');
    fs.writeFileSync(patchPath, original + '\n- id: e2e-missing-plugin\n  name: \'@test/missing-plugin\'\n', 'utf8');
    const res = await runService(web);
    assert.equal(res.up, true, '非 required 插件失败不应阻断启动；stderr=' + res.stderr.slice(-500));
    const diag = sb.parseStartupFailure(res);
    // 不应产生禁用计划（没有 required 启动失败，安全启动不该动配置）
    const ctx = makeCtx(web);
    const plans = sb.planSafeBootFixes(diag, ctx);
    assert.equal(plans.filter((p) => p.action === 'disable-entry').length, 0);
  });

  console.log('\n全部通过：' + passed + ' 个 E2E 案例');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
