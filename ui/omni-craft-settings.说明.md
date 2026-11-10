# omni-craft-settings.css — 设置页工艺说明

> 范围：LibreChat 桌面端设置页（模型配置 / API Key / 参数）。
> 覆盖策略：纯 CSS `!important` + 高特异性属性选择器，**不改 React 源码**。
> ⚠ 截图未验证：以下前后对比为基于选择器与样式的静态推断，实际像素以浏览器渲染为准。

## 一、选择器依据（均从 `desktop/ui/assets/*.js` 反查确认）

| 组件 | 真实结构（来自 bundle） |
|------|------------------------|
| 设置页根 | 竖向 Radix `Tabs`，class 含 `flex flex-1 flex-col gap-4 overflow-hidden p-5 md:flex-row md:gap-6` |
| API Key 弹窗 | `SetKeyDialog`，面板 class 含 `bg-surface-dialog shadow-2xl` |
| 文本/密码输入 | `input`/`textarea`，class 含 `h-10 w-full rounded-xl border border-border-medium bg-transparent ...` |
| 开关 | Radix `<button role="switch">`，`data-[state=checked]:bg-accent-primary`；滑块为 `> span[data-state]` |
| 分区卡片 | class 含 `rounded-xl bg-surface-secondary` / `rounded-lg bg-surface-secondary` |
| 字段标签 | `mb-1 text-sm font-medium`、`text-left text-sm font-medium`；微提示 `text-xs text-text-tertiary` |
| 保存/主按钮 | `.btn.bg-surface-submit`，`text-text-on-status font-semibold` |
| 参数滑块 | Radix `span[role="slider"]`（temperature / top_p 等） |

作用域用 `:is(设置页根, API Key 弹窗)` 包裹，只对这两处生效，不污染聊天等其它页面。

## 二、前后对比

### 1. 表单控件间距
- **前**：字段列容器 `gap-1.5 / gap-2`，控件紧凑、`mb-1` 标签贴边。
- **后**：字段列 `gap` 拉大到 `0.95~1.25rem`，`mb-1/mb-1.5` 标签下方补 `0.4~0.5rem`，控件内边距统一 `0.6rem 0.85rem`。整体纵向呼吸感更足。

### 2. 输入框圆角 + 聚焦辉光
- **前**：圆角 `rounded-xl`，聚焦仅有全局 `1px accent` 描边（来自 `omni-craft` 内联）。
- **后**：统一 `border-radius:12px`，背景改为 `--surface-tertiary`；聚焦时 `1px accent` 描边 + `0 0 16px -3px rgba(91,140,255,.55)` 外发光，因特异性更高压过全局 focus 样式。

### 3. 开关动效
- **前**：开关底盘 `transition-colors`，滑块 `transition-transform translate-x-5`，无辉光。
- **后**：底盘开启态加 `0 0 0 2px accent + 0 0 12px -2px` 辉光；滑块尺寸放大到 `1.15rem`、位移改用 `cubic-bezier(.34,1.56,.64,1)` 弹簧曲线，开启/关闭有回弹手感。

### 4. 分区卡片：轻阴影 + 细边框
- **前**：卡片仅 `border border-border-light/medium`，无阴影。
- **后**：统一 `1px` 细边框 + `0 1px 2px / 0 6px 18px -10px` 双层轻阴影；hover 时边框转 accent、阴影转为蓝色泛光，分区边界更立体。

### 5. 标签字号层级
- **前**：字段标题 `text-sm font-medium`、微提示 `text-xs text-text-tertiary`、大标题 `text-2xl`，层级靠默认字号。
- **后**：三级明确——大标题 `text-2xl/-0.01em`；字段标题 `0.8125rem / 600` 主文字色；微提示 `0.6875rem` 大写 + `0.06em` 字距 + tertiary 色，形成「标题→字段名→提示」清晰层级。

### 6. 保存 / 主按钮强调
- **前**：`.btn.bg-surface-submit` 平涂色块，hover 仅换色。
- **后**：改为 `180deg` 渐变（submit-hover→submit），加 `inset` 高光 + 蓝色投影；hover `brightness(1.08) + translateY(-1px)` 上浮，active `scale(.98)` 按压回弹；底部保存行加顶部分隔线并下沉留白。

### 7. 参数滑块（temperature / top_p）
- **前**：Radix 默认小滑块，无明显强调。
- **后**：`span[role="slider"]` 改为 `16px` accent 圆点 + `2px` 白边 + `0 0 0 3px` 蓝色光环；抓取时 `cursor:grab/grabbing` + `scale(1.15)` 放大反馈。

## 三、生效方式（HTML 装配，非 React 改动）

`desktop/ui/index.html` 的 `<head>` 末尾已追加：
```html
<link rel="stylesheet" href="./omni-craft-settings.css" />
```
（位于既有 `omni-craft` 内联样式与 `omni-craft-sidebar.css` 之后，确保本文件更高优先级。）

## 四、注意 / 风险
- 选择器基于 **当前构建产物**（`AccountSettings.C6Q414A8.js`、`hooks.BMVs3w69.js`、`radix-ui.BqLeJ6oI.js` 等）反查；若 LibreChat 升级改了 class 命名，需重新对齐作用域字符串。
- `:is()` 原生嵌套在现代 Chromium（LibreChat 桌面 webview）支持；老内核不支持。
- 全站均未截图验证，像素效果以实机渲染为准。
- 未改动任何 `.js` / `.tsx` / React 组件源码。
