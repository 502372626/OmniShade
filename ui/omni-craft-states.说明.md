# omni-craft-states.css — 空态 / 加载态 / 错误态 工艺说明

> 配套文件：`desktop/ui/omni-craft-states.css`
> 作用：仅 CSS 覆盖 LibreChat 编译产物里的状态组件，**不改 React 源码、不改 index.html**。
> 加载顺序：本文件应在 `omni-craft-sidebar / settings / chat.css` 之后引入，故级联上最后生效。

## 一、实测锚点（从 assets/index.CrPOrEtn.css 与 index.html 反查确认）

| 类别 | 真实 class / 结构 | 出处 |
|---|---|---|
| 加载 | `.spinner`（SVG 旋转圈，keyframes `librechat-spinner-rotate`） | index.css @1657 |
| 加载 | `.animate-spin`（Tailwind，keyframes `spin`）+ `.border-blue-600` 边框 spinner | index.css @154952 / JS `mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-b-2 border-blue-600` |
| 加载 | `.shimmer`（骨架屏文字微光，keyframes `shimmer`，`background-clip:text`） | index.css @174084 |
| 加载 | `.animate-pulse`（Tailwind 骨架块脉冲，keyframes `pulse`） | index.css @42831 |
| 加载 | `.submitting .result-thinking:empty:last-child:after`（生成中呼吸点，keyframes `lc-dot-breathe`） | index.css @157808 |
| 加载 | `#loading-container`（index.html 中 React 挂载前启动空 div，原**完全未着色**） | index.html @306 |
| 空态 | `[class*="border-dashed"]`（虚线框空位 / 上传占位） | index.css 多处在 |
| 空态 | `[class*="min-h-40"]`（居中空状态容器） | index.css `flex min-h-40 flex-col items-center justify-center gap-3 …` |
| 空态 | `[class*="py-16"]`（整屏空状态） | index.css `flex flex-col items-center justify-center py-16 text-center` |
| 错误 | `.omni-chrome-error`（编译产物自带错误条，原白底 `.surface-dialog`） | index.css @114522 |
| 错误 | `.bg-status-error-subtle` / `.border-status-error-border` / `.text-status-error` / `.text-text-destructive` | index.css 多处 |

## 二、前后对比（文字）

### 加载态
- **`.spinner` / `.animate-spin`**
  - 前：灰白 currentColor，无层次。
  - 后：统一染 `--accent-primary`(#5b8cff) 强调蓝，`drop-shadow` 柔光环，`will-change:transform` 更顺；蓝色边框 spinner 重染为「暗底+蓝顶」扫光环 + 柔光，转速 0.9s 更利落。
- **`.shimmer`（骨架文字）**
  - 前：灰白↔深灰微光（中性）。
  - 后：改为**强调蓝微光**（`--shimmer-base:91 140 255`），暗谷柔和石板灰，时长 4s→2.6s，加微文字辉光，更贴 OmniShade 调性。
- **`.animate-pulse`（骨架块）**
  - 前：整块透明度 1↔0.5 脉冲，略呆。
  - 后：升级为**微光扫光**（`omni-shimmer-block` 渐变扫过，暗底+蓝调高光），更像工艺骨架屏。
- **生成中呼吸点**
  - 前：纯文字色实心点，`lc-dot-breathe` 仅透明度变化。
  - 后：染强调蓝 + 柔光 + `omni-think-breathe`（透明度+缩放同步呼吸），更生动。
- **`#loading-container`（启动屏）**
  - 前：一块空白 `<div>`，React 挂载前纯黑无反馈。
  - 后：居中 42px 蓝顶扫光圈（`librechat-spinner-rotate` 复用），启动即有品牌感。

### 空态
- **虚线占位 `[class*="border-dashed"]`**
  - 前：默认灰虚线 + 灰字。
  - 后：柔和蓝虚线 + 极淡蓝底(4%)，圆角 `--radius`，hover 蓝边+蓝底(7%)+外环辉光，引导感更强。
- **居中空容器 `[class*="min-h-40"]`**
  - 前：gap-3(12px)，次级灰字。
  - 后：gap 拉到 18px，文字柔化为 `--text-secondary`，留白更舒展。
- **整屏空态 `[class*="py-16"]`**
  - 前：上下 py-16，无装饰。
  - 后：上下 80px 大留白，首个元素上方加一条「渐隐蓝分隔细线」(`::before`)，营造干净空场。

### 错误态
- **`.omni-chrome-error`（错误条）**
  - 前：白底 + 红边(`--border-destructive`) + 红字，浮在暗色界面上很突兀。
  - 后：**柔和红**重做——淡红底(8%) + 细红边(35%) + 左侧 3px 红条标识 + 红字降级为 `#f08a7e` 柔红 + 轻投影 + 毛玻璃 + `omni-error-in` 轻入，与暗色一体。
- **错误表面/文字令牌**
  - `.bg-status-error-subtle` → 柔和红底(10%)；`.border-status-error-border` → 柔和红边(40%)；`.text-status-error`/`.text-text-destructive` → 柔红 `#f08a7e`（降饱和不刺眼）。

## 三、接入方式（需在 index.html 末尾补一行 link —— 本次**未改 index.html**，按约束仅产出 CSS）

在 `index.html` 的 `</head>` 前、现有三条 craft 链接之后加入：

```html
<link rel="stylesheet" href="./omni-craft-states.css" />
```

位置参考（index.html 现有）：
```html
<link rel="stylesheet" href="./omni-craft-sidebar.css" />
<link rel="stylesheet" href="./omni-craft-settings.css" />
<link rel="stylesheet" href="./omni-craft-chat.css" />
<link rel="stylesheet" href="./omni-craft-states.css" />   <!-- 新增 -->
```

## 四、特异性与安全性
- 全局状态 class 自身 (0,1,0)，统一以 `html` 前缀抬到 (0,1,1) + `!important`，稳压编译产物单行工具类。
- 自定义属性 `--shimmer-*` 用 RGB 三元组（编译产物以 `rgb(var(--shimmer-x)/a)` 包裹），未误用 hex，避免语法失效。
- 表面/文字/强调变量直接 `var(--xxx)` 原值引用（OmniShade 覆写为十六进制，不可包进 `rgb()`）。
- 含 `prefers-reduced-motion` 降级：关闭 spinner/扫光/呼吸/错误条动画，骨架降级为静态色。

## 五、验证状态
- **截图未验证**：本机无运行中的 LibreChat 桌面实例，无法实机截图比对。
- 已静态校验：CSS 括号配平(34/34)、无非法 `rgb(var(--hex))`、4 个本地 `@keyframes` 定义完整、`librechat-spinner-rotate` 复用自编译产物、全部锚点选择器与实测 class 对应。
- 建议验证步骤：桌面端启动 → 观察启动 spinner；进入空会话看虚线/留白；触发一次加载看骨架扫光；制造一个错误看错误条柔和红。
