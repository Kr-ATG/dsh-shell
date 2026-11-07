// renderer.js — 极简搜索框开屏下移 + 文字从左往右自然铺开 + 官方鲸鱼图标 + 右缘悬浮窗口控制条
const api = window.shellAPI || {
  getTheme: () => Promise.resolve('dark'),
  onTheme: () => {},
  maximizeWindow: () => {},
  minimizeWindow: () => {},
  ensureMaximized: () => {},
  closeWindow: () => {},
  isMaximized: () => Promise.resolve(false),
  onMaximizeState: () => {},
  isFullScreen: () => Promise.resolve(false),
  setFullScreen: () => {},
  reloadPage: () => {},
  restartService: () => {},
  quitApp: () => {},
  getState: () => Promise.resolve({ serviceReady: true, dshUrl: 'http://127.0.0.1:3080' }),
  onServiceReady: () => {},
  onFrameError: () => {},
  onWindowShown: () => {},
  // 运行环境体检 / 自动部署（无桥时的空实现，独立打开本页不报错）
  getRuntimeInfo: () => Promise.resolve(null),
  onRuntimeEvent: () => {},
  retryRuntime: () => {},
  redeployPlugins: () => Promise.resolve({ ok: false }),
  openLogDir: () => {},
  openExternal: () => {},
  // 桌面通知浮窗（无桥时的空实现）
  toast: () => Promise.resolve(false),
  onOpenSession: () => {},
  onCallHotkey: () => {},
  getCallHotkey: () => Promise.resolve("Alt+V"),
  setCallHotkey: () => Promise.resolve(false),
};

// DOM 核心节点索引
const frame = document.getElementById("dsh-frame");
const mask = document.getElementById("error-mask");
const errMsg = document.getElementById("error-msg");
const retryBtn = document.getElementById("btn-retry");

// 搜索框开屏舞台节点
const searchStage = document.getElementById("search-stage");
const ssSearchBar = document.getElementById("ss-search-bar");
const ssStepText = document.getElementById("ss-step-text");
const ssPercent = document.getElementById("ss-percent");

// ================= 左上角常驻窗口控制（最小化 / 最大化） =================
// 不再做「贴右边缘悬停 1.5 秒滑出」那种交互：两个按钮常驻窗口左上角，整组高 24px，
// 正好落在 WebUI 侧边栏顶部内容（「新建会话」按钮与品牌 logo 都从 y=24 起）之上，
// 因此既不挡点击、也不会在页面按钮上方飘来飘去。
const winControls = document.getElementById("win-controls");
const winMin = document.getElementById("win-min");
const winMax = document.getElementById("win-max");
const shellToast = document.getElementById("shell-toast");
let toastTimer = null;

// 显示 / 隐藏由主进程判定（光标是否在窗口左上角那块区域）后推过来：
// 平时完全隐藏且 pointer-events: none，绝不会挡住 WebUI 侧边栏顶部的按钮。
function setWinControlsShown(show) {
  if (!winControls) return;
  winControls.classList.toggle("is-shown", !!show);
  winControls.setAttribute("aria-hidden", show ? "false" : "true");
}
api.onWinControls?.(setWinControlsShown);

// 最小化：交给主进程（缩到托盘，服务不停）
winMin?.addEventListener("click", () => api.minimizeWindow?.());

// 最大化 ↔ 还原：按钮图标由主进程回灌的 html.is-maximized 类切换（见 topbar.css）
winMax?.addEventListener("click", () => api.maximizeWindow?.());

