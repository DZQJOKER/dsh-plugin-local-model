import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, writeFile, rm } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

import type { Log } from '../log.js'
import { renderCommandLine, redactArgs } from './args.js'

export interface LlamaServerExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
  /** true = 我们自己要求它退出的，不是崩溃。 */
  expected: boolean
}

export interface LlamaServerOptions {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  pidFile: string
  log: Log
  onExit?: (info: LlamaServerExitInfo) => void
}

const LOG_RING = 200

/** 探测端口是否被占用（能 listen 就是空闲）。 */
export async function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, host)
  })
}

/** 优先用 preferred，被占用则让内核分配一个空闲端口。 */
export async function findFreePort(host: string, preferred: number): Promise<number> {
  if (preferred > 0 && (await isPortFree(host, preferred))) return preferred
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

export function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function runTaskkill(pid: number, force: boolean): Promise<void> {
  await new Promise<void>((resolve) => {
    const args = ['/PID', String(pid), '/T']
    if (force) args.push('/F')
    const child = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' })
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
  })
}

async function terminateGracefully(pid: number): Promise<void> {
  try {
    if (process.platform === 'win32') await runTaskkill(pid, false)
    else process.kill(pid, 'SIGTERM')
  } catch {
    // 进程已经没了：正常情形，忽略。
  }
}

async function terminateForcefully(pid: number): Promise<void> {
  try {
    if (process.platform === 'win32') await runTaskkill(pid, true)
    else process.kill(pid, 'SIGKILL')
  } catch {
    // 同上。
  }
}

export interface HealthResult {
  state: 'ok' | 'loading' | 'unreachable'
  detail: string
}

/** 读 llama-server 的 /health：加载中返回 503，就绪返回 200 {"status":"ok"}。 */
export function probeHealth(host: string, port: number, timeoutMs = 2000): Promise<HealthResult> {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path: '/health', method: 'GET', timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').trim()
          if (res.statusCode === 200 && /"status"\s*:\s*"ok"/.test(body)) {
            resolve({ state: 'ok', detail: body })
          } else if (res.statusCode === 200) {
            resolve({ state: 'ok', detail: body })
          } else {
            resolve({ state: 'loading', detail: body || `HTTP ${res.statusCode}` })
          }
        })
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ state: 'unreachable', detail: `/health 超时（${timeoutMs}ms）` })
    })
    req.on('error', (error: NodeJS.ErrnoException) => {
      resolve({ state: 'unreachable', detail: error.code ?? error.message })
    })
    req.end()
  })
}

/**
 * 从 llama-server 的 /props 读出**实际生效**的上下文长度。
 *
 * 为什么不能只看配置：新版 llama.cpp 的 `--fit` 为了塞进显存会把上下文悄悄调小，
 * 而 dsh 侧声明的 contextWindow 还是原值。两者不一致时，长会话会在中途崩，
 * 且崩得毫无线索 —— 所以启动后要对一次账，把偏差明说。
 */
export function fetchServerContext(host: string, port: number, timeoutMs = 3000): Promise<number | null> {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: '/props', method: 'GET', timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            default_generation_settings?: { n_ctx?: number }
            n_ctx?: number
          }
          const value = payload.default_generation_settings?.n_ctx ?? payload.n_ctx
          resolve(typeof value === 'number' && value > 0 ? value : null)
        } catch {
          resolve(null)
        }
      })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.on('error', () => resolve(null))
    req.end()
  })
}

/**
 * llama-server 子进程的一次生命周期。
 * 只负责「起、等就绪、停」，不懂业务语义 —— 状态机在 lifecycle.ts。
 */
export class LlamaServer {
  private child: ChildProcess | null = null
  private expectedStop = false
  private tail: string[] = []
  private remainder = ''

  constructor(private readonly options: LlamaServerOptions) {}

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  get logTail(): string[] {
    return this.tail.slice(-40)
  }

  get commandLine(): string {
    return renderCommandLine(this.options.command, redactArgs(this.options.args))
  }

  /** 拉起进程并写 pid 文件。不等待模型加载完成。 */
  async start(): Promise<void> {
    if (this.running) return
    this.expectedStop = false
    this.tail = []
    this.remainder = ''

    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.consume('stdout', chunk))
    child.stderr?.on('data', (chunk: string) => this.consume('stderr', chunk))

    child.once('error', (error) => {
      this.options.log.error(`启动 llama-server 失败：${error.message}`)
      this.append(`[spawn error] ${error.message}`)
    })

