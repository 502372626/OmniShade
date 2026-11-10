'use strict';
// goal_engine_v2.js — 目标驱动自主迭代引擎 v2（独立 worker）
// 由 goal_engine.js 改造：工具分阶段覆盖 + 失败恢复/降级 + 证据去重。
// 直接替换方式：把 bridge.js 里 `const enginePath = path.join(__dirname, 'goal_engine.js')`
// 换成 'goal_engine_v2.js' 即可，命令行参数与 v1 完全一致（forkGoalEngine 拼的 argv 不用动）。
//
// 目录 / 参数与 v1 一致：
//   --objective <目标> --state <状态目录> --max_iters <0=无限> --done <kw,kw>
//   --sleep_ms <毫秒> --bridge <http://127.0.0.1:9431> --token <bearer>
//
// 知识库检索约束沿用 v1（这两条是桥侧硬闸，写错就整轮空转）：
//   * scope 用 'redteam'（本地磁盘白名单），不用 'both'（both 会先打远端 103.117.136.137:9443）。
//   * mode 用 'name'（文件名/索引匹配），不用 'content'（红队库 83GB，content 直接被 SCOPE_BLOCKED）。
//
// ── v2 改了什么 ────────────────────────────────────────────────────────────
// 1) 工具覆盖按阶段分派（工具名/参数严格对齐 bridge.js 的 MCP_TOOLS 与 callTool 分支）：
//      recon    kb_search(mode:name) + skill_list
//      expand   追加 fs_list 扫目录（备选 local_fs_search 按内容搜）
//      deep     追加 skill_read / kb_read 读正文（路径来自 skill_list / kb_search 的真实命中）
//      sustain  追加 web 取证（web_fetch 桥里没有 → 见下方 CAPS，退 sys_exec+curl）
// 2) 失败恢复：任何工具报错/超时都不终止循环；本轮立刻换等价工具，下一轮换关键词；
//    失败计入 error_streak（仅成功清零），error_streak>=5 永久降级为只用 kb_search(mode:name)。
// 3) 证据去重：每轮结果取 sha256 前 16 hex 存 Set；重复轮不计 hits_total / evidence_count，但轮次照常推进。
// 4) 完成判据不变：done_keywords 命中 / max_iters 达到 / stop.flag 出现。没有「放弃」出口。
//
// ── 桥侧工具清单事实（本轮只读核对，未改 bridge.js）────────────────────────
// MCP_TOOLS 里存在的：goal_start/goal_status/goal_stop/goal_log、win_process/win_services/
// win_netstat/win_sysinfo、fs_read/fs_list/fs_hash、local_fs_search/local_fs_write、
// desktop_screenshot/desktop_window_list、cdp_navigate/cdp_click/cdp_eval/cdp_screenshot、
// process_list/taskkill/sys_exec、skill_list/skill_cache_clear/skill_read、kb_search/kb_read。
// 不存在：web_fetch、http_request、shell.run、fs.write（写盘只有 local_fs_write）。
// 注意 fs_read/fs_list 走 TOOL_ALIASES → 'fs.read'/'fs.list' 分支；local_fs_write 是独立分支。
// goal_start 严禁在 worker 里调用——会 fork 出第二个 worker，等于自繁殖。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const num = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

