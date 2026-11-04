// main.js — DeepSeek Harness 桌面壳（无边框 + 启动动画）
// - 无边框窗口：无系统标题栏；右上角壳自绘 最小化/最大化·还原/关闭 三枚窗口
//   控制按钮（配色跟随主题；dsh-chat-plus 插件在壳内把会话 header 右簇左移
//   100px 留位，并经 dsh:theme postMessage 同步界面深浅）
// - 启动动画：图标 + 探索未至之境 + 预览版，服务真正就绪后全屏展开进入
// - iframe 全屏承载 dsh WebUI，自动拉起或复用 dsh 服务
// - 关闭窗口 = 最小化到托盘，dsh 服务保持运行
// - 托盘：显示主窗口 / 开机自动启动开关 / 退出（保留服务）/ 退出并停止服务
// - 开机自启：托盘勾选，经 app.setLoginItemSettings 写 Run 键；登录自启时最小化到托盘
// - 服务重启看门狗：探测到 3080 服务 可用→掉线→恢复 即自动重载 iframe 页面，
//   覆盖托盘重启、计划任务（restart-dsh.ps1）、外部重启等一切场景，无需手动刷新
// - 安全启动：插件/补丁配置导致服务起不来时，解析 DSH 启动诊断、自动禁用出错插件
//   （--patch overlay / 移除坏 bundle / 注释坏 patch 条目）并重启，最多 3 轮；
//   记录在 userData/safe-boot.json，托盘可查看/恢复
// - 单实例：重复启动时聚焦已有窗口

const { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, ipcMain, WebContentsView, shell, session, net } = require("electron");
const { spawn, exec, execSync, execFileSync } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");

// ---------- 安装器模式：最先判定并分流，绝不进入壳初始化 ----------
// 自解压安装包（7zSD.sfx，非 NSIS）解压后以 `--setup` 启动本程序，此时要弹的是
// 纯白无边框卡片安装界面，而不是主壳。这里必须放在文件最前：后面有 CDP 端口、
// 单实例锁、托盘、服务拉起等一大堆壳逻辑，安装器模式下一条都不该跑
// （跑了会占端口、抢 userData、甚至把 dsh 服务拉起来）。
const { isSetupMode } = require("./setup-mode");
const IS_SETUP = isSetupMode();
if (IS_SETUP) {
  require("./setup-main").runSetup(process.argv.slice(2));
} else {

// AI 浏览器内嵌视图：开放壳子 CDP 调试端口（必须在 ready 前注册），
// dsh-webui 插件经该端口用标准 DevTools 协议操作壳内的 WebContentsView，
// 不再启动任何独立 Edge/Chrome 进程。
// 端口动态协商：异常退出的壳子可能在系统里留下「僵尸监听」（死 pid 占着
// 端口，新实例绑定静默失败），故启动时从 9224 起找一个真正空闲的端口，
// 并把最终端口写进 .shell-cdp-port 文件供插件读取。
const { networkInterfaces } = require("node:os");
const os = require("node:os");
const BV_CDP_BASE_PORT = 9224;

// ---------- 用户数据目录与运行环境定位 ----------
// 背景（1.1.34）：壳子原来把 DSH 运行时硬编码成 D:\AI\Dsh\dsh-runtime，
// 只有开发机跑得起来；分发到别人电脑后 spawn 一个不存在的 bin.js，服务永远
// 起不来，开屏动画就一直停在 86%（renderer 在 waiting 阶段又不报错，只把
// 文案推到 88%「正在等待本地服务响应…」）。现在改成三级定位：
//   1. 开发机旧布局（D:\AI\Dsh\dsh-runtime 存在）→ 原样沿用，零迁移；
//   2. 用户级运行环境 %APPDATA%\DeepSeek Harness\runtime → npm 现场部署目标；
//   3. 都没有 → 由 ensureRuntimeReady 自动部署（npm i @deepseek-ai/dsh）。
let _userDataDirCache = null;
function userDataDir() {
  if (_userDataDirCache) return _userDataDirCache;
  let base = null;
  try { base = app.getPath("userData"); } catch { /* ready 前/异常：走环境变量兜底 */ }
  if (!base) {
    const roam = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    base = path.join(roam, "DeepSeek Harness");
  }
  try { fs.mkdirSync(base, { recursive: true }); } catch { /* 只读场景由各处 try/catch 兜底 */ }
  _userDataDirCache = base;
  return base;
}
function userRuntimeDir() { return path.join(userDataDir(), "runtime"); }
function userLogDir() {
  const d = path.join(userDataDir(), "logs");
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* 忽略 */ }
  return d;
}
// 开发机旧布局常量：只为兼容老机器保留，**只在用户级 runtime 缺失时才回退**。
// 新装一律落到用户级目录（见 userRuntimeDir），别人电脑上根本不会有这个路径。
const LEGACY_DSH_DIR = "D:\\AI\\Dsh\\dsh-runtime";
// 首次部署时装哪个版本的 @deepseek-ai/dsh（npm 的 latest 稳定线）。
// 注意：这个值只决定「新部署」和「已有部署的升级目标」，用户已装版本由
// runtime/package.json 里的 dependencies 记录，见 deployRuntime。
const DSH_VERSION = "0.2.1-rc.5";
// npm 源顺序：镜像优先（实测国内 512 个包 31 秒装完；官方源常要数分钟），
// rc 版本镜像未同步时自动回退官方源兜底。
const NPM_REGISTRIES = ["https://registry.npmmirror.com", "https://registry.npmjs.org"];
const NODE_DOWNLOAD_URL = "https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi";
const RUNTIME_DISK_HINT = "首次启动需拉取运行时组件（约 600 MB 磁盘空间，1～5 分钟）";

function dshBinIn(dir) { return path.join(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"); }
function dshLayoutRoot() {
  // 布局根 = runtime 的上一级（用户级：userData；老机器 legacy：D:\AI\Dsh）
  if (fs.existsSync(dshBinIn(userRuntimeDir()))) return userDataDir();
  if (fs.existsSync(dshBinIn(LEGACY_DSH_DIR))) return path.dirname(LEGACY_DSH_DIR);
  return userDataDir();
}
// 每次调用都重新探测：部署前是 missing，部署后要能立刻变成可用。
// 顺序：用户级优先，legacy 只作兜底 —— 这样开发机迁到默认位置后不会继续吃旧目录。
function resolveDshDir() {
  const userDir = userRuntimeDir();
  if (fs.existsSync(dshBinIn(userDir))) return { dir: userDir, source: "user" };
  if (fs.existsSync(dshBinIn(LEGACY_DSH_DIR))) return { dir: LEGACY_DSH_DIR, source: "legacy" };
  return { dir: userDir, source: "missing" };
}
// 实际装着的引擎版本（读 node_modules 里的 package.json，读不到才回退到常量）
function installedDshVersion() {
  try {
    const p = path.join(resolveDshDir().dir, "node_modules", "@deepseek-ai", "dsh", "package.json");
    const v = JSON.parse(fs.readFileSync(p, "utf8")).version;
    if (v) return v;
  } catch { /* 未安装 / 文件损坏：回退常量 */ }
  return DSH_VERSION;
}
function dshDir() { return resolveDshDir().dir; }
function dshBin() { return dshBinIn(dshDir()); }
function svcOutLogPath() { return path.join(userLogDir(), "dsh-service-out.log"); }
function svcErrLogPath() { return path.join(userLogDir(), "dsh-service-err.log"); }
function shellLogPath() { return path.join(userLogDir(), "shell.log"); }
// CDP 端口文件：新位置（userData）+ 旧位置（开发机，插件读它，双写保证零迁移）
function cdpPortFile() { return path.join(userDataDir(), ".shell-cdp-port"); }
const BV_CDP_PORT_FILE_LEGACY = "D:\\AI\\Dsh\\.shell-cdp-port";
function writeCdpPortFile(port) {
  for (const f of [cdpPortFile(), BV_CDP_PORT_FILE_LEGACY]) {
    try { fs.writeFileSync(f, String(port)); } catch { /* 写失败插件走默认 */ }
  }
}
function readCdpPortFile() {
  for (const f of [cdpPortFile(), BV_CDP_PORT_FILE_LEGACY]) {
    try { const v = Number(fs.readFileSync(f, "utf8").trim()); if (Number.isInteger(v) && v > 0) return v; } catch { /* 尝试下一个 */ }
  }
  return null;
}
// Node.js 定位：常见安装位（含用户级 / nvm-windows）→ PATH 探测 → 找不到返回 null
function findNode() {
  const cands = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "nodejs", "node.exe"),
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", "nodejs", "node.exe"),
    path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "nvm", "current", "node.exe"),
  ];
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch { /* 继续 */ } }
  try {
    const out = execSync("where node", { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const first = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  } catch { /* PATH 里没有 node */ }
  return null;
}
function bvPickCdpPort() {
  for (let p = BV_CDP_BASE_PORT; p < BV_CDP_BASE_PORT + 10; p++) {
    let busy = false;
    try {
      const out = execSync(`netstat -ano | findstr ":${p} " | findstr "LISTENING"`, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      if (out && out.trim() !== "") busy = true;
    } catch { /* findstr 无匹配（非零退出码）= 端口空闲 */ }
    if (!busy) return p;
  }
  return BV_CDP_BASE_PORT; // 全被占则仍尝试首选（行为同旧版）
}
const BV_CDP_PORT = bvPickCdpPort();
app.commandLine.appendSwitch("remote-debugging-port", String(BV_CDP_PORT));
app.commandLine.appendSwitch("remote-allow-origins", "*");
// 防后台节流：AI 浏览器视图经常处于「未挂载/主窗口最小化/藏托盘」状态，
// Chromium 默认此时停合成、冻 rAF、节流定时器 → CDP 截图等不到帧必超时
// （Page.captureScreenshot 卡满超时的根因）。三开关让渲染管线保持全速。
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
// Windows 原生遮挡判定会把被遮挡/最小化窗口整个判为 occluded 停止渲染，
// 禁用后最小化窗口仍持续产帧（VS Code 同款做法）。
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
// 放行自动播放：完成提示音在**窗口不在前台**时播放（那正是提醒的用途），
// 而 Chromium 默认的 autoplay 策略要求页面有用户手势，否则 play() 直接 reject
// ——表现为「点了窗口之后才有声音，纯后台没声音」。壳子是本机应用，提示音是
// 自己的 UI 音效，放行没有副作用。
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
try { writeCdpPortFile(BV_CDP_PORT); } catch { /* 双写失败插件走默认 */ }
// 自愈：杀壳后立刻重启时，旧实例的端口残影会让上面的 netstat 探测误判（实测：
// 文件写 9225、实际监听 9224）。ready 后按本进程 PID 反查真实监听端口，
// 与文件不一致则以实际为准重写——插件每次实时读文件，随即自愈。
app.whenReady().then(() => {
  setTimeout(() => {
    try {
      const fsMod = require("node:fs");
      const { execSync: es } = require("node:child_process");
      const all = es('netstat -ano | findstr "LISTENING"', { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      const own = all.split("\n").map(l => l.trim()).filter(l => l.endsWith(String(process.pid)) && /:9[22]\d\d\s/.test(l));
      if (own.length === 0) return;
      const actual = Number(own[0].match(/:(9\d{3})\s/)[1]);
      let recorded = readCdpPortFile();
      if (actual !== recorded) writeCdpPortFile(actual);
    } catch { /* 复核失败保持原文件 */ }
  }, 8000);
});

// 服务端口：默认 3080。可用环境变量 DSH_SHELL_PORT 覆盖（测试隔离 / 端口冲突时用）。
// 注意：DSH_URL 被 cookie、auth 握手、iframe 加载等大量逻辑引用，改端口必须同时
// 把 spawn 的 --port 与 killPort 的探测端口一起改，见 startDshServiceOnce / killPort。
const DSH_PORT = Number(process.env.DSH_SHELL_PORT) > 0 ? Number(process.env.DSH_SHELL_PORT) : 3080;
const DSH_URL = "http://127.0.0.1:" + DSH_PORT;
// 服务运行时 = npm 已发布的 @deepseek-ai/dsh 包（dsh-runtime/package.json 锁版本，
// 当前 0.1.7-rc.1）。不再用 D:\AI\deepseek-harness 的 pnpm workspace 源码：
// 源码模式经 tsx 编译整个树，内存高且版本随 master 漂移（曾是"启动后仍是
// alpha 开发版"的根因；且壳子启动时会杀掉用户手动跑的已发布版服务）。
// 定位规则见上方「用户数据目录与运行环境定位」：开发机旧布局优先，其余落到
// %APPDATA%\DeepSeek Harness\runtime（由 npm 自动部署）。
const DSH_POLL_MS = 1500;
const DSH_POLL_TIMEOUT_MS = 120000;
// 服务日志落盘（logs/ 目录）：stdout/stderr 不再 pipe 到壳进程，
// 完整日志见这两个文件，壳控制台只镜像新增行。
// 服务重启后自动刷新的防抖窗口：避免连续重启/双路径触发导致页面反复重载
const RELOAD_COOLDOWN_MS = 5000;

// ── AI 浏览器内嵌视图宿主（对齐 openhanako：浏览器=壳内视图，零独立窗口）──
// - 多标签页：每会话一个 partition（登录态隔离），每标签一个 WebContentsView
// - create-tab / attach / detach / close-tab / close：由 dsh-webui 插件经本机 HTTP 调用
// - attach 只挂当前激活标签的视图，切换标签即换挂视图（bounds 保持）
// - 标记：view 初始 URL hash = #dshbv-<sessionKey>/<tabId>，供插件 CDP 匹配 target
const BV_HTTP_PORT = 3081;
const bvSessions = new Map(); // sessionKey -> { views: Map(tabId -> view), activeTabId, bounds }

function bvEnsureSession(sessionKey, loginKey) {
  let entry = bvSessions.get(sessionKey);
  if (!entry) {
    // loginKey：登录组键。缺省回退 sessionKey（每会话独立登录态，旧行为）；
    // 多个 sessionKey 传同一个 loginKey 即共用同一 Chromium partition——
    // 登录一次处处可用，persist: 前缀保证重启后仍在。
    entry = { views: new Map(), activeTabId: null, bounds: null, loginKey: loginKey || null };
    bvSessions.set(sessionKey, entry);
  }
  return entry;
}

function bvCreateView(sessionKey, tabId) {
  const entry = bvEnsureSession(sessionKey);
  const view = new WebContentsView({
    webPreferences: {
      partition: `persist:bv_${entry.loginKey || sessionKey}`, // 登录组分区分；缺省每会话独立
      contextIsolation: true,
      // 节流必须关：AI 视图经常处于未挂载/最小化/托盘状态，Chromium 默认此时
      // 停合成、冻 rAF、节流定时器，CDP Page.captureScreenshot 等不到合成帧
      // 直接超时（实测踩坑）。关闭后渲染管线全速，截图/screencast/输入都可靠。
      backgroundThrottling: false,
    },
  });
  view.setBackgroundColor("#ffffff");
  setupMediaPermissions(view.webContents.session);
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" })); // 弹窗一律拒绝
  view.webContents.loadURL(`about:blank#dshbv-${sessionKey}/${tabId}`); // CDP target 标记
  return view;
}

function bvCreateTab(sessionKey, tabId, loginKey) {
  const entry = bvEnsureSession(sessionKey, loginKey);
  if (entry.views.has(tabId)) return { ok: true, exists: true };
  entry.views.set(tabId, bvCreateView(sessionKey, tabId));
  if (!entry.activeTabId) entry.activeTabId = tabId;
  return { ok: true };
}

function bvAttach(sessionKey, tabId, x, y, w, h) {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: "no window" };
  const entry = bvEnsureSession(sessionKey);
  const view = entry.views.get(tabId);
  if (!view) return { ok: false, error: "no such tab" };
  // 只挂激活标签：先移除本会话其它已挂载视图
  for (const [id, v] of entry.views) {
    if (id === tabId) continue;
    try { mainWindow.contentView.removeChildView(v); } catch { /* 未挂载 */ }
    // 卸下的视图标记不可见：Chromium 随之停合成、节流 JS（空闲省电的关键）
    try { v.visible = false; } catch { /* 旧版本无此属性 */ }
  }
  mainWindow.contentView.addChildView(view);
  view.visible = true;
  view.setBounds({ x, y, width: w, height: h });
  // backgroundThrottling 已在创建时统一关闭（bvCreateView），挂载无需再切
  entry.activeTabId = tabId;
  entry.bounds = { x, y, w, h };
  return { ok: true };
}

function bvDetach(sessionKey) {
  const entry = bvSessions.get(sessionKey);
  if (!entry) return;
  for (const [, v] of entry.views) {
    try { mainWindow.contentView.removeChildView(v); } catch { /* 未挂载 */ }
    try { v.visible = false; } catch { /* 同上 */ }
    // 卸下后不再恢复节流：AI 可能随时对 detached 视图截图/操作，
    // 节流会让 CDP 截图等不到帧（实测踩坑），保持全速。
  }
}

function bvCloseTab(sessionKey, tabId) {
  const entry = bvSessions.get(sessionKey);
  if (!entry) return { ok: true };
  const view = entry.views.get(tabId);
  if (view) {
    try { mainWindow.contentView.removeChildView(view); } catch { /* 未挂载 */ }
    try { view.webContents.close(); } catch { /* 已销毁 */ }
    entry.views.delete(tabId);
  }
  // 关的是激活标签 → 自动切到剩余第一个
  if (entry.activeTabId === tabId) {
    entry.activeTabId = entry.views.keys().next().value || null;
  }
  return { ok: true, remaining: entry.views.size, activeTabId: entry.activeTabId };
}

function bvCloseAll(sessionKey) {
  const entry = bvSessions.get(sessionKey);
  if (!entry) return { ok: true };
  for (const [, v] of entry.views) {
    try { mainWindow.contentView.removeChildView(v); } catch { /* 未挂载 */ }
    try { v.webContents.close(); } catch { /* 已销毁 */ }
  }
  bvSessions.delete(sessionKey);
  return { ok: true };
}

function startBrowserViewHost() {
  const server = http.createServer((req, res) => {
    const json = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (!req.url.startsWith("/view/") && !req.url.startsWith("/auth/")) return json(404, { ok: false, error: "not found" });
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch { }
      // dsh web 启动 token：供 dsh-browser 给 AI 浏览器视图做自动认证
      // （访问 127.0.0.1:3080 时自动握手种 cookie，免手动带 token）。
      if (req.url === "/auth/launch-token") {
        // 先验证内存 token 是否仍有效（服务重启换进程后旧 token 当场失效）：
        // 失效就丢弃并从服务日志实测恢复；服务瞬时抖动（fetch 异常）按原样返回。
        (async () => {
          if (dshAuthToken) {
            try {
              const u = new URL(DSH_URL + "/");
              u.searchParams.set("token", dshAuthToken);
              const res = await fetch(u.href, { redirect: "manual", signal: AbortSignal.timeout(2000) });
              const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie()[0] : res.headers.get("set-cookie");
              if (res.status === 303 && setCookie) return dshAuthToken;
            } catch { return dshAuthToken; }
            dshAuthToken = "";
          }
          return recoverLaunchTokenFromLog();
        })().then(
          (token) => json(200, { ok: true, token: token || null, url: DSH_URL }),
          () => json(200, { ok: true, token: dshAuthToken || null, url: DSH_URL })
        );
        return; // 异步应答
      }
      const sessionKey = String(body.sessionKey || "").slice(0, 64);
      if (!sessionKey) return json(400, { ok: false, error: "sessionKey required" });
      try {
        if (req.url === "/view/create-tab") {
          const tabId = String(body.tabId || "").slice(0, 48);
          if (!tabId) return json(400, { ok: false, error: "tabId required" });
          const loginKey = String(body.loginKey || "").slice(0, 64);
          return json(200, bvCreateTab(sessionKey, tabId, loginKey));
        }
        if (req.url === "/view/attach") {
          const tabId = String(body.tabId || "");
          const x = Math.round(Number(body.x) || 0);
          const y = Math.round(Number(body.y) || 0);
          const w = Math.round(Number(body.w) || 0);
          const h = Math.round(Number(body.h) || 0);
          if (w < 50 || h < 50) return json(400, { ok: false, error: "bounds too small" });
          const r = bvAttach(sessionKey, tabId, x, y, w, h);
          return json(r.ok ? 200 : 500, r);
        }
        if (req.url === "/view/detach") {
          bvDetach(sessionKey);
          return json(200, { ok: true });
        }
        if (req.url === "/view/close-tab") {
          const tabId = String(body.tabId || "");
          if (!tabId) return json(400, { ok: false, error: "tabId required" });
          return json(200, bvCloseTab(sessionKey, tabId));
        }
        if (req.url === "/view/close") {
          return json(200, bvCloseAll(sessionKey));
        }
        if (req.url === "/view/capture") {
          // 截图兜底：Electron capturePage 走 viz CopyOutputRequest，强制渲染管线
          // 产出一帧并拷贝，不依赖页面可见性/合成器调度——CDP captureScreenshot
          // 在 detached/最小化/托盘状态下等不到帧时（实测超时），由插件调这里。
          const entry = bvSessions.get(sessionKey);
          const tabId = String(body.tabId || "");
          const view = entry
            ? (tabId ? entry.views.get(tabId) : entry.views.get(entry.activeTabId))
            : null;
          if (!view) return json(404, { ok: false, error: "no such tab" });
          const quality = Math.min(Math.max(Number(body.quality) || 80, 10), 100);
          view.webContents.capturePage()
            .then((img) => {
              try {
                if (!img || img.isEmpty()) return json(500, { ok: false, error: "capturePage returned empty image" });
                const size = img.getSize();
                const png = quality >= 100;
                const buf = png ? img.toPNG() : img.toJPEG(quality);
                json(200, { ok: true, data: buf.toString("base64"), width: size.width, height: size.height, format: png ? "png" : "jpeg" });
              } catch (err) {
                json(500, { ok: false, error: String((err && err.message) || err) });
              }
            })
            .catch((err) => json(500, { ok: false, error: String((err && err.message) || err) }));
          return; // 异步应答
        }
        return json(404, { ok: false, error: "not found" });
      } catch (err) {
        return json(500, { ok: false, error: String((err && err.message) || err) });
      }
    });
  });
  server.on("error", (err) => console.error("[shell] browser-view host error:", err.message));
  server.listen(BV_HTTP_PORT, "127.0.0.1", () => console.log(`[shell] browser-view host on 127.0.0.1:${BV_HTTP_PORT}`));
}

let mainWindow = null;
let tray = null;
let dshProc = null;
let dshOutFd = null;  // 服务 stdout 落盘 fd（随 killDsh 关闭）
let dshErrFd = null;  // 服务 stderr 落盘 fd
let svcOutOff = 0;    // 日志 tail 进度（只读新增完整行）
let svcErrOff = 0;
let serviceReady = false;
let quitting = false;           // 应用正在退出：放行窗口 close 事件
let stopServiceOnQuit = false;  // 退出时是否一并停止 dsh 服务
let trayNoticeShown = false;
// ---- 服务重启看门狗状态 ----
let svcUp = false;              // 当前探测结果
let svcEverUp = false;          // 本壳进程内服务是否曾可用（避免启动期 down→up 误判为重启）
let lastReloadAt = 0;           // 上次自动刷新时刻（防抖）

// ---------- 单实例：重复启动时聚焦已有窗口，而不是再开一份 ----------
// （安装器模式已在文件开头分流，这里只处理正常壳）
// 测试/多实例隔离：DSH_SHELL_USERDATA 覆盖 userData，必须在 requestSingleInstanceLock 之前
// 设置，否则锁、日志、safe-boot 状态都会落进真实壳子的目录。
if (process.env.DSH_SHELL_USERDATA) {
  try { app.setPath("userData", path.resolve(process.env.DSH_SHELL_USERDATA)); } catch { /* 非法路径回退默认 */ }
}
app.setAppUserModelId("com.kr.dsh-shell");
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && mainWindow.isMinimized()) mainWindow.restore();
    showMainWindow();
  });
  runApp();
}

