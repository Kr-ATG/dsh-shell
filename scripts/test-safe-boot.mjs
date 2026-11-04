#!/usr/bin/env node
/**
 * test-safe-boot.mjs — safe-boot.js 单元测试（node 直接运行）
 *
 * 覆盖：启动失败日志解析（StartupError / pending / skipped bundle / patch 错误 /
 * manifest 错误 / fatal load）、保护名单与环境错误、状态读写、overlay 生成、
 * disable-entry / remove-bundle / comment-patch-entry / restore-patch-file /
 * clearSafeBootState 五类修复动作。
 *
 * 运行：node scripts/test-safe-boot.mjs
 * 测试只写 _tmp/safe-boot-test 下的临时目录，不碰真实 profile。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const sb = require(path.join(ROOT, 'safe-boot.js'));

// DSH 运行时自带的 yaml 库（safe-boot 通过 ctx.yaml 注入）
let yaml = null;
for (const candidate of [
  path.join(ROOT, 'dsh-runtime', 'node_modules', 'yaml'),
  path.join(ROOT, 'node_modules', 'yaml'),
]) {
  try { yaml = require(candidate); break; } catch { /* 继续找 */ }
}

const TMP = path.join(ROOT, '_tmp', 'safe-boot-test');
function resetTmp() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
}
function makeProfile(name, { bundles = [], patch = '', pkgExtra = {} } = {}) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  const pkg = {
    name: 'test-profile-' + name,
    private: true,
    dsh: { profile: { bundles } },
    dependencies: {},
    ...pkgExtra,
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  if (patch !== null) fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), patch, 'utf8');
  return dir;
}
function makeCtx(profileDir) {
  const stateDir = path.join(TMP, 'state-' + path.basename(profileDir));
  fs.mkdirSync(stateDir, { recursive: true });
  return { profileDir, dshHome: TMP, stateDir, logDir: stateDir, yaml };
}
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

resetTmp();
console.log('safe-boot.js 单元测试');

// ---------------------------------------------------------------------------
// 1. StartupError：disabled 表达式抛错（真实日志格式）
// ---------------------------------------------------------------------------
const disabledExprLog = [
  'dsh: startup failed: 2 required plugins did not activate',
  '',
  'Failed plugins (1):',
  '  webserver (required)',
  '    Package: @deepseek-ai/dsh-host-webserver',
  '    disabled expression failed: Error: boom from plugin config',
  '        at eval (eval at <anonymous> (eval at <anonymous> (file:///D:/AI/Dsh/dsh-runtime/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js:301:18)), <anonymous>:1:16)',
  '        at Entry.evaluate (file:///D:/AI/Dsh/dsh-runtime/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js:421:10)',
  '',
  'Plugins waiting for services (2):',
  '  Plugin                  Missing services',
  '  web-runtime (required)  webServer',
  '  client-hmr              webServer',
  '',
  'Full diagnostics: D:\\AI\\Dsh\\_tmp\\logs\\startup-x.log',
].join('\n');

const diag1 = sb.parseStartupFailure({ stderrText: disabledExprLog });
ok('解析 disabled 表达式抛错的 StartupError', () => {
  assert.equal(diag1.kind, 'startup-error');
  assert.equal(diag1.failedPlugins.length, 1);
  const p = diag1.failedPlugins[0];
  assert.equal(p.id, 'webserver');
  assert.equal(p.module, '@deepseek-ai/dsh-host-webserver');
  assert.equal(p.required, true);
  assert.match(p.phase, /disabled expression failed/);
  assert.match(p.error, /boom from plugin config/);
  assert.equal(diag1.pending.length, 2);
  assert.deepEqual(diag1.pending[0].missing, ['webServer']);
  assert.match(diag1.summary, /插件启动失败/);
  assert.match(diag1.summary, /webserver/);
});

