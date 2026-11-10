// OmniShade 本机操作桥 v2 — 本地 MCP server（对标 omni-mcp http_main 模式）
// 安全模型:
//   - 只监听 127.0.0.1 (HK relay 经反向隧道到达这里)
//   - Bearer token 鉴权(进程级随机令牌，私有 IPC 交给主程序，/health 除外)
//   - 命令白名单(只读侦查类) + 写保护正则 + 路径 confinement + 50MB 写入上限
//   - 全程审计 %APPDATA%/omnishade/bridge_audit.jsonl (字段对齐服务端 mcp_audit.jsonl: ts/decision/path/size)
// HTTP API: POST /call {tool,args}(兼容) | POST /mcp JSONRPC(initialize/tools/list/tools/call) | POST /upload | GET /health
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const { execFile, spawn } = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');
const { Transform, pipeline } = require('stream');
const { pinnedTlsOptions } = require('./omni_tls');
const KB_FTS = require('./kb_fts');   // [EKB-FTS] E 盘知识库 FTS5 检索核心(引用式, 不拷贝)
const loot = require('./ui_shim_loot');   // [LOOT-MCP 2026-11-07] lootchain 攻击链核心层（与 ui_shim 同源单例）
const weapons = require('./ui_shim_weapons');   // [WEAPON-MCP 2026-11-08] 统一武器线核心层（registry 扫描 + job 模型，与 loot 同源模式）
const MiniSearchModule = require('./node_modules/minisearch/dist/cjs/index.cjs');
const MiniSearch = MiniSearchModule.default || MiniSearchModule;

const APPDATA_DIR = path.join(process.env.APPDATA || os.homedir(), 'omnishade');
const ACCOUNT_PATH = path.join(APPDATA_DIR, 'account.json');
const AUDIT = path.join(APPDATA_DIR, 'bridge_audit.jsonl');
const WORKROOT = process.env.OMNI_WORKROOT || path.join(os.homedir(), 'OmniShade');
const MAX_UPLOAD_BYTES = Math.max(1024 * 1024, Math.min(parseInt(process.env.OMNI_BRIDGE_MAX_UPLOAD_BYTES || String(128 * 1024 * 1024), 10) || 128 * 1024 * 1024, 512 * 1024 * 1024));
const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;
// [G81] 知识库服务端 token。客户端一律经 HK(9443) 调 /kb/*，数据侧(E盘)由反向隧道供给。
// 优先级：env OMNI_KB_TOKEN > %APPDATA%/omnishade/config.json 的 kb_token > 内置。
// 内置值只能防误连，不构成机密（二进制可被逆向），真正的边界在 HK nginx + 数据端权限。
const KB_REMOTE_TOKEN = process.env.OMNI_KB_TOKEN || (function () {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(APPDATA_DIR, 'config.json'), 'utf8'));
    if (c && typeof c.kb_token === 'string' && c.kb_token) return c.kb_token;
  } catch (_) {}
  return 'YagIFon0SQ75wd_cA8qHuNdKFzjv-NKikNcRWEVFo6eUBqQB';
})();
// [G81] E:\KnowledgeBase 真实顶层目录（2026-11-02 实测 34 个）。数据端 kb_server 返回真实相对路径，
// 这些前缀是唯一允许从服务端透传的路径面；scope 分组与 kb_server.py 的 SCOPE_PREFIXES 保持一致。
const KB_SCOPE_TG = ['03-TG内容', '32-TG与Tor资源', '12-Tor渠道资源'];
const KB_SCOPE_PRODUCT = ['05-技能库', '06-知识库全文', '90-知识库切片', '29-技术wiki与手册', '15-安全资料包'];
const KB_REAL_SCOPES = ['01-渗透测试', '01-漏洞库', '01-开源安全库', '04-漏洞平台知识库', '10-CVE漏洞数据库',
  '11-ExploitDB', '28-漏洞情报库', '34-逆向工程', '02-老K本地知识库', '09-安全工具库', '18-额外工具库',
  '22-大规模工具库', '24-Kali全量池', '33-Debian安全包池', '31-GitHub深度发现', '35-GitHub全量池',
  '14-安全研究论文', '26-安全会议资料', '13-安全数据集',
  '03-TG内容', '32-TG与Tor资源', '12-Tor渠道资源',
  '05-技能库', '06-知识库全文', '90-知识库切片', '29-技术wiki与手册', '15-安全资料包'];
const KB_SCOPE_REDTEAM = KB_REAL_SCOPES.filter(function (x) {
  return !KB_SCOPE_TG.includes(x) && !KB_SCOPE_PRODUCT.includes(x);
});

const PORT = parseInt(process.env.OMNI_BRIDGE_PORT || '9431');
// 权限模型: 默认 sandbox=最小权限; 只有显式配置 full 才放开工作区外操作。
// 来源优先级: env OMNI_PERM_MODE > %APPDATA%/omnishade/config.json 的 perm_mode > 内置默认 sandbox。
// full 下仅保留两条硬线: DISASTER_GUARD(磁盘毁灭) + denylist(凭据文件), 其余路径闸全部放行。
// [G69] 返回 { mode, source }: source 必须如实反映"这个有效值是谁给的",
// 否则 /health 只有一个 perm_mode 字段时无法区分"配置就是 full"还是"env 注入了却被吃掉"。
function loadPermMode() {
  // [G69 修复] 主进程把"生效值 + 来源"一起下发(OMNI_PERM_MODE / OMNI_PERM_MODE_SOURCE)。
  // 主进程一旦把 config/default 的值写进 OMNI_PERM_MODE, 本进程就再也分不清"真的是 env 给的"还是
  // "主进程代填的" —— 所以来源必须以主进程声明为准; 裸启动(无该变量)时才按本进程视角自行推断。
  const declared = String(process.env.OMNI_PERM_MODE_SOURCE || '').trim().toLowerCase();
  const DECLARED = (declared === 'env' || declared === 'config' || declared === 'default' || declared === 'config-invalid') ? declared : '';
  // [2026-10-31 修复] env 统一到 OMNI_PERM_MODE。历史遗留/误写的 OMNI_BRIDGE_PERM* 作为别名兼容并告警,
  // 杜绝"注入了环境变量却静默失效"(此前注入 OMNI_BRIDGE_PERM 完全没被读取, 直接掉到 config 的 full)。
  const PERM_ENVS = ['OMNI_PERM_MODE', 'OMNI_BRIDGE_PERM', 'OMNI_BRIDGE_PERM_MODE'];
  for (const k of PERM_ENVS) {
    const raw = String(process.env[k] || '').trim().toLowerCase();
    if (!raw) continue;                       // 未设置: 继续找下一个候选
    if (raw === 'full' || raw === 'sandbox') {
      if (k !== 'OMNI_PERM_MODE') console.warn('[perm] 废弃变量 ' + k + ' 已兼容接管, 请改用 OMNI_PERM_MODE (本次按 ' + raw + ' 生效)');
      return { mode: raw, source: DECLARED || 'env' };
    }
    // 非空但非法值: 不静默忽略, 明确提示(否则配错变量名的现场永远查不出来)
    console.warn('[perm] 非法值 ' + k + '=' + JSON.stringify(raw) + ', 仅接受 full|sandbox, 已忽略');
  }
  // omni 配置两处: %APPDATA%/omnishade/config.json 与应用 userData %APPDATA%/omnishade-desktop/config.json
  const cfgPaths = [
    path.join(APPDATA_DIR, 'config.json'),
    path.join(process.env.APPDATA || os.homedir(), 'omnishade-desktop', 'config.json'),
  ];
  for (const cp of cfgPaths) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cp, 'utf8'));
      const m = String(cfg.perm_mode || cfg.PERM_MODE || '').trim().toLowerCase();
      if (m === 'full' || m === 'sandbox') {
        console.warn('[perm] 来自配置文件 ' + cp + ' -> ' + m + ' (env OMNI_PERM_MODE 优先, 未设置时生效)');
        return { mode: m, source: DECLARED || 'config' };
      }
    } catch (_) {}
  }
  return { mode: 'sandbox', source: DECLARED || 'default' };
}
const PERM_MODE_INFO = loadPermMode();
const PERM_MODE = PERM_MODE_INFO.mode;
const PERM_MODE_SOURCE = PERM_MODE_INFO.source;
// full 模式下 'TRAVERSAL(cross-drive/UNC)'(绝对路径) 属于 sandbox 的路径闸, 不该误杀 full 的显式放行分支;
// 凭据类 denylist 与 '..' 穿越在两种模式下均保持硬挡。
// [G15 加固] 凭据类判定必须与「full 放行绝对路径」解耦: 先单独跑 kbDenyCred, 命中即返回(full 也不豁免);
// 只有纯路径形态(盘符/UNC)才按模式豁免 —— 修掉「full 模式写 KEYS_PLAINTEXT.txt 漏拦」。
// '..' 穿越属于形态类但不豁免: 与 kbDenyTraversal 内部语义一致(两种模式都硬挡)。
function kbDenyHard(inputPath) {
  const cred = kbDenyCred(inputPath);
  if (cred) return cred;                         // 凭据/敏感本体: full 也硬挡
  const trav = kbDenyTraversal(inputPath);
  if (!trav) return '';
  if (PERM_MODE === 'full' && trav === 'TRAVERSAL(cross-drive/UNC)') return '';   // full: 绝对路径是显式放行形态
  return trav;
}
// [G7-R3 修复] kbDenyHit 的 'TRAVERSAL(cross-drive/UNC)' 是「用户输入形态」判定: 任何带盘符/UNC 前缀的
// 路径都命中。但 safePath 后半段喂进去的是 path.resolve()/fs.realpathSync() 的产物 —— 必然是绝对路径,
// 于是恒定命中 → fs_read/fs.list/fs.hash/local_fs_search 全量 400 SCOPE_BLOCKED(整条工作区读链路死掉)。
// 解析产物只保留凭据类与 '..' 硬线; 盘符/UNC 形态一律放行, 越界已由上面的 containment + symlink 校验拦下。
function kbDenyResolved(absPath) {
  const n = String(absPath || '').replace(/\\/g, '/').toLowerCase();
  const rel = n.replace(/^[a-z]:\//, '').replace(/^\/\//, '');   // 剥盘符/UNC 前缀, 段级 denylist 照旧生效
  // [G15 加固] 凭据类先判且直接返回: 解析产物是绝对路径, 形态判定对它没有意义,
  // 凭据硬线必须由 kbDenyCred 独立保证(此前依赖 kbDenyHit 内部顺序, 顺序一变就漏)。
  const cred = kbDenyCred(rel);
  if (cred) return cred;
  const trav = kbDenyTraversal(rel);
  return trav === 'TRAVERSAL(cross-drive/UNC)' ? '' : trav;      // 双保险: 剥完仍是穿越形态则放行(已过 containment)
}
const ALLOWED_ORIGINS = ['https://103.117.136.137:9444']; // 仅聊天域名; 不再 ACAO *

// An application bridge owns a fresh in-memory bearer per process. The existing
// private ready IPC gives it to the parent; no HWID or persisted bearer is used.
function loadToken() {
  const supplied = process.env.OMNI_LOCAL_BRIDGE_TOKEN;
  delete process.env.OMNI_LOCAL_BRIDGE_TOKEN;
  if (supplied !== undefined) {
    if (!/^[A-Za-z0-9_-]{24,256}$/.test(supplied)) throw new Error('invalid bridge token');
    return supplied;
  }
  return crypto.randomBytes(32).toString('hex');
}
const TOKEN = loadToken();

// ── 审计: 字段对齐服务端 mcp_audit.jsonl (ts=unix秒, decision=EXEC/FS_SAVE/FS_SEARCH/SCOPE_BLOCKED/…) ──
const AUDIT_CONTEXT = new AsyncLocalStorage();
const CORRELATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
function callCorrelation(body) {
  const src = body && typeof body === 'object' ? body : {};
  const meta = src.meta && typeof src.meta === 'object' ? src.meta : {};
  const nonce = crypto.randomBytes(12).toString('hex');
  const pick = (snake, camel, fallback) => {
    const value = src[snake] !== undefined ? src[snake]
      : (src[camel] !== undefined ? src[camel]
        : (meta[snake] !== undefined ? meta[snake] : meta[camel]));
    return typeof value === 'string' && CORRELATION_ID_RE.test(value) ? value : fallback;
  };
  return {
    run_id: pick('run_id', 'runId', 'bridge_run_' + nonce),
    session_id: pick('session_id', 'sessionId', 'bridge_session_' + nonce),
    agent_id: pick('agent_id', 'agentId', 'bridge_agent_' + nonce),
    tool_call_id: pick('tool_call_id', 'toolCallId', 'bridge_tool_' + nonce),
  };
}
function audit(rec) {
  try {
    fs.mkdirSync(path.dirname(AUDIT), { recursive: true });
    const correlation = AUDIT_CONTEXT.getStore() || {};
    fs.appendFileSync(AUDIT, JSON.stringify(Object.assign({ ts: Math.floor(Date.now() / 1000) }, rec, correlation)) + '\n');
  } catch (_) {}
}

let _REAL_ROOT = null;
function getRealRoot() {
  if (_REAL_ROOT) return _REAL_ROOT;
  try { _REAL_ROOT = fs.realpathSync(path.resolve(WORKROOT)); }
  catch (_) { _REAL_ROOT = path.resolve(WORKROOT); }
  return _REAL_ROOT;
}

function safePath(rel) {
  const raw = String(rel || '').trim();
  if (!raw) throw new Error('TOOL_ERROR: path 参数为空(必填)');
  const dec = kbDecode(raw); // URL 编码变体循环解码后判定
  // denylist(凭据文件)是 full/sandbox 共同硬线, 优先于模式判定(无论路径形式一律命中)
  const decN = dec.replace(/\\/g, '/').toLowerCase();
  // [G7-R3 修复] full 模式允许绝对路径(工具文档明确: full 支持任意路径), 不能拿 sandbox 的形态闸误杀;
  // sandbox 下 kbDenyHard 等价于 kbDenyHit → 绝对路径仍由下面 137 行的 sandbox 分支显式拒(消息更准)。
  const denyDec = kbDenyHard(decN);
  if (denyDec) {
    audit({ decision: 'SCOPE_BLOCKED', path_head: raw.slice(0, 60), deny: denyDec });
    throw new Error('SCOPE_BLOCKED: 命中 denylist(' + denyDec + '), 已硬挡');
  }
  if (PERM_MODE === 'sandbox') {
    const norm = dec.replace(/\\/g, '/').toLowerCase();
    // 绝对路径/UNC/设备路径/%ENV% 形式 → SCOPE_BLOCKED(不再静默 join 工作区, 2026-09-27 收紧)
    if (/^[a-zA-Z]:[\\/]/.test(dec) || /^\\\\/.test(dec) || /^%[a-zA-Z_]+%/.test(dec)) {
      audit({ decision: 'SCOPE_BLOCKED', path_head: raw.slice(0, 60) });
      throw new Error('SCOPE_BLOCKED: 绝对路径/%ENV% 形式已拒——当前为 sandbox 模式, 仅允许工作区内相对路径 ' + WORKROOT);
    }
    const p0 = path.resolve(WORKROOT, dec.replace(/^([a-zA-Z]:)?[\\/]+/, ''));
    const root = path.resolve(WORKROOT);
    if (p0 !== root && !p0.toLowerCase().startsWith(root.toLowerCase() + path.sep)) {
      audit({ decision: 'SCOPE_BLOCKED', path_head: raw.slice(0, 60) });
      throw new Error('SCOPE_BLOCKED: 路径越界被拒——当前为 sandbox 模式, 仅允许工作区 ' + root);
    }
    // [2026-10-29 巡检修复] 符号链接逃逸: path.resolve 不解析符号链接, 而 fs.readFileSync 会跟随符号链接读到工作区外。
    // 目标存在时必须对其真实路径再校验 containment(fail-closed); 不存在则走原逻辑(由上面的 .. 校验拦逃逸)。
    let realP = null;
    try { realP = fs.realpathSync(p0); } catch (_) { realP = null; }
    if (realP) {
      const realRoot = getRealRoot();
      if (realP !== realRoot && !realP.toLowerCase().startsWith(realRoot.toLowerCase() + path.sep)) {
        audit({ decision: 'SCOPE_BLOCKED', path_head: raw.slice(0, 60), deny: 'symlink-escape' });
        throw new Error('SCOPE_BLOCKED: 符号链接指向工作区外(' + realP.slice(0, 80) + '), 已拒绝');
      }
      // [G7-R3 修复] realP 是 realpath 产物(必为绝对路径) → 用 kbDenyResolved: 只保留凭据/.. 硬线
      const denyReal = kbDenyResolved(realP);
      if (denyReal) {
        audit({ decision: 'SCOPE_BLOCKED', path_head: raw.slice(0, 60), deny: denyReal });
        throw new Error('SCOPE_BLOCKED: 命中 denylist(' + denyReal + '), 已硬挡');
      }
      return realP;
    }
    return p0;
  }
  // 显式 full: 任意路径放行(绝对/越界/工作区外), 工具调用不因权限判定出错
  let p = dec;
  if (!/^[a-zA-Z]:[\\/]/.test(dec) && !dec.startsWith('\\\\') && !/^%[a-zA-Z_]+%/.test(dec)) p = path.resolve(WORKROOT, dec.replace(/^([a-zA-Z]:)?[\\/]+/, ''));
  else p = path.resolve(dec.replace(/^%([a-zA-Z_]+)%/, (m, v) => process.env[v] || m));
  // [G7-R3 修复] p 是 resolve 产物(绝对路径) → 同上: 盘符形态不再误杀, 凭据/.. 硬线保留
  const denyFull = kbDenyResolved(p);
  if (denyFull) {
    audit({ decision: 'SCOPE_BLOCKED', path_head: raw.slice(0, 60), deny: denyFull });
    throw new Error('SCOPE_BLOCKED: 命中 denylist(' + denyFull + '), 已硬挡');
  }
  return p;
}

// ── skills/KB 只读工具组: 白名单多根 + denylist 硬挡 (v1.1.11 工程-A) ──
const R1_BASE = path.join(os.homedir(), 'Desktop', 'TG工作包');
const R2_BASE = path.join(os.homedir(), 'Desktop', '聚合平台管理', '技能与知识库');
// [1.1.47] 知识库源迁移: 默认指向 服务器知识库内容(本机直接读取, 内容改动即时生效); 不存在则回退 R2
const KB_SOURCE_ROOT = process.env.OMNI_KB_SOURCE || path.join(os.homedir(), 'Desktop', '服务器知识库内容');
// [EKB] 源根可达性。不可达时知识库目录用一个永不存在的哨兵路径:
// 旧实现存在即回退 %APPDATA%/omnishade/kb(桌面副本), E 盘临时掉线会静默读到陈旧内容。
// 哨兵 = 所有 existsSync/readdir 自然返回空, 全链路优雅降级为"无结果", 不报错。
const KB_SOURCE_OK = !!KB_SOURCE_ROOT && path.isAbsolute(KB_SOURCE_ROOT) && fs.existsSync(KB_SOURCE_ROOT);
const R3_BASE = path.join(KB_SOURCE_ROOT, '红队知识库-全网');
const KB_SKILLS_ROOT = fs.existsSync(path.join(KB_SOURCE_ROOT, '技能与知识库')) ? path.join(KB_SOURCE_ROOT, '技能与知识库') : R2_BASE;
const KB_INDEX_CSV = path.join(KB_SKILLS_ROOT, '08-索引与工具', '技能总索引.csv');
const KB_INDEX_JSON = path.join(KB_SKILLS_ROOT, '08-索引与工具', '技能总索引.json');
const HERMES_SKILLS_DIR = path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'skills');
// [P] 产品自有库(资源包解包产物, 首次运行由 payload.js 落到 %APPDATA%/omnishade)
const PRODUCT_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'omnishade');
const PRODUCT_SKILLS_DIR = path.join(PRODUCT_DIR, 'skills');
// [EKB-FTS] 知识库目录直接挂 KB_SOURCE_ROOT 下: 不再拿 kb_index.db 当哨兵(索引重建/改名/热 journal
// 期间文件临时不可见, 旧逻辑会整库回退到桌面副本)。E 盘/源根不存在 → 哨兵目录, 全链路空结果不报错。
const PRODUCT_KB_DIR = KB_SOURCE_OK ? path.join(KB_SOURCE_ROOT, '知识库') : path.join(PRODUCT_DIR, '_kb_unavailable');
const PRODUCT_TOOLS_DIR = path.join(PRODUCT_DIR, 'tools');
const PRODUCT_SKILLS_INDEX = fs.existsSync(KB_INDEX_JSON) ? KB_INDEX_JSON : path.join(PRODUCT_DIR, 'skills_index.json');   // [1.1.48] 索引也指向知识库源(软件查这里)
const PRODUCT_TOOLS_INDEX = path.join(PRODUCT_TOOLS_DIR, 'tools_index.json');
// [KBMERGE 2026-11-08] D:\分析到的 本机资料库根: SKILL_ROOTS 白名单与 kb_search scope=analyzed 共用同一常量(单一事实源)
const ANALYZED_BASE = 'D:\\分析到的';
const SKILL_ROOTS = [
  { id: 'R1', base: R1_BASE, subs: ['04-技能经验', '06-脚本工具', 'tg情报', '红队知识库-全网', '_share'] },
  { id: 'R2', base: KB_SKILLS_ROOT, subs: ['01-本机Agent技能', '02-军火库GitHub528仓库', '03-CyberStrikeAI技能库', '05-其他安全项目技能', '08-索引与工具'] },
  { id: 'R3', base: R3_BASE, subs: [''] },   // [1.1.50] 原始全量大堆(82GB, 已迁入知识库之家)   // [1.1.47] 指向服务器知识库内容
  { id: 'hermes-skills', base: HERMES_SKILLS_DIR, subs: [''] },
  { id: 'P', base: PRODUCT_SKILLS_DIR, subs: [''] },
  { id: 'P-kb', base: PRODUCT_KB_DIR, subs: [''] },
  { id: 'P-tools', base: PRODUCT_TOOLS_DIR, subs: [''] },
  // [EKB-FTS] E 盘知识库根: FTS 命中的 path 是相对它的路径, 读原文(命中后想看全文件)时用它还原绝对路径
  { id: 'EKB', base: KB_SOURCE_ROOT, subs: [''] },
  // [ANALYZED-KB 2026-11-07] 老板桌面「老K」快捷方式指向的本机资料库(D:\分析到的,
  // 414MB / 10288 文件: 工具箱拆解/提示词/插件/skill 模板/协议算法)。挂进白名单后
  // AI 对话直接 fs_list/fs_read/local_fs_search 可查, 无需 HK 中转。
  { id: 'ANALYZED', base: ANALYZED_BASE, subs: [''] },
];
// 展开为允许前缀清单(realpath 归一后精确匹配)
const SKILL_ALLOW_DIRS = [];
for (const _r of SKILL_ROOTS) for (const _s of _r.subs) SKILL_ALLOW_DIRS.push({ id: _r.id + (_s ? '/' + _s : ''), dir: _s ? path.join(_r.base, _s) : _r.base });
const { KB_DENY_SEGMENTS, kbDenyHit, kbDenyCred, kbDenyTraversal } = require('./kb_path_policy');
const KB_READ_LIMIT = 512 * 1024; // skill_read/kb_read 单文件上限 512KB, 超限报错不截断

function kbDecode(raw) {
  let s = String(raw || '');
  for (let i = 0; i < 3; i++) { // URL 编码变体循环解码(拦 %2e%2e%2f 等), 最多 3 层
    let d; try { d = decodeURIComponent(s); } catch (_) { break; }
    if (d === s) break; s = d;
  }
  return s;
}

// Old redtree names are aliases, never a second (removed) corpus location.
function kbAliasPath(raw) {
  return String(raw).replace(/\\/g, '/')
    .replace(/^R1[:/]\/?红队知识库-全网(?:[/:]|$)/i, 'R3/')
    .replace(/^(?:redtree|redteam|红队知识库-全网)(?:[/:]|$)\/?/i, 'R3/')
    .replace(/^技能与知识库(?:[/:]|$)\/?/, 'R2/')
    .replace(/^知识库(?:[/:]|$)\/?/, 'P-kb/')
    .replace(/^hermes-skills(?:[/:]|$)\/?/i, 'skills/');
}

// 解析+判定: 返回 { real, allow, rel, longPath }; 越界/denylist → SCOPE_BLOCKED
// 顺序: 解码 → \\?\ 前缀剥离 → denylist(raw) → 解析 → realpath → 白名单前缀判定 → denylist(realpath 复核)
// \\?\ 长路径前缀在 realpath 判定之后按需再加(longPath), 供 83GB 库 >260 字符深路径读取
function kbResolve(userPath, toolName) {
  const raw0 = String(userPath || '').trim();
  if (!raw0) {
    audit({ decision: 'SCOPE_BLOCKED', tool: toolName, path_head: '(empty)' });
    throw new Error('SCOPE_BLOCKED: 路径为空');
  }
  const raw = kbAliasPath(kbDecode(raw0).replace(/^\\\\\?\\UNC\\/i, '//').replace(/^\\\\\?\\/i, ''));
  const norm = raw.replace(/\\/g, '/').toLowerCase();
  // [G15 契约修复] 原用裸 kbDenyHit: full 模式下 skill_read/kb_read 喂绝对路径必命中
  // 'TRAVERSAL(cross-drive/UNC)' → 与工具自述「full 支持任意路径」冲突(engI_perm 两条 FAIL)。
  // 改走 kbDenyHard: full 只豁免"绝对路径形态", 凭据/.. 硬线两种模式照旧硬挡(sandbox 下等价 kbDenyHit)。
  const deny0 = kbDenyHard(norm);
  if (deny0) {
    audit({ decision: 'SCOPE_BLOCKED', tool: toolName, path_head: raw0.slice(0, 80), deny: deny0 });
    throw new Error('SCOPE_BLOCKED: 命中 denylist(' + deny0 + '), 无论路径变换一律硬挡');
  }
  let cand = null;
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('//')) {
    cand = path.resolve(raw); // 绝对路径: 仍须过白名单判定
  } else {
    let rel = raw.replace(/^([a-zA-Z]:)?[\\/]+/, '');
    // 根别名前缀: R1/R2/skills, 斜杠与冒号形态(R1:/R2:/skills: 及 R1\/R1:) 同闸(2026-09-27 补冒号形态)
    const mRoot = rel.match(/^(R1|R2|R3|skills|P|P-kb|P-tools|EKB)(?::[\\/]?|[\\/])(.*)$/i);   // [1.1.51] R3 原始全量根  // [EKB-FTS] EKB=E 盘知识库根
    let bases;
    if (mRoot) {
      const k = mRoot[1].toLowerCase();
      bases = [k === 'r1' ? R1_BASE : k === 'r2' ? KB_SKILLS_ROOT : k === 'r3' ? R3_BASE :
        k === 'p' ? PRODUCT_SKILLS_DIR : k === 'p-kb' ? PRODUCT_KB_DIR : k === 'p-tools' ? PRODUCT_TOOLS_DIR : k === 'ekb' ? KB_SOURCE_ROOT : k === 'p-up' ? path.join(PRODUCT_DIR, 'uploads') : HERMES_SKILLS_DIR];
      rel = mRoot[2];
    } else {
      bases = SKILL_ALLOW_DIRS.map(function (a) { return a.dir; }).concat([R1_BASE, KB_SKILLS_ROOT, PRODUCT_DIR]);
    }
    for (const b of bases) {
      const r2 = (b === HERMES_SKILLS_DIR) ? rel.replace(/^skills[\\/]+/i, '') : rel;
      const c = path.resolve(b, r2);
      if (fs.existsSync(c)) { cand = c; break; }
    }
    if (cand === null) {
      // 不存在: 仍按基做逻辑归一, 让 .. 逃逸走 SCOPE_BLOCKED 而非 NOT_FOUND(sandbox)
      let fb = R1_BASE;
      if (mRoot) {
        const k = mRoot[1].toLowerCase();
        fb = k === 'r1' ? R1_BASE : k === 'r2' ? KB_SKILLS_ROOT : k === 'r3' ? R3_BASE :
          k === 'p' ? PRODUCT_SKILLS_DIR : k === 'p-kb' ? PRODUCT_KB_DIR : k === 'p-tools' ? PRODUCT_TOOLS_DIR : k === 'ekb' ? KB_SOURCE_ROOT : HERMES_SKILLS_DIR;
      }
      cand = path.resolve(fb, rel);
      if (PERM_MODE === 'full' && !fs.existsSync(cand)) {
        const cW = path.resolve(WORKROOT, rel); // full 模式: 相对路径兜底回 workroot
        if (fs.existsSync(cW)) cand = cW;
      }
    }
  }
  // 逻辑归一白名单判定(realpath 之前): 对 .. 逃逸/不存在路径一律先拦(sandbox 全闸; full 仅 denylist 硬线)
  const candN = cand.replace(/\\/g, '/').toLowerCase();
  let logicAllow = null;
  for (const a of SKILL_ALLOW_DIRS) {
    const adN = a.dir.replace(/\\/g, '/').toLowerCase();
    if (candN === adN || candN.startsWith(adN + '/')) { logicAllow = a; break; }
  }
  if (!logicAllow && PERM_MODE === 'sandbox') {
    audit({ decision: 'SCOPE_BLOCKED', tool: toolName, path_head: raw0.slice(0, 80) });
    throw new Error('SCOPE_BLOCKED: 路径越界被拒——当前为 sandbox 模式, 仅允许白名单根(R1 五子路径/R2 五子路径/Hermes skills 目录)');
  }
  let real;
  try { real = fs.realpathSync(cand); } catch (_) { throw new Error('NOT_FOUND: 路径不存在 ' + raw.slice(0, 120)); }
  const realN = real.replace(/\\/g, '/').toLowerCase();
  let allow = null;
  for (const a of SKILL_ALLOW_DIRS) {
    const rd = allowRealpath(a); if (!rd) continue;   // [G68] 白名单根 realpath 记忆化(静态配置, 省 ~15 次/条)
    const rdN = rd.replace(/\\/g, '/').toLowerCase();
    if (realN === rdN || realN.startsWith(rdN + '/')) { allow = a; break; }
  }
  if (!allow && PERM_MODE === 'sandbox') {
    audit({ decision: 'SCOPE_BLOCKED', tool: toolName, path_head: raw0.slice(0, 80) });
    throw new Error('SCOPE_BLOCKED: 路径越界被拒——当前为 sandbox 模式, 仅允许白名单根(R1 五子路径/R2 五子路径/Hermes skills 目录)');
  }
  // [G15 契约修复] realN 是 realpath 产物(必为绝对路径) → 必须用 kbDenyResolved:
  // 裸 kbDenyHit 会对每一个绝对路径返回 'TRAVERSAL(cross-drive/UNC)', 把 full 的放行分支整条打死。
  // kbDenyResolved 保留凭据/.. 硬线(realpath 复核双保险, full/sandbox 共同)。
  const deny1 = kbDenyResolved(realN);
  if (deny1) {
    audit({ decision: 'SCOPE_BLOCKED', tool: toolName, path_head: raw0.slice(0, 80), deny: deny1 });
    throw new Error('SCOPE_BLOCKED: realpath 复核命中 denylist(' + deny1 + '), 已硬挡');
  }
  if (!allow) {
    // full 模式: 白名单外放行, rel 以 workroot 相对形式给出(仅信息性, 不作判定)
    let relFull = '';
    try { relFull = path.relative(WORKROOT, real).replace(/\\/g, '/'); } catch (_) {}
    return { real: real, allow: null, rel: relFull || real, longPath: '\\\\?\\' + real };
  }
  let relFromDir = '';
  try { relFromDir = path.relative(allow.dir, real).replace(/\\/g, '/'); } catch (_) {}
  return { real: real, allow: allow, rel: allow.id + '/' + relFromDir, longPath: '\\\\?\\' + real };
}

