import { existsSync } from 'node:fs'

import type { Log } from './log.js'
import type { ResolvedConfig } from './configResolve.js'
import { scanModelsDetailed, pickModel, formatBytes, resolveVisionProjector, type LocalModelEntry, type ModelShard } from './registry.js'
import { ensureReadme } from './paths.js'
import { buildLlamaServerArgs, DEFAULT_ALIAS } from './llama/args.js'
import { describeSearchScope, locateLlamaServer } from './llama/detect.js'
import {
  isFlashAttnFormError,
  probeCapabilities,
  unknownFlags,
  type FlashAttnMode,
} from './llama/capabilities.js'
import { diagnoseLoadFailure, extractEffectiveContext } from './llama/diagnose.js'
import {
  fetchServerContext,
  findFreePort,
  killStaleLlamaProcess,
  LlamaServer,
  type LlamaServerExitInfo,
} from './llama/runner.js'

/** 模型目录扫描结果的缓存时间：避免每次状态查询都去读盘。 */
const SCAN_TTL_MS = 5000

export type RuntimeState = 'disabled' | 'idle' | 'starting' | 'ready' | 'stopping' | 'failed'

export const STATE_LABEL: Record<RuntimeState, string> = {
  disabled: '已禁用',
  idle: '待机（模型未加载）',
  starting: '正在加载模型…',
  ready: '已就绪',
  stopping: '正在卸载…',
  failed: '加载失败',
}

export interface RuntimeStatus {
  state: RuntimeState
  stateLabel: string
  model: { id: string; displayName: string; quant: string | null; params: string | null; sizeBytes: number } | null
  /** dsh 侧应当配置的 baseURL。 */
  endpoint: string
  /** llama-server 实际监听地址，未运行时为 null。 */
  upstream: string | null
  pid: number | null
  loadedAt: number | null
  lastActivityAt: number
  /** 预计卸载时间；空闲卸载关闭时为 null。 */
  unloadAt: number | null
  /** 距离自动卸载还剩多少毫秒（≤0 表示已经过期，tick 下次巡检就会触发）；关闭时为 null。 */
  unloadInMs: number | null
  /** 当前被什么挡住没有卸载；null 表示「已到期，等下次 tick」。这是定位"5 分钟没卸载"的第一现场。 */
  unloadBlockedBy: string | null
  /** 上次巡检 unload 条件的时间戳。 */
  lastTickAt: number | null
  idleUnloadMinutes: number
  activeRequests: number
  restarts: number
  lastError: string | null
  logTail: string[]
  modelsFound: number
  modelsDir: string
  runtimeDir: string
  /** 本次加载会下发给 llama-server 的 --mmproj（绝对路径）；无视觉能力时为 null。 */
  visionProjector: string | null
}

/** 插件向生命周期层注入的代理句柄，避免 lifecycle 直接依赖 http 实现。 */
export interface ProxyHost {
  readonly origin: string
  listen(): Promise<number>
  close(): Promise<void>
}

/** llama-server 子进程的最小接口。默认实现是真实进程，测试可注入替身。 */
export interface LlamaServerLike {
  readonly running: boolean
  readonly pid: number | null
  readonly logTail: string[]
  readonly commandLine: string
  start(): Promise<void>
  waitUntilReady(host: string, port: number, timeoutMs: number): Promise<void>
  stop(graceMs: number): Promise<void>
}

export interface LaunchInput {
  config: ResolvedConfig
  entry: LocalModelEntry
  /** 已经挑好的内部端口。 */
  port: number
  /** 已经定位好的可执行文件绝对路径。 */
  executable: string
  /** 该构建的 --flash-attn 形状（由 --help 探测得到）。 */
  flashAttnMode: FlashAttnMode
  /** 该构建的 -ngl 是否接受 auto / all 关键字。 */
  gpuLayersSupport: { auto: boolean; all: boolean }
  log: Log
  /** 子进程退出回调。默认实现会把它挂到真实进程上，用于崩溃自愈。 */
  onExit: (info: LlamaServerExitInfo) => void
}

export type ServerLauncher = (input: LaunchInput) => LlamaServerLike

export interface RuntimeHooks {
  /** 通过会话内工具/命令切换模型时，尝试写回设置。 */
  persistSelectedModel?: (id: string) => Promise<void> | void
  /**
   * 子进程启动方式。默认走「定位 llama-server → 拼参数 → spawn 真实进程」，
   * 留这个注入点是为了让「首请求拉起 / 空闲卸载」这条主线能跑真实的端到端测试
   * （见 scripts/e2e.mjs），而不是只测到状态机的表面。
   */
  launchServer?: ServerLauncher
}

