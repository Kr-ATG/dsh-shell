// preload.js — 渲染进程与主进程的桥
// 壳页面职责：跟随 Web UI 的主题、启动动画（服务就绪通知）、右缘悬浮窗口控制条、双击/控制
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shellAPI", {
  getTheme: () => ipcRenderer.invoke("shell:get-theme"),
  onTheme: (cb) => ipcRenderer.on("shell:theme", (_e, t) => cb(t)),
  // 服务就绪（含重启恢复）：渲染进程加载 iframe 并播放展开动画
  onServiceReady: (cb) => ipcRenderer.on("shell:service-ready", (_e, url) => cb(url)),
  // iframe 加载失败通知（did-fail-load）：显示壳子错误遮罩 + 自动重试提示
  onFrameError: (cb) => ipcRenderer.on("shell:frame-error", (_e, msg) => cb(msg)),
  // 顶栏双击：切换最大化 / 还原
  maximizeWindow: () => ipcRenderer.invoke("shell:maximize-window"),
  // 右上角窗口控制：最小化 / 关闭按钮（关闭 = 最小化到托盘，服务不停）
  minimizeWindow: () => ipcRenderer.invoke("shell:minimize-window"),
  // 最大化状态：初始拉取 + 主进程 maximize/unmaximize 事件推送（切图标用）
  isMaximized: () => ipcRenderer.invoke("shell:is-maximized"),
  onMaximizeState: (cb) => ipcRenderer.on("shell:maximize-state", (_e, flag) => cb(flag)),
  // 启动动画收尾：确保窗口最大化
  ensureMaximized: () => ipcRenderer.invoke("shell:ensure-maximized"),
  // 全屏切换与状态查询 (F11)
  setFullScreen: (flag) => ipcRenderer.invoke("shell:set-fullscreen", flag),
  isFullScreen: () => ipcRenderer.invoke("shell:is-fullscreen"),
  // 页面重载与服务重启
  reloadPage: () => ipcRenderer.invoke("shell:reload-page"),
  // opts.clearCache 为真时，主进程会在下一次下发 iframe URL 时追加 _r=<时间戳>（只生效一次），
  // 强制浏览器重新请求页面资源；不传 opts 与旧行为完全一致（仅重启）
  restartService: (opts) => ipcRenderer.invoke("shell:restart-service", opts),
  // 退出应用
  quitApp: (stopService) => ipcRenderer.invoke("shell:quit-app", stopService),
  // 左上角窗口控制按钮：主进程轮询光标，指针进入窗口左上角区域才推 true（淡入），
  // 离开即推 false（隐藏）。判定放主进程是因为 WebUI 在跨源 iframe 里，收不到它的鼠标事件。
  onWinControls: (cb) => ipcRenderer.on("shell:win-controls", (_e, show) => cb(!!show)),
  // 关闭动画播完后隐藏窗口（最小化到托盘，服务保持运行）
  closeWindow: () => ipcRenderer.invoke("shell:close-window"),
  // 窗口从托盘恢复显示：清除关闭动画态
  onWindowShown: (cb) => ipcRenderer.on("shell:window-shown", () => cb()),
  // 启动时拉取一次服务就绪状态（兜底事件竞态）
  getState: () => ipcRenderer.invoke("shell:get-state"),
  // 一键更新：检查与执行
  checkUpdate: () => ipcRenderer.invoke("shell:check-update"),
  runUpdate: (opts) => ipcRenderer.invoke("shell:run-update", opts),
  onUpdateEvent: (cb) => ipcRenderer.on("shell:update-event", (_e, data) => cb(data)),
  onOpenUpdateModal: (cb) => ipcRenderer.on("shell:open-update-modal", () => cb()),
  // 运行环境体检 / 自动部署（开屏真实状态与错误提示，1.1.34）
  getRuntimeInfo: () => ipcRenderer.invoke("shell:get-runtime"),
  // 安全启动：查询/清除被自动关闭的插件（托盘菜单为主入口，这里供页面扩展用）
  getSafeBoot: () => ipcRenderer.invoke("shell:get-safe-boot"),
  clearSafeBoot: () => ipcRenderer.invoke("shell:clear-safe-boot"),
  onRuntimeEvent: (cb) => ipcRenderer.on("shell:runtime-event", (_e, evt) => cb(evt)),
  retryRuntime: () => ipcRenderer.invoke("shell:restart-service"),
  // { restart:false } = 只部署不重启内核（自动化/预置环境用）
  redeployPlugins: (opts) => ipcRenderer.invoke("shell:redeploy-plugins", opts),
  openLogDir: () => ipcRenderer.invoke("shell:open-log-dir"),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  // 桌面通知浮窗：任务完成时在桌面右下角弹一张卡片（不依赖 Windows 通知设置）
  toast: (payload) => ipcRenderer.invoke("shell:show-toast", payload),
  // 浮窗被点击后要跳的会话：壳页面转交给 WebUI（见 renderer.js）
  onOpenSession: (cb) => ipcRenderer.on("shell:open-session", (_e, sessionId) => cb(sessionId)),
  // 语音通话全局热键：主进程命中 → 壳页转发给 WebUI iframe（见 renderer.js）
  onCallHotkey: (cb) => ipcRenderer.on("shell:call-hotkey", () => cb()),
  getCallHotkey: () => ipcRenderer.invoke("shell:get-call-hotkey"),
  setCallHotkey: (acc) => ipcRenderer.invoke("shell:set-call-hotkey", acc),
});
