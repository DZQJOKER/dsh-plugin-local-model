/**
 * llama-server 启动参数拼装。
 *
 * 刻意做成纯函数：不碰进程、不碰 fs，输入确定则输出确定 —— 这是「启动逻辑稳定可靠」
 * 里最容易被回归破坏的一环，独立出来才能被单测钉死。
 */
import type { FlashAttnMode } from './capabilities.js'

/** llama.cpp 的 Flash Attention 三态。与 `-fa, --flash-attn [on|off|auto]` 对齐。 */
export type FlashAttnSetting = 'auto' | 'on' | 'off'

/**
 * GPU 层数策略。与 `-ngl, --gpu-layers ... either an exact number, 'auto', or 'all'` 对齐。
 *
 * `auto` 是默认值，原因很具体：新版 llama.cpp 的 `--fit` 会按可用显存自动调整
 * **用户没有显式设置**的参数。一旦把层数钉成具体数字，自适应就被跳过 ——
 * 模型放不下时，行为从「优雅降级（少放几层）」变成「直接 OOM 崩溃」。
 */
export type GpuLayersMode = 'auto' | 'all' | 'custom'

export interface LlamaServerArgInput {
  /** -m 模型文件（分片模型传第一片）。 */
  modelPath: string
  host: string
  port: number
  /** --alias：固定对外暴露的模型名，让 dsh 侧的路由配置不必随模型文件变化。 */
  alias: string
  ctxSize: number
  gpuLayersMode: GpuLayersMode
  /** 仅在 gpuLayersMode = custom 时生效；负数表示「全部层」。 */
  gpuLayers: number
  /** 该构建的 -ngl 是否接受 'auto' / 'all' 关键字（由 --help 探测得到）。 */
  gpuLayersSupport: { auto: boolean; all: boolean }
  threads: number
  threadsBatch: number
  batchSize: number
  ubatchSize: number
  flashAttention: FlashAttnSetting
  /** 该构建的 --flash-attn 接受哪种形状（由 --help 探测得到）。 */
  flashAttnMode: FlashAttnMode
  /** K 缓冲的量化精度；'auto' = 不下发（用 llama.cpp 默认 f16）。未传视为 q8_0。 */
  cacheTypeK?: string
  /** V 缓冲的量化精度；'auto' = 不下发。未传视为 q8_0。 */
  cacheTypeV?: string
  /** 统一的 KV 缓存管理策略（--kv-unified）。 */
  kvUnified: boolean
  /** --kv-stream-stage-mib；0 = 不下发。 */
  kvStreamStageMib: number
  /**
   * 服务端默认输出上限（-n / --n-predict）。负数 = 不下发。
   *
   * 与配置里的 `maxTokens` 不是一回事：那个是 dsh 路由声明、最终体现为**每次请求**的
   * `max_tokens`；这个是**没带 max_tokens 的请求**的兜底上限。kvmem 那个独立 server 上
   * 它默认是 128，小得离谱 —— 任何绕过 dsh 的调用（curl、脚本、别的客户端）都只会吐 128 个 token。
   */
  nPredict: number
  /** 权重加载方式（-lm / --load-mode）：auto|none|mmap|mlock|mmap+mlock|dio。空串 = 不下发。 */
  loadMode: string
  /** 频率惩罚（--frequency-penalty）；0 = 不下发（0 即不惩罚，与构建默认一致）。 */
  frequencyPenalty: number
  /** MTP 草稿的 K/V 精度（--spec-kv-dtype）。空串 = 不下发。 */
  specKvDtype: string
  /** MTP 单次草稿 token 数（--spec-draft-n-max）。负数 = 不下发。 */
  specDraftNMax: number
  /** MTP 草稿最小接受概率（--spec-draft-p-min）。负数 = 不下发。 */
  specDraftPMin: number
  /** GPU KV 缓存类型（--kv-dtype，kvmem 分支的合并写法，一次设 K 和 V）。空串 = 不下发。 */
  kvDtype: string
  /** 视觉编码器放 GPU（true = 构造默认，不下发；false = 下发 --no-mmproj-offload 放 CPU）。 */
  mmprojOffload: boolean
  /** 模板文件路径（--chat-template-file）。空串 = 不下发。 */
  chatTemplateFile: string
  /** 模板默认参数（--chat-template-kwargs，JSON 文本）。空串 = 不下发。 */
  chatTemplateKwargs: string
  /** 服务端默认推理档位（--reasoning-effort）。空串 = 不下发。 */
  reasoningEffort: string
  /** 预算耗尽时注入的过渡语（--reasoning-budget-message）。空串 = 不下发。 */
  reasoningBudgetMessage: string

