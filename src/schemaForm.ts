import type { LocalModelConfig } from './config.js'
import { defaultConfig } from './configResolve.js'
import type { ResolvedConfig } from './configResolve.js'
import { fieldTypeMap } from './configStore.js'

/**
 * 设置页表单描述。
 *
 * 字段的**类型、默认值、说明文案**全部从 schemastery schema 现场序列化得到
 * （`Config.toJSON()`），所以设置页永远和 config.ts 里那一份 schema 一致 ——
 * 加一个字段只需要改一处，界面自动出现。
 *
 * 这里只额外补两样 schema 表达不了的东西：
 *   - 分组（纯展示：把字段分成 6 组，不然一屏铺不完。字段数刻意不写死在这里 —— 它会变）；
 *   - 校验区间（界面上的 min/max 提示）。
 */

export type FieldKind = 'boolean' | 'number' | 'string' | 'select' | 'text'

export interface FormField {
  key: string
  label: string
  kind: FieldKind
  description: string
  default: unknown
  options?: string[]
  min?: number
  max?: number
  uiGroup: string
}

export interface FormGroup {
  id: string
  title: string
  hint: string
  fields: FormField[]
}

export interface FormDescriptor {
  groups: FormGroup[]
  /** 直接喂给界面的已序列化 schema（schema.toJSON()）。 */
  schema: unknown
  /** 只读的目录事实，便于用户在界面里照着放文件。 */
  paths: { modelsDir: string; runtimeDir: string; stateDir: string; configFile: string }
}

/** 展示分组。序列化 schema 里出现的、但没列在这里的字段会落到「其他」。 */
const GROUP_DEFS: { id: string; title: string; hint: string; keys: (keyof LocalModelConfig)[] }[] = [
  {
    id: 'model',
    title: '模型与目录',
    hint: '模型从哪里读、当前选中哪一个；需要图像输入时在这里挂上视觉投影文件并设定图像 token 预算。',
    keys: [
      'enabled',
      'selectedModel',
      'mmprojFile',
      'mtp',
      'mtpWithVision',
      'imageMinTokens',
      'imageMaxTokens',
      'modelsDir',
      'runtimeDir',
      'llamaServerPath',
      'preload',
    ],
  },
  {
    id: 'mtp',
    title: '多 Token 预测（MTP）细节',
    hint:
      '只在上面「模型与目录」里打开了「多 Token 预测（MTP）」时才起作用。' +
      '这三个参数决定草稿一次猜几个 token、草稿的 KV 用什么精度存。',
    keys: ['specKvDtype', 'specDraftNMax', 'specDraftPMin'],
  },
  {
    id: 'server',
    title: '服务与端口',
    hint: 'dsh 的模型路由要指向「对外端口」。内部端口留 0 最省心。',
    keys: ['host', 'port', 'llamaPort'],
  },
  {
    id: 'infer',
    title: '推理参数',
    hint:
      '直接映射到 llama-server 命令行。显存不够先降上下文长度或换更低比特量化。' +
      '「输出上限溢出保护」建议保持开启 —— kvmem 分支的服务端会把 prompt + max_tokens 超上下文直接判成 400。',
    keys: [
      'ctxSize',
      'maxTokens',
      'nPredict',
      'guardContextOverflow',
      'gpuLayersMode',
      'gpuLayers',
      'cacheTypeK',
      'cacheTypeV',
      'loadMode',
      'threads',
      'threadsBatch',
      'batchSize',
      'ubatchSize',
      'flashAttention',
      'mmprojOffload',
      'reasoningBudget',
      'reasoningBudgetMessage',
      'reasoningEffort',
      'jinja',
      'chatTemplate',
      'chatTemplateFile',
      'chatTemplateKwargs',
      'enableThinking',
      'preserveThinking',
      'mmap',
      'mlock',
    ],
  },
  {
    id: 'sampling',
    title: '采样与 KV 缓存',
    hint:
      '采样参数会显式下发给 llama-server 并覆盖它自己的默认值（本组默认值与 llama.cpp 默认值并不相同，表现在各项说明里）。' +
      'KV 相关的选项用于长上下文：统一缓冲减少碎片，流式暂存把一部分 KV 放到主机内存。',
    keys: [
      'kvUnified',
      'kvStreamStageMib',
      'kvDtype',
      'temp',
      'topK',
      'topP',
      'minP',
      'presencePenalty',
      'frequencyPenalty',
      'repeatPenalty',
      'repeatLastN',
      'seed',
    ],
  },
  {
    id: 'kvmem',
    title: 'KVMem 分块缓存（kvmem 分支专有）',
    hint:
      '整组都只对 llama-kvmem-server 生效，官方 llama.cpp 构建会全部跳过（探测不到即不下发）。' +
      '默认值一律是「不下发」，所以不动这里就等于用构建自己的默认行为。' +
      '★ 最该先看「解码预留」：这个构建的默认值只有 256，而它是**单次生成的上限**。',
    keys: [
      'kvmemEnabled',
      'kvmemBudget',
      'kvmemGenReserve',
      'kvmemBlockTokens',
      'kvmemSinkTokens',
      'kvmemRecentTokens',
      'kvmemMethod',
      'kvmemQueryLast',
      'kvmemQueryMaxTokens',
      'kvmemQueryReplay',
      'kvmemQueryPolicy',
      'kvmemMtpState',
      'kvmemGpuRatio',
      'kvmemCpuGb',
      'kvmemNvmeGb',
      'kvmemNvmeDir',
      'kvmemHarvestV',
      'kvmemRawKNvme',
    ],
  },
  {
    id: 'lifecycle',
    title: '加载与卸载',
    hint: '空闲多久释放显存，以及加载超时与崩溃重试。',
    keys: ['idleUnloadMinutes', 'startupTimeoutMs', 'shutdownGraceMs', 'autoRestart', 'maxRestarts'],
  },
  {
    id: 'advanced',
    title: '诊断与高级',
    hint: '排查问题用。密钥留空表示不校验（仅监听回环地址时推荐）。',
    keys: ['apiKey', 'extraArgs', 'envOverrides', 'logLevel'],
  },
]