/**
 * 空闲卸载判定的纯函数形式。
 *
 * 之所以抽出来：这是本插件最核心的业务规则（连续 N 分钟无交互即释放资源），
 * 边界条件（正在加载、有活跃请求、关闭了自动卸载）必须能被逐个钉死，
 * 而不是埋在定时器回调里靠肉眼看。
 *
 * 「activeRequests 计数被卡住」的自愈：SSE 长连接若因为 TCP 异常没正常 close，
 * finish() 永远不被调，计数永远 > 0，卸载就再也触发不了。但**只要还有活请求在跑，
 * lastActivityAt 就会被不断刷新**；反过来说，如果 lastActivityAt 已经 5 分钟没动，
 * activeRequests > 0 一定是计数器泄漏，把这一路也判为可卸载。这是用两条独立信号交叉
 * 验证避免「单点卡死整个生命周期」。
 */
export function shouldUnload(input: {
  state: RuntimeState
  activeRequests: number
  idleUnloadMs: number
  lastActivityAt: number
  now: number
}): boolean {
  if (input.state !== 'ready') return false
  if (!Number.isFinite(input.idleUnloadMs) || input.idleUnloadMs <= 0) return false
  const idleFor = input.now - input.lastActivityAt
  if (idleFor < input.idleUnloadMs) return false
  if (input.activeRequests <= 0) return true
  // 计数器说还有活请求，但 lastActivityAt 已经停了 ≥ idleUnloadMs —— 一定是 onRequestEnd
  // 漏调了。卸载以解锁；卸载过程中 activeRequests 会被自然清掉。
  return idleFor >= input.idleUnloadMs * 2
}

/** 默认启动方式：拼参数 → 起真进程。 */
export function defaultServerLauncher(input: LaunchInput): LlamaServerLike {
  const { config, entry, port, executable, log, onExit, flashAttnMode, gpuLayersSupport } = input
  const built = buildLlamaServerArgs({
    modelPath: entry.path,
    host: config.host,
    port,
    alias: config.modelAlias || DEFAULT_ALIAS,
    ctxSize: config.ctxSize,
    gpuLayersMode: config.gpuLayersMode,
    gpuLayers: config.gpuLayers,
    gpuLayersSupport,
    threads: config.threads,
    threadsBatch: config.threadsBatch,
    batchSize: config.batchSize,
    ubatchSize: config.ubatchSize,
    flashAttention: config.flashAttention,
    flashAttnMode,
    cacheTypeK: config.cacheTypeK,
    cacheTypeV: config.cacheTypeV,
    jinja: config.jinja,
    chatTemplate: config.chatTemplate,
    // 显式选择的 mmproj 优先；留空时仍是模型同目录自动关联的结果（原有行为不变）。
    mmproj: resolveVisionProjector(config.modelsDir, config.mmprojFile, entry.mmproj),
    mmap: config.mmap,
    mlock: config.mlock,
    apiKey: config.apiKey,
    extraArgs: config.extraArgs,
  })
  return new LlamaServer({
    command: executable,
    args: built.args,
    cwd: dirnameOf(executable),
    env: { ...process.env, ...config.envOverrides },
    pidFile: config.paths.pidFile,
    log,
    onExit,
  })
}

/**
 * 本地模型的运行时状态机。
 *
 *   disabled ──(启用)──▶ idle ──首条对话──▶ starting ──就绪──▶ ready
 *                          ▲                                     │
 *                          └──── 空闲 5 分钟 / 切换模型 / 手动 ────┘
 *
 * 两条硬约束：
 *   1. 任意时刻最多一个 llama-server 进程；
 *   2. 加载与卸载都做单飞（single-flight），并发请求共享同一次加载，不会重复拉起。
 */
export class LocalModelRuntime {
  private state: RuntimeState = 'idle'
  private server: LlamaServerLike | null = null
  private proxy: ProxyHost | null = null

  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private ticker: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null

  private models: LocalModelEntry[] = []
  private visionProjectors: ModelShard[] = []
  private modelsScannedAt = 0
  private selectedOverride: string | null = null

