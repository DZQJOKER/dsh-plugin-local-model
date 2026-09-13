/**
 * 加载验证 —— 在「类宿主」环境里真正把插件跑起来。
 *
 *   node scripts/load-check.mjs
 *
 * 为什么需要它：dsh 插件有四个硬约定（具名导出 name/inject/Config/apply、不能有默认导出、
 * schema 要能产出默认值、apply 里注册的一切必须可逆）。这些在类型检查阶段全都看不出来，
 * 而写错的后果恰恰是「插件装上了但什么都不发生」—— 正是最难排查的一类故障。
 *
 * 做法：在临时目录里搭一个假 profile —— node_modules/@deepseek-ai/schemastery 指回用户机器上
 * 真实的 schemastery（不是我自己编的桩），再把编译产物拷进去加载。这样验证的是插件本身，
 * 而不是「我以为的宿主行为」。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')

let passed = 0
let failed = 0

async function step(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    setTimeout(() => socket.destroy(), 1500)
  })
}

function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
      })
      .on('error', reject)
  })
}

/** 在用户机器上找真实的 schemastery，作为 @deepseek-ai/schemastery 的解析替身。 */
function findRealSchemastery() {
  const candidates = []
  if (process.env.DSH_HOME) candidates.push(path.resolve(process.env.DSH_HOME))
  candidates.push(path.join(os.homedir(), '.dsh'))
  if (process.platform === 'win32' && process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'dsh-desktop', 'harness'))
  }

  for (const home of candidates) {
    const profiles = path.join(home, 'profiles')
    if (!fs.existsSync(profiles)) continue
    for (const entry of fs.readdirSync(profiles, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue
      const candidate = path.join(profiles, entry.name, 'node_modules', 'schemastery')
      if (fs.existsSync(path.join(candidate, 'lib', 'index.mjs'))) return candidate
    }
  }
  const local = path.join(projectRoot, 'node_modules', 'schemastery')
  if (fs.existsSync(path.join(local, 'lib', 'index.mjs'))) return local
  return null
}

console.log('\n加载验证：插件能否在类宿主环境中启动')

const realSchemastery = findRealSchemastery()
if (!realSchemastery) {
  console.log('  ! 本机找不到 schemastery，无法做加载验证（在装了 dsh 的机器上会自动启用）')
  process.exit(0)
}
console.log(`  使用 schemastery：${realSchemastery}`)

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-load-check-'))
const shimDir = path.join(sandbox, 'node_modules', '@deepseek-ai', 'schemastery')
const pluginDir = path.join(sandbox, 'plugin')
const fakeHome = path.join(sandbox, 'dsh-home')
const fakeHomePosix = fakeHome.split(path.sep).join('/')

