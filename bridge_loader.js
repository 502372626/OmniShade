'use strict';
const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const bytenode = require('./bytenode-lib');

const SALT = Buffer.from('omnishade-hk-2026', 'utf8');
const INFO = Buffer.from('enc', 'utf8');

function decodeKey(value) {
  const text = String(value || '').trim();
  const raw = Buffer.from(text, 'base64');
  const ok = /^[A-Za-z0-9+/]+={0,2}$/.test(text) && text.length % 4 === 0 && raw.length === 32 && raw.toString('base64') === text;
  if (!ok) { raw.fill(0); throw new Error('runtime bridge key unavailable'); }
  return raw;
}
function decryptEncryptedBytecode(envelope, keyB64) {
  if (!Buffer.isBuffer(envelope) || envelope.length <= 28) throw new Error('invalid encrypted bridge envelope');
  const assetKey = decodeKey(keyB64);
  const cipherKey = Buffer.from(crypto.hkdfSync('sha256', assetKey, SALT, INFO, 32));
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', cipherKey, envelope.subarray(0, 12));
    decipher.setAuthTag(envelope.subarray(12, 28));
    return Buffer.concat([decipher.update(envelope.subarray(28)), decipher.final()]);
  } finally {
    assetKey.fill(0);
    cipherKey.fill(0);
  }
}
function loadModuleFromBytecode(bytecode, filename) {
  const wrapper = bytenode.runBytecode(bytecode);
  if (typeof wrapper !== 'function') throw new Error('bridge bytecode did not yield a CommonJS wrapper');
  const mod = new Module(filename, module.parent);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const localRequire = mod.require.bind(mod);
  localRequire.resolve = require.resolve;
  localRequire.main = require.main;
  localRequire.extensions = Module._extensions;
  localRequire.cache = Module._cache;
  wrapper.call(mod.exports, mod.exports, localRequire, mod, filename, path.dirname(filename), process, global);
  mod.loaded = true;
  return mod.exports;
}
function start() {
  const encryptedPath = path.join(__dirname, 'bridge.jsc.enc');
  const envelope = fs.readFileSync(encryptedPath);
  const keyText = process.env.OMNI_RUNTIME_KEY_B64 || '';
  delete process.env.OMNI_RUNTIME_KEY_B64;
  const bytecode = decryptEncryptedBytecode(envelope, keyText);
  try {
    const bridge = loadModuleFromBytecode(bytecode, path.join(__dirname, 'bridge.jsc'));
    if (!bridge || typeof bridge.startBridge !== 'function') throw new Error('encrypted bridge export missing');
    const port = parseInt(process.env.OMNI_BRIDGE_PORT || '9431', 10);
    bridge.startBridge(port);
  } finally {
    bytecode.fill(0);
  }
}

module.exports = { decodeKey, decryptEncryptedBytecode, loadModuleFromBytecode };
if (require.main === module) {
  try { start(); }
  catch (error) { console.error('[bridge-loader] ' + String(error && error.message || error)); process.exit(1); }
}