function showToast(text, kind) {
  if (!shellToast) return;
  shellToast.textContent = text;
  shellToast.className = `shell-toast is-${kind || "ok"} is-show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { shellToast.className = "shell-toast"; }, 2800);
}

let isCurrentlyMaximized = false;

// 最大化状态实时同步：只切 html.is-maximized，控制条上的图标由 CSS 跟着换
function applyMaximizeState(flag) {
  isCurrentlyMaximized = !!flag;
  document.documentElement.classList.toggle("is-maximized", isCurrentlyMaximized);
}
api.onMaximizeState?.(applyMaximizeState);
api.isMaximized?.().then(applyMaximizeState).catch(() => {});

// ---------- 桌面通知浮窗的桥（任务完成提醒） ----------
// WebUI 侧的 dsh-companion 插件经 `window.__dshNotify` 调到这里；壳页面把请求
// 转给主进程去开桌面浮窗。浮窗点击后主进程回发 `shell:open-session`，这里把会话
// id 转交给 WebUI 文档——复用插件已有的跳转入口（壳页面与 iframe 同源可达
// http://127.0.0.1:3080，见 topbar.html 的 CSP）。
window.__dshShellToast = {
  /**
   * 显示桌面浮窗。
   * @param {{title?:string,text?:string,meta?:string,kind?:string,sessionId?:string}} payload
   * @returns {Promise<boolean>} 主进程是否受理
   */
  show(payload) {
    try {
      return Promise.resolve(api.toast?.(payload)).catch(() => false);
    } catch {
      return Promise.resolve(false);
    }
  },
};

// 浮窗被点击 → 主进程唤起主窗并回传会话 id → 转交 WebUI 跳转
api.onOpenSession?.((sessionId) => {
  if (typeof sessionId !== "string" || sessionId === "") return;
  try {
    // WebUI 文档（iframe 内）里的插件在 window 上挂了 __dshNotify.call；
    // 跳转本身由插件的 session-nav 统一处理（含失败提示条）。
    const win = frame && frame.contentWindow;
    if (win && typeof win.__dshNotify?.openSession === "function") {
      win.__dshNotify.openSession(sessionId);
      return;
    }
  } catch { /* 跨源/未就绪：下面用 postMessage 兜底 */ }
  try {
    // 兜底：同源时直接 postMessage 给 iframe 文档（插件监听该消息）
    frame?.contentWindow?.postMessage({ type: "dsh-open-session", sessionId }, "*");
  } catch { /* 无法投递：主窗已唤起，用户可手动切会话 */ }
});

// ---------- 语音通话全局热键（dsh-seeker-bot） ----------
// OS 级：主进程 globalShortcut 命中后推 shell:call-hotkey，这里转交 iframe。
api.onCallHotkey?.(() => {
  try { frame?.contentWindow?.postMessage({ type: "dsh:call-hotkey" }, "*"); } catch { /* iframe 未就绪 */ }
});
// 窗口级兜底：焦点落在标题栏时按键不会进 iframe，把带修饰键的按键转过去，
// 由插件用同一份偏好匹配（globalShortcut 成功时按键已被主进程吃掉，不会重复）。
window.addEventListener("keydown", (e) => {
  if (e.repeat || e.defaultPrevented) return;
  if (!(e.ctrlKey || e.altKey || e.shiftKey || e.metaKey)) return;
  try {
    frame?.contentWindow?.postMessage({
      type: "dsh:hotkey-down",
      key: e.key, code: e.code,
      ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey,
    }, "*");
  } catch { /* iframe 未就绪 */ }
});

// 壳 chrome（非 iframe）上一律右键静默：主进程已 preventDefault，这里再兜一层，
// 确保顶栏区域右键既没有壳菜单也没有 Chromium 的「检查 / 打印 / 全屏」。
// 注意本监听只作用于壳页面自身文档，iframe 里 Web UI 的原生右键菜单完全不受影响。
document.addEventListener("contextmenu", (e) => e.preventDefault());

// ---------- 主题自适应系统 ----------
function applyTheme(theme) {
  const t = (theme === "light") ? "light" : "dark";
  const root = document.documentElement;
  root.setAttribute("data-theme", t);
  root.style.colorScheme = t;
}

api.getTheme?.().then(applyTheme);
api.onTheme?.(applyTheme);

if (window.matchMedia) {
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  mql.addEventListener("change", (e) => {
    applyTheme(e.matches ? "dark" : "light");
  });
}

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data) return;
  // 插件在 iframe 里改了快捷键 → 转给主进程重新注册 OS 级热键
  if (data.type === "dsh:set-call-hotkey" && typeof data.accelerator === "string" && event.source === frame?.contentWindow) {
    api.setCallHotkey?.(data.accelerator);
  }
  if (data.type === "dsh:theme" || data.type === "dsh:theme-change") {
    const theme = data.theme || data.colorScheme;
    if (theme === "light" || theme === "dark") {
      applyTheme(theme);
    }
  }
});

// ---------- 文字从左往右铺开展开核心动画系统 ----------
let currentPct = 28;

// 初次加载让初始文字即执行从左往右铺开动效
if (ssStepText) {
  ssStepText.classList.add("unfolding");
}

function updateStepTextWithTransition(newText, targetPct) {
  if (ssStepText && ssStepText.textContent === newText) {
    if (targetPct) setPercent(targetPct);
    return;
  }
  if (!ssStepText) return;

  // 1. 旧文字向右快速淡出
  ssStepText.classList.remove("unfolding");
  ssStepText.classList.add("fading-out");

  setTimeout(() => {
    // 2. 注入新文字并从左往右优雅铺开展现
    ssStepText.textContent = newText;
    ssStepText.classList.remove("fading-out");
    ssStepText.classList.add("unfolding");
    if (targetPct) setPercent(targetPct);
  }, 130);
}

function setPercent(pct) {
  currentPct = Math.max(currentPct, Math.min(100, pct));
  if (ssPercent) ssPercent.textContent = currentPct + "%";
}

// 模拟启动阶段自然推进
setTimeout(() => {
  if (stageState === "waiting") {
    updateStepTextWithTransition("正在建立本地通讯通道…", 62);
  }
}, 420);

setTimeout(() => {
  if (stageState === "waiting") {
    updateStepTextWithTransition("正在装载运行环境与工作空间…", 86);
  }
}, 900);

// ---------- 搜索框向下滑动与展开主页面状态机 ----------
let stageState = "waiting"; // waiting -> gliding -> done
let dshUrl = "http://127.0.0.1:3080";
let frameLoadedUrl = null;

function revealAndGlideDown() {
  if (stageState === "gliding" || stageState === "done") return;
  stageState = "gliding";

  hideRuntimeNote(); // 环境就绪：撤掉开屏上的环境提示/错误块
  updateStepTextWithTransition("环境就绪，探索未至之境…", 100);

  setTimeout(() => {
    // 触发搜索框向下平滑滑动到聊天输入框位置
    if (searchStage) searchStage.classList.add("gliding-down");
    /*
     * 入场这 520ms 临时借一个合成层，保证 opacity/transform 动画不掉帧；
     * 落位后必须清掉 —— iframe 常驻 transform/will-change 会永久留在合成层里，
     * Electron 下 iframe 内部滚动会走慢路径（浏览器直开正常、壳子里像掉帧的根因）。
     */
    if (frame) frame.style.willChange = "opacity, transform";
    // 同时平滑展开主页面 WebUI
    document.body.classList.add("page-revealed");

    setTimeout(() => {
      stageState = "done";
      if (searchStage) searchStage.classList.add("done");
      if (frame) {
        frame.style.willChange = "auto";
        frame.style.transform = "none";
      }
    }, 650);
  }, 180);
}

// 用户自主跳过通道
function tryInstantSkip() {
  if (stageState === "done" || stageState === "gliding") return;
  revealAndGlideDown();
}

ssSearchBar?.addEventListener("click", tryInstantSkip);
window.addEventListener("keydown", (e) => {
  if (stageState !== "done" && (e.code === "Space" || e.code === "Enter" || e.code === "Escape")) {
    tryInstantSkip();
  }
});

// ---------- 运行环境状态与错误提示（1.1.34） ----------
// 旧版：运行环境缺失（别人电脑上没有 DSH 运行时 / Node.js）时，服务永远起不来，
// 开屏动画静默停在 86%，既不推进也不报错。现在主进程经 shell:runtime-event 把
// 「体检 / 自动部署进度 / 失败原因」实时推到这里，失败时给出动作入口。
const rnBox = document.getElementById("ss-runtime-note");
const rnTitle = document.getElementById("ss-rn-title");
const rnText = document.getElementById("ss-rn-text");
const rnHint = document.getElementById("ss-rn-hint");
const rnRetry = document.getElementById("ss-rn-retry");
const rnNode = document.getElementById("ss-rn-node");
const rnLog = document.getElementById("ss-rn-log");

function showRuntimeNote(kind, text, hint, actions) {
  if (!rnBox) return;
  if (rnTitle) rnTitle.textContent = kind === "error" ? "启动受阻" : "环境提示";
  if (rnText) rnText.textContent = text || "";
  if (rnHint) rnHint.textContent = hint || "";
  const acts = Array.isArray(actions) ? actions : [];
  if (rnRetry) rnRetry.style.display = acts.includes("retry") ? "inline-block" : "none";
  if (rnNode) rnNode.style.display = acts.includes("install-node") ? "inline-block" : "none";
  if (rnLog) rnLog.style.display = acts.includes("log") ? "inline-block" : "none";
  rnBox.style.display = "block";
  rnBox.classList.toggle("is-error", kind === "error");
}

function hideRuntimeNote() {
  if (rnBox) rnBox.style.display = "none";
}

function handleRuntimeEvent(evt) {
  if (!evt) return;
  if (evt.type === "status") {
    // 部署中：开屏阶段用真实进度覆盖假动画；已进主界面则只在需要时提示
    if (stageState === "waiting") {
      updateStepTextWithTransition(evt.text || "正在准备运行环境…", evt.percent || 90);
    }
    return;
  }
  if (evt.type === "warn") {
    if (stageState !== "done") showRuntimeNote("warn", evt.text || "", evt.hint || "", evt.actions);
    return;
  }
  if (evt.type === "error") {
    showRuntimeNote("error", evt.text || "启动异常", evt.hint || "", evt.actions);
    if (stageState === "waiting") setPercent(Math.max(currentPct, 92)); // 不再假装推进
  }
}

// 「重新安装插件」：插件套件 zip 更新后 / 上次装失败时用（只在主界面提供）
function redeployPlugins() {
  api.redeployPlugins?.().then((r) => {
    if (r && r.ok) {
      if (stageState === "waiting") updateStepTextWithTransition("插件套件已更新，正在重启内核…", 100);
    } else if (r && r.error) {
      showRuntimeNote("error", "插件套件安装失败", r.error, ["log"]);
    }
  }).catch(() => {});
}

api.onRuntimeEvent?.(handleRuntimeEvent);

rnRetry?.addEventListener("click", () => {
  hideRuntimeNote();
  if (stageState !== "done") updateStepTextWithTransition("正在重试启动…", 90);
  api.retryRuntime?.();
});
rnNode?.addEventListener("click", () => {
  api.openExternal?.("https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi");
});
rnLog?.addEventListener("click", () => api.openLogDir?.());

// 初始兜底：主进程事件可能发在本订阅之前（冷启动竞态），拉一次快照补齐
api.getRuntimeInfo?.().then((info) => {
  if (!info) return;
  if (info.lastEvent) { handleRuntimeEvent(info.lastEvent); return; }
  if (info.inspect && info.inspect.runtime && !info.inspect.runtime.ok && stageState !== "done") {
    // 体检已发现 runtime 缺失但事件尚未到达：按"部署中"显示
    updateStepTextWithTransition("正在部署本地内核运行环境…", 88);
  }
}).catch(() => { /* 桥不可用：保持旧行为 */ });

// ---------- iframe 加载与导航管理 ----------
let glideFallbackTimer = null;

function onFrameLoad() {
  let currentUrl = null;
  try {
    currentUrl = frame ? frame.contentWindow?.location?.href : null;
  } catch {
    // 跨域（file:// 访问 http://）会触发 SecurityError，回退到 frame.src
    currentUrl = frame ? frame.src : null;
  }
  if (!currentUrl || currentUrl === "about:blank") return;
  frameLoadedUrl = currentUrl;
  if (mask) mask.style.display = "none";
  // 窗口控制能力声明（握手第二程）：iframe 每次真加载都主动推一次，
  // 与插件的 dsh:shell-hello 重试互为兜底，晚 boot 的插件也能拿到留位信号。
  try { frame.contentWindow?.postMessage({ type: "dsh:shell-chrome" }, "*"); } catch { /* 跨源读不到：忽略 */ }
  // 服务真正加载成功：留 180ms 确保首屏 DOM 渲染上屏，彻底避免白屏或半成品提前暴露
  if (stageState === "waiting") {
    if (glideFallbackTimer) clearTimeout(glideFallbackTimer);
    setTimeout(revealAndGlideDown, 180);
  }
}

if (frame) {
  frame.addEventListener("load", onFrameLoad);
}

function forceNav(url) {
  if (!frame) return;
  const isMaskVisible = mask && mask.style.display === "flex";
  if (frameLoadedUrl === url && stageState === "done" && !isMaskVisible) return;
  try {
    frame.contentWindow.location.replace(url);
  } catch {
    frame.src = url;
  }
}

api.onServiceReady?.((url) => {
  dshUrl = url;
  // 主进程「清理缓存并重启」会给 iframe 下发带 _r=<时间戳> 的 URL 强制重载，
  // 收到这个标记就说明缓存已清理、界面已重新加载
  if (typeof url === "string" && url.includes("_r=")) {
    showToast("缓存已清理，界面已重新加载", "ok");
  }
  if (stageState === "waiting") {
    updateStepTextWithTransition("官方内核服务已就绪…", 98);
    forceNav(url);
    // 关键优化：等待页面加载真正完成（优先由 onFrameLoad 触发自然进入），
    // 绝不再以 300ms 抢跑滑开暴露认证中页面；设置 1500ms 兜底定时器
    if (glideFallbackTimer) clearTimeout(glideFallbackTimer);
    glideFallbackTimer = setTimeout(() => {
      revealAndGlideDown();
    }, 1500);
  } else if (stageState === "done") {
    forceNav(url);
    if (mask && mask.style.display === "flex") {
      mask.style.display = "none";
    }
  }
});

// 关键异常处理：在开屏等待阶段绝不弹全屏错误，搜索框平滑吸纳状态
api.onFrameError?.((msg) => {
  if (stageState !== "done") {
    updateStepTextWithTransition("正在等待本地服务响应…", 88);
    return;
  }
  // 已进入主界面后出现断线时才展示容错层
  if (mask) mask.style.display = "flex";
  if (errMsg) errMsg.textContent = msg || "本地服务连接异常，正在重试…";
  if (retryBtn) retryBtn.style.display = "inline-block";
});

retryBtn?.addEventListener("click", () => {
  if (mask) mask.style.display = "none";
  forceNav(dshUrl);
});

api.getState?.().then((st) => {
  if (st?.dshUrl) dshUrl = st.dshUrl;
  if (st?.serviceReady && st?.dshUrl) {
    updateStepTextWithTransition("官方内核服务已就绪…", 98);
    forceNav(dshUrl);
    if (glideFallbackTimer) clearTimeout(glideFallbackTimer);
    glideFallbackTimer = setTimeout(() => {
      revealAndGlideDown();
    }, 1500);
  }
});

api.onWindowShown?.(() => {
  // 保持用户拖拽的窗口尺寸，不要在窗口显示时强制最大化
});

// ================= 右下角微型更新指示图标与演进弹窗系统 =================
const updateBeacon = document.getElementById("update-beacon");
const updateModal = document.getElementById("update-modal");
const uBackdrop = document.getElementById("u-backdrop");
const uCloseBtn = document.getElementById("u-close-btn");
const uBadgeEngine = document.getElementById("u-badge-engine");
const uValCurrent = document.getElementById("u-val-current");
const uValLatest = document.getElementById("u-val-latest");
const uValUpdated = document.getElementById("u-val-updated");
const uStatusTip = document.getElementById("u-status-tip");
const uProgressCard = document.getElementById("u-progress-card");
const uProgStep = document.getElementById("u-prog-step");
const uProgPct = document.getElementById("u-prog-pct");
const uProgBarFill = document.getElementById("u-prog-bar-fill");
const uProgTicker = document.getElementById("u-prog-ticker");
const uBtnRebuild = document.getElementById("u-btn-rebuild");
const uBtnAction = document.getElementById("u-btn-action");

let updateCache = null;

function showUpdateModal() {
  if (updateModal) updateModal.style.display = "flex";
  refreshUpdateUI();
}

function hideUpdateModal() {
  if (updateModal) updateModal.style.display = "none";
}

uCloseBtn?.addEventListener("click", hideUpdateModal);
uBackdrop?.addEventListener("click", hideUpdateModal);
updateBeacon?.addEventListener("click", showUpdateModal);
// 托盘「检查 DSH 更新」：主进程发 shell:open-update-modal，这里打开演进中心弹窗
api.onOpenUpdateModal?.(() => showUpdateModal());

window.addEventListener("keydown", (e) => {
  if (e.code === "Escape" && updateModal && updateModal.style.display === "flex") {
    hideUpdateModal();
  }
});

// 进度卡的成败色调：run 走品牌橙推进，warn 走琥珀色警示并轻微呼吸
function setProgressTone(tone) {
  const isWarn = tone === "warn";
  uProgressCard?.classList.toggle("is-warn", isWarn);
  uProgressCard?.classList.toggle("is-ok", !isWarn);
  uProgStep?.classList.toggle("is-warn", isWarn);
  uProgPct?.classList.toggle("is-warn", isWarn);
  uProgTicker?.classList.toggle("is-warn", isWarn);
}

function refreshUpdateUI() {
  if (!updateCache) {
    checkUpdates(true);
    return;
  }
  if (uValCurrent) uValCurrent.textContent = updateCache.currentVersion || "0.1.5-rc.2";
  if (uValLatest) uValLatest.textContent = updateCache.latestVersion || updateCache.currentVersion || "0.1.5-rc.2";
  if (uValUpdated) uValUpdated.textContent = updateCache.officialReleaseTime || updateCache.lastUpdated || localStorage.getItem("dsh_official_release_time") || "2026-09-10 22:57:10";

  if (updateCache.hasUpdate) {
    const pendingPublish = updateCache.pendingPublish === true;
    const pendingDeps = updateCache.pendingDeps === true;
    const pending = pendingPublish || pendingDeps;
    if (uBadgeEngine) {
      uBadgeEngine.textContent = pendingPublish
        ? "官方已发布 · NPM 待同步"
        : pendingDeps ? "官方分批发布中" : "发现新版本";
      uBadgeEngine.className = "u-badge warn";
    }
    if (uStatusTip) {
      uStatusTip.textContent = pendingPublish
        ? `官方 v${updateCache.latestVersion} 已在 GitHub 发布，NPM 仓库尚未同步完成，可稍后重试。`
        : pendingDeps
          ? `官方 v${updateCache.latestVersion} 正在分批发布，依赖包尚未齐备，现在升级会失败，可稍后重试。`
          : `发现官方新版本 v${updateCache.latestVersion}，点击立即一键升级`;
    }
    if (uBtnAction) {
      uBtnAction.textContent = pending ? "稍后重试" : "立即一键升级";
      uBtnAction.className = "u-btn u-btn-primary";
      uBtnAction.disabled = false;
    }
  } else {
    if (uBadgeEngine) {
      uBadgeEngine.textContent = "已是最新版本";
      uBadgeEngine.className = "u-badge ok";
    }
    if (uStatusTip) uStatusTip.textContent = "当前已为最新发行版本，无需更新。";
    if (uBtnAction) {
      uBtnAction.textContent = "重新检查";
      uBtnAction.className = "u-btn u-btn-tonal";
      uBtnAction.disabled = false;
    }
  }
}

async function checkUpdates(interactive = false) {
  if (interactive) {
    if (uBadgeEngine) {
      uBadgeEngine.textContent = "检查中…";
      uBadgeEngine.className = "u-badge";
    }
    if (uStatusTip) uStatusTip.textContent = "正在连接官方仓库检查更新…";
    if (uBtnAction) {
      uBtnAction.textContent = "正在检查…";
      uBtnAction.disabled = true;
    }
  }

  try {
    const res = await api.checkUpdate?.();
    const beaconDot = document.getElementById("beacon-dot");
    if (res?.ok && res.data) {
      updateCache = res.data;
      const offTime = res.data.officialReleaseTime || res.data.lastUpdated;
      if (offTime) {
        try { localStorage.setItem("dsh_official_release_time", offTime); } catch {}
      }
      if (uValUpdated) {
        uValUpdated.textContent = offTime || localStorage.getItem("dsh_official_release_time") || "2026-09-10 22:57:10";
      }
      // 只有「真的有新版本」才显示这个角落图标；没更新时彻底不占位（用户明确要求）
      if (updateBeacon) updateBeacon.style.display = res.data.hasUpdate ? "flex" : "none";
      // 有新版本时图标常态走品牌橙，不靠红点才能注意到
      updateBeacon?.classList.toggle("has-update", !!res.data.hasUpdate);
      if (res.data.hasUpdate) {
        if (beaconDot) beaconDot.style.display = "block";
        if (updateBeacon) updateBeacon.title = `发现官方新版本 v${res.data.latestVersion}，点击一键升级`;
      } else {
        if (beaconDot) beaconDot.style.display = "none";
        if (updateBeacon) updateBeacon.title = "DeepSeek Harness 演进中心";
      }
      if (interactive || (updateModal && updateModal.style.display === "flex")) {
        refreshUpdateUI();
      }
    }
  } catch (err) {
    if (interactive && uStatusTip) {
      uStatusTip.textContent = "检查更新失败，请稍后重试";
    }
  }
}

// 启动 3.5 秒后在后台静默检查是否有更新，有更新才在顶部栏淡出指示图标
setTimeout(() => {
  checkUpdates(false);
}, 3500);

// 每 30 分钟后台静默巡检一次
setInterval(() => {
  checkUpdates(false);
}, 30 * 60 * 1000);

// 操作更新触发
uBtnAction?.addEventListener("click", () => {
  if (updateCache?.hasUpdate) {
    executeRunUpdate();
  } else {
    checkUpdates(true);
  }
});

uBtnRebuild?.addEventListener("click", () => {
  executeRunUpdate(true);
});

async function executeRunUpdate(force = false) {
  if (uProgressCard) uProgressCard.style.display = "flex";
  setProgressTone("ok");
  if (uProgBarFill) uProgBarFill.classList.remove("is-warn");
  if (uProgStep) uProgStep.textContent = "正在启动更新任务…";
  if (uProgPct) uProgPct.textContent = "0%";
  if (uProgBarFill) uProgBarFill.style.width = "0%";
  if (uProgTicker) uProgTicker.textContent = "正在初始化更新进程…";
  if (uBtnAction) uBtnAction.disabled = true;
  if (uBtnRebuild) uBtnRebuild.disabled = true;

  try {
    const res = await api.runUpdate?.({ force });
    if (!res?.ok) {
      if (uProgStep) uProgStep.textContent = "更新任务未成功完成";
      if (uProgTicker) uProgTicker.textContent = res?.error || `退出码: ${res?.code ?? "未知"}`;
      if (uBtnAction) uBtnAction.disabled = false;
      if (uBtnRebuild) uBtnRebuild.disabled = false;
    }
  } catch (err) {
    if (uProgStep) uProgStep.textContent = "更新任务启动异常";
    if (uProgTicker) uProgTicker.textContent = String(err?.message || err);
    if (uBtnAction) uBtnAction.disabled = false;
    if (uBtnRebuild) uBtnRebuild.disabled = false;
  }
}

api.onUpdateEvent?.((event) => {
  if (!event) return;
  if (event.type === "progress" || event.type === "step") {
    if (uProgStep) uProgStep.textContent = event.step || "正在更新…";
    if (event.percent !== undefined) {
      if (uProgPct) uProgPct.textContent = `${event.percent}%`;
      if (uProgBarFill) uProgBarFill.style.width = `${event.percent}%`;
    }
    const ticker = event.detail || event.text;
    if (uProgTicker && ticker) uProgTicker.textContent = ticker;
  } else if (event.type === "log" && (event.text || event.detail)) {
    if (uProgTicker) uProgTicker.textContent = event.text || event.detail;
  } else if (event.type === "done" || event.type === "complete") {
    if (event.officialReleaseTime) {
      try { localStorage.setItem("dsh_official_release_time", event.officialReleaseTime); } catch {}
      if (uValUpdated) uValUpdated.textContent = event.officialReleaseTime;
      if (updateCache) updateCache.officialReleaseTime = event.officialReleaseTime;
    }
    // 引擎没换掉就如实说没换掉，绝不再弹「更新完成」绿勾
    const engineFailed = event.force !== true && event.engineUpgraded === false;
    if (uProgStep) uProgStep.textContent = engineFailed ? "引擎未升级" : "更新完成！正在重启服务…";
    if (uProgPct) uProgPct.textContent = engineFailed ? "!" : "100%";
    if (uProgBarFill) {
      uProgBarFill.style.width = engineFailed ? "100%" : "100%";
      uProgBarFill.classList.toggle("is-warn", engineFailed);
    }
    if (uProgTicker) uProgTicker.textContent = event.message || `全部插件构建完成，耗时: ${event.duration || "1.8"} 秒`;
    setProgressTone(engineFailed ? "warn" : "ok");
    if (engineFailed && uValCurrent && event.engineVersion) {
      uValCurrent.textContent = event.engineVersion;
    }
    setTimeout(() => {
      if (!engineFailed) hideUpdateModal();
      const beaconDot = document.getElementById("beacon-dot");
      // 升级失败时保留红点：只要引擎还没到目标版本，就该继续提醒
      if (beaconDot) beaconDot.style.display = engineFailed ? "block" : "none";
      if (updateBeacon) {
        // 升级成功且没有待处理更新 → 图标收起；只有失败（引擎仍未到位）才留着重试入口
        updateBeacon.style.display = engineFailed ? "flex" : "none";
        updateBeacon.title = engineFailed ? "官方引擎尚未升级，稍后重试" : "DeepSeek Harness 演进中心";
        updateBeacon.classList.toggle("has-update", engineFailed);
      }
      if (uProgressCard) uProgressCard.style.display = engineFailed ? "flex" : "none";
      if (uBtnAction) uBtnAction.disabled = false;
      if (uBtnRebuild) uBtnRebuild.disabled = false;
      if (engineFailed) {
        // 重新拉一次真实状态，让徽章/版本号自己纠正过来
        checkUpdates(true);
      }
    }, engineFailed ? 600 : 1800);
  }
});