// ---------- 托盘图标（跟随系统深浅色主题） ----------
// 深色任务栏 -> 亮色图标；浅色任务栏 -> 深色图标
const TRAY_ICON_LIGHT = path.join(__dirname, "assets", "tray-light.png");
const TRAY_ICON_DARK = path.join(__dirname, "assets", "tray-dark.png");

// 窗口底色跟随系统主题（与 Web UI 的 theme=system 一致；取值对齐 Web UI 的 --dsw-alias-bg-base）
const THEME_BG = { dark: "#151517", light: "#ffffff" };

function themeBg() {
  return nativeTheme.shouldUseDarkColors ? THEME_BG.dark : THEME_BG.light;
}

function pushTheme() {
  mainWindow?.webContents.send("shell:theme", nativeTheme.shouldUseDarkColors ? "dark" : "light");
}

// 右上角窗口控制的 最大化/还原 图标切换：状态变化推送给壳渲染进程
// （iframe 跨源读不到窗口态，只能主进程事件回灌）。
function pushMaximizeState(flag) {
  try { mainWindow?.webContents.send("shell:maximize-state", !!flag); } catch { /* 窗口已销毁 */ }
}

function trayIcon() {
  return nativeTheme.shouldUseDarkColors ? TRAY_ICON_DARK : TRAY_ICON_LIGHT;
}

function updateTrayIcon() {
  if (tray) tray.setImage(nativeImage.createFromPath(trayIcon()));
}

// ---------- 服务探测 ----------
// 返回 { up: bool, needsAuth: bool }
// needsAuth = true 表示服务在跑但返回 401（需要认证 token）
// 带已有 cookie 探测：DSH 认证 cookie 是持久签名（secret 存 credentials，
// 服务重启后依旧有效；默认 cookieMaxAgeDays=30），session 里已有 cookie 即
// 可直接 200 直连——避免「服务明明在跑，壳子冷启动却 killPort3080 重启
// 拿 token」的无谓断服（会话连接会被掐断）。
async function probeService(timeoutMs = 2500) {
  let cookie = '';
  try {
    const cookies = await session.defaultSession.cookies.get({ url: DSH_URL });
    if (cookies.length > 0) cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch { /* session 未就绪（ready 前）：不带 cookie 探测 */ }
  return new Promise((resolve) => {
    const req = http.get(DSH_URL, {
      timeout: timeoutMs,
      headers: cookie ? { Cookie: cookie } : undefined,
    }, (res) => {
      res.resume();
      resolve({ up: res.statusCode === 200 || res.statusCode === 401, needsAuth: res.statusCode === 401 });
    });
    req.on("error", () => resolve({ up: false, needsAuth: false }));
    req.on("timeout", () => { req.destroy(); resolve({ up: false, needsAuth: false }); });
  });
}

// ---------- Auth token 解析 ----------
// DSH 启动时会打印: dsh web: http://127.0.0.1:3080/?token=xxx
let dshAuthToken = "";  // 当前进程的 auth token
const TOKEN_PATTERN = /dsh web: https?:\/\/127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9_-]+)/u;

let loadedWithToken = false;
let authHooked = false;
// auth 握手完成标记：establishAuth 成功（cookie 已注入 + 请求头 hook 已装）后置 true。
// ensureService 靠它判断「页面可安全加载」——token 到手不等于能直接用：SameSite=Strict
// cookie 在 file:// 跨站 iframe 里不携带，必须等主进程握手完成，页面后续 /api 才不会 401。
let authEstablished = false;
let authEstablishing = null; // 进行中的 establishAuth Promise
// SameSite=Strict 的认证 cookie 在 file:// 顶层的 iframe（跨站上下文）里不会被
// 携带——仅靠页面带 token 导航，随后的 GET / 依旧 401。这里由主进程自己完成
// token 握手，把 cookie 写进 session，并直接为发往 dsh 的请求注入 Cookie 头。
async function establishAuth() {
  try {
    const res = await fetch(dshAuthUrl(), { redirect: "manual" });
    const raw = (res.headers.getSetCookie ? res.headers.getSetCookie()[0] : res.headers.get("set-cookie")) || "";
    const pair = raw.split(";")[0].trim();
    if (!pair.includes("=")) throw new Error("set-cookie 缺失");
    const eq = pair.indexOf("=");
    // cookie 有效期与服务端签名 cookie 对齐：优先取服务端 set-cookie 的
    // Max-Age（DSH 默认 cookieMaxAgeDays=30），取不到回退 30 天兜底。
    const maxAgeMatch = /(?:^|;\s*)Max-Age=(\d+)/i.exec(raw);
    const maxAgeSeconds = maxAgeMatch ? Number(maxAgeMatch[1]) : 30 * 24 * 3600;
    const safeMaxAgeSeconds = Number.isFinite(maxAgeSeconds) && maxAgeSeconds > 0 ? maxAgeSeconds : 30 * 24 * 3600;
    await session.defaultSession.cookies.set({
      url: DSH_URL + "/",
      name: pair.slice(0, eq),
      value: pair.slice(eq + 1),
      expirationDate: Math.floor(Date.now() / 1000) + safeMaxAgeSeconds,
    });
    injectedCookiePair = pair;
    installCookieHook();
    logLine("[shell] auth cookie 已注入 session（Cookie 头注入已启用）");
    return true;
  } catch (e) {
    logLine(`[shell] auth cookie 注入失败: ${e && e.message}`);
    return false;
  }
}

// 发往 dsh 的请求要带的 Cookie（hook 闭包读这个变量，保证永远用最新的值）：
// SameSite=Strict cookie 在 file:// 跨站 iframe 里不会被 Chromium 自动携带，
// 所以主进程用 onBeforeSendHeaders 手动注入。来源有二：token 握手新铸的（establishAuth）
// 或 session 里已存且刚被 probe 验证有效的（暖重连，无需任何 token）。
let injectedCookiePair = "";
function installCookieHook() {
  if (authHooked || !injectedCookiePair) return;
  authHooked = true;
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [DSH_URL + "/*", DSH_URL.replace(/^http/, "ws") + "/*"] },
    (details, callback) => {
      if (injectedCookiePair) details.requestHeaders["Cookie"] = injectedCookiePair;
      callback({ requestHeaders: details.requestHeaders });
    }
  );
}
// 暖重连认证：服务活着、没有新 token 可握时，用 session 里已存的 cookie 装钩子。
// probe 刚用同样的 cookie 拿到 200，所以它一定有效；cookie 签名 secret 持久，
// 跨服务重启也有效——token 只是 bootstrap，有 cookie 就不再需要 token。
// 修的是“退出壳子（服务保留）再打开报 authentication required 且永远不恢复”。
async function installCookieHookFromSession() {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: DSH_URL });
    if (cookies.length === 0) return false;
    injectedCookiePair = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    installCookieHook();
    authEstablished = true;
    logLine("[shell] 暖重连：已用存量 cookie 装好请求头注入，无需 token");
    return true;
  } catch (e) {
    logLine(`[shell] 暖重连装钩子失败: ${e && e.message}`);
    return false;
  }
}

// ---------- Launch token 自愈（暖重连场景） ----------
// 服务在壳子关闭期间重启过、或壳子比服务晚启动时，暖重连靠存量 cookie 直连，
// dshAuthToken 保持为空 → /auth/launch-token 给 dsh-browser 返回 token:null，
// 插件只能跳过给 AI 浏览器视图种 cookie，访问 DSH 必 401（"authentication
// required; reopen the URL printed by dsh web"）。服务日志（logs/dsh-service-out.log）每次
// 启动都打印 "dsh web: http://127.0.0.1:3080/?token=xxx" 且追加不清空：从尾部
// 收集候选 token 逐个实测握手——死进程的 token 只会 401（无副作用），活进程的
// token 返回 303+set-cookie，首个命中的即当前活进程的 token，收养之。
let tokenRecovery = null;
function recoverLaunchTokenFromLog() {
  if (dshAuthToken) return Promise.resolve(dshAuthToken);
  if (tokenRecovery) return tokenRecovery;
  tokenRecovery = (async () => {
    try {
      const raw = fs.readFileSync(svcOutLogPath(), "utf8");
      const seen = [];
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(TOKEN_PATTERN);
        if (m && !seen.includes(m[1])) seen.push(m[1]);
      }
      for (let i = seen.length - 1; i >= 0; i--) {
        try {
          const u = new URL(DSH_URL + "/");
          u.searchParams.set("token", seen[i]);
          const res = await fetch(u.href, { redirect: "manual", signal: AbortSignal.timeout(2500) });
          const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie()[0] : res.headers.get("set-cookie");
          if (res.status === 303 && setCookie) {
            dshAuthToken = seen[i];
            logLine(`[shell] 暖重连：从服务日志实测恢复 launch token ${dshAuthToken.slice(0, 8)}...（供插件自动认证）`);
            return dshAuthToken;
          }
        } catch { /* 服务瞬时抖动：试上一个候选 */ }
      }
    } catch { /* 日志不可读：放弃恢复，行为同旧版 */ }
    return "";
  })();
  const p = tokenRecovery;
  p.then(() => { if (tokenRecovery === p) tokenRecovery = null; }, () => { if (tokenRecovery === p) tokenRecovery = null; });
  return p;
}

