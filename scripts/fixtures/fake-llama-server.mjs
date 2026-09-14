#!/usr/bin/env node
/**
 * 端到端测试用的 llama-server 替身。
 *
 * 它只模仿插件真正依赖的那几条契约，用来验证「拉起 → 就绪 → 转发 → 空闲卸载 → 进程回收」
 * 这条主线，而不是去模仿 llama.cpp 的推理能力：
 *   - 启动后先有一段时间 /health 返回 503（模型加载中），之后 200 {"status":"ok"}
 *   - /v1/models 返回 --alias 指定的模型名
 *   - /v1/chat/completions 支持 JSON 与 SSE 两种返回
 *
 * 加载耗时可用 FAKE_LOAD_MS 调整。
 */
import http from 'node:http'

const argv = process.argv.slice(2)

function arg(name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const host = arg('--host', '127.0.0.1')
const port = Number(arg('--port', '0'))
const alias = arg('--alias', 'local')
const loadMs = Number(process.env.FAKE_LOAD_MS ?? 300)
const startedAt = Date.now()

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${host}`)

  if (url.pathname === '/health') {
    if (Date.now() - startedAt < loadMs) {
      const body = JSON.stringify({ error: { code: 503, message: 'Loading model' } })
      res.writeHead(503, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      res.end(body)
      return
    }
    const body = JSON.stringify({ status: 'ok' })
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    res.end(body)
    return
  }

  if (url.pathname === '/v1/models') {
    const body = JSON.stringify({ object: 'list', data: [{ id: alias, object: 'model' }] })
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    res.end(body)
    return
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    const raw = await readBody(req)
    let payload = {}
    try {
      payload = JSON.parse(raw)
    } catch {
      // 故意保留空对象：由下面的字段缺失来暴露问题。
    }
    const model = payload.model ?? alias

    if (payload.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(`data: ${JSON.stringify({ id: 'cmpl-fake', model, choices: [{ delta: { content: 'FAKE_' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ id: 'cmpl-fake', model, choices: [{ delta: { content: 'LLAMA_OK' } }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    const body = JSON.stringify({
      id: 'cmpl-fake',
      object: 'chat.completion',
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'FAKE_LLAMA_OK' }, finish_reason: 'stop' }],
      // 回显收到的关键字段：端到端测试据此确认「插件改写后的请求体真的到了上游」。
      _echo: {
        chat_template_kwargs: payload.chat_template_kwargs ?? null,
        messages: payload.messages ?? null,
      },
    })
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    res.end(body)
    return
  }

  if (url.pathname === '/shutdown') {
    res.writeHead(200).end('ok')
    setTimeout(() => process.exit(0), 10)
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: `no such route: ${url.pathname}` } }))
})

server.listen(port, host, () => {
  const address = server.address()
  process.stderr.write('llama_model_load: loading model (fake)\n')
  process.stderr.write(`main: server is listening on http://${host}:${address.port} - starting the main loop\n`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    process.stderr.write(`main: received ${signal}, shutting down\n`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 200)
  })
}
