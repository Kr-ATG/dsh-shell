// setup-main.js — 卡片安装器主进程逻辑（被 main.js --setup 分支调用）
// 无边框透明卡片窗 + 7za 解压 + 快捷方式 + 卸载注册 + 启动应用。
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { spawn, execFileSync } = require("node:child_process");
const path = require("node:path");
// 关键：安装器在复制应用文件时会读写 app.asar 等归档文件。
// Electron 默认会劫持 node:fs 把 .asar 视作虚拟目录，导致 copyFileSync 抛错并误报「文件被占用」。
// 必须优先使用未被劫持的 original-fs 并禁用 asar 拦截。
const fs = (() => {
  try { return require("original-fs"); }
  catch { return require("node:fs"); }
})();
try { process.noAsar = true; } catch { /* 忽略 */ }
const os = require("node:os");

const SETUP_VERSION = (() => {
  try { return require(path.join(__dirname, "package.json")).version || ""; }
  catch { return ""; }
})();

const APP_NAME = "DeepSeek Harness";
const APP_FILENAME = "DeepSeek Harness";
const APP_ID = "com.kr.dsh-shell";
const UNINSTALL_KEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DeepSeek Harness";

let setupWin = null;
let setupDone = false;
let installedDir = "";
let installedExe = "";
let payloadDir = "";   // 自解压包内 payload 位置（--setup-payload 传入）
let startedHidden = false;
let lastEvictedDir = null; // 腾挪安装时旧目录被改名到的位置（仅用于提示）

// 用户双击的那个 exe 所在目录（portable 壳注入；非 portable 时回退自身目录）。
// 安装标记与快捷方式都以这里为准 —— portable 形态下进程跑在 %TEMP% 解压目录，
// 用 process.execPath 会写错位置，导致「装完再双击还是弹安装卡」。
function launchDir() {
  const p = process.env.PORTABLE_EXECUTABLE_DIR;
  if (p && String(p).trim()) return String(p).trim();
  return path.dirname(process.execPath);
}
// portable 形态下应用真实文件解压在 %TEMP%\<随机>，这里就是「安装源」
function payloadSourceDir() {
  return path.dirname(process.execPath);
}

function defaultDir() {
  try {
    const st = fs.statSync("D:\\");
    if (st && st.isDirectory()) return `D:\\${APP_FILENAME}`;
  } catch { /* 无 D 盘 */ }
  return path.join(process.env.ProgramFiles || "C:\\Program Files", APP_FILENAME);
}

function sevenZaPath() {
  // portable 壳内自带 7za（build 时塞进 resources/bin）；开发期回退系统 7z
  const inner = path.join(process.resourcesPath || __dirname, "bin", "7za.exe");
  try { if (fs.existsSync(inner)) return inner; } catch { /* 继续 */ }
  const dev = path.join(__dirname, "node_modules", "7zip-bin", "win", "x64", "7za.exe");
  try { if (fs.existsSync(dev)) return dev; } catch { /* 继续 */ }
  return null;
}

function appPayloadArchive() {
  // portable 壳：payload.7z 与 exe 同目录（7z SFX 自解压）或 resources 内
  const cands = [
    payloadDir ? path.join(payloadDir, "payload.7z") : null,
    path.join(path.dirname(process.execPath), "payload.7z"),
    path.join(process.resourcesPath || __dirname, "payload.7z"),
    path.join(__dirname, "_tmp", "setup-payload.7z"),
  ].filter(Boolean);
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch { /* 下一个 */ }
  }
  return null;
}

function createSetupWindow() {
  setupWin = new BrowserWindow({
    width: 600, height: 440,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: "#00000000",
    title: `${APP_NAME} 安装程序`,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "setup-preload.js"),
    },
  });
  setupWin.loadFile(path.join(__dirname, "setup.html"));
  setupWin.once("ready-to-show", () => setupWin.show());
  setupWin.on("closed", () => {
    setupWin = null;
    if (!setupDone) app.quit();
  });
}

function sendProgress(percent, ticker) {
  try { setupWin?.webContents.send("setup:progress", { percent, ticker }); } catch { /* 窗口已关 */ }
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 退化：不睡 */ }
}