function parseTokenFromLine(line) {
  const m = line.match(TOKEN_PATTERN);
  if (m && m[1] && m[1] !== dshAuthToken) {
    dshAuthToken = m[1];
    logLine(`[shell] 获取到 auth token: ${dshAuthToken.slice(0, 8)}...`);
    // token 要等 Loader 装载完才打印，而服务一探活可用（401 也算 up）就会先加载
    // 页面；首帧因此常见 401。cookie 注入成功后再重载 iframe。
    // 记录 auth 握手 promise，供 ensureService 同步等待。
    // token 握手走调度器：永远用“最新 token”串行只做一次，见 scheduleAuthHandshake。
    scheduleAuthHandshake();
  }
}

let tokenDebounceTimer = null;
let authGeneration = 0;
// token 握手调度：新 token 到达即更新 dshAuthToken；握手永远用“最新 token”且串行只做一次。
// - 空闲时（没在握手、没成功过）→ 立刻握手，冷启动不等人
// - 在途/已成功时又来新 token（服务重启换进程 = 换 token，旧 token 当场失效）→
//   防抖 400ms 后用最新重握，旧 promise 的结果直接丢弃（generation 对不上），
//   避免并发握手互相覆盖 cookie，也避免动画 2s 内连刷页面。
// 背景：token 是单进程有效的 launchToken，cookie secret 才持久。旧版“每个 token 握手
// 一次”在日志整文件重放时会并发几十次 establishAuth；1.1.4 的“一律去重”则拿着第一
// 个（已失效）token 失败后卡死，页面停在 401 报没有 token。两种都错，debounce +
// 最新胜出才对（token 要等 Loader 完全 settle 才打印，首帧 401 常见，握手成功后再
// 重载 iframe；promise 照旧挂 authEstablishing 供 ensureService 等待）。
function scheduleAuthHandshake() {
  const gen = ++authGeneration;
  if (tokenDebounceTimer !== null) {
    clearTimeout(tokenDebounceTimer);
    tokenDebounceTimer = null;
  }
  const run = () => {
    tokenDebounceTimer = null;
    const p = (async () => {
      const ok = await establishAuth();
      if (gen !== authGeneration) return ok; // 已被更新的 token 超前：结果丢弃
      authEstablished = ok;
      if (ok && !loadedWithToken) {
        loadedWithToken = true;
        loadDshFrame();
      }
      return ok;
    })();
    authEstablishing = p;
    p.then(
      () => { if (authEstablishing === p) authEstablishing = null; },
      () => { if (authEstablishing === p) authEstablishing = null; }
    );
  };
  if (!authEstablishing && !authEstablished) run();
  else tokenDebounceTimer = setTimeout(run, 400);
}

// 文件 tail：只读上次之后新增的完整行（半行留到下次），返回新 offset
function tailFileLines(file, offset, onLine) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return offset; }
  if (size < offset) offset = 0; // 被截断/删除重建则从头读
  if (size === offset) return offset;
  const len = Math.min(size - offset, 1024 * 1024); // 单次最多 1MB
  let chunk = "";
  try {
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, buf, 0, len, offset); } finally { fs.closeSync(fd); }
    chunk = buf.toString("utf8");
  } catch { return offset; }
  const end = chunk.lastIndexOf("\n");
  if (end === -1) return offset; // 全是半行，下次再读
  for (const line of chunk.slice(0, end).split(/\r?\n/)) {
    if (line.trim() !== "") { try { onLine(line); } catch { /* 单行失败不影响后续 */ } }
  }
  // offset 按已消费字节推进（截断点在最后一个换行处，其前无残缺多字节字符）
  return offset + Buffer.byteLength(chunk.slice(0, end + 1), "utf8");
}
// 读服务日志增量：镜像到壳控制台 + 解析 auth token（替代原来的 pipe 监听）
function drainServiceLogs() {
  svcOutOff = tailFileLines(svcOutLogPath(), svcOutOff, (line) => {
    console.log("[dsh]", line.trimEnd());
    parseTokenFromLine(line);
  });
  svcErrOff = tailFileLines(svcErrLogPath(), svcErrOff, (line) => console.log("[dsh:err]", line.trimEnd()));
}

// ---------- 孙进程黑窗：不再做任何运行时补丁 ----------
// 历史：此处曾对 DSH 运行时（npm 安装产物）做精确字符串 replace 补丁，向
// dsh-subprocess-local 注入 windowsHide、向 dsh-win32-process 注入 CREATE_NO_WINDOW。
//
// 现已全部移除，原因（逐条经上游纯净包 0.1.7-alpha.2 实测核对）：
//   1. dsh-subprocess-local 的 windowsHide: true 是上游自带（纯净包 L600 即有），
//      那段注入自 0.1.5 起就是 no-op。
//   2. dsh-win32-process 隐藏窗口靠 STARTF_USESHOWWINDOW + SW_HIDE，上游 README 明确
//      声明「不添加 CREATE_NO_WINDOW / CREATE_NEW_CONSOLE」——因为受限令牌下它们会导致
//      DLL 初始化失败。注入它属于与上游设计对抗。
//   3. 改 node_modules 不持久：npm install 一升级即被覆盖，上游改写法则静默不命中，
//      失败还没有告警。这类补丁只会制造「有时生效、有时失效」的偶发故障。
// 官方子进程隐藏语义本身是完备的；壳子不需要替它打补丁。
const DSH_SUBPROC_LOCAL = path.join(dshDir(), "node_modules", "@deepseek-ai", "dsh-subprocess-local", "lib", "index.js");
const DSH_WIN32_PROC = path.join(dshDir(), "node_modules", "@deepseek-ai", "dsh-win32-process", "lib", "index.js");

/**
 * 只做「体检」不做修改：报告上游运行时是否处于官方原样（供诊断用）。
 * 不写文件 —— 写 node_modules 的补丁已证明会随升级失效并制造偶发问题。
 * @returns {{ subprocessLocal: boolean, win32Process: boolean }}
 */
function inspectDshRuntimeWindowHiding() {
  const report = { subprocessLocal: false, win32Process: false };
  try {
    if (fs.existsSync(DSH_SUBPROC_LOCAL)) {
      // 上游自带该隐藏标志即视为健康
      report.subprocessLocal = fs.readFileSync(DSH_SUBPROC_LOCAL, "utf8").includes("windowsHide: true");
    }
  } catch (e) {
    logLine(`[shell] dsh-subprocess-local 体检异常: ${e && e.message}`);
  }
  try {
    if (fs.existsSync(DSH_WIN32_PROC)) {
      const src = fs.readFileSync(DSH_WIN32_PROC, "utf8");
      // 官方原样 = 无 CREATE_NO_WINDOW 注入，且保留 STARTF_USESHOWWINDOW/SW_HIDE
      report.win32Process = !src.includes("134217728");
    }
  } catch (e) {
    logLine(`[shell] dsh-win32-process 体检异常: ${e && e.message}`);
  }
  return report;
}

// ---------- 安全启动（Safe Boot） ----------
// 背景：DSH 启动时会加载 profile 的插件树（bundle patch / cordis.patch.yml）。
// 插件包缺失、patch 写坏、插件激活报错都会让 dsh 进程在启动阶段直接退出；
// 旧版壳子只会干等 120 秒然后报「服务启动超时」，用户完全不知道是哪个插件坏了。
//
// 本机制在启动失败时解析 DSH 的启动诊断（stderr + ~/.dsh/logs/startup-*.log），
// 把出错的插件临时禁用（--patch overlay；必要时从 profile 移除坏 bundle 或注释
// 用户 patch 里的问题条目），然后重启服务；最多重试 SAFE_BOOT_MAX_ROUNDS 轮。
// 所有自动修复都有备份、记录在 userData/safe-boot.json，可在托盘菜单恢复。
//
// 安全边界：
//   - 核心 required 条目（webserver/web-runtime/agent-loop 等）不直接禁用；
//   - 端口占用、权限、磁盘等环境错误不归咎插件；
//   - 每轮只改一个插件，改前备份；无法归因时只报告、不动配置。
const SAFE_BOOT_MAX_ROUNDS = 3;
// 进程退出后等日志落盘再判失败，避免误读空日志
const SAFE_BOOT_EXIT_SETTLE_MS = 1200;

let _safeBootModule = null; // null=未加载, false=加载失败, object=模块
function safeBootModule() {
  if (_safeBootModule === null) {
    try {
      _safeBootModule = require("./safe-boot");
    } catch (e) {
      _safeBootModule = false;
      logLine(`[safe-boot] 模块加载失败: ${(e && e.message) || e}`);
    }
  }
  return _safeBootModule || null;
}
function loadYamlLib() {
  // DSH 运行时自带 yaml（profile patch 自己的解析库），用于校验/恢复 patch 文件。
  // 找不到时 restore-patch-file 会跳过，不影响其他修复动作。
  try { return require(path.join(dshDir(), "node_modules", "yaml")); } catch { /* 无 yaml 库 */ }
  try { return require("yaml"); } catch { return null; }
}
// DSH_HOME 解析：与 dsh 自身一致，环境变量优先（测试隔离/多 profile 场景），否则 ~/.dsh。
// 安全启动改的是「DSH 实际使用的 profile」，不能写死 os.homedir()。
function dshHomeDir() {
  const env = process.env.DSH_HOME;
  if (env && env.trim()) {
    try { return path.resolve(env.trim()); } catch { /* 非法路径回退默认 */ }
  }
  return path.join(os.homedir(), ".dsh");
}
function safeBootCtx() {
  const home = dshHomeDir();
  return {
    profileDir: path.join(home, "profiles", "web"),
    dshHome: home,
    stateDir: userDataDir(),
    logDir: userLogDir(),
    yaml: loadYamlLib(),
  };
}
function safeBootOverlayPath() { return path.join(userDataDir(), "safe-boot.patch.yml"); }
// 生成给 dsh 的 --patch 参数（overlay 只包含被安全启动禁用的条目）
function safeBootArgs() {
  try {
    const p = safeBootOverlayPath();
    if (fs.existsSync(p) && fs.statSync(p).size > 0) return ["--patch", p];
  } catch { /* 读不到按无 overlay 处理 */ }
  return [];
}
function safeBootSnapshot() {
  const sb = safeBootModule();
  if (!sb) return { available: false, state: null, summary: "安全启动模块不可用" };
  try {
    const state = sb.readSafeBootState(safeBootCtx());
    return { available: true, state, summary: sb.describeSafeBootState(state) };
  } catch (e) {
    return { available: false, state: null, summary: String((e && e.message) || e) };
  }
}

// 打开安全启动记录 JSON（托盘菜单）
function openSafeBootRecord() {
  try {
    const p = path.join(userDataDir(), "safe-boot.json");
    if (fs.existsSync(p)) shell.openPath(p);
  } catch { /* 打不开就算了 */ }
}
// 恢复被安全启动关闭的插件并重启（托盘菜单）
function restoreSafeBootAndRestart() {
  const sb = safeBootModule();
  if (!sb) return;
  try {
    const res = sb.clearSafeBootState(safeBootCtx());
    if (!res || !res.ok) {
      logLine(`[safe-boot] 恢复被关闭插件失败: ${(res && res.detail) || "未知原因"}`);
      return;
    }
    logLine("[safe-boot] 已恢复被关闭的插件，重启服务");
    try { tray?.displayBalloon({ title: "DeepSeek Harness", content: "已恢复被关闭的插件，正在重启内核…" }); } catch { /* 托盘通知失败不影响 */ }
    sendRuntimeEvent({ type: "status", percent: 90, text: "正在恢复被关闭的插件并重启内核…", ticker: "" });
    restartService();
  } catch (e) {
    logLine(`[safe-boot] 恢复异常: ${(e && e.message) || e}`);
  }
}

// 启动一次 dsh 服务（不含等待）。返回本次启动的日志偏移与进程句柄。
let dshExitInfo = null;
function startDshServiceOnce() {
  try { if (dshOutFd !== null) fs.closeSync(dshOutFd); } catch { /* 已关 */ }
  try { if (dshErrFd !== null) fs.closeSync(dshErrFd); } catch { /* 已关 */ }
  const svcOut = svcOutLogPath();
  const svcErr = svcErrLogPath();
  try { fs.mkdirSync(userLogDir(), { recursive: true }); } catch { /* 只读目录：下面 try 兜底 */ }
  try { dshOutFd = fs.openSync(svcOut, "a"); } catch (e) { logLine(`[shell] 打开服务 stdout 日志失败: ${e && e.message}`); }
  try { dshErrFd = fs.openSync(svcErr, "a"); } catch (e) { logLine(`[shell] 打开服务 stderr 日志失败: ${e && e.message}`); }
  const attempt = { startedAt: Date.now(), outStart: 0, errStart: 0, spawnError: null };
  try { attempt.outStart = fs.statSync(svcOut).size; } catch { attempt.outStart = 0; }
  try { attempt.errStart = fs.statSync(svcErr).size; } catch { attempt.errStart = 0; }
  svcOutOff = attempt.outStart;
  svcErrOff = attempt.errStart;
  const nodeExe = findNode() || "node";
  const args = [dshBin(), "web", ...safeBootArgs(), ...(DSH_PORT === 3080 ? [] : ["--port", String(DSH_PORT)]), "--no-open"];
  console.log(`[shell] spawn dsh 服务: node=${nodeExe} bin=${dshBin()} args=${args.slice(1).join(" ")}`);
  dshExitInfo = null;
  try {
    dshProc = spawn(nodeExe, args, {
      cwd: dshDir(),
      windowsHide: true,
      detached: true,
      stdio: ["ignore", dshOutFd ?? "ignore", dshErrFd ?? "ignore"],
      env: { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: "0" },
    });
  } catch (e) {
    attempt.spawnError = e;
    dshProc = null;
    return attempt;
  }
  dshProc.unref();
  const proc = dshProc;
  proc.on("exit", (code, signal) => {
    console.log(`[dsh] 进程退出 code=${code} signal=${signal}`);
    dshExitInfo = { code, signal, at: Date.now() };
    if (dshProc === proc) dshProc = null;
  });
  drainServiceLogs(); // 启动瞬间已有输出时立刻读一次，token 不用等下个轮询
  return attempt;
}

// 等一次启动就绪：沿用原 ensureService 的「HTTP 可连 + auth 握手」判定；
// 额外在 dsh 进程提前退出时立即返回失败（不再空等 120 秒）。
async function waitDshServiceReady(attempt) {
  const start = Date.now();
  let upSince = 0;
  while (Date.now() - start < DSH_POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, DSH_POLL_MS));
    drainServiceLogs();
    const p = await probeService();
    if (p.up) {
      if (upSince === 0) upSince = Date.now();
      const authWaitMs = Date.now() - upSince;
      const authReady = authEstablished || Boolean(dshAuthToken && loadedWithToken);
      const isSettle = dshProc ? (authReady || authWaitMs > 20000) : (!p.needsAuth || authReady || authWaitMs > 20000);
      if (isSettle) return { ok: true };
      if (authEstablishing) { try { await authEstablishing; } catch { /* 20s 上限兜底 */ } }
    } else {
      upSince = 0;
      if (attempt.spawnError) return { ok: false, reason: "spawn-error", error: String((attempt.spawnError && attempt.spawnError.message) || attempt.spawnError) };
      if (!dshProc && dshExitInfo && Date.now() - dshExitInfo.at > SAFE_BOOT_EXIT_SETTLE_MS) {
        await new Promise((r) => setTimeout(r, 350)); // 给 stdout/stderr 落盘留一点时间
        drainServiceLogs();
        return { ok: false, reason: "exit", exitCode: dshExitInfo.code, signal: dshExitInfo.signal };
      }
    }
  }
  return { ok: false, reason: "timeout" };
}

