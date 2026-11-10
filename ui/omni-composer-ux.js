/* =============================================================================
 * omni-composer-ux.js — Composer 输入区体验 shim（OmniShade omni-craft 工艺）
 * -----------------------------------------------------------------------------
 * 对应审计：00-会话督办/06-深度优化/perf-report/ui-composer/COMPOSER-AUDIT.md
 * 配套样式：ui/omni-craft-composer.css（由 index.html 注入，本 shim 不加载 CSS）
 * 用法：    <script src="./omni-composer-ux.js" defer></script>
 * 对外：    window.OmniComposerUX = { version, thresholds, rescan, destroy }
 *
 * 职责（纯视觉反馈层，零业务侵入）：
 *   ① 字符计数徽标：textarea.value.length > 5000 时在 composer 表面右下角
 *      显示「N 字符」；≥5000 warn、≥20000 danger。数据源只读 textarea.value，
 *      不 setAttribute/value 赋值 → 不碰 React 受控状态，不干扰粘贴链路。
 *   ② 粘贴闪光：paste 事件里若剪贴板带文件、或文本 > 2500 字符（对齐 app 的
 *      fl() 折叠阈值），给 composer 表面挂 .omni-composer-paste-flash 950ms。
 *      只 add/remove class，绝不 preventDefault / stopPropagation。
 *
 * 不做兜底实现的原则性说明：本 shim 的所有功能失败时（找不到表面容器等）
 * 直接静默跳过该 composer，不模拟、不降级替代 app 自身行为——主流程
 * （发送/粘贴/折叠）100% 由 app 自己的代码承担，shim 挂了只丢视觉反馈。
 * ========================================================================== */
