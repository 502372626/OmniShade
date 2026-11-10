'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function defaultPath() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'omnishade', 'runtime_key.json');
}
function safeStorage() {
  const electron = require('electron');
  if (!electron.safeStorage || !electron.safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage unavailable');
  }
  return electron.safeStorage;
}
function atomicWrite(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, target);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
  }
}
function validateKey(value) {
  const text = String(value || '').trim();
  const raw = Buffer.from(text, 'base64');
  const ok = /^[A-Za-z0-9+/]+={0,2}$/.test(text) && text.length % 4 === 0 && raw.length === 32 && raw.toString('base64') === text;
  raw.fill(0);
  if (!ok) throw new Error('runtime key must be canonical 32-byte base64');
  return text;
}
function store(grant, options = {}) {
  const key = validateKey(grant && grant.runtime_key_b64);
  const storage = options.safeStorage || safeStorage();
  const encrypted = storage.encryptString(key);
  // 套餐与配额：明文存（不是秘密），供授权面板展示 + 排查"这号还能用多少"。
  // prev 必须从「同一个落点」读——早先写成 `options.path ? null : loadSafe()`，
  // 结果是自定义 path 时永远读不到上次值，缺字段的一次 store 就把配额清零（单测抓到）。
  const targetPath = options.path || defaultPath();
  const prev = loadSafe({ path: targetPath });
  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  }
  const doc = {
    v: 1,
    alg: 'electron-safeStorage',
    email: String(grant.email || '').toLowerCase(),
    expires_at: Number(grant.expires_at || 0),
    // 套餐能力范围：'all' 全量工具 / 'kb' 仅知识库。
    // 不是秘密，明文存即可；用于主进程 fork bridge 时下发 OMNI_TOOL_SCOPE。
    tool_scope: (String(grant.toolScope || 'all').toLowerCase() === 'kb') ? 'kb' : 'all',
    // ---- 商业套餐快照（授权面板「套餐与用量」卡片数据源）----
    sku: String(grant.sku || (prev && prev.sku) || ''),
    sku_name: String(grant.skuName || grant.sku_name || (prev && prev.sku_name) || ''),
    soft: (typeof grant.soft === 'boolean') ? grant.soft : (prev ? prev.soft : null),
    kb: (typeof grant.kb === 'boolean') ? grant.kb : (prev ? prev.kb : null),
    kb_daily: num(grant.kb_daily, prev ? prev.kb_daily : 0),
    kb_used: num(grant.kb_used, prev ? prev.kb_used : 0),
    kb_remain: num(grant.kb_remain, prev ? prev.kb_remain : 0),
    issued_at: Number(grant.issued_at || (prev && prev.issued_at) || 0),
    ciphertext: Buffer.from(encrypted).toString('base64'),
  };
  atomicWrite(targetPath, JSON.stringify(doc));
  return { ok: true, email: doc.email, expires_at: doc.expires_at };
}
function loadSafe(options = {}) {
  // 只读明文段做"上次值"参考；解密失败返回 null，绝不因此让 store 失败。
  try {
    const doc = JSON.parse(fs.readFileSync(options.path || defaultPath(), 'utf8'));
    if (!doc || doc.v !== 1 || !doc.ciphertext) return null;
    // 与 load() 一致：过期即失效，不允许明文段绕过过期判断。
    const expSafe = Number(doc.expires_at || 0);
    if (expSafe && expSafe <= Math.floor(Date.now() / 1000)) return null;
    return {
      sku: String(doc.sku || ''), sku_name: String(doc.sku_name || ''),
      soft: (typeof doc.soft === 'boolean') ? doc.soft : null,
      kb: (typeof doc.kb === 'boolean') ? doc.kb : null,
      kb_daily: Number(doc.kb_daily || 0), kb_used: Number(doc.kb_used || 0),
      kb_remain: Number(doc.kb_remain || 0), issued_at: Number(doc.issued_at || 0),
    };
  } catch (_) { return null; }
}
function load(options = {}) {
  try {
    const doc = JSON.parse(fs.readFileSync(options.path || defaultPath(), 'utf8'));
    if (!doc || doc.v !== 1 || doc.alg !== 'electron-safeStorage' || !doc.ciphertext) return null;
    // 过期即失效：缓存的 runtime grant 只在 expires_at 之前可用。
    // 过期后必须返回 null，迫使调用方重新走 /runtime_grant（服务端会拒绝过期授权），
    // 否则过期卡密仍能靠本地缓存继续用——这就是「授权过期了居然还能用」的根因。
    const expiresAt = Number(doc.expires_at || 0);
    if (expiresAt && expiresAt <= Math.floor(Date.now() / 1000)) return null;
    const storage = options.safeStorage || safeStorage();
    const key = validateKey(storage.decryptString(Buffer.from(doc.ciphertext, 'base64')));
    return { keyB64: key, email: String(doc.email || ''),
             expires_at: expiresAt,
             toolScope: (String(doc.tool_scope || 'all').toLowerCase() === 'kb') ? 'kb' : 'all',
             // 套餐与配额快照（授权面板展示用）。旧版本文件没有这些键，全部回落成中性值。
             sku: String(doc.sku || ''),
             skuName: String(doc.sku_name || ''),
             soft: (typeof doc.soft === 'boolean') ? doc.soft : null,
             kb: (typeof doc.kb === 'boolean') ? doc.kb : null,
             kb_daily: Number(doc.kb_daily || 0),
             kb_used: Number(doc.kb_used || 0),
             kb_remain: Number(doc.kb_remain || 0),
             issued_at: Number(doc.issued_at || 0) };
  } catch (_) { return null; }
}
function clear(options = {}) {
  try { fs.rmSync(options.path || defaultPath(), { force: true }); } catch (_) {}
}
module.exports = { store, load, clear, validateKey, defaultPath };
