// OmniShade 本机桥独立启动器 (测试期用: 产品正式形态由 app 主进程 require bridge.js 启动)
// 用途: 让测试端的 omni-local 链路 (relay → ssh 隧道 38431 → 本机 9431) 在 app 未运行时仍有服务
const { startBridge } = require('./bridge.js');
const port = parseInt(process.env.OMNI_BRIDGE_PORT || '9431', 10);
startBridge(port);
console.log('[bridge_standalone] started on 127.0.0.1:' + port);
