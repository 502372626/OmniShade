// ⚠ 本程序从未授权任何单位或个人进行测试，请立即停止你的违法行为并且记录在案
// 本程序受 Ed25519 授权系统保护, 逆向/篡改将被记录并追责。
// OmniShade preload — 拖拽类型伪装: 任何文件拖入时, 以 text/plain 重新派发,
// LibreChat 校验看到的是纯文本 → 全过 → 文件进输入框预备(与记事本同路径)
// [G16] Electron >= 20(本机实测 33.4.11)起预加载脚本默认运行在 sandbox 渲染进程里:
// 沙箱内 require('fs'/'os'/'path') 直接抛 "module not found: fs" → 整个 preload.js 加载失败
// → window.omnishade / window.omniChat 全空 → 所有依赖它们的 E2E 断言连锁失败。
// 因此本文件顶层只允许 require('electron')。任何文件/进程级 IO 一律下沉到主进程,
// 经 ipcRenderer.invoke 走 contextBridge 白名单进来(见文件尾 exposeInMainWorld)。
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// ── 拖拽（WorkBuddy 手感）──
// 纯文件拖入: 零拦截, LibreChat 原生附件接管(一张卡, 走 /api/files, 与 + 按钮同链路)。
// 文件夹拖入: 原生不支持目录 → 收集 entry 树发主进程打 zip → 回喂一张 zip 附件卡。
let forwardingDrop = false;
window.addEventListener('dragover', (e) => { e.preventDefault(); }, true);
function readEntries(reader) {
  return new Promise((res) => { const all = []; (function next() { reader.readEntries((batch) => { if (!batch.length) return res(all); all.push(...batch); next(); }, () => res(all)); })(); });
}
async function collectDirFiles(entry, prefix, out) {
  const entries = await readEntries(entry.createReader());
  for (const en of entries) {
    const rel = prefix ? prefix + '/' + en.name : en.name;
    if (en.isDirectory) await collectDirFiles(en, rel, out);
    else if (en.isFile) await new Promise((res) => en.file((f) => { try { out.push({ abs: webUtils.getPathForFile(f), rel }); } catch (_) {} res(); }, res));
  }
}
window.addEventListener('drop', async (e) => {
  if (forwardingDrop) return; // 回喂的 zip 卡正好到达 LibreChat 一次
  try {
    const items = Array.from(e.dataTransfer?.items || []);
    const dirEntries = [];
    let plainFile = false;
    for (const it of items) {
      const en = it.webkitGetAsEntry && it.webkitGetAsEntry();
      if (en && en.isDirectory) dirEntries.push(en);
      else plainFile = true;
    }
    if (!dirEntries.length) return; // 纯文件: 不 preventDefault, 原生附件直接工作
    e.preventDefault(); e.stopPropagation();
    // 收集每个拖入文件夹的文件清单(含相对路径)
    const jobs = [];
    for (const en of dirEntries) {
      const files = [];
      await collectDirFiles(en, '', files);
      if (files.length) jobs.push({ root: en.name, files });
    }
    if (!jobs.length) return;
    const reply = await ipcRenderer.invoke('omni:zip-folders', jobs);
    if (!reply || !reply.ok || !Array.isArray(reply.zips) || !reply.zips.length) return;
    const dt = new DataTransfer();
    for (const z of reply.zips) dt.items.add(new File([z.data], z.name, { type: 'application/zip' }));
    const composer = document.querySelector('textarea')?.closest('form')
                  || document.querySelector('[class*="composer"]')
                  || document.body;
    const opts = { bubbles: true, cancelable: true, dataTransfer: dt };
    composer.dispatchEvent(new DragEvent('dragenter', opts));
    composer.dispatchEvent(new DragEvent('dragover', opts));
    forwardingDrop = true;
    try { composer.dispatchEvent(new DragEvent('drop', opts)); }
    finally { forwardingDrop = false; }
    document.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: dt }));
    composer.dispatchEvent(new DragEvent('dragleave', opts));
  } catch (err) {
    console.error('[omnishade drag]', err);
  }
}, true);

