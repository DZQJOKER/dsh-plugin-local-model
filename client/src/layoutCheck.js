/**
 * 设置页布局的**几何 + 主题变量自检**（纯函数，不依赖浏览器）。
 *
 * 为什么需要它：重叠类问题是「在某些屏幕宽度下才出现」的，人肉点一遍只能覆盖自己那一块屏。
 * 而这类 bug 的根因高度集中，可以归成两类，所以这里不测像素，只对样式表里的
 * **结构性约束**做断言，把教训固化成规则：
 *
 *   A. **几何**：flex/grid 子项缺少 `minWidth: 0`，格子拒绝压缩 → 内容溢出、被挤到下一行、
 *      和相邻元素在视觉上压在一起。
 *   B. **主题变量**：引用了宿主体系里**不存在**的 CSS 变量，`var(--x, fallback)`
 *      静默落到 fallback。如果 fallback 恰好是 `transparent`，元素就是透明的 ——
 *      sticky 卡片盖不住下层内容，形成「透明重叠」。**这一类比 A 更隐蔽**：
 *      样式完全合法、构建无警告，只有在真实宿主里才现形。
 *
 * 数据来源是 `styles.js` 的源码文本 —— 刻意如此：如果改成从导出的 S 对象上读，
 * 就得在 node 里 import 一个 jsx 模块，反而绕远。文本断言足够表达这些约束。
 */

/** 设置面板可用宽度：宿主 .panel 800 − 左导航 188 − .options 左右内边距 48。 */
export const PANEL_CONTENT_WIDTH = 564

/** 宿主 `.options` 的左右内边距。sticky 条要盖满它才不会两侧漏光。 */
export const OPTIONS_PADDING = 24

/**
 * 宿主真实提供的 CSS 变量前缀白名单。
 *
 * 实测（`app.asar` 全量扫，见 README「布局约束」一节）：
 * 宿主 `@deepseek-ai/dsh-client-ui-theme` 只定义 `--dsw-*`，
 * `--color-*`（Claude/Cursor 风格那一套）**定义数为 0**。
 * 所以插件里任何 `var(--color-…)` 都会取 fallback。
 */
export const ALLOWED_VAR_PREFIXES = ['--dsw-', '--font-', '--dsh-']