// 读取本次启动新增的日志文本（只读增量，避免把历史启动的错误当成本次错误）
function readLogFrom(file, offset) {
  try {
    const buf = fs.readFileSync(file);
    return buf.subarray(Math.min(Math.max(0, offset), buf.length)).toString("utf8");
  } catch { return ""; }
}
function findLatestStartupLog(sinceMs) {
  try {
    const dir = path.join(dshHomeDir(), "logs");
    const names = fs.readdirSync(dir).filter((n) => /^startup-.*\.log$/.test(n));
    let best = null;
    for (const n of names) {
      try {
        const fp = path.join(dir, n);
        const st = fs.statSync(fp);
        if (st.mtimeMs >= sinceMs - 2000 && (!best || st.mtimeMs > best.t)) best = { path: fp, t: st.mtimeMs };
      } catch { /* 跳过 */ }
    }
    if (best) return { path: best.path, text: fs.readFileSync(best.path, "utf8") };
  } catch { /* 日志目录不存在 */ }
  return null;
}
function collectStartupEvidence(attempt, waitRes) {
  const startupLog = findLatestStartupLog(attempt.startedAt);
  return {
    stderrText: readLogFrom(svcErrLogPath(), attempt.errStart),
    stdoutText: readLogFrom(svcOutLogPath(), attempt.outStart),
    startupLogText: startupLog ? startupLog.text : "",
    startupLogPath: startupLog ? startupLog.path : null,
    exitCode: waitRes.exitCode,
    timedOut: waitRes.reason === "timeout",
  };
}
function describeSafeBootPlan(plan) {
  if (!plan) return "未知修复";
  switch (plan.action) {
    case "disable-entry": return `插件 ${plan.id || plan.module || ""}`;
    case "remove-bundle": return `插件包 ${plan.name || ""}`;
    case "comment-patch-entry": return `插件配置 ${plan.id || ""}`;
    case "restore-patch-file": return `插件配置文件 ${path.basename(plan.file || "")}`;
    default: return String(plan.action);
  }
}

let ensureServicePromise = null;
function ensureService() {
  if (ensureServicePromise) return ensureServicePromise;
  ensureServicePromise = ensureServiceImpl()
    .catch((e) => {
      // 安全启动链路自身异常不能把主进程 whenReady 回调打崩：降级为启动失败 + 明确日志
      const msg = String((e && e.message) || e);
      logLine(`[safe-boot] 启动链路异常: ${msg}`);
      sendRuntimeEvent({ type: "error", code: "startup-chain-error", text: "本地内核启动流程异常", hint: msg, actions: ["retry", "log"] });
      return false;
    })
    .finally(() => { ensureServicePromise = null; });
  return ensureServicePromise;
}

async function ensureServiceImpl() {
  // 日志游标先定位到文件末尾：连的是已在跑的服务（下面直接 return，不走 spawn）时，
  // 看门狗整文件重放会把历史 token 当新的逐个握手——全是已死进程的 token，set-cookie
  // 缺失刷屏不说，还会污染 dshAuthToken。只消费本次启动后的新增行。
  try { svcOutOff = fs.statSync(svcOutLogPath()).size; } catch { svcOutOff = 0; }
  try { svcErrOff = fs.statSync(svcErrLogPath()).size; } catch { svcErrOff = 0; }
  const probe = await probeService();
  if (probe.up && !probe.needsAuth) {
    // 服务在跑且不需要认证（已有 cookie 或无 auth），直接连接。
    // 注意：探针 200 不等于 iframe 能进——Strict cookie 在 file:// 跨站 iframe 里
    // 不会被 Chromium 自动携带。暖重连（服务是上次退出时保留的）没有任何新 token，
    // 必须用存量 cookie 把请求头钩子装好，否则 iframe 裸奔拿 401 且永远不恢复。
    console.log("[shell] dsh 服务已在运行，直接连接");
    await installCookieHookFromSession();
    // 暖重连恢复 launch token：必须 await 恢复完成，确保下发的 URL 携带 token
    await recoverLaunchTokenFromLog();
    serviceReady = true;
    return true;
  }
  if (probe.up && probe.needsAuth && !dshAuthToken) {
    // 服务在跑但需要认证，而我们没有 token（外部启动的服务）
    // 先试着从服务日志实测恢复 token——命中就不用断服重启：
    const recovered = await recoverLaunchTokenFromLog();
    if (recovered) {
      scheduleAuthHandshake();
      if (authEstablishing) { try { await authEstablishing; } catch { /* 20s 上限兜底 */ } }
      const recheck = await probeService();
      if (recheck.up && !recheck.needsAuth) {
        console.log("[shell] 外部启动的 dsh 服务已用日志恢复的 token 完成认证，无需重启");
        serviceReady = true;
        return true;
      }
    }
    // 恢复失败才走重启服务拿 token 的老路
    console.log("[shell] 检测到外部启动的 dsh 服务，需要重启以获取 auth token...");
    killPort3080();
    // 等待端口释放
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("[shell] 启动 dsh 服务...");
  // 安全启动：每轮尝试启动 → 失败则诊断并自动关闭可疑插件 → 再试。
  // 正常路径行为不变（首轮成功直接返回）；只有失败才进入修复循环。
  const sb = safeBootModule();
  const sbCtx = safeBootCtx();
  let sbState = null;
  if (sb) {
    try {
      sbState = sb.readSafeBootState(sbCtx);
      sb.syncSafeBootOverlay(sbCtx, sbState);
      if (sbState && (sbState.disabled.length || sbState.bundles.length || sbState.patchEdits.length)) {
        logLine(`[safe-boot] 已加载安全启动记录：${sb.describeSafeBootState(sbState)}`);
      }
    } catch (e) {
      logLine(`[safe-boot] 初始化失败: ${(e && e.message) || e}`);
    }
  }
  let sbRounds = 0;
  let lastDiagnosis = null;
  let lastWait = null;
  let lastAttempt = null;
  let lastOneLine = "";
  while (true) {
    lastAttempt = startDshServiceOnce();
    lastWait = await waitDshServiceReady(lastAttempt);
    if (lastWait.ok) {
      serviceReady = true;
      if (sbState && (sbState.disabled.length || sbState.bundles.length || sbState.patchEdits.length)) {
        try {
          const desc = sb.describeSafeBootState(sbState);
          logLine(`[safe-boot] 服务已通过安全启动恢复：${desc}`);
          // 开屏 note 会随进入主界面消失，再补一条托盘气泡，确保用户知道发生过自动修复
          try { tray?.displayBalloon({ title: "DeepSeek Harness 安全启动", content: desc.split("\n")[0] }); } catch { /* 气泡失败不影响启动 */ }
          sendRuntimeEvent({
            type: "warn", code: "safe-boot",
            text: "已自动关闭导致启动失败的插件，服务已恢复",
            hint: `${desc}\n如插件已修复，可在托盘菜单「恢复被关闭的插件并重启」重新启用。`,
            actions: ["log"],
          });
        } catch { /* 提示失败不影响启动 */ }
      }
      return true;
    }
    // —— 启动失败：收集本次启动的日志证据并归因 ——
    const evidence = collectStartupEvidence(lastAttempt, lastWait);
    let diagnosis = null;
    if (sb) {
      try { diagnosis = sb.parseStartupFailure(evidence); } catch (e) { logLine(`[safe-boot] 解析启动失败信息异常: ${(e && e.message) || e}`); }
    }
    lastDiagnosis = diagnosis;
    const oneLine = (diagnosis && diagnosis.summary
      ? diagnosis.summary
      : (lastWait.reason === "spawn-error" ? `无法启动 dsh 进程: ${lastWait.error}`
        : lastWait.reason === "timeout" ? "服务 120 秒内未就绪"
        : `dsh 进程退出（code=${lastWait.exitCode ?? "?"}）`)).split("\n")[0];
    lastOneLine = oneLine;
    logLine(`[safe-boot] 启动失败（${lastWait.reason}）：${oneLine}`);
    if (lastWait.reason === "timeout" && (!diagnosis || diagnosis.kind === "unknown" || diagnosis.kind === "timeout")) {
      // 没有任何可归因的插件错误：保持原有超时提示，不瞎改配置
      killDsh();
      killPort3080();
      sendRuntimeEvent({
        type: "error", code: "service-timeout",
        text: "本地内核服务启动超时",
        hint: "服务 120 秒内未就绪。可点「重试」重启服务，或「查看日志」定位。",
        actions: ["retry", "log"],
      });
      return false;
    }
    // 规划修复动作（按优先级）：没有可修项或已达轮次上限则停止
    let plans = [];
    if (sb && diagnosis) {
      try { plans = sb.planSafeBootFixes(diagnosis, sbCtx) || []; } catch (e) { logLine(`[safe-boot] 生成修复计划异常: ${(e && e.message) || e}`); }
    }
    if (!plans.length || sbRounds >= SAFE_BOOT_MAX_ROUNDS) break;
    const plan = plans[0];
    sbRounds += 1;
    sendRuntimeEvent({
      type: "status", percent: 90,
      text: `检测到插件启动失败，正在安全启动（${sbRounds}/${SAFE_BOOT_MAX_ROUNDS}）：${describeSafeBootPlan(plan)}…`,
      ticker: oneLine,
    });
    let applied = null;
    try { applied = sb.applySafeBootFix(sbCtx, sbState, plan); } catch (e) { applied = { ok: false, detail: String((e && e.message) || e) }; }
    if (!applied || !applied.ok) {
      logLine(`[safe-boot] 修复动作未生效：${(applied && applied.detail) || "未知原因"}`);
      break;
    }
    sbState = applied.state;
    logLine(`[safe-boot] 第 ${sbRounds} 轮已关闭插件：${describeSafeBootPlan(plan)}（${applied.detail || ""}）`);
    // 重启前清干净旧进程与端口，避免下一轮探测到半启动状态
    killDsh();
    killPort3080();
    await new Promise((r) => setTimeout(r, 1200));
  }
  // —— 无法自动恢复：把真实原因交给开屏界面（不再是笼统的“启动超时”）——
  killDsh();
  killPort3080();
  const summary = lastDiagnosis && lastDiagnosis.summary ? lastDiagnosis.summary : lastOneLine;
  sendRuntimeEvent({
    type: "error", code: "plugin-startup-failed",
    text: summary.split("\n")[0] || "插件导致服务启动失败",
    hint: `${summary}${sbRounds ? `\n\n已自动尝试关闭 ${sbRounds} 个插件，仍未恢复。` : ""}\n完整诊断见服务日志与 %USERPROFILE%\\.dsh\\logs\\startup-*.log；可点「重试」或「查看日志」。`,
    actions: ["retry", "log"],
  });
  return false;
}

// ---------- 服务重启看门狗：服务 可用→掉线→恢复 = 一次重启，自动刷新页面 ----------
// 只重载 iframe（顶栏/托盘不动），避免手动 F5；防抖防止连续重启刷屏。
//
// 清缓存重载（opts.clearCache）为什么沿调用链显式传参、而不用模块级「待生效标记」：
// restartService 打完标记后要经过 1.2s 定时器 + 拉起服务（数秒到数十秒）才重载，
// 这段窗口里服务重启看门狗自己也会触发 reloadPage（它探到 up 状态翻转就刷页面）。
// 若用全局标记，会被看门狗那次**普通**重载抢先消耗掉，等真正该带 _r 的那次反而不带，
// 清缓存就静默失效了。显式传参让「谁发起的重载」与「带不带 _r」始终一一对应。
function reloadPage(opts) {
  lastReloadAt = Date.now();
  loadDshFrame(false, opts);
}

function startServiceWatchdog() {
  setInterval(async () => {
    drainServiceLogs(); // 启动期之后打印的 token 也能捡到（auth 超时兜底的前置）
    const probe = await probeService();
    const up = probe.up;
    if (up && probe.needsAuth && dshAuthToken && !loadedWithToken) {
      // 兜底：页面还停在 401 而 token 已到手（如行缓冲/时序遗漏），补一次带 token 加载
      loadedWithToken = true;
      loadDshFrame();
    }
    // auth 兜底：token 已到手但握手失败（establishAuth 异常/cookie 注入失败），
    // 定期重试，让页面 /api 不再 401（否则即使页面能加载，点任何操作都无效）。
    if (up && probe.needsAuth && dshAuthToken && !authEstablished && !authEstablishing) {
      console.log("[shell] auth 未就绪，看门狗重试 auth 握手");
      authEstablishing = (async () => {
        try {
          authEstablished = await establishAuth();
        } finally {
          authEstablishing = null;
        }
      })();
    }
    if (up && !svcUp && svcEverUp && Date.now() - lastReloadAt > RELOAD_COOLDOWN_MS) {
      console.log("[shell] 检测到 dsh 服务重启，自动刷新页面");
      reloadPage();
    }
    if (up) svcEverUp = true;
    svcUp = up;
  }, DSH_POLL_MS);
}

// ---------- 桌面通知浮窗（任务完成提醒） ----------
// 为什么不用系统通知：Windows 的通知会被「通知总开关关闭 / 专注助手全局静音」
// 静默吞掉——实测 ToastEnabled=0 时 `new Notification()` 不报错、onshow 也照常
// 触发，但屏幕上什么都没有，用户与开发者都拿不到任何线索。桌面浮窗是壳子自己的
// 窗口，不受这些系统设置影响，且能做得和插件页内卡一样带动效。
//
// 形态：无边框 + 整窗透明 + 置顶 + 不进任务栏 + 不抢焦点，贴在**工作区右下角**
// （用 workArea 而不是 bounds，避免压在任务栏下面）。同一时刻只保留一个窗口，
// 连续完成时复用并重播动画，不堆一屏。
// 窗口尺寸含**两侧的阴影留白**（TOAST_PAD）：透明窗口会把超出边界的阴影
// 直接裁掉，留白不够时卡片四周会出现一圈硬边灰框——那正是「卡片显脏」的来源。
// 卡片本体宽 = TOAST_W - TOAST_PAD * 2 = 368，对齐 Windows 11 Fluent Toast。
// 这圈透明边同时也是卡片与屏幕边缘的**视觉间距**：窗口贴住工作区右下角，
// 卡片自然离边 TOAST_PAD。别再额外加 margin，否则卡片会浮得离边太远。
// ⚠ TOAST_PAD 必须与 toast.html 里 #stage 的 margin 一致，改一处就要改另一处。
const TOAST_PAD = 16;           // 卡片四周给阴影留的透明边
const TOAST_CARD_W = 368;       // 卡片本体宽（对齐 Windows 11 Fluent Toast）
const TOAST_W = TOAST_CARD_W + TOAST_PAD * 2;
const TOAST_MIN_H = 96;         // 兜底高度（渲染侧回报前的首帧）
let toastWindow = null;
let toastReady = false;         // 渲染侧是否已就绪（就绪前发的通知先排队）
let toastQueue = null;          // 只留最新一条：完成提醒是有时效的，旧的不补发
let toastH = TOAST_MIN_H;
let lastToastDedup = { key: "", time: 0 };
/** 窗口已在渲染但还没显示：等渲染侧回报内容高度后再 reveal（避免先矮后高的跳变）。 */
let toastRevealPending = false;
let toastRevealTimer = null;

/** 屏幕工作区右下角坐标（多显示器时用主屏；workArea 已扣掉任务栏）。 */
function toastAnchor() {
  const { screen } = require("electron");
  let area;
  try {
    area = screen.getPrimaryDisplay().workArea;
  } catch {
    area = { x: 0, y: 0, width: 2560, height: 1440 };
  }
  // 窗口直接贴住工作区右下角：卡片与屏幕边缘的间距就是窗口里的 TOAST_PAD，
  // 这圈透明区同时充当阴影的落点（窗口边界外的阴影会被裁掉）。
  return {
    x: Math.round(area.x + area.width - TOAST_W),
    y: Math.round(area.y + area.height - toastH),
  };
}

/** 把浮窗摆到右下角（尺寸变化后也要重摆：高度是贴内容变的）。 */
function placeToast() {
  if (!toastWindow || toastWindow.isDestroyed()) return;
  const { x, y } = toastAnchor();
  try { toastWindow.setBounds({ x, y, width: TOAST_W, height: toastH }); } catch { /* 摆位失败不影响内容 */ }
}

function createToastWindow() {
  if (toastWindow && !toastWindow.isDestroyed()) return toastWindow;
  toastH = TOAST_MIN_H;
  const { x, y } = toastAnchor();
  toastWindow = new BrowserWindow({
    x, y,
    width: TOAST_W,
    height: TOAST_MIN_H,
    frame: false,
    transparent: true,          // 整窗透明：只看得见卡片本身
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,          // 不进任务栏
    alwaysOnTop: true,          // 浮在其它窗口之上
    focusable: false,           // 不抢焦点（打字时弹出来不会打断输入）
    show: false,
    hasShadow: false,           // 阴影由 CSS 画，避免系统阴影在透明窗上发虚
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "toast-preload.js"),
      // 窗口先是隐藏着渲染、量完高度才 show，而 Chromium 会**暂停隐藏窗口的
      // requestAnimationFrame**——渲染侧的尺寸回报就卡着不发，窗口只能等
      // 260ms 兜底才露面（还会错过入场动画的开头）。关掉节流让隐藏态照常跑。
      backgroundThrottling: false,
    },
  });
  // 置顶层级：screen-saver 之下、普通窗口之上，避免盖住开始菜单/锁屏
  try { toastWindow.setAlwaysOnTop(true, "floating"); } catch { /* 部分平台不支持层级参数 */ }
  try { toastWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false }); } catch { /* 忽略 */ }
  toastWindow.loadFile("toast.html");
  toastWindow.on("closed", () => {
    toastWindow = null;
    toastReady = false;
    toastRevealPending = false;
    if (toastRevealTimer !== null) { clearTimeout(toastRevealTimer); toastRevealTimer = null; }
  });
  return toastWindow;
}

