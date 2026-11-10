/* =============================================================================
 * omni-loot-panel.js — [LOOT-UI 2026-11-07] 「攻击链」面板（lootchain 集成 UI）
 * -----------------------------------------------------------------------------
 * 后端 : 同源 /api/lootchain/*（ui_shim_loot.js，鉴权门内）
 * 鉴权 : window.__OMNI_SHIM_TOKEN__（ui_shim injectBootstrap 注入）
 * 样式 : 内联注入，全部消费 omni-craft-system.css 的 :root 令牌
 * 对外 : window.OmniLootPanel = { mount, open, close, toggle }
 * 用法 : <script src="./omni-loot-panel.js" defer></script> 后自动 mount
 * ========================================================================== */
(function (global) {
  'use strict';

  var ENTRY_ID = 'omni-loot-entry', PANEL_ID = 'omni-loot-panel';
  var API = '/api/lootchain/';
  var stagesCache = null, jobsTimer = null, logTimer = null, activeLogJob = null, logOffset = 0;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function token() { try { return global.__OMNI_SHIM_TOKEN__ || ''; } catch (_) { return ''; } }
  function call(path, body) {
    var opt = body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token() }, body: JSON.stringify(body) }
      : { headers: { 'Authorization': 'Bearer ' + token() } };
    return fetch(API + path, opt).then(function (r) { return r.json(); });
  }
  function hint(msg, tone) {
    var n = $('loot-hint');
    if (n) { n.textContent = msg; n.setAttribute('data-tone', tone || 'err'); }
  }

  /* ---- 样式（[LOOT-UI 2026-11-07]，令牌全部来自 omni-craft-system.css :root） ---- */
  var CSS = ''
    + '#' + ENTRY_ID + '{position:fixed;right:24px;bottom:96px;z-index:1100;display:flex;align-items:center;gap:8px;'
    + ' padding:10px 16px;border-radius:12px;cursor:pointer;font-size:13px;font-weight:600;'
    + ' color:var(--text-primary,#e8ecf4);background:rgba(20,24,32,.92);border:1px solid var(--border-strong,#3a4252);'
    + ' box-shadow:0 6px 24px rgba(0,0,0,.35);transition:all .25s}'
    + '#' + ENTRY_ID + ':hover{border-color:var(--accent-primary,#5b8cff);color:var(--accent-primary,#5b8cff)}'
    + '#' + ENTRY_ID + ' .dot{width:8px;height:8px;border-radius:50%;background:var(--accent-primary,#5b8cff)}'
    + '#' + PANEL_ID + '{position:fixed;top:0;right:0;bottom:0;width:min(560px,92vw);z-index:1200;'
    + ' background:var(--surface-0,#080a0e);border-left:1px solid var(--border-subtle,#262c38);'
    + ' display:flex;flex-direction:column;transform:translateX(102%);transition:transform .25s ease;'
    + ' box-shadow:-16px 0 48px rgba(0,0,0,.5);font-size:13px;color:var(--text-primary,#e8ecf4)}'
    + '#' + PANEL_ID + '[data-open="true"]{transform:translateX(0)}'
    + '#' + PANEL_ID + ' .loot-hd{display:flex;align-items:center;gap:10px;padding:16px 20px;border-bottom:1px solid var(--border-subtle,#262c38)}'
    + '#' + PANEL_ID + ' .loot-hd h3{margin:0;font-size:15px;flex:1}'
    + '#' + PANEL_ID + ' .loot-hd .x{cursor:pointer;color:var(--text-secondary,#9aa2b4);font-size:18px;line-height:1;padding:4px 8px;border-radius:8px}'
    + '#' + PANEL_ID + ' .loot-hd .x:hover{color:var(--text-primary,#e8ecf4);background:var(--surface-1,#141820)}'
    + '#' + PANEL_ID + ' .loot-body{flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:16px}'
    + '#' + PANEL_ID + ' textarea{width:100%;min-height:88px;resize:vertical;padding:10px 12px;border-radius:10px;'
    + ' background:var(--surface-1,#141820);border:1px solid var(--border-subtle,#262c38);color:var(--text-primary,#e8ecf4);'
    + ' font:12px/1.6 var(--font-mono,monospace);outline:none;box-sizing:border-box}'
    + '#' + PANEL_ID + ' textarea:focus{border-color:var(--accent-primary,#5b8cff)}'
    + '#' + PANEL_ID + ' .loot-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}'
    + '#' + PANEL_ID + ' input[type=text]{flex:1;padding:8px 12px;border-radius:10px;background:var(--surface-1,#141820);'
    + ' border:1px solid var(--border-subtle,#262c38);color:var(--text-primary,#e8ecf4);font-size:12px;outline:none;min-width:120px}'
    + '#' + PANEL_ID + ' .go{padding:9px 18px;border-radius:10px;border:1px solid var(--accent-primary,#5b8cff);'
    + ' background:var(--accent-primary,#5b8cff);color:#fff;font-weight:600;font-size:13px;cursor:pointer;transition:all .15s}'
    + '#' + PANEL_ID + ' .go:hover{filter:brightness(1.12)}'
    + '#' + PANEL_ID + ' .go[disabled]{opacity:.5;cursor:default}'
    + '#' + PANEL_ID + ' .chips{display:flex;flex-wrap:wrap;gap:6px;max-height:150px;overflow-y:auto;padding:2px}'
    + '#' + PANEL_ID + ' .chip{padding:4px 10px;border-radius:99px;font-size:11px;cursor:pointer;user-select:none;'
    + ' color:var(--text-secondary,#9aa2b4);background:var(--surface-1,#141820);border:1px solid var(--border-subtle,#262c38);transition:all .15s}'
    + '#' + PANEL_ID + ' .chip.on{color:var(--accent-primary,#5b8cff);border-color:var(--accent-primary,#5b8cff);background:rgba(91,140,255,.12)}'
    + '#' + PANEL_ID + ' .job{border:1px solid var(--border-subtle,#262c38);border-radius:12px;padding:12px 14px;'
    + ' background:var(--surface-1,#141820);display:flex;flex-direction:column;gap:8px}'
    + '#' + PANEL_ID + ' .job .top{display:flex;align-items:center;gap:8px}'
    + '#' + PANEL_ID + ' .st{width:8px;height:8px;border-radius:50%;flex:none}'
    + '#' + PANEL_ID + ' .st.running{background:var(--accent-primary,#5b8cff);animation:lootpulse 1.5s infinite}'
    + '#' + PANEL_ID + ' .st.done{background:#37d67a}#' + PANEL_ID + ' .st.failed{background:#ff7a7a}'
    + '#' + PANEL_ID + ' .st.stopped{background:#ffc266}#' + PANEL_ID + ' .st.unknown{background:#9aa2b4}'
    + '#' + PANEL_ID + ' .job .nm{flex:1;font-weight:600;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '#' + PANEL_ID + ' .job .meta{font-size:11px;color:var(--text-secondary,#9aa2b4)}'
    + '#' + PANEL_ID + ' .job .ops{display:flex;gap:6px}'
    + '#' + PANEL_ID + ' .mini{padding:4px 10px;border-radius:8px;font-size:11px;cursor:pointer;background:none;'
    + ' border:1px solid var(--border-subtle,#3a4252);color:var(--text-secondary,#9aa2b4);transition:all .15s}'
    + '#' + PANEL_ID + ' .mini:hover{color:var(--accent-primary,#5b8cff);border-color:var(--accent-primary,#5b8cff)}'
    + '#' + PANEL_ID + ' .mini.danger:hover{color:#ff7a7a;border-color:#ff7a7a}'
    + '#' + PANEL_ID + ' .logbox{background:#05070b;border:1px solid var(--border-subtle,#262c38);border-radius:10px;'
    + ' padding:10px 12px;font:11px/1.5 var(--font-mono,monospace);white-space:pre-wrap;word-break:break-all;'
    + ' max-height:300px;overflow-y:auto;color:#b8c2d4}'
    + '#' + PANEL_ID + ' .rep{background:#05070b;border:1px solid var(--border-subtle,#262c38);border-radius:10px;'
    + ' padding:12px 14px;font:11px/1.6 var(--font-mono,monospace);white-space:pre-wrap;max-height:340px;overflow-y:auto;color:#cdd6e4}'
    + '#' + PANEL_ID + ' #loot-hint{font-size:11.5px;min-height:16px}'
    + '#' + PANEL_ID + ' #loot-hint[data-tone=ok]{color:#37d67a}#' + PANEL_ID + ' #loot-hint[data-tone=err]{color:#ff7a7a}'
    + '@keyframes lootpulse{0%,100%{opacity:1}50%{opacity:.35}}';

  /* ---- DOM ---- */
  var HTML = ''
    + '<div class="loot-hd"><h3>攻击链 · lootchain</h3><span class="x" id="loot-close" role="button" aria-label="关闭面板">✕</span></div>'
    + '<div class="loot-body">'
    + '  <div><textarea id="loot-targets" placeholder="目标列表，每行一个 URL&#10;http://TARGET/item?id=1&#10;http://TARGET2/"></textarea></div>'
    + '  <div class="loot-row"><input type="text" id="loot-name" placeholder="作业名（可选，默认自动生成）">'
    + '    <button class="go" id="loot-go" type="button">开始攻击链</button></div>'
    + '  <div><div class="loot-row" style="margin-bottom:6px"><span class="meta" style="font-size:11px;color:var(--text-secondary,#9aa2b4)">阶段（默认自适应 brain 模式，勾选则只跑所选）</span></div>'
    + '    <div class="chips" id="loot-chips"><span class="meta">加载阶段中…</span></div></div>'
    + '  <div id="loot-jobs"><span class="meta" style="font-size:11px;color:var(--text-secondary,#9aa2b4)">暂无作业</span></div>'
    + '  <div id="loot-logwrap" style="display:none"><div class="loot-row" style="justify-content:space-between;margin-bottom:6px">'
    + '    <span style="font-size:11px;color:var(--text-secondary,#9aa2b4)" id="loot-logtitle">日志</span>'
    + '    <span class="mini" id="loot-logclose" role="button">收起日志</span></div>'
    + '    <div class="logbox" id="loot-logbox"></div></div>'
    + '  <div id="loot-repwrap" style="display:none"><div class="loot-row" style="justify-content:space-between;margin-bottom:6px">'
    + '    <span style="font-size:11px;color:var(--text-secondary,#9aa2b4)">报告</span>'
    + '    <span class="mini" id="loot-repclose" role="button">收起报告</span></div>'
    + '    <div class="rep" id="loot-repbox"></div></div>'
    + '  <p id="loot-hint" role="status" aria-live="polite"></p>'
    + '</div>';

  function build() {
    if ($(PANEL_ID)) return;
    var style = document.createElement('style');
    style.setAttribute('data-omni-loot', '1');
    style.textContent = CSS;
    document.head.appendChild(style);

    var entry = document.createElement('div');
    entry.id = ENTRY_ID;
    entry.setAttribute('role', 'button');
    entry.setAttribute('aria-label', '打开攻击链面板');
    entry.innerHTML = '<span class="dot"></span>攻击链';
    entry.addEventListener('click', toggle);
    document.body.appendChild(entry);

    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('data-open', 'false');
    panel.innerHTML = HTML;
    document.body.appendChild(panel);

    $('loot-close').addEventListener('click', close);
    $('loot-go').addEventListener('click', startRun);
    $('loot-logclose').addEventListener('click', function () {
      $('loot-logwrap').style.display = 'none'; stopLogPoll();
    });
    $('loot-repclose').addEventListener('click', function () { $('loot-repwrap').style.display = 'none'; });
    loadStages();
    // [G95] 门禁：定时器只在打开时跑，关闭即停（原来面板关着也 5s 一次 fetch+innerHTML 全量重建）
    if (document.getElementById(PANEL_ID) && document.getElementById(PANEL_ID).getAttribute('data-open') === 'true') startJobsPoll();
  }

  function startJobsPoll() {
    if (jobsTimer) return;
    refreshJobs();
    jobsTimer = setInterval(refreshJobs, 5000);
  }
  function stopJobsPoll() {
    if (jobsTimer) { clearInterval(jobsTimer); jobsTimer = null; }
  }
  function open() { var p = $(PANEL_ID); if (p) { p.setAttribute('data-open', 'true'); startJobsPoll(); } }
  function close() { var p = $(PANEL_ID); if (p) { p.setAttribute('data-open', 'false'); stopJobsPoll(); } }
  function toggle() { var p = $(PANEL_ID); if (!p) return; p.getAttribute('data-open') === 'true' ? close() : open(); }

  /* ---- 阶段 chips ---- */
  function loadStages() {
    call('stages', {}).then(function (d) {
      if (!d || !d.ok) { $('loot-chips').innerHTML = '<span style="font-size:11px;color:#ff7a7a">阶段加载失败：' + esc((d && d.error) || '网络') + '</span>'; return; }
      stagesCache = d.stages || [];
      var box = $('loot-chips');
      box.innerHTML = stagesCache.map(function (s, i) {
        return '<span class="chip" data-i="' + i + '" title="' + esc(s[1] || '') + '">' + esc(s[0]) + '</span>';
      }).join('');
      box.querySelectorAll('.chip').forEach(function (c) {
        c.addEventListener('click', function () { c.classList.toggle('on'); });
      });
    }).catch(function () {
      $('loot-chips').innerHTML = '<span style="font-size:11px;color:#ff7a7a">阶段加载失败（本机服务未就绪）</span>';
    });
  }

  /* ---- 启动 ---- */
  function startRun() {
    var targets = $('loot-targets').value.trim();
    if (!targets) { hint('先填目标（每行一个 URL）'); return; }
    var name = $('loot-name').value.trim();
    var sel = [];
    var box = $('loot-chips');
    if (box && stagesCache) box.querySelectorAll('.chip.on').forEach(function (c) {
      sel.push(stagesCache[Number(c.getAttribute('data-i'))][0]);
    });
    var btn = $('loot-go');
    btn.disabled = true; btn.textContent = '启动中…';
    call('run', { targets: targets, name: name, stages: sel.join(',') })
      .then(function (d) {
        if (d && d.ok) {
          hint('已启动 ' + d.name + '（pid ' + d.pid + '），正在打开会话…', 'ok');
          $('loot-targets').value = ''; $('loot-name').value = '';
          refreshJobs();
          // [LOOT-SESSION 2026-11-07] 老板口径：点开始就要落到一个新会话里——
          // 攻击链不是孤立面板，是对话的第一等公民。种子简报注入新会话，
          // AI 用 lootchain_log/findings 工具在会话里实时跟踪+研判+建议下一轮。
          openLootSession(d);
        } else hint('启动失败：' + ((d && d.error) || '未知'));
      })
      .catch(function () { hint('启动失败：本机服务未就绪'); })
      .then(function () { btn.disabled = false; btn.textContent = '开始攻击链'; });
  }

  /* ---- [LOOT-SESSION 2026-11-07] 会话接管 ----
   * ① 种子简报写 localStorage（跨路由跳转存活）
   * ② 跳 LibreChat 新会话（根路由）
   * ③ 注入器轮询检测聊天输入框（React 受控组件要用原生 setter 才能让 state 收到值）
   * ④ 填入简报 + 触发发送按钮 → AI 开工
   * 用户全程只看到：点开始 → 落进新会话 → AI 已经在汇报攻击链。 */
  var SESSION_FLAG = 'omni-loot-pending';
  function openLootSession(job) {
    var brief = ''
      + '攻击链作业已启动，请立即接管跟踪：\n'
      + '- jobId: ' + job.jobId + '\n'
      + '- 作业名: ' + job.name + '\n'
      + '- 阶段组合: ' + (job.stages || 'adaptive（brain 自适应全链）') + '\n\n'
      + '要求：\n'
      + '1. 用 lootchain_log 工具（jobId 如上，offset 从 0 开始）跟踪执行进度，向用户实时汇报关键节点；\n'
      + '2. 作业结束后用 lootchain_findings 分析战果（findings/loot），给出研判结论；\n'
      + '3. 结合研判结果主动建议下一组阶段组合（如发现注入点→inject,creds；发现云凭据→cloud,bucket），等用户确认后再跑。\n'
      + '先调一次 lootchain_jobs 确认作业状态，然后开始汇报。';
    try {
      localStorage.setItem(SESSION_FLAG, JSON.stringify({ brief: brief, jobId: job.jobId, ts: Date.now() }));
      close();
      global.location.hash = '#/';
      global.location.pathname = '/';
      injectPending();
    } catch (e) { /* localStorage 异常时退化为仅面板跟踪 */ }
  }
  function setNativeValue(el, value) {
    var proto = el instanceof global.HTMLTextAreaElement ? global.HTMLTextAreaElement.prototype : global.HTMLInputElement.prototype;
    var desc = global.Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new global.Event('input', { bubbles: true }));
  }
  function injectPending(attempt) {
    attempt = attempt || 0;
    var raw = null;
    try { raw = localStorage.getItem(SESSION_FLAG); } catch (_) {}
    if (!raw) return;
    var pend = JSON.parse(raw);
    var ta = document.querySelector("textarea[data-testid='text-input'], textarea[id='composer'], form textarea");
    var sendBtn = document.querySelector("button[data-testid='send-button'], form button[type='submit']");
    if (ta && sendBtn) {
      setNativeValue(ta, pend.brief);
      setTimeout(function () {
        try {
          var sb = document.querySelector("button[data-testid='send-button'], form button[type='submit']");
          if (sb) sb.click();
          else if (ta.form) ta.form.requestSubmit ? ta.form.requestSubmit() : ta.form.dispatchEvent(new global.Event('submit', { bubbles: true, cancelable: true }));
          localStorage.removeItem(SESSION_FLAG);
        } catch (_) { /* 发送失败保留 pending，下次进会话再试 */ }
      }, 250);
      return;
    }
    if (attempt < 40) setTimeout(function () { injectPending(attempt + 1); }, 500);   // 最长等 20s（React 挂载）
    else { /* 超时放弃，保留 pending 供下次进入会话时补发 */ }
  }

  /* ---- job 列表 ---- */
  function refreshJobs() {
    call('jobs').then(function (d) {
      if (!d || !d.ok) return;
      var wrap = $('loot-jobs');
      var list = d.jobs || [];
      if (!list.length) { wrap.innerHTML = '<span style="font-size:11px;color:var(--text-secondary,#9aa2b4)">暂无作业</span>'; return; }
      wrap.innerHTML = list.map(function (j) {
        var dur = j.startedAt ? Math.round((Date.now() - j.startedAt) / 1000) + 's' : '';
        if (j.endedAt && j.startedAt) dur = Math.round((j.endedAt * 1000 - j.startedAt) / 1000) + 's';
        return '<div class="job" data-job="' + esc(j.jobId) + '">'
          + '<div class="top"><span class="st ' + esc(j.status) + '"></span>'
          + '<span class="nm" title="' + esc(j.name) + '">' + esc(j.name) + '</span>'
          + '<span class="meta">' + esc(j.status) + ' · ' + dur + (j.pid ? ' · pid ' + j.pid : '') + '</span></div>'
          + '<div class="ops">'
          + '<span class="mini" data-op="log" role="button">日志</span>'
          + '<span class="mini" data-op="report" role="button">报告</span>'
          + (j.status === 'running' || j.status === 'unknown' ? '<span class="mini danger" data-op="stop" role="button">停止</span>' : '')
          + '</div></div>';
      }).join('');
      wrap.querySelectorAll('.mini').forEach(function (b) {
        b.addEventListener('click', function () {
          var op = b.getAttribute('data-op');
          var jobId = b.closest('.job').getAttribute('data-job');
          if (op === 'log') openLog(jobId);
          else if (op === 'report') openReport(jobId);
          else if (op === 'stop') stopJob(jobId);
        });
      });
    }).catch(function () { /* 轮询静默 */ });
  }

  function stopJob(jobId) {
    call('stop', { jobId: jobId }).then(function (d) {
      hint(d && d.ok ? (d.note || '已停止') : '停止失败：' + ((d && d.error) || ''), d && d.ok ? 'ok' : 'err');
      refreshJobs();
    });
  }

  /* ---- 日志 ---- */
  function openLog(jobId) {
    activeLogJob = jobId; logOffset = 0;
    $('loot-logbox').textContent = '';
    $('loot-logwrap').style.display = '';
    $('loot-logtitle').textContent = '日志 · ' + jobId;
    stopLogPoll();
    pullLog();
    logTimer = setInterval(pullLog, 2000);
  }
  function stopLogPoll() { if (logTimer) { clearInterval(logTimer); logTimer = null; } }
  function pullLog() {
    if (!activeLogJob) { stopLogPoll(); return; }
    call('log', { jobId: activeLogJob, offset: logOffset }).then(function (d) {
      if (!d || !d.ok) return;
      logOffset = d.nextOffset;
      var box = $('loot-logbox');
      if (d.text) {
        var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
        box.textContent += d.text;
        if (atBottom) box.scrollTop = box.scrollHeight;
      }
      if (d.eof && d.status && d.status !== 'running') {
        stopLogPoll();
        box.textContent += '\n—— [' + d.status + '] 已结束 ——';
      }
    });
  }

  /* ---- 报告 ---- */
  function openReport(jobId) {
    call('report', { jobId: jobId }).then(function (d) {
      if (!d || !d.ok) { hint('报告不可读：' + ((d && d.error) || 'job 可能还没跑完')); return; }
      $('loot-repbox').textContent = d.markdown || '(空报告)';
      $('loot-repwrap').style.display = '';
      $('loot-repbox').scrollTop = 0;
      hint('报告已载入（完整产物：' + (d.workDir || '') + '）', 'ok');
    });
  }

  /* ---- 对外 ---- */
  global.OmniLootPanel = { mount: build, open: open, close: close, toggle: toggle };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})(window);
