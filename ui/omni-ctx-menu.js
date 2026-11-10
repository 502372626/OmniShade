/* =============================================================================
 * omni-ctx-menu.js — [UX-CTXMENU 2026-11-07b] 会话列表右键视觉反馈（精简版）
 * -----------------------------------------------------------------------------
 * 职责收敛：菜单判定与原生菜单触发已全权移交 main.js（主进程 executeJavaScript
 * 异步查 DOM——渲染层 preventDefault 挡不住主进程 context-menu 事件，老板实测
 * 弹了通用菜单的教训）。本文件只保留：右键命中会话项时的一瞬高亮锚点反馈。
 * 注入：ui_shim injectCtxMenuEntry → <script src="/omni-ctx-menu.js" defer>
 * ========================================================================== */
(function () {
  'use strict';
  var style = document.createElement('style');
  style.textContent = 'div.group.omni-ctx-hot{outline:1px solid var(--accent-primary,#5b8cff);outline-offset:-1px;}';
  document.head.appendChild(style);
  document.addEventListener('contextmenu', function (e) {
    var row = e.target.closest && e.target.closest('div.group');
    if (!row || !row.querySelector || !row.querySelector('button')) return;
    row.classList.add('omni-ctx-hot');
    setTimeout(function () { row.classList.remove('omni-ctx-hot'); }, 600);
  }, true);
})();
