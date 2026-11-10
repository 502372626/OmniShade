// OmniShade 发布通道 · 非打断更新入口
// 由 ui_shim 注入 index.html(与官网入口同一注入点)。数据面全部来自 preload:
//   window.omnishade.latestUpdate.{status,check,open,onAvailable}
// 本脚本只负责"显示一个不挡路的入口", 不下载、不安装、不轮询网络。
// 无 preload 的普通浏览器环境(例如直接开 http://127.0.0.1:9435/)没有 IPC 面, 直接退出。
(function () {
  'use strict';
  var api = window.omnishade && window.omnishade.latestUpdate;
  if (!api || typeof api.status !== 'function' || typeof api.open !== 'function') return;

  var DISMISS_KEY = 'omni-latest-update-dismissed';
  var state = null;          // 主进程下发的 status 快照
  var host = null;           // 挂在 body 上的宿主节点(含 shadow root)
  var ui = null;             // 渲染出来的节点引用

  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }

  // [G102] 按版本记忆（localStorage 而非 sessionStorage）：同一个版本只提示一次，
  // 换新版本会重新提示。会话级记忆会导致"关掉窗口再开又弹"，用户只能被迫每次关。
  function dismissedVersion() {
    try { return window.localStorage.getItem(DISMISS_KEY) || ''; } catch (_) { return ''; }
  }
  function dismiss(version) {
    try { window.localStorage.setItem(DISMISS_KEY, version) ; } catch (_) {}
    hide();
  }

  var STYLE = [
    ':host{all:initial}',
    /* [G105] 原 bottom:52px 压在登录框/输入框上，客户反馈「挡住登录界面点不了」→ 挪到右上角 */
    '.wrap{position:fixed;right:18px;top:64px;z-index:2147483000;font:13px/1.5 "Segoe UI",system-ui,-apple-system,"Microsoft YaHei",sans-serif;color:#1f2937;--omni-line:rgba(15,23,42,.12);--omni-bg:rgba(255,255,255,.97);--omni-muted:#5b6675;--omni-accent:#2563eb}',
    '@media (prefers-color-scheme:dark){.wrap{color:#e5e9f0;--omni-line:rgba(148,163,184,.28);--omni-bg:rgba(24,29,38,.97);--omni-muted:#9aa6b6;--omni-accent:#60a5fa}}',
    '.wrap.omni-dark{color:#e5e9f0;--omni-line:rgba(148,163,184,.28);--omni-bg:rgba(24,29,38,.97);--omni-muted:#9aa6b6;--omni-accent:#60a5fa}',
    'button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--omni-line);background:transparent;color:inherit;padding:6px 12px}',
    'button:focus-visible{outline:2px solid var(--omni-accent);outline-offset:2px}',
    '.pill{display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;border:1px solid var(--omni-line);background:var(--omni-bg);box-shadow:0 8px 24px rgba(15,23,42,.18);cursor:pointer;user-select:none}',
    '.pill:hover{border-color:var(--omni-accent)}',
    '.dot{width:8px;height:8px;border-radius:50%;background:var(--omni-accent);box-shadow:0 0 0 3px rgba(37,99,235,.18)}',
    '.pill b{font-weight:600}',
    '.pill .hint{color:var(--omni-muted);font-size:12px}',
    '.card{width:320px;max-width:calc(100vw - 36px);padding:16px;border-radius:14px;border:1px solid var(--omni-line);background:var(--omni-bg);box-shadow:0 18px 48px rgba(15,23,42,.28)}',
    '.head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}',
    '.head b{font-size:14px;font-weight:650}',
    '.close{border:0;padding:0 2px;font-size:18px;line-height:1;color:var(--omni-muted)}',
    '.meta{margin-top:4px;color:var(--omni-muted);font-size:12px}',
    '.notes{margin-top:10px;max-height:96px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:12.5px}',
    '.sha{margin-top:10px;padding:8px;border-radius:8px;background:rgba(127,127,127,.09);font:11px/1.45 Consolas,ui-monospace,monospace;word-break:break-all;color:var(--omni-muted)}',
    '.actions{display:flex;gap:8px;margin-top:12px}',
    '.primary{background:var(--omni-accent);border-color:transparent;color:#fff;font-weight:600;flex:1}',
    '.primary:disabled{opacity:.6;cursor:default}',
    '.err{margin-top:8px;font-size:12px;color:#dc2626}',
    '.hidden{display:none!important}',
  ].join('\n');

  function ensureDom() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'omni-latest-update-host';
    host.style.all = 'initial';
    var root = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = STYLE;
    var wrap = document.createElement('div');
    wrap.className = 'wrap hidden';
    root.appendChild(style);
    root.appendChild(wrap);

    var pill = document.createElement('div');
    pill.className = 'pill';
    pill.id = 'omni-update-pill';
    pill.setAttribute('role', 'button');
    pill.setAttribute('tabindex', '0');
    var dot = document.createElement('span'); dot.className = 'dot';
    var label = document.createElement('b');
    var hint = document.createElement('span'); hint.className = 'hint'; hint.textContent = '查看';
    pill.appendChild(dot); pill.appendChild(label); pill.appendChild(hint);

    var card = document.createElement('div');
    card.className = 'card hidden';
    var head = document.createElement('div'); head.className = 'head';
    var title = document.createElement('b');
    var close = document.createElement('button');
    close.className = 'close'; close.id = 'omni-update-close'; close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '稍后再说');
    head.appendChild(title); head.appendChild(close);
    var meta = document.createElement('div'); meta.className = 'meta';
    var notes = document.createElement('div'); notes.className = 'notes';
    var sha = document.createElement('div'); sha.className = 'sha';
    var actions = document.createElement('div'); actions.className = 'actions';
    var download = document.createElement('button');
    download.className = 'primary'; download.id = 'omni-update-download'; download.type = 'button'; download.textContent = '下载安装包';
    var later = document.createElement('button');
    later.id = 'omni-update-later'; later.type = 'button'; later.textContent = '稍后';
    actions.appendChild(download); actions.appendChild(later);
    var err = document.createElement('div'); err.className = 'err hidden';
    card.appendChild(head); card.appendChild(meta); card.appendChild(notes); card.appendChild(sha);
    card.appendChild(actions); card.appendChild(err);

    wrap.appendChild(pill); wrap.appendChild(card);
    document.body.appendChild(host);
    ui = { wrap: wrap, pill: pill, label: label, card: card, title: title, meta: meta, notes: notes, sha: sha,
           download: download, later: later, close: close, err: err, cardOpen: false };

    // 跟随页面主题(桌面端亮/暗由 root class 或 data-theme 决定, 不一定等于系统主题)
    var themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    window.addEventListener('pagehide', function () { try { themeObserver.disconnect(); } catch (_) {} }, { once: true });
    applyTheme();

    function toggle(open) {
      ui.cardOpen = open;
      ui.pill.classList.toggle('hidden', open);
      ui.card.classList.toggle('hidden', !open);
    }
    pill.addEventListener('click', function () { toggle(true); });
    pill.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(true); }
    });
    close.addEventListener('click', function () {
      if (state && state.latest) dismiss(state.latest.version); else toggle(false);
    });
    later.addEventListener('click', function () {
      if (state && state.latest) dismiss(state.latest.version); else toggle(false);
    });
    download.addEventListener('click', function () {
      ui.download.disabled = true;
      ui.download.textContent = '正在打开…';
      ui.err.classList.add('hidden');
      Promise.resolve(api.open()).then(function (r) {
        if (r && r.ok) {
          ui.download.textContent = '已在浏览器打开';
        } else {
          ui.download.disabled = false;
          ui.download.textContent = '下载安装包';
          ui.err.textContent = '打开下载地址失败: ' + ((r && r.error) || 'unknown');
          ui.err.classList.remove('hidden');
        }
      }).catch(function (e) {
        ui.download.disabled = false;
        ui.download.textContent = '下载安装包';
        ui.err.textContent = '打开下载地址失败: ' + String((e && e.message) || e);
        ui.err.classList.remove('hidden');
      });
    });
    host.__omniToggle = toggle;
  }

  function hide() {
    if (ui) {
      ui.wrap.classList.add('hidden');
      ui.card.classList.add('hidden');
      ui.pill.classList.remove('hidden');
      ui.cardOpen = false;
    } else if (host) host.style.display = 'none';
  }

  function applyTheme() {
    if (!ui || !ui.wrap) return;
    var de = document.documentElement;
    var dark = false;
    try {
      dark = de.classList.contains('dark') || de.getAttribute('data-theme') === 'dark'
        || (de.dataset && de.dataset.theme === 'dark');
    } catch (_) {}
    ui.wrap.classList.toggle('omni-dark', !!dark);
  }

  function render(snapshot) {
    if (!snapshot || snapshot.phase !== 'update-available' || !snapshot.latest) {
      if (ui) ui.wrap.classList.add('hidden');
      return;
    }
    state = snapshot;
    var latest = snapshot.latest;
    if (dismissedVersion() === latest.version) { hide(); return; }
    // [G105] 登录/注册界面一律不显示：那里每一像素都可点，浮层只会添乱
    try {
      var pwd = document.querySelector('input[type="password"]');
      if (pwd && pwd.offsetParent !== null) { hide(); return; }
      if (document.querySelector('[data-view="auth"], .omni-register, form[data-form="login"]')) { hide(); return; }
    } catch (_) {}
    ensureDom();
    ui.wrap.classList.remove('hidden');
    ui.label.textContent = '新版本 v' + latest.version;
    ui.title.textContent = '发现新版本 v' + latest.version;
    var meta = '当前 v' + snapshot.current;
    if (latest.size) meta += ' · 安装包 ' + formatSize(latest.size);
    ui.meta.textContent = meta;
    ui.notes.textContent = latest.notes || '（发布方未附更新说明）';
    ui.notes.classList.toggle('hidden', !latest.notes);
    ui.sha.textContent = 'SHA-256 ' + latest.sha256;
  }

  function sync() {
    Promise.resolve(api.status()).then(render).catch(function () { /* 主进程不可达: 保持静默, 不干扰聊天 */ });
  }

  if (typeof api.onAvailable === 'function') {
    try { api.onAvailable(render); } catch (_) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync, { once: true });
  else sync();
})();
