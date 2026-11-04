// toast-preload.js — 桌面浮窗的渲染进程桥（只暴露浮窗需要的四个动作）
//
// 与主壳的 preload.js 分开：浮窗是独立小窗口、独立页面，给它一份最小权限的桥
// 比复用主壳那份（含重启服务、退出应用等重动作）更安全，也更好读。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dshToast", {
  /** 渲染侧就绪：主进程收到后才发第一条，避免 show 早于监听注册而丢消息。 */
  ready: () => ipcRenderer.send("dsh-toast:ready"),
  /** 订阅新通知（复用同一个窗口）。 */
  onShow: (cb) => ipcRenderer.on("dsh-toast:show", (_e, payload) => cb(payload)),
  /** 内容高度回报：主进程据此把窗口高度贴到卡片（宽度固定）。 */
  resize: (height) => ipcRenderer.send("dsh-toast:resize", height),
  /** 退场动画播完 → 主进程隐藏窗口。 */
  dismiss: () => ipcRenderer.send("dsh-toast:dismiss"),
  /** 点击卡片：主进程唤起主窗并跳进对应会话。 */
  click: (sessionId) => ipcRenderer.send("dsh-toast:click", sessionId),
});
