/**
 * 设置页布局的**几何自检**（纯函数，不依赖浏览器）。
 *
 * 为什么需要它：重叠类问题是「在某些屏幕宽度下才出现」的，人肉点一遍只能覆盖自己那一块屏。
 * 而这类 bug 的根因高度集中 —— **flex/grid 子项缺少 `minWidth: 0`，格子拒绝压缩**，
 * 于是内容溢出、被挤到下一行、和相邻元素在视觉上压在一起。所以这里不测像素，
 * 只对「样式表里那些能让格子压缩的属性有没有写全」做断言，把教训固化成规则。
 *
 * 数据来源是 `styles.js` 的源码文本 —— 刻意如此：如果改成从导出的 S 对象上读，
 * 就得在 node 里 import 一个 jsx 模块，反而绕远。文本断言足够表达这些约束。
 */

/** 设置面板可用宽度：宿主 .panel 800 − 左导航 188 − .options 左右内边距 48。 */
export const PANEL_CONTENT_WIDTH = 564

/** 常见屏幕 / 窗口宽度 → 设置面板内容区宽度（面板 max-width: calc(100vw - 48px)、上限 800）。 */
export function panelContentWidthFor(viewportWidth) {
  const panel = Math.min(800, viewportWidth - 48)
  return Math.max(0, panel - 188 - 48)
}

/**
 * 一行设置项所需的最小宽度。
 *
 * grid 的自动最小尺寸默认是 `auto`（不小于内容最小宽度）。按格子声明算：
 *   - `minmax(A, B)` → 下限 A
 *   - `minmax(0, …)` / `1fr` → 0（前提是控件自身 minWidth: 0，见 checkLayout）
 *   - `auto` → 按钮的固有宽度（「默认」两字 + 内边距，实测约 44px）
 * 三列之和再加两道列间距，就是低于它必然换行的门槛。
 */
export function requiredFieldWidth(template, columnGap = 10, trailingAuto = 44) {
  const columns = template.trim().split(/\s+(?![^(]*\))/)
  let total = 0
  for (const column of columns) {
    const minmax = column.match(/^minmax\(([^,]+),/)
    if (minmax) {
      total += Number(minmax[1].trim()) || 0
      continue
    }
    if (column === 'auto' || column === 'min-content' || column === 'max-content') {
      total += trailingAuto
      continue
    }
    // 1fr / 0 / minmax 已处理 —— 都算 0
  }
  return total + columnGap * Math.max(0, columns.length - 1)
}

const RULES = [
  {
    name: '内容区不写死超出面板可用宽度的 maxWidth',
    test: (source) => {
      const block = blockOf(source, 'wrap')
      return Boolean(block && /maxWidth:\s*'100%'/.test(block))
    },
    detail: `可用宽度只有 ${PANEL_CONTENT_WIDTH}px（面板 800 − 导航 188 − 内边距 48），写死更大的值会让卡片横向溢出`,
  },
  {
    name: '字段行三列都可压缩（minmax 下限为 0，不用裸 1fr）',
    test: (source) => /gridTemplateColumns:\s*'minmax\(0, 168px\) minmax\(0, 1fr\) auto'/.test(blockOf(source, 'field') ?? ''),
    detail: 'grid 的自动最小尺寸默认 auto，1fr 会拒绝压到内容最小宽度以下 → 第二列被挤到下一行、和「默认」按钮重叠',
  },
  {
    name: '控件自身可压缩（input / select / textarea 都有 minWidth: 0）',
    test: (source) =>
      ['input', 'select', 'textarea'].every((name) => {
        const block = blockOf(source, name)
        return Boolean(block && /minWidth:\s*0/.test(block))
      }),
    detail: '格子能压缩的前提是子项也能压缩，否则输入框的 input 默认最小宽度仍会顶出去',
  },
  {
    name: '元信息网格不设硬下限（minmax(0, 220px) 而非 minmax(220px, 1fr)）',
    test: (source) => /minmax\(0, 220px\)/.test(blockOf(source, 'metaGrid') ?? ''),
    detail: '220px 的硬下限在窄面板下会整块溢出，长路径与右侧内容叠在一起',
  },
  {
    name: '置顶条用实色背景遮住穿透（sticky 上方的可滚动缝）',
    test: (source) => {
      const block = blockOf(source, 'cardPinned') ?? ''
      if (!block) return false
      const background = block.match(/background:\s*([^,\n]+)/)?.[1] ?? ''
      // 允许 var(--x, fallback) 这种带落底值的写法，但不允许落底值本身就是透明的。
      return background !== '' && !/transparent/i.test(background)
    },
    detail: '.options 的上内边距为 0，sticky 卡片上方会留一条能滚动的缝，透明背景下层内容会从缝里穿出来',
  },
  {
    name: '置顶条自建层叠上下文（不与宿主面板标题栏抢层级）',
    test: (source) => /isolation:\s*'isolate'/.test(blockOf(source, 'cardPinned') ?? ''),
    detail: '否则大 z-index 会盖住面板的「设置」标题与关闭按钮',
  },
  {
    name: '超长预设名被截断（chipLabel 有 maxWidth）',
    test: (source) => /maxWidth:\s*\d+/.test(blockOf(source, 'chipLabel') ?? ''),
    detail: '预设名上限 40 字，不封顶时单个 chip 会把「✎ / ×」挤出卡片、和相邻 chip 重叠',
  },
]

/**
 * 取出 `name: { … },` 这一段。
 *
 * 必须按**括号配对**取，不能靠正则「到下一个 `},` 为止」—— 值里出现别的对象
 * （例如 `var(--color-background-primary, '#fff')` 之后的嵌套、或更长的说明注释）
 * 会让正则提前收尾，于是断言在一个正确的样式表上误报。
 */
function blockOf(source, name) {
  const start = source.indexOf(`\n  ${name}: {`)
  if (start < 0) return null
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return null
}

/** 返回失败的规则说明；全通过则返回空数组。 */
export function checkLayout(source) {
  return RULES.filter((rule) => !rule.test(source)).map((rule) => `${rule.name} —— ${rule.detail}`)
}

/** 所有需要纳保的屏幕 / 窗口宽度。 */
export const SAMPLE_VIEWPORTS = [3840, 2560, 1920, 1600, 1440, 1366, 1280, 1180, 1024, 900, 848, 800, 768, 700, 640, 560, 480, 428]