/** 允许在 `var(...)` 里出现的字面量（函数、关键字），其余自定义名必须命中白名单。 */
const LITERAL_VAR = /^var\(--(?!(?:dsw|dsh|font)-)/

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

/** 去掉注释，避免把注释里的反面示例（如 `var(--color-x, …)`）当成真实代码。 */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/**
 * 取出某个块里的 `background:` 值（可能是 `var(--x, fallback)` 或字面量）。
 *
 * ★ 必须按**括号配对**截取，不能只取到行尾：样式对象里
 *   `background: c('--x', 'transparent'),` 之后的属性常常写在同一行，
 *   取整行会让 `transparent` 混在别的属性里被漏判 —— 假阴性比漏规则更危险。
 */
function backgroundOf(block) {
  const at = block.search(/\bbackground:\s*/)
  if (at < 0) return ''
  let i = block.indexOf(':', at) + 1
  let depth = 0
  let out = ''
  for (; i < block.length; i++) {
    const ch = block[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if ((ch === ',' || ch === '\n') && depth === 0) break
    out += ch
  }
  return out.trim()
}

/**
 * 判断一个 `background` 值是否真的**不透明**。
 *
 * ★ 这一条是「透明重叠」bug 的判据，必须严谨 —— 顺手写个 `=== 'transparent'`
 *   会漏掉源码里带引号的 `'transparent'`、以及 `var(--x, 'transparent')` 这种
 *   「变量取不到时就是透明」的写法，于是规则**永远不触发**（假阴性）。
 *   假阴性比没有规则更危险：它给了你「检查过了、没问题」的错觉。
 *
 * 判为透明的四类：
 *   1. 字面量 `transparent`（带不带引号都要认）
 *   2. `var(--x, transparent)` —— 落底值本身透明
 *   3. 显式带 alpha 的 hex（`#fff0` / `#ffffff00`）
 *   4. `rgba(r,g,b,α)` 且 α 不为 1（`rgb()` 无 alpha 参数，视为不透明）
 * `color-mix(…, transparent)` 与纯 `var(--dsw-…)`（宿主色板不含 alpha）算不透明。
 *
 * ★ 源码里写的是 helper 调用 `c('--x', 'transparent')`，不是展开后的 `var(...)`，
 *   所以这里要先解开 `c(...)` 再判。**样式表源码与运行期值不是一回事** ——
 *   断言器读的是源码，就必须按源码的写法解析。
 */
export function isOpaqueBackground(rawValue) {
  const value = String(rawValue ?? '').trim()
  if (!value) return false

  // 解开 `c('--x', fallback)` 这层 helper，取出真正传给 var() 的两个参数。
  if (/^c\(/.test(value) && value.endsWith(')')) {
    const inner = value.slice(2, -1)
    const comma = splitTopLevel(inner)
    if (comma.length === 2) return isOpaqueBackground(comma[1])
  }

  // 统一去掉包裹在字符串值外面的引号，避免 `'transparent'` 这种写法被漏掉。
  const unquoted = value.replace(/^['"]|['"]$/g, '').trim()
  if (/^transparent$/i.test(unquoted)) return false

  // 看 var() 的落底值（第二个参数）：落底为 transparent 时，变量缺失即透明。
  const varMatch = value.match(/^var\(\s*[^,)]+\s*,\s*([\s\S]+)\)\s*$/)
  if (varMatch) return isOpaqueBackground(varMatch[1])

  if (/#[0-9a-f]{4}\b/i.test(value) || /#[0-9a-f]{8}\b/i.test(value)) return false
  if (/rgba\([^)]*,\s*(0|0?\.\d+)\s*\)/i.test(value)) return false
  return true
}

/**
 * 按顶层逗号切分（忽略括号内的逗号）。
 * `c('--x', 'rgba(0,0,0,0.5)')` 这种值里带逗号，直接 `split(',')` 会切碎。
 */
export function splitTopLevel(input) {
  const out = []
  let depth = 0
  let buf = ''
  let quote = ''
  for (const ch of input) {
    if (quote) {
      buf += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      buf += ch
      continue
    }
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  out.push(buf.trim())
  return out
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
    name: '置顶条背景不透明（挡住下层卡片穿透）',
    test: (source) => isOpaqueBackground(backgroundOf(blockOf(source, 'cardPinned') ?? '')),
    detail: 'sticky 卡片上方/两侧会露出可滚动的缝，透明背景下层内容直接透上来 —— 这就是「透明重叠」',
  },
  {
    name: '保存条背景不透明（挡住下方输入框穿透）',
    test: (source) => isOpaqueBackground(backgroundOf(blockOf(source, 'footer') ?? '')),
    detail: '底部 sticky 保存条透明时，「当前模型」等输入框会透过按钮显示出来',
  },
  {
    name: '卡片背景不透明（滚动时内容不互相叠字）',
    test: (source) => isOpaqueBackground(backgroundOf(blockOf(source, 'card') ?? '')),
    detail: '卡片透明时，两张卡片交错滚动会形成「字压字」的观感',
  },
  {
    name: '置顶条与保存条横向盖满 .options 的内边距（不留侧缝）',
    test: (source) => {
      const ok = (name) => {
        const block = blockOf(source, name) ?? ''
        return (
          new RegExp(`marginLeft:\\s*-${OPTIONS_PADDING}\\b`).test(block) &&
          new RegExp(`marginRight:\\s*-${OPTIONS_PADDING}\\b`).test(block) &&
          new RegExp(`paddingLeft:\\s*${OPTIONS_PADDING}\\b`).test(block) &&
          new RegExp(`paddingRight:\\s*${OPTIONS_PADDING}\\b`).test(block)
        )
      }
      return ok('cardPinned') && ok('footer')
    },
    detail: `.options 左右各有 ${OPTIONS_PADDING}px 内边距，sticky 元素默认只盖内容区，两侧缝里滚过的内容会露出来`,
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
 * 扫描整个样式表，找出所有引用了**宿主不提供**的自定义 CSS 变量。
 *
 * 这是「透明重叠」那类 bug 的通用探测器：变量不存在时 `var()` 会静默退回 fallback，
 * 而 fallback 是人手写的、很容易写成 transparent。返回去重后的变量名数组。
 *
 * ★ 必须同时认两种写法 —— 源码里写的是 helper 调用 `c('--x', fallback)`，
 *   而**不是**展开后的 `var(--x, fallback)`。只匹配 `var(` 的话，
 *   这个检查会永远返回空数组（同样的假阴性陷阱，见 isOpaqueBackground 的注释）。
 *   白名单前缀在这里其实已经足够保守：`--dsw-` / `--font-` / `--dsh-` 之外的
 *   自定义变量一律视为不存在，宁可误报也不要漏报。
 */
export function findUnknownVars(source) {
  const code = stripComments(source)
  const found = new Set()
  const re = /(?:var\(\s*|c\(\s*['"])(--[\w-]+)/g
  let m
  while ((m = re.exec(code))) {
    const name = m[1]
    if (!ALLOWED_VAR_PREFIXES.some((p) => name.startsWith(p))) found.add(name)
  }
  return [...found]
}

/**
 * 会挡住下层内容的容器 → 它们的背景是否不透明。
 *
 * 抽成函数是为了让调用方（自检脚本）能逐条给出「为什么这个必须不透明」，
 * 而不是只拿到一句「有 3 个规则失败」。
 */
export const OPAQUE_SURFACES = ['card', 'cardPinned', 'footer']

export function checkOpaqueSurfaces(source) {
  const out = {}
  for (const name of OPAQUE_SURFACES) {
    out[name] = isOpaqueBackground(backgroundOf(blockOf(source, name) ?? ''))
  }
  return out
}

/** 返回失败的规则说明；全通过则返回空数组。 */
export function checkLayout(source) {
  const failures = RULES.filter((rule) => !rule.test(source)).map((rule) => `${rule.name} —— ${rule.detail}`)

  const unknown = findUnknownVars(source)
  if (unknown.length) {
    failures.push(
      `只使用宿主真实提供的 CSS 变量 —— 发现宿主未定义的变量：${unknown.join('、')}；` +
        `宿主只提供 ${ALLOWED_VAR_PREFIXES.join(' / ')}，其余变量会静默取 fallback（fallback 写成 transparent 时元素就是透明的）`,
    )
  }

  return failures
}

/** 所有需要纳保的屏幕 / 窗口宽度。 */
export const SAMPLE_VIEWPORTS = [3840, 2560, 1920, 1600, 1440, 1366, 1280, 1180, 1024, 900, 848, 800, 768, 700, 640, 560, 480, 428]
