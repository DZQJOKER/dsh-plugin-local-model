/**
 * 全部用内联样式，不引入 CSS modules。
 *
 * 这样客户端 bundle 只有一个入口文件、构建里没有 CSS 产物，
 * 也就少了一处「打包对了但资源没被加载」的失败面。
 *
 * ─────────────────────────────────────────────────────────────
 * ★★ 颜色变量：只能用 `--dsw-*`，`--color-*` 在 DSH 里根本不存在 ★★
 * ─────────────────────────────────────────────────────────────
 *
 * 早期版本这里写的是 `var(--color-background-primary, …)` 那一套（Claude/Cursor 风格的
 * 通用 token）。**DSH 里没有任何一个 `--color-*` 变量**：全量扫过 `app.asar` 的 21810
 * 个文件，`--color-background-primary` / `--color-background-secondary` /
 * `--color-border-tertiary` / `--color-text-primary` 的定义数**都是 0**。
 * 宿主（`@deepseek-ai/dsh-client-ui-theme`）只提供一套 `--dsw-*`：
 *
 *   --dsw-alias-bg-base / bg-layer-1|2|3 / bg-overlay / bg-mask-1 / bg-module-platform
 *   --dsw-alias-border-l1|2|3|4
 *   --dsw-alias-label-primary|secondary|tertiary|dimmed|caption
 *   --dsw-alias-button-primary-fill|hover / button-ghost-active-fill|border
 *   --dsw-alias-interactive-bg-hover
 *   --dsw-alias-state-error|success|warn-primary / -secondary / -tertiary
 *   --dsw-static-neutral-bluish-{00,50,60,75,100,…,1000} 等静态色板
 *
 * 所以 `var(--color-x, fallback)` 永远取 fallback。这正是「设置页元素透明重叠」的
 * **根因**（不是上一轮猜的 sticky 定位问题）：
 *   - `card` / `footer` 的 fallback 是 `'transparent'` → 卡片和底部保存条**是透明的**；
 *   - `cardPinned` 的 fallback 是 `'#fff'` → 浅色主题下白色等于面板白底，看着仍像透明。
 * 下层「运行状态」卡片的文字于是直接透上来，形成叠字。
 *
 * 取色规则（改样式时必须遵守）：
 *   1. **面板底**统一用 `--dsw-alias-bg-layer-2` —— 宿主 `.MI-_Aa_panel` 自己就是这个，
 *      两边同色才能让 sticky 元素「融进」面板、看不出接缝。
 *   2. **一切会挡住下层内容的容器**（sticky 预设条、sticky 保存条、卡片）
 *      背景必须是**不透明**的。宿主变量本身不含 alpha（`bg-layer-2` → `#fff` / `#2c2c2e`），
 *      但 fallback 绝不能写 `'transparent'`。这里统一用 `bg-layer-2`，fallback 写 `#fff`。
 *   3. 半透明底（hover、徽章底色）用 `color-mix(in srgb, …)`，不要直接写 alpha 白/黑，
 *      否则深浅主题下会有一边糊掉。
 */
const c = (name, fallback) => `var(${name}, ${fallback})`

/** 面板底色。宿主 `.MI-_Aa_panel` 用的就是这个 token，两边必须一致。 */
const SURFACE = c('--dsw-alias-bg-layer-2', '#fff')
/** 面板上「再抬一层」的表面：输入框、下拉框这种需要和卡片区分开的地方。 */
const SURFACE_RAISED = c('--dsw-alias-bg-layer-1', '#fff')
/** 一级文字。 */
const LABEL = c('--dsw-alias-label-primary', '#0f1115')
const LABEL_2 = c('--dsw-alias-label-secondary', '#61666b')
/** 分隔线三档（宿主给的是 rgba 白/黑，天然随主题翻转）。 */
const BORDER_1 = c('--dsw-alias-border-l1', 'rgba(0,0,0,0.04)')
const BORDER_2 = c('--dsw-alias-border-l2', '#0000001a')
const BORDER_3 = c('--dsw-alias-border-l3', '#0000001f')
const BORDER_4 = c('--dsw-alias-border-l4', '#00000029')
/** 交互态。 */
const HOVER = c('--dsw-alias-interactive-bg-hover', 'rgba(38,49,72,0.06)')
/** 语义色。 */
const DANGER = c('--dsw-alias-state-error-primary', '#ec1313')
const SUCCESS = c('--dsw-alias-state-success-primary', '#22c55e')
const WARN = c('--dsw-alias-state-warn-primary', '#f59e0b')

