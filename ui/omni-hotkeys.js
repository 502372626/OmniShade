/* =============================================================================
 * omni-hotkeys.js — [UX-HOTKEYS 2026-11-08] 全局快捷键体系（桌面肌肉记忆层）
 * -----------------------------------------------------------------------------
 * 键位（与 LibreChat 原生零冲突——assets 全量扫描结论，见 perf-report/ui-interact/REPORT.md）：
 *   Ctrl+K  聚焦侧栏搜索框     （原生等价物 Ctrl+/，本键为桌面习惯别名）
 *   Ctrl+N  新会话             （原生等价物 Ctrl+Shift+O；点击 a[href="/c/new"]
 *                                走 LibreChat 原生 onClick，不绕 React 路由）
 *   Ctrl+L  聚焦聊天输入框     （原生等价物 Shift+Esc）
 *   Ctrl+F  页内查找           （消息区 Range 查找 + CSS Custom Highlight API，
 *                                Electron 33 = Chromium 130 原生支持；不改 DOM 树，
 *                                不碰 React 托管节点，流式重渲不炸）
 *   Esc     逐级关闭浮层       （① 本模块查找条 ② omni-auto-drawer 抽屉；
 *                                原生 radix/headlessui 浮层自己处理 Esc，本模块不拦截）
 *
 * 原生占用位（本模块禁入，扫描自 hooks.b0NSLXq6.js 快捷键注册表）：
 *   Ctrl+Shift+O/S/M/K/L/X/E/I/Y/U/B/C/V/./;/,  Ctrl+/  Shift+Esc  Ctrl+M
 *   Shift+Alt+L(语音) Shift+Alt+M  Ctrl+Enter 系  Ctrl+S  F12/Ctrl+Shift+I/J/C(反调试拦)
 * → 本模块只绑裸 Ctrl+<k|n|l|f>（strict 校验 shift/alt 未按下），Ctrl+Shift+K 等
 *   原生键不会被劫持。
 *
 * 焦点可达性（全键盘路径）：
 *   - 抽屉打开 → 焦点移入首个可聚焦元素，关闭钮 .x 补 tabindex=0/role=button；
 *     Tab 在抽屉内循环（trap），关闭后焦点还原到打开前的元素。
 *     （外部接管 omni-auto-panel.js，不改其源码：关闭通过点击其 .x 关闭钮，
 *     走原生 close() 连轮询定时器一起清。）
 *   - 查找条 role=dialog，Tab 在条内循环，Esc 关闭并还原焦点。
 *   - 空会话欢迎区注入快捷键速查条（document.body 级 fixed，不碰 React 树）。
 *
 * 注入：ui_shim injectHotkeysEntry → <script src="/omni-hotkeys.js" defer>
 * 幂等：window.__OMNI_HOTKEYS__ 哨兵，重复注入直接 return。
 * ========================================================================== */
