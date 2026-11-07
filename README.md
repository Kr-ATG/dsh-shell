# DeepSeek Harness 桌面壳（dsh-shell）

给 [DeepSeek Harness](https://github.com/deepseek-ai) 的 Web UI 套的一层 **无边框 Electron 桌面壳**：把 `http://127.0.0.1:3080` 的网页装进一个原生窗口，接管窗口装饰、托盘、开机自启、服务进程与一键更新。

> 非官方项目，与 DeepSeek 官方无隶属关系。仓库内的鲸鱼 / 品牌素材版权归 DeepSeek 所有，仅用于本壳的界面呈现。

## 特性

- **无边框窗口**：没有系统标题栏，界面完全由壳自绘。
- **左上角窗口控制**：鼠标移到窗口左上角（82×26 区域）才淡入最小化 / 最大化按钮，平时完全隐藏且不接收鼠标事件，不遮挡 Web UI 自己的按钮。
- **无自绘右键菜单**：壳 chrome 上右键一律静默，iframe 内保留 Chromium 原生菜单。
- **浏览器快捷键**：`F5` / `Ctrl+R` 刷新，`Ctrl+Shift+R` / `Ctrl+F5` 强制刷新（清 HTTP 缓存 + 带 `_r` 重载），`F11` 全屏。
- **服务托管**：自动拉起 / 复用本地 DSH 服务，杀掉进程、重启服务、清缓存重启都在托盘菜单里；服务重启看门狗会自动刷新页面。
- **安全启动**：插件或补丁配置导致服务起不来时，解析启动诊断、自动禁用出错插件并重启，最多 3 轮，记录在 `userData/safe-boot.json`。
- **托盘常驻**：关闭窗口 = 最小化到托盘，服务不停；托盘可切开机自启、退出（保留服务 / 停止服务）。
- **滚动性能**：主 WebUI 的 iframe 只在入场动画期间临时借用合成层，落位后清掉 transform / will-change，避免 Electron 下 iframe 内滚动走慢路径（浏览器直开正常、壳子里掉帧的问题）。
- **桌面浮窗提醒**：任务完成时在右下角弹一张可点击跳转的卡片。
- **一键更新**：壳内检查引擎新版本并执行升级，带实时进度。
  - 右下角更新图标只在**真有新版本**时出现，没更新时不占位；
  - 托盘的 **检查 DSH 更新** 可随时唤起「演进中心」手动检查 / 一键升级。

## 安装

到 [Releases](https://github.com/Kr-ATG/dsh-shell/releases) 下载 `DeepSeek-Harness-<版本>.msi` 安装即可（按用户安装，不需要管理员权限）。

首次启动会自动体检运行环境：

- 缺 **Node.js 22 LTS** 会弹提示（需要自己装，壳子不代装）；
- 缺 **DSH 运行时**会在 `%APPDATA%\dsh-shell\runtime` 现场 `npm install`（先走 npmmirror 镜像，失败回退官方源，约 600 MB）。

引擎版本由壳里的 `DSH_VERSION` 决定（当前 `0.2.1-rc.5`，npm `latest` 稳定线）。已有部署会在换新版壳时按该常量自动对齐，也可以从界面里手动「一键更新」到 npm / GitHub 上的更新版本。

## 开发

```bash
npm install          # 装 electron + electron-builder
npm start            # 直接跑壳（--shell 强制壳模式，--setup 走安装卡片）
npm run dist:msi     # 打 MSI 到 dist/
npm run dist:exe     # 打 NSIS 安装包
```

服务端口的覆盖方式（调试 / 多实例隔离）：

```bash
DSH_SHELL_PORT=3099 DSH_SHELL_USERDATA=D:\tmp\shell-ud npm start
```

## 目录

| 文件 | 作用 |
| --- | --- |
| `main.js` | 主进程：窗口、托盘、服务托管、快捷键、IPC、安全启动 |
| `preload.js` | `contextBridge` 暴露的 `window.shellAPI` |
| `renderer.js` | 壳页面逻辑：开屏动画、窗口按钮、主题、更新弹窗 |
| `topbar.html` / `topbar.css` | 壳页面结构与样式 |
| `toast.*` | 桌面浮窗提醒窗口 |
| `setup-*` | 安装器卡片（自解压后 `--setup` 启动） |
| `safe-boot.js` | 安全启动：解析 DSH 启动诊断并修复配置 |
| `update.mjs` | 引擎一键更新脚本 |
| `build/` | NSIS / MSI 安装图与 `installer.nsh` |
| `scripts/` | 冒烟与自检脚本 |

## 许可

MIT（见 `LICENSE`）。