fs.mkdirSync(shimDir, { recursive: true })
fs.writeFileSync(
  path.join(shimDir, 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/schemastery', version: '0.0.0-shim', type: 'module', main: 'index.mjs' }, null, 2),
)
fs.writeFileSync(
  path.join(shimDir, 'index.mjs'),
  `import * as mod from ${JSON.stringify(pathToFileURL(path.join(realSchemastery, 'lib', 'index.mjs')).href)}\n` +
    `export default mod.default ?? mod\n`,
)

// 把编译产物拷进沙箱，让模块解析走到沙箱里的替身。
fs.cpSync(path.join(projectRoot, 'lib'), path.join(pluginDir, 'lib'), { recursive: true })
fs.copyFileSync(path.join(projectRoot, 'package.json'), path.join(pluginDir, 'package.json'))

const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = fakeHomePosix

/** 最小的 cordis Context 替身：只实现插件实际会用到的部分。 */
function createFakeContext(logs, services = {}) {
  const disposers = []
  const record =
    (level) =>
    (...parts) => {
      logs.push(`${level}: ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`)
    }
  const ctx = {
    logger: { error: record('error'), warn: record('warn'), info: record('info'), debug: record('debug') },
    // 默认全部返回 undefined：验证「宿主服务缺失时插件照常工作」这条降级路径；
    // 传了 services 的服务（如 webServer）则由对应的替身接管。
    get: (name) => services[name],
    inject: () => () => undefined,
    on: () => () => undefined,
    effect: (cb) => {
      const disposer = cb()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    setTimeout: () => () => undefined,
    setInterval: () => () => undefined,
    plugin: () => ({ dispose: async () => undefined }),
  }
  return { ctx, disposers }
}

const logs = []
const routes = []
const webServerStub = {
  port: 0,
  register(route) {
    routes.push(route)
    return () => {
      const index = routes.indexOf(route)
      if (index >= 0) routes.splice(index, 1)
    }
  },
}
const { ctx, disposers } = createFakeContext(logs, { webServer: webServerStub })
const port = await freePort()
let mod = null

/**
 * 直接调用桥接 handler，不走真实 socket。
 * 这样能精确构造「非回环来源」「非 JSON 请求体」这类真实浏览器里不好复现的输入。
 */
function callBridge({ method = 'GET', path: url = '/api/local-model/state', body, contentType, remoteAddress = '127.0.0.1', rawBody } = {}) {
  const route = routes.find((r) => url === r.path || url.startsWith(`${r.path}/`))
  if (!route) throw new Error(`没有匹配 ${url} 的路由`)

  const payload = rawBody !== undefined ? rawBody : body === undefined ? '' : JSON.stringify(body)
  const req = {
    method,
    url,
    headers: contentType ? { 'content-type': contentType } : {},
    socket: { remoteAddress },
  }
  req[Symbol.asyncIterator] = async function* iterate() {
    if (payload) yield Buffer.from(payload)
  }

  return new Promise((resolve, reject) => {
    const res = {
      headersSent: false,
      statusCode: 0,
      body: '',
      writeHead(status) {
        this.statusCode = status
        this.headersSent = true
        return this
      },
      end(chunk) {
        if (chunk) this.body += chunk.toString()
        resolve(this)
      },
      once() {},
      removeListener() {},
    }
    try {
      route.handler(req, res)
    } catch (error) {
      reject(error)
    }
  })
}

await step('模块能被 import，且导出符号齐全', async () => {
  mod = await import(pathToFileURL(path.join(pluginDir, 'lib', 'index.js')).href)
  assert.equal(mod.name, 'local-model', 'name 必须是 local-model')
  assert.ok(Array.isArray(mod.inject), 'inject 必须是数组')
  assert.equal(typeof mod.Config, 'function', 'Config 必须是可调用的 schema')
  assert.equal(typeof mod.apply, 'function', 'apply 必须是函数')
})

await step('没有默认导出（有默认导出会被 dsh 折叠掉 inject 元数据）', async () => {
  assert.equal(mod.default, undefined, 'export default 必须不存在')
})

await step('Config schema 能产出默认值（设置页依赖这一点）', async () => {
  const config = mod.Config({})
  assert.equal(config.idleUnloadMinutes, 5, '默认空闲卸载必须是 5 分钟')
  assert.equal(config.port, 18080)
  assert.equal(config.jinja, true)
  assert.equal(config.enabled, true)
})

await step('apply() 在宿主服务全缺失时也能跑起来', async () => {
  mod.apply(ctx, { port, logLevel: 'debug' })
  assert.equal(disposers.length, 1, 'apply 应当通过 ctx.effect 注册且仅注册一个可逆副作用')
})

await step('初始化后：目录骨架与放置说明被创建', async () => {
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(path.join(fakeHome, 'local-model', 'models'))) break
    await sleep(100)
  }
  const base = path.join(fakeHome, 'local-model')
  assert.ok(fs.existsSync(path.join(base, 'models')), 'models 目录应被创建')
  assert.ok(fs.existsSync(path.join(base, 'runtime')), 'runtime 目录应被创建')
  assert.ok(fs.existsSync(path.join(base, 'state')), 'state 目录应被创建')
  assert.ok(fs.existsSync(path.join(base, 'models', 'PUT_GGUF_MODELS_HERE.txt')), '应写入模型放置说明')
  assert.ok(fs.existsSync(path.join(base, 'runtime', 'PUT_LLAMA_RUNTIME_HERE.txt')), '应写入运行时放置说明')
})