// 真进程检测：列出「实际镜像路径落在 dir 下」的同名进程（排除安装器自身）。
// 旧实现用 fs.openSync(exe,"r+") 试探锁 —— 只读属性/杀软扫描/ACL 差异都会抛错，
// 没在运行也报「正在运行」，是本次误报的根因。
function runningFromDir(dir) {
  const want = path.resolve(dir).toLowerCase();
  let out = "";
  try {
    const script = "[System.Diagnostics.Process]::GetProcessesByName('DeepSeek Harness') | ForEach-Object { try { $_.Id.ToString() + '|' + $_.MainModule.FileName } catch {} }";
    out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, timeout: 15000,
    });
  } catch { return []; }
  const pids = [];
  for (const line of String(out).split(/\r?\n/)) {
    const idx = line.indexOf("|");
    if (idx <= 0) continue;
    const pid = Number(line.slice(0, idx).trim());
    const exePath = line.slice(idx + 1).trim().toLowerCase();
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    if (!exePath) continue;
    // 只认目标目录下的实例：安装器自身跑在 temp 解压目录，不误伤
    if (exePath.startsWith(want)) pids.push(pid);
  }
  return pids;
}

/**
 * 目标目录有旧版在跑就自动关掉（用户不必手动去托盘退出）。
 * 三层：① 按 PID 杀（含子进程树）→ ② 兜底 /IM 全杀同名进程 → ③ 等待文件锁释放。
 * 为什么要 /IM 兜底：Electron 是多进程（主进程 + GPU + 渲染 + 实用进程），
 * 只杀主 PID 会留下持有 app.asar 的子进程；且若旧版是「以管理员身份运行」启动的，
 * 普通权限的 taskkill 会 Access denied —— 这时只能明确告诉用户手动退出。
 * @param {string} dir 安装目标目录
 * @returns {Promise<{ok:boolean, closed?:number, error?:string}>}
 */
async function ensureNotRunning(dir) {
  let pids = runningFromDir(dir);
  if (!pids.length) return { ok: true, closed: 0 };
  sendProgress(10, `检测到已运行实例，正在自动关闭（${pids.length} 个）…`);
  // ① 按 PID 杀整棵进程树
  for (const pid of pids) {
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true, stdio: "ignore", timeout: 10000 });
    } catch { /* 权限不足或已退出 */ }
  }
  await new Promise((r) => setTimeout(r, 600));
  // ② 兜底：按镜像名全杀（覆盖上一步没抓到的子进程）
  try {
    execFileSync("taskkill", ["/F", "/T", "/IM", `${APP_FILENAME}.exe`], { windowsHide: true, stdio: "ignore", timeout: 15000 });
  } catch { /* 同上 */ }
  // ③ 等进程退净（Electron 退出 + 文件句柄释放要几秒）
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    pids = runningFromDir(dir);
    if (!pids.length) {
      await new Promise((r) => setTimeout(r, 800)); // 句柄释放缓冲
      return { ok: true, closed: 1 };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    ok: false,
    error: "无法自动关闭正在运行的 DeepSeek Harness。"
      + "请右键托盘图标选择「退出 DeepSeek Harness」，或在任务管理器中结束 DeepSeek Harness 进程后重试。",
  };
}

// 单文件复制带重试：目标被占用/只读时清属性再试，避免一次抖动就整包失败
function copyFileRetry(src, dst, tries = 6) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      if (fs.existsSync(dst)) {
        try { fs.unlinkSync(dst); } catch { /* 如果无法删除则直接覆盖写 */ }
      }
      fs.copyFileSync(src, dst);
      return null;
    } catch (err) {
      lastErr = err;
      try { fs.chmodSync(dst, 0o666); } catch { /* 目标不存在或无权改属性 */ }
      sleepSync(250 * (i + 1));
    }
  }
  return lastErr;
}

