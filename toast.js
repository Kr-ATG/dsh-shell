// toast.js — 桌面完成提醒浮窗的渲染逻辑（独立小窗口，见 main.js 的 dshToastShow）
//
// 这个窗口**不做通知**：它本身就是通知。壳子主进程按内容算好尺寸、把窗口摆在
// 屏幕右下角，这里只负责画卡片、播入场动画、到点播退场动画并回报主进程隐藏。
//
// 为什么不走 Windows 通知：系统通知会被「通知总开关关闭 / 专注助手全局静音」
// 静默吞掉（真机实测 ToastEnabled=0 时 new Notification() 不报错、onshow 也
// 触发，但屏幕上什么都没有），而桌面浮窗是壳子自己的窗口，不受系统通知设置影响。
//
// 与主进程的协议（全部经 preload 的 window.dshToast）：
//   主→渲染  dshToast:show  { title, text, meta, kind, theme, sessionId }
//   渲染→主  toastReady() / toastResize(h) / toastDismiss()
//            toastClick(sessionId)  ← 点击卡片：主进程唤起主窗并跳会话
//
// 版式（2026 重做）：
//   任务完成 ────────── 耗时 1:24     ← kicker 语义色 + 右对齐耗时
//   会话标题                           ← 主标题
//   问题摘要（最多两行）
//   ┃ 回答摘要                        ← 左侧发丝竖线引注
//   底部一条语义色细线 = 自动收起倒计时（hover 暂停）
const api = window.dshToast;

const stageEl = document.getElementById('stage');
const card = document.getElementById('card');
const kickerEl = document.getElementById('kicker');
const metaEl = document.getElementById('meta');
const titleEl = document.getElementById('title');
const textEl = document.getElementById('text');
const summaryEl = document.getElementById('summary');
const closeBtn = document.getElementById('close');
const iconCheck = document.getElementById('ico-check');
const iconWarn = document.getElementById('ico-warn');
const progressFill = document.getElementById('progress-fill');

/** 自动收起延迟（ms）：比页内卡长一点——桌面浮窗更该给足阅读时间。 */
const AUTO_HIDE_MS = 7000;
/** 退场动画时长（ms）：与 toast.html 的 toastOut 同源。 */
const OUT_MS = 210;

let hideTimer = null;
let outTimer = null;
let hovered = false;
/** 当前展示的会话 id：点击卡片时回传主进程，用于跳会话。 */
let currentSessionId = '';

// ── 倒计时进度条（与自动收起共用同一个时钟）────────────────────────────────
let progressRaf = null;
/** 已经流逝掉的毫秒数（暂停时累计，恢复时接着算）。 */
let progressElapsed = 0;
/** 本段连续运行 startedAt（performance.now）。 */
let progressStartedAt = 0;
let progressRunning = false;

function paintProgress(leftRatio) {
  // 从右往左裁：右侧已流逝的部分直接消失（背景渐变本身不动）。
  const cut = ((1 - leftRatio) * 100).toFixed(2);
  progressFill.style.clipPath = 'inset(0 ' + cut + '% 0 0)';
}

function progressTick(now) {
  progressRaf = null;
  if (!progressRunning) return;
  const used = progressElapsed + (now - progressStartedAt);
  const left = Math.max(0, 1 - used / AUTO_HIDE_MS);
  paintProgress(left);
  if (left <= 0) return;
  progressRaf = requestAnimationFrame(progressTick);
}

function startProgress() {
  if (progressRaf !== null) { cancelAnimationFrame(progressRaf); progressRaf = null; }
  progressElapsed = 0;
  progressStartedAt = performance.now();
  progressRunning = true;
  progressFill.classList.remove('paused');
  progressFill.classList.add('running');
  paintProgress(1);
  progressRaf = requestAnimationFrame(progressTick);
}

function pauseProgress() {
  if (!progressRunning) return;
  if (progressRaf !== null) { cancelAnimationFrame(progressRaf); progressRaf = null; }
  progressElapsed += performance.now() - progressStartedAt;
  progressRunning = false;
  // running / paused 互斥：两个都挂着虽然靠 CSS 先后能生效，但状态类要能
  // 直接反映真值（排查时看 className 就该知道当前是跑着还是停着）。
  progressFill.classList.remove('running');
  progressFill.classList.add('paused');
}

