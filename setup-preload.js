// setup-preload.js — 卡片安装器的渲染桥（最小权限：只给安装器用的 IPC）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dshSetup", {
  getDefaults: () => ipcRenderer.invoke("setup:get-defaults"),
  browse: (current) => ipcRenderer.invoke("setup:browse", current),
  install: (opts) => ipcRenderer.invoke("setup:install", opts),
  onProgress: (cb) => ipcRenderer.on("setup:progress", (_e, p) => cb(p)),
  launch: () => ipcRenderer.invoke("setup:launch"),
  close: () => ipcRenderer.invoke("setup:close"),
});
