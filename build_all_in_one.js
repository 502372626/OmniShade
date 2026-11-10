'use strict';
// build_all_in_one.js — OmniShade 出包链一键可复现 (G6)
//
// 串联实测链路(来源: 00-会话督办/04-package/03-build-result.md + desktop/build_all_193.sh):
//   ① build_protect.js 混淆+注入公钥+拼接 main.js
//   ② compile_all.js  用 Electron 的 v8 编 main.js/bridge.js -> .jsc
//   ③ enc_assets.js   AES-256-GCM 加密 bridge.jsc -> bridge.jsc.enc
//   ④ build_sign.js manifest  签完整性清单
//   ⑤ electron-builder --dir --config build-local.yml  出免安装版
//   ⑥ product_data -> resources/product_data (外置, 防 asar 膨胀 + MAX_PATH)
//      默认 robocopy; OMNI_PD_COPY=node|python 切到自研长路径复制器。复制后强制跑
//      pd_longpath_copy.js --mode=verify 对账(OMNI_PD_VERIFY=0 可关) —— 普通 os.walk
//      看不见 >260 的路径, 曾量出"863 项未进包"的假象, 闸门必须存在。
//   ⑦ build_sign.js exe + 拷贝 exe_integrity.* 进 resources
//   ⑧ build_sign.js preflight  清单 ⊆ asar 且逐文件 hash 复算
//   ⑨ 报告: exe sha256 / 各产物 hash
//
// 纪律:
//   - 任一子步非零 → fail-fast, 打印死因(命令行/退出码/signal/stderr 尾段), 不继续后续步骤;
//   - 禁止静默跳过: 只有显式 --skip-<name> 才跳过, 且打印 [SKIP] 并在末尾 SUMMARY 汇总;
//   - 无弹窗: 所有子进程 spawn 带 windowsHide:true
//     (windowsHide == libuv UV_PROCESS_WINDOWS_HIDE == dwCreationFlags |= CREATE_NO_WINDOW(0x08000000));
//   - 动文件前先快照: 链首把会被改写的文件 copy 到 _build_snapshots/<ts>/;
//   - 默认 --dry-run 只打印将执行的命令, 不落任何产物(STEP 0 前置校验是只读的, 仍会真跑)。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

// ---------------------------------------------------------------- 常量/路径
const CREATE_NO_WINDOW = 0x08000000;   // 无弹窗纪律: 见上
const DESK = process.env.OMNI_BUILD_DESK ? path.resolve(process.env.OMNI_BUILD_DESK) : __dirname;
const LICENSE_DIR = process.env.OMNI_LICENSE_DIR
  ? path.resolve(process.env.OMNI_LICENSE_DIR)
  : path.resolve(DESK, '..', 'license');
const NODE = process.env.OMNI_NODE
  || 'C:/Users/Administrator/AppData/Local/hermes/tools/node-26.12.1-win32-x64/node.exe';
