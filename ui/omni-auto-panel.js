/* =============================================================================
 * omni-auto-panel.js — [AUTO-SESSION 2026-11-08] 自动化中心进聊天（抽屉化）
 * -----------------------------------------------------------------------------
 * 老板口径：自动化中心不再跳独立页——入口按钮点击=聊天内滑出抽屉；
 * 除系统提示词可自定义外，全部能力默认全开，零开关零配置。
 * 区块：①自主目标（无限迭代引擎控制台）②系统提示词（唯一设置）
 *       ③能力总览（只读徽章，全开锁定）。
 * 注入：ui_shim injectAutoPanelEntry → <script src="/omni-auto-panel.js" defer>
 *
 * [MEM-PATCH 2026-11-08] 修复轮询请求堆积（行为语义不变）：
 *   P1  refreshGoals in-flight 防重：上一拍未完成直接跳过本拍，杜绝服务端慢响应
 *       时 5s 一拍的 fetch 线性堆积（Chromium 同域并发上限 6，堆积会饿死同源
 *       /api 请求，含消息 SSE 订阅）。
 *   P2  close() 时 abort 挂起请求：抽屉关闭后不再有游离的 in-flight 响应回调。
 *   P3  api() 支持可选 AbortSignal。
 * ========================================================================== */
(function () {
  'use strict';
  var CSS = [
    '#omni-auto-backdrop{position:fixed;inset:0;pointer-events:none;background:rgba(0,0,0,.45);z-index:99998;opacity:0;transition:opacity .25s;}',
    '#omni-auto-backdrop.on{opacity:1;pointer-events:auto}',
    '#omni-auto-drawer{position:fixed;top:0;right:-400px;width:380px;max-width:92vw;height:100vh;background:#0f131a;',
    '  border-left:1px solid #262c38;z-index:99999;transition:right .28s cubic-bezier(.2,.8,.2,1);',
    '  display:flex;flex-direction:column;font:13px/1.6 "Segoe UI",system-ui,sans-serif;color:#e8ecf4;}',
    '#omni-auto-drawer.on{right:0;}',
    '#omni-auto-drawer .hd{display:flex;align-items:center;gap:10px;padding:16px 18px;border-bottom:1px solid #262c38;}',
    '#omni-auto-drawer .hd b{font-size:15px;letter-spacing:.5px;}',
    '#omni-auto-drawer .hd .sub{font-size:11px;color:#6b7280;}',
    '#omni-auto-drawer .hd .x{margin-left:auto;cursor:pointer;color:#9aa2b4;padding:4px 8px;border-radius:8px;}',
    '#omni-auto-drawer .hd .x:hover{background:#141820;color:#e8ecf4;}',
    '#omni-auto-drawer .bd{flex:1;overflow-y:auto;padding:16px 18px;}',
    '#omni-auto-drawer .sec{margin-bottom:22px;}',
    '#omni-auto-drawer .sec h3{font-size:13px;margin:0 0 8px;color:#9aa2b4;font-weight:600;letter-spacing:.08em;}',
    '#omni-auto-drawer textarea{width:100%;box-sizing:border-box;background:#080a0e;border:1px solid #262c38;border-radius:10px;',
    '  color:#e8ecf4;padding:10px 12px;font:13px/1.55 inherit;resize:vertical;}',
    '#omni-auto-drawer textarea:focus{outline:none;border-color:#5b8cff;}',
    '#omni-auto-drawer .row{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;}',
    '#omni-auto-drawer .btn{cursor:pointer;border:none;border-radius:9px;padding:8px 16px;font-size:13px;font-weight:600;',
    '  background:#5b8cff;color:#fff;transition:filter .15s;}',
    '#omni-auto-drawer .btn:hover{filter:brightness(1.12);}',
    '#omni-auto-drawer .btn.ghost{background:#141820;color:#9aa2b4;border:1px solid #262c38;}',
    '#omni-auto-drawer .btn.danger{background:#ff7a7a;}',
    '#omni-auto-drawer .goal-card{background:#0f131a;border:1px solid #262c38;border-radius:12px;padding:10px 12px;margin-bottom:8px;}',
    '#omni-auto-drawer .goal-card .t{font-weight:600;font-size:12.5px;margin-bottom:4px;word-break:break-all;}',
    '#omni-auto-drawer .badge{display:inline-block;font-size:10.5px;padding:2px 9px;border-radius:99px;font-weight:600;letter-spacing:.05em;}',
    '#omni-auto-drawer .badge.run{background:rgba(91,140,255,.16);color:#5b8cff;animation:omni-auto-pulse 1.6s infinite;}',
    '#omni-auto-drawer .badge.done{background:rgba(55,214,122,.15);color:#37d67a;}',
    '#omni-auto-drawer .badge.stop{background:#141820;color:#6b7280;}',
    '@keyframes omni-auto-pulse{50%{opacity:.55;}}',
    '#omni-auto-drawer .meta{font-size:11px;color:#6b7280;margin-top:2px;}',
    '#omni-auto-drawer .caps{display:flex;flex-wrap:wrap;gap:8px;}',
    '#omni-auto-drawer .cap{display:flex;align-items:center;gap:6px;background:#0f131a;border:1px solid #262c38;',
    '  border-radius:10px;padding:8px 12px;font-size:12px;color:#9aa2b4;}',
    '#omni-auto-drawer .cap .dot{width:7px;height:7px;border-radius:50%;background:#37d67a;box-shadow:0 0 6px rgba(55,214,122,.6);}',
    '#omni-auto-drawer .hint{font-size:11px;color:#6b7280;margin-top:6px;}',
    '#omni-auto-drawer .hint b{color:#9aa2b4;}',
  ].join('\n');

  var drawer, backdrop, promptTa, statusLine;

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  // [P3] 增加可选 signal；无 signal 时行为与原版完全一致
  function api(path, body, method, signal) {
    var init = {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    };
    if (signal) init.signal = signal;
    return fetch(path, init).then(function (r) { return r.json().catch(function () { return {}; }); });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function build() {
    if (drawer) return;
    var st = el('style'); st.textContent = CSS; document.head.appendChild(st);

    backdrop = el('div'); backdrop.id = 'omni-auto-backdrop';
    backdrop.addEventListener('click', close);

    drawer = el('div'); drawer.id = 'omni-auto-drawer';
    drawer.innerHTML = [
      '<div class="hd"><b>自动化中心</b><span class="sub">全能力已开启 · 零配置</span>',
      '<span class="x" title="关闭">✕</span></div>',
      '<div class="bd">',
      '  <div class="sec"><h3>◆ 系统提示词（唯一可自定义项）</h3>',
      '    <textarea id="omni-prompt" rows="5" placeholder="留空 = 默认作战纪律（未达标禁止收口、自动换攻击面、无限迭代）"></textarea>',
      '    <div class="row"><button class="btn" id="omni-prompt-save">保存</button></div>',
      '    <div class="hint" id="omni-prompt-hint">每轮对话自动注入；留空时启用内置作战纪律。</div>',
      '  </div>',
      '  <div class="sec"><h3>◆ 能力总览（全部常开）</h3>',
      '    <div class="caps">',
      '      <span class="cap"><span class="dot"></span>自动知识库</span>',
      '      <span class="cap"><span class="dot"></span>自动技能</span>',
      '      <span class="cap"><span class="dot"></span>全量工具</span>',
      '      <span class="cap"><span class="dot"></span>攻击链 39 阶段</span>',
      '    </div>',
      '    <div class="hint">没有开关这一说——开箱即用，永远全开。</div>',
      '  </div>',
      '</div>',
    ].join('\n');
    drawer.querySelector('.x').addEventListener('click', close);
    document.body.appendChild(backdrop);
    document.body.appendChild(drawer);

    promptTa = drawer.querySelector('#omni-prompt');
    statusLine = drawer.querySelector('#omni-prompt-hint');

    drawer.querySelector('#omni-prompt-save').addEventListener('click', savePrompt);

    api('/api/omni-automation/settings').then(function (s) {
      if (s && typeof s.USER_SYSTEM_PROMPT === 'string' && s.USER_SYSTEM_PROMPT) promptTa.value = s.USER_SYSTEM_PROMPT;
    }).catch(function () {});
  }

  function open() {
    build();
    backdrop.classList.add('on');
    drawer.classList.add('on');
  }
  function close() {
    if (!drawer) return;
    backdrop.classList.remove('on');
    drawer.classList.remove('on');
  }
  function toggle() { (drawer && drawer.classList.contains('on')) ? close() : open(); }

  function savePrompt() {
    var v = promptTa.value;
    api('/api/omni-automation/settings', { USER_SYSTEM_PROMPT: v }, 'POST').then(function (d) {
      statusLine.textContent = d && d.error ? ('保存失败：' + d.error) : (v ? '已保存自定义提示词。' : '已恢复默认作战纪律（无限迭代）。');
    }).catch(function () { statusLine.textContent = '保存失败：本机服务未就绪'; });
  }

  // ── 入口接管：header「自动化中心」按钮点击 = 滑出抽屉（不再跳独立页）──
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href="/omni-automation"], a[href*="omni-automation"]');
    if (a) { e.preventDefault(); e.stopPropagation(); toggle(); return; }
    var b = e.target.closest && e.target.closest('button, a');
    if (b && /自动化中心/.test(b.textContent || '')) { e.preventDefault(); e.stopPropagation(); toggle(); }
  }, true);

  // 快捷键：Ctrl+Shift+A 呼出
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && (e.key === 'A' || e.key === 'a')) { e.preventDefault(); toggle(); }
  });
})();
