import type { LogLevel } from './log.js'
import type { LocalModelConfig } from './config.js'
import { resolveLayout, type PluginPaths } from './paths.js'
import { normalizeCacheType, normalizeFlashAttn, normalizeGpuLayersMode } from './llama/args.js'

export interface ResolvedConfig extends LocalModelConfig {
  paths: PluginPaths
  /** 空闲卸载毫秒数，0 表示关闭。 */
  idleUnloadMs: number
}

/*
 * ── 原「接入 dsh」那一组设置，现已从 schema 删除、改为常量 ─────────────────────
 *
 * 这几个值本来就不该由用户在界面上调：dsh 侧的 settings.yaml 是按名字引用它们的，
 * 改一次就要同步改另一侧。用户要求删掉那一整组设置，这里把它们固定成原来的默认值 ——
 * 因此行为与默认安装完全一致，只是从此不可配置。
 *
 * 放在本文件（而不是 config.ts）是因为这一层**不 import schemastery**：
 * scripts/ 下的自检脚本需要能在没有宿主依赖的环境里 import 它们。
 */

/** llama-server 对外暴露的模型别名（--alias），同时用于路由展示名。 */
export const DEFAULT_MODEL_ALIAS = 'local'

/** 本地路由在 dsh 侧注册用的路由名（pi-ai provider 的 key）。 */
export const LOCAL_ROUTE_NAME = 'local-llama'

/** dsh 模型选择器里的模型 id。 */
export const LOCAL_MODEL_ID = 'local'

/**
 * local_model 工具是否暴露给模型（原 `exposeTool` 设置）。
 * 保留原默认值 true：设置页不再提供开关，行为与默认安装一致。
 */
export const EXPOSE_LOCAL_MODEL_TOOL = true

/**
 * 是否允许模型通过 local_model 工具启停模型（原 `allowModelControl` 设置）。
 *
 * 保留原默认值 false：装载/卸载显存属于用户该拍板的资源决策。
 * 注意这是**能力上的取舍** —— 设置项被删除后，这一条从此不可配置。
 */
export const ALLOW_MODEL_CONTROL = false

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
    mtp: false,
    // 默认允许 MTP 与视觉共存：kvmem 分支实测支持，而这一侧的用户几乎都用它。
    // 官方 llama.cpp 那里两者不能共存，用户把本项关掉即可恢复旧的互斥行为。
    mtpWithVision: true,
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
    kvUnified: false,
    kvStreamStageMib: 1024,
    // KVMem 家族的默认值统一是「不下发」（-1 / 空串 / 构建默认），
    // 因此官方 llama.cpp 用户的行为与加这些字段之前完全一致。
    kvmemEnabled: true,
    kvmemBudget: -1,
    kvmemGenReserve: -1,
    kvmemBlockTokens: -1,
    kvmemSinkTokens: -1,
    kvmemRecentTokens: -1,
    kvmemMethod: '',
    kvmemQueryLast: -1,
    kvmemQueryMaxTokens: -1,
    kvmemQueryReplay: '',
    kvmemQueryPolicy: '',
    kvmemMtpState: '',
    kvmemGpuRatio: -1,
    kvmemCpuGb: -1,
    kvmemNvmeGb: -1,
    kvmemNvmeDir: '',
    kvmemHarvestV: false,
    kvmemRawKNvme: false,
    nPredict: -1,
    loadMode: '',
    kvDtype: '',
    specKvDtype: '',
    specDraftNMax: -1,
    specDraftPMin: -1,
    frequencyPenalty: 0,
    mmprojOffload: true,
    chatTemplateFile: '',
    chatTemplateKwargs: '',
    reasoningEffort: '',
    reasoningBudgetMessage: '',
    guardContextOverflow: true,
    temp: 0.75,
    topK: 20,
    topP: 0.95,
    minP: 0,
    presencePenalty: 0,
    repeatPenalty: 1,
    repeatLastN: 64,
    seed: -1,
    imageMinTokens: 1024,
    imageMaxTokens: 4096,
    reasoningBudget: 4096,
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
    maxTokens: 8192,
    logLevel: 'info',
  }
}

export function clamp(value: number, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * 小数版 clamp：**不取整**。
 *
 * 为什么必须单独有一个：`clamp()` 里的 `Math.round` 对整数参数是对的，但用在采样参数上
 * 会静默毁掉它们 —— `temp 0.75 → 1`、`top-p 0.95 → 1`、`min-p 0.05 → 0`，
 * 而且没有任何报错，只会表现为「设了没反应」。
 */
export function clampFloat(value: number, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, n))
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
 * 字符串枚举收敛：不在白名单里的一律回落到 fallback（通常是空串 = 不下发）。
 *
 * 为什么必须有这一层：这些值是**直接拼进子进程命令行**的，而命令行里一个拼错的取值
 * 不是「被忽略」，而是让整个服务起不来（`invalid --kvmem-method: xxxx` + exit 1）。
 * 写入门（configStore）只按类型放行、不认取值，所以唯一的收敛点就是这里。
 *
 * 空串永远是合法取值：在本插件里它表示「不下发这一项」。
 */
