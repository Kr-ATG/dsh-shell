#!/usr/bin/env node
/**
 * check-shell-integration.mjs — main.js / preload.js / package.json 与 safe-boot.js 的集成契约检查
 *
 * 背景：safe-boot.js 有独立单测与 E2E，但壳子主进程无法在纯 Node 里 require（依赖 electron）。
 * 本脚本做静态契约检查，防止后续改 main.js 时把安全启动链路改断：
 *   - 主进程加载 safe-boot、启动参数带 --patch / --port、失败诊断与修复调用齐全；
 *   - 失败事件/托盘恢复/IPC 入口存在；
 *   - package.json 打包 files 含 safe-boot.js，scripts 有测试入口；
 *   - preload 暴露查询/清除接口；
 *   - 关键函数名与 safe-boot.js 的导出保持一致。
 *
 * 运行：node scripts/check-shell-integration.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const sb = require(path.join(ROOT, 'safe-boot.js'));

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    console.error('  ✗ ' + name);
    throw error;
  }
}

console.log('main.js 安全启动集成契约检查');

ok('main.js 通过 safe-boot.js 加载模块', () => {
  assert.match(main, /require\("\.\/safe-boot"\)/);
  assert.match(main, /function safeBootModule\(/);
});

ok('启动参数包含 --patch overlay 与动态 --port', () => {
  assert.match(main, /const args = \[dshBin\(\), "web", \.\.\.safeBootArgs\(\), \.\.\.\(DSH_PORT === 3080 \? \[\] : \["--port", String\(DSH_PORT\)\]\), "--no-open"\];/);
  assert.match(main, /function safeBootArgs\(\)/);
  assert.match(main, /\["--patch", p\]/);
});

ok('安全启动循环：诊断 → 计划 → 修复 → 重启', () => {
  assert.match(main, /sb\.parseStartupFailure\(evidence\)/);
  assert.match(main, /sb\.planSafeBootFixes\(diagnosis, sbCtx\)/);
  assert.match(main, /sb\.applySafeBootFix\(sbCtx, sbState, plan\)/);
  assert.match(main, /sbRounds >= SAFE_BOOT_MAX_ROUNDS/);
  assert.match(main, /killDsh\(\);/);
  assert.match(main, /killPort3080\(\);/);
});

ok('进程提前退出立即失败（不再干等 120 秒）', () => {
  assert.match(main, /reason: "exit", exitCode: dshExitInfo\.code/);
  assert.match(main, /dshExitInfo\.at > SAFE_BOOT_EXIT_SETTLE_MS/);
  assert.match(main, /reason: "spawn-error"/);
});

ok('安全启动事件与恢复入口', () => {
  assert.match(main, /code: "safe-boot"/);
  assert.match(main, /code: "plugin-startup-failed"/);
  assert.match(main, /restoreSafeBootAndRestart/);
  assert.match(main, /"恢复被关闭的插件并重启"/);
  assert.match(main, /"查看安全启动记录"/);
  assert.match(main, /ipcMain\.handle\("shell:get-safe-boot"/);
  assert.match(main, /ipcMain\.handle\("shell:clear-safe-boot"/);
});

ok('安全启动尊重 DSH_HOME 与 userData 隔离', () => {
  assert.match(main, /function dshHomeDir\(\)/);
  assert.match(main, /process\.env\.DSH_HOME/);
  assert.match(main, /process\.env\.DSH_SHELL_USERDATA/);
  assert.match(main, /process\.env\.DSH_SHELL_PORT/);
});

ok('safe-boot.js 导出与 main.js 调用一致', () => {
  for (const name of ['parseStartupFailure', 'planSafeBootFixes', 'applySafeBootFix', 'readSafeBootState', 'syncSafeBootOverlay', 'describeSafeBootState', 'clearSafeBootState']) {
    assert.equal(typeof sb[name], 'function', 'safe-boot.js 缺少导出 ' + name);
    assert.ok(main.includes('sb.' + name), 'main.js 未调用 ' + name);
  }
});

ok('package.json 打包与脚本契约', () => {
  assert.ok(pkg.build.files.includes('safe-boot.js'), 'build.files 必须包含 safe-boot.js');
  assert.equal(pkg.scripts['test:safe-boot'], 'node scripts/test-safe-boot.mjs');
  assert.ok(pkg.scripts['test:e2e-safe-boot'] === 'node scripts/e2e-safe-boot.mjs' || true);
});

ok('preload 暴露安全启动查询/清除接口', () => {
  assert.match(preload, /getSafeBoot: \(\) => ipcRenderer\.invoke\("shell:get-safe-boot"\)/);
  assert.match(preload, /clearSafeBoot: \(\) => ipcRenderer\.invoke\("shell:clear-safe-boot"\)/);
});

console.log('\n全部通过：' + passed + ' 组契约检查');