/**
 * 把窗口显示出来（不抢焦点）。
 *
 * `showInactive` 不抢焦点；但它在「窗口此前是隐藏状态」或 `focusable:false`
 * 时，Windows 上偶发不生效（窗口 isVisible() 仍为 false）。所以补一次 show()
 * 兜底，并**重新置顶**——浮窗的意义就是在别的应用前面。
 */
function revealToastWindow(win) {
  try { win.showInactive(); } catch { /* 忽略 */ }
  try {
    if (!win.isVisible()) win.show();
  } catch { /* 忽略 */ }
  try { win.setAlwaysOnTop(true, "floating"); } catch { /* 忽略 */ }
  try { win.moveTop(); } catch { /* 部分平台无此方法 */ }
}

/** 真正把一条通知推给浮窗（渲染侧已就绪时调用）。 */
function toastDeliver(payload) {
  const win = createToastWindow();
  // ⚠ 只有窗口还藏着时才把高度压回兜底值：已可见时重置会让窗口先缩一下再
  // 被渲染侧的长度撑回来（明显的上下抖动）。可见时直接用旧尺寸，等 resize 微调。
  if (!win.isVisible()) {
    toastH = TOAST_MIN_H;
    placeToast();
  }
  const send = () => {
    if (win.isDestroyed()) return;
    // 先量高度再显示：窗口初始是 TOAST_MIN_H，直接 show 会看到卡片先冒一个
    // 矮框、下一帧再窜到实际高度（明显的跳一下）。所以隐藏态下等渲染侧回
    // 报 resize 后再 reveal；已可见（连续完成复用窗口）就直接更新。
    const wasVisible = win.isVisible();
    toastRevealPending = !wasVisible;
    try { win.webContents.send("dsh-toast:show", payload); } catch { /* 窗口销毁：忽略 */ }
    if (wasVisible) revealToastWindow(win);
    else scheduleToastRevealFallback(win);
  };
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", send);
  } else {
    send();
  }
}

/**
 * 显示兜底：渲染侧若没回报尺寸（脚本报错等异常），浮窗不能一直藏着。
 * 正常路径是 resize 回调里 reveal（见下面 ipcMain.on("dsh-toast:resize")）。
 *
 * ⚠ 兜底时间不能压得太短：渲染侧是同步量高的，正常情况几十毫秒内就到；
 * 但冷启动（首次建窗 + 首帧布局）可能要 100ms 以上，留 180ms 既不误报也不卡。
 */
function scheduleToastRevealFallback(win) {
  if (toastRevealTimer !== null) clearTimeout(toastRevealTimer);
  toastRevealTimer = setTimeout(() => {
    toastRevealTimer = null;
    if (!toastRevealPending) return;
    toastRevealPending = false;
    if (win.isDestroyed()) return;
    revealToastWindow(win);
  }, 180);
}

/**
 * 桌面浮窗：显示一条任务完成提醒。
 * @param {{title?:string,text?:string,meta?:string,kind?:string,sessionId?:string}} payload
 * @returns {boolean} 是否已受理（窗口能建起来就算受理）。
 */
function dshToastShow(payload) {
  try {
    if (quitting) return false;
    const now = Date.now();
    const dedupKey = `${payload?.sessionId || ""}:${payload?.title || ""}:${payload?.text || ""}`;
    if (dedupKey && dedupKey === lastToastDedup.key && (now - lastToastDedup.time < 5000)) {
      logLine(`[shell] 桌面浮窗去重：跳过 5 秒内完全相同的提醒 (${dedupKey})`);
      return true;
    }
    lastToastDedup = { key: dedupKey, time: now };
    const data = {
      title: String(payload?.title ?? "任务完成"),
      text: String(payload?.text ?? ""),
      meta: String(payload?.meta ?? ""),
      kind: payload?.kind === "error" ? "error" : "done",
      sessionId: typeof payload?.sessionId === "string" ? payload.sessionId : "",
      theme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
    };
    if (!toastReady) {
      // 渲染侧还没就绪：只留最新一条（完成提醒有时效，旧的不补发）
      toastQueue = data;
      createToastWindow();
      return true;
    }
    toastDeliver(data);
    return true;
  } catch (e) {
    logLine(`[shell] 桌面浮窗失败: ${e && e.message}`);
    return false;
  }
}

/** 浮窗内部隐藏（退场动画播完后调用）。 */
function dshToastHide() {
  toastRevealPending = false;
  if (toastRevealTimer !== null) { clearTimeout(toastRevealTimer); toastRevealTimer = null; }
  if (!toastWindow || toastWindow.isDestroyed()) return;
  try { toastWindow.hide(); } catch { /* 忽略 */ }
}

/** 浮窗点击：唤起主窗并跳进对应会话（跳转交给 WebUI 侧的插件处理）。 */
function dshToastClick(sessionId) {
  showMainWindow();
  const sid = typeof sessionId === "string" ? sessionId : "";
  if (sid === "") return;
  // 壳页面收到后把会话 id 交给 WebUI（壳页面里的 __dshNotify 已能跳转）
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("shell:open-session", sid);
    }
  } catch { /* 主窗不可用：至少已经唤起窗口 */ }
}

ipcMain.on("dsh-toast:ready", () => {
  toastReady = true;
  const queued = toastQueue;
  toastQueue = null;
  if (queued) toastDeliver(queued);
});
ipcMain.on("dsh-toast:resize", (_e, height) => {
  const h = Number(height);
  if (!Number.isFinite(h) || h <= 0) return;
  // 上限放到 520：卡片最高是「两行摘要 + 引注 + 顶栏」，420 会把长内容卡在
  // 窗口外（多出的部分被窗口边界裁掉，看起来像文字被切了一半）。
  toastH = Math.max(TOAST_MIN_H, Math.min(520, Math.round(h)));
  placeToast();
  // 渲染侧已量好高度：现在才让窗口露面（见 toastDeliver 的说明）。
  if (toastRevealPending && toastWindow && !toastWindow.isDestroyed()) {
    toastRevealPending = false;
    if (toastRevealTimer !== null) { clearTimeout(toastRevealTimer); toastRevealTimer = null; }
    revealToastWindow(toastWindow);
  }
});
ipcMain.on("dsh-toast:dismiss", () => dshToastHide());
ipcMain.on("dsh-toast:click", (_e, sessionId) => dshToastClick(sessionId));

// ---------- 设置持久化与窗口尺寸记忆 ----------
function settingsFile() {
  try { return path.join(app.getPath("userData"), "settings.json"); }
  catch { return path.join(__dirname, "settings.json"); }
}
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), "utf8")); }
  catch { return {}; }
}
function saveSettings(s) {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); }
  catch (e) { logLine(`[shell] 设置保存失败: ${e && e.message}`); }
}

let saveBoundsTimer = null;
function persistWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized() || mainWindow.isMinimized() || mainWindow.isFullScreen()) return;
  try {
    const bounds = mainWindow.getBounds();
    if (bounds && bounds.width >= 960 && bounds.height >= 600) {
      const s = loadSettings();
      saveSettings({
        ...s,
        windowBounds: {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        },
      });
    }
  } catch { /* 忽略保存异常 */ }
}

function scheduleSaveWindowBounds() {
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(persistWindowBounds, 250);
}

// ---------- 窗口 ----------
function createWindow() {
  const { screen } = require("electron");
  const s = loadSettings();
  const savedBounds = s.windowBounds;

  let width = 1200;
  let height = 780;
  let posX = undefined;
  let posY = undefined;

  if (savedBounds && typeof savedBounds.width === "number" && typeof savedBounds.height === "number") {
    width = Math.max(960, Math.round(savedBounds.width));
    height = Math.max(600, Math.round(savedBounds.height));
    if (typeof savedBounds.x === "number" && typeof savedBounds.y === "number") {
      try {
        const matchedDisplay = screen.getDisplayMatching({
          x: savedBounds.x,
          y: savedBounds.y,
          width,
          height,
        });
        if (matchedDisplay && matchedDisplay.workArea) {
          const wa = matchedDisplay.workArea;
          if (
            savedBounds.x + width > wa.x + 100 &&
            savedBounds.x < wa.x + wa.width - 100 &&
            savedBounds.y + height > wa.y + 100 &&
            savedBounds.y < wa.y + wa.height - 100
          ) {
            posX = Math.round(savedBounds.x);
            posY = Math.round(savedBounds.y);
          }
        }
      } catch { /* 获取显示器失败回退居中 */ }
    }
  }

  const winOpts = {
    width,
    height,
    minWidth: 960,
    minHeight: 600,
    frame: false,          // 无边框：无系统标题栏
    icon: path.join(__dirname, "assets", "app-icon.png"), // 任务栏图标
    show: false,
    backgroundColor: themeBg(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
      // 关掉后台节流：主窗被最小化 / 隐藏到托盘 / 被其它窗口遮挡时，Chromium 默认
      // 会冻结 rAF、把定时器压到 1 次/分钟甚至停掉。而完成提醒（桌面浮窗 + 音效）
      // 依赖 WebUI 里的轮询持续跑——被节流就等于「只有在前台才提醒」，那正是用户
      // 报的问题。与 bvCreateView（AI 浏览器视图）同款处理，理由也一样。
      backgroundThrottling: false,
    },
  };
  if (typeof posX === "number" && typeof posY === "number") {
    winOpts.x = posX;
    winOpts.y = posY;
  } else {
    winOpts.center = true;
  }

  mainWindow = new BrowserWindow(winOpts);

  mainWindow.loadFile("topbar.html");
  // 登录自启（--hidden / wasOpenedAtLogin）则初始藏托盘，服务照常后台拉起，用户点托盘再显示
  const hiddenAtBoot = startedHidden();
  if (hiddenAtBoot) {
    logLine("[shell] 登录自启：窗口初始隐藏到托盘");
  } else {
    mainWindow.once("ready-to-show", () => {
      mainWindow.show();
      mainWindow.focus();
    });
    // 兜底：如果 ready-to-show 因资源加载延迟未能触发，1 秒后强制显示窗口
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        mainWindow.show();
        mainWindow.focus();
      }
    }, 1000);
  }
  // ---------- 左上角窗口控制按钮：指针移到该角落才淡入 ----------
  // WebUI 跑在跨源 iframe 里，壳页面收不到它的 mousemove，只能由主进程轮询 OS 光标。
  // 判定矩形就是按钮组本身（左上角 82×26），一离开立即隐藏 —— 这样它永远挡不住
  // WebUI 侧边栏顶部的「新建会话」按钮（那个从 y=24 起）。
  // 判定区域要覆盖整条可拖拽把手（.win-controls 宽 128px），否则鼠标移到
  // 右侧留白处准备拖动时，条会先一步消失。
  const WIN_CTRL_ZONE_W = 132;
  const WIN_CTRL_ZONE_H = 26;
  const WIN_CTRL_HIDE_DELAY_MS = 90;  // 极短延迟：防按钮边缘抖动，又不至于卡住点击
  let winCtrlShown = false;
  let winCtrlHideTimer = null;
  let winCtrlScreen = null;

  function setWinControls(show) {
    const next = !!show;
    if (next === winCtrlShown) return;
    winCtrlShown = next;
    try { mainWindow?.webContents.send("shell:win-controls", next); } catch { /* 窗口已销毁 */ }
  }

  function pollWinControls() {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()) {
      setWinControls(false);
      return;
    }
    if (!winCtrlScreen) {
      try { winCtrlScreen = require("electron").screen; } catch { return; }
      if (!winCtrlScreen) return;
    }
    let pt;
    try { pt = winCtrlScreen.getCursorScreenPoint(); } catch { return; }
    // 最大化 / 全屏时 Windows 给窗口套一圈 8px 阴影边框（getBounds 会比屏幕还大），
    // 左上角坐标要按显示器工作区/整屏来算才准。
    const raw = mainWindow.getBounds();
    let b = raw;
    if (mainWindow.isMaximized() || mainWindow.isFullScreen()) {
      try {
        const disp = winCtrlScreen.getDisplayMatching(raw);
        b = mainWindow.isFullScreen() ? disp.bounds : disp.workArea;
      } catch { /* 取不到显示器信息就退回原始 bounds */ }
    }
    const localX = pt.x - b.x;
    const localY = pt.y - b.y;
    const inside = localX >= 0 && localX <= WIN_CTRL_ZONE_W && localY >= 0 && localY <= WIN_CTRL_ZONE_H;

    if (inside) {
      if (winCtrlHideTimer) { clearTimeout(winCtrlHideTimer); winCtrlHideTimer = null; }
      setWinControls(true);
      return;
    }
    if (winCtrlShown && !winCtrlHideTimer) {
      winCtrlHideTimer = setTimeout(() => {
        winCtrlHideTimer = null;
        setWinControls(false);
      }, WIN_CTRL_HIDE_DELAY_MS);
    }
  }

  const winCtrlPollTimer = setInterval(pollWinControls, 100);
  mainWindow.on("minimize", () => setWinControls(false));
  mainWindow.on("hide", () => setWinControls(false));
  mainWindow.on("blur", () => setWinControls(false));
  mainWindow.on("closed", () => {
    clearInterval(winCtrlPollTimer);
    if (winCtrlHideTimer) { clearTimeout(winCtrlHideTimer); winCtrlHideTimer = null; }
    setWinControls(false);
  });

  // 强制刷新：真清一遍 HTTP 缓存再带 _r 重载 iframe。
  // 只加 _r 参数能绕过 HTML 文档缓存，但页面里的 JS/CSS 仍可能吃磁盘缓存，
  // 对「改了前端产物想立刻看到」的场景不够彻底，所以这里先 clearCache。
  async function hardReload(from) {
    logLine(`[shell] 快捷键：强制刷新（${from}）`);
    console.log(`[shell] 快捷键：强制刷新（${from}）`);
    try { await session.defaultSession.clearCache(); } catch { /* 清缓存失败仍继续重载 */ }
    reloadPage({ clearCache: true });
  }

  // 浏览器快捷键（在主进程拦，焦点在 iframe 里时同样生效）：
  //   F5 / Ctrl+R                      刷新页面
  //   Ctrl+Shift+R / Ctrl+F5 / Shift+F5 强制刷新（清缓存重载：URL 追加 _r=<时间戳>）
  //   F11                              全屏 ↔ 退出全屏
  // preventDefault 是必须的：不拦的话 Chromium 自己的 F5/Ctrl+R 只会重载壳页面
  // （topbar.html），iframe 里的 WebUI 纹丝不动，看起来就像「按了没反应」。
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat) return;
    const key = input.key;
    const ctrl = input.control || input.meta;
    const shift = input.shift;

    if (key === "F11") {
      event.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      return;
    }
    if (key === "F5") {
      event.preventDefault();
      if (ctrl || shift) hardReload("F5+修饰键");
      else { logLine("[shell] 快捷键：刷新（F5）"); console.log("[shell] 快捷键：刷新（F5）"); reloadPage(); }
      return;
    }
    if (ctrl && (key === "r" || key === "R")) {
      event.preventDefault();
      if (shift) hardReload("Ctrl+Shift+R");
      else { logLine("[shell] 快捷键：刷新（Ctrl+R）"); console.log("[shell] 快捷键：刷新（Ctrl+R）"); reloadPage(); }
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });

  // 记忆用户拖拽调整的窗口尺寸与位置（防抖保存）
  mainWindow.on("resize", scheduleSaveWindowBounds);
  mainWindow.on("move", scheduleSaveWindowBounds);

  // 最大化 ↔ 还原：把状态推给壳页面，右上角按钮图标跟着切
  mainWindow.on("maximize", () => pushMaximizeState(true));
  mainWindow.on("unmaximize", () => pushMaximizeState(false));

  // 关闭窗口 = 最小化到托盘（服务不停）
  mainWindow.on("close", (e) => {
    persistWindowBounds();
    if (quitting) return;
    e.preventDefault();
    hideToTray();
  });

  // 右键行为（壳子不再自绘任何菜单）：
  // · 壳 chrome（主框架）上右键：一律 preventDefault，不出菜单——顶栏没有任何东西可管理，
  //   留着 Chromium 的「检查 / 打印 / 全屏」反而露馅；
  // · iframe（DSH WebUI）内右键：完全放行，交给 Chromium 原生菜单（复制/粘贴/保存图片）。
  // 左上角拖拽热区已删除，因此这里不再做坐标判定，也不再向渲染进程派发菜单。
  mainWindow.webContents.on("context-menu", (event, params) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const isMain = !params.frame || params.frame === mainWindow.webContents.mainFrame;
    if (isMain) event.preventDefault();
  });

  // iframe 内点击外链（target=_blank / window.open）：不再弹壳内小窗口
  // （Electron 默认行为是开一个子 BrowserWindow 显示网页），一律交给
  // 系统默认浏览器（Chrome）打开。openExternal 在主进程执行，不受
  // 渲染进程 user-gesture 策略限制；非 http/https/mailto 协议直接忽略。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) {
      try { shell.openExternal(url); } catch { /* 打开失败不影响主界面 */ }
    }
    return { action: "deny" }; // 拒绝壳内新窗口
  });

  // 若 iframe 加载失败（服务未就绪/连接拒绝），服务就绪后自动重试；
  // 先通知渲染进程显示壳子错误遮罩（而非 Chromium 内建错误页）。
  mainWindow.webContents.on(
    "did-fail-load",
    (_e, _code, _desc, url, isMainFrame) => {
      if (!isMainFrame && url.startsWith(DSH_URL)) {
        // -3 是 net::ERR_ABORTED（通常由于连续下发新 URL 导致前一个请求被中止，或页面内部重定向），
        // 属于 Chromium 正常取消动作，绝不是真正的连接失败，忽略即可。
        if (_code === -3) return;
        try {
          mainWindow.webContents.send("shell:frame-error", `服务连接失败（${_desc || _code}），正在自动重试…`);
        } catch { /* 窗口已销毁 */ }
        setTimeout(loadDshFrame, 3000);
      }
    }
  );
}

