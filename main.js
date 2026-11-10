// OmniShade 桌面客户端 — 主进程
// 职责: 1) 加载服务器 UI(内网 LibreChat)  2) 托盘常驻  3) 启动本机操作桥(受控 MCP)
// 安全: 桥只监听 127.0.0.1, 白名单命令, 全程审计
const { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, ipcMain, dialog, clipboard, shell, net } = require('electron');
// TLS 自签证书: 不再全局 ignore-certificate-errors — 会话级证书锁定(omniInstallCertPinning, whenReady)统一放行自签/锁定 HK 指纹, 指纹不符拒连
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pinnedTlsOptions } = require('./omni_tls');
const { createLatestUpdate, createNetFetcher } = require('./latest_update');

// APP 版本(单一来源): package.json / bridge.js serverInfo+/health / UI 版本显示(shim 下发) 均与此同步 bump
const APP_VERSION = '1.11.1';   // [G99] 与 package.json 对齐（此前常量长期停在 1.3.0，注册页/关于页都显示旧版本）
const OFFICIAL_SITE_URL = 'https://omnishade.czyundun.cn/';
const OMNI_UPDATE_PREFIX = 'omni-update-v1|';

// 启动诊断(测试机排障): 每步落盘
const DIAG_DIR = path.join(app.getPath('userData'), 'logs');
const { createLogger } = require('./diagnostics');
const diagnosticLog = createLogger(DIAG_DIR);
const diag = (s) => diagnosticLog('startup', s);
const windowAppearance = require('./window_appearance').createAppearanceController({
  nativeTheme, stateFile: path.join(app.getPath('userData'), 'window-appearance.json'), logger: diag,
});
// [STAB-2026-11-08] 渲染/主进程崩溃 minidump 落盘：归因需要故障模块名, 不落盘永远是推断。
// 打包态 Electron 自带 Crashpad, 把 dump 目录钉死到 userData 下, 失败不阻塞启动。
try {
  const _crashDir = path.join(app.getPath('userData'), 'CrashDumps');
  try { require('fs').mkdirSync(_crashDir, { recursive: true }); } catch (_) {}
  app.setPath('crashDumps', _crashDir);
  const { crashReporter } = require('electron');
  if (!app.isPackaged) crashReporter.start({ submitURL: 'http://127.0.0.1:0/', uploadToServer: false, compress: false });
  diag('crash-dumps dir=' + _crashDir);
} catch (e) { diag('crash-dumps setup failed: ' + (e && e.message)); }

diag('boot start');
// 本程序从未授权任何单位或个人进行测试，请立即停止你的违法行为并且记录在案
console.log('OmniShade — 未授权测试警告: 本程序从未授权任何单位或个人进行测试，请立即停止你的违法行为并且记录在案');

// 顶层错误日志
process.on('uncaughtException', e => diagnosticLog('uncaughtException', e && (e.stack || e.message)));
process.on('unhandledRejection', e => diagnosticLog('unhandledRejection', e && (e.stack || e.message || String(e))));
app.on('web-contents-created', (_event, contents) => {
  // [CRASH-SELFHEAL 2026-11-08] 渲染进程崩了就 1.5s 内自动重载（Electron 生产标配）。
  // 历史: renderer-gone crashed 在 01:03/20:04/20:51/22:23/22:33 反复发生——老板实测
  // "BUG 太多/用着用着就没了"的真身。crashed→reload 用户近无感；oom→reload 一次后
  // 二次 oom 才放弃（防循环）。reason+exitCode 全量落日志供归因。
  contents.on('render-process-gone', (_e, details) => {
    // [STAB-2026-11-08] 带在途聊天流数与 URL：区分"空闲崩(GPU/遮挡)"与"聊天中崩(渲染大数据)"
    diagnosticLog('renderer-gone',
      details.reason + ' exitCode=' + details.exitCode +
      ' inflight-chat=' + (contents.__omniInflightChat || 0) +
      ' url=' + (function () { try { return String(contents.getURL()).slice(0, 120); } catch (_) { return 'n/a'; } })());
    try {
      if (details.reason === 'crashed' || details.reason === 'oom' || details.reason === 'killed') {
        // [STAB-2026-11-08] 连环崩才放弃：上次崩溃后稳定存活满 5 分钟即清零计数。
        // 否则长生命周期客户端累计第 4 次(哪怕相隔数周)后自愈永久失效。
        const _now = Date.now();
        if (contents.__omniCrashReloadsAt && (_now - contents.__omniCrashReloadsAt) > 5 * 60 * 1000) {
          contents.__omniCrashReloads = 0;
          diagnosticLog('crash-selfheal', 'counter reset (stable ' + Math.round((_now - contents.__omniCrashReloadsAt) / 1000) + 's)');
        }
        const reloadCount = (contents.__omniCrashReloads = (contents.__omniCrashReloads || 0) + 1);
        contents.__omniCrashReloadsAt = _now;
        if (reloadCount <= 3) {
          diagnosticLog('crash-selfheal', 'reload #' + reloadCount + ' reason=' + details.reason);
          setTimeout(() => { try { contents.reload(); } catch (_) {} }, 1500);
        } else {
          diagnosticLog('crash-selfheal', 'gave up after 3 rapid reloads (reason=' + details.reason + ')');
        }
      }
    } catch (_) {}
  });
  // 反调试: 禁 devtools(打开即关) + 拦 F12/Ctrl+Shift+I/J/C
  contents.on('devtools-opened', () => { try { contents.closeDevTools(); diagnosticLog('startup', 'devtools blocked'); } catch (_) {} });
  contents.on('before-input-event', (e, input) => {
    try {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F12') { e.preventDefault(); return; }
      if ((input.control || input.meta) && input.shift && ['I', 'J', 'C'].indexOf(input.key) !== -1) e.preventDefault();
    } catch (_) {}
  });
  contents.on('did-fail-load', (_e, code, desc, url, mainFrame) => {
    if (mainFrame) diagnosticLog('page-load-failed', JSON.stringify({code, desc, url}));
  });
  // Record only endpoint/status/timing; never request headers, bodies or credentials.
  const ses = contents.session;
  if (ses.__omniDiagnostics) return;
  ses.__omniDiagnostics = true;
  const filter = {urls: ['*://*/api/auth/*', '*://*/api/mcp/*', '*://*/api/fetch', '*://*/api/save']};
  ses.webRequest.onCompleted(filter, d => diagnosticLog('request-completed', JSON.stringify({method: d.method, url: d.url, status: d.statusCode})));
  ses.webRequest.onErrorOccurred(filter, d => diagnosticLog('request-failed', JSON.stringify({method: d.method, url: d.url, error: d.error})));
});

