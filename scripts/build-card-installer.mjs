// scripts/build-card-installer.mjs — 打「纯卡片安装器」单文件 exe（非 NSIS）
//
// 为什么不用 electron-builder 的 portable/nsis 目标：
//   它们本质都是 NSIS 自解压，会创建 $PLUGINSDIR 写临时文件；本机环境下
//   NSIS 那层稳定报「Error writing temporary file. Make sure your temp folder
//   is valid.」（干净 TEMP、普通权限双击同样复现），且界面是原生 Windows 向导，
//   与「整体一张卡片」的诉求冲突。
// 现在做法：
//   1. electron-builder 只产「纯目录」（--dir），不生成任何安装器；
//   2. 用 7za 把目录压成 payload.7z；
//   3. 拼接 7zSD.sfx（7-Zip 官方 SFX 模块，非 NSIS）+ config.txt + payload.7z；
//   4. config.txt 用 ExecuteFile 静默解压后直接以 --setup 启动主程序，
//      由主程序渲染白色无边框卡片完成安装（见 setup-main.js）。
// 用法: node scripts/build-card-installer.mjs [--skip-build]
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const skipBuild = process.argv.includes("--skip-build");
const APP_FILENAME = "DeepSeek Harness";
function find7z() {
  const cands = [
    join(process.env["ProgramFiles"] || "C:\\Program Files", "7-Zip", "7z.exe"),
    join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "7-Zip", "7z.exe"),
    join(ROOT, "node_modules", "7zip-bin", "win", "x64", "7za.exe"),
  ];
  for (const c of cands) {
    if (existsSync(c)) return c;
  }
  return join(ROOT, "node_modules", "7zip-bin", "win", "x64", "7za.exe");
}
const SEVEN_ZA = find7z();
const SFX_MODULE = join(ROOT, "build", "7zSD.sfx");
const UNPACKED = join(ROOT, "dist", "win-unpacked");
const WORK = join(ROOT, "dist", "card-build");

function sh(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
}

function assertFile(p, label) {
  if (!existsSync(p)) {
    console.error(`缺少${label}：${p}`);
    process.exit(1);
  }
}

assertFile(SEVEN_ZA, "7-Zip / 7za 可执行文件");
assertFile(SFX_MODULE, "7zSD.sfx（build/7zSD.sfx）");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const ver = pkg.version || "1.2.0";
const product = (pkg.build && pkg.build.productName) || APP_FILENAME;

if (!skipBuild) {
  rmSync(UNPACKED, { recursive: true, force: true });
  // 只产目录：不走 nsis/portable，避免任何 NSIS 自解压层。
  // 直接跑 electron-builder 的 CLI 入口，别用 npx（Windows 上 execFileSync 找不到 npx.cmd）。
  const ebCli = join(ROOT, "node_modules", "electron-builder", "out", "cli", "cli.js");
  assertFile(ebCli, "electron-builder CLI");
  sh(process.execPath, [ebCli, "--win", "dir", "--x64"]);
}
assertFile(join(UNPACKED, `${product}.exe`), "打包后的主程序");

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

// ---- 1) 压 payload（根级平铺，解压后主程序直接在临时目录根）----
const payload = join(WORK, "payload.7z");
console.log("[1/4] 压缩应用文件…");
const t0 = Date.now();
sh(SEVEN_ZA, ["a", payload, "*", "-mx=5", "-mmt=on", "-bso0", "-bsp0"], { cwd: UNPACKED });
const payloadMB = (statSync(payload).size / 1048576).toFixed(1);
console.log(`      payload.7z = ${payloadMB} MB，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---- 2) SFX 配置：静默解压 + 以 --setup 启动（ExecuteFile 走相对解压目录）----
// Progress="no" 隐藏 7-Zip 自带解压框，保证用户只看到白色卡片。
const config = [
  ";!@Install@!UTF-8!",
  `Title="${product}"`,
  'Progress="no"',
  `ExecuteFile="${product}.exe"`,
  'ExecuteParameters="--setup"',
  ";!@InstallEnd@!",
].join("\r\n") + "\r\n";
const configPath = join(WORK, "config.txt");
writeFileSync(configPath, config, "utf8"); // 无 BOM：7zSD 按 UTF-8 读取

// ---- 3) 拼接单文件 exe ----
console.log("[2/4] 拼接自解压安装器…");
const outDir = join(ROOT, "dist", "card");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `DeepSeek-Harness-Setup-Card-${ver}.exe`);
rmSync(out, { force: true });
// copy /b 三段拼接（7zSD.sfx + config + payload）
execSync(`cmd /c copy /b "${SFX_MODULE}" + "${configPath}" + "${payload}" "${out}"`, { stdio: "ignore" });
console.log(`      产物 = ${(statSync(out).size / 1048576).toFixed(1)} MB`);

// ---- 4) 换图标（尽力而为：失败不影响可用性，只影响 exe 外观）----
console.log("[3/5] 替换安装器图标…");
let iconOk = false;
try {
  execFileSync(process.execPath, [
    join(ROOT, "scripts", "replace-sfx-icon.mjs"),
    out, join(ROOT, "assets", "app-icon.ico"), out,
  ], { stdio: "ignore", cwd: ROOT });
  iconOk = true;
} catch {
  console.warn("      图标替换跳过（7zSD.sfx 资源段放不下多尺寸图标，功能不受影响）");
}

// ---- 5) 备用产物：ZIP 免安装包（完全不依赖自解压/临时目录）----
// 自解压方案在个别机器上会因 TEMP 受限而失败；ZIP 解开后双击主程序即弹同一张白卡片，
// 是保底可用路径（安装逻辑与单文件版完全一致，只差「不用先解压到临时目录」）。
console.log("[4/5] 生成 ZIP 备用包…");
const zipPath = join(outDir, `DeepSeek-Harness-Card-${ver}.zip`);
rmSync(zipPath, { force: true });
sh(SEVEN_ZA, ["a", "-tzip", zipPath, "*", "-mx=5", "-bso0", "-bsp0"], { cwd: UNPACKED });
console.log(`      ${(statSync(zipPath).size / 1048576).toFixed(1)} MB`);

// ---- 说明文件 ----
writeFileSync(join(outDir, "README.txt"), [
  `${product} 卡片安装器 v${ver}`,
  "",
  "用法：双击 exe。",
  "  1. 自解压（7-Zip SFX，非 NSIS）静默解开应用文件到临时目录；",
  "  2. 以 --setup 启动主程序，弹出纯白无边框卡片安装界面；",
  "  3. 默认装到 D:\\DeepSeek Harness（可改路径），可选桌面/开始菜单快捷方式；",
  "  4. 装完写入 .dsh-installed 标记，之后双击直接进主界面。",
  "",
  "已彻底移除 NSIS/MSI 原生安装框（那些会触发 temp 写入报错且界面不统一）。",
  "",
  `图标替换：${iconOk ? "成功" : "跳过（用 7-Zip 默认图标）"}`,
  "",
  "若单文件版因系统 TEMP 受限打不开，用同目录的 ZIP 备用包：",
  "  解压后双击「DeepSeek Harness.exe」，同样弹白色卡片完成安装。",
  "",
  "参数：",
  "  --setup    强制弹卡片安装器",
  "  --shell    跳过安装器，直接进主界面",
].join("\r\n") + "\r\n");

console.log("[5/5] 完成");
console.log(`card installer: ${out}`);
console.log(`zip fallback  : ${zipPath}`);