// 技能总索引 CSV 缓存(1.9 万数据行 → 内存, 一次加载)
let _SKILL_CSV = null;
function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (q) {
      if (ch === '"') { if (line.charAt(i + 1) === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
// [1.1.36] 技能索引内存缓存(10.9MB JSON 每次重解析 ≈105ms → 首读后缓存; 诊断部实测)
let _SKILLS_IDX_CACHE = null;
function skillSearchTokens(value) {
  const source = String(value || '').toLowerCase();
  const tokens = [];
  for (const part of source.match(/[a-z0-9_.-]+|[\u3400-\u9fff]+/g) || []) {
    if (!/^[\u3400-\u9fff]+$/.test(part)) { tokens.push(part); continue; }
    if (part.length === 1) continue; // 单字噪声会把自然语言查询扩成近乎全库命中。
    for (let i = 0; i + 1 < part.length; i++) tokens.push(part.slice(i, i + 2));
  }
  return [...new Set(tokens)];
}
const _SKILL_SEARCH_INDEX_CACHE = new WeakMap();
function rankSkills(entries, query) {
  const q = String(query || '').trim();
  if (!q) return entries.map((entry) => Object.assign({ score: 0 }, entry));
  const queryTokens = skillSearchTokens(q);
  const minimumMatches = Math.max(1, Math.ceil(queryTokens.length * 0.3));
  let cached = _SKILL_SEARCH_INDEX_CACHE.get(entries);
  if (!cached) {
    const index = new MiniSearch({
      fields: ['name', 'description', 'tagsText', 'category', 'path', 'searchText'],
      storeFields: [],
      tokenize: skillSearchTokens,
      idField: 'path',
    });
    index.addAll(entries.map((entry) => ({
      path: entry.path,
      name: entry.name,
      description: entry.description || '',
      tagsText: Array.isArray(entry.tags) ? entry.tags.join(' ') : '',
      category: entry.category || '',
      searchText: entry.searchText || '',
    })));
    cached = { index, byPath: new Map(entries.map((entry) => [entry.path, entry])) };
    _SKILL_SEARCH_INDEX_CACHE.set(entries, cached);
  }
  const { index, byPath } = cached;
  return index.search(q, {
    combineWith: 'OR', prefix: true, fuzzy: 0.15,
    boost: { name: 6, description: 3, tagsText: 2, category: 1.5, path: 1, searchText: 0.8 },
  }).filter((hit) => new Set(hit.queryTerms || hit.terms || []).size >= minimumMatches)
    .map((hit) => Object.assign({ score: Number(hit.score || 0), match_count: new Set(hit.queryTerms || hit.terms || []).size, query_terms: queryTokens.length }, byPath.get(hit.id)))
    .filter((entry) => entry.path && entry.score > 0);
}
function skillsIndex() {
  if (_SKILLS_IDX_CACHE) return _SKILLS_IDX_CACHE;
  // Do not cache failed reads as an empty index: a later payload install must recover.
  const idx = JSON.parse(fs.readFileSync(PRODUCT_SKILLS_INDEX, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(idx)) throw new Error('INDEX_INVALID: skills index must be an array');
  _SKILLS_IDX_CACHE = idx;
  return _SKILLS_IDX_CACHE;
}
const FS_LIST_CAP = 3000;   // [1.1.36] fs.list 单次最多返回条目
function skillCsv() {
  if (_SKILL_CSV) return _SKILL_CSV;
  const p = fs.existsSync(KB_INDEX_CSV) ? KB_INDEX_CSV : path.join(R2_BASE, '08-索引与工具', '技能总索引.csv');   // [1.1.47] 知识库源迁移
  const txt = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  const lines = txt.split(/\r?\n/).filter(function (l) { return l.trim(); });
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    if (c.length < 11) continue;
    rows.push({ group: c[1], src: c[2], name: c[3], cat: c[4], files: c[5], sizeKB: c[6], rel: c[7], orig: c[8], desc: c[9], fp: c[10] });
  }
  _SKILL_CSV = { path: p, total: rows.length, rows: rows };
  return _SKILL_CSV;
}

// skill_list uses one merge point; a missing legacy source must not hide live skills.
function skillEntryPath(rawPath, root, skillFile) {
  let rel = kbDecode(String(rawPath || '')).replace(/\\/g, '/').replace(/^\.\//, '');
  if (root === 'P') rel = rel.replace(/^(?:skills|P)[/:]+/i, '');
  else if (root === 'P-tools') rel = rel.replace(/^(?:tools|P-tools)[/:]+/i, '');
  else if (root === 'R2') rel = rel.replace(/^(?:R2|技能与知识库)[/:]+/i, '');
  else if (root === 'skills') rel = rel.replace(/^(?:skills|hermes-skills)[/:]+/i, '');
  rel = rel.replace(/\/+$/, '');
  if (!rel || /^[a-z]:|^\//i.test(rel) || rel.split('/').some(p => p === '..') || kbDenyHit(rel.toLowerCase())) return '';
  if (skillFile && !/\/SKILL\.md$|^SKILL\.md$/i.test(rel)) rel += '/SKILL.md';
  return root + '/' + rel;
}
function skillSourceError(e) {
  const error = String(e && e.message || e).slice(0, 240);
  const code = e && e.code || (error.match(/^([A-Z_]+):/) || [])[1] || 'INDEX_ERROR';
  return { status: ['ENOENT', 'NOT_FOUND'].includes(code) ? 'missing' : 'error', code, error };
}
const _SKILL_CATALOG_CACHE = new Map();
const _SKILL_MERGED_CACHE = new WeakMap();
const SKILL_CATALOG_TTL_MS = 30000;
// [G8-修复 2026-10-31] 这个 Map 的 key 是 `source|category`, category 由调用方任意传入 → 键空间无界;
// value 持有全量 entries(hermes 源每条带 ≤12KB 的 searchText, 本机 367 个 SKILL.md / 37MB)。
// 实测(00-会话督办/03-backend/G8-内存采样.md §3.2): 24 个不同 category → 空闲 120s 后仍留 +4.2MB
// 不回落 —— 对象被 Map 强引用, GC 收不掉, 调用方若按时间戳/动态分类刷新就会线性膨胀。
// 三条硬约束: ①容量封顶(LRU) ②过期即 delete(原来只判定不删) ③可手动 clear(MCP: skill_cache_clear)。
const SKILL_CATALOG_MAX_KEYS = ekbClampInt('OMNI_SKILL_CACHE_MAX', 64, 1, 4096);   // ekbClampInt 是模块级函数声明(已提升)
// 读: 过期真删; 命中则重新插到末尾完成 LRU 续期(Map 保序, 首个即最久未用)。hit 语义与原来一致。
function skillCatalogGet(cacheKey) {
  const hit = _SKILL_CATALOG_CACHE.get(cacheKey);
  if (!hit) return null;
  if (Date.now() - hit.at >= SKILL_CATALOG_TTL_MS) { _SKILL_CATALOG_CACHE.delete(cacheKey); return null; }
  _SKILL_CATALOG_CACHE.delete(cacheKey);
  _SKILL_CATALOG_CACHE.set(cacheKey, hit);
  return hit;
}
// 写: 先删再插(保证最新端), 超出上限从头部淘汰。O(1), 不遍历。
function skillCatalogSet(cacheKey, value) {
  if (_SKILL_CATALOG_CACHE.has(cacheKey)) _SKILL_CATALOG_CACHE.delete(cacheKey);
  _SKILL_CATALOG_CACHE.set(cacheKey, value);
  while (_SKILL_CATALOG_CACHE.size > SKILL_CATALOG_MAX_KEYS) {
    _SKILL_CATALOG_CACHE.delete(_SKILL_CATALOG_CACHE.keys().next().value);
  }
}
function skillCatalogClear() { const n = _SKILL_CATALOG_CACHE.size; _SKILL_CATALOG_CACHE.clear(); return n; }
// [G8-修复] 按 source 维度清: key 形如 `source|category`, 前缀匹配只摘该 source 名下的键。
// 场景: 只重建了 hermes 源索引, 不必把 product/csv/tools 的缓存一起打掉(那些重建成本更高)。
// O(n), n ≤ 上限 64; 拷一份 keys 再删, 避免边遍历边删(Map 允许但不直观, 这里显式隔离)。
function skillCatalogClearSource(source) {
  const prefix = String(source || '') + '|';
  let n = 0;
  for (const k of [..._SKILL_CATALOG_CACHE.keys()]) {
    if (k.startsWith(prefix)) { _SKILL_CATALOG_CACHE.delete(k); n++; }
  }
  return n;
}
// 手动触发一次过期清扫(与定时清扫同一段逻辑)。给 skill_cache_clear 用: 不想全清、只想把过期项请出去时用。
function skillCatalogSweep() {
  const now = Date.now();
  let n = 0;
  for (const [k, v] of _SKILL_CATALOG_CACHE) if (now - v.at >= SKILL_CATALOG_TTL_MS) { _SKILL_CATALOG_CACHE.delete(k); n++; }
  return n;
}
// 只在"读到"时被动删过期项是不够的: 长跑下没人再问那个 category, 条目就永远占着堆
// (G8 §3.2 的 +4.2MB 就是这么留下来的 —— 24 个 category 之后再无任何请求, 但内存不回落)。
// 所以挂一个 unref 的清扫定时器: 到点真删 TTL 过期项; unref 保证它不钉住进程退出。O(n), n ≤ 上限。
const SKILL_CATALOG_SWEEP_MS = ekbClampInt('OMNI_SKILL_CACHE_SWEEP_MS', 30000, 1000, 3600000);
const _SKILL_CATALOG_SWEEPER = setInterval(() => skillCatalogSweep(), SKILL_CATALOG_SWEEP_MS);
if (_SKILL_CATALOG_SWEEPER.unref) _SKILL_CATALOG_SWEEPER.unref();
// ═══════════════════════════════════════════════════════════════════════════════
// [G68] skill_list 冷启性能 —— 按系统调用次数砍, 不赌硬件会变快
// 实测病灶(源码态本机, 见 00-会话督办/03-backend/G68-skill_list冷启19s性能归因.md):
//   一次 source=all&max=200 =
//     401 次 readdir + 405 次 SKILL.md open+read(2.3MB)
//   + 202 条 ×(15 次白名单根 realpath + 1 次 cand realpath + 1 次 existsSync + 1 次 stat)
//   ≈ 4,400 次文件系统调用。暖缓存 291ms; 冷启机械盘 + 腾讯管家实时扫描下每次调用放大到 ~4.4ms
//   文件系统调用 → 19.3s。四条修法都只动"同样的结果怎么拿到", 不改返回语义:
//   ① 白名单根 realpath 记忆化(静态配置): 每次调用省 ~3,000 次 realpath
//   ② 逐条 stat 校验结果按 path 缓存: TTL 内重复调用 0 系统调用(与 SKILL_CATALOG_TTL 同一陈旧度)
//   ③ hermes 每个 SKILL.md 的解析结果按 mtime+size 持久化: 内容没变就不读字节
//   ④ 启动后台预热 source=all 目录并写快照: 首次调用直接命中
// ═══════════════════════════════════════════════════════════════════════════════
const SKILL_VERIFY_TTL_MS = ekbClampInt('OMNI_SKILL_VERIFY_TTL_MS', SKILL_CATALOG_TTL_MS, 0, 600000);
const SKILL_VERIFY_MAX = ekbClampInt('OMNI_SKILL_VERIFY_MAX', 8192, 64, 65536);
const _SKILL_VERIFY_CACHE = new Map();          // path -> { at, ok, info? }
function skillVerifyGet(p) {
  if (SKILL_VERIFY_TTL_MS <= 0) return null;
  const hit = _SKILL_VERIFY_CACHE.get(p);
  if (!hit) return null;
  if (Date.now() - hit.at >= SKILL_VERIFY_TTL_MS) { _SKILL_VERIFY_CACHE.delete(p); return null; }
  _SKILL_VERIFY_CACHE.delete(p); _SKILL_VERIFY_CACHE.set(p, hit);   // Map 保序 → 重新插入即 LRU 续期
  return hit;
}
function skillVerifySet(p, ok, info) {
  if (SKILL_VERIFY_TTL_MS <= 0) return;
  if (_SKILL_VERIFY_CACHE.has(p)) _SKILL_VERIFY_CACHE.delete(p);
  _SKILL_VERIFY_CACHE.set(p, info ? { at: Date.now(), ok, info } : { at: Date.now(), ok });
  while (_SKILL_VERIFY_CACHE.size > SKILL_VERIFY_MAX) _SKILL_VERIFY_CACHE.delete(_SKILL_VERIFY_CACHE.keys().next().value);
}
function skillVerifyClear() { const n = _SKILL_VERIFY_CACHE.size; _SKILL_VERIFY_CACHE.clear(); return n; }

// hermes 源解析快照: %APPDATA%/omnishade/skill_catalog_hermes.json
// 记录每个 SKILL.md 的 [绝对路径, mtimeMs, size, description, searchText(≤12000 字符)]。
// 命中规则: mtime+size 都没变 → 直接复用解析结果(不 open 文件); 快照整体还在 TTL 内且根目录
// mtime 未变 → 连 readdir 都省掉。写盘 tmp+rename 原子替换, 失败静默(快照只是加速层, 不是数据源)。
const SKILL_SNAPSHOT_PATH = path.join(PRODUCT_DIR, 'skill_catalog_hermes.json');
const SKILL_SNAPSHOT_VER = 1;
const SKILL_SNAPSHOT_TTL_MS = ekbClampInt('OMNI_SKILL_SNAPSHOT_TTL_MS', SKILL_CATALOG_TTL_MS, 0, 86400000);   // [G68] 默认与目录缓存 TTL 同源: 陈旧度不超出现有契约(30s)
const SKILL_SNAPSHOT_SAVE_MS = ekbClampInt('OMNI_SKILL_SNAPSHOT_SAVE_MS', 30000, 0, 3600000);
let _SKILL_SNAP = null;
let _SKILL_SNAP_LOADED = false;
let _SKILL_SNAP_FROM_DISK = false;   // [G68] 只有"本进程自己走过一遍目录"产生的快照才允许走零 I/O 快路径
let _SKILL_SNAP_SAVED_AT = 0;
let _SKILL_WARM_STATE = { state: 'idle' };
function skillSnapshotLoad() {
  if (_SKILL_SNAP_LOADED) return _SKILL_SNAP;
  _SKILL_SNAP_LOADED = true;
  try {
    const j = JSON.parse(fs.readFileSync(SKILL_SNAPSHOT_PATH, 'utf8'));
    if (j && j.ver === SKILL_SNAPSHOT_VER && j.root === HERMES_SKILLS_DIR && Array.isArray(j.files)) { _SKILL_SNAP = j; _SKILL_SNAP_FROM_DISK = true; }
    else _SKILL_SNAP = null;
  } catch (_) { _SKILL_SNAP = null; }
  return _SKILL_SNAP;
}
function skillSnapshotSave(force) {
  if (!_SKILL_SNAP) return false;
  const now = Date.now();
  if (!force && SKILL_SNAPSHOT_SAVE_MS > 0 && now - _SKILL_SNAP_SAVED_AT < SKILL_SNAPSHOT_SAVE_MS) return false;
  _SKILL_SNAP_SAVED_AT = now;
  try {
    const tmp = SKILL_SNAPSHOT_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_SKILL_SNAP));
    fs.renameSync(tmp, SKILL_SNAPSHOT_PATH);
    return true;
  } catch (_) { return false; }   // 盘满/权限/并发 rename 都不该影响 skill_list 返回
}
function skillSnapshotDrop() {
  const had = !!_SKILL_SNAP;
  _SKILL_SNAP = null; _SKILL_SNAP_LOADED = true; _SKILL_SNAP_SAVED_AT = 0; _SKILL_SNAP_FROM_DISK = false;
  try { fs.unlinkSync(SKILL_SNAPSHOT_PATH); } catch (_) {}
  return had;
}

// [G68-修复] kbResolve 的 realpath 白名单复核: SKILL_ALLOW_DIRS 是启动期固定的配置, 原实现却对
// 每条路径都把 15 个根挨个 realpathSync 一遍(202 条 = 3,030 次), 是热态 291ms 里最大的一项。
// 缓存每个根的 realpath: 存在的根永久缓存; 不存在的根(本机没有桌面 R1/R2)按 10s 复探,
// 这样运行中新建根目录也能在 10s 内被发现。O(1)/次, 判定结果与逐次 realpath 完全一致。
const _ALLOW_REAL_CACHE = new Map();            // a.dir -> { real: string|null, at: number }
const ALLOW_REAL_MISS_RETRY_MS = 10000;
function allowRealpath(a) {
  const hit = _ALLOW_REAL_CACHE.get(a.dir);
  const now = Date.now();
  if (hit && (hit.real || now - hit.at < ALLOW_REAL_MISS_RETRY_MS)) return hit.real;
  let real = null;
  try { real = fs.realpathSync(a.dir); } catch (_) { real = null; }
  if (_ALLOW_REAL_CACHE.size > 512) _ALLOW_REAL_CACHE.delete(_ALLOW_REAL_CACHE.keys().next().value);
  _ALLOW_REAL_CACHE.set(a.dir, { real, at: now });
  return real;
}

async function finishSkillList(entries, sources, q, source, max, t0, warmOnly) {
  let mergedEntries = _SKILL_MERGED_CACHE.get(entries);
  if (!mergedEntries) {
    const merged = new Map();
    for (const e of entries) {
      const key = e.path.toLowerCase();
      const old = merged.get(key);
      if (old) { if (!old.sources.includes(e.source)) old.sources.push(e.source); continue; }
      merged.set(key, Object.assign({ sources: [e.source] }, e));
    }
    mergedEntries = [...merged.values()];
    _SKILL_MERGED_CACHE.set(entries, mergedEntries);
  }
  const sorted = rankSkills(mergedEntries, q)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  const visible = [], unavailable = [];
  let checked = 0, unavailableCount = 0;
  for (const e of sorted) {
    if (visible.length >= max || checked >= 2000) break;
    checked++;
    // [G68] 先查校验缓存: 命中 ok → 0 次系统调用; 命中失败 → 复现同样的 unavailable 结构。
    const v = skillVerifyGet(e.path);
    if (v) {
      if (v.ok) { const { searchText: _s, ...pub } = e; visible.push(pub); }
      else {
        unavailableCount++;
        if (unavailable.length < 20) unavailable.push(v.info || { skill_id: e.skill_id, source: e.source, path: e.path, status: 'missing', code: 'ENOENT' });
      }
      if (checked % 50 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      continue;
    }
    try {
      const resolved = kbResolve(e.path, 'skill_list');
      if (!fs.statSync(resolved.longPath).isFile()) throw new Error('NOT_A_FILE');
      skillVerifySet(e.path, true);
      const { searchText: _searchText, ...publicEntry } = e;
      visible.push(publicEntry);
    } catch (err) {
      unavailableCount++;
      const info = { skill_id: e.skill_id, source: e.source, path: e.path, ...skillSourceError(err) };
      skillVerifySet(e.path, false, info);
      if (unavailable.length < 20) unavailable.push(info);
    }
    if (checked % 50 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  const result = { source, scope: source, matched: sorted.length, matched_scope: 'index', returned: visible.length,
    scanned: sources.reduce((n, s) => n + s.scanned, 0), truncated: checked < sorted.length || sources.some(s => s.truncated),
    partial: unavailableCount > 0 || sources.some(s => s.status !== 'ok'), sources, entries: visible,
    checked_paths: checked, unavailable_count: unavailableCount, unavailable };
  if (!warmOnly) audit({ decision: 'FS_SEARCH', tool: 'skill_list', query_head: (q || '*').slice(0, 60), hits: result.matched, ms: Date.now() - t0 });   // [G68] 预热走同一段校验但不写审计(不是用户请求)
  return { text: JSON.stringify(result) };
}
// [G68] hermes 源: 目录树 → 条目。快路径(快照在 TTL 内且根 mtime 未变)= 0 次 I/O;
// 慢路径 = 401 次 readdir + 每个 SKILL.md 一次 stat, mtime+size 与快照一致就不读字节。
// 两条路产出的条目数组必须逐字段一致(顺序也一致: 都是 DFS 先序)。
function hermesEntry(dir, rel, fileName, description, searchText) {
  return { name: path.basename(dir), category: rel.split('/').slice(0, -1).join('/'), description,
    searchText, path: 'skills/' + (rel ? rel + '/' : '') + fileName };
}
async function buildHermesEntries(state) {
  const snap = skillSnapshotLoad();
  let rootMtime = 0;
  try { rootMtime = (await fs.promises.stat(HERMES_SKILLS_DIR)).mtimeMs; } catch (_) { rootMtime = 0; }
  if (snap && !_SKILL_SNAP_FROM_DISK && SKILL_SNAPSHOT_TTL_MS > 0 && rootMtime && snap.root_mtime === rootMtime
      && Date.now() - snap.built_at < SKILL_SNAPSHOT_TTL_MS) {
    state.scanned += snap.scanned || 0;
    const out = [];
    for (const r of snap.files) {
      state.total++;
      const abs = String(r[0]);
      const dir = path.dirname(abs);
      let rel = ''; try { rel = path.relative(HERMES_SKILLS_DIR, dir).replace(/\\/g, '/'); } catch (_) { rel = ''; }
      out.push({ name: path.basename(dir), category: rel.split('/').slice(0, -1).join('/'),
        description: r[3] || '', searchText: r[4] || '', path: 'skills/' + (rel ? rel + '/' : '') + path.basename(abs) });
    }
    _SKILL_WARM_STATE = Object.assign({}, _SKILL_WARM_STATE, { hermes_source: 'snapshot', snapshot_built_at: snap.built_at });
    return out;
  }
  const prev = new Map();
  if (snap) for (const r of snap.files) prev.set(String(r[0]).toLowerCase(), r);
  const files = [], out = [];
  let scanned = 0, reused = 0, fetched = 0;
  const walk = async (dir, rel, depth) => {
    const ents = await fs.promises.readdir(dir, { withFileTypes: true });
    scanned += ents.length;
    state.scanned += ents.length;
    const sk = ents.find(e => e.isFile() && e.name.toLowerCase() === 'skill.md');
    if (sk) {
      state.total++;
      const abs = path.join(dir, sk.name);
      let st = null;
      try { st = await fs.promises.stat(abs); } catch (_) {}
      const old = prev.get(abs.toLowerCase());
      let description = '', sourceText = '';
      if (st && old && old[1] === st.mtimeMs && old[2] === st.size) { description = old[3] || ''; sourceText = old[4] || ''; reused++; }
      else {
        try { sourceText = (await fs.promises.readFile(abs, 'utf8')).slice(0, 12000); } catch (_) {}
        description = ((/^---\s*[\s\S]*?^description:\s*["']?([^\r\n"']+)/mi.exec(sourceText) || [])[1] || '').trim();
        fetched++;
      }
      files.push([abs, st ? st.mtimeMs : 0, st ? st.size : 0, description, sourceText]);
      out.push(hermesEntry(dir, rel, sk.name, description, sourceText));
      return; // scripts/references/assets are not nested skills.
    }
    if (depth >= 3) return;
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || kbDenyHit(e.name.toLowerCase())) continue;
      try { await walk(path.join(dir, e.name), rel ? rel + '/' + e.name : e.name, depth + 1); }
      catch (err) { Object.assign(state, skillSourceError(err)); }
    }
  };
  await walk(HERMES_SKILLS_DIR, '', 0);   // 根目录 readdir 失败 → 抛出, 由 collect() 记 status(与旧实现一致)
  _SKILL_SNAP = { ver: SKILL_SNAPSHOT_VER, built_at: Date.now(), root: HERMES_SKILLS_DIR,
    root_mtime: rootMtime, scanned, dirs: files.length, files };
  _SKILL_SNAP_FROM_DISK = false;   // 本进程刚读过全部 SKILL.md 的 mtime/size, 快照是"活的"
  skillSnapshotSave(false);
  _SKILL_WARM_STATE = Object.assign({}, _SKILL_WARM_STATE, { hermes_source: 'walk', reused, fetched });
  return out;
}

// [G68] 目录构建: 抽成独立函数, "启动预热"与"首次调用"共用同一实现(不会出现两套口径)。
async function buildSkillCatalog(source, cat, t0) {
  const entries = [], sources = [];
  const add = (sourceName, entry) => {
    if (!entry.path) return;
    if (cat && String(entry.category || '').toLowerCase().indexOf(cat) === -1) return;
    entries.push(Object.assign({}, entry, { skill_id: entry.path.replace(/\/SKILL\.md$/i, ''), source: sourceName }));
  };
  // [G68] collect 改 async: hermes 源要走 await(快照/异步 readdir), 同步源 await 一个同步函数无副作用。
  const collect = async (sourceName, fn) => {
    const state = { source: sourceName, status: 'ok', total: 0, matched: 0, scanned: 0, truncated: false };
    const before = entries.length;
    try { await fn(state); } catch (e) { Object.assign(state, skillSourceError(e)); }
    state.matched = entries.length - before;
    sources.push(state);
  };
  if (source === 'all' || source === 'product') await collect('product', state => {
    const idx = skillsIndex();
    state.total = state.scanned = idx.length;
    for (const e of idx) {
      if (!e || typeof e !== 'object') continue;
      add('product', { name: String(e.name || ''), category: String(e.category || ''), description: String(e.description || ''), tags: e.tags,
        path: skillEntryPath(e.rel_path || [e.category, e.name].filter(Boolean).join('/'), 'P', true) });
    }
  });
  if (source === 'all' || source === 'csv') await collect('csv', state => {
    const csv = skillCsv();
    // The old CSV retained pre-flattening directories. Match only unambiguous
    // category/name identities from the product index, then dedupe by read path.
    const productPaths = new Map();
    try {
      for (const e of skillsIndex()) {
        if (!e || !e.name) continue;
        const key = (String(e.category || '') + '/' + e.name).toLowerCase();
        const p = skillEntryPath(e.rel_path || key, 'P', true);
        if (!productPaths.has(key)) productPaths.set(key, p);
        else if (productPaths.get(key) !== p) productPaths.set(key, '');
      }
    } catch (_) { /* CSV remains usable when the independent product index fails. */ }
    state.total = state.scanned = csv.total;
    for (const r of csv.rows) add('csv', { name: r.name, category: [r.cat, r.group, r.src].join(' '), description: r.desc,
      path: productPaths.get((r.group + '/' + r.name).toLowerCase()) || skillEntryPath(r.rel, 'R2', true) });
  });
  if (source === 'all' || source === 'hermes') await collect('hermes', async state => {
    for (const e of await buildHermesEntries(state)) add('hermes', e);
  });
  if (source === 'tools') await collect('tools', state => {
    const idx = JSON.parse(fs.readFileSync(PRODUCT_TOOLS_INDEX, 'utf8'));
    if (!Array.isArray(idx)) throw new Error('INDEX_INVALID: tools index must be an array');
    state.total = state.scanned = idx.length;
    for (const e of idx) add('tools', { name: String(e.name || ''), category: String(e.type || ''), description: [e.desc, e.usage, e.risk_level].filter(Boolean).join(' '),
      path: skillEntryPath(e.product_copy_path || e.name, 'P-tools', false) });
  });
  if (source === 'kb') await collect('kb', state => {
    const tw = t0 || Date.now();
    const walk = (dir, rel, depth) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (++state.scanned > 20000 || Date.now() - tw > 3000) { state.truncated = true; return; }
        const next = rel ? rel + '/' + e.name : e.name;
        if (e.name.startsWith('.') || kbDenyHit(next.toLowerCase()) || e.isSymbolicLink()) continue;
        if (e.isDirectory()) { if (depth < 6) walk(path.join(dir, e.name), next, depth + 1); else state.truncated = true; }
        else if (e.isFile()) { state.total++; add('kb', { name: e.name, category: rel, description: '', path: 'P-kb/' + next }); }
        if (state.truncated) return;
      }
    };
    walk(PRODUCT_KB_DIR, '', 0);
  });
  return { entries, sources };
}
// [G68] 同 key 的并发构建合并成一次: 预热刚开始 + 用户已经点开面板时不会两遍扫盘。
const _SKILL_BUILD_INFLIGHT = new Map();
function buildSkillCatalogShared(source, cat, t0) {
  const key = source + '|' + cat;
  const inflight = _SKILL_BUILD_INFLIGHT.get(key);
  if (inflight) return inflight;
  const p = buildSkillCatalog(source, cat, t0).finally(() => _SKILL_BUILD_INFLIGHT.delete(key));
  _SKILL_BUILD_INFLIGHT.set(key, p);
  return p;
}
// [G68] 启动预热: bridge 起来后后台把 source=all 的目录建好(填满 _SKILL_CATALOG_CACHE + 写快照),
// 用户第一次点技能面板时直接命中, 不再等 401 次 readdir / 405 次 SKILL.md open。
// 延迟 1200ms 让 license/health/settings 这些首屏请求先走; unref 保证不钉住进程退出。
function skillWarmStart(delayMs) {
  if (/^(off|0|false|no)$/i.test(String(process.env.OMNI_SKILL_WARM || ''))) { _SKILL_WARM_STATE = { state: 'disabled' }; return null; }
  const timer = setTimeout(async () => {
    const t0 = Date.now();
    try {
      if (skillCatalogGet('all|')) { _SKILL_WARM_STATE = { state: 'skipped-cached', at: t0 }; return; }
      _SKILL_WARM_STATE = { state: 'running', at: t0 };
      const built = await buildSkillCatalogShared('all', '', t0);
      skillCatalogSet('all|', { at: Date.now(), entries: built.entries, sources: built.sources });
      try { skillsIndex(); } catch (_) {}   // 顺手把 11.6MB 索引的页缓存焐热
      // [G68] 预热第二步: 用与用户完全相同的参数(source=all / q='' / max=200)走一遍校验循环,
      // 把 202 条 kbResolve+stat 的结果灌进验证缓存 → 首次点开面板 0 次系统调用。
      // 这一步是纯粹的"提前付账", 失败不影响正确性(用户调用时自己会再校验)。
      let verified = 0;
      try {
        const probe = await finishSkillList(built.entries, built.sources, '', 'all', 200, t0, true);
        try { verified = JSON.parse(probe.text).returned; } catch (_) {}
      } catch (_) {}
      _SKILL_WARM_STATE = { state: 'done', at: t0, ms: Date.now() - t0, entries: built.entries.length, verified,
        sources: built.sources.map(s => s.source + ':' + s.status + '/' + s.total), snapshot: !!_SKILL_SNAP };
      audit({ decision: 'SKILL_WARM', ok: true, ms: Date.now() - t0, entries: built.entries.length });
    } catch (e) {
      _SKILL_WARM_STATE = { state: 'error', at: t0, ms: Date.now() - t0, error: String(e && e.message || e).slice(0, 160) };
      audit({ decision: 'SKILL_WARM', ok: false, ms: Date.now() - t0, msg: String(e && e.message || e).slice(0, 120) });
    }
  }, Math.max(0, delayMs || 0));
  if (timer.unref) timer.unref();
  return timer;
}

async function listSkills(args) {
  const t0 = Date.now();
  const cat = String(args.category || '').trim().toLowerCase();
  const q = String(args.query || '').trim().toLowerCase();
  const source = String(args.source || 'all').trim().toLowerCase();
  const max = Math.max(1, Math.min(parseInt(args.max, 10) || 50, 200));
  if (!['all', 'product', 'csv', 'hermes', 'tools', 'kb'].includes(source)) throw new Error('TOOL_ERROR: unknown skill source ' + source);
  const cacheKey = source + '|' + cat;
  const cached = skillCatalogGet(cacheKey);   // [G8-修复] 过期即 delete + 命中续期(LRU), hit 语义不变
  if (cached) {
    return finishSkillList(cached.entries, cached.sources, q, source, max, t0);
  }
  const built = await buildSkillCatalogShared(source, cat, t0);   // [G68] 与预热共用同一次构建
  skillCatalogSet(cacheKey, { at: Date.now(), entries: built.entries, sources: built.sources });   // [G8-修复] 封顶写入(超出上限淘汰最久未用)
  return finishSkillList(built.entries, built.sources, q, source, max, t0);
}

// 工具目录: 名称对齐 MCP 规范 [A-Za-z0-9_-], 兼容旧点号名
const TOOLS = {
  'win.process':  { exe: 'tasklist', argre: /^[\s\/A-Za-z0-9]*$/ },
  'process_list': { exe: 'tasklist', argre: /^[\s\/A-Za-z0-9*=":.-]*$/ },
  'win.services': { exe: 'sc',       argre: /^(query|queryex)\s+\S+$/ },
  'win.netstat':  { exe: 'netstat',  argre: /^[-ano\s]*$/ },
  'win.sysinfo':  { exe: 'systeminfo', argre: /^\s*$/ },
  'fs.read':      { builtin: true },
  'fs.list':      { builtin: true },
  'fs.hash':      { builtin: true },
  'local_fs_search': { builtin: true },
  'local_fs_write':  { builtin: true },
  'desktop_screenshot': { builtin: true },
  'desktop_window_list': { builtin: true },
};
const TOOL_ALIASES = {}; // 'win_process'→'win.process' 兼容
for (const k of Object.keys(TOOLS)) TOOL_ALIASES[k.replace('.', '_')] = k;

// ── 套餐工具范围（商业口径的唯一落点）──────────────────────────────────────
// 服务端 /runtime_grant 返回 soft=false 时，主进程传 OMNI_TOOL_SCOPE=kb。
// 只卖知识库的档位（kb_day / kb_month）不能拿到桌面工具能力，否则 20 元的卡
// 等于 588 元月卡。默认 'all'，env 缺失/异常一律全开 —— 绝不误伤正常软件卡。
// 两层都要拦：tools/list 不列出（不诱导），callTool 直接拒（真正的闸）。
const TOOL_SCOPE = (() => {
  const v = String(process.env.OMNI_TOOL_SCOPE || 'all').trim().toLowerCase();
  return v === 'kb' ? 'kb' : 'all';
})();
const KB_SCOPE_TOOLS = new Set([
  'kb_search', 'kb_read',
  'skill_list', 'skill_read', 'skill_cache_clear',
]);
function scopeAllows(name) {
  if (TOOL_SCOPE !== 'kb') return true;
  const real = TOOL_ALIASES[name] || name;
  return KB_SCOPE_TOOLS.has(real);
}
function scopeReject(name) {
  const e = new Error('该能力不在当前套餐内（仅知识库）：' + String(name) +
    '。升级到软件日卡 / 月卡即可解锁全部工具。');
  e.code = 'TOOL_SCOPE_DENIED';
  return e;
}

// MCP 工具描述(inputSchema): 工作纪律中性化, 闸门语义留在执行层
// [release] Remote KB is account-gated. Read only the current opaque session token from the
// per-user account state; never log it and never send it to a non-KB endpoint.
function accountSessionToken() {
  try {
    const a = JSON.parse(fs.readFileSync(ACCOUNT_PATH, 'utf8'));
    return a && typeof a.token === 'string' ? a.token : '';
  } catch (_) { return ''; }
}
function kbNet(pathname, bodyObj, timeoutMs) {
  const targets = [
    // [G81] 知识库一律从 HK 取，不直连本机 E 盘。
    // 9443 = HK nginx TLS -> 127.0.0.1:19092(ssh -R 隧道) -> 数据端 kb_server -> E:\KnowledgeBase
    { host: '103.117.136.137', port: 9443, tls: true, timeout: timeoutMs || 20000 },
    // 备用端点：旧中继（9445）与本机直连（9102）只在 9443 不可用时才会被尝试，且同样走 /kb/* 契约。
    { host: '103.117.136.137', port: 9445, tls: true, timeout: timeoutMs || 12000 },
    { host: '127.0.0.1', port: 9102, tls: false, timeout: 4000 },
  ];
  const attempts = [];
  return targets.reduce(function (chain, t) {
    return chain.then(function (prev) {
      // Only a structured application response is authoritative. A proxy/old
      // relay returning HTML 404 means this endpoint is absent there, so try
      // the next configured relay instead of disguising topology as NOT_FOUND.
      // [G81] 2xx 必须短路：9443 已经返回 200 却继续打已死端点(9445/9102)，
      // 最终把成功结果覆盖成 ECONNREFUSED 失败 —— 原白名单漏了成功码。
      if (prev && prev.httpStatus && prev.httpStatus < 500 && prev.data
          && (prev.httpStatus < 300 || [400, 401, 403, 404, 409, 413, 422, 429].includes(prev.httpStatus))) return prev;
      return new Promise(function (resolve) {
        const mod = t.tls ? require('https') : require('http');
        // Avoid mutating caller-owned args. The server verifies this token with session_heartbeat.
        const payloadBody = Object.assign({}, bodyObj || {}, { token: accountSessionToken() });
        const payload = Buffer.from(JSON.stringify(payloadBody), 'utf8');
        let settled = false, deadline, req;
        const fin = (v) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          attempts.push({ endpoint: t.host + ':' + t.port, httpStatus: v.httpStatus || null,
            error: v.error || v.data && v.data.error || null, ...(v.truncated ? { truncated: true } : {}) });
          resolve(Object.assign({}, v, { attempts: attempts.slice() }));
        };
        try {
          const tlsPin = t.tls ? pinnedTlsOptions(t.host) : {};
          req = mod.request(Object.assign({ host: t.host, port: t.port, path: pathname, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length,
              ...(KB_REMOTE_TOKEN ? { 'X-Omni-Kb-Token': KB_REMOTE_TOKEN } : {}) },
            timeout: t.timeout }, tlsPin), (resp) => {
            let b = '', bytes = 0; resp.setEncoding('utf8');
            resp.on('data', (c) => {
              bytes += Buffer.byteLength(c);
              if (bytes > MAX_JSON_BODY_BYTES) { fin({ httpStatus: resp.statusCode, error: 'KB response too large', truncated: true }); resp.destroy(); return; }
              b += c;
            });
            resp.on('end', () => {
              let j = null; try { j = JSON.parse(b); } catch (_) {}
              fin({ httpStatus: resp.statusCode, data: j, ...(j ? {} : { error: 'invalid JSON response' }) });
            });
            resp.on('aborted', () => fin({ httpStatus: resp.statusCode, error: 'KB response aborted', truncated: true }));
            resp.on('error', (e) => fin({ httpStatus: resp.statusCode, error: String(e.message || e).slice(0, 80), truncated: true }));
          });
          const timedOut = () => { fin({ error: 'timeout' }); try { req.destroy(); } catch (_) {} };
          deadline = setTimeout(timedOut, t.timeout);
          req.on('timeout', timedOut);
          req.on('error', (e) => fin({ error: String(e && e.message || e).slice(0, 80) }));
          req.end(payload);
        } catch (e) { fin({ error: String(e && e.message || e).slice(0, 80) }); }
      });
    });
  }, Promise.resolve(null));
}
// Keep retrieval status in the tool text too: MCP and /call clients both consume it.
function kbToolResult(data) {
  return { text: JSON.stringify(data), ...(data.ok === false ? { isError: true } : {}) };
}
function kbRemoteFailure(net, scope, local) {
  const data = net && net.data && typeof net.data === 'object' ? net.data : {};
  const httpStatus = net && net.httpStatus || null;
  const error = String(data.error || data.code || net && net.error || 'invalid KB response').slice(0, 300);
  const code = httpStatus === 401 ? 'UNAUTHORIZED' : httpStatus === 403 ? 'FORBIDDEN' : httpStatus === 404 ? 'NOT_FOUND'
    : httpStatus === 413 ? 'TOO_LARGE' : /timeout|timed out/i.test(error) ? 'TIMEOUT'
    : /index/i.test(error) ? 'INDEX_UNAVAILABLE' : httpStatus === 200 ? 'INVALID_RESPONSE' : httpStatus ? 'HTTP_' + httpStatus : 'REMOTE_UNAVAILABLE';
  return { ok: false, source: 'server', code, error, httpStatus, scope: data.scope || scope,
    ...(data.code !== undefined ? { server_code: data.code } : {}),
    scanned: data.scanned == null ? null : data.scanned, truncated: data.truncated == null ? (net && net.truncated || null) : data.truncated,
    ...(data.missing_index !== undefined ? { missing_index: data.missing_index } : {}),
    ...(net && net.attempts ? { attempts: net.attempts } : {}), local };
}
function kbRemotePath(userPath) {
  const p = kbAliasPath(kbDecode(String(userPath || '').trim()));
  if (!p || p.startsWith('/') || /^[a-z]:/i.test(p) || p.split('/').includes('..') || kbDenyHit(p.toLowerCase())) {
    throw new Error('SCOPE_BLOCKED: remote KB path rejected');
  }
  const mappings = [ ['R3/', '红队知识库-全网/'], ['R2/', '技能与知识库/'], ['P-kb/', '知识库/'],
    ['R1/tg情报/', '知识库/tg情报/'], ['P/', '技能与知识库/'] ];
  for (const [alias, dir] of mappings) {
    const normal = p.replace(/^([^/]+):\/?/, '$1/');
    if (!normal.toLowerCase().startsWith(alias.toLowerCase())) continue;
    const rel = dir + normal.slice(alias.length);
    if (rel.split('/').some(s => s === '..' || s.includes(':')) || kbDenyHit(rel.toLowerCase())) throw new Error('SCOPE_BLOCKED: remote KB path rejected');
    return rel;
  }
  // [G81] 数据端 kb_server 返回的是 E:\KnowledgeBase 真实相对路径（01-渗透测试/…、05-技能库/…），
  // 不是旧的虚拟别名(R3/R2/P-kb)。这些是白名单顶层目录，原样放行（已在上方做过 .. 与 deny 校验）。
  const top = p.split('/')[0];
  if (KB_REAL_SCOPES.includes(top)) return p;
  return null; // Hermes/tools are local-only; never guess a server path for them.
}
function kbRemoteHitAllowed(hit, scope) {
  if (!hit || typeof hit.path !== 'string') return false;
  let p; try { p = kbRemotePath(hit.path); } catch (_) { return false; }
  if (!p) return false;
  // [G81] scope 过滤由数据端(kb_server 的 SCOPE_PREFIXES)负责，这里是第二道：
  // 只做"这条路径是否属于知识库范围"的判定，不再用旧的虚拟前缀猜 scope，
  // 否则真实目录(01-渗透测试/…)会被全部误杀。
  const top = p.split('/')[0];
  if (!KB_REAL_SCOPES.includes(top)) {
    // 兼容旧中继返回的虚拟路径
    if (scope === 'tg') return p.startsWith('知识库/tg情报/');
    if (scope === 'redteam') return p.startsWith('红队知识库-全网/');
    if (scope === 'product') return /^(知识库|技能与知识库)\//.test(p);
    return true;
  }
  if (scope === 'tg') return KB_SCOPE_TG.includes(top);
  if (scope === 'redteam') return KB_SCOPE_REDTEAM.includes(top);
  if (scope === 'product') return KB_SCOPE_PRODUCT.includes(top);
  return true;
}
async function finishKbSearch(local, args) {
  if (local.hits.length) return kbToolResult(local);
  let net;
  try { net = await kbNet('/kb/search', args); }
  catch (e) { net = { error: String(e && e.message || e) }; }
  const data = net && net.data;
  if (!net || net.httpStatus !== 200 || !data || data.ok === false || data.error || !Array.isArray(data.hits)) return kbToolResult(kbRemoteFailure(net, args.scope, local));
  // Older front servers scan the whole root. Filter their paths, and disclose that scan scope.
  const hits = data.hits.filter(h => kbRemoteHitAllowed(h, args.scope) && (!args.path || kbRemotePath(h.path) === args.path)).slice(0, args.max);
  const filtered = data.hits.length - hits.length;
  return kbToolResult({ ok: true, source: 'server', mode: args.mode, query: args.query, scope: data.scope || args.scope,
    requested_scope: args.scope, scan_scope: data.scope || 'server:all (legacy)', hits, matched: hits.length,
    scanned: data.scanned == null ? null : data.scanned, truncated: data.truncated == null ? null : data.truncated,
    filtered, partial: data.truncated !== false || filtered > 0 || !!data.missing_index || !!local.partial,
    ...(data.missing_index !== undefined ? { missing_index: data.missing_index } : {}),
    ...(net.attempts ? { attempts: net.attempts } : {}), local });
}
function productSearchStatus(pr, mode, max) {
  const head = String(pr && pr.head || '');
  const hits = pr && pr.body && pr.body !== '(无匹配)' ? String(pr.body).split('\n').filter(Boolean) : [];
  const count = mode === 'content' ? head.match(/扫描 (\d+)\/(\d+) 文件/) : head.match(/kb 文件 (\d+) 个/);
  const scanned = pr && pr.scanned != null ? pr.scanned : count ? Number(count[1]) : null;
  // Legacy worker has only display counts, not an exhaustive-completion flag. Do not invent one.
  const truncated = pr && pr.truncated != null ? pr.truncated
    : (hits.length >= max || (mode === 'content' && count && Number(count[1]) < Number(count[2])) ? true : null);
  const missing = [];
  if (!fs.existsSync(PRODUCT_KB_DIR)) missing.push('product_kb');
  if (mode === 'name') { try { skillsIndex(); } catch (e) { missing.push(e.code === 'ENOENT' ? 'skills_index' : 'skills_index_invalid'); } }
  return { hits, scanned, truncated, partial: truncated !== false || missing.length > 0, missing_index: missing, detail: head };
}
// [KBMERGE 2026-11-08] ── scope=analyzed 检索引擎: D:\分析到的 本机资料库(414MB/10288 文件) grep 级检索 ──
// 嫁接 local_fs_search 的受控 walk 语义(限深/符号链接不跟+realpath 逃逸校验/首4096字节二进制哨兵/单文件上限),
// 叠加四重预算保单查询 ≤3s: ①时间 deadline(目录+文件双层检查) ②总字节 64MB ③条目 50000 ④命中数 max。
// 限深取 8 而非 local_fs_search 的 5(实测该库最大深度13: ≤5 仅覆盖 60% 文件, ≤8 覆盖 91%):
// 深度只是次级护栏, 时间/字节双闸才是主防线 —— 实测零命中最坏情况 name 475ms / content 1917ms(冷)。
// 并发=1(同步单线程): 万级文件量在时间盒内单线程受控扫描即最优; 'all' 融合时它阻塞事件循环,
// 但 kbNet(HTTP socket)与 ekb/product(worker 线程)在各自通道并行推进, 互不等待。
// 命中对象: {kind:'name'|'content', source:'analyzed', path:'ANALYZED/<rel>[:line]', abs:<绝对路径>, size, line, snippet}
// abs 可直接喂 fs_read/skill_read(ANALYZED 已在 SKILL_ROOTS 白名单); path 的 ANALYZED/ 前缀仅作展示用。
function analyzedKbSearch(q, mode, max, budgetMs, t0) {
  const ms0 = t0 || Date.now();
  const deadline = ms0 + (budgetMs || 2500);
  const out = { status: 'ok', hits: [], scanned: 0, bytes: 0, truncated: false, ms: 0 };
  if (!ANALYZED_BASE || !fs.existsSync(ANALYZED_BASE)) { out.status = 'missing'; out.code = 'ENOENT'; out.ms = Date.now() - ms0; return out; }
  const ql = q.toLowerCase();
  const MAX_BYTES = 64 * 1024 * 1024, MAX_ENTRIES = 50000, MAX_DEPTH = 8;
  let rootReal = null; try { rootReal = fs.realpathSync(ANALYZED_BASE); } catch (_) {}
  (function walk(dir, depth) {
    if (out.hits.length >= max || out.scanned >= MAX_ENTRIES || out.bytes >= MAX_BYTES || Date.now() > deadline) { out.truncated = true; return; }
    let ents; try { ents = fs.readdirSync(dir); } catch (_) { return; }
    for (const f of ents) {
      if (out.hits.length >= max || out.scanned >= MAX_ENTRIES || out.bytes >= MAX_BYTES || Date.now() > deadline) { out.truncated = true; return; }
      const fp = path.join(dir, f);
      let st; try { st = fs.lstatSync(fp); } catch (_) { continue; }
      if (st.isSymbolicLink()) continue;                      // 符号链接不跟(防逃逸/防环, 对齐 local_fs_search 巡检修复)
      if (st.isDirectory()) {
        if (depth >= MAX_DEPTH) { out.truncated = true; continue; }   // 限深(实测依据见函数头注释)
        if (rootReal) {
          let rp; try { rp = fs.realpathSync(fp); } catch (_) { rp = null; }
          if (rp && rp !== rootReal && !rp.toLowerCase().startsWith(rootReal.toLowerCase() + path.sep)) continue;   // 目录逃逸校验
        }
        walk(fp, depth + 1); continue;
      }
      out.scanned++;
      if (kbDenyHit(fp.replace(/\\/g, '/').toLowerCase())) continue;    // 凭据 denylist 硬挡(与 tg walk 同闸)
      const rel = 'ANALYZED/' + path.relative(ANALYZED_BASE, fp).replace(/\\/g, '/');
      if (f.toLowerCase().indexOf(ql) !== -1 || rel.toLowerCase().indexOf(ql) !== -1) {
        out.hits.push({ kind: 'name', source: 'analyzed', path: rel, abs: fp, size: st.size, line: null, snippet: '' });
        continue;
      }
      if (mode !== 'content') continue;
      if (st.size > 2 * 1024 * 1024) continue;                // 单文件 2MB 上限(local_fs_search 为 1MB, analyzed 文本语料为主放宽一档)
      let buf; try { buf = fs.readFileSync(fp); } catch (_) { continue; }
      if (buf.slice(0, 4096).includes(0)) continue;           // 二进制哨兵: 首 4096 字节含 NUL 不扫(对齐 local_fs_search)
      out.bytes += buf.length;
      const ls = buf.toString('utf8').split('\n');
      for (let i = 0; i < ls.length; i++) {
        if (out.hits.length >= max) { out.truncated = true; break; }
        if (ls[i].toLowerCase().indexOf(ql) !== -1) {
          out.hits.push({ kind: 'content', source: 'analyzed', path: rel + ':' + (i + 1), abs: fp, size: st.size, line: i + 1, snippet: ls[i].trim().slice(0, 160) });
        }
      }
    }
  })(ANALYZED_BASE, 0);
  out.ms = Date.now() - ms0;
  return out;
}

// [KBMERGE 2026-11-08] ── scope=all 三路融合检索 ──
// 路线1 远端 kbNet(E盘 corpus, scope 降级 'both', 显式 2500ms) 路线2 ekb FTS + product 包内库(worker 线程)
// 路线3 analyzed 本机库(同步受控 walk ≤2000ms)。三路先发射、同步段先跑, 汇合点 Promise.race 总闸 2700ms(t0 起):
// 任何一路超时都记 sources[].status='deadline' 并置 partial/truncated, 绝不让 kb_search 超过 3s 红线。
// 合并: 按路优先级 [server, ekb-fts, analyzed, product] 轮转取条, 以 规范化path(:line) 为键去重
// (server 与 ekb-fts 同指 E盘 corpus, 是真实的重叠面), capped at max, docs 随 body 回传。
async function kbSearchAllFusion(name, q, mode, max, args, t0) {
  const FUSION_NET_MS = 2500, FUSION_SYNC_MS = 2000, FUSION_TOTAL_MS = 2700;
  const merged = { ok: true, source: 'merged', query: q, mode: mode, scope: 'all', hits: [], docs: [],
    scanned: 0, truncated: false, partial: false, sources: [] };
  // 1) 三条异步路先发射: kbNet(HTTP socket) / ekb FTS(worker) / product(worker) 各自并行推进
  const pNet = kbNet('/kb/search', { query: q, mode: mode, scope: 'both', max: max }, FUSION_NET_MS)
    .catch(function (e) { return { error: String(e && e.message || e).slice(0, 120) }; });
  const pEkb = ekbSearch(q, { mode: mode, max: max, source: args.source, category: args.category });
  const pProd = productSearch(q, { mode: mode, max: max })
    .catch(function (e) { return { __psError: String(e && e.message || e).slice(0, 160) }; });
  // 2) 同步路 analyzed: 阻塞事件循环 ≤FUSION_SYNC_MS, 三条异步路在 socket/worker 线程层继续跑
  const a = analyzedKbSearch(q, mode, max, FUSION_SYNC_MS, Date.now());
  // 3) 汇合: 总闸(t0 起算), 超时即放弃未回路并披露 —— 不等慢路
  let net = null, fr = null, pr = null, hitDeadline = false;
  const remainMs = Math.max(0, FUSION_TOTAL_MS - (Date.now() - t0));
  if (remainMs > 0) {
    let gTimer;
    const guard = new Promise(function (r) { gTimer = setTimeout(function () { r('__FUSION_DEADLINE__'); }, remainMs); });
    const r = await Promise.race([Promise.all([pNet, pEkb, pProd]), guard]);
    clearTimeout(gTimer);
    if (r === '__FUSION_DEADLINE__') hitDeadline = true;
    else { net = r[0]; fr = r[1]; pr = r[2]; }
  } else hitDeadline = true;
  // 4) 各路结果对象化 + 状态披露
  const srv = [], ek = [], ana = [], prod = [];
  if (net && net.httpStatus === 200 && net.data && net.data.ok !== false && Array.isArray(net.data.hits)) {
    for (const h of net.data.hits) {
      if (!kbRemoteHitAllowed(h, 'both')) continue;
      srv.push({ source: 'server', path: h.path, title: h.title || '', snippet: h.snippet || '',
        body: h.body, line: h.line_start == null ? null : h.line_start });
    }
    merged.sources.push({ source: 'server', status: 'ok', hits: net.data.hits.length,
      truncated: !!net.data.truncated, ...(net.attempts ? { attempts: net.attempts } : {}) });
  } else {
    merged.sources.push({ source: 'server', status: hitDeadline ? 'deadline' : 'unavailable',
      code: 'KBMERGE_NET_FAILED', error: String((net && (net.error || (net.data && net.data.error))) || '').slice(0, 160),
      ...(net && net.attempts ? { attempts: net.attempts } : {}) });
    merged.partial = true;
  }
  if (fr && fr.ok && Array.isArray(fr.hits)) {
    for (const h of fr.hits) {
      ek.push({ source: 'ekb-fts', path: h.path, title: h.title || '', snippet: h.snippet || '',
        body: h.body, line: h.line_start == null ? null : h.line_start });
    }
    merged.sources.push({ source: 'ekb-fts', status: 'ok', engine: fr.engine, ms: fr.ms, hits: fr.hits.length, scanned: fr.scanned });
  } else {
    merged.sources.push({ source: 'ekb-fts', status: hitDeadline ? 'deadline' : 'no_hit',
      code: (fr && fr.code) || 'NO_HIT', engine: fr && fr.engine, ms: fr && fr.ms });
  }
  if (pr && !pr.__psError) {
    const ps = productSearchStatus(pr, mode, max);
    for (const line of ps.hits) prod.push({ source: 'product', path: null, line: null, snippet: line });
    merged.sources.push({ source: 'product', status: ps.missing_index.length ? 'missing_index' : 'ok',
      hits: ps.hits.length, detail: String(ps.detail || '').slice(0, 120) });
  } else {
    merged.sources.push({ source: 'product', status: hitDeadline ? 'deadline' : 'unavailable',
      code: (pr && pr.__psError) || 'PS_FAILED' });
  }
  merged.sources.push({ source: 'analyzed', status: a.status, hits: a.hits.length, scanned: a.scanned, truncated: a.truncated, ms: a.ms });
  for (const h of a.hits) ana.push({ source: 'analyzed', path: h.path, abs: h.abs, title: '', snippet: h.snippet, body: null, line: h.line });
  // 5) 轮转合并去重(server→ekb-fts→analyzed→product 优先级, 逐位轮取)
  const seen = Object.create(null);
  const longest = Math.max(srv.length, ek.length, ana.length, prod.length);
  for (let i = 0; i < longest; i++) {
    const row = [srv[i], ek[i], ana[i], prod[i]];
    for (const h of row) {
      if (!h || merged.hits.length >= max) continue;
      const kPath = h.path ? String(h.path).replace(/\\/g, '/').toLowerCase() : 'snip:' + String(h.snippet || '').slice(0, 100);
      const key = kPath + ':' + (h.line == null ? '' : h.line);
      if (seen[key]) continue;
      seen[key] = 1;
      merged.hits.push(h);
      if (h.body) merged.docs.push({ path: h.path, title: h.title || '', source: h.source, line: h.line, body: h.body });
    }
    if (merged.hits.length >= max) { merged.truncated = true; break; }
  }
  // 6) 汇总: scanned/truncated/partial + 审计
  merged.scanned = ((net && net.data && net.data.scanned) || 0) + ((fr && fr.scanned) || 0) + a.scanned + ((pr && pr.scanned) || 0);
  merged.truncated = merged.truncated || a.truncated || !!(net && net.data && net.data.truncated) || !!(fr && fr.truncated);
  merged.partial = merged.partial || merged.truncated || hitDeadline
    || merged.sources.some(function (s) { return s.status && s.status !== 'ok'; });
  merged.matched = merged.hits.length;
  merged.detail = 'fusion routes=' + merged.sources.length + (hitDeadline ? ' (deadline ' + FUSION_TOTAL_MS + 'ms)' : '');
  audit({ decision: 'FS_SEARCH', tool: name, query_hash: crypto.createHash('sha256').update(q).digest('hex').slice(0, 12),
    hits: merged.matched, mode: mode, scope: 'all', scanned: merged.scanned, truncated: merged.truncated, ms: Date.now() - t0 });
  return kbToolResult(merged);
}
const MCP_TOOLS = [
  { name: 'goal_start', description: '启动一个目标驱动的自主迭代任务：接受任意目标（渗透/逆向/分析/检索），引擎会自行拆步、调用知识库与技能目录与文件检索，逐轮落证据到 %APPDATA%\\omnishade\\goals\\<id>\\goal.jsonl。不会拒绝任何目标；max_iters=0 表示不达完成判据不停。【自主纪律】目标未完成期间必须持续想办法：穷尽当前面就换面（换阶段组合/换子域/换端口/换指纹），禁止收口、禁止说已穷尽或等用户给入口；每轮回复以具体行动结尾。返回 {id,pid,state_dir}。',
    inputSchema: { type: 'object', properties: {
      objective: { type: 'string', description: '目标描述，必填，任意自然语言' },
      id: { type: 'string', description: '可选自定义 goal id（默认自动生成）' },
      max_iters: { type: 'number', description: '轮次上限；0 或不填=无限直到完成/停止' },
      done_keywords: { type: 'string', description: '完成判据关键词，逗号分隔，如 flag{,root,拿下' },
      sleep_ms: { type: 'number', description: '每轮间隔毫秒，默认 1200' } },
      required: ['objective'] } },
  { name: 'goal_status', description: '查询目标迭代状态。不带 id 返回全部目标列表；带 id 返回该目标快照 snapshot（iter/phase/hits_total/evidence_count/last_action/last_hypothesis/done）与最近 tail 条日志。',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string', description: 'goal id；省略则列全部' },
      tail: { type: 'number', description: '返回最近 N 条日志，默认 40，上限 500' } } } },
  { name: 'goal_stop', description: '停止一个正在跑的目标迭代（写 stop.flag 并终止 worker）。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'goal_log', description: '读取目标的完整迭代日志（goal.jsonl 最后 N 行）。',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string' }, tail: { type: 'number', description: '默认 200，上限 2000' } },
      required: ['id'] } },
  { name: 'win_process', description: '列出本机 Windows 进程(tasklist)。仅当用户明确要求查看进程时使用。',
    inputSchema: { type: 'object', properties: { args: { type: 'string', description: '可选过滤参数' } } } },
  { name: 'win_services', description: '查询本机 Windows 服务状态(sc query)。只读查询。',
    inputSchema: { type: 'object', properties: { args: { type: 'string', description: '服务名, 如 query <name>' } }, required: ['args'] } },
  { name: 'win_netstat', description: '查看本机网络连接(netstat -ano)。只读。',
    inputSchema: { type: 'object', properties: { args: { type: 'string' } } } },
  { name: 'win_sysinfo', description: '获取本机系统信息(systeminfo)。只读。',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'fs_read', description: '读取指定路径的文本文件(上限 50 万字符)。full 模式支持任意路径(绝对/工作区外); sandbox 模式仅工作区内相对路径。凭据文件(denylist)始终硬挡。仅当用户明确给出路径时使用。',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: '文件路径; full 模式任意路径, sandbox 模式工作区内相对路径' } }, required: ['path'] } },
  { name: 'fs_list', description: '递归列出指定目录下的文件与大小(最多 500 项)。full 模式支持任意路径; sandbox 模式仅工作区内相对路径。',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: '目录路径; full 模式任意路径, sandbox 模式工作区内相对路径, 空=工作区根' } } } },
  { name: 'fs_hash', description: '计算指定文件的 SHA-256 摘要。full 模式支持任意路径; sandbox 模式仅工作区内相对路径。',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: '文件路径; full 模式任意路径, sandbox 模式工作区内相对路径' } }, required: ['path'] } },
  { name: 'local_fs_search', description: '在指定目录内递归搜索文件: 按文件名或文本内容匹配关键词, 返回匹配清单。full 模式支持任意路径; sandbox 模式仅工作区内相对路径。',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: '搜索关键词' },
      path: { type: 'string', description: '起始目录; full 模式任意路径, sandbox 模式工作区内相对路径, 默认工作区根' },
      max: { type: 'integer', description: '最多返回条数, 默认 50' } }, required: ['query'] } },
  { name: 'local_fs_write', description: '保存文本到指定路径并返回落点与大小(单文件 50MB 上限)。full 模式支持任意路径(绝对/工作区外); sandbox 模式仅工作区内相对路径。凭据文件(denylist)始终硬挡。',
    inputSchema: { type: 'object', properties: {
      path: { type: 'string', description: '目标路径; full 模式任意路径, sandbox 模式工作区内相对路径, 如 report.md' },
      content: { type: 'string', description: '文本内容' } }, required: ['path', 'content'] } },
  { name: 'desktop_screenshot', description: '截取本机屏幕主屏并保存 PNG 到工作区 screenshots/ 下, 返回落点与大小。仅当用户明确要求截屏时使用。',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'desktop_window_list', description: '枚举本机当前有标题的窗口(进程名/标题/ID)。只读。',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'cdp_navigate', description: '在本机 Chrome 调试实例中打开网页(仅 http/https URL), 等待加载完成并返回页面标题。', 
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: '要打开的 http/https URL' } }, required: ['url'] } },
  { name: 'cdp_click', description: '在本机 Chrome 调试实例的当前页面上点击元素(CSS 选择器)。', 
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS 选择器' } }, required: ['selector'] } },
  { name: 'cdp_eval', description: '在本机 Chrome 调试实例的当前页面执行 JavaScript 表达式并返回结果。', 
    inputSchema: { type: 'object', properties: { expression: { type: 'string', description: 'JS 表达式' } }, required: ['expression'] } },
  { name: 'cdp_screenshot', description: '对本机 Chrome 调试实例的当前页面截图并保存 PNG 到工作区 screenshots/ 下, 返回落点与大小。', 
    inputSchema: { type: 'object', properties: {} } },
  { name: 'process_list', description: '列出本机 Windows 进程(tasklist)。只读枚举。', 
    inputSchema: { type: 'object', properties: { args: { type: 'string', description: '可选 tasklist 参数, 如 /FI "IMAGENAME eq chrome.exe"' } } } },
  { name: 'taskkill', description: '定点结束本机单个 Windows 进程(按数字 PID)。仅当用户明确给出要结束的进程时使用。', 
    inputSchema: { type: 'object', properties: { pid: { type: 'integer', description: '目标进程 PID' }, force: { type: 'boolean', description: '默认 true(/F 强制)' } }, required: ['pid'] } },
  { name: 'sys_exec', description: '在本机执行 Windows 命令行并返回 stdout/stderr。full 模式任意命令路径放行; 磁盘毁灭类命令(mkfs/rm -rf //fork bomb/dd 写盘)与凭据文件(denylist)始终硬挡。',
    inputSchema: { type: 'object', properties: { cmd: { type: 'string', description: '完整命令行' } }, required: ['cmd'] } },
  { name: 'skill_list', description: '列出可用技能/知识库条目: 数据源为技能总索引(约1.9万行)与本机 Hermes skills 目录实时枚举, 支持类目过滤与关键词检索。只读。',
    inputSchema: { type: 'object', properties: {
      category: { type: 'string', description: '类目过滤, 如 security 或 08-LLM与AI安全' },
      query: { type: 'string', description: '关键词(匹配技能名/描述/路径)' },
      source: { type: 'string', enum: ['all', 'csv', 'hermes', 'product', 'tools', 'kb'], description: '数据源, 默认 all 合并 product/csv/hermes; 返回 skill_id/source/path(可直接读取)' },
      max: { type: 'integer', description: '最多返回条数, 默认 50, 上限 200' } } } },
  { name: 'skill_cache_clear', description: '[G8] 清空/探查技能目录缓存(_SKILL_CATALOG_CACHE, 默认上限 64 个 source|category 键)。换索引或排查内存时调用; 不带 confirm 只返回当前大小。带 source=按该源前缀清理, sweep=true=只删 TTL 过期项。',
    inputSchema: { type: 'object', properties: {
      confirm: { type: 'boolean', description: 'true=执行清理; 不传=只探查当前缓存大小' },
      source: { type: 'string', enum: ['all', 'product', 'csv', 'hermes', 'tools', 'kb'], description: '只清该 source 前缀的键(source|category); 不传=全清' },
      sweep: { type: 'boolean', description: 'true=只删除已过 TTL 的条目(不清未过期的)' } } } },
  { name: 'skill_read', description: '读取单个文件(SKILL.md 或附属文件)并返回全文。full 模式支持任意路径; sandbox 模式仅白名单技能目录内。单文件上限 512KB, 超限报错不截断。凭据文件(denylist)始终硬挡。只读。',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: '文件路径; full 模式任意路径, sandbox 模式白名单内路径(绝对路径或相对白名单根, 如 security/src-web-recon/SKILL.md 或 R1/红队知识库-全网/00-全库导览.md)' } }, required: ['path'] } },
  { name: 'web_search', description: '互联网检索（知识库查不到时的兜底通道）。当 kb_search 没有命中或命中不足以回答问题时，用它查公网资料。返回标题/链接/摘要列表。只读。',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: '搜索关键词' },
      max: { type: 'number', description: '返回条数，默认 8，上限 20' } }, required: ['query'] } },
  { name: 'kb_search', description: '三路融合检索: scope=tg/redteam/both=远端 HK E盘知识库(FTS+白名单); product=包内产品库(FTS 引用式); analyzed=D:\\分析到的 本机资料库 grep 级(文件名+内容, 限深限流单查询≤3s); all=三路并发(E盘远端+产品库+本机分析库)轮转合并去重, 单查询≤3s, 超时路记 truncated 并在 sources 披露。mode=name 按文件名/索引匹配, mode=content 全文检索。只读。',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: '搜索关键词' },
      scope: { type: 'string', enum: ['tg', 'redteam', 'both', 'product', 'analyzed', 'all'], description: '检索范围, 默认 both; product=产品库, redteam=R3, analyzed=D:\\分析到的 本机库, all=三路融合' },
      mode: { type: 'string', enum: ['name', 'content'], description: 'name=文件名/索引匹配(默认), content=全文' },
      path: { type: 'string', description: '可选: content 模式指定单个行文件' },
      source: { type: 'string', description: '可选: E盘知识库顶层目录收窄(如 01-开源安全库 / 02-老K本地知识库)' },
      category: { type: 'string', description: '可选: 二级目录收窄(如 OWASP-CheatSheets)' },
      max: { type: 'integer', description: '最多返回条数, 默认 50, 上限 200' } }, required: ['query'] } },
  { name: 'kb_read', description: '读取单个知识库文件并返回全文。full 模式支持任意路径; sandbox 模式仅白名单内。单文件上限 512KB, 超限报错不截断。凭据文件(denylist)始终硬挡。只读。',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: '文件路径; full 模式任意路径, sandbox 模式白名单内路径(绝对路径或相对白名单根)' } }, required: ['path'] } },
  // ── [LOOT-MCP 2026-11-07] lootchain 攻击链 ── 变种组合/自动研判/自动创新组合 ──
  // 产品口径：39 阶段是积木不是模板。AI 应当 run(部分阶段) → findings 研判 →
  // 再 run 下一组组合，循环到目标拿下；stages 留空则交给 lootchain 的 brain 自适应。
  { name: 'lootchain_stages', description: '列出 lootchain 全部 39 个攻击阶段（积木清单：阶段名+中文描述）。编排攻击组合前先看这个。典型组合示例：先单跑 recon 摸底 → 研判后再组合 discover,js_api,inject 定向打击 → 拿下后 persist,privesc,lateral 扩大战果。',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'lootchain_run', description: '启动攻击链作业（异步，立即返回 jobId）。stages 不填=brain 自适应全链；填逗号分隔的阶段名=自由编排组合（如 "recon" 单跑、如 "js_api,idor,inject" 变种链），未知阶段名会直接报错。targets 每行一个 URL。【自主循环纪律】启动后必须自动循环：lootchain_log 跟踪到 eof → lootchain_findings 研判 → 战果显示还有未覆盖的攻击面就直接再 run 下一组组合继续打（不必等用户确认）→ 攻击面穷尽才用 lootchain_report 出最终报告。用户说「打这个站」「摸一下 TARGET」时直接用本工具。',
    inputSchema: { type: 'object', properties: {
      targets: { type: 'string', description: '目标列表，每行一个 URL（必填）' },
      stages: { type: 'string', description: '逗号分隔阶段组合；不填=自适应全链。可多轮不同组合反复调用' },
      name: { type: 'string', description: '可选作业名（默认自动生成）' } }, required: ['targets'] } },
  { name: 'lootchain_jobs', description: '列出全部攻击链作业（jobId/状态/阶段组合/时长/工作目录）。',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'lootchain_log', description: '增量读取某作业的运行日志：返回 {text, nextOffset, eof, status}。轮询时把上次返回的 nextOffset 传回 offset 参数。',
    inputSchema: { type: 'object', properties: {
      jobId: { type: 'string', description: '作业 ID' },
      offset: { type: 'number', description: '上次读到的字节偏移，首次为 0' } }, required: ['jobId'] } },
  { name: 'lootchain_findings', description: '研判原料：读取某作业的阶段产出——findings.csv 逐行战果 + loot 目录缴获文件清单 + 报告是否已生成。跑完一组组合后必读这个，据此决定下一组阶段怎么编排（比如发现 sql 注入点就接着 inject,creds；发现 OSS 凭据就接着 cloud,bucket）。',
    inputSchema: { type: 'object', properties: { jobId: { type: 'string', description: '作业 ID' } }, required: ['jobId'] } },
  { name: 'lootchain_report', description: '读取某作业的最终报告（report.md 全文 + report.json 结构化数据）。作业未跑完时报错属正常。',
    inputSchema: { type: 'object', properties: { jobId: { type: 'string', description: '作业 ID' } }, required: ['jobId'] } },
  { name: 'lootchain_stop', description: '强制停止某作业（杀整个进程树）。',
    inputSchema: { type: 'object', properties: { jobId: { type: 'string', description: '作业 ID' } }, required: ['jobId'] } },

  // ── [WEAPON-MCP 2026-11-08] 统一武器线 ── 多武器 registry 接入 AI 工具面 ──
  // 武器线=单点深耕武器（各带 registry.json，动态扫描注册，缺的自动跳过）；
  // lootchain=全链大杀器。同一个目标的攻击面两套交替组合打。
  { name: 'artex_tasks', description: '列出 ARTEX 全部渗透任务（id/name/status/goals 进度/findings 分档）。会话闭环第一步：先看已有任务。',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'artex_run', description: '在 ARTEX 里创建渗透任务（自主目标式：给 goal 描述+完成判据，ARTEX 的规划器/工人池自主拆解执行）。创建后立即 artex_log 轮询任务会话流跟踪；LLM 工人未配置时任务停在 created，需先 artex_llm_set。',
    inputSchema: { type: 'object', properties: {
      goal: { type: 'string', description: '目标与完成判据（必填，例：对 TARGET 完成子域测绘与弱口令面排查，产出可复核证据）' },
      description: { type: 'string', description: '任务描述（不填复用 goal）' },
      name: { type: 'string', description: '可选任务名' } }, required: ['goal'] } },
  { name: 'artex_log', description: '读取 ARTEX 任务会话流（tasks/{id}/chat：规划/工人消息/判定全在里面）。轮询跟踪用，配合 artex_run 形成会话内闭环。',
    inputSchema: { type: 'object', properties: {
      taskId: { type: 'string', description: '任务 id（artex_tasks 或 artex_run 返回）' } }, required: ['taskId'] } },
  { name: 'artex_findings', description: '拉取 ARTEX 全局侦察战果（exploration findings：发现/证据/深挖线索）。研判与续跑前先看这个。',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'artex_llm_set', description: '给 ARTEX 配置 LLM 工人池（provider=anthropic/openai 兼容，base_url/model/key）。未配置时任务停在 created；配好后任务自主跑。',
    inputSchema: { type: 'object', properties: {
      provider: { type: 'string', description: 'anthropic | openai' },
      baseUrl: { type: 'string', description: 'OpenAI 兼容端点（如 https://host/v1）' },
      model: { type: 'string', description: '模型名' },
      key: { type: 'string', description: 'API Key' } } } },
  { name: 'artex_api', description: 'ARTEX 全能力透传：直接调它的任意 REST 端点（74 条路由：companies/scope、task-templates、skills/upload、tools/custom、mcp、intercept 流量拦截、notify、settings、exploration 深挖等）。path 以 api/ 开头。这是"完完整整合成"的万能口。',
    inputSchema: { type: 'object', properties: {
      method: { type: 'string', description: 'GET/POST/PUT/DELETE，默认 GET' },
      path: { type: 'string', description: 'api/ 开头的端点路径（例 api/tasks、api/companies）' },
      body: { type: 'object', description: 'POST/PUT 的 JSON body' } }, required: ['path'] } },
  { name: 'artex_control', description: '自主渗透控制台 ARTEX 的启停与探活（独立部署的 Go 控制台, Web UI 127.0.0.1:8790, 含任务编排/工人池/流量录制代理 8788）。action=status 返回 {deployed, alive, url}；action=start 拉起（已在跑则幂等返回）；深入任务编排用它的 Web UI 或其 /api（AI 需要时经 sys_exec curl 127.0.0.1:8790）。',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', description: 'status | start' } }, required: ['action'] } },
  { name: 'weapons_list', description: '列出本机全部已注册武器线（name/desc/stages 清单，registry.json 动态扫描，建设中未落地的武器自动跳过）。编排武器打击前先看这个。与 lootchain 的分工：lootchain 是全链大杀器，武器线是单点深耕（子域/指纹/爆破/LFI SSRF/上传/POC 库等）——同一个目标两套交替组合打。',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'weapon_run', description: '启动武器作业（异步，立即返回 jobId）。weapon=武器名（见 weapons_list）；stages 逗号分隔该武器支持的阶段（不填=all 全阶段），未知阶段名直接报错；targets 每行一个 URL。【自主纪律】启动后必须自动循环：weapon_log 跟踪到 eof → weapon_findings 研判战果 → 战果有未覆盖的线索就换姿势继续（换武器/换阶段组合/换攻击面）再 weapon_run，未穷尽不打烊，不必等用户确认；攻击面穷尽或用户叫停才收口总结。',
    inputSchema: { type: 'object', properties: {
      weapon: { type: 'string', description: '武器名（weapons_list 里的 name，必填）' },
      targets: { type: 'string', description: '目标列表，每行一个 URL（必填）' },
      stages: { type: 'string', description: '逗号分隔阶段组合；不填=all 全阶段。可多轮不同组合反复调用' },
      name: { type: 'string', description: '可选作业名（默认自动生成）' } }, required: ['weapon', 'targets'] } },
  { name: 'weapon_log', description: '增量读取某武器作业的运行日志：返回 {text, nextOffset, eof, status}。轮询时把上次返回的 nextOffset 传回 offset 参数。',
    inputSchema: { type: 'object', properties: {
      jobId: { type: 'string', description: '作业 ID' },
      offset: { type: 'number', description: '上次读到的字节偏移，首次为 0' } }, required: ['jobId'] } },
  { name: 'weapon_findings', description: '研判原料：读取某武器作业的 findings.jsonl 战果行（自动定位落盘路径，非 JSON 行原样保留）。跑完必读这个，据此决定下一组怎么编排。【自主纪律】读完必须研判：有可深挖线索立即 weapon_run 下一组（换武器或换阶段组合）继续打，未穷尽不打烊。',
    inputSchema: { type: 'object', properties: { jobId: { type: 'string', description: '作业 ID' } }, required: ['jobId'] } },
  { name: 'weapon_stop', description: '强制停止某武器作业（杀整个进程树）。',
    inputSchema: { type: 'object', properties: { jobId: { type: 'string', description: '作业 ID' } }, required: ['jobId'] } },
  { name: 'weapon_jobs', description: '列出全部武器线作业（jobId/武器/状态/阶段组合/工作目录）。',
    inputSchema: { type: 'object', properties: {} } },
];

