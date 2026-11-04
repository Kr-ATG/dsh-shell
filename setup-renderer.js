// setup-renderer.js — 卡片安装器前端：欢迎 → 进度 → 完成三态切换
const api = window.dshSetup;
const $ = (id) => document.getElementById(id);
const views = { welcome: $("view-welcome"), progress: $("view-progress"), done: $("view-done") };

function show(name) {
  for (const [k, el] of Object.entries(views)) el.classList.toggle("active", k === name);
}

let installedDir = "";
let allowClose = true;

async function boot() {
  try {
    const d = await api.getDefaults();
    if (d && d.dir) $("path").value = d.dir;
    if (d && d.version) document.querySelectorAll("#ver").forEach((el) => { el.textContent = "v" + d.version; });
    if (d && d.hasD === false) $("space").textContent = "未检测到 D 盘，已回退到默认程序目录";
  } catch { /* 用 HTML 写死的默认值 */ }
}
boot();

$("browse").addEventListener("click", async () => {
  try {
    const dir = await api.browse($("path").value);
    if (dir) $("path").value = dir;
  } catch { /* 用户取消 */ }
});

$("btn-cancel").addEventListener("click", () => api.close());
$("close").addEventListener("click", () => { if (allowClose) api.close(); });
$("btn-close2").addEventListener("click", () => api.close());
$("btn-close3").addEventListener("click", () => api.close());
$("btn-launch").addEventListener("click", async () => { await api.launch(); });

$("btn-install").addEventListener("click", async () => {
  const btn = $("btn-install");
  btn.disabled = true;
  show("progress");
  allowClose = false;
  $("bar").style.width = "0%";
  $("pct").textContent = "0%";
  $("ticker").textContent = "";
  $("err-box").style.display = "none";
  $("btn-close2").style.display = "none";
  $("prog-title").textContent = "正在安装…";
  $("prog-sub").textContent = "正在解压应用文件，请稍候。";
  try {
    const r = await api.install({
      dir: $("path").value.trim(),
      desktop: $("opt-desktop").checked,
      startMenu: $("opt-start").checked,
      run: $("opt-run").checked,
    });
    allowClose = true;
    if (r && r.ok) {
      installedDir = r.dir || $("path").value.trim();
      $("done-sub").textContent = "已安装到 " + installedDir
        + (r.evicted ? `（旧版本目录已腾到 ${r.evicted}，可稍后手动删除）` : "");
      show("done");
      if (!(r.run === false)) {
        // 用户勾了完成后启动：主进程已起应用，这里 600ms 后自动关卡片
        setTimeout(() => api.close(), 900);
      }
    } else {
      throw new Error((r && r.error) || "安装失败");
    }
  } catch (err) {
    allowClose = true;
    $("prog-title").textContent = "安装失败";
    $("prog-sub").textContent = "请换个路径重试，或查看下方错误信息。";
    const box = $("err-box");
    box.textContent = String((err && err.message) || err);
    box.style.display = "block";
    $("btn-close2").style.display = "";
    btn.disabled = false;
  }
});

api.onProgress((p) => {
  const pct = Math.max(0, Math.min(100, Number(p && p.percent) || 0));
  $("bar").style.width = pct + "%";
  $("pct").textContent = pct + "%";
  if (p && p.ticker) $("ticker").textContent = p.ticker;
});
