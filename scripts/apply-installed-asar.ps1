# 把新版 app.asar 注入「已安装」的 DeepSeek Harness 目录
# 用法：先完全退出 DeepSeek Harness（托盘图标右键 → 退出），再运行本脚本
#   pwsh -NoProfile -ExecutionPolicy Bypass -File "D:\AI\Dsh\_tmp\apply-installed-asar.ps1"
$ErrorActionPreference = "Stop"
$target = "D:\DeepSeek Harness\resources\app.asar"
$src    = "D:\AI\Dsh\dist\win-unpacked\resources\app.asar"

$running = Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "检测到 DeepSeek Harness 正在运行（PID: $($running.Id -join ', ')）。" -ForegroundColor Yellow
  Write-Host "请先从托盘图标右键退出壳子，再重新运行本脚本。" -ForegroundColor Yellow
  exit 1
}
if (-not (Test-Path $target)) { Write-Host "找不到目标：$target" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $src))    { Write-Host "找不到新包：$src" -ForegroundColor Red; exit 1 }

$ts  = Get-Date -Format "yyyyMMddHHmmss"
$bak = "D:\AI\Dsh\_tmp\installed-app-asar-backup-$ts.asar"
Copy-Item -LiteralPath $target -Destination $bak -Force
Write-Host "已备份原 asar → $bak"

Copy-Item -LiteralPath $src -Destination $target -Force
Write-Host ("已注入新 asar：" + (Get-Item $target).Length + " bytes") -ForegroundColor Green

# 校验：新 asar 里 5 个关键文件应含新特征
$verifyJs = Join-Path $env:TEMP "verify-installed-asar.cjs"
@'
const { createRequire } = require("node:module");
const asar = require("@electron/asar");
const p = process.argv[2];
const css = asar.extractFile(p, "topbar.css").toString("utf8");
const main = asar.extractFile(p, "main.js").toString("utf8");
const html = asar.extractFile(p, "topbar.html").toString("utf8");
console.log("edge-strip 样式:", css.includes(".edge-strip"));
console.log("无 drag-strip:", !html.includes("drag-strip"));
console.log("无壳菜单:", !main.includes("showShellMenu"));
console.log("右缘轮询:", main.includes("pollEdgeHover"));
'@ | Set-Content -LiteralPath $verifyJs -Encoding UTF8
node $verifyJs $target
Remove-Item $verifyJs -Force -ErrorAction SilentlyContinue
Write-Host "完成。重新启动 DeepSeek Harness 即可看到新版壳。" -ForegroundColor Green