await step('常驻代理端口被监听，状态端点可访问', async () => {
  let status = null
  for (let i = 0; i < 60; i++) {
    try {
      const res = await get(`http://127.0.0.1:${port}/local-model/status`)
      if (res.status === 200) {
        status = JSON.parse(res.text)
        break
      }
    } catch {
      // 还没起来。
    }
    await sleep(100)
  }
  assert.ok(status, `状态端点应在 ${port} 上响应`)
  assert.equal(status.state, 'idle', '没有对话时应当处于待机状态')
  assert.equal(status.pid, null, '待机时不应有 llama-server 进程')
  assert.equal(status.idleUnloadMinutes, 5)
})

await step('模型未加载时 /v1/models 仍可列出模型（dsh 模型下拉框依赖它）', async () => {
  const res = await get(`http://127.0.0.1:${port}/v1/models`)
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.text).data[0].id, 'local')
})

await step('日志给出了用户能照着做的下一步', async () => {
  const text = logs.join('\n')
  assert.match(text, /模型目录/, '应打印模型目录位置')
  assert.match(text, /空闲卸载已启用：连续 5 分钟/, '应确认空闲卸载已生效')
  assert.match(text, /还没有 \.gguf|尚未选择|模型目录里还没有/, '应提示用户去放模型/选模型')
  assert.match(text, /未提供 tools 服务/, '宿主服务缺失时应显式降级并说明')
})

await step('设置页数据面：同源路由已挂载，state 能读出表单结构', async () => {
  const route = routes.find((r) => r.path === '/api/local-model')
  assert.ok(route, '应当注册 /api/local-model 前缀路由')
  assert.equal(route.kind, 'prefix', '必须用 prefix，否则子路径匹配不到')

  const res = await callBridge({ path: '/api/local-model/state' })
  assert.equal(res.statusCode, 200)
  const state = JSON.parse(res.body)
  assert.equal(state.ok, true)
  assert.ok(state.form.groups.length >= 5, `表单应当分成多组，实际 ${state.form.groups.length} 组`)
  const fieldCount = state.form.groups.reduce((n, g) => n + g.fields.length, 0)
  assert.ok(fieldCount >= 30, `表单字段应当来自 schema 序列化，实际只有 ${fieldCount} 个`)
  assert.equal(state.config.port, port)
  assert.ok(state.form.paths.modelsDir.includes('local-model'), '应当带上目录约定，便于用户放文件')
})

await step('设置页数据面：schema 里的说明文案被带到了字段上', async () => {
  const res = await callBridge({ path: '/api/local-model/state' })
  const state = JSON.parse(res.body)
  const all = state.form.groups.flatMap((g) => g.fields)
  const idle = all.find((f) => f.key === 'idleUnloadMinutes')
  assert.ok(idle, '必须包含空闲卸载字段')
  assert.equal(idle.kind, 'number', `期望 number，实际 ${idle.kind}`)
  assert.equal(idle.default, 5, `默认值必须来自 schema，实际 ${JSON.stringify(idle.default)}`)
  const dbg = JSON.stringify({
    schemaKeys: Object.keys(state.form.schema ?? {}),
    uid: state.form.schema?.uid,
    refCount: Object.keys(state.form.schema?.refs ?? {}).length,
  })
  assert.ok(
    typeof idle.description === 'string' && idle.description.includes('空闲卸载'),
    `说明文案必须来自 schema 的 description，实际是 ${JSON.stringify(idle.description)}；schema 形态 ${dbg}`,
  )
  const level = all.find((f) => f.key === 'logLevel')
  assert.equal(level.kind, 'select', `union 字段应当渲染成下拉框，实际 ${level.kind}`)
  assert.deepEqual(level.options, ['silent', 'error', 'warn', 'info', 'debug'])
})

