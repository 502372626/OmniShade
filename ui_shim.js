// OmniShade 本地 LibreChat UI 支撑服务(API shim + 静态托管)
// 目标: 用已镜像的 LibreChat 前端(desktop/ui/)在本机跑起来, 不依赖 HK 服务端:
//   静态: / 与 /assets/*  → desktop/ui/
//   API : 最小端点集(打开 UI / 登录态 / 会话列表读本地 sessions / 发消息桥接 omni_agent.runAgentLoop)
// 协议要点(与镜像 UI 的 fork 对齐, 见文件内各处注释的 file:line 依据):
//   · 渲染/形状: /api/convos 用 {conversations,nextCursor}; /api/projects 用 {projects,nextCursor};
//     /api/messages/<sid> 与 /api/user/settings/pinned-order、/api/user/settings/favorites、/api/tags、
//     /api/presets 都是裸数组; /api/banner 是 null 或 banner 本体; /api/search/enable 是裸布尔。
//   · 生成走 v2 可续流协议(client/src/hooks/SSE/useAdaptiveSSE.ts 对非 assistants 端点默认启用):
//     POST /api/agents/chat/<endpoint> → JSON {streamId,conversationId,generationCreatedAt,
//     generationProtocolVersion:2}(不是 SSE!); 之后 GET /api/agents/chat/stream/<streamId> 订阅 SSE 帧。
//     不带 v2 标记的 POST 仍按旧协议内联回 SSE(兼容/直连自测)。
// 端口只绑 127.0.0.1; 所有请求落审计日志(不含正文/key)。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pinnedTlsOptions } = require('./omni_tls');
const { handleLootchain } = require('./ui_shim_loot');   // [LOOT-INT 2026-11-07] lootchain 攻击链执行层
const { handleWeapons } = require('./ui_shim_weapons');   // [WEAPON-INT 2026-11-08] 统一武器线执行层
const { readAutomationSettings, writeAutomationSettings, getUserPromptStrength } = require('./automation_store');
const { buildAutomationContext, settingsWithDefaults, parseToolPayload } = require('./automation_runtime');
const { automationPageHtml } = require('./automation_page');

// [SLIM-MSGS] /api/messages 瘦身。
// 实测一个 16 条消息的会话吐 1.1 MB：content 占 99.7%，其中正文(text)只有几 KB，
// 其余全是 think(思维链 40 KB/条) + 几十个 tool_call(单个 output 最大 28 KB)。
// 前端把这些全渲染成 DOM → 打开会话就卡。这里只裁剪"展示用"字段，
// messageId/parentMessageId/content 结构一个不动（lastMessageId 并发校验依赖它们）。
// [PERF-STATUS] /status 缓存：心跳结果 60s，KB 探测 5min（KB 走 ssh -R 隧道，最贵）。
const STATUS_HB_TTL = 60 * 1000;
const STATUS_KB_TTL = 300 * 1000;
const STATUS_CACHE = { hb: null, hbAt: 0, hbKey: '', kb: null, kbAt: 0 };

const SLIM_THINK_KEEP = 1200;      // 思维链只留尾部（结论在最后）
const SLIM_TOOL_OUT_KEEP = 600;    // 工具输出预览
const SLIM_TOOL_ARGS_KEEP = 400;   // 工具入参预览

function slimMessages(list) {
  let trimmed = 0, savedBytes = 0;
  const out = list.map((m) => {
    const c = m && m.content;
    if (!Array.isArray(c)) return m;
    let hit = false;
    const nc = c.map((part) => {
      if (!part || typeof part !== 'object') return part;
      if (part.type === 'think' && typeof part.think === 'string' && part.think.length > SLIM_THINK_KEEP) {
        hit = true; savedBytes += part.think.length - SLIM_THINK_KEEP;
        return { ...part, think: part.think.slice(-SLIM_THINK_KEEP), omniFullLen: part.think.length };
      }
      if (part.type === 'tool_call' && part.tool_call && typeof part.tool_call === 'object') {
        const tc = part.tool_call;
        let th = false;
        const patch = {};
        if (typeof tc.output === 'string' && tc.output.length > SLIM_TOOL_OUT_KEEP) {
          patch.output = tc.output.slice(0, SLIM_TOOL_OUT_KEEP);
          patch.omniOutLen = tc.output.length; th = true;
          savedBytes += tc.output.length - SLIM_TOOL_OUT_KEEP;
        }
        if (typeof tc.args === 'string' && tc.args.length > SLIM_TOOL_ARGS_KEEP) {
          patch.args = tc.args.slice(0, SLIM_TOOL_ARGS_KEEP);
          patch.omniArgsLen = tc.args.length; th = true;
          savedBytes += tc.args.length - SLIM_TOOL_ARGS_KEEP;
        }
        if (th) { hit = true; return { ...part, tool_call: { ...tc, ...patch } }; }
      }
      return part;
    });
    if (!hit) return m;
    trimmed++;
    return { ...m, content: nc };
  });
  return { list: out, trimmed, savedBytes };
}

// [GRANT-MSG] 把 runtime grant 的真实失败原因翻成人话。
// 旧版所有失败统一回「运行时授权获取失败，请重试」——没绑卡、卡过期、卡绑了
// 别的账号在用户眼里长得一模一样，只能反复点重试。服务端已经给了 status/error，
// main.js 的 refreshRuntimeGrant.lastFailure() 会原样带出来，这里必须显示出来。
function omniGrantErrorText(handler) {
  let lf = null;
  try { lf = (handler && typeof handler.lastFailure === 'function') ? handler.lastFailure() : null; } catch (_) {}
  const st = String((lf && lf.status) || '');
  const raw = String((lf && lf.error) || '');
  switch (st) {
    case 'no-license': return '该账号还没有绑定卡密，请在下方「激活卡密」处输入卡密';
    case 'expired': return '授权已到期，请续费后再登录';
    case 'revoked': return '卡密已被吊销，请联系客服';
    case 'bound-other': return '该卡密已绑定其他账号，一张卡只能绑一个账号';
    case 'session-invalid': return '登录已过期，请重新登录';
    case 'missing-account': return '本机未登录账号，请先登录';
    case 'unreachable': return '连不上授权服务器，请检查网络后重试';
    default: return raw ? ('授权失败：' + raw.slice(0, 100)) : '运行时授权获取失败，请重试';
  }
}

const UI_DIR = path.join(__dirname, 'ui');
const APPDATA_DIR = path.join(process.env.APPDATA || os.homedir(), 'omnishade');
const ACCOUNT_FILE = path.join(APPDATA_DIR, 'account.json');
const ACCOUNT_DATA_ROOT = path.join(APPDATA_DIR, 'accounts');
const SHIM_LOG = path.join(APPDATA_DIR, 'ui_shim.log');
const SHIM_LOG_MAX = 2 * 1024 * 1024;   // L8: 日志轮转阈值(2MB → ui_shim.log.1)
let SESSION_DIRTY_GENERATION = 0;

// H1: sid 白名单(会话 id 只允许 URL 安全字符, 长度 ≤ 64)
const SID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function sidOk(sid) { return typeof sid === 'string' && SID_RE.test(sid); }
function normalizeAccountEmail(value) {
  const email = String(value == null ? '' : value).trim().toLowerCase();
  return email && email.length <= 320 ? email : null;
}
function currentAccountEmail() {
  try {
    const account = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
    return account && account.token ? normalizeAccountEmail(account.email) : null;
  } catch (_) { return null; }
}
// [G7-R1] 本机默认命名空间: 未登录(无 account.json / 无 token)时会话与元数据走本机命名空间,
// 登录后才走账号命名空间。哨兵 'local' 不含 '@', 与任何归一后的账号邮箱(必含 '@')不可能碰撞。
const LOCAL_OWNER_ID = 'local';
function resolveOwnerId(owner) {
  return normalizeAccountEmail(owner === undefined ? currentAccountEmail() : owner) || LOCAL_OWNER_ID;
}
function accountScopeKey(owner) {
  const id = resolveOwnerId(owner);
  return crypto.createHash('sha256').update('omnishade-account-sessions-v1\0' + id).digest('hex');
}
function accountDataDir(owner) {
  // 单机单用户：一台电脑就是一个人在使，不再按账号开目录。
  // 切账号照样看得到全部历史会话（老板原话：一台电脑上隔离什么）。
  return APPDATA_DIR;
}
function sessionsDir(owner) {
  // 会话统一落在 <APPDATA>/omnishade/sessions，不再按账号 hash 分目录。
  // 旧版按账号分的存档由 migrateLegacyAccountData() 一次性并进来。
  return path.join(APPDATA_DIR, 'sessions');
}
// [UNIFY-SESSIONS] 旧版按账号 hash 分的会话存档 → 统一目录（幂等，源目录保留不动）。
function migrateLegacyAccountData() {
  const legacyRoot = ACCOUNT_DATA_ROOT;
  const unifiedSessions = path.join(APPDATA_DIR, 'sessions');
  let moved = 0, skipped = 0;
  try { fs.mkdirSync(unifiedSessions, { recursive: true }); } catch (_) {}
  let dirs = [];
  try { dirs = fs.readdirSync(legacyRoot); } catch (_) { return { moved, skipped }; }
  for (const d of dirs) {
    const sd = path.join(legacyRoot, d, 'sessions');
    let files = [];
    try { files = fs.readdirSync(sd); } catch (_) { continue; }
    for (const f of files) {
      if (!f.endsWith('.json') && !f.endsWith('.jsonl')) continue;
      const src = path.join(sd, f);
      const dst = path.join(unifiedSessions, f);
      try {
        if (fs.existsSync(dst)) { skipped++; continue; }   // 同名以已有的为准，不覆盖
        fs.copyFileSync(src, dst);
        moved++;
      } catch (_) { skipped++; }
    }
    // 个人设置/会话标题/置顶：只在统一目录缺的时候补一份
    for (const name of ['user_settings.json', 'titles.json', 'pinned.json']) {
      const src = path.join(legacyRoot, d, name);
      const dst = path.join(APPDATA_DIR, name);
      try {
        if (!fs.existsSync(src)) continue;
        if (fs.existsSync(dst)) continue;
        fs.copyFileSync(src, dst);
      } catch (_) {}
    }
  }
  return { moved, skipped };
}

// L7/L8: 会话文件路径围栏(path.resolve + 分隔符边界; 白名单外或无当前账号一律 null)
function sessionPath(sid, owner) {
  if (!sidOk(sid)) return null;
  const dir = sessionsDir(owner === undefined ? currentAccountEmail() : owner);
  if (!dir) return null;
  const fp = path.resolve(dir, sid + '.jsonl');
  if (fp !== path.join(dir, sid + '.jsonl')) return null;          // 归一后必须仍是同名落点
  if (!fp.startsWith(dir + path.sep)) return null;                 // 必须严格在当前账号 sessions/ 之内
  return fp;
}

function shimLog(line) {
  try {
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
    try {                                                                 // 简单轮转: 超阈值转存 .1(丢弃更早的 .1)
      if (fs.statSync(SHIM_LOG).size > SHIM_LOG_MAX) {
        try { fs.renameSync(SHIM_LOG, SHIM_LOG + '.1'); }
        catch (_) { try { fs.truncateSync(SHIM_LOG, 0); } catch (__) {} }
      }
    } catch (_) {}
    fs.appendFileSync(SHIM_LOG, JSON.stringify({ ts: new Date().toISOString(), ...line }) + '\n');
  } catch (_) {}
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2',
};

// ── 会话(sessions/*.jsonl) → LibreChat convo/message ──
// MinimalConversation = Pick<TConversation, conversationId|endpoint|title|createdAt|updatedAt|
//   archivedAt|isArchived|user|chatProjectId|pinned>(data-provider/src/types/queries.ts:28)
function minimalConversation(sid, title, iso, extra, owner) {
  const ownerId = normalizeAccountEmail(owner === undefined ? currentAccountEmail() : owner);
  return {
    conversationId: sid, title, createdAt: iso, updatedAt: iso, endpoint: 'agents',
    archivedAt: null, isArchived: false, user: ownerId, chatProjectId: null, pinned: false,
    ...(extra || {}),
  };
}
// ── 工具调用 → LibreChat content part ──
// 形状来自镜像 bundle 实读: 渲染器 eventSelection.CHc8lDaG.js Pi() 要求 part.type==='tool_call'
// 且 part.tool_call 含 args(可为空串) / name / output / progress; data-testid="tool-call" 由此渲染。
const TOOL_ARG_LIMIT = 4000, TOOL_OUT_LIMIT = 60000;
function _asText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}
function _clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…[truncated ' + (s.length - n) + ' chars]' : s; }
function toolCallPart(id, name, args, output, progress) {
  return {
    type: 'tool_call',
    tool_call: {
      id: String(id || ('call_' + (name || 'tool'))),
      name: String(name || 'tool'),
      args: _clip(_asText(args), TOOL_ARG_LIMIT),
      output: _clip(_asText(output), TOOL_OUT_LIMIT),
      progress: progress == null ? 1 : progress,
    },
  };
}
function textPart(v) { return { type: 'text', text: { value: String(v == null ? '' : v) } }; }
// assistant 消息内容组装: 先工具卡(按调用顺序)再正文文本
function assistantContent(toolCalls, text, reasoning) {
  const parts = [];
  if (reasoning) parts.push({ type: 'think', think: String(reasoning) });   // [1.1.31] 思维链块(fork ContentTypes.THINK 原生渲染)
  for (const tc of (toolCalls || [])) parts.push(toolCallPart(tc.id, tc.name, tc.args, tc.output, tc.progress));
  if (text || parts.length === 0) parts.push(textPart(text));
  return parts;
}
const { messageGroups, projectSessionRows } = require('./session_messages_worker');
function sessionMessages(ag, sid, owner) {
  if (!sessionPath(sid, owner)) { shimLog({ stage: 'sid-rejected-read', sid: String(sid).slice(0, 80) }); return []; }
  let raw = [];
  try { raw = ag.loadSession(sid, owner) || []; } catch (_) {}
  return projectSessionRows(raw, sid);
}
// 真实工具调用流水(GET /api/agents/tools/calls): 从各会话 jsonl 重建 assistant.tool_calls × 工具结果
function sessionToolCalls(ag, limit, owner, conversationId) {
  const lim = limit || 200;
  const rows = [];
  let sessions = [];
  // [G95] 尊重 conversationId：只解析当前会话（前端每次切换都带，原来无视参数扫 50 个会话=纯 bug，
  // 单次 246ms 主线程阻塞，正好把 /api/messages 的响应往后推 → 点击/切换发木）。
  if (conversationId) {
    sessions = [{ id: String(conversationId), mtime: Date.now() }];
  } else {
    try { sessions = (ag.listSessions(owner) || []).slice(0, 50); } catch (_) {}
  }
  for (const s of sessions) {
    let raw = [];
    try { raw = ag.loadSession(s.id, owner) || []; } catch (_) { continue; }
    const outs = new Map();
    for (const m of raw) if (m && m.role === 'tool' && m.tool_call_id != null) outs.set(String(m.tool_call_id), _asText(m.content));
    raw.forEach((m, i) => {
      if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) return;
      for (const c of m.tool_calls) {
        const fn = (c && c.function) || {};
        rows.push({
          id: String((c && c.id) || ('call_' + s.id + '_' + i)),
          conversationId: s.id, messageId: 'msg_' + s.id + '_' + i,
          toolId: String(fn.name || ''), toolName: String(fn.name || ''),
          args: _clip(_asText(fn.arguments), TOOL_ARG_LIMIT),
          output: _clip(outs.get(String(c && c.id)) || '', TOOL_OUT_LIMIT),
          status: outs.has(String(c && c.id)) ? 'completed' : 'pending',
          createdAt: new Date(s.mtime || Date.now()).toISOString(),
        });
      }
    });
  }
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return rows.slice(0, lim);
}
// Conversation sidebar metadata must never deserialize every JSONL via agent.loadSession().
// A bounded first-chunk read is enough to recover the first user title; cache entries are invalidated by mtime.
const SESSION_TITLE_CACHE = new Map();
const SESSION_TITLE_READ_BYTES = 24 * 1024;
function sessionTitleFromDisk(sid, mtime, owner) {
  const key = String(accountScopeKey(owner) || '') + ':' + String(sid || '');
  const stamp = Number(mtime || 0);
  const cached = SESSION_TITLE_CACHE.get(key);
  if (cached && cached.mtime === stamp) return cached.title;
  let title = '';
  const fp = sessionPath(sid, owner);
  if (fp) {
    try {
      const fd = fs.openSync(fp, 'r');
      try {
        const buf = Buffer.alloc(SESSION_TITLE_READ_BYTES);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        const lines = buf.toString('utf8', 0, n).split(/\r?\n/);
        for (const line of lines) {
          if (!line) continue;
          let row = null; try { row = JSON.parse(line); } catch (_) { continue; }
          if (row && row.role === 'user' && !row.meta && row.content != null) {
            title = String(row.content).replace(/\s+/g, ' ').trim().slice(0, 60);
            if (title) break;
          }
        }
      } finally { try { fs.closeSync(fd); } catch (_) {} }
    } catch (_) {}
  }
  SESSION_TITLE_CACHE.set(key, { mtime: stamp, title });
  // Keep memory bounded on long-lived desktop sessions.
  if (SESSION_TITLE_CACHE.size > 2048) SESSION_TITLE_CACHE.delete(SESSION_TITLE_CACHE.keys().next().value);
  return title;
}
function conversationState(owner) {
return { tags: convoTagsStore(owner), pinned: pinnedSet(owner), archived: archivedSet(owner), projects: projectsStore(owner) };
}
// Full-text session search can read hundreds of JSONL files. Keep it out of the shim/main loop
// and paginate the scan so a result beyond the first batch is never misreported as absent.
function searchCursorDecode(raw, query) {
  if (!raw) return 0;
  try {
    const p = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (!p || p.q !== String(query) || !Number.isInteger(p.o) || p.o < 0) throw new Error('bad cursor');
    return p.o;
  } catch (_) { throw new Error('invalid search cursor'); }
}
function searchCursorEncode(query, offset) {
  return Buffer.from(JSON.stringify({ q: String(query), o: Number(offset) }), 'utf8').toString('base64url');
}
function searchSessionsWorker(list, query, offset, owner) {
  const { Worker } = require('worker_threads');
  const workerPath = path.join(__dirname, 'session_search_worker.js');
  const dir = sessionsDir(owner);
  if (!dir) return Promise.resolve({ hits: [], nextOffset: null });
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: {
      sessionsDir: dir, sessions: Array.isArray(list) ? list : [], query: String(query || ''),
      titles: loadTitles(owner), offset: Number(offset) || 0, batchSize: 100, resultLimit: 50,
    } });
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const timer = setTimeout(() => { try { worker.terminate(); } catch (_) {} finish(reject, new Error('session search timeout')); }, 20000);
    worker.on('message', (m) => {
      if (m && m.ok) return finish(resolve, m.result || { hits: [], nextOffset: null });
      finish(reject, new Error(String((m && m.error) || 'session search failed').slice(0, 500)));
    });
    worker.on('error', (e) => finish(reject, e));
    worker.on('exit', (code) => { if (!settled) finish(reject, new Error('session search worker exited ' + code)); });
  });
}
function convoOf(ag, sid, mtime, state, owner) {
  const custom = loadTitles(owner)[sid];                                            // [1.1.31] 改名覆盖优先
  const title = custom || sessionTitleFromDisk(sid, mtime, owner) || '(空会话)';
  const iso = new Date(mtime || Date.now()).toISOString();
  const st = state || conversationState(owner);
  return { ...minimalConversation(sid, title, iso, null, owner), model: null, modelLabel: null,
    tags: (st.tags.convos[sid] || []), pinned: st.pinned.has(sid), isArchived: st.archived.has(sid),
    ...(st.projects.convos[sid] ? { chatProjectId: st.projects.convos[sid] } : {}), files: [] };
}
function appendLocal(ag, sid, msg, owner) {
  const fp = sessionPath(sid, owner);                                             // H1: 写路径围栏
  if (!fp) { shimLog({ stage: 'sid-rejected-write', sid: String(sid).slice(0, 80) }); return false; }
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.appendFileSync(fp, JSON.stringify(msg) + '\n');
    SESSION_DIRTY_GENERATION++;
    return true;
  } catch (e) { shimLog({ stage: 'append-fail', err: String(e && e.message || e).slice(0, 120) }); return false; }
}

// Conversation-side metadata shares the same account namespace as JSONL sessions.
function accountDataFile(name, owner) {
  const dir = accountDataDir(owner === undefined ? currentAccountEmail() : owner);
  return dir ? path.join(dir, name) : null;
}
const titlesCaches = new Map();
function loadTitles(owner) {
  const id = normalizeAccountEmail(owner === undefined ? currentAccountEmail() : owner);
  if (!id) return {};
  const key = accountScopeKey(id);
  if (titlesCaches.has(key)) return titlesCaches.get(key);
  let data = {};
  const file = accountDataFile('titles.json', id);
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { data = {}; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  titlesCaches.set(key, data);
  return data;
}
function saveTitles(owner) {
  const id = normalizeAccountEmail(owner === undefined ? currentAccountEmail() : owner);
  const file = accountDataFile('titles.json', id);
  if (!file) return;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(loadTitles(id))); } catch (_) {}
}

// [1.1.32] 通用 JSON 存取(tags/presets/pinned/archived/feedback/memories/projects 落盘)
function loadJsonStore(file, def) {
  const target = typeof file === 'function' ? file() : file;
  if (!target) return def;
  try { const d = JSON.parse(fs.readFileSync(target, 'utf8')); return (d === null || d === undefined) ? def : d; } catch (_) { return def; }
}
function saveJsonStore(file, data) {
  const target = typeof file === 'function' ? file() : file;
  if (!target) return;
  try { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(data)); } catch (_) {}
}
const TAGS_FILE = (owner) => accountDataFile('tags.json', owner);
const PRESETS_FILE = (owner) => accountDataFile('presets.json', owner);
const PINNED_FILE = (owner) => accountDataFile('pinned.json', owner);
const ARCHIVED_FILE = (owner) => accountDataFile('archived.json', owner);
const FEEDBACK_FILE = (owner) => accountDataFile('feedback.json', owner);
const MEMORIES_FILE = (owner) => accountDataFile('memories.json', owner);
const PROJECTS_FILE = (owner) => accountDataFile('projects.json', owner);
const WORKFLOW_TEMPLATES_FILE = (owner) => accountDataFile('workflow_templates.json', owner);
const MAX_WORKFLOW_TEMPLATES = 100;
function pinnedSet(owner) { return new Set(loadJsonStore(PINNED_FILE(owner), [])); }
function archivedSet(owner) { return new Set(loadJsonStore(ARCHIVED_FILE(owner), [])); }
function convoTagsStore(owner) { const t = loadJsonStore(TAGS_FILE(owner), { defs: [], convos: {} }); if (!t || typeof t !== 'object') return { defs: [], convos: {} }; if (!t.convos) t.convos = {}; return t; }
function projectsStore(owner) { const t = loadJsonStore(PROJECTS_FILE(owner), { projects: [], convos: {} }); if (!t || typeof t !== 'object') return { projects: [], convos: {} }; if (!t.projects) t.projects = []; if (!t.convos) t.convos = {}; return t; }
function workflowTemplates(owner) {
  const rows = loadJsonStore(WORKFLOW_TEMPLATES_FILE(owner), []);
  return Array.isArray(rows) ? rows.filter((row) => row && typeof row.id === 'string').slice(0, MAX_WORKFLOW_TEMPLATES) : [];
}
function workflowTemplateInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('模板必须为 JSON 对象');
  const name = String(body.name || '').trim();
  const description = String(body.description || '').trim();
  const prompt = String(body.prompt || '');
  const toolIds = Array.isArray(body.toolIds) ? [...new Set(body.toolIds.map(String).filter((id) => /^[A-Za-z0-9_.:-]{1,128}$/.test(id)))].slice(0, 64) : [];
  if (!name || name.length > 80) throw new RangeError('模板名称必填且不超过 80 字符');
  if (description.length > 240) throw new RangeError('模板说明不超过 240 字符');
  if (!prompt || prompt.length > 16000) throw new RangeError('模板指令必填且不超过 16000 字符');
  return { name, description, prompt, toolIds };
}

// [1.1.31] 删除会话(复用 sessionPath 的 H1 路径围栏)
function deleteSessionLocal(sid, owner) {
  const fp = sessionPath(sid, owner);
  if (!fp) return false;
  try { if (fs.existsSync(fp)) { fs.unlinkSync(fp); SESSION_DIRTY_GENERATION++; return true; } } catch (_) {}
  return false;
}

// ── 角色权限 payload ──
// 依据 fork: packages/data-provider/src/roles.ts:145 `roleDefaults` + permissions.ts 各
// xxxPermissionsSchema 的 zod `.default(true)`(服务端 seed 后 DB 回读即此形状)。
// key 是大写枚举(PermissionTypes.AGENTS='AGENTS' / Permissions.USE='USE');
// 客户端 useHasAccess 判定 `roles[user.role]?.permissions?.[type]?.[perm] === true`(client/src/hooks/Roles/useHasAccess.ts:32)。
const S = { t: true, f: false };
const ROLE_DEFAULTS = {
  ADMIN: { name: 'ADMIN', permissions: {
    PROMPTS: { USE: S.t, CREATE: S.t, SHARE: S.t, SHARE_PUBLIC: S.t },
    BOOKMARKS: { USE: S.t },
    MEMORIES: { USE: S.t, CREATE: S.t, UPDATE: S.t, READ: S.t, OPT_OUT: S.t },
    AGENTS: { USE: S.t, CREATE: S.t, SHARE: S.t, SHARE_PUBLIC: S.t },
    MULTI_CONVO: { USE: S.t }, TEMPORARY_CHAT: { USE: S.t }, RUN_CODE: { USE: S.t }, WEB_SEARCH: { USE: S.t },
    PEOPLE_PICKER: { VIEW_USERS: S.t, VIEW_GROUPS: S.t, VIEW_ROLES: S.t },
    MARKETPLACE: { USE: S.f }, FILE_SEARCH: { USE: S.t }, FILE_CITATIONS: { USE: S.t },   // [1.1.32] B5: 空市场不显示
    MCP_SERVERS: { USE: S.t, CREATE: S.f, SHARE: S.t, SHARE_PUBLIC: S.t, CONFIGURE_OBO: S.t },   // [1.1.32] B4: MCP Builder 不显示
    REMOTE_AGENTS: { USE: S.f, CREATE: S.f, SHARE: S.t, SHARE_PUBLIC: S.t },   // [1.1.32] B3: Agent API Keys 不显示
    SKILLS: { USE: S.t, CREATE: S.t, SHARE: S.t, SHARE_PUBLIC: S.t },
    SHARED_LINKS: { CREATE: S.f, SHARE: S.t, SHARE_PUBLIC: S.t },   // [1.1.32] B7: 分享创建不显示
    SCHEDULES: { USE: S.t, CREATE: S.t },
  } },
  // USER: SHARE/SHARE_PUBLIC 按 roles.ts 显式 false; 其余组取 schema zod default(true)
  // (否则 agents/prompts 面在 UI 里被判为无权限, 模型选择器/侧栏会整片消失)
  USER: { name: 'USER', permissions: {
    PROMPTS: { USE: S.t, CREATE: S.t, SHARE: S.f, SHARE_PUBLIC: S.f },
    BOOKMARKS: { USE: S.t },
    MEMORIES: { USE: S.t, CREATE: S.t, UPDATE: S.t, READ: S.t, OPT_OUT: S.t },
    AGENTS: { USE: S.t, CREATE: S.t, SHARE: S.f, SHARE_PUBLIC: S.f },
    MULTI_CONVO: { USE: S.t }, TEMPORARY_CHAT: { USE: S.t }, RUN_CODE: { USE: S.t }, WEB_SEARCH: { USE: S.t },
    PEOPLE_PICKER: { VIEW_USERS: S.f, VIEW_GROUPS: S.f, VIEW_ROLES: S.f },
    MARKETPLACE: { USE: S.f }, FILE_SEARCH: { USE: S.t }, FILE_CITATIONS: { USE: S.t },
    MCP_SERVERS: { USE: S.t, CREATE: S.f, SHARE: S.f, SHARE_PUBLIC: S.f, CONFIGURE_OBO: S.f },
    REMOTE_AGENTS: { USE: S.f, CREATE: S.f, SHARE: S.f, SHARE_PUBLIC: S.f },
    SKILLS: { USE: S.t, CREATE: S.t, SHARE: S.f, SHARE_PUBLIC: S.f },
    SHARED_LINKS: { CREATE: S.t, SHARE: S.t, SHARE_PUBLIC: S.t },
    SCHEDULES: { USE: S.t, CREATE: S.t },
  } },
};
function rolePayload(name) { return ROLE_DEFAULTS[String(name).toUpperCase()] || { name: String(name), permissions: ROLE_DEFAULTS.USER.permissions }; }

// [账号系统] 无本地用户；唯一身份来自已验证的注册账号会话。
// [1.1.62] 无本地用户: 只有注册账号(未登录 → 401 → fork 原生登录页 = 账号登录)
function accountUser() {
  try {
    const p = require('path').join(process.env.APPDATA || require('os').homedir(), 'omnishade', 'account.json');
    const acct = JSON.parse(require('fs').readFileSync(p, 'utf8'));
    if (!acct || !acct.email) return null;
    return { id: acct.email, username: acct.email, name: acct.email, email: acct.email, provider: 'local', role: 'USER', emailVerified: true };
  } catch (_) { return null; }
}
function localUser() { return accountUser(); }

// ── SSE 帧(LibreChat v0.8.8 协议: event: message + content[{type:text}] / event: final) ──
// [G17-P1] LibreChat v2 协议哨兵: run step 帧的 runId 取这个常量时, 渲染层会替换成当前预备响应消息 id
const RUN_STEP_SENTINEL_RUNID = 'USE_PRELIM_RESPONSE_MESSAGE_ID';
function sseFrame(event, obj) { return 'event: ' + event + '\ndata: ' + JSON.stringify(obj) + '\n\n'; }
function sendSseHead(res, extraHeaders) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    ...(extraHeaders || {}),
  });
  if (typeof res.flushHeaders === 'function') { try { res.flushHeaders(); } catch (_) {} }
}
// M5: SSE 收尾的唯一实现(DONE + end); 幂等 —— 已结束/已销毁则什么都不做
function endSse(res) {
  try {
    if (!res || res.writableEnded || res.destroyed) return;
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (_) {}
}

// L8: 超限 → 丢弃剩余 body(drain) 后回 413, promise 必须 settle(旧实现 destroy 后 promise 永久挂起)
function readBody(req, res) {
  return new Promise((resolve) => {
    const MAX = 8e6;
    let b = '', done = false, tooLarge = false;
    const send413 = () => {
      try {
        if (res && !res.headersSent) {
          const payload = JSON.stringify({ error: 'payload too large' });
          res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), Connection: 'close' });
          res.end(payload);
        }
      } catch (_) {}
    };
    const settle = (v) => { if (done) return; done = true; clearTimeout(guard); resolve(v); };
    // 兜底: 客户端半途不发完也不让请求挂着
    const guard = setTimeout(() => { if (!done) { send413(); try { req.destroy(); } catch (_) {} settle({ __tooLarge: true }); } }, 30000);
    if (guard && guard.unref) guard.unref();
    const onData = (c) => {
      if (done || tooLarge) return;                  // 超限后只丢弃, 不再累积(内存有界)
      b += c;
      if (b.length > MAX) {
        tooLarge = true;
        shimLog({ stage: 'body-too-large', url: String(req.url).slice(0, 200), got: b.length });
        b = '';
        try { req.resume(); } catch (_) {}
      }
    };
    const onEnd = () => { if (done) return; if (tooLarge) { send413(); settle({ __tooLarge: true }); return; } try { settle(b ? JSON.parse(b) : {}); } catch (_) { settle({ __raw: b }); } };
    const onErr = () => { if (done) return; if (tooLarge) { send413(); settle({ __tooLarge: true }); return; } settle({ __readError: true }); };
    req.on('data', onData); req.on('end', onEnd); req.on('error', onErr);
  });
}

// H1: 渲染层注入 — 把本机随机会话 token 塞进 fetch/XHR(仅同源 /api/*), 并暴露到 window
function bootstrapJs(token) {
  return '(function(){var T=' + JSON.stringify(token) + ',O=location.origin;'
    + 'function api(u){try{var a=new URL(u,location.href);return a.origin===O&&a.pathname.indexOf("/api/")===0;}catch(_){return false;}}'
    + 'try{window.__OMNI_SHIM_TOKEN__=T;}catch(_){}'
    + 'try{if(localStorage.getItem("autoScroll")===null)localStorage.setItem("autoScroll","true");if(localStorage.getItem("showThinking")===null)localStorage.setItem("showThinking","true");}catch(_){}'
    // Visible entries belong to the React title strip; head-immediate auth stays here.
    + 'var of=window.fetch;'
    + 'window.fetch=function(input,init){try{if(api(typeof input==="string"?input:(input&&input.url)||"")){init=init||{};'
    + 'var h=new Headers(init.headers||(input&&input.headers)||{});h.set("Authorization","Bearer "+T);init.headers=h;}}catch(_){}'
    + 'return of.call(this,input,init);};'
    + 'try{var X=XMLHttpRequest.prototype,_o=X.open,_s=X.setRequestHeader,_d=X.send,W=new WeakMap(),H=new WeakSet();'
    + 'X.open=function(m,u){try{W.set(this,new URL(u,location.href));}catch(_){W.set(this,null);}return _o.apply(this,arguments);};'
    + 'X.setRequestHeader=function(k,v){try{var u=W.get(this);if(u&&api(u.href)&&String(k).toLowerCase()==="authorization"){v="Bearer "+T;H.add(this);}}catch(_){}return _s.call(this,k,v);};'
    + 'X.send=function(){try{var u=W.get(this);if(u&&api(u.href)&&!H.has(this)){_s.call(this,"Authorization","Bearer "+T);}}catch(_){}return _d.apply(this,arguments);};}catch(_){}'
    // [G7-R3] 账号入口: bootstrap 在 <head> 注入, 此时 document.body 还是 null —— 必须挂 DOMContentLoaded
    // 等 body 就绪再 appendChild。旧实现直接在 head 阶段 appendChild(会抛/静默丢入口), 现按契约延迟挂载。
    + 'try{var AC=function(){try{if(!document.body)return;if(location.pathname.indexOf("/omni-register")>=0)return;'
    + 'if(document.getElementById&&document.getElementById("omni-account-entry"))return;'
    + 'var b=document.createElement("a");b.id="omni-account-entry";b.href="/omni-register";b.target="_blank";'
    + 'b.textContent="账号登录 / 注册";'
     // 已登录时这个角标就地变成「退出登录」：主界面本来没有注销入口，用户只能登不能退。
     + 'try{fetch("/api/user").then(function(r){if(!r||!r.ok)return;b.textContent="退出登录";b.title="当前已登录，点击退出";'
     + 'b.onclick=function(ev){ev.preventDefault();if(!confirm("确认退出登录？退出后需要重新输入邮箱和密码。"))return;'
     + 'fetch("/api/auth/logout",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})'
     + '.then(function(){location.reload();}).catch(function(){alert("退出失败，请重试");});};}).catch(function(){});}catch(_){}'
    // [G52-F3] 顶栏 CTA 收成青绿描边，与页内 button.primary 同一形制（8px 圆角 / accent 描边 /
    // accent/.12 底 / 12px 字号）。原来这里是 #4A7DFF 实心 + 18px 圆角（约 30px 高即全胶囊），
    // 全站唯一一处蓝，跟页内青绿描边体系是两套语言。取 var 时带三元组兜底，保证 aux 页/SPA 都能解析。
    + 'b.style.cssText="position:fixed;top:10px;right:14px;z-index:99999;background:rgb(var(--accent-primary,114 215 211)/.12);color:rgb(var(--accent-primary,114 215 211));border:1px solid rgb(var(--accent-primary,114 215 211));padding:6px 12px;border-radius:8px;font-size:12px;line-height:16px;font-weight:650;text-decoration:none;box-shadow:none";'
    + 'document.body.appendChild(b);}catch(_){}};'
    + 'if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",AC);}else{AC();}}catch(_){}'
    + '})();';
}
// [G17-P1-fix] 窗口/标签页标题: 镜像产物 ui/index.html 写死 <title>LibreChat</title>, 而桌面端是 OmniShade
// (与 /api/config 的 appTitle 必须一致, 否则任务栏/标签页显示第三方品牌名)。
// 只换 SPA 壳首页的 title(路由切换不重写 title, 换它就够); 已是 OmniShade 则不动 —— 幂等, 未来产物改名也不炸。
function injectAppTitle(html) {
  if (/<title>\s*OmniShade\s*<\/title>/i.test(html)) return html;
  return html.replace(/<title>[^<]*<\/title>/i, '<title>OmniShade</title>');
}
function injectBootstrap(html, token) {
  const tag = '<script id="omni-shim-auth">' + bootstrapJs(token) + '</scr' + 'ipt>';
  if (html.indexOf('<head>') >= 0) return html.replace('<head>', '<head>' + tag);
  return tag + html;
}

// [G7-R6] 官网入口: 桌面端镜像 UI(LibreChat 产物)必须与 chat.html 一致带固定官网动作。
// 走 preload 暴露的 openOfficialSite → ipcMain 'omni:open-official-site' → shell.openExternal(固定 URL):
// 页面里不拼可改写的外链(防篡改/防钓鱼); preload 缺失时降级为直接开固定 URL。
function injectOfficialSiteEntry(html) {
  if (html.indexOf('omni-official-site') >= 0) return html;      // 幂等: 已注入过就不再加
  const snippet = '<a id="omni-official-site" href="https://omnishade.czyundun.cn/" target="_blank" rel="noopener noreferrer"'
    + ' title="OmniShade 官方网站"'
    + ' onclick="try{if(window.openOfficialSite){window.openOfficialSite();return false;}}catch(_){}"'
    // [G52-F3b] 同一形制的第二处：右下角「官方网站」原来是 rgba(74,125,255,.92) 实心胶囊，
    // 和顶栏 CTA 一样的蓝。既然定了「单强调色 = 青绿」，这处改为中性描边（不抢强调色），
    // 只留形制统一（8px 圆角 / 12px / 同内距）。
    + ' style="position:fixed;bottom:12px;right:14px;z-index:99999;background:rgb(var(--surface-secondary,11 16 23)/.92);color:rgb(var(--text-secondary,180 193 206));'
    + 'border:1px solid rgb(var(--border-medium,54 73 93));padding:6px 12px;border-radius:8px;font-size:12px;line-height:16px;text-decoration:none;box-shadow:none">'
    + '官方网站</a>';
  if (html.indexOf('</body>') >= 0) return html.replace('</body>', snippet + '\n  </body>');
  return html + snippet;
}