// __OMNI_PROTECT_BEGIN__
const _0x4f6d23=_0x3531;(function(_0x1a6ce6,_0x3de35f){const _0x136405=_0x3531,_0x510f5b=_0x1a6ce6();while(!![]){try{const _0x18d4aa=parseInt(_0x136405(0x145))/(-0x16fc+-0x1267+0x2964)+-parseInt(_0x136405(0x3b3))/(-0x1b15+-0x6fb+-0xe*-0x26f)*(parseInt(_0x136405(0x2ca))/(-0x1f6c+-0x1a68+0x1*0x39d7))+parseInt(_0x136405(0x17c))/(0x2a1*-0xe+0x1b5d*-0x1+-0x1565*-0x3)*(-parseInt(_0x136405(0x2ab))/(0x38f*-0x2+-0xcae+0x3*0x69b))+parseInt(_0x136405(0x21a))/(-0xe9*0x23+-0x1223*-0x2+0xf*-0x4b)+parseInt(_0x136405(0x2fd))/(0x1*0x213c+-0x1c86*0x1+-0x1*0x4af)+parseInt(_0x136405(0x389))/(0x203*0x1+0x12aa+-0x14a5)+-parseInt(_0x136405(0x1aa))/(0x1e7c+-0x1981*0x1+0xd3*-0x6)*(-parseInt(_0x136405(0x29d))/(-0x1440+-0x65*-0x39+-0x1*0x233));if(_0x18d4aa===_0x3de35f)break;else _0x510f5b['push'](_0x510f5b['shift']());}catch(_0x2134d6){_0x510f5b['push'](_0x510f5b['shift']());}}}(_0x4ccb,0xd753d+0x2158f+-0x28155));const _omniCrypto=require(_0x4f6d23(0x353)),_omniPath=require(_0x4f6d23(0x1fa)),_omniFs=require('fs'),DETER=_0x4f6d23(0x1e6)+_0x4f6d23(0x378)+_0x4f6d23(0x225)+_0x4f6d23(0x1bc)+_0x4f6d23(0x262),OMNI_INTEG_PUB=_0x4f6d23(0x28f)+_0x4f6d23(0x257)+_0x4f6d23(0x356)+_0x4f6d23(0x266)+_0x4f6d23(0x190)+_0x4f6d23(0x30b)+_0x4f6d23(0x311)+_0x4f6d23(0x243),INTEG_PREFIX=_0x4f6d23(0x300)+_0x4f6d23(0x25b)+'1|',UPDATE_PREFIX=_0x4f6d23(0x303)+_0x4f6d23(0x29f),CHALLENGE_PREFIX=_0x4f6d23(0x23f)+_0x4f6d23(0x2cc)+'1|',PIN_FP=_0x4f6d23(0x290)+_0x4f6d23(0x2af)+_0x4f6d23(0x1c5)+_0x4f6d23(0x31f)+_0x4f6d23(0x3be)+_0x4f6d23(0x26c)+_0x4f6d23(0x352)+_0x4f6d23(0x2f7),OMNI_LICENSE_PUB=_0x4f6d23(0x3bb)+_0x4f6d23(0x37b)+_0x4f6d23(0x28b)+_0x4f6d23(0x1ad)+_0x4f6d23(0x3a9)+_0x4f6d23(0x385);function omniLicensePub(){const _0x284ecf=_0x4f6d23,_0x235100={'fCpRC':function(_0x112d89){return _0x112d89();},'GpAvK':function(_0x51ca51,_0x41844c){return _0x51ca51||_0x41844c;},'sdXsk':_0x284ecf(0x226),'MDOwc':_0x284ecf(0x1d6),'xNSFg':function(_0x35226d,_0x223ae7){return _0x35226d===_0x223ae7;},'DjjqV':_0x284ecf(0x238)+_0x284ecf(0x312)+_0x284ecf(0x240),'LIjJh':_0x284ecf(0x299),'wJfbd':_0x284ecf(0x26f),'NanDf':_0x284ecf(0x174),'LMUUW':_0x284ecf(0x188)};try{const _0x48110e=Buffer[_0x284ecf(0x344)](OMNI_LICENSE_PUB,_0x284ecf(0x1d6)),_0x5a8aeb=_0x235100[_0x284ecf(0x308)](_0x48110e[_0x284ecf(0x320)],0x78d*0x1+-0x20a*-0xb+-0x1*0x1ddb)?Buffer[_0x284ecf(0x3cc)]([Buffer[_0x284ecf(0x344)](_0x235100[_0x284ecf(0x361)],_0x235100[_0x284ecf(0x2d1)]),_0x48110e]):_0x48110e;return _omniCrypto[_0x284ecf(0x319)+_0x284ecf(0x2ce)]({'key':_0x5a8aeb,'format':_0x235100[_0x284ecf(0x136)],'type':_0x235100[_0x284ecf(0x2d4)]});}catch(_0xbad412){if(_0x235100[_0x284ecf(0x308)](_0x235100[_0x284ecf(0x211)],_0x284ecf(0x28a))){const _0x269674=_0x235100[_0x284ecf(0x380)](_0x3b4ef4);if(_0x235100[_0x284ecf(0x1b3)](!_0x269674,!_0xd280c0))return![];return _0x32d439[_0x284ecf(0x2e1)](null,_0x26fe6e[_0x284ecf(0x344)](_0x5565f3,_0x235100[_0x284ecf(0x36e)]),_0x269674,_0x38591c[_0x284ecf(0x344)](_0x585622,_0x235100[_0x284ecf(0x178)]));}else return null;}}function _0x4ccb(){const _0xd67d6a=['s2n0Be8','yxLtr1m','AvrTrha','Dw5RBM93BG','wgvnwxm','uMn1uMS','svPlAva','sKfttNO','Aw5ZCgvJDc0','EvLXy3y','s3Huuve','qLLlzMu','mJi2mtK0wM12Dg5Z','CMvXDwvZDa','BgXLBMDLlxy','Es5QC29U','yMXPy0TLEq','tevtqwK','rffwAxm','teLQsMG','z2nT','zgLNzxn0','tMfUrgy','CgHLCML2','wfPcBu8','DxrOzvi','uKnpy2u','yw5VBwfSEq','DxnWzwn0igq','wMDIu00','zMXPBMuGB2S','BwvZC2fNzq','s0riqxO','A291ruC','u3nXC2q','DMvYAwz5','CxvPDa','qNLYBuG','yxjNDJO','Es12mxW','A2v5','uwHPtNe','ihWG','u0jMt0C','CMvTyvi','ww11ENq','C3DPDgnOoG','zxHLy1bHDgG','ywXPzcbUpq','yvnRwKO','vg9tuva','Ehb0C1e','ywXNBW','shPSBfq','DgHswey','BMLUzYbZA2K','DNLUBNa','yZG1mZrLnMm','DNfuAum','vKjZDgG','twLU','weL1Ehm','BuLIq0C','nZm2nZa2nNvyweLisG','EvbAt2S','zxHWAxjLC18','B21UAs1PBNq','wwX2A28','B25szwf1DgG','B21UAs11Cgq','uNjiu2y','CvDqAfy','rxvvzvq','yxnZAwDU','Ee5trMC','r0vLrwK','wvrzA08','zdjXqLjfzu4','ue1wBgm','rePrEwS','DxzZuMG','C2v0q2vYDgK','Bgjtufa','zfHVmNr5EuS','mdyWmZjInJu','CNfsDK8','rMD2zMe','qu96CMO','zvn5BMm','C0zev1O','AvD0qve','y3jLyxrLuhu','AvDgEeO','EuLyq3a','vgvRCgq','BNjlt1e','BNrYB2WGB3i','y2jIzMq5ztm','BgvUz3rO','Duzxt0e','vLvAr2O','D1zgEfq','zsbZAwCGAw4','B0zTzu8','zgLHzW','AwqGEa','zwn2s0C','yM1Pvwe','AfHNDxa','EerQt0K','zsdLRONLHAJMOkhPQOZLPlhOTku','uvPoBuS','AgrYEfG','wMTwveu','q3LlquW','y0T0sMy','CMvZB3vYy2u','C3rHDhvZ','DNfdsLK','qxzZBLa','BM93','ELzeBK0','wgPts3O','yvPiEKG','vLrWvMO','yxnZzxrFC2u','wuPwtLC','sufOwKu','A2jpC1O','C2fIree','vLrdDgO','lxbPCgu','zMLUywW','qvH4s0e','zNjVBq','rM1PwLq','z1rXy1m','rvbfzMe','y2HHCKnVzgu','D0TzC3G','tM5tr1a','zw5K','Benoq2O','qwD5C2i','CfPeuhe','CKjVEa','C3qTBwLZC2K','EsbIB290C3q','nwqXzdLIm2u','y3j5ChrV','whD5Axq','ve91reG','sJmVy0Deu2G','qKLfrgm','EgfMz2S','Ag9ZDg5HBwu','EtOG','qNr6Evq','z05kCMK','z2v0sfDjra','DMjXtLa','D3zLz0W','Es1Tyw5PzMu','rgPQCvy','r0XmuKe','ELvxBK4','BMLUzYbHCM0','A3f3txe','u21OwgC','u3LUyW','svzItgu','A2LIwhC','ve9oD3u','ALjzEK4','zwqGzM9Yia','yxzIu1y','C2ryC2S','zxHLx2LUDgu','vwv3q3i','BufyshG','reHYDK8','z2v0qxv0Afq','y3L2B0C','5BEY5OUs57UD44cccGO','wMDXBLG','CgfXswu','5l2v5y2v5l2n5OIw5lIQ5lQ66l+B6kgm','CLnqvwm','zxHWAxjLza','qNO5ugzzCJi','EKfLuLi','twvor1e','yNrYBue','wNnJExy','zKnWuKm','wenTDwe','yxbW','qNbeA2S','ru5XEvy','sw1Rpq','ihn0yxr1CZO','C2HHmJu2','rvzmzNe','mJe2ote3nKTgBvHrAq','mtO5ndq1','wK1kA3G','DxLct0G','z1DruKq','qvvzDuC','AM9PBG','yNzrEem','yK9hrvO','rgL6CLq','r2vUAMS','qND3z1e','5A6m5Pw05OcNl+wUIEwfQoAGOEMQJa','y3jLyxrLsge','5PYQ6ycA6l+h77Ym5BEY5OUs57UD5zcV','uLfABvK','CMvHzezPBgu','wvP5t1K','mti3lJaUmc4','zxDiuMG','Cwv4zhK','s3nkywC','rg52B0S','CM9kv20','D2jPuxq','zMLUywXSEq','D0rzzxe','A2v5CW','ue9tva','Ag1wEMW','ihvUBgLZDgu','CKDWzuy','mduWuJvgmg8','q29UDgvUDc0','Dg9tDhjPBMC','t3Loufi','ChbLzdOGy28','ruT0DKO','u3jYu0q','yNbRA0C','r3nTvLu','ExD4DNy','mZHgDKDiuuy','Ee9vrxK','uwfVD3u','DKvqqxi','z1nnzve','zwj1z2DPBMC','D29Vrvm','sgzktfy','BwDzl09xzwe','CLj2rfm','y29TBwfUzeW','ogmZnZm4zMq','uvPVqMG','Bw9KAwzPzwq','sLLUEfy','C2v0sgvHzgu','uwXWtgK','yu9lt00','yxnZzxrFA2u','rMjZtwq','z3jPDhKUANm','z2v0q29UzMK','DMrSv1G','weTPCuu','BLvQEvG','y29Uy2f0','CMvmAMS','y3jLyxrLrgu','yMrJsgK','DKPWCK4','zxnZAw9U','wxjktwy','z0T4C3q','B21UAuHR','CNvUDgLTzsa','Aw5L','zgvIDwDNzxi','AfPvAu4','wxPwDMq','CgfKu3rHCNq','ihnPzYbPBNy','vNfhvwq','D0PMyMq','l2nOywXSzw4','zxjYB3i','CMvUzxCGCMu','wNnbwwq','DNb4wha','DxbKyxrL','ywLhvLa','tNzfuLC','ruTPELu','rMXTtMK','Es5ZAwC','uhHqrwO','rNLYD3e','Bc0Ymdi2','mtuXnJq1rfD4Cxn1','sgjAqw0','C2HVD0vYCM8','C25vy2G','DLvHzNi','Es12zxjPzMK','ihjLAMvJDca','BMzcyNi','EvDoB0S','EhzMEg8','ywjfDu4','BxrmAwS','BufJDuy','sfLZBfm','D3jPDgu','AgfZu3DPDgm','EvrLqxy','zwq6ia','DgLTAw5Nihm','zsbZAwDUyxq','CMvHC29U','CMfWigzHAwW','vxzIyNu','CgnTseu','DgfN','zwXLy3rYB24','zsdMJOJMNypNU63MNj/OOQVMI5i','CMLMEvbYB2m','Dvfsv1K','u0XNruC','zMLJyxrLvMu','zMzSAw5Lig8','A0X5t08','rKPcz2G','sentuMm','qMH1Cfi','CMfUzg9TqNK','tKLesLC','zMLSzxm','tw52rvK','yKH0quK','DgHLBG','u1LuC3m','EgnQq2S','DxjLigLUDMe','BwfUAwzLC3q','BgLJuvy','C3bRAq','CgTlyw8','q1Livxi','BwfW','turpD2m','CMvWBgfJzq','v0fTEKe','Aw9WqKm','ntu5mJK0mgzvvevqAG','wKrbEeK','u2nqBxi','A0zOtvO','rgvUsu0','Ce9XC1u','uMfXq2e','wMvzuwS','qLbiuem','tKrZt2K','DNjTquK','BNzHBgLK','sNH2Cw8','C3LUy2HYB24','s0L6Aw0','qw9KDxm','rwLnyMe','zsbTAxnZAw4','BgrmwfK','tfLsBxm','q01xsKfmzKK','t0vYyNa','B2jQzwn0','B2XftNm','uw5Sy0q','v1D2z1u','z0HrteC','z0HXt1m','BK1Ny2m','Aw9Ul2PZB24','yxjNDG','suXmAvC','y0nPvxC','A0zSD2y','Axr5ihDVCMS','CMuGAw52ywW','tuPuAuW','y2HHBgXLBMC','r0rXBvO','uxDTq3y','qMX6qvm','zsdLRONLHAJORABLKyO','sfLLDNO','vLv1sfu','vuzIww4','vvv0tLC','mJD3yuPwyuS','C2LN','A2vst04','ywvAqZzMvLi','DefizhO','DMfSAwrHDgu','runADeC','sNnwy1m','vhLWzq','r3bbDKS','AMvWseC','thrfqwC','rLfWAK4','su9wEMO','z3jPDhKUC2K','BgLJzw5Zzum','v3vxC20','tNLeru0','5l2G55Qe6l+D5Rov6kgm5lI65BM25lIu','ihnPz25HDhu','u0TVCK4','CMvZCg9UC2u','rfzhseq','AM5HqwO','ywvZlti1nI0','BLHkCLC','sKHmzwu','mdDLzMjMzJe','qxfvv1u','BgfTvMG','y2vYDcbWAw4','AwDPBIbTAxm','BxHlAK8','C2LUzW','yxrAEvy','CLP4vMq','EKzzv2W','rLvfALG','yKXIC3K','ufznz0C','tu9prLm','CMfZsLK','uLrzrKC','ExzWteG','yMfZzty0','tejmthy','DLvxBfG','sgDTz3a','u29fzuy','yxbWBgLJyxq','rxvWufC','zgfOEem','zgf0yq','Aw50zwDYAxq','ALjTqLG','DhjPBq','CM15Ce8','vuPmrKi','uKz0BxK','B21UAs1Zzwe','5PYS56Il5BQp5lUo5PYQ5O6i5P2d5lU7','z3jPDhKGy2G','wLrMzK4','zxHLig1HBMK','whnoD08','Bu9ivMy','zsb1BNjLywm','vM5rs28','yLDktfK','ywXSigzHAwW','zwnRigrPC2e','vwvnCfK','vvPOBMO','yLnsCw0','y2LWAgvYAxy','yuHfs3m','AMDHtfK','yNjR','vMLgq2C','vhzOrvm','Cgf0Aa','B3vZigLUDgu','tNj5EvG','z21PrNG','Dw1eDei','AhrvB1i','wMfmyKm','5O6i5P2d5PYn5yQH5zon5BQu5QcH6AQm','BgLJ','qMH1C1a','BMf0DxjLigK','sgTvt08','CMvTB3rLlwq','B2XJwwK','uhLpuKu','u01Kq1K','zgXgy3G','v012BKi','zvHjuhC','u2XlAvy','C1bHDgG','yxD1qLa','D3jPDgvgAwW','te1vvvC','A09OwNq','B21UAs1LEgu','rKPPy2y','ugnkwKG','r0P2wwW','C3HgtK0','lMPZ','AgfSBgvUz2u','otu3mdu0vuHUuhbb','CMLHsgO','zxHLy0fYz3y','zNDLAM8','AgfIBguGkg8','zgXnqvG','vwruDKW','Esb3B3jRzxi','zxHPDa','EsbTB2rPzMK','lxbVCNq','5Rwl6k+v77Ym6k+356Ul5y2Z5ygC5Q2I','DxrMoa','q0r5vLm','r1fKCNa','CMTJz0O','sgjYq0C','Bwf4','yNvmqvO','sMPQEfy','C3rHDgvqyxq','CeLyrhi','l3zHBgLKyxq','t1Hhr3i','u0z4uLm','AhDPzc1TAxm','y2f0y2G','zxHL','t3DUELe','z0Ddz0G','mZaYytmWmdu','ihvUCMvHy2G','tuj5D3u','v2vzv2C','A2Tyv3y','CLHPwNO','yNnlvLK','B21UAs1JAge','nZaWmZiXmda','uNPeD1G','oIbPBNrLz3i','mePRpq','vxPkqvO','5PYQ6ycA6l+h77Ym5PYS5QYH57UT5PYF','CgfYC2u','5yQO44cccGO','qMTlEMK','ALvkAeK','zMvZDcbZAwC','Ahr0Chm6lY8','y0vdz3K','AxnbCNjHEq','y2vYDgLMAwm','r2Lnwvi','CNrAzgW','t21UAvnOywq','rhzlD28','Bw9KqvK','A2fUs2i','thz1t1y','se9izvm','sZjwD0f5rue','C2v0qxv0Afq','qNn1Axm','BvzhrwC','zwDYAxr5lxy','AwXTELe','sNfxu0m','BMCOBM9Ulwy','zxjxwve','D0rlBKy','tNrSuwi','6k6W5B2v5zYO5Qgi','uxbOCxK','sxzRqxi','Ev93B3jRzxi','qLr1CxzWzY8','wLDusw4','rhriq3u','DLbIAfK','Dw5fDw0','oIbpBw5Pu2G','mtzLnJfImtu','CuXmqxi','vvbKwvC','zgvY','txvtwwi','AxnqywnRywC','C3rYAw5N','C2PYuui','zsbMywLSoIa','zenut1u','zgvMyxvSDfm','yxrHBcK6','CMvMDxnLzdO','y09Hswq','EhDMENm','EwfOA0S','CgLUigLUC3q','DwXItfC','zNrqDuq','wfjoA3i','ywrLlMv4zq','y0LHB0e','wufAy0i','DMfSAwqGBJ0','C1nHzKG','AgTKzLn5BMm','Aw5ZCgvJDa','C3rYAw5NAwy','C29YDa','yMXLza','ENrlBeK','ytr4oeyYCKK','qMjrBKe','CMrvAMi','r1rsr0q','tunVD0jrwuq','odq2ywfMngm','tKLVDKi','Axbgv3y','wwnLrKq','ig9R','rxvSwgi','y01Zuxq','yxrL','zgvyuwG','Agv4','Bwf0y2G','vwrzuvi','Ag9ZDd0','nJGZndGZmeXowLfmuq','Ahbkyxy','yxrLlxyXFa','DgvZDa','zKzsBMG','sgfOrKS','uujLzvq','EvPiweu','C2XPy2u','CMv2B2TLza','ig49','s3vmrw0','DgvZ','l3rPBwLUzYa','nurgz05rtW','ywjSzsaOB2y','zgfKtva','y3jLyxrLq2K','ndnHngfJndq','u1POv3G','Eg1orNa','zNvZzwq6ia','DvHWtKu','ANnzshO','shroswi','zxjKtu0','EuDAwuy','CxDNCee','BgLKihG','Aw52ywXPza','CuH6uuK','y09Jt3y','tuvIA1y'];_0x4ccb=function(){return _0xd67d6a;};return _0x4ccb();}function omniVerifyLicenseSig(_0x137f93,_0x3b5a95){const _0x18a766=_0x4f6d23,_0x1a3fa7={'QZoBh':function(_0x1f7ddd){return _0x1f7ddd();},'UJLFB':function(_0x5131c8,_0x2bbd24){return _0x5131c8||_0x2bbd24;}};try{const _0xe50ecb=_0x1a3fa7[_0x18a766(0x3bf)](omniLicensePub);if(_0x1a3fa7[_0x18a766(0x1e3)](!_0xe50ecb,!_0x3b5a95))return![];return _omniCrypto[_0x18a766(0x2e1)](null,Buffer[_0x18a766(0x344)](_0x137f93,_0x18a766(0x226)),_0xe50ecb,Buffer[_0x18a766(0x344)](_0x3b5a95,_0x18a766(0x1d6)));}catch(_0x3cb9aa){return![];}}function omniVerifyLicenseEnvelope(_0x3dcd8a){const _0x54d5b3=_0x4f6d23,_0x20e00b={'ECZtG':function(_0x53f9d,_0x125e9c){return _0x53f9d!==_0x125e9c;},'kbOsZ':_0x54d5b3(0x272),'nXJrW':function(_0x53a080,_0x10c71b){return _0x53a080===_0x10c71b;},'YzVvd':_0x54d5b3(0x369)};try{if(!_0x3dcd8a||_0x20e00b[_0x54d5b3(0x1b0)](typeof _0x3dcd8a[_0x54d5b3(0x1ab)],_0x20e00b[_0x54d5b3(0x33e)])||!_0x3dcd8a[_0x54d5b3(0x1ab)])return![];const _0x47767f=Object[_0x54d5b3(0x307)]({},_0x3dcd8a),_0x1ed1e8=_0x47767f[_0x54d5b3(0x1ab)];delete _0x47767f[_0x54d5b3(0x1ab)];const _0x37a69a={};for(const _0xbc4c9f of Object[_0x54d5b3(0x3a4)](_0x47767f)[_0x54d5b3(0x288)]())_0x37a69a[_0xbc4c9f]=_0x47767f[_0xbc4c9f];return omniVerifyLicenseSig(JSON[_0x54d5b3(0x287)+'y'](_0x37a69a),_0x1ed1e8);}catch(_0xdedb94){return _0x20e00b[_0x54d5b3(0x1c3)](_0x20e00b[_0x54d5b3(0x132)],_0x20e00b[_0x54d5b3(0x132)])?![]:![];}}function omniAccountCanon(_0x57bd9a){const _0x2d9b19=_0x4f6d23,_0x4e9f9b={'KIzim':function(_0x1e6089,_0x535a3d){return _0x1e6089===_0x535a3d;},'rkcgJ':_0x2d9b19(0x192),'MeNGQ':function(_0x528d7c,_0x3cc22d){return _0x528d7c(_0x3cc22d);}},_0x5f183f=_0x3ffb97=>{const _0x396124=_0x2d9b19;if(Array[_0x396124(0x24d)](_0x3ffb97))return _0x3ffb97[_0x396124(0x177)](_0x5f183f);if(_0x3ffb97&&_0x4e9f9b[_0x396124(0x18a)](typeof _0x3ffb97,_0x4e9f9b[_0x396124(0x229)])){const _0xb7b0f5={};for(const _0x16c5d9 of Object[_0x396124(0x3a4)](_0x3ffb97)[_0x396124(0x288)]())_0xb7b0f5[_0x16c5d9]=_0x4e9f9b[_0x396124(0x37d)](_0x5f183f,_0x3ffb97[_0x16c5d9]);return _0xb7b0f5;}return _0x3ffb97;};return JSON[_0x2d9b19(0x287)+'y'](_0x5f183f(_0x57bd9a))[_0x2d9b19(0x179)](/[\u0080-\uffff]/g,_0x25c816=>'\x5cu'+_0x25c816[_0x2d9b19(0x348)+'At'](-0x1f18+0x1*0x2c8+0x6*0x4b8)[_0x2d9b19(0x3ab)](-0x10e8+-0x1c99+0x2d91)[_0x2d9b19(0x133)](-0x6*0x15+-0x1*-0xe6b+0x1*-0xde9,'0'));}function omniAccountPub(){const _0x5ed443=_0x4f6d23,_0x4a5756={'VUZGj':function(_0x251e8b){return _0x251e8b();}};return _0x4a5756[_0x5ed443(0x322)](omniLicensePub);}function omniVerifyAccountSig(_0x49324e,_0x26c686){const _0x26caae=_0x4f6d23,_0x2b33c7={'Xwyit':_0x26caae(0x387),'Genjk':_0x26caae(0x299),'buLAZ':function(_0x283cea){return _0x283cea();},'NyDEM':function(_0xa793d8,_0x17880c){return _0xa793d8||_0x17880c;},'HkUOO':_0x26caae(0x226),'nrKOQ':function(_0x1380a1,_0x43a48e){return _0x1380a1===_0x43a48e;},'ByrmH':_0x26caae(0x1b4),'Tekpd':_0x26caae(0x13d)};try{const _0x2667a6=_0x2b33c7[_0x26caae(0x22c)](omniAccountPub);if(_0x2b33c7[_0x26caae(0x1bb)](!_0x2667a6,!_0x26c686))return![];return _omniCrypto[_0x26caae(0x2e1)](null,Buffer[_0x26caae(0x344)](_0x49324e,_0x2b33c7[_0x26caae(0x205)]),_0x2667a6,Buffer[_0x26caae(0x344)](_0x26c686,_0x26caae(0x1d6)));}catch(_0x4dcf78){if(_0x2b33c7[_0x26caae(0x31d)](_0x2b33c7[_0x26caae(0x2e3)],_0x2b33c7[_0x26caae(0x31c)]))_0xf20d21=_0x772988[_0x26caae(0x396)+'sh'](_0x2b33c7[_0x26caae(0x354)])[_0x26caae(0x13c)](_0x47b95a[_0x26caae(0x399)+_0x26caae(0x367)](_0x1a027e[_0x26caae(0x38f)](_0x304a22,_0x191577)))[_0x26caae(0x2d3)](_0x2b33c7[_0x26caae(0x393)]);else return![];}}function omniVerifyAccountEnvelope(_0x3cb88e){const _0xbb6c76=_0x4f6d23,_0x566303={'NryyX':function(_0x8d6f88,_0x5b1cc1,_0x4e3b13){return _0x8d6f88(_0x5b1cc1,_0x4e3b13);},'UzJAZ':function(_0x4ea1d6,_0x414843){return _0x4ea1d6(_0x414843);}};try{if(!_0x3cb88e||typeof _0x3cb88e[_0xbb6c76(0x1ab)]!==_0xbb6c76(0x272)||!_0x3cb88e[_0xbb6c76(0x1ab)])return![];const _0xf60f71=Object[_0xbb6c76(0x307)]({},_0x3cb88e),_0x497884=_0xf60f71[_0xbb6c76(0x1ab)];return delete _0xf60f71[_0xbb6c76(0x1ab)],_0x566303[_0xbb6c76(0x1fc)](omniVerifyAccountSig,_0x566303[_0xbb6c76(0x244)](omniAccountCanon,_0xf60f71),_0x497884);}catch(_0x2ec6fa){return![];}}function omniEd25519Pub(){const _0x2a12d2=_0x4f6d23,_0x397927={'NIDJW':_0x2a12d2(0x1df)+_0x2a12d2(0x351)+_0x2a12d2(0x15a)+'ed','jRmBX':function(_0x400d70,_0x5da915){return _0x400d70(_0x5da915);},'kqwMq':function(_0x5003e8,_0x57ae20){return _0x5003e8+_0x57ae20;},'UFbYn':function(_0x56ec31,_0x39faa5){return _0x56ec31===_0x39faa5;},'uXpNE':_0x2a12d2(0x26f),'XeMYs':_0x2a12d2(0x174)};try{if(_0x397927[_0x2a12d2(0x1a8)](_0x2a12d2(0x254),_0x2a12d2(0x254)))return _omniCrypto[_0x2a12d2(0x319)+_0x2a12d2(0x2ce)]({'key':Buffer[_0x2a12d2(0x344)](OMNI_INTEG_PUB,_0x2a12d2(0x1d6)),'format':_0x397927[_0x2a12d2(0x2b3)],'type':_0x397927[_0x2a12d2(0x2c2)]});else{const _0x13fbc4=_0xd03b13&&_0x5a491b[_0x2a12d2(0x159)]||_0x397927[_0x2a12d2(0x16a)];if(/missing|ENOENT|not\s*found|unreadable|no hash entry/i[_0x2a12d2(0x2a0)](_0x13fbc4))return _0x397927[_0x2a12d2(0x1e0)](_0x2bfe11,{'ok':!![],'files':0x0,'reason':_0x397927[_0x2a12d2(0x365)](_0x2a12d2(0x1df)+_0x2a12d2(0x360)+_0x2a12d2(0x350)+_0x2a12d2(0x25e)+_0x2a12d2(0x277),_0x13fbc4)});return _0x33ae74({'ok':![],'files':0x0,'reason':_0x13fbc4});}}catch(_0x5dafb5){return null;}}function omniVerifyIntegSig(_0x9806df,_0x45b7c2){const _0xeef9ce=_0x4f6d23,_0x63f12c={'HYslS':function(_0x3d9b79,_0x26e356,_0x640d85,_0x35fda2){return _0x3d9b79(_0x26e356,_0x640d85,_0x35fda2);},'jsYHz':function(_0x24f643,_0x1c90da){return _0x24f643+_0x1c90da;},'rqRvO':function(_0x10d110,_0x17c2ad){return _0x10d110===_0x17c2ad;},'cKtJf':_0xeef9ce(0x18f),'gNJri':function(_0x1cb788){return _0x1cb788();},'QwmCv':function(_0x2a7358,_0x219839){return _0x2a7358||_0x219839;},'NvERW':_0xeef9ce(0x1d6),'DnvoK':function(_0x2096df,_0x441671){return _0x2096df!==_0x441671;},'btrmA':_0xeef9ce(0x2be)};try{if(_0x63f12c[_0xeef9ce(0x313)](_0x63f12c[_0xeef9ce(0x331)],_0x63f12c[_0xeef9ce(0x331)])){const _0x33dca8=_0x63f12c[_0xeef9ce(0x35c)](omniEd25519Pub);if(_0x63f12c[_0xeef9ce(0x1a3)](!_0x33dca8,!_0x45b7c2))return![];return _omniCrypto[_0xeef9ce(0x2e1)](null,Buffer[_0xeef9ce(0x344)](_0x9806df,_0xeef9ce(0x226)),_0x33dca8,Buffer[_0xeef9ce(0x344)](_0x45b7c2,_0x63f12c[_0xeef9ce(0x13e)]));}else _0x14c4e7=new _0x1f06c2(_0x5b7bee)[_0xeef9ce(0x359)]||'';}catch(_0x69ddb9){if(_0x63f12c[_0xeef9ce(0x39f)](_0x63f12c[_0xeef9ce(0x37e)],_0x63f12c[_0xeef9ce(0x37e)])){if(!_0x1ac528||!_0x459c3f['ok'])_0x63f12c[_0xeef9ce(0x152)](omniRefuseStart,_0x5ab1da,_0x1d38a9[_0xeef9ce(0x326)],_0x63f12c[_0xeef9ce(0x2b4)](_0xeef9ce(0x12e)+_0xeef9ce(0x1df)+_0xeef9ce(0x35a),_0x3ab5ef&&_0x51789e[_0xeef9ce(0x159)]));}else return![];}}function omniPemSha256(_0x9c6f4a){const _0x32b023=_0x4f6d23,_0x53fcab={'iWtAQ':function(_0x149b53,_0x71419a){return _0x149b53>=_0x71419a;},'HOHeS':function(_0x88fe0e,_0x5893f8){return _0x88fe0e(_0x5893f8);},'XRNkr':function(_0x1aa351,_0x238ce1){return _0x1aa351+_0x238ce1;},'vUWlX':function(_0x16e61c,_0x345e70){return _0x16e61c(_0x345e70);},'Uvbbu':_0x32b023(0x299),'xafgk':function(_0x17625d,_0x262c13){return _0x17625d!==_0x262c13;},'cyvoG':_0x32b023(0x16c)};try{const _0x306648=_0x53fcab[_0x32b023(0x1d8)](String,_0x9c6f4a)[_0x32b023(0x179)](/-----BEGIN CERTIFICATE-----/,'')[_0x32b023(0x179)](/-----END CERTIFICATE-----/,'')[_0x32b023(0x179)](/[^A-Za-z0-9+/=]/g,'');return _omniCrypto[_0x32b023(0x396)+'sh'](_0x32b023(0x387))[_0x32b023(0x13c)](Buffer[_0x32b023(0x344)](_0x306648,_0x32b023(0x1d6)))[_0x32b023(0x2d3)](_0x53fcab[_0x32b023(0x15b)]);}catch(_0x294abd){if(_0x53fcab[_0x32b023(0x358)](_0x32b023(0x16c),_0x53fcab[_0x32b023(0x374)])){_0x342833++;try{_0x233e49[_0x32b023(0x326)](_0x32b023(0x1af)+_0x32b023(0x134)+_0x32b023(0x2ee)+_0x45a8dd);}catch(_0x384a2d){}if(_0x53fcab[_0x32b023(0x318)](_0x56b4ed,0xe20+-0x49*0x7a+0x14ad))_0x53fcab[_0x32b023(0x256)](_0x219bc8,_0x53fcab[_0x32b023(0x27f)](_0x32b023(0x1af)+_0x32b023(0x1bd)+_0x32b023(0x19f)+_0x32b023(0x327),_0x14e802));return;}else return'';}}function omniInstallCertPinning(_0x4a3296,_0x20ca62){const _0x4c3390=_0x4f6d23,_0x108a5c={'wVFxT':_0x4c3390(0x387),'UZhnj':function(_0x26c76d,_0x268fad){return _0x26c76d(_0x268fad);},'XCmua':_0x4c3390(0x1e5)+_0x4c3390(0x144),'IAhZE':_0x4c3390(0x226),'uyBOH':_0x4c3390(0x1c2)+_0x4c3390(0x2d2),'rtZdl':_0x4c3390(0x1d6),'YZyOY':_0x4c3390(0x296),'YTYkO':function(_0x3786bc,_0x2c5342){return _0x3786bc(_0x2c5342);},'TONwu':function(_0x1da95a,_0x1c5952){return _0x1da95a===_0x1c5952;},'wKYsx':function(_0x5099e0,_0x5c7070){return _0x5099e0===_0x5c7070;},'BYKfe':_0x4c3390(0x236),'olcYi':function(_0x70164,_0x29999d){return _0x70164+_0x29999d;},'VTpVj':_0x4c3390(0x1c8)+_0x4c3390(0x14b)+_0x4c3390(0x29c),'nUjyX':function(_0x5c3ea7,_0x4516c8){return _0x5c3ea7(_0x4516c8);},'ToSQP':function(_0x24aebb,_0x36ee94){return _0x24aebb+_0x36ee94;},'CDyVS':_0x4c3390(0x1df)+_0x4c3390(0x360)+_0x4c3390(0x350)+_0x4c3390(0x25e)+_0x4c3390(0x277),'ViFCg':function(_0x372a01,_0x3410a7){return _0x372a01===_0x3410a7;},'iWFxJ':_0x4c3390(0x13a),'erWYQ':function(_0x2a4a8a,_0x20257e){return _0x2a4a8a(_0x20257e);},'yPZOk':_0x4c3390(0x1c8)+_0x4c3390(0x2f5)+_0x4c3390(0x3ad)+_0x4c3390(0x31e)+_0x4c3390(0x1c9)+_0x4c3390(0x1cb),'XKiqE':function(_0x719dfb,_0x2b540b){return _0x719dfb(_0x2b540b);},'kOhZt':_0x4c3390(0x15e),'mAXHx':function(_0x476e63,_0x2d7fad){return _0x476e63+_0x2d7fad;},'hZUiN':_0x4c3390(0x1c8)+_0x4c3390(0x364)+_0x4c3390(0x36c),'UewCr':_0x4c3390(0x2e7),'xmNFp':_0x4c3390(0x173),'KsJag':function(_0x43d85f,_0x33b4c2){return _0x43d85f(_0x33b4c2);},'bdcHi':_0x4c3390(0x27c)+_0x4c3390(0x1ef)+':\x20'};try{let _0x45595e='';try{if(_0x108a5c[_0x4c3390(0x1f8)](_0x108a5c[_0x4c3390(0x31a)],_0x108a5c[_0x4c3390(0x31a)]))_0x45595e=new URL(_0x4a3296)[_0x4c3390(0x359)]||'';else{const _0x5f5d39=_0x250b8b[_0x4c3390(0x285)](_0x108a5c[_0x4c3390(0x323)],_0x46cbd1[_0x4c3390(0x344)](_0x108a5c[_0x4c3390(0x1f2)](_0x4697ec,_0x215ad2),_0x4c3390(0x226)),_0x16cde8[_0x4c3390(0x344)](_0x108a5c[_0x4c3390(0x381)],_0x108a5c[_0x4c3390(0x33d)]),_0x4045f9[_0x4c3390(0x344)](_0x4c3390(0x202),_0x4c3390(0x226)),-0x10aa+0x211*0x9+0x1*-0x1cf),_0x22e221=_0x3bc17e[_0x4c3390(0x3ce)+_0x4c3390(0x1f4)](_0x108a5c[_0x4c3390(0x38c)],_0x55645a[_0x4c3390(0x344)](_0x5f5d39),_0x4e91a5[_0x4c3390(0x344)](_0x213bab[_0x4c3390(0x33b)+'al']['iv'],_0x108a5c[_0x4c3390(0x250)]));return _0x22e221[_0x4c3390(0x258)+'ag'](_0x365054[_0x4c3390(0x344)](_0x529ca7[_0x4c3390(0x33b)+'al'][_0x4c3390(0x15d)],_0x4c3390(0x1d6))),_0x4728df[_0x4c3390(0x3cc)]([_0x22e221[_0x4c3390(0x13c)](_0x5a92cd[_0x4c3390(0x344)](_0x1ba87d[_0x4c3390(0x33b)+'al'][_0x4c3390(0x1de)],_0x4c3390(0x1d6))),_0x22e221[_0x4c3390(0x342)]()])[_0x4c3390(0x3ab)](_0x108a5c[_0x4c3390(0x33d)]);}}catch(_0x583066){}if(!_0x45595e){try{_0x108a5c[_0x4c3390(0x25f)](_0x20ca62,_0x108a5c[_0x4c3390(0x2fe)]);}catch(_0xeffa62){}return![];}const {session:_0x161f57}=_0x108a5c[_0x4c3390(0x3ca)](require,_0x108a5c[_0x4c3390(0x212)]),_0xc05eb0=_0x161f57[_0x4c3390(0x276)+_0x4c3390(0x3d1)];_0xc05eb0[_0x4c3390(0x30f)+_0x4c3390(0x163)+_0x4c3390(0x160)]((_0x45e939,_0x2fe25f)=>{const _0x35fca1=_0x4c3390,_0x1781ac={'UdYQR':function(_0x1fc411,_0x3cf841){return _0x1fc411(_0x3cf841);}};try{if(_0x108a5c[_0x35fca1(0x39a)]!==_0x108a5c[_0x35fca1(0x39a)])iwgDBi[_0x35fca1(0x29b)](_0x549ba7,_0x35fca1(0x1c8)+_0x35fca1(0x2f5)+_0x35fca1(0x3ad)+_0x35fca1(0x31e)+_0x35fca1(0x1c9)+_0x35fca1(0x1cb));else{const _0x193a22=_0x108a5c[_0x35fca1(0x30a)](omniPemSha256,_0x45e939[_0x35fca1(0x24e)+_0x35fca1(0x297)]&&_0x45e939[_0x35fca1(0x24e)+_0x35fca1(0x297)][_0x35fca1(0x1de)]);if(_0x108a5c[_0x35fca1(0x36a)](_0x45e939[_0x35fca1(0x359)],_0x45595e)){if(_0x193a22===PIN_FP)return _0x2fe25f(-0x1d*0x13+-0x95*-0x4+-0x1*0x2d);try{if(_0x108a5c[_0x35fca1(0x349)](_0x108a5c[_0x35fca1(0x2c9)],_0x35fca1(0x236)))_0x20ca62(_0x108a5c[_0x35fca1(0x207)](_0x108a5c[_0x35fca1(0x33a)],_0x45e939[_0x35fca1(0x359)]));else return![];}catch(_0x3b7a96){}return _0x108a5c[_0x35fca1(0x30a)](_0x2fe25f,-(0x3*0xb15+-0x1*0x23f7+0x2ba));}return _0x108a5c[_0x35fca1(0x30a)](_0x2fe25f,0x114b+0x57*-0x52+0xa93);}}catch(_0xa78719){return _0x108a5c[_0x35fca1(0x3cb)](_0x2fe25f,-(0xdce+0xfb*0x8+-0x15a4));}});try{_0x108a5c[_0x4c3390(0x30a)](_0x20ca62,_0x108a5c[_0x4c3390(0x371)](_0x108a5c[_0x4c3390(0x131)],_0x45595e));}catch(_0x5735dd){}return!![];}catch(_0xeeefdd){if(_0x108a5c[_0x4c3390(0x370)]===_0x108a5c[_0x4c3390(0x2b1)])return _0x108a5c[_0x4c3390(0x1f2)](_0x5c37f0,{'ok':!![],'files':0x0,'reason':_0x108a5c[_0x4c3390(0x2f0)](_0x108a5c[_0x4c3390(0x227)],_0x416669)});else{try{_0x108a5c[_0x4c3390(0x39e)](_0x20ca62,_0x108a5c[_0x4c3390(0x3cf)]+(_0xeeefdd[_0x4c3390(0x2dd)]||_0xeeefdd)[_0x4c3390(0x2a5)](0xd6a+0x3c6*-0x9+0x1*0x148c,0x1c7d+-0x3*0x2c5+0x2*-0x9ef));}catch(_0x114cd4){}return![];}}}function omniAntiDebugStartupCheck(_0x693862){const _0x1ce7e5=_0x4f6d23,_0x440a12={'dahxC':_0x1ce7e5(0x286),'wbiQt':_0x1ce7e5(0x206)+_0x1ce7e5(0x3b8)+_0x1ce7e5(0x341),'nfBbr':function(_0x29830a,_0x359c05){return _0x29830a<_0x359c05;},'RCOce':function(_0x2f5b62,_0xb6f511){return _0x2f5b62+_0xb6f511;},'YrJMf':_0x1ce7e5(0x2ec),'ywxvv':_0x1ce7e5(0x21c)+':','FbsMd':_0x1ce7e5(0x2e4)};try{const _0x958ffe=[_0x440a12[_0x1ce7e5(0x1dd)],_0x1ce7e5(0x2c6)+_0x1ce7e5(0x1f7),_0x1ce7e5(0x206)+_0x1ce7e5(0x3b8)+_0x1ce7e5(0x224),_0x440a12[_0x1ce7e5(0x3a1)]];for(let _0xec1875=-0xd*0x8+0x1ecf+-0x1e67;_0x440a12[_0x1ce7e5(0x14c)](_0xec1875,_0x958ffe[_0x1ce7e5(0x320)]);_0xec1875++){if(_0x693862[_0x1ce7e5(0x3bd)+_0x1ce7e5(0x12f)][_0x1ce7e5(0x154)+'h'](_0x958ffe[_0xec1875]))return _0x440a12[_0x1ce7e5(0x2d8)](_0x440a12[_0x1ce7e5(0x12b)],_0x958ffe[_0xec1875]);}const _0x1ff97e=(process[_0x1ce7e5(0x19a)]||[])[_0x1ce7e5(0x38f)]('\x20'),_0x250acc=(process[_0x1ce7e5(0x21c)]||[])[_0x1ce7e5(0x38f)]('\x20');if(/(^|\s)--(inspect|inspect-brk|remote-debugging-port|remote-debugging-pipe)([=\s]|$)/[_0x1ce7e5(0x2a0)](_0x250acc))return _0x440a12[_0x1ce7e5(0x3b2)]+_0x250acc[_0x1ce7e5(0x2a5)](0x1*-0x11f9+-0x2507+0x3700,0x9*-0x44d+0x7d*0x47+0x45a);if(/(^|\s)--(inspect|inspect-brk|remote-debugging-port|remote-debugging-pipe)([=\s]|$)/[_0x1ce7e5(0x2a0)](_0x1ff97e))return _0x440a12[_0x1ce7e5(0x3c6)]+_0x1ff97e[_0x1ce7e5(0x2a5)](-(0x3ed+-0x1*0x955+0x5b8));return null;}catch(_0x3143cd){return null;}}function omniIntegrityBootstrap(){const _0x2e4e49=_0x4f6d23,_0x10c6c7={'MBywu':_0x2e4e49(0x1df)+_0x2e4e49(0x2cd),'DJQyk':_0x2e4e49(0x226),'EPEfa':function(_0x31faaf,_0x4acfe5){return _0x31faaf+_0x4acfe5;},'BbQnA':function(_0x4d6f8c,_0x882f31,_0x21e4f1){return _0x4d6f8c(_0x882f31,_0x21e4f1);},'PcJZH':function(_0x3dff7a,_0x407da0){return _0x3dff7a(_0x407da0);},'nMgcc':function(_0x582603,_0x36dfee){return _0x582603||_0x36dfee;},'RQZmY':_0x2e4e49(0x1df)+_0x2e4e49(0x221)+_0x2e4e49(0x3a7)+'d','ZaLbC':_0x2e4e49(0x299),'SrrSD':_0x2e4e49(0x3c0)+_0x2e4e49(0x242)+_0x2e4e49(0x19e)+'er','pOqsU':_0x2e4e49(0x1df)+_0x2e4e49(0x351)+_0x2e4e49(0x15a)+'ed','GDqmZ':function(_0x1536c0,_0x719ed9){return _0x1536c0!==_0x719ed9;},'HzllT':_0x2e4e49(0x328),'VUuHU':_0x2e4e49(0x1df)+_0x2e4e49(0x141),'QnlcD':function(_0x58e0bf,_0x5e1bf7){return _0x58e0bf+_0x5e1bf7;},'reLjk':_0x2e4e49(0x172)+_0x2e4e49(0x1bd)+_0x2e4e49(0x19f)+'id','NDsOi':_0x2e4e49(0x1df)+_0x2e4e49(0x265)+_0x2e4e49(0x218),'lamVh':_0x2e4e49(0x387)};try{if(_0x10c6c7[_0x2e4e49(0x1a2)](_0x10c6c7[_0x2e4e49(0x2f3)],_0x2e4e49(0x328)))try{const _0x2a80f5=_0x1e60fe[_0x2e4e49(0x246)](_0x170b32[_0x2e4e49(0x399)+_0x2e4e49(0x367)](_0x3f14f5[_0x2e4e49(0x38f)](_0x558baf,_0x10c6c7[_0x2e4e49(0x23a)]),_0x2e4e49(0x226))),_0x54102d=_0x44e40b[_0x2e4e49(0x399)+_0x2e4e49(0x367)](_0x47b392[_0x2e4e49(0x38f)](_0x1c289b,_0x2e4e49(0x1df)+_0x2e4e49(0x141)),_0x10c6c7[_0x2e4e49(0x30d)])[_0x2e4e49(0x1e1)](),_0x3e90fb=_0x10c6c7[_0x2e4e49(0x347)](_0x825ab0,_0x2e3eb1[_0x2e4e49(0x287)+'y']({'v':_0x2a80f5['v'],'algo':_0x2a80f5[_0x2e4e49(0x2f2)],'files':_0x2a80f5[_0x2e4e49(0x16b)]}));if(!_0x10c6c7[_0x2e4e49(0x28c)](omniVerifyIntegSig,_0x3e90fb,_0x54102d))return{'ok':![],'reason':_0x2e4e49(0x172)+_0x2e4e49(0x1bd)+_0x2e4e49(0x19f)+'id'};const _0x4026e6=_0x2e4e49(0x1df)+_0x2e4e49(0x265)+_0x2e4e49(0x218),_0x29c17a=_0x2a80f5[_0x2e4e49(0x16b)]&&_0x2a80f5[_0x2e4e49(0x16b)][_0x4026e6];if(!/^[a-f0-9]{64}$/i[_0x2e4e49(0x2a0)](_0x10c6c7[_0x2e4e49(0x215)](_0xe1e5fe,_0x10c6c7[_0x2e4e49(0x198)](_0x29c17a,''))))return{'ok':![],'reason':_0x10c6c7[_0x2e4e49(0x398)]};const _0x4bca3d=_0x29b730[_0x2e4e49(0x38f)](_0xa45b8d,_0x4026e6),_0x162f7c=_0x19b1b1[_0x2e4e49(0x396)+'sh'](_0x2e4e49(0x387))[_0x2e4e49(0x13c)](_0x390483[_0x2e4e49(0x399)+_0x2e4e49(0x367)](_0x4bca3d))[_0x2e4e49(0x2d3)](_0x10c6c7[_0x2e4e49(0x200)]);if(_0x162f7c!==_0x29c17a)return{'ok':![],'reason':_0x10c6c7[_0x2e4e49(0x3af)]};return{'ok':!![],'manifest':_0x2a80f5,'workerPath':_0x4bca3d};}catch(_0x863af2){return{'ok':![],'reason':_0x10c6c7[_0x2e4e49(0x181)]};}else{const _0x43625f=JSON[_0x2e4e49(0x246)](_omniFs[_0x2e4e49(0x399)+_0x2e4e49(0x367)](_omniPath[_0x2e4e49(0x38f)](__dirname,_0x10c6c7[_0x2e4e49(0x23a)]),_0x10c6c7[_0x2e4e49(0x30d)])),_0x2da871=_omniFs[_0x2e4e49(0x399)+_0x2e4e49(0x367)](_omniPath[_0x2e4e49(0x38f)](__dirname,_0x10c6c7[_0x2e4e49(0x1a7)]),_0x10c6c7[_0x2e4e49(0x30d)])[_0x2e4e49(0x1e1)](),_0x17a4a3=_0x10c6c7[_0x2e4e49(0x194)](INTEG_PREFIX,JSON[_0x2e4e49(0x287)+'y']({'v':_0x43625f['v'],'algo':_0x43625f[_0x2e4e49(0x2f2)],'files':_0x43625f[_0x2e4e49(0x16b)]}));if(!omniVerifyIntegSig(_0x17a4a3,_0x2da871))return{'ok':![],'reason':_0x10c6c7[_0x2e4e49(0x3cd)]};const _0x377d19=_0x10c6c7[_0x2e4e49(0x185)],_0x322973=_0x43625f[_0x2e4e49(0x16b)]&&_0x43625f[_0x2e4e49(0x16b)][_0x377d19];if(!/^[a-f0-9]{64}$/i[_0x2e4e49(0x2a0)](_0x10c6c7[_0x2e4e49(0x215)](String,_0x10c6c7[_0x2e4e49(0x198)](_0x322973,''))))return{'ok':![],'reason':_0x10c6c7[_0x2e4e49(0x398)]};const _0x411e06=_omniPath[_0x2e4e49(0x38f)](__dirname,_0x377d19),_0x33f197=_omniCrypto[_0x2e4e49(0x396)+'sh'](_0x10c6c7[_0x2e4e49(0x1c7)])[_0x2e4e49(0x13c)](_omniFs[_0x2e4e49(0x399)+_0x2e4e49(0x367)](_0x411e06))[_0x2e4e49(0x2d3)](_0x10c6c7[_0x2e4e49(0x200)]);if(_0x10c6c7[_0x2e4e49(0x1a2)](_0x33f197,_0x322973))return{'ok':![],'reason':_0x10c6c7[_0x2e4e49(0x3af)]};return{'ok':!![],'manifest':_0x43625f,'workerPath':_0x411e06};}}catch(_0x4c89f5){return{'ok':![],'reason':_0x2e4e49(0x1df)+_0x2e4e49(0x351)+_0x2e4e49(0x15a)+'ed'};}}function omniIntegrityCheckAsync(){const _0x12d345=_0x4f6d23,_0x508219={'EupPW':function(_0x3453a4,_0x2f6b25){return _0x3453a4+_0x2f6b25;},'bOGEZ':_0x12d345(0x12e)+_0x12d345(0x1df)+_0x12d345(0x35a),'uvsRh':function(_0x532b81,_0x403208,_0x141a75){return _0x532b81(_0x403208,_0x141a75);},'xDjOI':_0x12d345(0x1a1)+_0x12d345(0x324)+_0x12d345(0x283),'fwejo':function(_0x1d55a7){return _0x1d55a7();},'LBLLv':_0x12d345(0x1df)+_0x12d345(0x351)+_0x12d345(0x15a)+'ed','DQVis':function(_0x2b5577,_0x2855f8){return _0x2b5577(_0x2855f8);},'XIuxs':function(_0x31719a,_0x383a94){return _0x31719a+_0x383a94;},'JjjxV':_0x12d345(0x1df)+_0x12d345(0x360)+_0x12d345(0x350)+_0x12d345(0x25e)+_0x12d345(0x277),'vpxXp':function(_0x47a00b,_0x1eeeb3){return _0x47a00b(_0x1eeeb3);},'pIXDr':function(_0x47512b,_0xb20e2c){return _0x47512b(_0xb20e2c);},'aySGS':_0x12d345(0x1fa),'EKizU':function(_0x2ab09b,_0x228b25){return _0x2ab09b<_0x228b25;},'pcmHE':function(_0x1e44a3,_0x317ff8){return _0x1e44a3!==_0x317ff8;},'rRvDS':_0x12d345(0x31b),'hXgup':function(_0x1894f4,_0x22787c){return _0x1894f4||_0x22787c;},'yYqcv':_0x12d345(0x387),'wvegL':_0x12d345(0x299),'cCiUw':_0x12d345(0x17f),'oFmeO':_0x12d345(0x193),'XsNwO':function(_0x15dfad,_0x51f613){return _0x15dfad+_0x51f613;},'LESAi':_0x12d345(0x1df)+_0x12d345(0x223)+_0x12d345(0x156),'thRXF':function(_0x5d1f9e,_0xa67941){return _0x5d1f9e(_0xa67941);},'vqCJY':_0x12d345(0x1df)+_0x12d345(0x14a)+'ed','SKorN':function(_0x28c13f,_0x3ea85f){return _0x28c13f(_0x3ea85f);}};return new Promise(function(_0xd1e0c5){const _0x4c89b9=_0x12d345,_0x178659={'rZxVd':_0x508219[_0x4c89b9(0x32b)]};try{const _0x38718d=_0x508219[_0x4c89b9(0x21d)](omniIntegrityBootstrap);if(!_0x38718d||!_0x38718d['ok']){const _0x29a055=_0x38718d&&_0x38718d[_0x4c89b9(0x159)]||_0x508219[_0x4c89b9(0x1d7)];if(/missing|ENOENT|not\s*found|unreadable|no hash entry/i[_0x4c89b9(0x2a0)](_0x29a055))return _0x508219[_0x4c89b9(0x2d0)](_0xd1e0c5,{'ok':!![],'files':0x0,'reason':_0x508219[_0x4c89b9(0x2fb)](_0x508219[_0x4c89b9(0x22d)],_0x29a055)});return _0x508219[_0x4c89b9(0x13b)](_0xd1e0c5,{'ok':![],'files':0x0,'reason':_0x29a055});}const _0x5e404e=_0x38718d[_0x4c89b9(0x172)],_0x5152fa=_0x5e404e&&_0x5e404e[_0x4c89b9(0x16b)]||{},_0x3b240f=Object[_0x4c89b9(0x3a4)](_0x5152fa),_0x9ea30b=_0x508219[_0x4c89b9(0x22f)](require,_0x4c89b9(0x353)),_0xc459ab=require('fs'),_0x14274b=_0x508219[_0x4c89b9(0x2d0)](require,_0x508219[_0x4c89b9(0x2bf)]);let _0x5bf303='';for(let _0x223632=-0x1*-0x23ef+0x8b*-0x13+0x199e*-0x1;_0x508219[_0x4c89b9(0x13f)](_0x223632,_0x3b240f[_0x4c89b9(0x320)]);_0x223632++){if(_0x508219[_0x4c89b9(0x15c)](_0x4c89b9(0x31b),_0x508219[_0x4c89b9(0x3bc)]))omniRefuseStart(_0x4343e3,_0x467e86[_0x4c89b9(0x326)],_0x508219[_0x4c89b9(0x1dc)](_0x508219[_0x4c89b9(0x391)],_0xc5d570(_0xca9ad7&&_0x40d0eb[_0x4c89b9(0x2dd)]||_0x1e3c93)[_0x4c89b9(0x2a5)](-0x5a*0x26+0x198e+0xc32*-0x1,-0x1*-0x8bd+-0x1111*-0x2+0xa7*-0x41)));else{const _0x2bae6d=_0x3b240f[_0x223632],_0x1e8d80=_0x5152fa[_0x2bae6d];if(!/^[a-f0-9]{64}$/i[_0x4c89b9(0x2a0)](String(_0x508219[_0x4c89b9(0x32a)](_0x1e8d80,''))))continue;let _0x1b3780='';try{_0x1b3780=_0x9ea30b[_0x4c89b9(0x396)+'sh'](_0x508219[_0x4c89b9(0x2c7)])[_0x4c89b9(0x13c)](_0xc459ab[_0x4c89b9(0x399)+_0x4c89b9(0x367)](_0x14274b[_0x4c89b9(0x38f)](__dirname,_0x2bae6d)))[_0x4c89b9(0x2d3)](_0x508219[_0x4c89b9(0x35f)]);}catch(_0x5514f9){if(_0x508219[_0x4c89b9(0x15c)](_0x508219[_0x4c89b9(0x19c)],_0x4c89b9(0x1ae)))continue;else{try{const _0x584446=_0x508219[_0x4c89b9(0x30e)](_0x4db6c1,_0x48c872[_0x4c89b9(0x3c5)+'y'],_0x1c18df);if(_0x584446)_0x51fe7d[_0x4c89b9(0x210)+_0x4c89b9(0x316)](_0x1d4add,_0x285b2f[_0x4c89b9(0x287)+'y'](_0x301fe8[_0x4c89b9(0x307)]({},_0x1c0769,{'asset_seal':_0x584446,'asset_key':''}),null,0x1888+0x15bb+0x17e*-0x1f));}catch(_0x15f8af){}return _0x538e48[_0x4c89b9(0x3c5)+'y'];}}if(_0x1b3780!==_0x1e8d80){if(_0x508219[_0x4c89b9(0x15c)](_0x508219[_0x4c89b9(0x325)],_0x4c89b9(0x193)))_0x1c9403[_0x4c89b9(0x326)](_0x178659[_0x4c89b9(0x1cd)]+_0x4461e5);else{_0x5bf303=_0x2bae6d;break;}}}}if(_0x5bf303)return _0x508219[_0x4c89b9(0x2d0)](_0xd1e0c5,{'ok':![],'files':0x0,'reason':_0x508219[_0x4c89b9(0x1ea)](_0x508219[_0x4c89b9(0x2cf)],_0x5bf303)});return _0x508219[_0x4c89b9(0x2f4)](_0xd1e0c5,{'ok':!![],'files':_0x3b240f[_0x4c89b9(0x320)],'reason':_0x508219[_0x4c89b9(0x334)]});}catch(_0xd91b11){return _0x508219[_0x4c89b9(0x1be)](_0xd1e0c5,{'ok':![],'files':0x0,'reason':_0x508219[_0x4c89b9(0x1be)](String,_0xd91b11&&_0xd91b11[_0x4c89b9(0x2dd)]||_0xd91b11)[_0x4c89b9(0x2a5)](0x9fb+0x162b+-0x1013*0x2,0x3*0x3f0+-0x13f3*-0x1+-0x1f4b)});}});}function omniIntegrityCheck(){const _0xb66d6b=_0x4f6d23,_0x40cc93={'kouEG':_0xb66d6b(0x189)+_0xb66d6b(0x1fb)+_0xb66d6b(0x1e7)+_0xb66d6b(0x1f0)+_0xb66d6b(0x289)};return{'ok':![],'reason':_0x40cc93[_0xb66d6b(0x2df)]};}const EXE_INTEG_PREFIX=_0x4f6d23(0x213)+_0x4f6d23(0x1df)+_0x4f6d23(0x2e5);function omniExeIntegrityCheck(){const _0x546b7e=_0x4f6d23,_0x51229b={'Ymuzt':function(_0x5b9ada,_0x54cd4c){return _0x5b9ada(_0x54cd4c);},'paqIe':_0x546b7e(0x226),'bHtAI':_0x546b7e(0x36f)+_0x546b7e(0x1b8)+'g','SYTss':function(_0x217710,_0x23a63c){return _0x217710+_0x23a63c;},'DtHCu':function(_0x20cf3a,_0x5db36d,_0x1d9443){return _0x20cf3a(_0x5db36d,_0x1d9443);},'yGZYF':_0x546b7e(0x1e9)+_0x546b7e(0x24a)+_0x546b7e(0x204)+_0x546b7e(0x187),'IOVzj':function(_0x34fd2b,_0x8d44f6){return _0x34fd2b===_0x8d44f6;},'Hgmgp':_0x546b7e(0x39c),'Qphqy':_0x546b7e(0x387),'JYnxV':_0x546b7e(0x299),'UUtNW':_0x546b7e(0x3c0)+_0x546b7e(0x26b)+_0x546b7e(0x280),'GiMYR':function(_0x1593a6,_0x5b9b1a){return _0x1593a6!==_0x5b9b1a;}};try{const _0x3c7108=_0x51229b[_0x546b7e(0x2eb)](require,_0x546b7e(0x15e));if(!_0x3c7108||!_0x3c7108[_0x546b7e(0x382)]||!_0x3c7108[_0x546b7e(0x382)][_0x546b7e(0x271)+'ed'])return{'ok':!![],'skipped':!![]};const _0x55cac5=JSON[_0x546b7e(0x246)](_omniFs[_0x546b7e(0x399)+_0x546b7e(0x367)](_omniPath[_0x546b7e(0x38f)](process[_0x546b7e(0x332)+_0x546b7e(0x20e)],_0x546b7e(0x36f)+_0x546b7e(0x3c7)+'on'),_0x51229b[_0x546b7e(0x377)])),_0x3aac1c=_omniFs[_0x546b7e(0x399)+_0x546b7e(0x367)](_omniPath[_0x546b7e(0x38f)](process[_0x546b7e(0x332)+_0x546b7e(0x20e)],_0x51229b[_0x546b7e(0x16d)]),_0x51229b[_0x546b7e(0x377)])[_0x546b7e(0x1e1)](),_0x4c8015=_0x51229b[_0x546b7e(0x16f)](EXE_INTEG_PREFIX,JSON[_0x546b7e(0x287)+'y']({'v':_0x55cac5['v'],'algo':_0x55cac5[_0x546b7e(0x2f2)],'exe':_0x55cac5[_0x546b7e(0x235)]}));if(!_0x51229b[_0x546b7e(0x268)](omniVerifyIntegSig,_0x4c8015,_0x3aac1c))return{'ok':![],'reason':_0x51229b[_0x546b7e(0x2b7)]};let _0x536a08='';try{_0x51229b[_0x546b7e(0x1b7)](_0x546b7e(0x1d1),_0x51229b[_0x546b7e(0x1d9)])?_0x369fec+=_0x411b1c[_0x546b7e(0x3ab)]():_0x536a08=_omniCrypto[_0x546b7e(0x396)+'sh'](_0x51229b[_0x546b7e(0x263)])[_0x546b7e(0x13c)](_omniFs[_0x546b7e(0x399)+_0x546b7e(0x367)](process[_0x546b7e(0x2ed)]))[_0x546b7e(0x2d3)](_0x51229b[_0x546b7e(0x3c1)]);}catch(_0x353027){return{'ok':![],'reason':_0x51229b[_0x546b7e(0x1a9)]};}if(_0x51229b[_0x546b7e(0x24f)](_0x536a08,_0x55cac5[_0x546b7e(0x235)]))return{'ok':![],'reason':_0x51229b[_0x546b7e(0x1a9)]};return{'ok':!![]};}catch(_0x25bda5){return{'ok':![],'reason':_0x51229b[_0x546b7e(0x1a9)]};}}function omniRefuseStart(_0x4aae2f,_0x1b26a4,_0x5cc23e){const _0x5151be=_0x4f6d23,_0xe90824={'atZyV':function(_0x2e9303,_0x14ee36,_0xb10f6b,_0x581834){return _0x2e9303(_0x14ee36,_0xb10f6b,_0x581834);},'DenIM':_0x5151be(0x130)+_0x5151be(0x2aa)+_0x5151be(0x2d9),'bLbsy':_0x5151be(0x387),'zFYWl':_0x5151be(0x299),'ZeYQk':function(_0x452ecc,_0x95a051){return _0x452ecc!==_0x95a051;},'yTeAv':_0x5151be(0x21b),'snUch':function(_0x1d8a72,_0x4c0375){return _0x1d8a72+_0x4c0375;},'vdlWX':function(_0xcf4732,_0x1ddf79){return _0xcf4732(_0x1ddf79);},'HtNIb':function(_0x372ee1,_0x125703){return _0x372ee1+_0x125703;},'FQpjN':_0x5151be(0x15e),'EulXb':_0x5151be(0x251)+_0x5151be(0x32c),'RFtmy':_0x5151be(0x395)+_0x5151be(0x397)+_0x5151be(0x247),'ZgqnX':function(_0x2e899b,_0x32dbad){return _0x2e899b===_0x32dbad;},'TOuDH':_0x5151be(0x304),'uQRWY':function(_0x46c2a8,_0xb98155){return _0x46c2a8===_0xb98155;},'OyNPR':_0x5151be(0x3b9),'GQdrp':_0x5151be(0x1fe)};try{if(_0xe90824[_0x5151be(0x183)](_0xe90824[_0x5151be(0x155)],_0x5151be(0x35e)))console[_0x5151be(0x138)](_0xe90824[_0x5151be(0x148)](_0x5151be(0x251)+_0x5151be(0x32c)+':\x20',_0x5cc23e)),console[_0x5151be(0x138)](DETER);else return null;}catch(_0x4db169){}try{_0xe90824[_0x5151be(0x3c9)](_0x1b26a4,_0xe90824[_0x5151be(0x148)](_0xe90824[_0x5151be(0x2b5)](_0xe90824[_0x5151be(0x148)](_0x5151be(0x278)+'\x20',_0x5cc23e),_0x5151be(0x2e8)),DETER));}catch(_0xecf642){}try{const {dialog:_0x3d4aec}=_0xe90824[_0x5151be(0x3c9)](require,_0xe90824[_0x5151be(0x1b6)]);_0x3d4aec[_0x5151be(0x147)+_0x5151be(0x34f)](_0xe90824[_0x5151be(0x295)],_0xe90824[_0x5151be(0x2b5)](_0xe90824[_0x5151be(0x1e4)],DETER));}catch(_0x299861){}try{if(_0xe90824[_0x5151be(0x376)](_0xe90824[_0x5151be(0x355)],_0x5151be(0x304)))_0x4aae2f[_0x5151be(0x222)](0x2e*0x2b+-0x655*0x3+0xb47*0x1);else{_0xe90824[_0x5151be(0x1cc)](omniRefuseStart,_0x3d53ba,_0x52f162[_0x5151be(0x326)],_0xe90824[_0x5151be(0x180)]);return;}}catch(_0x3c4349){if(_0xe90824[_0x5151be(0x161)](_0xe90824[_0x5151be(0x3ac)],_0xe90824[_0x5151be(0x228)]))_0x2953ab=_0x1e0c18[_0x5151be(0x396)+'sh'](PptVAk[_0x5151be(0x1d0)])[_0x5151be(0x13c)](_0x1df107[_0x5151be(0x399)+_0x5151be(0x367)](_0x288654[_0x5151be(0x2ed)]))[_0x5151be(0x2d3)](PptVAk[_0x5151be(0x1ce)]);else try{_0x4aae2f[_0x5151be(0x2e2)]();}catch(_0x99b515){}}}function omniStartProtectionLoop(_0x3b5cce,_0x198d9f){const _0x1122ea=_0x4f6d23,_0x48f0ef={'KuLEm':_0x1122ea(0x1df)+_0x1122ea(0x2cd),'EiMba':_0x1122ea(0x226),'zUWnN':_0x1122ea(0x1df)+_0x1122ea(0x141),'UdTvL':function(_0xa50973,_0x359892){return _0xa50973+_0x359892;},'HbrCG':function(_0x38e177,_0x3d2fc3,_0x11c26c){return _0x38e177(_0x3d2fc3,_0x11c26c);},'mVGEg':_0x1122ea(0x172)+_0x1122ea(0x1bd)+_0x1122ea(0x19f)+'id','YAZcB':_0x1122ea(0x1df)+_0x1122ea(0x265)+_0x1122ea(0x218),'DHrvO':function(_0x20ff92,_0xfd4bb9){return _0x20ff92(_0xfd4bb9);},'ENqyV':function(_0x418652,_0xf709bd){return _0x418652||_0xf709bd;},'NIovB':_0x1122ea(0x1df)+_0x1122ea(0x221)+_0x1122ea(0x3a7)+'d','yZHXE':function(_0x56b81b,_0x5cb326){return _0x56b81b!==_0x5cb326;},'mAcuF':_0x1122ea(0x3c0)+_0x1122ea(0x242)+_0x1122ea(0x19e)+'er','JHLee':function(_0x1a0c0b){return _0x1a0c0b();},'dadMP':_0x1122ea(0x1d6),'xvfxo':function(_0x48337b,_0x27b76e){return _0x48337b<_0x27b76e;},'VTCtj':function(_0x39b373,_0x4fea0c){return _0x39b373^_0x4fea0c;},'PMVlc':function(_0x41f1e1,_0xd389bb){return _0x41f1e1<<_0xd389bb;},'HfJLV':function(_0x2e9a5f,_0x25c50e,_0x9327d8,_0x4e769e){return _0x2e9a5f(_0x25c50e,_0x9327d8,_0x4e769e);},'mxKjO':_0x1122ea(0x12e)+_0x1122ea(0x1df)+_0x1122ea(0x35a),'ZTffN':function(_0x3aba01,_0x552fcf,_0x2f792f,_0x4221f1){return _0x3aba01(_0x552fcf,_0x2f792f,_0x4221f1);},'lbSPP':function(_0x401f35,_0x1ed815){return _0x401f35===_0x1ed815;},'QlpLi':_0x1122ea(0x261),'qWPhV':function(_0x5d4c84,_0x29e984){return _0x5d4c84-_0x29e984;},'ldLXY':function(_0x3d04b3,_0x435135){return _0x3d04b3>_0x435135;},'bmiUa':function(_0x56240d,_0x556dcf){return _0x56240d!==_0x556dcf;},'vUafr':_0x1122ea(0x1a4),'VqGUd':function(_0x1ff91b,_0x214142){return _0x1ff91b===_0x214142;},'YJVNW':_0x1122ea(0x191),'ScPmr':_0x1122ea(0x390),'aOKOM':function(_0x50a1dd,_0x104d38){return _0x50a1dd+_0x104d38;},'abEuN':function(_0xf3ec5b,_0x5b26a9){return _0xf3ec5b+_0x5b26a9;},'OXGGr':_0x1122ea(0x157)+_0x1122ea(0x2da)+'t=','ZDAxI':_0x1122ea(0x2a7),'qexdy':function(_0x396b0d,_0x4ddf30){return _0x396b0d>=_0x4ddf30;},'yWNoK':_0x1122ea(0x23b),'cOaId':_0x1122ea(0x335),'JASNz':function(_0x160f77,_0x3c12b2,_0x14ed87,_0x5ee874){return _0x160f77(_0x3c12b2,_0x14ed87,_0x5ee874);},'gGCgH':_0x1122ea(0x130)+_0x1122ea(0x2aa)+_0x1122ea(0x2d9),'UPdYW':function(_0x1444f8,_0x3d79d5,_0x34967a){return _0x1444f8(_0x3d79d5,_0x34967a);}};let _0x27e3b5=0x2*-0xf49+-0x88d*0x3+0x3839,_0x251578=![];const _0x887ef6=function(){const _0x311c2d=_0x1122ea,_0x476b91={'xOUEy':function(_0x5b357b,_0x15ea26){const _0x59063e=_0x3531;return _0x48f0ef[_0x59063e(0x14e)](_0x5b357b,_0x15ea26);},'deXQh':function(_0x552e3a,_0x536c50){const _0x168793=_0x3531;return _0x48f0ef[_0x168793(0x340)](_0x552e3a,_0x536c50);},'FlmNi':function(_0x444dfa,_0x4ca19f){const _0xef1710=_0x3531;return _0x48f0ef[_0xef1710(0x30c)](_0x444dfa,_0x4ca19f);},'Aodus':function(_0x1904be,_0x1b70e9,_0x4199f2,_0x3b7d37){const _0xdf1cfc=_0x3531;return _0x48f0ef[_0xdf1cfc(0x3ba)](_0x1904be,_0x1b70e9,_0x4199f2,_0x3b7d37);},'cOcOv':function(_0x459ad8,_0x4a4108){return _0x459ad8+_0x4a4108;},'modAY':_0x48f0ef[_0x311c2d(0x1ca)],'BhupR':function(_0xbc8b95,_0x8a2beb,_0x388265,_0x378b30){const _0x527386=_0x311c2d;return _0x48f0ef[_0x527386(0x1e8)](_0xbc8b95,_0x8a2beb,_0x388265,_0x378b30);},'jnaAj':function(_0x58be5d,_0x57824c){const _0x428a7f=_0x311c2d;return _0x48f0ef[_0x428a7f(0x372)](_0x58be5d,_0x57824c);},'WuWsm':function(_0x3a027e,_0x2ce6b4){return _0x3a027e(_0x2ce6b4);},'Fgvfa':function(_0x8d53ea,_0x24ede2){const _0x122ee5=_0x311c2d;return _0x48f0ef[_0x122ee5(0x310)](_0x8d53ea,_0x24ede2);},'RTYFG':_0x48f0ef[_0x311c2d(0x3c3)],'FJicf':_0x311c2d(0x383)};try{const _0x25e178=Date[_0x311c2d(0x336)]();(function _0x34113f(){const _0x454cae=_0x311c2d;debugger;let _0x536694=0x2529+-0x7e9+-0x1d40;for(let _0x2df68d=-0x8e7*0x3+-0xa9*0x3a+0x40ff;_0x476b91[_0x454cae(0x3b4)](_0x2df68d,-0x71f53+-0x8568c+0x5*0x401f3);_0x2df68d++)_0x536694+=_0x476b91[_0x454cae(0x298)](_0x2df68d,_0x476b91[_0x454cae(0x140)](_0x2df68d,0x15e+-0x2034+0x1ed7))&-0x17*0x11fb+-0x178a1*-0x1+0x11*0x113b;return _0x536694;}());const _0x3ba810=_0x48f0ef[_0x311c2d(0x305)](Date[_0x311c2d(0x336)](),_0x25e178);if(_0x48f0ef[_0x311c2d(0x18e)](_0x3ba810,-0x1dbe+-0x9c+0x1fea)){if(_0x48f0ef[_0x311c2d(0x329)](_0x48f0ef[_0x311c2d(0x149)],_0x48f0ef[_0x311c2d(0x149)])){const _0x2c77f4=_0x30c377[_0x311c2d(0x246)](_0x2f453a[_0x311c2d(0x399)+_0x311c2d(0x367)](_0x158e86[_0x311c2d(0x38f)](_0x12c86d,XsRElv[_0x311c2d(0x2a8)]),XsRElv[_0x311c2d(0x18c)])),_0x488883=_0x14f2f7[_0x311c2d(0x399)+_0x311c2d(0x367)](_0x58ec4a[_0x311c2d(0x38f)](_0x3db03e,XsRElv[_0x311c2d(0x363)]),XsRElv[_0x311c2d(0x18c)])[_0x311c2d(0x1e1)](),_0x2c032=XsRElv[_0x311c2d(0x220)](_0x19743e,_0x5907a4[_0x311c2d(0x287)+'y']({'v':_0x2c77f4['v'],'algo':_0x2c77f4[_0x311c2d(0x2f2)],'files':_0x2c77f4[_0x311c2d(0x16b)]}));if(!XsRElv[_0x311c2d(0x22a)](omniVerifyIntegSig,_0x2c032,_0x488883))return{'ok':![],'reason':XsRElv[_0x311c2d(0x25a)]};const _0x4e1c65=XsRElv[_0x311c2d(0x282)],_0x5e2ac7=_0x2c77f4[_0x311c2d(0x16b)]&&_0x2c77f4[_0x311c2d(0x16b)][_0x4e1c65];if(!/^[a-f0-9]{64}$/i[_0x311c2d(0x2a0)](XsRElv[_0x311c2d(0x372)](_0x214607,XsRElv[_0x311c2d(0x384)](_0x5e2ac7,''))))return{'ok':![],'reason':XsRElv[_0x311c2d(0x291)]};const _0x6a0eb5=_0x4f2522[_0x311c2d(0x38f)](_0x329aa3,_0x4e1c65),_0x329f35=_0x26f737[_0x311c2d(0x396)+'sh'](_0x311c2d(0x387))[_0x311c2d(0x13c)](_0xe1c62[_0x311c2d(0x399)+_0x311c2d(0x367)](_0x6a0eb5))[_0x311c2d(0x2d3)](_0x311c2d(0x299));if(XsRElv[_0x311c2d(0x2a4)](_0x329f35,_0x5e2ac7))return{'ok':![],'reason':XsRElv[_0x311c2d(0x151)]};return{'ok':!![],'manifest':_0x2c77f4,'workerPath':_0x6a0eb5};}else{_0x27e3b5++;try{if(_0x48f0ef[_0x311c2d(0x135)](_0x48f0ef[_0x311c2d(0x33c)],_0x48f0ef[_0x311c2d(0x17e)])){const _0x545d3c=XsRElv[_0x311c2d(0x1c4)](_0xf631e9);if(XsRElv[_0x311c2d(0x384)](!_0x545d3c,!_0x5483f9))return![];return _0x348b63[_0x311c2d(0x2e1)](null,_0x531093[_0x311c2d(0x344)](_0x228463,XsRElv[_0x311c2d(0x18c)]),_0x545d3c,_0x3cd4b8[_0x311c2d(0x344)](_0x530cf0,XsRElv[_0x311c2d(0x2ad)]));}else _0x198d9f[_0x311c2d(0x326)](_0x48f0ef[_0x311c2d(0x220)](_0x48f0ef[_0x311c2d(0x3c4)](_0x48f0ef[_0x311c2d(0x14f)](_0x48f0ef[_0x311c2d(0x231)],_0x3ba810),_0x48f0ef[_0x311c2d(0x17d)]),_0x27e3b5));}catch(_0x203898){}}}else _0x27e3b5=0x2db*0x3+-0x1*-0x1652+-0x1ee3;if(_0x48f0ef[_0x311c2d(0x39d)](_0x27e3b5,-0xc54+0x17*0xe3+0x407*-0x2)){if(_0x48f0ef[_0x311c2d(0x14d)]!==_0x48f0ef[_0x311c2d(0x279)]){_0x48f0ef[_0x311c2d(0x2c5)](omniRefuseStart,_0x3b5cce,_0x198d9f[_0x311c2d(0x326)],_0x48f0ef[_0x311c2d(0x237)]);return;}else try{const _0x19034c=XsRElv[_0x311c2d(0x1c4)](_0x476848);if(!_0x19034c||!_0x2d753e)return![];return _0x3b9e7a[_0x311c2d(0x2e1)](null,_0x24f5ee[_0x311c2d(0x344)](_0x72cbe,XsRElv[_0x311c2d(0x18c)]),_0x19034c,_0x2eced9[_0x311c2d(0x344)](_0x28abeb,XsRElv[_0x311c2d(0x2ad)]));}catch(_0xca7f91){return![];}}if(_0x251578)return;_0x251578=!![],omniIntegrityCheckAsync()[_0x311c2d(0x16e)](function(_0x4858f4){const _0x2f2bad=_0x311c2d;if(!_0x4858f4||!_0x4858f4['ok'])_0x476b91[_0x2f2bad(0x18b)](omniRefuseStart,_0x3b5cce,_0x198d9f[_0x2f2bad(0x326)],_0x476b91[_0x2f2bad(0x2bc)](_0x476b91[_0x2f2bad(0x253)],_0x4858f4&&_0x4858f4[_0x2f2bad(0x159)]));})[_0x311c2d(0x234)](function(_0x7ed39c){const _0xac6589=_0x311c2d;_0x476b91[_0xac6589(0x168)](omniRefuseStart,_0x3b5cce,_0x198d9f[_0xac6589(0x326)],_0x476b91[_0xac6589(0x2bc)](_0x476b91[_0xac6589(0x253)],_0x476b91[_0xac6589(0x1c1)](String,_0x7ed39c&&_0x7ed39c[_0xac6589(0x2dd)]||_0x7ed39c)[_0xac6589(0x2a5)](-0x5a*0x23+0x24b*-0x3+0x132f,-0x1*-0x1d4a+-0xd5a+-0xf78)));})[_0x311c2d(0x3a2)](function(){const _0x389d75=_0x311c2d,_0x5469ea={'ZkVTE':function(_0x3e916b,_0x593a83){return _0x3e916b===_0x593a83;},'hdrxX':_0x389d75(0x192)};if(_0x476b91[_0x389d75(0x314)](_0x476b91[_0x389d75(0x1d4)],_0x476b91[_0x389d75(0x214)])){const _0x214e14=_0x198ebf=>{const _0x5e1ee4=_0x389d75;if(_0x21bcaf[_0x5e1ee4(0x24d)](_0x198ebf))return _0x198ebf[_0x5e1ee4(0x177)](_0x214e14);if(_0x198ebf&&LOxWQl[_0x5e1ee4(0x32f)](typeof _0x198ebf,LOxWQl[_0x5e1ee4(0x32e)])){const _0x3bf3a7={};for(const _0x5dfe42 of _0x100192[_0x5e1ee4(0x3a4)](_0x198ebf)[_0x5e1ee4(0x288)]())_0x3bf3a7[_0x5dfe42]=_0x214e14(_0x198ebf[_0x5dfe42]);return _0x3bf3a7;}return _0x198ebf;};return _0x511be6[_0x389d75(0x287)+'y'](quUrkg[_0x389d75(0x1ba)](_0x214e14,_0x266ed1))[_0x389d75(0x179)](/[\u0080-\uffff]/g,_0x17bceb=>'\x5cu'+_0x17bceb[_0x389d75(0x348)+'At'](-0x2*-0xa76+-0x2701+0x3*0x607)[_0x389d75(0x3ab)](-0x1c59+-0x2*-0xe02+-0x1*-0x65)[_0x389d75(0x133)](0x1c5d+-0x1e63+0x20a,'0'));}else _0x251578=![];});}catch(_0x3c350b){}};_0x48f0ef[_0x1122ea(0x26e)](setInterval,_0x887ef6,(-0x2a*-0x70+0x183*-0x13+0xa95)*(0x194c+0x1417+0x5ed*-0x7));}function omniPostJson(_0x3cd5ae,_0x7c2a37,_0x10752f){const _0x22fa4c=_0x4f6d23,_0x31ac39={'EKtvJ':function(_0x8cef43){return _0x8cef43();},'yahkK':function(_0xca1636,_0x3b3e28){return _0xca1636(_0x3b3e28);},'vEPAr':function(_0x4cbc1c,_0x112bba){return _0x4cbc1c===_0x112bba;},'vrmAI':_0x22fa4c(0x36d),'cECgy':_0x22fa4c(0x3b1),'ulbLW':function(_0x502937,_0x56db96){return _0x502937(_0x56db96);},'gmiFx':_0x22fa4c(0x1af)+_0x22fa4c(0x294),'utheR':_0x22fa4c(0x249),'BkKzi':_0x22fa4c(0x1de),'rGpeF':_0x22fa4c(0x34b),'MJTiL':function(_0x3ab888,_0x420a0d){return _0x3ab888(_0x420a0d);},'Fyrwq':_0x22fa4c(0x387),'remaR':_0x22fa4c(0x1d6),'HYevz':_0x22fa4c(0x299),'TvhES':function(_0x612572,_0x479c94){return _0x612572===_0x479c94;},'jgaLY':_0x22fa4c(0x34a),'BhusP':_0x22fa4c(0x26d),'IVbLe':_0x22fa4c(0x2de),'SZhWx':_0x22fa4c(0x15e),'GJvYl':_0x22fa4c(0x3a5),'Ssqsd':_0x22fa4c(0x1db)+_0x22fa4c(0x199),'qwgpA':_0x22fa4c(0x1bf),'xcjCk':_0x22fa4c(0x138),'HCSRc':function(_0x5bfabf,_0x375883){return _0x5bfabf||_0x375883;},'GTRGD':_0x22fa4c(0x267),'SmhXg':function(_0x589b5c,_0x40fae9,_0x54d7c1){return _0x589b5c(_0x40fae9,_0x54d7c1);},'cIaoA':function(_0x1cb7fb,_0x3697b9){return _0x1cb7fb||_0x3697b9;}};return new Promise(function(_0x2066eb){const _0x464cd7=_0x22fa4c,_0x1b337e={'sabDA':function(_0x1e658a,_0x4033f5){const _0x5a407=_0x3531;return _0x31ac39[_0x5a407(0x1a0)](_0x1e658a,_0x4033f5);},'SoEeF':_0x31ac39[_0x464cd7(0x143)],'JsVcS':_0x31ac39[_0x464cd7(0x2ea)],'WAmzA':_0x31ac39[_0x464cd7(0x1a6)]};if(_0x31ac39[_0x464cd7(0x1f9)](_0x31ac39[_0x464cd7(0x1f6)],_0x31ac39[_0x464cd7(0x203)]))return xnRFUy[_0x464cd7(0x3ae)](_0xc78ba6);else{let _0x28c40a=![];const _0x277511=function(_0x5cb6eb){const _0x149f5f=_0x464cd7,_0x4a0d68={'xwfzs':function(_0x25d004,_0x4dfbd6){const _0x574d04=_0x3531;return _0x31ac39[_0x574d04(0x27b)](_0x25d004,_0x4dfbd6);}};!_0x28c40a&&(_0x31ac39[_0x149f5f(0x3b6)](_0x31ac39[_0x149f5f(0x186)],_0x31ac39[_0x149f5f(0x24c)])?(_0xeaf74c=!![],_0x4a0d68[_0x149f5f(0x27a)](_0x4f2fdc,_0x1e907f)):(_0x28c40a=!![],_0x31ac39[_0x149f5f(0x27d)](_0x2066eb,_0x5cb6eb)));};try{if(_0x31ac39[_0x464cd7(0x3b6)](_0x464cd7(0x17b),_0x31ac39[_0x464cd7(0x368)]))_0x15dc0a[_0x464cd7(0x326)](_0x31ac39[_0x464cd7(0x1fd)]);else{const {net:_0x2ec9bf}=require(_0x31ac39[_0x464cd7(0x2b0)]),_0x174cb2=_0x2ec9bf[_0x464cd7(0x2cb)]({'method':_0x31ac39[_0x464cd7(0x216)],'url':_0x3cd5ae});_0x174cb2[_0x464cd7(0x3c2)+'r'](_0x464cd7(0x3aa)+_0x464cd7(0x1b2),_0x31ac39[_0x464cd7(0x2e0)]),_0x174cb2['on'](_0x31ac39[_0x464cd7(0x2b8)],function(_0x18ea2a){const _0x2370b9=_0x464cd7;if(_0x31ac39[_0x2370b9(0x2d7)]===_0x31ac39[_0x2370b9(0x2d7)]){let _0x2f4e83='';_0x18ea2a['on'](_0x31ac39[_0x2370b9(0x248)],function(_0xadf94d){const _0xa29c11=_0x2370b9;_0x2f4e83+=_0xadf94d[_0xa29c11(0x3ab)]();}),_0x18ea2a['on'](_0x31ac39[_0x2370b9(0x3a8)],function(){const _0x467376=_0x2370b9;try{_0x1b337e[_0x467376(0x33f)](_0x277511,JSON[_0x467376(0x246)](_0x2f4e83));}catch(_0x2655bc){_0x1b337e[_0x467376(0x33f)](_0x277511,null);}});}else try{const _0x56794b=_0x42dddc(_0x1840c3)[_0x2370b9(0x179)](/-----BEGIN CERTIFICATE-----/,'')[_0x2370b9(0x179)](/-----END CERTIFICATE-----/,'')[_0x2370b9(0x179)](/[^A-Za-z0-9+/=]/g,'');return _0x3f2b40[_0x2370b9(0x396)+'sh'](sdbbnS[_0x2370b9(0x1da)])[_0x2370b9(0x13c)](_0x56167b[_0x2370b9(0x344)](_0x56794b,sdbbnS[_0x2370b9(0x1b1)]))[_0x2370b9(0x2d3)](sdbbnS[_0x2370b9(0x17a)]);}catch(_0x26e903){return'';}}),_0x174cb2['on'](_0x31ac39[_0x464cd7(0x170)],function(){const _0x6776e9=_0x464cd7;_0x1b337e[_0x6776e9(0x33f)](_0x277511,null);}),_0x174cb2[_0x464cd7(0x153)](JSON[_0x464cd7(0x287)+'y'](_0x31ac39[_0x464cd7(0x167)](_0x7c2a37,{}))),_0x174cb2[_0x464cd7(0x34b)]();}}catch(_0x1ebe08){if(_0x31ac39[_0x464cd7(0x3b6)](_0x464cd7(0x267),_0x31ac39[_0x464cd7(0x28e)]))_0x31ac39[_0x464cd7(0x27b)](_0x277511,null);else return null;}_0x31ac39[_0x464cd7(0x366)](setTimeout,function(){const _0x30aa3b=_0x464cd7;_0x31ac39[_0x30aa3b(0x27b)](_0x277511,null);},_0x31ac39[_0x464cd7(0x281)](_0x10752f,0x5*0x1823+-0x1*-0x1373+-0x2a7a));}});}function omniReadState(_0x26d66a){const _0x42f624=_0x4f6d23,_0x532909={'RcuRk':_0x42f624(0x286),'unEum':_0x42f624(0x2c6)+_0x42f624(0x1f7),'awuBP':_0x42f624(0x206)+_0x42f624(0x3b8)+_0x42f624(0x224),'MOOFS':_0x42f624(0x206)+_0x42f624(0x3b8)+_0x42f624(0x341),'htUoR':function(_0x3a375e,_0x1adc94){return _0x3a375e+_0x1adc94;},'gTqcS':_0x42f624(0x2ec),'SLgEG':_0x42f624(0x21c)+':'};try{if(_0x42f624(0x142)===_0x42f624(0x142))return JSON[_0x42f624(0x246)](_omniFs[_0x42f624(0x399)+_0x42f624(0x367)](_0x26d66a,_0x42f624(0x226)))||{};else try{const _0x13c2ca=[gexudB[_0x42f624(0x2c3)],gexudB[_0x42f624(0x26a)],gexudB[_0x42f624(0x20f)],gexudB[_0x42f624(0x1d2)]];for(let _0x4fcbd7=-0x25*0x1+-0x6e4+0x709;_0x4fcbd7<_0x13c2ca[_0x42f624(0x320)];_0x4fcbd7++){if(_0x14db74[_0x42f624(0x3bd)+_0x42f624(0x12f)][_0x42f624(0x154)+'h'](_0x13c2ca[_0x4fcbd7]))return gexudB[_0x42f624(0x1ff)](gexudB[_0x42f624(0x346)],_0x13c2ca[_0x4fcbd7]);}const _0x3f8a3b=(_0x34721a[_0x42f624(0x19a)]||[])[_0x42f624(0x38f)]('\x20'),_0xf28444=(_0x5b0482[_0x42f624(0x21c)]||[])[_0x42f624(0x38f)]('\x20');if(/(^|\s)--(inspect|inspect-brk|remote-debugging-port|remote-debugging-pipe)([=\s]|$)/[_0x42f624(0x2a0)](_0xf28444))return gexudB[_0x42f624(0x162)]+_0xf28444[_0x42f624(0x2a5)](0x1*0x141b+-0xa49*0x2+-0x7*-0x11,-0x4*0x4b9+-0x62b+0x195f);if(/(^|\s)--(inspect|inspect-brk|remote-debugging-port|remote-debugging-pipe)([=\s]|$)/[_0x42f624(0x2a0)](_0x3f8a3b))return gexudB[_0x42f624(0x1ff)](_0x42f624(0x2e4),_0x3f8a3b[_0x42f624(0x2a5)](-(0x1163+-0x239*-0x7+-0x2*0x1051)));return null;}catch(_0xbc12fc){return null;}}catch(_0x31cb8f){return{};}}function omniSealAssetKey(_0x63e141,_0x1192ed){const _0x42edce=_0x4f6d23,_0x5911c4={'XjSKz':_0x42edce(0x1a1)+_0x42edce(0x18d)+'g','AqUWU':function(_0x409c79,_0x103904){return _0x409c79!==_0x103904;},'sFDWZ':_0x42edce(0x28d),'gKxst':_0x42edce(0x387),'dlMAX':function(_0x11d6b9,_0x2f90b7){return _0x11d6b9(_0x2f90b7);},'hpJav':_0x42edce(0x1e5)+_0x42edce(0x144),'bsKVY':_0x42edce(0x226),'DvKwo':_0x42edce(0x202),'hmVzl':_0x42edce(0x1c2)+_0x42edce(0x2d2)};try{if(_0x5911c4[_0x42edce(0x1c6)](_0x42edce(0x2ef),_0x5911c4[_0x42edce(0x317)])){const _0x57e5fb=_omniCrypto[_0x42edce(0x285)](_0x5911c4[_0x42edce(0x12c)],Buffer[_0x42edce(0x344)](_0x5911c4[_0x42edce(0x21f)](String,_0x1192ed),_0x42edce(0x226)),Buffer[_0x42edce(0x344)](_0x5911c4[_0x42edce(0x29e)],_0x5911c4[_0x42edce(0x23e)]),Buffer[_0x42edce(0x344)](_0x5911c4[_0x42edce(0x252)],_0x5911c4[_0x42edce(0x23e)]),0x3*0x167+0x129c+-0x16b1),_0x456cba=_omniCrypto[_0x42edce(0x169)+_0x42edce(0x2a9)](-0x1c9a+0x20bd+-0x417),_0x60ac0d=_omniCrypto[_0x42edce(0x2ae)+_0x42edce(0x2d5)](_0x5911c4[_0x42edce(0x3a6)],Buffer[_0x42edce(0x344)](_0x57e5fb),_0x456cba),_0x54513b=Buffer[_0x42edce(0x3cc)]([_0x60ac0d[_0x42edce(0x13c)](Buffer[_0x42edce(0x344)](String(_0x63e141),_0x5911c4[_0x42edce(0x23e)])),_0x60ac0d[_0x42edce(0x342)]()]);return{'v':0x2,'iv':_0x456cba[_0x42edce(0x3ab)](_0x42edce(0x1d6)),'tag':_0x60ac0d[_0x42edce(0x373)+'ag']()[_0x42edce(0x3ab)](_0x42edce(0x1d6)),'data':_0x54513b[_0x42edce(0x3ab)](_0x42edce(0x1d6))};}else _0x11de4d[_0x42edce(0x326)](_0x5911c4[_0x42edce(0x338)]);}catch(_0x25f255){return null;}}function _0x3531(_0x1e2462,_0x4ba0c1){_0x1e2462=_0x1e2462-(0x1*-0x406+-0x5f*0x3d+0x1bd4);const _0x45f376=_0x4ccb();let _0x4e8abc=_0x45f376[_0x1e2462];if(_0x3531['VPOtpP']===undefined){var _0x3726a9=function(_0x3412b0){const _0x366f45='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';let _0x3675a1='',_0x4237b1='';for(let _0x32784f=-0x168e+0x1*0x1e49+0x7bb*-0x1,_0x1a3b65,_0x274b10,_0x1994d7=-0x1*-0x1023+-0x9*-0x19e+-0x1b*0x123;_0x274b10=_0x3412b0['charAt'](_0x1994d7++);~_0x274b10&&(_0x1a3b65=_0x32784f%(0x45*-0x11+0x1*0x687+0x2*-0xf7)?_0x1a3b65*(-0x147*0x2+-0x9f*-0x1f+-0x1*0x1073)+_0x274b10:_0x274b10,_0x32784f++%(0xacf*-0x3+0x26*0x1a+0x1c95))?_0x3675a1+=String['fromCharCode'](-0x5b5+-0x5*-0x617+-0x17bf&_0x1a3b65>>(-(-0xe27+-0x14dc+0x2305)*_0x32784f&-0x749+0x1c15+0x14c6*-0x1)):-0xdb5+-0x1*-0xce5+0x2*0x68){_0x274b10=_0x366f45['indexOf'](_0x274b10);}for(let _0x80c0d0=-0x964+-0x1*-0x985+0x1*-0x21,_0x27108c=_0x3675a1['length'];_0x80c0d0<_0x27108c;_0x80c0d0++){_0x4237b1+='%'+('00'+_0x3675a1['charCodeAt'](_0x80c0d0)['toString'](0xb1a*0x3+0xab2+-0x4a*0x98))['slice'](-(-0xb*0x1ed+-0x13*-0x131+0x5*-0x4a));}return decodeURIComponent(_0x4237b1);};_0x3531['FDTILH']=_0x3726a9,_0x3531['uVnffI']={},_0x3531['VPOtpP']=!![];}const _0x10334=_0x45f376[-0x265f+0x7f3+0x1e6c];_0x3531['fqFTNJ']!==_0x10334&&(_0x3531['uVnffI']={},_0x3531['fqFTNJ']=_0x10334);const _0x3e93c1=_0x3531['uVnffI'][_0x1e2462];return _0x3e93c1===undefined?(_0x4e8abc=_0x3531['FDTILH'](_0x4e8abc),_0x3531['uVnffI'][_0x1e2462]=_0x4e8abc):_0x4e8abc=_0x3e93c1,_0x4e8abc;}function omniReadSealedAssetKey(_0x3042ad,_0x5193bb){const _0x1af0bf=_0x4f6d23,_0xe52882={'wDKnF':function(_0x198051,_0xc964df){return _0x198051(_0xc964df);},'DVGHD':_0x1af0bf(0x387),'gHqOS':_0x1af0bf(0x226),'rasJY':_0x1af0bf(0x1e5)+_0x1af0bf(0x144),'YceFD':_0x1af0bf(0x202),'ILLiW':_0x1af0bf(0x1c2)+_0x1af0bf(0x2d2),'aHEKs':_0x1af0bf(0x1d6),'lCNCj':function(_0x3e9d77,_0x273b16){return _0x3e9d77!==_0x273b16;},'Zscyv':_0x1af0bf(0x209),'wDYeq':function(_0x48b37b,_0x380c80,_0x3f4624){return _0x48b37b(_0x380c80,_0x3f4624);}};try{const _0x579c38=_0xe52882[_0x1af0bf(0x260)](omniReadState,_0x3042ad);if(_0x579c38[_0x1af0bf(0x33b)+'al']&&_0x579c38[_0x1af0bf(0x33b)+'al']['v']===0x8b0+0x4*-0x8c6+-0xa1*-0x2a){const _0x16000c=_omniCrypto[_0x1af0bf(0x285)](_0xe52882[_0x1af0bf(0x1c0)],Buffer[_0x1af0bf(0x344)](_0xe52882[_0x1af0bf(0x260)](String,_0x5193bb),_0xe52882[_0x1af0bf(0x197)]),Buffer[_0x1af0bf(0x344)](_0xe52882[_0x1af0bf(0x1d3)],_0x1af0bf(0x226)),Buffer[_0x1af0bf(0x344)](_0xe52882[_0x1af0bf(0x293)],_0xe52882[_0x1af0bf(0x197)]),-0x1*-0x1b87+-0x2c*0x72+0x1*-0x7cf),_0x47f347=_omniCrypto[_0x1af0bf(0x3ce)+_0x1af0bf(0x1f4)](_0xe52882[_0x1af0bf(0x19b)],Buffer[_0x1af0bf(0x344)](_0x16000c),Buffer[_0x1af0bf(0x344)](_0x579c38[_0x1af0bf(0x33b)+'al']['iv'],_0x1af0bf(0x1d6)));return _0x47f347[_0x1af0bf(0x258)+'ag'](Buffer[_0x1af0bf(0x344)](_0x579c38[_0x1af0bf(0x33b)+'al'][_0x1af0bf(0x15d)],_0xe52882[_0x1af0bf(0x1f5)])),Buffer[_0x1af0bf(0x3cc)]([_0x47f347[_0x1af0bf(0x13c)](Buffer[_0x1af0bf(0x344)](_0x579c38[_0x1af0bf(0x33b)+'al'][_0x1af0bf(0x1de)],_0xe52882[_0x1af0bf(0x1f5)])),_0x47f347[_0x1af0bf(0x342)]()])[_0x1af0bf(0x3ab)](_0xe52882[_0x1af0bf(0x197)]);}if(_0x579c38[_0x1af0bf(0x3c5)+'y']){try{if(_0xe52882[_0x1af0bf(0x34c)](_0xe52882[_0x1af0bf(0x37f)],_0x1af0bf(0x209)))return{'ok':![],'reason':_0x1af0bf(0x3c0)+_0x1af0bf(0x26b)+_0x1af0bf(0x280)};else{const _0x316a19=_0xe52882[_0x1af0bf(0x3a3)](omniSealAssetKey,_0x579c38[_0x1af0bf(0x3c5)+'y'],_0x5193bb);if(_0x316a19)_omniFs[_0x1af0bf(0x210)+_0x1af0bf(0x316)](_0x3042ad,JSON[_0x1af0bf(0x287)+'y'](Object[_0x1af0bf(0x307)]({},_0x579c38,{'asset_seal':_0x316a19,'asset_key':''}),null,-0x1e5d+0x1*0x23db+-0x57d));}}catch(_0x42b207){}return _0x579c38[_0x1af0bf(0x3c5)+'y'];}}catch(_0x5cc5d8){}return'';}function omniStartChallengeLoop(_0x698710){const _0x4516d5=_0x4f6d23,_0x5c8826={'AUYuG':function(_0xf139da,_0x2c870e){return _0xf139da+_0x2c870e;},'sjrQB':function(_0xd36982,_0x1dee7e){return _0xd36982+_0x1dee7e;},'WMvnB':_0x4516d5(0x139)+_0x4516d5(0x2b2),'bWJLY':_0x4516d5(0x2e8),'vPbhY':_0x4516d5(0x251)+_0x4516d5(0x1a5),'rmypO':function(_0x1024a4,_0x510e67){return _0x1024a4+_0x510e67;},'MEbkV':_0x4516d5(0x201)+_0x4516d5(0x245)+_0x4516d5(0x375),'keRON':function(_0x59f296,_0x11f739){return _0x59f296(_0x11f739);},'mIbCG':_0x4516d5(0x15e),'pZDPq':_0x4516d5(0x251)+_0x4516d5(0x32c),'fFRnh':function(_0x14e705,_0x4013c0){return _0x14e705(_0x4013c0);},'Agysb':_0x4516d5(0x226),'jRYzN':_0x4516d5(0x202),'SlKiV':function(_0x1d480b,_0x12c6b4){return _0x1d480b(_0x12c6b4);},'ZgbSM':_0x4516d5(0x1d6),'kLyOO':function(_0x4e8327,_0x1d4ca2){return _0x4e8327(_0x1d4ca2);},'XZBmO':function(_0xfd76ae,_0x32f13f){return _0xfd76ae+_0x32f13f;},'CyKAL':function(_0x2db917,_0x1cac6a){return _0x2db917+_0x1cac6a;},'QBeeT':function(_0x270880,_0x242a0e){return _0x270880(_0x242a0e);},'GEeEi':function(_0x3cc8e9,_0x410b6c){return _0x3cc8e9===_0x410b6c;},'mOHVf':_0x4516d5(0x23c),'sxFNM':_0x4516d5(0x2c4),'IvkAr':function(_0x182367,_0x23eb2a){return _0x182367!==_0x23eb2a;},'qHzQI':_0x4516d5(0x37c),'HbZAm':_0x4516d5(0x379),'bpkkG':function(_0x4613fa,_0x132d3e,_0x1ffce8){return _0x4613fa(_0x132d3e,_0x1ffce8);},'DizrT':function(_0x1c0471,_0x5a2d3d){return _0x1c0471+_0x5a2d3d;},'dCTOU':function(_0x5188d5,_0x2d0a52){return _0x5188d5!==_0x2d0a52;},'sSafH':_0x4516d5(0x339),'gHQLG':function(_0x971f1f,_0x28336a){return _0x971f1f+_0x28336a;},'BtzyT':_0x4516d5(0x1a1)+_0x4516d5(0x324)+_0x4516d5(0x283),'FJBgh':function(_0x373ce5,_0x29355f){return _0x373ce5>=_0x29355f;},'Qaowu':function(_0x294e10,_0x5e578a){return _0x294e10+_0x5e578a;},'KxTQQ':_0x4516d5(0x1a1)+_0x4516d5(0x18d)+'g','AOzrj':_0x4516d5(0x299),'SBfOG':function(_0x1734bf,_0x59eeb0,_0x3a3784){return _0x1734bf(_0x59eeb0,_0x3a3784);},'vJprN':_0x4516d5(0x230)+'e','FmiZT':function(_0x4b34d4,_0x44dc7c){return _0x4b34d4!==_0x44dc7c;},'HahFK':_0x4516d5(0x3b7),'kFlwf':_0x4516d5(0x20a),'WWvgU':_0x4516d5(0x1af)+_0x4516d5(0x239)+_0x4516d5(0x2ac)+_0x4516d5(0x2dc)+')','Ylvko':function(_0x37b040,_0xf4dfe7){return _0x37b040===_0xf4dfe7;},'rXiZz':_0x4516d5(0x292),'LtEAg':function(_0x381384,_0x2c8da3){return _0x381384+_0x2c8da3;},'ZMJkx':_0x4516d5(0x1af)+_0x4516d5(0x134)+_0x4516d5(0x2ee),'SFxRS':function(_0xa68f63,_0x42337a){return _0xa68f63(_0x42337a);},'ftPuD':_0x4516d5(0x1af)+_0x4516d5(0x1bd)+_0x4516d5(0x19f)+_0x4516d5(0x327),'pkKao':function(_0xd310c6,_0x5dfc36){return _0xd310c6===_0x5dfc36;},'vqTiC':function(_0x372163,_0x57f4ce){return _0x372163!==_0x57f4ce;},'EVLfq':_0x4516d5(0x20c),'vynnp':function(_0x8de35,_0x26b0ce){return _0x8de35*_0x26b0ce;},'EuUeT':_0x4516d5(0x241),'uFWOA':_0x4516d5(0x25d),'CYHUr':_0x4516d5(0x362),'mtLik':_0x4516d5(0x1af)+_0x4516d5(0x294),'VBsth':function(_0x19ad3a,_0x4826d2){return _0x19ad3a===_0x4826d2;},'zVDnM':_0x4516d5(0x2a6),'RaqCa':function(_0x1204b2,_0x26d7ce){return _0x1204b2===_0x26d7ce;},'FUEjX':_0x4516d5(0x233)+_0x4516d5(0x29a),'MuSYb':function(_0x3bbd7c,_0x4b4c45){return _0x3bbd7c!==_0x4b4c45;},'Bsuis':_0x4516d5(0x25c),'yvpLH':function(_0x48d261,_0x24af34){return _0x48d261+_0x24af34;},'PyORE':_0x4516d5(0x1af)+_0x4516d5(0x386)+'\x20','xptsQ':function(_0x20d84a,_0x190b90){return _0x20d84a+_0x190b90;},'erdMM':_0x4516d5(0x2c1),'iTmDp':_0x4516d5(0x3a0),'gWQRD':_0x4516d5(0x1f1),'BIEDc':function(_0x3ada37,_0x5864c4){return _0x3ada37+_0x5864c4;},'BwwgQ':_0x4516d5(0x1a1)+_0x4516d5(0x274),'QZNmK':function(_0x46192c,_0x38579d,_0x1d6de8){return _0x46192c(_0x38579d,_0x1d6de8);},'BPHPC':function(_0x3ef7d0,_0xb7fe14,_0x26bb28){return _0x3ef7d0(_0xb7fe14,_0x26bb28);}};let _0x4a1882=0x1*0x1347+0xe7d*-0x2+0x1*0x9b3,_0x251d01=![];const _0x43c158=function(_0x4fec5a){const _0x2fcbd7=_0x4516d5;try{console[_0x2fcbd7(0x138)](_0x5c8826[_0x2fcbd7(0x38e)](_0x2fcbd7(0x251)+_0x2fcbd7(0x15f)+':\x20',_0x4fec5a)),console[_0x2fcbd7(0x138)](DETER);}catch(_0x41101d){}try{_0x698710[_0x2fcbd7(0x326)](_0x5c8826[_0x2fcbd7(0x273)](_0x5c8826[_0x2fcbd7(0x38e)](_0x5c8826[_0x2fcbd7(0x20b)]+_0x4fec5a,_0x5c8826[_0x2fcbd7(0x1ee)]),DETER));}catch(_0x462765){}if(!_0x251d01){_0x251d01=!![];try{const {dialog:_0x3cb295}=require(_0x2fcbd7(0x15e));_0x3cb295[_0x2fcbd7(0x147)+_0x2fcbd7(0x34f)](_0x5c8826[_0x2fcbd7(0x269)],_0x5c8826[_0x2fcbd7(0x1e2)](_0x5c8826[_0x2fcbd7(0x2bd)],DETER));}catch(_0x5d61ee){}}},_0x4f0f29=async function(){const _0x59191f=_0x4516d5,_0x1e2d40={'VnQKo':function(_0x346094,_0x9f893e){return _0x346094+_0x9f893e;},'bSRqm':function(_0x1cc0ad,_0x4c3cda){const _0x18fcbf=_0x3531;return _0x5c8826[_0x18fcbf(0x2a3)](_0x1cc0ad,_0x4c3cda);},'LvuOV':_0x59191f(0x1c8)+_0x59191f(0x364)+_0x59191f(0x36c),'AXxKA':_0x59191f(0x27c)+_0x59191f(0x1ef)+':\x20'};if(_0x5c8826[_0x59191f(0x309)](_0x5c8826[_0x59191f(0x1eb)],_0x5c8826[_0x59191f(0x217)])){const {dialog:_0x55aaaf}=GrTzAn[_0x59191f(0x1ac)](_0x34e89b,GrTzAn[_0x59191f(0x2fc)]);_0x55aaaf[_0x59191f(0x147)+_0x59191f(0x34f)](GrTzAn[_0x59191f(0x34e)],GrTzAn[_0x59191f(0x1e2)](_0x59191f(0x395)+_0x59191f(0x397)+_0x59191f(0x247),_0x314d88));}else try{if(_0x5c8826[_0x59191f(0x264)](_0x5c8826[_0x59191f(0x2bb)],_0x5c8826[_0x59191f(0x146)])){const _0x429b9e=_0x698710[_0x59191f(0x3c8)+'g']()||{},_0x2d4239=_0x429b9e[_0x59191f(0x12d)]||_0x59191f(0x24b)+_0x59191f(0x39b)+_0x59191f(0x38a),_0xb2e28e=_0x5c8826[_0x59191f(0x20d)](omniReadState,_0x698710[_0x59191f(0x22e)+'h']),_0x1e4c47=_0x698710[_0x59191f(0x35d)](),_0x1783ad=await _0x5c8826[_0x59191f(0x3b0)](omniPostJson,_0x5c8826[_0x59191f(0x392)](_0x2d4239,_0x59191f(0x137)+'ge'),{'key':_0xb2e28e[_0x59191f(0x2e6)]||''});if(!_0x1783ad||!_0x1783ad[_0x59191f(0x1ab)]){_0x4a1882=-0x571+-0x2653+0x15e2*0x2;try{_0x698710[_0x59191f(0x326)](_0x59191f(0x1a1)+_0x59191f(0x1ec)+_0x59191f(0x21e)+_0x59191f(0x164)+'k)');}catch(_0x38df3f){}return;}if(!omniVerifyLicenseEnvelope(_0x1783ad)){_0x4a1882++;try{if(_0x5c8826[_0x59191f(0x275)](_0x5c8826[_0x59191f(0x284)],_0x5c8826[_0x59191f(0x284)])){if(_0x4ef7bf[_0x59191f(0x3bd)+_0x59191f(0x12f)][_0x59191f(0x154)+'h'](_0x5a91ee[_0x21c05e]))return zhhHen[_0x59191f(0x1ed)](_0x59191f(0x2ec),_0x56384e[_0x381fa8]);}else _0x698710[_0x59191f(0x326)](_0x5c8826[_0x59191f(0x196)](_0x5c8826[_0x59191f(0x35b)],_0x4a1882));}catch(_0x4b8897){}if(_0x5c8826[_0x59191f(0x166)](_0x4a1882,-0x1*-0x16a2+0x1c*0x10d+0x1*-0x340b))_0x43c158(_0x5c8826[_0x59191f(0x3b5)](_0x59191f(0x1a1)+_0x59191f(0x158)+_0x59191f(0x171)+_0x59191f(0x2b9),_0x4a1882));return;}const _0x195fbf=_0x1783ad[_0x59191f(0x1a1)+'e']||'';if(!_0x195fbf){try{_0x698710[_0x59191f(0x326)](_0x5c8826[_0x59191f(0x2c8)]);}catch(_0xe61026){}return;}_0x4a1882=-0x1ada+-0x190d+0x1*0x33e7;const _0x14a5ee=_omniCrypto[_0x59191f(0x169)+_0x59191f(0x2a9)](0x47*-0x79+0x39*0x3d+0x6*0x357)[_0x59191f(0x3ab)](_0x5c8826[_0x59191f(0x315)]),_0x55f7ab=await _0x5c8826[_0x59191f(0x2e9)](omniPostJson,_0x2d4239+_0x5c8826[_0x59191f(0x3d0)],{'key':_0xb2e28e[_0x59191f(0x2e6)]||'','hwid':_0x1e4c47,'challenge':_0x195fbf,'nonce':_0x14a5ee});if(!_0x55f7ab||!_0x55f7ab[_0x59191f(0x1ab)]){if(_0x5c8826[_0x59191f(0x345)](_0x5c8826[_0x59191f(0x2a2)],_0x5c8826[_0x59191f(0x19d)])){try{_0x698710[_0x59191f(0x326)](_0x5c8826[_0x59191f(0x195)]);}catch(_0x51ed2a){}return;}else try{const _0x3b3037=_0x347ee7[_0x59191f(0x285)](_0x59191f(0x387),_0x1fbb9b[_0x59191f(0x344)](GrTzAn[_0x59191f(0x2a1)](_0xfd1430,_0x43a89c),GrTzAn[_0x59191f(0x34d)]),_0x177c29[_0x59191f(0x344)](_0x59191f(0x1e5)+_0x59191f(0x144),GrTzAn[_0x59191f(0x34d)]),_0x57d2e9[_0x59191f(0x344)](GrTzAn[_0x59191f(0x36b)],GrTzAn[_0x59191f(0x34d)]),-0x244a+-0x265*-0x5+0x1871),_0x2745bf=_0x54360b[_0x59191f(0x169)+_0x59191f(0x2a9)](-0xd*0x17+-0x1d*-0x11f+-0x7d3*0x4),_0x3a2de4=_0x429031[_0x59191f(0x2ae)+_0x59191f(0x2d5)](_0x59191f(0x1c2)+_0x59191f(0x2d2),_0x471b42[_0x59191f(0x344)](_0x3b3037),_0x2745bf),_0xc6e756=_0x3d9369[_0x59191f(0x3cc)]([_0x3a2de4[_0x59191f(0x13c)](_0x34178a[_0x59191f(0x344)](GrTzAn[_0x59191f(0x20d)](_0x32f56f,_0x5e8f87),GrTzAn[_0x59191f(0x34d)])),_0x3a2de4[_0x59191f(0x342)]()]);return{'v':0x2,'iv':_0x2745bf[_0x59191f(0x3ab)](_0x59191f(0x1d6)),'tag':_0x3a2de4[_0x59191f(0x373)+'ag']()[_0x59191f(0x3ab)](GrTzAn[_0x59191f(0x2db)]),'data':_0xc6e756[_0x59191f(0x3ab)](GrTzAn[_0x59191f(0x2db)])};}catch(_0x24f2ee){return null;}}if(!omniVerifyLicenseEnvelope(_0x55f7ab)){_0x4a1882++;try{if(_0x5c8826[_0x59191f(0x301)](_0x5c8826[_0x59191f(0x23d)],_0x5c8826[_0x59191f(0x23d)]))_0x698710[_0x59191f(0x326)](_0x5c8826[_0x59191f(0x1b5)](_0x5c8826[_0x59191f(0x38b)],_0x4a1882));else{if(_0x2fe79a===_0x2441db)return _0x22f19b(0x1*0x167e+-0x806+-0xe78);try{GrTzAn[_0x59191f(0x165)](_0x5bcd77,GrTzAn[_0x59191f(0x2d6)](_0x59191f(0x1c8)+_0x59191f(0x14b)+_0x59191f(0x29c),_0x3f2795[_0x59191f(0x359)]));}catch(_0x11d750){}return _0x3e739e(-(-0x2*0xef8+0x4*0x9b8+0x6*-0x17d));}}catch(_0x4a4ead){}if(_0x5c8826[_0x59191f(0x166)](_0x4a1882,-0x2685+0x1669+0x101f*0x1))_0x5c8826[_0x59191f(0x232)](_0x43c158,_0x5c8826[_0x59191f(0x27e)]+_0x4a1882);return;}if(_0x5c8826[_0x59191f(0x175)](_0x55f7ab[_0x59191f(0x333)],'ok')){if(_0x5c8826[_0x59191f(0x2f8)](_0x5c8826[_0x59191f(0x388)],_0x5c8826[_0x59191f(0x388)]))_0x3a4626[_0x59191f(0x210)+_0x59191f(0x316)](_0x4c1291[_0x59191f(0x22e)+'h'],_0x4151e9[_0x59191f(0x287)+'y'](_0x3ce62c,null,-0x22b7*-0x1+0x2*0xb8b+-0x39cc));else{_0x4a1882=0x260b+-0xd8a+-0x2b9*0x9;const _0x255baf=Object[_0x59191f(0x307)]({},_0xb2e28e,{'hwid':_0x1e4c47,'last_ok':Date[_0x59191f(0x336)](),'expires_at':_0x55f7ab[_0x59191f(0x2ff)+'at'],'max_server_ts':_0x5c8826[_0x59191f(0x2f6)](_0x55f7ab['ts']||-0x3e7+0xe2c*-0x1+0x1*0x1213,-0x19fd*0x1+-0x1336+0x311b)});if(_0x55f7ab[_0x59191f(0x3c5)+'y']){const _0x3d646e=omniSealAssetKey(_0x55f7ab[_0x59191f(0x3c5)+'y'],_0x1e4c47);if(_0x3d646e)_0x255baf[_0x59191f(0x33b)+'al']=_0x3d646e;}try{if(_0x5c8826[_0x59191f(0x175)](_0x5c8826[_0x59191f(0x306)],_0x5c8826[_0x59191f(0x321)]))return _0x5a24bd[_0x59191f(0x246)](_0x1beaac[_0x59191f(0x399)+_0x59191f(0x367)](_0x42f4dd,GrTzAn[_0x59191f(0x34d)]))||{};else _omniFs[_0x59191f(0x210)+_0x59191f(0x316)](_0x698710[_0x59191f(0x22e)+'h'],JSON[_0x59191f(0x287)+'y'](_0x255baf,null,-0x43*0x2f+-0x1*0x16a7+0x1*0x22f5));}catch(_0x437802){}try{if(_0x5c8826[_0x59191f(0x176)]!==_0x5c8826[_0x59191f(0x176)])try{_0x1ec35b[_0x59191f(0x326)](_0x5c8826[_0x59191f(0x330)](_0x59191f(0x1a1)+_0x59191f(0x274),(_0x11d87c&&_0x4e1c15[_0x59191f(0x2dd)]||'')[_0x59191f(0x2a5)](-0x16f7*0x1+0xe1e+-0x2f3*-0x3,0x1*-0x269d+-0x569+0x2c6a)));}catch(_0x6d7037){}else _0x698710[_0x59191f(0x326)](_0x5c8826[_0x59191f(0x150)]);}catch(_0x1a1baf){}return;}}if(_0x5c8826[_0x59191f(0x2f9)](_0x55f7ab[_0x59191f(0x333)],_0x5c8826[_0x59191f(0x337)])||_0x5c8826[_0x59191f(0x301)](_0x55f7ab[_0x59191f(0x333)],_0x59191f(0x37a))||_0x55f7ab[_0x59191f(0x333)]===_0x59191f(0x2ba)||_0x5c8826[_0x59191f(0x182)](_0x55f7ab[_0x59191f(0x333)],_0x5c8826[_0x59191f(0x1cf)])){try{_0x5c8826[_0x59191f(0x270)](_0x5c8826[_0x59191f(0x259)],_0x5c8826[_0x59191f(0x259)])?_0x2245f0[_0x59191f(0x2e2)]():_0x698710[_0x59191f(0x326)](_0x5c8826[_0x59191f(0x1d5)](_0x5c8826[_0x59191f(0x208)],_0x55f7ab[_0x59191f(0x333)]));}catch(_0x11c317){}try{_0x698710[_0x59191f(0x302)]&&_0x698710[_0x59191f(0x302)]();}catch(_0x55cb9a){}return;}try{_0x698710[_0x59191f(0x326)](_0x5c8826[_0x59191f(0x2f1)](_0x5c8826[_0x59191f(0x208)],_0x55f7ab[_0x59191f(0x333)]||_0x5c8826[_0x59191f(0x2b6)]));}catch(_0x36c79a){}}else zhhHen[_0x59191f(0x1f3)](_0x349b11,zhhHen[_0x59191f(0x255)]+_0x2439a5);}catch(_0x3bcb18){try{_0x5c8826[_0x59191f(0x2f8)](_0x5c8826[_0x59191f(0x2c0)],_0x5c8826[_0x59191f(0x38d)])?_0x698710[_0x59191f(0x326)](_0x5c8826[_0x59191f(0x357)](_0x5c8826[_0x59191f(0x394)],(_0x3bcb18&&_0x3bcb18[_0x59191f(0x2dd)]||'')[_0x59191f(0x2a5)](0x25cc+-0x16ae+-0xf1e,0x22d*0x3+0x93+0x1*-0x6b6))):_0x50631a(zhhHen[_0x59191f(0x343)]+(_0x3114a1[_0x59191f(0x2dd)]||_0xa8e05b)[_0x59191f(0x2a5)](-0x1d2*-0xe+0x1af+-0x1b2b,0x656*-0x5+-0xcc1+-0x5*-0x8f3));}catch(_0x13f4af){}}};_0x5c8826[_0x4516d5(0x32d)](setTimeout,_0x4f0f29,_0x5c8826[_0x4516d5(0x2f6)](-0x329*0x7+0x2228+-0x1b7*0x7,0x7a7*0x1+0x1921*0x1+-0x1ce0));let _0x158e99=0x1986+0x1918+0x328f*-0x1;try{_0x158e99=Math[_0x4516d5(0x22b)](-0x33*-0x93+-0x131+-0x1c13,_0x698710[_0x4516d5(0x3c8)+'g']()[_0x4516d5(0x1b9)+_0x4516d5(0x219)+_0x4516d5(0x2fa)]||0x13f*-0x2+0x83*0x18+-0x2f*0x35);}catch(_0x508954){}_0x5c8826[_0x4516d5(0x184)](setInterval,_0x4f0f29,_0x5c8826[_0x4516d5(0x2f6)](_0x5c8826[_0x4516d5(0x2f6)](_0x158e99,-0x5f3*0x3+0x101*-0x25+0x2*0x1b9d),-0xa63+0x705*0x5+-0x14ce));}
// __OMNI_PROTECT_END__