  // ── KVMem 分块 KV 检索（kvmem/kvmem-llama.cpp 分支专有）────────────────────
  /**
   * 是否启用 KVMem（true = 构建默认，不下发；false = 下发 --no-kvmem 退回普通 KV 缓存）。
   */
  kvmemEnabled: boolean
  /** GPU 工作集 token 数（--kvmem-budget）。负数 = 不下发（构建默认 0 = 等于 n_ctx）。 */
  kvmemBudget: number
  /**
   * 解码预留（--kvmem-gen-reserve）：**单次生成的上限**（含思考）。
   *
   * 🔴 这个构建的默认值只有 256 —— 也就是说不开这一项，每次回复最多只能生成 256 个 token。
   * 负数 = 不下发。
   */
  kvmemGenReserve: number
  /** 检索块大小（--kvmem-block-tokens）。负数 = 不下发。 */
  kvmemBlockTokens: number
  /** 常驻前缀 token 数（--kvmem-sink-tokens）。负数 = 不下发。 */
  kvmemSinkTokens: number
  /** 常驻后缀 token 数（--kvmem-recent-tokens）。负数 = 不下发。 */
  kvmemRecentTokens: number
  /** 选择算法：recency | retrieval（--kvmem-method）。空串 = 不下发。 */
  kvmemMethod: string
  /** 检索查询取提示词末尾多少 token（--kvmem-query-last）。负数 = 不下发。 */
  kvmemQueryLast: number
  /** 检索查询的上限 token 数（--kvmem-query-max-tokens）。负数 = 不下发。 */
  kvmemQueryMaxTokens: number
  /** 查询重放模式：legacy | auto（--kvmem-query-replay）。空串 = 不下发。 */
  kvmemQueryReplay: string
  /** 查询策略：legacy | user（--kvmem-query-policy）。空串 = 不下发。 */
  kvmemQueryPolicy: string
  /** MTP 状态模式：snapshots | auto | replay（--kvmem-mtp-state）。空串 = 不下发。 */
  kvmemMtpState: string
  /** 槽池占显存的比例上限（--kvmem-gpu-ratio，如 0.8）。负数 = 不下发（构建默认 0.50）。 */
  kvmemGpuRatio: number
  /** CPU 溢出场大小 GiB（--kvmem-cpu-gb）。负数 = 不下发（构建默认 0 = 关闭）。 */
  kvmemCpuGb: number
  /** NVMe 溢出场大小 GiB（--kvmem-nvme-gb）。负数 = 不下发（构建默认 0 = 关闭）。 */
  kvmemNvmeGb: number
  /** NVMe 溢出场目录（--kvmem-nvme-dir）。空串 = 不下发。 */
  kvmemNvmeDir: string
  /** 用原始 K 预填 V 到主机内存（--kvmem-harvest-v，裸开关）。 */
  kvmemHarvestV: boolean
  /** 把原始 K 与 V 落到 NVMe（--kvmem-raw-k-nvme，需要 --kvmem-nvme-gb）。 */
  kvmemRawKNvme: boolean
  /** 采样参数：全部按配置显式下发（它们的默认值就是用户指定的值）。 */
  temp: number
  topK: number
  topP: number
  minP: number
  presencePenalty: number
  repeatPenalty: number
  repeatLastN: number
  seed: number
  /** 每张图的最少/最多 token 数（--image-min-tokens / --image-max-tokens）；0 = 不下发该项。 */
  imageMinTokens: number
  imageMaxTokens: number
  /** 推理 token 预算（--reasoning-budget）。0 = 关掉思考，-1 = 不限。 */
  reasoningBudget: number
  /**
   * 这个构建在 `--help` 里公开的选项名集合。
   *
   * `null` = 探测失败/未知。
   *
   * 探测成功时它决定**每一个**选项怎么下发，两档严格程度：
   *   - 只有较新构建/特定分支才有的选项（--kv-unified / --kv-stream-stage-mib /
   *     --image-*-tokens / --reasoning-budget）走严格门控：探测失败也不下发；
   *   - 其余选项（--alias / -t / -ub / --no-mmap / --api-key / 采样参数……）走宽松门控：
   *     只有构建**明确不公开**时才跳过。不认识选项的分支不是忽略它，而是
   *     `unknown flag: xxx` + exit 1 直接起不来；实测那个 kvmem 独立 server 就是如此。
   */
  knownFlags: ReadonlySet<string> | null
  /** --jinja：OpenAI 风格 function calling 依赖它，默认开。 */
  jinja: boolean
  chatTemplate: string
  mmproj: string
  /**
   * 多 Token 预测（MTP）：下发 `--spec-type draft-mtp`。
   *
   * 与 `mmproj` 的关系由 `mtpWithVision` 决定 —— 上游 llama.cpp 里两者不能共存，
   * 但 kvmem 分支的 llama-kvmem-server 可以（本机实测同时加载成功）。
   */
  mtp: boolean
  /**
   * 允许 MTP 与视觉投影同时下发（默认开）。
   *
   * 关掉时恢复旧的互斥行为：MTP 生效、`--mmproj` 被忽略并给出说明。
   */
  mtpWithVision: boolean
  mmap: boolean
  mlock: boolean
  apiKey: string
  /** 原生附加参数，按 shell 规则分词。 */
  extraArgs: string
}