const ELECTRON_EXE = path.join(DESK, 'node_modules', 'electron', 'dist', 'electron.exe');
const BUILDER_CLI = path.join(DESK, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const ROBOCOPY = 'C:/Windows/System32/robocopy.exe';
// build-local.yml: output=dist-local, target=dir(免安装版), 不签 Authenticode
const BUILDER_CONFIG = path.join(DESK, 'build-local.yml');
const OUT_DIR = path.join(DESK, 'dist-local');
const UNPACKED = path.join(OUT_DIR, 'win-unpacked');
const EXE = path.join(UNPACKED, 'OmniShade.exe');
const ASAR = path.join(UNPACKED, 'resources', 'app.asar');
const RESOURCES = path.join(UNPACKED, 'resources');
const ASSET_KEY_FILE = path.join(LICENSE_DIR, '.asset_key');
const PRIV_KEY = path.join(LICENSE_DIR, 'integrity_ed25519.priv');
const PUB_KEY = path.join(LICENSE_DIR, 'integrity_ed25519.pub');
// [G1-b] product_data 真源: 上级 OmniShade/product_data(63953)。DESK/product_data 是历史副本,
// 比真源少 136 个文件(被 Defender 当攻击样本删过), 绝不能再拿它当出包源。
const PD_SRC = process.env.OMNI_PD_SRC
  ? path.resolve(process.env.OMNI_PD_SRC)
  : path.resolve(DESK, '..', 'product_data');
// [G22] STEP 6 复制器可选: robocopy(默认, 实测能扛 MAX_PATH) / node / python
//   robocopy 实测 949/949 长路径文件全过(它内部自带 \\?\); 给它显式加 \\?\ 反而 rc=16 全炸, 别加。
//   node 26 实测原生扛 >260(node.exe manifest 声明 longPathAware), 加 --unc 也能过。
//   python 必须 \\?\ 前缀(无前缀实测 0/949, WinError 206), 脚本里已写死。
//   换引擎不改默认行为: 忘设 env 时还是老 robocopy 路径。
const PD_COPY_JS = path.join(DESK, 'pd_longpath_copy.js');
const PD_COPY_PY = path.join(DESK, 'pd_longpath_copy.py');
const PYTHON = process.env.OMNI_PYTHON || 'python';
const PD_COPY = (process.env.OMNI_PD_COPY || 'robocopy').toLowerCase();
const PD_UNC = process.env.OMNI_PD_UNC === '1';                 // 仅 node 引擎生效
const PD_VERIFY = process.env.OMNI_PD_VERIFY !== '0';           // 默认开: STEP6 后置对账闸门
// OMNI_PD_DST: 只给"真跑 STEP6 但不碰交付包"的演练用(如把目标指到临时目录验证新复制器),
// 正式出包别设 —— 设了会把 product_data 拷到包外, 线上交付就缺数据。
const PD_DST = process.env.OMNI_PD_DST
  ? path.resolve(process.env.OMNI_PD_DST)
  : path.join(RESOURCES, 'product_data');
if (!['robocopy', 'node', 'python'].includes(PD_COPY)) {
  console.error('[FATAL] OMNI_PD_COPY 只能是 robocopy|node|python, 当前=' + PD_COPY);
  process.exit(2);
}

// 预估耗时(分钟, 未实测基线: 本次任务禁止全量重跑, 只跑 dry-run; 真实跑时脚本会自采并打印)
const EST_MIN = { 0: 0.1, 1: 1.5, 2: 0.5, 3: 0.2, 4: 1.5, 5: 4.0, 6: 1.0, 7: 1.0, 8: 1.5, 9: 0.1 };

// ---------------------------------------------------------------- 参数
function parseArgs(argv) {
  const o = {
    dry: true,          // 默认 dry-run: 任务要求不真跑
    from: 0, to: 9,
    skip: new Set(),
    dropPlainJsc: false, // true = 加密后删除明文 bridge.jsc(正式 release 口径); 默认保留(本地 build-local.yml 口径)
    keepLogs: true,
  };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') o.dry = true;
    else if (a === '--run') o.dry = false;
    else if (a === '--drop-plain-jsc') o.dropPlainJsc = true;
    else if (a.startsWith('--from=')) o.from = Number(a.split('=')[1]);
    else if (a.startsWith('--to=')) o.to = Number(a.split('=')[1]);
    else if (a.startsWith('--skip=')) for (const s of a.split('=')[1].split(',')) o.skip.add(s.trim());
    else if (a === '-h' || a === '--help') { o.help = true; }
    else { console.error('未知参数: ' + a); process.exit(2); }
  }
  return o;
}
const OPT = parseArgs(process.argv);