  private upstreamPort = 0
  private commandLine = ''
  private loadedAt: number | null = null
  private lastActivityAt = Date.now()
  /** 上次 tick() 跑过的时间；用来回答"5 分钟过去了吗" —— 即使 tick 没真的触发卸载。 */
  private lastTickAt: number | null = null
  private activeRequests = 0
  private restarts = 0
  private lastError: string | null = null
  private disposed = false
  private started = false
  /** 启动后探测到的 llama.cpp 实际生效的上下文（受 --fit 影响，可能小于声明值）。 */
  private effectiveContext: number | null = null
  /** 探测结果与实际不符时（--flash-attn 形状），本次会话内记住「不下发」。 */
  private flashAttnOverride: FlashAttnMode | null = null

  private readonly listeners = new Set<() => void>()
  private currentConfig: ResolvedConfig

  constructor(
    config: ResolvedConfig,
    private readonly log: Log,
    private readonly hooks: RuntimeHooks = {},
  ) {
    this.currentConfig = config
  }

  /** 当前生效的配置（可被设置页改写，见 applyConfig）。 */
  get config(): ResolvedConfig {
    return this.currentConfig
  }

  /**
   * 换一份配置并让它立即生效。
   *
   * 规则：会改变 llama-server 进程形态的设置（模型、参数、端口、路径）只影响「下一次加载」，
   * 所以这里直接把已加载的模型卸掉 —— 用户刚改完设置，期望的是下次对话按新参数来，
   * 而不是继续用旧参数跑着。有请求正在生成时不打断它，等它跑完再卸。
   */
  async applyConfig(next: ResolvedConfig, options: { reload?: boolean } = {}): Promise<void> {
    const previous = this.currentConfig
    this.currentConfig = next

    if (previous.selectedModel !== next.selectedModel) {
      // 设置页的选择优先于会话内临时选择，否则界面改了模型却毫无反应。
      this.selectedOverride = null
    }

    // init 之前只换配置：此时还没有代理、定时器和子进程，任何副作用都无从谈起。
    if (!this.started) return

    // 只有影响卸载时机的字段变了才重排定时器，避免每次保存配置都刷一条日志。
    if (previous.idleUnloadMs !== next.idleUnloadMs || previous.enabled !== next.enabled) {
      this.restartTicker()
    }

    if (!next.enabled) {
      // doUnload 会依据 config.enabled 自行落到 disabled 状态。
      await this.unload('总开关已关闭')
      this.setState('disabled')
      return
    }

    if (this.state === 'disabled') this.setState('idle')

    if (options.reload && this.state === 'ready') {
      if (this.activeRequests > 0) {
        this.log.info('设置已更新；当前有请求正在生成，等它结束后再按新参数重新加载')
        return
      }
      await this.unload('设置已更新')
    }
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  attachProxy(proxy: ProxyHost): void {
    this.proxy = proxy
  }

  async init(): Promise<void> {
    await ensureReadme(this.config.paths)
    await this.refreshModels(true)

    if (!this.config.enabled) {
      this.setState('disabled')
      this.log.info('本地模型已禁用（设置 → 本地模型 → 总开关）')
      return
    }

    try {
      await this.bootstrap()
    } catch (error) {
      this.lastError = (error as Error).message
      this.setState('failed')
      this.log.error(`本地模型插件初始化失败：${this.lastError}`)
      throw error
    }
  }

  private async bootstrap(): Promise<void> {
    // 顺序很重要：先回收上次残留的进程，再启动新的，否则两个进程会抢同一块显存。
    try {
      await killStaleLlamaProcess(this.config.paths.pidFile, this.log)
    } catch (error) {
      this.log.debug(`清理残留进程时出错：${(error as Error).message}`)
    }

    // 常驻代理很轻（不加载模型），但它让端点「永远在线」—— 这正是首条对话能触发加载的前提。
    if (!this.proxy) throw new Error('代理未注入')
    await this.proxy.listen()
    this.armTicker()
    this.setState('idle')

    this.log.info(`模型目录：${this.config.modelsDir}`)
    this.log.info(`运行时目录：${this.config.runtimeDir}`)
    if (this.models.length === 0) {
      this.log.warn('模型目录里还没有 .gguf 文件。放入模型后到 设置 → 本地模型 点「重新扫描」')
    } else if (!this.selectedModelId) {
      this.log.info(`已发现 ${this.models.length} 个本地模型，但尚未选择。设置 → 本地模型 → 选择模型`)
    }

    this.started = true

    if (this.config.preload && this.selectedModelId) {
      this.log.info('preload 已开启，开始预加载所选模型')
      void this.ensureReady().catch((error) => this.log.warn(`预加载失败：${(error as Error).message}`))
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.startPromise) await this.startPromise.catch(() => undefined)
    await this.stopServerQuietly()
    const proxy = this.proxy
    this.proxy = null
    if (proxy) await proxy.close()
    this.listeners.clear()
    this.log.info('本地模型插件已卸载，代理端口已关闭')
  }

  // ── 对外能力 ────────────────────────────────────────────────────────────

  /**
   * 「首条对话自动拉起模型」的唯一入口。
   * 所有请求路径都收敛到这里：没加载就加载，正在加载就复用同一个 promise。
   */
  async ensureReady(): Promise<void> {
    if (this.disposed) throw new Error('插件已卸载')
    if (!this.config.enabled) throw new Error('本地模型插件已禁用。请在 Harness 设置 → 本地模型 中打开总开关。')

    for (;;) {
      if (this.stopPromise) {
        await this.stopPromise.catch(() => undefined)
        continue
      }
      if (this.state === 'ready' && this.server?.running) {
        this.touch()
        return
      }
      if (!this.startPromise) {
        this.startPromise = this.doStart().finally(() => {
          this.startPromise = null
        })
      }
      return this.startPromise
    }
  }

  /** 卸载模型并释放资源。空闲超时、切换模型、手动停止都走这里。 */
  async unload(reason: string): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.doUnload(reason).finally(() => {
      this.stopPromise = null
    })
    return this.stopPromise
  }