export const DEFAULT_ALIAS = 'local'

export interface BuiltLlamaArgs {
  args: string[]
  /** 本次下发的选项名（不含值、不含 extraArgs）。用来和 --help 对照，提前发现不认识的选项。 */
  usedFlags: string[]
  /** 有参数因为构建形状不支持而没能下发时的说明，交给调用方记日志。 */
  notices: string[]
}

/** 兼容历史布尔值：true → on，false → off；无法识别的一律回到 auto。 */
export function normalizeFlashAttn(value: unknown): FlashAttnSetting {
  if (value === true || value === 'on' || value === 'true') return 'on'
  if (value === false || value === 'off' || value === 'false') return 'off'
  return 'auto'
}

/**
 * KV cache 量化精度。
 *
 * 关键事实：长上下文时 **KV cache 是显存大头**，比模型权重还吃 —— 27B 模型在 16K ctx 下
 * KV cache 的 f16 表示是几个 GB，q8 直接减半。这是大模型最容易 OOM 的隐藏点：
 * 显存够装下模型 + 默认 f16 KV，但装不下模型 + 长 ctx + f16 KV。手动用 q8 减半就装得下。
 *
 * 'auto' 永远不下发（让 llama.cpp 用默认 f16），给专家路径用。
 */
export type KvCacheType = 'auto' | 'f16' | 'q8_0' | 'q4_0' | 'q4_1' | 'q5_0' | 'q5_1' | 'bf16' | 'f32' | 'iq4_nl'

const KV_CACHE_TYPES = new Set<string>([
  'auto', 'f16', 'q8_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'bf16', 'f32', 'iq4_nl',
])

export function normalizeCacheType(value: unknown): KvCacheType {
  if (typeof value !== 'string') return 'q8_0'
  const lower = value.trim().toLowerCase()
  if (KV_CACHE_TYPES.has(lower)) return lower as KvCacheType
  return 'q8_0'
}

export function normalizeGpuLayersMode(value: unknown): GpuLayersMode {
  if (value === 'all') return 'all'
  if (value === 'custom') return 'custom'
  return 'auto'
}

/**
 * GPU 层数的下发规则。
 *
 * - `auto`：优先下发 `-ngl auto`（把卸载决策交给 llama.cpp 的 --fit 按可用显存自适应）。
 *   构建不认这个关键字时退回 `-ngl -1`（全部上，即老行为），并出一句说明 ——
 *   老构建上不下发 -ngl 会退化成纯 CPU，那是比「全部上」糟糕得多的意外。
 * - `all`：`-ngl all`，不支持则 `-ngl -1`。
 * - `custom`：`-ngl <数字>`；负数按「全部」处理。
 */
export function gpuLayersArgs(
  mode: GpuLayersMode,
  layers: number,
  support: { auto: boolean; all: boolean },
): { args: string[]; notice: string | null } {
  if (mode === 'custom') {
    const value = Number.isFinite(layers) ? Math.round(layers) : 0
    if (value < 0) {
      return support.all ? { args: ['-ngl', 'all'], notice: null } : { args: ['-ngl', '-1'], notice: null }
    }
    return { args: ['-ngl', String(value)], notice: null }
  }

  if (mode === 'all') {
    return support.all
      ? { args: ['-ngl', 'all'], notice: null }
      : { args: ['-ngl', '-1'], notice: '这个构建的 -ngl 不认识 all 关键字，已下发 -1（同样表示全部层）' }
  }

  return support.auto
    ? { args: ['-ngl', 'auto'], notice: null }
    : {
        args: ['-ngl', '-1'],
        notice:
          '这个构建的 -ngl 不认识 auto 关键字（无法按显存自适应），已下发 -1（全部层）；放不下时会直接报显存不足，可改用「自定义」层数',
      }
}

/**
 * Flash Attention 的下发规则。
 *
 * 核心取舍：**auto 永远不下发**。因为 auto 在所有支持三态的构建里都等于默认值，
 * 而在只支持裸开关的老构建里根本表达不出来 —— 不下发是唯一在两种构建上语义都正确的做法。
 * 这样也顺带避开了「这个构建收不收 auto 这个字面量」的问题。
 */