const OBJECTIVE = argOf('objective', '').trim();
const STATE_DIR = argOf('state', '');
const MAX_ITERS = Math.max(0, num(argOf('max_iters', '0'), 0));
const SLEEP_MS = Math.max(200, num(argOf('sleep_ms', '1200'), 1200));
const DONE_KWS = (argOf('done', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const BRIDGE_URL = argOf('bridge', 'http://127.0.0.1:9431');
const BRIDGE_TOKEN = argOf('token', '');

// 单次工具调用超时：v1 写死 90s。环境变量可调，防止大目录 fs_list 被误杀或长检索被拖死。
const TOOL_TIMEOUT_MS = clamp(num(process.env.OMNI_GOAL_TOOL_TIMEOUT_MS, 90000), 5000, 300000);
const CALL_RETRY_MS = 300;          // 纯传输层失败（桥忙/连接断）同轮内补一次，不换工具
const ERROR_STREAK_LIMIT = 5;       // 连续失败轮数阈值 → 降级
const HASH_CAP = 20000;             // 去重集合上限（FIFO 淘汰，防长跑吃内存）
const EVIDENCE_CAP = 300000;        // 回灌证据窗口，同 v1
const COLLECT_CAP = 800;            // 技能/知识库路径缓存上限

if (!OBJECTIVE || !STATE_DIR) {
  process.stderr.write('goal_engine_v2: objective/state 必填\n');
  process.exit(2);
}
fs.mkdirSync(STATE_DIR, { recursive: true });

// 调试落盘沿用 v1 口径（只打 bridge 地址 + token 长度/前 6 位，不打全文）
try {
  fs.writeFileSync(path.join(STATE_DIR, 'debug.json'), JSON.stringify({
    engine: 'goal_engine_v2',
    bridge: BRIDGE_URL,
    token_len: BRIDGE_TOKEN.length,
    token_head: BRIDGE_TOKEN.slice(0, 6),
    argv: process.argv.slice(2).length,
    env_token_len: (process.env.OMNI_LOCAL_BRIDGE_TOKEN || '').length,
  }, null, 2));
} catch (_) {}

const JSONL = path.join(STATE_DIR, 'goal.jsonl');
const SNAP = path.join(STATE_DIR, 'goal.json');
const STOPF = path.join(STATE_DIR, 'stop.flag');

// 允许运维指定 expand 阶段要扫的目录（分号分隔；不设就从命中里自动取绝对路径）
const SCAN_DIRS = String(process.env.OMNI_GOAL_SCAN_DIRS || '')
  .split(';').map(s => s.trim()).filter(Boolean);

// ── 桥侧能力表（默认值 = 本轮读 bridge.js 核对出来的实况）──────────────────
// web_fetch/http_request 桥里没有；用环境变量显式打开是为了「桥以后注册了 web_fetch，
// 这里只改一处」——若是强行调用不存在的工具，桥会回 TOOL_BLOCKED: 未知工具，本轮白烧。
const CAPS = {
  kb_search: true,
  skill_list: true,
  skill_read: true,
  kb_read: true,
  fs_list: true,
  local_fs_search: true,
  local_fs_write: true,
  sys_exec: true,
  web_fetch: false,
  http_request: false,
};
if (process.env.OMNI_GOAL_WEB_TOOL === 'web_fetch') CAPS.web_fetch = true;
if (process.env.OMNI_GOAL_WEB_TOOL === 'http_request') CAPS.http_request = true;

// ── 状态（字段与 v1 对齐，UI 轮询 goal.json 不用改）───────────────────────
let RECENT = '';                     // 证据回灌窗口：只放内存，不写快照（v1 会把它塞进 goal.json）
const state = {
  engine: 'goal_engine_v2',
  id: path.basename(STATE_DIR),
  objective: OBJECTIVE,
  started_at: Date.now(),
  iter: 0,
  phase: 'recon',
  status: 'running',                 // running / done / stopped / error
  done: false,
  stop_reason: '',
  hits_total: 0,
  evidence_count: 0,
  dup_rounds: 0,
  uniq_rounds: 0,
  error_streak: 0,
  degraded: false,
  degraded_at_iter: 0,
  last_action: '',
  last_tool: '',
  last_hypothesis: '',
  last_error: '',
  last_ms: 0,
  last_hash: '',
  seen_hashes: 0,
  tool_stats: {},
  done_keywords: DONE_KWS,
  max_iters: MAX_ITERS,
};

function saveSnap() {
  state.updated_at = Date.now();
  state.elapsed_s = Math.round((Date.now() - state.started_at) / 1000);
  state.seen_hashes = SEEN.size;
  // 只序列化公开字段：任何 _ 前缀（历史 v1 的 _recentEvidence）都不进快照
  const pub = {};
  for (const k of Object.keys(state)) if (k.charAt(0) !== '_') pub[k] = state[k];
  const tmp = SNAP + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(pub, null, 2));
  fs.renameSync(tmp, SNAP);          // 原子替换：UI 轮询永远读不到半截 JSON
}

function logLine(obj) {
  const line = JSON.stringify({ ts: Date.now(), iter: state.iter, ...obj });
  fs.appendFileSync(JSONL, line + '\n');
  saveSnap();
}

// ── 工具调用（走桥的 /call；worker 里不重复实现工具）──────────────────────
async function callToolOnce(name, a) {
  const body = JSON.stringify({ tool: name, args: a || {} });
  const ctrl = new AbortController();
  let timedOut = false;
  const to = setTimeout(() => { timedOut = true; ctrl.abort(); }, TOOL_TIMEOUT_MS);
  try {
    const r = await fetch(BRIDGE_URL + '/call', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(BRIDGE_TOKEN ? { authorization: 'Bearer ' + BRIDGE_TOKEN } : {}),
      },
      body,
      signal: ctrl.signal,
    });
    const txt = await r.text();
    if (!r.ok) return { ok: false, status: r.status, error: txt.slice(0, 400), transport: false };
    try {
      const j = JSON.parse(txt);
      // 桥对 tool 内部错误返回 {ok:false,result:{text,isError:true}}：这种算工具失败，不是成功空结果
      if (j && j.ok === false) return { ok: false, status: r.status, error: String(j.error || 'ok=false').slice(0, 300), transport: false };
      if (j && j.result && j.result.isError) return { ok: false, status: r.status, error: String(j.result.text || 'tool error').slice(0, 300), transport: false };
      return { ok: true, status: r.status, result: (j && j.result) || j };
    } catch (_) {
      return { ok: true, status: r.status, result: { text: txt } };
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 300), timedOut, transport: true };
  } finally {
    clearTimeout(to);
  }
}

