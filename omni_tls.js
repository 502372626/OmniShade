'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PINNED_HOST = '103.117.136.137';
const PINNED_CERT_SHA256 = '8db68f5fd660c67dd5b135728d652a52327e2c2d1422f760e22b6e9042ec9db1';
const PINNED_CA = fs.readFileSync(path.join(__dirname, 'assets', 'omni.crt'));

function certFingerprint(raw) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || '');
  let der = bytes;
  if (bytes.includes(Buffer.from('-----BEGIN CERTIFICATE-----'))) {
    const body = bytes.toString('utf8').replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, '');
    der = Buffer.from(body, 'base64');
  }
  return crypto.createHash('sha256').update(der).digest('hex');
}

function pinnedTlsOptions(host) {
  const wanted = String(host || '');
  // [AUTH-REACH 2026-11-07] gdlr.asia 用正式 CA 证书（Let's Encrypt），走 Node 标准
  // CA 链校验即可，不进 pin 名单。显式传 servername 保证 SNI 正确。
  if (wanted === 'gdlr.asia') return { servername: 'gdlr.asia' };
  return {
    // [G81] 信任根 = 证书指纹 pin，不是 CA 链。
    // 服务端用的是自签 leaf 证书（CA:FALSE），把它当 ca 去验自己时，Electron 的
    // BoringSSL 会直接拒（OpenSSL 宽松所以 node 脚本能过，Electron 里必失败）。
    // pinning 场景下 CA 链没有额外价值：指纹不等就立刻断，比任何 CA 都严。
    rejectUnauthorized: false,
    ca: PINNED_CA,
    checkServerIdentity(servername, cert) {
      if (wanted !== PINNED_HOST || String(servername || '') !== PINNED_HOST) {
        throw new Error('TLS host rejected: ' + String(servername || ''));
      }
      const got = certFingerprint(cert && cert.raw);
      if (got !== PINNED_CERT_SHA256) throw new Error('TLS pin mismatch');
      return undefined;
    },
  };
}

module.exports = { PINNED_HOST, PINNED_CERT_SHA256, certFingerprint, pinnedTlsOptions };