  async reload(reason = '手动重新加载'): Promise<void> {
    await this.unload(reason)
    await this.ensureReady()
  }

  async refreshModels(force = false): Promise<LocalModelEntry[]> {
    const now = Date.now()
    if (!force && now - this.modelsScannedAt < SCAN_TTL_MS) return this.models
    try {
      const scanned = await scanModelsDetailed(this.config.modelsDir)
      this.models = scanned.entries
      this.visionProjectors = scanned.visionProjectors
    } catch (error) {
      this.log.error(`扫描模型目录失败：${(error as Error).message}`)
      this.models = []
      this.visionProjectors = []
    }
    this.modelsScannedAt = now
    this.emit()
    return this.models
  }

  listModels(): LocalModelEntry[] {
    return this.models
  }

  /** 模型目录里扫到的全部视觉投影文件（供设置页的下拉框）。 */
  listVisionProjectors(): ModelShard[] {
    return this.visionProjectors
  }

  /**
   * 本次加载实际会下发的 --mmproj（绝对路径）；没有视觉能力时为 null。
   * 取值规则与拼参数时完全一致 —— 界面显示的和真正下发的不该是两回事。
   */
  effectiveVisionProjector(entry: LocalModelEntry | null = pickModel(this.models, this.selectedModelId)): string | null {
    if (!entry) return null
    const resolved = resolveVisionProjector(this.config.modelsDir, this.config.mmprojFile, entry.mmproj)
    return resolved.length > 0 ? resolved : null
  }

  /** 会话内切换模型：能找到持久化钩子就落盘，否则只在本进程生效。 */
  async selectModel(id: string): Promise<LocalModelEntry> {
    await this.refreshModels(true)
    const entry = pickModel(this.models, id)
    if (!entry) {
      const available = this.models.map((m) => m.id).slice(0, 20)
      throw new Error(
        `模型目录里找不到「${id}」。当前可用（${this.models.length}）：\n${
          available.map((m) => `  - ${m}`).join('\n') || '  （目录为空）'
        }`,
      )
    }
    if (!entry.complete) {
      throw new Error(`模型「${entry.displayName}」分片不完整，缺少：${entry.missing.join('、') || '（未知）'}`)
    }

    const changed = entry.id !== this.selectedModelId
    this.selectedOverride = entry.id
    await this.hooks.persistSelectedModel?.(entry.id)
    if (changed && (this.state === 'ready' || this.startPromise)) {
      await this.unload('切换模型')
    }
    this.emit()
    return entry
  }

  get selectedModelId(): string {
    return (this.selectedOverride ?? this.config.selectedModel ?? '').trim()
  }

  get currentState(): RuntimeState {
    return this.state
  }

  /** 请求开始时计数：有活跃请求时绝不卸载。 */
  beginRequest(): void {
    this.activeRequests++
    this.touch()
  }