// 禁止: 写盘/删除/下载/脚本解释器
const WRITE_GUARD = /(\bcmd\b|\bpowershell\b|\bwscript\b|\bcscript\b|\bmshta\b|\brundll32\b|\breg\b|\bsc\s+(config|delete|create)|\bdel\b|\brd\b|\bformat\b|\bshutdown\b|\btaskkill\b|\bsetx\b|\bregedit\b|(&|\|\||>|>|`))/i;

// DISASTER guard(客户端化): 判据对齐服务端 omni_mcp_compat.py DISASTER 正则
// (服务端: mkfs\. | rm\s+-rf\s+/(\s|$) | :\(\)\{ | dd\s+if=.*of=/dev/[sh]d, re.I)
// 客户端在 Windows 侧同样只拦磁盘毁灭类; 对 rm -rf / 追加 /* 变体; 不拦 taskkill 单进程定点结束。
const DISASTER_GUARD = /(mkfs\.|rm\s+-rf\s+\/(\s|$|\*)|:\(\)\{|dd\s+if=.*of=\/dev\/[sh]d)/i;
// sys_exec 读命令路径参数 confinement(2026-09-27): type/type$/cat/more/Get-Content 等读命令的路径参数
// sandbox: 走 kbResolve 同一套白名单+denylist 闸, 越界/命中凭据文件 → SCOPE_BLOCKED(防 E2E B01 白名单外凭据文件 EXEC 回显)
// 显式 full: 白名单闸放行(任意命令路径), 仅 denylist(凭据文件)照旧硬挡
const READ_CMD_RE = /\b(?:type|type\$|cat|more|get-content|gc)\s+("([^"]*)"|([^\s"&|<>]+))/gi;
function sysExecPathGuard(cmd) {
  const re = new RegExp(READ_CMD_RE.source, 'gi');
  let m;
  while ((m = re.exec(String(cmd || ''))) !== null) {
    let p = (m[2] !== undefined ? m[2] : m[3] || '').trim();
    if (!p) continue;
    if (/^(\/|-|%|\$\(|\.\.?)[\\/!]?$/.test(p) && !/^%[a-zA-Z_]+%[\\/]/.test(p)) continue; // flags/空参
    if (PERM_MODE === 'full') {
      const pN = p.replace(/\\/g, '/').toLowerCase();
      // [G15 加固] 同 kbResolve: 形态判定走 kbDenyHard, 凭据判定不受 full 的形态豁免影响。
      // (当前 sysExecPathGuard 只在 sandbox 分支被调用, 此处改后若将来接回 full 也不会漏凭据。)
      const denyP = kbDenyHard(pN);
      if (denyP) {
        audit({ decision: 'SCOPE_BLOCKED', tool: 'sys_exec', path_head: p.slice(0, 60), deny: denyP });
        throw new Error('SCOPE_BLOCKED: sys_exec 读命令路径命中 denylist(' + denyP + '), 已硬挡');
      }
      continue;
    }
    try { kbResolve(p, 'sys_exec'); }
    catch (e) {
      audit({ decision: 'SCOPE_BLOCKED', tool: 'sys_exec', path_head: p.slice(0, 60) });
      throw new Error('SCOPE_BLOCKED: sys_exec 读命令路径越界被拒(' + p.slice(0, 80) + ')');
    }
  }
}

// [1.1.35] 桥跑在**子进程**(避免同步扫盘冻结主进程/UI) → Electron 专属能力走 IPC 回传主进程执行
let _ipcSeq = 0;
function ipcAvailable() { return typeof process.send === 'function'; }
function ipcRequest(method, params) {
  if (!ipcAvailable()) return Promise.reject(new Error('IPC_UNAVAILABLE: 桥不在子进程模式'));
  const id = ++_ipcSeq;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { process.off('message', h); reject(new Error('IPC_TIMEOUT: ' + method)); }, 30000);
    const h = (m) => {
      if (!m || m.type !== 'omni-ipc-res' || m.id !== id) return;
      clearTimeout(t); process.off('message', h);
      if (m.error) reject(new Error(String(m.error))); else resolve(m.result);
    };
    process.on('message', h);
    process.send({ type: 'omni-ipc-req', id, method, params: params || {} });
  });
}

// desktopCapturer 仅在 Electron 主进程可用(桥在主进程时直接可用; 子进程模式下走 IPC 回传)
let _dc = null;
function desktopCapturer() {
  if (_dc !== null) return _dc;
  try {
    const e = require('electron');
    _dc = (e && typeof e === 'object' && e.desktopCapturer) ? e.desktopCapturer : false;
  } catch (_) { _dc = false; }
  return _dc;
}

// ── CDP(网页控制): Chrome DevTools Protocol 客户端(零依赖: net+crypto 手写 WS) ──
// 调试端口只绑 127.0.0.1; Chrome ≥136 禁止默认 profile 开调试端口 → 统一用独立 profile
const CDP_PORT = parseInt(process.env.OMNI_CDP_PORT || '9333', 10);
const CDP_URL_BLOCK = /^(file|chrome|devtools|view-source|javascript|data|about):/i;
const CDP_CHROME_DIRS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || os.homedir(), 'Google', 'Chrome', 'Application', 'chrome.exe'),
];
const CDP_PROFILE_DIR = path.join(APPDATA_DIR, 'cdp-profile');
const CDP_STATE = path.join(APPDATA_DIR, 'cdp-instance.json');

function findChromeExe() {
  for (const p of CDP_CHROME_DIRS) { try { if (fs.existsSync(p)) return p; } catch (_) {} }
  return null;
}
function chromeRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], { timeout: 8000, windowsHide: true },
      (err, stdout) => resolve(!err && String(stdout || '').toLowerCase().includes('chrome.exe')));
  });
}
function cdpHttpRequest(port, method, urlPath, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: method || 'GET', timeout: timeoutMs || 3000 }, (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}
// Chrome 启动管理: 端口占用检测(9333 /json/version) → 不通时拉起(独立 profile, 只绑 127.0.0.1)
let _cdpLaunchPromise = null;   // [2026-10-29 巡检修复] 单飞锁: 并发 cdp_* 调用复用同一启动流程, 避免重复拉起 Chrome 抢端口/覆盖 CDP_STATE
async function ensureCdp() {
  if (_cdpLaunchPromise) return _cdpLaunchPromise;
  const launch = (async () => {
    let v = await cdpHttpRequest(CDP_PORT, 'GET', '/json/version', 1200);
    if (v && v.status === 200) return { launched: false };
    const chrome = findChromeExe();
    if (!chrome) throw new Error('CDP_FAIL: 未找到 chrome.exe 且调试端口 ' + CDP_PORT + ' 不可用');
    const child = spawn(chrome, [
      '--remote-debugging-port=' + CDP_PORT,
      '--remote-debugging-address=127.0.0.1',
      '--remote-allow-origins=*',
      '--user-data-dir=' + CDP_PROFILE_DIR,
      '--no-first-run', '--no-default-browser-check', '--disable-features=DialMediaRouteProvider',
    ], { detached: true, windowsHide: false, stdio: 'ignore' });
    child.unref();
    try {
      fs.mkdirSync(APPDATA_DIR, { recursive: true });
      fs.writeFileSync(CDP_STATE, JSON.stringify({ pid: child.pid, profile: 'isolated', port: CDP_PORT, ts: Date.now() }));
    } catch (_) {}
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      v = await cdpHttpRequest(CDP_PORT, 'GET', '/json/version', 1200);
      if (v && v.status === 200) {
        audit({ decision: 'CDP_LAUNCH', profile: 'isolated', pid: child.pid, port: CDP_PORT });
        return { launched: true, pid: child.pid };
      }
    }
    throw new Error('CDP_FAIL: Chrome 调试端口 ' + CDP_PORT + ' 启动超时(端口占用或启动失败)');
  })();
  _cdpLaunchPromise = launch;
  try { return await launch; }
  finally { _cdpLaunchPromise = null; }
}
async function cdpTarget() {
  const list = await cdpHttpRequest(CDP_PORT, 'GET', '/json/list', 2000);
  let tabs = [];
  try { tabs = JSON.parse(list.body).filter((t) => t.type === 'page'); } catch (_) {}
  const usable = tabs.filter((t) => !CDP_URL_BLOCK.test(String(t.url || 'about:blank')));
  let tab = usable.find((t) => /^https?:/i.test(t.url)) || usable[0] || null;
  if (!tab) {
    const created = await cdpHttpRequest(CDP_PORT, 'PUT', '/json/new?about:blank', 3000);
    try { tab = JSON.parse(created.body); } catch (_) {}
    if (!tab || !tab.webSocketDebuggerUrl) throw new Error('CDP_FAIL: 无可用页面 target 且新建失败');
  }
  return tab;
}
function cdpWsPath(tab) {
  try { const u = new URL(tab.webSocketDebuggerUrl); return u.pathname + (u.search || ''); }
  catch (_) { throw new Error('CDP_FAIL: target 无 webSocketDebuggerUrl'); }
}
// 极简 WS 客户端(客户端帧必须 mask; 处理分片/ping; 上限 64MB 供截图 base64)
function wsFrame(op, data) {
  const mask = crypto.randomBytes(4);
  let header;
  if (data.length < 126) { header = Buffer.alloc(2); header[1] = 0x80 | data.length; }
  else if (data.length < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
  else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
  header[0] = 0x80 | op;
  const masked = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}
function wsConnect(port, wsPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => { try { sock.destroy(); } catch (_) {} reject(new Error('WS connect timeout')); }, timeoutMs || 5000);
    let buf = Buffer.alloc(0), upgraded = false, frag = null;
    const listeners = [];
    function feed() {
      for (;;) {
        if (buf.length < 2) return;
        const b0 = buf[0], b1 = buf[1];
        const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) {
          if (buf.length < 10) return;
          const big = buf.readBigUInt64BE(2);
          if (big > BigInt(64 * 1024 * 1024)) { try { sock.destroy(); } catch (_) {} return; }
          len = Number(big); off = 10;
        }
        if (buf.length < off + len + (masked ? 4 : 0)) return;
        if (masked) off += 4; // 服务端帧从不 mask
        const payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if (op === 0x8) { try { sock.destroy(); } catch (_) {} return; }
        if (op === 0x9) { try { sock.write(wsFrame(0xA, payload)); } catch (_) {} continue; }
        if (frag) frag.chunks.push(payload); else frag = { chunks: [payload] };
        if (fin) {
          const msg = Buffer.concat(frag.chunks).toString('utf8');
          frag = null;
          for (const l of listeners) { try { l(msg); } catch (_) {} }
        }
      }
    }
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buf.slice(0, idx).toString('utf8');
        buf = buf.slice(idx + 4);
        upgraded = true;
        clearTimeout(timer);
        if (!/^HTTP\/1\.1 101/.test(head)) { try { sock.destroy(); } catch (_) {} return reject(new Error('WS handshake failed: ' + head.split('\r\n')[0].slice(0, 60))); }
        resolve({
          onMessage: (fn) => listeners.push(fn),
          send: (text) => sock.write(wsFrame(0x1, Buffer.from(text, 'utf8'))),
          close: () => { try { sock.write(wsFrame(0x8, Buffer.alloc(0))); } catch (_) {} try { sock.destroy(); } catch (_) {} },
        });
      }
      feed();
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      if (!upgraded) reject(new Error('WS connect fail: ' + String(e.message || e).slice(0, 80)));
    });
    sock.write('GET ' + wsPath + ' HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\nOrigin: http://127.0.0.1:' + port + '\r\n\r\n');
  });
}
async function cdpSession(wsPath) {
  const ws = await wsConnect(CDP_PORT, wsPath, 5000);
  let nextId = 1;
  const pending = new Map();
  const eventListeners = [];
  ws.onMessage((msg) => {
    let m; try { m = JSON.parse(msg); } catch (_) { return; }
    for (const l of eventListeners) { try { l(m); } catch (_) {} }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error('CDP: ' + ((m.error.message || 'error') + '').slice(0, 150)));
      else p.resolve(m.result);
    }
  });
  return {
    send(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 25000);
      });
    },
    addEventListener: (fn) => eventListeners.push(fn),
    removeEventListener: (fn) => { const i = eventListeners.indexOf(fn); if (i >= 0) eventListeners.splice(i, 1); },
    close: ws.close,
  };
}
async function cdpEval(session, expr) {
  const r = await session.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r && r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('CDP_EVAL_FAIL: ' + String((d.exception && d.exception.description) || d.text || 'exception').slice(0, 200));
  }
  return r && r.result ? r.result.value : null;
}
function waitLoadEvent(session, timeoutMs) {
  return new Promise((resolve) => {
    const fn = (m) => { if (m && m.method === 'Page.loadEventFired') { clearTimeout(t); session.removeEventListener(fn); resolve(); } };
    const t = setTimeout(() => { session.removeEventListener(fn); resolve(); }, timeoutMs || 12000); // 超时按已导航处理
    session.addEventListener(fn);
  });
}

// [release] Product corpus walks/full-text scans run off the bridge event loop.
// A slow search must not make a tool-enabled chat look frozen or block /health.
// [G8-修复 2026-10-31] 原实现: 每个请求 new Worker 一次。不是泄漏(finish/timeout 都 terminate),
// 但每条检索都要付一次 V8 isolate 启动 + product 索引冷读 → 延迟抖动(G8 §4-P2)。
// 改成常驻一代 + 空闲退出, 模式完全对齐 kb_fts_worker.js:
//   1) 启动握手: worker 回 {ready:true} 才发请求(不然冷启动那一跳会被算进执行超时)
//   2) 每代一张 pending 表: 旧代死亡只回收自己那张表, 不误伤新代在飞的请求(ekb 早年踩过的坑)
//   3) 执行超时从 worker 回 {kind:'begin'} 那一刻起计: 排队时间不算查询超时
//   4) 空闲 OMNI_PS_WORKER_IDLE_MS(默认 300000)后 worker 自己 exit(0), 线程堆/页缓存归还 OS
//   5) 重试耗尽才抛(调用方 kb_search 已有 try/catch 降级到 source 状态, 语义与原实现一致)
const PS_TIMEOUT_MS = ekbClampInt('OMNI_PS_TIMEOUT_MS', 20000, 1000, 600000);        // 单条检索执行预算
const PS_QUEUE_MS = ekbClampInt('OMNI_PS_QUEUE_MS', 60000, 1000, 600000);            // 排队等 begin 的上限
const PS_BOOT_MS = ekbClampInt('OMNI_PS_BOOT_MS', 30000, 1000, 300000);              // 启动握手上限
const PS_MAX_RETRY = ekbClampInt('OMNI_PS_MAX_RETRY', 1, 0, 5);                      // 该代死了最多重排几代
const PS_IDLE_MS = ekbClampInt('OMNI_PS_WORKER_IDLE_MS', 300000, 1000, 3600000);     // 空闲退出(经 workerData 传给 worker)

let _psGen = null;       // 当前代 { w, pending:Map, ready, dead, bootTimer }
let _psBooting = null;   // 正在启动的那一代(Promise)
let _psSeq = 0;
let _psBroken = false;   // worker 结构性不可用: 不再反复 spawn

function psSpawnGen() {
  return new Promise((resolve, reject) => {
    if (_psBroken) { const e = new Error('PS_WORKER_BROKEN: worker 结构性不可用'); e.psCode = 'PS_WORKER_BROKEN'; e.psRetry = false; return reject(e); }
    let gen;
    try {
      const { Worker } = require('worker_threads');
      gen = { w: new Worker(path.join(__dirname, 'product_search_worker.js'), { workerData: {
          productDir: PRODUCT_DIR, productKbDir: PRODUCT_KB_DIR, productSkillsIndex: PRODUCT_SKILLS_INDEX,
          idleMs: PS_IDLE_MS,   // 空闲退出阈值: worker 侧自己计时, 到点 parentPort.close()
        } }), pending: new Map(), ready: false, dead: false, bootTimer: null, born: Date.now() };
      // 常驻线程不该把进程钉住: http server 一关, 进程能正常退出
      if (gen.w.unref) gen.w.unref();
    } catch (e) { _psBroken = true; e.psCode = 'PS_WORKER_SPAWN_FAILED'; e.psRetry = false; return reject(e); }
    let settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(gen.bootTimer); fn(v); };
    gen.bootTimer = setTimeout(() => {
      psKill(gen, 'boot timeout', 'PS_WORKER_BOOT_TIMEOUT');
      const e = new Error('PS_WORKER_BOOT_TIMEOUT: worker 启动握手超时 ' + PS_BOOT_MS + 'ms');
      e.psCode = 'PS_WORKER_BOOT_TIMEOUT'; e.psRetry = true;
      finish(reject, e);
    }, PS_BOOT_MS);
    gen.w.on('message', (m) => {
      if (!m) return;
      if (m.ready === true) { gen.ready = true; return finish(resolve, gen); }
      if (m.ready === false) {
        _psBroken = true;
        psKill(gen, 'ready=false: ' + String(m.error || '').slice(0, 160), 'PS_WORKER_BROKEN');
        const e = new Error('PS_WORKER_BROKEN: ' + String(m.error || 'search worker unavailable').slice(0, 200));
        e.psCode = 'PS_WORKER_BROKEN'; e.psRetry = false;
        return finish(reject, e);
      }
      const p = gen.pending.get(m.id);
      if (!p) return;                     // 跨代/已结算消息: 丢弃
      if (m.kind === 'begin') {           // worker 真正开始执行: 从这一刻起才计执行超时
        clearTimeout(p.execTimer);
        p.execTimer = setTimeout(() => psKill(gen, 'exec timeout ' + p.timeoutMs + 'ms', 'PS_TIMEOUT'), p.timeoutMs);
        return;
      }
      gen.pending.delete(m.id);
      clearTimeout(p.execTimer); clearTimeout(p.queueTimer);
      if (p.settled) return;
      p.settled = true;
      if (m.ok) p.resolve(m.result);
      else { const e = new Error(String(m.error || 'product search failed').slice(0, 500)); e.psCode = String(m.code || 'PS_WORKER_ERROR'); p.reject(e); }
    });
    gen.w.on('error', (e) => {
      _psBroken = true;                   // 一次 error 多半是 require/驱动层面的结构性问题, 别无限重启
      psKill(gen, 'error: ' + String(e && e.message || e).slice(0, 160), 'PS_WORKER_ERROR');
      const err = new Error('PS_WORKER_ERROR: ' + String(e && e.message || e).slice(0, 200));
      err.psCode = 'PS_WORKER_ERROR'; err.psRetry = true;
      finish(reject, err);
    });
    gen.w.on('exit', (code) => {
      psKill(gen, 'exit ' + code, code === 0 ? 'PS_WORKER_IDLE_EXIT' : 'PS_WORKER_EXIT');
      const err = new Error('PS_WORKER_' + (code === 0 ? 'IDLE_EXIT' : 'EXIT') + ': ' + code);
      err.psCode = code === 0 ? 'PS_WORKER_IDLE_EXIT' : 'PS_WORKER_EXIT'; err.psRetry = true;
      finish(reject, err);
    });
  });
}

// 干掉一代: 只回收它自己的 pending(标记为可重试), 不动别代在飞的请求
function psKill(gen, why, code) {
  if (!gen || gen.dead) return;
  gen.dead = true;
  clearTimeout(gen.bootTimer);
  if (_psGen === gen) _psGen = null;
  const stuck = [...gen.pending.values()];
  gen.pending.clear();
  try { gen.w.terminate(); } catch (_) {}
  const c = String(code || 'PS_WORKER_GONE');
  for (const p of stuck) {
    clearTimeout(p.execTimer); clearTimeout(p.queueTimer);
    if (p.settled) continue;
    p.settled = true;
    const e = new Error(c + ': ' + why);
    e.psCode = c; e.psRetry = true;
    p.reject(e);
  }
  try { audit({ decision: 'PS_WORKER_KILL', code: c, why: String(why).slice(0, 160), stuck: stuck.length }); } catch (_) {}
}

function psReady() {
  if (_psGen && _psGen.ready && !_psGen.dead) return Promise.resolve(_psGen);
  if (_psBooting) return _psBooting;
  const p = psSpawnGen().then((gen) => {
    _psGen = gen;
    if (_psBooting === p) _psBooting = null;
    return gen;
  }, () => {
    if (_psBooting === p) _psBooting = null;
    _psGen = null;
    return null;
  });
  _psBooting = p;
  return p;
}

function psAttempt(msg, timeoutMs, attempt) {
  return psReady().then((gen) => {
    if (!gen) throw new Error('PS_WORKER_UNAVAILABLE: worker 起不来');
    if (gen.dead) throw new Error('PS_WORKER_GONE: 该代 worker 已回收');
    return new Promise((resolve, reject) => {
      const id = ++_psSeq;
      const p = { id, resolve, reject, timeoutMs: timeoutMs || PS_TIMEOUT_MS, settled: false, execTimer: null, queueTimer: null, born: Date.now() };
      p.queueTimer = setTimeout(() => psKill(gen, 'queue wait ' + PS_QUEUE_MS + 'ms', 'PS_QUEUE_TIMEOUT'), PS_QUEUE_MS);
      gen.pending.set(id, p);
      try {
        gen.w.postMessage(Object.assign({ id }, msg));
      } catch (e) {
        gen.pending.delete(id); clearTimeout(p.queueTimer);
        reject(e);
      }
    });
  }).catch((e) => {
    const retryable = !!(e && e.psRetry) && !_psBroken;
    if (retryable && attempt < PS_MAX_RETRY) {
      try { audit({ decision: 'PS_RETRY', attempt: attempt + 1, err: String(e && e.message || e).slice(0, 160) }); } catch (_) {}
      return psAttempt(msg, timeoutMs, attempt + 1);
    }
    throw e;
  });
}

function productSearch(q, opts) { return psAttempt({ query: String(q || ''), opts: opts || {} }, PS_TIMEOUT_MS, 0); }
// [EKB-FTS] E 盘知识库检索(FTS5, 引用式不拷贝)。
// 放在 worker 里: 偶发慢查询(热 journal / 冷页缓存)不能卡住 bridge 事件循环(与 productSearch 同策略)。
//
// ── 2026-10-30 实测(E:\KnowledgeBase\知识库\kb_index.db 1125MB / 162379 chunk, win32, node v26) ──
//   warm(冷页) 23.3s | 渗透 11.1s | volatility 19.8s | 页缓存热了之后同类查询 0.2~2ms。
//   旧默认 30s 超时扛不住冷页 → terminate → 旧代 exit(1) 事件把新代在飞的请求一起 reject
//   → "EKB_WORKER_RESTART: worker 重启中"(旧代码的 _ekbPending 是全局表, 跨代互杀, 这是第一病根)。
//   第二病根: kb_fts.search() 把 sqlite 句柄挂到 out.db 上, worker postMessage 抛
//   "Cannot clone object of unsupported type" 被 reply() 的 catch(_) 吞掉 → worker 静默挂死 → 必然超时。
//
// 现在的设计(任何情况下都不靠抛错收场):
//   1) 一代 worker 一张 pending 表: 旧代死亡只回收自己那张表, 不会误伤新代在飞的请求。
//   2) 启动握手: 收到 {ready:true} 才发请求; 重启期间的请求排队等新代 ready, 不是立刻抛。
//   3) 执行超时从 worker 回 {kind:'begin'} 那一刻才计时: 排队等冷页/预热的时间不算查询超时。
//   4) warm 走独立的一次性 worker: 冷页预热(实测 23s+)绝不会挡住或拖死在线查询。
//   5) 查询超时默认提到 90s(OMNI_EKB_TIMEOUT_MS 可调, 1s~600s): 冷页首次查询实测 11~58s。
//   6) 重试耗尽 / worker 起不来 → 落回有界磁盘 walk, 返回 {ok, hits, code}, 永不抛到调用方。
const EKB_TIMEOUT_MS = ekbClampInt('OMNI_EKB_TIMEOUT_MS', 90000, 1000, 600000);        // 单条查询执行预算(冷页实测 11~58s)
const EKB_QUEUE_MS = ekbClampInt('OMNI_EKB_QUEUE_MS', 120000, 1000, 900000);           // 排队等 worker 开始执行的上限
const EKB_BOOT_MS = ekbClampInt('OMNI_EKB_BOOT_MS', 60000, 1000, 600000);              // worker 启动握手上限(加载 sqlite 驱动)
const EKB_WARM_TIMEOUT_MS = ekbClampInt('OMNI_EKB_WARM_TIMEOUT_MS', 240000, 1000, 900000); // 预热预算(独立 worker, 不占查询队列)
const EKB_MAX_RETRY = ekbClampInt('OMNI_EKB_MAX_RETRY', 2, 0, 10);                     // 单次检索最多重启几代 worker
const EKB_DISK_FILES = ekbClampInt('OMNI_EKB_DISK_FILES', 1500, 10, 100000);           // 磁盘兜底最多扫多少文件
const EKB_DISK_MS = ekbClampInt('OMNI_EKB_DISK_MS', 12000, 500, 120000);               // 磁盘兜底时间预算(同步跑在 bridge 主线程, 必须小)
const EKB_DISK_MAX_BYTES = 8 * 1024 * 1024;                                           // 兜底单文件上限
function ekbClampInt(envName, dflt, lo, hi) {
  const v = parseInt(process.env[envName], 10);
  // 给了值就夹到 [lo,hi](越界不静默回默认值, 免得调参时以为生效了其实没生效); 没给/非数字才用默认
  return Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : dflt;
}

let _ekbGen = null;        // 当前代 worker { w, pending:Map, ready, dead, bootTimer }
let _ekbBooting = null;    // 正在启动的那一代(Promise): 重启期间的请求排队等它, 不抛
let _ekbSeq = 0;
let _ekbBroken = false;    // worker 结构性不可用(驱动缺失等): 直接磁盘兜底, 不再反复 spawn

function ekbSpawnGen() {
  return new Promise((resolve, reject) => {
    if (_ekbBroken) { const e = new Error('EKB_WORKER_BROKEN: worker 结构性不可用'); e.ekbCode = 'EKB_WORKER_BROKEN'; e.ekbRetry = false; return reject(e); }
    let gen;
    try {
      const { Worker } = require('worker_threads');
      // 常驻 worker: 冷页首次查询 11~58s, 每次新建进程等于每次冷启动
      gen = { w: new Worker(path.join(__dirname, 'kb_fts_worker.js')), pending: new Map(), ready: false, dead: false, bootTimer: null, born: Date.now() };
    } catch (e) { _ekbBroken = true; e.ekbCode = 'EKB_WORKER_SPAWN_FAILED'; e.ekbRetry = false; return reject(e); }
    let settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(gen.bootTimer); fn(v); };
    // 启动握手超时: require/驱动加载卡住时别让请求无限等
    gen.bootTimer = setTimeout(() => {
      ekbKill(gen, 'boot timeout', 'EKB_WORKER_BOOT_TIMEOUT');
      const e = new Error('EKB_WORKER_BOOT_TIMEOUT: worker 启动握手超时 ' + EKB_BOOT_MS + 'ms');
      e.ekbCode = 'EKB_WORKER_BOOT_TIMEOUT'; e.ekbRetry = true;
      finish(reject, e);
    }, EKB_BOOT_MS);

    gen.w.on('message', (m) => {
      if (!m) return;
      if (m.ready === true) { gen.ready = true; return finish(resolve, gen); }
      if (m.ready === false) {
        // 结构性失败(驱动缺失 / require 炸): 标记 broken, 以后直接磁盘兜底, 别反复 spawn
        _ekbBroken = true;
        ekbKill(gen, 'ready=false: ' + String(m.error || '').slice(0, 160), 'EKB_WORKER_BROKEN');
        const e = new Error('EKB_WORKER_BROKEN: ' + String(m.error || 'driver unavailable').slice(0, 200));
        e.ekbCode = 'EKB_WORKER_BROKEN'; e.ekbRetry = false;
        return finish(reject, e);
      }
      const p = gen.pending.get(m.id);
      if (!p) return;            // 跨代/已结算消息: 丢弃(旧实现在这里用全局表误杀了新代请求)
      if (m.kind === 'begin') {
        // worker 真正开始执行这条请求: 从这一刻起才计执行超时 —— 排队等冷页/warm 的时间不算
        clearTimeout(p.execTimer);
        p.execTimer = setTimeout(() => ekbKill(gen, 'exec timeout ' + p.timeoutMs + 'ms', 'EKB_TIMEOUT'), p.timeoutMs);
        return;
      }
      gen.pending.delete(m.id);
      clearTimeout(p.execTimer); clearTimeout(p.queueTimer);
      if (p.settled) return;
      p.settled = true;
      if (m.ok) p.resolve(m.result);
      else {
        const e = new Error(String(m.error || 'ekb fts failed').slice(0, 500));
        e.ekbCode = String(m.code || 'EKB_WORKER_ERROR'); e.ekbRetry = false;   // worker 自己报的错不重试(重试也一样错)
        p.reject(e);
      }
    });
    gen.w.on('error', (e) => {
      ekbKill(gen, 'error: ' + String(e && e.message || e).slice(0, 160), 'EKB_WORKER_ERROR');
      const err = new Error('EKB_WORKER_ERROR: ' + String(e && e.message || e).slice(0, 200));
      err.ekbCode = 'EKB_WORKER_ERROR'; err.ekbRetry = true;
      finish(reject, err);
    });
    gen.w.on('exit', (code) => {
      const why = 'exit ' + code;
      ekbKill(gen, why, code === 0 ? 'EKB_WORKER_IDLE_EXIT' : 'EKB_WORKER_EXIT');
      const err = new Error('EKB_WORKER_' + (code === 0 ? 'IDLE_EXIT' : 'EXIT') + ': ' + code);
      err.ekbCode = code === 0 ? 'EKB_WORKER_IDLE_EXIT' : 'EKB_WORKER_EXIT'; err.ekbRetry = true;
      finish(reject, err);
    });
  });
}

// 拿一个可用的 worker 代; 拿不到返回 null(调用方走磁盘兜底), 绝不抛到工具层
function ekbReady() {
  if (_ekbGen && _ekbGen.ready && !_ekbGen.dead) return Promise.resolve(_ekbGen);
  if (_ekbBooting) return _ekbBooting;   // 重启期间: 排队等这一代 ready
  const p = ekbSpawnGen().then((gen) => {
    _ekbGen = gen;
    if (_ekbBooting === p) _ekbBooting = null;
    return gen;
  }, () => {
    if (_ekbBooting === p) _ekbBooting = null;
    _ekbGen = null;
    return null;
  });
  _ekbBooting = p;
  return p;
}

// 干掉一代: 只回收它自己的 pending(标记为可重试, 上层重排到新代), 不动别代的请求
function ekbKill(gen, why, code) {
  if (!gen || gen.dead) return;
  gen.dead = true;
  clearTimeout(gen.bootTimer);
  if (_ekbGen === gen) _ekbGen = null;
  const stuck = [...gen.pending.values()];
  gen.pending.clear();
  try { gen.w.terminate(); } catch (_) {}
  const c = String(code || 'EKB_WORKER_GONE');
  for (const p of stuck) {
    clearTimeout(p.execTimer); clearTimeout(p.queueTimer);
    if (p.settled) continue;
    p.settled = true;
    const e = new Error(c + ': ' + why);
    e.ekbCode = c; e.ekbRetry = true;
    p.reject(e);
  }
  try { audit({ decision: 'EKB_WORKER_KILL', code: c, why: String(why).slice(0, 160), stuck: stuck.length }); } catch (_) {}
}

function ekbRequest(msg, timeoutMs) { return ekbAttempt(msg, timeoutMs, 0); }

function ekbAttempt(msg, timeoutMs, attempt) {
  return ekbReady().then((gen) => {
    if (!gen) { const e = new Error('EKB_WORKER_UNAVAILABLE: worker 起不来'); e.ekbCode = 'EKB_WORKER_UNAVAILABLE'; e.ekbRetry = true; throw e; }
    if (gen.dead) { const e = new Error('EKB_WORKER_GONE: 该代 worker 已回收'); e.ekbCode = 'EKB_WORKER_GONE'; e.ekbRetry = true; throw e; }
    return new Promise((resolve, reject) => {
      const id = ++_ekbSeq;
      const p = { id, resolve, reject, timeoutMs: timeoutMs || EKB_TIMEOUT_MS, settled: false, execTimer: null, queueTimer: null, born: Date.now() };
      // 排队上限: worker 迟迟不发 begin(卡在上一跳)时兜底; 执行超时由 begin 之后另起
      p.queueTimer = setTimeout(() => ekbKill(gen, 'queue wait ' + EKB_QUEUE_MS + 'ms', 'EKB_QUEUE_TIMEOUT'), EKB_QUEUE_MS);
      gen.pending.set(id, p);
      try {
        gen.w.postMessage(Object.assign({ id }, msg));
      } catch (e) {
        gen.pending.delete(id); clearTimeout(p.queueTimer);
        e.ekbCode = 'EKB_POST_FAILED'; e.ekbRetry = true;
        reject(e);
      }
    });
  }).catch((e) => {
    const msg2 = String(e && e.message || e);
    const code = (e && e.ekbCode) || (/^EKB_[A-Z_]+/.test(msg2) ? msg2.split(':')[0] : 'EKB_FAILED');
    const retryable = !!(e && e.ekbRetry) && !_ekbBroken;
    if (retryable && attempt < EKB_MAX_RETRY) {
      try { audit({ decision: 'EKB_RETRY', attempt: attempt + 1, code, err: msg2.slice(0, 160) }); } catch (_) {}
      return ekbAttempt(msg, timeoutMs, attempt + 1);   // 排队等新代 ready 再发, 不是抛错
    }
    throw e;
  });
}

function ekbEmptyResult(q, code, err) {
  return { ok: false, engine: null, ms: 0, query: String(q || ''), match: '', hits: [], scanned: 0, truncated: false,
    code: String(code || 'EKB_UNAVAILABLE'), error: String(err || '').slice(0, 300) };
}

// [G45] 索引库 gate 的唯一判据: kb_fts 的候选链能不能解析出一个真实存在的库文件。
// 旧判据是 kbSource 根目录是否存在(main.js 默认 E:\KnowledgeBase), 它把「源根不在」误判成「没索引」,
// 于是包内 resources/product_data/kb 与 seed 到 %APPDATA%\omnishade\kb 的两份真实索引永远轮不到 ——
// 真机四词全 0 的根因。root 语义是库内 path 的相对基准根: 源根可达就沿用源根, 否则按库文件布局反推。
function ekbResolve() {
  const db = KB_FTS.dbPath(KB_SOURCE_ROOT);
  if (!db || !fs.existsSync(db)) return null;
  if (KB_SOURCE_OK) return { db: db, root: KB_SOURCE_ROOT };
  const dir = path.dirname(db);
  const base = path.basename(dir) === KB_FTS.DEFAULTS.dbDirname ? path.dirname(dir) : dir;
  return { db: db, root: base };
}

function ekbSearch(q, opts) {
  const query = String(q || '');
  const req = ekbResolve();
  const o = Object.assign({ root: (req && req.root) || KB_SOURCE_ROOT }, opts || {});
  try {
    if (!fs.existsSync(path.join(__dirname, 'kb_fts.js'))) return Promise.resolve(ekbEmptyResult(query, 'EKB_INDEX_UNAVAILABLE', 'kb_fts.js missing'));
    if (!req) return Promise.resolve(ekbEmptyResult(query, 'EKB_DB_MISSING', '索引库不可用: kb_fts.dbPath(' + KB_SOURCE_ROOT + ') 未解析到真实库文件'));
    return ekbRequest({ query, opts: o }, EKB_TIMEOUT_MS).then((r) => {
      if (r && typeof r === 'object') return r;                       // ok:false(零命中/索引不可用) 也是正常结果, 交给调用方退磁盘 walk
      return ekbEmptyResult(query, 'EKB_BAD_RESULT', 'worker 返回非对象结果');
    }).catch((e) => {
      const msg2 = String(e && e.message || e);
      const code = (e && e.ekbCode) || (/^EKB_[A-Z_]+/.test(msg2) ? msg2.split(':')[0] : 'EKB_FAILED');
      try { audit({ decision: 'EKB_SEARCH_FALLBACK', code, err: msg2.slice(0, 200), qlen: query.length }); } catch (_) {}
      return ekbDiskWalk(query, o, code, msg2);                       // 真的落回磁盘 walk: 要么 hits, 要么空结果+原因码
    });
  } catch (e) {
    return Promise.resolve(ekbDiskWalk(query, o, 'EKB_THROW', String(e && e.message || e)));
  }
}

// 预热: 走一次性独立 worker, 冷页 23~51s 的代价不占常驻 worker 的查询队列(旧实现在这里把在线查询拖超时)。
// 预热收益来自 OS 页缓存(系统级跨进程共享), 所以换进程一样有效。
function ekbWarm() {
  try {
    // [G45] 预热走同一 gate: 库能解析就该预热, 否则源根不在的部署机首查永远付 15~50s 冷页代价。
    const req = ekbResolve();
    if (!req) return Promise.resolve({ ok: false, code: 'EKB_DB_MISSING', db: KB_FTS.dbPath(KB_SOURCE_ROOT) });
    const t0 = Date.now();
    return ekbWarmOnce(req.root).then((r) => {
      try { audit({ decision: 'EKB_WARM', ok: !!(r && r.ok), ms: Date.now() - t0, root: KB_SOURCE_ROOT }); } catch (_) {}
      return r;
    }).catch((e) => ({ ok: false, code: 'EKB_WARM_FAILED', error: String(e && e.message || e).slice(0, 200) }));
  } catch (e) { return Promise.resolve({ ok: false, code: 'EKB_WARM_FAILED', error: String(e && e.message || e).slice(0, 200) }); }
}
function ekbWarmOnce(rootOverride) {
  const warmRoot = String(rootOverride || KB_SOURCE_ROOT || '');
  return new Promise((resolve) => {
    let w = null, timer = null, done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { if (w) w.terminate(); } catch (_) {} resolve(r); };
    try {
      const { Worker } = require('worker_threads');
      w = new Worker(path.join(__dirname, 'kb_fts_worker.js'));
    } catch (e) { return resolve({ ok: false, code: 'EKB_WARM_SPAWN_FAILED', error: String(e && e.message || e).slice(0, 200) }); }
    timer = setTimeout(() => finish({ ok: false, code: 'EKB_WARM_TIMEOUT', error: '预热超时 ' + EKB_WARM_TIMEOUT_MS + 'ms', ms: EKB_WARM_TIMEOUT_MS }), EKB_WARM_TIMEOUT_MS);
    w.on('message', (m) => { if (m && m.kind === 'warm') finish(m.result || { ok: false, code: 'EKB_WARM_EMPTY' }); });
    w.on('error', (e) => finish({ ok: false, code: 'EKB_WARM_ERROR', error: String(e && e.message || e).slice(0, 200) }));
    w.on('exit', (c) => finish({ ok: false, code: 'EKB_WARM_EXIT', error: 'exit ' + c }));
    try { w.postMessage({ id: 0, warm: true, root: warmRoot }); }
    catch (e) { finish({ ok: false, code: 'EKB_WARM_POST_FAILED', error: String(e && e.message || e).slice(0, 200) }); }
  });
}

// 磁盘 walk 兜底: worker 彻底起不来时的最后一道网。有界(文件数/单文件字节/时间)。
// 同步跑在 bridge 主线程, 所以预算默认只有 12s / 1500 文件 —— 它只是兜底, 主路径是 FTS5 + productSearch worker。
function ekbDiskWalk(q, opts, code, err) {
  const t0 = Date.now();
  const o = opts || {};
  const out = ekbEmptyResult(q, code || 'EKB_DISK_FALLBACK', err || '');
  const rootDir = String(o.root || KB_SOURCE_ROOT || '');
  if (!rootDir || !path.isAbsolute(rootDir) || !fs.existsSync(rootDir)) {
    out.code = 'EKB_ROOT_MISSING'; out.error = '知识库根不存在: ' + rootDir; out.ms = Date.now() - t0; return out;
  }
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!terms.length) { out.code = 'EMPTY_QUERY'; out.error = '关键词为空'; out.ms = Date.now() - t0; return out; }
  out.engine = 'disk-walk';
  const max = Math.max(1, Math.min(parseInt(o.max, 10) || 10, 50));
  const hits = [];
  let scanned = 0;
  const stack = [[rootDir, 0]];
  while (stack.length && scanned < EKB_DISK_FILES && hits.length < max && Date.now() - t0 < EKB_DISK_MS) {
    const cur = stack.pop();
    const dir = cur[0], depth = cur[1];
    if (depth > 5) continue;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents) {
      if (Date.now() - t0 >= EKB_DISK_MS) break;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push([fp, depth + 1]); continue; }
      if (!/\.(txt|md|jsonl|csv|log)$/i.test(e.name)) continue;
      if (++scanned > EKB_DISK_FILES) break;
      let st; try { st = fs.statSync(fp); } catch (_) { continue; }
      if (!st || st.size === 0 || st.size > EKB_DISK_MAX_BYTES) continue;
      let buf; try { buf = fs.readFileSync(fp, 'utf8'); } catch (_) { continue; }
      const lines = buf.split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < max; i++) {
        const raw = lines[i];
        if (!raw) continue;
        const lineLow = raw.toLowerCase();
        if (!terms.every((t) => lineLow.indexOf(t) !== -1)) continue;   // 只做包含匹配, 大文件 O(lines*terms)
        hits.push({
          path: path.relative(rootDir, fp).split('\\').join('/'), title: e.name, source: '', category: '',
          line_start: i + 1, line_end: i + 1, snippet: raw.slice(0, 240), body: raw.slice(0, 2000),
          body_len: raw.length, body_truncated: raw.length > 2000, abs: fp, score: 0,
        });
      }
    }
  }
  out.hits = hits;
  out.scanned = scanned;
  out.ok = hits.length > 0;
  out.truncated = scanned >= EKB_DISK_FILES || Date.now() - t0 >= EKB_DISK_MS;
  out.ms = Date.now() - t0;
  out.note = 'disk-walk files=' + scanned + ' budget=' + EKB_DISK_MS + 'ms' + (out.truncated ? ' (预算用尽, 结果不全)' : '');
  return out;
}

// Legacy sync implementation retained only as a development reference. Do not call it from the bridge loop.
function productSearchSync(q, opts) {
  const t0 = Date.now();
  const mode = String(opts.mode || 'name').toLowerCase();
  const max = Math.min(opts.max || 50, 200);
  const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  const kbFiles = [];
  (function walk(d, depth) {
    if (depth > 6 || kbFiles.length > 8192) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) { walk(fp, depth + 1); continue; }
      if (/\.(txt|md|jsonl|csv|log)$/i.test(e.name)) {
        let st; try { st = fs.statSync(fp); } catch (_) { continue; }
        if (st.size > 128 * 1024 * 1024) continue;
        kbFiles.push({ rel: path.relative(PRODUCT_DIR, fp).replace(/\\/g, '/'), fp, size: st.size });
      }
    }
  })(PRODUCT_KB_DIR, 0);

  if (mode === 'name') {
    let idxN = 0;
    try {
      const idx = skillsIndex();
      for (const e of (Array.isArray(idx) ? idx : [])) {
        const hay = String(e.name + ' ' + (e.description || '') + ' ' + ((e.tags || []).join(' ')) + ' ' + (e.category || '')).toLowerCase();
        if (terms.every((t) => hay.indexOf(t) !== -1)) {
          out.push('[skill] ' + e.name + ' | ' + String(e.description || '').slice(0, 110) + ' | ' + e.rel_path +
            (e.has_scripts ? ' [scripts]' : '') + (e.has_references ? ' [refs]' : ''));
          if (++idxN >= max) break;
        }
      }
    } catch (_) {}
    for (const f of kbFiles) {
      if (out.length >= max) break;
      const n = f.rel.toLowerCase();
      if (terms.every((t) => n.indexOf(t) !== -1)) out.push('[file] ' + f.rel + ' (' + Math.round(f.size / 1024) + 'KB)');
    }
    const head = 'source=产品库(name) | skills_index ' + (idxN || 0) + ' 条, kb 文件 ' + kbFiles.length + ' 个, 命中 ' + out.length;
    return { head, body: out.join('\n') || '(无匹配)', ms: Date.now() - t0 };
  }

  // content: 多词 AND 全文扫描(带字节/时间上限)
  const BYTE_CAP = 800 * 1024 * 1024, TIME_CAP = 15000;
  let bytes = 0, scanned = 0;
  for (const f of kbFiles) {
    if (out.length >= max || bytes >= BYTE_CAP || Date.now() - t0 > TIME_CAP) break;
    let text; try { text = fs.readFileSync(f.fp, 'utf8'); } catch (_) { continue; }
    bytes += text.length; scanned++;
    const ls = text.split(/\r?\n/);
    for (let i = 0; i < ls.length; i++) {
      const low = ls[i].toLowerCase();
      if (terms.every((t) => low.indexOf(t) !== -1)) {
        out.push('[content] ' + f.rel + ':' + (i + 1) + ' ' + ls[i].trim().slice(0, 160));
        if (out.length >= max) break;
      }
    }
  }
  const head = 'source=产品库(content) | 扫描 ' + scanned + '/' + kbFiles.length + ' 文件 ' + Math.round(bytes / 1048576) + 'MB, 命中 ' + out.length + ' 用时 ' + (Date.now() - t0) + 'ms';
  return { head, body: out.join('\n') || '(无匹配)', ms: Date.now() - t0 };
}

// ── 目标驱动自主迭代引擎的辅助（G80）──────────────────────────────────────
// GOALS: goalId -> { id, objective, pid, started_at, child }
// 独立 worker 的好处：bridge 重启不影响正在跑的目标；worker 挂掉也不拖垮 bridge。
const GOALS = new Map();

function getGoalRoot() {
  const base = process.env.OMNI_GOAL_DIR
    || path.join(process.env.APPDATA || require('os').homedir(), 'omnishade', 'goals');
  try { fs.mkdirSync(base, { recursive: true }); } catch (_) {}
  return base;
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function forkGoalEngine({ objective, stateDir, maxIter, doneKws, sleepMs }) {
  const { fork } = require('child_process');
  const enginePath = path.join(__dirname, 'goal_engine.js');
  // 用模块级 TOKEN 常量（loadToken() 在启动时算好的那把）。
  // 不能读 process.env.OMNI_LOCAL_BRIDGE_TOKEN —— loadToken() 读完就 delete 了，
  // 所以 fork 出去的子进程里这个 env 是空的，worker 会 401。
  // 也不能再调 loadToken() —— 它会重新生成一把新的，跟 bridge 实际用的不是同一个。
  const token = (typeof TOKEN === 'string' && TOKEN) ? TOKEN : '';
  const port = (process.env.OMNI_LOCAL_BRIDGE_PORT || '9431');
  const argv = [
    enginePath,
    '--objective', objective,
    '--state', stateDir,
    '--max_iters', String(maxIter || 0),
    '--done', doneKws || '',
    '--sleep_ms', String(sleepMs || 1200),
    '--bridge', 'http://127.0.0.1:' + port,
    '--token', token,
  ];
  const logFile = path.join(stateDir, 'worker.log');
  const out = fs.openSync(logFile, 'a');
  const err = fs.openSync(logFile, 'a');
  const child = fork(enginePath, argv.slice(1), {
    detached: true,
    stdio: ['ignore', out, err, 'ipc'],
    windowsHide: true,
    env: Object.assign({}, process.env, {
      // 防止把 ELECTRON_RUN_AS_NODE 之外的 GUI 标志传过去
      ELECTRON_RUN_AS_NODE: '1',
    }),
  });
  child.unref();
  return child;
}

async function callTool(name, args, opts) {
  name = TOOL_ALIASES[name] || name;
  // 套餐闸门：仅知识库档位拒绝一切非 KB 工具（HTTP /call 与 MCP tools/call 都走这里）
  if (!scopeAllows(name)) {
    audit({ decision: 'DENY_SCOPE', tool: String(name).slice(0, 40), ok: false });
    throw scopeReject(name);
  }
  // ── [LOOT-MCP 2026-11-07] lootchain 攻击链 ──
  // 逻辑单源在 ui_shim_loot.js 核心层（ui_shim HTTP 面与这里共用同一个 job 表）。
  // 变种组合/自动研判的编排智能在模型侧：本层只提供积木与原料，不替模型做决策。
  if (String(name).startsWith('lootchain_')) {
    const t0 = Date.now();
    let r;
    if (name === 'lootchain_stages') r = loot.lootStages();
    else if (name === 'lootchain_run') r = await loot.lootRun(args || {});
    else if (name === 'lootchain_jobs') r = loot.lootJobs();
    else if (name === 'lootchain_log') r = loot.lootLog(args || {});
    else if (name === 'lootchain_findings') r = loot.lootFindings(args || {});
    else if (name === 'lootchain_report') r = loot.lootReport(args || {});
    else if (name === 'lootchain_stop') r = loot.lootStop(args || {});
    else throw new Error('unknown lootchain tool: ' + name);
    audit({ decision: 'LOOT_TOOL', tool: name, ok: !!(r && r.ok),
            job: String((args && args.jobId) || (r && r.jobId) || '').slice(0, 24),
            stages: String((args && args.stages) || (r && r.stages) || '').slice(0, 80),
            ms: Date.now() - t0 });
    return r;
  }

  // ── [WEAPON-MCP 2026-11-08] 统一武器线 ──
  // 逻辑单源在 ui_shim_weapons.js 核心层（ui_shim HTTP 面与这里共用同一个 job 表）。
  // 武器编排智能在模型侧：本层只提供积木与原料，不替模型做决策。
  if (name === 'artex_control') {
    // [ARTEX 2026-11-08] 自主渗透控制台启停/探活：HTTP 直连 8790, 失败=未部署
    const action = String((args || {}).action || 'status');
    const URL_ = 'http://127.0.0.1:8790/';
    const probe = async () => { try { const r = await fetch(URL_, { signal: AbortSignal.timeout(3000) }); return r.ok; } catch (_) { return false; } };
    const alive = await probe();
    if (action === 'status') {
      let llm = null;
      try {
        const t = await artexToken();
        const r = await fetch(URL_ + 'api/llm', { headers: { Authorization: 'Bearer ' + t }, signal: AbortSignal.timeout(4000) });
        llm = await r.json();
      } catch (_) {}
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, deployed: true, alive, url: URL_, llm_configured: !!(llm && llm.configured), llm_provider: llm && llm.provider }) }] };
    }
    if (action === 'start') {
      if (alive) return { content: [{ type: 'text', text: JSON.stringify({ ok: true, started: false, note: 'already running' }) }] };
      const { spawn } = require('child_process');
      const bat = 'D:\\老K日站工作区\\ARTEX\\start-artex.bat';
      try { spawn('cmd.exe', ['/c', bat], { cwd: require('path').dirname(bat), detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
      catch (e) { return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(e && e.message || e) }) }] }; }
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 2000));
        if (await probe()) return { content: [{ type: 'text', text: JSON.stringify({ ok: true, started: true }) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: '20s 未探活 8790' }) }] };
    }
    throw new Error('unknown artex action: ' + action);
  }

  // ── [ARTEX 2026-11-08] 会话内闭环工具组：任务在 OmniShade 会话里创建/跟踪/研判 ──
  // ARTEX 自身是会话制（tasks/{id}/chat 任务流），这组工具把它对齐成武器线同款闭环：
  // artex_run 建任务 → artex_log 轮任务会话流 → artex_findings 拉战果 → artex_api 全能力透传。
  // JWT 托管：登录缓存内存，401/过期自动重登。LLM 未配置时任务停在 created，用 artex_llm_set 接池。
  const ART_BASE = 'http://127.0.0.1:8790/';
  let _artexTok = null, _artexTokExp = 0;
  async function artexToken(force) {
    if (!force && _artexTok && Date.now() < _artexTokExp - 60000) return _artexTok;
    const r = await fetch(ART_BASE + 'api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ARTEX', password: 'LaokArtex2026!' }),
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) throw new Error('artex login ' + r.status);
    const j = await r.json();
    _artexTok = j.token;
    try { const pp = JSON.parse(Buffer.from(j.token.split('.')[1], 'base64').toString('utf8')); _artexTokExp = (pp.exp || 0) * 1000; } catch (_) { _artexTokExp = Date.now() + 3600e3; }
    return _artexTok;
  }
  async function artexFetch(method, path, body) {
    const do1 = async (tok) => fetch(ART_BASE + String(path).replace(/^\//, ''), {
      method, headers: Object.assign({ Authorization: 'Bearer ' + tok }, body ? { 'Content-Type': 'application/json;charset=utf-8' } : {}),
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
    });
    let r = await do1(await artexToken());
    if (r.status === 401) r = await do1(await artexToken(true));
    const text = await r.text();
    try { return { status: r.status, json: JSON.parse(text) }; } catch (_) { return { status: r.status, text: text } }
  }
  const artexJ = (r) => r.json !== undefined ? r.json : r.text;
  if (/^artex_(tasks|run|log|findings|llm_set|api)$/.test(String(name))) {
    const a = args || {};
    if (name === 'artex_tasks') {
      const r = await artexFetch('GET', 'api/tasks');
      const ts = (artexJ(r).tasks) || artexJ(r) || [];
      const brief = (Array.isArray(ts) ? ts : []).slice(0, 30).map((t) => ({ id: t.id, name: t.name, status: t.status, goals: (t.goals_met || 0) + '/' + (t.goals_total || 0), findings: t.findings, description: String(t.description || '').slice(0, 120) }));
      return { content: [{ type: 'text', text: JSON.stringify({ ok: r.status === 200, count: brief.length, tasks: brief }) }] };
    }
    if (name === 'artex_run') {
      if (!a.goal) throw new Error('goal 必填');
      const body = { description: String(a.description || a.goal).slice(0, 500), goal: String(a.goal).slice(0, 500) };
      if (a.name) body.name = String(a.name).slice(0, 80);
      const r = await artexFetch('POST', 'api/tasks', body);
      const t = artexJ(r);
      let llmCfg = false;
      try { const x = await artexFetch('GET', 'api/llm'); llmCfg = !!(x.json && x.json.configured); } catch (_) {}
      return { content: [{ type: 'text', text: JSON.stringify({ ok: r.status === 200, task: t, note: llmCfg ? '任务已创建；用 artex_log 轮询任务会话流跟踪执行。' : '任务已创建，但 ARTEX 的 LLM 工人未配置（会停在 created 不动）——先用 artex_llm_set 接上 LLM 池再跑。' }) }] };
    }
    if (name === 'artex_log') {
      if (!a.taskId) throw new Error('taskId 必填');
      const r = await artexFetch('GET', 'api/tasks/' + encodeURIComponent(a.taskId) + '/chat');
      return { content: [{ type: 'text', text: JSON.stringify({ ok: r.status === 200, chat: artexJ(r) }) }] };
    }
    if (name === 'artex_findings') {
      const r = await artexFetch('GET', 'api/exploration/findings');
      return { content: [{ type: 'text', text: JSON.stringify({ ok: r.status === 200, findings: artexJ(r) }) }] };
    }
    if (name === 'artex_llm_set') {
      const body = {};
      if (a.provider) body.provider = String(a.provider);
      if (a.baseUrl) body.base_url = String(a.baseUrl);
      if (a.model) body.model = String(a.model);
      if (a.key) body.key = String(a.key);
      const r = await artexFetch('PUT', 'api/llm', body);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: r.status === 200, llm: artexJ(r) }) }] };
    }
    if (name === 'artex_api') {
      const method = String(a.method || 'GET').toUpperCase();
      if (!/^(GET|POST|PUT|DELETE)$/.test(method)) throw new Error('method 仅限 GET/POST/PUT/DELETE');
      const path = String(a.path || '').trim();
      if (!/^api\//.test(path) || path.includes('..')) throw new Error('path 必须以 api/ 开头且不含 ..');
      const r = await artexFetch(method, path, a.body);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: r.status < 400, status: r.status, data: artexJ(r) }) }] };
    }
  }
  if (/^(weapon_|weapons_)/.test(String(name))) {
    const t0 = Date.now();
    let r;
    if (name === 'weapons_list') r = weapons.weaponsList();
    else if (name === 'weapon_run') r = await weapons.weaponRun(args || {});
    else if (name === 'weapon_log') r = weapons.weaponLog(args || {});
    else if (name === 'weapon_findings') r = weapons.weaponFindings(args || {});
    else if (name === 'weapon_stop') r = weapons.weaponStop(args || {});
    else if (name === 'weapon_jobs') r = weapons.weaponJobs();
    else throw new Error('unknown weapon tool: ' + name);
    audit({ decision: 'WEAPON_TOOL', tool: name, ok: !!(r && r.ok),
            job: String((args && args.jobId) || (r && r.jobId) || '').slice(0, 24),
            weapon: String((args && args.weapon) || (r && r.weapon) || '').slice(0, 24),
            stages: String((args && args.stages) || (r && r.stages) || '').slice(0, 80),
            ms: Date.now() - t0 });
    return r;
  }

  // ── 目标驱动自主迭代（G80）──────────────────────────────────────────────
  // 产品特性：不拒绝任何目标；max_iters=0 表示不达完成判据不停；
  // 由独立 worker(goal_engine.js) 驱动，bridge 只负责启动/查询/停止。
  if (name === 'goal_start') {
    const objective = String(args.objective || '').trim();
    if (!objective) throw new Error('objective 不能为空');
    const goalId = (args.id && String(args.id).trim()) ||
      ('g' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'));
    const stateDir = path.join(getGoalRoot(), goalId);
    fs.mkdirSync(stateDir, { recursive: true });
    const maxIter = parseInt(args.max_iters || '0', 10) || 0;
    const doneKws = String(args.done_keywords || args.done || '');
    const child = forkGoalEngine({
      objective, stateDir, maxIter, doneKws,
      sleepMs: parseInt(args.sleep_ms || '1200', 10) || 1200,
    });
    GOALS.set(goalId, { id: goalId, objective, pid: child.pid, started_at: Date.now(), child });
    audit({ decision: 'EXEC', tool: 'goal_start', id: goalId, pid: child.pid });
    return { text: JSON.stringify({ ok: true, id: goalId, pid: child.pid, state_dir: stateDir }) };
  }
  if (name === 'goal_status') {
    const goalId = String(args.id || '').trim();
    const tailN = Math.min(parseInt(args.tail || '40', 10) || 40, 500);
    const dir = goalId ? path.join(getGoalRoot(), goalId) : getGoalRoot();
    if (goalId) {
      const snapPath = path.join(dir, 'goal.json');
      let snap = null;
      try { snap = JSON.parse(fs.readFileSync(snapPath, 'utf8')); } catch (_) {}
      const jl = path.join(dir, 'goal.jsonl');
      let tail = [];
      if (fs.existsSync(jl)) {
        const lines = fs.readFileSync(jl, 'utf8').split('\n').filter(Boolean);
        tail = lines.slice(-tailN).map(l => { try { return JSON.parse(l); } catch (_) { return { raw: l }; } });
      }
      const rec = GOALS.get(goalId);
      return { text: JSON.stringify({ id: goalId, snapshot: snap, tail, alive: rec ? isAlive(rec.pid) : null }) };
    }
    const ids = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => {
      try { return fs.statSync(path.join(dir, f)).isDirectory(); } catch (_) { return false; }
    }) : [];
    const list = ids.map(id => {
      let snap = null;
      try { snap = JSON.parse(fs.readFileSync(path.join(dir, id, 'goal.json'), 'utf8')); } catch (_) {}
      const rec = GOALS.get(id);
      return { id, snapshot: snap, alive: rec ? isAlive(rec.pid) : null };
    });
    return { text: JSON.stringify({ goals: list }) };
  }
  if (name === 'goal_stop') {
    const goalId = String(args.id || '').trim();
    if (!goalId) throw new Error('id 不能为空');
    const dir = path.join(getGoalRoot(), goalId);
    try { fs.writeFileSync(path.join(dir, 'stop.flag'), String(Date.now())); } catch (_) {}
    const rec = GOALS.get(goalId);
    let killed = false;
    if (rec && isAlive(rec.pid)) {
      try { process.kill(rec.pid); killed = true; } catch (_) {}
      GOALS.delete(goalId);
    }
    return { text: JSON.stringify({ ok: true, id: goalId, killed }) };
  }
  if (name === 'goal_log') {
    const goalId = String(args.id || '').trim();
    const dir = path.join(getGoalRoot(), goalId);
    const jl = path.join(dir, 'goal.jsonl');
    if (!fs.existsSync(jl)) return { text: '(还没有日志)' };
    const n = Math.min(parseInt(args.tail || '200', 10) || 200, 2000);
    const lines = fs.readFileSync(jl, 'utf8').split('\n').filter(Boolean);
    return { text: lines.slice(-n).join('\n') };
  }
  if (name === 'fs.read') {
    const p = safePath(args.path || '');
    return { text: fs.readFileSync(p, 'utf8').slice(0, 500000) };
  }
  if (name === 'fs.list') {
    const p = safePath((args.path && String(args.path).trim()) ? args.path : '.');   // 空路径=工作区根(对齐工具文档), 避免被误判 SCOPE_BLOCKED
    const out = [];
    (function walk(dir, depth) {
      if (depth > 3) return;
        if (out.length >= FS_LIST_CAP) return;   // [1.1.36] 条目上限, 防大目录同步遍历冻结
      for (const f of fs.readdirSync(dir)) {
        const fp = path.join(dir, f);
        let st; try { st = fs.statSync(fp); } catch (_) { continue; }   // [2026-10-29] 断链符号链接不崩
        out.push(st.isDirectory() ? '[DIR] ' + fp : st.size + '  ' + fp);
        if (st.isDirectory()) {
          // [2026-10-29 巡检修复] 符号链接目录逃逸: 递归前校验真实路径仍在工作区内
          let rp; try { rp = fs.realpathSync(fp); } catch (_) { rp = null; }
          if (rp) { const rr = getRealRoot(); if (rp !== rr && !rp.toLowerCase().startsWith(rr.toLowerCase() + path.sep)) continue; }
          walk(fp, depth + 1);
        }
      }
    })(p, 0);
    return { text: out.slice(0, 500).join('\n') || '(空)' };
  }
  if (name === 'fs.hash') {
    const p = safePath(args.path || '');
    const h = crypto.createHash('sha256');
    h.update(fs.readFileSync(p));
    return { text: h.digest('hex') };
  }
  if (name === 'local_fs_search') {
    const q = String(args.query || '').trim();
    if (!q) throw new Error('query 不能为空');
    const p = safePath((args.path && String(args.path).trim()) ? args.path : '.');   // 空路径=工作区根(对齐工具文档)
    const max = Math.min(parseInt(args.max || '50', 10) || 50, 100);
    const ql = q.toLowerCase();
    const hits = [];
    (function walk(dir, depth) {
      if (depth > 5 || hits.length >= max) return;
      let entries;
      try { entries = fs.readdirSync(dir); } catch (_) { return; }
      for (const f of entries) {
        if (hits.length >= max) return;
        const fp = path.join(dir, f);
        let st;
        try { st = fs.statSync(fp); } catch (_) { continue; }
        if (st.isDirectory()) {
          // [2026-10-29 巡检修复] 符号链接目录逃逸: 递归前校验真实路径仍在工作区内
          let rp; try { rp = fs.realpathSync(fp); } catch (_) { rp = null; }
          if (rp) { const rr = getRealRoot(); if (rp !== rr && !rp.toLowerCase().startsWith(rr.toLowerCase() + path.sep)) { continue; } }
          walk(fp, depth + 1); continue;
        }
        const matchedName = f.toLowerCase().includes(ql);
        let matchedContent = false;
        if (!matchedName && st.size <= 1024 * 1024) {
          try {
            const buf = fs.readFileSync(fp);
            if (!buf.slice(0, 4096).includes(0)) matchedContent = buf.toString('utf8').toLowerCase().includes(ql);
          } catch (_) {}
        }
        if (matchedName || matchedContent) {
          hits.push((matchedName ? '[name] ' : '[content] ') + st.size + 'B  ' + fp);
        }
      }
    })(p, 0);
    const qhash = crypto.createHash('sha256').update(q).digest('hex').slice(0, 12);
    audit({ decision: 'FS_SEARCH', query_hash: qhash, hits: hits.length });
    return { text: hits.join('\n') || '(无匹配)' };
  }
  if (name === 'local_fs_write') {
    let rel = String(args.path || '').trim().replace(/\\/g, '/');
    const content = args.content;
    if (!rel) throw new Error('path 必填');
    // denylist(凭据文件)是 full/sandbox 共同硬线, 优先于模式判定
    // [2026-10-31 修复] 用 kbDenyHard: full 下不再把绝对路径误判成 TRAVERSAL(cross-drive/UNC),
    // 否则 1484-1486 的 full 放行分支永远走不到(死代码)。
    const destDeny = kbDenyHard(rel.toLowerCase());
    if (destDeny) {
      audit({ decision: 'SCOPE_BLOCKED', tool: name, path_head: rel.slice(0, 60), deny: destDeny });
      throw new Error('SCOPE_BLOCKED: 写入目标命中 denylist(' + destDeny + '), 已硬挡');
    }
    const root = path.resolve(WORKROOT);
    let dest;
    if (PERM_MODE === 'full') {
      // 显式 full: 任意路径写放行(绝对/工作区外), 仅 denylist 硬线; 相对路径仍按 WORKROOT 解析
      dest = /^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith('//') || rel.startsWith('\\\\') ? path.resolve(rel) : path.resolve(root, rel);
    } else {
      if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) throw new Error('路径守卫: 检测到绝对路径——当前为 sandbox 模式, 仅允许工作区内相对路径');
      dest = path.resolve(root, rel);
      if (dest !== root && !dest.toLowerCase().startsWith(root.toLowerCase() + path.sep)) {
        audit({ decision: 'SCOPE_BLOCKED', path_head: rel.slice(0, 60) });
        throw new Error('路径守卫: 检测到路径逃逸(..), 已拒绝写入');
      }
    }
    // [G15 加固] 落盘前对**解析后**的绝对路径再补一闸(kbDenyResolved: 只留凭据/.. 硬线)。
    // 作用: 相对路径 → 绝对路径的解析过程(含 .. 折叠)再被审一遍, 不依赖前置闸的顺序正确性。
    const destDeny2 = kbDenyResolved(dest);
    if (destDeny2) {
      audit({ decision: 'SCOPE_BLOCKED', tool: name, path_head: rel.slice(0, 60), deny: destDeny2 });
      throw new Error('SCOPE_BLOCKED: 写入目标命中 denylist(' + destDeny2 + '), 已硬挡');
    }
    const data = Buffer.from(typeof content === 'string' ? content : String(content), 'utf8');
    if (data.length > 50 * 1024 * 1024) throw new Error('内容超过 50MB 单文件上限, 已拒绝');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    audit({ decision: 'FS_SAVE', path: PERM_MODE === 'full' ? dest : path.relative(root, dest).replace(/\\/g, '/'), size: data.length });
    return { text: JSON.stringify({ saved: dest, size: data.length, root }) };
  }
  if (name === 'desktop_screenshot') {
    const dc = desktopCapturer();
    if (!dc) {
      if (ipcAvailable()) {   // [1.1.35] 子进程模式: 让主进程截屏后回传
        return ipcRequest('desktop_screenshot', {}).then((r) => {
          const png = Buffer.from(String((r && r.b64) || ''), 'base64');
          if (!png.length) throw new Error('IPC_SCREENSHOT_EMPTY');
          const dir = path.join(path.resolve(WORKROOT), 'screenshots');
          fs.mkdirSync(dir, { recursive: true });
          const dst = path.join(dir, 'shot-' + Date.now() + '.png');
          fs.writeFileSync(dst, png);
          const h = crypto.createHash('sha256').update(png).digest('hex');
          const rel = path.relative(path.resolve(WORKROOT), dst).replace(/\\/g, '/');
          audit({ decision: 'SCREENSHOT', path: rel, size: png.length });
          return { text: JSON.stringify({ saved: rel, size: png.length, sha256: h }) };
        });
      }
      throw new Error('desktopCapturer 不可用(需在 Electron 主进程内运行)');
    }
    return dc.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } }).then((sources) => {
      if (!sources || !sources.length) throw new Error('无可用屏幕源');
      const png = sources[0].thumbnail.toPNG();
      const dir = path.join(path.resolve(WORKROOT), 'screenshots');
      fs.mkdirSync(dir, { recursive: true });
      const dst = path.join(dir, 'shot-' + Date.now() + '.png');
      fs.writeFileSync(dst, png);
      const h = crypto.createHash('sha256').update(png).digest('hex');
      audit({ decision: 'SCREENSHOT', path: path.relative(path.resolve(WORKROOT), dst).replace(/\\/g, '/'), size: png.length });
      return { text: JSON.stringify({ saved: path.relative(path.resolve(WORKROOT), dst).replace(/\\/g, '/'), size: png.length, sha256: h }) };
    });
  }
  if (name === 'desktop_window_list') {
    return new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-Command',
        "Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Id,ProcessName,MainWindowTitle | Format-Table -AutoSize | Out-String -Width 300"],
        { timeout: 30000, maxBuffer: 16 << 20, windowsHide: true }, (err, stdout, stderr) => {
          const out = ((stdout || '') + (stderr ? '\n[stderr] ' + stderr : '')).trim();
          if (err && !out) return reject(new Error('EXEC_FAIL: rc=' + (err.code || -1) + ' ' + err.message.slice(0, 200)));
          audit({ decision: 'EXEC', tool: name, ok: !err, rc: err && err.code ? err.code : 0 });
          resolve({ text: markTruncated(out || '(无窗口)', 200000) });
        });
    });
  }
  if (name === 'taskkill') {
    const pid = String(args.pid || '').trim();
    if (!/^\d{1,7}$/.test(pid)) throw new Error('TOOL_BLOCKED: taskkill 需要数字 pid(定点结束单进程)');
    return new Promise((resolve, reject) => {
      const a = args.force === false ? ['/PID', pid] : ['/PID', pid, '/F'];
      execFile('taskkill', a, { timeout: 15000, maxBuffer: 16 << 20, windowsHide: true }, (err, stdout, stderr) => {
        const out = ((stdout || '') + (stderr ? '\n[stderr] ' + stderr : '')).trim();
        if (err && !out) return reject(new Error('EXEC_FAIL: rc=' + (err.code || -1) + ' ' + err.message.slice(0, 150)));
        audit({ decision: 'EXEC', tool: 'taskkill', pid: parseInt(pid, 10), ok: !err, rc: err && err.code ? err.code : 0 });
        resolve({ text: out || ('已发送结束指令 pid=' + pid) });
      });
    });
  }
  if (name === 'sys_exec') {
    const cmd = String(args.cmd || args.command || '').trim();
    if (!cmd) throw new Error('cmd 必填');
    if (cmd.length > 2000) throw new Error('TOOL_BLOCKED: 命令过长(>2000)');
    if (DISASTER_GUARD.test(cmd)) {
      audit({ decision: 'DISASTER_BLOCKED', cmd_head: cmd.slice(0, 60) });
      throw new Error('DISASTER_GUARD: 该命令会销毁系统本体(疑似误操作), 已拦。');
    }
    // [2026-10-31 修复] sandbox=最小权限: 接回 WRITE_GUARD(写盘/解释器/危险命令黑名单) 与
    // sysExecPathGuard(读命令路径 confinement)。二者此前定义后从未被调用(死代码),
    // 导致 sandbox 模式下 sys_exec 与 full 完全等价。full 模式保持不放行(仅 DISASTER_GUARD)。
    if (PERM_MODE === 'sandbox') {
      const wm = String(cmd).match(WRITE_GUARD);
      if (wm) {
        audit({ decision: 'WRITE_BLOCKED', tool: name, cmd_head: cmd.slice(0, 60), rule: wm[0] });
        throw new Error('WRITE_GUARD: sandbox 模式下该命令被安全策略拒绝(命中: ' + wm[0] + '); 需要执行请切 OMNI_PERM_MODE=full');
      }
      sysExecPathGuard(cmd);
    }
    // 2026-09-29 exec 工具链修复: 路径白名单/读命令路径校验已按用户明令移除(仅对 full 模式成立);
    // DISASTER_GUARD 保留(仅拦 mkfs/rm -rf / 等磁盘毁灭类, 非路径限制)。
    return runCmdFull(cmd, 60000, 'sys_exec', opts);
  }
  if (name === 'skill_list') return listSkills(args);
  if (name === 'skill_cache_clear') {
    // [G8-修复] 明确的回收入口: 换索引/换技能目录后可以主动把 entries(含 hermes 源 ≤12KB/条的 searchText)
    // 从 Map 强引用里摘掉, 不用等 TTL 自然过期(原来过期也不删)。
    const sizeBefore = _SKILL_CATALOG_CACHE.size;
    const extra = { verify_size: _SKILL_VERIFY_CACHE.size, snapshot: !!_SKILL_SNAP, warm: _SKILL_WARM_STATE };   // [G68] 新增观测面, 不改旧字段
    if (args.confirm !== true) return { text: JSON.stringify({ ok: true, cleared: 0, size: sizeBefore, max: SKILL_CATALOG_MAX_KEYS, ttl_ms: SKILL_CATALOG_TTL_MS, sweep_ms: SKILL_CATALOG_SWEEP_MS, ...extra, hint: 'confirm=true 才执行清理' }) };
    // 三档: sweep=true 只请过期项(最温和) > source= 按源前缀清 > 默认全清
    let cleared, how;
    if (args.sweep === true) { cleared = skillCatalogSweep(); how = 'sweep'; }
    else if (args.source) { cleared = skillCatalogClearSource(args.source); how = 'source:' + args.source; }
    else { cleared = skillCatalogClear(); how = 'all'; }
    // [G68] 全清时把校验缓存和 hermes 解析快照一起打掉: 换索引/删技能后不能靠 30s TTL 或旧快照兜着。
    if (how === 'all') { skillVerifyClear(); skillSnapshotDrop(); }
    audit({ decision: 'SKILL_CACHE_CLEAR', tool: name, how, cleared });
    return { text: JSON.stringify({ ok: true, how, cleared, sizeBefore, size: _SKILL_CATALOG_CACHE.size, max: SKILL_CATALOG_MAX_KEYS, ttl_ms: SKILL_CATALOG_TTL_MS, verify_size: _SKILL_VERIFY_CACHE.size, snapshot: !!_SKILL_SNAP }) };
  }
  if (name === 'skill_read' || name === 'kb_read') {
    const t0 = Date.now();
    // [G81] E:\KnowledgeBase 的文件一律走 HK，不在本地落盘解析（老板明令不直连 E 盘）。
    // 判定依据：路径首段命中真实顶层目录白名单。包内 product/skills 路径不在此列，仍走本地。
    const _topSeg = String(args.path || '').replace(/\\/g, '/').replace(/^\/+/, '').split('/')[0];
    if (name === 'kb_read' && KB_REAL_SCOPES.includes(_topSeg)) {
      const remotePath = kbRemotePath(args.path);
      if (!remotePath) throw new Error('NOT_FOUND: local-only resource ' + String(args.path).slice(0, 120));
      let rnet;
      try { rnet = await kbNet('/kb/read', { path: remotePath }); }
      catch (e) { rnet = { error: String(e && e.message || e) }; }
      const rdata = rnet && rnet.data;
      if (!rnet || rnet.httpStatus !== 200 || !rdata || rdata.ok === false || rdata.error || typeof rdata.content !== 'string') {
        return kbToolResult(kbRemoteFailure(rnet, remotePath.split('/')[0], null));
      }
      const rbytes = rdata.bytes == null ? Buffer.byteLength(rdata.content, 'utf8') : Number(rdata.bytes);
      if (Buffer.byteLength(rdata.content, 'utf8') > KB_READ_LIMIT || rbytes > KB_READ_LIMIT) throw new Error('TOO_LARGE: remote KB file exceeds 512KB');
      audit({ decision: 'NET_READ', tool: name, path_head: remotePath.slice(0, 120), size: rbytes, ms: Date.now() - t0 });
      return kbToolResult({ ok: true, path: rdata.path || remotePath, size: rbytes,
        content: rdata.content, source: 'server', truncated: false });
    }
    let localError;
    try {
      const r = kbResolve(args.path, name);
      const st = fs.statSync(r.longPath);
      if (st.isDirectory()) throw new Error('TOOL_ERROR: 目标是目录, 需单文件路径: ' + r.rel);
      if (st.size > KB_READ_LIMIT) throw new Error('TOO_LARGE: 单文件 ' + st.size + 'B 超过 512KB 上限, 报错不截断');
      const content = fs.readFileSync(r.longPath, 'utf8');
      audit({ decision: 'FS_READ', tool: name, path_head: r.rel.slice(0, 120), size: st.size, ms: Date.now() - t0 });
      return kbToolResult({ ok: true, path: r.rel, size: st.size, content, source: 'local', truncated: false });
    } catch (e) {
      // Availability fallback must never bypass a local security/size/type rejection.
      if (name !== 'kb_read' || !(/^NOT_FOUND:/.test(e.message) || ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(e.code))) throw e;
      localError = { code: e.code || 'NOT_FOUND', error: e.message.slice(0, 240) };
    }
    const remotePath = kbRemotePath(args.path);
    if (!remotePath) throw new Error('NOT_FOUND: local-only resource ' + String(args.path).slice(0, 120));
    let net;
    try { net = await kbNet('/kb/read', { path: remotePath }); }
    catch (e) { net = { error: String(e && e.message || e) }; }
    const data = net && net.data;
    if (!net || net.httpStatus !== 200 || !data || data.ok === false || data.error || typeof data.content !== 'string') return kbToolResult(kbRemoteFailure(net, remotePath.split('/')[0], localError));
    if (Buffer.byteLength(data.content, 'utf8') > KB_READ_LIMIT || Number(data.size) > KB_READ_LIMIT) throw new Error('TOO_LARGE: remote KB file exceeds 512KB');
    if (data.path && kbRemotePath(data.path) !== remotePath) throw new Error('SCOPE_BLOCKED: remote KB returned a different path');
    audit({ decision: 'NET_READ', tool: name, path_head: remotePath.slice(0, 120), size: data.size, ms: Date.now() - t0 });
    return kbToolResult({ ok: true, path: data.path || remotePath, size: data.size == null ? Buffer.byteLength(data.content) : data.size,
      content: data.content, source: 'server', scope: data.scope || remotePath.split('/')[0],
      scanned: data.scanned == null ? null : data.scanned, truncated: data.truncated == null ? false : data.truncated, local: localError });
  }
  if (name === 'web_search') {
    // 互联网检索（KB 查不到时的兜底通道）。
    // 用 Bing CN（cn.bing.com），国内直连可达，无需 API key、无需登录、不依赖付费服务。
    // 已实测：DuckDuckGo 在本机直连超时，Bing CN 200 且结果块可稳定解析。
    const q = String(args.query || '').trim();
    if (!q) throw new Error('query 不能为空');
    const max = Math.max(1, Math.min(parseInt(args.max, 10) || 8, 20));
    const https = require('https');
    const http = require('http');
    function fetchText(url, redirects) {
      return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, timeout: 20000 }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (redirects || 0) < 5) {
            res.resume();
            return resolve(fetchText(new URL(res.headers.location, url).toString(), (redirects || 0) + 1));
          }
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { buf += c; if (buf.length > 400000) req.destroy(); });
          res.on('end', () => resolve({ status: res.statusCode, body: buf }));
        });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.on('error', reject);
      });
    }
    const url = 'https://cn.bing.com/search?q=' + encodeURIComponent(q);
    const r = await fetchText(url, 0);
    if (r.status !== 200) throw new Error('web_search HTTP ' + r.status);
    // 解析 Bing CN 结果项（b_algo 块）
    const hits = [];
    const strip = (t) => String(t || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&ensp;|&nbsp;/g, ' ').replace(/&#0183;/g, '·').replace(/\s+/g, ' ').trim();
    const blocks = r.body.split(/<li class="b_algo"/).slice(1);
    for (const b of blocks) {
      if (hits.length >= max) break;
      const h2 = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(b);
      const a = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(h2 ? h2[1] : b);
      if (!a) continue;
      const cap = /<p[^>]*class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(b) || /<p[^>]*>([\s\S]*?)<\/p>/.exec(b);
      hits.push({ title: strip(a[2]), url: a[1], snippet: strip(cap ? cap[1] : '') });
    }
    const engine = 'bing-cn';
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, query: q, engine: 'bing-cn', count: hits.length, hits }, null, 2) }] };
  }

  if (name === 'kb_search') {
    const t0 = Date.now();
    const q = String(args.query || '').trim();
    if (!q) throw new Error('query 不能为空');
    const mode = String(args.mode || 'name').toLowerCase();
    const scope = String(args.scope || 'both').toLowerCase().replace(/^redtree$/, 'redteam');
    const max = Math.max(1, Math.min(parseInt(args.max, 10) || 50, 200));
    if (!['name', 'content'].includes(mode) || !['tg', 'redteam', 'product', 'both', 'analyzed', 'all'].includes(scope)) throw new Error('TOOL_ERROR: invalid KB mode/scope');
    if (mode === 'content' && scope === 'redteam') throw new Error('SCOPE_BLOCKED: 红队库禁全文扫描, 请用 mode=name');
    const ql = q.toLowerCase();
    const remoteArgs = { query: q, mode, scope, max };
    const local = { ok: true, source: 'local', query: q, mode, scope, hits: [], scanned: 0, truncated: false, partial: false, sources: [] };
    const finish = (localOnly) => {
      local.matched = local.hits.length;
      local.partial = local.partial || local.truncated !== false || local.sources.some(s => s.status && s.status !== 'ok');
      audit({ decision: 'FS_SEARCH', tool: name, query_hash: crypto.createHash('sha256').update(q).digest('hex').slice(0, 12),
        hits: local.matched, mode, scope, scanned: local.scanned, truncated: local.truncated, ms: Date.now() - t0 });
      // [KBMERGE] localOnly=true: analyzed 纯本地 corpus, 远端没有它, 禁止落入 finishKbSearch 的 kbNet 回退
      // (旧逻辑 local.hits 为空时会把 scope 原样发给 kb_server —— 'analyzed' 在服务端 SCOPE_PREFIXES 里不存在, 属未定义行为)
      if (localOnly) return kbToolResult(local);
      return finishKbSearch(local, remoteArgs);
    };
    // [G81] 老板明令：知识库一律从 HK 取，客户端不直连 E 盘。
    // redteam / tg / both 直接交给 kbNet(-> HK:9443 -> 隧道 -> 数据端)，本机不再 ekbSearch、不再磁盘 walk。
    // product 仍读包内 product_data（随包发布的语料，不属于 E 盘），走下面的本地分支。
    // [KBMERGE 2026-11-08] scope=analyzed: 只查 D:\分析到的 本机资料库(grep 级, 嫁接 local_fs_search 的受控
    // walk: 限深8(实测覆盖91%)/单文件2MB/时间2500ms/字节64MB/条目50000), 纯本地 corpus, 不落远端回退。单查询 ≤3s。
    if (scope === 'analyzed') {
      const a = analyzedKbSearch(q, mode, max, 2500, Date.now());
      local.sources.push({ source: 'analyzed', status: a.status, hits: a.hits.length, scanned: a.scanned, truncated: a.truncated, ms: a.ms });
      local.hits = a.hits.map(function (h) {
        return h.kind === 'name' ? '[name] ' + h.path + ' (' + h.size + 'B)'
          : '[content] ' + h.path + ':' + h.line + ' ' + h.snippet;
      });
      local.docs = a.hits.map(function (h) {
        return { source: 'analyzed', path: h.path, abs: h.abs, line: h.line || null, snippet: h.snippet || '' };
      });
      local.scanned = a.scanned;
      local.truncated = a.truncated;
      local.detail = 'analyzed walk: ' + a.scanned + ' entries, ' + a.bytes + 'B read, ' + a.ms + 'ms';
      return finish(true);
    }
    // [KBMERGE 2026-11-08] scope=all: 三路并发融合 —— 远端 kbNet(E盘 corpus, scope 降级为 both)
    // + ekb FTS/product(包内产品库) + analyzed(D:\分析到的 本机库), 轮转合并去重, 总时间盒 2700ms。
    if (scope === 'all') return kbSearchAllFusion(name, q, mode, max, args, t0);
    if (scope !== 'product') return finish();
    // [EKB-FTS] 优先走 E 盘 FTS5 索引(引用式: 命中直接取 kb.body 作正文, 不回头读盘)。
    // 查询必有 LIMIT、不做 bm25 排序、source/category 收窄在窗口内 JS 过滤(详见 kb_fts.js 头部实测注释)。
    // 零命中 / 索引不可用 → 落到下面的磁盘 walk, 行为与改造前一致, 不报错。
    if ((scope === 'product' || scope === 'both') && !args.path) {
      try {
        const fr = await ekbSearch(q, { mode, max, source: args.source, category: args.category });
        if (fr && fr.ok && fr.hits.length) {
          local.hits = fr.hits.map(function (h) {
            return '[fts] ' + h.path + ':' + (h.line_start == null ? '?' : h.line_start) + ' ' + (h.title || '')
              + ' | ' + String(h.snippet || '').replace(/\s+/g, ' ').slice(0, 160);
          });
          // 正文随结果回传: 调用方不用再 kb_read 一遍; 要完整原文时用 abs(=KB_SOURCE_ROOT+path)读盘
          local.docs = fr.hits.map(function (h) {
            return { path: h.path, title: h.title, source: h.source, category: h.category,
              line_start: h.line_start, line_end: h.line_end, body: h.body,
              body_len: h.body_len, body_truncated: h.body_truncated, abs: h.abs };
          });
          local.scanned = fr.scanned;
          local.truncated = fr.truncated !== false;
          local.engine = fr.engine;
          local.sources.push({ source: 'ekb-fts', status: 'ok', engine: fr.engine, ms: fr.ms,
            note: fr.note, hits: fr.hits.length, scanned: fr.scanned });
          return finish();
        }
        // 结果码永远带回(零命中/索引不可用/磁盘兜底都有 code): 调用方能看出走的是哪条路, 而不是只看到空 hits
        local.sources.push(fr && fr.ok
          ? { source: 'ekb-fts', status: 'no_hit', engine: fr.engine, ms: fr.ms, note: fr.note,
              code: fr.code || (fr.engine === 'disk-walk' ? 'EKB_DISK_FALLBACK' : 'NO_HIT') }
          : { source: 'ekb-fts', status: 'unavailable', engine: fr && fr.engine, ms: fr && fr.ms,
              code: (fr && fr.code) || 'EKB_UNAVAILABLE', error: String(fr && fr.error || '').slice(0, 240) });
      } catch (e) {
        // ekbSearch 契约上不抛; 这里只是最后一道网: 任何漏网异常都降级成 source 状态, 不打断 kb_search
        local.sources.push({ source: 'ekb-fts', status: 'error', ...skillSourceError(e) });
      }
    }
    // Check the requested corpus, not the existence of its parent directory.
    if ((scope === 'product' || scope === 'both') && !args.path) {
      try {
        const pr = productSearchStatus(await productSearch(q, { mode, max }), mode, max);
        Object.assign(local, { hits: pr.hits, scanned: pr.scanned, truncated: pr.truncated, partial: pr.partial });
        local.sources.push({ source: 'product', status: pr.missing_index.length ? 'missing_index' : 'ok', ...pr, hits: pr.hits.length });
      } catch (e) { local.sources.push({ source: 'product', ...skillSourceError(e) }); }
      if (local.hits.length || scope === 'product') return finish();
    }
    const tgRoot = path.join(R1_BASE, 'tg情报');
    const rtRoot = R3_BASE;
    const scopes = [];
    if (scope !== 'redteam') scopes.push({ id: 'R1/tg情报', dir: tgRoot });
    if (scope !== 'tg') scopes.push({ id: 'R3', dir: rtRoot });
    const hits = local.hits;
    let note = '';
    for (const s of scopes) local.sources.push({ source: s.id, status: fs.existsSync(s.dir) ? 'ok' : 'missing', ...(fs.existsSync(s.dir) ? {} : { code: 'ENOENT' }) });
    if (args.path && (mode !== 'content' || scope === 'product')) throw new Error('TOOL_ERROR: path is supported only for tg content search');
    if (mode === 'content') {
      // tg情报 行文件全文检索(行数/字节上限); path 参数与 scope 同闸(2026-09-27): 必须落在 tg情报 根, 否则 SCOPE_BLOCKED
      const files = [];
      let wantFile = null;
      if (args.path) {
        let r;
        try { r = kbResolve(args.path, name); }
        catch (e) {
          if (!/^NOT_FOUND:/.test(e.message)) throw e;
          const remotePath = kbRemotePath(args.path);
          if (!remotePath || !remotePath.startsWith('知识库/tg情报/')) throw new Error('SCOPE_BLOCKED: content path must remain in tg情报');
          remoteArgs.path = remotePath;
          local.sources.push({ source: 'tg/path', ...skillSourceError(e) });
          return finish();
        }
        const tgN = fs.realpathSync(tgRoot).replace(/\\/g, '/').toLowerCase();
        const rN = String(r.real || '').replace(/\\/g, '/').toLowerCase();
        if (rN !== tgN && !rN.startsWith(tgN + '/')) {
          audit({ decision: 'SCOPE_BLOCKED', tool: name, path_head: String(args.path).slice(0, 60), deny: 'content-path-非tg情报根' });
          throw new Error('SCOPE_BLOCKED: content 模式 path 必须落在 tg情报 根内(当前 ' + r.rel.slice(0, 80) + ')');
        }
        wantFile = r;
        remoteArgs.path = kbRemotePath(r.rel);
      }
      if (wantFile) {
        files.push({ rel: wantFile.rel, long: wantFile.longPath });
      } else {
        let ents; try { ents = fs.readdirSync(tgRoot); } catch (_) {}
        for (const f of (ents || [])) {
          if (!/\.txt$/i.test(f)) continue;
          const fp = path.join(tgRoot, f);
          let st; try { st = fs.statSync(fp); } catch (_) { continue; }
          if (st.isFile()) files.push({ rel: 'R1/tg情报/' + f, long: '\\\\?\\' + fp, size: st.size });
        }
      }
      const MAX_LINES = 400000, MAX_BYTES = 64 * 1024 * 1024;
      let linesRead = 0, bytesRead = 0;
      for (const f of files) {
        if (hits.length >= max || linesRead >= MAX_LINES || bytesRead >= MAX_BYTES) break;
        let st; try { st = fs.statSync(f.long); } catch (_) { continue; }
        if (st.size > MAX_BYTES - bytesRead) { note += ' [skip>' + f.rel + ']'; local.truncated = true; continue; }
        let text;
        try { text = fs.readFileSync(kbResolve(f.rel, name).longPath, 'utf8'); }
        catch (e) { local.sources.push({ source: f.rel, ...skillSourceError(e) }); continue; }
        bytesRead += Buffer.byteLength(text, 'utf8');
        const ls = text.split(String.fromCharCode(10));
        for (let i = 0; i < ls.length; i++) {
          linesRead++;
          if (linesRead > MAX_LINES) break;
          if (ls[i].toLowerCase().indexOf(ql) !== -1) {
            hits.push('[content] ' + f.rel + ':' + (i + 1) + ' ' + ls[i].trim().slice(0, 160));
            if (hits.length >= max) break;
          }
        }
      }
      local.scanned = linesRead;
      if (hits.length >= max || linesRead >= MAX_LINES || bytesRead >= MAX_BYTES) local.truncated = true;
      note += ' lines=' + linesRead;
    } else {
      // mode=name: 文件名/路径匹配 + 已有索引(83GB 库禁整库全文扫描)
      // 1) 索引先行: _manifest 顶层 report/索引文件 + 00-全库导览.md
      const idxFiles = scope === 'tg' ? [] : [path.join(rtRoot, '00-全库导览.md')];
      let indexesRead = 0;
      if (scope !== 'tg') {
        const md = path.join(rtRoot, '_manifest');
        try { for (const f of fs.readdirSync(md)) if (/\.json$|\.md$|\.txt$/i.test(f)) idxFiles.push(path.join(md, f)); } catch (_) {}
        try { for (const f of fs.readdirSync(path.join(md, '_i3'))) if (/^(targets_|all_targets)\S*\.txt$/i.test(f)) idxFiles.push(path.join(md, '_i3', f)); } catch (_) {}
      }
      for (const ip of idxFiles) {
        if (hits.length >= max) break;
        let st; try { st = fs.statSync(ip); } catch (_) { continue; }
        if (!st.isFile() || st.size > 50 * 1024 * 1024) continue;
        let ls;
        try { ls = fs.readFileSync(kbResolve(ip, name).longPath, 'utf8').split(/\r?\n/); indexesRead++; }
        catch (e) { local.sources.push({ source: 'R3/index', ...skillSourceError(e) }); continue; }
        for (let i = 0; i < ls.length; i++) {
          if (ls[i].toLowerCase().indexOf(ql) !== -1) {
            hits.push('[index] R3/' + path.relative(rtRoot, ip).replace(/\\/g, '/') + ':' + (i + 1) + ' ' + ls[i].trim().slice(0, 140));
            if (hits.length >= max) break;
          }
        }
      }
      if (scope !== 'tg') local.sources.push({ source: 'R3/index', status: indexesRead ? 'ok' : 'missing_index', scanned: indexesRead });
      // 2) 文件名 walk(条数/时间预算, 不整扫)
      let scanned = 0, truncated = false;
      const BUDGET_ENTRIES = 200000, BUDGET_MS = 15000;
      for (const s of scopes) {
        (function walk(dir, depth) {
          if (truncated || hits.length >= max || scanned >= BUDGET_ENTRIES || Date.now() - t0 > BUDGET_MS) { truncated = true; return; }
          let ents; try { ents = fs.readdirSync(dir); } catch (e) { local.sources.push({ source: s.id, ...skillSourceError(e) }); return; }
          for (const f of ents) {
            scanned++;
            if (scanned >= BUDGET_ENTRIES || Date.now() - t0 > BUDGET_MS) { truncated = true; return; }
            if (hits.length >= max) { truncated = true; return; }
            const fp = path.join(dir, f);
            if (kbDenyHit(fp.replace(/\\/g, '/').toLowerCase())) continue;
            let st; try { st = fs.lstatSync(fp); } catch (_) { local.partial = true; continue; }
            if (st.isSymbolicLink()) continue;
            if (st.isDirectory()) { if (depth < 6) walk(fp, depth + 1); else local.truncated = true; continue; }
            if (f.toLowerCase().indexOf(ql) !== -1) {
              hits.push('[name] ' + s.id + '/' + path.relative(s.dir, fp).replace(/\\/g, '/') + ' (' + st.size + 'B)');
            }
          }
        })(s.dir, 0);
      }
      local.scanned = (local.scanned || 0) + scanned;
      if (truncated || hits.length >= max) local.truncated = true;
      note += ' scanned=' + scanned + (truncated ? '(预算截断)' : '');
    }
    local.detail = note.trim();
    return finish();
  }
  if (name === 'cdp_navigate') {
    const url = String(args.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      audit({ decision: 'CDP_BLOCKED', url_head: url.slice(0, 60) });
      throw new Error('CDP_BLOCKED: 仅允许 http/https URL(file:/chrome:/data: 等一律拒绝)');
    }
    await ensureCdp();
    const tab = await cdpTarget();
    const s = await cdpSession(cdpWsPath(tab));
    try {
      await s.send('Page.enable');
      await s.send('Page.navigate', { url });
      await waitLoadEvent(s, 12000);
      let title = null;
      try { title = await cdpEval(s, 'document.title'); } catch (_) {}
      audit({ decision: 'CDP_NAV', url: url.slice(0, 120) });
      return { text: JSON.stringify({ ok: true, url, title }) };
    } finally { s.close(); }
  }
  if (name === 'cdp_click') {
    const sel = String(args.selector || '').trim();
    if (!sel) throw new Error('selector 必填');
    await ensureCdp();
    const tab = await cdpTarget();
    const s = await cdpSession(cdpWsPath(tab));
    try {
      await s.send('Runtime.enable');
      const clicked = await cdpEval(s, "(() => { const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return false; try { el.scrollIntoView({ block: 'center' }); } catch (_) {} el.click(); return true; })()");
      audit({ decision: 'CDP_CLICK', sel_head: sel.slice(0, 80), clicked: !!clicked });
      return { text: JSON.stringify({ ok: !!clicked, selector: sel, url: tab.url }) };
    } finally { s.close(); }
  }
  if (name === 'cdp_eval') {
    const expr = String(args.expression || '');
    if (!expr.trim()) throw new Error('expression 必填');
    await ensureCdp();
    const tab = await cdpTarget();
    const s = await cdpSession(cdpWsPath(tab));
    try {
      await s.send('Runtime.enable');
      const v = await cdpEval(s, expr);
      audit({ decision: 'CDP_EVAL', url_head: String(tab.url || '').slice(0, 80) });
      return { text: typeof v === 'string' ? v.slice(0, 200000) : JSON.stringify(v) };
    } finally { s.close(); }
  }
  if (name === 'cdp_screenshot') {
    await ensureCdp();
    const tab = await cdpTarget();
    const s = await cdpSession(cdpWsPath(tab));
    try {
      await s.send('Page.enable');
      const shot = await s.send('Page.captureScreenshot', { format: 'png' });
      const png = Buffer.from(shot.data, 'base64');
      const dir = path.join(path.resolve(WORKROOT), 'screenshots');
      fs.mkdirSync(dir, { recursive: true });
      const dst = path.join(dir, 'cdp-' + Date.now() + '.png');
      fs.writeFileSync(dst, png);
      const rel = 'screenshots/' + path.basename(dst);
      audit({ decision: 'SCREENSHOT', path: rel, size: png.length, source: 'cdp' });
      return { text: JSON.stringify({ saved: rel, size: png.length, sha256: crypto.createHash('sha256').update(png).digest('hex'), target: tab.url }) };
    } finally { s.close(); }
  }
  if (name === 'process_list') {
    const a = String(args.args || '').trim();
    if (a && !/^[\s\/A-Za-z0-9*=":.-]*$/.test(a)) throw new Error('TOOL_BLOCKED: 参数形态不合规');
    const argv = [];
    let rest = a;
    rest = rest.replace(/\/FI\s+"([^"]+)"/g, (_, f) => { argv.push('/FI', f); return ' '; });
    rest = rest.replace(/\/FO\s+(\w+)/g, (_, f) => { argv.push('/FO', f); return ' '; });
    for (const tok of rest.split(/\s+/)) if (tok) argv.push(tok);
    return new Promise((resolve, reject) => {
      // [G45] encoding:'buffer' + decodeSmart: tasklist 是 cp936 输出, 默认 utf8 解码必出 42 个 U+FFFD
      execFile('tasklist', argv, { timeout: 20000, maxBuffer: 16 << 20, windowsHide: true, encoding: 'buffer' }, (err, stdoutBuf, stderrBuf) => {
        const stdout = decodeSmart(stdoutBuf), stderr = decodeSmart(stderrBuf);
        const out = ((stdout || '') + (stderr ? '\n[stderr] ' + stderr : '')).trim();
        if (err && !out) return reject(new Error('EXEC_FAIL: rc=' + (err.code || -1) + ' ' + err.message.slice(0, 150)));
        audit({ decision: 'EXEC', tool: 'win_process', ok: !err, rc: err && err.code ? err.code : 0 });
        resolve({ text: markTruncated(out || '(无输出)', 200000) });
      });
    });
  }
  const t = TOOLS[name];
  if (!t) throw new Error('TOOL_BLOCKED: 未知工具 ' + name);
  const a = (args.args || '').trim();
  if (!t.argre.test(a)) throw new Error('TOOL_BLOCKED: 参数形态不合规');
  if (WRITE_GUARD.test(a)) throw new Error('WRITE_GUARD: 禁止变更类操作');
  return new Promise((resolve, reject) => {
    // [G45] encoding:'buffer' + decodeSmart: systeminfo 等 cp936 输出统一走替换符计数判据
    execFile(t.exe, a ? a.split(/\s+/) : [], { timeout: 30000, maxBuffer: 16 << 20, windowsHide: true, encoding: 'buffer' },
      (err, stdoutBuf, stderrBuf) => {
        const stdout = decodeSmart(stdoutBuf), stderr = decodeSmart(stderrBuf);
        const out = ((stdout || '') + (stderr ? '\n[stderr] ' + stderr : '')).trim();
        if (err && !out) return reject(new Error('EXEC_FAIL: rc=' + (err.code || -1) + ' ' + err.message.slice(0, 200)));
        audit({ decision: 'EXEC', tool: name, ok: !err, rc: err && err.code ? err.code : 0 });
        resolve({ text: markTruncated(out || '(无输出)', 200000) });
      });
  });
}

// 统一调用入口: Promise 化, 审计(补 tool+path 摘要)+错误归类
// ── 2026-09-29 exec 工具链修复: runCmdFull ──
// stdout/stderr 全捕获(spawn 流式收集, 无 maxBuffer 1MB/8MB 截断丢失; 上限 64MB),
// UTF-8 解码(cmd 以 chcp 65001 运行, 中文不乱码), 超时 kill 前已收流的输出保留并标注,
// 失败不静默: 结构化错误含 stderr+退出码+原因。
const CMD_OUT_LIMIT = 64 << 20;
const CMD_TEXT_LIMIT = 200000;

function redactCmd(cmd) {
  // 审计日志凭据脱敏: token/key/password/secret/sk-/Bearer/ghp_ 后面的取值打码
  let s = String(cmd || '');
  s = s.replace(/((?:token|key|password|passwd|secret|api[_-]?key|bearer|authorization)\s*[=:]\s*["']?)([^\s"'&|<>]+)/gi, (m, p1) => p1 + '***');
  s = s.replace(/\b(sk-[A-Za-z0-9_-]{6,}|ghp_[A-Za-z0-9]{6,})/g, '***');
  return s;
}

function markTruncated(text, limit) {
  const s = String(text == null ? '' : text);
  const lim = parseInt(limit, 10) || CMD_TEXT_LIMIT;
  if (s.length <= lim) return s;
  return s.slice(0, lim) + '\n…[truncated 展示 ' + lim + ' / 真实总数 ' + s.length + ' 字符]';
}

function terminateProcessTree(child) {
  if (!child || !child.pid) return;
  if (process.platform !== 'win32') {
    try { child.kill('SIGKILL'); } catch (_) {}
    return;
  }
  // taskkill is the Windows-native tree terminator. Invoke it directly with a bounded
  // execFile call; never start another shell and never kill only cmd.exe.
  execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
    timeout: 10000, maxBuffer: 1 << 20, windowsHide: true,
  }, () => {});
}

// [G45] 输出解码: UTF-8 优先, 但判据不是「GBK 结果必须零替换符」——GBK 回退后仍可能有个别替换符
// (混排/私有区/截断字节), 旧判据一票否决就退回 UTF-8 乱码版。改成比替换符个数, 取少的那个;
// 个数相同保留 utf-8。execFile 侧必须配 encoding:'buffer', 否则 Node 已按 utf8 解坏, 这里救不回来。
function decodeSmart(buf) {
  if (!Buffer.isBuffer(buf)) return String(buf == null ? '' : buf);
  const bad = (s) => { let n = 0; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0xFFFD) n++; return n; };
  const u = buf.toString('utf8');
  const nu = bad(u);
  if (!nu) return u;                                  // 纯 UTF-8: 零成本直通
  let g = '';
  try { g = new TextDecoder('gbk').decode(buf); } catch (_) { return u; }
  return bad(g) < nu ? g : u;
}

function runCmdFull(cmd, timeoutMs, toolName, opts) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const signal = opts && opts.signal;
    // chcp 65001: cmd 内建命令/错误消息以 UTF-8 输出, 避免中文 cp936 乱码
    const child = spawn('cmd.exe', ['/d', '/s', '/c', 'chcp 65001>nul 2>nul & ' + cmd], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = []; let outBytes = 0, errChunks = [], errBytes = 0, spawnErr = null;
    let timedOut = false, cancelled = false, terminating = false;
    const terminate = (reason) => {
      if (terminating) return;
      terminating = true;
      if (reason === 'timeout') timedOut = true;
      if (reason === 'cancel') cancelled = true;
      terminateProcessTree(child);
    };
    const onAbort = () => terminate('cancel');
    if (signal && signal.aborted) onAbort();
    else if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => terminate('timeout'), timeoutMs || 60000);
    let settled = false;
    // [2026-10-29 巡检修复] 硬上限兜底: 即便 close 事件在极端情况下未触发(子进程树 stdio 未完全回收), 也强制超时, 避免 promise 永远挂起
    const hardCap = setTimeout(() => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      const e = new Error('EXEC_TIMEOUT: hard cap exceeded ' + ((timeoutMs || 60000) + 15000) + 'ms'); e.code = 'ETIMEDOUT';
      reject(e);
    }, (timeoutMs || 60000) + 15000);
    child.stdout.on('data', (c) => { outBytes += c.length; if (outBytes <= CMD_OUT_LIMIT) chunks.push(c); });
    child.stderr.on('data', (c) => { errBytes += c.length; if (errBytes <= CMD_OUT_LIMIT) errChunks.push(c); });
    child.on('error', (e) => { spawnErr = e; });
    child.on('close', (code, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardCap);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      const rc = typeof code === 'number' ? code : (sig ? -1 : 0);
      const outBuf = Buffer.concat(chunks), errBuf = Buffer.concat(errChunks);
      // [G45] 解码判据见 decodeSmart 定义处: 比两种解码的替换符个数, 取少的那个
      const stdoutTxt = decodeSmart(outBuf), stderrTxt = decodeSmart(errBuf);
      let out = (stdoutTxt || '') + (stderrTxt ? '\n[stderr] ' + stderrTxt : '');
      out = out.replace(/\r\n/g, '\n').trim();
      if (timedOut) out += '\n[timeout 已在 ' + (timeoutMs || 60000) + 'ms 结束进程, 以上为已收到的部分输出]';
      const combinedBytes = outBytes + errBytes;
      audit({
        decision: 'EXEC', tool: toolName || 'sys_exec', cmd: redactCmd(cmd).slice(0, 300),
        cmd_hash: crypto.createHash('sha256').update(cmd).digest('hex').slice(0, 12),
        rc, ok: rc === 0 && !timedOut && !cancelled, out_bytes: combinedBytes,
        ms: Date.now() - t0, timed_out: timedOut, cancelled,
      });
      if (spawnErr) {
        return reject(new Error('EXEC_FAIL: spawn 失败 rc=' + rc + ' stderr=' + (stderrTxt.slice(0, 200) || '(无)') + ' 原因=' + spawnErr.message.slice(0, 150)));
      }
      if (cancelled) {
        const e = new Error('EXEC_CANCELLED: caller disconnected'); e.code = 'EABORT';
        return reject(e);
      }
      if (timedOut) {
        const e = new Error('EXEC_TIMEOUT: exceeded ' + (timeoutMs || 60000) + 'ms'); e.code = 'ETIMEDOUT';
        return reject(e);
      }
      let text = markTruncated(out || '(无输出)', CMD_TEXT_LIMIT);
      if (rc !== 0) text += '\n[exit code ' + rc + ']';  // 非零退出码显式带出, 不静默
      resolve({ text });
    });
  });
}

// [E2] 工具错误统一分类: 失败必须带 code/reason/hint, 绝不透出裸技术消息或空
function classifyToolError(name, e, args) {
  const raw = String((e && e.message) || e || 'unknown').slice(0, 300);
  const a = args || {};
  const p = String(a.path || a.file || '').slice(0, 160);
  const M = (code, reason, hint, retryable) =>
    '[tool:' + name + '] TOOL_ERROR code=' + code + ' reason=' + reason +
    (hint ? ' hint=' + hint : '') + ' retryable=' + (retryable ? 'true' : 'false') + ' | 原始: ' + raw;
  if (/^SCOPE_BLOCKED/.test(raw)) return M('SECURITY_BLOCKED', raw.replace(/^SCOPE_BLOCKED:?\s*/, ''), '换合规路径/先列目录确认', false);
  if (/^EXEC_FAIL/.test(raw)) return M('EXEC_FAIL', raw.replace(/^EXEC_FAIL:?\s*/, ''), '检查命令是否存在/参数是否正确', false);
  if (/^NOT_FOUND/.test(raw)) return M('FILE_NOT_FOUND', raw.replace(/^NOT_FOUND:?\s*/, ''), '确认根别名(P=产品技能库, P-kb=产品知识库, R1/R2/Hermes=旧源)与路径拼写', false);
  if (/^TOO_LARGE/.test(raw)) return M('TOO_LARGE', raw.replace(/^TOO_LARGE:?\s*/, ''), '用 kb_search 定位后分段读取', false);
  if (/^WRITE_|^SCOPE_/.test(raw)) return M('SECURITY_BLOCKED', raw, '该路径/操作被安全策略拒绝', false);
  if (/^TOOL_ERROR/.test(raw)) return M('TOOL_ERROR', raw.replace(/^TOOL_ERROR:?\s*/, ''), '', false);
  if (/ENOENT|no such file/i.test(raw)) return M('FILE_NOT_FOUND', '文件或目录不存在' + (p ? ': ' + p : ''), '用 fs.list 列目录确认路径, 或先 sys_exec dir 查看', false);
  if (/EACCES|EPERM|permission denied/i.test(raw)) return M('PERMISSION_DENIED', '权限不足' + (p ? ': ' + p : ''), '该文件被占用或无权限; 可尝试以更高权限运行或换路径', false);
  if (/EISDIR|是目录/.test(raw)) return M('IS_DIRECTORY', '目标是目录' + (p ? ': ' + p : ''), '改用目录内具体文件路径', false);
  if (/ENOTDIR/.test(raw)) return M('NOT_DIRECTORY', '路径中某段不是目录' + (p ? ': ' + p : ''), '检查路径拼写', false);
  if (/EBUSY|locked|被占用/i.test(raw)) return M('FILE_BUSY', '文件被占用' + (p ? ': ' + p : ''), '稍后重试或关闭占用程序', true);
  if (/ETIMEDOUT|timed? ?out|超时/i.test(raw)) return M('TIMEOUT', '操作超时' + (p ? ': ' + p : ''), '可重试; 大文件建议缩小范围', true);
  if (/ECONNRESET|ECONNREFUSED|socket hang up|EPIPE/i.test(raw)) return M('CONNECTION', '连接失败/被重置' + (p ? ': ' + p : ''), '检查目标服务是否在运行; 可重试', true);
  if (/JSON|parse|解析/.test(raw) && /argument/i.test(raw)) return M('BAD_ARGUMENTS', '参数解析失败', '重新调用并提供合法 JSON 参数', false);
  if (/args|参数/.test(raw) && /不能为空|required|missing/i.test(raw)) return M('BAD_ARGUMENTS', raw.slice(0, 120), '补齐必填参数后重试', false);
  return M('UNKNOWN', raw.slice(0, 160), '如重复失败请把本条完整信息反馈', false);
}

function argSummary(args) {
  const a = args || {};
  // cmd 入审计日志前同样脱敏(防止 path_head 通道泄凭据)
  return String(a.path || a.query || a.category || (a.cmd || a.command ? redactCmd(a.cmd || a.command) : '')).slice(0, 80);
}
async function runTool(tool, args, opts) {
  const t0 = Date.now();
  const result = await callTool(tool, args || {}, opts || {});
  audit({ decision: 'EXEC', tool, ok: !result.isError, ms: Date.now() - t0, path_head: argSummary(args) });
  return result;
}

// MCP JSONRPC 分发(对齐 omni_mcp_compat.rpc)
async function rpc(req) {
  const method = req.method;
  const rid = req.id;
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id: rid, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'omni-local', version: '1.2.0' },
      instructions: '基于对话内容工作；文件工具按用户给出的路径使用；缺少信息时直接向用户提问。' } };
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id: rid, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id: rid, result: { tools: MCP_TOOLS.filter(function (t) { return scopeAllows(t.name); }) } };
  if (method === 'tools/call') {
    const p = req.params || {};
    try {
      const out = await runTool(p.name, p.arguments || {});
      return { jsonrpc: '2.0', id: rid, result: { content: [{ type: 'text', text: out.text }], ...(out.isError ? { isError: true } : {}) } };
    } catch (e) {
      audit({ decision: e.message.startsWith('TOOL') || e.message.startsWith('WRITE') || e.message.startsWith('SCOPE') ? 'BLOCKED' : 'ERROR', tool: p.name, msg: e.message.slice(0, 150), path_head: argSummary(p.arguments) });
      return { jsonrpc: '2.0', id: rid, result: { content: [{ type: 'text', text: classifyToolError(p.name, e, p.arguments) }], isError: true } };
    }
  }
  if (rid !== undefined && rid !== null) {
    return { jsonrpc: '2.0', id: rid, error: { code: -32601, message: 'method not found' } };
  }
  return null;
}

function checkAuth(req) {
  if (!TOKEN) return false; // Authentication never opens when token state is absent.
  return req.headers['authorization'] === 'Bearer ' + TOKEN;
}

function readLimitedJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0; let done = false;
    const finish = (fn, v) => { if (!done) { done = true; fn(v); } };
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        const e = new Error('body too large'); e.code = 'ETOOLARGE';
        try { req.resume(); } catch (_) {}
        return finish(reject, e);
      }
      chunks.push(chunk);
    });
    req.on('error', (e) => finish(reject, e));
    req.on('end', () => finish(resolve, Buffer.concat(chunks, total)));
    req.on('aborted', () => { const e = new Error('request aborted'); e.code = 'EABORT'; finish(reject, e); });
  });
}
function streamUpload(req, rawName) {
  return new Promise((resolve, reject) => {
    const declared = parseInt(req.headers['content-length'] || '0', 10) || 0;
    if (declared > MAX_UPLOAD_BYTES) {
      // Drain a declared oversize body before replying, so a well-behaved local client receives
      // a deterministic 413 instead of a reset socket. No bytes are buffered or written.
      const e = new Error('file too large'); e.code = 'ETOOLARGE';
      req.on('data', () => {});
      req.once('error', () => reject(e));
      req.once('aborted', () => reject(e));
      req.once('end', () => reject(e));
      req.resume();
      return;
    }
    let original = 'upload-' + Date.now() + '.bin';
    try { original = decodeURIComponent(String(rawName || original)); } catch (_) {}
    original = path.basename(original).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'upload.bin';
    const id = crypto.randomBytes(12).toString('hex');
    const dir = path.join(WORKROOT, 'inbox');
    const finalName = id + '__' + original;
    const dst = path.join(dir, finalName);
    const tmp = dst + '.part-' + process.pid + '-' + Date.now();
    fs.mkdirSync(dir, { recursive: true });
    let total = 0, cleaned = false;
    const hash = crypto.createHash('sha256');
    const limiter = new Transform({ transform(chunk, _enc, cb) {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) { const e = new Error('file too large'); e.code = 'ETOOLARGE'; return cb(e); }
      hash.update(chunk); cb(null, chunk);
    }});
    const cleanup = () => { if (cleaned) return; cleaned = true; try { fs.rmSync(tmp, { force: true }); } catch (_) {} };
    const timeout = setTimeout(() => { const e = new Error('upload timeout'); e.code = 'ETIMEDOUT'; try { req.destroy(e); } catch (_) {}; }, 120000);
    pipeline(req, limiter, fs.createWriteStream(tmp, { flags: 'wx' }), (err) => {
      clearTimeout(timeout);
      if (err) { cleanup(); return reject(err); }
      try {
        fs.renameSync(tmp, dst);
        resolve({ ok: true, file_id: id, filename: original, path: 'inbox/' + finalName, sha256: hash.digest('hex'), size: total });
      } catch (e) { cleanup(); reject(e); }
    });
  });
}

function startBridge(port) {
  // [EKB-FTS] 起桥就预热 FTS(高频词拉页进缓存), 免得第一次搜索付冷页 23~51s。失败不影响起桥。
  try { ekbWarm(); } catch (_) {}
  const server = http.createServer((req, res) => {
    const origin = req.headers['origin'] || '';
    const cors = ALLOWED_ORIGINS.includes(origin) ? { 'Access-Control-Allow-Origin': origin } : {};
    const json = (code, obj) => {
      const b = JSON.stringify(obj);
      res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b) }, cors));
      res.end(b);
    };
    if (req.method === 'GET' && req.url === '/health') {
      // /health 保持无鉴权(对齐 omni-mcp)
      // [G8-修复] 缓存/常驻 worker 占用可观测: 不用连 inspector 就能看封顶是否生效、ps worker 是否常驻。
      // mem: RSS 是 V8 高水位(GC 后不一定还给 OS), heap_used 才反映 Map 是否还持有对象 —— 排内存必须两个一起看。
      const mu = process.memoryUsage();
      const mb = (n) => Math.round(n / 1048576 * 10) / 10;
      const hb = JSON.stringify({ ok: true, host: os.hostname(), tool_scope: TOOL_SCOPE, tools: MCP_TOOLS.filter(function (t) { return scopeAllows(t.name); }).map(t => t.name), new4: ['skill_list', 'skill_read', 'kb_search', 'kb_read'], mcp: true, perm_mode: PERM_MODE, perm_mode_source: PERM_MODE_SOURCE, version: '1.2.0',
        skill_cache: { size: _SKILL_CATALOG_CACHE.size, max: SKILL_CATALOG_MAX_KEYS, ttl_ms: SKILL_CATALOG_TTL_MS },
        mem: { rss_mb: mb(mu.rss), heap_used_mb: mb(mu.heapUsed), heap_total_mb: mb(mu.heapTotal), external_mb: mb(mu.external) },
        ps_worker: { resident: !!(_psGen && _psGen.ready && !_psGen.dead), broken: _psBroken, idle_ms: PS_IDLE_MS } });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(hb) });
      return res.end(hb);
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, Object.assign({ 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-filename' }, cors));
      return res.end();
    }
    if (!checkAuth(req)) {
      audit({ decision: 'AUTH_FAIL', path: req.url, ip: req.socket.remoteAddress });
      return json(401, { ok: false, error: 'unauthorized' });
    }

    const readBody = () => readLimitedJsonBody(req, MAX_JSON_BODY_BYTES);

    if (req.method === 'POST' && req.url === '/upload') {
      return streamUpload(req, req.headers['x-filename']).then((out) => {
        audit({ decision: 'UPLOAD', file: out.path, size: out.size, sha256: out.sha256 });
        json(200, out);
      }).catch((e) => {
        const code = e && e.code === 'ETOOLARGE' ? 413 : (e && e.code === 'EABORT' ? 400 : 500);
        json(code, { ok: false, error: code === 413 ? 'file too large' : String(e && e.message || e).slice(0, 200) });
      });
    }

    if (req.method === 'POST' && req.url === '/call') {
      return readBody().then((buf) => {
        let body = {};
        try { body = JSON.parse(buf.toString('utf8') || '{}'); } catch (_) {}
        const correlation = callCorrelation(body);
        const callController = new AbortController();
        let callSettled = false;
        const abortCall = () => {
          if (!callSettled && !callController.signal.aborted) {
            callController.abort(new Error('bridge caller disconnected'));
          }
        };
        const cleanupCall = () => {
          req.off('aborted', abortCall);
          res.off('close', abortCall);
        };
        req.once('aborted', abortCall);
        res.once('close', abortCall);
        return AUDIT_CONTEXT.run(correlation, () => runTool(body.tool, body.args || {}, { signal: callController.signal }).then((result) => {
          callSettled = true;
          cleanupCall();
          if (!res.destroyed) json(200, { ok: !result.isError, result });
        }).catch((e) => {
          callSettled = true;
          cleanupCall();
          const msg = String(e && e.message || e);
          audit({ decision: msg.startsWith('TOOL') || msg.startsWith('WRITE') || msg.startsWith('SCOPE') ? 'BLOCKED' : 'ERROR', tool: body.tool, msg: msg.slice(0, 150), path_head: argSummary(body.args) });
          if (!res.destroyed) json(400, { ok: false, error: msg.slice(0, 300) });
        }));
      }).catch((e) => {
        const code = e && e.code === 'ETOOLARGE' ? 413 : 400;
        json(code, { ok: false, error: code === 413 ? 'request too large' : 'bad request body' });
      });
    }

    if (req.method === 'POST' && req.url === '/mcp') {
      return readBody().then((buf) => {
        let reqJson;
        try { reqJson = JSON.parse(buf.toString('utf8') || '{}'); }
        catch (e) { return json(200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: ' + e.message.slice(0, 120) } }); }
        const correlation = callCorrelation(reqJson);
        return AUDIT_CONTEXT.run(correlation, () => Promise.resolve(rpc(reqJson)).then((resp) => {
          if (resp === null) return json(200, { jsonrpc: '2.0', id: reqJson.id, result: {} });
          json(200, resp);
        }).catch((e) => json(200, { jsonrpc: '2.0', id: reqJson.id, error: { code: -32603, message: String(e.message || e).slice(0, 200) } })));
      }).catch((e) => {
        const code = e && e.code === 'ETOOLARGE' ? -32001 : -32600;
        json(200, { jsonrpc: '2.0', id: null, error: { code, message: code === -32001 ? 'request too large' : 'bad request body' } });
      });
    }

    if (req.method === 'GET' && req.url === '/mcp') {
      const mb = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'POST only' } });
      res.writeHead(405, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(mb), Allow: 'POST' });
      return res.end(mb);
    }
    res.writeHead(404, { 'Content-Length': 0 }); res.end();
  });
  // [2026-10-29 巡检修复] 传输层超时: 防止慢速/挂死请求长期占用连接槽(/call /mcp 长任务边缘场景)
  server.headersTimeout = 15000;
  server.requestTimeout = 120000;
  server.keepAliveTimeout = 30000;
  server.listen(port, '127.0.0.1', () => {
    const boundPort = Number(server.address() && server.address().port) || port;
    audit({ decision: 'BRIDGE_START', port: boundPort, mcp: true, token: !!TOKEN });
    // The bearer value stays out of the renderer and logs; only the trusted Electron parent
    // receives it over the fork IPC channel for native drag/drop uploads.
    try { if (typeof process.send === 'function') process.send({ type: 'omni-bridge-ready', port: boundPort, token: TOKEN }); } catch (_) {}
    console.log('[bridge] listening 127.0.0.1:' + boundPort + ' (MCP: /mcp, token: ' + (TOKEN ? 'on' : 'off') + ')');
    // [G68] 启动预热: 后台先把 skill_list 的目录建好, 首次点击技能面板不再等扫盘。
    // 任何异常都吞掉 —— 预热失败只该退化成"首次调用慢", 不该影响 bridge 起来。
    try { skillWarmStart(ekbClampInt('OMNI_SKILL_WARM_DELAY_MS', 1200, 0, 60000)); } catch (_) {}
  });
  return server;
}

module.exports = { startBridge, ekbSearch, ekbWarm, ekbStatus: KB_FTS.status, kbFts: KB_FTS,
  kbSourceRoot: KB_SOURCE_ROOT, productKbDir: PRODUCT_KB_DIR, kbSourceOk: KB_SOURCE_OK };


// [1.1.35] 子进程/独立启动: node bridge.js 或 child_process.fork(bridge.js) 时直接起服务
if (require.main === module) {
  const _p = parseInt(process.env.OMNI_BRIDGE_PORT || '9431', 10);
  try { startBridge(_p); console.log('[bridge] standalone on 127.0.0.1:' + _p); }
  catch (e) { console.error('[bridge] start fail: ' + (e && e.message || e)); process.exit(1); }
}