// [发布通道] 更新入口: 复用 index.html 注入点挂 ui/omni-update-entry.js。
// 脚本自己通过 preload 的 window.omnishade.latestUpdate 取状态; 没有 preload 的纯浏览器环境脚本直接 return,
// 所以这里不需要判断运行环境。defer 保证不阻塞 SPA 首屏。
function injectUpdateEntry(html) {
  // [G102 2026-11-10] 恢复：老板要求旧版必须看到新版本提示（G94 曾按"别弹"整条关掉，
  // 结果老客户永远升不上来，永远看到旧的授权显示）。提示形态仍是非打断 pill，带稍后/关闭。
  if (html.indexOf('omni-update-entry.js') >= 0) return html;      // 幂等
  const tag = '<script src="/omni-update-entry.js" defer></script>';
  if (html.indexOf('</body>') >= 0) return html.replace('</body>', tag + '\n  </body>');
  return html + tag;
}
// [PERF-RENDER] 消息默认只渲染最近 5 条（/api/messages 窗口化），
// 长会话不再一次塞几百条 DOM。上翻看历史点按钮，拉全量后以只读面板展示。
// 实现放 ui/omni-history-more.js（静态文件），这里只注入 script 标签，避免在 shim 里拼大段模板字符串。
function injectHistoryMoreEntry(html) {
  if (html.indexOf('omni-history-more.js') >= 0) return html;      // 幂等
  const tag = '<script src="/omni-history-more.js" defer></script>';
  if (html.indexOf('</body>') >= 0) return html.replace('</body>', tag + '\n  </body>');
  return html + tag;
}
// [UX-CTXMENU 2026-11-07] 会话列表右键=管理菜单（重命名/删除/归档）：渲染层接管
function injectCtxMenuEntry(html) {
  if (html.indexOf('omni-ctx-menu.js') >= 0) return html;          // 幂等
  const tag = '<script src="/omni-ctx-menu.js" defer></script>';
  if (html.indexOf('</body>') >= 0) return html.replace('</body>', tag + '\n  </body>');
  return html + tag;
}
// [AUTO-SESSION 2026-11-08] 自动化中心进聊天：header 按钮=抽屉（不跳独立页），零开关零配置
function injectAutoPanelEntry(html) {
  if (html.indexOf('omni-auto-panel.js') >= 0) return html;        // 幂等
  const tag = '<script src="/omni-auto-panel.js" defer></script>';
  if (html.indexOf('</body>') >= 0) return html.replace('</body>', tag + '\n  </body>');
  return html + tag;
}
// [UX-HOTKEYS 2026-11-08] 全局快捷键体系（Ctrl+K 搜索/Ctrl+N 新会话/Ctrl+L 聚焦输入/Ctrl+F 查找/Esc 关浮层）
function injectHotkeysEntry(html) {
  if (html.indexOf('omni-hotkeys.js') >= 0) return html;           // 幂等
  const tag = '<script src="/omni-hotkeys.js" defer></script>';
  if (html.indexOf('</body>') >= 0) return html.replace('</body>', tag + '\n  </body>');
  return html + tag;
}
// 从 LibreChat 请求体里挖出用户输入(多形态兜底)
function extractPrompt(body) {
  const pick = (c) => {
    if (!c) return '';
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((p) => (p && p.text && p.text.value) || (p && p.text) || '').join('');
    if (c.text) return c.text.value || '';
    return '';
  };
  if (typeof body.text === 'string' && body.text) return body.text;
  for (const key of ['messages', 'history']) {
    const arr = body[key];
    if (Array.isArray(arr) && arr.length) {
      for (let i = arr.length - 1; i >= 0; i--) {
        const m = arr[i];
        if (m && (m.isCreatedByUser || m.role === 'user')) {
          const t = pick(m.content) || (typeof m.text === 'string' ? m.text : '');
          if (t) return t;
        }
      }
    }
  }
  return pick(body.content) || '';
}

// Advanced.tsx:43-46 sends promptPrefix; endpoint payloads may nest it in
// endpointOption. Only an explicit string edits the account setting ('' clears,
// null/omitted preserves); never copy arbitrary request settings onto disk.
function saveUserSystemPrompt(body, owner) {
  let value;
  for (const source of [body, body && body.endpointOption, body && body.conversation]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const key of ['promptPrefix', 'instructions', 'USER_SYSTEM_PROMPT']) {
      if (!Object.prototype.hasOwnProperty.call(source, key) || source[key] == null) continue;
      if (typeof source[key] !== 'string' || source[key].length > 32000) {
        const e = new Error('用户前置提示词必须为字符串且不超过 32000 字符'); e.status = 400; throw e;
      }
      value = source[key]; break;
    }
    if (value !== undefined) break;
  }
  if (value === undefined) return;
  const file = accountDataFile('user_settings.json', owner);
  const current = readAutomationSettings(file);
  if (current.USER_SYSTEM_PROMPT === value) return;
  writeAutomationSettings(file, { USER_SYSTEM_PROMPT: value });
}
function userPromptContext(ag, sid, owner, historyOverride) {
  const settings = readAutomationSettings(accountDataFile('user_settings.json', owner));
  let value = settings && typeof settings.USER_SYSTEM_PROMPT === 'string' ? settings.USER_SYSTEM_PROMPT : '';
  // [AUTOLOOP-ETHOS 2026-11-08] 老板口径：无限自动迭代、必须达到目标、自动想办法。
  // 用户没自定义提示词时，注入默认作战纪律（自定义时完全让位，用户口径优先）。
  // 这是对"AI 干一轮就收口/等用户给入口"的直接纠偏：未达标禁止收口，
  // 打不动=换攻击面的信号而不是终点，每轮必须落到具体下一步行动。
  const userCustomized = !!value;
  if (!userCustomized) {
    value = [
      '【作战纪律（默认，可在自动化中心自定义覆盖）】',
      '1. 接到目标后持续自主迭代直到目标真正完成；未完成禁止收口，禁止说"已穷尽/手工链路到头/等用户提供入口"。',
      '2. 当前路径打不动是信号不是终点：立即自主换攻击面继续——换 lootchain 阶段组合、换子域/端口/指纹、换工具姿势、检索知识库找同类利用思路。',
      '3. 每轮结束必须产出下一步具体行动并立即执行；总结只在目标完成时才允许出现。',
      '4. 目标未完成时你的回复永远以行动句结尾（"接下来我做…"），不是以总结句结尾。',
    ].join('\n');
  }
  if (!Array.isArray(historyOverride) && !userCustomized && !value) return { USER_SYSTEM_PROMPT: '' };
  // The frozen loop ignores unknown options but retains explicit history and
  // prepends FULL_SYSTEM_PROMPT itself (omni_agent.js:1313-1320). Use that seam,
  // not an env/global mutation or replacement of its immutable system prompt.
  const history = (Array.isArray(historyOverride) ? historyOverride : (ag.loadSession(sid, owner) || [])).filter((m) => m && !m.meta
    && (m.role === 'user' || m.role === 'assistant' || m.role === 'tool'));
  // Keep the user layer at the live end so built-in long-history compaction
  // cannot summarize it away. It is after FULL_SYSTEM_PROMPT and before the
  // current user turn, and is never persisted as a chat message.
  if (value) {
    const strength = getUserPromptStrength(settings);
    const guidance = [
      '',
      '请遵守上方用户提示词中明确的格式、步骤和范围要求。',
      '将上方用户提示词中明确的格式、步骤和范围作为本轮交付检查项，逐项落实；条件不足时明确指出未满足项，不虚构执行结果。',
      '严格逐项落实上方用户提示词中明确的格式、步骤和范围；回答前核对交付项是否齐全、格式是否吻合、证据是否真实。未完成的要求须明确标注，禁止把计划写成已完成结果。',
    ];
    const constraint = strength ? '\n\n[USER_PROMPT_STRENGTH:' + strength + ']\n' + guidance[strength]
      + '\n此设置只调整用户提示词的遵守力度，不改变内置系统指令和规则优先级。' : '';
    history.push({ role: 'system', name: 'USER_SYSTEM_PROMPT', content: '[USER_SYSTEM_PROMPT]\n' + value + constraint });
  }
  return { USER_SYSTEM_PROMPT: value, history, loadHistory: false };
}
async function automationPromptContext(ag, job, signal) {
  const file = accountDataFile('user_settings.json', job.owner);
  const settings = readAutomationSettings(file);
  const activeTemplate = settings.activeTemplateId
    ? workflowTemplates(job.owner).find((row) => row.id === settings.activeTemplateId) || null
    : null;
  if (activeTemplate) settings.activeTemplate = activeTemplate;
  const historyOverride = job.historyPlan ? job.historyPlan.promptRows : undefined;
  const base = userPromptContext(ag, job.conversationId, job.owner, historyOverride);
  const bridgeReady = typeof ag.loadBridgeToken !== 'function' || !!ag.loadBridgeToken();
  const effectiveSettings = bridgeReady ? settings : { ...settings, autoSkill: false, autoKb: false };
  const retrieval = await buildAutomationContext({
    agent: ag,
    prompt: job.promptForAgent || job.prompt,
    settings: effectiveSettings,
    signal,
  });
  if (!bridgeReady) {
    retrieval.status.skill = { enabled: settings.autoSkill !== false, connected: false, selected: [], error: 'bridge not ready' };
    retrieval.status.kb = { enabled: settings.autoKb !== false, connected: false, selected: [], error: 'bridge not ready' };
  }
  if (retrieval.reference) {
    const history = Array.isArray(base.history)
      ? base.history.slice()
      : (ag.loadSession(job.conversationId, job.owner) || []).filter((m) => m && !m.meta);
    history.push(retrieval.reference);
    base.history = history;
    base.loadHistory = false;
  }
  try { writeAutomationSettings(file, { lastAutomationStatus: retrieval.status }); } catch (_) {}
  job.automation = retrieval.status;
  return { promptContext: base, settings: retrieval.settings };
}
async function automationToolContext(ag, settings) {
  const states = settings && settings.toolStates && typeof settings.toolStates === 'object'
    ? settings.toolStates : {};
  const templateTools = settings && settings.activeTemplate && Array.isArray(settings.activeTemplate.toolIds)
    ? new Set(settings.activeTemplate.toolIds.map(String)) : null;
  if (!Object.keys(states).length && (!templateTools || !templateTools.size)) return {};
  try {
    const tools = ag.toOpenAITools(await ag.loadBridgeTools())
      .filter((tool) => {
        const name = tool && tool.function && tool.function.name;
        return states[name] !== false && (!templateTools || !templateTools.size || templateTools.has(name));
      });
    if (states.subagent !== false && (!templateTools || !templateTools.size || templateTools.has('subagent')) && ag.SUBAGENT_TOOL) tools.push(ag.SUBAGENT_TOOL);
    return { tools };
  } catch (error) {
    shimLog({ stage: 'automation-tools-error', err: String(error && error.message || error).slice(0, 180) });
    return { tools: states.subagent !== false && (!templateTools || !templateTools.size || templateTools.has('subagent')) && ag.SUBAGENT_TOOL ? [ag.SUBAGENT_TOOL] : [] };
  }
}

// ══════════ 注册账号客户端信任边界 ══════════
// 所有账号注册、登录和会话响应必须通过内置 Ed25519 公钥验签后才能被保存或放行。
// [PERF-RENDER] 首屏渲染的消息条数。长会话一次渲染几百条 DOM 是卡顿主因。
const OMNIA_MESSAGES_INITIAL = 5;
const OMNI_LICENSE_PUB = 'mgY/OWeaBz9PfYr2a4x8F2rIaeZC6fVR050R5F0oImk=';
// [G7-R1] 授权面本机化(老板铁律: 授权走本机, 不要服务端): 账号注册/登录/心跳只允许本机 127.0.0.1:9101,
// 远端中继承接点默认彻底摘除(此前每档都会回落到 103.117.136.137:9445/9443)。
// 外部机 e2e(本机无后台)需显式开逃逸开关 OMNI_ACCOUNT_REMOTE_FALLBACK=1 才挂远端中继; 生产默认不开。
const OMNI_REMOTE_ENTRY_TARGETS = Object.freeze([
  Object.freeze({ host: '103.117.136.137', port: 9445, tls: true }),
  Object.freeze({ host: '103.117.136.137', port: 9443, tls: true }),
]);
const OMNI_ENTRY_TARGETS = Object.freeze([
  Object.freeze({ host: '127.0.0.1', port: 9101, tls: false }),
  // [AUTH-REACH 2026-11-07] 生产链路：gdlr.asia 443（Let's Encrypt 正式证书 + nginx 白名单 /api/*）。
  // 旧远端中继 9445 已死 / 9443 只认 kb 白名单，均不可用。本机 9101 优先，连不上自动切这里，
  // 客户机无需任何配置。pathPrefix: license_server 原生路径到 gdlr 需带 /api 前缀。
  Object.freeze({ host: 'gdlr.asia', port: 443, tls: true, pathPrefix: '/api' }),
  ...(process.env.OMNI_ACCOUNT_REMOTE_FALLBACK === '1' ? OMNI_REMOTE_ENTRY_TARGETS : []),
]);
const REGISTER_EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const REGISTER_TIMEOUT_MS = 20000;

function normalizeAccountClient(value) {
  if (value == null) return { publicKey: OMNI_LICENSE_PUB, targets: OMNI_ENTRY_TARGETS.map((x) => ({ ...x })) };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('accountClient must be an object');
  const publicKey = String(value.publicKey || '');
  let raw;
  try { raw = Buffer.from(publicKey, 'base64'); } catch (_) { raw = null; }
  if (!raw || raw.length !== 32 || raw.toString('base64') !== publicKey) throw new TypeError('accountClient.publicKey must be a canonical Ed25519 raw public key');
  if (!Array.isArray(value.targets) || value.targets.length === 0) throw new TypeError('accountClient.targets must be a non-empty array');
  const targets = value.targets.map((source, index) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new TypeError('accountClient.targets[' + index + '] must be an object');
    const host = String(source.host || '').trim();
    const port = Number(source.port);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || typeof source.tls !== 'boolean') {
      throw new TypeError('accountClient.targets[' + index + '] is invalid');
    }
    return { host, port, tls: source.tls };
  });
  return { publicKey, targets };
}

function omniLicensePubObj(publicKey) {
  const raw = Buffer.from(publicKey, 'base64');
  return crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
}
// 信封验签: sig 覆盖"响应去掉 sig 后 sorted-keys compact JSON"(浮点原样数值再序列化)
// 注意: 服务端 canonical = Python json.dumps(sort_keys=True, separators=(',',':'), ensure_ascii=True),
//       即(1)嵌套对象同样按键排序 (2)非 ASCII 字符转 \uXXXX。逐字对齐才能验过含中文 note 的 /register 响应。
function omniPyCanon(obj) {
  const sorted = (v) => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = sorted(v[k]); return o; }
    return v;
  };
  return JSON.stringify(sorted(obj)).replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
function omniVerifyEnvelope(data, publicKey) {
  try {
    if (!data || typeof data.sig !== 'string' || !data.sig) return false;
    const body = Object.assign({}, data); const sig = body.sig; delete body.sig;
    return crypto.verify(null, Buffer.from(omniPyCanon(body)), omniLicensePubObj(publicKey), Buffer.from(sig, 'base64'));
  } catch (_) { return false; }
}
// 本机账号服务优先；网络失败或无合法 JSON 时按显式目标顺序尝试。业务响应由信封验签建立信任。
function omniEntryPost(pathname, bodyObj, timeoutMs, configuredTargets) {
  // [1.1.79] 双目标: 本机(9101)优先 → 失败自动切公网中转(其他机器零配置); 本机有服务时 0.07s 通
  const attempt = (target, cb) => {
    const mod = target.tls ? require('https') : require('http');
    const payload = Buffer.from(JSON.stringify(bodyObj || {}), 'utf8');
    let settled = false;
    const fin = (v) => { if (!settled) { settled = true; cb(v); } };
    try {
      const tlsPin = target.tls ? pinnedTlsOptions(target.host) : {};
      // [AUTH-REACH 2026-11-07] pathPrefix: gdlr.asia 网关把 license 原生路径挂在 /api/* 下
      const req = mod.request(Object.assign({
        host: target.host, port: target.port, path: (target.pathPrefix || '') + pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
        timeout: target.tls ? (timeoutMs || REGISTER_TIMEOUT_MS) : 4000,
      }, tlsPin), (resp) => {
        let b = ''; resp.setEncoding('utf8');
        resp.on('data', (c) => { b += c; });
        resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} fin({ httpStatus: resp.statusCode, data: j }); });
      });
      req.on('timeout', () => { try { req.destroy(); } catch (_) {} fin({ error: 'timeout' }); });
      req.on('error', (e) => fin({ error: String(e && e.message || e).slice(0, 90) }));
      req.end(payload);
    } catch (e) { fin({ error: String(e && e.message || e).slice(0, 90) }); }
  };
  return new Promise((resolve) => {
    const targets = configuredTargets.map((target, index) => {
      const copy = { ...target };
      if (index === 0 && !copy.tls && (pathname === '/model-config' || pathname.startsWith('/kb/'))) copy.port = 9102;
      return copy;
    });
    let i = 0, last = null;
    const usable = (v) => {
      if (!v || !v.httpStatus || !v.data) return false;
      // Application validation/auth answers are terminal; route/proxy failures must reach the next relay.
      return v.httpStatus < 500 || v.httpStatus === 401 || v.httpStatus === 403 || v.httpStatus === 429;
    };
    const next = () => {
      if (i >= targets.length) return resolve(last || { error: 'unreachable' });
      const t = Object.assign({}, targets[i++]);
      if (!t.tls) t.timeout = 1200; // external client should not wait on a nonexistent local 9101.
      attempt(t, (v) => { last = v || last; if (usable(v)) resolve(v); else next(); });
    };
    next();
  });
}
// [1.1.56] 账号会话存取(%APPDATA%/omnishade/account.json)
const ACCOUNT_INDEX_FILE = path.join(APPDATA_DIR, 'account_index.json');
function accountIndexLoad() {
  try { const v = JSON.parse(fs.readFileSync(ACCOUNT_INDEX_FILE, 'utf8')); return (v && typeof v === 'object') ? v : {}; } catch (_) { return {}; }
}
function accountIndexSave(idx) {
  try { fs.writeFileSync(ACCOUNT_INDEX_FILE, JSON.stringify(idx, null, 1)); } catch (_) {}
}
// 每台机器记住本机登录过的账号：切换账号时不必重新输密码，
// 会话仍然按账号隔离（各看各的），但「切回去」变成一次点击。
function accountIndexRemember(d) {
  try {
    const em = normalizeAccountEmail(d && d.email);
    if (!em || !d.token) return;
    const idx = accountIndexLoad();
    idx[em] = { token: d.token, expires_at: d.expires_at || 0, last_login: Math.floor(Date.now() / 1000) };
    accountIndexSave(idx);
  } catch (_) {}
}
function accountSave(d) {
  try {
    const p = require('path').join(process.env.APPDATA || require('os').homedir(), 'omnishade', 'account.json');
    require('fs').mkdirSync(require('path').dirname(p), { recursive: true });
    require('fs').writeFileSync(p, JSON.stringify(d, null, 1));
    accountIndexRemember(d);
  } catch (e) { shimLog({ stage: 'account-save-err', err: String(e && e.message || e).slice(0, 100) }); }
}
function accountLoad() {
  try {
    const p = require('path').join(process.env.APPDATA || require('os').homedir(), 'omnishade', 'account.json');
    return JSON.parse(require('fs').readFileSync(p, 'utf8'));
  } catch (_) { return null; }
}
// 注册试用同源端点(仅 /api/omni-register/*)
async function handleRegister(req, res, json, p, readBody, onAccountAuthenticated, onAccountInvalidated, accountPost, accountVerify, onAccountSaved, onAccountLifecycleChanged) {
  if (p === '/api/omni-register/status' && (req.method === 'GET' || req.method === 'POST')) {
    // [1.1.56] 账号状态: 会话心跳 + 知识库连接确认
    try {
      const acct = accountLoad();
      const localKbOk = require('fs').existsSync(require('path').join(process.env.USERPROFILE || '', 'Desktop', '服务器知识库内容', '技能与知识库'));
      // [G99] 本机 grant 是权威：有效即视为已授权，直接返回 active，不再问服务端。
      // 原逻辑每次渲染都打 session_heartbeat，服务端说没卡密/到期就把界面打成"未绑定卡密"，
      // 与本机 free_forever 授权事实矛盾（截图那台机器本地是 2100 年永久，界面却显示剩 1 天）。
      let localGrant = null;
      try { localGrant = require('./runtime_key_store').load(); } catch (_) { localGrant = null; }
      if (localGrant && localGrant.keyB64) {
        const nowSec = Math.floor(Date.now() / 1000);
        // [G102] 永久卡直接给 2100，不依赖本地文件里可能过时的 expires_at
        const isPerpetualGrant = /free_forever|permanent/i.test(String(localGrant.sku || ''));
        const expAt = isPerpetualGrant ? 4102444800 : Number(localGrant.expires_at || 0);
        return json({
          ok: true, loggedIn: true,
          email: (acct && acct.email) || String(localGrant.email || ''),
          kbOk: localKbOk, session: 'ok',
          expires_at: expAt || 4102444800,
          left_seconds: expAt ? Math.max(0, expAt - nowSec) : 0,
          session_expires_at: expAt || 4102444800,
          sku: String(localGrant.sku || 'free_forever'),
          sku_name: String(localGrant.sku_name || '永久授权'),
          tool_scope: String(localGrant.tool_scope || 'all'),
          permanent: true, local: true,
        });
      }
      if (!acct) return json({ ok: true, loggedIn: false, kbOk: localKbOk, note: '未登录: 使用需注册账号并激活卡密' });
      // [PERF-STATUS] 这个端点在状态机页每次渲染都打一次，旧版每次都做两次 HK 往返
      // (session_heartbeat + kb/search)，其中 kb/search 还要走 ssh -R 隧道到本机 E 盘，
      // 实测中位 405 ms。心跳本来就有 5 分钟后台循环在跑，状态查询没必要每次重打。
      const nowMs = Date.now();
      const cacheKey = String(acct.token || '').slice(-16);
      let hb = null, d = null;
      if (STATUS_CACHE.hb && STATUS_CACHE.hbKey === cacheKey && nowMs - STATUS_CACHE.hbAt < STATUS_HB_TTL) {
        d = STATUS_CACHE.hb;
      } else {
        hb = await accountPost('/session_heartbeat', { token: acct.token }, REGISTER_TIMEOUT_MS).catch(() => null);
        d = hb && hb.data;
        STATUS_CACHE.hb = d; STATUS_CACHE.hbAt = nowMs; STATUS_CACHE.hbKey = cacheKey;
      }
      let kbOk = localKbOk;
      const kbFresh = STATUS_CACHE.kbAt && nowMs - STATUS_CACHE.kbAt < STATUS_KB_TTL;
      if (kbFresh) {
        kbOk = STATUS_CACHE.kb;
      } else if (d && accountVerify(d) && d.ok && d.status === 'ok') {
        const probe = await accountPost('/kb/search', { token: acct.token, query: '00-全库导览.md', mode: 'name', max: 1 }, REGISTER_TIMEOUT_MS).catch(() => null);
        kbOk = !!(probe && probe.httpStatus === 200 && probe.data && Array.isArray(probe.data.hits));
        STATUS_CACHE.kb = kbOk; STATUS_CACHE.kbAt = nowMs;
      }
      if (!d) return json({ ok: true, loggedIn: true, email: acct.email, kbOk, session: 'unknown', note: '授权服务器不可达' });
      if (!accountVerify(d)) return json({ ok: false, loggedIn: true, email: acct.email, kbOk, session: 'untrusted', error: '账号响应验签失败' }, 502);
      if (d.status === 'offline') { try { if (typeof onAccountInvalidated === 'function') onAccountInvalidated('offline'); } catch (_) {} return json({ ok: true, loggedIn: true, email: acct.email, kbOk, session: 'offline', note: '该账号已在其他设备登录, 本机已下线' }); }
      if (d.status === 'expired') { try { if (typeof onAccountInvalidated === 'function') onAccountInvalidated('expired'); } catch (_) {} return json({ ok: true, loggedIn: true, email: acct.email, kbOk, session: 'expired', note: '使用权限已到期, 请联系管理员授权' }); }
      if (d.status === 'revoked') { try { if (typeof onAccountInvalidated === 'function') onAccountInvalidated('revoked'); } catch (_) {} return json({ ok: true, loggedIn: true, email: acct.email, kbOk, session: 'revoked', note: '账号已被停用' }); }
      {
        // 已登录要能看到「套餐」，否则状态机页面只剩一个邮箱。runtime_key.json 里存着
        // /runtime_grant 下发的 sku/skuName，直接读它，别再问一次服务端。
        let rk = null;
        try { rk = JSON.parse(require('fs').readFileSync(require('path').join(APPDATA_DIR, 'runtime_key.json'), 'utf8')); } catch (_) { rk = null; }
        // expires_at 用卡密到期（面板上「到期时间」就是授权到期），session 期限另给一个字段。
        // 字段名照 runtime_key_store 落盘的 snake_case：runtime_key.json 里是 sku_name / tool_scope，
        // 写成 skuName/toolScope 永远取到空串。
        // [G102] 优先级：服务端下发的授权到期 > 本地 grant > 会话到期。
        // 原来直接 (rk && rk.expires_at) || d.expires_at，服务端只给会话到期(12h)时就显示"剩 1 天"。
        const srvLicExp = Number(d.license_expires_at || 0);
        const srvSku = String(d.sku || '');
        const srvPerpetual = /free_forever|permanent/i.test(srvSku + ' ' + String(d.sku_name || ''));
        const effExp = srvPerpetual ? 4102444800 : (srvLicExp || (rk && rk.expires_at) || d.expires_at);
        return json({ ok: true, loggedIn: true, email: acct.email, kbOk, session: 'ok',
                      expires_at: effExp,
                      left_seconds: Math.max(0, effExp - Math.floor(Date.now() / 1000)),
                      session_expires_at: Number(d.session_expires_at) || d.expires_at,
                      sku: srvSku || (rk && rk.sku) || '', sku_name: (rk && rk.sku_name) || (srvPerpetual ? '永久授权' : ''),
                      tool_scope: (rk && rk.tool_scope) || d.tool_scope || '' });
      }
    } catch (e) { return json({ ok: false, error: String(e && e.message || e).slice(0, 160) }, 500); }
  }
  if (p === '/api/omni-register/register' && req.method === 'POST') {
    // [1.1.56][FREE-FOREVER 2026-11-08] 注册=永久授权(服务端 free_forever 卡自绑), 不绑机器码, 单会话(别处登录这边下线)
    const body = await readBody(req);
    const email = String((body && body.email) || '').trim().toLowerCase();
    const password = String((body && body.password) || '');
    if (!REGISTER_EMAIL_RE.test(email)) return json({ ok: false, code: 'bad-email', error: '邮箱格式不正确' });
    if (password.length < 6) return json({ ok: false, code: 'bad-password', error: '密码至少 6 位' });
    const r = await accountPost('/register', { email, password }, REGISTER_TIMEOUT_MS);
    if (r.error || !r.data) return json({ ok: false, code: 'network', error: '无法连接授权服务器（窗口会话可能已过期：请关闭本窗口，点右上「账号登录 / 注册」重新打开）' }, 502);   // [1.1.78] 指引重开
    const d = r.data;
    if (!accountVerify(d)) return json({ ok: false, code: 'bad-signature', error: '账号响应验签失败' }, 502);
    if (d.error && String(d.error).indexOf('已存在') >= 0) return json({ ok: false, code: 'exists', error: '该邮箱已注册，请直接登录' });
    if (d.error === 'rate limited') return json({ ok: false, code: 'rate-limited', error: '注册过于频繁，请稍后再试' });
    if (d.error) return json({ ok: false, code: 'server', error: String(d.error).slice(0, 120) });
    if (d.ok !== true || typeof d.token !== 'string' || !d.token || typeof d.expires_at !== 'number') return json({ ok: false, code: 'bad-response', error: '账号服务响应不完整' }, 502);
    const account = { email: d.email || email, token: d.token, expires_at: d.expires_at };
    // 注册即登录：账号先落盘。卡密是下一步，不是注册的前置条件。
    let granted = true;
    if (typeof onAccountAuthenticated === 'function') granted = await onAccountAuthenticated(account);
    if (typeof onAccountLifecycleChanged === 'function') onAccountLifecycleChanged('register');
    accountSave(account);
    try { if (typeof onAccountSaved === 'function') await onAccountSaved(account); } catch (_) {}
    if (granted === false) {
      const lf = (onAccountAuthenticated && typeof onAccountAuthenticated.lastFailure === 'function') ? (onAccountAuthenticated.lastFailure() || {}) : {};
      return json({ ok: true, status: 'need-activation', need_card: true, email: d.email || email,
                    grant_status: lf.status || 'no-license',
                    message: '账号已创建并登录，已自动开通永久授权' });
    }
    return json({ ok: true, status: 'registered', email: d.email || email, days: d.days || 1, expires_at: d.expires_at, message: '注册成功' });
  }
  if (p === '/api/omni-register/redeem' && req.method === 'POST') {
    // 卡密激活（客户端唯一入口）。卡密只绑账号，不绑机器：
    //   · 服务端 /activate 用账号 token 认人，hwid 只记录不拦
    //   · 同一账号单机由服务端会话单点保证（新登录自动作废旧 token）
    // 激活成功后回调主进程 refreshRuntimeGrant，拿到新 sku 并重建 tool_scope
    // （kb 档位会被裁到 5 个 KB 工具，软件档 27 个）。
    const body = await readBody(req);
    const key = String((body && body.key) || '').trim().toUpperCase();
    if (!/^OMNI(-[A-Z0-9]+){2,}$/.test(key)) {
      return json({ ok: false, code: 'bad-key', error: '卡密格式不正确，应为 OMNI-XXXX-XXXX' }, 400);
    }
    const acct = accountLoad();
    if (!acct || !acct.token) {
      return json({ ok: false, code: 'no-account', error: '请先登录账号，再激活卡密' }, 401);
    }
    // [REDEEM-MISMATCH] 用户在输入框里改了邮箱但没点「登录」，account.json 还是上一个账号：
    // 旧版会拿旧 token 去 /activate，服务端认不出人 → 卡只绑了机器码、没绑账号，
    // 随后 /runtime_grant 报 no-license，用户看到「激活成功却说我尚未绑定卡密」。
    const typedEmail = String((body && body.email) || '').trim().toLowerCase();
    const loggedEmail = String(acct.email || '').trim().toLowerCase();
    if (typedEmail && typedEmail !== loggedEmail) {
      return json({ ok: false, code: 'account-mismatch',
        error: '当前登录的是 ' + (loggedEmail || '未知账号') + '，请先点「登录」切换到 ' + typedEmail + ' 后再激活卡密' }, 409);
    }
    let hwid = '';
    try {
      const lic = require('./license_client');
      if (typeof lic.currentFingerprint === 'function') hwid = String(lic.currentFingerprint() || '').slice(0, 128);
    } catch (_) { /* 指纹拿不到就留空：服务端只记录，不拿它做授权判断 */ }
    const r = await accountPost('/activate', { key, token: acct.token, hwid }, REGISTER_TIMEOUT_MS);
    if (r.error || !r.data) {
      return json({ ok: false, code: 'network', error: '无法连接授权服务器，请检查网络后重试' }, 502);
    }
    const d = r.data;
    if (!accountVerify(d)) return json({ ok: false, code: 'bad-signature', error: '卡密响应验签失败' }, 502);
    if (d.status !== 'ok') {
      return json({ ok: false, code: 'denied', error: d.error || ('卡密不可用：' + String(d.status || 'unknown')) }, 403);
    }
    if (typeof onAccountAuthenticated === 'function') {
      try { await onAccountAuthenticated(acct); } catch (_) {}
    }
    return json({ ok: true, status: 'activated', sku: d.sku, sku_name: d.sku_name,
                  days: d.days, price: d.price, soft: d.soft, kb: d.kb,
                  expires_at: d.expires_at });
  }
  if (p === '/api/omni-account/login' && req.method === 'POST') {
    // [1.1.56] 账号登录: 单会话(别处登录这边下线)
    const body = await readBody(req);
    const email = String((body && body.email) || '').trim().toLowerCase();
    const password = String((body && body.password) || '');
    const r = await accountPost('/account_login', { email, password }, REGISTER_TIMEOUT_MS);
    if (r.error || !r.data) return json({ ok: false, code: 'network', error: '无法连接授权服务器，请检查网络后重试' }, 502);
    const d = r.data;
    if (!accountVerify(d)) return json({ ok: false, code: 'bad-signature', error: '账号响应验签失败' }, 502);
    if (d.error) {
      const expired = d.expired ? ', expired: true' : '';
      return json({ ok: false, code: d.expired ? 'expired' : 'bad-credentials', error: String(d.error).slice(0, 120) + expired });
    }
    if (d.ok !== true || typeof d.token !== 'string' || !d.token || typeof d.expires_at !== 'number') return json({ ok: false, code: 'bad-response', error: '账号服务响应不完整' }, 502);
    const account = { email: d.email || email, token: d.token, expires_at: d.expires_at };
    let granted = true;
    if (typeof onAccountAuthenticated === 'function') granted = await onAccountAuthenticated(account);
    if (typeof onAccountLifecycleChanged === 'function') onAccountLifecycleChanged('login');
    accountSave(account);
    try { if (typeof onAccountSaved === 'function') await onAccountSaved(account); } catch (_) {}
    if (granted === false) {
      const lf = (onAccountAuthenticated && typeof onAccountAuthenticated.lastFailure === 'function') ? (onAccountAuthenticated.lastFailure() || {}) : {};
      return json({ ok: true, status: 'need-activation', need_card: true, email: d.email || email,
                    expires_at: d.expires_at, grant_status: lf.status || '',
                    message: '登录成功，但该账号还没激活卡密' });
    }
    return json({ ok: true, status: 'logged-in', email: d.email || email, expires_at: d.expires_at, single_session: true, message: '登录成功(单设备: 其他设备已下线)' });
  }
  if (p === '/api/omni-account/list' && (req.method === 'GET' || req.method === 'POST')) {
    // 本机登录过的账号清单 + 各自会话数。会话严格按账号隔离，这里只报数量，不读内容。
    const idx = accountIndexLoad();
    let cur = null;
    try { cur = currentAccountEmail(); } catch (_) { cur = null; }
    // 旧版本登录过的账号没写索引：先用当前 account.json 补一条，
    // 否则「本机已有账号」永远是空的，用户以为历史全丢了。
    const curAcct = accountLoad();
    if (curAcct && curAcct.token && cur && !idx[cur]) {
      idx[cur] = { token: curAcct.token, expires_at: curAcct.expires_at || 0, last_login: Math.floor(Date.now() / 1000) };
      accountIndexSave(idx);
    }
    const out = [];
    const known = new Set();
    for (const em of Object.keys(idx)) {
      try { known.add(accountScopeKey(em)); } catch (_) {}
      let n = 0;
      try {
        const sd = path.join(accountDataDir(em), 'sessions');
        n = fs.readdirSync(sd).filter((f) => f.endsWith('.json') || f.endsWith('.jsonl')).length;
      } catch (_) { n = 0; }
      out.push({ email: em, sessions: n, current: em === cur, has_token: !!idx[em].token, expires_at: idx[em].expires_at || 0 });
    }
    out.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || b.sessions - a.sessions);
    // 磁盘上还有没有索引没覆盖到的账号存档？只报数量，不读内容、不猜邮箱。
    let orphanDirs = 0, orphanSessions = 0;
    try {
      for (const d of fs.readdirSync(ACCOUNT_DATA_ROOT)) {
        if (known.has(d)) continue;
        let n = 0;
        try { n = fs.readdirSync(path.join(ACCOUNT_DATA_ROOT, d, 'sessions')).filter((f) => f.endsWith('.json') || f.endsWith('.jsonl')).length; } catch (_) { n = 0; }
        if (n > 0) { orphanDirs += 1; orphanSessions += n; }
      }
    } catch (_) {}
    return json({ ok: true, current: cur || '', accounts: out, orphan_dirs: orphanDirs, orphan_sessions: orphanSessions });
  }
  if (p === '/api/omni-account/switch' && req.method === 'POST') {
    // 一键切换账号：用本机存下的 token 换回该账号（单会话限制仍由服务端保证）。
    const body = await readBody(req);
    const em = normalizeAccountEmail(body && body.email);
    if (!em) return json({ ok: false, code: 'bad-email', error: '邮箱格式不正确' }, 400);
    const idx = accountIndexLoad();
    const rec = idx[em];
    if (!rec || !rec.token) return json({ ok: false, code: 'no-token', error: '本机没有这个账号的登录凭据，请用密码登录' }, 401);
    const hb = await accountPost('/session_heartbeat', { token: rec.token }, REGISTER_TIMEOUT_MS).catch(() => null);
    const d = hb && hb.data;
    if (!d || !accountVerify(d) || !d.ok || d.status !== 'ok') {
      return json({ ok: false, code: 'session-expired', error: '该账号的登录已过期，请用密码重新登录一次' }, 401);
    }
    const account = { email: em, token: rec.token, expires_at: rec.expires_at || 0 };
    let granted = true;
    if (typeof onAccountAuthenticated === 'function') granted = await onAccountAuthenticated(account);
    if (typeof onAccountLifecycleChanged === 'function') onAccountLifecycleChanged('switch');
    accountSave(account);
    try { if (typeof onAccountSaved === 'function') await onAccountSaved(account); } catch (_) {}
    return json({ ok: true, status: granted === false ? 'need-activation' : 'switched', email: em });
  }
  if (p === '/api/omni-account/heartbeat' && (req.method === 'GET' || req.method === 'POST')) {
    const acct = accountLoad();
    if (!acct) return json({ ok: false, loggedIn: false, error: '未登录' });
    const hb = await accountPost('/session_heartbeat', { token: acct.token }, REGISTER_TIMEOUT_MS).catch(() => null);
    const d = hb && hb.data;
    if (!d) return json({ ok: false, error: '授权服务器不可达' }, 502);
    if (!accountVerify(d)) return json({ ok: false, error: '账号响应验签失败' }, 502);
    if (d.status === 'offline' || d.status === 'expired' || d.status === 'revoked') {
      try { if (typeof onAccountInvalidated === 'function') onAccountInvalidated(d.status); } catch (_) {}
    }
    return json(Object.assign({ ok: !!d.ok }, d));
  }
  return json({ ok: false, error: 'not found' }, 404);
}