  /** 请求结束时计数并刷新空闲计时。 */
  endRequest(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1)
    this.touch()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  status(): RuntimeStatus {
    const entry = pickModel(this.models, this.selectedModelId)
    const idleMs = this.config.idleUnloadMs
    const unloadAt = this.state === 'ready' && idleMs > 0 ? this.lastActivityAt + idleMs : null
    return {
      state: this.state,
      stateLabel: STATE_LABEL[this.state],
      model: entry
        ? {
            id: entry.id,
            displayName: entry.displayName,
            quant: entry.quant,
            params: entry.params,
            sizeBytes: entry.sizeBytes,
          }
        : null,
      endpoint: this.proxy ? `${this.proxy.origin}/v1` : '(代理未启动)',
      upstream: this.upstreamOrigin(),
      pid: this.server?.pid ?? null,
      loadedAt: this.loadedAt,
      lastActivityAt: this.lastActivityAt,
      unloadAt,
      unloadInMs: unloadAt !== null ? Math.max(0, unloadAt - Date.now()) : null,
      unloadBlockedBy: this.explainUnloadBlocked(idleMs),
      lastTickAt: this.lastTickAt,
      idleUnloadMinutes: this.config.idleUnloadMinutes,
      activeRequests: this.activeRequests,
      restarts: this.restarts,
      lastError: this.lastError,
      logTail: this.server?.logTail.slice(-10) ?? [],
      modelsFound: this.models.length,
      modelsDir: this.config.modelsDir,
      runtimeDir: this.config.runtimeDir,
      visionProjector: this.effectiveVisionProjector(entry),
    }
  }

  /**
   * 把"为什么没卸载"翻译成一句人话。
   *
   * 这是排查"5 分钟过去模型还在"的第一个现场 —— 不打开插件代码也能照着看：
   *   - "空闲卸载已关闭"：用户把 idleUnloadMinutes 设成了 0，或 schema 默认值被改过；
   *   - "尚未就绪"：首条对话没进来过，状态卡在 idle/starting/failed；
   *   - "还有 N 个进行中请求"：activeRequests 计数异常，多半是某次请求 finish() 漏调；
   *   - "还有 4.8 分钟到期"：tick 正常，5 分钟还没到；
   *   - null：到期了，下次 tick 就会触发卸载。
   */
  private explainUnloadBlocked(idleMs: number): string | null {
    if (idleMs <= 0) return '空闲卸载已关闭（idleUnloadMinutes = 0）'
    if (this.state !== 'ready') {
      if (this.lastError) return `状态 ${this.state}，加载未成功（${this.lastError}）`
      return `状态 ${this.state}，模型未就绪`
    }
    if (this.activeRequests > 0) return `还有 ${this.activeRequests} 个进行中请求（finish() 漏调？）`
    const remaining = idleMs - (Date.now() - this.lastActivityAt)
    if (remaining > 0) return `还有 ${(remaining / 60_000).toFixed(1)} 分钟到期`
    return null
  }

  /** 人类可读状态，供 /local-model status 与日志使用。 */
  describe(): string {
    const status = this.status()
    const lines: string[] = []
    lines.push(`状态：${status.stateLabel}`)
    lines.push(
      `模型：${
        status.model
          ? `${status.model.displayName}（${status.model.quant ?? '未知量化'}，${formatBytes(status.model.sizeBytes)}）`
          : '未选择'
      }`,
    )
    lines.push(`入口：${status.endpoint}`)
    if (status.upstream) lines.push(`上游：${status.upstream}${status.pid ? `（pid ${status.pid}）` : ''}`)
    if (status.visionProjector) lines.push(`视觉投影：${status.visionProjector}`)
    if (status.state === 'ready') {
      lines.push(
        this.config.idleUnloadMinutes > 0
          ? `空闲卸载：连续 ${this.config.idleUnloadMinutes} 分钟无交互即释放${
              status.unloadAt ? `（约 ${new Date(status.unloadAt).toLocaleTimeString()}）` : ''
            }`
          : '空闲卸载：已关闭',
      )
    }
    if (status.activeRequests > 0) lines.push(`进行中请求：${status.activeRequests}`)
    if (status.modelsFound === 0) lines.push(`模型目录为空：${status.modelsDir}`)
    if (status.lastError) lines.push(`最近错误：${status.lastError}`)
    return lines.join('\n')
  }

  // ── 内部实现 ────────────────────────────────────────────────────────────

  private upstreamOrigin(): string | null {
    if (!this.server?.running || !this.upstreamPort) return null
    return `http://${this.config.host}:${this.upstreamPort}`
  }