/** 恢复倒计时；剩余时间已归零时直接收起。 */
function resumeProgress() {
  if (progressRunning) return;
  progressFill.classList.remove('paused');
  if (progressElapsed >= AUTO_HIDE_MS) { startHide(); return; }
  progressStartedAt = performance.now();
  progressRunning = true;
  progressFill.classList.remove('paused');
  progressFill.classList.add('running');
  progressRaf = requestAnimationFrame(progressTick);
}

function stopProgress() {
  if (progressRaf !== null) { cancelAnimationFrame(progressRaf); progressRaf = null; }
  progressRunning = false;
  progressFill.classList.remove('running');
  progressFill.classList.remove('paused');
}

// ── 收起 / 定时 ─────────────────────────────────────────────────────────────

function clearTimers() {
  if (hideTimer !== null) { clearTimeout(hideTimer); hideTimer = null; }
  if (outTimer !== null) { clearTimeout(outTimer); outTimer = null; }
}

/** 播退场动画，动画结束再让主进程隐藏窗口（避免「啪」地消失）。 */
function startHide() {
  if (stageEl.classList.contains('leaving')) return;
  stopProgress();
  stageEl.classList.add('leaving');
  outTimer = setTimeout(() => {
    outTimer = null;
    stageEl.classList.remove('leaving');
    if (api && typeof api.dismiss === 'function') api.dismiss();
  }, OUT_MS);
}

function scheduleHide() {
  if (hideTimer !== null) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    // 悬停中到点不收：等 mouseleave 由 resumeProgress 触发（暂停即续算）。
    if (!hovered) startHide();
  }, AUTO_HIDE_MS);
}

// ── 文案拆分 ────────────────────────────────────────────────────────────────

/**
 * 从 meta 里剥出耗时文案。
 *
 * host 传来的 meta 是 body 除第一行外的其余部分拼接（回答摘要 + 「耗时 x」），
 * 所以耗时可能黏在末尾，也可能整段就是耗时。剥出来的耗时单独放右对齐位，
 * 剩下的才是有信息量的回答摘要。
 *
 * 判据是从**最后一次**出现的「耗时」切到尾，不用带 \S+ 的正则：耗时文案有
 * 「耗时 42 秒」这种带空格的形式，\S+ 只会吃到「42」，尾巴会留在摘要里。
 */
function splitMeta(raw) {
  const text = String(raw || '').trim();
  if (text === '') return { elapsed: '', rest: '' };
  const at = text.lastIndexOf('耗时');
  if (at >= 0 && (at === 0 || /\s/.test(text.charAt(at - 1)))) {
    return { elapsed: text.slice(at).trim(), rest: text.slice(0, at).trim() };
  }
  return { elapsed: '', rest: text };
}

/**
 * 剥掉 host 加在标题上的状态前缀。
 *
 * pill-host 的 noticeContentOf 把 title 拼成「任务完成 · 会话名」/「任务出错 ·
 * 会话名」再交给浮窗，而这里的状态已经由独立的 kicker 行承担——不剥就会看到
 * 「任务完成」压着「任务完成 · 新会话」两行重复。失败与否看 kind 就够了。
 */
function stripStatusPrefix(title) {
  return String(title || '').replace(/^\s*任务(?:完成|出错)\s*[·・:：]\s*/, '').trim();
}