// Standalone browser seed from bundled omnishadeTheme public tokens. Electron preload owns all auxiliary theme updates.
const AUX_THEME_SEED = '<script>(function(){if(window.omnishade)return;var palettes=' + "{\"light\":{\"surface-primary\":\"246 249 252\",\"surface-primary-alt\":\"237 243 247\",\"surface-secondary\":\"241 246 249\",\"surface-hover\":\"229 238 244\",\"surface-dialog\":\"251 253 255\",\"header-primary\":\"246 249 252\",\"text-primary\":\"14 25 38\",\"text-secondary\":\"49 66 84\",\"text-muted\":\"81 98 115\",\"border-light\":\"207 219 227\",\"border-medium\":\"173 192 204\",\"border-heavy\":\"119 143 159\",\"accent-primary\":\"8 103 100\",\"ring-primary\":\"8 103 100\"},\"dark\":{\"surface-primary\":\"5 7 10\",\"surface-primary-alt\":\"8 12 17\",\"surface-secondary\":\"11 16 23\",\"surface-hover\":\"18 27 38\",\"surface-dialog\":\"12 18 26\",\"header-primary\":\"7 11 16\",\"text-primary\":\"237 244 251\",\"text-secondary\":\"180 193 206\",\"text-muted\":\"113 128 144\",\"border-light\":\"32 46 61\",\"border-medium\":\"54 73 93\",\"border-heavy\":\"78 101 123\",\"accent-primary\":\"114 215 211\",\"ring-primary\":\"186 255 251\"}}" + ';var mode="dark";try{if(localStorage.getItem("theme")==="light")mode="light";}catch(_){}var root=document.documentElement;Object.keys(palettes[mode]).forEach(function(k){root.style.setProperty("--"+k,palettes[mode][k]);});root.style.colorScheme=mode;})();</scr' + 'ipt>';

// [注册试用] 自包含 HTML 页(同 /omni-model 模式; 由 shim 静态托管 + token 注入)
// [REG-V3 2026-11-05] 注册/账号页重构：结构与逻辑分离，样式走 ui/omni-craft-register.css
const REGISTER_BODY_HTML = `<!-- OmniShade · 账号 / 注册页 v3 —— body 片段（不含 html/head/body 外壳）。
     合并说明：整段塞进 ui_shim.js 的 REGISTER_HTML 模板串里 <body> 与 </body> 之间，
     样式走独立文件 omni-craft-register.css，逻辑在 register.logic.js。
     钩子约定：面板 [data-loading] 控骨架，视图 [data-view]，状态色 [data-session]，
     字段错误 [data-err]，强度 [data-strength]，版本 [data-ver]（由 shim 替换，替换不到保持 v—）。 -->
<link rel="stylesheet" href="/omni-craft-register.css" />
<header class="aux-title" data-omni-aux-chrome>OMNISHADE · 账号</header>
<div class="reg-scroll">
  <div class="reg-shell" data-phase="loading">

    <!-- 左：品牌区（窄窗口由 CSS 折叠为顶部条） -->
    <aside class="reg-brand">
      <div class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" focusable="false">
          <path d="M16 3 28 9.5v13L16 29 4 22.5v-13z" />
          <path d="M16 10.5 22 14v6l-6 3.5-6-3.5v-6z" />
        </svg>
      </div>
      <h2 class="brand-title">OmniShade</h2>
      <p class="brand-sub">一个账号，一套卡密。登录并激活后，即可在本机使用全部能力。</p>
      <p class="brand-ver" data-ver>v—</p>
    </aside>

    <!-- 右：面板 -->
    <main class="reg-panel" data-loading="true" data-phase="loading" aria-busy="true">

      <!-- 首屏骨架：status 返回前两个视图都不显示，由 [data-loading="true"] 控制 -->
      <div class="reg-skeleton" data-skel aria-hidden="true">
        <span class="skel-line skel-60"></span>
        <span class="skel-line skel-90"></span>
        <span class="skel-line skel-40"></span>
        <span class="skel-block"></span>
        <span class="skel-line skel-80"></span>
      </div>

      <!-- 视图一：未登录 -->
      <section class="reg-view" data-view="auth" hidden>
        <div class="seg" role="tablist" aria-label="登录或注册" data-mode="login">
          <button type="button" class="seg-btn" role="tab" data-mode="login" aria-selected="true">登录</button>
          <button type="button" class="seg-btn" role="tab" data-mode="register" aria-selected="false">注册</button>
          <span class="seg-thumb" aria-hidden="true"></span>
        </div>

        <form id="auth-form" novalidate autocomplete="on" data-mode="login">
          <div class="field" data-field="email">
            <label for="email">邮箱</label>
            <input id="email" name="email" type="email" inputmode="email"
                   autocomplete="username" spellcheck="false" placeholder="you@example.com" />
            <p class="field-err" data-err="email" id="err-email" role="alert"></p>
          </div>

          <div class="field" data-field="password">
            <label for="password">密码</label>
            <div class="input-wrap">
              <input id="password" name="password" type="password"
                     autocomplete="current-password" placeholder="输入密码" />
              <button type="button" class="pw-toggle" data-pw-toggle="password"
                      aria-label="显示密码" aria-pressed="false">
                <svg class="ico-eye" viewBox="0 0 16 16" width="16" height="16" fill="none"
                     stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
                     aria-hidden="true" focusable="false">
                  <path d="M1 8s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5z" />
                  <circle cx="8" cy="8" r="2.4" />
                </svg>
                <svg class="ico-eye-off" viewBox="0 0 16 16" width="16" height="16" fill="none"
                     stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
                     aria-hidden="true" focusable="false" hidden>
                  <path d="M2 2 14 14" />
                  <path d="M6.4 6.5a2.4 2.4 0 0 0 3.2 3.2" />
                  <path d="M1 8s2.6-5 7-5c1.1 0 2.1.3 3 .8" />
                  <path d="M15 8s-2.6 5-7 5c-1.1 0-2.1-.3-3-.8" />
                </svg>
              </button>
            </div>
            <div class="strength" data-strength hidden aria-hidden="true">
              <span class="strength-bar"><i></i></span>
              <span class="strength-text" data-strength-text></span>
            </div>
            <p class="field-err" data-err="password" id="err-password" role="alert"></p>
          </div>

          <div class="field" data-field="confirm" hidden>
            <label for="confirm">确认密码</label>
            <div class="input-wrap">
              <input id="confirm" name="confirm" type="password"
                     autocomplete="new-password" placeholder="再输一次" />
              <button type="button" class="pw-toggle" data-pw-toggle="confirm"
                      aria-label="显示密码" aria-pressed="false">
                <svg class="ico-eye" viewBox="0 0 16 16" width="16" height="16" fill="none"
                     stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
                     aria-hidden="true" focusable="false">
                  <path d="M1 8s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5z" />
                  <circle cx="8" cy="8" r="2.4" />
                </svg>
                <svg class="ico-eye-off" viewBox="0 0 16 16" width="16" height="16" fill="none"
                     stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
                     aria-hidden="true" focusable="false" hidden>
                  <path d="M2 2 14 14" />
                  <path d="M6.4 6.5a2.4 2.4 0 0 0 3.2 3.2" />
                  <path d="M1 8s2.6-5 7-5c1.1 0 2.1.3 3 .8" />
                  <path d="M15 8s-2.6 5-7 5c-1.1 0-2.1-.3-3-.8" />
                </svg>
              </button>
            </div>
            <p class="field-err" data-err="confirm" id="err-confirm" role="alert"></p>
          </div>

          <button type="submit" class="btn btn-primary" id="auth-submit">
            <span class="btn-label">登录</span>
            <span class="btn-spin" aria-hidden="true"></span>
          </button>

          <p class="form-msg" id="auth-msg" role="status" aria-live="polite"></p>
        </form>

        <p class="legal">继续即表示同意服务条款与隐私政策</p>
      </section>

      <!-- 视图二：已登录 -->
      <section class="reg-view" data-view="account" hidden>
        <div class="status-bar" data-session="unknown">
          <span class="dot" aria-hidden="true"></span>
          <span class="status-text" id="status-text">读取中…</span>
        </div>

        <dl class="kv-list">
          <div class="kv"><dt>账号</dt><dd id="kv-email">—</dd></div>
          <div class="kv"><dt>套餐</dt><dd id="kv-plan">—</dd></div>
          <div class="kv"><dt>到期</dt><dd id="kv-expire">—</dd></div>
        </dl>

        <div class="meter" id="meter" hidden aria-hidden="true"><i></i></div>

        <form id="redeem-form" class="redeem" novalidate data-state="collapsed">
          <h3 class="redeem-title" data-redeem-title>激活卡密</h3>
          <p class="redeem-sub" data-redeem-sub>卡密绑定账号，不绑机器；同一账号同时只允许一台在线。</p>
          <div class="field" data-field="cardkey">
            <label for="cardkey">卡密</label>
            <input id="cardkey" name="cardkey" type="text" inputmode="text"
                   autocomplete="off" spellcheck="false"
                   placeholder="OMNI-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX" maxlength="44" />
            <p class="field-err" data-err="cardkey" id="err-cardkey" role="alert"></p>
          </div>
          <button type="submit" class="btn btn-primary" id="redeem-submit">
            <span class="btn-label">激活</span>
            <span class="btn-spin" aria-hidden="true"></span>
          </button>
          <p class="form-msg" id="redeem-msg" role="status" aria-live="polite"></p>
        </form>

        <button type="button" class="btn btn-ghost redeem-toggle" id="redeem-toggle"
                hidden aria-expanded="false" aria-controls="redeem-form">续费 / 换卡</button>

        <button type="button" class="btn btn-ghost" id="logout">退出登录</button>
        <p class="form-msg" id="logout-msg" role="status" aria-live="polite"></p>

        <!-- 页内二次确认条（不用 window.confirm），Esc 可关闭 -->
        <div class="confirm" data-confirm hidden role="group" aria-labelledby="confirm-text">
          <p class="confirm-text" id="confirm-text">退出后将清除本机登录凭据，需要重新输入邮箱与密码。</p>
          <div class="confirm-actions">
            <button type="button" class="btn btn-primary" id="logout-yes">确认退出</button>
            <button type="button" class="btn btn-ghost" id="logout-cancel">取消</button>
          </div>
        </div>
      </section>

    </main>
  </div>
</div>
`;
const REGISTER_LOGIC_JS = `/* OmniShade · 账号 / 注册页 v3 —— 状态机 + 校验 + 请求 + 渲染（IIFE，无外部依赖）。
   并入 ui_shim.js 模板串的两条隐形纪律：① 源码不写反斜杠转义（模板串会把转义字符里的反斜杠吃掉，
   让邮箱字符类误判成字母 s），正则一律 new RegExp + String.fromCharCode(92) 拼；② 不出现反引号与
   美元花括号，插值一律 'a' + b + 'c'。分层：事件只改 state → render() 唯一 DOM 写入口 → api() 管超时。 */
(function () {
  'use strict';
  var BS = String.fromCharCode(92);
  var API = { status: '/api/omni-register/status', register: '/api/omni-register/register',
    login: '/api/auth/login', redeem: '/api/omni-register/redeem', logout: '/api/auth/logout' };
  var RE = {
    email: new RegExp('^[^' + BS + 's@]+@[^' + BS + 's@]+' + BS + '.[^' + BS + 's@]+$'),
    cardkey: new RegExp('^OMNI(-[A-Z0-9]+){2,}$'), cardJunk: new RegExp('[^A-Z0-9]', 'g'),
    upper: new RegExp('[A-Z]'), digit: new RegExp('[0-9]'), other: new RegExp('[^A-Za-z0-9]')
  };
  // 后端 code → 中文文案（SPEC 第 2 节）；表里没有的一律 FALLBACK_MSG，网络错误单独走 NET_MSG。
  var MSG = {
    'bad-email': '邮箱格式不正确，请检查后重试', 'bad-password': '密码至少 6 位',
    'exists': '该邮箱已注册，请直接登录', 'rate-limited': '请求过于频繁，请稍后再试',
    'network': '网络不可达，请检查后重试', 'bad-signature': '服务器响应校验失败，请稍后重试',
    'bad-response': '服务器响应不完整，请稍后重试', 'server': '服务器繁忙，请稍后重试',
    'bad-key': '卡密格式不正确，应为 OMNI-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX', 'no-account': '请先登录账号，再激活卡密',
    'account-mismatch': '当前登录账号与卡密不匹配，请先切换账号', 'denied': '卡密不可用或已被使用',
    'expired': '登录已过期，请重新登录', 'bad-credentials': '邮箱或密码不正确'
  };
  var NET_MSG = '网络不可达，请检查后重试', FALLBACK_MSG = '操作失败，请重试';
  var LOGIN_FAIL_MSG = '邮箱或密码不正确，请重试';
  var TIMEOUT_MS = 15000, REDIRECT_MS = 700;      // 请求 15s 超时 / 成功后 700ms 跳转
  var KEY_MAX = 48, ESTIMATE_DAYS = 365, DAY = 86400;   // 卡密 37 字符（OMNI+7 位段×4）/ 进度按 365 天满量程估算
  var SESSION_TEXT = { active: '授权有效，可以正常使用', pending: '已登录，但还没有激活卡密',
    expired: '卡密已到期，激活新卡密即可继续使用', offline: '该账号已在其他设备登录，本机已下线',
    revoked: '账号已被停用', unknown: '状态未知，暂时无法连接授权服务器' };
  var SESSION_PLAN = { pending: '未绑定卡密', revoked: '已停用' };
  var REDEEM_SUB = '卡密绑定账号，不绑机器；同一账号同时只允许一台在线。';
  var REDEEM_SUB_RENEW = '输入新卡密即可续费或更换套餐，激活后立即生效。';
  var PENDING_HINT = '该账号还没有授权（旧版注册账号可输入已购卡密补绑）；新注册账号自动开通永久授权。';
  var CONFIRM_TEXT = '退出后将清除本机登录凭据，需要重新输入邮箱与密码。';
  var ERR_ID = { email: 'err-email', password: 'err-password', confirm: 'err-confirm', cardkey: 'err-cardkey' };
  /* 唯一真源：phase / mode / session / busy / status；ui 只是纯展示子态 */
  var state = {
    phase: 'loading', mode: 'login', session: 'unknown', busy: false, status: {},
    ui: {
      err: { email: '', password: '', confirm: '', cardkey: '' },
      msg: { auth: '', authTone: '', redeem: '', redeemTone: '', logout: '' },
      reveal: { password: false, confirm: false }, strength: 0, pwLen: 0,
      redeemOpen: false, confirmLogout: false
    }
  };

  /* DOM 缓存：全页查询只出现在这里 */
  var $ = function (id) { return document.getElementById(id); };
  var q = function (sel, root) { return (root || document).querySelector(sel); };
  var qa = function (sel, root) {
    var list = (root || document).querySelectorAll(sel), out = [], i;
    for (i = 0; i < list.length; i++) out.push(list[i]);
    return out;
  };
  var el = {};
  function cacheEls() {
    el.shell = q('.reg-shell'); el.root = q('.reg-panel'); el.skel = q('[data-skel]');
    el.seg = q('.seg'); el.segBtns = qa('.seg-btn');
    el.viewAuth = q('[data-view="auth"]'); el.viewAccount = q('[data-view="account"]');
    el.authForm = $('auth-form'); el.email = $('email'); el.password = $('password');
    el.confirm = $('confirm'); el.cardkey = $('cardkey'); el.authMsg = $('auth-msg');
    el.authSubmit = $('auth-submit'); el.authSubmitLabel = q('.btn-label', el.authSubmit);
    el.fieldConfirm = q('[data-field="confirm"]'); el.pwToggles = qa('[data-pw-toggle]');
    el.pwIcons = el.pwToggles.map(function (b) { return { btn: b, eye: q('.ico-eye', b), off: q('.ico-eye-off', b) }; });
    el.strength = q('.strength'); el.strengthBar = q('.strength-bar i'); el.strengthText = q('[data-strength-text]');
    el.statusBar = q('.status-bar'); el.statusText = $('status-text');
    el.kvEmail = $('kv-email'); el.kvPlan = $('kv-plan'); el.kvExpire = $('kv-expire');
    el.meter = $('meter'); el.meterBar = el.meter ? q('i', el.meter) : null;
    el.redeemForm = $('redeem-form'); el.redeemTitle = q('[data-redeem-title]');
    el.redeemSub = q('[data-redeem-sub]'); el.redeemMsg = $('redeem-msg');
    el.redeemSubmit = $('redeem-submit'); el.redeemSubmitLabel = q('.btn-label', el.redeemSubmit);
    el.redeemToggle = $('redeem-toggle'); el.logoutBtn = $('logout'); el.logoutMsg = $('logout-msg');
    el.confirmBar = q('[data-confirm]'); el.confirmText = $('confirm-text');
    el.confirmYes = $('logout-yes'); el.confirmCancel = $('logout-cancel'); el.ver = q('[data-ver]');
    el.input = { email: el.email, password: el.password, confirm: el.confirm, cardkey: el.cardkey };
    el.err = {};
    var errs = qa('[data-err]'), i;
    for (i = 0; i < errs.length; i++) el.err[errs[i].getAttribute('data-err')] = errs[i];
  }
  /* 幂等写 DOM 的小工具 */
  function txt(node, value) {
    if (!node) return;
    var s = (value === null || value === undefined) ? '' : String(value); if (node.textContent !== s) node.textContent = s;
  }
  function attr(node, name, value) {
    if (!node) return;
    if (value === null || value === undefined) { if (node.hasAttribute(name)) node.removeAttribute(name); return; }
    if (node.getAttribute(name) !== String(value)) node.setAttribute(name, String(value));
  }
  // hidden + 行内 display 双保险：CSS 即使没写 [hidden] 规则也不会漏出隐藏节点。
  function show(node, visible) {
    if (!node) return;
    if (!visible) {
      if (!node.hasAttribute('hidden')) node.setAttribute('hidden', 'hidden');
      node.style.display = 'none';
      return;
    }
    if (node.hasAttribute('hidden')) node.removeAttribute('hidden'); if (node.style.display === 'none') node.style.display = '';
  }
  function toggleCls(node, name, on) {
    if (!node || on === node.classList.contains(name)) return;
    if (on) node.classList.add(name); else node.classList.remove(name);
  }

  /* 渲染：唯一 DOM 写入口，可重复调用 */
  function render() {
    if (!el.root) return;
    var loading = state.phase === 'loading';
    attr(el.root, 'data-loading', loading ? 'true' : 'false');
    attr(el.root, 'data-phase', state.phase);
    attr(el.root, 'aria-busy', (loading || state.busy) ? 'true' : 'false');
    attr(el.shell, 'data-phase', state.phase);
    show(el.skel, loading);
    show(el.viewAuth, state.phase === 'anonymous');
    show(el.viewAccount, state.phase === 'account');
    renderSeg(); renderAuth(); renderAccount();
  }
  function renderSeg() {
    attr(el.seg, 'data-mode', state.mode);
    for (var i = 0; i < el.segBtns.length; i++) {
      var on = el.segBtns[i].getAttribute('data-mode') === state.mode;
      attr(el.segBtns[i], 'aria-selected', on ? 'true' : 'false');
      toggleCls(el.segBtns[i], 'is-active', on);
    }
  }
  function renderAuth() {
    var isReg = state.mode === 'register';
    txt(el.authSubmitLabel, state.busy ? (isReg ? '注册中…' : '登录中…') : (isReg ? '注册' : '登录'));
    attr(el.authSubmit, 'disabled', state.busy ? 'disabled' : null); attr(el.authSubmit, 'aria-busy', state.busy ? 'true' : 'false');
    attr(el.authForm, 'data-mode', state.mode);
    attr(el.password, 'autocomplete', isReg ? 'new-password' : 'current-password');
    attr(el.password, 'placeholder', isReg ? '设置密码（至少 6 位）' : '输入密码');
    show(el.fieldConfirm, isReg); show(el.strength, isReg && state.ui.pwLen > 0);
    renderStrength(); paintErr('email'); paintErr('password'); paintErr('confirm');
    paintReveal('password'); paintReveal('confirm');
    txt(el.authMsg, state.ui.msg.auth); attr(el.authMsg, 'data-tone', state.ui.msg.authTone || null);
  }
  // 强度四项：长度>=8 / 大写 / 数字 / 符号；0-1 弱、2-3 中、4 强。
  function renderStrength() {
    var scored = state.ui.pwLen > 0, s = state.ui.strength;
    attr(el.strength, 'data-level', scored ? (s <= 1 ? 'weak' : (s <= 3 ? 'mid' : 'strong')) : null);
    attr(el.strength, 'data-score', scored ? String(s) : null); attr(el.strength, 'aria-hidden', scored ? 'false' : 'true');
    txt(el.strengthText, scored ? (s <= 1 ? '弱' : (s <= 3 ? '中' : '强')) : '');
    if (el.strengthBar) el.strengthBar.style.width = (scored ? ([8, 25, 50, 75, 100][s] || 8) : 0) + '%';
  }
  function renderAccount() {
    var st = state.status || {}, sess = state.session;
    // [G99] 永久授权（free_forever / permanent）不出现任何卡密入口：本机 grant 已永久有效。
    var permanent = /free_forever|permanent/i.test(String(st.sku || '') + ' ' + String(st.sku_name || ''));
    var canRedeem = !permanent && (sess === 'pending' || sess === 'active' || sess === 'expired' || sess === 'unknown');
    var open = canRedeem && (sess !== 'active' || state.ui.redeemOpen || !!state.ui.msg.redeem);
    var meter = meterData(sess, st);
    attr(el.statusBar, 'data-session', sess);
    txt(el.statusText, statusText(sess, st)); txt(el.kvEmail, st.email || '—');
    txt(el.kvPlan, planText(sess, st)); txt(el.kvExpire, expireText(st));
    show(el.meter, !!meter);
    if (meter) {
      if (el.meterBar) el.meterBar.style.width = meter.pct + '%';
      attr(el.meter, 'data-pct', String(meter.pct)); attr(el.meter, 'title', meter.title);
    }
    show(el.redeemForm, open); show(el.redeemToggle, canRedeem && sess === 'active');
    attr(el.redeemForm, 'data-state', sess === 'active' ? (open ? 'open' : 'collapsed') : 'required');
    attr(el.redeemToggle, 'aria-expanded', open ? 'true' : 'false');
    txt(el.redeemTitle, sess === 'active' ? '续费 / 换卡' : '激活卡密');
    txt(el.redeemSub, sess === 'active' ? REDEEM_SUB_RENEW : REDEEM_SUB);
    txt(el.redeemSubmitLabel, state.busy ? '激活中…' : '激活');
    attr(el.redeemSubmit, 'disabled', state.busy ? 'disabled' : null);
    attr(el.redeemSubmit, 'aria-busy', state.busy ? 'true' : 'false');
    attr(el.cardkey, 'disabled', state.busy ? 'disabled' : null);
    paintErr('cardkey'); txt(el.redeemMsg, state.ui.msg.redeem); attr(el.redeemMsg, 'data-tone', state.ui.msg.redeemTone || null);
    show(el.confirmBar, state.ui.confirmLogout); txt(el.confirmText, CONFIRM_TEXT);
    attr(el.logoutBtn, 'disabled', (state.busy || state.ui.confirmLogout) ? 'disabled' : null);
    txt(el.logoutMsg, state.ui.msg.logout); attr(el.logoutMsg, 'data-tone', state.ui.msg.logout ? 'err' : null);
  }
  function paintErr(name) {
    var msg = state.ui.err[name] || '';
    txt(el.err[name], msg); show(el.err[name], !!msg);
    attr(el.input[name], 'aria-invalid', msg ? 'true' : null);
    attr(el.input[name], 'aria-describedby', msg ? ERR_ID[name] : null);
  }
  function paintReveal(name) {
    var on = !!state.ui.reveal[name], i;
    attr(el.input[name], 'type', on ? 'text' : 'password');
    for (i = 0; i < el.pwIcons.length; i++) {
      var it = el.pwIcons[i];
      if (it.btn.getAttribute('data-pw-toggle') !== name) continue;
      attr(it.btn, 'aria-pressed', on ? 'true' : 'false');
      attr(it.btn, 'aria-label', on ? '隐藏密码' : '显示密码');
      attr(it.btn, 'data-reveal', on ? 'true' : 'false');
      show(it.eye, !on); show(it.off, on);
    }
  }

  /* 文案与格式化 */
  function statusText(sess, st) {
    var note = String(st.note || '').trim(); return (sess === 'unknown' && note) ? note : (SESSION_TEXT[sess] || SESSION_TEXT.unknown);
  }
  function planText(sess, st) {
    var plan = String(st.sku_name || st.sku || '').trim(); return (plan && plan !== 'none' && plan !== '-') ? plan : (SESSION_PLAN[sess] || '—');
  }
  function fmtTime(sec) {
    var n = Number(sec) || 0; if (!n) return '';
    var d = new Date(n * 1000), p = function (v) { return String(v).length < 2 ? '0' + v : String(v); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function expireText(st) {
    var when = fmtTime(st.expires_at); if (!when) return '—';
    var ms = (Number(st.expires_at) || 0) * 1000 - Date.now();
    if (ms <= 0) return when + '（已到期）';
    var days = Math.ceil(ms / (DAY * 1000));
    // [G99] 永久授权不报"剩余 2.7 万天"这种数字
    if (days > 7300) return '永久有效';   // [G103] >20 年即按永久显示（原 36500 天会露出「剩余 26716 天」）
    return when + '（剩余 ' + days + ' 天）';
  }
  // 服务端只给剩余秒数、不给签发时间：进度按 ESTIMATE_DAYS 满量程估算，title 里写明。
  function meterData(sess, st) {
    if (sess !== 'active') return null;
    var left = Number(st.left_seconds) || 0; if (!left) left = Math.max(0, (Number(st.expires_at) || 0) - Math.floor(Date.now() / 1000));
    if (!left) return null;
    return {
      pct: Math.round(Math.min(100, (left / (ESTIMATE_DAYS * DAY)) * 100)),
      title: '授权剩余约 ' + Math.ceil(left / DAY) + ' 天；进度按 ' + ESTIMATE_DAYS + ' 天满量程估算（服务端未提供签发时间）'
    };
  }
  function codeMsg(data) {
    var code = (data && data.code) ? String(data.code) : ''; return (code && MSG[code]) ? MSG[code] : FALLBACK_MSG;
  }
  // /api/auth/login 失败只回 {error}（无 code），按错误文本兜底到凭据错误。
  function loginMsg(res) {
    var d = res.data || {};
    if (d.code && MSG[d.code]) return MSG[d.code];
    return (d.error && String(d.error).indexOf('过期') >= 0) ? MSG['expired'] : LOGIN_FAIL_MSG;
  }

  /* 校验 */
  function vEmail() {
    var v = String(el.email.value || '').trim(); return !v ? '请填写邮箱' : (RE.email.test(v) ? '' : '邮箱格式不正确');
  }
  function vPassword() {
    var v = String(el.password.value || ''); return !v ? '请填写密码' : (v.length < 6 ? '密码至少 6 位' : '');
  }
  function vConfirm() {
    if (state.mode !== 'register') return ''; var v = String(el.confirm.value || '');
    return !v ? '请再次输入密码' : (v === String(el.password.value || '') ? '' : '两次输入的密码不一致');
  }
  // 卡密：转大写、只留 A-Z0-9、OMNI 后每 7 位插 '-'（服务端签发即此格式）；
  // 2026-11-06 修复：旧版按 4 位分组且 KEY_MAX=24，会把 37 字符真卡密截断成无效卡。
  function formatKey(raw) {
    var s = String(raw || '').toUpperCase().replace(RE.cardJunk, '');
    if (s.length > KEY_MAX) s = s.slice(0, KEY_MAX);
    var head = s.indexOf('OMNI') === 0 ? 'OMNI' : '';
    var rest = head ? s.slice(4) : s;
    var segs = rest.match(/.{1,7}/g) || [];
    return head + (segs.length ? (head ? '-' : '') + segs.join('-') : '');
  }
  function vCardkey() {
    var k = formatKey(el.cardkey.value); return !k ? '请填写卡密' : (RE.cardkey.test(k) ? '' : '卡密格式不正确，应为 OMNI-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX');
  }
  var VALIDATORS = { email: vEmail, password: vPassword, confirm: vConfirm, cardkey: vCardkey };
  function validateOne(name) {
    var fn = VALIDATORS[name];
    if (!fn) return '';
    state.ui.err[name] = fn();
    return state.ui.err[name];
  }
  function validateForm(names) {
    var bad = names.filter(function (n) { return validateOne(n); });
    return bad.length ? bad[0] : '';
  }
  function clearErrs() { state.ui.err = { email: '', password: '', confirm: '', cardkey: '' }; }
  function authFields() { return state.mode === 'register' ? ['email', 'password', 'confirm'] : ['email', 'password']; }
  function scorePassword() {
    var v = String(el.password.value || ''); if (!v) return 0;
    var n = (v.length >= 8 ? 1 : 0) + (RE.upper.test(v) ? 1 : 0);
    return n + (RE.digit.test(v) ? 1 : 0) + (RE.other.test(v) ? 1 : 0);
  }

  /* 网络：15s AbortController 超时 + same-origin 凭据 */
  function api(method, url, body) {
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = null, timedOut = false;
    var opts = {
      method: method, credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
    };
    if (ctrl) {
      opts.signal = ctrl.signal;
      timer = setTimeout(function () { timedOut = true; try { ctrl.abort(); } catch (e) { /* 已结束 */ } }, TIMEOUT_MS);
    }
    if (body !== null && body !== undefined) opts.body = JSON.stringify(body);
    function done() { if (timer) { clearTimeout(timer); timer = null; } }
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (raw) {
        done();
        var data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
        return { status: res.status, httpOk: !!res.ok, data: data };
      }, function () { done(); return { status: res.status, httpOk: !!res.ok, data: null }; });
    }, function () {
      done();
      return { status: 0, httpOk: false, data: null, netError: timedOut ? 'timeout' : 'network' };
    });
  }

  /* status 装载与映射（SPEC 第 3 节） */
  function mapStatus(d) {
    if (!d || d.loggedIn === false) return { phase: 'anonymous', session: 'unknown' };
    var s = String(d.session || 'unknown');
    var sku = String(d.sku_name || '').trim();
    if (sku === 'none' || sku === '-') sku = '';
    // [G103] 永久授权判定不能只看 sku_name：老服务端/旧缓存可能只给得到到期时间。
    // 到期剩余 > 20 年 等同永久，直接判 active，不再显示「未绑定卡密」。
    var _expLeft = Number(d.expires_at || 0) - Math.floor(Date.now() / 1000);
    var _perpetual = _expLeft > 7300 * 86400;
    var sess = s === 'ok' ? ((sku || _perpetual) ? 'active' : 'pending')
      : ((s === 'expired' || s === 'offline' || s === 'revoked') ? s : 'unknown');
    return { phase: 'account', session: sess };
  }
  function applyStatus(d) {
    var mapped = mapStatus(d);
    state.phase = mapped.phase; state.session = mapped.session;
    state.status = {
      email: String(d.email || ''), sku: String(d.sku || ''), sku_name: String(d.sku_name || ''),
      note: String(d.note || ''), session_raw: String(d.session || ''),
      expires_at: Number(d.expires_at) || 0, left_seconds: Number(d.left_seconds) || 0,
      session_expires_at: Number(d.session_expires_at) || 0, kbOk: !!d.kbOk, tool_scope: d.tool_scope || ''
    };
    if (state.session === 'pending' || state.session === 'expired') state.ui.redeemOpen = true;
    if (state.session === 'active' && !state.ui.msg.redeem) state.ui.redeemOpen = false;
  }
  function refresh(first) {
    if (first) { state.phase = 'loading'; state.session = 'unknown'; state.status = {}; render(); }
    return api('GET', API.status, null).then(function (res) {
      var d = res.data;
      if (!d || (d.ok === false && typeof d.loggedIn !== 'boolean')) {
        if (state.phase === 'account') { state.session = 'unknown'; state.ui.msg.logout = NET_MSG; }
        else { state.phase = 'anonymous'; state.ui.msg.auth = NET_MSG; state.ui.msg.authTone = 'err'; }
        render(); return;
      }
      applyStatus(d); render();
    });
  }
  /* 交互：Tab / 密码可见 / 强度 / 卡密输入 */
  function setMode(mode) {
    state.mode = mode; clearErrs();
    state.ui.msg.auth = ''; state.ui.msg.authTone = ''; state.ui.pwLen = String(el.password.value || '').length;
    state.ui.strength = scorePassword();
    if (mode === 'login') { state.ui.reveal.confirm = false; if (el.confirm) el.confirm.value = ''; }
    render(); if (el.email && !String(el.email.value || '').trim()) el.email.focus();
  }
  function onSegClick(ev) {
    if (state.busy) return;
    var mode = ev.currentTarget.getAttribute('data-mode');
    if (mode !== 'login' && mode !== 'register') return;
    if (mode !== state.mode) setMode(mode);
  }
  function onPwToggle(ev) {
    var name = ev.currentTarget.getAttribute('data-pw-toggle');
    if (!name || !state.ui.reveal.hasOwnProperty(name)) return;
    state.ui.reveal[name] = !state.ui.reveal[name]; render();
    if (el.input[name]) el.input[name].focus();
  }
  function onPasswordInput() {
    state.ui.pwLen = String(el.password.value || '').length;
    state.ui.strength = scorePassword();
    if (state.ui.err.password) state.ui.err.password = vPassword();
    if (state.ui.err.confirm) state.ui.err.confirm = vConfirm(); render();
  }
  function onConfirmInput() {
    if (!state.ui.err.confirm) return;
    state.ui.err.confirm = vConfirm(); render();
  }
  // 输入掩码：只清洗自身 value（render 不写 value，避免打断光标）。
  function onCardInput() {
    var next = formatKey(el.cardkey.value);
    if (next !== el.cardkey.value) el.cardkey.value = next; if (!state.ui.err.cardkey) return;
    state.ui.err.cardkey = vCardkey(); render();
  }
  function setBusy(on) { state.busy = !!on; render(); }

  /* 交互：登录 / 注册 */
  function onAuthSubmit(ev) {
    ev.preventDefault();
    if (state.busy) return;
    var first = validateForm(authFields());
    if (first) { render(); if (el.input[first]) el.input[first].focus(); return; }
    var isReg = state.mode === 'register';
    var body = { email: String(el.email.value || '').trim().toLowerCase(), password: String(el.password.value || '') };
    state.ui.msg.auth = ''; state.ui.msg.authTone = ''; setBusy(true);
    api('POST', isReg ? API.register : API.login, body).then(function (res) {
      setBusy(false);
      if (isReg) afterRegister(res, body.email); else afterLogin(res, body.email);
    });
  }
  function afterLogin(res, email) {
    var d = res.data || {};
    if (res.netError) { authMsg(NET_MSG, 'err'); return; }
    if (res.httpOk && (d.token || d.user)) {
      if (d.need_card) { authMsg(d.message || '登录成功，请激活卡密后继续', 'ok'); enterPending(d, email, d.message); return; }
      authMsg('登录成功，正在进入…', 'ok'); redirectHome(); return;
    }
    authMsg(loginMsg(res), 'err');
  }
  function afterRegister(res, email) {
    var d = res.data || {};
    if (res.netError) { authMsg(NET_MSG, 'err'); return; }
    if (d.ok === true) {
      if (d.need_card) { authMsg(d.message || '账号已创建，请激活卡密', 'ok'); enterPending(d, email, d.message); return; }
      authMsg('注册成功，正在进入…', 'ok'); redirectHome(); return;
    }
    if (d.code === 'exists') { state.mode = 'login'; clearErrs(); }   // 已注册就顺手切回登录态
    authMsg(codeMsg(d), 'err');
  }
  // 乐观切到 account/pending 并聚焦卡密，随后用权威 status 校正。
  function enterPending(d, email, hint) {
    state.phase = 'account'; state.session = 'pending';
    state.status = {
      email: String(d.email || (d.user && d.user.email) || email || ''),
      sku: '', sku_name: String(d.sku_name || ''), note: String(d.message || ''), session_raw: 'ok',
      expires_at: Number(d.expires_at) || 0, left_seconds: 0, session_expires_at: 0,
      kbOk: false, tool_scope: ''
    };
    state.ui.redeemOpen = true; state.ui.err.cardkey = '';
    state.ui.msg.redeem = hint || PENDING_HINT; state.ui.msg.redeemTone = 'warn';
    render(); if (el.cardkey) el.cardkey.focus(); refresh(false);
  }
  function redirectHome() { setTimeout(function () { location.href = '/'; }, REDIRECT_MS); }
  function authMsg(text, tone) { state.ui.msg.auth = text || ''; state.ui.msg.authTone = tone || ''; render(); }
  /* 交互：激活卡密 */
  function onRedeemToggle() {
    if (state.busy) return;
    state.ui.redeemOpen = !state.ui.redeemOpen;
    render();
    if (state.ui.redeemOpen && el.cardkey) el.cardkey.focus();
  }
  function onRedeemSubmit(ev) {
    ev.preventDefault();
    if (state.busy) return;
    var key = formatKey(el.cardkey.value);
    if (key !== el.cardkey.value) el.cardkey.value = key;
    if (validateOne('cardkey')) { render(); if (el.cardkey) el.cardkey.focus(); return; }
    state.ui.msg.redeem = ''; state.ui.msg.redeemTone = ''; setBusy(true);
    api('POST', API.redeem, { key: key, email: String(state.status.email || '') }).then(function (res) {
      setBusy(false);
      var d = res.data || {};
      if (res.netError) { redeemMsg(NET_MSG, 'err'); return; }
      if (d.ok === true && d.status === 'activated') {
        var when = fmtTime(Number(d.expires_at) || 0);
        redeemMsg('激活成功：' + String(d.sku_name || d.sku || '已生效') + (when ? '，到期 ' + when : ''), 'ok');
        el.cardkey.value = ''; state.ui.err.cardkey = ''; state.ui.redeemOpen = true;
        refresh(false);
        return;
      }
      redeemMsg(codeMsg(d), 'err');
    });
  }
  function redeemMsg(text, tone) { state.ui.msg.redeem = text || ''; state.ui.msg.redeemTone = tone || ''; render(); }

  /* 交互：退出登录（页内二次确认，Esc 撤销） */
  function onLogoutAsk() {
    if (state.busy || state.ui.confirmLogout) return;
    state.ui.confirmLogout = true;
    render();
    if (el.confirmYes) el.confirmYes.focus();
  }
  function onLogoutCancel() {
    if (!state.ui.confirmLogout) return;
    state.ui.confirmLogout = false;
    render(); if (el.logoutBtn) el.logoutBtn.focus();
  }
  function onLogoutDo() {
    if (state.busy) return;
    state.ui.confirmLogout = false;
    setBusy(true);
    api('POST', API.logout, {}).then(function (res) {
      setBusy(false);
      resetFields();
      state.ui.msg.auth = res.netError ? NET_MSG : '已退出登录';
      state.ui.msg.authTone = res.netError ? 'err' : 'ok';
      state.mode = 'login'; refresh(true);
    });
  }
  function resetFields() {
    if (el.email) el.email.value = '';
    if (el.password) el.password.value = '';
    if (el.confirm) el.confirm.value = '';
    if (el.cardkey) el.cardkey.value = '';
    clearErrs(); state.ui.msg.redeem = ''; state.ui.msg.redeemTone = ''; state.ui.msg.logout = '';
    state.ui.reveal.password = false; state.ui.reveal.confirm = false;
    state.ui.strength = 0; state.ui.pwLen = 0;
    state.ui.redeemOpen = false; state.ui.confirmLogout = false;
    state.status = {}; state.session = 'unknown';
  }
  function onKeydown(ev) {
    var key = ev.key || '';
    if (key !== 'Escape' && key !== 'Esc') return;
    if (!state.ui.confirmLogout) return;
    ev.preventDefault(); onLogoutCancel();
  }
  /* 绑定与启动：bindEvents → refresh */
  function bindEvents() {
    el.segBtns.forEach(function (b) { b.addEventListener('click', onSegClick); });
    el.pwToggles.forEach(function (b) { b.addEventListener('click', onPwToggle); });
    if (el.authForm) el.authForm.addEventListener('submit', onAuthSubmit);
    if (el.redeemForm) el.redeemForm.addEventListener('submit', onRedeemSubmit);
    if (el.redeemToggle) el.redeemToggle.addEventListener('click', onRedeemToggle);
    if (el.logoutBtn) el.logoutBtn.addEventListener('click', onLogoutAsk);
    if (el.confirmCancel) el.confirmCancel.addEventListener('click', onLogoutCancel);
    if (el.confirmYes) el.confirmYes.addEventListener('click', onLogoutDo);
    var blurMap = [[el.email, 'email'], [el.password, 'password'], [el.confirm, 'confirm'], [el.cardkey, 'cardkey']];
    blurMap.forEach(function (pair) {
      if (pair[0]) pair[0].addEventListener('blur', function () { validateOne(pair[1]); render(); });
    });
    var inputMap = [[el.password, onPasswordInput], [el.confirm, onConfirmInput], [el.cardkey, onCardInput]];
    inputMap.forEach(function (pair) { if (pair[0]) pair[0].addEventListener('input', pair[1]); });
    document.addEventListener('keydown', onKeydown);
  }
  function init() {
    cacheEls(); if (!el.root) return;
    // 版本号由 shim 替换；替换不到就保留占位 v—，前端不伪造。
    if (el.ver && !String(el.ver.textContent || '').trim()) el.ver.textContent = 'v—';
    bindEvents(); refresh(true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
`;
const REGISTER_HTML = '<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>登录 / 注册 · OmniShade</title>'
  + '<link rel="stylesheet" href="/omni-craft-register.css" />'
  + AUX_THEME_SEED
  + '</head><body data-omni-theme="aux">'
  + REGISTER_BODY_HTML
  + '<scr' + 'ipt>' + REGISTER_LOGIC_JS + '</scr' + 'ipt></body></html>';