/** 数值字段的界面区间（与 configResolve.ts 的收敛区间一致，只是为了让输入框不给出荒谬值）。 */
const RANGES: Partial<Record<keyof LocalModelConfig, [number, number]>> = {
  port: [1, 65535],
  llamaPort: [0, 65535],
  ctxSize: [512, 1_048_576],
  gpuLayers: [-1, 4096],
  threads: [0, 1024],
  threadsBatch: [0, 1024],
  batchSize: [0, 1_048_576],
  ubatchSize: [0, 1_048_576],
  idleUnloadMinutes: [0, 1_000_000],
  startupTimeoutMs: [5_000, 3_600_000],
  shutdownGraceMs: [500, 120_000],
  maxRestarts: [0, 10],
  maxTokens: [64, 131_072],
  kvStreamStageMib: [0, 1_048_576],
  temp: [0, 100],
  topK: [0, 1_048_576],
  topP: [0, 1],
  minP: [0, 1],
  presencePenalty: [-10, 10],
  repeatPenalty: [0, 10],
  repeatLastN: [-1, 1_048_576],
  seed: [-1, 2_147_483_647],
  imageMinTokens: [0, 1_048_576],
  imageMaxTokens: [0, 1_048_576],
  reasoningBudget: [-1, 1_048_576],
  // ── KVMem 家族与新增启动项（区间与 configResolve 的收敛区间一致）──────────
  kvmemBudget: [-1, 1_048_576],
  kvmemGenReserve: [-1, 1_048_576],
  kvmemBlockTokens: [-1, 1_048_576],
  kvmemSinkTokens: [-1, 1_048_576],
  kvmemRecentTokens: [-1, 1_048_576],
  kvmemQueryLast: [-1, 1_048_576],
  kvmemQueryMaxTokens: [-1, 1_048_576],
  kvmemGpuRatio: [-1, 1],
  kvmemCpuGb: [-1, 4096],
  kvmemNvmeGb: [-1, 4096],
  nPredict: [-1, 1_048_576],
  specDraftNMax: [-1, 1024],
  specDraftPMin: [-1, 1],
  frequencyPenalty: [-2, 2],
}

