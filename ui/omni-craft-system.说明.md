# OmniShade 全局设计系统工艺说明（omni-craft-system.css）

> 配套文件：`desktop/ui/omni-craft-system.css`（仅 CSS 覆盖层，不碰 React / TSX 源码，不改 `index.html`）
> 校验方法：对比度用 WCAG 2.1 相对亮度公式逐对实算（脚本见文末），非目测。
> 截图：**未验证**。以下为静态选择器 + 数值校验结论，最终像素以浏览器渲染为准。

---

## 0. 角色定位

本文件是 5 个 craft 覆盖层之上的**设计令牌 + 全局强制执行**层，与已存在的三条覆盖层职责切分：

| 文件 | 职责 |
|------|------|
| `omni-craft-sidebar.css`  | 侧边栏 / 会话列表工艺 |
| `omni-craft-settings.css` | 设置页 / 弹窗工艺 |
| `omni-craft-chat.css`     | 主聊天页 / 气泡 / 输入工艺 |
| **`omni-craft-system.css`（本）** | **全局令牌与跨页基线：缓动、字号、对比度、间距、焦点** |

加载顺序要求（级联末端才压得住 inline `#omni-craft` 与 Tailwind）：
`omni-craft-sidebar` → `omni-craft-settings` → `omni-craft-chat` → **`omni-craft-system`**。

---

## 1. 动效曲线统一

- **定义**：`--ease-out: cubic-bezier(.22, 1, .36, 1)`（标准缓出），另给 `--ease-standard` / `--ease-out-fast` 别名。
- **全局接管**：`* , *::before , *::after { transition-timing-function / animation-timing-function: var(--ease-out) !important }`。
- **前 → 后**：
  - 前：页面动效曲线散落——Tailwind 默认 `ease-in-out(.4,0,.2,1)`、各组件自写曲线，节奏不统一。
  - 后：所有过渡/动画统一收敛到同一条缓出曲线。
- **不误伤特例**：craft 文件里**更高特异性 + `!important`** 的故意弹簧（如设置页开关滑块 `cubic-bezier(.34,1.56,.64,1)` 回弹）因特异性胜出，仍保留回弹手感；普通 `!important` 作者声明压过 Tailwind 非 `!important` 工具类，达成「默认统一、特例保留」。
- `prefers-reduced-motion` 下时长压到瞬时，曲线仍统一。

---

## 2. 字号比例层级（rem）

根锁定 `html{font-size:100%}` = 16px，故 rem 严格等于标注 px：

| 变量 | rem | px | 用途 |
|------|-----|----|------|
| `--fs-xs`    | .75   | 12 | 角标 / 计数 / 最次级提示 |
| `--fs-sm`    | .8125 | 13 | 次级正文 / 列表项 |
| `--fs-base`  | .875  | 14 | 默认正文基准（`body` 落地） |
| `--fs-md`    | 1     | 16 | 输入框 / 强调正文 |
| `--fs-lg`    | 1.25  | 20 | 区块标题 / h2 |
| `--fs-xl`    | 1.5   | 24 | 页标题 / h1 |
| `--fs-2xl`   | 2     | 32 | 顶部大标题 / 空态主文案 |

- 前：字号靠 Tailwind `text-sm/text-base/...` 散点定义，缺统一令牌，跨页易漂移。
- 后：7 级唯一来源，组件层应改引用 `--fs-*`。

---

## 3. 色彩对比度校验（WCAG AA，已实算）

阈值：**正文 ≥ 4.5:1，大字号（≥18.66px 粗体 / ≥24px）≥ 3:1**。
背景取各 `--text-*` 实际落点（来自 inline `#omni-craft` 的 surface 令牌）。

### 3.1 inline 原值（修复前）

| 变量 | 原值 | 落点背景 | 实测比值 | 判定 |
|------|------|----------|----------|------|
| `--text-primary`   | `#e9edf5` | `#0a0c10` | **16.5:1** | AA 正文 ✅ |
| `--text-secondary` | `#aab3c5` | `#11141b` | **8.7:1**  | AA 正文 ✅ |
| `--text-tertiary`  | `#6f7889` | `#161a23` | **3.9:1**  | ❌ 未达正文 4.5（仅够大字号） |
| `--text-muted`     | `#59617a` | `#0c0e13` | **3.1:1**  | ❌ 未达正文 4.5（仅够大字号） |