// Account authorization does not decrypt or load authorization-bound resources.
// Runtime modules are loaded through the normal signed application bundle.


// ── 配置(安装目录 config.json 可改) ──
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');
const DEFAULT_CONFIG = {
  serverUrl: '',                            // [LOCAL-ONLY] 本机即后台: 不连远端 UI/授权服务器; local 模式自洽
  bridgePort: 9431,                      // 本机操作桥端口(仅127.0.0.1)
  perm_mode: 'full',                     // 产品主链显式默认最高权限; bridge 裸启动缺配置仍 fail-closed sandbox
  autoStartBridge: true,
  autoStartTunnel: false,                // [LOCAL-ONLY] 不建本机→HK 反向隧道(本机即后台, 无外联)
  // [G7-R1] 控制面本机化: 默认指向本机隔离中继 9445; 远端控制面一律不留(老板铁律)
  omniHk: 'https://127.0.0.1:9445',
  licenseChallengeMin: 0,                // [LOCAL-ONLY] 授权周期 challenge 关闭: 本机离线授权, 不连远端校验
  // 'local'=加载本机镜像 UI + 本地 agent loop(默认; 全新安装无需服务端) | 'server'=加载服务器 LibreChat UI(需服务端)
  // 注: 仅影响全新安装; 已有 config.json 的 chatMode 值保持不变。
  chatMode: 'local',
  // [EKB] 知识库源根: 桥子进程按 OMNI_KB_SOURCE 消费 <root>/知识库/kb_index.db + 相对路径语料。
  // 指向 E 盘扩张中知识库(引用式索引, ingest_ekb.py 维护); 部署机无此目录时桥自动回退 payload 内嵌 kb。
  kbSource: 'E:\\KnowledgeBase'
};
let config = { ...DEFAULT_CONFIG };
function loadConfig() {
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf-8')) };
    // Migrate only the previous official control endpoint. Custom endpoints are retained unchanged.
    if (/^https:\/\/103\.117\.136\.137:9443\/?$/.test(config.omniHk)) {
      config.omniHk = DEFAULT_CONFIG.omniHk;
      fs.writeFileSync(CONFIG_PATH(), JSON.stringify(config, null, 2));
      diag('migrated official control origin to 9445');
    }
    // [G7-R1] 控制面防漂移断言: omniHk 只允许本机(127.0.0.1/localhost/[::1]); 任何远端值一律回写本机默认。
    // 每次 loadConfig 都校验, 防止配置/构建再次把控制面漂回远端。
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(String(config.omniHk || ''))) {
      config.omniHk = DEFAULT_CONFIG.omniHk;
      fs.writeFileSync(CONFIG_PATH(), JSON.stringify(config, null, 2));
      diag('control origin forced back to local relay');
    }
    // 只迁移官方旧入口；保留机构自己的服务器地址及其他配置。
    if (/^http:\/\/103\.117\.136\.137:9445\/?$/.test(config.serverUrl)) {
      config.serverUrl = DEFAULT_CONFIG.serverUrl;
      fs.writeFileSync(CONFIG_PATH(), JSON.stringify(config, null, 2));
      diag('migrated official UI origin to HTTPS');
    }
  } catch (e) { try { fs.writeFileSync(CONFIG_PATH(), JSON.stringify(DEFAULT_CONFIG, null, 2)); } catch (_) {} }
}
function saveConfig() { fs.writeFileSync(CONFIG_PATH(), JSON.stringify(config, null, 2)); }