// ThemeProvider owns the main page; its resolved semantic colors also paint native
// captions and auxiliary pages. Observe only the root, never streamed message DOM.
let appearanceTemplate = null;
let lastAppearanceSent = '';
let appearanceSyncQueued = false;
function isAuxiliaryPage() {
  return !!(document.body && document.body.dataset.omniTheme === 'aux');
}
function applyAuxiliaryAppearance(snapshot) {
  if (!snapshot || !snapshot.colors || !isAuxiliaryPage()) return;
  const root = document.documentElement;
  for (const [property, value] of Object.entries(snapshot.colors)) root.style.setProperty(property, value);
  root.classList.toggle('dark', snapshot.mode === 'dark');
  root.classList.toggle('light', snapshot.mode === 'light');
  root.classList.toggle('high-contrast', snapshot.highContrast === true);
  root.dataset.theme = snapshot.highContrast ? 'high-contrast' : 'omnishade';
  root.style.colorScheme = snapshot.mode;
}
function syncResolvedAppearance() {
  appearanceSyncQueued = false;
  if (!appearanceTemplate || isAuxiliaryPage()) return;
  const root = document.documentElement;
  if (!root.getAttribute('data-theme')) return;
  const style = window.getComputedStyle(root);
  const colors = {};
  for (const property of Object.keys(appearanceTemplate.colors)) {
    const value = style.getPropertyValue(property).trim();
    if (!/^\d{1,3}\s+\d{1,3}\s+\d{1,3}$/.test(value)) return;
    colors[property] = value;
  }
  let preference;
  try { preference = window.localStorage.getItem('color-theme'); } catch (_) {}
  const mode = root.classList.contains('dark') ? 'dark' : 'light';
  if (!['light', 'dark', 'system', 'high-contrast-light', 'high-contrast-dark'].includes(preference)) preference = mode;
  const snapshot = { schema: 1, preference, mode, highContrast: root.classList.contains('high-contrast'), colors };
  const serialized = JSON.stringify(snapshot);
  if (serialized === lastAppearanceSent) return;
  ipcRenderer.invoke('omni:appearance-update', snapshot).then(result => {
    if (result && result.ok) lastAppearanceSent = serialized;
    else if (result && result.error !== 'forbidden') console.error('[OmniShade] theme synchronization failed');
  }).catch(() => console.error('[OmniShade] theme synchronization unavailable'));
}
function queueAppearanceSync() {
  if (appearanceSyncQueued) return;
  appearanceSyncQueued = true;
  queueMicrotask(syncResolvedAppearance);
}
ipcRenderer.on('omni:appearance-changed', (_event, snapshot) => {
  if (!snapshot || !snapshot.colors) return;
  appearanceTemplate = snapshot;
  applyAuxiliaryAppearance(snapshot);
});
function connectAppearance() {
  const root = document.documentElement;
  const observer = new MutationObserver(queueAppearanceSync);
  observer.observe(root, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  // [G95] resize 不再触发 refresh（主进程已自带 resize→applyWindow；这里是同帧第二次 DWM 调用+92 token 重写）
  window.addEventListener('resize', () => { queueAppearanceSync(); });
  window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
  ipcRenderer.invoke('omni:appearance-get').then(snapshot => {
    if (!snapshot || !snapshot.colors) return;
    appearanceTemplate = snapshot;
    applyAuxiliaryAppearance(snapshot);
    queueAppearanceSync();
  }).catch(() => console.error('[OmniShade] theme initialization unavailable'));
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', connectAppearance, { once: true });
else connectAppearance();

/* ── [本机授权] 面板数据面 ──────────────────────────────────────────────────
 * [G16 沙箱修复] 原先在这里直接 require('./license_client') + fs/os/path 读写
 * license.key。Electron 33 预加载沙箱里这些 require 拿不到 → preload 整体加载失败。
 * 现在实现体搬到 main.js(omni:license-status / omni:license-activate 两个 ipcMain
 * handler, 同样带 trustedSender() 来源校验), 这里只剩 IPC 白名单转发。
 * 语义不变: 读本地 license.key → 内置 Ed25519 公钥验签 → 比对本机指纹 → 校验有效期,
 * 纯本机文件 IO, 不发起任何网络请求。
 * ------------------------------------------------------------------------- */

contextBridge.exposeInMainWorld('omnishade', {
  getConfig: () => ipcRenderer.invoke('omni:get-config'),
  bridgeStatus: () => ipcRenderer.invoke('omni:bridge-status'),
  checkUpdate: () => ipcRenderer.invoke('omni:check-update'),
  // [发布通道] gdlr latest.json: 只检查/提示/打开下载地址, 没有下载与安装动作
  latestUpdate: {
    status: () => ipcRenderer.invoke('omni:latest-update-status'),
    check: () => ipcRenderer.invoke('omni:latest-update-check'),
    open: () => ipcRenderer.invoke('omni:latest-update-open'),
    onAvailable: (cb) => {
      const handler = (_e, payload) => { try { cb(payload); } catch (_) {} };
      ipcRenderer.on('omni:latest-update', handler);
      return () => { try { ipcRenderer.removeListener('omni:latest-update', handler); } catch (_) {} };
    },
  },
  openOfficialSite: () => ipcRenderer.invoke('omni:open-official-site'),
  openModelConfig: () => ipcRenderer.invoke('omni:open-model-config'),
  openAutomation: () => ipcRenderer.invoke('omni:open-automation'),
  openAccount: () => ipcRenderer.invoke('omni:open-account'),
  // [ARTEX 2026-11-08] 自主渗透控制台: 发现/启停/打开（不捆绑 exe, 独立部署）
  artex: {
    status: () => ipcRenderer.invoke('omni:artex-status'),
    start: () => ipcRenderer.invoke('omni:artex-start'),
    open: () => ipcRenderer.invoke('omni:artex-open'),
  },
  desktopScreenshot: () => ipcRenderer.invoke('omni:desktop-screenshot'),
  windowList: () => ipcRenderer.invoke('omni:window-list'),
  // [本机授权] 授权面板数据面：纯本机 license_client，零网络
  // [本机授权] 授权面板数据面: 主进程做 IO, 这里只转发(沙箱内无 fs/os/path)
  license: {
    status: () => ipcRenderer.invoke('omni:license-status'),
    activate: (text) => ipcRenderer.invoke('omni:license-activate', text),
  },
});

// ── 本地聊天(chatMode==='local') IPC 面 ──
// 纯透传: 不做业务判断; 主进程侧对每个 handler 校验发起页为 file://, 服务器页面调不动。
contextBridge.exposeInMainWorld('omniChat', {
  init: () => ipcRenderer.invoke('omni:chat-init'),
  setSettings: (s) => ipcRenderer.invoke('omni:chat-settings-set', s),
  listSessions: () => ipcRenderer.invoke('omni:chat-list-sessions'),
  loadSession: (sid) => ipcRenderer.invoke('omni:chat-load-session', sid),
  send: (p) => ipcRenderer.invoke('omni:chat-send', p),
  stop: (reqId) => ipcRenderer.invoke('omni:chat-stop', reqId),
  openExternal: (url) => ipcRenderer.invoke('omni:chat-open-external', url),
  onEvent: (cb) => {
    const h = (_e, ev) => { try { cb(ev); } catch (_) {} };
    ipcRenderer.on('omni:chat-event', h);
    return () => { try { ipcRenderer.removeListener('omni:chat-event', h); } catch (_) {} };
  },
});