→ 原 tertiary / muted 在小字号正文场景**不达标**，属可访问性缺陷。

### 3.2 system.css 覆盖值（修复后，全部 AA 正文达标）

| 变量 | 新值 | 落点背景 | 实测比值 | 判定 |
|------|------|----------|----------|------|
| `--text-primary`   | `#eef2f8` | `#0a0c10` | **17.4:1** | AA 正文 ✅（AAA ✅） |
| `--text-secondary` | `#c2cbd9` | `#11141b` | **11.3:1** | AA 正文 ✅（AAA ✅） |
| `--text-tertiary`  | `#9aa4b6` | `#161a23` | **6.9:1**  | AA 正文 ✅（原 3.9 → 修复） |
| `--text-muted`     | `#7e879b` | `#13161e` | **5.0:1**  | AA 正文 ✅（原 3.1 → 修复） |

- 前 → 后：`text-tertiary` 3.9→6.9:1，`text-muted` 3.1→5.0:1，两处从「仅大字号达标」提升至「正文即达标」。
- 视觉代价极小：仅是暗灰提示文字提亮一档，整体暗色基调不变。

### 3.3 焦点 accent 可见度（附）

焦点描边用 `--accent-primary: #5b8cff`，其在各暗背景上的比值：

| accent `#5b8cff` on | 比值 |
|---------------------|------|
| `#0a0c10` | 6.2:1 |
| `#0c0e13` | 6.1:1 |
| `#11141b` | 5.8:1 |
| `#13161e` | 5.7:1 |

→ 2px accent 描边在暗底上对比 5.7–6.2:1，**清晰可见**，满足焦点指示可辨要求。

---

## 4. 间距标尺

`--space-1..6` = 4 / 8 / 12 / 16 / 24 / 32 px。组件层间距应改引用此标尺，替代散落的 `px`/`rem` 魔法值，保证呼吸感一致。
（注：chat/sidebar/settings 已大量使用 8/12/16/24 节奏，本标尺与之同源、补齐 4/32 两端。）

---

## 5. 焦点可见性

- **规则**：`:where(...):focus-visible` 给一切可聚焦元素 2px accent 描边 + 2px 偏移（`--focus-ring-width` / `--focus-ring-offset`）。
- **抢回输入框描边**：inline `#omni-craft` 用 `textarea:focus,input:focus,div[contenteditable]:focus{outline:none!important}` 关掉了原生描边、改走 box-shadow 辉光。本文件用**同特异性 (0,1,1) + 更靠后源码顺序**的 `:focus-visible` 规则把 2px accent 描边抢回，键盘焦点在输入框也一致可见。
- 前 → 后：键盘 Tab 游走时，按钮/链接/输入框/开关等全部出现统一 accent 描边；原仅输入框靠 box-shadow 辉光（仍保留，二者叠加）。

---

## 激活装配（父代理待执行，本任务不改动 index.html）

在 `desktop/ui/index.html` 的 `<head>` 末尾、已有三条 craft `<link>` **之后**追加一行：

```html
<link rel="stylesheet" href="./omni-craft-system.css" />
```

未装配前本文件不生效（符合「只写 CSS、不改 index.html」约束）。

---

## 校验脚本（可复现）

```python
def lin(c):
    c/=255.0
    return c/12.92 if c<=0.03928 else ((c+0.055)/1.055)**2.4
def lum(h):
    h=h.lstrip('#'); r,g,b=int(h[0:2],16),int(h[2:4],16),int(h[4:6],16)
    return 0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b)
def ratio(f,b):
    L1,L2=lum(f),lum(b); hi,lo=max(L1,L2),min(L1,L2)
    return round((hi+0.05)/(lo+0.05),2)
# 用法：ratio('#9aa4b6','#161a23') -> 6.93
```