  private async doStart(): Promise<void> {
    this.setState('starting')
    this.lastError = null
    try {
      const entry = await this.resolveSelectedModel()

      const location = await locateLlamaServer({
        explicit: this.config.llamaServerPath,
        runtimeDir: this.config.runtimeDir,
      })
      if (!location) {
        throw new Error(
          '没有找到 llama-server 可执行文件。请下载 llama.cpp 并解压到运行时目录，或在设置里填写绝对路径。\n已查找位置：\n' +
            describeSearchScope({ explicit: this.config.llamaServerPath, runtimeDir: this.config.runtimeDir }),
        )
      }

      // 起进程前先问清楚这个构建认识哪些选项、--flash-attn 是哪种形状。
      // 同一个参数在不同版本里形状不同，猜错会让解析器把下一个参数当成它的值吃掉。
      const capabilities = await probeCapabilities(location.path)
      if (!capabilities.ok) {
        this.log.warn(
          `无法探测 llama-server 的选项支持情况（${capabilities.detail}）。Flash Attention 将不下发，交由 llama.cpp 的默认值决定。`,
        )
      } else {
        this.log.debug(`已探测 ${location.path}：${capabilities.detail}`)
      }

      // 内部端口优先用配置值，被占用就自动挑空闲端口 —— 绝不和别的服务抢端口。
      const port = await findFreePort(this.config.host, this.config.llamaPort)
      this.upstreamPort = port

      const launcher = this.hooks.launchServer ?? defaultServerLauncher
      const preferred = this.flashAttnOverride ?? capabilities.flashAttnMode
      // 第二种形状只在「按第一种加载失败且失败原因是 flash-attn 形状」时才会被用到。
      const attempts: FlashAttnMode[] = preferred === 'unsupported' ? ['unsupported'] : [preferred, 'unsupported']

      let server: LlamaServerLike | null = null
      let failure: unknown = null

      for (const mode of attempts) {
        const built = buildLlamaServerArgs({
          modelPath: entry.path,
          host: this.config.host,
          port,
          alias: this.config.modelAlias || DEFAULT_ALIAS,
          ctxSize: this.config.ctxSize,
          gpuLayersMode: this.config.gpuLayersMode,
          gpuLayers: this.config.gpuLayers,
          gpuLayersSupport: capabilities.gpuLayers,
          threads: this.config.threads,
          threadsBatch: this.config.threadsBatch,
          batchSize: this.config.batchSize,
          ubatchSize: this.config.ubatchSize,
          flashAttention: this.config.flashAttention,
          flashAttnMode: mode,
          cacheTypeK: this.config.cacheTypeK,
          cacheTypeV: this.config.cacheTypeV,
          jinja: this.config.jinja,
          chatTemplate: this.config.chatTemplate,
          mmproj: resolveVisionProjector(this.config.modelsDir, this.config.mmprojFile, entry.mmproj),
          mmap: this.config.mmap,
          mlock: this.config.mlock,
          apiKey: this.config.apiKey,
          extraArgs: this.config.extraArgs,
        })
        for (const notice of built.notices) this.log.warn(`参数提示：${notice}`)

        if (capabilities.ok) {
          const unknown = unknownFlags(built.usedFlags, capabilities.flags)
          if (unknown.length > 0) {
            this.log.warn(
              `这个 llama-server 不认识以下选项：${unknown.join('、')}；加载可能失败。` +
                '可在「设置 → 本地模型 → 附加参数」里调整，或升级 llama.cpp。',
            )
          }
        }

        const candidate = launcher({
          config: this.config,
          entry,
          port,
          executable: location.path,
          flashAttnMode: mode,
          gpuLayersSupport: capabilities.gpuLayers,
          log: this.log,
          onExit: (info) => this.handleExit(info),
        })

        this.log.info(
          `正在加载 ${entry.displayName}（${formatBytes(entry.sizeBytes)}，可执行文件来自 ${location.source}）`,
        )
        try {
          await candidate.start()
          await candidate.waitUntilReady(this.config.host, port, this.config.startupTimeoutMs)
          server = candidate
          break
        } catch (error) {
          failure = error
          const tail = candidate.logTail.join('\n')
          if (mode !== 'unsupported' && isFlashAttnFormError(tail)) {
            // 探测结果与实际不符（或探测不可用）。退一步：不下发这个参数再试一次。
            this.flashAttnOverride = 'unsupported'
            this.log.warn('llama-server 拒绝了当前形式的 --flash-attn，已改为不下发该参数并重试一次')
            await candidate.stop(this.config.shutdownGraceMs).catch(() => undefined)
            continue
          }
          await candidate.stop(this.config.shutdownGraceMs).catch(() => undefined)
          throw new Error(explainServerFailure(tail, error as Error, this.config))
        }
      }

      if (!server) throw failure ?? new Error('无法启动 llama-server')

      this.server = server
      this.commandLine = server.commandLine
      this.loadedAt = Date.now()
      this.touch()
      this.setState('ready')
      this.log.info(`本地模型已就绪：${this.proxy?.origin ?? ''}/v1（模型别名 ${this.config.modelAlias}）`)
      void this.reconcileContext(port)
    } catch (error) {
      const message = (error as Error).message
      this.lastError = message
      await this.stopServerQuietly()
      this.setState('failed')
      this.log.error(`加载本地模型失败：${message}`)
      throw new Error(message)
    }
  }