/** 会话标题过长时按字符截断（sessionId 之类的兜底标题不该撑满一行）。 */
function clip(text, max) {
  const value = String(text || '');
  return value.length <= max ? value : value.slice(0, max) + '…';
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

/** 重播整卡的入场编排：摘掉 .anim、强制 reflow、再挂回去。 */
function replayIntro() {
  stageEl.classList.remove('leaving');
  stageEl.classList.remove('anim');
  void stageEl.offsetHeight; // 强制 reflow，动画才会从头播
  stageEl.classList.add('anim');
}

/** 把文本塞进卡片并量出高度回报主进程（窗口高度要贴着内容）。 */
function render(payload) {
  const data = payload || {};
  const kind = data.kind === 'error' ? 'error' : 'done';
  document.body.dataset.kind = kind;
  document.body.dataset.theme = data.theme === 'dark' ? 'dark' : 'light';

  // 语义图标只留一个（对勾 / 感叹号各自的描画动画都挂在 .draw 上）。
  // ⚠ 用的是 svg 元素的 style.display，所以值必须是 'none' / 'block'
  // （空串会回落到 HTML 属性的默认值，导致两个图标同时出现）。
  iconCheck.style.display = kind === 'error' ? 'none' : 'block';
  iconWarn.style.display = kind === 'error' ? 'block' : 'none';
  kickerEl.textContent = kind === 'error' ? '任务出错' : '任务完成';

  const parts = splitMeta(data.meta);
  const session = clip(stripStatusPrefix(data.title), 30);
  const body = String(data.text || '').trim();

  // 标题位永远是会话标题（拿不到时留空并整行隐藏），正文位才是问题摘要。
  titleEl.textContent = session;
  titleEl.style.display = session !== '' ? 'block' : 'none';

  textEl.textContent = body;
  textEl.style.display = body !== '' ? '-webkit-box' : 'none';

  summaryEl.textContent = parts.rest;
  summaryEl.style.display = parts.rest !== '' ? '' : 'none';

  metaEl.textContent = parts.elapsed;
  metaEl.style.display = parts.elapsed !== '' ? '' : 'none';

  currentSessionId = typeof data.sessionId === 'string' ? data.sessionId : '';

  replayIntro();
  clearTimers();
  hovered = false;
  startProgress();
  scheduleHide();

  // ⚠ **同步**量高，不要包 requestAnimationFrame：窗口首次显示前是隐藏的，
  // Chromium 会完全暂停隐藏窗口的 rAF（backgroundThrottling:false 也救不回
  // 来，实测），于是尺寸回报永远等不到，主进程只能走兜底定时器才露面。
  // 同步读 offsetHeight 会强制布局，拿到的就是换行/截断后的最终高度。
  reportHeight();
}

/**
 * 回报内容高度（主进程据此把窗口贴到卡片，宽度固定）。
 *
 * 两个必须注意的点：
 *  1. 用 offsetHeight 而不是 getBoundingClientRect：入场动画里有
 *     scale(0.955)，rect 会把缩放算进去——动画没播完时量到的高度比实际小
 *     一截，窗口就会裁掉卡片底部的阴影。offsetHeight 是布局高度，不受
 *     transform 影响。
 *  2. #stage 的上下外边距是给阴影留的透明区，offsetHeight 不含外边距，
 *     要自己加回来；否则卡片下沿的阴影会被窗口边界裁成一条硬边。
 */
function reportHeight() {
  const cs = getComputedStyle(stageEl);
  const marginY = parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
  const h = Math.ceil(stageEl.offsetHeight + (Number.isFinite(marginY) ? marginY : 0));
  if (h > 0 && api && typeof api.resize === 'function') api.resize(h);
}

// ── 交互 ────────────────────────────────────────────────────────────────────

// 卡片悬停：暂停自动收起与倒计时（用户正在读）。
card.addEventListener('mouseenter', () => {
  hovered = true;
  pauseProgress();
});
card.addEventListener('mouseleave', () => {
  hovered = false;
  resumeProgress();
});

// 点击卡片：唤起主窗 + 跳进对应会话（打开界面时不需要动效，直接消失）。
card.addEventListener('click', (event) => {
  if (event.target === closeBtn || closeBtn.contains(event.target)) return;
  clearTimers();
  stopProgress();
  if (api && typeof api.click === 'function') api.click(currentSessionId);
  if (api && typeof api.dismiss === 'function') api.dismiss();
});
card.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    card.click();
  }
});

// 关闭按钮：直接收。
closeBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  clearTimers();
  startHide();
});

// 主进程推新通知（复用同一个窗口）。
if (api && typeof api.onShow === 'function') api.onShow(render);

// 告诉主进程：渲染侧已就绪，可以发第一条了（避免 show 早于监听注册而丢消息）。
if (api && typeof api.ready === 'function') api.ready();