export function normalizeChoice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof value !== 'string') return fallback
  const lower = value.trim().toLowerCase()
  return (allowed as readonly string[]).includes(lower) ? (lower as T) : fallback
}

/** 把用户配置收敛成一份可用的运行配置：
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
    // MTP 与视觉投影互斥；互斥本身由 args.ts 的拼参数层强制，这里只负责把开关收敛成布尔。
    mtp: normalizeBool(merged.mtp, defaults.mtp),
    mtpWithVision: normalizeBool(merged.mtpWithVision, defaults.mtpWithVision),
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
    maxTokens: clamp(merged.maxTokens, 64, 131_072, defaults.maxTokens),
    // 采样参数：区间只做「明显荒谬值」的兜底，不替用户裁决风格。
    // 小数项一律走 clampFloat —— clamp 会四舍五入，用它会把 0.75 变成 1。
    temp: clampFloat(merged.temp, 0, 100, defaults.temp),
    topK: clamp(merged.topK, 0, 1_048_576, defaults.topK),
    topP: clampFloat(merged.topP, 0, 1, defaults.topP),
    minP: clampFloat(merged.minP, 0, 1, defaults.minP),
    presencePenalty: clampFloat(merged.presencePenalty, -10, 10, defaults.presencePenalty),
    repeatPenalty: clampFloat(merged.repeatPenalty, 0, 10, defaults.repeatPenalty),
    // -1 = 沿用整个上下文长度（llama.cpp 语义），0 = 关闭重复惩罚。
    repeatLastN: clamp(merged.repeatLastN, -1, 1_048_576, defaults.repeatLastN),
    seed: clamp(merged.seed, -1, 2_147_483_647, defaults.seed),
    // KV 流式暂存：0 = 不下发（这是唯一能给「关掉」的表达，因为 0 MiB 暂存本身没有意义）。
    kvStreamStageMib: clamp(merged.kvStreamStageMib, 0, 1_048_576, defaults.kvStreamStageMib),
    kvUnified: normalizeBool(merged.kvUnified, defaults.kvUnified),

    // ── KVMem 家族与新增启动项 ──────────────────────────────────────────────
    // 这一整组用 **-1 = 不下发** 的哨兵，而不是 kvStreamStageMib 那套「0 = 不下发」。
    // 原因是它们的 0 几乎都是有意义的取值：--kvmem-budget 0 = 取 n_ctx、
    // --kvmem-cpu-gb 0 = 关闭溢出场、--kvmem-recent-tokens 0 = 不额外保留。
    // 用 0 当哨兵会让「显式关闭」和「不下发」两件事无法区分。
    // 负数在这些选项的取值域里一律非法，因此是天然安全的哨兵。
    kvmemEnabled: normalizeBool(merged.kvmemEnabled, defaults.kvmemEnabled),
    kvmemBudget: clamp(merged.kvmemBudget, -1, 1_048_576, defaults.kvmemBudget),
    kvmemGenReserve: clamp(merged.kvmemGenReserve, -1, 1_048_576, defaults.kvmemGenReserve),
    kvmemBlockTokens: clamp(merged.kvmemBlockTokens, -1, 1_048_576, defaults.kvmemBlockTokens),
    kvmemSinkTokens: clamp(merged.kvmemSinkTokens, -1, 1_048_576, defaults.kvmemSinkTokens),
    kvmemRecentTokens: clamp(merged.kvmemRecentTokens, -1, 1_048_576, defaults.kvmemRecentTokens),
    kvmemMethod: normalizeChoice(merged.kvmemMethod, ['', 'recency', 'retrieval'] as const, ''),
    kvmemQueryLast: clamp(merged.kvmemQueryLast, -1, 1_048_576, defaults.kvmemQueryLast),
    kvmemQueryMaxTokens: clamp(merged.kvmemQueryMaxTokens, -1, 1_048_576, defaults.kvmemQueryMaxTokens),
    kvmemQueryReplay: normalizeChoice(merged.kvmemQueryReplay, ['', 'legacy', 'auto'] as const, ''),
    kvmemQueryPolicy: normalizeChoice(merged.kvmemQueryPolicy, ['', 'legacy', 'user'] as const, ''),
    kvmemMtpState: normalizeChoice(merged.kvmemMtpState, ['', 'snapshots', 'auto', 'replay'] as const, ''),
    // 比例项走 clampFloat：clamp 会四舍五入，用它会把手填的 0.8 变成 1。
    kvmemGpuRatio: clampFloat(merged.kvmemGpuRatio, -1, 1, defaults.kvmemGpuRatio),
    kvmemCpuGb: clampFloat(merged.kvmemCpuGb, -1, 4096, defaults.kvmemCpuGb),
    kvmemNvmeGb: clampFloat(merged.kvmemNvmeGb, -1, 4096, defaults.kvmemNvmeGb),
    kvmemNvmeDir: (merged.kvmemNvmeDir ?? '').trim(),
    kvmemHarvestV: normalizeBool(merged.kvmemHarvestV, defaults.kvmemHarvestV),
    kvmemRawKNvme: normalizeBool(merged.kvmemRawKNvme, defaults.kvmemRawKNvme),
    nPredict: clamp(merged.nPredict, -1, 1_048_576, defaults.nPredict),
    loadMode: normalizeChoice(merged.loadMode, ['', 'auto', 'none', 'mmap', 'mlock', 'mmap+mlock', 'dio'] as const, ''),
    kvDtype: normalizeChoice(merged.kvDtype, ['', 'f16', 'f32', 'q8_0', 'q5_0', 'q4_0'] as const, ''),
    specKvDtype: normalizeChoice(merged.specKvDtype, ['', 'f16', 'f32', 'q8_0', 'q5_0', 'q4_0'] as const, ''),
    specDraftNMax: clamp(merged.specDraftNMax, -1, 1024, defaults.specDraftNMax),
    specDraftPMin: clampFloat(merged.specDraftPMin, -1, 1, defaults.specDraftPMin),
    frequencyPenalty: clampFloat(merged.frequencyPenalty, -2, 2, defaults.frequencyPenalty),
    mmprojOffload: normalizeBool(merged.mmprojOffload, defaults.mmprojOffload),
    chatTemplateFile: (merged.chatTemplateFile ?? '').trim(),
    chatTemplateKwargs: (merged.chatTemplateKwargs ?? '').trim(),
    reasoningEffort: normalizeChoice(
      merged.reasoningEffort,
      ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const,
      '',
    ),
    reasoningBudgetMessage: (merged.reasoningBudgetMessage ?? '').trim(),
    guardContextOverflow: normalizeBool(merged.guardContextOverflow, defaults.guardContextOverflow),
    // 图像 token 预算：max >= min 的收敛放在 args.ts 的拼参数层（与 -ub <= -b 同一处），避免两处规则漂移。
    imageMinTokens: clamp(merged.imageMinTokens, 0, 1_048_576, defaults.imageMinTokens),
    imageMaxTokens: clamp(merged.imageMaxTokens, 0, 1_048_576, defaults.imageMaxTokens),
    // -1 = 不限预算。
    reasoningBudget: clamp(merged.reasoningBudget, -1, 1_048_576, defaults.reasoningBudget),
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

/**
 * 加载前的配置一致性检查：把「两个数字对不上」这类**一定会出问题**的组合提前说出来。
 *
 * 为什么值得单独做一层：这些数字分散在三个地方（dsh 路由声明、llama-server 启动参数、
 * kvmem 的解码预留），任何两处对不上都不会在加载时报错，而是等到某次对话才以一条
 * 难以解读的服务端错误冒出来。实测那一次就是这样 —— 路由里声明 maxTokens=128000、
 * 服务端却以 -c 32768 启动，于是**每一条**消息都 400，而报错里只有
 * `prompt + max_tokens exceeds n_ctx`，既没给 prompt 长度也没给 n_ctx。
 *
 * 只返回文字，不擅自改配置：这三个数字的取舍（省显存 / 要长回答 / 要多长上下文）
 * 是用户自己的决定，插件该做的是把后果讲清楚。纯函数，便于单测。
 */