async function callTool(name, a) {
  const first = await callToolOnce(name, a);
  if (first.ok) return first;
  // 只有「连不上/被断开」才同轮补一次；桥已经明确回 4xx/工具错误就不重试（重试也只是同一句报错）
  if (!first.transport) return first;
  await new Promise(r => setTimeout(r, CALL_RETRY_MS));
  const second = await callToolOnce(name, a);
  if (!second.ok && first.timedOut) second.timedOut = true;
  return second;
}

function classifyError(r) {
  const e = String((r && r.error) || '') + ' ' + String((r && r.status) || '');
  if (/未知工具/.test(e)) return 'UNKNOWN_TOOL';
  if (/SCOPE_BLOCKED/.test(e)) return 'SCOPE';
  if (/TOOL_BLOCKED|WRITE_GUARD|DISASTER_GUARD/.test(e)) return 'GUARD';
  if (/unauthorized|\b401\b/.test(e)) return 'AUTH';
  if (r && r.timedOut) return 'TIMEOUT';
  if (r && r.transport) return 'TRANSPORT';
  return 'ERROR';
}

function healthOk(tool, ms) {
  const s = state.tool_stats[tool] || (state.tool_stats[tool] = { ok: 0, fail: 0, last_ms: 0, last_error: '' });
  s.ok += 1;
  s.last_ms = ms;
}
function healthFail(tool, cls, ms, err) {
  const s = state.tool_stats[tool] || (state.tool_stats[tool] = { ok: 0, fail: 0, last_ms: 0, last_error: '' });
  s.fail += 1;
  s.last_ms = ms;
  s.last_error = (cls + ': ' + String(err || '')).slice(0, 200);
}

function resultText(res) {
  if (!res) return '';
  if (typeof res === 'string') return res;
  if (res.text) return String(res.text);
  if (res.content) return JSON.stringify(res.content);
  return JSON.stringify(res).slice(0, 200000);
}

