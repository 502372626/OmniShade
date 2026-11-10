/* =============================================================================
 * omni-license-panel.js — 「本机授权」面板挂载逻辑 (OmniShade omni-craft 工艺)
 * -----------------------------------------------------------------------------
 * 片段 : ui/omni-license-panel.html（同源片段；取不到用内置兜底片段）
 * 样式 : ui/omni-craft-license.css（片段页自举时由片段尾部 <link> 装载）
 * 数据 : 三级本机数据源，全部指向 desktop/license_client.js（本机文件 IO + 内置
 *        Ed25519 验签），对外网零请求：
 *          ① window.omnishade.license.*  —— Electron preload 直连（首选，真·零网络）
 *          ② 同源 /api/omni-license/*    —— 仅当 hostname 是回环地址时启用
 *                                           （静态 server / 无头截图 / 浏览器直开）
 *          ③ 都没有                        —— 明确 no-api 错误态，面板仍完整铺开
 *
 * 对外: window.OmniLicensePanel = { mount, open, close, toggle, refresh, state, errors }
 * 用法: <script src="./omni-license-panel.js" defer></script>
 *       OmniLicensePanel.mount({ container: null, showEntry: true })
 *            container 为空 → 挂到 document.body（右下角入口 + 右侧抽屉）
 *            container 非空 → 行内嵌进该容器（设置页挂载点）
 *            文档里已有 #omni-license-panel（片段页直开 / SSR）→ 收养该节点，不再重建
 *
 * ⚠ G13 修复要点（「只有入口按钮、面板主体空壳」的根因，详见 02-ui/G13-授权面板空壳修复.md）：
 *    · auto() 原 `if (getElementById(PANEL_ID)) return;` —— 片段页里已有面板就整段放弃挂载，
 *      既不 bind 也不 refresh，主体永久停在 hidden + closed。现改走 adopt() 收养分支。
 *    · mount() 原来只在自己 inject 出来的节点上工作。现支持收养文档里已存在的节点。
 *    · open() 原依赖双 requestAnimationFrame：headless=old / 无合成器时 rAF 可能永不回调，
 *      data-state 永远不置 open。现 nextFrame() 带 90ms 幂等兜底。
 *    · refresh() 原来只认 window.omnishade.license，缺失即全字段「—」。现三级本机数据源。
 *    · 原三处 catch(_) {} 静默吞错 → 统一 report()，面板消息行 + console 双留痕。
 * ========================================================================== */
