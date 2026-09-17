/**
 * 浏览器侧 bundle 的加载验证。
 *
 *   node scripts/client-check.mjs
 *
 * 为什么必须有这一步：dsh 客户端模块系统要求产物是特定的 lazy-CJS factory 形状
 * （`window.__ModuleLoader__.load({ id, factory })`，外部依赖走 factory 注入的 require）。
 * 形状不对的话，浏览器里只表现为「设置里没有这一项」，不会有任何报错 ——
 * 这正是最难排查的一类故障。这里用假的 loader 与假的 react 真正跑一遍：
 * 校验工厂签名、导出符号、插槽注册规格，以及外部依赖有没有被误打进包里。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')

let passed = 0
let failed = 0

function step(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`)
  }
}

console.log('\n客户端 bundle 加载验证')

const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
const clientFile = path.join(projectRoot, 'client', 'client.js')

if (!fs.existsSync(clientFile)) {
  console.log('  ✗ 找不到 client/client.js —— 先运行 npm run build:client')
  process.exit(1)
}
const source = fs.readFileSync(clientFile, 'utf8')

// ── 假宿主：window.__ModuleLoader__ + 假的 react ────────────────────────────
const loaded = []
const requireLog = []

const reactStub = {
  useCallback: (fn) => fn,
  useEffect: () => undefined,
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [initial, () => undefined],
}
const jsxStub = {
  jsx: () => null,
  jsxs: () => null,
  Fragment: Symbol('Fragment'),
  jsxDEV: () => null,
}
const cordisStub = {}

const moduleStubs = {
  react: reactStub,
  'react/jsx-runtime': jsxStub,
  'react/jsx-dev-runtime': jsxStub,
  'react-dom': {},
  'react-dom/client': {},
  '@deepseek-ai/cordis': cordisStub,
  '@deepseek-ai/cordis/client': cordisStub,
}

const sandbox = {
  window: {
    __ModuleLoader__: {
      load(entry) {
        loaded.push(entry)
      },
    },
  },
  console,
  Symbol,
  Object,
  JSON,
  Array,
  Promise,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  fetch: () => Promise.reject(new Error('no network in check')),
  Date,
  Math,
  String,
  Number,
  Boolean,
  Error,
  RegExp,
  Map,
  Set,
}
sandbox.globalThis = sandbox

vm.createContext(sandbox)

step('产物能被 dsh 的模块加载器接收', () => {
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.equal(loaded.length, 1, 'window.__ModuleLoader__.load 应当被调用恰好一次')
})

const entry = loaded[0]

step('工厂 id 等于包名', () => {
  assert.ok(entry, '没有捕获到 load 调用')
  assert.equal(entry.id, pkg.name, `id 必须是 ${pkg.name}，实际是 ${entry.id}`)
  assert.equal(typeof entry.factory, 'function', 'factory 必须是函数')
})

let exports_ = null

step('factory 可调用，且外部依赖都走注入的 require', () => {
  const requireFn = (id) => {
    requireLog.push(id)
    if (!(id in moduleStubs)) throw new Error(`未声明为 external，却要求宿主提供：${id}`)
    return moduleStubs[id]
  }
  exports_ = entry.factory(requireFn)
  assert.ok(exports_ && typeof exports_ === 'object', 'factory 必须返回 exports 对象')
})

step('导出符号齐全（apply / inject），且没有 default 导出', () => {
  assert.equal(typeof exports_.apply, 'function', 'apply 必须是函数')
  assert.ok(Array.isArray(exports_.inject), 'inject 必须是数组')
  assert.equal(exports_.default, undefined, '不能有 default 导出')
  assert.ok(exports_.inject.includes('slots'), 'inject 必须声明 slots')
  assert.ok(exports_.inject.includes('locale'), 'inject 必须声明 locale')
})

step('只依赖宿主提供的模块（react / cordis），没有把 dsh 内部实现打进来', () => {
  const allowed = new Set(Object.keys(moduleStubs))
  const unexpected = [...new Set(requireLog)].filter((id) => !allowed.has(id) && !id.startsWith('react'))
  assert.deepEqual(unexpected, [], `出现了意料之外的外部依赖：${unexpected.join(', ')}`)
})

// ── 用假的客户端 ctx 跑一遍 apply ──────────────────────────────────────────
const registered = []
const localeRegistrations = []
const disposers = []

const fakeCtx = {
  effect: (fn) => {
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
    return d
  },
  on: () => () => undefined,
  get: () => undefined,
  locale: {
    register: (ns, dicts) => {
      localeRegistrations.push({ ns, dicts })
      return () => undefined
    },
    bind: (ns) => (key) => {
      const dict = localeRegistrations.find((r) => r.ns === ns)?.dicts
      return dict?.zh?.[key] ?? key
    },
  },
  slots: {
    inject: (slotName, callback) => {
      const d = callback()
      if (typeof d === 'function') disposers.push(d)
      return d
    },
    register: (spec, component) => {
      registered.push({ spec, component })
      return () => undefined
    },
  },
}

step('apply 能跑通，并注册了「本地模型」设置分区', () => {
  exports_.apply(fakeCtx)
  assert.equal(registered.length, 1, '应当注册恰好一个设置分区')
  const { spec, component } = registered[0]
  assert.equal(spec.name, 'settings.section', '必须注册进 settings.section 插槽')
  assert.equal(spec.id, 'local-model', '分区 id 必须是 local-model')
  assert.equal(typeof spec.order, 'number', 'order 必须是数字，决定侧栏顺序')
  assert.equal(typeof component, 'function', '分区内容必须是可渲染的组件')
})

step('分区标题取词可用（侧栏会显示「本地模型」）', () => {
  assert.deepEqual(
    localeRegistrations.map((r) => r.ns),
    ['local-model'],
  )
  const label = registered[0].spec.label()
  assert.equal(label, '本地模型', `侧栏标题应为「本地模型」，实际是「${label}」`)
})

step('注册的一切都可逆（分区与词条都能被卸载掉）', () => {
  assert.equal(disposers.length, 2, `应当有 2 个 disposer（locale + section），实际 ${disposers.length}`)
  for (const dispose of disposers) assert.equal(typeof dispose, 'function')
})

/*
 * 客户端与宿主的「接口契约」检查。
 *
 * 这一对最容易悄悄错位：客户端 fetch 的路径、宿主 switch 里的 case，两边各自改各自的，
 * 谁都不会报错 —— 表现只是「点了没反应」。所以直接从两边各取一份事实来对，而不是靠人记。
 */