// ── 关键词扩展（纯规则，不依赖模型）────────────────────────────────────────
const EXPANDERS = [
  (q) => q,
  (q) => q + ' 漏洞',
  (q) => q + ' 利用',
  (q) => q + ' exploit',
  (q) => q + ' poc',
  (q) => q + ' 复现',
  (q) => q + ' payload',
  (q) => q + ' writeup',
  (q) => q + ' CVE',
  (q) => q + ' 逆向',
  (q) => q + ' 反编译',
  (q) => q + ' 脱壳',
  (q) => q + ' 破解',
  (q) => q + ' bypass',
  (q) => q + ' 注入',
  (q) => q + ' RCE',
  (q) => q + ' 提权',
  (q) => q + ' 内网',
  (q) => q + ' 后渗透',
];
const expanderAt = (n) => EXPANDERS[((n % EXPANDERS.length) + EXPANDERS.length) % EXPANDERS.length];

function extractTokens(s) {
  const out = new Set();
  const re = /[A-Za-z][A-Za-z0-9_\-./]{2,}/g;
  let m;
  while ((m = re.exec(String(s || ''))) !== null) {
    const t = m[0];
    if (t.length >= 3 && !/^(the|and|for|with|http|https|www)$/i.test(t)) out.add(t);
  }
  return [...out].slice(0, 8);
}

function phaseOf(iter) {
  if (iter < 3) return 'recon';        // 先广撒
  if (iter < 8) return 'expand';       // 关键词/目录扩展
  if (iter < 14) return 'deep';        // 读正文深挖
  return 'sustain';                    // 持续迭代直到命中完成判据
}

// ── 证据去重（sha256 前 16 hex）───────────────────────────────────────────
const SEEN = new Set();
function evidenceHash(txt) {
  return crypto.createHash('sha256').update(String(txt), 'utf8').digest('hex').slice(0, 16);
}
function trimSeen() {
  while (SEEN.size > HASH_CAP) {       // Set 迭代顺序 = 插入顺序，丢掉最老的
    const it = SEEN.values().next();
    if (it.done) break;
    SEEN.delete(it.value);
  }
}

function tryJson(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t || (t.charAt(0) !== '{' && t.charAt(0) !== '[')) return null;
  try { return JSON.parse(t); } catch (_) { return null; }
}

function countHits(tool, txt) {
  const j = tryJson(txt);
  if (j && !Array.isArray(j)) {
    if (Array.isArray(j.hits)) return j.hits.length;
    if (Array.isArray(j.entries)) return j.entries.length;
    if (typeof j.content === 'string') return 1;    // 读正文：一篇文档算一条证据
    if (Array.isArray(j.goals)) return j.goals.length;
  }
  if (typeof txt !== 'string') return 0;
  if (txt === '(空)' || txt === '(无匹配)' || txt === '(还没有日志)') return 0;
  return txt.split('\n').filter(l => l.trim()).length;
}

// ── 命中里回收「下一轮可用的真实路径」────────────────────────────────────
// 只认三类来源：skill_list 的 entries[].path、kb_search 的 hits/docs、任何结果里出现的绝对路径。
// 这样 fs_list / skill_read / kb_read 的参数全都来自桥自己回过的路径，不猜目录。
const SKILL_PATHS = [];
const SKILL_SEEN = new Set();
const KB_PATHS = [];
const KB_SEEN = new Set();
const ABS_DIRS = [];
const ABS_SEEN = new Set();

function pushCapped(list, seen, val) {
  if (!val || typeof val !== 'string') return;
  const s = val.trim();
  if (!s || seen.has(s)) return;
  seen.add(s);
  list.push(s);
  if (list.length > COLLECT_CAP) {
    const drop = list.splice(0, list.length - Math.floor(COLLECT_CAP * 0.75));
    for (const d of drop) seen.delete(d);
  }
}

function addAbsDir(p) {
  const norm = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!/^[A-Za-z]:\//.test(norm) && !/^\/\//.test(norm)) return;
  if (norm.length < 4 || norm.length > 240) return;
  pushCapped(ABS_DIRS, ABS_SEEN, norm);
}