(function (global) {
  'use strict';

  var FRAGMENT_URL = './omni-license-panel.html';
  var TEMPLATE_ID = 'omni-license-panel-tpl';
  var PANEL_ID = 'omni-license-panel';
  var ENTRY_ID = 'omni-license-entry';
  var STANDALONE_FLAG = 'omni-license-standalone';   // 加在 <html> 上：片段被当独立页打开
  var PAGE_CLASS = 'omni-license--page';             // 加在 .omni-license 上：正文铺开而非右抽屉

  /* 回环同源 API：只用于「无 Electron preload」的本机静态 / 无头场景 */
  var LOCAL_STATUS_API = '/api/omni-license/status';
  var LOCAL_ACTIVATE_API = '/api/omni-license/activate';

  /* ---------------- 原因码 → 中文文案（与 license_client.js 返回值一一对应） ---------- */
  var REASON_TEXT = {
    ok: '本机校验通过：签名有效、指纹匹配、在有效期内。',
    expired: '授权已过期，请重新签发或更新 license.key。',
    'fingerprint-mismatch': '授权绑定的机器指纹与本机不一致，请按本机指纹重新签发。',
    'bad-signature': '签名校验失败，授权文件被篡改或签发密钥不匹配。',
    'schema-mismatch': '授权协议版本不匹配（需 omnishade-license-v1）。',
    'no-signature': '授权文件缺少签名字段。',
    'bad-license': '授权文件不是合法 JSON 对象。',
    'read-error': '读取授权文件失败（权限或路径问题）。',
    'no-license': '本机未找到可用的 license.key。',
    'no-api': '本机授权数据源未挂载：既无 Electron preload 桥，也无回环 license API。',
    'bad-json': '粘贴的内容不是合法 JSON。',
    'write-blocked': '授权写入被拒绝：本机校验未通过，已保留原授权文件。',
    'network-blocked': '本机校验通道不可用（回环 license API 未响应）。',
  };

  /* 原因码 → 面板状态（驱动徽章配色：active/expired/mismatch/error/inactive/unknown） */
  function stateOfReason(reason, valid) {
    if (valid === true) return 'active';
    switch (reason) {
      case 'ok': return 'active';
      case 'expired': return 'expired';
      case 'fingerprint-mismatch': return 'mismatch';
      case 'no-license': return 'inactive';
      case 'bad-signature':
      case 'schema-mismatch':
      case 'no-signature':
      case 'bad-license':
      case 'read-error':
      case 'no-api':
      case 'bad-json':
      case 'write-blocked':
      case 'network-blocked':
        return 'error';
      default: return 'unknown';
    }
  }

  var STATE_TEXT = {
    active: '已激活',
    expired: '已过期',
    mismatch: '绑定不匹配',
    inactive: '未激活',
    error: '校验失败',
    unknown: '读取中…',
  };

  var SOURCE_TEXT = {
    user: '用户目录',
    bundled: '内置授权',
    'loopback-api': '本机回环 API',
    '': '—',
  };

  /* ---------------- 小工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 指纹脱敏：只暴露后 8 位，前段整段打点（复制按钮给完整值）
  function maskFingerprint(fp) {
    var s = String(fp == null ? '' : fp);
    if (!s) return '—';
    if (s.length <= 8) return s;
    return new Array(s.length - 8 + 1).join('•') + s.slice(-8);
  }

  function daysLeft(expires) {
    var exp = Number(expires || 0);
    if (!exp) return null;
    var diff = exp * 1000 - Date.now();
    return diff <= 0 ? 0 : Math.ceil(diff / 86400000);
  }

  function formatExpiry(expires) {
    var exp = Number(expires || 0);
    if (!exp) return '—';
    var d = new Date(exp * 1000);
    if (isNaN(d.getTime())) return '—';
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ---- 帧驱动：headless=old / 无合成器环境 rAF 可能永不回调 → 90ms 幂等兜底 ---- */
  function nextFrame(fn) {
    var done = false;
    function once() { if (done) return; done = true; fn(); }
    try { requestAnimationFrame(function () { requestAnimationFrame(once); }); } catch (_) { /* 落到定时器 */ }
    setTimeout(once, 90);
  }

  /* ---- 回环保守判定：只有 127.0.0.1 / localhost / [::1] 才允许走 HTTP 兜底 ----
     硬保证「零外网请求」：非回环域名永远拿不到 ② 级数据源，直接落到 ③ no-api。 */
  function localHttpAllowed() {
    try {
      var h = String(location.hostname || '');
      return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
    } catch (_) { return false; }
  }

  /* ---- URL 显式开关：?omniLicense=open / #open 强制展开，=closed 强制收起 ---- */
  function urlWantsOpen() {
    try {
      if (/(\?|&)omniLicense=open/.test(location.search || '')) return true;
      if (/(\?|&)omniLicense=closed/.test(location.search || '')) return false;
      return /^#(open|license)$/.test(location.hash || '') ? true : null;
    } catch (_) { return null; }
  }

  function api() {
    var o = global.omnishade;
    return (o && o.license && typeof o.license.status === 'function') ? o.license : null;
  }

  function noApiStatus(reason) {
    return {
      state: 'error', valid: false, ok: false, available: false,
      reason: reason || 'no-api',
      expires: 0, tier: null, fingerprint: null, machineFingerprint: '',
      source: '', path: '', daysLeft: null,
    };
  }

  /* ---------------- 内置兜底片段（fetch 失败时仍能挂载，绝不白屏） ---------------- */
  function fallbackFragment() {
    return [
      '<button type="button" id="omni-license-entry" class="omni-license__entry" data-state="unknown"',
      ' aria-haspopup="dialog" aria-controls="omni-license-panel" title="授权信息" style="display:none">',
      '<span class="omni-license__entry-dot" aria-hidden="true"></span><span>授权</span></button>',
      '<div id="omni-license-panel" class="omni-license" data-state="closed" hidden>',
      '<div class="omni-license__scrim" data-omni-license-close></div>',
      '<aside class="omni-license__sheet" role="dialog" aria-modal="false" aria-labelledby="omni-license-title">',
      '<header class="omni-license__head"><div>',
      '<h2 class="omni-license__title" id="omni-license-title">授权</h2>',
      '<p class="omni-license__subtitle" id="omni-license-subtitle">账号授权与使用情况。卡密激活请前往「账号」页，',
      '绑定账号后任意机器可用。</p></div>',
      '<button type="button" class="omni-license__close" id="omni-license-close" data-omni-license-close aria-label="关闭授权面板">×</button></header>',
      '<div class="omni-license__status" id="omni-license-status" data-state="unknown">',
      '<span class="omni-license__status-dot" id="omni-license-status-dot" aria-hidden="true"></span>',
      '<span id="omni-license-status-text">正在读取本机授权…</span></div>',
      '<div class="omni-license__loading" id="omni-license-loading" role="status" aria-live="polite" hidden>',
      '<span class="omni-license__spinner" aria-hidden="true"></span>',
      '<span id="omni-license-loading-text">正在本机校验授权…</span></div>',
      '<div class="omni-license__empty" id="omni-license-empty" hidden>',
      '<span class="omni-license__empty-mark" aria-hidden="true">◇</span>',
      '<p class="omni-license__empty-title" id="omni-license-empty-title">本机尚未激活</p>',
      '<p class="omni-license__empty-desc" id="omni-license-empty-desc">尚未绑定账号授权，请前往「账号」页登录并激活卡密。</p></div>',
      '<section class="omni-license__card"><h3 class="omni-license__card-title">授权信息</h3>',
      '<div class="omni-license__meta" id="omni-license-meta">',
      '<div class="omni-license__meta-item"><span class="omni-license__meta-key">版本</span>',
      '<span class="omni-license__meta-val" id="omni-license-tier">',
      '<span class="omni-license__skeleton" style="width: 48px"></span></span></div>',
      '<div class="omni-license__meta-item"><span class="omni-license__meta-key">到期时间</span>',
      '<span class="omni-license__meta-val" id="omni-license-expiry">',
      '<span class="omni-license__skeleton" style="width: 96px"></span></span></div>',
      '<div class="omni-license__meta-item"><span class="omni-license__meta-key">剩余天数</span>',
      '<span class="omni-license__meta-val" id="omni-license-days">',
      '<span class="omni-license__skeleton" style="width: 40px"></span></span></div>',
      '<div class="omni-license__meta-item"><span class="omni-license__meta-key">授权来源</span>',
      '<span class="omni-license__meta-val" id="omni-license-source">',
      '<span class="omni-license__skeleton" style="width: 56px"></span></span></div></div>',
      '<div class="omni-license__row"><span class="omni-license__label" id="omni-license-bound-label">绑定账号</span>',
      '<span class="omni-license__value" id="omni-license-bound">—</span></div></section>',
      '<section class="omni-license__card"><h3 class="omni-license__card-title">使用情况</h3>',
      '<div class="omni-license__meta" id="omni-license-plan">',
      '<div class="omni-license__meta-item"><span class="omni-license__meta-key">使用类型</span>',
      '<span class="omni-license__meta-val" id="omni-license-plan-sku">—</span></div>',
      '<div class="omni-license__meta-item"><span class="omni-license__meta-key">知识库今日配额</span>',
      '<span class="omni-license__meta-val" id="omni-license-plan-kb">—</span></div>',
      '<div class="omni-license__meta-item"><span class="omni-license__meta-key">工具范围</span>',
      '<span class="omni-license__meta-val" id="omni-license-plan-scope">—</span></div>',
      '<div class="omni-license__meta-item"><span class="omni-license__meta-key">有效期至</span>',
      '<span class="omni-license__meta-val" id="omni-license-plan-expiry">—</span></div></div>',
      '<div class="omni-license__kb-wrap" id="omni-license-kb-wrap" hidden>',
      '<div class="omni-license__kb-bar" id="omni-license-kb-bar">',
      '<div class="omni-license__kb-fill" id="omni-license-kb-fill"></div></div>',
      '<span class="omni-license__kb-text" id="omni-license-kb-text">—</span></div></section>',
      '<section class="omni-license__card"><h3 class="omni-license__card-title" id="omni-license-verify-title">离线校验结果</h3>',
      '<div class="omni-license__verify" id="omni-license-verify" data-state="unknown">',
      '<span class="omni-license__verify-text" id="omni-license-verify-text">尚未校验</span>',
      '<span class="omni-license__verify-code" id="omni-license-verify-code">—</span></div></section>',
      '<div class="omni-license__actions">',
      '<button type="button" class="omni-license__btn omni-license__btn--ghost" id="omni-license-refresh">重新校验</button>',
      '</div>',
      '<p class="omni-license__msg" id="omni-license-msg" role="status" aria-live="polite"></p>',
      '</aside></div>',
    ].join('');
  }

  /* ---------------- 面板实例 ---------------- */
  var el = {};       // id → 节点缓存
  var root = null;   // #omni-license-panel
  var entry = null;  // #omni-license-entry
  var lastStatus = null;
  var lastFingerprint = '';
  var mounted = false;
  var inlineMode = false;
  var docBound = false;          // document 级监听是否已挂（保活重挂不重复绑）
  var lastFragmentHtml = '';     // 最近一次成功注入的片段，保活重挂时复用
  var keepAliveTimer = null;     // SPA 清 DOM 的体检定时器
  var injectTarget = null;       // inject 落点（mount 设定，保活重挂沿用）
  var inflight = null;           // refresh 单飞，避免 open() 与按钮并发互相覆盖
  var errors = [];               // 被吞过的异常一律留痕（G13：静默吞错是白屏帮凶）
  var lastSourceLabel = '';      // 本次数据来自哪一级，写进消息行便于排障

  /* ---- 错误留痕：面板消息行 + console 双写，绝不再静默 ---- */
  function report(tag, e) {
    var s = tag + '：' + String((e && e.message) || e);
    errors.push(s);
    if (errors.length > 40) errors.shift();
    try { if (global.console && console.error) console.error('[omni-license]', s); } catch (_) { /* 无处可写别二次抛 */ }
    try { if (mounted) msg(s, 'err'); } catch (_) { /* ignore */ }
    return s;
  }

  /* ---- 保活：SPA 重建 / 路由切换把面板整块摘掉时，用上次片段重新挂回 ---- */
  function startKeepAlive() {
    if (keepAliveTimer) return;
    keepAliveTimer = setInterval(function () {
      if (!mounted) return;
      var r = document.getElementById(PANEL_ID);
      var e = document.getElementById(ENTRY_ID);
      var alive = r && r.isConnected !== false && (!e || e.isConnected !== false);
      if (alive) return;
      mounted = false; root = null; entry = null;
      try {
        inject(lastFragmentHtml);
      } catch (err) {
        report('保活重挂失败', err);   // 原实现 catch(_){} 静默 → 面板消失无人知晓
      }
    }, 3000);
  }

  /* ---- 片段来源①：index.html 内嵌 <template>（零请求，file:// 下也不会被 CORS 拦） ---- */
  function templateFragment() {
    var tpl = document.getElementById(TEMPLATE_ID);
    if (!tpl) return null;
    return tpl.innerHTML || null;
  }

  function $(id) {
    if (el[id] && document.body.contains(el[id])) return el[id];
    var node = document.getElementById(id);
    if (node) el[id] = node;
    return node;
  }

  function setText(id, text) {
    var n = $(id);
    if (n) n.textContent = text;
  }

  function setHtml(id, html) {
    var n = $(id);
    if (n) n.innerHTML = html;
  }

  function setState(state) {
    var s = $('omni-license-status');
    if (s) s.setAttribute('data-state', state);
    if (entry) entry.setAttribute('data-state', state);
    setText('omni-license-status-text', STATE_TEXT[state] || STATE_TEXT.unknown);
  }

  function busy(on, text) {
    var box = $('omni-license-loading');
    if (!box) return;
    if (on) {
      setText('omni-license-loading-text', text || '正在本机校验授权…');
      box.removeAttribute('hidden');
    } else {
      box.setAttribute('hidden', '');
    }
  }

  /* 骨架态：数据没到之前占位，避免面板高度抖动（G13 要求的加载骨架态） */
  var SKELETON_W = {
    'omni-license-tier': 48, 'omni-license-expiry': 96,
    'omni-license-days': 40, 'omni-license-source': 56,
  };

  function setSkeleton(on) {
    Object.keys(SKELETON_W).forEach(function (id) {
      if (on) {
        setHtml(id, '<span class="omni-license__skeleton" style="width: ' + SKELETON_W[id] + 'px"></span>');
      } else {
        var n = $(id);
        if (n && /omni-license__skeleton/.test(n.innerHTML)) setText(id, '—');
      }
    });
    var fp = $('omni-license-fp');
    if (fp) {
      if (on) {
        fp.innerHTML = '<span class="omni-license__skeleton" style="width: 60%"></span>';
        fp.setAttribute('data-state', 'loading');
      } else if (fp.getAttribute('data-state') === 'loading') {
        setText('omni-license-fp', '—');
        fp.setAttribute('data-state', 'empty');
      }
    }
  }

  function showEmpty(on, title, desc) {
    var box = $('omni-license-empty');
    if (!box) return;
    if (on) {
      if (title) setText('omni-license-empty-title', title);
      if (desc) setText('omni-license-empty-desc', desc);
      box.removeAttribute('hidden');
    } else {
      box.setAttribute('hidden', '');
    }
  }

  function msg(text, tone) {
    var n = $('omni-license-msg');
    if (!n) return;
    n.textContent = text || '';
    if (tone) n.setAttribute('data-tone', tone); else n.removeAttribute('data-tone');
  }

  /* ---------------- 渲染 ---------------- */
  function render(st) {
    lastStatus = st || null;
    if (!st) return;

    var state = st.state || stateOfReason(st.reason, st.valid);
    // 账号授权（服务端 runtime grant）与本地 license.key 是两条独立授权路径。
    // 账号已登录且套餐有效时，本地没有 license.key 是正常的，不能因此把面板标成「未激活」。
    var hasAccountPlan = !!(st.plan && (st.plan.sku || st.plan.skuName) && st.plan.expiresAt > Date.now() / 1000);
    if (hasAccountPlan && state !== 'active') state = 'active';
    setState(state);

    var fp = st.machineFingerprint || '';
    lastFingerprint = fp;
    var fpBox = $('omni-license-fp');
    if (fpBox) {
      fpBox.textContent = fp
        ? maskFingerprint(fp) + '  （共 ' + fp.length + ' 位）'
        : '—';
      fpBox.setAttribute('data-state', fp ? 'ready' : 'empty');
    }

    /* ---- 授权信息：优先用账号套餐（runtime grant），其次本地 license.key ----
       两条授权路径只能显示一条真实来源。账号已登录却把「版本/到期/剩余天数/来源」全显示成 —，
       再叠一句「本机未找到 license.key」，是自相矛盾的渲染 bug。 */
    var planInfo = st.plan || null;
    if (hasAccountPlan) {
      // 「版本」是客户端版本，不是套餐名——套餐在下面「当前套餐」里已经有了，重复显示等于丢一条信息。
      setText('omni-license-tier', st.appVersion || '1.1.99');
      setText('omni-license-expiry', formatExpiry(planInfo.expiresAt));
      var pd = daysLeft(planInfo.expiresAt);
      setText('omni-license-days', (pd === null || isNaN(pd)) ? '—' : (pd + ' 天'));
      setText('omni-license-source', '账号授权（运行时授权）');
      // 账号授权绑的是账号不是机器指纹：标签跟着改，别让「绑定的指纹」显示一个邮箱。
      var boundLabel = $('omni-license-bound-label');
      if (boundLabel) boundLabel.textContent = '绑定账号';
      setText('omni-license-bound', planInfo.email || '—');
      var boundEl = $('omni-license-bound');
      if (boundEl) boundEl.title = planInfo.email || '';
    } else {
      setText('omni-license-tier', st.tier || '—');
      setText('omni-license-expiry', formatExpiry(st.expires));
      var d = (st.daysLeft === 0 || st.daysLeft) ? Number(st.daysLeft) : daysLeft(st.expires);
      setText('omni-license-days', (d === null || isNaN(d)) ? '—' : (d + ' 天'));
      setText('omni-license-source', SOURCE_TEXT[st.source] || (st.source || '—'));
      var boundLabel2 = $('omni-license-bound-label');
      if (boundLabel2) boundLabel2.textContent = '绑定的指纹';
      setText('omni-license-bound', st.fingerprint ? maskFingerprint(st.fingerprint) : '—');
    }

    /* ---- 套餐与用量（数据来自运行时 grant 快照；缺数据一律显示 —，不编造） ---- */
    var plan = planInfo;
    var planSkuEl = $('omni-license-plan-sku');
    if (plan && (plan.sku || plan.skuName)) {
      // [文案口径] 对外统一"半开源使用", 不暴露 sku 细分(软硬分级仅内部 tone 标记)
      setText('omni-license-plan-sku', '半开源使用');
      if (planSkuEl) planSkuEl.setAttribute('data-tone', plan.soft === false ? 'kb' : 'soft');
    } else {
      setText('omni-license-plan-sku', plan ? '半开源使用' : '—');
      if (planSkuEl) planSkuEl.removeAttribute('data-tone');
    }

    // 「套餐到期」：与授权信息卡的到期时间不同口径——这里只关心本次套餐剩多久
    setText('omni-license-plan-expiry', plan ? formatExpiry(plan.expiresAt) : '—');

    var kbEl = $('omni-license-plan-kb');
    var barEl = $('omni-license-kb-bar');
    var fillEl = $('omni-license-kb-fill');
    var wrapEl = $('omni-license-kb-wrap');
    var kbTextEl = $('omni-license-kb-text');
    if (plan && plan.kbDaily > 0) {
      var used = Number(plan.kbUsed || 0);
      var daily = Number(plan.kbDaily || 0);
      var remain = Number(plan.kbRemain || 0);
      var pct = daily > 0 ? Math.min(100, Math.round(used / daily * 100)) : 0;
      setText('omni-license-plan-kb', used + ' / ' + daily + ' 次　剩余 ' + remain);
      if (kbEl) kbEl.setAttribute('data-tone', remain <= 0 ? 'warn' : (remain < daily * 0.1 ? 'warn' : 'ok'));
      if (wrapEl) wrapEl.hidden = false;
      if (barEl) barEl.hidden = false;
      if (fillEl) {
        fillEl.style.width = pct + '%';
        fillEl.setAttribute('data-tone', remain <= 0 ? 'warn' : (pct >= 90 ? 'warn' : 'ok'));
      }
      // 0% 时也要有可读的量化信息，否则那根空轨道等于没画
      setText('omni-license-kb-text', '已用 ' + pct + '%　剩余 ' + remain + ' 次');
    } else {
      setText('omni-license-plan-kb', plan ? '不含知识库' : '—');
      if (kbEl) kbEl.removeAttribute('data-tone');
      if (wrapEl) wrapEl.hidden = true;
      if (barEl) barEl.hidden = true;
      setText('omni-license-kb-text', '—');
    }

    var scopeEl = $('omni-license-plan-scope');
    if (plan && plan.toolScope) {
      var allScope = plan.toolScope === 'all';
      setText('omni-license-plan-scope', allScope
        ? '全部 ' + (plan.toolCount || 27) + ' 个工具'
        : '仅知识库 ' + (plan.toolCount || 5) + ' 个工具');
      if (scopeEl) scopeEl.setAttribute('data-tone', allScope ? 'ok' : 'kb');
    } else {
      setText('omni-license-plan-scope', '—');
      if (scopeEl) scopeEl.removeAttribute('data-tone');
    }

    var verify = $('omni-license-verify');
    var verifyTitle = $('omni-license-verify-title');
    var subtitle = $('omni-license-subtitle');
    if (hasAccountPlan) {
      // 账号授权生效时，摘要和卡片标题都要跟着换口径：
      // 原来的「不发起任何网络请求」「离线校验结果」跟「服务端签发」是自相矛盾的。
      if (subtitle) {
        subtitle.textContent = '账号授权：登录后由服务端签发运行时授权（Ed25519 签名），' +
          '本机验签后解锁对应使用能力。本机 license.key 是可选的离线授权通道。';
      }
      if (verifyTitle) verifyTitle.textContent = '授权校验结果';
      if (verify) verify.setAttribute('data-state', 'ok');
      setText('omni-license-verify-text', '账号授权生效（服务端签发，本机已验签）');
      setText('omni-license-verify-code', 'account-grant');
    } else {
      if (subtitle) {
        subtitle.textContent = '账号授权与套餐用量。卡密激活请前往「账号」页， ' +
          '比对本机指纹 → 校验有效期。不发起任何网络请求。';
      }
      if (verifyTitle) verifyTitle.textContent = '离线校验结果';
      if (verify) verify.setAttribute('data-state', st.valid === true ? 'ok' : 'fail');
      setText('omni-license-verify-text', REASON_TEXT[st.reason] || ('原因码：' + (st.reason || '未知')));
      setText('omni-license-verify-code', st.reason || '—');
    }

    showEmpty(false);
    // 账号套餐有效时不再显示「本机尚未激活」——本地 license.key 缺省是正常的。
    if (!hasAccountPlan) {
      if (st.reason === 'no-license') {
        showEmpty(true, '本机尚未激活',
          '未找到 license.key，且当前没有登录账号。把签发好的授权内容粘贴到下方完成本机激活，或点右上「账号登录 / 注册」用卡密激活账号。');
      } else if (st.reason === 'no-api') {
        showEmpty(true, '本机授权数据源未挂载',
          '既没有 Electron preload 桥（window.omnishade.license），也没有回环 license API。' +
          '面板已完整铺开，但读不到授权状态 —— 在 OmniShade 客户端内打开即可正常读取。');
      }
    }
  }

  /* ---------------- 数据源：三级本机兜底，全部指向 license_client.js ---------------- */
  function readStatus() {
    var lic = api();
    if (lic) {                                   // ① Electron preload：直连 license_client.js
      lastSourceLabel = 'Electron preload 桥（本机直读 license.key）';
      return Promise.resolve().then(function () { return lic.status(); });
    }
    if (localHttpAllowed()) {                    // ② 回环同源 API（静态 server / 无头截图）
      lastSourceLabel = '本机回环 API（127.0.0.1，本机 license_client 验签）';
      return fetch(LOCAL_STATUS_API, { credentials: 'same-origin' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .catch(function (e) {
          report('回环 license API 读取失败', e);
          return noApiStatus('network-blocked');
        });
    }
    lastSourceLabel = '';
    return Promise.resolve(noApiStatus());        // ③ 明确 no-api，面板照样铺开（不再空壳）
  }

  function writeLicense(text) {
    var lic = api();
    if (lic) return Promise.resolve().then(function () { return lic.activate(text); });
    if (localHttpAllowed()) {
      return fetch(LOCAL_ACTIVATE_API, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'text/plain;charset=utf-8' },
        body: text,
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
    }
    return Promise.resolve({ ok: false, reason: 'no-api', status: null, targets: [] });
  }

  /* ---------------- 取状态（单飞：骨架态 → 数据态） ---------------- */
  function refresh() {
    if (inflight) return inflight;               // 单飞：open() 与按钮并发不互相覆盖
    setSkeleton(true);
    busy(true, '正在本机校验授权…');
    inflight = readStatus()
      .then(function (st) {
        render(st);
        if (lastSourceLabel && st && st.reason !== 'no-api') {
          // 这行是排障信息，不是状态高亮：账号授权时「无外网请求」也不成立，
          // 所以按通道分别描述，并且用中性 tone，避免和「已激活」绿撞色。
          var viaAccount = !!(st.plan && (st.plan.sku || st.plan.skuName));
          msg(viaAccount
            ? '数据源：' + lastSourceLabel + '（账号授权经服务端签发，本机验签）'
            : '数据源：' + lastSourceLabel + '（全程本机校验，无外网请求）', 'info');
        }
        return st;
      })
      .catch(function (e) {
        report('读取本机授权失败', e);
        render(noApiStatus('read-error'));
        return null;
      })
      .then(function (st) {
        busy(false);
        setSkeleton(false);
        inflight = null;
        return st;
      });
    return inflight;
  }

  /* ---------------- 复制指纹 ---------------- */
  function copyFingerprint() {
    if (!lastFingerprint) { msg('指纹尚未就绪，稍后再试。', 'warn'); return; }
    var text = lastFingerprint;
    var done = function () { msg('已复制完整指纹（' + text.length + ' 位）到剪贴板。', 'ok'); };
    var fail = function () { msg('复制失败，请手动选中指纹文本复制。', 'err'); };
    try {
      if (global.navigator && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fail);
        return;
      }
    } catch (e) { report('剪贴板 API 不可用，回落 execCommand', e); }
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      ok ? done() : fail();
    } catch (e) { report('复制兜底失败', e); fail(); }
  }

  /* ---------------- 激活 ---------------- */
  function readFileText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(new Error('文件读取失败')); };
      reader.readAsText(file);
    });
  }

  function activate() {
    var input = $('omni-license-input');
    var text = input ? String(input.value || '').trim() : '';
    if (!text) { msg('请先粘贴 license 内容，或选择 license.key 文件。', 'warn'); return; }
    if (!api() && !localHttpAllowed()) { msg('本机授权数据源未挂载，无法激活。', 'err'); return; }

    busy(true, '正在本机校验并写入授权…');
    var btn = $('omni-license-activate');
    if (btn) btn.disabled = true;
    Promise.resolve()
      .then(function () { return writeLicense(text); })
      .then(function (res) {
        if (btn) btn.disabled = false;
        busy(false);
        res = res || {};
        if (res.ok === true) {
          msg('激活成功，已写入：' + (res.path || '本机授权文件'), 'ok');
          if (input) input.value = '';
          return refresh();
        }
        msg('激活失败：' + (REASON_TEXT[res.reason] || res.reason || '未知原因') +
          '（原因码 ' + (res.reason || '-') + '）', 'err');
        return render(res.status || res);
      })
      .catch(function (e) {
        if (btn) btn.disabled = false;
        busy(false);
        report('激活过程异常', e);
      });
  }

  /* ---------------- 开合 ---------------- */
  function open() {
    if (!root) return;
    if (inlineMode) { root.setAttribute('data-state', 'open'); refresh(); return; }
    root.hidden = false;
    // 去 rAF 硬依赖：nextFrame 带 90ms 幂等兜底，无头环境也必定置 open
    nextFrame(function () { root.setAttribute('data-state', 'open'); });
    refresh();
  }

  function close() {
    if (!root) return;
    root.setAttribute('data-state', 'closed');
    if (inlineMode) return;
    // 等出场动画走完再 hidden，避免面板闪断
    setTimeout(function () {
      if (root && root.getAttribute('data-state') === 'closed') root.hidden = true;
    }, 340);
  }

  function toggle() {
    if (!root) return;
    if (root.getAttribute('data-state') === 'open') close(); else open();
  }

  /* ---------------- 挂载 ---------------- */
  function bind() {
    var closeBtn = $('omni-license-close');
    if (closeBtn) closeBtn.addEventListener('click', close);

    var scrim = root ? root.querySelector('[data-omni-license-close]') : null;
    if (scrim && scrim !== closeBtn) scrim.addEventListener('click', close);

    if (entry) entry.addEventListener('click', toggle);

    var copyBtn = $('omni-license-fp-copy');
    if (copyBtn) copyBtn.addEventListener('click', copyFingerprint);

    var actBtn = $('omni-license-activate');
    if (actBtn) actBtn.addEventListener('click', activate);

    var refBtn = $('omni-license-refresh');
    if (refBtn) refBtn.addEventListener('click', function () { msg(''); refresh(); });

    var fileInput = $('omni-license-file');
    if (fileInput) {
      fileInput.addEventListener('change', function () {
        var f = fileInput.files && fileInput.files[0];
        if (!f) { setText('omni-license-file-name', '未选择文件'); return; }
        setText('omni-license-file-name', '已选择：' + f.name + '（' + f.size + ' 字节）');
        readFileText(f).then(function (text) {
          var input = $('omni-license-input');
          if (input) input.value = String(text || '').trim();
          msg('文件已读入，点「本机激活」写入并校验。');
        }, function () { msg('文件读取失败，请改用粘贴方式。', 'err'); });
      });
    }

    // document 级监听只挂一次：SPA 重建 DOM 触发保活重挂时不能重复累积
    if (!docBound) {
      docBound = true;
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && root && root.getAttribute('data-state') === 'open') close();
      });

      // 任意节点带 data-omni-license-open 也能拉起面板（给设置页菜单项用）
      document.addEventListener('click', function (e) {
        var t = e.target;
        if (t && t.closest && t.closest('[data-omni-license-open]')) { e.preventDefault(); open(); }
      });
    }
  }

  function inject(html) {
    if (mounted) return;
    var wrap = document.createElement('div');
    wrap.innerHTML = html;
    lastFragmentHtml = html;   // 记下来，保活重挂时复用同一份片段
    var nodes = [];
    // 必须 removeChild 再 push（搬移而非复制）：只 push 不摘 → firstChild 恒非空 →
    // 死循环 → RangeError: Invalid array length → 面板/入口永远 inject 不进去（挂载失败）
    while (wrap.firstChild) nodes.push(wrap.removeChild(wrap.firstChild));
    var host = injectTarget || document.body;
    for (var i = 0; i < nodes.length; i++) host.appendChild(nodes[i]);
  }

  /* 片段被直接当页面打开（http 静态 server / 无头截图）→ 正文铺开，不再是右抽屉 */
  function markStandalone() {
    if (!root) return false;
    if (document.getElementById('root')) return false;   // 应用外壳在 → 保持浮层模式
    try { document.documentElement.classList.add(STANDALONE_FLAG); } catch (_) { /* ignore */ }
    root.classList.add(PAGE_CLASS);
    root.removeAttribute('hidden');                      // 关键：摘掉片段自带的 hidden
    inlineMode = true;                                   // 走行内分支：不做抽屉位移
    if (!document.title) document.title = '本机授权 · OmniShade';
    return true;
  }

  /* 收养文档里已存在的 #omni-license-panel（片段页直开 / SSR 场景）。
     原实现 auto() 见到已有面板直接 return → 不 bind、不 refresh、不开面板 → 空壳。 */
  function adopt(options) {
    var existing = document.getElementById(PANEL_ID);
    if (!existing) return false;
    root = existing;
    entry = document.getElementById(ENTRY_ID);
    if (!markStandalone()) inlineMode = !!root.classList.contains('omni-license--inline');
    mounted = true;
    lastFragmentHtml = root.outerHTML || '';
    bind();
    startKeepAlive();
    var want = urlWantsOpen();
    var shouldOpen = (want === null) ? (options.openOnMount !== false) : want;
    if (shouldOpen) open(); else refresh();
    return true;
  }

  function finishMount(options) {
    if (mounted) return global.OmniLicensePanel;
    root = document.getElementById(PANEL_ID);
    entry = document.getElementById(ENTRY_ID);
    if (!root) {
      report('挂载失败', new Error('文档中没有 #omni-license-panel'));
      return global.OmniLicensePanel;
    }
    if (inlineMode) root.classList.add('omni-license--inline');
    if (options.showEntry === false && entry && entry.parentNode) entry.parentNode.removeChild(entry);
    mounted = true;
    bind();
    startKeepAlive();   // 入口被 SPA 清掉也能自己长回来
    var want = urlWantsOpen();
    if (want === true || options.openOnMount === true) open();
    else refresh();
    return global.OmniLicensePanel;
  }

  function mount(options) {
    if (mounted) return global.OmniLicensePanel;
    options = options || {};

    // 片段页 / SSR 场景：文档里已经有面板节点 → 收养，别再注入第二份
    try {
      if (document.getElementById(PANEL_ID)) {
        if (adopt(options)) return global.OmniLicensePanel;
      }
    } catch (e) {
      report('收养既有面板失败', e);
    }

    var fragUrl = options.fragmentUrl || FRAGMENT_URL;
    var host = options.container || null;
    if (typeof host === 'string') host = document.querySelector(host);
    inlineMode = !!host;
    injectTarget = host || document.body;

    // 片段取回优先级：① index.html 内嵌 <template> ② 同源 fetch ③ 内置兜底片段
    var inline = templateFragment();
    if (inline && inline.indexOf(PANEL_ID) >= 0) {
      inject(inline);
      return finishMount(options);
    }

    // 片段取回失败（file:// / CORS / 未打包）→ 内置兜底片段，保证功能不缺
    var fallbackTimer = setTimeout(function () {
      try {
        if (!mounted) { inject(fallbackFragment()); finishMount(options); }
      } catch (e) { report('兜底片段注入失败', e); }
    }, 1200);

    try {
      fetch(fragUrl, { credentials: 'same-origin' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }).then(function (html) {
        clearTimeout(fallbackTimer);
        try {
          if (html && html.indexOf(PANEL_ID) >= 0) inject(html);
          else inject(fallbackFragment());
        } catch (e) {
          report('片段注入失败，改用内置片段', e);
          try { inject(fallbackFragment()); } catch (e2) { report('内置片段注入失败', e2); }
        }
        return finishMount(options);
      }).catch(function (e) {
        clearTimeout(fallbackTimer);
        report('片段取回失败，改用内置片段', e);
        try { inject(fallbackFragment()); } catch (e2) { report('内置片段注入失败', e2); }
        return finishMount(options);
      });
    } catch (e) {
      clearTimeout(fallbackTimer);
      report('片段请求抛出，改用内置片段', e);
      try { inject(fallbackFragment()); } catch (e2) { report('内置片段注入失败', e2); }
      return finishMount(options);
    }

    return global.OmniLicensePanel;
  }

  global.OmniLicensePanel = {
    mount: mount,
    open: open,
    close: close,
    toggle: toggle,
    refresh: refresh,
    adoptExisting: function (opts) { return adopt(opts || {}); },
    markStandalone: markStandalone,
    get state() { return lastStatus; },
    get fingerprint() { return lastFingerprint; },
    get errors() { return errors.slice(); },
    get mounted() { return mounted; },
  };

  // 默认自挂载：DOM 就绪后挂到 body，入口常驻右下角（设置页 / 主界面均可见）
  function auto() {
    mount({ container: null, showEntry: true });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', auto, { once: true });
  } else {
    auto();
  }
})(window);
