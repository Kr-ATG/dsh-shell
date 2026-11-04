// setup-mode.js — 安装器模式判定（main.js 与 setup-main.js 共用，纯函数无 Electron 依赖）
//
// 背景：安装包用 7-Zip 自解压（7zSD.sfx，非 NSIS）把完整应用解到临时目录，
// 再以 `--setup` 启动主程序，由它渲染白色无边框卡片完成安装。
// 所以「同一个 exe」有三种运行形态，必须分清：
//   1. 安装器入口：SFX 解压后带 --setup 启动 → 弹安装卡。
//   2. 已安装的应用：跑在真实安装目录（同目录有 resources/app.asar）→ 直接进壳。
//   3. 开发模式（npx electron .）→ 直接进壳。
// 关键：--setup 的扫描不能用 argv.slice(2) —— 打包后 argv=[exe路径, --setup]，
// slice(2) 会把开关吃掉，导致安装器直接进壳（表现为「双击没反应」）。
const path = require("node:path");
const fs = require("node:fs");

const MARKER = ".dsh-installed";

function argSet(argv) {
  return new Set((argv || []).map((a) => String(a)));
}

/** 判断某个目录是否是「完整应用布局」（有 Electron 运行时 + app.asar） */
function looksInstalled(dir) {
  try { return fs.existsSync(path.join(dir, "resources", "app.asar")); }
  catch { return false; }
}

function markerPath(dir) {
  try { return path.join(dir || path.dirname(process.execPath), MARKER); }
  catch { return null; }
}

function hasMarker(dir) {
  const p = markerPath(dir);
  if (!p) return false;
  try { return fs.existsSync(p); } catch { return false; }
}

/**
 * 是否进入安装器（卡片）模式。
 * @param {string[]} argv 进程参数（默认 process.argv）
 * @returns {boolean}
 */
function isSetupMode(argv = process.argv) {
  const args = argSet(argv);
  const verdict = (v, why) => {
    // 诊断留痕：安装器行为异常时用 DSH_SETUP_DEBUG=1 复现，写 %TEMP%\dsh-setup-diag.txt
    if (process.env.DSH_SETUP_DEBUG) {
      try {
        require("node:fs").appendFileSync(
          require("node:path").join(require("node:os").tmpdir(), "dsh-setup-diag.txt"),
          `[${new Date().toISOString()}] verdict=${v} why=${why} argv=${JSON.stringify(argv)} ` +
          `execPath=${process.execPath} defaultApp=${String(process.defaultApp)} ` +
          `electron=${(process.versions && process.versions.electron) || "(none)"}\n`
        );
      } catch { /* 诊断失败不影响判定 */ }
    }
    return v;
  };
  if (args.has("--setup")) return verdict(true, "explicit-setup");
  if (args.has("--shell") || args.has("--no-setup")) return verdict(false, "explicit-shell");
  try {
    if (!process.versions || !process.versions.electron) return verdict(false, "not-electron");
    if (process.defaultApp) return verdict(false, "dev-mode");
  } catch { /* 忽略 */ }
  // 已安装形态：自身目录就是完整应用布局 → 直接进壳
  const selfDir = path.dirname(process.execPath);
  if (looksInstalled(selfDir)) return verdict(false, "installed-layout");
  // 布局不完整（异常/半装）：按安装入口处理，便于修复安装
  return verdict(!hasMarker(selfDir), "incomplete-layout");
}

module.exports = { isSetupMode, markerPath, hasMarker, looksInstalled, MARKER };