/** 字段的中文短标签。schema 的 description 是句子，这里是控件旁边的短名。 */
const LABELS: Partial<Record<keyof LocalModelConfig, string>> = {
  enabled: '启用',
  modelsDir: '模型目录',
  runtimeDir: '运行时目录',
  llamaServerPath: 'llama-server 路径',
  selectedModel: '当前模型',
  mmprojFile: '视觉投影文件',
  mtp: '多 Token 预测（MTP）',
  mtpWithVision: 'MTP 与视觉共存',
  preload: '预加载',
  host: '监听地址',
  port: '对外端口',
  llamaPort: '内部端口',
  ctxSize: '上下文长度',
  gpuLayersMode: 'GPU 层数策略',
  gpuLayers: 'GPU 层数（自定义时生效）',
  threads: 'CPU 线程',
  threadsBatch: '批处理线程',
  batchSize: '逻辑批大小',
  ubatchSize: '物理批大小',
  flashAttention: 'Flash Attention',
  cacheTypeK: 'KV cache 精度（K）',
  cacheTypeV: 'KV cache 精度（V）',
  kvUnified: '统一 KV 缓存',
  kvStreamStageMib: 'KV 主机内存暂存（MiB）',
  temp: '温度（temp）',
  topK: 'Top-K',
  topP: 'Top-P（核采样）',
  minP: 'Min-P',
  presencePenalty: '存在惩罚',
  repeatPenalty: '重复惩罚',
  repeatLastN: '重复惩罚范围',
  seed: '随机种子',
  imageMinTokens: '图像最少 token',
  imageMaxTokens: '图像最多 token',
  reasoningBudget: '推理 token 预算',
  jinja: 'Jinja 模板',
  chatTemplate: '对话模板',
  enableThinking: '启用思考',
  preserveThinking: '保留历史 think',
  mmap: '内存映射',
  mlock: '锁定内存',
  apiKey: '访问密钥',
  extraArgs: '附加参数',
  envOverrides: '环境变量',
  idleUnloadMinutes: '空闲卸载（分钟）',
  startupTimeoutMs: '加载超时（毫秒）',
  shutdownGraceMs: '卸载宽限（毫秒）',
  autoRestart: '崩溃自动重启',
  maxRestarts: '最大重启次数',
  maxTokens: '单次最大输出 tokens',
  logLevel: '日志级别',
  // ── KVMem 家族与新增启动项 ────────────────────────────────────────────────
  kvmemEnabled: '启用 KVMem',
  kvmemBudget: 'GPU 工作集 tokens',
  kvmemGenReserve: '解码预留（生成上限）',
  kvmemBlockTokens: '检索块大小',
  kvmemSinkTokens: '常驻前缀 tokens',
  kvmemRecentTokens: '常驻后缀 tokens',
  kvmemMethod: '检索算法',
  kvmemQueryLast: '查询兜底长度',
  kvmemQueryMaxTokens: '查询上限 tokens',
  kvmemQueryReplay: '查询重放模式',
  kvmemQueryPolicy: '查询策略',
  kvmemMtpState: 'MTP 状态模式',
  kvmemGpuRatio: '槽池显存占比',
  kvmemCpuGb: 'CPU 溢出场（GiB）',
  kvmemNvmeGb: 'NVMe 溢出场（GiB）',
  kvmemNvmeDir: 'NVMe 溢出场目录',
  kvmemHarvestV: '原始 K 预填 V',
  kvmemRawKNvme: '原始 K/V 落 NVMe',
  nPredict: '服务端默认输出上限',
  loadMode: '权重加载方式',
  kvDtype: 'KV 缓存类型（合并）',
  specKvDtype: 'MTP 草稿 KV 精度',
  specDraftNMax: 'MTP 草稿 token 数',
  specDraftPMin: 'MTP 草稿最小概率',
  frequencyPenalty: '频率惩罚',
  mmprojOffload: '视觉编码器放 GPU',
  chatTemplateFile: '模板文件路径',
  chatTemplateKwargs: '模板默认参数（JSON）',
  reasoningEffort: '服务端默认推理档位',
  reasoningBudgetMessage: '预算耗尽过渡语',
  guardContextOverflow: '输出上限溢出保护',
}