function copyDirRecursive(src, dst, onTick, skipNames) {
  let count = 0;
  const failed = [];
  const skip = new Set((skipNames || []).map((s) => String(s).toLowerCase()));
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const e of entries) {
    if (skip.has(e.name.toLowerCase())) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      const sub = copyDirRecursive(s, d, onTick);
      count += sub.count;
      failed.push(...sub.failed);
    } else {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      const err = copyFileRetry(s, d);
      if (err) {
        failed.push(e.name);
        continue;
      }
      count++;
      if (onTick && count % 25 === 0) onTick(`正在复制文件…（${count}）`);
    }
  }
  return { count, failed };
}

/**
 * Windows 技巧：正在被占用的文件无法覆盖，但**可以整个目录改名**。
 * 所以旧版残留锁死时，把旧目录改名腾到一边，再在新目录里装一份干净的，
 * 之后尽力删除旧目录（删不掉就留成 .old-<时间戳>，不影响新装可用）。
 * @param {string} dir 目标安装目录
 * @returns {{ok:boolean, moved?:string, error?:string}}
 */
function evictLockedDir(dir) {
  try {
    if (!fs.existsSync(dir)) return { ok: true };
    const old = `${dir}.old-${Date.now()}`;
    fs.renameSync(dir, old);
    // 尽力清理旧目录；被占用的文件删不掉就留着
    try { fs.rmSync(old, { recursive: true, force: true }); } catch { /* 留成 .old 目录 */ }
    return { ok: true, moved: old };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function writeShortcut(linkPath, target, workDir, icon) {
  try {
    const ps = [
      "$ws = New-Object -ComObject WScript.Shell",
      `$s = $ws.CreateShortcut(${JSON.stringify(linkPath)})`,
      `$s.TargetPath = ${JSON.stringify(target)}`,
      `$s.WorkingDirectory = ${JSON.stringify(workDir)}`,
      icon ? `$s.IconLocation = ${JSON.stringify(icon)}` : null,
      "$s.Save()",
    ].filter(Boolean).join("; ");
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true });
    return new Promise((resolve) => { child.on("close", (c) => resolve(c === 0)); child.on("error", () => resolve(false)); });
  } catch { return Promise.resolve(false); }
}

function registerUninstall(dir, exe) {
  try {
    const { execSync } = require("node:child_process");
    const q = (s) => `"${s.replace(/"/g, "")}"`;
    const base = `HKCU\\${UNINSTALL_KEY}`;
    const un = path.join(dir, "Uninstall.bat");
    execSync(`reg add ${q(base)} /v DisplayName /t REG_SZ /d ${q(APP_NAME)} /f`, { windowsHide: true, stdio: "ignore" });
    execSync(`reg add ${q(base)} /v DisplayVersion /t REG_SZ /d ${q(SETUP_VERSION)} /f`, { windowsHide: true, stdio: "ignore" });
    execSync(`reg add ${q(base)} /v InstallLocation /t REG_SZ /d ${q(dir)} /f`, { windowsHide: true, stdio: "ignore" });
    execSync(`reg add ${q(base)} /v UninstallString /t REG_SZ /d ${q(`"${un}"`)} /f`, { windowsHide: true, stdio: "ignore" });
    execSync(`reg add ${q(base)} /v DisplayIcon /t REG_SZ /d ${q(`"${exe}",0`)} /f`, { windowsHide: true, stdio: "ignore" });
    execSync(`reg add ${q(base)} /v Publisher /t REG_SZ /d ${q("Kr")} /f`, { windowsHide: true, stdio: "ignore" });
    execSync(`reg add ${q(base)} /v NoModify /t REG_DWORD /d 1 /f`, { windowsHide: true, stdio: "ignore" });
    execSync(`reg add ${q(base)} /v NoRepair /t REG_DWORD /d 1 /f`, { windowsHide: true, stdio: "ignore" });
  } catch { /* 注册表写失败不阻断安装 */ }
}