step('参数预设：客户端调用的路由，宿主侧全都存在', () => {
  const called = [...new Set([...source.matchAll(/["'`]\/presets\/([a-z]+)["'`]/g)].map((m) => m[1]))].sort()
  assert.deepEqual(
    called,
    ['apply', 'delete', 'overwrite', 'rename', 'save'],
    `客户端用到的预设接口是 ${called.join(' / ')}，与预期不符`,
  )

  const hostSource = fs.readFileSync(path.join(projectRoot, 'src', 'webBridge.ts'), 'utf8')
  for (const route of called) {
    assert.ok(
      hostSource.includes(`case '/presets/${route}':`),
      `客户端在调 /presets/${route}，但 webBridge.ts 里没有这条路由 —— 点了就会 404`,
    )
  }
})

step('参数预设：设置页顶部那一块确实被打进了产物', () => {
  assert.ok(source.includes('保存为预设'), '产物里找不到「保存为预设」，预设条可能没被渲染进页面')
  assert.ok(source.includes('presets'), '产物里没有引用宿主返回的 presets 字段')

  // 「固定在顶部」是需求里的硬约束，所以直接钉住渲染顺序，而不是靠人肉记得别把它挪下去。
  const sectionSource = fs.readFileSync(path.join(projectRoot, 'client', 'src', 'section.jsx'), 'utf8')
  const barAt = sectionSource.indexOf('<PresetBar')
  const statusAt = sectionSource.indexOf('S.statusRow')
  assert.ok(barAt > -1, 'section.jsx 里没有渲染 <PresetBar>')
  assert.ok(statusAt > -1, '找不到运行状态卡的位置锚点（S.statusRow）')
  assert.ok(barAt < statusAt, '预设条必须排在运行状态卡之前 —— 它要固定在设置页顶部')
})

/*
 * 快照逻辑是纯函数（client/src/presetSnapshot.js），所以能在这里直接测 ——
 * 「存错一套参数」是这块功能最贵的失败方式，不该只靠浏览器里点一遍来发现。
 */
const snapshotModule = await import(pathToFileURL(path.join(projectRoot, 'client', 'src', 'presetSnapshot.js')).href)

step('参数预设快照：字段类型表来自宿主，界面不自己猜', () => {
  const kinds = snapshotModule.fieldKindMap([
    { id: 'a', fields: [{ key: 'ctxSize', kind: 'number' }, { key: 'mtp', kind: 'boolean' }] },
    { id: 'b', fields: [{ key: 'selectedModel', kind: 'string' }] },
  ])
  assert.deepEqual(kinds, { ctxSize: 'number', mtp: 'boolean', selectedModel: 'string' })
  assert.deepEqual(snapshotModule.fieldKindMap(undefined), {}, '拿不到表单描述也不能炸')
})

step('参数预设快照：草稿优先 / 空数字回落 / 字符串空值保留', () => {
  const keys = ['ctxSize', 'temp', 'selectedModel', 'mtp']
  const kinds = { ctxSize: 'number', temp: 'number', selectedModel: 'string', mtp: 'boolean' }
  const config = { ctxSize: 8192, temp: 0.75, selectedModel: 'a.gguf', mtp: false }
  const snap = (draft, cfg = config) => snapshotModule.buildPresetSnapshot({ keys, kinds, draft, config: cfg })

  assert.deepEqual(snap({}), config, '没有草稿时，快照就是当前生效配置')

  const edited = snap({ ctxSize: '16384', temp: '0.5' })
  assert.equal(edited.ctxSize, '16384', '草稿优先级高于已保存配置（宿主负责类型强制转换）')
  assert.equal(edited.temp, '0.5')
  assert.equal(edited.selectedModel, 'a.gguf', '没改过的字段照抄当前值')

  assert.equal(snap({ ctxSize: '' }).ctxSize, 8192, '数字框被清空 = 未设置，回落到已保存值（空串会被宿主丢掉）')
  assert.equal(snap({ temp: '   ' }).temp, 0.75, '只有空白也算没填')
  assert.equal(snap({ selectedModel: '' }).selectedModel, '', '字符串的空串是合法取值，不能被回落掉')
  assert.equal(snap({ mtp: false }, { ...config, mtp: true }).mtp, false, '布尔 false 是明确的取值，不是「空」')
  assert.deepEqual(
    Object.keys(snap({ port: 1234 })).sort(),
    [...keys].sort(),
    '只取宿主认定的预设字段，界面不自己扩大作用域',
  )
})

/*
 * 布局几何 + 主题变量：设置页「元素重叠」有两类根因，都只在真实宿主里才现形 ——
 *   A. flex/grid 子项缺少 minWidth: 0，格子拒绝压缩（某些屏幕宽度下才出现）
 *   B. 引用了宿主**不存在**的 CSS 变量，`var()` 静默落到 fallback；
 *      fallback 若写 transparent，元素就是透明的 —— 这就是「透明重叠」
 * 这里既断言样式规则写全了，也把「常见分辨率下字段行放得下」算一遍。
 * ★ 还必须反向验证一次：拿旧版（有 bug 的）样式表跑，探测必须报错。
 *   否则规则可能永远不触发，给人「检查过了」的错觉。
 */
const layout = await import(pathToFileURL(path.join(projectRoot, 'client', 'src', 'layoutCheck.js')).href)
const stylesSource = fs.readFileSync(path.join(projectRoot, 'client', 'src', 'styles.js'), 'utf8')

step('布局：设置页的防重叠规则全部在样式表里', () => {
  const problems = layout.checkLayout(stylesSource)
  assert.deepEqual(problems, [], `样式表缺少防重叠约束：\n      ${problems.join('\n      ')}`)
})

step('主题：只用宿主真实提供的 CSS 变量（--dsw-* / --font-*）', () => {
  // 宿主 @deepseek-ai/dsh-client-ui-theme 只定义 --dsw-*；--color-* 那一套在 DSH 里不存在，
  // 写了就会静默取 fallback。这条规则专门拦这个。
  const unknown = layout.findUnknownVars(stylesSource)
  assert.deepEqual(
    unknown,
    [],
    `样式表引用了宿主未定义的变量：${unknown.join('、')}；` +
      `宿主只提供 ${layout.ALLOWED_VAR_PREFIXES.join(' / ')}，其余会落到 fallback`,
  )
  assert.ok(
    !/--color-[a-z-]+/.test(layout.stripComments(stylesSource)),
    '样式表里不该出现 --color-* （宿主的变量名前缀是 --dsw-*）',
  )
})

step('主题：会挡住下层内容的容器一律不透明（这就是「透明重叠」的成因）', () => {
  // 逐条给出人话原因，方便出错时直接定位是哪个元素。
  const reasons = {
    cardPinned: '置顶的预设条透明时，下层「运行状态」卡片的文字会直接透上来',
    footer: '底部保存条透明时，「当前模型」输入框会透过按钮显示出来',
    card: '卡片透明时，交错滚动会形成「字压字」',
  }
  const opaque = layout.checkOpaqueSurfaces(stylesSource)
  for (const [name, ok] of Object.entries(opaque)) {
    assert.ok(ok, `${name} 的背景必须不透明 —— ${reasons[name]}`)
  }
})

step('布局：探测规则本身有效（拿有 bug 的旧样式表必须能报出问题）', () => {
  /*
   * 反向验证。这里的「旧样式表」是刻意构造的坏样本，覆盖两类根因：
   *   1. `card` / `footer` 用 `'transparent'` 兜底
   *   2. sticky 条没盖满 `.options` 的 24px 内边距
   * 只要这两处还能被报出来，就说明规则不是摆设。
   */
  const brokenSample = `
export const S = {
  wrap: { maxWidth: '100%' },
  card: {
    border: \`1px solid \${c('--color-border-tertiary', 'rgba(0,0,0,0.12)')}\`,
    background: c('--color-background-primary', 'transparent'),
  },
  cardPinned: {
    position: 'sticky',
    top: 0,
    background: c('--color-background-primary', '#fff'),
    isolation: 'isolate',
  },
  footer: {
    position: 'sticky',
    bottom: 0,
    background: c('--color-background-primary', 'transparent'),
  },
  field: { gridTemplateColumns: 'minmax(0, 168px) minmax(0, 1fr) auto' },
  input: { minWidth: 0 },
  select: { minWidth: 0 },
  textarea: { minWidth: 0 },
  metaGrid: { gridTemplateColumns: 'repeat(auto-fit, minmax(0, 220px))' },
  chipLabel: { maxWidth: 240 },
}
`
  const problems = layout.checkLayout(brokenSample)
  assert.ok(problems.length > 0, '坏样本竟然全部通过 —— 说明探测规则已经失效，必须修规则本身')
  const joined = problems.join('\n')
  assert.ok(joined.includes('保存条背景不透明'), '没报出「保存条透明」—— 这是透明重叠的主要症状')
  assert.ok(joined.includes('卡片背景不透明'), '没报出「卡片透明」')
  assert.ok(joined.includes('横向盖满'), '没报出「sticky 条两侧漏缝」')
  assert.ok(joined.includes('--color-'), '没报出「引用了宿主不存在的变量」')

  // 但白色兜底的 sticky 条不算「透明」—— 它的真实问题是「和面板同色」，
  // 由覆盖宽度那条规则负责。这里确认判定函数没把 '#fff' 误判成透明。
  assert.equal(layout.isOpaqueBackground("c('--x', '#fff')"), true, "'#fff' 应判为不透明")
  assert.equal(layout.isOpaqueBackground("c('--x', 'transparent')"), false, "'transparent' 应判为透明")
})

step('布局：常见屏幕与分辨率下，设置项一行排得下（不会换行重叠）', () => {
  const template = stylesSource.match(/field:\s*\{[^}]*gridTemplateColumns:\s*'([^']+)'/)?.[1]
  assert.ok(template, '找不到 field 的列定义')
  const gap = Number(stylesSource.match(/field:\s*\{[^}]*gap:\s*'6px (\d+)px'/)?.[1] ?? 10)
  const required = layout.requiredFieldWidth(template, gap)

  const tooNarrow = layout.SAMPLE_VIEWPORTS.filter(
    (viewport) => layout.panelContentWidthFor(viewport) < required,
  )
  assert.deepEqual(
    tooNarrow,
    [],
    `这些宽度下设置面板装不下 ${required}px 的字段行：${tooNarrow.join(' / ')}`,
  )
  // 把「刚好最窄的那一档」也算出来，改动模板时能立刻看到余量还剩多少。
  const narrowest = Math.min(...layout.SAMPLE_VIEWPORTS.map((v) => layout.panelContentWidthFor(v)))
  assert.ok(narrowest > required, `最窄内容区 ${narrowest}px 必须大于字段行需求 ${required}px`)
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