if (OPT.help) {
  console.log(`用法: node build_all_in_one.js [选项]
  --dry-run              只打印将执行的命令(默认), 不落产物; STEP 0 前置校验照常真跑
  --run                  真跑全链
  --skip=<a,b,c>         跳过指定步骤(名或序号), 会打印 [SKIP] 并在 SUMMARY 记录
  --from=N --to=M        只跑 N..M 区间(用于断点续跑; 与依赖顺序无关, 使用者自担)
  --drop-plain-jsc       加密后删除明文 bridge.jsc(正式 release 口径)
                         默认保留明文 —— build-local.yml 与 build_sign.js 清单都列了 bridge.jsc

STEP 6 环境变量(product_data 复制器, 见 00-会话督办/04-package/G22-product_data长路径修复.md):
  OMNI_PD_COPY=robocopy|node|python   默认 robocopy(实测 949/949 长路径全过, 别给它加 \\\\?\\, 加了 rc=16 全炸)
  OMNI_PD_UNC=1                       node 引擎显式加 \\\\?\\ 前缀(兜底用; node 26 原生已能扛 >260)
  OMNI_PD_VERIFY=0                    关掉 STEP6 后置对账闸门(默认开, ~4s, 是防 MAX_PATH 静默丢文件的唯一闸门)
  OMNI_PYTHON=<exe>                   python 引擎用什么解释器(默认 PATH 里的 python)
  --help                 本帮助`);
  process.exit(0);
}

// ---------------------------------------------------------------- 输出/日志
// 时间戳用本机时区(+0800), 不用 UTC —— 日志名/快照目录名要能和仓库里其他文件的时间对上
const TS = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
})();
const LOG = path.join(DESK, `build_all_in_one_${TS}.log`);
let logFd = null;
if (OPT.keepLogs && !OPT.dry) {
  try { logFd = fs.openSync(LOG, 'w'); } catch (e) { console.error('[WARN] 无法写日志 ' + LOG + ': ' + e.message); }
}
function say(line) {
  console.log(line);
  if (logFd !== null) try { fs.writeSync(logFd, line + '\n'); } catch (_) {}
}
function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}
function humanSize(n) {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  return (n / 1024).toFixed(1) + ' KB';
}

// ---------------------------------------------------------------- 快照
const SNAP_DIR = path.join(DESK, '_build_snapshots', TS);
const MUTABLE = ['main.js', 'main.jsc', 'bridge.jsc', 'bridge.jsc.enc', 'integrity.json', 'integrity.sig', 'exe_integrity.json', 'exe_integrity.sig'];
function snapshot(kind) {
  if (OPT.dry) return;
  if (kind === 'chain') {
    try {
      fs.mkdirSync(SNAP_DIR, { recursive: true });
      for (const f of MUTABLE) {
        const src = path.join(DESK, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(SNAP_DIR, f));
      }
      say(`[SNAPSHOT] 链首快照 -> ${SNAP_DIR} (${MUTABLE.filter((f) => fs.existsSync(path.join(DESK, f))).length} 个文件)`);
    } catch (e) {
      fail(0, 'snapshot', '链首快照失败: ' + e.message);
    }
  } else if (kind === 'bridgesc') {
    // STEP 3 明文 bridge.jsc 的临时备份: enc_assets.js 会在加密后 rmSync 掉明文源,
    // 本地口径要保留明文(build-local.yml + 完整性清单都列了 bridge.jsc), 故备份后还原。
    const dst = path.join(DESK, 'bridge.jsc.plain.tmp-' + process.pid);
    try {
      fs.copyFileSync(path.join(DESK, 'bridge.jsc'), dst);
      return dst;
    } catch (e) {
      fail(0, 'snapshot', 'bridge.jsc 明文备份失败: ' + e.message);
    }
  }
  return null;
}
function restorePlain(backup) {
  if (!backup) return;
  try {
    fs.copyFileSync(backup, path.join(DESK, 'bridge.jsc'));   // 原子性够用: 同名覆盖, 单文件或丢
    fs.rmSync(backup, { force: true });
  } catch (e) {
    fail(0, 'restore', 'bridge.jsc 明文还原失败: ' + e.message);
  }
}