export function consistencyNotices(config: {
  ctxSize: number
  maxTokens: number
  kvmemGenReserve: number
}): string[] {
  const notices: string[] = []
  const { ctxSize, maxTokens, kvmemGenReserve } = config

  if (Number.isFinite(ctxSize) && Number.isFinite(maxTokens) && ctxSize > 0) {
    if (maxTokens >= ctxSize) {
      notices.push(
        `「单次最大输出 tokens」（${maxTokens}）不小于「上下文长度」（${ctxSize}）：` +
          '提示词本身至少要占 1 个 token，这类请求**一定**放不下。' +
          'kvmem 分支的独立 server 会直接回 400（prompt + max_tokens exceeds n_ctx），' +
          `上游 llama.cpp 则是打一条 warning 再自行收敛。请把它调到 ${Math.max(512, Math.floor(ctxSize / 4))} 一类的值。`,
      )
    } else if (maxTokens > ctxSize / 2) {
      notices.push(
        `「单次最大输出 tokens」（${maxTokens}）超过了上下文长度的一半（${ctxSize}）：` +
          '留不出多少空间给提示词 + 历史，长会话很容易在对话中途开始报「上下文放不下」。' +
          `建议降到 ${Math.floor(ctxSize / 4)} 左右。`,
      )
    }
  }

  if (kvmemGenReserve >= 0 && Number.isFinite(maxTokens) && maxTokens > kvmemGenReserve) {
    notices.push(
      `「解码预留」（--kvmem-gen-reserve = ${kvmemGenReserve}）小于「单次最大输出 tokens」（${maxTokens}）：` +
        '解码预留是 kvmem 里**单次生成的上限**（含思考），模型每轮最多只能写这么多 token，' +
        '多出来的部分会被硬截断且没有任何报错。请把解码预留调到不小于单次最大输出 tokens。',
    )
  }

  return notices
}