interface SerializedRef {
  type?: string
  meta?: { default?: unknown; description?: string; required?: boolean }
  dict?: Record<string, number>
  list?: number[]
  value?: unknown
}

/**
 * schemastery 的 schema 实例要经过 toJSON() 才是可解析的 {uid, refs} 图。
 * 传进来的可能是实例，也可能已经是序列化结果（单测/缓存），两种都接受。
 */
export function serializeSchema(schema: unknown): unknown {
  const candidate = schema as { toJSON?: () => unknown } | undefined
  if (candidate && typeof candidate.toJSON === 'function') {
    try {
      return candidate.toJSON()
    } catch {
      return schema
    }
  }
  return schema
}

/** 从 schema.toJSON() 抽出「字段 → 类型/默认值/说明/可选项」。拿不到就退回类型表。 */
export function extractFields(schema: unknown): FormField[] {
  const types = fieldTypeMap()
  const defaults = defaultConfig() as unknown as Record<string, unknown>
  const serialized = serializeSchema(schema) as { uid?: number; refs?: Record<string, SerializedRef> } | undefined
  const refs = serialized?.refs
  // 根节点的编号是 toJSON() 自报的 uid，不是固定值 —— 写死会静默退化成「没有说明文案」。
  const root = serialized?.uid !== undefined ? refs?.[String(serialized.uid)] : undefined
  const dict = root?.type === 'object' ? root.dict : undefined

  const keys = dict ? Object.keys(dict) : Object.keys(types)

  const fields: FormField[] = []
  for (const key of keys) {
    const refId = dict?.[key]
    const ref = refId !== undefined ? refs?.[String(refId)] : undefined
    const description = ref?.meta?.description ?? ''
    const type = ref?.type ?? types[key] ?? 'string'

    let kind: FieldKind = 'string'
    let options: string[] | undefined

    if (type === 'boolean') kind = 'boolean'
    else if (type === 'number') kind = 'number'
    else if (type === 'union') {
      const list = ref?.list ?? []
      options = list
        .map((id) => refs?.[String(id)]?.value)
        .filter((v): v is string => typeof v === 'string')
      kind = options.length > 0 ? 'select' : 'string'
    } else if (type === 'object') kind = 'text'
    else kind = 'string'

    const range = RANGES[key as keyof LocalModelConfig]
    fields.push({
      key,
      label: LABELS[key as keyof LocalModelConfig] ?? key,
      kind,
      description,
      default: ref?.meta?.default ?? defaults[key],
      ...(options ? { options } : {}),
      ...(range ? { min: range[0], max: range[1] } : {}),
      uiGroup: groupOf(key),
    })
  }
  return fields
}

function groupOf(key: string): string {
  for (const group of GROUP_DEFS) {
    if ((group.keys as string[]).includes(key)) return group.id
  }
  return 'other'
}

export function buildFormDescriptor(schema: unknown, resolved: ResolvedConfig, configFile: string): FormDescriptor {
  const fields = extractFields(schema)
  const groups: FormGroup[] = []

  for (const def of GROUP_DEFS) {
    const groupFields = fields.filter((f) => f.uiGroup === def.id)
    if (groupFields.length === 0) continue
    groups.push({ id: def.id, title: def.title, hint: def.hint, fields: groupFields })
  }

  const orphans = fields.filter((f) => f.uiGroup === 'other')
  if (orphans.length > 0) {
    groups.push({ id: 'other', title: '其他', hint: '', fields: orphans })
  }

  return {
    groups,
    schema: serializeSchema(schema),
    paths: {
      modelsDir: resolved.paths.modelsDir,
      runtimeDir: resolved.paths.runtimeDir,
      stateDir: resolved.paths.stateDir,
      configFile,
    },
  }
}