export function flashAttnArgs(setting: unknown, mode: FlashAttnMode): { args: string[]; notice: string | null } {
  const value = normalizeFlashAttn(setting)
  if (value === 'auto') return { args: [], notice: null }

  if (mode === 'value') return { args: ['--flash-attn', value], notice: null }

  if (mode === 'bare') {
    return value === 'on'
      ? { args: ['--flash-attn'], notice: null }
      : { args: [], notice: '这个 llama-server 的 --flash-attn 是裸开关，无法显式关闭；已不下发该参数' }
  }

  return {
    args: [],
    notice: '无法确定这个 llama-server 的 --flash-attn 形状（探测 --help 失败），已不下发该参数；如需强制指定请用「附加参数」',
  }
}

/**
 * 把配置里的数字渲染成命令行文本。
 *
 * 为什么不能直接 `String(value)`：采样参数是小数，用户在界面上敲的 0.75 经 JSON 往返后
 * 可能是 0.7500000000000001 这类浮点噪声，直接拼进命令行既难看又可能被 llama.cpp 判为非法。
 * 统一截到 6 位有效小数再去掉尾零。
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return String(Number(value.toFixed(6)))
}

export function buildLlamaServerArgs(input: LlamaServerArgInput): BuiltLlamaArgs {
  const args: string[] = []
  const usedFlags: string[] = []
  const notices: string[] = []
  /** 严格门控跳过的选项（含「探测失败」这一类）。 */
  const skipped: string[] = []
  /** 宽松门控跳过的选项（探测成功、且这个构建确实没公开它）。 */
  const dropped: string[] = []

  const flag = (...tokens: string[]): void => {
    usedFlags.push(tokens[0]!)
    args.push(...tokens)
  }

  /**
   * 严格门控：只有「探测成功**且**构建公开了该选项」才下发。
   *
   * 用在「新版本 / 特定分支才有」的选项上（--kv-unified、--kv-stream-stage-mib、
   * --image-*-tokens、--reasoning-budget）：探测失败时宁可退回构建默认值，也不赌它认。
   */
  const gateStrict = (...tokens: string[]): boolean => {
    const name = tokens[0]!
    if (!input.knownFlags || !input.knownFlags.has(name)) {
      skipped.push(name)
      return false
    }
    flag(...tokens)
    return true
  }

  /**
   * 宽松门控：**只要是这个构建明确不认识的就跳过**；探测失败时照旧下发。
   *
   * 用在「几乎所有构建都有、但不是每个都有」的选项上：--alias、-t、--threads-batch、
   * -ub、--no-mmap、--mlock、--api-key、--cache-type-*、采样参数那一组。
   * 两条规则各自解决一个具体问题：
   *
   *   - 探测失败（knownFlags 为 null）→ **照旧下发**。这是与引入门控前完全一致的行为：
   *     一次 --help 失败就把别名、线程数、全部采样设置丢掉，比「可能不认识」糟糕得多。
   *   - 探测成功但不认识 → **跳过**。这一条不是可选项：不认识选项的分支不是「忽略它」，
   *     而是直接 `unknown flag: --alias` 然后 exit 1，整台服务起不来。
   *     实测（kvmem-v0.16.0-rc2 的独立 server）：--alias / -t / -ub / --repeat-last-n /
   *     --no-mmap / --api-key 全部是 `unknown flag: xxx` + usage + exit 1。
   *
   * 跳过的一律记进 notices，绝不静默 —— 用户看到的应该是「哪几个选项被跳过了」，
   * 而不是命令行里少了一项却毫无线索。
   */
  const gateLoose = (...tokens: string[]): boolean => {
    const name = tokens[0]!
    if (input.knownFlags && !input.knownFlags.has(name)) {
      dropped.push(name)
      return false
    }
    flag(...tokens)
    return true
  }

  // -m / --host / --port / -c 是「llama-server 兼容」的最小契约，不做门控：
  // 连这几个都没有的二进制本来就不是 llama-server，跳过它们只会拼出一条毫无意义的命令行。
  flag('-m', input.modelPath)
  flag('--host', input.host)
  flag('--port', String(input.port))
  gateLoose('--alias', input.alias)
  flag('-c', String(input.ctxSize))

  // GPU 层数：默认 auto，让 llama.cpp 的 --fit 按可用显存决定，避免「放不下就崩」。
  const gpu = gpuLayersArgs(input.gpuLayersMode, input.gpuLayers, input.gpuLayersSupport)
  if (gpu.args.length > 0) gateLoose(...gpu.args)
  if (gpu.notice) notices.push(gpu.notice)

  if (input.threads > 0) gateLoose('-t', String(input.threads))
  if (input.threadsBatch > 0) gateLoose('--threads-batch', String(input.threadsBatch))
  if (input.batchSize > 0) gateLoose('-b', String(input.batchSize))
  if (input.ubatchSize > 0) {
    // -ub 必须 <= -b，否则 llama.cpp 直接启动失败。这里就地收敛，避免把矛盾参数丢给子进程。
    const ub = input.batchSize > 0 ? Math.min(input.ubatchSize, input.batchSize) : input.ubatchSize
    gateLoose('-ub', String(ub))
  }

  const flash = flashAttnArgs(input.flashAttention, input.flashAttnMode)
  if (flash.args.length > 0) flag(...flash.args)
  if (flash.notice) notices.push(flash.notice)

  // KV cache 量化。'auto' 不下发，其它下发对应值。'auto' 与 flashAttention 的 'auto'
  // 语义一致：不参与决策、把选择权完整交给 llama.cpp。
  const cacheK = normalizeCacheType(input.cacheTypeK)
  if (cacheK !== 'auto') gateLoose('--cache-type-k', cacheK)
  const cacheV = normalizeCacheType(input.cacheTypeV)
  if (cacheV !== 'auto') gateLoose('--cache-type-v', cacheV)

  // ── KV 缓存策略 ──────────────────────────────────────────────────────────
  /**
   * 只在构建公开了这个选项时才下发。
   *
   * 被门控的都是「新」选项：--kv-unified 较新、--kv-stream-stage-mib 更是特定分支的私有参数、
   * --image-*-tokens 要带动态分辨率的 mtmd、--reasoning-budget 也才合并不久。
   * 不认识的构建收到它们会**直接启动失败**，所以宁可跳过并说明，也不能照发。
   * 探测失败（knownFlags 为 null）时同样不下发 —— 与 --flash-attn 的取舍一致。
   */
  // 两个门控函数（gateStrict / gateLoose）与 skipped / dropped 两本账都定义在函数开头。

  if (input.kvUnified) gateStrict('--kv-unified')

  /**
   * 块级 KV 流式 + 单序列约束。
   *
   * 实测错误（那个「自适应 KV 流式」分支）：
   *   E llama_init_from_model: failed to initialize the context:
   *     block KV streaming requires exactly one sequence (-np 1)
   * 而 llama.cpp 的 `-np` 默认是 **-1（自动）**，会落到多序列 —— 于是「开了暂存就加载不了」。
   *
   * 这是参数自身的前置条件，所以在拼参数层强制兜住，不指望用户自己去「附加参数」里补：
   * 少了它，这个开关就是个「一开就崩」的陷阱。
   * 注意 `-np 1` **只在暂存确实下发时才加** —— 构建不认 --kv-stream-stage-mib 时，
   * 平白把并发降到 1 是没有理由的行为变更。
   */
  const stageMib = Math.round(input.kvStreamStageMib)
  if (stageMib > 0 && gateStrict('--kv-stream-stage-mib', String(stageMib))) {
    const extraTokens = splitArgs(input.extraArgs)
    if (extraTokens.some((token) => token === '-np' || token === '--parallel')) {
      // 用户显式写过就不覆盖 —— 但必须说清后果，否则他只会看到一句难懂的英文错误。
      notices.push(
        '你在「附加参数」里指定了 -np / --parallel。KV 流式暂存（--kv-stream-stage-mib）要求**恰好一个序列**，' +
          '那里不是 1 的话加载会直接失败（block KV streaming requires exactly one sequence）。' +
          '插件不覆盖你的显式设置，请自行改成 -np 1，或把 KV 主机内存暂存设为 0 关掉它。',
      )
    } else {
      flag('-np', '1')
      notices.push(
        '已自动追加 -np 1：KV 流式暂存要求单序列（llama.cpp 的 -np 默认是自动，会落到多序列并导致加载失败）。',
      )
    }
  }

  // ── 采样参数 ────────────────────────────────────────────────────────────
  // 这些（--temp/top-k/top-p/min-p/penalties/repeat-last-n/seed）在几乎所有 llama.cpp
  // 版本里都存在，所以走**宽松**门控：探测失败时照旧全量下发（于是一次 --help 失败不会
  // 静默丢掉全部采样设置），只有构建明确不公开其中某一项时才跳过那一项。
  // 「明确不公开」不是理论情况：kvmem 那个独立 server 就没有 --repeat-last-n，
  // 发过去就是 `unknown flag: --repeat-last-n` + exit 1。
  gateLoose('--temp', formatNumber(input.temp))
  gateLoose('--top-k', String(Math.round(input.topK)))
  gateLoose('--top-p', formatNumber(input.topP))
  gateLoose('--min-p', formatNumber(input.minP))
  gateLoose('--presence-penalty', formatNumber(input.presencePenalty))
  gateLoose('--repeat-penalty', formatNumber(input.repeatPenalty))
  gateLoose('--repeat-last-n', String(Math.round(input.repeatLastN)))

  /**
   * 种子：**负数一律不下发**。
   *
   * 语义上没有任何损失：llama.cpp 里 seed < 0 就是「随机」，而它的默认值本来就是 -1 ——
   * 也就是说「下发 -1」与「不下发」在标准构建上完全等价（本插件默认值就是 -1）。
   * 但有些构建（实测 kvmem 的独立 server）按 uint32 校验取值范围：
   *   invalid --seed: seed out of range [0.000000, 4294967295.000000]  → exit 1
   * 于是「默认设置直接起不来」。既然负数不表达任何额外信息，一律不下发 ——
   * 一条规则同时满足「标准构建语义不变」与「取值范围收窄的构建也能起来」。
   */
  const seed = Math.round(input.seed)
  if (seed >= 0) gateLoose('--seed', String(seed))

  // ── 多模态图像预算 ──────────────────────────────────────────────────────
  // max 必须 >= min，否则 llama.cpp 拒绝启动。就地收敛，与 -ub <= -b 同一处规则。
  const imageMin = Math.max(0, Math.round(input.imageMinTokens))
  const imageMax = Math.max(imageMin, Math.round(input.imageMaxTokens))
  if (imageMin > 0) gateStrict('--image-min-tokens', String(imageMin))
  if (imageMax > 0) gateStrict('--image-max-tokens', String(imageMax))

  // ── 推理预算 ────────────────────────────────────────────────────────────
  // 0 是有意义的取值（关掉思考），所以不按「> 0」判断，只在构建支持时才下发。
  gateStrict('--reasoning-budget', String(Math.round(input.reasoningBudget)))

  // 两本账（skipped / dropped）在这里**还不能**结算成提示：下面还有一批选项要下发，
  // 它们同样会往这两本账里记东西。结算统一放在函数末尾（紧挨着 extraArgs 之前），
  // 否则「新增的选项被跳过」就会悄无声息 —— 实测就是这么漏掉一批 --kvmem-* 的。

  if (input.jinja) gateLoose('--jinja')
  if (input.chatTemplate.trim()) gateLoose('--chat-template', input.chatTemplate.trim())

  /**
   * MTP 与视觉投影的关系。决策点必须在这一层（参数真正被拼出来的地方），
   * 调用方怎么传都不可能拼出一条自相矛盾的命令行。
   *
   * 事实基础（本机实测，2026-09-21）：**kvmem 分支的 llama-kvmem-server 两者可以共存** ——
   * 同时给 `--mmproj` 与 `--spec-type draft-mtp` 时，
   *   `clip_model_loader: has vision encoder` 与 `creating MTP draft context` 同时出现，
   *   服务正常起来，看图对话也能识别。
   * 而**上游 llama.cpp** 不许这样组合（会加载失败），所以那一侧的用户要把
   * 「MTP 与视觉共存」关掉 —— 关掉后恢复旧的互斥：MTP 生效、mmproj 被忽略。
   *
   * 默认走共存（kvmem 是这一侧的主流构建），但那条「已同时下发」的说明保留 ——
   * 换回官方构建时用户就是靠它知道该去关哪个开关。
   */
  const mmproj = input.mmproj.trim()
  if (input.mtp) {
    gateLoose('--spec-type', 'draft-mtp')
    if (mmproj) {
      /*
       * 判据写成 `!== false` 而不是 `if (input.mtpWithVision)`：
       * 「没给这个字段」必须和 registry 那侧的 `=== false` 判据**同义**，
       * 否则会出现「面板显示启用了视觉、命令行里却没有」的错位 ——
       * 这正是本插件在 --flash-attn 上吃过一次的那类 bug（两处默认值各说各话）。
       */
      if (input.mtpWithVision !== false) {
        gateLoose('--mmproj', mmproj)
        notices.push(
          '已同时下发 --spec-type draft-mtp 与 --mmproj（「MTP 与视觉共存」为开）。' +
            'kvmem 分支的 llama-kvmem-server 实测支持这种组合；' +
            '若你换回官方 llama.cpp 并在加载时看到错误，把「MTP 与视觉共存」关掉即可恢复互斥。',
        )
      } else {
        notices.push(
          '已开启 MTP，视觉投影文件（--mmproj）被忽略：官方 llama.cpp 的 MTP 与图像输入不能同时下发。' +
            '如果你的构建支持共存（kvmem 分支的 llama-kvmem-server 可以），把「MTP 与视觉共存」打开。',
        )
      }
    }
  } else if (mmproj) {
    gateLoose('--mmproj', mmproj)
  }

  if (!input.mmap) gateLoose('--no-mmap')
  if (input.mlock) gateLoose('--mlock')
  if (input.apiKey.trim()) gateLoose('--api-key', input.apiKey.trim())

  // ── 输出上限与加载方式 ───────────────────────────────────────────────────
  /**
   * 数值选项的统一入口：**负数一律不下发**。
   *
   * `-1` 在本插件里从此是一个约定的「沿用构建默认」哨兵，理由与 --seed 完全相同：
   * 这些选项的 0 往往是有意义的取值（`--kvmem-budget 0` = 取 n_ctx、
   * `--kvmem-cpu-gb 0` = 关闭溢出场），所以「0 = 不下发」这套约定在这里不成立，
   * 必须换一个不可能被合法赋值的哨兵。负数在它们的取值域里全部非法。
   */
  const gateNumber = (
    gate: (...tokens: string[]) => boolean,
    name: string,
    value: number,
    format: (n: number) => string = (n) => String(Math.round(n)),
  ): boolean => {
    if (!Number.isFinite(value) || value < 0) return false
    return gate(name, format(value))
  }

  gateNumber(gateLoose, '-n', input.nPredict)
  if (input.loadMode.trim()) gateLoose('-lm', input.loadMode.trim())

  // ── KVMem 分块 KV 检索 ───────────────────────────────────────────────────
  // 全部走**严格**门控：这是 kvmem/kvmem-llama.cpp 分支专有的参数族，上游 llama.cpp
  // 一个都不认识 —— 探不到就绝不下发。探测失败时宁可退回构建默认，也不能赌它认。
  if (!input.kvmemEnabled) gateStrict('--no-kvmem')
  gateNumber(gateStrict, '--kvmem-budget', input.kvmemBudget)
  gateNumber(gateStrict, '--kvmem-gen-reserve', input.kvmemGenReserve)
  gateNumber(gateStrict, '--kvmem-block-tokens', input.kvmemBlockTokens)
  gateNumber(gateStrict, '--kvmem-sink-tokens', input.kvmemSinkTokens)
  gateNumber(gateStrict, '--kvmem-recent-tokens', input.kvmemRecentTokens)
  if (input.kvmemMethod.trim()) gateStrict('--kvmem-method', input.kvmemMethod.trim())
  gateNumber(gateStrict, '--kvmem-query-last', input.kvmemQueryLast)
  gateNumber(gateStrict, '--kvmem-query-max-tokens', input.kvmemQueryMaxTokens)
  if (input.kvmemQueryReplay.trim()) gateStrict('--kvmem-query-replay', input.kvmemQueryReplay.trim())
  if (input.kvmemQueryPolicy.trim()) gateStrict('--kvmem-query-policy', input.kvmemQueryPolicy.trim())
  if (input.kvmemMtpState.trim()) gateStrict('--kvmem-mtp-state', input.kvmemMtpState.trim())
  gateNumber(gateStrict, '--kvmem-gpu-ratio', input.kvmemGpuRatio, formatNumber)
  gateNumber(gateStrict, '--kvmem-cpu-gb', input.kvmemCpuGb, formatNumber)
  gateNumber(gateStrict, '--kvmem-nvme-gb', input.kvmemNvmeGb, formatNumber)
  if (input.kvmemNvmeDir.trim()) gateStrict('--kvmem-nvme-dir', input.kvmemNvmeDir.trim())
  if (input.kvmemHarvestV) gateStrict('--kvmem-harvest-v')
  if (input.kvmemRawKNvme) gateStrict('--kvmem-raw-k-nvme')

  /**
   * 解码预留（--kvmem-gen-reserve）的两次提醒。
   *
   * 这个构建的默认值只有 **256** —— 而它同时是**单次生成的上限**（含思考）。
   * 也就是说「不设置它」等于「每次回复最多 256 个 token」，一个足以让人以为模型坏了的坑，
   * 而且完全没有报错。所以：
   *   - 用户填了但填得过小 → 直接说出后果；
   *   - 用户没填、而这个构建确实有这个选项 → 说明「即将沿用 256」。
   * 只在构建认得这个选项时才提醒，上游构建不会看到这条噪音。
   */
  const genReserveSupported = input.knownFlags?.has('--kvmem-gen-reserve') ?? false
  if (genReserveSupported) {
    const effective = input.kvmemGenReserve >= 0 ? Math.round(input.kvmemGenReserve) : 256
    if (effective < 1024) {
      notices.push(
        `解码预留（--kvmem-gen-reserve）当前为 ${effective}，而它是**单次生成的上限**（含思考）—— ` +
          '模型每次回复最多只能写这么多 token，长回答会被硬截断且不报错。' +
          '建议设成不小于 dsh 路由的「单次最大输出 tokens」（例如 8192～16384）。',
      )
    }
  }

  // ── KV 类型与 MTP 细节 ───────────────────────────────────────────────────
  if (input.kvDtype.trim()) gateStrict('--kv-dtype', input.kvDtype.trim())
  if (input.specKvDtype.trim()) gateLoose('--spec-kv-dtype', input.specKvDtype.trim())
  gateNumber(gateLoose, '--spec-draft-n-max', input.specDraftNMax)
  gateNumber(gateLoose, '--spec-draft-p-min', input.specDraftPMin, formatNumber)

  // --kv-dtype 一次设 K 和 V，与 -ctk / -ctv 是两条并行的通道；同时给会让「谁生效」
  // 取决于构建内部的读取顺序（无法从外面判断），所以只提醒、不替用户裁决。
  if (input.kvDtype.trim() && (normalizeCacheType(input.cacheTypeK) !== 'auto' || normalizeCacheType(input.cacheTypeV) !== 'auto')) {
    notices.push(
      '「KV 缓存类型（合并）」与「KV cache 精度（K/V）」同时设置了：前者对应 --kv-dtype、' +
        '后者对应 -ctk/-ctv，两者作用重叠，生效顺序由构建内部决定。建议只留一个。',
    )
  }

  // ── 模板、推理档位与其它 ─────────────────────────────────────────────────
  if (!input.mmprojOffload) gateLoose('--no-mmproj-offload')
  if (input.chatTemplateFile.trim()) gateLoose('--chat-template-file', input.chatTemplateFile.trim())
  if (input.chatTemplateKwargs.trim()) gateLoose('--chat-template-kwargs', input.chatTemplateKwargs.trim())
  if (input.reasoningEffort.trim()) gateLoose('--reasoning-effort', input.reasoningEffort.trim())
  if (input.reasoningBudgetMessage.trim()) gateLoose('--reasoning-budget-message', input.reasoningBudgetMessage.trim())
  // 0 就是不惩罚，与构建默认值一致，下发它没有任何信息量 —— 只在非 0 时下发。
  if (Math.round(input.frequencyPenalty ?? 0) !== 0) {
    gateLoose('--frequency-penalty', formatNumber(input.frequencyPenalty))
  }

  // ── 被跳过选项的结算（必须是最后一步）────────────────────────────────────
  // 两本账合成一条提示：被跳过的可能既有「只有较新构建才有的」（strict）也有
  // 「这个分支干脆没有的」（loose），但对用户是同一件事 —— 哪几个选项没发出去。
  //
  // 位置很关键：这个循环必须在**所有**下发决策之后跑完。它曾经放在采样参数后面，
  // 于是后面新增的每一项（--kvmem-*、-n、-lm、--kv-dtype……）被跳过后都不会出现在
  // 提示里 —— 用户看到的是「设置填了但没生效，日志里也没有任何线索」。
  const notRecognized = [...skipped, ...dropped]
  if (notRecognized.length > 0) {
    notices.push(
      input.knownFlags
        ? `这个 llama-server 不认识以下选项，已跳过（不影响加载）：${notRecognized.join('、')}`
        : `无法探测这个 llama-server 支持哪些选项，已跳过：${notRecognized.join('、')}（宁可退回构建默认值，也不赌它认）`,
    )
  }

  args.push(...splitArgs(input.extraArgs))

  return { args: args.filter((token) => token.length > 0), usedFlags, notices }
}