function harvestAbs(txt) {
  const re = /[A-Za-z]:[\\/][^\s"'<>|*?\r\n]{2,220}/g;
  let m;
  let n = 0;
  while ((m = re.exec(txt)) !== null && n < 60) {
    const raw = m[0].replace(/[),.;]+$/, '');
    const hasExt = /\.[A-Za-z0-9]{1,6}$/.test(raw);
    addAbsDir(hasExt ? path.dirname(raw).replace(/\\/g, '/') : raw);
    n++;
  }
}

function harvest(tool, txt) {
  if (tool === 'skill_list') {
    const j = tryJson(txt);
    if (j && Array.isArray(j.entries)) {
      for (const e of j.entries) if (e && typeof e.path === 'string') pushCapped(SKILL_PATHS, SKILL_SEEN, e.path);
    }
  }
  if (tool === 'kb_search') {
    const j = tryJson(txt);
    if (j) {
      if (Array.isArray(j.hits)) {
        for (const h of j.hits) {
          if (typeof h === 'string') {
            // 形态: "[name] R3/foo/bar (123B)" / "[index] R3/x.md:12 ..."
            const m = h.match(/^\[(?:name|index)\]\s+((?:R3|知识库)\/[^\s(]+)/);
            if (m) pushCapped(KB_PATHS, KB_SEEN, m[1]);
          } else if (h && typeof h.path === 'string') {
            pushCapped(KB_PATHS, KB_SEEN, h.path);
          }
        }
      }
      if (Array.isArray(j.docs)) {
        for (const d of j.docs) {
          if (!d) continue;
          if (typeof d.path === 'string') pushCapped(KB_PATHS, KB_SEEN, d.path);
          if (typeof d.abs === 'string') addAbsDir(path.dirname(d.abs).replace(/\\/g, '/'));
        }
      }
    }
  }
  harvestAbs(txt);
}

let skillCursor = 0, kbCursor = 0;
function nextSkillPath() {
  if (!SKILL_PATHS.length) return '';
  for (let i = 0; i < Math.min(SKILL_PATHS.length, 60); i++) {
    const p = SKILL_PATHS[(skillCursor + i) % SKILL_PATHS.length];
    if (p) { skillCursor = (skillCursor + i + 1) % SKILL_PATHS.length; return p; }
  }
  return '';
}
function nextKbPath() {
  if (!KB_PATHS.length) return '';
  for (let i = 0; i < Math.min(KB_PATHS.length, 60); i++) {
    const p = KB_PATHS[(kbCursor + i) % KB_PATHS.length];
    if (p) { kbCursor = (kbCursor + i + 1) % KB_PATHS.length; return p; }
  }
  return '';
}
function nextScanDir() {
  if (SCAN_DIRS.length) return SCAN_DIRS[state.iter % SCAN_DIRS.length];
  if (ABS_DIRS.length) return ABS_DIRS[state.iter % ABS_DIRS.length];
  return '.';                          // '.' = 桥的 WORKROOT（fs_list 空参会被 safePath 拒，必须显式给）
}

// ── web 取证：桥没有 web_fetch，链式退到等价载体 ───────────────────────────
const URL_SEEN = new Set();
const URLS = [];
function harvestUrls(txt) {
  const re = /https?:\/\/[^\s"'<>)\]}\u4e00-\u9fa5]+/g;
  let m;
  let n = 0;
  while ((m = re.exec(txt)) !== null && n < 40) {
    const u = m[0].replace(/[),.;]+$/, '');
    if (u.length > 8 && u.length < 400 && !URL_SEEN.has(u)) { URL_SEEN.add(u); URLS.push(u); }
    n++;
  }
  while (URLS.length > 200) { const d = URLS.shift(); URL_SEEN.delete(d); }
}
function nextUrl() {
  if (!URLS.length) return '';
  return URLS[state.iter % URLS.length];
}
function webCallFor(url) {
  // & / 引号 / 反引号会撞 sys_exec 的 WRITE_GUARD，直接放弃这条 URL
  if (!/^https?:\/\/[^\s"'<>|`&]+$/i.test(url)) return null;
  if (CAPS.web_fetch) return { tool: 'web_fetch', args: { url } };
  if (CAPS.http_request) return { tool: 'http_request', args: { url, method: 'GET' } };
  if (CAPS.sys_exec) {
    // 走桥的 sys_exec：内部 spawn('cmd.exe', windowsHide:true)，不弹窗、不常驻
    return { tool: 'sys_exec', args: { cmd: 'curl -sS -L --max-time 8 --max-filesize 300000 "' + url + '"' } };
  }
  return null;
}

// ── 每轮计划：主选 + 同一轮的等价备选 ─────────────────────────────────────
function shortQuery() {
  const toks = extractTokens(OBJECTIVE);
  return toks.length ? toks.slice(0, 3).join(' ') : OBJECTIVE.slice(0, 40);
}
function deepQuery(base) {
  const toks = extractTokens(RECENT).filter(t => !OBJECTIVE.includes(t));
  return toks.length ? (OBJECTIVE + ' ' + toks.slice(0, 3).join(' ')) : base;
}
function kbName(q, scope, max) {
  return { tool: 'kb_search', args: { query: q, scope: scope || 'redteam', max: max || 8, mode: 'name' } };
}
function skillList(max, source) {
  return { tool: 'skill_list', args: { source: source || 'all', max: max || 50, query: OBJECTIVE } };
}

function planRound() {
  const iter = state.iter;
  const phase = state.phase;
  const q = expanderAt(iter - 1);
  const qAlt = expanderAt(iter + 4);

  // 降级态：只发 kb_search(mode:name)，不碰其它工具
  if (state.degraded) {
    return {
      hypothesis: '已降级：仅 kb_search(mode:name)',
      attempts: [kbName(q, 'redteam', 8), kbName(qAlt, 'tg', 8)],
    };
  }

  if (phase === 'recon') {
    // 奇偶交替：知识库广撒 / 技能目录枚举
    const primary = iter % 2 === 1 ? kbName(q, 'redteam', 8) : skillList(50, 'all');
    const alt = iter % 2 === 1
      ? kbName(qAlt, 'redteam', 8)                       // 失败换关键词
      : skillList(50, 'hermes');                         // 失败换数据源（等价工具变体）
    return { hypothesis: '广撒：kb_search + skill_list', attempts: [primary, alt] };
  }

  if (phase === 'expand') {
    const pick = iter % 3;
    if (pick === 1) {
      const dir = nextScanDir();
      return {
        hypothesis: '扫目录：' + dir,
        attempts: [
          { tool: 'fs_list', args: { path: dir } },
          { tool: 'local_fs_search', args: { query: shortQuery(), path: dir, max: 30 } },
          kbName(q, 'redteam', 10),
        ],
      };
    }
    if (pick === 2) {
      return {
        hypothesis: '技能目录二次检索',
        attempts: [skillList(50, 'all'), skillList(60, 'csv'), kbName(q, 'redteam', 10)],
      };
    }
    return {
      hypothesis: '关键词扩展：' + q,
      attempts: [kbName(q, 'redteam', 10), kbName(q + ' ' + shortQuery(), 'redteam', 10)],
    };
  }

  if (phase === 'deep') {
    const pick = iter % 4;
    const q2 = deepQuery(q);
    if (pick === 0) {
      const p = nextSkillPath();
      return {
        hypothesis: p ? '读技能正文：' + p : '技能路径池为空，回落关键词深挖',
        attempts: p
          ? [{ tool: 'skill_read', args: { path: p } }, { tool: 'kb_read', args: { path: p } }, kbName(q2, 'redteam', 10)]
          : [kbName(q2, 'redteam', 10), skillList(60, 'all')],
      };
    }
    if (pick === 1) {
      const p = nextKbPath();
      return {
        hypothesis: p ? '读知识库正文：' + p : '知识库路径池为空，回落关键词深挖',
        attempts: p
          ? [{ tool: 'kb_read', args: { path: p } }, { tool: 'skill_read', args: { path: p } }, kbName(q2, 'redteam', 10)]
          : [kbName(q2, 'redteam', 10), skillList(60, 'all')],
      };
    }
    if (pick === 3) {
      return { hypothesis: '深挖阶段补充技能目录', attempts: [skillList(60, 'all'), kbName(q2, 'redteam', 10)] };
    }
    return { hypothesis: '从命中抽线索再检索', attempts: [kbName(q2, 'redteam', 10), kbName(q, 'redteam', 10)] };
  }

  // sustain
  const pick = iter % 4;
  if (pick === 0) {
    const url = nextUrl();
    const web = url ? webCallFor(url) : null;
    if (web) {
      return {
        hypothesis: '外部取证：' + url,
        attempts: [web, kbName(q, 'tg', 12), kbName(q, 'redteam', 12)],
      };
    }
  }
  if (pick === 1) {
    return {
      hypothesis: 'tg 情报轮询 + 红队库兜底',
      attempts: [kbName(q, 'tg', 12), kbName(q, 'redteam', 12)],
    };
  }
  if (pick === 3) {
    return { hypothesis: '技能库持续枚举', attempts: [skillList(80, 'all'), kbName(q, 'redteam', 12)] };
  }
  return {
    hypothesis: '红队库持续迭代：' + q,
    attempts: [kbName(q, 'redteam', 12), kbName(qAlt, 'tg', 12)],
  };
}

// ── 单轮执行 ─────────────────────────────────────────────────────────────
function appendEvidence(txt) {
  RECENT += '\n' + String(txt).slice(0, 60000);
  if (RECENT.length > EVIDENCE_CAP) RECENT = RECENT.slice(-EVIDENCE_CAP);
}

function checkDoneKeywords() {
  if (!DONE_KWS.length) return false;
  const low = RECENT.toLowerCase();
  for (const kw of DONE_KWS) {
    if (kw && low.includes(kw.toLowerCase())) {
      state.done = true;
      state.status = 'done';
      state.stop_reason = '命中完成关键词: ' + kw;
      logLine({ phase: state.phase, action: 'done', keyword: kw });
      return true;
    }
  }
  return false;
}

async function tryCall(c, idx, total) {
  const t0 = Date.now();
  logLine({ phase: state.phase, action: 'call', tool: c.tool, args: c.args, attempt: idx + 1, of: total });
  const r = await callTool(c.tool, c.args);
  const ms = Date.now() - t0;
  if (r.ok) return { ok: true, r, ms };
  const cls = classifyError(r);
  const err = r.error || ('HTTP ' + r.status);
  state.last_error = String(err).slice(0, 300);
  state.last_ms = ms;
  healthFail(c.tool, cls, ms, err);
  if (cls === 'UNKNOWN_TOOL') CAPS[c.tool] = false;   // 桥没这个工具：本轮之后不再选它
  logLine({ phase: state.phase, action: 'error', tool: c.tool, cls, error: state.last_error, ms, attempt: idx + 1, of: total });
  return { ok: false, ms, cls };
}

function handleSuccess(c, r, ms) {
  const txt = resultText(r.result);
  const hash = evidenceHash(txt);
  state.last_tool = c.tool;
  state.last_hash = hash;
  state.last_ms = ms;
  state.last_error = '';
  state.error_streak = 0;                 // 只有成功才清零
  healthOk(c.tool, ms);
  harvest(c.tool, txt);
  harvestUrls(txt);

  if (SEEN.has(hash)) {
    // 证据重复：不计 hits / evidence，但轮次照常推进（去重不等于跳过）
    state.dup_rounds += 1;
    logLine({ phase: state.phase, action: 'dup', tool: c.tool, hash, ms, bytes: txt.length });
    return;
  }
  SEEN.add(hash);
  trimSeen();
  state.uniq_rounds += 1;
  const hits = countHits(c.tool, txt);
  state.hits_total += hits;
  if (txt.length > 200) state.evidence_count += 1;
  appendEvidence(txt);
  logLine({
    phase: state.phase, action: 'hit', tool: c.tool, hash, ms,
    bytes: txt.length, hits, sample: txt.slice(0, 400),
  });
  checkDoneKeywords();
}

async function oneRound() {
  state.iter += 1;
  state.phase = phaseOf(state.iter);
  const plan = planRound();
  state.last_hypothesis = plan.hypothesis;
  state.last_action = plan.attempts.map(a => a.tool).join('→') + ' ' + JSON.stringify(plan.attempts[0].args).slice(0, 160);
  logLine({ phase: state.phase, action: 'plan', plan: plan.attempts.map(a => a.tool), hypothesis: plan.hypothesis });

  let last = null;
  for (let i = 0; i < plan.attempts.length; i++) {
    const out = await tryCall(plan.attempts[i], i, plan.attempts.length);
    last = out;
    if (out.ok) { handleSuccess(plan.attempts[i], out.r, out.ms); break; }
  }

  if (last && !last.ok) {
    // 全轮失败：不终止、不放弃；只累计失败并判定是否降级
    state.error_streak += 1;
    if (state.error_streak >= ERROR_STREAK_LIMIT && !state.degraded) {
      state.degraded = true;
      state.degraded_at_iter = state.iter;
      logLine({
        phase: state.phase, action: 'degrade', error_streak: state.error_streak,
        rule: '仅剩 kb_search(mode:name)，直到进程重启',
      });
    }
  }

  // 轮次上限放在「无论成败」都判的位置：v1 只在成功轮判，桥全挂时 max_iters 永远达不到
  if (!state.done && MAX_ITERS > 0 && state.iter >= MAX_ITERS) {
    state.done = true;
    state.status = 'done';
    state.stop_reason = '达到轮次上限 ' + MAX_ITERS;
    logLine({ phase: state.phase, action: 'done', reason: state.stop_reason });
  }
}

async function main() {
  logLine({
    phase: 'init', action: 'start', objective: OBJECTIVE,
    max_iters: MAX_ITERS, done_keywords: DONE_KWS,
    caps: CAPS, tool_timeout_ms: TOOL_TIMEOUT_MS, scan_dirs: SCAN_DIRS,
  });
  saveSnap();
  // 不拒绝：主循环只有完成 / 用户停止 / 进程被杀三种出口，没有「放弃」
  while (!state.done) {
    if (fs.existsSync(STOPF)) {
      state.status = 'stopped';
      state.stop_reason = '用户停止';
      logLine({ phase: state.phase, action: 'stopped' });
      break;
    }
    try {
      await oneRound();
    } catch (e) {
      // 单轮内任何意外异常都只记一笔，循环继续（下一轮自动换工具/关键词）
      state.last_error = String((e && e.message) || e).slice(0, 300);
      state.error_streak += 1;
      logLine({ phase: state.phase, action: 'exception', error: state.last_error, error_streak: state.error_streak });
      if (state.error_streak >= ERROR_STREAK_LIMIT && !state.degraded) {
        state.degraded = true;
        state.degraded_at_iter = state.iter;
        logLine({ phase: state.phase, action: 'degrade', error_streak: state.error_streak });
      }
    }
    saveSnap();
    if (state.done) break;
    await new Promise(r => setTimeout(r, SLEEP_MS));
  }
  saveSnap();
  logLine({ phase: state.phase, action: 'exit', status: state.status, reason: state.stop_reason });
  process.exit(0);
}

process.on('SIGTERM', () => {
  state.status = 'stopped';
  state.stop_reason = 'SIGTERM';
  saveSnap();
  process.exit(0);
});
process.on('SIGINT', () => {
  state.status = 'stopped';
  state.stop_reason = 'SIGINT';
  saveSnap();
  process.exit(0);
});
// 未处理的 Promise 拒绝不许带走进程：自主迭代要求「不达目标不停」
process.on('unhandledRejection', (e) => {
  try { logLine({ phase: state.phase, action: 'unhandled_rejection', error: String((e && e.message) || e).slice(0, 300) }); } catch (_) {}
});

main().catch(e => {
  state.status = 'error';
  state.last_error = String((e && e.message) || e);
  saveSnap();
  process.exit(1);
});