// ---------------------------------------------------------------------------
// 2. EADDRINUSE 环境错误：不能作为禁用依据
// ---------------------------------------------------------------------------
const addrLog = [
  'dsh: startup failed: 1 required plugins did not activate',
  '',
  'Failed plugins (1):',
  '  webserver (required)',
  '    Package: @deepseek-ai/dsh-host-webserver',
  '    Error: listen EADDRINUSE: address already in use 127.0.0.1:3099',
  '        at Server.setupListenHandle [as _listen2] (node:net:2008:16)',
].join('\n');
ok('识别环境类错误（EADDRINUSE）且不产生禁用计划', () => {
  const diag = sb.parseStartupFailure(addrLog);
  assert.equal(diag.failedPlugins[0].id, 'webserver');
  assert.match(diag.failedPlugins[0].error, /EADDRINUSE/);
  const ctx = makeCtx(makeProfile('env-profile', { patch: '- id: webserver\n  config: {}\n' }));
  const plans = sb.planSafeBootFixes(diag, ctx);
  assert.equal(plans.filter((p) => p.action === 'disable-entry').length, 0, '环境错误不应禁用插件');
  // webserver 是保护条目：即便 patch 有它的条目，也不应直接 disable
  assert.equal(plans.filter((p) => p.action === 'disable-entry').length, 0);
});

// ---------------------------------------------------------------------------
// 3. 非保护插件失败 → disable-entry
// ---------------------------------------------------------------------------
const pluginFailLog = [
  'dsh: startup failed: 1 required plugins did not activate',
  '',
  'Failed plugins (2):',
  '  webserver (required)',
  '    Package: @deepseek-ai/dsh-host-webserver',
  '    Error: listen EADDRINUSE: address already in use 127.0.0.1:3080',
  '  dsh-bad-plugin',
  '    Package: @test/dsh-bad-plugin',
  '    Error: cannot read properties of undefined (reading \'foo\')',
].join('\n');
ok('非保护插件失败生成 disable-entry 计划', () => {
  const diag = sb.parseStartupFailure(pluginFailLog);
  assert.equal(diag.failedPlugins.length, 2);
  const ctx = makeCtx(makeProfile('plugin-profile', { patch: '[]\n' }));
  const plans = sb.planSafeBootFixes(diag, ctx);
  const disable = plans.find((p) => p.action === 'disable-entry');
  assert.ok(disable, '应生成 disable-entry');
  assert.equal(disable.id, 'dsh-bad-plugin');
  assert.equal(disable.module, '@test/dsh-bad-plugin');
  assert.ok(disable.priority >= 60);
});

// ---------------------------------------------------------------------------
// 4. skipped bundle / 坏 bundle patch
// ---------------------------------------------------------------------------
const skipLog = [
  'dsh: skipping profile bundle "@test/broken-bundle": Error: dsh: failed to parse overlay D:\\x\\profiles\\web\\node_modules\\@test\\broken-bundle\\cordis.patch.yml: YAMLException: unexpected end of the stream',
  'dsh web: http://127.0.0.1:3999/?token=abc',
].join('\n');
ok('解析 skipping bundle 并生成 remove-bundle 兜底计划', () => {
  const diag = sb.parseStartupFailure(skipLog);
  assert.equal(diag.skippedBundles.length, 1);
  assert.equal(diag.skippedBundles[0].name, '@test/broken-bundle');
  const ctx = makeCtx(makeProfile('skip-profile', { bundles: ['@deepseek-ai/dsh-base', '@test/broken-bundle'] }));
  const plans = sb.planSafeBootFixes(diag, ctx);
  const remove = plans.find((p) => p.action === 'remove-bundle');
  assert.ok(remove);
  assert.equal(remove.name, '@test/broken-bundle');
});