(function () {
  'use strict';
  if (window.__OMNI_HOTKEYS__) return;                  // 幂等：防 shim 重复注入二次注册
  window.__OMNI_HOTKEYS__ = true;

  /* ── DOM 锚点（全部实锤自 assets/index.Bx_aOP0E.js + hooks.b0NSLXq6.js）──── */
  // 侧栏搜索框：aria-keyshortcuts 恒为 Control+/（Windows）/ Meta+/（macOS）
  function findSearchBox() {
    var el = document.querySelector('input[aria-keyshortcuts="Control+/"], input[aria-keyshortcuts="Meta+/"]');
    if (el) return el;
    // 次级锚点：侧栏容器内带 placeholder 的文本输入（react-vtree 搜索框本体）
    return document.querySelector('nav input[placeholder]:not([type="hidden"]), aside input[placeholder]:not([type="hidden"])');
  }
  // 新会话：LibreChat 原生三个入口锚（header/nav-fab/sidebar），点击走原生 onClick
  function findNewChatAnchor() {
    var list = document.querySelectorAll('a[href="/c/new"]');
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      var rect = a.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return a;  // 首个可见入口（侧栏折叠时 header 仍在）
    }
    return null;
  }
  // 聊天输入框：镜像产物 composer 带 omni-native-composer 类
  function findComposer() {
    return document.querySelector('textarea.omni-native-composer')
      || document.querySelector('main[role="main"] form textarea')
      || document.querySelector('main[role="main"] textarea');
  }

  /* ── 动作 ─────────────────────────────────────────────────────────────── */
  function actFocusSearch() {
    var box = findSearchBox();
    if (box) { box.focus(); try { box.select(); } catch (_) {} }
  }
  function actNewChat() {
    var a = findNewChatAnchor();
    if (a) a.click();                                   // 原生 onClick → 乐观新会话导航
  }
  function actFocusComposer() {
    var ta = findComposer();
    if (ta) {
      ta.focus();
      var len = ta.value ? ta.value.length : 0;
      try { ta.setSelectionRange(len, len); } catch (_) {}   // 光标落末尾（textarea 语义）
    }
  }

  /* ── 页内查找（Ctrl+F）───────────────────────────────────────────────────
   * 引擎：TreeWalker 遍历 main[role="main"] 文本节点 → indexOf 命中 → Range →
   * CSS.highlights 注册（::highlight() 伪元素着色）。零 DOM 变更：不改 React
   * 托管节点，流式重渲/会话切换不会因虚拟 DOM 与真实 DOM 脱节而崩。
   * Electron 33（Chromium 130）确定性支持，无降级路径。 */
  var findBar = null, findInput = null, findCount = null;
  var findRanges = [], findPos = -1, findSavedFocus = null;
  var HL_ALL = 'omni-find-hl', HL_ACTIVE = 'omni-find-hl-active';
  var searchTimer = null, streamObs = null;

  function buildFind() {
    var st = document.createElement('style');
    st.textContent = [
      '#omni-find-bar{position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:100000;',
      '  display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:10px;',
      '  background:rgba(13,18,26,.94);border:1px solid rgb(var(--border-medium,54 73 93));',
      '  box-shadow:0 10px 30px -12px rgba(0,0,0,.6);}',
      '#omni-find-bar[hidden]{display:none !important;}',   // display:flex 会盖掉 [hidden] 的 UA 样式——必须显式压制
      '#omni-find-bar input{width:230px;background:rgb(var(--surface-secondary,11 16 23));',
      '  border:1px solid rgb(var(--border-medium,54 73 93));border-radius:8px;padding:6px 10px;',
      '  color:rgb(var(--text-primary,233 237 245));font-size:13px;outline:none;}',
      '#omni-find-bar input:focus{border-color:rgb(var(--accent-primary,91 140 255));}',
      '#omni-find-bar span.cnt{font-size:12px;color:rgb(var(--text-secondary,180 193 206));',
      '  font-variant-numeric:tabular-nums;min-width:46px;text-align:center;}',
      '#omni-find-bar button{width:28px;height:28px;border:none;border-radius:7px;cursor:pointer;',
      '  background:rgb(var(--surface-secondary,11 16 23));color:rgb(var(--text-secondary,180 193 206));',
      '  font-size:13px;line-height:1;}',
      '#omni-find-bar button:hover{background:rgb(var(--surface-active,30 41 59));color:rgb(var(--text-primary,233 237 245));}',
      '::highlight(omni-find-hl){background-color:rgba(250,204,21,.34);}',
      '::highlight(omni-find-hl-active){background-color:rgb(250 204 21);color:#10151d;}',
    ].join('\n');
    document.head.appendChild(st);

    findBar = document.createElement('div');
    findBar.id = 'omni-find-bar';
    findBar.setAttribute('role', 'dialog');
    findBar.setAttribute('aria-label', '页内查找');
    findBar.hidden = true;
    findBar.innerHTML =
      '<input type="text" placeholder="查找会话内容…" aria-label="查找内容" spellcheck="false">' +
      '<span class="cnt" id="omni-find-count">0/0</span>' +
      '<button type="button" data-testid="omni-find-prev" aria-label="上一个匹配">↑</button>' +
      '<button type="button" data-testid="omni-find-next" aria-label="下一个匹配">↓</button>' +
      '<button type="button" data-testid="omni-find-close" aria-label="关闭查找">✕</button>';
    document.body.appendChild(findBar);

    findInput = findBar.querySelector('input');
    findCount = findBar.querySelector('#omni-find-count');
    findBar.querySelector('[data-testid="omni-find-prev"]').addEventListener('click', function () { step(-1); });
    findBar.querySelector('[data-testid="omni-find-next"]').addEventListener('click', function () { step(1); });
    findBar.querySelector('[data-testid="omni-find-close"]').addEventListener('click', closeFind);

    findInput.addEventListener('input', function () {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { searchAll(findInput.value); if (findRanges.length) { findPos = -1; step(1); } }, 150);
    });
    findInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }   // Enter=下一个 Shift+Enter=上一个
    });
    // 流式生成时消息节点持续插入 → 防抖重查，命中列表不过期
    // [G95] observe 移到 openFind（关闭态不再收全量 mutation），closeFind 里 disconnect
    streamObs = new MutationObserver(function () {
      if (!findBar || findBar.hidden || !findInput.value) return;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { searchAll(findInput.value); }, 300);
    });
  }

  function clearHighlights() {
    try { CSS.highlights.delete(HL_ALL); CSS.highlights.delete(HL_ACTIVE); } catch (_) {}
  }
  function updateCount() {
    if (findCount) findCount.textContent = (findRanges.length ? (findPos + 1) : 0) + '/' + findRanges.length;
  }
  function searchAll(q) {
    clearHighlights();
    findRanges = []; findPos = -1;
    if (!q) { updateCount(); return; }
    var root = document.querySelector('main[role="main"]');       // 只查消息区，不扫侧栏/弹窗噪音
    if (!root) { updateCount(); return; }
    var ql = q.toLowerCase();
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || n.nodeValue.trim().length === 0) return NodeFilter.FILTER_REJECT;
        var p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest('script, style, noscript, textarea, input, select, [contenteditable]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    var hl = new Highlight();
    var node, ranges = [];
    while ((node = walker.nextNode())) {
      var text = node.nodeValue.toLowerCase(), from = 0, idx;
      while ((idx = text.indexOf(ql, from)) !== -1) {
        try {
          var r = document.createRange();
          r.setStart(node, idx); r.setEnd(node, idx + q.length);
          ranges.push(r); hl.add(r);
        } catch (_) { break; }                                     // 节点在流式中被换掉 → 该节点放弃
        from = idx + q.length;
      }
    }
    findRanges = ranges;
    if (ranges.length) CSS.highlights.set(HL_ALL, hl);
    updateCount();
  }
  function step(dir) {
    if (!findRanges.length) { updateCount(); return; }
    findPos = (findPos + dir + findRanges.length) % findRanges.length;
    try { CSS.highlights.set(HL_ACTIVE, new Highlight(findRanges[findPos])); } catch (_) {}
    var el = findRanges[findPos].startContainer.parentElement;     // 滚到当前命中（块居中）
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
    updateCount();
    // 命中若落在 omni-history-more 折叠区（display:none），提示展开——只报不猜
    if (el && el.offsetParent === null) { if (findCount) findCount.textContent = '已折叠/'; }
  }
  function openFind() {
    try { if (streamObs) streamObs.observe(document.body, { childList: true, subtree: true }); } catch (_) {}
    if (!findBar) buildFind();
    if (findBar.hidden) {
      findSavedFocus = document.activeElement;
      findBar.hidden = false;
      var sel = String(window.getSelection && window.getSelection() || '');
      if (sel && sel.length && sel.length <= 64) findInput.value = sel;  // 浏览器惯例：带选区预填
      findInput.focus(); findInput.select();
      if (findInput.value) { searchAll(findInput.value); if (findRanges.length) {
    try { if (streamObs) streamObs.disconnect(); } catch (_) {} findPos = -1; step(1); } }
    } else { findInput.focus(); findInput.select(); }
  }
  function closeFind() {
    if (!findBar || findBar.hidden) return false;
    findBar.hidden = true;
    clearHighlights();
    findRanges = []; findPos = -1;
    findInput.value = '';
    updateCount();
    if (findSavedFocus && findSavedFocus.focus) { try { findSavedFocus.focus(); } catch (_) {} }
    findSavedFocus = null;
    return true;
  }

  /* ── Esc 逐级关闭（bubble 相：让 radix/headlessui 原生浮层先处理）───────── */
  function onEsc(e) {
    if (e.isComposing || e.key === 'Process') return;              // IME 组合中不劫持
    if (e.defaultPrevented) return;                                // 原生浮层已消费 → 不抢
    if (e.ctrlKey || e.metaKey || e.altKey) return;                // Shift+Esc 是原生 focusChat
    if (closeFind()) { e.preventDefault(); e.stopPropagation(); return; }        // ① 查找条（最顶）
    var drawer = document.getElementById('omni-auto-drawer');      // ② 自动化抽屉
    if (drawer && drawer.classList.contains('on')) {
      var x = drawer.querySelector('.x');
      if (x) { x.click(); e.preventDefault(); e.stopPropagation(); }             // 走原生 close()（连轮询定时器一起清）
      return;
    }
    // ③ LibreChat 原生浮层（radix/headlessui）：自带 Esc 关闭，不拦截
  }

  /* ── 抽屉焦点可达性（外部接管 omni-auto-panel.js，不改其源码）──────────── */
  var drawerWasOpen = false, drawerPrevFocus = null;
  function firstFocusable(container) {
    if (!container) return null;
    var els = container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.disabled || el.offsetParent === null) continue;
      return el;
    }
    return null;
  }
  function lastFocusable(container) {
    if (!container) return null;
    var els = container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    for (var i = els.length - 1; i >= 0; i--) {
      var el = els[i];
      if (el.disabled || el.offsetParent === null) continue;
      return el;
    }
    return null;
  }
  function pollDrawerFocus() {
    var drawer = document.getElementById('omni-auto-drawer');
    var open = !!(drawer && drawer.classList.contains('on'));
    if (open === drawerWasOpen) return;
    drawerWasOpen = open;
    if (open) {
      drawerPrevFocus = document.activeElement;
      var x = drawer && drawer.querySelector('.x');                // 关闭钮是 <span>——补键盘可达性
      if (x && !x.hasAttribute('tabindex')) {
        x.tabIndex = 0;
        x.setAttribute('role', 'button');
        x.setAttribute('aria-label', '关闭自动化中心');
        x.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); x.click(); }
        });
      }
      var first = firstFocusable(drawer);
      if (first) first.focus();
    } else if (drawerPrevFocus && drawerPrevFocus.focus) {
      try { drawerPrevFocus.focus(); } catch (_) {}                 // 关闭后焦点还原
      drawerPrevFocus = null;
    }
  }

  /* ── 欢迎速查条已按老板口径移除（2026-11-09）——快捷键能力保留在全局键派发与 ? 面板 ──

  /* ── 全局键派发（bubble 相，单监听器）──────────────────────────────────── */
  document.addEventListener('keydown', function (e) {
    if (e.isComposing || e.key === 'Process') return;              // 中文 IME 组合中一律放行
    if (e.key === 'Escape') { onEsc(e); return; }
    if (e.key === 'Tab') { onTab(e); return; }
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.shiftKey || e.altKey) return;                            // Ctrl+Shift/Ctrl+Alt 全是原生位，禁入
    var k = (e.key || '').toLowerCase();
    if (k === 'k') { e.preventDefault(); actFocusSearch(); }
    else if (k === 'n') { e.preventDefault(); actNewChat(); }
    else if (k === 'l') { e.preventDefault(); actFocusComposer(); }
    else if (k === 'f') { e.preventDefault(); openFind(); }
  });

  /* Tab trap：抽屉/查找条内循环（浮层在顶时 Tab 不外泄到页面底层） */
  function onTab(e) {
    var scope = null;
    if (findBar && !findBar.hidden) scope = findBar;
    else if (drawerWasOpen) scope = document.getElementById('omni-auto-drawer');
    if (!scope) return;
    var active = document.activeElement;
    var inScope = active && scope.contains(active);
    var first = firstFocusable(scope), last = lastFocusable(scope);
    if (!first || !last) return;
    if (e.shiftKey && (!inScope || active === first)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (!inScope || active === last)) { e.preventDefault(); first.focus(); }
  }

  /* ── 轮询驱动（同 omni-history-more.js 模式：无 observer 泄漏、开销 O(1)）── */
  setInterval(function () {
    pollDrawerFocus();
  }, 600);

  /* ── E2E 测试面（test_*.js 断言用，不参与业务）────────────────────────── */
  window.__omniHotkeys = {
    version: '1.0',
    openFind: openFind,
    closeFind: closeFind,
    state: function () { return { findOpen: !!(findBar && !findBar.hidden), matches: findRanges.length, pos: findPos }; },
  };
})();