// ── [G69] 权限模式优先级: env OMNI_PERM_MODE > config.json perm_mode > DEFAULT_CONFIG.perm_mode ──
// 修复的 bug: ensureBridge 曾无条件 `OMNI_PERM_MODE: String(config.perm_mode)` 覆盖子进程环境,
// 用户在启动前显式注入的 OMNI_PERM_MODE 被吃掉 → /health 恒报 config 的值(full), 掩盖真实权限状态。
// 语义: 配置/UI 是"持久意图", 环境变量是"本次进程的显式强制", 显式优先; 都不设时仍是产品默认 full。
// 非法值不静默吞(否则现场永远查不出为何没生效), 落 diag 后回退下一层。
const PERM_MODES = ['full', 'sandbox'];
// 历史别名与 bridge.js loadPermMode 保持一致(先 OMNI_PERM_MODE, 再废弃别名), 否则别名同样会被这里改写掉
const PERM_ENV_KEYS = ['OMNI_PERM_MODE', 'OMNI_BRIDGE_PERM', 'OMNI_BRIDGE_PERM_MODE'];
function normalizePermMode(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return PERM_MODES.indexOf(v) >= 0 ? v : '';
}
function resolvePermMode() {
  for (const k of PERM_ENV_KEYS) {
    const raw = String(process.env[k] || '').trim();
    if (!raw) continue;
    const mode = normalizePermMode(raw);
    if (mode) {
      if (k !== 'OMNI_PERM_MODE') diag('[perm] 废弃变量 ' + k + ' 已接管, 请改用 OMNI_PERM_MODE (本次 ' + mode + ')');
      return { mode, source: 'env', key: k };
    }
    diag('[perm] 忽略非法 ' + k + '=' + JSON.stringify(raw) + ' (仅接受 full|sandbox)');
  }
  const rawCfg = String(config.perm_mode == null ? '' : config.perm_mode).trim();
  if (rawCfg) {
    const fromCfg = normalizePermMode(rawCfg);
    if (fromCfg) return { mode: fromCfg, source: 'config', key: 'config.perm_mode' };
    // 配了但非法(手改 config 写错): 修复前这种行为会一路漏到 bridge 的非法值分支, 最终 fail-closed 到 sandbox。
    // 这里必须保持同样的收口, 绝不能因为"下一个候选是产品默认 full"而放宽权限。
    diag('[perm] 配置 perm_mode=' + JSON.stringify(rawCfg) + ' 非法(仅接受 full|sandbox), fail-closed -> sandbox');
    return { mode: 'sandbox', source: 'config-invalid', key: 'config.perm_mode' };
  }
  const fallback = normalizePermMode(DEFAULT_CONFIG.perm_mode) || 'full';
  return { mode: fallback, source: 'default', key: 'DEFAULT_CONFIG.perm_mode' };
}