// ---------------------------------------------------------------- 失败处理
let HARD_FAIL = null;
function fail(n, name, cause) {
  HARD_FAIL = { n, name, cause };
  say(`\n[FAIL] STEP ${n} ${name} — 死因: ${cause}`);
  say(`       链已 fail-fast 中止, 后续步骤未执行。修复后从 STEP ${n} 续跑:`);
  say(`       node build_all_in_one.js --run --from=${n}`);
  say('[RESULT] FAIL');
  process.exit(n === 0 ? 90 : 80 + (n % 20));
}

// ---------------------------------------------------------------- 步骤定义
// MUST_SIGN 名单单一来源: 直接从 build_sign.js 源码抽, 避免这里再抄一份导致漂移
function readMustSign() {
  const src = fs.readFileSync(path.join(DESK, 'build_sign.js'), 'utf8');
  const m = /const MUST_SIGN = \[([\s\S]*?)\];/.exec(src);
  if (!m) throw new Error('build_sign.js 里没找到 MUST_SIGN 数组 — 签名器的强制名单可能被改名/删除');
  const list = [...m[1].matchAll(/'([^']+)'/g)].map((r) => r[1]);
  if (!list.length) throw new Error('MUST_SIGN 解析出 0 项 — build_sign.js 结构变了');
  return list;
}

