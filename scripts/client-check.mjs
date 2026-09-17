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

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
