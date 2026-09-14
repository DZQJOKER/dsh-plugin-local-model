import type { LogLevel } from './log.js'
import type { LocalModelConfig } from './config.js'
import { resolveLayout, type PluginPaths } from './paths.js'
import { normalizeCacheType, normalizeFlashAttn, normalizeGpuLayersMode } from './llama/args.js'

export interface ResolvedConfig extends LocalModelConfig {
  paths: PluginPaths
  /** 空闲卸载毫秒数，0 表示关闭。 */
  idleUnloadMs: number
}

/**
 * 这一层刻意不 import schemastery。
 *
 * 好处有三：
 *   1. 配置解析是「启动逻辑稳定可靠」里最容易出回归的一环，独立成纯模块才能被单测钉死；
 *   2. 它不依赖任何宿主包，可以在 dsh 之外直接跑（见 scripts/selftest.mjs）；
 *   3. 用户如果用纯 JS 配置挂载插件，schema 可能没参与校验，这里仍能兜住。
 */
export function defaultConfig(): LocalModelConfig {
  return {
    enabled: true,
    modelsDir: '',
    runtimeDir: '',
    llamaServerPath: '',
    selectedModel: '',
    mmprojFile: '',
    preload: false,
    host: '127.0.0.1',
    port: 18080,
    llamaPort: 0,
    ctxSize: 8192,
    gpuLayers: -1,
    gpuLayersMode: 'auto',
    threads: 0,
    threadsBatch: 0,
    batchSize: 2048,
    ubatchSize: 512,
    flashAttention: 'auto',
    cacheTypeK: 'q8_0',
    cacheTypeV: 'q8_0',
    jinja: true,
    chatTemplate: '',
    enableThinking: true,
    preserveThinking: true,
    mmap: true,
    mlock: false,
    apiKey: '',
    extraArgs: '',
    envOverrides: {},
    idleUnloadMinutes: 5,
    startupTimeoutMs: 180_000,
    shutdownGraceMs: 8000,
    autoRestart: true,
    maxRestarts: 2,
    routeName: 'local-llama',
    modelAlias: 'local',
    routeModelId: 'local',
    contextWindow: 32768,
    maxTokens: 8192,
    registerRoute: true,
    exposeTool: true,
    allowModelControl: false,
    logLevel: 'info',
  }
}

export function clamp(value: number, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * 布尔收敛：只有明确的「假」才判为关闭，其余无法识别的值一律回落到 fallback。
 *
 * 为什么需要它：组合层（cordis.patch.yml / 手写 JS 配置）不经过 Web 侧的写入闸门，
 * 一个字符串 `"false"` 直接用 `!== false` 判断会变成「开启」—— 开关方向反了是最难查的一类 bug。
 */
export function normalizeBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1' || value === 'true' || value === 'yes') return true
  if (value === 0 || value === '0' || value === 'false' || value === 'no') return false
  return fallback
}

export function logLevelOf(value: string | undefined): LogLevel {
  return value === 'silent' || value === 'error' || value === 'warn' || value === 'debug' ? value : 'info'
}

export function isAutoUnloadDisabled(minutes: number): boolean {
  return !Number.isFinite(minutes) || minutes <= 0
}

/**
 * 把用户配置收敛成一份可用的运行配置：
 * - 缺字段用默认值兜底；
 * - 目录一律解析成绝对路径，相对路径相对 $DSH_HOME 而不是进程 cwd（cwd 会随启动方式漂移）；
 * - 数值做区间收敛，避免把互相矛盾的参数丢给 llama-server。
 */
export function resolveConfig(input: Partial<LocalModelConfig> | undefined, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const defaults = defaultConfig()
  const merged: LocalModelConfig = { ...defaults, ...(input ?? {}) }
  const paths = resolveLayout({ modelsDir: merged.modelsDir, runtimeDir: merged.runtimeDir }, env)
  const idleUnloadMinutes = clamp(merged.idleUnloadMinutes, 0, 60 * 24 * 365, defaults.idleUnloadMinutes)

  return {
    ...merged,
    modelsDir: paths.modelsDir,
    runtimeDir: paths.runtimeDir,
    // 视觉投影：这里只做 trim，真正的优先级（显式选择 → 自动关联）在 registry.resolveVisionProjector。
    mmprojFile: (merged.mmprojFile ?? '').trim(),
    enableThinking: normalizeBool(merged.enableThinking, defaults.enableThinking),
    preserveThinking: normalizeBool(merged.preserveThinking, defaults.preserveThinking),
    host: (merged.host || defaults.host).trim(),
    port: clamp(merged.port, 1, 65535, defaults.port),
    llamaPort: clamp(merged.llamaPort, 0, 65535, defaults.llamaPort),
    ctxSize: clamp(merged.ctxSize, 512, 1_048_576, defaults.ctxSize),
    gpuLayers: clamp(merged.gpuLayers, -1, 4096, defaults.gpuLayers),
    gpuLayersMode: normalizeGpuLayersMode(merged.gpuLayersMode),
    threads: clamp(merged.threads, 0, 1024, defaults.threads),
    threadsBatch: clamp(merged.threadsBatch, 0, 1024, defaults.threadsBatch),
    batchSize: clamp(merged.batchSize, 0, 1_048_576, defaults.batchSize),
    ubatchSize: clamp(merged.ubatchSize, 0, 1_048_576, defaults.ubatchSize),
    idleUnloadMinutes,
    idleUnloadMs: idleUnloadMinutes * 60_000,
    startupTimeoutMs: clamp(merged.startupTimeoutMs, 5_000, 3_600_000, defaults.startupTimeoutMs),
    shutdownGraceMs: clamp(merged.shutdownGraceMs, 500, 120_000, defaults.shutdownGraceMs),
    maxRestarts: clamp(merged.maxRestarts, 0, 10, defaults.maxRestarts),
    contextWindow: clamp(merged.contextWindow, 512, 1_048_576, defaults.contextWindow),
    maxTokens: clamp(merged.maxTokens, 64, 131_072, defaults.maxTokens),
    routeName: (merged.routeName || defaults.routeName).trim(),
    modelAlias: (merged.modelAlias || defaults.modelAlias).trim(),
    routeModelId: (merged.routeModelId || merged.modelAlias || defaults.routeModelId).trim(),
    envOverrides: { ...(merged.envOverrides ?? {}) },
    logLevel: logLevelOf(merged.logLevel),
    // 历史配置里这一项是布尔值，这里统一收敛成三态（true → on / false → off / 其余 → auto）。
    flashAttention: normalizeFlashAttn(merged.flashAttention),
    // KV cache 类型即使设了非法值也收敛成 q8_0，**绝不**回落到 'auto'（那等于让 f16 占满显存，违背默认保护）。
    cacheTypeK: normalizeCacheType(merged.cacheTypeK),
    cacheTypeV: normalizeCacheType(merged.cacheTypeV),
    paths,
  }
}