function extractPayload(sevenZa, archive, destDir, stageDir) {
  // 两段式避免 exe 自我覆盖与 dll 占用：先解到 stage，再整体拷贝到目标
  return new Promise((resolve) => {
    fs.mkdirSync(stageDir, { recursive: true });
    const child = spawn(sevenZa, ["x", archive, `-o${stageDir}`, "-y"], { windowsHide: true });
    let out = "";
    child.stdout?.on("data", (d) => { out += String(d); });
    child.stderr?.on("data", (d) => { out += String(d); });
    child.on("error", (err) => resolve({ ok: false, error: String((err && err.message) || err) }));
    child.on("close", (code) => {
      if (code !== 0) return resolve({ ok: false, error: `解压失败（exit ${code}）：${out.slice(-300)}` });
      resolve({ ok: true });
    });
  });
}

function installFromArchive(sevenZa, archive, dir, opts) {
  // 旧 7z payload 路线（保留兼容）：先解到 stage 再整体拷贝
  return (async () => {
    try {
      sendProgress(4, "准备安装目录…");
      fs.mkdirSync(dir, { recursive: true });
      const guard = await ensureNotRunning(dir);
      if (!guard.ok) return { ok: false, error: guard.error };
      const stage = path.join(os.tmpdir(), `dsh-setup-${Date.now()}`);
      sendProgress(8, "正在解压应用文件…");
      const ex = await extractPayload(sevenZa, archive, dir, stage);
      if (!ex.ok) return ex;
      sendProgress(62, "正在复制文件…");
      const res = copyDirRecursive(stage, dir, (t) => sendProgress(70, t));
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* 忽略 */ }
      if (res.failed.length) {
        const retry = await ensureNotRunning(dir);
        if (!retry.ok) return { ok: false, error: retry.error };
        const again = copyDirRecursive(stage, dir, null);
        if (again.failed.length) {
          return { ok: false, error: `以下文件被占用，无法写入：${again.failed.slice(0, 5).join("、")}` };
        }
      }
      sendProgress(84, `已复制 ${res.count} 个文件，正在创建快捷方式…`);
      installedDir = dir;
      installedExe = path.join(dir, `${APP_FILENAME}.exe`);
      try { fs.writeFileSync(path.join(dir, ".dsh-installed"), `${SETUP_VERSION}\n${Date.now()}\n`); } catch { /* 忽略 */ }
      const jobs = [];
      if (opts && opts.desktop !== false) {
        jobs.push(writeShortcut(
          path.join(os.homedir(), "Desktop", `${APP_NAME}.lnk`),
          installedExe, dir, `${installedExe},0`
        ));
      }
      if (opts && opts.startMenu !== false) {
        const sm = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
          "Microsoft", "Windows", "Start Menu", "Programs", APP_NAME);
        try { fs.mkdirSync(sm, { recursive: true }); } catch { /* 忽略 */ }
        jobs.push(writeShortcut(path.join(sm, `${APP_NAME}.lnk`), installedExe, dir, `${installedExe},0`));
      }
      await Promise.all(jobs);
      registerUninstall(dir, installedExe);
      sendProgress(100, "安装完成");
      setupDone = true;
      return { ok: true, dir, run: opts ? opts.run !== false : true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  })();
}

