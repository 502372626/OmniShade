# omni-craft-kb.css — 知识库 / 文件管理页 工艺说明

> 配套文件：`desktop/ui/omni-craft-kb.css`
> 生效方式：由主控在 `index.html` 的 `<head>` 末尾（其它 `omni-craft-*.css` 之后）统一追加
> `<link rel="stylesheet" href="./omni-craft-kb.css" />`。**本任务不改动 index.html，不改动任何 React 源码。**
> 验证状态：静态选择器已逐条比对编译产物（命中真实 class，大括号平衡）。**截图未验证——无 GUI 环境，实际像素以浏览器渲染为准。**

---

## 一、现场勘察结论（真实类名来自编译产物）

| 区块 | 实测命中 class（节选） |
|---|---|
| 文件管理页表格容器 | `rounded-lg border border-border-light bg-transparent shadow-sm transition-colors` |
| 表格元素 | `table-fixed` |
| 表头格 | `bg-surface-secondary py-2 text-sm font-medium text-text-secondary` |
| 表体行 | `border-b border-border-light transition-colors hover:bg-surface-secondary [&:last-child]:border-0` |
| 无结果行 | `h-24 text-center text-sm text-text-secondary` |
| 文件卡片体 | `relative overflow-hidden rounded-2xl border border-border-medium` |
| 卡片外层 | `group relative inline-block text-sm text-text-secondary` |
| 卡片包装 | `flex flex-wrap gap-2` / `mx-2 mt-2 flex flex-wrap gap-2` |
| 上传拖拽区 | `group flex w-full flex-col … rounded-xl border border-dashed border-border-medium bg-surface-secondary` |
| 上传进度轨道 | `h-2 w-full rounded-full bg-surface-tertiary` |
| 上传进度填充 | 上述轨道直接子 `div`（`bg-blue-600` + 内联 width） |
| Manage Files 弹窗面板 | `w-11/12 bg-surface-dialog text-text-primary shadow-2xl` |
| 弹窗表格区 | `max-h-[calc(100vh-20rem)] … rounded-md border border-border-light` |
| 弹窗列表操作钮 | `px-2 py-0 text-xs hover:bg-surface-hover` |
| 上传/操作主按钮 | `btn btn-neutral border-token-border-light relative h-8/h-9 w-full rounded-lg font-medium` |
| 拖放遮罩 | `rounded-2xl border border-border-light bg-surface-primary/60 p-8 shadow-2xl backdrop-blur-xl` |

设计令牌复用 `omni-craft`（`index.html <style id="omni-craft">`）注入的
`--accent-primary / --accent-primary-hover / --surface-* / --border-* / --text-* / --radius(12px)`。

---

## 二、工艺标准落实清单

- **间距层次 8 / 12 / 16 / 24**：卡片包装 gap 8→12；单元格/表头 padding 12/16；无结果行 padding 24；统一经 `--kb-gap-*` 常量管理。
- **字号层级**：标题沿用 `text-lg`(18)；正文 13px；表头微标签 11px 大写 + 0.06em 字距；说明文字 12px（`--text-tertiary`）。
- **圆角 12px**：表格容器、卡片体、弹窗、拖拽区、按钮、进度条全部归一到 `--kb-radius`(=12px)，覆盖原 `rounded-2xl`(16) / `rounded-md`(6) / `rounded-lg`(8)。
- **卡片轻阴影细边框**：卡片体 / 表格容器 / 弹窗面板统一 `1px --border-medium` + 双层轻阴影（`--kb-shadow-card`）。
- **hover 微动效**：
  - 卡片：`-2px` 抬升 + accent 描边 + 外发光；内部预览图 `scale(1.06)`。
  - 表体行：accent 底色染 + 左侧 3px 色条（`inset` 阴影）。
  - 拖拽区 / 按钮：accent 描边 + 辉光 + `-1px` 抬升；按钮 `:active` `scale(0.98)`。
  - 卡片删除钮：默认隐去，hover / focus 时浮现（减少视觉噪音）。
- **上传进度态**：轨道高 8px、内嵌暗阴影、圆角满；填充改为 accent 渐变 + 辉光，进度仍由 React 内联 `width` 驱动。

---

## 三、前后对比（文字）

### 1) 文件管理页表格
- **前**：容器 `bg-transparent` 近乎无边界、仅 `shadow-sm`；表头与正文同色同字号、无层级；表体行 hover 仅换底色；无结果行拥挤。
- **后**：容器沉入 `--surface-secondary` + 细边框 + 轻阴影 + 12px 圆角；表头降级为 11px 大写 tertiary 微标签，与正文拉开层级；表体行 hover 染 accent 并亮起左侧色条；单元格统一 12/16 内边距；无结果行放松到 24px 留白。

### 2) 文件卡片（Knowledge / 文件上下文区）
- **前**：卡片体 `rounded-2xl`(16px) + 细边但无阴影；hover 无反馈；预览静止；删除钮常驻。
- **后**：12px 圆角 + 细边框 + 轻阴影；hover 轻微抬升 + accent 描边 + 外发光，预览图放大 1.06；删除钮默认隐去、悬浮/聚焦浮现。卡片包装行距 8→12。

### 3) 上传拖拽区
- **前**：`border-dashed border-border-medium bg-surface-secondary`，hover 仅换边色。
- **后**：虚线加粗到 1.5px、底色微染 accent；hover 描边变 accent + 辉光 + 轻微抬升，落点明确。

### 4) 上传进度态
- **前**：轨道 `bg-surface-tertiary` 细条；填充 `bg-blue-600`（与主题 accent 不一致）。
- **后**：轨道加高到 8px、内嵌暗阴影；填充改为 accent 渐变 + 辉光，与全站强调色统一。

### 5) Manage Files 弹窗
- **前**：面板 `shadow-2xl` 无边框；表格区 `rounded-md`(6) 细边；列表操作钮 `hover:bg-surface-hover` 平淡。
- **后**：面板放大圆角 + 重描边 + 深投影；表格区 12px 圆角；操作钮 8px 圆角 + hover accent 染 + 文字提亮。

### 6) 上传 / 操作主按钮
- **前**：`btn btn-neutral` 默认态，hover 仅换底色。
- **后**：12px 圆角 + 细边框；hover accent 描边 + 辉光 + 抬升；active 回弹 `scale(0.98)`。

### 7) 拖放遮罩
- **前**：`bg-surface-primary/60` 实边 + 模糊。
- **后**：虚线变 accent、底色染 accent、加 accent 辉光，拖拽落点更具引导性。

---

## 四、特异性与风险

- 所有规则以 `:is([class*="..."])` 局部匹配 Tailwind 工具类组合起手（复合特异性 ≥ (0,2,0)），属性全部 `!important`，稳稳压过 Tailwind 单类(0,1,0) 与内联样式。
- 过滤输入框用 `:has(table)` 将作用范围精确锁在文件页 / 弹窗表格内，避免误伤其它输入框。
- 表体行 hover 规则子串（`border-b border-border-light transition-colors hover:bg-surface-secondary`）同时覆盖「文件页表」与「Manage Files 弹窗表」，二者视觉一致，无副作用。
- 未修改任何 React 源码与 `index.html`；HTML `<link>` 装配由主控统一负责。

---

## 五、验证

- ✅ 大括号平衡（31 / 31）。
- ✅ 110 条 `class*="..."` 子串逐条比对 `index.Bs825gBQ.js` 与 `MyFilesModal.*.js`，**全部命中真实 class，无死选择器**。
- ⚠ 截图未验证：无 GUI 环境，渲染像素以浏览器实际表现为准。