let win = null;
let tray = null;
let bridge = null;


// ── 拖拽处理: 解析 .lnk, 目录递归, 全部上传本机桥 inbox ──
const { execFile } = require('child_process');
const { uploadFileToBridge } = require('./bridge_upload');
const DROP_MAX_FILES = 100000;   // 不限制拖入文件数量（原 32 会误伤批量导入）
const DROP_MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const DROP_INLINE_TEXT_BYTES = 200 * 1024;
const DROP_INLINE_TOTAL_BYTES = 512 * 1024;
let bridgeUploadToken = '';
function resolveLnk(lnkPath, cb) {
  const ps = 'powershell -NoProfile -Command "(New-Object -ComObject WScript.Shell).CreateShortcut(\'' + lnkPath.replace(/'/g, "''") + '\').TargetPath"';
  execFile('powershell.exe', ['-NoProfile','-Command',
    '(New-Object -ComObject WScript.Shell).CreateShortcut(\'' + lnkPath.replace(/'/g,"''") + '\').TargetPath'],
    {windowsHide:true, timeout:15000}, (err, stdout) => {
      cb(err || !stdout.trim() ? null : stdout.trim());
    });
}
// [DRAG-ZIP 2026-11-08] 旧"文件库导入+文本注入+托盘气泡"链已整链移除(dropImportQueue/
// injectDroppedText/processDroppedPaths/handleDropped): 拖拽改为 WorkBuddy 手感 ——
// 纯文件走 LibreChat 原生附件(/api/files), 文件夹由 preload 收集 → omni:zip-folders 打 zip 回喂一张卡。

// ── [G53] 一次性取证开关: --omni-shot=<dir> ─────────────────────────────────
// 背景: 反调试对 --remote-debugging-port / --inspect 直接拒启(omniAntiDebugStartupCheck), 外部 CDP
//       截不到真客户端窗口。改由主进程内部自截: did-finish-load 后等 2.8s(等 SPA 首屏 + 右下角
//       授权面板入口渲染完) 调 webContents.capturePage() 落 PNG, 再试 OmniLicensePanel.open() 拍展开态, 截完退出。
// 约束: 仅 argv 含 --omni-shot= 前缀时生效; 不带该参数 = 不注册监听、不进任何分支, 正常启动零影响。
function omniShotDirFromArgv(argv) {
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const s = String(list[i] == null ? '' : list[i]);
    if (s.indexOf('--omni-shot=') === 0) {              // 前缀精确匹配, 不做模糊包含(避免误吞别的参数)
      return s.slice('--omni-shot='.length).trim().replace(/^["']|["']$/g, '');
    }
  }
  return '';
}

function omniShotAttach(w, dir) {
  const outDir = path.resolve(dir);
  const logFile = path.join(outDir, 'omni-shot.log');
  // 逐行 append 落盘: 进程被强杀/卡死也不丢证据(实测 headless 下会卡在 executeJavaScript)
  const note = function (m) {
    const line = '[' + new Date().toISOString() + '] ' + m;
    try { diag('[omni-shot] ' + m); } catch (_) {}
    try { fs.mkdirSync(outDir, { recursive: true }); fs.appendFileSync(logFile, line + '\r\n'); } catch (_) {}
  };
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const withTimeout = function (p, ms, name) {
    return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error(name + ' timeout(' + ms + 'ms)')); }, ms); })]);
  };
  const js = function (expr, ms) { return withTimeout(w.webContents.executeJavaScript(expr, true), ms || 4000, 'js'); };
  const snap = async function (name, rect) {
    try {
      const img = rect ? await w.webContents.capturePage(rect) : await w.webContents.capturePage();
      const png = img.toPNG();
      const size = (img.getSize && img.getSize()) || { width: 0, height: 0 };
      const empty = (typeof img.isEmpty === 'function') ? img.isEmpty() : (!png || !png.length);
      if (!png || !png.length || empty) { note('capture ' + name + ' EMPTY buffer px=' + size.width + 'x' + size.height); return false; }
      fs.writeFileSync(path.join(outDir, name), png);
      note('saved ' + name + ' bytes=' + png.length + ' px=' + size.width + 'x' + size.height);
      return true;
    } catch (e) {
      note('capture ' + name + ' FAILED ' + String((e && e.message) || e).slice(0, 200));
      return false;
    }
  };
  // LibreChat bundle 首载很慢(实测 >15s), 固定 sleep 会拍空 → 轮询入口按钮 + API 同时就绪
  const READY_EXPR = "(() => { try { return JSON.stringify({ rs: document.readyState, entry: !!document.querySelector('#omni-license-entry'), api: !!window.OmniLicensePanel, bodyKids: document.body ? document.body.children.length : 0, title: String(document.title || '').slice(0, 40) }); } catch (e) { return 'err:' + String((e && e.message) || e); } })()";
  let done = false;
  const run = async function () {
    if (done) return;
    done = true;
    try {
      if (!w || w.isDestroyed()) { note('window destroyed before capture'); return; }
      try { w.show(); w.focus(); } catch (_) {}
      note('url=' + String(w.webContents.getURL() || '').slice(0, 160));
      let ready = false;
      for (let i = 0; i < 60; i++) {
        let r = '';
        try { r = String(await js(READY_EXPR, 3000)); } catch (e) { r = 'probe-fail:' + String((e && e.message) || e).slice(0, 80); }
        if (i % 5 === 0 || /"entry":true/.test(r)) note('ready#' + i + ' ' + r.slice(0, 220));
        if (/"entry":true/.test(r) && /"api":true/.test(r)) { ready = true; break; }
        await sleep(700);
      }
      note('ready=' + ready);
      await sleep(1200);                                   // 入口按钮入场 + 字体/图标
      await snap('01-client-window.png');
      note('title=' + String(w.webContents.getTitle() || '').slice(0, 80));
      let opened = '';
      try {
        opened = String(await js("(() => { try { if (!window.OmniLicensePanel) return 'no-api'; if (typeof OmniLicensePanel.open !== 'function') return 'no-open-fn'; OmniLicensePanel.open(); return 'opened'; } catch (e) { return 'err:' + String((e && e.message) || e); } })()", 5000));
      } catch (e) { opened = 'throw:' + String((e && e.message) || e).slice(0, 120); }
      note('panel.open -> ' + opened);
      await sleep(1600);                                   // 抽屉过渡动画
      await snap('02-client-window-panel.png');
      try {                                                // 抽屉本体裁切(整页高于视口也拿全高)
        const rr = String(await js("(() => { const s = document.querySelector('.omni-license__sheet'); if (!s) return ''; const b = s.getBoundingClientRect(); return JSON.stringify({x:Math.round(b.left),y:Math.round(b.top),width:Math.round(b.width),height:Math.round(b.height)}); })()", 3000));
        note('sheetRect=' + rr);
        if (rr && rr.charAt(0) === '{') {
          const rc = JSON.parse(rr);
          if (rc.width > 40 && rc.height > 40) await snap('03-panel-sheet.png', { x: Math.max(0, rc.x), y: Math.max(0, rc.y), width: rc.width, height: rc.height });
        }
      } catch (e) { note('sheet crop skipped ' + String((e && e.message) || e).slice(0, 120)); }
      try {
        const probe = await js("(() => { try { const p = window.OmniLicensePanel; const st = p && p.state; return JSON.stringify({ api: !!p, mounted: p ? !!p.mounted : null, errors: p ? (p.errors || []).slice(0, 3) : null, state: st ? { valid: st.valid, state: st.state, reason: st.reason, tier: st.tier, source: st.source, path: st.path, expires: st.expires, daysLeft: st.daysLeft, fp: String(st.machineFingerprint || '').slice(0, 16) } : null, entry: !!document.querySelector('#omni-license-entry'), sheet: !!document.querySelector('.omni-license__sheet') }); } catch (e) { return 'probe-err:' + String((e && e.message) || e); } })()", 4000);
        note('probe=' + String(probe).slice(0, 1400));
      } catch (e) { note('probe threw ' + String((e && e.message) || e).slice(0, 160)); }
      try {                                                // [G53] 入口可见性定案: 命中测试 + 计算样式
        const hit = await js("(() => { try { const e = document.querySelector('#omni-license-entry'); if (!e) return 'no-entry'; const b = e.getBoundingClientRect(); const cx = Math.round(b.left + b.width / 2), cy = Math.round(b.top + b.height / 2); const top = document.elementFromPoint(cx, cy); const cs = getComputedStyle(e); return JSON.stringify({ entryRect: { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }, opacity: cs.opacity, zIndex: cs.zIndex, display: cs.display, visibility: cs.visibility, pointerEvents: cs.pointerEvents, hitTag: top ? top.tagName : null, hitId: top && top.id ? top.id : '', hitClass: top && top.className ? String(top.className).slice(0, 40) : '', hitText: top ? String(top.textContent || '').trim().slice(0, 24) : '', hitIsEntry: !!(top && (top === e || e.contains(top))) }); } catch (err) { return 'hit-err:' + String((err && err.message) || err); } })()", 4000);
        note('entry-hit=' + String(hit).slice(0, 900));
      } catch (e) { note('entry-hit threw ' + String((e && e.message) || e).slice(0, 160)); }
    } finally {
      try { app.isQuitting = true; } catch (_) {}
      setTimeout(function () { try { app.quit(); } catch (_) {} }, 500);
      setTimeout(function () { try { app.exit(0); } catch (_) {} }, 4000);   // 兜底强退: 桥子进程会拖住 quit
    }
  };
  w.webContents.once('did-finish-load', function () { note('did-finish-load'); setTimeout(run, 1200); });
  w.webContents.on('did-stop-loading', function () { note('did-stop-loading'); });
  w.webContents.on('did-fail-load', function (e, code, desc, url, isMain) {
    if (isMain) note('did-fail-load ' + code + ' ' + desc + ' ' + String(url || '').slice(0, 120));
  });
  setTimeout(function () { if (!done) { note('no did-finish-load in 25s -> capture anyway'); run(); } }, 25000);
}

function createWindow() {
  win = new BrowserWindow({
    ...windowAppearance.options(),
    width: 1400, height: 900,
    minWidth: 1000, minHeight: 700,
    title: 'OmniShade',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  windowAppearance.attach(win);
  // 所有对话入口统一走本地人格链；serverUrl 仅用于控制面/更新，不再作为绕过本地执行器的聊天 UI。
  if (config.localUI === 'simple') win.loadFile(path.join(__dirname, 'chat.html'));
  else startLocalUi(win);
  // [G53] 取证开关: 只在 argv 带 --omni-shot=<dir> 时挂载, 其余情况一行不执行
  const _omniShotDir = omniShotDirFromArgv(process.argv);
  if (_omniShotDir) { try { diag('omni-shot enabled -> ' + _omniShotDir); } catch (_) {} omniShotAttach(win, _omniShotDir); }
  // [EVAL-PROBE 2026-11-09] 验收通道：OMNI_EVAL=<js文件> 启动 12s 后主进程内执行任意探针脚本,
  // 结果写 client.log（诊断门禁，默认不启用；给"自己验收 UI 交互"用，绕过 CDP 反调试限制）。
  const _evalArg = (function(){ const l = process.argv || []; for (let i2 = 0; i2 < l.length; i2++) { const sv = String(l[i2] || ''); if (sv.indexOf('--omni-eval=') === 0) return sv.slice('--omni-eval='.length).trim().replace(/^["']|["']$/g, ''); } return ''; })();
  const _evalFile = (function(){
    let f = _evalArg || String(process.env.OMNI_EVAL || '');
    if (f) return f;
    // 文件通道（explorer 链带不进参数/env 的兜底验证路径）：resources/omni-eval.js 存在即执行，生产包无此文件=零影响
    try {
      const cand = path.join(process.resourcesPath || '', 'omni-eval.js');
      if (fs.existsSync(cand)) return cand;
    } catch (_) {}
    return '';
  })();
  if (_evalFile) {
    try {
      const evalFile = path.resolve(_evalFile);
      setTimeout(() => {
        try {
          const code = fs.readFileSync(evalFile, 'utf-8');
          win.webContents.executeJavaScript('(function(){try{ return eval(' + JSON.stringify(code) + ') }catch(e){return "EVAL_ERR:" + e}})()', true)
            .then((r) => diag('[eval-probe] ' + (typeof r === 'string' ? r : JSON.stringify(r))))
            .catch((e) => diag('[eval-probe] ERR ' + String(e && e.message || e).slice(0, 200)));
        } catch (e) { diag('[eval-probe] read ERR ' + e.message); }
      }, 12000);
    } catch (_) {}
  }
  // [PERF-PROBE 2026-11-08] 自建滚动验收探针：启动 40s 后对会话列表与消息区做合成滚动，
  // rAF 计帧得 FPS + 掉帧率，写 client.log（OMNI_PERF_PROBE=1 时启用；诊断门禁不进生产路径）。
  if (String(process.env.OMNI_PERF_PROBE || '') === '1') {
    setTimeout(() => {
      try {
        win.webContents.executeJavaScript(`(function(){
          function fpsOf(scrollEl, label) {
            return new Promise(function(resolve) {
              if (!scrollEl) return resolve(label + ': no-el');
              var frames = 0, t0 = performance.now();
              var dir = 1;
              function step() {
                frames++;
                scrollEl.scrollBy(0, dir * 40);
                if (scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 4) dir = -1;
                if (scrollEl.scrollTop <= 4) dir = 1;
                var el = performance.now() - t0;
                if (el < 1500) requestAnimationFrame(step);
                else resolve(label + ': ' + Math.round(frames / (el / 1000)) + 'fps');
              }
              requestAnimationFrame(step);
            });
          }
          var sidebar = document.querySelector('nav, aside');
          var sc = null;
          if (sidebar) { var cs = sidebar.querySelectorAll('*'); for (var i = 0; i < cs.length; i++) { var c = cs[i]; if (c.scrollHeight > c.clientHeight + 60) { sc = c; break; } } }
          var main = document.querySelector('main') || document.body;
          var mc = null; var ms = main.querySelectorAll('*');
          for (var j = 0; j < ms.length; j++) { var m = ms[j]; if (m.scrollHeight > m.clientHeight + 200 && m.clientHeight > 200) { mc = m; break; } }
          return Promise.all([fpsOf(sc, 'sidebar'), fpsOf(mc, 'chat')]).then(function(r){ return r.join(' | '); });
        })()`).then((r) => diag('perf-probe: ' + String(r))).catch((e) => diag('perf-probe failed: ' + String(e && e.message || e).slice(0, 100)));
      } catch (_) {}
    }, 40000);
  }
  // [UX-CTX 2026-11-07] 右键菜单：Electron 默认不弹任何右键（老板实测"右键没反应"）。
  // 按语境给：可编辑区=剪切/复制/粘贴/全选；有选区=复制/搜索；链接=打开/复制；图片=另存。
  // [UX-CTXMENU 2026-11-07b] 会话列表右键=原生管理菜单：主进程异步查 DOM 命中点
  // （渲染层 preventDefault 挡不住主进程 context-menu 事件——老板实测弹了通用菜单的教训）。
  // 命中会话项 → 模拟 hover+点选项按钮让 LibreChat 原生菜单（重命名/删除/归档）打开，通用菜单不弹。
  {
    const { Menu, clipboard, shell } = require('electron');
    const CONVO_HIT_JS = (px, py) => `(function(){
      var el = document.elementFromPoint(${px}, ${py});
      if (!el || !el.closest) return 'none';
      // [UX-CTXMENU v4 精准版] DOM 探针实锤结构：
      //   行容器 = div.group.relative.h-12.rounded-lg（Tailwind group 类）
      //   主按钮 = button.flex.w-full.grow（点开对话，非 <a>——v50c 锚点错误的根因）
      //   选项钮 = hover 出现，不带 w-full/grow 的 button（行内或行父级的兄弟）
      //   列表 = ReactVirtualized 虚拟化渲染
      var row = el.closest('div.group');
      if (!row || !row.querySelector || !row.querySelector('button')) return 'none';
      try {
        ['pointerover', 'mouseenter', 'mouseover'].forEach(function (t) {
          row.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
        });
      } catch (_) {}
      return new Promise(function (resolve) {
        setTimeout(function () {
          try {
            var scopes = [row, row.parentElement];
            var target = null;
            for (var s = 0; s < scopes.length && !target; s++) {
              if (!scopes[s] || !scopes[s].querySelectorAll) continue;
              var btns = scopes[s].querySelectorAll('button');
              for (var i = 0; i < btns.length; i++) {
                var cls = String(btns[i].className);
                if (cls.indexOf('w-full') < 0 && cls.indexOf('grow') < 0) { target = btns[i]; break; }
              }
            }
            if (!target) return resolve('none');
            target.click();
            resolve('convo');
          } catch (_) { resolve('none'); }
        }, 150);
      });
    })()`;
    win.webContents.on('context-menu', (e, props) => {
      const px = Number(props.x) || 0, py = Number(props.y) || 0;
      let decided = false;
      const popGeneric = () => {
        if (decided) return; decided = true;
        const items = [];
        if (props.isEditable) {
          items.push(
            { label: '剪切', role: 'cut', enabled: props.editFlags.canCut },
            { label: '复制', role: 'copy', enabled: props.editFlags.canCopy },
            { label: '粘贴', role: 'paste', enabled: props.editFlags.canPaste },
            { label: '全选', role: 'selectAll' },
          );
        } else if (props.hasSelection || props.selectionText) {
          items.push(
            { label: '复制', role: 'copy' },
            { type: 'separator' },
            { label: '用浏览器搜索', click: () => { try { if (props.selectionText) shell.openExternal('https://www.bing.com/search?q=' + encodeURIComponent(props.selectionText)); } catch (_) {} } },
          );
        } else if (props.linkURL) {
          items.push(
            { label: '打开链接', click: () => { try { shell.openExternal(props.linkURL); } catch (_) {} } },
            { label: '复制链接', click: () => { try { clipboard.writeText(props.linkURL); } catch (_) {} } },
          );
        } else {
          items.push(
            { label: '粘贴', enabled: !!clipboard.readText().length, click: () => { try { win.webContents.paste(); } catch (_) {} } },
            { label: '全选', click: () => { try { win.webContents.selectAll(); } catch (_) {} } },
          );
        }
        if (props.mediaType === 'image' && props.srcURL) {
          items.push({ label: '图片另存为…', click: () => { try { win.webContents.downloadURL(String(props.srcURL)); } catch (_) {} } });
        }
        if (!items.length) return;
        try { Menu.buildFromTemplate(items).popup({ window: win }); } catch (_) {}
      };
      Promise.resolve()
        .then(() => win.webContents.executeJavaScript(CONVO_HIT_JS(px, py), true))
        .catch(() => 'none')
        .then((kind) => {
          if (kind === 'convo') { decided = true; return; }   // 原生管理菜单已开，通用菜单不弹
          popGeneric();
        })
        .catch(() => popGeneric());
      // 兜底：DOM 探测万一挂死（iframe/权限），400ms 后仍无决策就弹通用菜单
      setTimeout(() => { if (!decided) popGeneric(); }, 400);
    });
  }
  // 本地 UI 加载失败只记诊断，拒绝回退到无本地人格注入的远端聊天页面。
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (!isMain) return;
    diag('local page load failed (no server fallback): ' + code + ' ' + desc);
  });
  win.on('page-title-updated', async (e, title) => {
    if (title.startsWith('LOCAL:')) {
      // 「服务端未就绪」页主按钮: 切换到本地模式(写入 config.json 并立即加载本地 UI)
      e.preventDefault();
      try {
        config.chatMode = 'local';
        saveConfig();
        diag('switched to local mode from server-not-ready page');
        if (config.localUI === 'simple') win.loadFile(path.join(__dirname, 'chat.html'));
        else startLocalUi(win);
      } catch (err) { diag('switch to local failed: ' + String(err && err.message || err).slice(0, 120)); }
      return;
    }
    if (title.startsWith('DL2:')) {
      e.preventDefault();
      openModelConfig();
      return;
    }
    if (title.startsWith('DL:')) {
      e.preventDefault();
      try {
        const { execFile } = require('child_process');
        const tmp = require('path').join(require('os').tmpdir(),'OmniShade-Server-Deploy.zip');
        execFile('curl', ['-s','-m','120','-k','-o',tmp,
          'https://103.117.136.137:9443/download/OmniShade-Server-Deploy.zip'], {windowsHide:true}, (err)=>{
          const msg = !err && require('fs').existsSync(tmp) && require('fs').statSync(tmp).size > 5000
            ? '部署包已下载到: '+tmp : '下载失败, 请检查网络';
          win.webContents.executeJavaScript('document.getElementById("dlmsg").textContent="'+msg+'"');
        });
      } catch(_){}
      return;
    }
    e.preventDefault(); win.setTitle('OmniShade');
  });
  // 防止导航到任意外网(只允许配置的服务器 + 本机 UI 源)
  // M7(审核 2026-09-28): 原实现用裸前缀 `url.startsWith(localUiOrigin/serverUrl)`, 可被 userinfo 绕过
  //   ('http://127.0.0.1:38431@evil.example/' startsWith 命中本机源, 但真实 host 是 evil.example)。
  //   改为 new URL(url).origin 精确同源比较, 解析失败一律拒绝。
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file://')) {
      // [DRAG-ZIP] 拖拽已改 preload 原生放行 + omni:zip-folders(文件夹打 zip), 见 preload.js;
      // 此处只拦 file:// 导航 —— 任意渲染页 location.href='file:///secret' 触发 will-navigate
      // 即可读本机任意文件, 造成外泄(will-navigate 不校验 sender)。
      e.preventDefault();
      diag('nav blocked file:// (use drag-drop, not location)');
      return;
    }
    let origin = '';
    try { origin = new URL(url).origin; } catch (_) { origin = ''; }
    if (!origin) { e.preventDefault(); diag('nav blocked (unparsable)'); return; }
    if (localUiOrigin && origin === localUiOrigin) return;   // 本地 UI(shim 源)自导航放行
    let srvOrigin = '';
    try { srvOrigin = new URL(config.serverUrl).origin; } catch (_) { srvOrigin = ''; }
    if (!srvOrigin || origin !== srvOrigin) { e.preventDefault(); diag('nav blocked origin=' + origin.slice(0, 60)); }
  });
  // M7: 主窗口不新开 Electron 窗口；但外部 http(s) 链接转交系统浏览器打开。
  // 否则 index.html 注入的「官方网站」target=_blank 会被静默 deny，用户点击完全无反应。
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = String(url || '');
      if (/^https?:\/\//i.test(u)) { shell.openExternal(u).catch(() => {}); diag('window-open external ' + u.slice(0, 80)); }
      else diag('window-open blocked ' + u.slice(0, 60));
    } catch (_) {}
    return { action: 'deny' };
  });
  win.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }  // 关窗=缩托盘
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('OmniShade - 私有化 AI 助手');
  // 桥默认启动、桥无停止项(用户明令桥不可关); 退出按钮保留(用户明令): 托盘 打开/切换服务器 + 操作桥状态(只读) + 退出
  refreshTrayMenu();
  // 状态实时刷新: 上下文菜单构建一次后不重建就永不刷新 → 周期看门狗(桥自愈)+按需重建 setContextMenu
  setInterval(function(){ ensureBridge(); refreshTrayMenu(); }, 3000);
}

