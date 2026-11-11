# OmniShade · 操作台

> 一个把「AI 对话」和「本机作业能力」焊在一起的桌面客户端。
> 装完即用，永久免费，不需要卡密、不需要订阅。

![版本](https://img.shields.io/badge/version-1.11.0-2563eb)
![平台](https://img.shields.io/badge/platform-Windows%2010%2F11-0078d4)
![授权](https://img.shields.io/badge/license-永久免费-16a34a)

---

> 💬 **交流 QQ 群 1124698128** ｜ ⬇️ [下载安装包](https://github.com/502372626/OmniShade/releases/latest) ｜ ❤️ [支持项目](#打赏) ｜ 🐛 [提问题](https://github.com/502372626/OmniShade/issues)

## 这是什么

OmniShade 不是又一个套壳聊天框。它在本地跑一条完整的**工具桥**，把 49 个本机能力直接接进对话：

| 类别 | 能力 |
|---|---|
| 命令执行 | `sys_exec` —— 任意 Windows 命令行，stdout/stderr 直接回传 |
| 系统 | 进程 / 服务 / 网络连接 / 系统信息 / 结束进程 |
| 文件 | 全盘读写、递归列目录、SHA-256、按名或按内容搜索 |
| 桌面 | 截屏、枚举窗口 |
| 浏览器 | CDP 驱动本机 Chrome（导航 / 点击 / 执行 JS / 截图） |
| 检索 | 本地知识库三路融合检索、技能目录、公网检索（Bing 直连，不要 API key） |
| 作业链 | 39 阶段攻击链、任务池、目标驱动的自主迭代 |
| 分派 | 并行子代理 |

## 安装

1. 下载安装包（任选其一，**同一个文件，SHA256 完全一致**）：

   | 线路 | 地址 | 说明 |
   |---|---|---|
   | **GitHub 官方** | [Releases · v1.11.1](https://github.com/502372626/OmniShade/releases/download/v1.11.1/OmniShade-Setup-1.11.1.exe) | 579,467,938 字节，海外/代理环境用这个 |
   | **GitHub 加速①** | `https://gh-proxy.com/https://github.com/502372626/OmniShade/releases/download/v1.11.1/OmniShade-Setup-1.11.1.exe` | 国内实测 9.3 MB/s |
   | **GitHub 加速②** | `https://ghproxy.net/https://github.com/502372626/OmniShade/releases/download/v1.11.1/OmniShade-Setup-1.11.1.exe` | 备用线路 |
   | **国内直链** | [gdlr.asia/download](https://gdlr.asia/download/OmniShade-Setup-latest.exe) | 自动 302 到 GitHub，不占服务器带宽 |

   校验值（四种线路下载到的都是同一个文件）：
   ```
   SHA256  edfc5a30c0d1022203ce9b032637604689cf8e0075ac5aea323e38d75f0b2191
   大小    579,467,938 字节
   ```
2. 双击 → 确认 → 自动装到 `%LocalAppData%\Programs\OmniShade`
3. 首次打开注册一个账号（**注册即永久授权**，无卡密环节）

约需 4 GB 磁盘空间，解压 2–3 分钟。

## 从源码构建

仓库只含源码（33 MB），依赖与运行时不在版本库里——这是标准做法。

```bash
# 1. 装依赖（约 626 MB）
npm install

# 2. 全链构建（UI 产物 → asar → exe → 安装包）
node build_all_in_one.js --run

# 产物位置
#   dist-local/win-unpacked/            可直接运行的目录
#   dist-local/OmniShade-<version>.7z   安装包载荷
```

构建脚本 STEP 说明见 `build_all_in_one.js` 顶部注释。Electron 运行时、Chromium、node_modules 全部由构建过程生成，不进 Git。

## 设计要点

- **本机优先**：授权、工具桥、会话数据全部落在本机，断网可用
- **零配置**：不需要填 API Key、不需要配 MCP、不需要装依赖
- **单入口**：一次注册 → 永久授权 → 桥自动拉起 → 工具全通

## 架构

```
Electron 主进程 (main.js)
├── ui_shim.js        本地 HTTP 服务 :9435（API 转发 / 页面注入 / 会话落盘）
├── omni_agent.js     推理循环（工具调用 / 流式 / 模型链回退）
├── bridge.js         工具桥 :9431（MCP，49 个工具）
├── runtime_key_store 授权凭证（safeStorage 加密落盘）
└── ui/               注入层（样式 / 快捷键 / 面板 / 更新入口）
```

## 交流

有问题、要反馈、想看更新：**QQ 群 1124698128**

## 打赏

如果这个软件帮到你了，可以扫个码留下一点爱心 ♥

**不打赏也照样永久免费用。**

<img src="docs/omni-tip.jpg" width="220" alt="打赏">

## 免责声明

本项目仅供**自有资产、授权靶标与本地作业环境**使用。使用者需自行确保其行为符合所在地法律法规。作者不对任何滥用行为承担责任。

## License

MIT