  private async doUnload(reason: string): Promise<void> {
    if (this.startPromise) await this.startPromise.catch(() => undefined)
    const hadServer = this.server !== null
    this.setState('stopping')
    await this.stopServerQuietly()
    this.loadedAt = null
    this.restarts = 0
    if (hadServer) this.log.info(`已卸载本地模型（${reason}），显存与内存已释放`)
    this.touch()
    this.setState(this.config.enabled ? 'idle' : 'disabled')
  }

  private async stopServerQuietly(): Promise<void> {
    const server = this.server
    this.server = null
    this.upstreamPort = 0
    if (!server) return
    try {
      await server.stop(this.config.shutdownGraceMs)
    } catch (error) {
      this.log.warn(`停止 llama-server 时出错：${(error as Error).message}`)
    }
  }

  private handleExit(info: LlamaServerExitInfo): void {
    if (this.disposed) return
    this.server = null
    this.upstreamPort = 0
    if (info.expected) {
      this.emit()
      return
    }

    this.lastError = `llama-server 意外退出（code=${info.code} signal=${info.signal}）`
    if (this.config.autoRestart && this.restarts < this.config.maxRestarts) {
      this.restarts++
      const backoffMs = 1000 * this.restarts
      this.log.warn(`llama-server 崩溃，${backoffMs}ms 后自动重启（第 ${this.restarts}/${this.config.maxRestarts} 次）`)
      this.setState('starting')
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        if (this.disposed || this.startPromise) return
        this.startPromise = this.doStart()
          .catch(() => undefined)
          .finally(() => {
            this.startPromise = null
          })
      }, backoffMs)
      this.restartTimer.unref?.()
    } else {
      this.setState('failed')
      this.log.error(`${this.lastError}；已达重启上限，请检查设置或模型文件`)
    }
  }

  private async resolveSelectedModel(): Promise<LocalModelEntry> {
    await this.refreshModels(true)
    const id = this.selectedModelId
    if (!id) {
      const available = this.models.map((m) => m.id).slice(0, 20)
      throw new Error(
        `还没有选择本地模型。\n请把 GGUF 放进 ${this.config.modelsDir}，然后在 Harness 设置 → 本地模型 的「模型」下拉框中选择。\n` +
          (available.length ? `当前可用：\n${available.map((m) => `  - ${m}`).join('\n')}` : '（模型目录当前为空）'),
      )
    }
    const entry = pickModel(this.models, id)
    if (!entry) {
      throw new Error(
        `选中的模型「${id}」已不在模型目录里（可能被移动或删除）。当前可用：${
          this.models.map((m) => m.id).join('、') || '（空）'
        }`,
      )
    }
    if (!entry.complete) {
      throw new Error(`模型「${entry.displayName}」分片不完整，缺少：${entry.missing.join('、') || '（未知）'}`)
    }
    if (!existsSync(entry.path)) {
      throw new Error(`模型文件不存在：${entry.path}`)
    }
    return entry
  }

  /** 空闲计时的唯一时间源：每个请求开始/结束、加载完成、卸载完成都会刷新。 */
  touch(): void {
    this.lastActivityAt = Date.now()
    this.emit()
  }

  /**
   * 启动后核对「实际生效的上下文」。
   *
   * `--fit` 会在显存紧张时把上下文调小，而 dsh 侧声明的是原值。两者不一致时，
   * 长会话会在超出实际 ctx 后中断，且现场看不出原因 —— 因此这里主动对一次账。
   */
  private async reconcileContext(port: number): Promise<void> {
    const fromProps = await fetchServerContext(this.config.host, port)
    const effective = fromProps ?? extractEffectiveContext(this.server?.logTail.join('\n') ?? '')
    if (effective === null) return

    this.effectiveContext = effective
    this.emit()

    if (effective < this.config.contextWindow) {
      this.log.warn(
        `llama.cpp 实际生效的上下文是 ${effective}，小于 dsh 侧声明的 ${this.config.contextWindow}。` +
          '这通常是因为显存自适应（--fit）把上下文压小了。为避免长会话在中途断掉，' +
          `建议把「设置 → 本地模型 → 声明上下文」改成不超过 ${effective}，或者调小模型/量化以腾出显存。`,
      )
    } else if (effective > this.config.contextWindow) {
      this.log.debug(`llama.cpp 实际上下文 ${effective}，不低于声明的 ${this.config.contextWindow}`)
    }
  }

  private armTicker(): void {
    if (this.ticker) return
    if (this.config.idleUnloadMs <= 0) {
      this.log.info('空闲卸载已关闭（idleUnloadMinutes = 0）')
      return
    }
    const period = Math.max(2000, Math.min(15_000, Math.floor(this.config.idleUnloadMs / 4)))
    this.ticker = setInterval(() => this.tick(), period)
    this.ticker.unref?.()
    this.log.info(`空闲卸载已启用：连续 ${this.config.idleUnloadMinutes} 分钟无对话交互即释放模型`)
  }

  /** 配置变了（可能关掉了自动卸载、或改了时长），重排定时器。 */
  private restartTicker(): void {
    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
    if (!this.disposed && this.config.enabled) this.armTicker()
  }

  private tick(): void {
    if (this.disposed) return
    const now = Date.now()
    this.lastTickAt = now
    if (
      !shouldUnload({
        state: this.state,
        activeRequests: this.activeRequests,
        idleUnloadMs: this.config.idleUnloadMs,
        lastActivityAt: this.lastActivityAt,
        now,
      })
    ) {
      return
    }
    const minutes = ((now - this.lastActivityAt) / 60_000).toFixed(1)
    this.log.info(`空闲 ${minutes} 分钟无对话交互，准备卸载模型`)
    void this.unload(`空闲 ${minutes} 分钟无对话交互`).catch((error) => {
      // unload 抛错绝不能让 ticker 死掉 —— 下一轮 tick 仍要重试。
      this.log.warn(`空闲卸载失败（${(error as Error).message}），下一轮 tick 会重试`)
    })
  }

  private setState(state: RuntimeState): void {
    this.state = state
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // 订阅者自己的异常不应该影响运行时。
      }
    }
  }
}