// ---------------------------------------------------------------------------
// 5. profile patch 解析失败 → restore-patch-file（最高优先级）
// ---------------------------------------------------------------------------
ok('profile patch 解析失败 → restore-patch-file（priority 90）', () => {
  const profileDir = makeProfile('patch-profile', { patch: '- id: [unclosed\n' });
  const ctx = makeCtx(profileDir);
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const patchErrorLog = [
    'file:///D:/AI/Dsh/dsh-runtime/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:4052',
    '    throw new Error(`dsh: failed to parse overlay ${file}: ${String(error)}`);',
    '',
    'Error: dsh: failed to parse overlay ' + patchPath + ': YAMLException: unexpected end of the stream within a flow collection (2:1)',
    '    at parsePatchList (file:///D:/AI/Dsh/dsh-runtime/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:4052:9)',
  ].join('\n');
  const diag = sb.parseStartupFailure(patchErrorLog);
  assert.equal(diag.kind, 'patch-error');
  assert.equal(diag.patchErrors.length, 1);
  const plans = sb.planSafeBootFixes(diag, ctx);
  const restore = plans.find((p) => p.action === 'restore-patch-file');
  assert.ok(restore, '应生成 restore-patch-file');
  assert.equal(restore.priority, 90);
});

// ---------------------------------------------------------------------------
// 6. fatal load failure 模块提取 + bundle 移除
// ---------------------------------------------------------------------------
const fatalLog = [
  'dsh: fatal load failure: Error: Cannot find module \'@test/crash-bundle/lib/index.js\'',
  '    at Module._resolveFilename (node:internal/modules/cjs/loader:1234:15)',
  '    at file:///D:/Users/Anti/.dsh/profiles/web/node_modules/@test/crash-bundle/lib/index.js:1:1',
].join('\n');
ok('解析 fatal load failure 并提取模块名', () => {
  const diag = sb.parseStartupFailure(fatalLog);
  assert.equal(diag.kind, 'fatal-load');
  assert.equal(diag.fatalLoads.length, 1);
  assert.equal(diag.fatalLoads[0].module, '@test/crash-bundle');
  const ctx = makeCtx(makeProfile('fatal-profile', { bundles: ['@test/crash-bundle'] }));
  const plans = sb.planSafeBootFixes(diag, ctx);
  assert.ok(plans.some((p) => p.action === 'remove-bundle' && p.name === '@test/crash-bundle'));
});

// ---------------------------------------------------------------------------
// 7. 保护名单
// ---------------------------------------------------------------------------
ok('保护名单与 bundle 保护', () => {
  for (const id of ['webserver', 'web-runtime', 'agent-loop', 'connection', 'acp']) {
    assert.equal(sb.isProtectedEntry(id), true, id + ' 应受保护');
  }
  assert.equal(sb.isProtectedEntry('dsh-bad-plugin'), false);
  assert.equal(sb.isProtectedBundle('@deepseek-ai/dsh-base'), true);
  assert.equal(sb.isProtectedBundle('@test/broken-bundle'), false);
});

// ---------------------------------------------------------------------------
// 8. 状态读写 + overlay
// ---------------------------------------------------------------------------
ok('状态读写与 overlay 生成/删除', () => {
  const ctx = makeCtx(makeProfile('state-profile'));
  const state = sb.readSafeBootState(ctx);
  assert.equal(state.version, 1);
  assert.equal(state.disabled.length, 0);
  state.disabled.push({ id: 'dsh-bad-plugin', module: '@test/dsh-bad-plugin', reason: '测试', at: 'now' });
  sb.writeSafeBootState(ctx, state);
  const again = sb.readSafeBootState(ctx);
  assert.equal(again.disabled.length, 1);
  assert.equal(again.disabled[0].id, 'dsh-bad-plugin');

  const overlay = sb.buildSafeBootOverlay(again);
  assert.match(overlay, /- id: dsh-bad-plugin/);
  assert.match(overlay, /disabled: true/);
  assert.doesNotMatch(overlay, /name:/, 'overlay 不应带 name（避免覆盖模块名）');
  const overlayPath = sb.syncSafeBootOverlay(ctx, again);
  assert.ok(overlayPath && fs.existsSync(overlayPath));
  const cleared = { ...again, disabled: [] };
  assert.equal(sb.syncSafeBootOverlay(ctx, cleared), null);
  assert.equal(fs.existsSync(overlayPath), false);
});

