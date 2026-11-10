'use strict';
// OmniShade License 校验客户端 (纯本地, 不连任何服务端)
// 主路径: 读本地 license.key -> 内置 Ed25519 公钥验签 -> 比对本机指纹 -> 校验过期
// 返回固定结构: { valid: boolean, expires: number, tier: string|null, reason: string }
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 复用 gen_license 的 canonical/fingerprint 逻辑, 生成端与校验端严格一致, 避免重复实现漂移
const gen = require('./local_auth/gen_license');

// ============================================================
// 内置 Ed25519 公钥 (SPKI PEM), 与 local_auth/license_ed25519.pub 完全一致
// "内置" 意味着校验不再依赖任何外部文件/服务端, 公钥直接编译进模块
const LICENSE_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEARzh17DpS4Id6WNC36jL7ihX0IxpPYXnoT+Vfe6ptKgE=
-----END PUBLIC KEY-----
`;
const LICENSE_PUBKEY = crypto.createPublicKey(LICENSE_PUBKEY_PEM);

// license.key 默认位置: 与 gen_license 同目录 (desktop/local_auth/license.key)
// [G37] 解析顺序: 用户安装后激活的 %APPDATA%\omnishade\license.key -> 出厂预置 __dirname/local_auth/license.key
// 理由: 出厂预置那份绑的是构建机(或 ANY); 用户机器激活后的那份才是"本机"授权，必须优先。
function resolveLicensePath() {
  try {
    const base = process.env.APPDATA
      || (process.platform === 'darwin'
        ? path.join(require('os').homedir(), 'Library', 'Application Support')
        : require('os').homedir());
    const userPath = path.join(base, 'omnishade', 'license.key');
    if (require('fs').existsSync(userPath)) return userPath;
  } catch (_) {}
  return path.join(__dirname, 'local_auth', 'license.key');
}
const DEFAULT_LICENSE_PATH = resolveLicensePath();
const LOCAL_LICENSE_SCHEMA = gen.SCHEMA; // 'omnishade-license-v1'

// 兼容旧 account session 验签用的公钥 (保留, 纯本地, 无网络)
const ACCOUNT_PUBKEY = 'mgY/OWeaBz9PfYr2a4x8F2rIaeZC6fVR050R5F0oImk=';
function publicKeyObject() {
  const raw = Buffer.from(ACCOUNT_PUBKEY, 'base64');
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  return crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

// ------------------------------------------------------------
// 本地 license.key 读取 + 解析
function readLicenseKey(p) {
  const file = p || DEFAULT_LICENSE_PATH;
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text);
}

// 本机实时指纹 v2 (与 license.key 签发时同一套采集逻辑)
function currentFingerprint() {
  return gen.collectFingerprint();
}
// 本机分量摘要 (软指纹), 用于 >=2/3 模糊匹配
function currentFingerprintParts() {
  return gen.componentsToParts(gen.collectFingerprintComponents());
}
// 本机 v1 老算法指纹: 迁移期兜底用, 老 license 在尚未重签前仍可验过
function currentFingerprintLegacy() {
  return gen.collectFingerprintLegacy();
}

// ------------------------------------------------------------
// 指纹比对: 三级判定, 顺序即短路顺序
//   ① exact  : 硬指纹 v2 严格相等
//   ② fuzzy  : 核心分量 disk/uuid/mac >= 2/3 一致 (需 license 带签名保护的 fp_parts)
//   ③ legacy : 与 v1 老算法采集值相等 (迁移期兼容, 未重签也能过)
// opts.fingerprint 被显式传入时代表"模拟另一台机器", 只走 ① 严格判定, 不再走模糊/兜底
// 返回 { mode, score, matched, missing, pass }
function matchFingerprint(lic, opts) {
  opts = opts || {};
  // [G37 · 出厂态授权] fingerprint === 'ANY' -> 任意机器放行。
  // 用途: 出厂预置的 license.key 不能绑构建机指纹(否则用户装机即指纹不匹配、判定未授权)。
  // 机器绑定能力仍完整保留: 管理员用 gen_license.js 逐台签发时 fingerprint 写真实指纹,
  // 走下面的 exact / fuzzy 分支; 'ANY' 只用于"出厂即用 + 首次运行落本机"这一条路径。
  if (lic && lic.fingerprint === 'ANY') {
    return { mode: 'any-machine', score: 1, matched: gen.CORE_KEYS.slice(), missing: [], pass: true };
  }
  const localFp = (opts.fingerprint !== undefined) ? opts.fingerprint : currentFingerprint();
  if (lic.fingerprint === localFp) {
    return { mode: 'exact', score: 1, matched: gen.CORE_KEYS.slice(), missing: [], pass: true };
  }
  if (opts.fingerprint !== undefined) {
    // 调用方强制指定了机器标识 -> 严格判定, 防止"改指纹还能靠模糊匹配蒙过"
    return { mode: 'strict-mismatch', score: 0, matched: [], missing: gen.CORE_KEYS.slice(), pass: false };
  }
  // ② 模糊匹配: 仅当 license 带签名的 fp_parts 时启用 (无 fp_parts = 老 license)
  if (lic.fp_v === gen.FP_VERSION && lic.fp_parts && typeof lic.fp_parts === 'object') {
    const localParts = opts.parts || currentFingerprintParts();
    const cmp = gen.compareParts(localParts, lic.fp_parts, { minScore: opts.minScore });
    return {
      mode: cmp.pass ? 'fuzzy' : 'fuzzy-mismatch',
      score: cmp.score, matched: cmp.matched, missing: cmp.missing,
      platMatch: cmp.platMatch, emptyLocal: cmp.emptyLocal, pass: cmp.pass,
    };
  }
  // ③ 迁移兜底: v1 老算法
  const legacyFp = (opts.legacyFingerprint !== undefined) ? opts.legacyFingerprint : currentFingerprintLegacy();
  if (lic.fingerprint === legacyFp) {
    return { mode: 'legacy', score: 1, matched: ['legacy'], missing: [], pass: true };
  }
  return { mode: 'mismatch', score: 0, matched: [], missing: gen.CORE_KEYS.slice(), pass: false };
}

// license 里没有 email 字段时(本机签发)用固定占位, 保证 runtime grant 结构完整
const LOCAL_LICENSE_EMAIL = 'local@omnishade';
function emailOf(lic) {
  const e = lic && typeof lic.email === 'string' ? lic.email.trim() : '';
  return e ? e.toLowerCase() : LOCAL_LICENSE_EMAIL;
}

// 资产密钥规范化: 必须是 32 字节的规范 base64, 与 bridge_loader.js decodeKey 同口径; 否则视为无
function normalizeAssetKey(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  try {
    const raw = Buffer.from(text, 'base64');
    const ok = /^[A-Za-z0-9+/]+={0,2}$/.test(text) && text.length % 4 === 0
      && raw.length === 32 && raw.toString('base64') === text;
    raw.fill(0);
    return ok ? text : null;
  } catch (_) {
    return null;
  }
}

// ------------------------------------------------------------
// 本机授权 → runtime grant: 验签通过后把 license 里封的资产密钥拼成 store 能接受的结构
// 返回 { ok, runtime_key_b64, email, expires_at, reason }; 失败一律 ok:false, 不抛异常
function localRuntimeGrant(opts) {
  const lic = verifyLicense(opts);
  if (!lic || lic.valid !== true) {
    return { ok: false, runtime_key_b64: null, email: null, expires_at: 0, reason: (lic && lic.reason) || 'invalid' };
  }
  if (!lic.asset_key) {
    return { ok: false, runtime_key_b64: null, email: lic.email, expires_at: lic.expires, reason: 'no-asset-key' };
  }
  return {
    ok: true,
    runtime_key_b64: lic.asset_key,
    email: lic.email || LOCAL_LICENSE_EMAIL,
    expires_at: Number(lic.expires || 0),
    tier: lic.tier,
    reason: 'ok',
  };
}

// ------------------------------------------------------------
// 主校验: 读本地 license.key, 内置公钥验签 + 指纹比对 + 过期校验
// opts:
//   licensePath : 可选, 覆盖 license.key 路径
//   fingerprint : 可选, 覆盖本机指纹 (测试/换机模拟用)
// 返回固定结构: { valid, expires, tier, reason }
function verifyLicense(opts) {
  opts = opts || {};
  try {
    const lic = readLicenseKey(opts.licensePath);
    if (!lic || typeof lic !== 'object') {
      return { valid: false, expires: 0, tier: null, reason: 'bad-license' };
    }
    if (lic.schema !== LOCAL_LICENSE_SCHEMA) {
      return { valid: false, expires: 0, tier: null, reason: 'schema-mismatch' };
    }
    if (typeof lic.sig !== 'string' || !lic.sig) {
      return { valid: false, expires: 0, tier: null, reason: 'no-signature' };
    }
    // ① Ed25519 验签: canonical payload 固定字段顺序, 必须与生成端一致
    const canonical = gen.canonicalPayload(lic);
    const sigOk = crypto.verify(
      null,
      Buffer.from(canonical, 'utf8'),
      LICENSE_PUBKEY,
      Buffer.from(lic.sig, 'base64'),
    );
    if (!sigOk) {
      return { valid: false, expires: 0, tier: null, reason: 'bad-signature' };
    }
    // ② 过期校验: exp 为 epoch 秒, 必须晚于当前
    const now = Math.floor(Date.now() / 1000);
    if (typeof lic.exp !== 'number' || lic.exp <= now) {
      return { valid: false, expires: lic.exp || 0, tier: lic.tier || null, reason: 'expired' };
    }
    // ③ 机器指纹比对 (v2: 精确 -> 分量模糊 >=2/3 -> v1 老算法兜底)
    const m = matchFingerprint(lic, opts);
    if (!m.pass) {
      return {
        valid: false, expires: lic.exp, tier: lic.tier, email: emailOf(lic), asset_key: null,
        score: m.score, match_mode: m.mode, missing: m.missing,
        reason: 'fingerprint-mismatch',
      };
    }
    // ④ 资产密钥: 有则回传(32B 规范 base64), 供 runtime key store 落盘后解 bridge.jsc.enc
    //    缺失(老 license)不判失败, 但 asset_key=null, 上层据此回落到远端授权路径
    return {
      valid: true,
      expires: lic.exp,
      tier: lic.tier || null,
      fingerprint: lic.fingerprint,
      score: m.score,                 // 相似度: 命中核心分量 / 3
      match_mode: m.mode,             // exact | fuzzy | legacy
      matched: m.matched,
      missing: m.missing,
      stale_binding: m.mode === 'legacy' ? 'yes' : 'no', // legacy = 靠 v1 兜底过的, 建议重签
      email: emailOf(lic),
      asset_key: normalizeAssetKey(lic.asset_key),
      reason: 'ok',
    };
  } catch (e) {
    return { valid: false, expires: 0, tier: null, reason: 'read-error' };
  }
}

// 激活态检查: 语义等同 verifyLicense
function checkActivation(opts) {
  return verifyLicense(opts);
}

// ============================================================
// 以下为 兼容旧导出 (纯本地, 无网络), 保留原接口名与调用约定
function canonicalWithoutSignature(data) {
  const body = Object.assign({}, data || {});
  const signature = body.sig;
  delete body.sig;
  const sort = (value) => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === 'object') {
      const out = {};
      for (const name of Object.keys(value).sort()) out[name] = sort(value[name]);
      return out;
    }
    return value;
  };
  const canonical = JSON.stringify(sort(body)).replace(/[ -￿]/g, (ch) =>
    '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
  return { signature, canonical };
}

function verifyEnvelope(data) {
  try {
    if (!data || typeof data.sig !== 'string' || !data.sig) return false;
    const signed = canonicalWithoutSignature(data);
    return crypto.verify(
      null,
      Buffer.from(signed.canonical, 'utf8'),
      publicKeyObject(),
      Buffer.from(signed.signature, 'base64'),
    );
  } catch (_) {
    return false;
  }
}

function verifySessionResponse(data) {
  if (!verifyEnvelope(data)) return { ok: false, reason: 'bad-signature' };
  if (data.ok !== true || data.status !== 'ok') {
    return { ok: false, reason: String(data.status || data.error || 'denied') };
  }
  if (typeof data.email !== 'string' || typeof data.expires_at !== 'number') {
    return { ok: false, reason: 'bad-response' };
  }
  return { ok: true, email: data.email, expires_at: data.expires_at };
}

// 旧的 file-based 本地校验入口 (读 pubkey 文件), 保留以向后兼容
const DEFAULT_LOCAL_PUBKEY = path.join(__dirname, 'local_auth', 'license_ed25519.pub');
function verifyLocalLicense(data, opts) {
  opts = opts || {};
  try {
    if (!data || typeof data !== 'object') return { ok: false, reason: 'bad-input' };
    if (data.schema !== LOCAL_LICENSE_SCHEMA) return { ok: false, reason: 'schema-mismatch' };
    if (typeof data.sig !== 'string' || !data.sig) return { ok: false, reason: 'no-signature' };
    const pubKeyPath = opts.pubKeyPath || DEFAULT_LOCAL_PUBKEY;
    if (!fs.existsSync(pubKeyPath)) return { ok: false, reason: 'no-pubkey' };
    const publicKey = crypto.createPublicKey(fs.readFileSync(pubKeyPath, 'utf8'));
    const canonical = gen.canonicalPayload(data);
    const sigOk = crypto.verify(null, Buffer.from(canonical, 'utf8'), publicKey, Buffer.from(data.sig, 'base64'));
    if (!sigOk) return { ok: false, reason: 'bad-signature' };
    const now = Math.floor(Date.now() / 1000);
    if (typeof data.exp !== 'number' || data.exp <= now) return { ok: false, reason: 'expired' };
    const m = matchFingerprint(data, opts);
    if (!m.pass) return { ok: false, reason: 'fingerprint-mismatch', score: m.score, match_mode: m.mode };
    return { ok: true, fingerprint: data.fingerprint, exp: data.exp, tier: data.tier, score: m.score, match_mode: m.mode };
  } catch (e) {
    return { ok: false, reason: 'error:' + (e && e.message) };
  }
}

// ============================================================
// 导出
module.exports = {
  // —— 新增主路径 (纯本地) ——
  LICENSE_PUBKEY_PEM,
  DEFAULT_LICENSE_PATH,
  LOCAL_LICENSE_SCHEMA,
  readLicenseKey,
  currentFingerprint,
  verifyLicense,
  checkActivation,
  localRuntimeGrant,
  // —— 兼容旧导出 (纯本地, 无网络) ——
  ACCOUNT_PUBKEY,
  canonicalWithoutSignature,
  verifyEnvelope,
  verifySessionResponse,
  verifyLocalLicense,
  DEFAULT_LOCAL_PUBKEY,
};