    child.once('exit', (code, signal) => {
      const expected = this.expectedStop
      this.child = null
      this.append(`[exit] code=${code} signal=${signal}`)
      if (expected) this.options.log.info(`llama-server 已退出（code=${code}）`)
      else this.options.log.error(`llama-server 意外退出（code=${code} signal=${signal}）`)
      void this.clearPidFile()
      this.options.onExit?.({ code, signal, expected })
    })

    if (child.pid) await this.writePidFile(child.pid)
    this.options.log.info(`已拉起：${this.commandLine}`)
  }

  /** 轮询 /health 直到就绪；超时抛错，错误里带日志尾巴，方便定位。 */
  async waitUntilReady(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastDetail = ''
    let polls = 0
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('启动被取消')
      if (!this.running && polls > 0) {
        throw new Error(`llama-server 在加载过程中退出。\n最近日志：\n${this.tail.join('\n')}`)
      }
      const health = await probeHealth(host, port, 2000)
      polls++
      if (health.state === 'ok') {
        this.options.log.info(`模型加载完成（${polls} 次探测，耗时 ${Math.round(timeoutMs / 100) / 10}s 上限内）`)
        return
      }
      lastDetail = health.detail
      await delay(polls < 5 ? 400 : 1000)
    }
    throw new Error(
      `等待模型加载超时（${timeoutMs}ms）。最后一次探测：${lastDetail}\n最近日志：\n${this.tail.slice(-15).join('\n')}`,
    )
  }

  /**
   * 优雅停：先请它自己退，等 graceMs；还没走就强杀整个进程树。
   * 进程树很关键 —— llama-server 在某些后端下会派生 worker，只杀父进程会留下占显存的孤儿。
   */
  async stop(graceMs = 8000): Promise<void> {
    const child = this.child
    if (!child) {
      await this.clearPidFile()
      return
    }
    const pid = child.pid
    this.expectedStop = true

    if (!pid || child.exitCode !== null) {
      this.child = null
      await this.clearPidFile()
      return
    }

    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
    })
    await terminateGracefully(pid)

    const raced = await Promise.race([exited.then(() => true), delay(graceMs).then(() => false)])
    if (!raced) {
      this.options.log.warn(`llama-server 未在 ${graceMs}ms 内退出，强制结束进程树 (pid=${pid})`)
      await terminateForcefully(pid)
      await Promise.race([exited, delay(3000)])
    }

    this.child = null
    await this.clearPidFile()
  }

  /** 启动时调用：清掉上一次 dsh 异常退出残留的 llama-server，避免白占显存。 */
  async killStaleProcess(): Promise<number | null> {
    return killStaleLlamaProcess(this.options.pidFile, this.options.log)
  }

  private consume(stream: 'stdout' | 'stderr', chunk: string): void {
    const text = this.remainder + chunk
    const lines = text.split(/\r?\n/)
    this.remainder = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trimEnd()
      if (!trimmed) continue
      this.append(trimmed)
      if (/\b(error|failed|abort|out of memory|CUDA error)\b/i.test(trimmed)) {
        this.options.log.warn(`llama-server: ${trimmed}`)
      } else {
        this.options.log.debug(`llama-server: ${trimmed}`)
      }
    }
  }

  private append(line: string): void {
    this.tail.push(line)
    if (this.tail.length > LOG_RING) this.tail.splice(0, this.tail.length - LOG_RING)
    void this.options.log
  }

  private async writePidFile(pid: number): Promise<void> {
    try {
      await writeFile(this.options.pidFile, `${pid}\n`, 'utf8')
    } catch (error) {
      this.options.log.debug(`写 pid 文件失败：${(error as Error).message}`)
    }
  }

  private async clearPidFile(): Promise<void> {
    try {
      await rm(this.options.pidFile, { force: true })
    } catch {
      // 忽略。
    }
  }
}

async function readPidFileRaw(pidFile: string): Promise<number | null> {
  try {
    const pid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * 插件加载时回收上一次 dsh 异常退出留下的 llama-server。
 * 不做这件事的后果很具体：旧进程一直握着显存，新模型加载直接 OOM。
 */
export async function killStaleLlamaProcess(pidFile: string, log: Log): Promise<number | null> {
  const pid = await readPidFileRaw(pidFile)
  if (pid === null) {
    await rm(pidFile, { force: true })
    return null
  }
  if (pid === process.pid) {
    await rm(pidFile, { force: true })
    return null
  }
  if (!isProcessAlive(pid)) {
    await rm(pidFile, { force: true })
    return null
  }
  log.warn(`发现上一次运行残留的 llama-server（pid=${pid}），正在回收，避免它继续占用显存`)
  await terminateForcefully(pid)
  await rm(pidFile, { force: true })
  return pid
}

