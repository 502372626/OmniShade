# omni-craft-tools.css — 工具/技能页工艺说明

> 作用页：**Tools Marketplace（工具市场，含 Tools / Skills / MCP / Actions 四类）** 与 **工具选择网格（对话框内）**。
> 配套文件：`desktop/ui/omni-craft-tools.css`（仅 CSS 覆盖，未改 React 源码、未改 `index.html`）。

## 一、定位依据（search_files 实查）

在 `desktop/ui/assets/index.Bs825gBQ.js` 中检索到真实类名，确定目标节点：

| 区块 | 真实类名（节选自 bundle） |
|------|---------------------------|
| 工具市场网格容器 | `grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3`（aria-label=`com_ui_tools_marketplace`） |
| 市场卡片根 (gF) | `flex h-32 w-full flex-col gap-2 rounded-2xl border border-border-light p-4` |
| 市场图标瓦片 | `h-10 w-10 shrink-0 rounded-xl` |
| 市场标签 chip | `inline-flex … rounded-full bg-surface-tertiary px-2 py-0.5 text-[10px] text-text-tertiary`（含 `max-w-[60%]`、`px-1.5` 变体） |
| 工具选择网格容器 | `grid grid-cols-1 grid-rows-2 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4` |
| 选择卡片根 | `flex flex-col gap-4 rounded border border-border-medium bg-transparent p-6` |
| 选择图标瓦片 | `h-[70px] w-[70px] shrink-0` |

注：`Skills` 在 bundle 内以 `com_ui_tools_kind_skills` 作为 marketplace 的“kind”之一，与市场卡片共用 `gF` 组件，因此本覆盖对**工具与技能同时生效**。

## 二、前后对比

### 1. 网格间距（gap）
- **前**：市场 `gap-2`(8px)、选择网格 `gap-3`(12px)，卡片贴得紧、留白不足。
- **后**：统一 `gap: 1rem`(16px) `!important`，卡片间呼吸感更足，密集排布不挤。

### 2. 卡片圆角 / 阴影 / hover 抬升
- **市场卡片（前）**：`rounded-2xl border-border-light`，**无背景、无阴影**，悬停无反馈，在深色面板上边界几乎不可见。
- **市场卡片（后）**：补 `background: var(--surface-secondary)` + 分层阴影（`0 1px 2px / 0 8px 22px -12px`）+ `border-medium`；`:hover` 时 `translateY(-4px)` 抬升、accent 描边、`surface-tertiary` 浅亮 + accent 辉光阴影。回弹用 `cubic-bezier(0.34,1.4,0.64,1)` 弹簧曲线。
- **选择卡片（前）**：`rounded border-border-medium bg-transparent p-6`，透明底、无阴影。
- **选择卡片（后）**：同工艺，`radius:16px` + 阴影 + hover 抬升 `-3px` + accent 描边。

### 3. 标签配色（chip）
- **前**：`bg-surface-tertiary text-text-tertiary` —— 灰底灰字，与卡片同色系，标签语义弱、不可一眼区分。
- **后**：改为 **accent 浅染底**（`color-mix(accent 16%, transparent)`，含 `rgba(91,140,255,.16)` 兜底）+ **accent 字** + accent 描边(30%)，字重 600、字距 +0.02em；标签内 `size-2.5` 色点也染 accent。形成清晰的彩色标签，与卡片主色拉开层级。

### 4. 图标对齐
- **前**：图标瓦片仅有尺寸与 `rounded-xl`，无底色/边框；图标与标题仅靠 flex 默认对齐，悬空感强。
- **后**：
  - 市场 `h-10 w-10 rounded-xl` → 加 `display:flex; align/justify:center` + `surface-tertiary` 浅底 + `border-light` 细边，图标居中成“图标瓦片”。
  - 选择 `h-[70px] w-[70px]` → `border-radius:14px` + 浅底细边 + `overflow:hidden`。
  - 标题行（`flex items-center text-sm font-semibold text-text-primary`）→ 强制 `align-items:center` + `line-height:1.3`，图标与名称基线稳定对齐。

## 三、生效方式（装配，不改 React / 不改 index.html 由本任务负责）

在 `desktop/ui/index.html` 的 `<head>` 末尾、`omni-craft-sidebar.css` / `omni-craft-settings.css` / `omni-craft-chat.css` 的 `<link>` 之后追加：

```html
<link rel="stylesheet" href="./omni-craft-tools.css" />
```

（与既有三个 omni-craft 文件同套装配约定；本任务按“只写 CSS 文件，不修改 index.html”要求，未写入该 link。）

## 四、验证状态

- ✅ 选择器全部基于 `assets/index.Bs825gBQ.js` 中实查类名，未臆造。
- ✅ 特异性：使用 `:is(...)` 复合属性选择器 + `!important`，压过 Tailwind 工具类与 React 内联样式。
- ⚠ **截图未验证**：当前为静态选择器覆盖，实际像素渲染（尤其 `color-mix` 兜底、hover 动效）需浏览器/Electron 内打开 Tools 页目视确认。
- ⚠ 若 `index.html` 未加上述 `<link>`，本 CSS 不会加载、无可见效果（属装配遗漏，非 CSS 本身问题）。