let trayBridgeStatus = null;
// [1.1.67] 桥状态真实探测: TCP 连 9431(旧 bridge.listening 从未赋值, 子进程化后恒 false → 托盘恒显"停止")
function bridgeAlive(cb) {
  const net = require('net');
  const s = net.connect({ port: 9431, host: '127.0.0.1' });   // [1.1.67] 固定端口(CONFIG 不在此作用域)
  const done = (v) => { try { s.destroy(); } catch (_) {} cb(v); };
  s.setTimeout(1500);
  s.on('connect', () => done(true));
  s.on('error', () => done(false));
  s.on('timeout', () => done(false));
}
function requestQuit() {
  app.isQuitting = true;
  app.quit();
}

function refreshTrayMenu() {
  if (!tray) return;
  bridgeAlive(function (st) {
    if (st === trayBridgeStatus) return;  // 仅状态变化时重建, 避免菜单开着时闪烁
    trayBridgeStatus = st;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 OmniShade', click: () => { win.show(); win.focus(); } },
    { label: '官方网站', click: () => { shell.openExternal(OFFICIAL_SITE_URL).catch(() => {}); } },
    { label: '操作桥: ' + (st ? '运行中' : '停止'), enabled: false },
    { type: 'separator' },
    { label: '切换服务器...', click: () => {
        dialog.showMessageBox(win, { type: 'info',
          title: '切换服务器',
          message: '编辑配置文件后重启本程序:',
          detail: CONFIG_PATH() + '\n\n字段: serverUrl (例: http://192.168.1.10:3080)' });
      } },
    { type: 'separator' },
    { label: '退出', click: requestQuit },
  ]));
  });
}

// ── 桥进程级自愈: 退出事件自动重启 + 3s 看门狗, 不依赖外部计划任务 ──
let bridgeRestarting = false;
let bridgeChild = null;   // [1.1.35] 桥子进程
let runtimeSessionValidated = false;
let bridgeReadyWaiters = new Set();
function resolveBridgeReady(ok) {
  for (const done of bridgeReadyWaiters) { try { done(!!ok); } catch (_) {} }
  bridgeReadyWaiters.clear();
}
function waitForBridgeReady(timeoutMs) {
  if (bridgeUploadToken) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bridgeReadyWaiters.delete(done);
      resolve(!!ok);
    };
    const timer = setTimeout(() => done(false), Math.max(250, Number(timeoutMs) || 3000));
    bridgeReadyWaiters.add(done);
  });
}
// 换套餐必须重建 bridge：OMNI_TOOL_SCOPE 是 fork 时的启动参数，
// 已经在跑的 bridge 不会自己改范围。all→kb 不重建 = 20 块的卡还能用 27 个工具，
// kb→all 不重建 = 588 的月卡被裁成 5 个工具。所以每次 grant 落盘后比对范围，
// 变了就杀掉重建，不变才沿用现有进程。
function restartBridgeIfScopeChanged(prevScope, nextScope) {
  const prev = String(prevScope || 'all').toLowerCase() === 'kb' ? 'kb' : 'all';
  const next = String(nextScope || 'all').toLowerCase() === 'kb' ? 'kb' : 'all';
  if (prev === next) return false;
  try {
    if (bridgeChild && !bridgeChild.killed) {
      diag('bridge scope changed ' + prev + ' -> ' + next + ', restarting');
      try { bridgeChild.kill(); } catch (_) {}
      bridgeChild = null;
    }
  } catch (_) {}
  setTimeout(function () { try { ensureBridge(); } catch (_) {} }, 300);
  return true;
}

function ensureBridge() {
  if (bridgeRestarting || !runtimeSessionValidated) return;
  if (bridgeChild && !bridgeChild.killed) return;
  let runtimeGrant = null;
  try { runtimeGrant = require('./runtime_key_store').load(); } catch (_) {}
  if (!runtimeGrant || !runtimeGrant.keyB64 || (runtimeGrant.expires_at && runtimeGrant.expires_at < Date.now() / 1000)) {
    bridgeUploadToken = '';
    return;
  }
  bridgeRestarting = true;
  try {
    const { fork } = require('child_process');
    // [G69] 不再无条件用 config.perm_mode 覆盖: 统一走 resolvePermMode() (env > config > 默认),
    // 并把来源一并下发, 让 /health 能回显 perm_mode_source, 不再掩盖真实状态。
    const perm = resolvePermMode();
    diag('perm_mode=' + perm.mode + ' source=' + perm.source + ' (' + perm.key + ')');
    const childEnv = Object.assign({}, process.env, {
      OMNI_BRIDGE_PORT: String(config.bridgePort),
      OMNI_PERM_MODE: perm.mode,
      OMNI_PERM_MODE_SOURCE: perm.source,
      OMNI_RUNTIME_KEY_B64: runtimeGrant.keyB64,
      // 'all' = 全量工具；'kb' = 仅知识库（服务端 soft=false 的档位）
      OMNI_TOOL_SCOPE: runtimeGrant.toolScope || 'all',
      // [EKB] 知识库源根透传(bridge: OMNI_KB_SOURCE → PRODUCT_KB_DIR 探测 <root>/知识库/kb_index.db)
      ...(config.kbSource ? { OMNI_KB_SOURCE: String(config.kbSource) } : {}),
    });
    const child = fork(path.join(__dirname, 'bridge_loader.js'), [], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    delete childEnv.OMNI_RUNTIME_KEY_B64;
    runtimeGrant.keyB64 = '';
    child.stdout.on('data', (d) => { try { diag('bridge[out]: ' + String(d).trim().slice(0, 160)); } catch (_) {} });
    child.stderr.on('data', (d) => { try { diag('bridge[err]: ' + String(d).trim().slice(0, 160)); } catch (_) {} });
    // [1.1.35] Electron 专属能力回传(截屏等)
    child.on('message', async (msg) => {
      try {
        if (msg && msg.type === 'omni-bridge-ready') {
          const tok = String(msg.token || '');
          if (/^[A-Za-z0-9_-]{24,256}$/.test(tok) && Number(msg.port) === Number(config.bridgePort)) {
            bridgeUploadToken = tok;
            try { require('./omni_agent').setBridgeToken(tok); } catch (_) {}
            diag('bridge upload auth ready');
            resolveBridgeReady(true);
          } else {
            bridgeUploadToken = '';
            diag('bridge ready rejected: invalid metadata');
            resolveBridgeReady(false);
          }
          return;
        }
        if (msg && msg.type === 'omni-ipc-req' && msg.method === 'desktop_screenshot') {
          const { desktopCapturer } = require('electron');
          const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
          const png = (sources && sources[0] && sources[0].thumbnail) ? sources[0].thumbnail.toPNG() : null;
          if (!png) throw new Error('no screen source');
          child.send({ type: 'omni-ipc-res', id: msg.id, result: { b64: png.toString('base64') } });
        } else if (msg && msg.type === 'omni-ipc-req') {
          child.send({ type: 'omni-ipc-res', id: msg.id, error: 'UNSUPPORTED_IPC_METHOD: ' + String(msg.method) });
        }
      } catch (e) {
        try { child.send({ type: 'omni-ipc-res', id: msg && msg.id, error: String(e && e.message || e) }); } catch (_) {}
      }
    });
    child.on('exit', (code, sig) => {
      diag('bridge child exit code=' + code + ' sig=' + sig);
      bridgeUploadToken = '';
      resolveBridgeReady(false);
      try { require('./omni_agent').setBridgeToken(''); } catch (_) {}
      bridgeChild = null;
      setTimeout(function () { try { ensureBridge(); } catch (_) {} }, 1500);
    });
    bridgeChild = child;
    diag('bridge child (re)started pid=' + child.pid);
  } catch(e) {
    diag('bridge fork fail: ' + (e.message||e).slice(0,120));
    resolveBridgeReady(false);
  }
  finally { bridgeRestarting = false; }
}

function invalidateRuntimeGrant(reason) {
  runtimeSessionValidated = false;
  try { require('./runtime_key_store').clear(); } catch (_) {}
  bridgeUploadToken = '';
  resolveBridgeReady(false);
  try { require('./omni_agent').setBridgeToken(''); } catch (_) {}
  const child = bridgeChild;
  bridgeChild = null;
  if (child && !child.killed) { try { child.kill(); } catch (_) {} }
  diag('runtime grant invalidated reason=' + String(reason || 'unknown').slice(0, 40));
}

// [DRAG-ZIP 2026-11-08] 文件夹拖入 → 主进程打 zip（PowerShell Compress-Archive, windowsHide 无弹窗）
// 回喂 renderer 一张 zip 附件卡（与 WorkBuddy 手感一致: 拖进去一张卡, 无气泡无注入）。
// 纯文件拖入不走这里 —— preload 直接放行 LibreChat 原生附件(走 /api/files)。
ipcMain.handle('omni:zip-folders', async (e, jobs) => {
  if (!trustedSender(e)) { diag('zip-folders from untrusted frame rejected'); return { ok: false, error: 'forbidden' }; }
  if (!Array.isArray(jobs) || !jobs.length || jobs.length > 8) return { ok: false, error: 'bad payload' };
  const tmpRoot = path.join(app.getPath('userData'), 'tmp-zips');
  try { fs.mkdirSync(tmpRoot, { recursive: true }); } catch (_) {}
  const zips = [];
  for (const job of jobs) {
    const root = String(job && job.root || 'folder').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'folder';
    const files = Array.isArray(job.files) ? job.files : [];
    if (!files.length) continue;
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const zipPath = path.join(tmpRoot, root + '-' + stamp + '.zip');
    // 写文件清单(UTF-8 BOM, PowerShell -Encoding 兼容中文路径), Compress-Archive 按清单精确打包
    const listPath = zipPath + '.txt';
    const lines = files.map((f) => String((f && f.abs) || '')).filter(Boolean);
    if (!lines.length) continue;
    try { fs.writeFileSync(listPath, '\uFEFF' + lines.join('\r\n'), 'utf8'); } catch (_) { continue; }
    try {
      const { execFile } = require('child_process');
      await new Promise((res, rej) => {
        execFile('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          "$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath (Get-Content -LiteralPath '" + listPath + "' -Encoding UTF8 | Where-Object {$_ -ne ''}) -DestinationPath '" + zipPath + "' -Force"
        ], { windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err) => err ? rej(err) : res());
      });
      const data = fs.readFileSync(zipPath);
      if (data.length) zips.push({ name: root + '.zip', data });
    } catch (err) {
      diag('zip-folders failed root=' + root + ' err=' + String(err && err.message || err).slice(0, 100));
    } finally {
      try { fs.unlinkSync(listPath); } catch (_) {}
      try { fs.unlinkSync(zipPath); } catch (_) {}
    }
  }
  return { ok: true, zips };
});
ipcMain.handle('omni:get-config', (e) => trustedSender(e) ? { serverUrl: config.serverUrl, port: config.bridgePort } : { ok: false, error: 'forbidden' });
ipcMain.handle('omni:get-pending-import', (e) => {
  if (!trustedSender(e)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'pendingImport.json'), 'utf-8')); }
  catch (_) { return null; }
});
ipcMain.handle('omni:clear-pending-import', (e) => {
  if (!trustedSender(e)) return { ok: false, error: 'forbidden' };
  try { fs.unlinkSync(path.join(app.getPath('userData'), 'pendingImport.json')); } catch (_) {}
});
ipcMain.handle('omni:bridge-status', (e) => trustedSender(e) ? { listening: trayBridgeStatus === true } : { ok: false, error: 'forbidden' });   // [1.1.67] 真实探测缓存值
// ── 桌面控制: 截屏(desktopCapturer) + 窗口枚举(PowerShell 只读) ──
ipcMain.handle('omni:desktop-screenshot', async (e) => {
  if (!trustedSender(e)) return { ok: false, error: 'forbidden' };
  try {
    const { desktopCapturer } = require('electron');
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
    if (!sources || !sources.length) return { ok: false, error: '无可用屏幕源' };
    const png = sources[0].thumbnail.toPNG();
    const dir = path.join(require('os').homedir(), 'OmniShade', 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const dst = path.join(dir, 'shot-' + Date.now() + '.png');
    fs.writeFileSync(dst, png);
    diagnosticLog('screenshot', JSON.stringify({ path: dst, size: png.length }));
    return { ok: true, path: dst, size: png.length };
  } catch (e) { return { ok: false, error: (e.message || e).slice(0, 200) }; }
});
ipcMain.handle('omni:window-list', async (e) => {
  if (!trustedSender(e)) return { ok: false, error: 'forbidden' };
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile('powershell.exe', ['-NoProfile', '-Command',
      "Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Id,ProcessName,MainWindowTitle | Format-Table -AutoSize | Out-String -Width 300"],
      { timeout: 30000, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout) => {
        resolve(err && !stdout ? { ok: false, error: (err.message || '').slice(0, 200) } : { ok: true, text: stdout });
      });
  });
});

// ══════════════════ 本地聊天模式(chatMode==='local') ══════════════════
// 只服务本机 file:// 页: 渲染层 chat.js 经 preload 暴露的 window.omniChat 调用下列 handler,
// agent loop 事件(delta/reasoning/tool/tool_result/error/done)经 'omni:chat-event' 推回渲染层。
// 隔离: 不读写 config.json; 设置单独存 %APPDATA%/omnishade/omni_settings.json。
const OMNI_CHAT_MOCK = /^(1|true|yes)$/i.test(String(process.env.OMNI_CHAT_MOCK || ''));
const OMNI_SETTINGS_PATH = () => path.join(process.env.APPDATA || require('os').homedir(), 'omnishade', 'omni_settings.json');
// ── H3: omni_settings.json 只允许非机密(模型名/URL); provider key 仅来自账号同步的 models.json。 ──
const SECRET_SETTING_KEYS = ['apiKey', 'apikey', 'api_key', 'key', 'token', 'secret', 'password'];
// 旧版兼容: 老 omni_settings.json 里的明文 key 只删除，不迁入任何 HWID 绑定状态。
function migrateLegacySettingKey(o) {
  if (!o || typeof o !== 'object') return o;
  const plain = SECRET_SETTING_KEYS.map(k => (typeof o[k] === 'string' ? o[k].trim() : '')).find(v => !!v) || '';
  let dirty = false;
  for (const k of SECRET_SETTING_KEYS) if (Object.prototype.hasOwnProperty.call(o, k)) { delete o[k]; dirty = true; }
  if (plain) diag('legacy settings plaintext key removed apiKeyLen=' + plain.length);
  if (dirty) { try { fs.writeFileSync(OMNI_SETTINGS_PATH(), JSON.stringify(o, null, 1)); diag('omni_settings.json plaintext fields stripped'); } catch (_) {} }
  return o;
}
function loadOmniSettings() {
  try { const o = JSON.parse(fs.readFileSync(OMNI_SETTINGS_PATH(), 'utf8')); return migrateLegacySettingKey((o && typeof o === 'object') ? o : {}); }
  catch (_) { return {}; }
}
function saveOmniSettings(next) {
  try {
    const doc = Object.assign({}, next || {});
    for (const k of SECRET_SETTING_KEYS) delete doc[k];   // 写盘前硬性剥密(纵深防御)
    fs.mkdirSync(path.dirname(OMNI_SETTINGS_PATH()), { recursive: true });
    fs.writeFileSync(OMNI_SETTINGS_PATH(), JSON.stringify(doc, null, 1));
    return true;
  } catch (e) { diag('chat settings save fail: ' + String(e && e.message || e).slice(0, 120)); return false; }
}
// [客户端模型配置] 读取本机 models.json 的启用供应商(零服务器依赖)
function activeProvider() {
  try {
    const p = path.join(process.env.APPDATA || require('os').homedir(), 'omnishade', 'models.json');
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    return require('./model_selection').activeProvider(d);
  } catch (_) {}
  return null;
}
// Key 来源: 开发/测试显式 env override → 账号登录后服务器下发的 models.json active provider。
function resolveChatKey(st) {
  if (process.env.OMNI_ST_KEY) return process.env.OMNI_ST_KEY;
  const provider = activeProvider();
  return provider && typeof provider.key === 'string' ? provider.key : '';
}
function resolveChatKeyMeta(st) {
  if (process.env.OMNI_ST_KEY) return { masked: maskKey(process.env.OMNI_ST_KEY), apiKeyLen: String(process.env.OMNI_ST_KEY).length, source: 'env' };
  const provider = activeProvider();
  const key = provider && typeof provider.key === 'string' ? provider.key : '';
  return { masked: maskKey(key), apiKeyLen: key.length, source: key ? 'account-model-config' : 'none', baseURL: (provider && provider.url) || '' };
}
function maskKey(k) { k = String(k || ''); return !k ? '' : (k.length <= 8 ? '••••' : k.slice(0, 4) + '••••' + k.slice(-4)); }
function chatAgent() {
  try { return require('./omni_agent'); }
  catch (e) { diag('omni_agent load fail: ' + String(e && e.message || e).slice(0, 140)); return null; }
}
// [M9] UI 侧工具结果截断: 显式标记 + 码点安全切片; 总数用真实总长度(不再是截断后长度)
const UI_TOOL_RESULT_LIMIT = parseInt(process.env.OMNI_UI_TOOL_RESULT_LIMIT || '8000', 10);
function uiTruncateMarked(s, limit, meta) {
  const str = String(s == null ? '' : s);
  // 上游(omni_agent)已带标记时, 复用其中的真实总数
  const m = /…\[truncated (\d+)\/(\d+) 字符\]\s*$/.exec(str);
  const realTotal = (meta && meta.truncated && typeof meta.total === 'number') ? meta.total : (m ? parseInt(m[2], 10) : str.length);
  const body = m ? str.slice(0, m.index).replace(/\n$/, '') : str;
  const lim = parseInt(limit, 10) > 0 ? parseInt(limit, 10) : 0;
  if (lim && body.length > lim) {
    let end = lim;
    const c = body.charCodeAt(end - 1);
    if (c >= 0xD800 && c <= 0xDBFF) end -= 1;        // 不产生 lone surrogate
    const cut = body.slice(0, end);
    return { text: cut + '\n…[truncated ' + cut.length + '/' + realTotal + ' 字符]', truncated: true, total: realTotal, shown: cut.length };
  }
  return { text: str, truncated: !!m || !!(meta && meta.truncated), total: realTotal, shown: body.length };
}

function chatEmit(reqId, ev) {
  try { if (win && !win.isDestroyed()) win.webContents.send('omni:chat-event', Object.assign({ reqId }, ev)); } catch (_) {}
}
// 仅放行本机 file:// 页面(服务器 UI 即使拿到同名 API 也不能驱动本地 agent/写本机设置)
function chatLocalSender(e) { try { return String((e && e.senderFrame && e.senderFrame.url) || '').startsWith('file://'); } catch (_) { return false; } }
// L11(审核 2026-09-28): 敏感 handler 的发起页校验 — 只接受本机 file:// 页、本机 shim 源(localUiOrigin)
// 或配置服务器源(config.serverUrl). 用 origin 精确比较, 与 M7 同口径(裸前缀可被 userinfo 绕过)。
function trustedSender(e) {
  try {
    const u = String((e && e.senderFrame && e.senderFrame.url) || '');
    if (!u) return false;
    if (u.startsWith('file://')) return true;
    const origin = new URL(u).origin;
    if (localUiOrigin && origin === localUiOrigin) return true;
    let srv = ''; try { srv = new URL(config.serverUrl).origin; } catch (_) {}
    return !!srv && origin === srv;
  } catch (_) { return false; }
}
let chatAbort = null, chatSeq = 0;

function chatSettingsView() {
  const st = loadOmniSettings(), ag = chatAgent(), key = resolveChatKey(st), meta = resolveChatKeyMeta(st);
  return {
    ok: true, mock: OMNI_CHAT_MOCK, chatMode: config.chatMode || 'server',
    settingsPath: OMNI_SETTINGS_PATH(),
    settings: { model: st.model || '', baseURL: st.baseURL || '' },
    defaults: { model: (ag && ag.MODEL) || '', baseURL: (ag && ag.UPSTREAM) || '' },
    hasApiKey: !!meta.masked, apiKeyMasked: meta.masked, keySource: meta.source, keyBaseURL: meta.baseURL || '',
  };
}

ipcMain.handle('omni:chat-init', (e) => chatLocalSender(e) ? chatSettingsView() : { ok: false, error: 'forbidden' });
ipcMain.handle('omni:chat-settings-set', (e, s) => {
  if (!chatLocalSender(e)) return { ok: false, error: 'forbidden' };
  const p = s || {}, st = loadOmniSettings();
  if (typeof p.model === 'string') st.model = p.model.trim();
  if (typeof p.baseURL === 'string') {
    const bu = p.baseURL.trim();
    if (bu && !/^https?:\/\//i.test(bu)) return { ok: false, error: 'baseURL 必须为 http(s):// 地址' };
    st.baseURL = bu;
  }
  if (p.clearApiKey || (typeof p.apiKey === 'string' && p.apiKey.trim())) {
    return { ok: false, error: 'API Key 由注册账号自动恢复，本地手工 Key 已停用' };
  }
  if (!saveOmniSettings(st)) return { ok: false, error: '写入失败: ' + OMNI_SETTINGS_PATH() };
  diag('chat settings saved');
  return chatSettingsView();
});
ipcMain.handle('omni:chat-list-sessions', (e) => {
  if (!chatLocalSender(e)) return [];
  const ag = chatAgent(); return ag ? ag.listSessions() : [];
});
ipcMain.handle('omni:chat-load-session', (e, sid) => {
  if (!chatLocalSender(e)) return [];
  const ag = chatAgent(); return (ag && sid) ? ag.loadSession(String(sid)) : [];
});
ipcMain.handle('omni:chat-open-external', (e, url) => {
  if (!chatLocalSender(e)) return { ok: false, error: 'forbidden' };
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'scheme rejected' };
  try { require('electron').shell.openExternal(u); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});
ipcMain.handle('omni:chat-stop', (e) => {
  if (!chatLocalSender(e)) return { ok: false, error: 'forbidden' };
  try { if (chatAbort) { if (typeof chatAbort.abort === 'function') chatAbort.abort(); else chatAbort.aborted = true; } } catch (_) {}
  diag('chat stop requested');
  return { ok: true };
});
ipcMain.handle('omni:chat-send', async (e, payload) => {
  // [STAB-2026-11-08] 在途聊天流计数：崩溃归因需要"崩时是否在聊天"
  try { e.sender.__omniInflightChat = (e.sender.__omniInflightChat || 0) + 1; } catch (_) {}
  if (!chatLocalSender(e)) return { ok: false, error: 'forbidden' };
  const p = payload || {}, prompt = String(p.prompt || '');
  if (!prompt.trim()) return { ok: false, error: '空消息' };
  if (chatAbort) return { ok: false, error: '上一条仍在生成中' };
  const ag = chatAgent();
  if (!ag) return { ok: false, error: 'omni_agent.js 加载失败' };
  const sid = p.sid ? String(p.sid) : ag.sessionId();
  const reqId = 'r' + (++chatSeq);
  if (OMNI_CHAT_MOCK) { const a = { aborted: false }; chatAbort = a; setTimeout(() => chatMockRun(reqId, sid, a), 0); return { ok: true, reqId, sid, mock: true }; }
  const st = loadOmniSettings();
  const prov = activeProvider();                     // [客户端模型配置] 启用的供应商优先
  let selected;
  try { selected = require('./model_selection').selectModel(prov, p.model, st); }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
  const apiKey = prov.key;
  if (!apiKey) return { ok: false, error: '未配置 API Key — 点击右上角「设置」或按 Ctrl+M 打开「模型配置」填写' };
  const ac = new AbortController(); chatAbort = ac;
  // 只传会话消息；runAgentLoop.normalizeHistory 统一装载 FULL_SYSTEM_PROMPT，避免恢复路径注入 L0-only。
  let history = [];
  try { const old = ag.loadSession(sid); if (old.length) history = old; } catch (_) {}
  // 下一拍再起流: 保证 invoke 的 {reqId} 先到渲染层, 避免首个事件被 reqId 过滤丢掉
  setTimeout(() => {
    (async () => {
      try {
        const r = await ag.runAgentLoop({
          prompt, apiKey, sid, history,
          baseURL: prov.url,
          model: selected, models: [selected], protocol: prov.protocol || 'openai',
          signal: ac.signal,
          onDelta: (t) => chatEmit(reqId, { type: 'delta', text: t }),
          onReasoning: (t) => chatEmit(reqId, { type: 'reasoning', text: t }),
          onTool: (n, a) => chatEmit(reqId, { type: 'tool', name: n, args: a }),
          onToolResult: (n, o, meta) => { const tr = uiTruncateMarked(o, UI_TOOL_RESULT_LIMIT, meta); if (tr.truncated) diag('ui_tool_result_truncated shown=' + tr.shown + ' total=' + tr.total); chatEmit(reqId, { type: 'tool_result', name: n, result: tr.text, truncated: tr.truncated, total: tr.total }); },
        });
        const finDone = r.finish || 'stop';
        // 非成功终态与 shim 一致；主动停止仅 unfinished，不冒充成功也不标为错误。
        const unfinished = finDone !== 'stop' && finDone !== 'tool_calls';
        chatEmit(reqId, { type: 'done', sid: r.sid, rounds: r.rounds, finish: finDone, text: r.text, unfinished, error: unfinished && finDone !== 'aborted' });
      } catch (err) {
        const aborted = !!(ac.signal && ac.signal.aborted);
        chatEmit(reqId, { type: 'error', message: (aborted ? '已停止: ' : '') + String(err && err.message || err).slice(0, 500) });
        chatEmit(reqId, { type: 'done', sid, aborted, finish: aborted ? 'aborted' : ((err && err.finish) || 'error'), text: null, error: !aborted, unfinished: true });
      } finally { if (chatAbort === ac) chatAbort = null; }
    })();
  }, 0);
  return { ok: true, reqId, sid };
});

// ── 本地 LibreChat UI: 起本机 shim(静态托管 desktop/ui + 最小 API + SSE 桥) ──
let localUiSrv = null, localUiOrigin = '';
// [模型配置客户端化 1.1.28] 保存/启用模型后: 等当前任务空闲 → 刷新本地 UI, 模型选择器立即拿到新清单
let uiReloadPending = false;
function uiReloadForModels(w) {
  if (uiReloadPending) return;
  uiReloadPending = true;
  const step = () => {
    try {
      if (!w || w.isDestroyed()) { uiReloadPending = false; return; }
      const busy = localUiSrv && localUiSrv.hasActiveJobs && localUiSrv.hasActiveJobs();
      if (busy) { setTimeout(step, 4000); return; }
      uiReloadPending = false;
      w.webContents.reload();
      diag('model config changed -> UI reloaded (model list refresh)');
    } catch (_) { uiReloadPending = false; }
  };
  setTimeout(step, 800);
}
let modelConfigSyncStarted = false;
let modelConfigSyncTimer = null;
function readAccountSession() {
  try {
    const p = path.join(process.env.APPDATA || require('os').homedir(), 'omnishade', 'account.json');
    const a = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (a && a.token && a.email) ? a : null;
  } catch (_) { return null; }
}
function controlPost(pathname, body, timeoutMs) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const localPort = pathname === '/model-config' || pathname.startsWith('/kb/') ? 9102 : 9101;
    // [G103] 原 targets 只有 127.0.0.1 —— 那是开发机上的本地 license_server。
    // 客户机压根没有 9101/9102 → /runtime_grant 恒失败 → runtime_key.json 永不落地 →
    // ensureBridge() 因 runtimeSessionValidated=false 直接 return（托盘「操作桥：停止」）→
    // loadBridgeTools() 降级成零工具。整条授权/工具链全靠这个入口，必须给生产兜底。
    const targets = [
      { host:'127.0.0.1', port:localPort, tls:false, timeout:timeoutMs || 3000 },
    ];
    // gdlr.asia 的授权面挂在 /api 前缀下（与 shim 的 accountPost 同一套生产入口）
    if (process.env.OMNI_CONTROL_LOCAL_ONLY !== '1') {
      targets.push({ host:'gdlr.asia', port:443, tls:true, pathPrefix:'/api', timeout: Math.max(Number(timeoutMs) || 0, 8000) });
    }
    let n=0;
    const next = () => {
      if (n >= targets.length) return resolve(null);
      const t=targets[n++], mod=t.tls ? require('https') : require('http'); let done=false;
      const finish=(v)=>{if(!done){done=true;v ? resolve(v) : next();}};
      try {
        const tlsPin = t.tls ? pinnedTlsOptions(t.host) : {};   // [G103] gdlr.asia 无 pin 时返回空对象=系统 CA 校验
        const reqPath = String(t.pathPrefix || '') + pathname;   // [G103] 生产入口带 /api 前缀
        const req=mod.request(Object.assign({host:t.host,port:t.port,path:reqPath,method:'POST',headers:{'Content-Type':'application/json','Content-Length':payload.length},timeout:t.timeout},tlsPin),(resp)=>{
          let raw=''; resp.setEncoding('utf8'); resp.on('data',(c)=>{raw+=c;}); resp.on('end',()=>{let data=null;try{data=JSON.parse(raw);}catch(_){};
            // Expected application 4xx responses are valid endpoint answers; routing/transport failures advance.
            if (data && (resp.statusCode < 500 || resp.statusCode === 401 || resp.statusCode === 403)) return finish({status:resp.statusCode,data});
            finish(null);
          });
        });
        req.on('timeout',()=>{try{req.destroy();}catch(_){}finish(null);}); req.on('error',()=>finish(null)); req.end(payload);
      } catch (_) { finish(null); }
    };
    next();
  });
}
// 最近一次 runtime grant 失败的服务端原话（status + error）。
// 旧版把它吞掉，shim 只能回「运行时授权获取失败，请重试」——用户看不到真正的
// 「未绑定卡密 / 已到期 / 卡密绑了别的账号」，只能反复点重试。这里必须留证据。
let lastGrantFailure = null;
async function refreshRuntimeGrant(account) {
  const store = require('./runtime_key_store');
  const token = String(account && account.token || '');
  const email = String(account && account.email || '').toLowerCase();
  if (!token || !email) { lastGrantFailure = { status: 'missing-account', error: '本机未登录账号' }; invalidateRuntimeGrant('missing-account'); return false; }
  try {
    const res = await controlPost('/runtime_grant', { token });
    const body = res && res.data;
    if (!res || res.status !== 200 || !body || body.status !== 'runtime-grant' || !omniVerifyAccountEnvelope(body)) {
      // 服务端明确拒绝时优先采信它的 status/error，别用笼统的签名校验失败盖掉真正原因
      const st = String((body && body.status) || (res && res.status === 0 ? 'unreachable' : 'grant-rejected'));
      const msg = String((body && body.error) || '');
      lastGrantFailure = { status: st, error: msg };
      throw new Error(st + (msg ? ': ' + msg : ''));
    }
    const key = store.validateKey(body.runtime_key_b64);
    if (String(body.email || '').toLowerCase() !== email) throw new Error('runtime grant account mismatch');
    if (typeof body.expires_at !== 'number' || !Number.isFinite(body.expires_at) || body.expires_at <= Date.now() / 1000) throw new Error('runtime grant expired');
    // 套餐能力：soft=false 是"仅知识库"档（kb_day/kb_month），必须裁掉桌面工具，
    // 否则 20 块的卡能用到 588 的全套能力。缺字段时按 all 处理，不误伤软件卡。
    const toolScope = (body.soft === false) ? 'kb' : 'all';
    // 先记住旧范围，落盘后比对：换了套餐就必须重建 bridge，否则范围改动不生效。
    let prevScope = null;
    try { const g = store.load(); prevScope = g && g.toolScope; } catch (_) { prevScope = null; }
    store.store({
      runtime_key_b64: key, email, expires_at: body.expires_at, toolScope,
      // 服务端 /runtime_grant 把商业套餐和当日配额一起下发，原样落盘给授权面板用。
      // 缺字段就传 undefined，store() 会沿用上一份快照而不是清零。
      sku: body.sku, skuName: body.sku_name, soft: body.soft, kb: body.kb,
      kb_daily: body.kb_daily, kb_used: body.kb_used, kb_remain: body.kb_remain,
      issued_at: body.issued_at,
    });
    runtimeSessionValidated = true;
    lastGrantFailure = null;
    if (!restartBridgeIfScopeChanged(prevScope, toolScope)) ensureBridge();
    return true;
  } catch (error) {
    if (!lastGrantFailure) lastGrantFailure = { status: 'grant-rejected', error: String(error && error.message || error).slice(0, 120) };
    invalidateRuntimeGrant('grant-rejected');
    diag('runtime grant refresh failed: ' + String(error && error.message || error).slice(0, 140));
    return false;
  }
}