// ---------------------------------------------------------------------------
// 9. disable-entry 应用（幂等）
// ---------------------------------------------------------------------------
ok('disable-entry 写入状态与 overlay，重复执行不重复记录', () => {
  const ctx = makeCtx(makeProfile('disable-profile'));
  const state = sb.readSafeBootState(ctx);
  const plan = { action: 'disable-entry', id: 'dsh-bad-plugin', module: '@test/dsh-bad-plugin', reason: 'boom', priority: 60 };
  const first = sb.applySafeBootFix(ctx, state, plan);
  assert.equal(first.ok, true);
  assert.equal(first.state.disabled.length, 1);
  assert.ok(fs.existsSync(path.join(ctx.stateDir, 'safe-boot.patch.yml')));
  const second = sb.applySafeBootFix(ctx, first.state, plan);
  assert.equal(second.ok, true);
  assert.equal(second.state.disabled.length, 1, '重复 apply 不应重复记录');
  const protectedApply = sb.applySafeBootFix(ctx, first.state, { action: 'disable-entry', id: 'webserver', reason: 'x' });
  assert.equal(protectedApply.ok, false, '保护条目必须拒绝');
});

// ---------------------------------------------------------------------------
// 10. remove-bundle 应用 + clear 恢复
// ---------------------------------------------------------------------------
ok('remove-bundle 改 package.json 并备份，clear 按原索引恢复', () => {
  const profileDir = makeProfile('bundle-profile', { bundles: ['@deepseek-ai/dsh-base', '@test/bad-bundle', '@deepseek-ai/dsh-web-app'] });
  const ctx = makeCtx(profileDir);
  const state = sb.readSafeBootState(ctx);
  const res = sb.applySafeBootFix(ctx, state, { action: 'remove-bundle', name: '@test/bad-bundle', reason: '坏 bundle', priority: 80 });
  assert.equal(res.ok, true);
  const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
  assert.equal(res.state.bundles.length, 1);
  assert.equal(res.state.bundles[0].index, 1);
  const backups = fs.readdirSync(profileDir).filter((n) => n.startsWith('package.json.bak-safe-boot'));
  assert.ok(backups.length >= 1, '应保留 package.json 备份');
  const cleared = sb.clearSafeBootState(ctx);
  assert.equal(cleared.ok, true);
  const pkg2 = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  assert.deepEqual(pkg2.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@test/bad-bundle', '@deepseek-ai/dsh-web-app']);
});

// ---------------------------------------------------------------------------
// 11. comment-patch-entry 应用（幂等）
// ---------------------------------------------------------------------------
ok('comment-patch-entry 注释顶层条目并备份，重复执行幂等', () => {
  const patch = [
    '# 顶部注释',
    '- id: webserver',
    '  name: \'@deepseek-ai/dsh-host-webserver\'',
    '  disabled: !!js \'(() => { throw new Error("boom") })()\'',
    '',
    '- id: other-entry',
    '  disabled: true',
  ].join('\n');
  const profileDir = makeProfile('comment-profile', { patch });
  const ctx = makeCtx(profileDir);
  const state = sb.readSafeBootState(ctx);
  const res = sb.applySafeBootFix(ctx, state, {
    action: 'comment-patch-entry', id: 'webserver', file: path.join(profileDir, 'cordis.patch.yml'), reason: '核心条目被坏表达式污染', priority: 50,
  });
  assert.equal(res.ok, true);
  const text = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
  assert.match(text, /# \[safe-boot .*\] 自动禁用/);
  assert.match(text, /# - id: webserver/);
  assert.doesNotMatch(text, /^- id: webserver/m);
  assert.match(text, /- id: other-entry/);
  const backups = fs.readdirSync(profileDir).filter((n) => n.startsWith('cordis.patch.yml.bak-safe-boot'));
  assert.ok(backups.length >= 1);
  // 重复执行：已注释 → 幂等返回，不再改动
  const res2 = sb.applySafeBootFix(ctx, res.state, { action: 'comment-patch-entry', id: 'webserver', reason: 'again' });
  assert.equal(res2.ok, true);
  const text2 = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
  assert.equal(text2, text, '重复执行不应再改文件');
});

// ---------------------------------------------------------------------------
// 12. restore-patch-file：从最近可用备份恢复
// ---------------------------------------------------------------------------
ok('restore-patch-file 从最近可用备份恢复损坏的 cordis.patch.yml', () => {
  const profileDir = makeProfile('restore-profile', { patch: '- id: [unclosed\n' });
  const oldBak = path.join(profileDir, 'cordis.patch.yml.bak-20260101-000000');
  const newBak = path.join(profileDir, 'cordis.patch.yml.bak-20260102-000000');
  fs.writeFileSync(oldBak, '[]\n', 'utf8');
  fs.writeFileSync(newBak, '- id: good\n  disabled: true\n', 'utf8');
  // 备份按 mtime 取最新；显式设置时间，避免同一毫秒创建导致排序不稳定
  fs.utimesSync(oldBak, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  fs.utimesSync(newBak, new Date('2026-01-02T00:00:00Z'), new Date('2026-01-02T00:00:00Z'));
  const ctx = makeCtx(profileDir);
  const state = sb.readSafeBootState(ctx);
  const res = sb.applySafeBootFix(ctx, state, { action: 'restore-patch-file', file: path.join(profileDir, 'cordis.patch.yml'), reason: '坏文件', priority: 90 });
  assert.equal(res.ok, true);
  const restored = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
  assert.match(restored, /good/, '应恢复较新的可解析备份');
  const broken = fs.readdirSync(profileDir).filter((n) => n.startsWith('cordis.patch.yml.broken-'));
  assert.ok(broken.length >= 1, '坏文件应保留备份');
});

// ---------------------------------------------------------------------------
// 13. 缺少 yaml 库时 restore 必须拒绝（不能误判健康文件）
// ---------------------------------------------------------------------------
ok('缺少 yaml 库时 restore-patch-file 拒绝执行且不改文件', () => {
  const profileDir = makeProfile('restore-no-yaml', { patch: '- id: healthy\n  disabled: true\n' });
  const ctx = { ...makeCtx(profileDir), yaml: null };
  const res = sb.applySafeBootFix(ctx, sb.readSafeBootState(ctx), { action: 'restore-patch-file', file: path.join(profileDir, 'cordis.patch.yml'), priority: 90 });
  assert.equal(res.ok, false);
  assert.match(fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8'), /healthy/);
});

// ---------------------------------------------------------------------------
// 14. describeSafeBootState
// ---------------------------------------------------------------------------
ok('describeSafeBootState 输出中文摘要', () => {
  const ctx = makeCtx(makeProfile('describe-profile'));
  const state = sb.readSafeBootState(ctx);
  state.disabled.push({ id: 'x', module: 'm', reason: 'r', at: 't' });
  state.bundles.push({ name: 'b', index: 0, reason: 'r', at: 't' });
  const text = sb.describeSafeBootState(state);
  assert.match(text, /禁用 1 个插件/);
  assert.match(text, /移除 1 个 bundle/);
  assert.match(text, /注释 0 个补丁条目/);
});

// ---------------------------------------------------------------------------
// 15. 超时文本
// ---------------------------------------------------------------------------
ok('识别启动超时文本', () => {
  const diag = sb.parseStartupFailure({ stderrText: 'dsh: web did not become ready within 120s' });
  assert.equal(diag.kind, 'timeout');
  assert.match(diag.summary, /超时/);
});

console.log('\n全部通过：' + passed + ' 组断言');