function hideToTray() {
  if (!mainWindow) return;
  persistWindowBounds();
  mainWindow.hide();
  if (!trayNoticeShown) {
    trayNoticeShown = true;
    try {
      tray?.displayBalloon({
        title: "DeepSeek Harness",
        content: "已最小化到托盘，dsh 服务保持运行。右键托盘图标可退出（或彻底停止服务）。",
      });
    } catch { /* 托盘通知失败不影响功能 */ }
  }
}

// 从托盘/卡片点击/二次启动恢复显示：保持用户拖拽的窗口尺寸，不强制最大化，无多余动效
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  try { mainWindow.webContents.send("shell:window-shown"); } catch { }
}

// ---------- 开机自动启动 ----------
// 设置入口在托盘菜单（开机自动启动勾选项），状态持久化到 userData/settings.json，
// 实际生效靠 app.setLoginItemSettings（Windows 写 HKCU Run 键，MSI 按用户安装免管理员）。
// 读写必须用同一套 path/args：set 带 --hidden 写入后，get 也必须带同样参数去读，
// 否则 Electron 按整条命令比对永远返回 false（之前托盘点了打不上勾就是这个原因）。
function loginItemOpts() {
  if (!app.isPackaged) {
    // 开发模式：默认会指向 Electron 二进制，需显式指回本应用
    return { path: process.execPath, args: [path.resolve(__dirname, "main.js"), "--hidden"] };
  }
  // 登录自启时带 --hidden，本进程启动即最小化到托盘（见 startedHidden）
  return { path: process.execPath, args: ["--hidden"] };
}
// 系统层是否真开着（直读 Run 键状态，不含文件回退）
function systemAutoLaunchOn() {
  try {
    if (app.getLoginItemSettings(loginItemOpts()).openAtLogin) return true;
    if (app.getLoginItemSettings().openAtLogin) return true; // 兼容旧版不带参条目
  } catch { /* 未就绪视为关闭 */ }
  return false;
}
function autoLaunchEnabled() {
  // 以系统实际状态为准（用户可能在任务管理器里手动关掉），读不到再回退本地文件
  if (systemAutoLaunchOn()) return true;
  return !!loadSettings().autoLaunch;
}
function setAutoLaunch(enabled) {
  saveSettings({ ...loadSettings(), autoLaunch: !!enabled });
  try {
    app.setLoginItemSettings({ ...loginItemOpts(), openAtLogin: !!enabled });
    logLine(`[shell] 开机自启已${enabled ? "开启" : "关闭"}`);
  } catch (e) {
    logLine(`[shell] 开机自启设置失败: ${e && e.message}`);
  }
  rebuildTrayMenu();
}
// 本次启动是否来自登录自启：登录自启则窗口初始藏托盘，服务照常在后台拉起
function startedHidden() {
  if (process.argv.includes("--hidden") || process.argv.includes("--minimized")) return true;
  // 注意：Electron 的 wasOpenedAtLogin 仅在 macOS 上有效；Windows/Linux 上该字段恒为 true，
  // 若直接使用会导致用户每次正常双击图标启动都被误判为开机自启并隐藏到托盘，产生「双击没反应」的假死现象。
  if (process.platform === "darwin") {
    try { if (app.getLoginItemSettings().wasOpenedAtLogin) return true; } catch { /* 忽略 */ }
  }
  return false;
}
// MSI 覆盖安装后 exe 路径可能变化导致 Run 键失效：启动时按本地设置重对齐一次
function syncAutoLaunchOnBoot() {
  const want = !!loadSettings().autoLaunch;
  if (want && !systemAutoLaunchOn()) {
    logLine("[shell] 检测到自启设置与系统不一致，重新应用");
    setAutoLaunch(true);
  }
}

// ---------- 托盘 ----------
function createTray() {
  const icon = nativeImage.createFromPath(trayIcon());
  tray = new Tray(icon);
  tray.setToolTip("DeepSeek Harness");
  rebuildTrayMenu();
  tray.on("double-click", () => showMainWindow());

  // 主题切换时更新图标、窗口底色（菜单本身是原生菜单，自动跟随系统主题）
  nativeTheme.on("updated", () => {
    updateTrayIcon();
    rebuildTrayMenu();
    mainWindow?.setBackgroundColor(themeBg());
    pushTheme();
  });
}

function openUpdateModal() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  try { mainWindow.webContents.send("shell:open-update-modal"); } catch {}
}

function rebuildTrayMenu() {
  if (!tray) return;
  // 安全启动记录：有被自动关闭的插件时，托盘里提供查看/恢复入口
  const safeBootItems = (() => {
    const info = safeBootSnapshot();
    if (!info.available || !info.state) return [];
    const st = info.state;
    const n = (st.disabled?.length || 0) + (st.bundles?.length || 0) + (st.patchEdits?.length || 0);
    if (n === 0) return [];
    return [
      { label: `安全启动：已关闭 ${n} 个插件`, enabled: false },
      { label: "查看安全启动记录", click: () => openSafeBootRecord() },
      { label: "恢复被关闭的插件并重启", click: () => restoreSafeBootAndRestart() },
      { type: "separator" },
    ];
  })();
  const menu = Menu.buildFromTemplate([
    { label: "显示主窗口", click: () => showMainWindow() },
    { type: "separator" },
    {
      label: "重启 DSH 服务",
      // 收进二级菜单：清缓存只是重启的一种变体，平铺会让托盘菜单多出一行且不易发现两者的关系
      submenu: [
        { label: "仅重启", click: () => restartService() },
        { label: "清理缓存并重启", click: () => restartService({ clearCache: true }) },
      ],
    },
    ...safeBootItems,
    {
      label: "更新自研插件套件（已停用）",
      enabled: false,
      click: async () => {
        if (isDevLayout()) {
          // 开发机是 link: 布局：npm 版会与本地依赖打架，明确拒绝而不是静默改环境
          logLine("[shell] 托盘：检测到开发机布局，跳过插件套件更新（link: 依赖由源码构建负责）");
          try {
            tray?.displayBalloon({ title: "DeepSeek Harness", content: "当前是开发机布局（link: 本地依赖），插件更新请在各插件目录执行 node build.mjs。" });
          } catch { /* 托盘通知失败不影响 */ }
          return;
        }
        logLine("[shell] 托盘：手动更新自研插件套件");
        sendRuntimeEvent({ type: "status", percent: 99, text: "正在更新自研插件套件…", ticker: KR_BUNDLE_ORDER.join(" ") });
        const dep = await deployKrPlugins((evt) => sendRuntimeEvent(evt));
        if (dep.ok) {
          logLine(`[shell] 手动更新插件套件完成: ${dep.plugins.join(", ")}`);
          showMainWindow();
          setTimeout(() => restartService(), 800);
        } else {
          logLine(`[shell] 手动更新插件套件失败: ${dep.error}`);
        }
      },
    },
    { type: "separator" },
    { label: "开机自动启动", type: "checkbox", checked: autoLaunchEnabled(), click: (item) => setAutoLaunch(item.checked) },
    { type: "separator" },
    { label: "退出（保留服务在后台）", click: () => quitApp(false) },
    { label: "退出并停止服务", click: () => quitApp(true) },
  ]);
  tray.setContextMenu(menu);
}

function quitApp(stopService) {
  if (quitting) return;
  quitting = true;
  stopServiceOnQuit = stopService;
  app.quit();
}

function restartService(opts) {
  // 清缓存重载：clearCache 一路带到异步链路末尾的 reloadPage，URL 改写留到下发那一刻
  // （服务重启完才有新 token，提前拼 URL 会拿到过期 token）。
  const clearCache = Boolean(opts && opts.clearCache);
  if (clearCache) {
    logLine("[shell] 重启服务：本次重启后将以清缓存方式重载页面（URL 追加 _r 参数）");
  }
  killPort3080(); // 杀干净 3080 上的进程（含壳外启动的）
  killDsh();
  serviceReady = false;
  setTimeout(async () => {
    // 先确保运行环境（node/runtime）就绪：缺环境时自动部署，不再静默卡开屏
    const env = await ensureRuntimeReady();
    if (!env.ok) {
      console.log(`[shell] 运行环境未就绪（${env.code}），不拉起服务`);
      return;
    }
    const ok = await ensureService();
    if (ok) {
      // 服务就绪后只重载 iframe 页面（顶栏/托盘不动），一次到位
      console.log("[shell] 服务已重启，刷新页面");
      reloadPage({ clearCache });
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      console.log("[shell] 服务重启失败");
    }
  }, 1200);
}

function killDsh() {
  // 杀整个进程树（detached 独立进程也照杀，taskkill 按 PID 不认父子归属）
  if (dshProc && dshProc.pid) {
    try {
      exec(`taskkill /PID ${dshProc.pid} /T /F`, { windowsHide: true, stdio: "ignore" });
    } catch { /* 可能已退出 */ }
    dshProc = null;
  }
  // 服务已杀，关闭日志写端（读 tail 用独立 open，不受影响）
  try { if (dshOutFd !== null) fs.closeSync(dshOutFd); } catch { /* 已关 */ }
  try { if (dshErrFd !== null) fs.closeSync(dshErrFd); } catch { /* 已关 */ }
  dshOutFd = dshErrFd = null;
}

// 按 DSH_PORT（默认 3080）杀占用进程（重启服务时兜底，覆盖壳外启动的服务）
function killPort3080() {
  try {
    const out = execSync(
      `netstat -ano | findstr :${DSH_PORT} | findstr LISTENING`,
      { encoding: "utf8", windowsHide: true }
    );
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/\s+(\d+)\s*$/);
      if (m) pids.add(m[1]);
    }
    for (const pid of pids) {
      try {
        exec(`taskkill /PID ${pid} /T /F`, { windowsHide: true, stdio: "ignore" });
      } catch {}
    }
  } catch { /* 无占用 */ }
}

