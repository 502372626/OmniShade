/* [OMNI-HISTORY-FOLD] 长会话只显示最近几条，上翻按需展开。
 *
 * 为什么在 DOM 层做：/api/messages 必须返回全量——客户端拿
 * messages[messages.length-1].messageId 当 lastMessageId 发消息，服务端拿它做乐观
 * 并发校验。数据层一旦截断，发消息必然报「会话最新消息已变化，请刷新后重试」。
 * 所以省渲染只能省在视图层：消息仍在 DOM，前 N 条 display:none 掉。
 *
 * [MEM-PATCH 2026-11-08] 修复两处长跑卡顿源（行为语义不变）：
 *   P1  findScroller 结果缓存：O(1) 校验代替每 tick 全 DOM querySelectorAll
 *       + getComputedStyle 扫描（原每 1.2s 一次 + 每 mutation 节流 180ms 一次）。
 *   P2  MutationObserver 随 SPA 路由断开：离开 /c/ 即 disconnect，回到 /c/ 重挂；
 *       非会话页不再被全 subtree 观察持续唤醒。
 *   P3  轮询稳态零开销：pathname 未变直接 return（DOM 变化已由 observer 驱动，
 *       路由检测仍靠轮询——react-router pushState 不派发可监听事件）。
 *   P4  applyFold 签名短路：消息总数/折叠数/首节点 display 探针未变则跳过重算。
 */
(function () {
  'use strict';
  var KEEP = 5;          // 默认露出最近几条
  var STEP = 10;         // 每次多露几条
  var shown = 0;
  var lastCheapSig = '';         // 当前额外露出的条数
  var sid = '';
  var btn = null;
  var obs = null;
  var lastPath = location.pathname;   // [P3]
  var scCache = null;                 // [P1] scroller 缓存
  var lastSig = '';                   // [P4] applyFold 签名

  function currentSid() {
    var m = location.pathname.match(/\/c\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function findScroller() {
    // [P1] 先做 O(1) 校验：缓存命中且仍连通/仍可滚/仍够大 → 直接复用。
    // scroller 被 React 换节点时 isConnected 变 false → 落回全扫一次并重建缓存。
    if (scCache && scCache.isConnected) {
      var cst = getComputedStyle(scCache);
      if ((cst.overflowY === 'auto' || cst.overflowY === 'scroll')
        && scCache.scrollHeight > scCache.clientHeight + 40) {
        var cr = scCache.getBoundingClientRect();
        if (cr.width >= 200 && cr.height >= 160) return scCache;
      }
    }
    var best = null, bestArea = 0;
    var all = document.querySelectorAll('div,main,section');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var st = getComputedStyle(el);
      if (st.overflowY !== 'auto' && st.overflowY !== 'scroll') continue;
      if (el.scrollHeight <= el.clientHeight + 40) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 160) continue;
      var area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = el; }
    }
    scCache = best;
    return best;
  }

  function collectMessages(scroller) {
    if (!scroller) return [];
    var out = [];
    // LibreChat 的消息节点带 data-testid="message-<id>" 或 role=article 的 .message
    var nodes = scroller.querySelectorAll('[data-testid^="message-"], .message');
    for (var i = 0; i < nodes.length; i++) {
      // 只要顶层消息，排除嵌套
      if (nodes[i].closest('[data-testid^="message-"]') !== nodes[i] &&
          nodes[i].closest('.message') !== nodes[i]) continue;
      out.push(nodes[i]);
    }
    return out;
  }

  function updateBtn(hideCount) {
    if (!btn) return;
    if (hideCount > 0) {
      btn.style.display = 'block';
      btn.textContent = '显示更早的 ' + Math.min(STEP, hideCount) + ' 条（还有 ' + hideCount + ' 条）';
    } else {
      btn.style.display = 'none';
    }
  }

  function applyFold() {
    var sc = findScroller();
    if (!sc) return;
    // [G95] 廉价签名前置：childElementCount + 末消息 id 未变 → 直接跳过昂贵扫描（原签名在 collectMessages 之后=白扫）
    ensureBtn();
    var cheapSig;
    try {
      var kids = sc.children ? sc.children.length : 0;
      var lastMsg = sc.querySelector('[data-testid^="message-"]:last-of-type');
      cheapSig = kids + '|' + (lastMsg ? (lastMsg.getAttribute('data-message-id') || lastMsg.id || lastMsg.textContent.length) : 'none');
    } catch (e) { cheapSig = ''; }
    if (cheapSig && cheapSig === lastCheapSig) { return; }
    lastCheapSig = cheapSig;
    var msgs = collectMessages(sc);
    if (!msgs.length) { if (btn) btn.style.display = 'none'; return; }
    var total = msgs.length;
    var visible = KEEP + shown;
    var hideCount = Math.max(0, total - visible);
    // [P4] 签名短路：总数/折叠数/首节点 display 探针未变则跳过整段重算。
    // 探针覆盖 React 重置行内样式的情形（display 被还原 → 探针变 → 重新套折叠）。
    var sig = total + '|' + hideCount + '|' + msgs[0].style.display;
    if (sig === lastSig) { updateBtn(hideCount); return; }
    lastSig = sig;
    for (var i = 0; i < total; i++) {
      var el = msgs[i];
      if (i < hideCount) {
        if (el.style.display !== 'none') el.style.display = 'none';
      } else if (el.style.display === 'none') {
        el.style.display = '';
      }
    }
    updateBtn(hideCount);
  }

  function ensureBtn() {
    if (btn && document.body.contains(btn)) return btn;
    btn = document.getElementById('omni-history-more');
    if (btn) return btn;
    btn = document.createElement('button');
    btn.id = 'omni-history-more';
    btn.type = 'button';
    btn.style.cssText = [
      'position:fixed', 'top:74px', 'left:50%', 'transform:translateX(-50%)',
      'z-index:40', 'display:none', 'padding:6px 14px', 'border-radius:999px',
      'border:1px solid rgba(120,150,190,.35)', 'background:rgba(17,25,37,.92)',
      'color:#cfe0f5', 'font-size:12px', 'cursor:pointer', 'backdrop-filter:blur(8px)'
    ].join(';');
    btn.onclick = function () {
      shown += STEP;
      applyFold();
    };
    document.body.appendChild(btn);
    return btn;
  }

  function mount() {
    if (location.pathname.indexOf('/c/') === -1) {
      if (btn) btn.style.display = 'none';
      if (obs) obs.disconnect();       // [P2] 离开会话页：停掉全 subtree 观察
      return;
    }
    sid = currentSid();
    ensureBtn();
    if (!obs) {
      obs = new MutationObserver(function () {
        if (location.pathname.indexOf('/c/') === -1) return;   // [P2] 回调内路由早退
        if (window.__OMNI_FOLD_TICK__) return;
        window.__OMNI_FOLD_TICK__ = setTimeout(function () {
          window.__OMNI_FOLD_TICK__ = null;
          applyFold();
        }, 400);   // [G94] 180→400ms：流式/高频 DOM 变更期降 55% 回调频次
      });
    }
    obs.observe(document.body, { childList: true, subtree: true });   // [P2] 重挂（对已观察目标是幂等的）
    applyFold();
  }

  // 会话切换 → 重置折叠。
  // [P3] 稳态（pathname 未变）零开销：interval 只承担路由检测与挂载兜底，
  // 持续折叠纠偏由 observer 的 180ms 节流驱动——原「每 tick 无条件 mount→全扫」移除。
  setInterval(function () {
    var p = location.pathname;
    if (p === lastPath) return;
    lastPath = p;
    shown = 0;
    mount();
  }, 1200);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