/**
 * 引号感知的参数分词：支持 'a b'、"a b"。
 *
 * 关于反斜杠：**不**把它当通用转义符。用户会往这里贴 Windows 路径
 * （`--lora "C:\users\me\lora.bin"`、`--chat-template C:\tpl\qwen.jinja`），
 * 一旦把 `\` 当转义符，路径会被静默吃掉字符，比分词不准难查得多。
 * 只保留一个例外：`\"` / `\'` 转义它自己所在的那种引号。
 */
export function splitArgs(raw: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!

    if (quote) {
      if (ch === '\\' && raw[i + 1] === quote) {
        current += quote
        i++
        continue
      }
      if (ch === quote) {
        quote = null
        continue
      }
      current += ch
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (started || current.length > 0) {
        out.push(current)
        current = ''
        started = false
      }
      continue
    }

    current += ch
  }

  if (started || current.length > 0) out.push(current)
  return out
}

/** 把参数数组还原成可读命令行（用于日志与 status 输出，注意会暴露 --api-key）。 */
export function renderCommandLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteIfNeeded).join(' ')
}

export function redactArgs(args: string[]): string[] {
  const out = args.slice()
  const index = out.findIndex((a) => a === '--api-key')
  if (index >= 0 && index + 1 < out.length) out[index + 1] = '***'
  return out
}

function quoteIfNeeded(token: string): string {
  return /[\s"']/.test(token) ? JSON.stringify(token) : token
}
