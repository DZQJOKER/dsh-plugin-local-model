/**
 * 端到端测试：用真实子进程验证插件的两条核心链路。
 *
 *   node scripts/e2e.mjs
 *
 * 覆盖：
 *   1. 没有对话时绝不占资源 —— 初始化后只有常驻代理，没有 llama-server 进程；
 *   2. 首条对话自动拉起 —— 第一个请求进来才 spawn，并等它 /health 就绪后原样转发（含 SSE 流式）；
 *   3. 并发单飞 —— 闲置状态下 4 个并发请求只拉起 1 个进程；
 *   4. 空闲自动卸载 —— 静默一段时间后模型被卸载、进程被回收、端口被释放；
 *   5. 未选模型时的报错必须可操作（告诉用户去哪儿选）。
 *
 * 它把 llama-server 换成了 scripts/fixtures/fake-llama-server.mjs（用真实 spawn / 健康探测 /
 * kill 流程），因此验证的是本插件自己的进程与生命周期管理，而不是 llama.cpp 的推理。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { LocalModelRuntime, shouldUnload } from '../lib/lifecycle.js'
import { LocalModelProxy } from '../lib/proxy.js'
import { resolveConfig } from '../lib/configResolve.js'
// 路由名/模型别名/id 过去是设置项，已从 schema 删除、改为常量 —— 测试也跟着取常量，
// 免得再写成 config.xxx 拿到 undefined 却只表现为「某个断言莫名失败」。
import { DEFAULT_MODEL_ALIAS, LOCAL_MODEL_ID } from '../lib/configResolve.js'
import { isProcessAlive, isPortFree, LlamaServer } from '../lib/llama/runner.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(here, 'fixtures', 'fake-llama-server.mjs')

let passed = 0
let failed = 0

async function step(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.log(`  ✗ ${name}\n      ${error.stack?.split('\n').slice(0, 3).join('\n      ') ?? error.message}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 静默日志：端到端测试只关心行为，不想刷屏。改成 { verbose: true } 可看到插件日志。 */
const verbose = process.argv.includes('--verbose')
const logs = []
const log = {
  error: (...a) => verbose && console.log('[error]', ...a),
  warn: (...a) => verbose && console.log('[warn]', ...a),
  info: (...a) => {
    logs.push(a.join(' '))
    if (verbose) console.log('[info]', ...a)
  },
  debug: (...a) => verbose && console.log('[debug]', ...a),
}