(function (global) {
  'use strict';

  var VERSION = '1.0.0';
  var COUNTER_VISIBLE_THRESHOLD = 5000; // >5000 才显示（任务口径）
  var DANGER_THRESHOLD = 20000;        // ≥20000 升 danger
  var PASTE_TEXT_FLASH_THRESHOLD = 2500; // 对齐 app fl() 的折叠阈值
  var FLASH_CLASS = 'omni-composer-paste-flash';
  var FLASH_MS = 950;
  var COUNTER_CLASS = 'omni-composer-counter';
  var RESCAN_DEBOUNCE_MS = 250;

  var observers = [];   // 已绑定的 composer 记录: {textarea, surface, counter, timers}
  var bodyObserver = null;
  var rescanTimer = 0;
  var destroyed = false;

  /* ---------------- 工具 ---------------- */

  function closest(el, selector) {
    if (el && el.closest) { return el.closest(selector); }
    for (var n = el; n && n.nodeType === 1; n = n.parentNode) {
      if (n.matches && n.matches(selector)) { return n; }
    }
    return null;
  }

  function findSurface(textarea) {
    var surface = closest(textarea, "[data-testid='composer-surface']");
    if (surface) { return surface; }
    /* 表面缺失（未来 DOM 结构变化）→ 不硬造锚点，返回 null：
       徽标和闪光都跳过，只保留无副作用的监听。不搞 form 兜底 ——
       兜底锚点会把闪光类挂到没有对应 CSS 规则的节点上，掩盖真实问题。 */
    return null;
  }

  /* ---------------- ① 字符计数 ---------------- */

  function updateCounter(entry) {
    if (!entry.counter) { return; }
    var n = 0;
    try { n = (entry.textarea.value || '').length; } catch (_) { n = 0; }

    var show = n > COUNTER_VISIBLE_THRESHOLD;
    if (!show) {
      entry.counter.removeAttribute('data-visible');
      return;
    }
    entry.counter.textContent = n.toLocaleString('en-US') + ' 字符';
    entry.counter.setAttribute('data-level',
      n >= DANGER_THRESHOLD ? 'danger' : 'warn');
    entry.counter.setAttribute('data-visible', 'true');
  }

  /* ---------------- ② 粘贴闪光 ---------------- */

  function flashSurface(entry) {
    var s = entry.surface;
    if (!s || s.getAttribute('data-testid') !== 'composer-surface') { return; }
    s.classList.remove(FLASH_CLASS);
    // 强制 reflow 让连续两次粘贴都能重放动画
    void s.offsetWidth;
    s.classList.add(FLASH_CLASS);
    if (entry.flashTimer) { clearTimeout(entry.flashTimer); }
    entry.flashTimer = setTimeout(function () {
      s.classList.remove(FLASH_CLASS);
      entry.flashTimer = 0;
    }, FLASH_MS);
  }

  function onPaste(evt) {
    var entry = findEntry(this);
    if (!entry) { return; }
    var cd = evt.clipboardData;
    if (cd) {
      if (cd.files && cd.files.length > 0) { flashSurface(entry); return; }
      try {
        if ((cd.getData('text/plain') || '').length > PASTE_TEXT_FLASH_THRESHOLD) {
          flashSurface(entry);
        }
      } catch (_) { /* 某些环境 getData 抛错 → 只是不闪光，粘贴本身不受影响 */ }
    }
  }

  function findEntry(textarea) {
    for (var i = 0; i < observers.length; i++) {
      if (observers[i].textarea === textarea) { return observers[i]; }
    }
    return null;
  }

  /* ---------------- 绑定 / 重扫 ---------------- */

  function bindComposer(textarea) {
    var surface = findSurface(textarea);
    var counter = null;
    if (surface) {
      counter = document.createElement('div');
      counter.className = COUNTER_CLASS;
      counter.setAttribute('aria-hidden', 'true');
      counter.setAttribute('data-level', 'warn');
      surface.appendChild(counter);
    }

    var entry = {
      textarea: textarea,
      surface: surface,
      counter: counter,
      flashTimer: 0,
    };
    observers.push(entry);

    textarea.addEventListener('input', function () { updateCounter(entry); }, false);
    textarea.addEventListener('change', function () { updateCounter(entry); }, false);
    textarea.addEventListener('paste', onPaste, false);

    // 初始（草稿恢复 / 会话切换）读一次
    updateCounter(entry);
  }

  function rescan() {
    if (destroyed) { return; }
    var seen = [];
    var list = document.querySelectorAll(
      "textarea[data-testid='text-input'], textarea#prompt-textarea");
    for (var i = 0; i < list.length; i++) {
      var ta = list[i];
      seen.push(ta);
      if (!findEntry(ta)) { bindComposer(ta); }
    }
    // 卸载已离开 DOM 的 composer（路由切换）
    for (var j = observers.length - 1; j >= 0; j--) {
      if (seen.indexOf(observers[j].textarea) === -1) {
        unbind(observers[j]);
      }
    }
  }

  function unbind(entry) {
    var idx = observers.indexOf(entry);
    if (idx !== -1) { observers.splice(idx, 1); }
    if (entry.flashTimer) { clearTimeout(entry.flashTimer); }
    if (entry.counter && entry.counter.parentNode) {
      entry.counter.parentNode.removeChild(entry.counter);
    }
    if (entry.surface) { entry.surface.classList.remove(FLASH_CLASS); }
  }

  function scheduleRescan() {
    if (rescanTimer) { return; }
    rescanTimer = setTimeout(function () {
      rescanTimer = 0;
      rescan();
    }, RESCAN_DEBOUNCE_MS);
  }

  /* ---------------- 生命周期 ---------------- */

  function init() {
    if (destroyed) { return; }
    rescan();

    // SPA 路由切换 / composer 重建 → 重扫。debounce 250ms，观察 childList
    // 不看属性（输入打字不触发 attributes），开销可控。
    if (!bodyObserver && typeof MutationObserver !== 'undefined') {
      bodyObserver = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          if (muts[i].type === 'childList') { scheduleRescan(); return; }
        }
      });
      bodyObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  function destroy() {
    destroyed = true;
    if (bodyObserver) { bodyObserver.disconnect(); bodyObserver = null; }
    if (rescanTimer) { clearTimeout(rescanTimer); rescanTimer = 0; }
    while (observers.length) { unbind(observers[0]); }
  }

  global.OmniComposerUX = {
    version: VERSION,
    thresholds: {
      counterVisible: COUNTER_VISIBLE_THRESHOLD,
      danger: DANGER_THRESHOLD,
      pasteTextFlash: PASTE_TEXT_FLASH_THRESHOLD,
    },
    rescan: rescan,
    destroy: destroy,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})(window);