function dirnameOf(file: string): string {
  const index = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return index > 0 ? file.slice(0, index) : '.'
}

/**
 * 把 llama-server 的失败原因翻译成可读错误。
 *
 * 优先调用 `diagnoseLoadFailure`：它知道十几种典型错误模式（OOM、--fit 被钉住、
 * --flash-attn 形状不对、模型分片缺失、架构不支持等），命中就直接给出「结论 + 建议」，
 * 不再让用户对着几十行 GGML_ASSERT 排查。认不出来时回退到原错误信息加日志尾巴，
 * 保留排查线索但不会让用户完全看到一堆未加工的英文。
 */
function explainServerFailure(logTail: string, original: Error, config: ResolvedConfig): string {
  const gpuLayersPinned = config.gpuLayersMode === 'custom' || config.gpuLayersMode === 'all'
  const diagnosis = diagnoseLoadFailure(logTail, { gpuLayersPinned })

  if (diagnosis) {
    const lines = [diagnosis.summary]
    for (const action of diagnosis.actions) lines.push(`  · ${action}`)
    if (diagnosis.evidence) lines.push(`（判据：${diagnosis.evidence}）`)
    if (logTail.trim()) {
      const tail = logTail.trim().split(/\r?\n/).slice(-3).join('\n')
      lines.push('', '最近日志尾巴：', tail)
    }
    return lines.join('\n')
  }

  const message = original?.message?.trim() || 'llama-server 退出但未给出可读原因'
  const tail = logTail.trim().split(/\r?\n/).slice(-6)
  if (tail.length === 0) return message
  return `${message}\n最近日志：\n${tail.join('\n')}`
}