await step('设置页数据面：保存配置会落盘并即时生效', async () => {
  const res = await callBridge({
    method: 'POST',
    path: '/api/local-model/config',
    contentType: 'application/json',
    body: { values: { ctxSize: 4096, idleUnloadMinutes: 9, logLevel: 'debug', bogus: 1, port: String(port) } },
  })
  assert.equal(res.statusCode, 200)
  const state = JSON.parse(res.body)
  assert.equal(state.config.ctxSize, 4096, '保存后运行时配置必须立即反映新值')
  assert.equal(state.config.idleUnloadMinutes, 9)
  assert.equal(state.config.logLevel, 'debug')
  assert.ok(state.overridden.includes('ctxSize'), '应当标记字段已被用户覆盖')

  const onDisk = JSON.parse(fs.readFileSync(path.join(fakeHome, 'local-model', 'state', 'config.json'), 'utf8'))
  assert.equal(onDisk.values.ctxSize, 4096, '用户层配置应当写入 config.json')
  assert.equal(onDisk.values.bogus, undefined, '白名单外的键必须被丢弃')
  assert.equal(onDisk.values.port, port, '数字字段应当被强制转换为数字')
})

await step('设置页数据面：恢复默认会清空用户层', async () => {
  const res = await callBridge({ method: 'POST', path: '/api/local-model/reset', contentType: 'application/json', body: {} })
  assert.equal(res.statusCode, 200)
  const state = JSON.parse(res.body)
  assert.equal(state.config.ctxSize, 8192, '应当回到 schema 默认值')
  assert.deepEqual(state.overridden, [])
})

await step('设置页数据面：操作端点能扫模型 / 报错可读', async () => {
  const scan = await callBridge({ method: 'POST', path: '/api/local-model/action', contentType: 'application/json', body: { action: 'scan' } })
  assert.equal(scan.statusCode, 200)
  assert.match(JSON.parse(scan.body).message, /重新扫描/)

  const bogus = await callBridge({ method: 'POST', path: '/api/local-model/action', contentType: 'application/json', body: { action: 'nuke' } })
  assert.equal(bogus.statusCode, 500)
  assert.match(JSON.parse(bogus.body).error, /未知操作/)
})

await step('设置页数据面：拒绝非本机来源（局域网拿不到配置与启停权限）', async () => {
  const res = await callBridge({ path: '/api/local-model/state', remoteAddress: '192.168.1.20' })
  assert.equal(res.statusCode, 403)
  assert.match(JSON.parse(res.body).error, /只接受来自本机/)
})

await step('设置页数据面：写操作要求 JSON content-type（挡住跨站表单提交）', async () => {
  const res = await callBridge({
    method: 'POST',
    path: '/api/local-model/config',
    contentType: 'text/plain',
    rawBody: JSON.stringify({ values: { ctxSize: 1 } }),
  })
  assert.equal(res.statusCode, 415)
})

await step('设置页数据面：只接受 GET/POST，非法 JSON 有明确报错', async () => {
  const del = await callBridge({ method: 'DELETE', path: '/api/local-model/config' })
  assert.equal(del.statusCode, 405)

  const broken = await callBridge({ method: 'POST', path: '/api/local-model/config', contentType: 'application/json', rawBody: '{oops' })
  assert.equal(broken.statusCode, 500)
  assert.match(JSON.parse(broken.body).error, /不是合法 JSON/)
})

await step('卸载时端口被释放（一切注册都是可逆的）', async () => {
  assert.equal(await isPortOpen(port), true, '卸载前端口应当是开的')
  for (const dispose of disposers) dispose()
  let closed = false
  for (let i = 0; i < 50; i++) {
    if (!(await isPortOpen(port))) {
      closed = true
      break
    }
    await sleep(100)
  }
  assert.equal(closed, true, '卸载后端口必须关闭，否则重载会端口冲突')
})

if (previousHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = previousHome
fs.rmSync(sandbox, { recursive: true, force: true })

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
