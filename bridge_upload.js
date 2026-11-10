'use strict';
// bridge_upload.js — bounded, streamed main-process upload client for the local bridge.
const fs = require('fs');
const path = require('path');
const http = require('http');

function uploadFileToBridge(opts) {
  const o = opts || {};
  const port = Number(o.port || 9431);
  const filePath = String(o.filePath || '');
  const token = String(o.token || '');
  const timeoutMs = Math.max(1000, Number(o.timeoutMs || 120000));
  if (!filePath || !token) return Promise.reject(new Error('bridge upload unavailable'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    let st;
    try { st = fs.statSync(filePath); } catch (e) { return reject(e); }
    if (!st.isFile()) return reject(new Error('not a regular file'));
    const req = http.request({
      host: '127.0.0.1', port, path: '/upload', method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'x-filename': encodeURIComponent(path.basename(filePath)),
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(st.size),
      },
    }, (res) => {
      const chunks = []; let total = 0;
      res.on('data', (c) => { total += c.length; if (total <= 256 * 1024) chunks.push(c); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null; try { body = JSON.parse(text); } catch (_) {}
        if (res.statusCode !== 200 || !body || !body.ok) {
          return finish(reject, new Error('bridge upload HTTP ' + res.statusCode + ': ' + String(body && body.error || text || 'failed').slice(0, 180)));
        }
        finish(resolve, body);
      });
    });
    const timer = setTimeout(() => {
      try { req.destroy(new Error('bridge upload timeout')); } catch (_) {}
      finish(reject, new Error('bridge upload timeout'));
    }, timeoutMs);
    req.on('error', (e) => finish(reject, e));
    const input = fs.createReadStream(filePath);
    input.on('error', (e) => { try { req.destroy(e); } catch (_) {} finish(reject, e); });
    input.pipe(req);
  });
}

module.exports = { uploadFileToBridge };