function startUiShim(opts) {
  // [UNIFY-SESSIONS] 启动时把旧版按账号分的会话并进统一目录（幂等，只补不覆盖）。
  try {
    const _mig = migrateLegacyAccountData();
    if (_mig && _mig.moved) shimLog({ stage: 'sessions-unify', moved: _mig.moved, skipped: _mig.skipped });
  } catch (e) { shimLog({ stage: 'sessions-unify-err', err: String(e && e.message || e).slice(0, 120) }); }
  const o = opts || {};
  const accountClient = normalizeAccountClient(o.accountClient);
  const accountPost = (pathname, bodyObj, timeoutMs) => omniEntryPost(pathname, bodyObj, timeoutMs, accountClient.targets);
  const accountVerify = (data) => omniVerifyEnvelope(data, accountClient.publicKey);
  const mock = !!o.mock;
  const getAgent = o.agent || (() => require('./omni_agent'));
  // [G17-P1] 账号门禁是否被本次启动绕过(mock + 显式 testAllowMockAccount)。后续所有"账号一致性"复核
  // 必须共用这一个判据: 门禁已跳过(本机/单测无 account.json)却又拿 currentAccountEmail() 去比对
  // job.owner → 恒不相等 → '账号已切换，请重新发送', 注入的 runAgentLoop 一次都没跑, 工具事件全黑。
  const accountGateBypassed = mock === true && o.testAllowMockAccount === true;
  // [G17-P1] 调用方注入了**替身** agent 时, mock 只表示"跳过账号门禁", 不得再用内置 MOCK_REPLY 顶替
  // 真实 loop —— 否则注入的 runAgentLoop 永不执行, 工具卡/工具事件一条都不会产生(D1 验收全黑的根因)。
  // [G17-P1-fix] 判定必须与"是不是真替身"挂钩, 不能只看有没有传 agent: 产品 main.js 恒传
  //   agent: chatAgent(内部就是 require('./omni_agent')) —— 按旧判定 injectedAgent 恒为 true,
  //   mock 态再也进不去内置 MOCK_REPLY, 一路走到"供应商优先"的 selectModel(); 测试态没有 models.json
  //   → 抛"未启用有效供应商，请在「模型配置」中明确启用供应商"(e2e 2 条 FAIL 的真因)。
  //   解出来不是默认 omni_agent 才算真替身; 产品态 mock=false, 这段怎么判都不影响产品链路。
  let injectedAgent = false;
  if (typeof o.agent === 'function') {
    try { const probe = o.agent(); injectedAgent = !!probe && probe !== require('./omni_agent'); }
    catch (_) { injectedAgent = false; }   // 取 agent 失败 → 按默认 agent 处理(走内置链路, 不掩盖失败)
  }
  const getSettings = o.settings || (() => ({}));
  const getKey = o.key || (() => '');
  // H1: 每次启动一个随机 token(主进程生成 → startUiShim 注入渲染层); 未给则本地生成
  const TOKEN = String(o.token || '') || crypto.randomBytes(32).toString('hex');
  // [UI 版本] 真实 APP 版本(main.js APP_VERSION 下发, 不硬编码第二份): 镜像构建产物里写死的
  // 页脚/关于页版本串(如 `v1.1.19 (OmniShade)`)在静态托管时运行时替换为 v<APP_VERSION> (OmniShade)
  const APP_VERSION_UI = String(o.appVersion || '').trim();
  // [REG-V3] 注册页品牌区的版本占位(data-ver)在运行时替换为真实 APP 版本；拿不到就保持 v—，不伪造。
  const registerPageHtml = () => {
    const v = APP_VERSION_UI;
    let html = v ? REGISTER_HTML.split('data-ver>v—<').join('data-ver>v' + v + '<') : REGISTER_HTML;
    // [G105] 打赏：只在账号页出现一次，不打扰主界面
    if (html.indexOf('omni-tip-card') < 0) {
      const tip = '<div class="omni-tip-card" style="margin:28px auto 18px;max-width:420px;padding:16px;border:1px solid rgba(120,130,150,.22);border-radius:14px;text-align:center;background:rgba(120,130,150,.06)">'
        + '<div style="font-size:13px;line-height:1.7;opacity:.85">如果这个软件帮到你了，可以扫个码留下一点爱心 ♥<br><span style="opacity:.65;font-size:12px">（不打赏也照样永久免费用）</span></div>'
        + '<img src="data:image/jpeg;base64,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kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/osYEcgb0/ffp/kbv+77/oAAuCuAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA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" alt="打赏" loading="lazy" style="display:block;width:190px;max-width:70%;margin:12px auto 0;border-radius:10px">'
        + '</div>';
      html = html.indexOf('</body>') >= 0 ? html.replace('</body>', tip + '</body>') : html + tip;
    }
    return html;
  };
  // [关于页 buildInfo] 本地模式: 提交/分支/构建时间跟随真实版本, 不显示 omnishade-local 之类占位
  const BUILD_DATE_ISO = (() => { try { return new Date(require('fs').statSync(__filename).mtime).toISOString().replace(/\.\d+Z$/, 'Z'); } catch (_) { return new Date().toISOString().replace(/\.\d+Z$/, 'Z'); } })();
  const VER_DISPLAY_SRC = 'v\\d+\\.\\d+\\.\\d+ \\(OmniShade\\)';
  const verLogged = new Set();   // (file|version) 只记一次 diag, 防日志刷屏
  function patchUiVersion(fp, buf) {
    if (!APP_VERSION_UI) return buf;
    const want = 'v' + APP_VERSION_UI + ' (OmniShade)';
    let s;
    try { s = buf.toString('utf8'); } catch (_) { return buf; }
    if (s.indexOf(want) >= 0) return buf;                       // 已是目标版本(或无版本串) → 原样返回
    if (!new RegExp(VER_DISPLAY_SRC).test(s)) return buf;       // 该文件不含版本显示串 → 原样返回
    let n = 0;
    const patched = s.replace(new RegExp(VER_DISPLAY_SRC, 'g'), () => { n++; return want; });
    const key = path.basename(fp) + '|' + want;
    if (n && !verLogged.has(key)) { verLogged.add(key); shimLog({ stage: 'ui_version_patched', file: path.basename(fp), to: want, hits: n }); }
    return Buffer.from(patched, 'utf8');
  }
  const STATIC_CACHE = new Map();
  let staticCacheBytes = 0;
  const STATIC_CACHE_MAX_BYTES = 24 * 1024 * 1024;
  async function readStaticAsset(fp, rel) {
    const st = await fs.promises.stat(fp);
    if (!st.isFile()) { const e = new Error('not file'); e.code = 'ENOENT'; throw e; }
    const key = fp;
    const cached = STATIC_CACHE.get(key);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.buf;
    let buf = await fs.promises.readFile(fp);
    // [G7-R6] 镜像首页同时注入官网入口与发布通道更新入口(与 head 里的 auth bootstrap 互不干扰)
    if (rel === 'index.html') buf = Buffer.from(injectHotkeysEntry(injectAutoPanelEntry(injectCtxMenuEntry(injectHistoryMoreEntry(injectUpdateEntry(injectOfficialSiteEntry(injectAppTitle(injectBootstrap(buf.toString('utf8'), TOKEN)))))))), 'utf8');
    buf = patchUiVersion(fp, buf);
    const old = STATIC_CACHE.get(key);
    if (old) staticCacheBytes -= old.buf.length;
    STATIC_CACHE.set(key, { mtimeMs: st.mtimeMs, size: st.size, buf });
    staticCacheBytes += buf.length;
    while (staticCacheBytes > STATIC_CACHE_MAX_BYTES && STATIC_CACHE.size > 1) {
      const first = STATIC_CACHE.keys().next().value;
      const evicted = STATIC_CACHE.get(first); STATIC_CACHE.delete(first);
      staticCacheBytes -= evicted ? evicted.buf.length : 0;
    }
    return buf;
  }
  let boundPort = 0;
  // Session metadata enumeration can be thousands of stat calls. Keep the first page responsive
  // by building the index in a worker and reuse it briefly; mutations invalidate immediately.
  const SESSION_INDEX_TTL_MS = 2500;
  const sessionIndexBuckets = new Map();
  // [HISTORY-RESTORE] Offset pagination over the 2.5s live index loses/duplicates
  // rows whenever a session's mtime changes while the user scrolls. Keep a bounded,
  // owner-scoped point-in-time list for each cursor chain instead.
  const CONVO_SNAPSHOT_TTL_MS = 30 * 60 * 1000;
  const CONVO_SNAPSHOT_LIMIT = 32;
  const convoSnapshots = new Map();
  function pruneConvoSnapshots() {
    const cutoff = Date.now() - CONVO_SNAPSHOT_TTL_MS;
    for (const [id, snapshot] of convoSnapshots) if (snapshot.at < cutoff) convoSnapshots.delete(id);
    while (convoSnapshots.size > CONVO_SNAPSHOT_LIMIT) convoSnapshots.delete(convoSnapshots.keys().next().value);
  }
  function createConvoSnapshot(owner, filterKey, filtered) {
    pruneConvoSnapshots();
    const id = crypto.randomUUID();
    convoSnapshots.set(id, { ownerKey: accountScopeKey(owner), filterKey, filtered, at: Date.now() });
    pruneConvoSnapshots();
    return id;
  }
  function readConvoSnapshot(id, owner, filterKey) {
    const snapshot = convoSnapshots.get(id);
    if (!snapshot || snapshot.ownerKey !== accountScopeKey(owner) || snapshot.filterKey !== filterKey
      || Date.now() - snapshot.at > CONVO_SNAPSHOT_TTL_MS) {
      convoSnapshots.delete(id);
      return null;
    }
    // Sliding expiration keeps a long, active scroll alive; refresh LRU order too.
    snapshot.at = Date.now(); convoSnapshots.delete(id); convoSnapshots.set(id, snapshot);
    return snapshot.filtered;
  }
  function invalidateSessionIndex(owner) {
    const key = accountScopeKey(owner === undefined ? currentAccountEmail() : owner);
    if (key) sessionIndexBuckets.delete(key); else sessionIndexBuckets.clear();
  }
  function sessionIndex(owner) {
    const ownerId = normalizeAccountEmail(owner === undefined ? currentAccountEmail() : owner);
    const key = 'unified';   // 会话已统一到单目录，缓存不再按账号分桶
    const dir = sessionsDir(ownerId);
    if (!key || !dir) return Promise.resolve([]);
    let bucket = sessionIndexBuckets.get(key);
    if (!bucket) { bucket = { cache: null, at: 0, inFlight: null, generation: -1 }; sessionIndexBuckets.set(key, bucket); }
    if (bucket.cache && bucket.generation === SESSION_DIRTY_GENERATION && Date.now() - bucket.at < SESSION_INDEX_TTL_MS) return Promise.resolve(bucket.cache);
    if (bucket.inFlight) return bucket.inFlight;
    const startGeneration = SESSION_DIRTY_GENERATION;
    const work = new Promise((resolve, reject) => {
      const { Worker } = require('worker_threads');
      const worker = new Worker(path.join(__dirname, 'session_index_worker.js'), { workerData: { sessionsDir: dir } });
      let settled = false;
      const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
      const timer = setTimeout(() => { try { worker.terminate(); } catch (_) {} finish(reject, new Error('session index timeout')); }, 20000);
      worker.on('message', (m) => {
        if (!m || !m.ok || !Array.isArray(m.sessions)) return finish(reject, new Error(String((m && m.error) || 'session index failed').slice(0, 300)));
        bucket.cache = m.sessions; bucket.at = Date.now(); bucket.generation = startGeneration; finish(resolve, bucket.cache);
      });
      worker.on('error', (e) => finish(reject, e));
      worker.on('exit', (code) => { if (!settled) finish(reject, new Error('session index worker exited ' + code)); });
    });
    bucket.inFlight = work;
    return work.finally(() => { if (bucket.inFlight === work) bucket.inFlight = null; });
  }
  // [WORKER-POOL] 常驻一个 session_messages worker，按 seq 路由应答。
  // 旧实现每个请求 new Worker()：线程启动 80~120 ms，占 /api/messages 总耗时的九成。
  let _msgWorker = null;
  let _msgSeq = 0;
  const _msgPending = new Map();
  function msgWorkerGet() {
    if (_msgWorker) return _msgWorker;
    const { Worker } = require('worker_threads');
    const w = new Worker(path.join(__dirname, 'session_messages_worker.js'));
    w.on('message', (m) => {
      const done = _msgPending.get(m && m.seq);
      if (done) { _msgPending.delete(m.seq); done(m); }
    });
    const fail = (err) => {
      for (const done of Array.from(_msgPending.values())) done({ ok: false, error: err });
      _msgPending.clear();
      if (_msgWorker === w) _msgWorker = null;
      try { w.terminate(); } catch (_) {}
    };
    w.on('error', (e) => fail(String((e && e.message) || e).slice(0, 300)));
    w.on('exit', (code) => { if (_msgWorker === w) { _msgWorker = null; if (_msgPending.size) fail('session messages worker exited ' + code); } });
    if (typeof w.unref === 'function') w.unref();   // 不阻止进程退出
    _msgWorker = w;
    return w;
  }
  function sessionMessagesWorker(sid, owner) {
    if (!sidOk(sid)) return Promise.resolve([]);
    const ownerId = normalizeAccountEmail(owner === undefined ? currentAccountEmail() : owner);
    const dir = sessionsDir(ownerId);
    if (!dir) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const w = msgWorkerGet();
      const seq = ++_msgSeq;
      const timer = setTimeout(() => { _msgPending.delete(seq); reject(new Error('session messages timeout')); }, 30000);
      _msgPending.set(seq, (m) => {
        clearTimeout(timer);
        if (m && m.ok && Array.isArray(m.messages)) return resolve(m.messages);
        reject(new Error(String((m && m.error) || 'session messages failed').slice(0, 300)));
      });
      try { w.postMessage({ seq, sessionsDir: dir, sid }); }
      catch (e) { clearTimeout(timer); _msgPending.delete(seq); reject(e); }
    });
  }

  // H1: Bearer 定长比较(防时序侧信道)
  function authOk(req) {
    const got = String(req.headers['authorization'] || '');
    const want = 'Bearer ' + TOKEN;
    try {
      const a = Buffer.from(got), b = Buffer.from(want);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (_) { return false; }
  }
  // H1: Host 必须指向本机监听端口(挡 DNS rebinding / 任意本机进程直连伪造域名)
  function hostOk(req) {
    const h = String(req.headers['host'] || '').toLowerCase();
    return h === '127.0.0.1:' + boundPort || h === 'localhost:' + boundPort || h === '[::1]:' + boundPort;
  }
  // H1: 带跨源 Origin 的请求一律拒绝(无 Origin 的同源导航/GET 放行)
  function originOk(req) {
    const oo = req.headers['origin'];
    if (!oo) return true;
    const s = String(oo).toLowerCase().replace(/\/+$/, '');
    return s === 'http://127.0.0.1:' + boundPort || s === 'http://localhost:' + boundPort;
  }

  // H1: sid 白名单拒绝(读/写共用; 依赖请求作用域内的 json(), 在使用处绑定)

  // ── 生成 job(v2 可续流协议的状态容器) ──
  // streamId === conversationId(与上游 GenerationJobManager 一致, api/server/routes/agents/index.js:96
  // "streamId === conversationId, so we can use getJob directly")
  const jobs = new Map();          // accountScopeKey:streamId → job
  // [SIDEBAR-ACTIVE] One current indicator per account. Track the latest submitted
  // job explicitly so an older unfinished job can never reclaim the indicator.
  const currentJobByOwner = new Map(); // normalized owner → latest submitted job
  const JOB_REAP_DELAY_MS = 30000;   // 终态后延迟回收帧缓冲(给续订/重放 30s 窗口; 空闲期不再常驻)
  let accountLifecycleEpoch = 0;
  function jobKey(owner, sid) { const key = accountScopeKey(owner); return key ? key + ':' + sid : null; }
  function ownedJob(owner, sid) { const key = jobKey(owner, sid); return key ? jobs.get(key) : null; }
  function hasForeignJob(owner, sid) {
    const own = jobKey(owner, sid);
    for (const [key, job] of jobs) if (key !== own && job && job.conversationId === sid) return true;
    return false;
  }
  function invalidateAccountJobs(reason) {
    accountLifecycleEpoch++;
    for (const job of jobs.values()) {
      if (!job || job.done) continue;
      job.accountInvalidated = true;
      cancelQueuedSteers(job, () => true);
      job.aborted = true; job.preemptedBySteer = false;
      if (job.kill) { try { job.kill(); } catch (_) {} }
      // Active loops own persistence. Publish final only after their abort settles.
      if (!job.loopActive) jobFinalize(job, true);
    }
    shimLog({ stage: 'account-lifecycle-invalidated', reason: String(reason || 'changed').slice(0, 40), epoch: accountLifecycleEpoch });
  }
  const PROTO = { 'X-LibreChat-Generation-Protocol': '2' };
  const MOCK_REPLY = [
    '# 本地 LibreChat 链路自检 (MOCK)',
    '',
    '**结论**: 本地 UI + shim + SSE 桥已连通。',
    '',
    '- 静态资产来自 desktop/ui/ (已从线上镜像)',
    '- 会话列表读的是本机 sessions/*.jsonl',
    '- 本条回答由 shim 的 MOCK 流逐字推送(v2 可续流协议)',
    '',
    '| 环节 | 状态 |',
    '| --- | --- |',
    '| 窗口/UI | OK |',
    '| shim /api/convos | OK |',
    '| SSE 桥 | OK |',
  ].join('\n');

  // [1.1.30] 会话消息计数/lastId: 与 /api/messages 的序号方案一致(非 system/tool/meta)
  function convoMsgSeq(ag, sid, owner) {
    let raw = [];
    try { raw = ag.loadSession(sid, owner) || []; } catch (_) {}
    let count = 0;
    for (const m of raw) { if (!m || m.role === 'system' || m.role === 'tool' || m.meta) continue; count++; }
    return count;
  }
  // Process-local FIFO: the frozen agent has no live steering hook. Each item
  // becomes a new, serialized run AFTER its predecessor has persisted/finalized.
  // Wire receipts follow client/src/data-provider/SSE/mutations.ts:165-205 and
  // packages/data-provider/src/types/queuedTurns.ts:53-94 (never claim preemption).
  const STEER_QUEUE_LIMIT = 16;
  // [CHAT-QUEUE] runAgentLoop 的正常终态不只有 OpenAI stop/tool_calls；
  // persistent 成功收尾是 goal_done。三个消费点必须共用同一判据，否则回答成功后队列仍被判死。
  function isSuccessfulFinish(finish) {
    return !finish || finish === 'stop' || finish === 'tool_calls' || finish === 'goal_done';
  }
  function isSuccessfulPredecessor(job) {
    return (!job.err && isSuccessfulFinish(job.finish))
      || (job.preemptedBySteer === true && job.finish === 'interrupted_partial');
  }
  function queuedTurnView(item, position) {
    return { ...item.receipt, ...(position == null ? {} : { position }) };
  }
  function jobContent(job) {
    const parts = assistantContent(job.toolCalls, job.acc, job.reasoning || job.finalReasoning);
    // Receipt evidence lets the fork retire optimistic steer chips even when
    // the automatic successor completes before the first status/refetch.
    for (const item of job.steering.receipts.values()) {
      const r = item.receipt;
      if (r.status === 'admitted') parts.push({ type: 'steer', steer: r.text,
        steerId: r.steerId, clientSteerId: r.clientSteerId, createdAt: Date.parse(r.createdAt) });
    }
    return parts;
  }
  function pendingSteers(job) {
    return job ? job.steering.queue.map((item) => ({
      steerId: item.receipt.steerId, clientSteerId: item.receipt.clientSteerId,
      text: item.receipt.text, createdAt: Date.parse(item.receipt.createdAt),
      preempt: item.receipt.preempt === true, preemptRevision: Number(item.receipt.preemptRevision || 0),
    })) : [];
  }
  function queueSteer(job, body, verifiedQueueLineage) {
    const state = job.steering;
    const clientId = body.clientSteerId || body.clientRequestId || crypto.randomUUID();
    const previous = state.receipts.get(clientId);
    if (previous) return { item: previous, replayed: true };
    if (state.queue.length >= STEER_QUEUE_LIMIT) return { code: 'STEER_QUEUE_FULL' };
    // Keep bounded terminal receipts for ambiguous POST retries; never evict a
    // queued item merely to make room for another request.
    if (state.receipts.size >= 128) {
      for (const [key, item] of state.receipts) {
        if (item.receipt.status !== 'queued') { state.receipts.delete(key); break; }
      }
    }
    const id = crypto.randomUUID(), now = new Date().toISOString();
    const item = { model: null, verifiedQueueLineage, receipt: {
      queuedTurnId: id, steerId: id, clientSteerId: body.clientSteerId,
      clientRequestId: clientId, conversationId: job.conversationId,
      parentMessageId: body.parentMessageId || job.mid, text: body.text, status: 'queued',
      preempt: body.preempt === true, preemptRevision: body.preempt === true ? 1 : 0,
      expectedPredecessorCreatedAt: body.generationCreatedAt ?? job.createdAt, generationCreatedAt: job.createdAt,
      revision: ++state.revision, createdAt: now, updatedAt: now,
    } };
    if (job.aborted) {
      // The cancelled predecessor cannot execute another turn. Preserve a
      // newly accepted queued message as a visible, recoverable receipt.
      item.receipt.status = 'dead';
      item.receipt.failure = { code: 'PREDECESSOR_FAILED', message: '上一轮未成功完成；该排队消息未执行，请手动重试。' };
    } else {
      state.queue.push(item);
    }
    state.receipts.set(clientId, item);
    return { item, replayed: false };
  }
  function preemptForSteer(job, item, boundary) {
    if (!job || !item || job.done || job.aborted || item.receipt.status !== 'queued') return false;
    job.preemptRequested = item.receipt.steerId;
    job.preemptedBySteer = true;
    item.receipt.preempt = true;
    item.receipt.preemptRevision = Math.max(1, Number(item.receipt.preemptRevision || 0) + (boundary === 'arm' ? 1 : 0));
    item.receipt.updatedAt = new Date().toISOString();
    item.receipt.boundary = boundary;
    if (job.kill) { try { job.kill(); } catch (_) {} }
    else if (job.timer) {
      clearInterval(job.timer); job.timer = null;
      job.finish = 'interrupted_partial';
      jobFinalize(job, false);
    }
    return true;
  }
  function cancelQueuedSteers(job, predicate) {
    if (!job) return 0;
    let removed = 0, cancelledPreempt = false;
    for (const item of job.steering.receipts.values()) {
      if (!['queued', 'dead'].includes(item.receipt.status) || !predicate(item.receipt)) continue;
      if (!job.done && item.receipt.steerId === job.preemptRequested) cancelledPreempt = true;
      item.receipt.status = 'cancelled'; item.receipt.updatedAt = new Date().toISOString();
      removed++;
    }
    if (cancelledPreempt) {
      // The preempt signal already stopped this run. Removing its handoff
      // target cannot turn that interruption into a successful completion;
      // no other queued turn may inherit the cancelled boundary.
      job.aborted = true; job.preemptedBySteer = false; job.preemptRequested = null;
      job.finish = 'aborted';
      for (const item of job.steering.queue) {
        if (item.receipt.status !== 'queued') continue;
        item.receipt.status = 'dead'; item.receipt.updatedAt = new Date().toISOString();
        item.receipt.failure = { code: 'PREDECESSOR_FAILED', message: '上一轮未成功完成；该排队消息未执行，请手动重试。' };
      }
      if (job.kill) { try { job.kill(); } catch (_) {} }
    }
    job.steering.queue = job.steering.queue.filter((item) => item.receipt.status === 'queued');
    if (cancelledPreempt && !job.loopActive) jobFinalize(job, true);
    return removed;
  }
  function continueQueuedJob(job) {
    if (job.aborted || job.accountInvalidated || job.accountLifecycleEpoch !== accountLifecycleEpoch || currentAccountEmail() !== job.owner) {
      // Abort retires only runnable work. A previously failed receipt remains
      // visible for recovery; it must not be turned into a user cancellation.
      cancelQueuedSteers(job, (receipt) => receipt.status === 'queued');
      return null;
    }
    const successfulPredecessor = isSuccessfulPredecessor(job);
    if (!successfulPredecessor) {
      for (const item of job.steering.queue.splice(0)) {
        item.receipt.status = 'dead'; item.receipt.updatedAt = new Date().toISOString();
        item.receipt.failure = { code: 'PREDECESSOR_FAILED', message: '上一轮未成功完成；该排队消息未执行，请手动重试。' };
      }
      return null;
    }
    if (!job.steering.queue.length) return null;
    const item = job.steering.queue.shift();
    const next = newJob(job.conversationId, item.receipt.text, job.owner);
    next.model = item.model;
    item.receipt.status = 'admitted';
    item.receipt.effectivePredecessorCreatedAt = job.createdAt;
    item.receipt.updatedAt = new Date().toISOString();
    next.queuedTurn = item.receipt;
    // Carry the precise parent/epoch proof checked when THIS item entered the
    // FIFO. A predecessor may have a different verified root (A→B→D→E where
    // E was anchored to B); reconstructing only from D loses E's B proof.
    // Never derive an inherited root from the untrusted receipt fields alone.
    if (item.verifiedQueueLineage) next.queuedTurnLineage = item.verifiedQueueLineage;
    setTimeout(() => jobStart(next), 0);
    return next;
  }
  function prepareHistoryEdit(sid, body, owner) {
    // createPayload.ts forwards omniHistoryEdit only for an explicit local user
    // edit. Ordinary sends also carry parentMessageId; a stale parent must
    // never be interpreted as permission to truncate later durable turns.
    if (body.editedContent != null || body.isContinued === true) {
      const e = new Error('本地回答编辑请使用保存；重新生成从原用户消息开始'); e.status = 400; throw e;
    }
    const regenerate = body.isRegenerate === true;
    const edit = body.omniHistoryEdit === true;
    const hasParent = Object.prototype.hasOwnProperty.call(body, 'parentMessageId');
    if (!regenerate && !hasParent && !edit) return null;
    if (edit && (regenerate || !hasParent)) {
      const e = new Error('编辑请求缺少有效的原消息锚点'); e.status = 400; throw e;
    }
    const parent = regenerate ? body.overrideParentMessageId : body.parentMessageId;
    const root = parent == null || parent === '' || parent === '00000000-0000-0000-0000-000000000000';
    if (!root && (typeof parent !== 'string' || !/^[A-Za-z0-9_-]{1,180}$/.test(parent))) {
      const e = new Error('无效的回退消息标识'); e.status = 400; throw e;
    }
    const fp = sessionPath(sid, owner);
    const original = fp && fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '';
    const raw = getAgent().loadSession(sid, owner) || [];
    const groups = messageGroups(raw, sid);
    if (!regenerate && !edit) {
      const last = groups.length ? groups[groups.length - 1].id : null;
      if ((root ? last !== null : parent !== last)) {
        const e = new Error('会话最新消息已变化，请刷新后重试'); e.status = 409; throw e;
      }
      return null;
    }
    const index = root ? -1 : groups.findIndex(row => row.id === parent);
    if (!root && index < 0) { const e = new Error('回退消息不存在，请刷新会话后重试'); e.status = 409; throw e; }
    if (regenerate && (index < 0 || groups[index].role !== 'user')) {
      const e = new Error('重新生成需要有效的原用户消息'); e.status = 409; throw e;
    }
    const cut = index < 0 ? 0 : groups[index].end;
    const user = regenerate ? projectSessionRows(raw, sid)[index] : null;
    return { rows: raw.slice(0, cut), promptRows: regenerate ? raw.slice(0, groups[index].start) : raw.slice(0, cut),
      user, original, changed: cut < raw.length, committed: false };
  }
  function commitHistoryEdit(job) {
    const plan = job.historyPlan;
    if (!plan || plan.committed) return;
    const fp = sessionPath(job.conversationId, job.owner);
    if (!fp) throw new Error('account session required for history edit');
    if (plan.changed) {
      const current = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '';
      if (current !== plan.original) throw new Error('会话已变化，未执行回退；请刷新后重试');
      const temp = fp + '.' + crypto.randomUUID() + '.tmp';
      const backupTemp = temp + '.bak';
      try {
        fs.writeFileSync(backupTemp, current, { mode: 0o600 });
        fs.renameSync(backupTemp, fp + '.rewind.bak');
        fs.writeFileSync(temp, plan.rows.map(row => JSON.stringify(row)).join('\n') + (plan.rows.length ? '\n' : ''), { mode: 0o600 });
        fs.renameSync(temp, fp);
      } finally { for (const candidate of [temp, backupTemp]) { try { fs.unlinkSync(candidate); } catch (_) {} } }
      SESSION_DIRTY_GENERATION++; invalidateSessionIndex(job.owner);
    }
    plan.committed = true;
  }
  function newJob(sid, prompt, owner, historyPlan) {
    const ownerId = normalizeAccountEmail(owner);
    if (!ownerId) throw new Error('account session required for generation');
    const history = historyPlan ? projectSessionRows(historyPlan.rows, sid) : sessionMessages(getAgent(), sid, ownerId);
    const previous = ownedJob(ownerId, sid);
    const job = {
      streamId: sid, conversationId: sid, owner: ownerId, prompt: historyPlan && historyPlan.user ? historyPlan.user.text : (prompt || ''),
      createdAt: Math.max(Date.now(), previous ? previous.createdAt + 1 : 0),
      accountLifecycleEpoch,
      steering: previous ? previous.steering : { queue: [], receipts: new Map(), revision: 0 },
      mid: 'msg_' + crypto.randomUUID(), pid: historyPlan && historyPlan.user ? historyPlan.user.messageId : 'msg_' + crypto.randomUUID(),
      pidParent: historyPlan && historyPlan.user ? historyPlan.user.parentMessageId : (history.length ? history[history.length - 1].messageId : null),
      skipPersistUser: !!(historyPlan && historyPlan.user),
      historyPlan: historyPlan || null,
      acc: '', err: null,
      pendingText: '', chunkTimer: null, finalizePending: null,
      frames: [], subs: new Set(), finalFrame: null, done: false, aborted: false, timer: null, kill: null,
      toolCalls: [],   // D1: 本轮真实工具调用流水(供工具卡渲染 + /api/agents/tools/calls)
    };
    const key = jobKey(ownerId, sid);
    jobs.set(key, job);
    currentJobByOwner.set(ownerId, job); // [SIDEBAR-ACTIVE] newest submission replaces the previous current job
    if (jobs.size > 50) {
      for (const [oldKey, old] of jobs) {
        if (oldKey !== key && old.done && !old.loopActive && !old.steering.queue.length) { jobs.delete(oldKey); break; }
      }
    }
    return job;
  }
  // D1: 流式工具事件 —— 与镜像 UI agents 协议对齐(Rb.ON_RUN_STEP / ON_RUN_STEP_COMPLETED)
  // The fork accepts a concrete runId. Use the durable assistant ID from the
  // first step, so final compaction preserves the existing content subtree.
  function emitToolStart(job, tc, index) {
    jobPush(job, {
      event: 'on_run_step',
      data: {
        id: tc.stepId, runId: job.mid, index: index, type: 'tool_calls',
        stepDetails: { type: 'tool_calls', tool_calls: [{ id: tc.id, name: tc.name, args: tc.args || '', type: 'tool_call' }] },
      },
    });
  }
  function emitToolDone(job, tc) {
    jobPush(job, {
      event: 'on_run_step_completed',
      data: { result: { id: tc.stepId, tool_call: { id: tc.id, name: tc.name, args: tc.args || '', output: _clip(_asText(tc.output), TOOL_OUT_LIMIT), progress: 1 } } },
    });
  }
  /** 帧进缓冲并推给订阅者; obj === null 表示流结束(BUFFER 完成后关闭连接) */
  function jobPush(job, obj) {
    if (job.done && obj) return;
    job.frames.push(obj);
    for (const fn of job.subs) { try { fn(obj); } catch (_) {} }
  }
  function jobFinish(job) {
    if (job.done) return;
    job.done = true;
    // [SIDEBAR-ACTIVE] Clear only the job that still owns the pointer. If an older
    // job finishes after a newer one started, the newer conversation stays lit.
    if (currentJobByOwner.get(job.owner) === job) currentJobByOwner.delete(job.owner);
    if (job.chunkTimer) { clearTimeout(job.chunkTimer); job.chunkTimer = null; }
    if (job.timer) { clearInterval(job.timer); job.timer = null; }
    for (const fn of Array.from(job.subs)) { try { fn(null); } catch (_) {} }
    job.subs.clear();
    scheduleJobReap(job);   // 终态: 延迟回收帧缓冲, 空闲期不再常驻
  }
  // 终态 job 的帧缓冲是大内存占用源; 续订/重放只需 finalFrame(已存 job.finalFrame)。
  // 延迟 N 秒后置空 frames/subs, 并从 jobs Map 移除(仅当 steering 队列已空), 空闲期不再常驻。
  function scheduleJobReap(job) {
    const t = setTimeout(() => {
      job.frames = null;
      job.subs = null;
      if (!job.steering || job.steering.queue.length === 0) {
        for (const [k, j] of jobs) if (j === job) { jobs.delete(k); break; }
      }
    }, JOB_REAP_DELAY_MS);
    if (t.unref) t.unref();
  }
  // [1.1.33] delta 协议(fork useStepHandler.ts:1053/1132): 帧的 id 必须是**已注册的 run step id**(on_run_step 注册, runId=job.mid),
  //   否则帧进 pendingDeltaBuffer 永远等不到 step → 只发不渲染(思维链不上屏/闪屏的根因)。
  //   步骤索引: 工具卡用 0..n(现状不动), 思维链=900, 正文=901(布局: 工具卡在上, 思维链在正文上方)。
  function ensureDeltaStep(job, kind) {
    if (job.done) return;
    if (kind === 'think' && !job.stepThink) {
      job.stepThink = 'step_think_' + job.conversationId;
      jobPush(job, { event: 'on_run_step', data: { id: job.stepThink, runId: job.mid, index: 900, type: 'message_creation', stepDetails: { type: 'message_creation', message_creation: {} } } });
    }
    if (kind === 'text' && !job.stepText) {
      job.stepText = 'step_text_' + job.conversationId;
      jobPush(job, { event: 'on_run_step', data: { id: job.stepText, runId: job.mid, index: 901, type: 'message_creation', stepDetails: { type: 'message_creation', message_creation: {} } } });
    }
  }
  // 思维链流式帧(on_reasoning_delta, think 累计)
  function jobReasoning(job, rz, force) {
    if (job.done) return;
    if (rz) job.reasoning = (job.reasoning || '') + String(rz);
    if (!job.reasoning) return;
    const now = Date.now();
    if (!force && now - (job.rzAt || 0) < 150 && (job.reasoning.length - (job.rzLen || 0)) < 120) return;   // 节流
    // [1.1.46] 发增量(自上次发送以来), 不是累计全文 —— 同滚雪球修复
    const rzDelta = job.reasoning.slice(job.rzLen || 0);
    job.rzAt = now; job.rzLen = job.reasoning.length;
    ensureDeltaStep(job, 'think');
    jobPush(job, { event: 'on_reasoning_delta', data: { id: job.stepThink, delta: { content: [{ type: 'think', think: rzDelta }] } } });
  }
  function scheduleJobTextPump(job) {
    if (job.chunkTimer || job.done) return;
    job.chunkTimer = setTimeout(() => {
      job.chunkTimer = null;
      if (job.done) return;
      const text = job.pendingText.slice(0, 512);
      job.pendingText = job.pendingText.slice(text.length);
      if (text) {
        ensureDeltaStep(job, 'text');
        jobPush(job, { event: 'on_message_delta', data: { id: job.stepText, delta: { content: [{ type: 'text', text }] } } });
      }
      if (job.pendingText) scheduleJobTextPump(job);
      else if (job.finalizePending) {
        const pending = job.finalizePending;
        job.finalizePending = null;
        jobFinalize(job, pending.aborted, true);
      }
    }, 16);
  }
  function flushJobText(job) {
    if (!job.pendingText) return;
    ensureDeltaStep(job, 'text');
    const text = job.pendingText;
    job.pendingText = '';
    if (job.chunkTimer) { clearTimeout(job.chunkTimer); job.chunkTimer = null; }
    jobPush(job, { event: 'on_message_delta', data: { id: job.stepText, delta: { content: [{ type: 'text', text }] } } });
  }
  /** [1.1.90] 正文增量进入16ms有界泵，避免本机UI被高频小帧淹没。 */
  function jobChunk(job, t) {
    if (job.done || !t) return;
    job.pendingText += String(t);
    job.acc += String(t);
    scheduleJobTextPump(job);
  }
  /** 收尾: final 帧带齐 finalHandler 要的 requestMessage/responseMessage/conversation(useEventHandlers.ts:894)
   *  M5: 本函数只推帧(jobFinish → 订阅者收到 null), 绝不 end 响应 —— DONE+end 统一在 jobWriter 的 null 分支(endSse) */
  function jobFinalize(job, aborted, drained) {
    if (job.done) return;
    const isAborted = job.aborted || !!aborted;
    job.aborted = isAborted;
    if (!drained && job.pendingText && !isAborted && !job.err) {
      job.finalizePending = { aborted: false };
      scheduleJobTextPump(job);
      return;
    }
    flushJobText(job);
    const ag = getAgent();
    const now = new Date().toISOString();
    try { if (job.reasoning && (job.rzLen || 0) < job.reasoning.length) jobReasoning(job, '', true); } catch (_) {}   // [1.1.31] 思维链尾量补发
    // [A4] 终态必须进 UI: r.text(带 [输出中断]/[轮数上限] 标记) 与 r.finish 不再只写日志。
    const fin = isAborted ? 'aborted' : (job.finish || (job.err ? 'error' : null));
    const isInterrupt = fin === 'interrupted_partial';                        // 引擎已交付半截文本(自带标记)
    const nonSuccess = !!fin && !isSuccessfulFinish(fin);
    const isTrunc = nonSuccess || !!job.err || isAborted;
    // 三份文本逐字节一致(T4): UI 显示以 agent 终态文本为准(流式 acc 可能缺引擎后补的标记行)
    // [G17-P1] 原判定要求 finalText !== acc 才下发 —— 流式与终态逐字节一致时(正常完成的绝大多数情况)
    // 这帧就被吞了: 旧客户端/自证脚本拿不到累计文本(textLen=0), 只有 final 帧里才有全文。
    // 累计文本帧是 LibreChat v1 协议的正帧(useSSE 靠 data.message 注水), 与 v2 的 delta 帧并存不冲突,
    // 故终态一律下发一次全文, 不再以"和 acc 不同"为条件。
    // [G17-P1] 无 finalText 的链路(内置 MOCK_REPLY / 引擎未回填终态)同样必须下发一次累计全文帧,
    // 否则 v1 客户端与自证脚本只能拿到 final 帧里的文本, 累计帧恒为 0 长度。
    const finalAcc = (typeof job.finalText === 'string' && job.finalText.length) ? job.finalText : (job.acc || '');
    if (finalAcc) {
      job.acc = finalAcc;
      jobPush(job, { message: true, text: job.acc, messageId: job.mid, parentMessageId: job.pid, conversationId: job.conversationId });
    }
    // 保留引擎终态全文；只有未交付终态文本时兜底，不能把工具/子任务失败谎报成网络中断。
    if (isTrunc && job.acc && typeof job.finalText !== 'string' && !/\[输出中断|任务达到最大轮数上限|\[工具失败|\[子任务失败|\[PERSONA_CONTRACT_VIOLATION|\[重复输出|\[已停止|\[任务未完成/.test(job.acc)) {
      job.acc += isInterrupt ? '\n\n[输出中断: 上方为已保留的部分内容]'
        : (isAborted || fin === 'aborted') ? '\n\n[已停止: 上方为已保留的部分内容]'
        : '\n\n[任务未完成: 本轮未成功结束, 上方为已保留的部分内容]';
      jobPush(job, { message: true, text: job.acc, messageId: job.mid, parentMessageId: job.pid, conversationId: job.conversationId });
    }
    const text = job.acc || (job.err ? job.err : '');
    const errFlag = !!job.err || (nonSuccess && fin !== 'aborted');
    const unfinishedFlag = isTrunc;
    const requestMessage = {
      messageId: job.pid, conversationId: job.conversationId, parentMessageId: (job.pidParent !== undefined ? job.pidParent : null), isCreatedByUser: true,
      sender: 'User', text: job.prompt || '(空)', createdAt: now, updatedAt: now,
      error: false, unfinished: false, model: null, endpoint: 'agents',
    };
    // v2 lifecycle reconciliation also applies before persistence: a preempted
    // setup must hand off without inventing durable user/assistant identities.
    const successfulPredecessor = !isAborted && isSuccessfulPredecessor(job);
    const handoff = successfulPredecessor && !job.accountInvalidated
      && job.accountLifecycleEpoch === accountLifecycleEpoch && job.steering.queue.length > 0
      && currentAccountEmail() === job.owner;
    const lifecycle = handoff ? { reconcile: true, reconcileReason: 'queued_follow_up', terminalStatus: 'complete' } : {};
    // runAgentLoop may await loadBridgeTools before its first append. Owning
    // persistence is not proof of durable IDs; verify the pair after it settles.
    const verifyInterruptedIds = !mock && (isAborted || job.preemptedBySteer);
    const savedMessages = verifyInterruptedIds && job.loopOwnsPersistence
      ? sessionMessages(ag, job.conversationId, job.owner) : [];
    const durablePair = savedMessages.some(row => row.isCreatedByUser && row.messageId === job.pid)
      && savedMessages.some(row => !row.isCreatedByUser && row.messageId === job.mid && row.parentMessageId === job.pid);
    // A rejected edit/regeneration is not an ordinary failed send: appending
    // its proposed IDs to the untouched suffix would manufacture a new branch.
    const uncommittedHistoryEdit = job.historyPlan && !job.historyPlan.committed;
    if ((verifyInterruptedIds && !durablePair) || uncommittedHistoryEdit) {
      const earlyFinal = { final: true, ...lifecycle, earlyAbort: true, aborted: isAborted, finish: fin,
        ...(job.err ? { error: job.err } : {}),
        generationCreatedAt: job.createdAt, generationProtocolVersion: 2,
        conversation: convoOf(ag, job.conversationId, Date.now(), null, job.owner), requestMessage };
      jobPush(job, earlyFinal);
      job.finalFrame = earlyFinal;
      if (job.err) shimLog({ stage: 'gen-error', sid: job.conversationId, err: String(job.err).slice(0, 200) });
      jobFinish(job);
      continueQueuedJob(job);
      return;
    }
    const responseMessage = {
      messageId: job.mid, conversationId: job.conversationId, parentMessageId: job.pid, isCreatedByUser: false,
      sender: 'OmniShade', content: assistantContent(job.toolCalls, text, (job.reasoning || job.finalReasoning || '')),
      createdAt: now, updatedAt: now, error: errFlag, unfinished: unfinishedFlag, finish: fin, model: null, endpoint: 'agents',
    };
    try {   // 先落盘: 客户端 final 后可能立刻 refetch /api/messages/<sid>
      // [H2 配套] 真链路下 runAgentLoop 已用同一 sid 落盘(user/assistant/tool 全量) —— 再写一遍会重复,
      // 且下一轮历史回读会出现双份消息。仅 MOCK 链路在 shim 侧落盘。
      if (!job.loopOwnsPersistence) {
        if (!job.skipPersistUser) appendLocal(ag, job.conversationId, { role: 'user', content: job.prompt || '(空)', messageId: job.pid, parentMessageId: job.pidParent }, job.owner);
        appendLocal(ag, job.conversationId, { role: 'assistant', content: text, finish: fin, messageId: job.mid, parentMessageId: job.pid }, job.owner);
      }
    } catch (_) {}
    SESSION_DIRTY_GENERATION++;
    const titleStr = (job.prompt || '本地会话').slice(0, 60);
    const finalObj = { final: true, ...lifecycle, generationCreatedAt: job.createdAt, generationProtocolVersion: 2, aborted: isAborted, finish: fin, interrupted: !!isInterrupt, truncated: !!isTrunc, conversation: { ...convoOf(ag, job.conversationId, Date.now(), null, job.owner), title: titleStr }, requestMessage, responseMessage };
    jobPush(job, finalObj);
    job.finalFrame = finalObj;
    if (!isAborted) jobPush(job, { event: 'title', data: { conversationId: job.conversationId, title: titleStr } });
    if (job.err) shimLog({ stage: 'gen-error', sid: job.conversationId, err: String(job.err).slice(0, 200) });
    jobFinish(job);
    continueQueuedJob(job);
  }
  /** 一个 SSE 响应的写入器: obj=null → 收尾(DONE + end) —— 全流程唯一 end 点(M5) */
  function jobWriter(res, isClosed) {
    return (obj) => {
      if (isClosed()) return;
      if (res.writableEnded || res.destroyed) return;                       // M5: 已结束就绝不再写
      if (obj === null) { endSse(res); return; }
      try { res.write(sseFrame('message', obj)); } catch (_) {}
    };
  }
  /** 跑一次生成: created → 增量帧 → final(+title) */
  function jobStart(job) {
    if (job.done || job.started) return;
    job.started = true;
    // useSSE/useResumableSSE hydrate the user only from data.message.
    const now = new Date(job.createdAt).toISOString();
    jobPush(job, { created: true, messageId: job.mid, parentMessageId: job.pid, conversationId: job.conversationId,
      message: { messageId: job.pid, conversationId: job.conversationId, parentMessageId: job.pidParent,
        isCreatedByUser: true, sender: 'User', text: job.prompt || '(空)',
        createdAt: now, updatedAt: now, error: false, unfinished: false, model: null, endpoint: 'agents' } });
    if (mock && !injectedAgent) {
      try { commitHistoryEdit(job); } catch (e) { job.err = e.message; jobFinalize(job, false); return; }
      let i = 0;
      job.timer = setInterval(() => {
        if (job.done) return;
        if (i >= MOCK_REPLY.length) {
          const timer = job.timer;
          job.timer = null;
          clearInterval(timer);
          jobFinalize(job, false);
          return;
        }
        const chunk = MOCK_REPLY.slice(i, i + 4); i += 4;
        jobChunk(job, chunk);
      }, 12);
      return;
    }
    // 真实链路: 账号 gate 必须先于模型/API Key 配置检查。
    const ac = new AbortController();
    job.kill = () => { try { ac.abort(); } catch (_) {} };
    const finishSetupAbort = () => {
      if (job.done) return true;
      if (!ac.signal.aborted) return false;
      job.finish = job.preemptedBySteer ? 'interrupted_partial' : 'aborted';
      jobFinalize(job, !job.preemptedBySteer);
      return true;
    };
    (async () => {
      try {
  // [1.1.56] 使用门禁: 必须注册/登录且会话有效; test-only mocks must opt in
  // explicitly, so no renderer input can ever bypass the production account gate.
  // [G34 · 本机授权主路径] 老板要求「授权从本机，不依赖服务端」。
  // 本机 license.key 离线验签通过（Ed25519 签名 + 三分量指纹绑定）即放行对话；
  // 账号心跳降级为可选的在线状态同步，不可达时不再拦主流程。
  // 两条并列合法路径：本地 license 命中 → 直接放行；未命中 → 走原账号会话门禁。
  // [G99] 本机授权判据（两个合法来源，不是兜底）：
  //   ① license.key 离线验签（Ed25519 + 指纹绑定）
  //   ② runtime_key.json —— /runtime_grant 下发后的落地凭证，email/expires_at/sku/ciphertext 齐全，
  //      它本身就是"已授权"的事实。此前只认 ①，于是走过账号下发（无 license.key）的机器每轮都退回
  //      服务端心跳：账号一没卡密/一到期就把对话拦死，哪怕本地 grant 是 free_forever 到 2100 年。
  const localLicenseGrant = (() => {
    try {
      const lic = require('./license_client');
      if (lic && typeof lic.localRuntimeGrant === 'function') {
        const g = lic.localRuntimeGrant();
        if (g && g.ok === true) return g;
      }
    } catch (_) {}
    try {
      const rk = require('./runtime_key_store').load();
      if (rk && rk.keyB64) {
        return { ok: true, tier: String(rk.sku || 'free_forever'), sku: String(rk.sku || ''),
                 expires_at: Number(rk.expires_at || 0), source: 'runtime-key' };
      }
    } catch (_) {}
    return null;
  })();
  if (localLicenseGrant) {
    shimLog({ stage: 'chat-gate', gate: 'local-license', tier: String(localLicenseGrant.tier || '-'), sid: job.conversationId });
  }
  if (!accountGateBypassed && !localLicenseGrant) {
    const acct = accountLoad();
    const kbOk = require('fs').existsSync(require('path').join(process.env.USERPROFILE || '', 'Desktop', '服务器知识库内容', '技能与知识库'));
    // [1.1.82] 本地 KB 缺失不硬拦：部署机经 bridge kbNet 回退服务器 /kb/read+/kb_search。
    if (!kbOk) shimLog({ stage: 'kb-remote-fallback', sid: job.conversationId });
    if (!acct || normalizeAccountEmail(acct.email) !== job.owner) { job.err = '使用需要账号授权：请先注册账号并激活卡密，或登录'; jobFinalize(job, false); return; }
    const hb = await accountPost('/session_heartbeat', { token: acct.token }, 8000).catch(() => null);
    if (finishSetupAbort()) return;
    const d = hb && hb.data;
    if (!d || !accountVerify(d) || !d.ok) {
      const why = d && !accountVerify(d) ? '账号响应验签失败' : d ? (d.status === 'offline' ? '该账号已在其他设备登录，本机已下线' : d.status === 'expired' ? '使用权限已到期，请联系管理员授权' : d.status === 'revoked' ? '账号已被停用' : '会话无效，请重新登录') : '授权服务器不可达';
      job.err = '账号校验未通过: ' + why; jobFinalize(job, false); return;
    }
    const liveAccount = accountLoad();
    if (!liveAccount || normalizeAccountEmail(liveAccount.email) !== job.owner || liveAccount.token !== acct.token) {
      job.err = '账号已切换，请在当前账号重新发送'; jobFinalize(job, true); return;
    }
  }
        if (finishSetupAbort()) return;
        const prov = activeProviderModels();                       // [客户端模型配置] 供应商优先
        const st = getSettings() || {};
        const selected = require('./model_selection').selectModel(prov, job.model, st);
        job.model = selected;
        shimLog({ stage: 'model-bound', sid: job.conversationId, provider: prov.name || '', model: null, protocol: prov.protocol || 'openai' });
        const apiKey = prov.key;
        if (!apiKey) { job.err = '未配置 API Key — 请按 Ctrl+M 打开「模型配置」或在设置中填写'; jobFinalize(job, false); return; }
        const ag = getAgent();
        const automation = await automationPromptContext(ag, job, ac.signal);
        if (finishSetupAbort()) return;
        const automationTools = await automationToolContext(ag, automation.settings);
        if (finishSetupAbort()) return;
        if (!accountGateBypassed && !localLicenseGrant && (currentAccountEmail() !== job.owner || job.accountLifecycleEpoch !== accountLifecycleEpoch)) throw new Error('账号已切换，请重新发送');
        commitHistoryEdit(job);
        // Delegate writes, not a persistence receipt: the loop can still fail
        // during async setup before writing either durable message identity.
        job.loopOwnsPersistence = true;
        job.loopActive = true;
        const r = await ag.runAgentLoop({
          prompt: (job.promptForAgent || job.prompt), apiKey, sid: job.conversationId, sessionOwner: job.owner,
          userMessageId: job.pid, responseMessageId: job.mid, parentMessageId: job.pidParent, skipPersistUser: job.skipPersistUser,
          ...automation.promptContext,
          ...automationTools,
          attachments: job.attachments || undefined,   // [1.1.35] 图片多模态送达
          baseURL: prov.url,
          model: null, models: [selected],
          protocol: prov.protocol || 'openai',
          signal: ac.signal,
          onDelta: (t) => jobChunk(job, t),
          onReasoning: (rz) => { try { jobReasoning(job, rz); } catch (_) {} },   // [1.1.31] 思维链不再丢弃
          onTool: (n, args, meta) => {
            const idx = job.toolCalls.length;
            const toolCallId = meta && meta.toolCallId ? String(meta.toolCallId) : ('call_' + job.conversationId + '_' + idx);
            const tc = { id: toolCallId, stepId: 'step_' + job.conversationId + '_' + idx, name: n, args: _clip(_asText(args), TOOL_ARG_LIMIT), output: '', progress: 1, done: false };
            job.toolCalls.push(tc);
            shimLog({ stage: 'tool', name: n, idx, toolCallId });
            try { emitToolStart(job, tc, idx); } catch (_) {}     // D1: 下发渲染层工具事件(工具卡开始)
          },
          onToolResult: (n, o, meta) => {
            const toolCallId = meta && meta.toolCallId ? String(meta.toolCallId) : '';
            let tc = toolCallId ? job.toolCalls.find((x) => x.id === toolCallId) : null;
            if (!tc) {   // 无对应起始(异常路径): 仍补一张完整卡片, 保证痕迹可见
              const idx = job.toolCalls.length;
              tc = { id: toolCallId || ('call_' + job.conversationId + '_' + idx), stepId: 'step_' + job.conversationId + '_' + idx, name: n, args: '', output: '', progress: 1, done: false };
              job.toolCalls.push(tc);
              try { emitToolStart(job, tc, idx); } catch (_) {}
            }
            tc.output = _clip(_asText(o), TOOL_OUT_LIMIT); tc.done = true;
            shimLog({ stage: 'tool-result', name: n, toolCallId: tc.id, len: String(o).length, truncated: !!(meta && meta.truncated) });
            try { emitToolDone(job, tc); } catch (_) {}          // D1: 下发渲染层工具事件(工具卡完成+输出)
          },
        });
        job.loopActive = false;
        // [A4] 终态文本 + finish 进 job: final 帧不再只靠流式 acc, 截断/中断必须带标记与状态位
        job.finish = job.preemptedBySteer && ac.signal.aborted ? 'interrupted_partial' : ((r && r.finish) || 'stop');
        job.finalText = (r && typeof r.text === 'string') ? r.text : null;
        job.finalReasoning = (r && typeof r.reasoning === 'string') ? r.reasoning : '';   // [1.1.31] 思维链终态
        shimLog({ stage: 'sse-done', sid: job.conversationId, rounds: r.rounds, finish: job.finish, textLen: job.finalText ? job.finalText.length : 0, accLen: job.acc.length });
        jobFinalize(job, ac.signal.aborted && !job.preemptedBySteer);
      } catch (e) {
        job.loopActive = false;
        if (ac.signal.aborted) {
          job.finish = job.preemptedBySteer ? 'interrupted_partial' : (job.finish || 'aborted');
          jobFinalize(job, !job.preemptedBySteer); return;
        }
        job.err = String((e && e.message) || e).slice(0, 300);
        job.finish = (e && e.finish) || 'error';   // [A4] 引擎分类(chain_exhausted/hard_error/…)带进终态
        jobFinalize(job, false);
      }
    })();
  }

  // ══════════ 客户端模型配置(本地存储 %APPDATA%/omnishade/models.json, 零服务器依赖) ══════════
  const MODELS_PATH = path.join(process.env.APPDATA || os.homedir(), 'omnishade', 'models.json');
  function modelsLoad() {
    try { const d = JSON.parse(fs.readFileSync(MODELS_PATH, 'utf8')); return { active: d.active || '', providers: Array.isArray(d.providers) ? d.providers : [] }; }
    catch (_) { return { active: '', providers: [] }; }
  }
  function modelsSave(d) {
    fs.mkdirSync(path.dirname(MODELS_PATH), { recursive: true });
    try { if (fs.existsSync(MODELS_PATH)) fs.copyFileSync(MODELS_PATH, MODELS_PATH + '.bak'); } catch (_) {}   // [1.1.28] 覆盖前自动备份, 防误丢配置
    fs.writeFileSync(MODELS_PATH, JSON.stringify(d, null, 1));
  }
  // 当前启用供应商(含模型清单) — 选择器/链路共用
  function activeProviderModels() {
    return require('./model_selection').activeProvider(modelsLoad());
  }
  // 模型选择器清单仅来自明确启用的供应商，不混入旧设置或占位模型。
  function providerModelList() {
    return require('./model_selection').providerModels(activeProviderModels());
  }
  // [CHAT-MODEL] /api/agents 的本地 agent ID 与发送链共用同一映射。
  // 前端选择本地智能体时只回传 agent_id，不一定回传 model；此前这里被丢弃，永远落到目录首模型。
  function localAgentId(provider, model) {
    return 'local-agent-' + crypto.createHash('sha256')
      .update(String(provider && provider.name || 'local') + '\0' + String(model)).digest('hex').slice(0, 16);
  }
  function modelForLocalAgent(provider, agentId) {
    const id = String(agentId || '');
    if (!provider || !id.startsWith('local-agent-')) return '';
    return require('./model_selection').providerModels(provider).find((model) => localAgentId(provider, model) === id) || '';
  }
  // 会话级模型(sid → model): convos 写/model 选择器切换时记录
  const sidModel = new Map();
  function readBody(req, res) {
    // JSON API body is capped at 8MiB and always settles with 413; multipart uploads use readRawBody's separate 64MiB limit.
    return new Promise((resolve) => {
      let b = ''; let over = false;
      const LIM = 8 * 1024 * 1024;
      req.on('data', (c) => {
        if (over) return;
        b += c;
        if (b.length > LIM) {
          over = true;
          try { if (res && !res.headersSent) { res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'payload too large', limit: LIM })); } } catch (_) {}
          resolve({ __tooLarge: true });
          try { req.pause(); req.resume(); } catch (_) {}   // 排空剩余, 不断连
        }
      });
      req.on('end', () => { if (over) return; try { const t = b.trim(); resolve(t ? JSON.parse(t) : {}); } catch (_) { resolve({ __badJson: true }); } });
      req.on('error', () => { if (!over) resolve({ __readError: true }); });
    });
  }
  async function handleModelConfig(req, res, json, p, readBody) {
    const d = modelsLoad();
    const notifyModels = () => { try { if (typeof o.onModelsChanged === 'function') o.onModelsChanged(); } catch (_) {} };
    if (p === '/api/omni-model/providers') {
      if (req.method !== 'GET') return json({ ok: false, error: '请使用 GET' }, 405);
      return json({ active: d.active, providers: d.providers.map((x) => ({ name: x.name, url: x.url, protocol: x.protocol || 'openai', models: x.models || [], key: x.key ? '********' : '' })), storage: 'models.json (本地保存, 不上传)' });
    }
    if (!['fetch', 'test', 'save', 'delete', 'activate'].some((action) => p === '/api/omni-model/' + action)) return json({ ok: false, error: 'not found' }, 404);
    if (req.method !== 'POST') return json({ ok: false, error: '请使用 POST' }, 405);
    // This route precedes the general API body parser: consume exactly once here.
    const body = await readBody(req, res);
    if (body && body.__tooLarge) return;
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.__badJson || body.__readError) return json({ ok: false, error: '请求正文必须是有效 JSON 对象' }, 400);
    const name = String(body.name || '').trim();
    const urlInput = String(body.url || '').trim();
    const url = urlInput.replace(/\/+$/, '');
    const protocol = body.protocol || 'openai';
    const validUrl = () => { try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; } catch (_) { return false; } };
    const exact = (x) => x && x.name === name && x.url === urlInput && (x.protocol || 'openai') === protocol;
    if (p.endsWith('/fetch') || p.endsWith('/test')) {
      if (!validUrl()) return json({ ok: false, error: 'API 地址需为 http(s):// 基础地址，不能包含账号、密码、查询或片段' }, 400);
      if (!['openai', 'anthropic'].includes(protocol)) return json({ ok: false, error: '不支持此 API 协议' }, 400);
      const saved = d.providers.find(exact);
      const typedKey = String(body.key || '').trim();
      if (typedKey === '********') return json({ ok: false, error: '请填写真实 Key，或留空复用完全匹配的已保存供应商' }, 400);
      const key = typedKey || (saved ? saved.key : '') || '';
      const sameName = d.providers.find((x) => x.name === name);
      if (!typedKey && !saved && sameName && sameName.key) return json({ ok: false, error: '地址或协议已更改，请重新输入 Key；不会向新地址发送已保存的 Key' }, 400);
      const secrets = [...d.providers.map((x) => x.key), key].filter(Boolean);
      const scrub = (value) => { let text = String(value || ''); for (const secret of secrets) text = text.split(secret).join('[已隐藏]'); return text; };
      const pulling = p.endsWith('/fetch');
      const model = String(body.model || '').trim();
      if (!pulling && !model) return json({ ok: false, error: '先选择/填写一个模型再测试' }, 400);
      const headers = protocol === 'anthropic'
        ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) }
        : (key ? { Authorization: 'Bearer ' + key } : {});
      const endpoint = url + (pulling ? '/models' : protocol === 'anthropic' ? '/messages' : '/chat/completions');
      const t0 = Date.now();
      try {
        const r = await fetch(endpoint, { method: pulling ? 'GET' : 'POST', headers: pulling ? headers : { ...headers, 'Content-Type': 'application/json' },
          body: pulling ? undefined : JSON.stringify({ model, messages: [{ role: 'user', content: '回复:OK' }], max_tokens: 8, stream: false }),
          redirect: 'error', signal: AbortSignal.timeout(pulling ? 20000 : 30000) });
        let j = null; try { j = await r.json(); } catch (_) {}
        if (!r.ok) return json({ ok: false, status: r.status, ms: Date.now() - t0, error: '上游返回 HTTP ' + r.status + (pulling && (r.status === 404 || r.status === 405) ? '，此接口不支持列出模型，请手动填写模型 ID' : '，请检查地址、协议、Key 和模型权限') });
        if (pulling) {
          if (!j || !Array.isArray(j.data)) return json({ ok: false, status: r.status, error: '上游未返回有效模型列表，请手动填写模型 ID' });
          const models = [...new Set(j.data.map((m) => m && m.id).filter((id) => typeof id === 'string' && id.trim()).map((id) => scrub(id.trim())))];
          return json({ ok: true, status: r.status, models, note: models.length ? '拉取到 ' + models.length + ' 个模型；保存后生效' : '接口返回空模型列表，可手动填写；现有输入未清空' });
        }
        const reply = protocol === 'anthropic'
          ? j && Array.isArray(j.content) && j.content.filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('')
          : j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        if (typeof reply !== 'string' || !reply.trim()) return json({ ok: false, status: r.status, ms: Date.now() - t0, error: 'HTTP 成功但未收到该协议的文本回复，不能确认模型可用' });
        return json({ ok: true, status: r.status, ms: Date.now() - t0, reply: scrub(reply).slice(0, 80), note: '模型已实际回复' });
      } catch (_) { return json({ ok: false, status: 0, ms: Date.now() - t0, error: '连接失败或超时；请检查 API 地址、网络和证书（不跟随重定向）' }); }
    }
    if (p.endsWith('/save')) {
      if (!name || name.length > 60 || !validUrl()) return json({ ok: false, error: '供应商名称（最多 60 字）与合法 API 基础地址必填' }, 400);
      if (!['openai', 'anthropic'].includes(protocol)) return json({ ok: false, error: '不支持此 API 协议' }, 400);
      const originalName = String(body.originalName || name).trim();
      const old = d.providers.find((x) => x.name === originalName);
      if (body.originalName && !old) return json({ ok: false, error: '原供应商不存在，请重新加载' }, 409);
      if (name !== originalName && d.providers.some((x) => x.name === name)) return json({ ok: false, error: '名称已存在，请换一个名称' }, 409);
      const typedKey = String(body.key || '').trim();
      if (typedKey === '********') return json({ ok: false, error: 'Key 不可使用掩码，请留空或重新填写' }, 400);
      // Renaming a provider is harmless; changing its destination/protocol requires fresh credentials.
      if (!typedKey && old && old.key && (old.url !== urlInput || (old.protocol || 'openai') !== protocol)) return json({ ok: false, error: '地址或协议已更改，请重新输入 Key 后保存' }, 400);
      const key = typedKey || (old ? old.key : '') || '';
      const models = Array.isArray(body.models) ? [...new Set(body.models.map((s) => String(s).trim()).filter(Boolean))].slice(0, 200) : [];
      const prov = { name, url, key, models, protocol, updatedAt: new Date().toISOString() };
      const providers = old ? d.providers.map((x) => x.name === originalName ? prov : x) : d.providers.concat([prov]);
      // Preserve the initial-provider default used by the desktop runtime; subsequent saves never switch providers.
      const active = !d.active ? name : d.active === originalName ? name : d.active;
      modelsSave({ active, providers });
      notifyModels();
      return json({ ok: true, active, message: '已保存 ' + name + '（' + models.length + ' 个模型）' + (active === name ? '，当前供应商模型列表已刷新' : '；尚未切换，点击「设为当前供应商」启用') });
    }
    const existing = d.providers.find((x) => x.name === name);
    if (!existing) return json({ ok: false, error: '供应商不存在' }, 404);
    if (p.endsWith('/delete')) {
      const providers = d.providers.filter((x) => x.name !== name);
      if (d.active === name && providers.length) return json({ ok: false, error: '请先显式启用其他供应商，再删除当前供应商；不会自动切换目标' }, 409);
      const active = d.active === name ? '' : d.active;
      modelsSave({ active, providers });
      notifyModels();
      return json({ ok: true, active, message: '已删除 ' + name + (d.active === name ? (active ? '；当前供应商已切换为 ' + active : '；当前无供应商') : '') });
    }
    modelsSave({ active: name, providers: d.providers });
    notifyModels();
    return json({ ok: true, active: name, message: name + ' 已设为当前供应商，主界面模型列表已刷新' });
  }

const MODEL_CFG_HTML = String.raw`<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>供应商与模型 · OmniShade</title>${AUX_THEME_SEED}<style>
/* G46 · 本页是 shim 独立托管的自绘文档，收不到 index.html 里 <style id="omni-craft"> 的令牌表，
   所以在页内声明与 omni-craft-system.css **完全同值**的工艺尺度（真源仍是那份文件，此处只做镜像）。 */
:root{
  --fs-1:11px;--lh-1:16px;--fs-2:12px;--lh-2:16px;--fs-3:13px;--lh-3:20px;
  --fs-4:14px;--lh-4:22px;--fs-5:16px;--lh-5:24px;--fs-6:20px;--lh-6:28px;
  --space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-5:24px;--space-6:32px;
  --dur-1:120ms;--dur-2:180ms;--dur-3:240ms;--dur-4:320ms;
  --ease-craft:cubic-bezier(0.22, 1, 0.36, 1);
}
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden}
body{font-family:"Segoe UI Variable","Segoe UI",system-ui,sans-serif;font-size:var(--fs-4);line-height:var(--lh-4);background:rgb(var(--surface-primary));color:rgb(var(--text-primary))}
a{color:rgb(var(--accent-primary));text-underline-offset:4px;transition:color var(--dur-2) var(--ease-craft)}
button,input,select,textarea{font:inherit;color:rgb(var(--text-primary));border:1px solid rgb(var(--border-medium));border-radius:8px;background:rgb(var(--surface-dialog))}
button{min-height:40px;padding:var(--space-2) var(--space-3);cursor:pointer;transition:background-color var(--dur-2) var(--ease-craft),border-color var(--dur-2) var(--ease-craft),color var(--dur-2) var(--ease-craft),box-shadow var(--dur-3) var(--ease-craft)}
button:hover:not(:disabled){background:rgb(var(--surface-hover));border-color:rgb(var(--border-heavy))}
button:active:not(:disabled){transition-duration:var(--dur-1)}
button:disabled{opacity:.55;cursor:not-allowed}
button.primary{border-color:rgb(var(--accent-primary));background:rgb(var(--accent-primary) / .12);color:rgb(var(--accent-primary));font-weight:650}
button.danger{margin-left:auto;border-color:rgb(var(--border-heavy))}
:is(button,a,input,select,textarea):focus-visible{outline:2px solid rgb(var(--ring-primary));outline-offset:3px}
.title-strip{height:44px;display:flex;align-items:center;gap:var(--space-2);padding:0 max(144px,calc(100vw - env(titlebar-area-width,100vw))) 0 var(--space-4);background:rgb(var(--header-primary));border-bottom:1px solid rgb(var(--border-light));-webkit-app-region:drag;user-select:none;white-space:nowrap;overflow:hidden}
.title-strip strong{letter-spacing:.08em;font-size:var(--fs-2);line-height:var(--lh-2)}
.title-strip span{color:rgb(var(--text-secondary));font-size:var(--fs-2);line-height:var(--lh-2)}
.title-strip :is(a,button){-webkit-app-region:no-drag}
main{height:calc(100dvh - 44px);overflow:auto;padding:var(--space-5);scrollbar-color:rgb(var(--border-heavy)) rgb(var(--surface-primary))}
.page{max-width:1160px;margin:auto}
.nav,.heading,.panel-heading,.actions{display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap}
.nav{justify-content:space-between;margin-bottom:var(--space-5);font-size:var(--fs-3);line-height:var(--lh-3)}
.heading{justify-content:space-between;margin-bottom:var(--space-5);align-items:flex-start}
h1{font-size:var(--fs-6);line-height:var(--lh-6);letter-spacing:-.02em;margin:0 0 var(--space-2)}
h2{font-size:var(--fs-4);line-height:var(--lh-4);margin:0}
.eyebrow{font-size:var(--fs-1);line-height:var(--lh-1);letter-spacing:.14em;color:rgb(var(--accent-primary));font-weight:700}
.sub,.hint,.meta{color:rgb(var(--text-secondary));font-size:var(--fs-2);line-height:var(--lh-2)}
.sub{margin:0;max-width:590px}
/* [G52-F4] 空态降噪：默认（未配置 / 读取中）走中性边，只有真的挂上当前供应商才点亮 accent。
   状态由 render() 写的 data-state 驱动（presentational 钩子，不新增节点、不动结构）。
   原来无条件 accent/.55 描边 —— 空的卡片却是全页最亮的一圈青，抢焦点。 */
.current{padding:var(--space-2) var(--space-4);border:1px solid rgb(var(--border-light));border-radius:10px;background:rgb(var(--surface-secondary));min-width:180px;max-width:100%;overflow-wrap:anywhere;transition:background-color var(--dur-3) var(--ease-craft),border-color var(--dur-3) var(--ease-craft)}
.current[data-state=ready]{border-color:rgb(var(--accent-primary) / .55)}
.current span{display:block;font-size:var(--fs-1);line-height:var(--lh-1);color:rgb(var(--text-secondary))}
/* 未配置态：灰边 + --text-muted 字 + 650 字重（不是 <strong> 默认的 700），彻底退出第一眼；
   ready 才 accent 边 + accent 字 + 同一字号，两级一起点亮。muted 在 surface-secondary 上 4.73:1，AA 过。 */
.current strong{color:rgb(var(--text-muted));font-size:var(--fs-5);line-height:var(--lh-5);font-weight:650}
.current[data-state=ready] strong{color:rgb(var(--accent-primary))}
/* [G52-F2] 两栏 gap 16 → 24（--space-5）：16 与卡内字段间距同值，栏缝读成卡内留白；
   24 = 卡内 padding（--space-4=16）之上再进一格，栏缝 > 卡内距，分区才立得住。 */
.workspace{display:grid;grid-template-columns:248px minmax(0,1fr);gap:var(--space-5);align-items:start}
.panel{border:1px solid rgb(var(--border-light));border-radius:12px;background:rgb(var(--surface-secondary));min-width:0;transition:border-color var(--dur-3) var(--ease-craft)}
.panel-heading{justify-content:space-between;padding:var(--space-4);border-bottom:1px solid rgb(var(--border-light))}
.panel-heading .hint{margin:var(--space-1) 0 0}
.list{padding:var(--space-2);display:grid;gap:var(--space-2);max-height:58dvh;overflow:auto}
.provider{display:block;width:100%;text-align:left;padding:var(--space-3);background:rgb(var(--surface-primary-alt));overflow-wrap:anywhere;transition:background-color var(--dur-2) var(--ease-craft),border-color var(--dur-2) var(--ease-craft),box-shadow var(--dur-2) var(--ease-craft)}
.provider:hover{background:rgb(var(--surface-hover));border-color:rgb(var(--border-heavy))}
.provider[aria-pressed=true]{border-color:rgb(var(--ring-primary));background:rgb(var(--surface-hover))}
.provider.current-provider{box-shadow:inset 3px 0 0 rgb(var(--accent-primary))}
.provider .name{display:block;font-weight:650}
.provider .meta{display:block;margin-top:var(--space-1);word-break:break-all}
.badge{display:inline-block;border:1px solid rgb(var(--border-medium));border-radius:5px;font-size:var(--fs-1);line-height:var(--lh-1);padding:0 var(--space-1);margin-top:var(--space-1);color:rgb(var(--accent-primary))}
.empty{padding:var(--space-4) var(--space-2);margin:0;font-size:var(--fs-3);line-height:var(--lh-3);color:rgb(var(--text-secondary))}
.aside-note{padding:var(--space-1) var(--space-4) var(--space-4);margin:0;font-size:var(--fs-1);line-height:var(--lh-1);color:rgb(var(--text-muted))}
.editor{padding:var(--space-4)}
.fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(150px,.7fr);gap:var(--space-4)}
.full{grid-column:1/-1}
/* [G52-F1] 层级靠「字号 4px + 字重 650 vs 400」撑：标签 12px 已是 --fs-2（元信息档），
   不再往下压到 11px（那会与 .eyebrow/.badge 角标同级，字段名降级成角标）；
   真正拉开的是正文 —— 见下面 input,select,textarea 抬到 --fs-5。 */
label{display:block;color:rgb(var(--text-secondary));font-size:var(--fs-2);line-height:var(--lh-2);font-weight:650;margin-bottom:var(--space-2)}
/* [G52-F1] 输入正文 14 → 16（--fs-5）：12px 标签 vs 16px 正文 = 4px 级差 / 1.33 倍，
   不再与正文基准同级（原来 12:14 只差 2px，且空态占位符用 --text-muted 比标签还暗，层级倒挂）。 */
input,select,textarea{display:block;width:100%;padding:var(--space-2) var(--space-3);min-height:40px;font-size:var(--fs-5);line-height:var(--lh-5);transition:border-color var(--dur-3) var(--ease-craft),box-shadow var(--dur-3) var(--ease-craft),background-color var(--dur-3) var(--ease-craft)}
input:focus,select:focus,textarea:focus{border-color:rgb(var(--ring-primary));box-shadow:0 0 0 3px rgb(var(--ring-primary) / .18)}
input::placeholder,textarea::placeholder{color:rgb(var(--text-muted))}
/* [G52-F1] 等宽正文单独一档：Consolas 同字号视觉比系统 sans 大一档，所以不跟 input 一起抬到 16，
   只从 13 抬到 14（--fs-4）与正文同档，行高成对 --lh-4。 */
textarea{resize:vertical;min-height:120px;line-height:var(--lh-4);font-family:Consolas,ui-monospace,monospace;font-size:var(--fs-4)}
/* [G52-F1b] 帮助文本压到 --text-muted 一档：原来 .hint 与 label 同色同号（都 12/secondary），
   标签和说明在视觉上是同一层，字段名认不出来。三档分明 = 标签 12/650/secondary > 说明 12/muted。
   #edit-state 是状态句，末尾另有规则把它拉回 secondary，不受这刀影响。 */
.hint{margin:var(--space-1) 0 0;color:rgb(var(--text-muted));overflow-wrap:anywhere}
.actions{padding-top:var(--space-4);margin-top:var(--space-4);border-top:1px solid rgb(var(--border-light));gap:var(--space-2)}
#msg{min-height:24px;padding:var(--space-2) var(--space-3);border:1px solid rgb(var(--border-light));border-radius:8px;margin:var(--space-4) 0 0;background:rgb(var(--surface-primary-alt));font-size:var(--fs-2);line-height:var(--lh-2);white-space:pre-wrap;overflow-wrap:anywhere;transition:color var(--dur-3) var(--ease-craft),border-color var(--dur-3) var(--ease-craft),background-color var(--dur-3) var(--ease-craft)}
#msg[data-state=success]{color:rgb(var(--accent-primary));border-color:rgb(var(--accent-primary) / .5)}
#msg[data-state=error]{border-color:rgb(var(--border-heavy));color:rgb(var(--text-primary));border-left:3px solid rgb(var(--text-secondary))}
#edit-state{color:rgb(var(--text-secondary))}
@media(max-width:760px){main{padding:var(--space-4)}.workspace{grid-template-columns:1fr}.list{max-height:200px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}.heading{gap:var(--space-4)}.current{width:100%}.fields{grid-template-columns:1fr}.full{grid-column:auto}.actions .danger{margin-left:0}.title-strip span{display:none}}
@media(forced-colors:active){.provider.current-provider{border-width:2px}button.primary{font-weight:750}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto;transition-duration:0s}}
</style></head><body data-omni-theme="aux">
<header class="title-strip" data-omni-aux-chrome><strong>OMNISHADE</strong><span>供应商与模型</span></header>
<main><div class="page"><nav class="nav"><a href="/">← 返回对话</a><a href="/omni-register">账号与授权 →</a></nav>
<div class="heading"><div><div class="eyebrow">MODEL CONNECTIONS</div><h1>供应商与模型</h1><p class="sub">管理本机模型接入。选择列表项只会编辑；保存配置后，使用「设为当前供应商」明确切换。</p></div><div class="current"><span>当前供应商</span><strong id="current-name">读取中…</strong></div></div>
<div class="workspace"><aside class="panel" aria-label="已保存的供应商"><div class="panel-heading"><h2>供应商 <span id="count" class="meta"></span></h2><button id="new" type="button">＋ 新增</button></div><div id="list" class="list"><p class="empty">正在读取本机配置…</p></div><p class="aside-note">配置保存在本机。Key 不回显；只有拉取和测试会访问填写的供应商。</p></aside>
<section class="panel" aria-label="供应商编辑"><div class="panel-heading"><div><h2 id="editor-title">新增供应商</h2><p id="edit-state" class="hint">填写接入信息后保存</p></div><button id="activate" class="primary" type="button" disabled>设为当前供应商</button></div>
<div id="editor" class="editor"><div class="fields"><div><label for="n">供应商名称</label><input id="n" maxlength="60" autocomplete="off" placeholder="例如：团队 API / 本机模型"></div><div><label for="protocol">API 协议</label><select id="protocol"><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic Messages</option></select></div>
<div class="full"><label for="u">API 基础地址</label><input id="u" type="url" autocomplete="off" spellcheck="false" placeholder="https://api.example.com/v1" aria-describedby="protocol-help"><p id="protocol-help" class="hint"></p></div>
<div class="full"><label for="k">API Key <span id="key-state" class="meta"></span></label><input id="k" type="password" autocomplete="new-password" spellcheck="false" aria-describedby="key-help"><p id="key-help" class="hint">编辑时留空保留 Key。拉取/测试仅在名称、地址、协议完全匹配时复用；更改地址或协议需重新填写。</p></div>
<div class="full"><label for="m">模型列表 · 每行一个模型 ID</label><textarea id="m" rows="5" spellcheck="false" placeholder="model-one&#10;model-two" aria-describedby="models-help"></textarea><p id="models-help" class="hint">拉取会更新草稿，保存后生效。测试会向第一行模型发送一条短请求，可能产生供应商用量。</p></div></div>
<div class="actions"><button id="save" class="primary" type="button">保存配置</button><button id="fetch" type="button">拉取模型</button><button id="test" type="button">测试连接</button><button id="delete" class="danger" type="button" disabled>删除供应商</button></div>
<p id="msg" role="status" aria-live="polite" data-state="idle">正在读取配置…</p></div></section></div></div></main>
<script>
'use strict';
const $=id=>document.getElementById(id);let providers=[],active='',selected=null,busy=false,loaded=false;
const modelLines=()=>[...new Set($('m').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean))];
const draft=()=>({name:$('n').value.trim(),url:$('u').value.trim(),key:$('k').value.trim(),protocol:$('protocol').value,models:modelLines()});
function dirty(){const d=draft();return selected?!!d.key||d.name!==selected.name||d.url!==selected.url||d.protocol!==(selected.protocol||'openai')||JSON.stringify(d.models)!==JSON.stringify(selected.models||[]):!!(d.name||d.url||d.key||d.models.length)}
function msg(text,state){$('msg').textContent=text||'';$('msg').dataset.state=state||'idle';$('msg').setAttribute('role',state==='error'?'alert':'status')}
function controls(){for(const el of document.querySelectorAll('button,input,textarea,select'))el.disabled=busy;for(const id of ['new','save','fetch','test'])$(id).disabled=busy||!loaded;$('activate').disabled=busy||!selected||selected.name===active||dirty();$('delete').disabled=busy||!selected;$('activate').textContent=selected&&selected.name===active?'当前供应商':'设为当前供应商';$('edit-state').textContent=dirty()?'有未保存的更改 · 保存后才能切换':selected?(selected.name===active?'正在使用此供应商':'已保存 · 可设为当前供应商'):'填写接入信息后保存';$('editor').setAttribute('aria-busy',String(busy));$('protocol-help').textContent=$('protocol').value==='anthropic'?'使用 /messages + x-api-key；请包含 /v1。拉取使用 /models，不支持时可手动填写。':'使用 /chat/completions + Bearer Key；请包含供应商要求的 /v1 等前缀。'}
function choose(p){selected=p||null;$('n').value=p?p.name:'';$('u').value=p?p.url:'';$('k').value='';$('m').value=p?(p.models||[]).join('\n'):'';$('protocol').value=p?(p.protocol||'openai'):'openai';$('key-state').textContent=p&&p.key?'· 已保存（不回显）':'· 未保存 / 可选';$('editor-title').textContent=p?'编辑 · '+p.name:'新增供应商';render();controls()}
function render(){const list=$('list');list.replaceChildren();$('current-name').textContent=active||'尚未配置';const cur=document.querySelector('.current');if(cur)cur.dataset.state=active?'ready':'empty';$('count').textContent=String(providers.length);if(!providers.length){const e=document.createElement('p');e.className='empty';e.textContent='暂无供应商。填写右侧表单并保存，第一个供应商将作为初始接入。';list.appendChild(e)}for(const p of providers){const b=document.createElement('button');b.type='button';b.className='provider'+(p.name===active?' current-provider':'');b.setAttribute('aria-pressed',String(!!selected&&selected.name===p.name));b.setAttribute('aria-label','编辑供应商 '+p.name);const n=document.createElement('span');n.className='name';n.textContent=p.name;const meta=document.createElement('span');meta.className='meta';meta.textContent=p.url;const badge=document.createElement('span');badge.className='badge';badge.textContent=(p.name===active?'当前供应商 · ':'')+(p.protocol==='anthropic'?'Anthropic':'OpenAI')+' · '+(p.models||[]).length+' 个模型';b.append(n,meta,badge);b.onclick=()=>{if(dirty()&&!confirm('放弃未保存的更改？'))return;choose(p);msg('正在编辑 '+p.name+'；选择不会切换当前供应商。')};list.appendChild(b)}}
async function api(path,body){let r;try{r=await fetch('/api/omni-model'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined})}catch(_){throw new Error('本机配置服务连接失败，请重试')}let d;try{d=await r.json()}catch(_){throw new Error('配置服务返回无效响应')}if(!r.ok||d.ok===false)throw new Error(d.error||('请求失败 HTTP '+r.status));return d}
async function load(name){const d=await api('/providers');if(!Array.isArray(d.providers))throw new Error('供应商列表格式无效');providers=d.providers;active=d.active||'';loaded=true;choose(providers.find(p=>p.name===name)||providers.find(p=>p.name===active)||null)}
async function run(label,action){if(busy)return;busy=true;controls();msg(label,'pending');try{await action()}catch(e){msg('操作失败：'+e.message,'error')}finally{busy=false;controls()}}
$('new').onclick=()=>{if(dirty()&&!confirm('放弃未保存的更改？'))return;choose(null);msg('新增供应商：保存不会切换已存在的当前供应商。');$('n').focus()};
for(const id of ['n','u','k','m','protocol']){$(id).addEventListener('input',controls);$(id).addEventListener('change',controls)}
$('save').onclick=()=>run('正在保存配置…',async()=>{const d=draft();if(!selected&&providers.some(p=>p.name===d.name))throw new Error('同名供应商已存在，请从左侧选择后编辑');const result=await api('/save',{...d,originalName:selected?selected.name:undefined});$('k').value='';await load(d.name);msg(result.message,'success')});
$('activate').onclick=()=>run('正在切换当前供应商…',async()=>{if(!selected||dirty())throw new Error('请先保存配置');const name=selected.name;const result=await api('/activate',{name});await load(name);if(active!==name)throw new Error('供应商切换尚未确认，请重试');msg(result.message,'success')});
$('fetch').onclick=()=>run('正在拉取模型…',async()=>{const d=await api('/fetch',draft());if(!Array.isArray(d.models))throw new Error('上游未返回模型列表');if(d.models.length)$('m').value=d.models.join('\n');msg(d.note||'拉取完成；保存后生效',d.models.length?'success':'empty')});
$('test').onclick=()=>run('正在测试连接（请求第一行模型）…',async()=>{const d=draft();if(!d.models.length)throw new Error('请先填写至少一个模型 ID');const r=await api('/test',{...d,model:d.models[0]});msg('连接成功 · '+r.ms+' ms · '+d.models[0]+'\n模型回复：'+r.reply,'success')});
$('delete').onclick=()=>{if(!selected)return;const name=selected.name;if(!confirm('删除供应商「'+name+'」？'+(name===active?(providers.length>1?'请先显式启用其他供应商，否则不会删除或自动切换。':'删除后将没有当前供应商。'):'')+(dirty()?'未保存的更改也会丢弃。':'')))return;return run('正在删除供应商…',async()=>{const r=await api('/delete',{name});await load();if(providers.some(p=>p.name===name))throw new Error('删除尚未确认，请重试');msg(r.message,'success')})};
window.addEventListener('beforeunload',e=>{if(dirty()||busy){e.preventDefault();e.returnValue=''}});
function boot(){return run('正在读取配置…',async()=>{try{await load();msg(providers.length?'选择左侧供应商编辑，或新增接入。保存与切换是两个独立操作。':'暂无供应商，请填写接入信息。','idle')}catch(e){loaded=false;$('current-name').textContent='读取失败';const retry=document.createElement('button');retry.type='button';retry.textContent='读取失败 · 重试';retry.onclick=boot;$('list').replaceChildren(retry);throw e}})}
boot();
</script></body></html>`;

  // ══════════ [1.1.30] 文件上传(本地落盘, 对齐 fork 期望: file_id/filename/filepath/type/source/embedded) ══════════
  const UPLOAD_DIR = path.join(process.env.APPDATA || os.homedir(), 'omnishade', 'uploads');
  // Attachment metadata is indexed in a worker. Rewalking every upload directory on every
  // preview/download/usage call made large histories visibly freeze the local UI shim.
  const UPLOAD_INDEX_TTL_MS = 2500;
  let uploadIndexCache = null;
  let uploadIndexAt = 0;
  let uploadIndexDirty = 0;
  let uploadIndexCacheDirty = -1;
  let uploadIndexInFlight = null;
  function invalidateUploadIndex() { uploadIndexDirty++; uploadIndexAt = 0; }
  function uploadIndex() {
    if (uploadIndexCache && uploadIndexCacheDirty === uploadIndexDirty && Date.now() - uploadIndexAt < UPLOAD_INDEX_TTL_MS) return Promise.resolve(uploadIndexCache);
    if (uploadIndexInFlight) return uploadIndexInFlight;
    uploadIndexInFlight = new Promise((resolve, reject) => {
      const { Worker } = require('worker_threads');
      const worker = new Worker(path.join(__dirname, 'upload_index_worker.js'), { workerData: { uploadDir: UPLOAD_DIR, maxFiles: 50000 } });
      let settled = false;
      const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
      const timer = setTimeout(() => { try { worker.terminate(); } catch (_) {} finish(reject, new Error('upload index timeout')); }, 20000);
      worker.on('message', (m) => {
        if (!m || !m.ok || !m.index || !Array.isArray(m.index.entries)) return finish(reject, new Error(String((m && m.error) || 'upload index failed').slice(0, 300)));
        uploadIndexCache = m.index; uploadIndexAt = Date.now(); uploadIndexCacheDirty = uploadIndexDirty; finish(resolve, uploadIndexCache);
      });
      worker.on('error', (e) => finish(reject, e));
      worker.on('exit', (code) => { if (!settled) finish(reject, new Error('upload index worker exited ' + code)); });
    });
    return uploadIndexInFlight.finally(() => { uploadIndexInFlight = null; });
  }
  async function findUpload(fid) {
    const f = String(fid).replace(/[^A-Za-z0-9_.-]/g, '');
    if (!f) return null;
    const idx = await uploadIndex();
    const hit = idx.entries.find((x) => x.file_id === f);
    return hit ? hit.filepath : null;
  }
  async function listUploads() {
    const idx = await uploadIndex();
    return idx.entries.slice(0, 200);
  }
  function readRawBody(req, limitBytes) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => { if (size > limitBytes) return; size += c.length; if (size > limitBytes) { chunks.length = 0; reject(new Error('payload too large')); return; } chunks.push(c); });   // [1.1.30] 不 destroy: 交给上层回 413 后自然排空
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  function stageRawBody(req, limitBytes) {
    return new Promise((resolve, reject) => {
      const declared = parseInt(req.headers['content-length'] || '0', 10) || 0;
      if (declared > limitBytes) { const e = new Error('payload too large'); e.code = 'ETOOLARGE'; req.resume(); return reject(e); }
      const stageDir = path.join(process.env.APPDATA || os.homedir(), 'omnishade', '.staging');
      fs.mkdirSync(stageDir, { recursive: true });
      const temp = path.join(stageDir, 'multipart-' + process.pid + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.bin');
      const out = fs.createWriteStream(temp, { flags: 'wx' });
      let total = 0, settled = false;
      const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
      const cleanup = () => { try { out.destroy(); } catch (_) {} try { fs.rmSync(temp, { force: true }); } catch (_) {} };
      req.on('data', (chunk) => {
        total += chunk.length;
        if (total > limitBytes) { const e = new Error('payload too large'); e.code = 'ETOOLARGE'; try { req.resume(); } catch (_) {}; cleanup(); return finish(reject, e); }
        if (!out.write(chunk)) req.pause();
      });
      out.on('drain', () => { try { req.resume(); } catch (_) {} });
      req.on('aborted', () => { const e = new Error('request aborted'); e.code = 'EABORT'; cleanup(); finish(reject, e); });
      req.on('error', (e) => { cleanup(); finish(reject, e); });
      req.on('end', () => out.end());
      out.on('error', (e) => { cleanup(); finish(reject, e); });
      out.on('finish', () => finish(resolve, { path: temp, bytes: total }));
    });
  }
  function runMultipartWorker(workerData) {
    return new Promise((resolve, reject) => {
      const { Worker } = require('worker_threads');
      const worker = new Worker(path.join(__dirname, 'multipart_extract_worker.js'), { workerData });
      let settled = false;
      const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
      const timer = setTimeout(() => { try { worker.terminate(); } catch (_) {} finish(reject, new Error('multipart worker timeout')); }, 30000);
      worker.on('message', (m) => {
        if (m && m.ok) return finish(resolve, m.result);
        finish(reject, new Error(String((m && m.error) || 'multipart worker failed').slice(0, 500)));
      });
      worker.on('error', (e) => finish(reject, e));
      worker.on('exit', (code) => { if (!settled) finish(reject, new Error('multipart worker exited ' + code)); });
    });
  }
  function parseMultipart(buf, boundary) {
    const out = { fields: {}, file: null };
    const bdelim = Buffer.from('--' + boundary);
    let pos = buf.indexOf(bdelim);
    if (pos < 0) throw new Error('bad multipart boundary');
    pos += bdelim.length;
    while (pos < buf.length) {
      if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) pos += 2;
      if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break;   // closing --
      const headEnd = buf.indexOf('\r\n\r\n', pos);
      if (headEnd < 0) break;
      const header = buf.slice(pos, headEnd).toString('utf8');
      const bodyStart = headEnd + 4;
      const next = buf.indexOf(bdelim, bodyStart);
      if (next < 0) break;
      let bodyEnd = next;
      if (bodyEnd >= 2 && buf[bodyEnd - 2] === 0x0d && buf[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
      const chunk = buf.slice(bodyStart, bodyEnd);
      const nameM = /name="([^"]*)"/i.exec(header);
      const fileM = /filename="([^"]*)"/i.exec(header);
      const ctype = /Content-Type:\s*([^\r\n]+)/i.exec(header);
      if (nameM) {
        if (fileM) {
          let fn = fileM[1]; try { fn = decodeURIComponent(fn); } catch (_) {}
          out.file = { field: nameM[1], filename: fn, contentType: ctype ? ctype[1].trim() : 'application/octet-stream', data: chunk };
        } else out.fields[nameM[1]] = chunk.toString('utf8');
      }
      pos = next + bdelim.length;
    }
    return out;
  }
  async function handleFileUpload(req, res, json) {
    const ct = String(req.headers['content-type'] || '');
    const mm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
    if (!mm) return json({ message: '缺少 multipart boundary' }, 400);
    let staged = null;
    try {
      staged = await stageRawBody(req, 64 * 1024 * 1024);
      const r = await runMultipartWorker({ mode: 'upload', rawPath: staged.path, boundary: (mm[1] || mm[2]).trim(), uploadDir: UPLOAD_DIR });
      invalidateUploadIndex();
      const ext = path.extname(r.filename || '').toLowerCase();
      const out = {
        file_id: r.file_id, temp_file_id: r.temp_file_id, filename: r.filename, filepath: r.filepath,
        type: r.type || MIME[ext] || 'application/octet-stream', bytes: r.bytes, embedded: false, source: 'local',
        llmDeliveryPath: 'provider', conversationId: r.conversationId,
        message: '文件已保存到本机: ' + r.filepath,
      };
      if (r.height) out.height = r.height;
      if (r.width) out.width = r.width;
      shimLog({ stage: 'file-upload', fid: r.file_id, cid: r.conversationId, name: r.filename, bytes: r.bytes, type: out.type });
      return json(out);
    } finally {
      if (staged && staged.path) { try { await fs.promises.rm(staged.path, { force: true }); } catch (_) {} }
    }
  }
  // [1.1.32] A6 导入会话: multipart file = LibreChat 导出 JSON(数组: {title, messages:[{isCreatedByUser,text,sender}]})
  async function handleConvoImport(req, res, json, owner) {
    const ct = String(req.headers['content-type'] || '');
    const mm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
    if (!mm) return json({ message: '缺少 multipart boundary' }, 400);
    const ownerId = normalizeAccountEmail(owner);
    const dir = sessionsDir(ownerId);
    if (!ownerId || !dir) return json({ error: 'unauthorized' }, 401);
    let staged = null;
    try {
      staged = await stageRawBody(req, 64 * 1024 * 1024);
      const r = await runMultipartWorker({ mode: 'import', rawPath: staged.path, boundary: (mm[1] || mm[2]).trim(), sessionsDir: dir, maxConvos: 200 });
      for (const item of (r.imported || [])) if (item && item.title) loadTitles(ownerId)[item.sid] = item.title;
      if (r.imported && r.imported.length) { saveTitles(ownerId); SESSION_DIRTY_GENERATION++; invalidateSessionIndex(ownerId); }
      shimLog({ stage: 'convos-import', imported: (r.imported || []).length, fileBytes: r.fileBytes || 0 });
      return json({ message: 'ok', imported: (r.imported || []).length });
    } finally {
      if (staged && staged.path) { try { await fs.promises.rm(staged.path, { force: true }); } catch (_) {} }
    }
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;
    let status = 200;
    const json = (obj, code, headers) => {
      try { if (res.headersSent || res.writableEnded) return; } catch (_) {}
      status = code || 200;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(headers || {}) });
      res.end(JSON.stringify(obj));
    };
    // H1: sid 白名单拒绝(读/写共用)
    const rejectSid = (sid) => {
      shimLog({ stage: 'sid-reject', sid: String(sid).slice(0, 80) });
      return json({ error: 'invalid conversation id' }, 400);
    };
    // Freeze identity at request entry. Never re-read account.json after an await to choose
    // a session namespace; login switches in the same process must not cross-label requests.
    // [G7-R1] 未登录 → 本机默认命名空间(local); 目录解析已按 owner 分流, 无账号只能看到本机命名空间。
    const requestOwner = currentAccountEmail() || LOCAL_OWNER_ID;
    const modelKey = (sid) => (accountScopeKey(requestOwner) || '') + ':' + sid;

    try {
      // ── H1 边界门: Host / Origin 必须指向本机(在任何路由之前) ──
      if (!hostOk(req)) { shimLog({ stage: 'host-reject', host: String(req.headers.host || '').slice(0, 80), url: String(req.url).slice(0, 120) }); return json({ error: 'forbidden host' }, 403); }
      if (!originOk(req)) { shimLog({ stage: 'origin-reject', origin: String(req.headers.origin || '').slice(0, 80), url: String(req.url).slice(0, 120) }); return json({ error: 'forbidden origin' }, 403); }

      // ── 静态 ──
      if (p === '/health') return json({ status: 'ok', shim: 'omnishade-local' });

      // ── [1.1.29] About页「检查更新」按钮的数据端点(同源 /omni-version → 上游更新链) ──
      if (p === '/omni-version') {
        try {
          const { net } = require('electron');
          const up = await new Promise((resolve) => {
            const req = net.request('https://103.117.136.137:9445/version');
            req.on('response', (resp) => {
              let b = '';
              resp.on('data', (c) => { b += c.toString(); });
              resp.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
            });
            req.on('error', () => resolve(null));
            req.end();
          });
          if (!up) return json({ error: 'upstream unreachable' }, 502);
          return json({ version: up.version, url: up.url, sha256: up.sha256 });
        } catch (e) { return json({ error: String(e && e.message || e).slice(0, 120) }, 502); }
      }

      // ── 客户端模型配置(本地页面, 不依赖服务器) ──
      if (p === '/omni-model') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(injectBootstrap(MODEL_CFG_HTML, TOKEN));
      }
      if (p === '/omni-automation') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(injectBootstrap(automationPageHtml(AUX_THEME_SEED), TOKEN));
      }

      // ── 注册账号页面(同源 /api/omni-register/*, 见 handleRegister) ──
      if (p === '/register') {   // [1.1.71] fork 原生 Sign up 链接 → 注册页
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(injectBootstrap(registerPageHtml(), TOKEN));
      }
      if (p === '/omni-register') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(injectBootstrap(registerPageHtml(), TOKEN));
      }

      // ── H1 鉴权: 除静态资产外, 一切 /api/* 必须带本机随机 token; [1.1.61] auth/refresh+login 豁免(重新认证路径必须可达, 否则旧 token 死锁) ──
      if (p.startsWith('/api/') && !authOk(req) && p !== '/api/auth/refresh' && p !== '/api/auth/login') {
        shimLog({ stage: 'auth-reject', method: req.method, url: String(req.url).slice(0, 120), hasAuth: !!req.headers['authorization'] });
        return json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
      }

      if (p.startsWith('/api/omni-model')) {
        try { return await handleModelConfig(req, res, json, p, readBody); }
        catch (e) { return json({ ok: false, error: String(e && e.message || e).slice(0, 160) }, 500); }
      }

      // [LOOT-INT 2026-11-07] lootchain 攻击链执行层（鉴权门内，同 omni-model 模式）
      if (p.startsWith('/api/lootchain/')) {
        try { return await handleLootchain(req, res, json, p, readBody); }
        catch (e) { return json({ ok: false, error: String(e && e.message || e).slice(0, 160) }, 500); }
      }

      // [WEAPON-INT 2026-11-08] 统一武器线执行层（鉴权门内，同 lootchain 模式）
      if (p.startsWith('/api/weapons/')) {
        try { return await handleWeapons(req, res, json, p, readBody); }
        catch (e) { return json({ ok: false, error: String(e && e.message || e).slice(0, 160) }, 500); }
      }

      // 授权面板回环数据面：与 preload 的 omni:license-status 同源（同一个 licenseStatus()），
      // 让「没有 preload / 直接在浏览器打开面板」的场景也能读到授权状态与套餐配额，
      // 不再只能显示 no-api。函数由 main.js 注入，未注入时明确回 503，不伪造空状态。
      if (p === '/api/omni-license/status' && (req.method === 'GET' || req.method === 'POST')) {
        try {
          const fn = o.licenseStatus;
          if (typeof fn !== 'function') {
            return json({ available: false, ok: false, valid: false, state: 'error', reason: 'no-api' }, 503);
          }
          return json(fn());
        } catch (e) {
          return json({ available: false, ok: false, valid: false, state: 'error', reason: 'read-error',
                        error: String(e && e.message || e).slice(0, 160) }, 500);
        }
      }

      // ── 注册账号同源端点: 状态查询、注册、登录与会话验证 ──
      if (p.startsWith('/api/omni-register') || p.startsWith('/api/omni-account')) {   // [1.1.66] 账号端点接入分发
        try { return await handleRegister(req, res, json, p, readBody, o.onAccountAuthenticated, o.onAccountInvalidated, accountPost, accountVerify, o.onAccountSaved, invalidateAccountJobs); }
        catch (e) { return json({ ok: false, error: String(e && e.message || e).slice(0, 160) }, 500); }
      }

      const accountOwnedApi = p === '/api/convos' || p.startsWith('/api/convos/') || p.startsWith('/api/messages/')
        || p.startsWith('/api/agents/chat') || p === '/api/search' || p.startsWith('/api/projects')
        || p.startsWith('/api/tags') || p.startsWith('/api/presets') || p.startsWith('/api/memories')
        || p.startsWith('/api/omni-automation') || p === '/api/agents/tools/calls';
      if (accountOwnedApi && !requestOwner) return json({ error: 'unauthorized' }, 401);

      // [付费硬闸] 没充钱就是不能用——不是面板显示一下就算数。
      // 聊天与工具调用必须持有有效套餐（runtime grant 未过期），否则直接 403。
      // licenseStatus() 已由 main.js 注入；attachPlan 里账号套餐有效会把 state 置为 active。
      const paidGateApi = p.startsWith('/api/agents/chat') || p.startsWith('/api/agents/tools/calls');
      if (paidGateApi && typeof o.licenseStatus === 'function') {
        try {
          const lst = o.licenseStatus() || {};
          const planOk = lst.state === 'active' && lst.plan && Number(lst.plan.expiresAt || 0) > Math.floor(Date.now() / 1000);
          const localOk = lst.valid === true;   // 本地 license.key 离线授权通道也算有效
          if (!planOk && !localOk) {
            return json({ error: 'no-license', message: '该账号尚未获得授权（新注册自动开通永久授权），请重新注册或登录获取', state: lst.state || 'inactive' }, 403);
          }
        } catch (e) {
          // 授权状态读不出来 = 无法证明已付费，同样拒绝。绝不做「异常就放行」的兜底。
          return json({ error: 'license-check-failed', message: '授权状态校验失败，请重新登录或激活', detail: String(e && e.message || e).slice(0, 120) }, 403);
        }
      }

      if (!p.startsWith('/api/')) {
        // 线上这几个路径返回空 200(0 字节) — 保持一致, 避免无谓 404 噪音
        if (p === '/omni-access.js' || p === '/registerSW.js') {
          res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
          return res.end('');
        }
        let rel;
        try { rel = decodeURIComponent(p === '/' ? '/index.html' : p).replace(/^\/+/, ''); }
        catch (_) { status = 400; res.writeHead(400); return res.end('400'); }
        // L7: path.resolve + 分隔符边界(旧 startsWith(UI_DIR) 放行同前缀兄弟文件, 如 /..%2fui_shim.js)
        let fp = path.resolve(UI_DIR, rel);
        let inUi = (fp === UI_DIR || fp.startsWith(UI_DIR + path.sep));
        let staticExists = false;
        if (inUi) {
          try { staticExists = (await fs.promises.stat(fp)).isFile(); } catch (_) { staticExists = false; }
        }
        if (!inUi || !staticExists) {
          if (/\.[A-Za-z0-9]{1,6}$/.test(rel) && !rel.endsWith('.html')) { status = 404; res.writeHead(404); return res.end('404'); }
          fp = path.join(UI_DIR, 'index.html'); rel = 'index.html';       // SPA 路由 fallback
          inUi = true;
        }
        let buf;
        try { buf = await readStaticAsset(fp, rel); }
        catch (_) { status = 404; res.writeHead(404); return res.end('404'); }
        status = 200;
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        return res.end(buf);
      }

      // ── [1.1.30] 文件: 上传(本地落盘) / 预览 / 列表 / 删除 ──
      if ((p === '/api/files' || p === '/api/files/images' || p === '/api/files/images/avatar') && (req.method === 'POST' || req.method === 'PUT')) {   // [1.1.30] 图片走 /api/files/images(fork 行为)
        try { return await handleFileUpload(req, res, json); }
        catch (e) {
          const msg = String(e && e.message || e).slice(0, 160);
          shimLog({ stage: 'files-upload-err', err: msg.slice(0, 200) });
          if (/payload too large/.test(msg)) return json({ message: '文件过大(上限 64MB)', error: 'PAYLOAD_TOO_LARGE' }, 413);
          return json({ message: '上传失败: ' + msg }, 500);
        }
      }
      if (p === '/api/files' && req.method === 'DELETE') {
        // [1.1.30] 批量删除(fork 实际调用): body {files:[...]}
        try {
          const bd = await readBody(req, res);
          const ids = Array.isArray(bd && bd.files) ? bd.files : [];
          const deleted = [];
          for (const f of ids) {
            const fid2 = String((f && (f.file_id || f.fileId)) || f || '');
            const fp4 = await findUpload(fid2);
            if (fp4) { try { await fs.promises.unlink(fp4); deleted.push(fid2); } catch (_) {} }
          }
          if (deleted.length) invalidateUploadIndex();
          shimLog({ stage: 'files-delete-batch', asked: ids.length, deleted: deleted.length });
          return json({ message: 'Files deleted', deleted });
        } catch (e) { return json({ error: String(e && e.message || e).slice(0, 120) }, 500); }
      }
      if (p === '/api/files' && req.method === 'GET') {
        try {
          const idx = await uploadIndex();
          if (u.searchParams.get('file_id')) {
            const hit = idx.entries.find((x) => x.file_id === u.searchParams.get('file_id'));
            return json(hit ? [hit] : []);
          }
          return json(idx.entries.slice(0, 200));
        } catch (e) { return json({ error: 'file index unavailable' }, 503); }
      }
      // [1.1.30] usage(文件面板): 返回计数, 形状宽松
      if (p === '/api/files/usage' && (req.method === 'POST' || req.method === 'GET')) {
        try {
          const idx = await uploadIndex();
          return json({ ok: true, fileCount: idx.fileCount, totalBytes: idx.totalBytes, truncated: !!idx.truncated });
        } catch (e) { return json({ error: 'file index unavailable' }, 503); }
      }
      // [1.1.30] 下载系列(审核部缺陷7): /download/<uid>/<fid>、/download/<fid>、裸 /:<fid> 一律字节流(附件)
      let fdm0 = p.match(/^\/api\/files\/download(?:-[^/]+)?\/(?:[^/]+\/)?([^/]+)$/);
      if (fdm0 && req.method === 'GET') {
        const fp5 = await findUpload(decodeURIComponent(fdm0[1]));
        if (!fp5) return json({ error: 'file not found' }, 404);
        try {
          const st = await fs.promises.stat(fp5);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment; filename="' + encodeURIComponent(path.basename(fp5)).slice(0, 160) + '"', 'Cache-Control': 'no-store' });
          fs.createReadStream(fp5).on('error', () => { try { res.destroy(); } catch (_) {} }).pipe(res);
          return;
        } catch (_) { return json({ error: 'file not found' }, 404); }
      }
      // [1.1.32] A6 导入会话(multipart, 必须在 body JSON 解析之前)
      if (p === '/api/convos/import' && req.method === 'POST') {
        try { return await handleConvoImport(req, res, json, requestOwner); }
        catch (e) { shimLog({ stage: 'convos-import-err', err: String(e && e.message || e).slice(0, 160) }); return json({ message: '导入失败: ' + String(e && e.message || e).slice(0, 120) }, 400); }
      }
      let fpm = p.match(/^\/api\/files\/([^/]+)\/(preview|content)$/);
      if (fpm && req.method === 'GET') {
        const fp2 = await findUpload(decodeURIComponent(fpm[1]));
        if (!fp2) return json({ error: 'file not found' }, 404);
        let buf2; try { buf2 = await fs.promises.readFile(fp2); } catch (_) { return json({ error: 'file not found' }, 404); }
        const ext2 = path.extname(fp2).toLowerCase();
        // [1.1.31] S1 残留: 扩展名+magic 双重判定(伪装图片降级为附件)
        const MAGIC = { '.png': [0x89, 0x50, 0x4E, 0x47], '.jpg': [0xFF, 0xD8], '.jpeg': [0xFF, 0xD8], '.gif': [0x47, 0x49, 0x46, 0x38], '.bmp': [0x42, 0x4D], '.ico': [0x00, 0x00, 0x01, 0x00] };
        const magicOk = (ext, buf) => {
          if (ext === '.webp') return buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP';
          const mg = MAGIC[ext]; if (!mg) return false;
          if (buf.length < mg.length) return false;
          for (let i = 0; i < mg.length; i++) if (buf[i] !== mg[i]) return false;
          return true;
        };
        const inlineOk = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico'].includes(ext2) && magicOk(ext2, buf2);   // [1.1.30] S1: html/svg 等主动内容绝不内联
        if (fpm[2] === 'preview' && !inlineOk) {
          // 非图片 preview = JSON 形状(fork getFilePreview 期望 {status,text}); 文本类给前 16KB
          let text = '';
          try { if (buf2.length <= 2 * 1024 * 1024 && !/\x00/.test(buf2.slice(0, 512).toString('latin1'))) text = buf2.toString('utf8').slice(0, 16384); } catch (_) {}
          return json({ status: 'ready', text });
        }
        const hdrs = { 'Content-Type': inlineOk ? (MIME[ext2] || 'application/octet-stream') : 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
        if (!inlineOk) hdrs['Content-Disposition'] = 'attachment';
        res.writeHead(200, hdrs);
        return res.end(buf2);
      }
      let fm1 = p.match(/^\/api\/files\/([^/]+)$/);
      if (fm1 && req.method === 'GET' && !['images', 'config', 'usage', 'speech'].includes(fm1[1])) {
        const fp6 = await findUpload(decodeURIComponent(fm1[1]));
        if (fp6) {
          try {
            const st = await fs.promises.stat(fp6);
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment; filename="' + encodeURIComponent(path.basename(fp6)).slice(0, 160) + '"', 'Cache-Control': 'no-store' });
            fs.createReadStream(fp6).on('error', () => { try { res.destroy(); } catch (_) {} }).pipe(res);
            return;
          } catch (_) { return json({ error: 'file not found' }, 404); }
        }
        // 未命中文件 → 继续走原 DELETE :id 分支之外的其他路由
      }
      let fdm = p.match(/^\/api\/files\/([^/]+)$/);
      if (fdm && req.method === 'DELETE') {
        const fp2 = await findUpload(decodeURIComponent(fdm[1]));
        try { if (fp2) { await fs.promises.unlink(fp2); invalidateUploadIndex(); } } catch (_) {}
        return json({ message: 'deleted', file_id: decodeURIComponent(fdm[1]) });
      }

      const ag = getAgent();
      const body = (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE' || req.method === 'PATCH') ? await readBody(req, res) : {};   // [1.1.31] DELETE/PATCH 也解析 body(删除会话/改名都靠它)
      if (body && body.__tooLarge) { status = 413; return; }   // L8: 413 已在 readBody 内发出
      if (body && body.__readError) return json({ error: 'bad request body' }, 400);
      if (body && body.__badJson) return json({ error: 'bad JSON body' }, 400);   // [1.1.30] C4: 不再静默当空提示词跑一轮生成

      // ── 自动化中心: 账号隔离设置 + bridge catalog + 方式模板 ──
      if (p === '/api/omni-automation/settings') {
        const file = accountDataFile('user_settings.json', requestOwner);
        if (req.method === 'GET') return json({ ...settingsWithDefaults(readAutomationSettings(file)), ...readAutomationSettings(file) });
        if (req.method !== 'PUT' && req.method !== 'PATCH' && req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
        try { return json({ ...settingsWithDefaults(writeAutomationSettings(file, body)), ...readAutomationSettings(file) }); }
        catch (e) { return json({ error: String(e && e.message || e).slice(0, 240) }, 400); }
      }
      if (p === '/api/omni-automation/catalog' && req.method === 'GET') {
        const file = accountDataFile('user_settings.json', requestOwner);
        const settings = readAutomationSettings(file);
        let tools = [], skills = [], sources = [], errors = [];
        try {
          tools = (await ag.loadBridgeTools()).map((tool) => ({
            name: String(tool.name || ''), description: String(tool.description || ''),
            active: !settings.toolStates || settings.toolStates[tool.name] !== false,
          })).filter((tool) => tool.name);
        } catch (e) { errors.push({ source: 'tools', error: String(e && e.message || e).slice(0, 180) }); }
        try {
          const listed = parseToolPayload(await ag.bridgeCall('skill_list', {
            source: 'all', query: String(u.searchParams.get('query') || '').slice(0, 2000), max: 200,
          }));
          sources = Array.isArray(listed.sources) ? listed.sources : [];
          skills = (Array.isArray(listed.entries) ? listed.entries : []).map((skill) => ({
            ...skill, active: !settings.skillStates || settings.skillStates[skill.skill_id] !== false,
          }));
        } catch (e) { errors.push({ source: 'skills', error: String(e && e.message || e).slice(0, 180) }); }
        return json({ tools, skills, sources, errors, partial: errors.length > 0 });
      }
      if (p === '/api/omni-automation/templates') {
        if (req.method === 'GET') return json({ templates: workflowTemplates(requestOwner) });
        if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
        try {
          const rows = workflowTemplates(requestOwner);
          if (rows.length >= MAX_WORKFLOW_TEMPLATES) return json({ error: `模板数量已达上限（${MAX_WORKFLOW_TEMPLATES} 个），请先删除一个模板` }, 409);
          const input = workflowTemplateInput(body), now = new Date().toISOString();
          const row = { id: 'workflow_' + crypto.randomUUID(), ...input, createdAt: now, updatedAt: now };
          rows.push(row); saveJsonStore(WORKFLOW_TEMPLATES_FILE(requestOwner), rows);
          return json(row, 201);
        } catch (e) { return json({ error: String(e && e.message || e).slice(0, 240) }, 400); }
      }
      const workflowMatch = p.match(/^\/api\/omni-automation\/templates\/(workflow_[A-Fa-f0-9-]{36})$/);
      if (workflowMatch) {
        const rows = workflowTemplates(requestOwner), index = rows.findIndex((row) => row.id === workflowMatch[1]);
        if (req.method === 'DELETE') {
          if (index < 0) return json({ deleted: false, id: workflowMatch[1] }, 404);
          rows.splice(index, 1); saveJsonStore(WORKFLOW_TEMPLATES_FILE(requestOwner), rows);
          const settingsFile = accountDataFile('user_settings.json', requestOwner);
          if (readAutomationSettings(settingsFile).activeTemplateId === workflowMatch[1]) writeAutomationSettings(settingsFile, { activeTemplateId: '' });
          return json({ deleted: true, id: workflowMatch[1] });
        }
        if (req.method === 'PATCH' || req.method === 'PUT') {
          if (index < 0) return json({ error: 'template not found' }, 404);
          try { rows[index] = { ...rows[index], ...workflowTemplateInput(body), updatedAt: new Date().toISOString() }; saveJsonStore(WORKFLOW_TEMPLATES_FILE(requestOwner), rows); return json(rows[index]); }
          catch (e) { return json({ error: String(e && e.message || e).slice(0, 240) }, 400); }
        }
        return index >= 0 ? json(rows[index]) : json({ error: 'template not found' }, 404);
      }

      // ── G80: 自主目标（goal_start/goal_status/goal_stop/goal_log） ──
      // 前端 /omni-automation 面板的「自主目标」走这组路由，转发到 bridge 的 goal_* 工具。
      // 设计：任何目标都接受，不拒绝；max_iters=0 表示不达完成判据不停。
      if (p === '/api/omni-automation/goal/start' && (req.method === 'POST' || req.method === 'PUT')) {
        const objective = String(body.objective || '').trim();
        if (!objective) return json({ error: 'objective 不能为空' }, 400);
        if (objective.length > 2000) return json({ error: 'objective 过长（>2000）' }, 400);
        const maxIter = Math.max(0, Math.min(parseInt(body.max_iters || '0', 10) || 0, 100000));
        const doneKws = String(body.done_keywords || '').slice(0, 500);
        try {
          const r = parseToolPayload(await ag.bridgeCall('goal_start', {
            objective, max_iters: maxIter, done_keywords: doneKws,
          }));
          // [SESSION-LINK 2026-11-09] 无限迭代已在会话内闭环：AI 侧可直接 goal_status/goal_log 跟踪
          if (r && typeof r === 'object' && !r.error) r.session_hint = '目标已在会话内运行——对 AI 说「跟踪目标 ' + String(r.id || '') + '」即可在聊天里看迭代日志与战果研判';
          return json(r);
        } catch (e) { return json({ error: String(e && e.message || e).slice(0, 240) }, 500); }
      }
      if (p === '/api/omni-automation/goal/list' && req.method === 'GET') {
        try { return json(parseToolPayload(await ag.bridgeCall('goal_status', {}))); }
        catch (e) { return json({ error: String(e && e.message || e).slice(0, 240) }, 500); }
      }
      const goalStatusMatch = p.match(/^\/api\/omni-automation\/goal\/([A-Za-z0-9_-]{1,64})\/status$/);
      if (goalStatusMatch && req.method === 'GET') {
        const tail = Math.max(1, Math.min(parseInt(u.searchParams.get('tail') || '40', 10) || 40, 500));
        try { return json(parseToolPayload(await ag.bridgeCall('goal_status', { id: goalStatusMatch[1], tail }))); }
        catch (e) { return json({ error: String(e && e.message || e).slice(0, 240) }, 500); }
      }
      const goalLogMatch = p.match(/^\/api\/omni-automation\/goal\/([A-Za-z0-9_-]{1,64})\/log$/);
      if (goalLogMatch && req.method === 'GET') {
        const tail = Math.max(1, Math.min(parseInt(u.searchParams.get('tail') || '120', 10) || 120, 2000));
        try {
          const r = await ag.bridgeCall('goal_log', { id: goalLogMatch[1], tail });
          return json({ id: goalLogMatch[1], text: (r && r.result && r.result.text) || (r && r.text) || '' });
        } catch (e) { return json({ error: String(e && e.message || e).slice(0, 240) }, 500); }
      }
      const goalStopMatch = p.match(/^\/api\/omni-automation\/goal\/([A-Za-z0-9_-]{1,64})\/stop$/);
      if (goalStopMatch && (req.method === 'POST' || req.method === 'PUT')) {
        try { return json(parseToolPayload(await ag.bridgeCall('goal_stop', { id: goalStopMatch[1] }))); }
        catch (e) { return json({ error: String(e && e.message || e).slice(0, 240) }, 500); }
      }

      // ── 启动配置(形状对齐线上 /api/config: 756B 精简体) ──
      if (p === '/api/config') {
        // [MODEL-DEDUP] Agent rows below are the single visible model catalog.
        // Legacy modelSpecs duplicate those rows, so only emit them with the rollback switch.
        let modelSpecs;
        try {
          if (process.env.OMNI_LEGACY_MODEL_AGENTS === '1' && activeProviderModels()) {
            const seen = new Set();
            const uniq = providerModelList().filter((m) => { if (seen.has(m)) return false; seen.add(m); return true; });
            // 默认与两个发送入口共用同一选择规则，只接受当前目录中的设置。
            const pref = require('./model_selection').selectModel(activeProviderModels(), undefined, getSettings());
            const list = uniq.map((m) => ({ name: m, label: m, group: 'agents', preset: { endpoint: 'agents', model: m }, ...(m === (pref || uniq[0]) ? { default: true } : {}) }));
            if (list.length) modelSpecs = { list };
          }
        } catch (_) {}
        return json({
          modelSpecs,
          appTitle: 'OmniShade', discordLoginEnabled: false, facebookLoginEnabled: false,
          githubLoginEnabled: false, googleLoginEnabled: false, appleLoginEnabled: false,
          openidLoginEnabled: false, openidLabel: 'Continue with OpenID', openidAutoRedirect: false,
          samlLoginEnabled: false, serverDomain: 'http://localhost:3080', emailLoginEnabled: true,
          registrationEnabled: true, socialLoginEnabled: false, emailEnabled: true,   // [1.1.71] 登录页显示注册入口
          passwordResetEnabled: false, ldap: { enabled: false },
          socialLogins: ['google', 'facebook', 'openid', 'github', 'discord', 'saml'], turnstile: {},
          buildInfo: { commit: 'OmniShade ' + APP_VERSION_UI, commitShort: APP_VERSION_UI, branch: 'release', buildDate: BUILD_DATE_ISO },
          adminPanelURL: 'http://' + (req.headers.host || '127.0.0.1') + '/omni-model',
          allowAccountDeletion: false,   // [1.1.32] B2: 删除账号项隐藏
          // [G105] 关掉前端原生网页搜索：它固定走 web-search-deepseek（要 DEEPSEEK_API_KEY），
          // 本机没这个 key → 用户一点就报「没有 DEEPSEEK_API_KEY」。
          // 联网检索由桥内 web_search 工具承担（cn.bing.com 直连解析，不要 key、不要登录）。
          webSearch: { enabled: false, useWebSearch: false },
          version: 'v' + APP_VERSION_UI + ' (OmniShade)',
        });
      }
      // ── 端点配置: 客户端期望 TEndpointsConfig(对象映射, 不是数组!) ──
      if (p === '/api/endpoints') {
        const models = providerModelList();
        return json({
          agents: {
            title: 'OmniShade', type: 'agents', streamRate: 0, iconURL: null,
            models: { default: models, fetch: false },
            disableBuilder: true,   // [1.1.32] B6: Agent Builder 隐藏
            modelDisplayLabel: 'OmniShade',
          },
        });
      }
      // ── 登录态: t.TUser(types.ts:316) ──
      // [1.1.62] 账号用户: 未登录一律 401(fork 原生登录页 = 账号登录)
      const _acctU = accountUser();
      if (p === '/api/user' && req.method === 'GET') { if (!_acctU) return json({ error: 'unauthorized' }, 401); return json(_acctU); }
      if (p === '/api/user' && (req.method === 'PUT' || req.method === 'POST')) { if (!_acctU) return json({ error: 'unauthorized' }, 401); return json(_acctU); }
      if (p === '/api/auth/refresh' && (req.method === 'GET' || req.method === 'POST')) {
        if (!_acctU) return json({ error: 'unauthorized' }, 401);
        return json({ token: TOKEN, user: _acctU });
      }
      if (p === '/api/auth/login' && req.method === 'POST') {
        // 账号登录: 邮箱+密码 → 服务端 /account_login 校验(单会话)
        try {
          const email = String((body && body.email) || '').trim().toLowerCase();
          const password = String((body && body.password) || '');
          if (!email || !password) return json({ error: '邮箱和密码不能为空' }, 401);
          const r = await accountPost('/account_login', { email, password }, REGISTER_TIMEOUT_MS);
          if (r.error || !r.data) return json({ error: '账号服务不可达' }, 502);
          if (!accountVerify(r.data)) return json({ error: '账号响应验签失败' }, 502);
          if (r.data.error) return json({ error: r.data.error || '账号或密码错误' }, r.httpStatus === 401 ? 401 : 403);
          if (r.data.ok !== true || typeof r.data.token !== 'string' || !r.data.token || typeof r.data.expires_at !== 'number') return json({ error: '账号服务响应不完整' }, 502);
          const account = { email: r.data.email || email, token: r.data.token, expires_at: r.data.expires_at };
          // 登录成功就先落盘：没卡密只是「未激活」，不是登录失败。
          let granted = true;
          if (typeof o.onAccountAuthenticated === 'function') granted = await o.onAccountAuthenticated(account);
          try { if (typeof invalidateAccountJobs === 'function') invalidateAccountJobs('login'); } catch (_) {}
          accountSave(account);
          try { if (typeof o.onAccountSaved === 'function') await o.onAccountSaved(account); } catch (_) {}
          if (granted === false) {
            const lf = (o.onAccountAuthenticated && typeof o.onAccountAuthenticated.lastFailure === 'function') ? (o.onAccountAuthenticated.lastFailure() || {}) : {};
            return json({ token: TOKEN, user: accountUser(), need_card: true,
                          grant_status: lf.status || '', message: '登录成功，但该账号还没激活卡密' });
          }
          return json({ token: TOKEN, user: accountUser(), message: '登录成功(单设备)' });
        } catch (e) { return json({ error: '登录失败: ' + String(e && e.message || e).slice(0, 100) }, 401); }
      }
      if (p === '/api/auth/logout' && (req.method === 'POST' || req.method === 'GET')) {
        try { if (typeof invalidateAccountJobs === 'function') invalidateAccountJobs('logout'); } catch (_) {}
        try { const p2 = require('path').join(process.env.APPDATA || require('os').homedir(), 'omnishade', 'account.json'); require('fs').rmSync(p2, { force: true }); } catch (_) {}
        try { if (typeof o.onAccountInvalidated === 'function') o.onAccountInvalidated('logout'); } catch (_) {}
        return json({ message: 'ok' });
      }
      // TModelsConfig = Record<string, string[]>(types.ts:692)
      // TModelsConfig = Record<string, string[]>: 选择器数据源 = 启用供应商的模型清单
      if (p === '/api/models') {
        return json({ agents: providerModelList() });
      }
      // ProjectListResponse = {projects, nextCursor}(types/queries.ts:61); 客户端走 infinite query,
      // pages.flatMap(p=>p.projects) + pages[last].nextCursor !== null 判定翻页(projects 面板)
      // [RENAME-PERSIST] 项目与会话共用请求入口冻结的账号命名空间；所有写操作落 projects.json。
      if (p === '/api/projects' && req.method === 'GET') return json({ projects: projectsStore(requestOwner).projects, nextCursor: null });
      if (p === '/api/projects' && req.method === 'POST') {
        const now = new Date().toISOString();
        const store = projectsStore(requestOwner);
        const project = {
          _id: 'p_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
          name: (String((body && body.name) || '本地项目').trim() || '本地项目').slice(0, 100),
          description: typeof (body && body.description) === 'string' ? body.description.trim().slice(0, 1000) : '',
          createdAt: now, updatedAt: now, user: 'local-user', conversationCount: 0,
        };
        store.projects.push(project);
        saveJsonStore(PROJECTS_FILE(requestOwner), store);
        return json(project);
      }
      let prjc = p.match(/^\/api\/projects\/conversations\/([^/]+)$/);   // 分配/移出: PUT {projectId|null}
      if (prjc && (req.method === 'PUT' || req.method === 'POST')) {
        const cid = decodeURIComponent(prjc[1]);
        if (!sidOk(cid)) return rejectSid(cid);
        const store = projectsStore(requestOwner);
        const prev = store.convos[cid] || null;
        const pid = body && (body.projectId !== undefined) ? body.projectId : null;
        if (pid) store.convos[cid] = String(pid); else delete store.convos[cid];
        saveJsonStore(PROJECTS_FILE(requestOwner), store);
        return json({ conversation: convoOf(ag, cid, Date.now(), null, requestOwner), previousProjectId: prev, projectId: pid || null });
      }
      let prjl = p.match(/^\/api\/projects\/([^/]+)\/conversations$/);   // 项目会话列表
      if (prjl && req.method === 'GET') {
        const pid = decodeURIComponent(prjl[1]);
        const store = projectsStore(requestOwner);
        const convos = (ag ? ag.listSessions(requestOwner) : []).filter((x) => store.convos[x.id] === pid).map((x) => convoOf(ag, x.id, x.mtime, null, requestOwner));
        return json({ conversations: convos, nextCursor: null });
      }
      let pm = p.match(/^\/api\/projects\/([^/]+)$/);
      if (pm) {
        const pid = decodeURIComponent(pm[1]);
        const store = projectsStore(requestOwner);
        const index = store.projects.findIndex((row) => row && row._id === pid);
        if (req.method === 'DELETE') return json({ message: 'deleted' });
        if (req.method === 'PATCH' || req.method === 'PUT') {
          if (index < 0) return json({ error: 'Project not found' }, 404);
          const project = store.projects[index];
          if (body && body.name !== undefined) {
            const name = typeof body.name === 'string' ? body.name.trim() : '';
            if (!name) return json({ error: 'name is required' }, 400);
            project.name = name.slice(0, 100);
          }
          if (body && body.description !== undefined) {
            project.description = typeof body.description === 'string' ? body.description.trim().slice(0, 1000) : '';
          }
          project.updatedAt = new Date().toISOString();
          saveJsonStore(PROJECTS_FILE(requestOwner), store);
          shimLog({ stage: 'project-rename', projectId: pid });
          return json(project);
        }
        if (req.method === 'GET') {
          if (index < 0) return json({ error: 'Project not found' }, 404);
          return json(store.projects[index]);
        }
        return json({ error: 'method not allowed' }, 405);
      }
      // getFiles(): Promise<TFile[]>(data-service.ts:565)→ 裸数组
      if (p === '/api/files/config') return json({
        fileStrategy: 'local', imageOutputType: 'webp',
        endpoints: {
          agents: { fileLimit: 10, fileSizeLimit: 64, totalSizeLimit: 128, supportedMimeTypes: ['image/.*', 'application/.*', 'text/.*'] },
          default: { fileLimit: 10, fileSizeLimit: 64, totalSizeLimit: 128, supportedMimeTypes: ['image/.*', 'application/.*', 'text/.*'] },
        },
        serverFileSizeLimit: 64, avatarSizeLimit: 2,
        clientImageResize: { enabled: false },   // 本地不压缩, 原样落盘
      });
      if (p === '/api/tokenizer') return json({ count: 0 });
      // getUserKeyExpiry: {expiresAt: Date|'never'|null}(packages/data-schemas/src/methods/key.ts:87); 无 key → null
      if (p === '/api/keys') return json({ expiresAt: null });
      // getConversationTags(): TConversationTag[](裸数组) — [1.1.32] 落盘 tags.json
      if (p === '/api/tags') {
        if (req.method === 'POST') {
          const tg = String((body && body.tag) || '').trim().slice(0, 60);
          if (!tg) return json({ error: 'tag required' }, 400);
          const now = new Date().toISOString();
          return json({ tag: tg, user: 'local-user', count: 0, position: 0, createdAt: now, updatedAt: now });
        }
        const tj = convoTagsStore(); const counts = {};
        for (const cid of Object.keys(tj.convos)) for (const tg of (tj.convos[cid] || [])) counts[tg] = (counts[tg] || 0) + 1;
        const now = new Date().toISOString();
        return json(Object.keys(counts).map((tg, i) => ({ tag: tg, user: 'local-user', count: counts[tg], position: i, createdAt: now, updatedAt: now })));
      }
      let tgc = p.match(/^\/api\/tags\/convo\/([^/]+)$/);   // [1.1.32] A8: 会话标签(读写都是 string[])
      if (tgc) {
        const cid = decodeURIComponent(tgc[1]);
        if (!sidOk(cid)) return rejectSid(cid);
        if (req.method === 'PUT' || req.method === 'POST') {
          const tags = Array.isArray(body && body.tags) ? body.tags.map(String).slice(0, 20) : [];
          const tj = convoTagsStore(); tj.convos[cid] = tags; saveJsonStore(TAGS_FILE, tj);
          return json(tags);
        }
        return json(convoTagsStore().convos[cid] || []);
      }
      if (p.startsWith('/api/tags/')) {
        const tg = decodeURIComponent(p.slice('/api/tags/'.length));
        if (req.method === 'DELETE') {
          const tj = convoTagsStore(); let n = 0;
          for (const cid of Object.keys(tj.convos)) { const arr = tj.convos[cid] || []; const i = arr.indexOf(tg); if (i >= 0) { arr.splice(i, 1); n++; } }
          saveJsonStore(TAGS_FILE, tj);
          return json({ deletedCount: n });
        }
        return json({ tag: tg, user: 'local-user', count: 0, position: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      }
      // getPresets(): TPreset[](裸数组) — [1.1.32] 落盘 presets.json
      if (p === '/api/presets') {
        if (req.method === 'POST') {
          const preset = { ...(body || {}) };
          if (!preset.presetId) preset.presetId = 'preset_' + Date.now().toString(36);
          const arr = loadJsonStore(PRESETS_FILE, []);
          const i = arr.findIndex((x) => x && x.presetId === preset.presetId);
          if (i >= 0) arr[i] = preset; else arr.push(preset);
          saveJsonStore(PRESETS_FILE, arr);
          return json(preset);
        }
        return json(loadJsonStore(PRESETS_FILE, []));
      }
      if (p === '/api/presets/delete' && req.method === 'POST') {
        const pid = String((body && (body.presetId || (body.arg && body.arg.presetId))) || '');
        const arr = loadJsonStore(PRESETS_FILE, []);
        const i = arr.findIndex((x) => x && x.presetId === pid);
        if (i >= 0) { arr.splice(i, 1); saveJsonStore(PRESETS_FILE, arr); return json({ acknowledged: true, deletedCount: 1 }); }
        return json({ acknowledged: true, deletedCount: 0 });
      }
      if (p.startsWith('/api/presets/')) {
        const pid = decodeURIComponent(p.slice('/api/presets/'.length));
        const one = loadJsonStore(PRESETS_FILE, []).find((x) => x && x.presetId === pid);
        return json(one || {});
      }
      // getTokenConfig(): TTokenConfigMap = Record<string, Record<string, TModelTokenomics>>(types.ts:704)
      if (p === '/api/endpoints/token-config') return json({});
      // getUserBalance(): TBalanceResponse(types.ts:986); 本地不计费 → 0 额度/无自动充值
      if (p === '/api/balance') return json({ tokenCredits: 0, autoRefillEnabled: false });
      // 工具鉴权: GET /api/agents/tools/<toolId>/auth → {authenticated, authTypes[][], ...}(客户端读 authData?.authTypes)
      if (/^\/api\/agents\/tools\/[^/]+\/auth$/.test(p)) return json({ authenticated: false, authTypes: [] });
      if (p === '/api/agents/tools/calls') {
        const q = new URL(String(req.url || ''), 'http://x');
        const cid = q.searchParams.get('conversationId') || String((body && (body.conversationId || (body.arg && body.arg.conversationId))) || '');
        return json(ag ? sessionToolCalls(ag, 200, requestOwner, cid || '') : []);   // D1: 真实工具调用流水（[G95] 按 conversationId 只解析当前会话）
      }
      if (p === '/api/agents/tools') return json([]);
      if (p === '/api/user/plugins') return json([]);
      // 资源权限全量: 本地无共享资源 → {}(api/server/controllers/PermissionsController.js:503)
      if (/^\/api\/permissions\/[^/]+\/effective\/all$/.test(p)) return json({});
      // getSharedLink(): 无分享链接形态(api/server/routes/share.js:616)
      let sm = p.match(/^\/api\/share\/link\/([^/]+)$/);
      if (sm) return json({ _id: null, success: false, shareId: null, targetMessageId: null, conversationId: decodeURIComponent(sm[1]) });
      if (p === '/api/share') return json({ links: [], nextCursor: null, hasNextPage: false });
      // TBannerResponse = TBanner | null(types.ts:974); 直接返回 banner 本体, 不是 {banner:...}
      if (p === '/api/banner') return res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }) && res.end('null');
      // getFavorites(): Promise<TUserFavorite[]>(data-service.ts:149)→ 裸数组
      if (p === '/api/user/settings/favorites' || p.startsWith('/api/user/settings/favorites/')) return json([]);
      if (p === '/api/tools/favorites' || p.startsWith('/api/tools/favorites')) return json([]);
      // getCustomConfigSpeech(): TCustomConfigSpeechResponse = {[k:string]: string}(types.ts:962)
      if (p === '/api/files/speech/config/get') return json({});
      if (p === '/api/files/speech/voices') return json({ voices: [] });
      // getPinnedOrder(): Promise<string[]>(data-service.ts:161)→ 裸字符串数组!
      // 消费方 PinnedSection.tsx:605: `if (!u || u.length === 0) return w; ... for (const r of u)`
      // 返回 {order:[]} 时 u.length===undefined → 落到 for..of → "TypeError: u is not iterable"
      if (p === '/api/user/settings/pinned-order' && req.method === 'GET') return json([], 200);
      if (p === '/api/user/settings/pinned-order' && req.method === 'POST') {
        const arr = body && Array.isArray(body.pinnedOrder) ? body.pinnedOrder : [];
        return json(arr);
      }
      // getRole(roleName): Promise<TRole>(data-provider/roles.ts:43 roleSchema {name, permissions})
      if (p.startsWith('/api/roles/')) return json(rolePayload(decodeURIComponent(p.slice('/api/roles/'.length))));
      if (p === '/api/roles') return json({ roles: Object.values(ROLE_DEFAULTS) });
      // getUserTerms(): TUserTermsResponse {termsAccepted, termsAcceptedAt}(types.ts:964)
      if (p === '/api/user/terms') return json({ termsAccepted: true, termsAcceptedAt: new Date().toISOString() });
      // getSearchEnabled(): Promise<boolean>(data-service.ts) → 裸布尔
      if (p === '/api/search/enable') return json(true);   // [1.1.32] A7: 打开侧栏搜索框
      if (p === '/api/search' && req.method === 'GET') {
        const q = String(u.searchParams.get('q') || '').trim().toLowerCase();
        if (!q || !ag) return json({ messages: [], nextCursor: null });
        try {
          const offset = searchCursorDecode(u.searchParams.get('cursor'), q);
          const page = await searchSessionsWorker(await sessionIndex(requestOwner), q, offset, requestOwner);
          const nextCursor = page && page.nextOffset != null ? searchCursorEncode(q, page.nextOffset) : null;
          return json({ messages: (page && page.hits) || [], nextCursor });
        } catch (e) {
          shimLog({ stage: 'session-search-error', err: String(e && e.message || e).slice(0, 160) });
          return json({ error: 'search unavailable', messages: [], nextCursor: null }, /cursor/.test(String(e && e.message || '')) ? 400 : 503);
        }
      }
      // getActiveJobs(): {activeJobIds: string[]}(data-service.ts:1653)
      if (p === '/api/agents/chat/active') {
        // [SIDEBAR-ACTIVE] Conversations.tsx/PinnedSection.tsx light every ID in
        // this list. Expose only the account's latest unfinished submission.
        const current = currentJobByOwner.get(requestOwner);
        return json({ activeJobIds: current && !current.done ? [current.streamId] : [] });
      }
      if (p === '/api/plugins') return json([]);
      if (p === '/api/config/interface' || p === '/api/endpoints/config') return json({});
      if (p === '/api/mcp/servers' || p === '/api/mcp') return json([]);
      // [1.1.32] B14/B15: memories 正确形状 + 落盘 memories.json
      if (p === '/api/memories/preferences' && (req.method === 'PATCH' || req.method === 'POST' || req.method === 'GET')) {
        const store = loadJsonStore(MEMORIES_FILE, {});
        return json({ updated: true, preferences: { memories: Object.keys(store) } });
      }
      if (p === '/api/memories') {
        const store = loadJsonStore(MEMORIES_FILE, {});
        if (req.method === 'POST') {
          const key = 'mem_' + Date.now().toString(36);
          const mem = { key, ...(body || {}), value: String((body && (body.value || (body.memory && body.memory.value))) || '') };
          store[key] = mem; saveJsonStore(MEMORIES_FILE, store);
          return json({ created: true, memory: mem });
        }
        return json({ memories: Object.values(store) });
      }
      let memm = p.match(/^\/api\/memories\/([^/]+)$/);
      if (memm) {
        const k = decodeURIComponent(memm[1]);
        const store = loadJsonStore(MEMORIES_FILE, {});
        if (req.method === 'DELETE') { const had = k in store; delete store[k]; saveJsonStore(MEMORIES_FILE, store); return json({ deleted: had, key: k }); }
        if (req.method === 'PATCH' || req.method === 'PUT') { store[k] = { ...(store[k] || { key: k }), ...(body || {}), key: k }; saveJsonStore(MEMORIES_FILE, store); return json({ updated: true, memory: store[k] }); }
        return json(store[k] || {});
      }
      if (p === '/api/prompts' && req.method === 'POST') {   // [1.1.32] 创建提示词: 返回所建对象(TCreatePromptResponse)
        const pr = { ...(body || {}) };
        if (!pr._id && !pr.id) pr._id = 'prompt_' + Date.now().toString(36);
        return json(pr);
      }
      if (p === '/api/prompts' || p.startsWith('/api/prompts/')) {
        return json(p.includes('groups') ? { promptGroups: [], total: 0 } : { prompts: [], total: 0 });
      }
      // listAgents(): ag.AgentListResponse {object, data[], first_id, last_id, has_more, after?}
      // (data-provider/src/types/agents.ts:1138; 客户端 fetchAllAgentPages 用 `cursor = page.after` 翻页)
      if ((p === '/api/agents' || p === '/api/agents/v1' || p === '/api/agents/list') && req.method === 'GET') {
        // [MODEL-DEDUP] Keep one selectable row per model, using the bare model name.
        // /api/config.modelSpecs is suppressed by default above so it cannot clone these rows.
        let data = [];
        try {
          const provider = activeProviderModels();
          if (provider) {
            const settings = getSettings() || {};
            const preferred = require('./model_selection').selectModel(provider, undefined, settings);
            const models = require('./model_selection').providerModels(provider);
            // 保留多模型可选（选择器必须能切换），但身份统一为 OmniShade。
            // 消息气泡/输入框占位已由 sender='OmniShade' 与 model:null 控制，不出现技术名词；
            // 这里 name 仅用于选择器区分条目，去掉 cn: 这类渠道前缀。
            data = models.map((model) => {
              const aid = localAgentId(provider, model);
              return {
                id: aid, agent_id: aid,
                name: 'OmniShade · ' + model,   // cn: 是网关自带命名空间，原样保留
                description: 'OmniShade 作业系统',
                provider: provider.name || 'local', model,
                endpoint: 'agents', endpointType: 'agents', tools: [], isAvailable: true,
                default: model === preferred,
              };
            });
          }
        } catch (e) {
          shimLog({ stage: 'agents-list-error', err: String(e && e.message || e).slice(0, 160) });
        }
        return json({ object: 'list', data, first_id: data[0] ? data[0].id : '', last_id: data.length ? data[data.length - 1].id : '', has_more: false });
      }

      // ── 会话 ──
      // ConversationListResponse = {conversations: MinimalConversation[], nextCursor: string|null}
      // (data-provider/src/types/queries.ts:42; 客户端 infinite query 用 pages[last].nextCursor !== null 判定翻页)
      if (p === '/api/convos' && req.method === 'GET') {
        const isArchived = u.searchParams.get('isArchived') === 'true';
        const pinnedOnly = u.searchParams.get('pinned') === 'true';
        const search = String(u.searchParams.get('search') || '').toLowerCase();
        const projectId = u.searchParams.get('projectId');
        const requestedLimit = parseInt(u.searchParams.get('limit') || '50', 10);
        const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 50, 100));
        const state = { tags: convoTagsStore(requestOwner), pinned: pinnedSet(requestOwner), archived: archivedSet(requestOwner), projects: projectsStore(requestOwner) };
        const arch = state.archived, pin = state.pinned, pj = state.projects;
        const filterKey = [isArchived ? 'a' : 'l', pinnedOnly ? 'p' : '-', projectId || '', search].join('|');
        let offset = 0, snapshotId = null;
        const rawCursor = String(u.searchParams.get('cursor') || '');
        if (rawCursor) {
          try {
            const parsed = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8'));
            if (!parsed || parsed.k !== filterKey || !Number.isInteger(parsed.o) || parsed.o < 0) throw new Error('bad cursor');
            offset = parsed.o;
            if (parsed.s != null) {
              if (parsed.v !== 2 || typeof parsed.s !== 'string' || !/^[A-Fa-f0-9-]{36}$/.test(parsed.s)) throw new Error('bad snapshot');
              snapshotId = parsed.s;
            }
          } catch (_) { return json({ error: 'invalid cursor' }, 400); }
        }
        let filtered;
        if (snapshotId) {
          filtered = readConvoSnapshot(snapshotId, requestOwner, filterKey);
          if (!filtered) return json({ error: 'invalid or expired cursor' }, 400);
        } else {
          let list = [];
          try { list = await sessionIndex(requestOwner); }
          catch (e) { shimLog({ stage: 'session-index-error', err: String(e && e.message || e).slice(0, 160) }); return json({ error: 'session index unavailable', conversations: [], nextCursor: null }, 503); }
          // Filter/sort metadata first; materialize JSONL titles only for the requested page.
          filtered = list
            .filter((s) => (isArchived ? arch.has(s.id) : !arch.has(s.id)))
            .filter((s) => (projectId ? pj.convos[s.id] === projectId : true))
            .filter((s) => (pinnedOnly ? pin.has(s.id) : true));
          if (search) filtered = filtered.filter((s) => String(convoOf(ag, s.id, s.mtime, state, requestOwner).title).toLowerCase().includes(search));
          filtered.sort((a, b) => {
            const pcmp = (pin.has(b.id) ? 1 : 0) - (pin.has(a.id) ? 1 : 0);
            return pcmp || (Number(b.mtime || 0) - Number(a.mtime || 0)) || String(a.id).localeCompare(String(b.id));
          });
        }
        const page = filtered.slice(offset, offset + limit);
        const conversations = page.map((s) => convoOf(ag, s.id, s.mtime, state, requestOwner));
        const nextOffset = offset + page.length;
        if (nextOffset < filtered.length && !snapshotId) snapshotId = createConvoSnapshot(requestOwner, filterKey, filtered);
        const nextCursor = nextOffset < filtered.length
          ? Buffer.from(JSON.stringify({ v: 2, k: filterKey, s: snapshotId, o: nextOffset }), 'utf8').toString('base64url') : null;
        return json({ conversations, nextCursor });
      }
      if (p === '/api/convos' && req.method === 'POST') {
        const sid = (ag && ag.sessionId && ag.sessionId()) || ('s_' + Date.now());
        if (!sidOk(sid)) return rejectSid(sid);
        // [H2 配套] 会话占位(标题)不是真实用户消息 → 打 meta 标记, runAgentLoop 回读历史时跳过, 不污染模型上下文
        if (body && body.title) appendLocal(ag, sid, { role: 'user', content: String(body.title), meta: 'convo_title' }, requestOwner);
        if (body && body.model) sidModel.set(modelKey(sid), String(body.model).trim());   // 选择器→会话模型
        return json({ conversation: convoOf(ag, sid, Date.now(), null, requestOwner) });
      }
      // ── [1.1.32] convos 子路由必须排在 /:id 通配之前(审核部对账根因) ──
      // [NEW-CONVO-SUBAGENTS] ParentSubagentIndex(data-provider/src/types/subagents.ts)。
      // "new" 是前端占位会话，尚未落盘也不可能有子代理；返回真实空索引，
      // 避免新建页的首个子代理查询落入默认 404，阻断后续消息提交。
      if (p === '/api/convos/new/subagents' && req.method === 'GET') {
        return json({ parentConversationId: 'new', children: [], childrenTruncated: false });
      }
      // [G95] 通用子代理索引：真实会话的 subagents 也返回空索引（原落 404 → 客户端按可重试轮询 18 次/会话）
      const subMatch = p.match(/^\/api\/convos\/([^/]+)\/subagents$/);
      if (subMatch && req.method === 'GET') {
        return json({ parentConversationId: subMatch[1], children: [], childrenTruncated: false });
      }
      if (p === '/api/convos/update' && req.method === 'POST') {
        const arg = (body && body.arg) || {};
        const sid = String(arg.conversationId || '');
        if (!sid) return json({ error: 'conversationId required' }, 400);
        if (!sidOk(sid)) return rejectSid(sid);
        if (typeof arg.title === 'string' && arg.title.trim()) { loadTitles(requestOwner)[sid] = arg.title.trim().slice(0, 80); saveTitles(requestOwner); }
        if (arg.model) sidModel.set(modelKey(sid), String(arg.model).trim());
        if (Array.isArray(arg.tags)) { const tj = convoTagsStore(requestOwner); tj.convos[sid] = arg.tags.map(String).slice(0, 20); saveJsonStore(TAGS_FILE(requestOwner), tj); }
        shimLog({ stage: 'convos-update', sid, hasTitle: !!arg.title, tags: Array.isArray(arg.tags) ? arg.tags.length : -1 });
        return json(convoOf(ag, sid, Date.now(), null, requestOwner));
      }
      if (p === '/api/convos/pin' && req.method === 'POST') {
        const arg = (body && body.arg) || {};
        const sid = String(arg.conversationId || '');
        if (!sid) return json({ error: 'conversationId required' }, 400);
        if (!sidOk(sid)) return rejectSid(sid);
        const pinned = arg.pinned === true;
        const set = pinnedSet(requestOwner); if (pinned) set.add(sid); else set.delete(sid);
        saveJsonStore(PINNED_FILE(requestOwner), [...set]);
        shimLog({ stage: 'convos-pin', sid, pinned });
        return json({ ...convoOf(ag, sid, Date.now(), null, requestOwner), pinned });
      }
      if (p === '/api/convos/archive' && req.method === 'POST') {
        const arg = (body && body.arg) || {};
        const sid = String(arg.conversationId || '');
        if (!sid) return json({ error: 'conversationId required' }, 400);
        if (!sidOk(sid)) return rejectSid(sid);
        const isArch = arg.isArchived === true;
        const set = archivedSet(requestOwner); if (isArch) set.add(sid); else set.delete(sid);
        saveJsonStore(ARCHIVED_FILE(requestOwner), [...set]);
        shimLog({ stage: 'convos-archive', sid, isArchived: isArch });
        return json({ ...convoOf(ag, sid, Date.now(), null, requestOwner), isArchived: isArch, archivedAt: isArch ? new Date().toISOString() : null });
      }
      if (p === '/api/convos/archive/all' && req.method === 'POST') {
        const set = archivedSet(requestOwner);
        try { for (const x of await sessionIndex(requestOwner)) set.add(x.id); }
        catch (e) { return json({ error: 'session index unavailable' }, 503); }
        saveJsonStore(ARCHIVED_FILE(requestOwner), [...set]);
        shimLog({ stage: 'convos-archive-all', count: set.size });
        return json({ ack: true, archivedCount: set.size });
      }
      if (p === '/api/convos/duplicate' && req.method === 'POST') {
        const arg = (body && body.arg) || {};
        const sid = String(arg.conversationId || '');
        if (!sid) return json({ error: 'conversationId required' }, 400);
        if (!sidOk(sid)) return rejectSid(sid);
        const src = sessionPath(sid, requestOwner);
        if (!src || !fs.existsSync(src)) return json({ error: 'conversation not found' }, 404);
        const newSid = 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        fs.copyFileSync(src, sessionPath(newSid, requestOwner));
        SESSION_DIRTY_GENERATION++; invalidateSessionIndex(requestOwner);
        const srcTitle = loadTitles(requestOwner)[sid] || convoOf(ag, sid, Date.now(), null, requestOwner).title || '会话';
        loadTitles(requestOwner)[newSid] = (srcTitle + ' (副本)').slice(0, 80); saveTitles(requestOwner);
        shimLog({ stage: 'convos-duplicate', from: sid, to: newSid });
        return json({ conversation: convoOf(ag, newSid, Date.now(), null, requestOwner), messages: sessionMessages(ag, newSid, requestOwner) });
      }
      if (p === '/api/convos/fork' && req.method === 'POST') {
        const arg = (body && body.arg) || {};
        const sid = String(arg.conversationId || '');
        const mid = String(arg.messageId || '');
        if (!sid) return json({ error: 'conversationId required' }, 400);
        if (!sidOk(sid)) return rejectSid(sid);
        const src = sessionPath(sid, requestOwner);
        if (!src || !fs.existsSync(src)) return json({ error: 'conversation not found' }, 404);
        let raw = []; try { raw = ag.loadSession(sid, requestOwner) || []; } catch (_) {}
        let cutRaw = raw.length;
        const mm = /_(\d+)$/.exec(mid);
        if (mm) {
          const want = parseInt(mm[1], 10);
          let n = -1;
          for (let i = 0; i < raw.length; i++) {
            const m2 = raw[i];
            if (!m2 || m2.role === 'system' || m2.meta || m2.role === 'tool') continue;
            n++;
            if (n === want) { cutRaw = i + 1; break; }
          }
        }
        const newSid = 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        fs.writeFileSync(sessionPath(newSid, requestOwner), raw.slice(0, cutRaw).map((x) => JSON.stringify(x)).join('\n') + '\n');
        SESSION_DIRTY_GENERATION++; invalidateSessionIndex(requestOwner);
        const srcTitle = loadTitles(requestOwner)[sid] || convoOf(ag, sid, Date.now(), null, requestOwner).title || '会话';
        loadTitles(requestOwner)[newSid] = (srcTitle + ' (分叉)').slice(0, 80); saveTitles(requestOwner);
        shimLog({ stage: 'convos-fork', from: sid, to: newSid, cutRaw });
        return json({ conversation: convoOf(ag, newSid, Date.now(), null, requestOwner), messages: sessionMessages(ag, newSid, requestOwner) });
      }
      let m = p.match(/^\/api\/convos\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const sid = decodeURIComponent(m[1]);
        if (!sidOk(sid)) return rejectSid(sid);                        // H1: 读围栏(挡 ../ 穿越)
        let list = [];
        try { list = (await sessionIndex(requestOwner)).filter((s) => s.id === sid); }
        catch (e) { return json({ error: 'session index unavailable' }, 503); }
        if (!list.length) return json({ error: 'conversation not found' }, 404);
        return json(convoOf(ag, sid, list[0].mtime, null, requestOwner));
      }
      m = p.match(/^\/api\/convos\/([^/]+)$/);
      if (m && (req.method === 'PATCH' || req.method === 'PUT' || req.method === 'POST')) {
        const sid = decodeURIComponent(m[1]);
        if (!sidOk(sid)) return rejectSid(sid);
        if (!sessionPath(sid, requestOwner) || !fs.existsSync(sessionPath(sid, requestOwner))) return json({ error: 'conversation not found' }, 404);
        if (body && body.model) sidModel.set(modelKey(sid), String(body.model).trim());   // 选择器→会话模型(PATCH)
        if (body && typeof body.title === 'string' && body.title.trim()) {      // [1.1.31] 改名持久化
          loadTitles(requestOwner)[sid] = body.title.trim().slice(0, 80);
          saveTitles(requestOwner);
          shimLog({ stage: 'convos-rename', sid, title: body.title.trim().slice(0, 40) });
        }
        return json(convoOf(ag, sid, Date.now(), null, requestOwner));
      }
      // [1.1.31] 删除单个会话: DELETE /api/convos, body {arg:{conversationId}} (fork: deleteConversation→W.deleteWithOptions(Fu(),{data:{arg}}))
      if (p === '/api/convos' && req.method === 'DELETE') {
        const arg = (body && body.arg) || body || {};
        const sid = String(arg.conversationId || '');
        if (!sid) return json({ error: 'conversationId required' }, 400);
        if (!sidOk(sid)) return rejectSid(sid);
        const ok = deleteSessionLocal(sid, requestOwner); invalidateSessionIndex(requestOwner);
        try { sidModel.delete(modelKey(sid)); } catch (_) {}
        try { const t = loadTitles(requestOwner); if (sid in t) { delete t[sid]; saveTitles(requestOwner); } } catch (_) {}   // [1.1.31] 清标题
        shimLog({ stage: 'convos-delete', sid, ok });
        return json({ ack: true, deletedCount: ok ? 1 : 0 });
      }
      // [1.1.31] 删除全部会话: DELETE /api/convos/all (fork: W.delete(Iu()))
      if (p === '/api/convos/all' && req.method === 'DELETE') {
        let n = 0;
        try { for (const s of await sessionIndex(requestOwner)) { if (deleteSessionLocal(s.id, requestOwner)) { n++; try { sidModel.delete(modelKey(s.id)); } catch (_) {} } } } catch (_) {}
        try { titlesCaches.set(accountScopeKey(requestOwner), {}); saveTitles(requestOwner); invalidateSessionIndex(requestOwner); } catch (_) {}   // [1.1.31] 清空标题
        shimLog({ stage: 'convos-delete-all', deleted: n });
        return json({ ack: true, deletedCount: n });
      }
      // [1.1.32] A10 消息反馈: PUT /api/messages/<cid>/<mid>/feedback → {feedback:{rating,tag,text}}
      let fbm = p.match(/^\/api\/messages\/([^/]+)\/([^/]+)\/feedback$/);
      if (fbm && (req.method === 'PUT' || req.method === 'POST')) {
        const cid = decodeURIComponent(fbm[1]), mid = decodeURIComponent(fbm[2]);
        if (!sidOk(cid)) return rejectSid(cid);
        const fb = { rating: (body && body.rating) || null, tag: (body && body.tag) || null, text: String((body && body.text) || '').slice(0, 2000) };
        const all = loadJsonStore(FEEDBACK_FILE, {}); all[cid + '/' + mid] = fb; saveJsonStore(FEEDBACK_FILE, all);
        return json({ feedback: fb });
      }
      const editMessageMatch = p.match(/^\/api\/messages\/([^/]+)\/([^/]+)$/);
      if (editMessageMatch && req.method === 'PUT') {
        const sid = decodeURIComponent(editMessageMatch[1]), mid = decodeURIComponent(editMessageMatch[2]);
        if (!sidOk(sid)) return rejectSid(sid);
        const active = ownedJob(requestOwner, sid);
        if (active && (!active.done || active.loopActive)) return json({ code: 'GENERATION_IN_FLIGHT', error: '请先停止本轮生成再编辑消息' }, 409);
        if (typeof body.text !== 'string' || body.text.length > 1000000) return json({ error: '消息文本必须是字符串且不超过 1000000 字符' }, 400);
        if (body.index != null && (!Number.isInteger(body.index) || body.index < 0)) return json({ error: '无效的消息片段索引' }, 400);
        const fp = sessionPath(sid, requestOwner);
        if (!fp || !fs.existsSync(fp)) return json({ error: 'conversation not found' }, 404);
        const raw = getAgent().loadSession(sid, requestOwner) || [];
        const mapped = sessionMessages(getAgent(), sid, requestOwner);
        const target = mapped.findIndex(row => row.messageId === mid);
        if (target < 0) return json({ error: 'message not found' }, 404);
        const group = messageGroups(raw, sid)[target];
        let field = 'content';
        if (body.index != null) {
          const part = mapped[target].content && mapped[target].content[body.index];
          if (!part || !['text', 'think'].includes(part.type)) return json({ error: '只能编辑文字或思考片段' }, 400);
          field = part.type === 'think' ? 'reasoning' : 'content';
        }
        // One editable UI part may span several tool rounds. Replace the grouped
        // value once without changing tool calls/results or durable identities.
        for (const index of group.indices) raw[index][field] = '';
        raw[group.indices[group.indices.length - 1]][field] = body.text;
        const temp = fp + '.' + crypto.randomUUID() + '.tmp';
        try { fs.writeFileSync(temp, raw.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 }); fs.renameSync(temp, fp); }
        finally { try { fs.unlinkSync(temp); } catch (_) {} }
        SESSION_DIRTY_GENERATION++; invalidateSessionIndex(requestOwner);
        return json(sessionMessages(getAgent(), sid, requestOwner)[target]);
      }
      m = p.match(/^\/api\/messages\/([^/]+)$/);
      if (m && req.method === 'GET') {
        // getMessagesByConvoId(): Promise<TMessage[]>(data-service.ts:1097)→ 裸数组, 不是 {messages:[...]}
        const sid = decodeURIComponent(m[1]);
        if (!sidOk(sid)) return rejectSid(sid);                        // H1: 读围栏(挡 ../ 穿越, 旧实现可读 sessions 外文件)
        const fp = sessionPath(sid, requestOwner);
        // [G17-P1-fix] 新建会话的落盘有窗口: POST /api/agents/chat 回 ack 时 job 才刚建号, 首帧(用户消息)
        // 要等 jobStart 才写 jsonl; 客户端拿到 conversationId 立刻导航并 refetch 消息 → 文件还没生成 → 旧实现
        // 直接 404, 客户端把"刚建的会话"渲染成"会话不存在"。本进程持有该 sid 的 job = 会话确实存在, 按
        // getMessagesByConvoId 的裸数组契约返回空数组; 真正未知的会话仍 404(不吞错误)。
        if (!fp || (!fs.existsSync(fp) && !ownedJob(requestOwner, sid))) return json({ error: 'conversation not found' }, 404);
        if (!fs.existsSync(fp)) { shimLog({ stage: 'session-messages-pending', sid }); return json([]); }
        // [PERF-RENDER] 默认只返回最近 5 条：长会话一次渲染几百条 DOM 是卡顿主因。
        // 上翻加载更多走 ?before=<messageId>&limit=N，全量走 ?limit=all。
        // 契约仍是裸数组（getMessagesByConvoId 期望 Promise<TMessage[]>），不包 page 信封。
        try {
          const all = await sessionMessagesWorker(sid, requestOwner);
          const qs = new URL(req.url, 'http://x').searchParams;
          const limitRaw = String(qs.get('limit') || '').trim().toLowerCase();
          const beforeId = String(qs.get('before') || '').trim();
          // 默认必须返回全量：客户端用 messages[messages.length-1].messageId 当 lastMessageId
          // 发消息，服务端拿它做乐观并发校验(「会话最新消息已变化，请刷新后重试」)。
          // 旧版这里默认截 5 条 → 前端算出来的 lastMessageId 永远是第 5 条 → 发一条报一条。
          // 分页只允许显式请求：?limit=N 或 ?before=<id>；渲染折叠放到 DOM 层做。
          if (!limitRaw && !beforeId) {
            const sl = slimMessages(all);
            shimLog({ stage: 'session-messages-slim', sid: String(sid).slice(0, 40), total: all.length, trimmed: sl.trimmed, savedKB: Math.round(sl.savedBytes / 1024) });
            return json(sl.list, 200, { 'Cache-Control': 'no-store', 'X-Omni-Total': String(all.length) });
          }
          if (limitRaw === 'all' || qs.get('full') === '1') {
            return json(all, 200, { 'Cache-Control': 'no-store', 'X-Omni-Total': String(all.length) });
          }
          const limit = Math.max(1, Math.min(parseInt(limitRaw, 10) || OMNIA_MESSAGES_INITIAL, 500));
          let end = all.length;
          if (beforeId) {
            const idx = all.findIndex((m) => String(m && m.messageId) === beforeId);
            if (idx > 0) end = idx;   // 只返回这条之前的
          }
          const slice = all.slice(Math.max(0, end - limit), end);
          shimLog({ stage: 'session-messages-window', sid: String(sid).slice(0, 40), total: all.length, returned: slice.length, before: beforeId ? 1 : 0 });
          return json(slice, 200, { 'Cache-Control': 'no-store', 'X-Omni-Total': String(all.length), 'X-Omni-Window': String(slice.length) });
        }
        catch (e) { shimLog({ stage: 'session-messages-error', sid, err: String(e && e.message || e).slice(0, 160) }); return json({ error: 'session messages unavailable' }, 503); }
      }
      m = p.match(/^\/api\/agents\/chat\/status\/([^/]+)$/);
      // v2 状态位: {active, status, generationCreatedAt, generationProtocolVersion:2}
      // (客户端 fetchStreamStatus 用 supportsGenerationProtocolV2 判定; fork client/src/data-provider/SSE/protocol.ts:26)
      if (m) {
        const sid = decodeURIComponent(m[1]);
        if (!sidOk(sid)) return rejectSid(sid);
        const job = ownedJob(requestOwner, sid);
        if (!job && hasForeignJob(requestOwner, sid)) return json({ error: 'Generation stream not found', streamId: sid }, 404);
        const terminalStatus = !job || !job.done ? 'running'
          : job.aborted || job.finish === 'aborted' ? 'aborted'
            : !job.err && (isSuccessfulFinish(job.finish)
              || (job.preemptedBySteer === true && job.finish === 'interrupted_partial')) ? 'complete' : 'error';
        return json({
          active: !!(job && !job.done),
          status: job ? terminalStatus : 'complete',
          streamId: sid, conversationId: sid,
          generationCreatedAt: job ? job.createdAt : Date.now(), createdAt: job ? job.createdAt : undefined,
          aggregatedContent: job ? jobContent(job) : [],
          resumeState: job ? { runSteps: [], aggregatedContent: jobContent(job), conversationId: sid, responseMessageId: job.mid,
            userMessage: { messageId: job.pid, parentMessageId: job.pidParent, conversationId: sid, text: job.prompt },
            pendingSteers: pendingSteers(job), model: null, sender: 'OmniShade' } : undefined,
          generationProtocolVersion: 2,
        });
      }
      if (p === '/api/agents/chat/abort' && req.method === 'POST') {
        // AbortStreamResponse = {success, aborted?, streamId?, settled?, generationProtocolVersion?}
        // (client/src/data-provider/SSE/mutations.ts:17)
        const key = String((body && (body.streamId || body.conversationId)) || '');
        if (key && !sidOk(key)) return rejectSid(key);
        const job = key ? ownedJob(requestOwner, key) : null;
        if (!job && key && hasForeignJob(requestOwner, key)) return json({ error: 'Generation stream not found', streamId: key }, 404);
        if (body.generationCreatedAt != null && (!Number.isSafeInteger(body.generationCreatedAt) || body.generationCreatedAt < 0)) return json({ code: 'INVALID_GENERATION_IDENTITY', generationProtocolVersion: 2 }, 400);
        if (job && body.generationCreatedAt != null && job.createdAt !== body.generationCreatedAt) return json({ code: 'RUN_REPLACED', generationProtocolVersion: 2 }, 409);
        cancelQueuedSteers(job, () => true);
        if (job && !job.done) {
          job.aborted = true; job.preemptedBySteer = false;
          if (job.kill) { try { job.kill(); } catch (_) {} }
          if (!job.loopActive) jobFinalize(job, true);
        }
        return json({ success: true, aborted: job ? key : undefined, settled: !job || job.done, streamId: key || undefined, generationProtocolVersion: 2 });
      }
      // Literal controls precede /chat/:endpoint; otherwise /steer starts a
      // normal generation and /queued-turns POST silently loses the message.
      const isQueuedTurnPost = p === '/api/agents/chat/queued-turns' && req.method === 'POST';
      if ((p === '/api/agents/chat/steer' && req.method === 'POST') || isQueuedTurnPost) {
        const input = isQueuedTurnPost ? { ...body, clientSteerId: body.clientRequestId, generationCreatedAt: body.expectedPredecessorCreatedAt } : body;
        const sid = input && input.conversationId;
        if (!sidOk(sid) || sid === 'new') return rejectSid(sid);
        if (isQueuedTurnPost && (typeof input.clientRequestId !== 'string' || typeof input.parentMessageId !== 'string' || !input.parentMessageId)) return json({ code: 'INVALID_QUEUED_TURN' }, 400);
        if (typeof input.text !== 'string' || !input.text.trim()) return json({ code: 'EMPTY_TEXT', generationProtocolVersion: 2 }, 400);
        if (input.text.length > 16000) return json({ code: 'STEER_TOO_LONG', generationProtocolVersion: 2 }, 413);
        if (input.clientSteerId != null && (typeof input.clientSteerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.clientSteerId))) return json({ code: 'INVALID_CLIENT_STEER_ID' }, 400);
        if (input.generationCreatedAt != null && (!Number.isSafeInteger(input.generationCreatedAt) || input.generationCreatedAt < 0)) return json({ code: 'INVALID_GENERATION_IDENTITY' }, 400);
        if (isQueuedTurnPost && input.generationCreatedAt == null) return json({ code: 'INVALID_GENERATION_IDENTITY' }, 400);
        // Unsupported context must fall back to the client's normal queued
        // send, not be acknowledged and discarded (useSteering.ts:1747).
        if (['files', 'quotes', 'manualSkills'].some((key) => input[key] != null && (!Array.isArray(input[key]) || input[key].length)) || input.priority === true) {
          return json({ code: isQueuedTurnPost ? 'QUEUED_TURNS_UNSUPPORTED' : 'STEER_UNSUPPORTED', generationProtocolVersion: 2 }, 501);
        }
        const job = ownedJob(requestOwner, sid);
        if (!job && hasForeignJob(requestOwner, sid)) return json({ error: 'Generation stream not found' }, 404);
        const prior = job && input.clientSteerId && job.steering.receipts.get(input.clientSteerId);
        if (prior && (prior.receipt.text !== input.text
          || (input.generationCreatedAt != null && input.generationCreatedAt !== (isQueuedTurnPost ? prior.receipt.expectedPredecessorCreatedAt : prior.receipt.generationCreatedAt))
          || (isQueuedTurnPost && input.parentMessageId !== prior.receipt.parentMessageId))) {
          return json({ code: 'STEER_ID_CONFLICT', generationProtocolVersion: 2 }, 409);
        }
        if (!prior && (!job || job.done)) return json({ code: isQueuedTurnPost ? 'QUEUED_TURNS_UNSUPPORTED' : 'NO_ACTIVE_RUN', generationProtocolVersion: 2 }, isQueuedTurnPost ? 501 : 409);
        if (!prior && job.aborted && !isQueuedTurnPost) return json({ code: 'RUN_ABORTING', generationProtocolVersion: 2 }, 409);
        // A server-admitted B may already own the stream while the mounted
        // composer still carries A's queue anchor. Accept only a follow-up
        // bound to B's exact admitted A receipt; a stale steer or unrelated
        // parent/epoch remains fenced to the current generation.
        const admittedParent = job.queuedTurn;
        const verifiedLineage = job.queuedTurnLineage;
        const currentQueueRoot = (input.generationCreatedAt == null || input.generationCreatedAt === job.createdAt)
          && (!isQueuedTurnPost || input.parentMessageId === job.mid || input.parentMessageId === job.clientQueueParentMessageId)
          ? { createdAt: job.createdAt, parentMessageIds: [job.mid, job.clientQueueParentMessageId].filter(Boolean) }
          : null;
        const inheritedQueueRoot = isQueuedTurnPost && verifiedLineage?.createdAt === input.generationCreatedAt
          && verifiedLineage.parentMessageIds.includes(input.parentMessageId) ? verifiedLineage : null;
        const verifiedQueueLineage = currentQueueRoot || inheritedQueueRoot;
        const continuesAdmittedLineage = isQueuedTurnPost && input.preempt !== true && admittedParent?.status === 'admitted'
          && !!inheritedQueueRoot;
        if (!prior && isQueuedTurnPost && input.generationCreatedAt === job.createdAt && !verifiedQueueLineage) {
          return json({ code: 'RUN_REPLACED', generationProtocolVersion: 2 }, 409);
        }
        if (!prior && input.generationCreatedAt != null && input.generationCreatedAt !== job.createdAt && !continuesAdmittedLineage) {
          return json({ code: 'RUN_REPLACED', generationProtocolVersion: 2 }, 409);
        }
        if (!prior && job.steering.queue.length >= STEER_QUEUE_LIMIT) return json({ code: 'STEER_QUEUE_FULL', generationProtocolVersion: 2 }, 429);
        if (!prior) {
          try { saveUserSystemPrompt(input, requestOwner); }
          catch (e) { return json({ error: e.message, code: 'USER_SYSTEM_PROMPT_SAVE_FAILED' }, e.status || 500); }
        }
        const result = queueSteer(job, input, verifiedQueueLineage);
        if (result.code) return json({ code: result.code, generationProtocolVersion: 2 }, 429);
        const item = result.item, position = job.steering.queue.indexOf(item) + 1;
        if (!result.replayed && input.preempt === true) preemptForSteer(job, item, 'token');
        if (isQueuedTurnPost) return json({ queued: true, receipt: queuedTurnView(item, position),
          capability: { supported: true, durability: 'process_local' }, generationProtocolVersion: 2 }, 202, PROTO);
        return json({ status: 'queued', queued: true, mode: input.preempt === true ? 'interrupt_follow_up' : 'follow_up',
          preempt: item.receipt.preempt === true, preemptRevision: Number(item.receipt.preemptRevision || 0),
          steerId: item.receipt.steerId, position, conversationId: sid,
          generationCreatedAt: item.receipt.generationCreatedAt, generationProtocolVersion: 2,
          replayed: result.replayed, settled: item.receipt.status !== 'queued' }, 202, PROTO);
      }
      if ((p === '/api/agents/chat/steer/cancel' || p === '/api/agents/chat/steer/arm') && req.method === 'POST') {
        const sid = body && body.conversationId;
        if (!sidOk(sid) || sid === 'new') return rejectSid(sid);
        if (body.generationCreatedAt != null && (!Number.isSafeInteger(body.generationCreatedAt) || body.generationCreatedAt < 0)) return json({ code: 'INVALID_GENERATION_IDENTITY' }, 400);
        const job = ownedJob(requestOwner, sid);
        if (!job && hasForeignJob(requestOwner, sid)) return json({ error: 'Generation stream not found' }, 404);
        const matches = (r) => (body.generationCreatedAt == null || r.generationCreatedAt === body.generationCreatedAt || (job && job.createdAt === body.generationCreatedAt))
          && (body.steerId == null || r.steerId === body.steerId)
          && (body.clientSteerId == null || r.clientSteerId === body.clientSteerId);
        if (p.endsWith('/arm')) {
          if (typeof body.steerId !== 'string' || !body.steerId) return json({ code: 'INVALID_STEER_ID' }, 400);
          const item = job && job.steering.queue.find((entry) => matches(entry.receipt));
          // A queued receipt can outlive its A run and remain in B's shared
          // FIFO. Arm is a control on the ACTIVE run, unlike cancel: both the
          // request and the receipt must name that run before interrupting it.
          const sameRun = !!item && body.generationCreatedAt === job.createdAt
            && item.receipt.generationCreatedAt === job.createdAt;
          const armed = sameRun && preemptForSteer(job, item, 'arm');
          return json({ armed, queued: !!item, code: armed ? undefined : item && !sameRun ? 'RUN_REPLACED' : 'STEER_NOT_QUEUED',
            preemptRevision: item ? Number(item.receipt.preemptRevision || 0) : undefined,
            generationProtocolVersion: 2 });
        }
        const removedCount = cancelQueuedSteers(job, matches);
        return json({ success: true, removed: removedCount > 0, removedCount, generationProtocolVersion: 2 });
      }
      if (p === '/api/agents/chat/queued-turns' && req.method === 'GET') {
        const sid = u.searchParams.get('conversationId');
        if (!sidOk(sid) || sid === 'new') return rejectSid(sid);
        const job = ownedJob(requestOwner, sid), state = job && job.steering;
        if (!job && hasForeignJob(requestOwner, sid)) return json({ error: 'Generation stream not found' }, 404);
        const known = new Set(u.searchParams.getAll('clientRequestIds'));
        const queued = state ? [...state.receipts.values()].filter((item) => item.receipt.status === 'queued' || item.receipt.status === 'dead' || known.has(item.receipt.clientRequestId)) : [];
        return json({ queuedTurns: queued.map((item) => queuedTurnView(item, state.queue.indexOf(item) + 1)),
          has_more: false, count: queued.length, pendingCount: state ? state.queue.length : 0, revision: state ? state.revision : 0,
          capability: { supported: true, durability: 'process_local' }, generationProtocolVersion: 2 });
      }
      const queuedDelete = p.match(/^\/api\/agents\/chat\/queued-turns\/([^/]+)$/);
      if (queuedDelete && req.method === 'DELETE') {
        const id = decodeURIComponent(queuedDelete[1]);
        for (const job of jobs.values()) {
          if (job.owner !== requestOwner) continue;
          const item = [...job.steering.receipts.values()].find((entry) => entry.receipt.queuedTurnId === id);
          if (!item) continue;
          cancelQueuedSteers(job, (r) => r.queuedTurnId === id);
          return json({ receipt: queuedTurnView(item), generationProtocolVersion: 2 });
        }
        return json({ code: 'QUEUED_TURN_NOT_FOUND' }, 404);
      }
      if (p === '/api/agents/chat/queued-turns') return json({ code: 'QUEUED_TURNS_UNSUPPORTED' }, 501);
      if (p === '/api/agents/chat/resume') return json({ success: false, code: 'RESUME_UNSUPPORTED', error: '本地不支持暂停恢复；排队引导会在本轮结束后自动续跑', generationProtocolVersion: 2 });

      // ── 生成(v2 可续流协议) ──
      // fork 依据:
      //  · client/src/data-provider/SSE/protocol.ts: GENERATION_PROTOCOL_VERSION=2;
      //    postGenerationRequest 用 authenticatedFetch POST 并 JSON.parse(await response.text()) → 启动请求必须回 JSON。
      //  · client/src/hooks/SSE/useAdaptiveSSE.ts: 非 assistants 端点一律走 useResumableSSE(即 v2)。
      //  · client/src/hooks/SSE/useResumableSSE.ts:3924 startGeneration 期待
      //    {streamId, conversationId, generationCreatedAt:number, generationProtocolVersion:2, status?};
      //    :1881 之后订阅 GET /api/agents/chat/stream/<streamId>?generationProtocolVersion=2 拿 SSE 帧。
      //  → 本地把"生成"做成 job: POST 建 job 回 JSON ack, 帧先进 job.frames 再推给订阅者(支持续订重放)。
      if (/^\/api\/agents\/chat(\/[^/]+)?$/.test(p) && req.method === 'POST') {
        const prompt = extractPrompt(body);
        const bodySid = body.conversationId == null ? '' : String(body.conversationId);
        if (bodySid && bodySid !== 'new' && !sidOk(bodySid)) return rejectSid(bodySid);   // H1: sid 白名单(写路径, 防 ../ 落盘)
        // 新会话在客户端侧 conversationId 为 null/'new'(useChatFunctions.ts:488 起), 本地自建 id
        const sid = (bodySid && bodySid !== 'new') ? bodySid
          : 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const reqModel = body.model !== undefined && body.model !== null && body.model !== '' ? body.model : (body.spec ?? '');
        const hasReqModel = reqModel !== undefined && reqModel !== null && reqModel !== '';
        const requestProvider = activeProviderModels();
        const agentModel = hasReqModel ? '' : modelForLocalAgent(requestProvider, body.agent_id || body.agentId);
        let defaultModel = '';
        try { defaultModel = require('./model_selection').selectModel(requestProvider, undefined, getSettings() || {}); } catch (_) {}
        const rememberedModel = sidModel.get(modelKey(sid));
        const effectiveModel = (hasReqModel ? reqModel : agentModel) || rememberedModel || defaultModel;
        const modelSource = hasReqModel ? 'body' : agentModel ? 'agent_id' : rememberedModel ? 'conversation' : defaultModel ? 'provider_default' : 'unbound';
        if (effectiveModel) sidModel.set(modelKey(sid), effectiveModel);
        // [CHAT-MODEL] 在 POST 即绑定当前 provider：缺省取默认目录项，agent_id 反解其对应模型。
        shimLog({ stage: 'chat-post', sid, provider: requestProvider && requestProvider.name || '', model: effectiveModel || '(default)',
          modelSource, keys: Object.keys(body || {}).slice(0, 14).join(',') });
        const wantsV2 = String(body.generationProtocolVersion || '') === '2'
          || String(req.headers['x-librechat-generation-protocol'] || '') === '2';
        const running = ownedJob(requestOwner, sid);
        if (running && (!running.done || running.loopActive)) {
          // M6 单飞: 同会话并发 POST 直接拒绝(与 main.js:516 'chatAbort 存在 → 上一条仍在生成中' 语义对齐)
          shimLog({ stage: 'gen-inflight-reject', sid });
          return json({ error: '上一条仍在生成中', code: 'GENERATION_IN_FLIGHT', streamId: sid, conversationId: sid, generationProtocolVersion: 2 }, 409);
        }
        try { saveUserSystemPrompt(body, requestOwner); }
        catch (e) { return json({ error: e.message, code: 'USER_SYSTEM_PROMPT_SAVE_FAILED' }, e.status || 500); }
        let historyPlan;
        try { historyPlan = prepareHistoryEdit(sid, body, requestOwner); }
        catch (e) { return json({ error: e.message, code: 'HISTORY_EDIT_REJECTED' }, e.status || 500); }
        const job = newJob(sid, prompt, requestOwner, historyPlan);
        // The mounted fork queues against its optimistic user ID until the
        // created/final SSE replaces that row with the durable assistant ID.
        // Bind that ID to this POST, never learn it from a queued-turn request.
        job.clientQueueParentMessageId = typeof body.messageId === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(body.messageId)
          ? body.messageId : null;
        job.model = effectiveModel || ''; // POST 已绑定 provider；jobStart 再按同一目录校验，显式非法值仍原样报错。
        // [1.1.35] 附件: ①桥可读**相对路径**(绝对路径被 bridge safePath 硬挡) ②文本内联 ③图片走多模态
        try {
          const refs = Array.isArray(body.files) ? body.files : [];
          if (refs.length) {
            const lines = [];
            const atts = [];
            for (const r of refs) {
              const fid = String((r && (r.file_id || r.fileId)) || r || '');
              if (!fid) continue;
              const fp3 = await findUpload(fid);
              if (!fp3) continue;
              const base = path.basename(fp3);
              const name = base.includes('__') ? base.slice(base.indexOf('__') + 2) : base;
              const ext = path.extname(name).toLowerCase();
              const rel = fp3;   // [1.1.35 实测] 桥对「白名单根内」的**绝对路径**放行(uploads 在 PRODUCT_DIR 内), 相对路径反被重定到 WORKROOT→ENOENT
              const isImg = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext);
              const isTxt = ['.txt', '.md', '.json', '.csv', '.log', '.yml', '.yaml', '.xml', '.html', '.js', '.ts', '.py', '.sh', '.ps1', '.ini', '.conf', '.sql', '.c', '.cpp', '.h', '.java', '.go', '.rs'].includes(ext);
              let info = '- ' + name + ' (本机路径, 可直接 fs_read: ' + rel + ')';
              try {
                const st = fs.statSync(fp3);
                info += ' [' + Math.round(st.size / 1024) + 'KB]';
                if (isTxt && st.size <= 256 * 1024) {
                  const txt = fs.readFileSync(fp3, 'utf8').slice(0, 65536);
                  info += '\n```' + (ext.replace('.', '') || 'text') + '\n' + txt + '\n```';
                }
              } catch (_) {}
              lines.push(info);
              atts.push({ path: fp3, name, mime: isImg ? ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' }[ext]) : 'text/plain' });
            }
            if (lines.length) {
              job.promptForAgent = prompt + '\n\n[附件(已落盘到本机; 文本已内联, 图片随消息多模态送达; 需要时可用 fs_read 按桥内可读路径读取)]\n' + lines.join('\n');
              job.attachments = atts;
            }
          }
        } catch (_) {}
        if (!wantsV2) {
          // 旧客户端/直连自测: 在本响应上直接回 SSE(与 v1 行为一致)
          sendSseHead(res);
          let closed = false;
          const w = jobWriter(res, () => closed);
          if (job.subs) job.subs.add(w);
          req.on('close', () => { closed = true; if (job.subs) job.subs.delete(w); });
          jobStart(job);
          return;
        }
        json({ status: 'started', streamId: sid, conversationId: sid, generationCreatedAt: job.createdAt, generationProtocolVersion: 2 });
        setTimeout(() => jobStart(job), 0);
        return;
      }
      // v2: 订阅生成流(客户端 useResumableSSE.ts:1881 用 GET; 支持 resume=true 重放)
      let jm = p.match(/^\/api\/agents\/chat\/stream\/([^/]+)$/);
      if (jm && req.method === 'GET') {
        const streamId = decodeURIComponent(jm[1]);
        if (!sidOk(streamId)) return rejectSid(streamId);
        const job = ownedJob(requestOwner, streamId);
        if (!job) { status = 404; return json({ error: 'Generation stream not found', streamId }, 404); }
        const epoch = u.searchParams.get('generationCreatedAt');
        if (epoch != null && (!/^[0-9]+$/.test(epoch) || !Number.isSafeInteger(Number(epoch)))) return json({ code: 'INVALID_GENERATION_IDENTITY', generationProtocolVersion: 2 }, 400);
        if (epoch != null && Number(epoch) !== job.createdAt) {
          sendSseHead(res, PROTO);
          res.write(sseFrame('message', { final: true, reconcile: true, reconcileReason: 'queued_follow_up',
            terminalStatus: 'complete', conversation: { conversationId: streamId },
            generationCreatedAt: Number(epoch), generationProtocolVersion: 2 }));
          endSse(res); return;
        }
        sendSseHead(res, { 'X-LibreChat-Generation-Protocol': '2' });
        let closed = false;
        const isResume = u.searchParams.get('resume') === 'true';
        if (isResume) {
          // LibreChat native resume contract: one authoritative SYNC snapshot,
          // followed only by events created after that snapshot boundary. Replaying
          // old deltas after aggregatedContent duplicates the same text at a new
          // content index in the reducer.
          const runSteps = [];
          const seenSteps = new Set();
          for (const frame of (job.frames || [])) {
            if (!frame || frame.event !== 'on_run_step' || !frame.data || !frame.data.id || seenSteps.has(frame.data.id)) continue;
            seenSteps.add(frame.data.id); runSteps.push(frame.data);
          }
          const resumeState = {
            runSteps,
            aggregatedContent: jobContent(job),
            conversationId: streamId,
            responseMessageId: job.mid,
            userMessage: { messageId: job.pid, parentMessageId: job.pidParent, conversationId: streamId, text: job.prompt },
            pendingSteers: pendingSteers(job), model: null, sender: 'OmniShade',
          };
          try { res.write(sseFrame('message', { sync: true, resumeState, pendingEvents: [], generationCreatedAt: job.createdAt, generationProtocolVersion: 2 })); } catch (_) {}
          if (job.done) {
            const finalFrame = (job.frames && job.frames.length ? [...job.frames].reverse().find((frame) => frame && frame.final === true) : null) || job.finalFrame || null;
            if (finalFrame) { try { res.write(sseFrame('message', finalFrame)); } catch (_) {} }
            endSse(res); return;
          }
        } else {
          for (const f of (job.frames || [])) { try { res.write(sseFrame('message', f)); } catch (_) {} }   // 首次订阅补齐 POST→GET 之间的帧
          if (job.done) { endSse(res); return; }
        }
        const w = jobWriter(res, () => closed);
        if (job.subs) job.subs.add(w);
        req.on('close', () => { closed = true; if (job.subs) job.subs.delete(w); });
        return;
      }

      // 标题轮询: GET /api/convos/gen_title/:conversationId → {title}(api/server/routes/convos.js:223)
      let gm = p.match(/^\/api\/convos\/gen_title\/([^/]+)$/);
      if (gm) {
        const sid = decodeURIComponent(gm[1]);
        if (!sidOk(sid)) return rejectSid(sid);
        const msgs = ag ? sessionMessages(ag, sid) : [];
        const firstUser = msgs.find((x) => x.isCreatedByUser);
        return json({ title: (firstUser && String(firstUser.text || '').slice(0, 60)) || '本地会话' });
      }

      status = 404;
      return json({ error: 'shim: unhandled ' + req.method + ' ' + p }, 404);
    } catch (e) {
      status = 500;
      shimLog({ stage: 'handler-error', url: req.url, err: String(e && e.stack || e).slice(0, 300) });
      try {
        if (!res.headersSent && !res.writableEnded) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(e && e.message || e) }));
        }
      } catch (_) {}
    } finally {
      shimLog({ method: req.method, url: String(req.url).slice(0, 200), status });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(o.port || 0, '127.0.0.1', () => {
      const port = server.address().port;
      boundPort = port;                                        // H1: Host/Origin 校验依赖实际监听端口
      shimLog({ stage: 'listen', port, mock, auth: true });
      resolve({ server, port, token: TOKEN, url: 'http://127.0.0.1:' + port, close: () => new Promise((r) => server.close(r)), hasActiveJobs: () => { try { return [...jobs.values()].some((j) => !j.done); } catch (_) { return false; } } });
    });
  });
}

module.exports = { startUiShim, UI_DIR, SHIM_LOG, SID_RE, sessionPath, sidOk, bootstrapJs };
