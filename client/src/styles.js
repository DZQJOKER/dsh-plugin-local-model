/**
 * 全部用内联样式，不引入 CSS modules。
 *
 * 这样客户端 bundle 只有一个入口文件、构建里没有 CSS 产物，
 * 也就少了一处「打包对了但资源没被加载」的失败面。
 * 颜色走宿主主题变量，取值失败时回落到中性色。
 */

const c = (name, fallback) => `var(${name}, ${fallback})`

export const S = {
  wrap: { padding: '4px 2px 32px', maxWidth: 720 },
  h2: { fontSize: 15, fontWeight: 500, margin: '0 0 4px' },
  lede: { fontSize: 12.5, opacity: 0.7, margin: '0 0 16px', lineHeight: 1.6 },

  card: {
    border: `1px solid ${c('--color-border-tertiary', 'rgba(0,0,0,0.12)')}`,
    borderRadius: 12,
    padding: '14px 16px',
    marginBottom: 14,
    background: c('--color-background-primary', 'transparent'),
  },

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
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: '6px 18px',
    marginTop: 12,
    fontSize: 12,
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

  field: {
    display: 'grid',
    gridTemplateColumns: 'minmax(140px, 190px) 1fr auto',
    gap: '6px 12px',
    alignItems: 'start',
    padding: '7px 0',
    borderTop: `1px solid ${c('--color-border-tertiary', 'rgba(0,0,0,0.08)')}`,
  },
  label: { fontSize: 12.5, paddingTop: 5, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  desc: { fontSize: 11.5, opacity: 0.6, lineHeight: 1.5, marginTop: 4, gridColumn: '2 / 4' },
  input: {
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
    boxSizing: 'border-box',
    borderRadius: 7,
    minHeight: 48,
    resize: 'vertical',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    border: `1px solid ${c('--color-border-secondary', 'rgba(0,0,0,0.22)')}`,
    background: c('--color-background-secondary', 'transparent'),
    color: 'inherit',
  },
  checkboxRow: { display: 'flex', alignItems: 'center', gap: 8 },
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