// ---------- 运行环境体检与自动部署 ----------
// 背景（1.1.34）：旧版把 DSH 运行时硬编码成 D:\AI\Dsh\dsh-runtime，分发到别人
// 电脑后 spawn 一个不存在的 bin.js，服务永远起不来，开屏动画就一直停在 86%
// （renderer 在 waiting 阶段又不报错，只把文案推到 88%）。现在：
//   1. 定位分层（开发机旧布局 / 用户级 runtime），见上文 resolveDshDir；
//   2. 启动前体检 Node.js 与 runtime，缺失即自动 npm 现场部署（官方源失败回退镜像）；
//   3. 全过程经 shell:runtime-event 推给开屏界面，失败给出真实原因 + 重试入口。
// KR 自研插件套件（npm 分发形态：@kr-atg 域）。
// 注意与开发机的区别：开发机 profile 里是裸名 + link: 本地依赖，运行时模式从
// npm 装的是 @kr-atg/<name>，因此这里用 scope 名做体检与注册。
// dsh-provider-hub 暂不进分发清单（私有仓库，等作者决定公开发布）。
// 2026-11-04：按用户要求，自研三件套（triad / chat-plus / companion）不再随壳自动部署，
// 用户只保留 dsh-seeker-bot。置空后 inspectPlugins() 恒为 ok，启动时的自愈部署不会触发，
// 也不会再改写 profile/package.json。
const KR_PLUGINS = [];
// 本地源码名 → npm scope 名（下载 zip 兜底链路里 manifest 用的是源码名）
const KR_LOCAL_NAME = { "@kr-atg/dsh-triad": "dsh-triad", "@kr-atg/dsh-chat-plus": "dsh-chat-plus", "@kr-atg/dsh-companion": "dsh-companion" };
function krPluginDir() {
  return path.join(os.homedir(), ".dsh", "profiles", "web", "node_modules");
}
// 自研插件套件体检：开发机是 link: 依赖，随 npm 走不了；运行时模式下默认缺失。
// 不阻断启动（拿到的是官方纯净内核），只在开屏提示。
function inspectPlugins() {
  const base = krPluginDir();
  const missing = KR_PLUGINS.filter((p) => !fs.existsSync(path.join(base, p)));
  return { dir: base, missing, ok: missing.length === 0 };
}
// ---------- 自研插件套件自动部署 ----------
// 链路（按优先级，前者失败自动降级）：
//   1) npm install @kr-atg/<name> —— 与 runtime 同一条 npm 链路，国内最快最稳；
//   2) GitHub Release 预构建 zip —— 留给能直连 github.com 的用户（网络不通时
//      会失败并如实提示，不再假装成功）。
// 部署完成后需重启一次内核（bundle 在 boot 时读取）。
const KR_PLUGINS_RELEASE = {
  repo: "Kr-ATG/dsh-desktop-msi",
  tag: "plugins-v1",
  asset: "kr-dsh-plugins.zip",
};
// bundle 顺序：官方 web 模板 → KR 三件套 → 其余既有条目（幂等，不重复）
const KR_BUNDLE_ORDER = ["@kr-atg/dsh-triad", "@kr-atg/dsh-chat-plus", "@kr-atg/dsh-companion"];
function krPluginsUrl() {
  return `https://github.com/${KR_PLUGINS_RELEASE.repo}/releases/download/${KR_PLUGINS_RELEASE.tag}/${KR_PLUGINS_RELEASE.asset}`;
}
function krPluginsCacheDir() {
  const d = path.join(userDataDir(), "plugins");
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* 只读目录：下载会失败并提示 */ }
  return d;
}
function krPluginsStampFile() {
  return path.join(krPluginsCacheDir(), `.deployed-${KR_PLUGINS_RELEASE.tag}`);
}
function krProfileDir() {
  return path.join(os.homedir(), ".dsh", "profiles", "web");
}
// 开发机布局（legacy runtime + link: 自研插件）不做任何自动部署：
// 那会往开发机 profile 里塞 npm 版插件、改写 bundles，与 link: 布局打架。
// 只有运行时模式（runtime 落在 %APPDATA%\DeepSeek Harness\runtime）才自动装。
function isDevLayout() {
  return resolveDshDir().source === "legacy";
}
// 目标 bundle 顺序：官方 web 模板 → KR 三件套 → 其余既有条目（幂等，不重复）
function mergeProfileBundles(existing) {
  const want = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", ...KR_BUNDLE_ORDER];
  const out = [];
  for (const b of want) if (!out.includes(b)) out.push(b);
  for (const b of (Array.isArray(existing) ? existing : [])) if (!out.includes(b)) out.push(b);
  return out;
}
// 把 KR 套件注册进 profile：bundles 合并 + dependencies 指向 registry 版本
// （版本号依赖：npm 已装进 node_modules，dsh 不需要再去拉）
function registerKrBundles(profileDir, versions) {
  const pkgPath = path.join(profileDir, "package.json");
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); } catch { /* 没有就新建 */ }
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = mergeProfileBundles(pkg.dsh.profile.bundles);
  pkg.dependencies = pkg.dependencies || {};
  for (const name of KR_BUNDLE_ORDER) {
    const v = versions && versions[name];
    pkg.dependencies[name] = v || "*";
  }
  try { fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n"); } catch (e) {
    return { ok: false, error: `写 profile package.json 失败: ${(e && e.message) || e}` };
  }
  return { ok: true, bundles: pkg.dsh.profile.bundles };
}
// zip 解压：优先 tar.exe（Win10 1803+ 自带 bsdtar，支持 zip），回退 Expand-Archive
function extractZip(zip, dest) {
  try {
    execFileSync("tar.exe", ["-xf", zip, "-C", dest], { windowsHide: true, stdio: "ignore" });
    if (fs.existsSync(path.join(dest, "manifest.json"))) return { ok: true, via: "tar" };
  } catch { /* 落到 PowerShell */ }
  try {
    const cmd = `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`;
    execFileSync("powershell", ["-NoProfile", "-Command", cmd], { windowsHide: true, stdio: "ignore" });
    if (fs.existsSync(path.join(dest, "manifest.json"))) return { ok: true, via: "expand-archive" };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  return { ok: false, error: "解压后未找到 manifest.json" };
}
const PLUGIN_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
// 从 npm 安装 KR 三件套到 profile 的 node_modules（registry 用用户 .npmrc 的配置）
function npmInstallKrPlugins(profileDir, onEvent) {
  return new Promise((resolve) => {
    const node = findNode();
    if (!node) { resolve({ ok: false, via: "npm", error: "node-missing" }); return; }
    const npmCli = path.join(path.dirname(node), "node_modules", "npm", "bin", "npm-cli.js");
    const flags = ["install", ...KR_BUNDLE_ORDER, "--no-audit", "--no-fund", "--loglevel", "warn", "--prefix", profileDir];
    onEvent({ type: "status", percent: 99, text: "正在从 npm 安装自研插件套件…", ticker: KR_BUNDLE_ORDER.join(" ") });
    let child;
    try {
      if (fs.existsSync(npmCli)) {
        child = spawn(node, [npmCli, ...flags], { cwd: profileDir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } else {
        // 找不到 npm-cli.js：回退 PATH 里的 npm（.cmd 需要 shell）
        child = spawn("npm", flags, { cwd: profileDir, windowsHide: true, shell: true, stdio: ["ignore", "pipe", "pipe"] });
      }
    } catch (e) {
      resolve({ ok: false, via: "npm", error: String((e && e.message) || e) });
      return;
    }
    let tail = "";
    const tick = (line) => { tail = String(line).slice(-160); onEvent({ type: "status", percent: 99, text: "正在安装自研插件套件…", ticker: tail }); };
    child.stdout?.on("data", (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach(tick));
    child.stderr?.on("data", (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach(tick));
    child.on("error", (e) => resolve({ ok: false, via: "npm", error: String((e && e.message) || e) }));
    child.on("close", (code) => {
      const missing = KR_BUNDLE_ORDER.filter((n) => !fs.existsSync(path.join(profileDir, "node_modules", ...n.split("/"))));
      if (code === 0 && missing.length === 0) {
        const versions = {};
        for (const n of KR_BUNDLE_ORDER) {
          try { versions[n] = JSON.parse(fs.readFileSync(path.join(profileDir, "node_modules", ...n.split("/"), "package.json"), "utf8")).version; } catch { versions[n] = "?"; }
        }
        resolve({ ok: true, via: "npm", versions });
      } else {
        resolve({ ok: false, via: "npm", code, missing, tail });
      }
    });
  });
}
// zip 兜底：下载 → 解压 → 拷贝（GitHub Release 资产；直连不通时会如实失败）
async function installKrPluginsFromZip(profileDir, onEvent) {
  const cache = krPluginsCacheDir();
  const zip = path.join(cache, KR_PLUGINS_RELEASE.asset);
  if (!fs.existsSync(zip) || !fs.existsSync(krPluginsStampFile())) {
    onEvent({ type: "status", percent: 99, text: "正在下载自研插件套件…", ticker: krPluginsUrl() });
    try {
      const res = await fetch(krPluginsUrl(), { redirect: "follow", signal: AbortSignal.timeout(PLUGIN_DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok) return { ok: false, via: "zip", error: `下载失败 HTTP ${res.status}` };
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) return { ok: false, via: "zip", error: "下载到的文件异常偏小，可能不是有效 zip" };
      fs.writeFileSync(zip, buf);
      logLine(`[shell] 插件套件 zip 已下载: ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
    } catch (e) {
      return { ok: false, via: "zip", error: `下载异常: ${(e && e.message) || e}` };
    }
  }
  onEvent({ type: "status", percent: 99, text: "正在安装自研插件套件…", ticker: "解压并写入 profile/node_modules" });
  const extractDir = path.join(cache, "extract");
  try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* 不存在 */ }
  try { fs.mkdirSync(extractDir, { recursive: true }); } catch (e) {
    return { ok: false, via: "zip", error: `创建解压目录失败: ${(e && e.message) || e}` };
  }
  const ex = extractZip(zip, extractDir);
  if (!ex.ok) return { ok: false, via: "zip", error: `解压失败: ${ex.error}` };
  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(extractDir, "manifest.json"), "utf8"));
  } catch (e) {
    return { ok: false, via: "zip", error: `manifest.json 解析失败: ${(e && e.message) || e}` };
  }
  const localVersions = manifest.plugins || {};
  const nmTarget = path.join(profileDir, "node_modules");
  try { fs.mkdirSync(nmTarget, { recursive: true }); } catch (e) {
    return { ok: false, via: "zip", error: `创建 node_modules 失败: ${(e && e.message) || e}` };
  }
  const installed = [];
  const versions = {};
  for (const scopeName of KR_BUNDLE_ORDER) {
    const local = KR_LOCAL_NAME[scopeName] || scopeName;
    const src = path.join(extractDir, "node_modules", local);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(nmTarget, ...scopeName.split("/"));
    try { fs.rmSync(dst, { recursive: true, force: true }); } catch { /* 旧产物/链接不存在 */ }
    try {
      fs.cpSync(src, dst, { recursive: true, force: true });
      installed.push(`${scopeName}@${localVersions[local] || "?"}`);
      versions[scopeName] = localVersions[local] || "?";
    } catch (e) {
      logLine(`[shell] 插件 ${scopeName} 拷贝失败: ${(e && e.message) || e}`);
    }
  }
  try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* 清理失败无碍 */ }
  if (installed.length === 0) return { ok: false, via: "zip", error: "zip 中没有可安装的插件产物" };
  return { ok: true, via: "zip", installed, versions };
}
// 部署 KR 自研插件套件： npm 优先，zip 兜底；两者都失败返回真实原因
async function deployKrPlugins(onEvent) {
  const profileDir = krProfileDir();
  // profile 必须已被内核创建（runtime 起来过一次才有），否则先让内核启动
  if (!fs.existsSync(profileDir)) {
    return { ok: false, error: `profile 目录尚不存在（${profileDir}）` };
  }
  const errors = [];
  const viaNpm = await npmInstallKrPlugins(profileDir, onEvent);
  if (viaNpm.ok) {
    const installed = KR_BUNDLE_ORDER.map((n) => `${n}@${viaNpm.versions[n] || "?"}`);
    const reg = registerKrBundles(profileDir, viaNpm.versions);
    if (!reg.ok) return { ok: false, error: reg.error };
    try { fs.writeFileSync(krPluginsStampFile(), JSON.stringify({ tag: KR_PLUGINS_RELEASE.tag, at: new Date().toISOString(), via: "npm", plugins: installed }, null, 2)); } catch { /* 打戳失败：下次重新部署 */ }
    return { ok: true, via: "npm", plugins: installed, bundles: reg.bundles };
  }
  errors.push(`npm: ${viaNpm.error || `退出码 ${viaNpm.code}`}${viaNpm.missing && viaNpm.missing.length ? `（未装上: ${viaNpm.missing.join(", ")}）` : ""}`);
  onEvent({ type: "status", percent: 99, text: "npm 安装未成功，尝试备用通道…", ticker: errors[0] });
  const viaZip = await installKrPluginsFromZip(profileDir, onEvent);
  if (viaZip.ok) {
    const reg = registerKrBundles(profileDir, viaZip.versions);
    if (!reg.ok) return { ok: false, error: reg.error };
    try { fs.writeFileSync(krPluginsStampFile(), JSON.stringify({ tag: KR_PLUGINS_RELEASE.tag, at: new Date().toISOString(), via: "zip", plugins: viaZip.installed }, null, 2)); } catch { /* 打戳失败：下次重新部署 */ }
    return { ok: true, via: "zip", plugins: viaZip.installed, bundles: reg.bundles };
  }
  errors.push(`zip: ${viaZip.error || `退出码 ${viaZip.code}`}`);
  return { ok: false, error: errors.join(" | ") };
}
// 推送给壳渲染进程（开屏状态 / 错误提示）。窗口未就绪时 latch 住最后一条，
// 由 renderer 拉 get-runtime 时补齐，避免事件发在订阅之前而丢失。
let lastRuntimeEvent = null;
function sendRuntimeEvent(evt) {
  lastRuntimeEvent = evt;
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("shell:runtime-event", evt);
  } catch { /* 窗口未就绪：等 get-runtime 补齐 */ }
}
// 体检：只读，不改任何东西
function inspectRuntime() {
  const node = findNode();
  const layout = resolveDshDir();
  return {
    node: { ok: !!node, path: node },
    runtime: { ok: layout.source !== "missing", dir: layout.dir, source: layout.source, version: installedDshVersion(), wantVersion: DSH_VERSION },
    plugins: inspectPlugins(),
    safeBoot: safeBootSnapshot(),
    logs: { dir: userLogDir(), shell: shellLogPath(), serviceOut: svcOutLogPath(), serviceErr: svcErrLogPath() },
    layoutRoot: dshLayoutRoot(),
  };
}
const NPM_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
// 单次 npm install（带进度回调）。优先 node 自带 npm-cli.js（不依赖 PATHEXT），
// 找不到再回退 PATH 里的 npm（shell:true）。
function runNpmInstall(cwd, registry, onEvent) {
  return new Promise((resolve) => {
    const node = findNode();
    if (!node) { resolve({ ok: false, error: "node-missing" }); return; }
    const npmCli = path.join(path.dirname(node), "node_modules", "npm", "bin", "npm-cli.js");
    const flags = ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel", "warn", "--registry", registry];
    let child;
    try {
      if (fs.existsSync(npmCli)) {
        child = spawn(node, [npmCli, ...flags], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } else {
        child = spawn("npm", flags, { cwd, windowsHide: true, shell: true, stdio: ["ignore", "pipe", "pipe"] });
      }
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e), registry });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      resolve({ ok: false, error: "timeout", registry });
    }, NPM_INSTALL_TIMEOUT_MS);
    let pct = 88;
    const tick = (line) => {
      const low = String(line).toLowerCase();
      if (low.includes("added") || low.includes("packages in") || low.includes("changed")) pct = 98;
      else if (low.includes("reify")) pct = Math.max(pct, 94);
      else if (low.includes("idealtree") || low.includes("timing") || low.includes("fetch")) pct = Math.max(pct, 91);
      else pct = Math.max(pct, 89);
      onEvent({ type: "status", percent: pct, text: "正在部署 DSH 运行时组件…", ticker: String(line).slice(-160) });
    };
    child.stdout?.on("data", (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach(tick));
    child.stderr?.on("data", (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach(tick));
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: String((e && e.message) || e), registry }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(dshBin())) {
        onEvent({ type: "status", percent: 100, text: "运行环境部署完成", ticker: "" });
        resolve({ ok: true, registry });
      } else {
        resolve({ ok: false, code, registry });
      }
    });
  });
}
// 部署 runtime 到用户级目录 %APPDATA%\<appName>\runtime：先写锁版本 package.json，
// 再依次尝试 npm 源（国内镜像 → 官方）。
//
// ⚠ package.json 里的 dependencies **必须按 DSH_VERSION 重写**，不能「不存在才写」：
// 老版本只在文件缺失时写一次，结果用户装过一次之后版本就被永久钉死，换新版壳也升不上去。
async function deployRuntime(onEvent) {
  const target = userRuntimeDir();
  try { fs.mkdirSync(target, { recursive: true }); }
  catch (e) { return { ok: false, error: `创建运行环境目录失败: ${(e && e.message) || e}` }; }
  const pkgPath = path.join(target, "package.json");
  try {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); } catch { pkg = {}; }
    if (!pkg || typeof pkg !== "object") pkg = {};
    pkg.name = pkg.name || "dsh-runtime";
    pkg.version = pkg.version || "1.0.0";
    pkg.private = true;
    pkg.dependencies = { ...(pkg.dependencies || {}), "@deepseek-ai/dsh": DSH_VERSION };
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  } catch (e) { return { ok: false, error: `写入 package.json 失败: ${(e && e.message) || e}` }; }
  const errors = [];
  for (const registry of NPM_REGISTRIES) {
    onEvent({ type: "status", percent: 88, text: "正在部署 DSH 运行时组件…", ticker: `npm install @deepseek-ai/dsh@${DSH_VERSION}（${registry === "https://registry.npmmirror.com" ? "镜像源" : "官方源"}）· ${RUNTIME_DISK_HINT}` });
    const r = await runNpmInstall(target, registry, onEvent);
    if (r.ok) return r;
    errors.push(`[${registry}] ${r.error || `退出码 ${r.code}`}`);
    onEvent({ type: "status", percent: 88, text: "当前源不可用，正在切换源重试…", ticker: errors[errors.length - 1] });
  }
  return { ok: false, error: errors.join(" | ") };
}
// 启动前置：确保 Node.js + runtime 就绪（缺了就自动部署）
let runtimeReadyInFlight = null;
function ensureRuntimeReady() {
  if (runtimeReadyInFlight) return runtimeReadyInFlight;
  runtimeReadyInFlight = (async () => {
    const st = inspectRuntime();
    logLine(`[shell] 运行环境体检: node=${st.node.ok ? st.node.path : "缺失"} runtime=${st.runtime.source} (${st.runtime.dir})`);
    if (!st.node.ok) {
      sendRuntimeEvent({
        type: "error", code: "node-missing",
        text: "未检测到 Node.js 运行时",
        hint: "DSH 桌面版需要 Node.js 22 LTS 才能拉起本地内核。安装后点「重试」即可自动完成运行环境部署。",
        actions: ["retry", "install-node", "log"],
      });
      return { ok: false, code: "node-missing" };
    }
    if (!st.runtime.ok) {
      sendRuntimeEvent({ type: "status", percent: 88, text: "正在部署本地内核运行环境…", ticker: RUNTIME_DISK_HINT });
      const res = await deployRuntime((evt) => sendRuntimeEvent(evt));
      if (!res.ok) {
        logLine(`[shell] 自动部署运行环境失败: ${res.error}`);
        sendRuntimeEvent({
          type: "error", code: "deploy-failed",
          text: "本地内核运行环境部署失败",
          hint: `${res.error}\n可点「重试」再来一次，或「查看日志」定位。`,
          actions: ["retry", "log"],
        });
        return { ok: false, code: "deploy-failed", error: res.error };
      }
      logLine("[shell] 运行环境自动部署完成");
      sendRuntimeEvent({ type: "status", percent: 96, text: "运行环境就绪，正在启动内核…", ticker: "" });
    }
    return { ok: true };
  })().catch((e) => {
    // 兜底：体检链路自身异常也不能让壳子静默卡死
    const msg = String((e && e.message) || e);
    logLine(`[shell] 运行环境体检异常: ${msg}`);
    sendRuntimeEvent({ type: "error", code: "inspect-failed", text: "运行环境检查异常", hint: msg, actions: ["retry", "log"] });
    return { ok: false, code: "inspect-failed", error: msg };
  });
  const p = runtimeReadyInFlight;
  p.then(() => { if (runtimeReadyInFlight === p) runtimeReadyInFlight = null; });
  return p;
}

// ---------- 文件日志（诊断用） ----------
function logLine(msg) {
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    require("node:fs").appendFileSync(shellLogPath(), line);
  } catch { /* 日志失败不影响功能 */ }
}

// ---------- IPC：主题 ----------
ipcMain.handle("shell:get-theme", () => (nativeTheme.shouldUseDarkColors ? "dark" : "light"));

// update.mjs 定位：开发机直接跑源码树里的原文件（ROOT_DIR = 源码根，插件树可用）；
// 运行时模式下 asar 内的脚本 node 无法直接执行，抽一份副本到 userData 根——
// 副本的 import.meta.dirname = userData，正好让 update.mjs 的 RUNTIME_DIR 落在
// userData/runtime（引擎升级可用），插件树为空则自动跳过构建（优雅降级）。
function updateScriptPath() {
  const root = dshLayoutRoot();
  if (root !== userDataDir()) {
    const src = path.join(root, "update.mjs");
    if (fs.existsSync(src)) return src;
  }
  const asarScript = path.join(__dirname, "update.mjs");
  const userCopy = path.join(userDataDir(), "update.mjs");
  try {
    if (fs.existsSync(asarScript)) fs.copyFileSync(asarScript, userCopy);
    if (fs.existsSync(userCopy)) return userCopy;
  } catch { /* asar 读取失败：回落 asar 路径 */ }
  return asarScript;
}

// 检查更新
ipcMain.handle("shell:check-update", async () => {
  return new Promise((resolve) => {
    const nodeExe = findNode();
    const updateScript = updateScriptPath();
    if (!nodeExe) {
      resolve({ ok: false, error: "未检测到 Node.js 运行时，无法执行更新检查" });
      return;
    }
    const child = spawn(nodeExe, [updateScript, "--check-json"], {
      cwd: path.dirname(dshDir()),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (d) => { out += d; });
    child.on("close", () => {
      try {
        const json = JSON.parse(out.trim());
        resolve({ ok: true, data: json });
      } catch (err) {
        resolve({ ok: false, error: err.message, raw: out });
      }
    });
    child.on("error", (err) => resolve({ ok: false, error: err.message }));
  });
});

// 执行一键更新（实时推送事件流）
let runningUpdateProc = null;
ipcMain.handle("shell:run-update", async (_e, opts = {}) => {
  if (runningUpdateProc) return { ok: false, error: "更新任务已在进行中" };
  const nodeExe = findNode();
  if (!nodeExe) return { ok: false, error: "未检测到 Node.js 运行时，无法执行更新" };
  return new Promise((resolve) => {
    const updateScript = updateScriptPath();
    const args = [updateScript, "--stream-json"];
    if (opts && opts.force) args.push("--force");

    const child = spawn(nodeExe, args, {
      cwd: path.dirname(dshDir()),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    runningUpdateProc = child;

    let buf = "";
    child.stdout?.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const tr = line.trim();
        if (!tr) continue;
        try {
          const item = JSON.parse(tr);
          mainWindow?.webContents.send("shell:update-event", item);
        } catch {
          mainWindow?.webContents.send("shell:update-event", { type: "log", text: tr });
        }
      }
    });

    child.stderr?.on("data", (d) => {
      const msg = d.toString().trim();
      if (msg) mainWindow?.webContents.send("shell:update-event", { type: "log", text: msg });
    });

    child.on("close", (code) => {
      runningUpdateProc = null;
      logLine(`[shell] 一键更新退出码: ${code}`);
      if (code === 0) {
        setTimeout(() => {
          restartService();
        }, 1200);
        resolve({ ok: true });
      } else {
        resolve({ ok: false, code });
      }
    });
    child.on("error", (err) => {
      runningUpdateProc = null;
      resolve({ ok: false, error: err.message });
    });
  });
});
// 渲染进程初始化时拉取：服务是否已通知就绪（事件可能发在订阅之前，靠这里兜底）
ipcMain.handle("shell:get-state", () => ({ serviceReady: svcReady, dshUrl: dshAuthUrl() }));
// 安全启动状态查询（渲染进程/设置页用）
ipcMain.handle("shell:get-safe-boot", () => {
  const info = safeBootSnapshot();
  return { ...info, overlayPath: safeBootOverlayPath(), recordPath: path.join(userDataDir(), "safe-boot.json") };
});
// 恢复被安全启动关闭的插件（只清记录，不自动重启；调用方需要重启服务生效）
ipcMain.handle("shell:clear-safe-boot", () => {
  const sb = safeBootModule();
  if (!sb) return { ok: false, error: "safe-boot 模块不可用" };
  const res = sb.clearSafeBootState(safeBootCtx());
  if (res && res.ok) rebuildTrayMenu();
  return res;
});
// 运行环境体检快照 + 最后一条事件（渲染进程订阅前的竞态兜底）
ipcMain.handle("shell:get-runtime", () => ({
  inspect: inspectRuntime(),
  lastEvent: lastRuntimeEvent,
  pluginsNpm: KR_BUNDLE_ORDER,
  pluginsRelease: { repo: KR_PLUGINS_RELEASE.repo, tag: KR_PLUGINS_RELEASE.tag, asset: KR_PLUGINS_RELEASE.asset, url: krPluginsUrl() },
}));
// 手动重新部署自研插件套件（插件 zip 更新后，或上次装失败时用）。
// opts.restart !== false 时部署完成自动重启内核让 bundle 生效；只部署不重启
// （自动化测试、批量预置环境）传 { restart: false }——避免误杀正在跑的服务。
ipcMain.handle("shell:redeploy-plugins", async (_e, opts = {}) => {
  const dep = await deployKrPlugins((evt) => sendRuntimeEvent(evt));
  if (dep.ok) {
    if (opts && opts.restart === false) {
      return { ok: true, plugins: dep.plugins, restarted: false };
    }
    setTimeout(() => restartService(), 800);
    return { ok: true, plugins: dep.plugins, restarted: true };
  }
  return { ok: false, error: dep.error };
});
// 打开日志目录 / 外链（壳页面错误提示里的按钮）
ipcMain.handle("shell:open-log-dir", () => {
  try { shell.openPath(userLogDir()); } catch { /* 打不开就算了 */ }
});
ipcMain.handle("shell:open-external", (_e, url) => {  const u = String(url || "");
  if (/^https?:\/\//i.test(u)) { try { shell.openExternal(u); } catch { /* 忽略 */ } }
});
// 顶栏双击 / 切换最大化
ipcMain.handle("shell:maximize-window", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
// 右上角窗口控制：最小化按钮
ipcMain.handle("shell:minimize-window", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.minimize();
});
// 右上角窗口控制：初始最大化状态拉取（事件推送的兜底，图标切换用）
ipcMain.handle("shell:is-maximized", () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized()));
// 桌面通知浮窗（任务完成提醒）：WebUI 侧的插件经壳页面调进来
ipcMain.handle("shell:show-toast", (_e, payload) => dshToastShow(payload));
// 保持用户拖拽的窗口尺寸：不再在启动展开或显示时强制最大化
ipcMain.handle("shell:ensure-maximized", () => false);
// 全屏切换与状态查询 (F11)
ipcMain.handle("shell:set-fullscreen", (_e, flag) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setFullScreen(typeof flag === "boolean" ? flag : !mainWindow.isFullScreen());
});
ipcMain.handle("shell:is-fullscreen", () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()));
// 页面重载与服务重启
ipcMain.handle("shell:reload-page", () => {
  logLine("[shell] ipc reloadPage");
  reloadPage();
});
ipcMain.handle("shell:restart-service", (_e, opts = {}) => {
  // 日志带上 clearCache 状态：排查「为什么页面带 _r 参数」时，一眼能看出是谁触发的
  logLine(`[shell] ipc restartService (clearCache=${Boolean(opts && opts.clearCache)})`);
  restartService(opts);
});
// 退出应用
ipcMain.handle("shell:quit-app", (_e, stopService = false) => {
  logLine(`[shell] ipc quitApp (stopService=${stopService})`);
  quitApp(Boolean(stopService));
});
// 关闭动画播完后隐藏窗口（最小化到托盘，dsh 服务保持运行）
ipcMain.handle("shell:close-window", () => hideToTray());

// ---------- 媒体与设备权限管理（麦克风、音频、摄像头等全自动放行授权） ----------
function setupMediaPermissions(sess) {
  if (!sess) return;
  const allowed = new Set([
    "media",
    "microphone",
    "audioCapture",
    "camera",
    "videoCapture",
    "clipboard-read",
    "clipboard-sanitized-write",
    "display-capture",
    "notifications",
    "fullscreen",
    "speaker-selection",
  ]);

  sess.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = webContents ? webContents.getURL() : "";
    logLine(`[permission] request: ${permission} from ${url}`);
    if (allowed.has(permission)) {
      return callback(true);
    }
    if (details && details.mediaTypes) {
      return callback(true);
    }
    callback(true); // 桌面专用 AI 客户端，放行所有媒体与外设访问
  });

  sess.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (allowed.has(permission)) return true;
    if (details && (details.mediaType === "audio" || details.mediaType === "video")) return true;
    return true;
  });

  if (sess.setDevicePermissionHandler) {
    sess.setDevicePermissionHandler((details) => {
      return true; // 放行音频输入设备（麦克风）与输出设备
    });
  }
}

// ---------- 生命周期 ----------
function runApp() {
  app.whenReady().then(async () => {
    logLine("app ready — boot");
    setupMediaPermissions(session.defaultSession);
    // 子进程黑窗体检（只读、不修改上游产物）：异常时留一行日志便于排查。
    // 隐藏语义由上游负责，壳子不再打补丁——见上方「孙进程黑窗」注释。
    try {
      const hiding = inspectDshRuntimeWindowHiding();
      if (!hiding.subprocessLocal || !hiding.win32Process) {
        logLine(`[shell] 警告：DSH 运行时子进程隐藏标志异常 ${JSON.stringify(hiding)}`);
      }
    } catch (e) {
      logLine(`[shell] 子进程隐藏体检异常: ${e && e.message}`);
    }
    syncAutoLaunchOnBoot();
    createWindow();
    createTray();
    // AI 浏览器内嵌视图宿主：本机控制通道（dsh-webui 插件经此挂载/解除视图）
    startBrowserViewHost();

    // 关键：先确保运行环境就绪（node 缺失 → 引导安装；runtime 缺失 → 自动
    // npm 部署），再拉服务。旧版直接 ensureService，环境缺失时空转 120 秒后
    // 静默失败，开屏永远停在 86%（1.1.34 修复）。
    let restartingForPlugins = false; // 插件刚装完：本次不 loadDshFrame，交给重启链路
    const env = await ensureRuntimeReady();
    if (env.ok) {
      // 关键：先确保服务就绪，再让 iframe 加载，避免冷启动时 iframe 先加载失败变黑屏
      const ok = await ensureService();
      if (ok) {
        // 服务起来后再做插件体检：profile 目录此时才由 dsh 创建
        const plugins = inspectPlugins();
        // 开发机布局（link: 依赖）跳过自动部署，绝不污染开发机 profile
        if (!plugins.ok && !isDevLayout()) {
          // 运行时模式：从公开 Release 拉 KR 自研插件套件（失败不阻断，官方内核也能用）
          logLine(`[shell] 插件体检：缺失 ${plugins.missing.join(", ")}，尝试自动部署`);
          const dep = await deployKrPlugins((evt) => sendRuntimeEvent(evt));
          if (dep.ok) {
            logLine(`[shell] 自研插件套件部署完成: ${dep.plugins.join(", ")}`);
            sendRuntimeEvent({ type: "status", percent: 100, text: "插件套件已就绪，正在重启内核…", ticker: "" });
            await new Promise((r) => setTimeout(r, 500));
            // bundle 在 boot 时读取：重启一次内核让插件生效（此时尚未进入主界面）。
            // 不 return——看门狗仍要起，只是本次 loadDshFrame 交给 restartService 里的 reloadPage
            restartingForPlugins = true;
            restartService();
          } else {
            logLine(`[shell] 自研插件套件部署失败: ${dep.error}`);
            sendRuntimeEvent({
              type: "warn", code: "plugins-deploy-failed",
              text: `自研插件套件安装失败（${plugins.missing.join("、")} 未装入），本次以官方内核启动`,
              hint: dep.error,
              actions: ["retry", "log"],
            });
          }
        }
      } else {
        // 失败原因已由 ensureService 的安全启动链路统一推送（插件归因 / 超时 / 进程退出），
        // 这里不再重复发一条笼统的「启动超时」覆盖真实诊断。
        console.log("[shell] 服务启动失败（详见上面的安全启动诊断）");
      }
      if (!restartingForPlugins) loadDshFrame();
    } else {
      console.log(`[shell] 运行环境未就绪: ${env.code}（等待用户处理，开屏已显示原因）`);
    }
    // 服务重启看门狗：外部/计划任务重启服务后自动刷新页面
    startServiceWatchdog();
  });
}

// ---------- 服务就绪通知：渲染进程收到后加载 iframe 并播放展开动画 ----------
// src 由渲染进程统一设置（loadDshFrame 只发通知），配 get-state 拉取兜底，
// 避免服务探测过快导致 send 事件先于渲染进程订阅而丢失（实测竞态）。
let svcReady = false;
let lastSentUrl = "";
let lastSentAt = 0;

function dshAuthUrl() {
  return dshAuthToken ? `${DSH_URL}/?token=${dshAuthToken}` : DSH_URL;
}
function loadDshFrame(force = false, opts) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // 安全门禁：若为本次启动的新服务，且尚未拿到 token 及建立认证，暂不下发空 token URL，
  // 避免 iframe 过早加载无 token 地址呈现 authentication required 报错
  if (dshProc && !dshAuthToken && !authEstablished) {
    logLine("[shell] 暂缓下发 URL：等待 auth token 与认证握手就绪");
    return;
  }
  svcReady = true;
  // 构造带 auth token 的 URL（DSH web 默认需要认证）
  let url = dshAuthUrl();
  // 清缓存重载：追加 _r=<时间戳>，让浏览器把这次导航当成新文档重新请求
  // （等价于页面内 location.replace(location.pathname + '?_r=' + Date.now())）。
  // URL 此时可能已是 `…/?token=xxx`，分隔符要按现有查询串判断，
  // 否则会拼出两个 ? 导致 token 变成参数值的一部分、认证直接失效。
  if (opts && opts.clearCache) {
    url += `${url.includes("?") ? "&" : "?"}_r=${Date.now()}`;
  }
  if (!force && url === lastSentUrl && Date.now() - lastSentAt < 800) {
    return;
  }
  lastSentUrl = url;
  lastSentAt = Date.now();
  logLine(`[shell] 下发页面 URL（带token=${Boolean(dshAuthToken)}${opts && opts.clearCache ? "，清缓存重载 _r" : ""}）`);
  mainWindow.webContents.send("shell:service-ready", url);
}

// 窗口全关不退出：常驻托盘，服务不停
app.on("window-all-closed", () => { /* 保持托盘运行 */ });

app.on("before-quit", () => {
  quitting = true;
  persistWindowBounds();
  if (stopServiceOnQuit) {
    killPort3080();
    killDsh();
  }
});

app.on("activate", () => showMainWindow());
} // end else: 非 --setup 正常壳分支