export const S = {
  /**
   * 内容区**不写死最大宽度**。
   *
   * 宿主设置面板实测：`.panel` 宽 800px（`max-width: calc(100vw - 48px)`），左导航 188px，
   * `.options` 左右各 24px 内边距 —— 真正能用的宽度只有 `800 − 188 − 48 = 564px`。
   * 原先这里写 720（比可用宽度还宽 156px），于是每张卡片都横向溢出 24px、
   * 字段行被压到换行（见 `field` 的注释）。
   * 宽度交给面板自己决定，这里只保证不撑破它。
   *
   * `paddingBottom` 64 是为了让最后一个卡片滚到底时不被保存条压住 ——
   * 保存条是 sticky 的、会一直在视口底部。
   */
  wrap: { padding: '4px 2px 64px', maxWidth: '100%', boxSizing: 'border-box', minWidth: 0 },
  h2: { fontSize: 15, fontWeight: 500, margin: '0 0 4px' },
  lede: { fontSize: 12.5, opacity: 0.72, margin: '0 0 16px', lineHeight: 1.6 },

  /**
   * 普通卡片。
   *
   * ★ `background` 必须是**不透明**的：写 `transparent` 时，卡片内的说明文字会和
   *   滚动过程中从下面经过的另一张卡片叠在一起（上一版的真实故障）。
   */
  card: {
    border: `1px solid ${BORDER_1}`,
    borderRadius: 12,
    padding: '14px 16px',
    marginBottom: 14,
    background: SURFACE,
    boxSizing: 'border-box',
    minWidth: 0,
  },
  /**
   * 置顶卡：参数预设那一块。
   *
   * 用 sticky 把自己钉在滚动容器（宿主面板的 `.options`，`overflow-y:auto`）顶部。
   * 有四个必须一起处理的细节，否则它会和面板本身「撞车」：
   *
   *   1. sticky 的包含块是 `.options` 的**内边距盒**，`top:0` 相对的是它 ——
   *      而面板上圆角（border-radius: 32px）恰好压在这个位置。滚起来之后
   *      卡片上边缘会被圆角切掉，所以这里留出 `paddingTop` 当缓冲。
   *   2. `.options` 的 `padding: 0 24px 24px` 上边距是 0，那部分属于它自己的 padding、
   *      不被 sticky 元素认领，卡片滚动时会被裁切。
   *   3. 背景必须**不透明且与面板同色**（`--dsw-alias-bg-layer-2`）。写透明、
   *      或写一个和面板不同的白，下层「运行状态」卡片就会透出来 —— 这就是本 bug。
   *      横向用负 margin 把 `.options` 的 24px 内边距**盖满**，
   *      否则卡片左右两侧各留 24px 缝，下面滚过去的内容会从缝里露出来。
   *   4. `isolation: isolate` 新建层叠上下文，`zIndex` 只在本组件内比较，
   *      不会再去和宿主面板的标题栏抢层级。
   */
  cardPinned: {
    position: 'sticky',
    top: 0,
    zIndex: 3,
    marginTop: 0,
    marginLeft: -24,
    marginRight: -24,
    paddingLeft: 24,
    paddingRight: 24,
    paddingTop: 14,
    background: SURFACE,
    isolation: 'isolate',
    /* 和面板同色，上边不需要描边；只在下方留一条分隔线表示「这是浮在上面的」。 */
    borderWidth: '0 0 1px 0',
    borderRadius: 0,
  },

  chipRow: { display: 'flex', flexWrap: 'wrap', gap: 8, margin: '0 0 12px', minWidth: 0 },
  chip: {
    display: 'inline-flex',
    alignItems: 'stretch',
    borderRadius: 9,
    border: `1px solid ${BORDER_4}`,
    overflow: 'hidden',
    maxWidth: '100%',
  },
  /** 当前生效的那一个：加粗边框 + 主色描边，一眼看出「现在跑的是它」。 */
  chipActive: {
    borderColor: LABEL,
    boxShadow: `inset 0 0 0 1px ${LABEL}`,
  },
  chipLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12.5,
    lineHeight: '26px',
    padding: '0 10px',
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    /*
     * 预设名是用户自己填的，可以很长（上限 40 字）。不设上限时单个 chip 会宽到
     * 把「✎ / ×」两个按钮挤出卡片外，和相邻 chip 叠在一起。这里封顶并省略，
     * 完整名字仍可从 title 提示里看到。
     */
    maxWidth: 240,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  chipMeta: { fontSize: 10.5, opacity: 0.6, flexShrink: 0 },
  chipIcon: {
    fontSize: 11.5,
    lineHeight: '26px',
    padding: '0 7px',
    border: 'none',
    borderLeft: `1px solid ${BORDER_3}`,
    background: 'transparent',
    color: 'inherit',
    opacity: 0.7,
    cursor: 'pointer',
    flex: '0 0 auto',
  },
  presetRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 12, minWidth: 0 },

  statusRow: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    padding: '2px 10px',
    fontSize: 12,
    lineHeight: '18px',
    border: '1px solid transparent',
  },
  dot: { width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto' },

  metaGrid: {
    display: 'grid',
    /*
     * 下限必须是 0 而不是 220：`minmax(220px, 1fr)` 会让格子**拒绝压缩到 220px 以下**，
     * 窄设置面板（可用宽度 < 220 + 18 时）整块网格横向溢出卡片，回环地址、模型路径
     * 这些长串会和右侧内容叠在一起。用 `minmax(0, 220px)` 让格子可以被压窄，
     * 长串靠 mono 的 break-all 折行。
     */
    gridTemplateColumns: 'repeat(auto-fit, minmax(0, 220px))',
    gap: '6px 18px',
    marginTop: 12,
    fontSize: 12,
    minWidth: 0,
  },
  metaLabel: { opacity: 0.62 },
  mono: { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 11.5, wordBreak: 'break-all' },

  actions: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 },
  button: {
    fontSize: 12.5,
    lineHeight: '26px',
    padding: '0 12px',
    borderRadius: 8,
    border: `1px solid ${BORDER_4}`,
    background: 'transparent',
    color: LABEL,
    cursor: 'pointer',
  },
  buttonPrimary: {
    fontSize: 12.5,
    lineHeight: '26px',
    padding: '0 14px',
    borderRadius: 8,
    border: '1px solid transparent',
    background: c('--dsw-alias-button-primary-fill', '#0f1115'),
    color: c('--dsw-alias-button-floating-fill', '#fff'),
    cursor: 'pointer',
  },
  buttonDisabled: { opacity: 0.5, cursor: 'default' },

  groupTitle: { fontSize: 13.5, fontWeight: 500, margin: '0 0 2px', display: 'flex', alignItems: 'center', gap: 8 },
  groupHint: { fontSize: 12, opacity: 0.62, margin: '0 0 12px', lineHeight: 1.55 },

  /**
   * 一行设置项：`[标签] [控件] [默认]`，说明文字挂在第二、三列下面。
   *
   * ★ 三列一律用 `minmax(0, …)`，不能写 `minmax(140px, 190px) 1fr auto`：
   *   grid 自动最小尺寸的默认值是 `auto`，即「不小于内容最小宽度」——
   *   `1fr` 那一列于是**拒绝被压到输入框的 min-content 以下**。
   *   改成 0 之后格子才能真正收缩（前提是控件本身也 `minWidth: 0`，见 input/select）。
   *   这是「输入框与『默认』按钮叠在一起」的直接原因：可用宽度不足以容纳
   *   `140(标签下限) + 12 + 输入框min-content + 12 + 44(按钮)` 时，grid 把第二列挤到
   *   下一行，按钮回到右侧，两行内容在视觉上就压住了。
   *   最小需求现在降到 `140 + 10 + 0 + 10 + 44 ≈ 204px`，任何常见分辨率都富余。
   *
   * ★ 标签列上限 168（原 190）是量出来的：最长的标签「GPU 层数（自定义时生效）」
   *   不换行约 200px，会超过上限、把整行撑宽。配合下面的 `overflowWrap` 让它折行。
   */
  field: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 168px) minmax(0, 1fr) auto',
    gap: '6px 10px',
    alignItems: 'start',
    padding: '7px 0',
    borderTop: `1px solid ${BORDER_1}`,
    minWidth: 0,
  },
  /**
   * 标签：与输入框**底对齐**（`flex-end`）。
   * 用 center 时，多行标签会让按钮跟着它一起被撑高、和输入框错位 ——
   * 看起来就是「按钮和输入框没对齐／叠在一起」。
   */
  label: {
    fontSize: 12.5,
    paddingTop: 5,
    display: 'flex',
    alignItems: 'flex-end',
    gap: 6,
    flexWrap: 'wrap',
    minWidth: 0,
    overflowWrap: 'anywhere',
    lineHeight: 1.4,
  },
  /** 说明横跨控件与按钮两列；同样要能压缩，否则长参数说明会把卡片顶宽。 */
  desc: { fontSize: 11.5, opacity: 0.62, lineHeight: 1.5, marginTop: 4, gridColumn: '2 / 4', minWidth: 0, overflowWrap: 'anywhere' },
  /**
   * 输入框 / 下拉框。
   *
   * ★ `background` 用 `--dsw-alias-bg-layer-1`（浅色主题 `#fff`）而不是透明：
   *   宿主变量缺失时旧写法落到 `transparent`，输入框在卡片上就是「看不见底」的一块，
   *   用户会以为渲染坏了。这里给真实底色 + fallback `#fff` 兜住。
   */
  input: {
    minWidth: 0,
    fontSize: 12.5,
    lineHeight: '24px',
    padding: '1px 8px',
    width: '100%',
    boxSizing: 'border-box',
    borderRadius: 7,
    border: `1px solid ${BORDER_4}`,
    background: SURFACE_RAISED,
    color: 'inherit',
  },
  textarea: {
    fontSize: 12,
    padding: '5px 8px',
    width: '100%',
    minWidth: 0,
    boxSizing: 'border-box',
    borderRadius: 7,
    minHeight: 48,
    resize: 'vertical',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    border: `1px solid ${BORDER_4}`,
    background: SURFACE_RAISED,
    color: 'inherit',
  },
  checkboxRow: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' },
  overridden: {
    fontSize: 10.5,
    opacity: 0.75,
    border: `1px solid ${BORDER_3}`,
    borderRadius: 999,
    padding: '0 6px',
    lineHeight: '16px',
  },

  select: {
    fontSize: 12.5,
    lineHeight: '26px',
    padding: '1px 8px',
    width: '100%',
    minWidth: 0,
    boxSizing: 'border-box',
    borderRadius: 7,
    border: `1px solid ${BORDER_4}`,
    background: SURFACE_RAISED,
    color: 'inherit',
  },
  modelMeta: { fontSize: 11.5, opacity: 0.65, marginTop: 6, lineHeight: 1.5 },

  /**
   * 底部保存条（保存 / 放弃修改 / 恢复默认）。
   *
   * ★ 横向负 margin + 同额 padding：`.options` 左右各有 24px 内边距，
   *   sticky 元素默认只覆盖**内容区**宽度，两侧那 24px 缝里滚过去的内容会直接露出来
   *   （旧版 `padding: '10px 0'` 时更明显，连上下都有 10px 缝）。
   *   用 `marginLeft/Right: -24` + `paddingLeft/Right: 24` 把缝盖满。
   * ★ 背景必须不透明：写 `transparent` 时下方「当前模型」输入框会透过按钮显示出来。
   */
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
    position: 'sticky',
    bottom: 0,
    zIndex: 3,
    marginLeft: -24,
    marginRight: -24,
    paddingLeft: 24,
    paddingRight: 24,
    paddingTop: 10,
    paddingBottom: 10,
    background: SURFACE,
    isolation: 'isolate',
    borderTop: `1px solid ${BORDER_1}`,
  },
  dirty: { fontSize: 12, opacity: 0.75 },

  banner: { fontSize: 12, lineHeight: 1.55, borderRadius: 8, padding: '8px 10px', marginBottom: 12 },
  error: { border: `1px solid ${DANGER}`, color: DANGER, background: `color-mix(in srgb, ${DANGER} 8%, transparent)` },
  notice: { border: `1px solid ${SUCCESS}`, color: SUCCESS, background: `color-mix(in srgb, ${SUCCESS} 8%, transparent)` },
  /** 警告（橙）：与状态徽章里的 starting/stopping 同色，表示「能跑但要注意」。 */
  warn: { border: `1px solid ${WARN}`, color: c('--dsw-alias-state-warn-label', '#9a6209'), background: `color-mix(in srgb, ${WARN} 8%, transparent)` },
  hint: { border: `1px solid ${BORDER_2}`, opacity: 0.85 },

  // ── 「本次启动参数」面板（设置页最顶部）────────────────────────────────────
  /**
   * 代码块**横竖都可滚**，不换行。
   *
   * `whiteSpace: 'pre'` + `overflowX: 'auto'` 是刻意的：命令行的每一项都要能一眼看出
   * 「哪一项配哪个值」，一旦自动换行，`--kvmem-budget` 和它的数字就会被拆到两行上去。
   * `maxHeight` 则保证几十项参数也不会把下面的设置项挤出视口。
   */
  codeBlock: {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: 11,
    lineHeight: 1.7,
    margin: 0,
    padding: '10px 12px',
    borderRadius: 8,
    border: `1px solid ${BORDER_2}`,
    background: SURFACE_RAISED,
    color: LABEL,
    overflow: 'auto',
    maxHeight: 280,
    whiteSpace: 'pre',
    minWidth: 0,
  },
  /** 参数摘要：两列网格，窄屏也压得住（列宽 `minmax(0, 1fr)`，裸 `1fr` 会拒绝压缩）。 */
  factGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: '10px 16px',
    margin: '12px 0 0',
    minWidth: 0,
  },
  factCell: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
  factLabel: { fontSize: 11, opacity: 0.6, minWidth: 0 },
  factValue: {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: 11.5,
    wordBreak: 'break-all',
    minWidth: 0,
  },
  factNote: { fontSize: 10.5, opacity: 0.55, lineHeight: 1.45 },
  /** 面板顶部的小标题（「本次启动参数」「参数摘要」这种）。 */
  subTitle: { fontSize: 12.5, fontWeight: 500, margin: '0 0 8px' },
  /** 面板右上角的工具行（复制按钮 + 时间）。 */
  panelHead: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10, minWidth: 0 },
  panelHeadSpacer: { flex: '1 1 auto', minWidth: 0 },
}

/**
 * 状态 → 颜色（各自成对，浅深主题下都保持可读）。
 *
 * 底色用 `color-mix` 从前景色兑出来，而不是写死一套浅色 —— 这样深色主题下
 * 徽章底色自动变暗，不会出现「浅底浅字」看不见的情况。
 */
const pair = (fg) => ({
  fg,
  bg: `color-mix(in srgb, ${fg} 12%, transparent)`,
  border: `color-mix(in srgb, ${fg} 35%, transparent)`,
})

export const STATE_COLORS = {
  ready: pair(c('--dsw-alias-state-success-primary', '#22c55e')),
  starting: pair(c('--dsw-alias-state-warn-primary', '#f59e0b')),
  stopping: pair(c('--dsw-alias-state-warn-primary', '#f59e0b')),
  failed: pair(c('--dsw-alias-state-error-primary', '#ec1313')),
  idle: pair(c('--dsw-alias-label-secondary', '#61666b')),
  disabled: pair(c('--dsw-alias-label-secondary', '#61666b')),
}
