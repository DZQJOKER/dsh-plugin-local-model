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
import { fileURLToPath } from 'node:url'

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

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