const STEPS = [
  {
    n: 0,
    name: '前置校验(只读: 工具链/密钥/资产密钥/MUST_SIGN 名单/protect 标记)',
    internal: true,
    alwaysRun: true,                      // dry-run 也真跑, 否则 dry-run 是空转
    fn: () => {
      const need = [[NODE, 'node.exe'], [ELECTRON_EXE, 'electron.exe'], [BUILDER_CLI, 'electron-builder cli.js'],
        [BUILDER_CONFIG, 'build-local.yml'], [PRIV_KEY, 'integrity_ed25519.priv'], [PUB_KEY, 'integrity_ed25519.pub'],
        [ASSET_KEY_FILE, '.asset_key'], [path.join(DESK, 'compile_all.js'), 'compile_all.js'],
        [path.join(DESK, 'build_protect.js'), 'build_protect.js'], [path.join(DESK, 'enc_assets.js'), 'enc_assets.js'],
        [path.join(DESK, 'build_sign.js'), 'build_sign.js'], [path.join(DESK, 'protect_seg.js'), 'protect_seg.js'],
        [path.join(DESK, 'main.js'), 'main.js'], [path.join(DESK, 'bridge.js'), 'bridge.js'],
        [path.join(DESK, 'bytenode-lib'), 'bytenode-lib/'], [path.join(DESK, 'product_data'), 'product_data/']];
      for (const [p, label] of need) {
        if (!fs.existsSync(p)) throw new Error('缺 ' + label + ' → ' + p);
      }
      // 资产密钥: 必须是 32 字节规范 base64, 与 release_encrypt_assets.js 同口径校验
      const keyText = fs.readFileSync(ASSET_KEY_FILE, 'utf8').trim();
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(keyText) || keyText.length % 4 !== 0) {
        throw new Error('.asset_key 不是合法 base64');
      }
      const key = Buffer.from(keyText, 'base64');
      if (key.length !== 32 || key.toString('base64') !== keyText) throw new Error('.asset_key 必须恰好 32 字节');
      // 签名密钥对一致(与 build_sign.js loadKeys 同口径)
      const priv = crypto.createPrivateKey(fs.readFileSync(PRIV_KEY, 'utf8'));
      const pubB64 = fs.readFileSync(PUB_KEY, 'utf8').trim();
      const a = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' });
      const b = crypto.createPublicKey({ key: Buffer.from(pubB64, 'base64'), format: 'der', type: 'spki' })
        .export({ type: 'spki', format: 'der' });
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Ed25519 公私钥不配对');
      // MUST_SIGN 强制名单全在场
      const missing = readMustSign().filter((f) => !fs.existsSync(path.join(DESK, f)));
      if (missing.length) throw new Error('MUST_SIGN 缺文件: ' + missing.join(', '));
      // protect 段标记: build_protect 靠它定位插入点, 缺了会在 STEP 1 才炸, 提前暴露
      const mainSrc = fs.readFileSync(path.join(DESK, 'main.js'), 'utf8');
      if (!mainSrc.includes('// __OMNI_PROTECT_BEGIN__') || !mainSrc.includes('// __OMNI_PROTECT_END__')) {
        throw new Error('main.js 缺 __OMNI_PROTECT_BEGIN__/__END__ 标记');
      }
      // 版本一致性(RC-10): build_protect 里也会查, 这里提前查一次
      const pkg = JSON.parse(fs.readFileSync(path.join(DESK, 'package.json'), 'utf8'));
      const vm = /const\s+APP_VERSION\s*=\s*'([^']+)'/.exec(mainSrc);
      if (vm && vm[1] !== pkg.version) {
        throw new Error(`RC-10: APP_VERSION(${vm[1]}) != package.json.version(${pkg.version})`);
      }
      return { ok: true, detail: `node/electron/builder/密钥/MUST_SIGN(${'全部在场'})/protect标记 全通过; APP_VERSION=${pkg.version}` };
    },
  },
  {
    n: 1,
    name: 'build_protect: 混淆保护段 + 注入 Ed25519 公钥 + 拼进 main.js',
    cmd: NODE,
    args: [path.join(DESK, 'build_protect.js')],
    cwd: DESK,
  },
  {
    n: 2,
    name: 'compile_all: 用 Electron 的 v8 编 main.js/bridge.js → .jsc',
    cmd: ELECTRON_EXE,
    args: [path.join(DESK, 'compile_all.js')],
    cwd: DESK,
    // 关键: 不设 ELECTRON_RUN_AS_NODE 就是开 GUI 窗口; 设了才是拿 electron 当 node 用
    env: { ELECTRON_RUN_AS_NODE: '1' },
  },
  {
    n: 3,
    name: 'enc_assets: AES-256-GCM 加密 bridge.jsc → bridge.jsc.enc',
    cmd: NODE,
    args: [path.join(DESK, 'enc_assets.js')],
    cwd: DESK,
    envOf: () => ({ OMNI_ASSET_KEY_B64: fs.readFileSync(ASSET_KEY_FILE, 'utf8').trim() }),
    pre: () => {
      if (!fs.existsSync(path.join(DESK, 'bridge.jsc'))) {
        throw new Error('bridge.jsc 不存在 — STEP 2 没产出或被别的上游删了, 不能空跑加密');
      }
      // enc_assets.js 内部 rmSync 掉明文源(正式 release 口径)
      return OPT.dropPlainJsc ? null : snapshot('bridgesc');
    },
    post: (backup) => {
      if (!OPT.dropPlainJsc) {
        restorePlain(backup);
        say('    | 明文 bridge.jsc 已还原(本地口径: build-local.yml 与完整性清单都列了它)');
      } else {
        say('    | --drop-plain-jsc: 明文 bridge.jsc 已按 release 口径删除');
      }
    },
  },
  {
    n: 4,
    name: 'build_sign manifest: 签完整性清单(必须在 .enc 产出之后)',
    cmd: NODE,
    args: [path.join(DESK, 'build_sign.js'), 'manifest'],
    cwd: DESK,
  },
  {
    n: 5,
    name: 'electron-builder --dir: 出免安装版(dist-local/win-unpacked)',
    cmd: NODE,
    args: [BUILDER_CLI, '--dir', '--config', BUILDER_CONFIG],
    cwd: DESK,
  },
  {
    n: 6,
    // [G22] 复制器可切换: OMNI_PD_COPY=robocopy(默认)|node|python, OMNI_PD_UNC=1 给 node 加 \\?\ 前缀
    name: `${PD_COPY}: product_data 外置到 resources/product_data(防 asar 膨胀 + MAX_PATH 260)`,
    cmd: PD_COPY === 'robocopy' ? ROBOCOPY : (PD_COPY === 'python' ? PYTHON : NODE),
    // [G1-b 修根因] 源必须是上级 OmniShade/product_data(真源, 63953 文件), 不能是
    // DESK/product_data —— 那份是历史副本, 且被 Defender 削过, 实测比真源少 136 文件,
    // 拿它当源会把"缺 136"永久固化进包。OMNI_PD_SRC 可覆盖。
    args: PD_COPY === 'robocopy'
      ? [PD_SRC, PD_DST,
        // [G38] /MT:32 —— 原先无 /MT 是单线程, 搬 5.6 万个 skills 小文件实测 746 文件/分钟(要 66 分钟);
        // 多线程后按磁盘与 Defender 实际吞吐走, 同机实测提升一个数量级。robocopy /MT 上限 128。
        '/E', '/MT:32', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP']
      : PD_COPY === 'python'
        ? [PD_COPY_PY, PD_SRC, PD_DST]
        : [PD_COPY_JS, PD_SRC, PD_DST].concat(PD_UNC ? ['--unc'] : []),
    cwd: DESK,
    // robocopy 退出码是位图: <8 = 成功(0..7 表示复制了文件), >=8 = 真错; 自研脚本是 0/1
    rcOk: (rc) => (PD_COPY === 'robocopy' ? rc < 8 : rc === 0),
    pre: () => {
      if (!fs.existsSync(EXE)) throw new Error('win-unpacked/OmniShade.exe 不存在 — STEP 5 没出包');
      // 源必须同时含 skills/ 与 kb/, 否则说明指到了空壳/错目录
      for (const d of ['skills', 'kb']) {
        if (!fs.existsSync(path.join(PD_SRC, d))) throw new Error('STEP6 源缺 ' + d + '/ : ' + PD_SRC);
      }
      // 真源比 desktop/product_data 多 136 个文件; 误指到副本时直接 fail-fast
      const stale = path.join(DESK, 'product_data');
      if (PD_SRC === stale) say('    | [警告] 源=DESK/product_data(历史副本) — 确认要这样吗?');
      if (PD_COPY !== 'robocopy') {
        const tool = PD_COPY === 'python' ? PD_COPY_PY : PD_COPY_JS;
        if (!fs.existsSync(tool)) throw new Error('OMNI_PD_COPY=' + PD_COPY + ' 但脚本缺失: ' + tool);
      }
    },
    post: () => {
      // [G22 对账闸门] 必须用能看见 >260 路径的枚举器对账(node 原生 longPathAware)。
      // 历史那 863 项"未进包"就是拿普通 os.walk 量的假象 —— 它自己撞 MAX_PATH 看不见。
      if (!PD_VERIFY) { say('    | [G22] 对账已按 OMNI_PD_VERIFY=0 跳过'); return; }
      const dstPd = PD_DST;
      const t = Date.now();
      const v = spawnSync(NODE, [PD_COPY_JS, PD_SRC, dstPd, '--mode=verify'],
        { cwd: DESK, windowsHide: true, encoding: 'utf8' });
      const line = String(v.stdout || '').trim().split(/\r?\n/)[0] || '(无输出)';
      say('    | [G22 对账] ' + line + ` (${((Date.now() - t) / 1000).toFixed(1)}s)`);
      if (v.status !== 0) {
        throw new Error('product_data 对账不过: ' + line
          + ' — 这就是 MAX_PATH 级丢文件的真信号, 别拿普通资源管理器复核它');
      }
    },
  },
  {
    n: 7,
    name: 'build_sign exe + 拷贝 exe_integrity.* 进 resources',
    cmd: NODE,
    args: [path.join(DESK, 'build_sign.js'), 'exe', EXE],
    cwd: DESK,
    pre: () => { if (!fs.existsSync(EXE)) throw new Error('OmniShade.exe 不存在 — 无法签 exe 清单'); },
    post: () => {
      // build-local.yml 的 extraResources 在 STEP 5 打包时已拷过一次(那时是旧内容),
      // 新签名必须再覆盖一次, 否则运行时 omniExeIntegrityCheck 拿旧 hash 比对新 exe → 拒绝启动
      for (const f of ['exe_integrity.json', 'exe_integrity.sig']) {
        const src = path.join(DESK, f);
        if (!fs.existsSync(src)) throw new Error('签名器没产出 ' + f);
        fs.mkdirSync(RESOURCES, { recursive: true });
        fs.copyFileSync(src, path.join(RESOURCES, f));
        say('    | copy ' + f + ' -> resources/');
      }
    },
  },
  {
    n: 8,
    name: 'build_sign preflight: 清单 ⊆ asar 且逐文件 hash 复算',
    cmd: NODE,
    args: [path.join(DESK, 'build_sign.js'), 'preflight', ASAR],
    cwd: DESK,
    pre: () => { if (!fs.existsSync(ASAR)) throw new Error('app.asar 不存在 — STEP 5 没出包'); },
  },
  {
    n: 9,
    name: '报告: exe/产物 sha256',
    internal: true,
    fn: () => {
      const rows = [];
      for (const [label, p] of [['OmniShade.exe', EXE], ['resources/app.asar', ASAR],
        ['main.jsc', path.join(DESK, 'main.jsc')], ['bridge.jsc.enc', path.join(DESK, 'bridge.jsc.enc')],
        ['bridge.jsc', path.join(DESK, 'bridge.jsc')], ['integrity.json', path.join(DESK, 'integrity.json')],
        ['exe_integrity.json', path.join(DESK, 'exe_integrity.json')]]) {
        if (!fs.existsSync(p)) { rows.push(`${label} = <缺失>`); continue; }
        rows.push(`${label}  ${humanSize(fs.statSync(p).size).padStart(9)}  sha256=${sha256File(p)}`);
      }
      let nFiles = '?';
      try { nFiles = String(Object.keys(JSON.parse(fs.readFileSync(path.join(DESK, 'integrity.json'), 'utf8')).files).length); } catch (_) {}
      rows.push(`integrity.json 条目数 = ${nFiles}`);
      return { ok: true, detail: rows.join('\n    ') };
    },
  },
];