function wireIpc() {
  ipcMain.handle("setup:get-defaults", () => {
    let hasD = false;
    try { hasD = fs.statSync("D:\\").isDirectory(); } catch { /* 无 */ }
    return { dir: defaultDir(), hasD, version: SETUP_VERSION };
  });
  ipcMain.handle("setup:browse", async (_e, current) => {
    // 关键：不传 setupWin 作为父窗口！
    // 因为 setupWin 是无边框透明窗口（transparent: true），在 Windows 上将原生文件对话框
    // 挂靠在透明窗口下会导致对话框被遮挡在底层或无响应（表现为「点浏览没反应」）。
    const r = await dialog.showOpenDialog({
      title: "选择安装位置", defaultPath: current || defaultDir(),
      properties: ["openDirectory", "createDirectory"],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const picked = r.filePaths[0];
    // 选了空目录则直接用；否则建议进 DeepSeek Harness 子目录
    try {
      const items = fs.readdirSync(picked);
      if (items.length === 0) return picked;
    } catch { return picked; }
    if (picked.toLowerCase().endsWith("deepseek harness")) return picked;
    return path.join(picked, APP_FILENAME);
  });
  ipcMain.handle("setup:install", async (_e, opts) => {
    const dir = String((opts && opts.dir) || defaultDir()).trim();
    if (!dir || !/^[a-zA-Z]:[\\/]/.test(dir)) return { ok: false, error: "安装路径必须是盘符开头的绝对路径" };
    // 安装源 = 进程所在目录（portable 壳已把全量文件解压到 %TEMP%\<随机>）
    const srcDir = (() => {
      if (payloadDir) { try { if (fs.existsSync(payloadDir)) return payloadDir; } catch { /* 回退 */ } }
      return payloadSourceDir();
    })();
    const srcExe = path.join(srcDir, `${APP_FILENAME}.exe`);
    let hasSrc = false;
    try { hasSrc = fs.existsSync(srcExe); } catch { hasSrc = false; }
    if (!hasSrc) {
      // 回退：旧 7z payload 路线（保留兼容）
      const sevenZa = sevenZaPath();
      const archive = appPayloadArchive();
      if (!sevenZa || !archive) return { ok: false, error: "安装器缺少应用文件，请重新下载安装包" };
      return installFromArchive(sevenZa, archive, dir, opts);
    }
    try {
      sendProgress(4, "准备安装目录…");
      fs.mkdirSync(dir, { recursive: true });
      // 安装目标就是「双击 exe 所在目录」时（portable 原地安装/绿色版转正）：
      // 文件已在位，只需补标记 + 快捷方式，不复制（复制会撞上正在运行的自身）
      const sameDir = path.resolve(dir).toLowerCase() === path.resolve(launchDir()).toLowerCase();
      if (sameDir) {
        sendProgress(60, "文件已就位，正在创建快捷方式…");
      } else {
        // 占用处理：先自动关闭旧实例（真进程检测，不再用文件锁试探）
        let guard = await ensureNotRunning(dir);
        let evicted = null;
        if (!guard.ok) {
          // 兜底：旧实例杀不掉（多为管理员身份启动）时，利用「目录可改名」绕过文件锁：
          // 把旧目录整体腾到 .old-<时间戳>，再在新目录装一份干净的。旧目录删不掉就留着，
          // 不影响新装可用（占的只是磁盘）。
          sendProgress(14, "旧版本无法关闭，正在改用「腾挪安装」…");
          const ev = evictLockedDir(dir);
          if (!ev.ok) {
            return { ok: false, error: `${guard.error}（腾挪也失败：${ev.error}）` };
          }
          evicted = ev.moved || null;
          guard = { ok: true, closed: 0 };
        }
        sendProgress(20, "正在复制应用文件…");
        // 注意：跨目录复制时不能跳过任何文件 —— 主程序 exe 必须落到目标目录。
        // （portable 形态下 process.execPath 在 %TEMP% 解压目录，与目标目录无关，
        //   之前按名字跳过它会导致「装完目标目录没有主程序」。）
        const res = copyDirRecursive(srcDir, dir, (t) => sendProgress(50, t));
        if (res.failed.length) {
          // 仍有占用：再关一次旧实例后补拷；还不行就腾挪重装（同样绕开文件锁）
          const retry = await ensureNotRunning(dir);
          let again = null;
          if (retry.ok) {
            again = copyDirRecursive(srcDir, dir, null);
          }
          if (!again || again.failed.length) {
            const ev = evictLockedDir(dir);
            if (!ev.ok) {
              const names = (again ? again.failed : res.failed).slice(0, 5).join("、");
              return { ok: false, error: `以下文件被占用，无法写入：${names}（腾挪也失败：${ev.error}）` };
            }
            evicted = ev.moved || evicted;
            const fresh = copyDirRecursive(srcDir, dir, (t) => sendProgress(50, t));
            if (fresh.failed.length) {
              return { ok: false, error: `以下文件被占用，无法写入：${fresh.failed.slice(0, 5).join("、")}` };
            }
          }
          sendProgress(80, "占用文件已补齐，正在创建快捷方式…");
        } else {
          sendProgress(80, `已复制 ${res.count} 个文件，正在创建快捷方式…`);
        }
        if (evicted) {
          // 旧目录残留告知（不阻断）：下次重启后可手动删除
          lastEvictedDir = evicted;
        }
      }
      installedDir = dir;
      installedExe = path.join(dir, `${APP_FILENAME}.exe`);
      // 落已安装标记：下次同目录启动直接进壳，不再弹安装卡。
      // 两处都写 —— 安装目标目录 + 用户双击的 exe 所在目录（portable 形态判定读后者）。
      const markerBody = `${SETUP_VERSION}\n${Date.now()}\n`;
      for (const p of new Set([path.join(dir, ".dsh-installed"), path.join(launchDir(), ".dsh-installed")])) {
        try { fs.writeFileSync(p, markerBody); } catch { /* 单个位置失败不阻断 */ }
      }
      const jobs = [];
      if (opts && opts.desktop !== false) {
        jobs.push(writeShortcut(
          path.join(os.homedir(), "Desktop", `${APP_NAME}.lnk`),
          installedExe, dir, `${installedExe},0`
        ));
      }
      if (opts && opts.startMenu !== false) {
        const sm = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
          "Microsoft", "Windows", "Start Menu", "Programs", APP_NAME);
        try { fs.mkdirSync(sm, { recursive: true }); } catch { /* 忽略 */ }
        jobs.push(writeShortcut(path.join(sm, `${APP_NAME}.lnk`), installedExe, dir, `${installedExe},0`));
      }
      await Promise.all(jobs);
      // 卸载器：把卸载脚本落盘（exe 本体在 portable 形态下就是主程序，不再另拷）
      try {
        fs.copyFileSync(path.join(__dirname, "setup-uninstall.bat"), path.join(dir, "Uninstall.bat"));
      } catch { /* 卸载器落盘失败不阻断 */ }
      registerUninstall(dir, installedExe);
      sendProgress(100, "安装完成");
      setupDone = true;
      return { ok: true, dir, run: opts ? opts.run !== false : true, evicted: lastEvictedDir || undefined };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
  ipcMain.handle("setup:launch", async () => {
    try {
      if (installedExe && fs.existsSync(installedExe)) {
        spawn(installedExe, [], { detached: true, stdio: "ignore", windowsHide: false });
        setupDone = true;
        setTimeout(() => app.quit(), 400);
        return { ok: true };
      }
      return { ok: false, error: "找不到已安装的主程序" };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
  ipcMain.handle("setup:close", () => {
    setupDone = setupDone || false;
    app.quit();
  });
}

function runSetup(argv) {
  for (const a of argv) {
    if (a.startsWith("--setup-payload=")) payloadDir = a.slice("--setup-payload=".length).replace(/^"|"$/g, "");
  }
  // 安装源 = 进程所在目录（portable 壳已把全量文件解压到 %TEMP%\<随机>，
  // 那里就是完整应用布局，免解压直拷；非 portable 时即自身目录）
  if (!payloadDir) payloadDir = payloadSourceDir();
  // 关键：安装器必须与已安装的壳隔离单实例锁与 userData。
  // requestSingleInstanceLock 按 userData 目录加锁，若共用 %APPDATA%\dsh-shell，
  // 已装的壳在跑时安装器会被判定成「第二实例」直接退出 —— 表现为安装卡一闪就没 / 报错。
  try {
    const isoDir = path.join(os.tmpdir(), "dsh-setup-profile");
    fs.mkdirSync(isoDir, { recursive: true });
    app.setPath("userData", isoDir);
    app.setPath("sessionData", isoDir);
  } catch { /* 隔离失败：仍按默认路径继续 */ }
  app.setAppUserModelId(`${APP_ID}.setup`);
  // 安装器自身单实例：避免同时开多个安装卡（与壳的锁已隔离）
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on("second-instance", () => {
    try { if (setupWin && !setupWin.isDestroyed()) { setupWin.show(); setupWin.focus(); } } catch { /* 忽略 */ }
  });
  app.whenReady().then(() => {
    wireIpc();
    createSetupWindow();
  });
  app.on("window-all-closed", () => { /* 安装器：窗关即退 */ });
}

module.exports = { runSetup };
