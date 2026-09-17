/**
 * 全部用内联样式，不引入 CSS modules。
 *
 * 这样客户端 bundle 只有一个入口文件、构建里没有 CSS 产物，
 * 也就少了一处「打包对了但资源没被加载」的失败面。
 * 颜色走宿主主题变量，取值失败时回落到中性色。
 */

const c = (name, fallback) => `var(${name}, ${fallback})`

export const S = {
  /**
   * 内容区**不写死最大宽度**。
   *
   * 宿主设置面板实测：`.panel` 宽 800px（`max-width: calc(100vw - 48px)`），左导航 188px，
   * `.options` 左右各 24px 内边距 —— 真正能用的宽度只有 `800 − 188 − 48 = 564px`。
   * 原先这里写 720（比可用宽度还宽 156px），于是每张卡片都横向溢出 24px、
   * 字段行被压到换行（见 `field` 的注释）。
   * 宽度交给面板自己决定，这里只保证不撑破它。
   */
  wrap: { padding: '4px 2px 32px', maxWidth: '100%', boxSizing: 'border-box', minWidth: 0 },
  h2: { fontSize: 15, fontWeight: 500, margin: '0 0 4px' },
  lede: { fontSize: 12.5, opacity: 0.7, margin: '0 0 16px', lineHeight: 1.6 },

  card: {
    border: `1px solid ${c('--color-border-tertiary', 'rgba(0,0,0,0.12)')}`,
    borderRadius: 12,
    padding: '14px 16px',
    marginBottom: 14,
    background: c('--color-background-primary', 'transparent'),
    boxSizing: 'border-box',
    minWidth: 0,
  },
  /**
   * 置顶卡：参数预设那一块。
   *
   * 用 sticky 把自己钉在滚动容器（宿主面板的 `.options`，`overflow-y:auto`）顶部。
   * 有三个必须一起处理的细节，否则它会和面板本身「撞车」：
   *
   *   1. sticky 的包含块是 `.options` 的**内边距盒**，`top:0` 相对的是它 ——
   *      而面板上圆角（border-radius: 32px）恰好压在这个位置。滚起来之后
   *      卡片上边缘会被圆角切掉、盖住面板标题栏，所以这里留出 `paddingTop` 当缓冲。
   *   2. `.options` 的 `padding: 0 24px 24px` 上边距是 0，那 24px 属于它自己的 padding、
   *      不被 sticky 元素认领，于是卡片上方会留一条**能滚动的透明缝**，下层卡片从缝里透出来。
   *      所以这里必须给**实色背景**把穿透挡掉（取不到主题色时回落到不透明白）。
   *   3. `isolation: isolate` 新建层叠上下文，`zIndex` 只在本组件内比较，
   *      不会再去和宿主面板的标题栏抢层级。
   */
  cardPinned: {
    position: 'sticky',
    top: 0,
    zIndex: 3,
    marginTop: 0,
    paddingTop: 12,
    background: c('--color-background-primary', '#fff'),
    isolation: 'isolate',
  },

  chipRow: { display: 'flex', flexWrap: 'wrap', gap: 8, margin: '0 0 12px', minWidth: 0 },
  chip: {
    display: 'inline-flex',
    alignItems: 'stretch',
    borderRadius: 9,
    border: `1px solid ${c('--color-border-secondary', 'rgba(0,0,0,0.22)')}`,
    overflow: 'hidden',
    maxWidth: '100%',
  },
  /** 当前生效的那一个：加粗边框 + 主题主色描边，一眼看出「现在跑的是它」。 */
  chipActive: {
    borderColor: c('--color-text-primary', '#111'),
    boxShadow: `inset 0 0 0 1px ${c('--color-text-primary', '#111')}`,
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
    borderLeft: `1px solid ${c('--color-border-tertiary', 'rgba(0,0,0,0.1)')}`,
    background: 'transparent',
    color: 'inherit',
    opacity: 0.7,
    cursor: 'pointer',
    flex: '0 0 auto',
  },
  presetRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 12, minWidth: 0 },

  statusRow: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  h2: { fontSize: 15, fontWeight: 500, margin: '0 0 4px' },
  lede: { fontSize: 12.5, opacity: 0.7, margin: '0 0 16px', lineHeight: 1.6 },

  card: {
    border: `1px solid ${c('--color-border-tertiary', 'rgba(0,0,0,0.12)')}`,
    borderRadius: 12,
    padding: '14px 16px',
    marginBottom: 14,
    background: c('--color-background-primary', 'transparent'),
  },
  /**
   * 置顶卡：参数预设那一块。
   *
   * 用 sticky 把自己钉在滚动容器顶部（与底部保存条同一套做法），滚到参数区时预设条依然在，
   * 「随时切换」才成立。背景取主题的 primary，取不到时回落到 transparent —— 与底部保存条一致。
   */
  cardPinned: {
    position: 'sticky',
    top: 0,
    zIndex: 2,
  },

  chipRow: { display: 'flex', flexWrap: 'wrap', gap: 8, margin: '0 0 12px' },
  chip: {
    display: 'inline-flex',
    alignItems: 'stretch',
    borderRadius: 9,
    border: `1px solid ${c('--color-border-secondary', 'rgba(0,0,0,0.22)')}`,
    overflow: 'hidden',
  },
  /** 当前生效的那一个：加粗边框 + 主题主色描边，一眼看出「现在跑的是它」。 */
  chipActive: {
    borderColor: c('--color-text-primary', '#111'),
    boxShadow: `inset 0 0 0 1px ${c('--color-text-primary', '#111')}`,
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
  },
  chipMeta: { fontSize: 10.5, opacity: 0.6 },
  chipIcon: {
    fontSize: 11.5,
    lineHeight: '26px',
    padding: '0 7px',
    border: 'none',
    borderLeft: `1px solid ${c('--color-border-tertiary', 'rgba(0,0,0,0.1)')}`,
    background: 'transparent',
    color: 'inherit',
    opacity: 0.7,
    cursor: 'pointer',
  },
  presetRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 12 },

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
  metaLabel: { opacity: 0.6 },
  mono: { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 11.5, wordBreak: 'break-all' },

  actions: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 },
  button: {
    fontSize: 12.5,
    lineHeight: '26px',
    padding: '0 12px',
    borderRadius: 8,
    border: `1px solid ${c('--color-border-secondary', 'rgba(0,0,0,0.22)')}`,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  buttonPrimary: {
    fontSize: 12.5,
    lineHeight: '26px',
    padding: '0 14px',
    borderRadius: 8,
    border: '1px solid transparent',
    background: c('--color-text-primary', '#111'),
    color: c('--color-background-primary', '#fff'),
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
   *   这是原先「输入框与『默认』按钮叠在一起」的直接原因：可用宽度不足以容纳
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
    borderTop: `1px solid ${c('--color-border-tertiary', 'rgba(0,0,0,0.08)')}`,
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
  desc: { fontSize: 11.5, opacity: 0.6, lineHeight: 1.5, marginTop: 4, gridColumn: '2 / 4', minWidth: 0, overflowWrap: 'anywhere' },
  input: {
    minWidth: 0,
    fontSize: 12.5,
    lineHeight: '24px',
    padding: '1px 8px',
    width: '100%',
    
    boxSizing: 'border-box',
    borderRadius: 7,
    border: `1px solid ${c('--color-border-secondary', 'rgba(0,0,0,0.22)')}`,
    background: c('--color-background-secondary', 'transparent'),
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
    border: `1px solid ${c('--color-border-secondary', 'rgba(0,0,0,0.22)')}`,
    background: c('--color-background-secondary', 'transparent'),
    color: 'inherit',
  },
  checkboxRow: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' },
  overridden: {
    fontSize: 10.5,
    opacity: 0.75,
    border: `1px solid ${c('--color-border-tertiary', 'rgba(0,0,0,0.15)')}`,
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
    border: `1px solid ${c('--color-border-secondary', 'rgba(0,0,0,0.22)')}`,
    background: c('--color-background-secondary', 'transparent'),
    color: 'inherit',
  },
  modelMeta: { fontSize: 11.5, opacity: 0.65, marginTop: 6, lineHeight: 1.5 },

  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
    position: 'sticky',
    bottom: 0,
    padding: '10px 0',
    background: c('--color-background-primary', 'transparent'),
  },
  dirty: { fontSize: 12, opacity: 0.75 },

  banner: { fontSize: 12, lineHeight: 1.55, borderRadius: 8, padding: '8px 10px', marginBottom: 12 },
  error: { border: `1px solid ${c('--color-border-danger', 'rgba(200,40,40,0.45)')}`, color: c('--color-text-danger', '#b02525') },
  notice: { border: `1px solid ${c('--color-border-success', 'rgba(30,140,80,0.45)')}`, color: c('--color-text-success', '#1c7a48') },
  /** 警告（橙）：与状态徽章里的 starting/stopping 同色，表示「能跑但要注意」。 */
  warn: { border: '1px solid rgba(154,98,9,0.45)', color: '#9a6209' },
  hint: { border: `1px solid ${c('--color-border-tertiary', 'rgba(0,0,0,0.12)')}`, opacity: 0.85 },
}

/** 状态 → 颜色（各自成对，浅深主题下都保持可读）。 */
export const STATE_COLORS = {
  ready: { fg: '#1c7a48', bg: 'rgba(28,122,72,0.12)', border: 'rgba(28,122,72,0.35)' },
  starting: { fg: '#9a6209', bg: 'rgba(154,98,9,0.12)', border: 'rgba(154,98,9,0.35)' },
  stopping: { fg: '#9a6209', bg: 'rgba(154,98,9,0.12)', border: 'rgba(154,98,9,0.35)' },
  failed: { fg: '#b02525', bg: 'rgba(176,37,37,0.12)', border: 'rgba(176,37,37,0.35)' },
  idle: { fg: '#5a5a56', bg: 'rgba(120,120,116,0.12)', border: 'rgba(120,120,116,0.35)' },
  disabled: { fg: '#5a5a56', bg: 'rgba(120,120,116,0.12)', border: 'rgba(120,120,116,0.35)' },
}