// ---------------------------------------------------------------- 主流程
(async function main() {
  say('='.repeat(72));
  say(`OmniShade 出包链 G6  mode=${OPT.dry ? 'DRY-RUN(不落产物)' : 'REAL-RUN'}  desk=${DESK}`);
  say(`node=${NODE}`);
  say(`electron=${ELECTRON_EXE}`);
  say(`builder=${BUILDER_CLI}`);
  say(`子进程标志: windowsHide=true (= CreateProcess dwCreationFlags | CREATE_NO_WINDOW 0x${CREATE_NO_WINDOW.toString(16)})`);
  if (!OPT.dry) say(`日志: ${LOG}`);
  say('='.repeat(72));

  const results = [];
  let tChain = Date.now();
  snapshot('chain');

  for (const step of STEPS) {
    const n = step.n;
    const id = `${n}`;
    const skipByFlag = OPT.skip.has(id) || OPT.skip.has(step.name.split(':')[0]);
    if (n < OPT.from || n > OPT.to) { say(`[SKIP] STEP ${n} ${step.name} — 不在 --from=${OPT.from}..--to=${OPT.to} 区间`); results.push({ n, name: step.name, state: 'SKIP' }); continue; }
    if (skipByFlag) { say(`[SKIP] STEP ${n} ${step.name} — 显式 --skip`); results.push({ n, name: step.name, state: 'SKIP' }); continue; }

    say(`\n[STEP ${n}] ${step.name}`);

    // dry-run: 打印将执行的完整命令行(含环境变量), 不落产物
    if (OPT.dry && !step.internal) {
      const envStr = Object.entries(Object.assign({}, step.env || {}, step.envOf ? step.envOf() : {}))
        .map(([k, v]) => `${k}=${k === 'OMNI_ASSET_KEY_B64' ? '<32B base64 from ../license/.asset_key>' : v}`).join(' ');
      say(`    cwd : ${step.cwd || DESK}`);
      say(`    cmd : ${envStr ? envStr + ' ' : ''}${step.cmd} ${step.args.map((a) => (/[ ]/.test(a) ? `"${a}"` : a)).join(' ')}`);
      say(`    预估: ${EST_MIN[n]} min (未实测基线)`);
      say(`    [DRY] exit=0 (未执行)`);
      results.push({ n, name: step.name, state: 'DRY' });
      continue;
    }

    // internal 步骤(STEP 0 前置校验 / STEP 9 报告)
    if (step.internal) {
      if (OPT.dry && !step.alwaysRun) { say('    [DRY] 未执行'); results.push({ n, name: step.name, state: 'DRY' }); continue; }
      const t0 = Date.now();
      try {
        const r = step.fn();
        say('    ' + (r && r.detail ? r.detail : 'OK'));
        say(`[STEP ${n}] OK exit=0 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        results.push({ n, name: step.name, state: 'OK', ms: Date.now() - t0 });
      } catch (e) {
        say(`[STEP ${n}] FAILED — ${e.message}`);
        fail(n, step.name, e.message);
      }
      continue;
    }

    // 外部命令步骤
    const t0 = Date.now();
    let backup = null;
    try {
      if (step.pre) backup = step.pre() || null;
    } catch (e) {
      fail(n, step.name, '前置检查未通过: ' + e.message);
    }
    const env = Object.assign({}, step.env || {}, step.envOf ? step.envOf() : {});
    const child = spawn(step.cmd, step.args, {
      cwd: step.cwd || DESK,
      env: Object.assign({}, process.env, env),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let lines = 0;
    const onData = (buf) => {
      for (const ln of String(buf).split(/\r?\n/)) {
        if (!ln) continue;
        lines++;
        if (lines <= 400) say('    | ' + ln);
        else if (lines === 401) say('    | ... (输出截断)');
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let rc = null, signal = null;
    await new Promise((res) => {
      child.on('error', (e) => { rc = -1; say('    | spawn error: ' + (e && e.message)); res(); });
      child.on('close', (c, s) => { rc = c; signal = s; res(); });
    });
    const ms = Date.now() - t0;
    const ok = rc !== null && (step.rcOk ? step.rcOk(rc) : rc === 0);
    if (!ok) {
      const why = rc === -1
        ? `子进程起不来(路径/权限/被占用) — ${step.cmd}`
        : (signal ? `被信号杀掉: ${signal}` : `退出码 rc=${rc}`);
      say(`[STEP ${n}] FAILED rc=${rc}${signal ? ' signal=' + signal : ''} (${(ms / 1000).toFixed(1)}s) — ${why}`);
      say(`    死因命令: ${step.cmd} ${step.args.join(' ')}`);
      fail(n, step.name, why);
    }
    try { if (step.post) step.post(backup); } catch (e) { fail(n, step.name, '后置处理失败: ' + e.message); }
    say(`[STEP ${n}] OK exit=${rc} (${(ms / 1000).toFixed(1)}s)`);
    results.push({ n, name: step.name, state: 'OK', ms, rc });
  }

  const totalMs = Date.now() - tChain;
  say('\n==== SUMMARY ====');
  for (const r of results) {
    say(`STEP ${r.n}  ${r.state.padEnd(4)}  ${(r.ms ? (r.ms / 1000).toFixed(1) + 's' : '-').padStart(7)}  ${r.name}`);
  }
  say(`总耗时 ${(totalMs / 60000).toFixed(1)} min`);
  say(`[RESULT] ${HARD_FAIL ? 'FAIL' : (OPT.dry ? 'DRY-RUN OK (逻辑校验通过, 未落产物)' : 'OK')}`);
  if (logFd !== null) try { fs.closeSync(logFd); } catch (_) {}
  process.exit(0);
})();