function request(url, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = http.request(
      url,
      {
        method,
        headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': payload.byteLength } : {}), ...headers },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(150)
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label}`)
}

async function buildRuntime(overrides = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-local-model-e2e-'))
  const modelsDir = path.join(home, 'local-model', 'models')
  await mkdir(modelsDir, { recursive: true })
  await writeFile(path.join(modelsDir, 'Test-Model-3B-Q4_K_M.gguf'), Buffer.alloc(4096))

  const config = resolveConfig(
    {
      selectedModel: 'Test-Model-3B-Q4_K_M.gguf',
      // 把「llama-server 路径」指向替身脚本：既走通了 locateLlamaServer 的显式路径分支，
      // 又不需要真的装 llama.cpp。
      llamaServerPath: FIXTURE,
      host: '127.0.0.1',
      port: 0,
      idleUnloadMinutes: 1,
      startupTimeoutMs: 20_000,
      shutdownGraceMs: 3000,
      logLevel: 'silent',
      ...overrides,
    },
    { DSH_HOME: home },
  )
  // 生产默认是 5 分钟；测试里压到 1.2 秒，只为把「空闲卸载」跑到。
  config.idleUnloadMs = 1200

  const spawns = []
  const runtime = new LocalModelRuntime(config, log, {
    launchServer: ({ config: cfg, port, executable, log: l, onExit }) => {
      spawns.push(port)
      return new LlamaServer({
        command: process.execPath,
        args: [executable, '--host', cfg.host, '--port', String(port), '--alias', DEFAULT_MODEL_ALIAS],
        cwd: here,
        env: { ...process.env, FAKE_LOAD_MS: '300' },
        pidFile: cfg.paths.pidFile,
        log: l,
        onExit,
      })
    },
  })

  const proxy = new LocalModelProxy({
    host: config.host,
    port: config.port,
    upstream: () => runtime.status().upstream,
    ensureReady: () => runtime.ensureReady(),
    onRequestStart: () => runtime.beginRequest(),
    onRequestEnd: () => runtime.endRequest(),
    status: () => runtime.status(),
    modelId: () => LOCAL_MODEL_ID,
    modelDisplayName: () => runtime.status().model?.displayName ?? LOCAL_MODEL_ID,
    apiKey: () => config.apiKey,
    // 生产里由 index.ts 注入；这里按配置取，才能验证「改写后的请求体真的到了上游」。
    // supportedEfforts 也必须带上 —— 少了它代理层不敢下发档位，测出来的就不是真实行为。
    thinkPolicy: () => ({
      enableThinking: config.enableThinking,
      preserveThinking: config.preserveThinking,
      supportedEfforts: runtime.reasoningEfforts,
    }),
    log,
  })
  runtime.attachProxy(proxy)
  return { home, config, runtime, proxy, spawns }
}

async function teardown(ctx) {
  await ctx.runtime.dispose()
  await ctx.proxy.close()
  await rm(ctx.home, { recursive: true, force: true })
}

console.log('\n端到端：本地模型按需加载与空闲卸载')

await step('初始化后：只有常驻代理，没有 llama-server 进程（不占显存）', async () => {
  const ctx = await buildRuntime()
  try {
    await ctx.runtime.init()
    assert.equal(ctx.runtime.currentState, 'idle')
    assert.equal(ctx.spawns.length, 0, '没有对话时不应拉起 llama-server')

    const status = await request(`${ctx.proxy.origin}/local-model/status`)
    assert.equal(status.status, 200)
    assert.equal(JSON.parse(status.text).state, 'idle')

    // 模型未加载时也要能回答 /v1/models，否则 dsh 的模型下拉框会是空的。
    const models = await request(`${ctx.proxy.origin}/v1/models`)
    assert.equal(models.status, 200)
    assert.equal(JSON.parse(models.text).data[0].id, 'local')
  } finally {
    await teardown(ctx)
  }
})

await step('首条对话：自动拉起 → 等待就绪 → 原样转发', async () => {
  const ctx = await buildRuntime()
  try {
    await ctx.runtime.init()
    const started = Date.now()
    const res = await request(`${ctx.proxy.origin}/v1/chat/completions`, {
      method: 'POST',
      body: { model: LOCAL_MODEL_ID, messages: [{ role: 'user', content: 'hi' }] },
    })
    const elapsed = Date.now() - started

    assert.equal(res.status, 200, `期望 200，实际 ${res.status}：${res.text.slice(0, 300)}`)
    const payload = JSON.parse(res.text)
    assert.equal(payload.choices[0].message.content, 'FAKE_LLAMA_OK')
    assert.equal(payload.model, 'local', '请求体应原样转发到 llama-server')
    assert.equal(res.headers['x-local-model'], 'local', '应带上 x-local-model 头')
    assert.equal(ctx.spawns.length, 1, '应恰好拉起一个进程')
    assert.ok(elapsed >= 250, '首个请求应当真的等了模型加载（fake 约 300ms）')
    assert.equal(ctx.runtime.currentState, 'ready')

    const status = JSON.parse((await request(`${ctx.proxy.origin}/local-model/status`)).text)
    assert.ok(status.pid > 0, '应记录子进程 pid')
    assert.equal(status.activeRequests, 0, '请求结束后活跃计数必须归零，否则永远不会自动卸载')
  } finally {
    await teardown(ctx)
  }
})

await step('并发单飞：4 个并发请求只拉起 1 个进程', async () => {
  const ctx = await buildRuntime()
  try {
    await ctx.runtime.init()
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(`${ctx.proxy.origin}/v1/chat/completions`, {
          method: 'POST',
          body: { model: 'local', messages: [{ role: 'user', content: 'hi' }] },
        }),
      ),
    )
    for (const res of results) assert.equal(res.status, 200)
    assert.equal(ctx.spawns.length, 1, '并发加载必须单飞，不能重复 spawn')
  } finally {
    await teardown(ctx)
  }
})

await step('流式返回逐块透传（SSE 不被缓冲）', async () => {
  const ctx = await buildRuntime()
  try {
    await ctx.runtime.init()
    const res = await request(`${ctx.proxy.origin}/v1/chat/completions`, {
      method: 'POST',
      body: { model: 'local', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'] ?? '', /event-stream/)
    assert.ok(res.text.includes('data: '), 'SSE 应带 data: 前缀')
    assert.ok(res.text.includes('FAKE_'), '分块内容应完整透传')
    assert.ok(res.text.includes('[DONE]'), '结束标记应透传')
  } finally {
    await teardown(ctx)
  }
})

await step('思考开关：默认开启时显式下发 true，其它字段不受影响', async () => {
  const ctx = await buildRuntime()
  try {
    await ctx.runtime.init()
    const res = await request(`${ctx.proxy.origin}/v1/chat/completions`, {
      method: 'POST',
      body: { model: 'local', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(res.status, 200)
    const payload = JSON.parse(res.text)
    assert.deepEqual(
      payload._echo.chat_template_kwargs,
      { enable_thinking: true, preserve_thinking: true },
      '上游必须收到改写后的 chat_template_kwargs',
    )
    assert.deepEqual(payload._echo.messages, [{ role: 'user', content: 'hi' }], '保留历史 think 时 messages 原样转发')
    assert.equal(payload.choices[0].message.content, 'FAKE_LLAMA_OK', '改写不能破坏响应透传')
  } finally {
    await teardown(ctx)
  }
})

await step('思考开关：关闭时下发 false，并剥掉历史 think 后再发给上游', async () => {
  const ctx = await buildRuntime({ enableThinking: false, preserveThinking: false })
  try {
    await ctx.runtime.init()
    const res = await request(`${ctx.proxy.origin}/v1/chat/completions`, {
      method: 'POST',
      body: {
        model: 'local',
        messages: [
          { role: 'assistant', content: '<think>想了一大堆</think>答案是 2', reasoning_content: '内部推理' },
          { role: 'user', content: '那 3 呢' },
        ],
      },
    })
    assert.equal(res.status, 200)
    const payload = JSON.parse(res.text)
    assert.deepEqual(payload._echo.chat_template_kwargs, { enable_thinking: false, preserve_thinking: false })
    assert.deepEqual(
      payload._echo.messages,
      [{ role: 'assistant', content: '答案是 2' }, { role: 'user', content: '那 3 呢' }],
      '历史 think 必须在上游看到之前就被剥掉',
    )
  } finally {
    await teardown(ctx)
  }
})

await step('思考开关：dsh 的推理档位不被抹平，也不会把模板不认的值发过去', async () => {
  const ctx = await buildRuntime()
  try {
    await ctx.runtime.init()

    // 形态一：dsh 的「推理等级 = Off」实测会发成布尔 false（settings.yaml 把 off 读成布尔）。
    // 插件此前会把它原样塞给模板 → 模板 raise → 整次对话 500。现在必须变成 enable_thinking:false。
    const off = await request(`${ctx.proxy.origin}/v1/chat/completions`, {
      method: 'POST',
      body: { model: LOCAL_MODEL_ID, messages: [{ role: 'user', content: 'hi' }], reasoning_effort: false },
    })
    assert.equal(off.status, 200)
    const offKwargs = JSON.parse(off.text)._echo.chat_template_kwargs
    assert.equal(offKwargs.enable_thinking, false, '请求选 Off 时，即使插件开关开着也必须关掉思考')
    assert.equal(offKwargs.reasoning_effort, undefined, '模板会 raise 的值绝不能发过去')

    // 形态二：档位走了顶层字段（dsh 的默认 openai 格式），且值不在模板支持表里。
    const leveled = await request(`${ctx.proxy.origin}/v1/chat/completions`, {
      method: 'POST',
      body: { model: LOCAL_MODEL_ID, messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high' },
    })
    const kwargs = JSON.parse(leveled.text)._echo.chat_template_kwargs
    assert.equal(kwargs.enable_thinking, true, '选了档位就是要思考')
    assert.equal(
      kwargs.reasoning_effort,
      'xhigh',
      '假服务器声明的模板只认 xhigh/medium/low，high 必须被映射成 xhigh（原样发会 500）',
    )
  } finally {
    await teardown(ctx)
  }
})

await step('空闲一段时间后：自动卸载、进程被回收、端口被释放', async () => {  const ctx = await buildRuntime()
  try {
    await ctx.runtime.init()
    await request(`${ctx.proxy.origin}/v1/chat/completions`, {
      method: 'POST',
      body: { model: 'local', messages: [{ role: 'user', content: 'hi' }] },
    })
    const status = JSON.parse((await request(`${ctx.proxy.origin}/local-model/status`)).text)
    const pid = status.pid
    assert.ok(pid > 0 && isProcessAlive(pid), '加载后进程应当存活')

    await waitFor(() => ctx.runtime.currentState === 'idle', 10_000, '等待空闲卸载')
    assert.equal(isProcessAlive(pid), false, `空闲后进程 ${pid} 必须被回收（否则显存会被一直占着）`)

    const after = JSON.parse((await request(`${ctx.proxy.origin}/local-model/status`)).text)
    assert.equal(after.pid, null)
    assert.ok(after.lastActivityAt > 0)
  } finally {
    await teardown(ctx)
  }
})

await step('空闲卸载后再次对话：能重新拉起（可反复加载/卸载）', async () => {
  const ctx = await buildRuntime()
  try {
    await ctx.runtime.init()
    const call = () =>
      request(`${ctx.proxy.origin}/v1/chat/completions`, {
        method: 'POST',
        body: { model: 'local', messages: [{ role: 'user', content: 'hi' }] },
      })
    assert.equal((await call()).status, 200)
    await waitFor(() => ctx.runtime.currentState === 'idle', 10_000, '第一次空闲卸载')
    assert.equal((await call()).status, 200, '卸载后应能自动重新加载')
    assert.equal(ctx.spawns.length, 2, '应当是第二次真实 spawn')
  } finally {
    await teardown(ctx)
  }
})

await step('未选择模型时：报错可操作（告诉用户去哪儿选）', async () => {
  const ctx = await buildRuntime({ selectedModel: '' })
  try {
    await ctx.runtime.init()
    const res = await request(`${ctx.proxy.origin}/v1/chat/completions`, {
      method: 'POST',
      body: { model: 'local', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(res.status, 503)
    const payload = JSON.parse(res.text)
    assert.match(payload.error.message, /还没有选择本地模型/)
    assert.ok(payload.error.hint.includes('本地模型'), '应给出设置页路径')
    assert.equal(ctx.spawns.length, 0)
  } finally {
    await teardown(ctx)
  }
})

await step('llama-server 缺失时：报错列出查找过的位置', async () => {
  const ctx = await buildRuntime({ llamaServerPath: path.join(os.tmpdir(), 'definitely-not-here') })
  try {
    await ctx.runtime.init()
    const res = await request(`${ctx.proxy.origin}/v1/chat/completions`, {
      method: 'POST',
      body: { model: 'local', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(res.status, 503)
    assert.match(JSON.parse(res.text).error.message, /没有找到 llama-server/)
    assert.equal(ctx.runtime.currentState, 'failed')
  } finally {
    await teardown(ctx)
  }
})

await step('空闲判定规则：加载中/有活跃请求/关闭自动卸载 都不卸载', async () => {
  const base = { activeRequests: 0, idleUnloadMs: 300_000, lastActivityAt: 0, now: 300_001 }
  assert.equal(shouldUnload({ ...base, state: 'ready' }), true, '满足空闲时长应卸载')
  assert.equal(shouldUnload({ ...base, state: 'ready', now: 299_999 }), false, '未到时长不应卸载')
  assert.equal(shouldUnload({ ...base, state: 'starting' }), false, '加载中不应卸载')
  assert.equal(shouldUnload({ ...base, state: 'ready', activeRequests: 1 }), false, '有活跃请求不应卸载')
  assert.equal(shouldUnload({ ...base, state: 'ready', idleUnloadMs: 0 }), false, '关闭自动卸载后不应卸载')
  assert.equal(shouldUnload({ ...base, state: 'idle' }), false, '已经是待机状态无需再卸')
})

await step('插件卸载时：清理进程与端口', async () => {
  const ctx = await buildRuntime()
  const status = await (async () => {
    await ctx.runtime.init()
    await request(`${ctx.proxy.origin}/v1/chat/completions`, {
      method: 'POST',
      body: { model: 'local', messages: [{ role: 'user', content: 'hi' }] },
    })
    return JSON.parse((await request(`${ctx.proxy.origin}/local-model/status`)).text)
  })()

  const port = Number(new URL(status.upstream).port)
  await ctx.runtime.dispose()
  await ctx.proxy.close()

  await waitFor(() => !isProcessAlive(status.pid), 5000, 'dispose 后进程应退出')
  await waitFor(() => isPortFree(ctx.config.host, port), 5000, 'dispose 后上游端口应释放')
  await rm(ctx.home, { recursive: true, force: true })
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
console.log(`插件日志条数：${logs.length}（加 --verbose 查看）`)
process.exit(failed === 0 ? 0 : 1)
