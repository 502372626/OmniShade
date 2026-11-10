# 主聊天页工艺说明 — omni-craft-chat.css

> 覆盖层性质：纯 CSS 覆盖，不改任何 React/TSX 源码（依赖不全无法重建，故不碰构建）。
> 加载链：`index.html` 末尾已按既有 `omni-craft-sidebar/settings.css` 的模式追加
> `<link rel="stylesheet" href="./omni-craft-chat.css" />`，位于编译产物
> `assets/index.*.css` 与 inline `#omni-craft` 令牌表之后，级联顺序最后生效；
> 竞争属性再用 `!important` 与 `.omni-route-viewport` 高特异性兜底。
>
> ⚠️ **验证状态：未验证 — 无 GUI 无法渲染**。以下"前后对比"为基于源码选择器契约
> （MessageRow.tsx / ChatForm.tsx / MessagesView.tsx）与编译 CSS 推演的工艺差异，
> 未在真实窗口渲染核对。请在有桌面的环境用 LibreChat 编译 UI 打开对话页目测。

---

## 一、改造范围（命中真实 DOM 契约）

| 区域 | 选择器（来自源码/编译 CSS） | 说明 |
|---|---|---|
| 消息行 | `.message-render`（`.user-turn` / `.agent-turn`） | 每行包裹，决定对齐与节奏 |
| 气泡 | `[data-testid=message-body]` | 用户实心泡 / 助手阅读态 |
| 头像 | `.agent-turn h2 > span.size-6` + `.t-avatar` | 助手头像描边环影 |
| 正文 | `.markdown` / `.message-content` / `.message-editor-text` | Markdown 字体层级 |
| 代码块 | `.markdown pre` / `.message-content pre` / `.code-analyze-block pre` | 块级代码 |
| 行内代码 | `:where(code):not(pre code)` | 行内片段 |
| 输入框 | `[data-testid=composer-surface]` + `.omni-native-composer` / `textarea` | 写作区 |
| 发送键 | `[data-testid=send-button]` / `.bg-surface-submit` | 主操作 |
| 操作栏 | `[data-testid=message-actions]` | 复制/重生成等 |
| 列表容器 | `.flex.flex-col.pb-9.pt-14` | 消息纵向留白 |

---

## 二、工艺标准落地

- **间距层次 8 / 12 / 16 / 24px**：以 `--omni-space-1..4` 令牌统一，消息行间距 16px、
  气泡内距 12×16px、工具栏/列表留白 8/24px。
- **字号层次 13 / 14 / 16 / 20px**：`--omni-fs-sm..lg`，正文 14、h2 16、h1 20、代码 13。
- **圆角 `--radius` 12px**：气泡、代码块、输入框统一 12px；行内代码 6px、按钮 8–10px 分级。
- **气泡轻阴影**：`--omni-bubble-shadow`（1px 贴边 + 弥散负扩散投影），hover 加重。
- **输入框聚焦辉光**：`:focus-within` 切 accent 描边 + `--omni-glow` 双层环影外发光。
- **消息入场动效**：`@keyframes omni-msg-in`（opacity 0→1 + translateY 10px→0），
  统一缓动 `cubic-bezier(.22,1,.36,1)`，0.42s；并尊重 `prefers-reduced-motion`。

---

## 三、前后对比（推演）

### 1. 消息气泡
- **前**：用户泡 `bg-surface-tertiary` + `py-2.5` + 旧 `--theme-surface` 圆角，无阴影；
  助手泡满宽透明无边界，段落与列表间距由 Tailwind 默认撑开，层级偏平。
- **后**：用户泡 12px 圆角 + 1px 细边 + 轻阴影 + 12/16 内距，hover 轻微抬升；
  助手泡保留满宽阅读态仅给左右 8px 内距，段落 12px、列表项 8px 节奏清晰。

### 2. 头像
- **前**：`size-6` 圆角包裹，仅默认 overflow 裁切，无描边/环影，弱聚焦。
- **后**：1.5px `--border-heavy` 描边 + 双层环影（surface 隔离环 + 弥散投影），
  与暗色背景拉开层次；`.t-avatar` 强制圆形 + `object-fit:cover`。

### 3. 排版字号
- **前**：正文 `--markdown-font-size`（默认 1rem≈16）统一，标题按 1.75/1.5/1.25 倍缩放，
  长文偏"重"，聊天场景密度高。
- **后**：聊天正文降为 14px（更紧凑），标题 16/20 分级，行内代码 13px，阅读密度更贴聊天场景。

### 4. 代码块
- **前**：pre 用 `--theme-surface` 圆角 + 旧 elevation，内距随主题，块/行内区分弱。
- **后**：统一 12px 圆角 + 边框 + `surface-code` 底 + 轻阴影 + 16px 内距；行内代码独立
  浅底细边 6px 圆角，块级与行内一眼可分。

### 5. 输入框 Composer
- **前**：`composer-surface` 1rem 圆角 + `--theme-elevation-surface` 投影，聚焦无专属辉光；
  textarea 字号随继承。
- **后**：12px 圆角 + 轻阴影；`:focus-within` accent 描边 + 外发光辉光；textarea 14px 舒适行高，
  placeholder 用 `--text-muted`。

### 6. 发送按钮
- **前**：`bg-surface-submit` 实色，无过渡/反馈。
- **后**：10px 圆角 + accent 投影；hover 上移 1px 投影加强，active 缩 0.96，过渡曲线统一。

### 7. 操作工具栏
- **前**：`message-actions` 默认随 `--avatar-dur` 透明度出现，按钮无圆角/内距统一。
- **后**：flex 8px 间距 + 顶部 8px 留白 + 0.2s 淡入；按钮 8px 圆角 + 6px 内距 + hover 浅底 +
  active 缩 0.92，与全局触觉一致。

### 8. 消息入场
- **前**：无逐条入场动效（仅 `--avatar-dur` 影响头像）。
- **后**：每条 `.message-render` 以 omni-msg-in 淡入上移，缓动 `cubic-bezier(.22,1,.36,1)`，
  新增消息从底部自然浮入；减少动态偏好下自动关闭。

---

## 四、风险与回滚

- 本文件纯增量覆盖，不删除编译 CSS 任何规则；删除 `index.html` 中那一行 `<link>` 即整体回退。
- 作用域全部挂在 `.omni-route-viewport` 下，不影响侧边栏/设置页等其它 omni-craft 覆盖层。
- 若某选择器契约在后续 LibreChat 升级中改名（如 `message-body` testid），对应规则自动失效、
  静默回退到编译默认，不会报错。