// ── [本机授权] 本地 license.key → runtime key → 起桥 ──
// 背景: refreshRuntimeGrant() 依赖 127.0.0.1:9101 的 /runtime_grant(仓库内无服务端实现),
//      导致 runtime_key.json 永不写入 → ensureBridge() 因 runtimeSessionValidated=false 直接 return → 工具能力全废。
// 改法: 本机版直接用本地 Ed25519 license 里封的资产密钥(asset_key)落 runtime key 并置位起桥;
//      失败(invalid / no-asset-key / 异常)一律返回 false, 由调用方回落原账号授权路径, 保持兼容。
function localRuntimeGrantFromLicense() {
  try {
    const lic = require('./license_client');
    const grant = lic.localRuntimeGrant();
    if (!grant || grant.ok !== true || !grant.runtime_key_b64) {
      diag('local license grant unavailable reason=' + String(grant && grant.reason || 'unavailable').slice(0, 60));
      return false;
    }
    const store = require('./runtime_key_store');
    // validateKey 兜一道: 必须是规范 32B base64, 否则 bridge_loader.decodeKey 会拒绝
    const key = store.validateKey(grant.runtime_key_b64);
    store.store({ runtime_key_b64: key, email: grant.email || 'local@omnishade', expires_at: Number(grant.expires_at || 0) });
    runtimeSessionValidated = true;
    ensureBridge();
    diag('local license grant accepted exp=' + Number(grant.expires_at || 0) + ' tier=' + String(grant.tier || '-'));
    return true;
  } catch (error) {
    diag('local license grant failed: ' + String(error && error.message || error).slice(0, 140));
    return false;
  }
}

// ── [本机授权] 面板数据面 —— 由 preload 下沉到主进程 ──────────────────────────
// [G16 沙箱修复] 这三个函数原先写在 preload.js 里(直接 require('./license_client') +
// fs/os/path)。Electron ≥20 预加载默认沙箱化后 require('fs') 抛错 → preload 整体加载失败 →
// window.omnishade/omniChat 全空。文件 IO 只能在主进程做, 所以整段原样搬过来, preload 侧
// 只剩 ipcRenderer.invoke。调用方来源仍走 trustedSender() —— 与 omni:get-config 同口径。
function licenseUserPath() {
  const base = process.env.APPDATA
    || (process.platform === 'darwin'
      ? path.join(require('os').homedir(), 'Library', 'Application Support')
      : require('os').homedir());
  return path.join(base, 'omnishade', 'license.key');
}

function attachPlan(st) {
  // 把 runtime grant 快照（套餐 + 当日 KB 配额）并进授权状态，供面板「套餐与用量」卡片使用。
  // 读不到就留 plan=null，面板显示「—」，绝不编造数字。
  try {
    const store = require('./runtime_key_store');
    const g = store.load();
    if (g && (g.sku || g.kb_daily || g.kb_used || g.kb_remain)) {
      const scopeAll = g.toolScope === 'all';
      st.plan = {
        email: g.email || '',
        sku: g.sku || '',
        skuName: g.skuName || g.sku || '',
        soft: g.soft,
        kb: g.kb,
        kbDaily: Number(g.kb_daily || 0),
        kbUsed: Number(g.kb_used || 0),
        kbRemain: Number(g.kb_remain || 0),
        toolScope: g.toolScope || 'all',
        toolCount: scopeAll ? 27 : 5,
        expiresAt: Number(g.expires_at || 0),
        issuedAt: Number(g.issued_at || 0),
      };
      // 账号套餐有效时，整体状态视为 active。
      // 本地 license.key 只是可选的离线授权通道，不是唯一激活来源——
      // 只卖线上账号卡密的场景下根本没有本地 key，不能因为 key 缺失就显示「未激活」。
      const planExp = Number(g.expires_at || 0);
      if (!st.valid && planExp > Math.floor(Date.now() / 1000)) {
        st.state = 'active';
        st.reason = 'account';
        if (!st.source) st.source = 'account';
      }
    } else {
      st.plan = null;
    }
  } catch (_) { st.plan = null; }
  return st;
}

function licenseStatusRaw() {
  let lc = null;
  try { lc = require('./license_client'); } catch (_) { lc = null; }
  const out = {
    available: !!lc, ok: false, valid: false, state: 'unknown',
    reason: lc ? 'no-license' : 'no-api',
    expires: 0, tier: null, fingerprint: null, machineFingerprint: '',
    source: '', path: '', daysLeft: null,
  };
  if (!lc) { out.state = 'error'; return attachPlan(out); }

  try { out.machineFingerprint = String(lc.currentFingerprint() || ''); } catch (_) { out.machineFingerprint = ''; }

  // 候选顺序: 用户目录(可写, UI 激活落点) → 内置(打包随包)
  const candidates = [];
  try { const p = licenseUserPath(); if (fs.existsSync(p)) candidates.push({ path: p, source: 'user' }); } catch (_) {}
  try { const p = lc.DEFAULT_LICENSE_PATH; if (p && fs.existsSync(p)) candidates.push({ path: p, source: 'bundled' }); } catch (_) {}
  if (!candidates.length) { out.state = 'inactive'; return attachPlan(out); }

  let picked = null;
  for (const c of candidates) {
    const r = lc.verifyLicense({ licensePath: c.path }) || {};
    const item = Object.assign({}, r, { path: c.path, source: c.source });
    if (r.valid === true) { picked = item; break; }
    if (!picked) picked = item; // 全部不过时保留第一个候选的结果(用户目录优先)
  }
  const st = Object.assign(out, picked);
  st.valid = st.valid === true;
  st.ok = st.valid;
  // 校验失败分支不回带 fingerprint, 直接读文件补上, 面板才能显示「绑定的指纹」
  if (!st.fingerprint) {
    try {
      const raw = JSON.parse(fs.readFileSync(st.path, 'utf8'));
      if (raw && typeof raw.fingerprint === 'string') st.fingerprint = raw.fingerprint;
    } catch (_) {}
  }
  const stateMap = { expired: 'expired', 'fingerprint-mismatch': 'mismatch', 'no-license': 'inactive' };
  st.state = st.valid ? 'active' : (stateMap[st.reason] || 'error');
  const exp = Number(st.expires || 0);
  st.daysLeft = exp ? Math.max(0, Math.ceil((exp * 1000 - Date.now()) / 86400000)) : null;
  return attachPlan(st);
}


// [AUTO-PERPETUAL 2026-11-09] 老板口径: 自动激活永久——任何机器开箱即永久有效,
// DRM(完整性+VMP+runtime 门禁)只保护代码, 不拦使用。shim 付费硬闸读同一函数, 一处生效全链放行。
const PERPETUAL_EXPIRES = 4102444800; // 2100-01-01
function licenseStatus() {
  let raw = null;
  try { raw = licenseStatusRaw(); } catch (_) { raw = null; }
  const base = (raw && typeof raw === 'object') ? raw : {};
  const out = Object.assign({}, base, {
    available: true, ok: true, valid: true,
    state: 'active', permanent: true,
    license: Object.assign({}, base.license, { type: 'perpetual', expiresAt: PERPETUAL_EXPIRES }),
    plan: Object.assign({ sku: 'perpetual', expiresAt: PERPETUAL_EXPIRES, soft: true }, base.plan),
  });
  return out;
}

function licenseActivate(text) {
  let lc = null;
  try { lc = require('./license_client'); } catch (_) { lc = null; }
  if (!lc) return { ok: false, reason: 'no-api', status: null, targets: [] };

  let parsed = null;
  try { parsed = JSON.parse(String(text == null ? '' : text)); } catch (_) { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'bad-json', status: null, targets: [] };
  }

  const targets = [];
  try {
    const p = licenseUserPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    targets.push({ path: p, tag: 'user' });
  } catch (_) {}
  try {
    const p = lc.DEFAULT_LICENSE_PATH;
    // 内置路径只在可写时(解包/开发态)作为第二落点; 打包进 asar 时 existsSync 为真但写入会 EROFS, 靠 try 兜住
    if (p && fs.existsSync(path.dirname(p))) targets.push({ path: p, tag: 'bundled' });
  } catch (_) {}
  if (!targets.length) return { ok: false, reason: 'read-error', status: null, targets: [] };

  const payload = JSON.stringify(parsed, null, 1);

  // ① 先在临时文件上完整校验: 验签 + 指纹 + 有效期, 不通过绝不覆盖现有授权
  const probePath = targets[0].path + '.probe-' + Date.now();
  try {
    fs.writeFileSync(probePath, payload, 'utf8');
    const probe = lc.verifyLicense({ licensePath: probePath }) || {};
    if (probe.valid !== true) {
      try { fs.unlinkSync(probePath); } catch (_) {}
      return { ok: false, reason: probe.reason || 'bad-license', status: probe, targets: [] };
    }
  } catch (e) {
    try { fs.unlinkSync(probePath); } catch (_) {}
    return { ok: false, reason: 'read-error', status: null, targets: [] };
  }

  // ② 逐落点原子写入: 备份原文件 → 写 tmp → rename 覆盖
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const results = [];
  let firstOk = null;
  let lastErr = 'read-error';
  for (const t of targets) {
    try {
      if (fs.existsSync(t.path)) {
        try { fs.copyFileSync(t.path, t.path + '.bak-' + stamp); } catch (_) {}
      }
      const tmp = t.path + '.tmp-' + Date.now();
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, t.path); // 同分区 rename 原子替换, 避免半截文件
      results.push({ path: t.path, tag: t.tag, ok: true, error: null });
      if (!firstOk) firstOk = t.path;
    } catch (e) {
      lastErr = 'read-error';
      results.push({ path: t.path, tag: t.tag, ok: false, error: String((e && e.code) || (e && e.message) || e) });
    }
  }
  try { fs.unlinkSync(probePath); } catch (_) {}

  if (!firstOk) return { ok: false, reason: lastErr, status: null, targets: results };
  // ③ 写后回读复核: 面板拿到的是真实落盘状态, 不是「我觉得写成功了」
  const after = lc.verifyLicense({ licensePath: firstOk }) || {};
  return { ok: after.valid === true, reason: after.reason || 'ok', path: firstOk, targets: results, status: after };
}

// 授权面板数据面 IPC: 与 omni:get-config 同口径, 非本机/非 file:// 来源一律 forbidden。
ipcMain.handle('omni:license-status', (e) => {
  if (!trustedSender(e)) return { available: false, ok: false, valid: false, state: 'error', reason: 'forbidden' };
  try { return licenseStatus(); }
  catch (_) { return { available: false, ok: false, valid: false, state: 'error', reason: 'no-api' }; }
});
ipcMain.handle('omni:license-activate', (e, text) => {
  if (!trustedSender(e)) return { ok: false, reason: 'forbidden', status: null, targets: [] };
  try { return licenseActivate(text); }
  catch (_) { return { ok: false, reason: 'read-error', status: null, targets: [] }; }
});

async function validAccountSession(acct) {
  const a=acct || readAccountSession();
  if (!a || !a.token) return false;
  const r=await controlPost('/session_heartbeat',{token:a.token},8000);
  return !!(r && r.status===200 && r.data && omniVerifyAccountEnvelope(r.data) && r.data.ok && r.data.status==='ok');
}
function modelsFileHasUsableConfig(mp) {
  try {
    const m=JSON.parse(fs.readFileSync(mp,'utf8'));
    return !!(m && typeof m.active==='string' && m.active && Array.isArray(m.providers)
      && m.providers.some((p)=>p && p.name && p.url && typeof p.key==='string' && p.key.trim()
        && Array.isArray(p.models) && p.models.length > 0));
  } catch (_) { return false; }
}
function scheduleModelConfigRetry() {
  if (modelConfigSyncTimer) return;
  modelConfigSyncTimer=setTimeout(()=>{modelConfigSyncTimer=null; modelConfigSyncStarted=false; startModelConfigSyncAfterAuth();},15000);
  try { if (modelConfigSyncTimer.unref) modelConfigSyncTimer.unref(); } catch (_) {}
}
async function startModelConfigSyncAfterAuth() {
  if (modelConfigSyncStarted) return;
  const acct=readAccountSession(); if (!acct || !(await validAccountSession(acct))) return;
  modelConfigSyncStarted=true;
  try {
    const px=require('path'); const mp=px.join(process.env.APPDATA || require('os').homedir(),'omnishade','models.json');
    if (modelsFileHasUsableConfig(mp)) return;
    const r=await controlPost('/model-config',{token:acct.token},12000);
    const models=r && r.status===200 && r.data && r.data.models;
    if (!models || !Array.isArray(models.providers) || !models.providers.some((p)=>p && p.name && p.url)) {
      modelConfigSyncStarted=false; scheduleModelConfigRetry(); return;
    }
    fs.mkdirSync(px.dirname(mp),{recursive:true});
    try { if(fs.existsSync(mp)) fs.copyFileSync(mp,mp+'.bak-sync'); } catch(_) {}
    fs.writeFileSync(mp,JSON.stringify(models,null,1),'utf8');
    diag('models.json synced after verified account auth');
    try { if(win&&!win.isDestroyed()) uiReloadForModels(win); } catch(_) {}
  } catch (_) { modelConfigSyncStarted=false; scheduleModelConfigRetry(); }
}


async function startLocalUi(w) {

  try {
    const { startUiShim } = require('./ui_shim');
    // H1: 主进程为本次启动生成随机 token, 交由 shim 注入渲染层(index.html bootstrap)并校验 /api/*
    const shimToken = require('crypto').randomBytes(32).toString('hex');
    const shimOpts = {
      mock: OMNI_CHAT_MOCK, testAllowMockAccount: OMNI_CHAT_MOCK && process.env.OMNI_TEST_ALLOW_MOCK_ACCOUNT === '1',
      agent: chatAgent, settings: loadOmniSettings,
      key: () => resolveChatKey(loadOmniSettings()),
      token: shimToken,
      appVersion: APP_VERSION,
      onModelsChanged: () => uiReloadForModels(w),   // [1.1.28] 模型配置变更 → 自动刷新界面   // [UI 版本] 真实 APP 版本下发 shim: 镜像产物里写死的页脚/关于页版本串运行时替换, 不硬编码第二份
      onAccountInvalidated: (reason) => invalidateRuntimeGrant(reason),
      onAccountAuthenticated: Object.assign((account) => refreshRuntimeGrant(account),
        { lastFailure: () => lastGrantFailure }),
      onAccountSaved: async () => {
        try { await scheduleAccountTransfers('interactive-login'); } catch (_) {}
      },
      // 授权面板的回环数据面：面板在 Electron 里走 preload IPC，
      // 但在浏览器/无 preload 的场景下要能通过 /api/omni-license/* 拿到同一份数据。
      // 直接传函数引用，shim 侧同步调用，读的仍是同一个 licenseStatus()。
      licenseStatus: () => licenseStatus(),
      licenseActivate: (text) => licenseActivate(text),
    };
    // [1.1.77] shim 固定端口 9435: 应用重启后端口不变 → 旧注册页/登录窗口不再打空(随机端口导致窗口全部失效报"无法连接授权服务器"); 被占则随机兜底
    try {
      localUiSrv = await startUiShim(Object.assign({ port: 9435 }, shimOpts));
    } catch (ePort) {
      localUiSrv = await startUiShim(shimOpts);
    }
    localUiOrigin = 'http://127.0.0.1:' + localUiSrv.port;
    diag('local ui shim listening ' + localUiOrigin);
    // 已有会话先刷新 signed runtime grant，再串行同步；新部署机先显示登录页。
    // [本机授权] 先试本地 license.key: 命中则直接落 runtime key + 起桥, 不再打 127.0.0.1:9101 账号会话路径
    if (localRuntimeGrantFromLicense()) {
      diag('local license grant used; skip server session grant');
    } else {
    try {
      const ap = path.join(process.env.APPDATA || require('os').homedir(), 'omnishade', 'account.json');
      if (fs.existsSync(ap)) setTimeout(async () => {
        try {
          const account = JSON.parse(fs.readFileSync(ap, 'utf8'));
          if (await validAccountSession(account) && await refreshRuntimeGrant(account)) {
            await scheduleAccountTransfers('saved-session');
          } else {
            require('./runtime_key_store').clear();
          }
        } catch (_) {}
      }, 8000);
    } catch (_) {}
    }
    if (w && !w.isDestroyed()) w.loadURL(localUiOrigin + '/');
  } catch (e) {
    diag('local ui shim fail: ' + String(e && e.message || e).slice(0, 160));
    if (w && !w.isDestroyed()) { try { w.loadFile(path.join(__dirname, 'chat.html')); } catch (_) {} }   // shim 起不来 → 回落极简页
  }
}

// ── MOCK 自测流(OMNI_CHAT_MOCK=1): 逐字 markdown + 一张工具卡片 + 结束, 全程不触网 ──
const CHAT_MOCK_REPLY = [
  '## 本地链路自检 (MOCK)',
  '',
  '**结论**: 本地 agent 通道已连通；`chat.js` 的流式 markdown 与工具卡片按预期工作。',
  '',
  '- delta 逐字到达，未丢字、未闪烁',
  '- 转义自检 A: <img src=x onerror="window.xssProbe=1"> 与 <script>window.xssProbe=1</script> 应按纯文本显示',
  '- 转义自检 B(含双下划线, 走 markdown 强调分支): <img src=x onerror="window.__xss=1"> 同样不得产生元素',
  '- 链接自检: [示例文档](https://example.com/docs) 与裸链接 https://example.com/plain',
  '',
  '| 组件 | 状态 | 备注 |',
  '| --- | --- | --- |',
  '| preload / IPC | OK | omniChat 通道 |',
  '| markdown 渲染 | OK | 代码块 / 粗体 / 列表 / 表格 |',
  '',
  '```json',
  '{"mock": true, "rounds": 1, "finish": "stop"}',
  '```',
  '',
  '危险协议自检: [点我](javascript:window.__xss=1) 应降级为纯文本(无 href)。',
].join('\n');

function chatMockRun(reqId, sid, a) {
  const D = parseInt(process.env.OMNI_CHAT_MOCK_DELAY || '12', 10);
  const steps = [];
  steps.push(() => chatEmit(reqId, { type: 'reasoning', text: 'MOCK: 收到指令 → 走本地 loop → 汇总结论。' }));
  (CHAT_MOCK_REPLY.match(/[\s\S]{1,3}/g) || []).forEach(ch => steps.push(() => chatEmit(reqId, { type: 'delta', text: ch })));
  steps.push(() => chatEmit(reqId, { type: 'tool', name: 'win_sysinfo', args: { scope: 'cpu,mem', detail: true } }));
  steps.push(() => chatEmit(reqId, { type: 'tool_result', name: 'win_sysinfo', result: JSON.stringify({
    os: 'Windows 10 22H2', cpu: { cores: 8, model: 'Intel Core i7' },
    mem: { total_gb: 32, used_gb: 11.4 }, tool: 'win_sysinfo', ms: 41 }, null, 1) }));
  steps.push(() => chatEmit(reqId, { type: 'delta', text: '\n\n工具卡片自检: 点击卡片头部可展开/折叠，结果区显示返回摘要。' }));
  steps.push(() => chatEmit(reqId, { type: 'done', sid, rounds: 1, finish: 'stop', mock: true }));
  let i = 0;
  setTimeout(function tick() {
    if (a.aborted) { chatEmit(reqId, { type: 'error', message: '已停止: MOCK 流被中止' }); chatEmit(reqId, { type: 'done', sid, aborted: true }); if (chatAbort === a) chatAbort = null; return; }
    if (i >= steps.length) { if (chatAbort === a) chatAbort = null; return; }
    steps[i++]();
    setTimeout(tick, D);   // 首拍也延后: 保证 invoke 响应先回渲染层(否则渲染层还没拿到 reqId)
  }, D);
}

// ── 本机→HK 反向隧道(MCP) 自愈启动: pidfile 单例 ──
function startTunnelKeepalive() {
  try {
    const bat = path.join(__dirname, 'tunnel_mcp_keepalive.bat');
    const key = path.join(require('os').homedir(), '.ssh', 'hk_proxy_ed25519');
    if (!fs.existsSync(bat) || !fs.existsSync(key)) { diag('tunnel skip: bat/key missing'); return; }
    const pidFile = path.join(app.getPath('userData'), 'tunnel.pid');
    let alive = false;
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (pid) { process.kill(pid, 0); alive = true; }
    } catch (_) {}
    if (alive) { diag('tunnel keepalive already running'); return; }
    const { spawn } = require('child_process');
    const child = spawn('cmd.exe', ['/c', bat], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.unref();
    try { fs.writeFileSync(pidFile, String(child.pid)); } catch (_) {}
    diag('tunnel keepalive started pid=' + child.pid);
  } catch (e) { diag('tunnel start fail: ' + (e.message || e).slice(0, 120)); }
}
ipcMain.handle('omni:open-official-site', async (e) => {
  if (!trustedSender(e)) return { ok: false, error: 'forbidden' };
  try { await shell.openExternal(OFFICIAL_SITE_URL); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err && err.message || err).slice(0, 160) }; }
});

diag('before single-instance-lock');
const gotLock = app.requestSingleInstanceLock();
diag('lock='+gotLock);
if (!gotLock) { diag('lock fail, quit'); app.quit(); } else {
diag('lock ok');
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });


// ── 自动更新(服务器发版, 客户端弹窗) ──
// APP_VERSION 已提升至模块顶层(单一来源, startLocalUi/更新链共用)
// HK 设置页「当前版本」: uaVersion() 从 navigator.userAgent 解析 OmniShade/x.y.z — app ready 前设 UA 回退
try { app.userAgentFallback = 'OmniShade/' + APP_VERSION + ' ' + app.userAgentFallback; } catch(_) {}
// ── Serialized stream download + SHA-256 verification ──
// Bulk traffic deliberately uses one stream: concurrent ranges can starve control traffic over the relay.
function sha256FileAsync(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
async function omniParallelDownload(url, dest, _parts, expectSha, onProgress, signal) {
  const netApi = require('electron').net;
  const parent = path.dirname(dest);
  try { fs.mkdirSync(parent, { recursive: true }); } catch (_) {}
  await new Promise((resolve, reject) => {
    let settled = false, req = null, file = null, idleTimer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try { clearTimeout(idleTimer); } catch (_) {}
      try { if (signal) signal.removeEventListener('abort', onAbort); } catch (_) {}
      fn(value);
    };
    const cleanup = () => { try { if (file) file.destroy(); } catch (_) {} try { fs.rmSync(dest, { force: true }); } catch (_) {} };
    const fail = (err) => {
      if (settled) return;
      cleanup();
      finish(reject, err instanceof Error ? err : new Error(String(err || 'download failed')));
    };
    const armIdle = () => {
      try { clearTimeout(idleTimer); } catch (_) {}
      idleTimer = setTimeout(() => { try { if (req) req.abort(); } catch (_) {} fail(new Error('download idle timeout')); }, 45000);
    };
    const onAbort = () => { try { if (req) req.abort(); } catch (_) {} fail(new Error('download aborted')); };
    if (signal && signal.aborted) return onAbort();
    try { if (signal) signal.addEventListener('abort', onAbort, { once: true }); } catch (_) {}
    try {
      req = netApi.request(url);
      armIdle();
      req.on('response', (resp) => {
        const status = Number(resp.statusCode || 0);
        if (status !== 200 && status !== 206) { try { req.abort(); } catch (_) {} return fail(new Error('HTTP ' + status)); }
        let received = 0;
        const total = parseInt(resp.headers['content-length'] || '0', 10) || 0;
        try { file = fs.createWriteStream(dest, { flags: 'w' }); } catch (e) { return fail(e); }
        resp.on('data', (chunk) => { received += chunk.length; armIdle(); try { if (total) onProgress && onProgress(received / total); } catch (_) {} });
        resp.on('error', fail);
        file.on('error', fail);
        file.on('finish', () => file.close((e) => e ? fail(e) : finish(resolve)));
        resp.pipe(file);
      });
      req.on('error', fail);
      req.end();
    } catch (e) { fail(e); }
  });
  if (expectSha) {
    const got = await sha256FileAsync(dest);
    if (got !== String(expectSha).toLowerCase()) { try { fs.unlinkSync(dest); } catch (_) {} throw new Error('sha256 mismatch'); }
  }
}
// [E1 自动更新] 完整流程: 查看 -> 静默下载(断点并发) -> 验签+sha256 -> NSIS 静默安装 -> 重启
//  - checkUpdate(true)                      : 启动路径, 发现新版即下载并安装(立即重启升级)
//  - checkUpdate(true,{prefetchOnly:true})  : 常驻路径, 只预下载并记 pending, 下次启动秒装(不打断进行中的任务)
const UPDATE_DIR = require('path').join(process.env.APPDATA || require('os').homedir(), 'omnishade', 'updates');
function pendingInfo() {
  try { return JSON.parse(require('fs').readFileSync(require('path').join(UPDATE_DIR, 'pending.json'), 'utf8')); }
  catch (_) { return null; }
}
function installUpdate(exePath) {
  const { spawn } = require('child_process');
  // [RC-4] 安装尝试计数: APP_VERSION 不变时失败会重装, attempts>=3 由 autoUpdateBoot 熔断
  try {
    const prev = pendingInfo();
    const rec = (prev && prev.file === exePath) ? prev : { file: exePath };
    rec.attempts = (rec.attempts || 0) + 1; rec.at = Date.now();
    const pendPath = require('path').join(UPDATE_DIR, 'pending.json');
    const tmpP = pendPath + '.tmp';
    require('fs').writeFileSync(tmpP, JSON.stringify(rec, null, 1));
    require('fs').renameSync(tmpP, pendPath);
  } catch (_) {}
  try { diag('auto-update: launching installer ' + exePath); } catch (_) {}
  // [RC-2] /S 静默 + --force-run: electron-builder assisted(oneClick:false) 安装器
  //        只有 isForceRun && Silent 才 doStartApp, 裸 /S 装完不拉起 = "更新完应用消失"
  spawn(exePath, ['/S', '--force-run'], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
  app.isQuitting = true;
  try { app.quit(); } catch (_) {}
  setTimeout(function () { try { app.exit(0); } catch (_) {} }, 2500);
}
// [RC-9] 更新链单飞锁: 启动路径/45min 预取/手动检查共用, 防并写同一 want
let updateBusy = false;
async function checkUpdate(silent, opts) {
  opts = opts || {};
  if (updateBusy) { diag('auto-update busy, skip'); return; }
  updateBusy = true;
  try {
    const d = await new Promise((resolve) => {
      const { net } = require('electron');
      const req = net.request(OMNI_HK() + '/version');
      let feedDone=false; const feedFinish=(v)=>{if(!feedDone){feedDone=true;resolve(v);}};
      req.setTimeout(12000,()=>{try{req.abort();}catch(_){}feedFinish(null);});
      req.on('response', (resp) => {
        let body = '';
        resp.on('data', (ch) => { body += ch.toString(); });
        resp.on('end', () => { try { feedFinish(JSON.parse(body)); } catch (_) { feedFinish(null); } });
      });
      req.on('error', () => feedFinish(null));
      req.end();
    });
    if (!d) return;
    // 更新链一律 Ed25519 验签(客户端内置公钥, 伪造/篡改响应必拒)
    const umsg = OMNI_UPDATE_PREFIX + [d.version, d.url || '', d.sha256 || ''].join('|');
    if (!omniVerifyIntegSig(umsg, d.sig || '')) { diag('update feed sig invalid'); return; }
    // Payload v2 binds version + URL + SHA-256 + size; unsigned delta metadata is ignored.
    if (d.payload) {
      const pmsg = payloadSigMessage(d.payload);
      if (!pmsg || !omniVerifyIntegSig(pmsg, d.payload.sig || '')) { diag('payload feed sig invalid -> ignored'); d.payload = null; }
    }
    if (!require('./version').isNewerVersion(d.version, APP_VERSION)) return;
    // 已有同一版本的预下载文件 → 启动路径直接安装
    const want = require('path').join(UPDATE_DIR, 'OmniShade-Setup-' + d.version + '.exe');
    const part = want + '.part'; const _ufs = require('fs');
    try { _ufs.mkdirSync(UPDATE_DIR, { recursive: true }); } catch (_) {}
    // Hash via stream: reading an 80MB installer synchronously stalled the Electron main process.
    const validFile = async (p) => { try { return !!(d.sha256 && _ufs.existsSync(p) && await sha256FileAsync(p) === d.sha256); } catch (_) { return false; } };
    let have = await validFile(want);
    if (!have) {
      try { _ufs.rmSync(want, { force:true }); _ufs.rmSync(part, { force:true }); } catch (_) {}
      if (silent && win && !win.isDestroyed()) { try { win.setTitle('OmniShade — 后台更新 v' + d.version + ' …'); } catch (_) {} }
      let ok = false, lastErr = null;
      for (let a = 0; a < 3 && !ok; a++) {
        try {
          await omniParallelDownload(d.url, part, 1, d.sha256 || '', (p) => { if (win && !win.isDestroyed()) { try { win.setTitle('OmniShade — 下载更新 v' + d.version + ' ' + Math.round(p * 100) + '%'); } catch (_) {} } });
          if (!await validFile(part)) throw new Error('verified installer missing');
          _ufs.renameSync(part, want); have=true; ok=true;
        } catch (e) { lastErr=e; try { _ufs.rmSync(part,{force:true}); } catch (_) {}; await new Promise((r)=>setTimeout(r,1500*(a+1))); }
      }
      if (!ok || !have) { diag('auto-update download fail: ' + String(lastErr && lastErr.message || lastErr).slice(0, 140)); return; }
    }
    // [RC-4] pending 原子写( tmp+rename ), attempts 随版本重置
    try {
      const prevPending = pendingInfo();
      const attempts = (prevPending && prevPending.version === d.version) ? (prevPending.attempts || 0) : 0;
      const pendPath = require('path').join(UPDATE_DIR, 'pending.json');
      const tmpP = pendPath + '.tmp';
      require('fs').writeFileSync(tmpP,
        JSON.stringify({ version: d.version, file: want, sha256: d.sha256 || '', attempts, at: Date.now() }, null, 1));
      require('fs').renameSync(tmpP, pendPath);
    } catch (_) {}
    if (opts.prefetchOnly) { diag('auto-update prefetched v' + d.version + ' (next boot installs)'); return; }
    if (silent) { installUpdate(want); return; }
    // 手动路径: 弹确认框
    const { dialog } = require('electron');
    const r = await dialog.showMessageBox({
      type: 'info', title: 'OmniShade 更新',
      message: '发现新版本 v' + d.version + '（当前 v' + APP_VERSION + '）',
      detail: (d.notes || '') + '\n点击"立即更新"将自动安装并重启。',
      buttons: ['立即更新', '稍后'], defaultId: 0,
    });
    if (r.response === 0) installUpdate(want);
  } catch (e) { diag('auto-update check fail: ' + String(e && e.message || e).slice(0, 140)); }
  finally {
    updateBusy = false;
    // [RC-6] 标题复位: 下载失败/中断不得永久占用窗口标题
    try {
      if (win && !win.isDestroyed()) {
        const t = win.getTitle();
        if (t && t.indexOf('更新') >= 0) { try { win.setTitle('OmniShade'); } catch (_) {} }
      }
    } catch (_) {}
  }
}
async function autoUpdateBoot() {
  try {
    const p = pendingInfo();
    if (p && p.file && p.sha256 && require('./version').isNewerVersion(p.version, APP_VERSION)) {
      // [RC-4] 熔断: 同一版本安装尝试 >=3 次仍停旧版 → 清 pending 放弃, 留诊断
      if ((p.attempts || 0) >= 3) {
        diag('auto-update: install attempts exhausted (v' + p.version + '), skip & clear pending');
        try { require('fs').unlinkSync(require('path').join(UPDATE_DIR, 'pending.json')); } catch (_) {}
        return;
      }
      if (require('fs').existsSync(p.file) && await sha256FileAsync(p.file) === p.sha256) {
        diag('auto-update: installing verified prefetched v' + p.version);
        installUpdate(p.file);
        return;
      }
    }
    // [RC-9] 启动路径只预取: 新版装包推迟到下一启动, 不在启动 2.5s 后自杀打断
    await checkUpdate(true, { prefetchOnly: true });
  } catch (e) { diag('auto-update boot fail: ' + String(e && e.message || e).slice(0, 140)); }
}
// [RC-1] handler 注册移到 checkUpdate 声明之后(同块内):
//        async function 块内声明不提升到模块作用域, 原先注册在块外 871 行必然 "checkUpdate is not defined"
ipcMain.handle('omni:check-update', async (e) => {
  if (!trustedSender(e)) return { ok: false, error: 'forbidden' };
  try { await checkUpdate(true); return { ok: true, started: true }; }
  catch (e2) { const msg = String(e2 && e2.message || e2).slice(0, 140); diag('update fail: ' + msg); return { ok: false, error: msg }; }
});

// ── [发布通道] gdlr latest.json: 启动异步检查 + UI 非打断入口 ──
// 与上面 HK /version 的静默预取安装是两条独立通道: 这条只"检查+提示", 永远不下载、不安装、不重启,
// 点击后交给系统浏览器打开清单里的官方安装包地址(shell.openExternal)。
const LATEST_JSON_URL = 'https://gdlr.asia/download/latest.json';
let latestUpdate = null;
function initLatestUpdate() {
  if (latestUpdate) return latestUpdate;
  latestUpdate = createLatestUpdate({
    currentVersion: app.getVersion(),
    fetchJson: createNetFetcher(require('electron').net),
    openExternal: (url) => shell.openExternal(url),
    log: (msg) => diag(msg),
    manifestUrl: LATEST_JSON_URL,
  });
  diag('latest-update: channel armed current=v' + app.getVersion() + ' manifest=' + LATEST_JSON_URL);
  return latestUpdate;
}
function publishLatestUpdate(st) {
  if (!st || st.phase !== 'update-available') return;
  try { if (win && !win.isDestroyed()) win.webContents.send('omni:latest-update', st); } catch (_) {}
}
async function checkLatestUpdate(force) {
  try {
    const st = await initLatestUpdate().check({ force: !!force });
    publishLatestUpdate(st);
    return st;
  } catch (e) {
    diag('latest-update: unexpected ' + String((e && e.message) || e).slice(0, 160));
    return null;
  }
}
ipcMain.handle('omni:latest-update-status', (e) => {
  if (!trustedSender(e)) return { ok: false, error: 'forbidden' };
  return initLatestUpdate().status();
});
ipcMain.handle('omni:latest-update-check', async (e) => {
  if (!trustedSender(e)) return { ok: false, error: 'forbidden' };
  return (await checkLatestUpdate(true)) || { ok: false, error: 'check-failed' };
});
ipcMain.handle('omni:latest-update-open', async (e) => {
  if (!trustedSender(e)) return { ok: false, error: 'forbidden' };
  try {
    const r = await initLatestUpdate().openDownload();
    return { ok: true, url: r.url, version: r.version };
  } catch (err) {
    return { ok: false, error: String((err && (err.code || err.message)) || err).slice(0, 160) };
  }
});

// Signed update/control origin. Product authorization is account-only.
// [G7-R1] 控制面只允许本机: 兜底也必须是本机中继, 不得回落任何远端地址
const OMNI_HK = () => (config.omniHk || 'https://127.0.0.1:9445');
function payloadSigMessage(p) {
  if (!p || typeof p !== 'object') return '';
  const version = String(p.version || '');
  const url = String(p.url || '');
  const sha = String(p.sha256 || '').toLowerCase();
  const size = String(p.size == null ? '' : p.size);
  if (!version || !/^https:\/\//.test(url) || !/^[a-f0-9]{64}$/.test(sha) || !/^[0-9]+$/.test(size)) return '';
  return OMNI_UPDATE_PREFIX + 'payload-v2|' + [version, url, sha, size].join('|');
}


// __OMNI_APPEARANCE_WIRING_BEGIN__
let modelConfigWindow = null;
let accountWindow = null;
let automationWindow = null;
function appearanceSender(e) {
  try {
    if (!e || !e.sender || !e.senderFrame || e.senderFrame.parent) return false;
    if (!localUiOrigin || new URL(e.senderFrame.url).origin !== localUiOrigin) return false;
    return [win, modelConfigWindow, automationWindow, accountWindow].some(w => w && !w.isDestroyed() && w.webContents === e.sender);
  } catch (_) { return false; }
}
function openLocalSettingsWindow(kind) {
  if (!localUiOrigin) {
    diag('local settings unavailable: local UI not ready');
    return { ok: false, error: '本地界面尚未就绪，请稍后再试' };
  }
  const existing = kind === 'model' ? modelConfigWindow : kind === 'automation' ? automationWindow : accountWindow;
  if (existing && !existing.isDestroyed()) {
    existing.show(); existing.focus(); return { ok: true };
  }
  const origin = localUiOrigin;
  const target = new BrowserWindow({
    ...windowAppearance.options(),
    // [WINDOW-ZORDER] 设置/账号/自动化是非模态子窗口：parent 让 Windows 把它们作为
    // 主窗口的 owned window，天然始终在主窗口之上，主窗口聚焦时也盖不住。
    // 不要加 alwaysOnTop：那是全局置顶，会把子窗口压在用户其它应用（浏览器/终端）上面。
    parent: win,
    width: kind === 'account' ? 840 : 1180, height: 800,
    minWidth: 680, minHeight: 560,
    title: kind === 'model' ? '供应商与模型 · OmniShade' : kind === 'automation' ? '自动化中心 · OmniShade' : '账号 · OmniShade',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true },
  });
  if (kind === 'model') modelConfigWindow = target;
  else if (kind === 'automation') automationWindow = target;
  else accountWindow = target;
  windowAppearance.attach(target);
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  target.webContents.on('will-navigate', (event, url) => {
    try {
      const next = new URL(url);
      if (next.origin !== origin) { event.preventDefault(); return; }
      if (!['/omni-model', '/omni-automation', '/omni-register', '/register'].includes(next.pathname)) {
        event.preventDefault();
        if (win && !win.isDestroyed()) { win.show(); win.focus(); }
        target.close();
      }
    } catch (_) { event.preventDefault(); }
  });
  target.on('closed', () => {
    if (kind === 'model') modelConfigWindow = null;
    else if (kind === 'automation') automationWindow = null;
    else accountWindow = null;
  });
  target.loadURL(origin + (kind === 'model' ? '/omni-model' : kind === 'automation' ? '/omni-automation' : '/omni-register'));
  return { ok: true };
}
function openModelConfig() { return openLocalSettingsWindow('model'); }
function openAutomation() { return openLocalSettingsWindow('automation'); }
function openAccount() { return openLocalSettingsWindow('account'); }
ipcMain.handle('omni:open-model-config', e => appearanceSender(e) ? openModelConfig() : { ok: false, error: 'forbidden' });
ipcMain.handle('omni:open-automation', e => appearanceSender(e) ? openAutomation() : { ok: false, error: 'forbidden' });
ipcMain.handle('omni:open-account', e => appearanceSender(e) ? openAccount() : { ok: false, error: 'forbidden' });

// ── [ARTEX 2026-11-08] 自主渗透控制台集成（不捆绑 exe, 防杀软盯防: 只发现+拉起+探活）──
// ARTEX 独立部署在 D:\老K日站工作区\ARTEX（Go 后端 8790 + PG 5433 + 流量代理 8788）。
// 集成面: 发现(多候选路径) / 启停(start-artex.bat 链路) / 探活(HTTP 200) / 打开(内嵌窗口)。
const ARTEX_CANDIDATES = [
  'D:\\老K日站工作区\\ARTEX\\app\\artex-0.3.15-global.1-windows-amd64\\artex.exe',
  'D:\\老K日站工作区\\ARTEX\\start-artex.bat',
];
const ARTEX_URL = 'http://127.0.0.1:8790/';
function artexLocate() {
  for (const c of ARTEX_CANDIDATES) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return null;
}
async function artexAlive() {
  try {
    const body = await net.fetch(ARTEX_URL, { signal: AbortSignal.timeout(3000) });
    return body.ok;
  } catch (_) { return false; }
}
async function artexStart() {
  const alive = await artexAlive();
  if (alive) return { ok: true, started: false, note: 'already running' };
  const bat = ARTEX_CANDIDATES[1];
  if (!fs.existsSync(bat)) return { ok: false, error: 'ARTEX 未部署: ' + bat };
  try {
    const { spawn } = require('child_process');
    spawn('cmd.exe', ['/c', bat], { cwd: require('path').dirname(bat), detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  // PG 起服务 + artex 起监听实测需 3~15s, 轮询探活至多 20s
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 2000));
    if (await artexAlive()) return { ok: true, started: true, note: 'ARTEX 起来了 (' + ((i + 1) * 2) + 's)' };
  }
  return { ok: false, error: '20s 内未探活 8790, 查 start-artex.bat 手动跑一次' };
}
ipcMain.handle('omni:artex-status', async (e) => {
  if (!trustedSender(e)) return { ok: false, error: 'forbidden' };
  return { ok: true, deployed: !!artexLocate(), alive: await artexAlive(), url: ARTEX_URL };
});
ipcMain.handle('omni:artex-start', async (e) => {
  if (!trustedSender(e)) return { ok: false, error: 'forbidden' };
  return artexStart();
});
ipcMain.handle('omni:artex-open', async (e) => {
  if (!trustedSender(e)) return { ok: false, error: 'forbidden' };
  const r = await artexStart();
  if (!r.ok) return r;
  try { await shell.openExternal(ARTEX_URL); return { ok: true, opened: true }; }
  catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});
ipcMain.handle('omni:appearance-get', e => appearanceSender(e) ? windowAppearance.snapshot() : { ok: false, error: 'forbidden' });
ipcMain.handle('omni:appearance-refresh', e => {
  if (!appearanceSender(e)) return { ok: false, error: 'forbidden' };
  const target = [win, modelConfigWindow, automationWindow, accountWindow].find(w => w && !w.isDestroyed() && w.webContents === e.sender);
  windowAppearance.refresh(target);
  return { ok: true };
});
ipcMain.handle('omni:appearance-update', (e, snapshot) => {
  if (!appearanceSender(e) || !win || e.sender !== win.webContents) return { ok: false, error: 'forbidden' };
  try {
    windowAppearance.update(snapshot);
    windowAppearance.refresh(win);
    return { ok: true };
  } catch (error) {
    diag('appearance sync failed: ' + String(error.message || error).slice(0, 120));
    return { ok: false, error: 'invalid-appearance' };
  }
});
// __OMNI_APPEARANCE_WIRING_END__



// [1.1.84] 数据面串行：更新包与知识包共用公网中转，绝不能与认证或彼此并发。
let dataPlaneQueue = Promise.resolve();
function enqueueDataPlane(label, fn) {
  const run = () => Promise.resolve().then(fn).catch((e) => { diag('data-plane ' + label + ' fail: ' + String(e && e.message || e).slice(0, 140)); });
  const next = dataPlaneQueue.then(run, run);
  dataPlaneQueue = next.catch(() => {});
  return next;
}
// [1.1.82] 资源包同步延后到账号认证成功；HK隧道带宽有限，首次538MB四流会让登录TLS握手超时。
let payloadSyncStarted = false;
let payloadRetryAttempts = 0;
let payloadRetryTimer = null;
function schedulePayloadRetry(reason) {
  if (payloadRetryTimer || payloadRetryAttempts >= 3) {
    diag('payload retry suppressed attempts=' + payloadRetryAttempts + ' reason=' + String(reason || '').slice(0, 100));
    return;
  }
  const attempt = ++payloadRetryAttempts;
  const delay = Math.min(5 * 60 * 1000, 15000 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 5000);
  diag('payload retry scheduled attempt=' + attempt + ' delayMs=' + delay + ' reason=' + String(reason || '').slice(0, 100));
  payloadRetryTimer = setTimeout(() => {
    payloadRetryTimer = null;
    if (hasAccountSession()) enqueueDataPlane('payload-retry', () => startPayloadSyncAfterAuth()).catch(() => {});
  }, delay);
}
function runPayloadWorker(remote, opts) {
  const o = opts || {};
  const { Worker } = require('worker_threads');
  const workerPath = path.join(__dirname, 'payload_worker.js');
  return new Promise((resolve, reject) => {
    const downloadAbort = new AbortController();
    // appDataDir 缺省时 worker 内走 defaultAppData()(%APPDATA%/omnishade); 测试可显式指到临时目录
    const worker = new Worker(workerPath, { workerData: { resourcesDir: process.resourcesPath || __dirname, remote: remote || null, appDataDir: o.appDataDir || undefined, force: !!o.force, wantStats: !!o.wantStats } });
    let finished = false;
    const finish = (ok, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (!ok) { try { downloadAbort.abort(); } catch (_) {} }
      if (ok) resolve(value); else reject(value instanceof Error ? value : new Error(String(value || 'payload worker failed')));
    };
    const timer = setTimeout(() => {
      try { downloadAbort.abort(); } catch (_) {}
      try { worker.terminate(); } catch (_) {}
      finish(false, new Error('payload worker timeout'));
    }, 45 * 60 * 1000);
    worker.on('message', (m) => {
      if (!m || finished) return;
      if (m.type === 'log') { diag('payload: ' + String(m.message || '').slice(0, 500)); return; }
      if (m.type === 'progress') {
        try { if (win && !win.isDestroyed() && m.p > 0) win.setTitle('OmniShade — 资源包同步 ' + Math.round(m.p * 100) + '%'); } catch (_) {}
        return;
      }
      if (m.type === 'download') {
        // Network stays in Electron's pinned main-process session. The worker only performs CPU/disk work.
        omniParallelDownload(m.url, m.dest, 1, '', (p) => {
          try { if (!finished) worker.postMessage({ type: 'download_progress', id: m.id, p }); } catch (_) {}
        }, downloadAbort.signal).then(() => {
          if (finished) return;
          let bytes = 0; try { bytes = fs.statSync(m.dest).size; } catch (_) {}
          try { worker.postMessage({ type: 'download_result', id: m.id, result: { bytes } }); } catch (_) {}
        }).catch((e) => {
          if (finished) return;
          try { worker.postMessage({ type: 'download_error', id: m.id, error: String(e && e.message || e).slice(0, 240) }); } catch (_) {}
        });
        return;
      }
      if (m.type === 'result') finish(true, m.result);
      if (m.type === 'error') finish(false, new Error(String(m.error || 'payload worker error')));
    });
    worker.on('error', (e) => finish(false, e));
    worker.on('exit', (code) => { if (!finished) finish(false, new Error('payload worker exited ' + code)); });
  });
}
// [冷启动 seed 修复] 去掉"登录后才 seed"的门控: app ready 后无条件触发一次本地种子。
// 只走 bundled-dir 分支(remote=null → 不下载远端), 把内嵌 product_data 平铺到
// %APPDATA%/omnishade(skills/kb/tools), 供 bridge 9431 直接读取。不置 payloadSyncStarted,
// 登录后的远程同步(startPayloadSyncAfterAuth)不受影响; ensurePayload 幂等, 中断可续铺。
let coldSeedStarted = false;
// [G1] 种子修订号: 内嵌 product_data 内容有增量(如补齐 136 个含空格/中文/重名文件)时 +1,
// 老装机 rev 不匹配 → 冷启动重跑一次 seed(只补缺失文件, seedFromDir 逐文件 existsSync 跳过已存在), 不整包重铺。
const COLD_SEED_REV = '20261031.1';
function coldSeedAppDataDir() {
  return path.join(process.env.APPDATA || require('os').homedir(), 'omnishade');
}
function coldSeedRevPath() { return path.join(coldSeedAppDataDir(), '.cold_seed_rev'); }
function coldSeedApplied() {
  try { return String(fs.readFileSync(coldSeedRevPath(), 'utf8') || '').trim() === COLD_SEED_REV; } catch (_) { return false; }
}
// [G78 出厂授权播种] 把包内 local_auth/license.key 复制到 %APPDATA%\omnishade\license.key。
// 为什么需要：出厂 license 只打在 asar 里的 local_auth/，而客户端运行时只认
// licenseUserPath()（%APPDATA%\omnishade\license.key）。不播种的话，用户装完首次启动
// 会看到「需要激活」——实测全新 APPDATA 下 9431 能起、但 license.key 不存在。
// 幂等：目标已存在就完全不动（绝不覆盖用户自己导入的授权）。
function ensureBundledLicense() {
  try {
    const dst = licenseUserPath();
    if (fs.existsSync(dst)) return;                       // 已有授权，零动作
    const src = path.join(__dirname, 'local_auth', 'license.key');
    if (!fs.existsSync(src)) {
      diag('license-seed: bundled license NOT FOUND at ' + src);
      return;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    diag('license-seed: bundled license installed -> ' + dst);
  } catch (e) {
    diag('license-seed: err ' + String(e && e.message || e).slice(0, 140));
  }
}
function coldSeedOnce() {
  if (coldSeedStarted) return;
  coldSeedStarted = true;
  // [G78 出厂授权播种] 必须在 coldSeedApplied() 早退之前执行 ——
  // 老装机 .cold_seed_rev 可能已匹配（rev 相同），但 %APPDATA%\omnishade\license.key
  // 未必存在（旧版没播过它）。所以这一步独立于 rev，每次启动都查一次，幂等。
  ensureBundledLicense();
  if (coldSeedApplied()) { diag('cold-seed: skip (rev ' + COLD_SEED_REV + ' already applied)'); return; }
  diag('cold-seed: trigger bundled dir seed (rev ' + COLD_SEED_REV + ', no login required)');
  // force: 绕过 .payload_version 的 up-to-date 早退, 保证新补齐的文件也能进 %APPDATA%;
  // seedFromDir 本身逐文件 existsSync, 已存在的不重写 —— 幂等, 不是全量重铺。
  runPayloadWorker(null, { force: true, wantStats: true }).then((r) => {
    diag('cold-seed: done ' + JSON.stringify(r && { changed: r.changed, reason: r.reason, mode: r.mode, version: r.version } || r));
    try {
      fs.mkdirSync(coldSeedAppDataDir(), { recursive: true });
      fs.writeFileSync(coldSeedRevPath(), COLD_SEED_REV + '\n');
    } catch (_) {}
    try { if (win && !win.isDestroyed()) win.setTitle('OmniShade'); } catch (_) {}
  }).catch((e) => {
    diag('cold-seed: err ' + String(e && e.message || e).slice(0, 160));
    try { if (win && !win.isDestroyed()) win.setTitle('OmniShade'); } catch (_) {}
  });
}
async function startPayloadSyncAfterAuth() {
  if (payloadSyncStarted) return;
  payloadSyncStarted = true;
  diag('payload: account authenticated -> deferred sync starts');
  try {
    let remote = null;
    try {
      const feed = await new Promise((resolve) => {
        const { net } = require('electron');
        const req = net.request(OMNI_HK() + '/version');
        req.setTimeout(12000, () => { try { req.abort(); } catch (_) {} resolve(null); });
        req.on('response', (resp) => { let b = ''; resp.on('data', (c) => { b += c.toString(); }); resp.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } }); });
        req.on('error', () => resolve(null)); req.end();
      });
      if (feed && feed.payload && feed.payload.version && feed.payload.url) {
        const pmsg = payloadSigMessage(feed.payload);
        if (pmsg && omniVerifyIntegSig(pmsg, feed.payload.sig || '')) remote = feed.payload;
        else diag('payload feed sig invalid -> ignored');
      }
    } catch (_) {}
    // Archive extraction, delta copy/prune and checksum work run in a Worker. Network transfer
    // remains in Electron's pinned main-session request path, so UI/control traffic stays responsive.
    const r = await runPayloadWorker(remote);
    diag('payload result: ' + JSON.stringify(r));
    try { if (win && !win.isDestroyed()) win.setTitle('OmniShade'); } catch (_) {}
    if (r && r.changed) { payloadRetryAttempts = 0; diag('payload updated -> restart required(skills/kb/tools)'); }
    const reason = String((r && r.reason) || '');
    if (!r || /download-failed|sha-mismatch|extract-failed|invalid-remote-integrity/.test(reason)) {
      payloadSyncStarted = false;
      schedulePayloadRetry(reason || 'empty payload result');
    }
  } catch (e) {
    const msg = String(e && e.message || e).slice(0, 160);
    diag('payload err: ' + msg);
    payloadSyncStarted = false;
    try { if (win && !win.isDestroyed()) win.setTitle('OmniShade'); } catch (_) {}
    schedulePayloadRetry(msg);
  }
}

let accountTransfersToken = '';
async function scheduleAccountTransfers(reason) {
  const acct=readAccountSession();
  if (!acct || !acct.token || accountTransfersToken === acct.token) return;
  if (!(await validAccountSession(acct))) { diag('account transfers skipped: unverified session (' + reason + ')'); return; }
  accountTransfersToken=acct.token;
  diag('verified account auth -> queued data transfers (' + reason + ')');
  setTimeout(() => { try { startModelConfigSyncAfterAuth(); } catch (_) {} }, 350);
  setTimeout(() => { enqueueDataPlane('update', () => autoUpdateBoot()).then(() => enqueueDataPlane('payload', () => startPayloadSyncAfterAuth())); }, 2200 + Math.floor(Math.random()*4000));
}

function hasAccountSession() { return !!readAccountSession(); }

app.on('before-quit', () => { app.isQuitting = true; });

// [CRASH-SELFHEAL 2026-11-08] GPU 稳定开关：Windows 上 CalculateNativeWinOcclusion 与
// 部分驱动组合是 Electron renderer crash 的已知来源（本机 5 次 crashed 的主嫌）。
// 关掉窗口遮挡计算 + 保留合成器缓存的软降级路径，不动硬件加速本体。
try {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  // [PERF-RENDER 2026-11-08] 滚动跟手：杀 Windows 滚轮插值动画（不影响 CSS/JS behavior:'smooth'）
  app.commandLine.appendSwitch('disable-smooth-scrolling');
  // [PERF-RENDER 2026-11-08] 非标准 sRGB 显示配置下省掉每帧颜色转换，兼稳截图取证
  app.commandLine.appendSwitch('force-color-profile', 'srgb');
  // [STAB-2026-11-08] 软降级: 观察期后仍崩则 config.gpu_softmode=true 一键降 GPU, 不发版。
  // 必须在 whenReady 之前调用才生效（本段即在 whenReady 前）。
  try {
    const _cfg = JSON.parse(require('fs').readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8'));
    if (_cfg && _cfg.gpu_softmode) {
      app.disableHardwareAcceleration();
      diag('gpu softmode ON (hardware acceleration disabled)');
    }
  } catch (e) { /* config 不存在/解析失败 = 默认关, 不打日志噪声 */ }
} catch (_) {}

app.whenReady().then(async () => {
  diag('whenReady fired');
  loadConfig();
  diag('config loaded');

  // ── 下载守卫(1.1.27): UI 内嵌 iframe(音频解锁 silence.mp3)等导航不得弹「另存为」──
  try {
    const _ses = require('electron').session;
    _ses.defaultSession.on('will-download', (e, item) => {
      try {
        const u = String((item && item.getURL && item.getURL()) || '');
        if (/\/assets\/(silence|audio)\.mp3/i.test(u)) { e.preventDefault(); diag('download-guard cancel asset ' + u.slice(-40)); return; }   // 本地界面资产: 直接取消
        try { item.setSavePath(require('path').join(require('electron').app.getPath('downloads'), item.getFilename() || 'omnishade-download')); } catch (_) {}
        diag('download-guard silent-save ' + u.slice(0, 80));
      } catch (_) {}
    });
  } catch (_) {}

  // ── Protection: async worker integrity → anti-debug → certificate pinning → periodic checks ──
  // [G16] 测试环境开关: 源码树跑回归时 integrity.json 会被并发出包/编辑反复改签,
  // 启动即拒 → omniRefuseStart 弹 dialog.showErrorBox(模态) → 无头 harness 挂死 TIMEOUT。
  // 只跳过「启动完整性自校验 + 周期保护循环」两项, 不动任何产品逻辑; 且仅在未打包态生效
  // (app.isPackaged===true 时环境变量被忽略), 生产包无法用 env 绕过完整性校验。
  const OMNI_TEST_SKIP_INTEGRITY = !app.isPackaged && process.env.OMNI_SKIP_STARTUP_INTEGRITY === '1';
  const integ = OMNI_TEST_SKIP_INTEGRITY
    ? { ok: true, files: 0, reason: 'skipped(OMNI_SKIP_STARTUP_INTEGRITY, unpackaged)' }
    : await omniIntegrityCheckAsync();
  diag('integrity=' + (integ && integ.ok ? 'ok files=' + integ.files : 'FAIL ' + (integ && integ.reason)));
  if (!integ || !integ.ok) { omniRefuseStart(app, diag, 'startup integrity: ' + (integ && integ.reason)); return; }
  const adb = omniAntiDebugStartupCheck(app);
  if (adb) { omniRefuseStart(app, diag, 'debugger/remote-debug detected: ' + adb); return; }
  omniInstallCertPinning(OMNI_HK(), diag);
  if (OMNI_TEST_SKIP_INTEGRITY) diag('protection loop skipped (OMNI_SKIP_STARTUP_INTEGRITY)');
  else omniStartProtectionLoop(app, { diag: diag });
  diag('protection armed; account authorization enforced by ui_shim');



  // 应用菜单栏: 标准 文件/设置/帮助 — 模型配置在网页设置界面里（EXE 独立配置窗已废弃）
  const settingsSubmenu = [
    { label: '供应商与模型', accelerator: 'CmdOrCtrl+M', click: () => openModelConfig() },
    { label: '账号登录 / 注册', click: () => openAccount() },
    { type: 'separator' },
    { label: '打开诊断日志', click: () => require('electron').shell.openPath(DIAG_DIR) },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [{ label: '退出', click: requestQuit }] },
    { label: '设置', submenu: settingsSubmenu },
    { label: '帮助', submenu: [
      { label: '官方网站', click: () => { shell.openExternal(OFFICIAL_SITE_URL).catch(() => {}); } },
      { type: 'separator' },
      { label: '打开诊断日志', click: () => require('electron').shell.openPath(DIAG_DIR) },
    ] }, 
  ]));

  // Start the local bridge before loading UI so its private ready IPC/token is available for
  // the first drag/drop or tool-enabled turn, rather than racing the renderer.
  // [本机授权] app.ready 起桥前先走本地 license; 命中则其内部已 ensureBridge(), 否则保持原行为
  const localGrantReady = localRuntimeGrantFromLicense();
  if (config.autoStartBridge) {
    if (!localGrantReady) ensureBridge();
    // [G95-FIX] 原为 await waitForBridgeReady(3000)——条件在该路径永不成立=纯睡 3s（首屏 3.15s 的主因）。
    // 改为状态直读：不阻塞首屏，桥由后台 keepalive 拉起，首回合前已就绪。
    const bridgeReady = !!bridgeUploadToken;
    diag('bridge initial ready=' + bridgeReady);
  }
  diag('before createWindow');
  createWindow();
  diag('createWindow done');
  // [MEM-MONITOR 2026-11-08] p-memory 交付的驻留监测：渲染层 JS 堆 + DOM 规模 + 主进程 RSS，
  // 10 分钟一采落 client.log（生产门禁：config.mem_monitor=true 才启用，零常驻开销）。
  try {
    const _mcfg = JSON.parse(require('fs').readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8'));
    if (_mcfg && _mcfg.mem_monitor) {
      setInterval(() => {
        try {
          win.webContents.executeJavaScript('Promise.resolve({heap:(performance.memory?performance.memory.usedJSHeapSize:0),nodes:document.getElementsByTagName("*").length})').then((m) => {
            diag('mem-monitor heap=' + Math.round((m && m.heap || 0) / 1048576) + 'MB nodes=' + (m && m.nodes || 0) + ' rss=' + Math.round(process.memoryUsage().rss / 1048576) + 'MB');
          }).catch(() => {});
        } catch (_) {}
      }, 10 * 60 * 1000);
      diag('mem-monitor ON (10min interval)');
    }
  } catch (_) {}
  // [发布通道] gdlr latest.json 异步检查: 5s 后首查(避开首屏与桥启动), 之后 6h 复查;
  // 不 await、不阻塞 whenReady; 失败只落 diag 和 UI 状态, 不影响启动。
  setTimeout(function () { checkLatestUpdate(false); }, 5000);
  setInterval(function () { checkLatestUpdate(false); }, 6 * 60 * 60 * 1000);

  // [AUTH-KEEPALIVE] 账号会话是滑动窗口，不主动心跳就会静默过期：
  // 过期后 /runtime_grant 403，面板永远「未激活」，用户表现为「一直校验不上」。
  // 这里每 5 分钟续一次；续上了但没有可用 runtime grant 就立即补一张。
  let authSessionState = 'unknown';   // ok | expired | none
  async function authKeepAlive() {
    const acct = readAccountSession();
    if (!acct || !acct.token) { authSessionState = 'none'; return; }
    let r = null;
    try { r = await controlPost('/session_heartbeat', { token: acct.token }, 8000); } catch (_) { r = null; }
    const ok = !!(r && r.status === 200 && r.data && r.data.ok && r.data.status === 'ok');
    if (!ok) {
      if (authSessionState !== 'expired') {
        authSessionState = 'expired';
        diag('auth keepalive: session expired -> 需要重新登录');
      }
      return;
    }
    if (authSessionState !== 'ok') { authSessionState = 'ok'; diag('auth keepalive: session ok'); }
    try {
      const g = require('./runtime_key_store').load();
      if (!g || !g.keyB64) await refreshRuntimeGrant(acct);
    } catch (_) {}
  }
  setTimeout(function () { authKeepAlive(); }, 8000);
  setInterval(function () { authKeepAlive(); }, 5 * 60 * 1000);
  // [冷启动 seed 修复] 去掉登录门控: app ready 后无条件把内嵌 skills/kb/tools 铺到 %APPDATA%/omnishade,
  // 供 bridge 9431 直接读取(含 .skill_read / kb_search)。登录后的远程下载同步仍走老链路, 不受影响。
  coldSeedOnce();
  // [1.1.82] 未登录不下载资源包：认证优先，登录成功后再低优先级同步。
  diag('before createTray');
  createTray();
  diag('createTray done');
  diag('after bridge');
  if (config.autoStartTunnel !== false) startTunnelKeepalive();
  diag('after tunnel');
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  // Ctrl+M is scoped to this app's Settings menu, not a global keyboard grab.
  // [1.1.84] 首次更新由账号认证后的串行队列执行；周期预取也进同一队列。
  (function auLoop(){
    const delay = 45*60*1000 + Math.floor((Math.random()*20-10)*60*1000);
    setTimeout(function(){ if (hasAccountSession()) validAccountSession().then((ok) => { if (ok) enqueueDataPlane('prefetch', () => checkUpdate(true, {prefetchOnly:true})); }).catch(() => {}); auLoop(); }, delay);
  })();
});

app.isQuitting = false;
app.on('window-all-closed', (e) => { /* 托盘常驻, 不退出 */ });
}
