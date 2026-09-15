import Schema from '@deepseek-ai/schemastery'

/**
 * 插件配置。这个 schema 就是 dsh 设置页「本地模型」那一栏的全部内容 ——
 * 每一项都带 description / default，设置页会据此自动渲染成表单。
 * 约束：默认值只写在 schema 里，业务代码不再写一份，避免两处漂移。
 */
export interface LocalModelConfig {
  enabled: boolean
  modelsDir: string
  runtimeDir: string
  llamaServerPath: string

  selectedModel: string
  /** 手动指定的视觉投影文件（mmproj）；留空 = 沿用同目录的自动关联。 */
  mmprojFile: string
  /**
   * 多 Token 预测（MTP）。开启后下发 `--spec-type draft-mtp`，
   * 并**强制禁用视觉投影**（两者在 llama.cpp 里不能共存）。
   */
  mtp: boolean
  preload: boolean

  host: string
  port: number
  llamaPort: number

  ctxSize: number
  /**
   * GPU 层数怎么决定。默认 auto —— 让 llama.cpp 的 --fit 按可用显存自适应。
   * 钉成具体数字会跳过这层保护，模型放不下时从「少放几层」变成「直接 OOM」。
   */
  gpuLayersMode: 'auto' | 'all' | 'custom'
  /** 仅在 gpuLayersMode = custom 时生效；负数表示全部层。 */
  gpuLayers: number
  threads: number
  threadsBatch: number
  batchSize: number
  ubatchSize: number
  /** 与 llama.cpp 的 `-fa, --flash-attn [on|off|auto]` 对齐；auto = 不下发。 */
  flashAttention: 'auto' | 'on' | 'off'
  /**
   * K 缓冲的量化精度。默认 q8_0：长上下文时 KV cache 是显存大头，q8_0 比默认 f16 省一半、
   * 精度损失极小，是大模型（≥13B）+ 长 ctx（≥8K）的标配。显存富余或特别在意精度时改 f16。
   * 'auto' = 不下发，由 llama.cpp 用其默认 f16。
   */
  cacheTypeK: 'auto' | 'f16' | 'q8_0' | 'q4_0' | 'q4_1' | 'q5_0' | 'q5_1' | 'bf16' | 'f32' | 'iq4_nl'
  /** V 缓冲的量化精度。默认与 K 同步。 */
  cacheTypeV: 'auto' | 'f16' | 'q8_0' | 'q4_0' | 'q4_1' | 'q5_0' | 'q5_1' | 'bf16' | 'f32' | 'iq4_nl'

  // ── KV 缓存策略 ──────────────────────────────────────────────────────────
  /** 统一的 KV 缓存管理策略（--kv-unified）。默认关闭 = 不下发，交给 llama.cpp 决定。 */
  kvUnified: boolean
  /**
   * 把这么多 MiB 的 KV 缓存暂存到主机内存，以减轻显存压力（--kv-stream-stage-mib）。
   *
   * **这是特定 llama.cpp 分支（自适应 KV 流式）的私有参数**，上游构建不认识它 ——
   * 插件因此按 `--help` 探测结果决定是否下发，不认识的构建上会被跳过。0 = 不下发。
   */
  kvStreamStageMib: number

  // ── 采样参数（默认值即用户指定的值，全部下发；与 llama.cpp 自身默认值不同）─────
  /** 温度（--temp）。越高越随机。llama.cpp 自身默认 0.8。 */
  temp: number
  /** 仅从概率最高的 K 个 token 中采样（--top-k）。0 = 不过滤。llama.cpp 自身默认 40。 */
  topK: number
  /** 核采样阈值（--top-p）：累计概率达到该比例的 token 集合。llama.cpp 自身默认 0.95。 */
  topP: number
  /** 最小概率阈值（--min-p）：低于「最佳 token 概率 × 该值」的 token 被过滤。0 = 不过滤。llama.cpp 自身默认 0.05。 */
  minP: number
  /** 存在惩罚（--presence-penalty）。正值鼓励谈论新话题。 */
  presencePenalty: number
  /** 重复惩罚（--repeat-penalty）。1.0 = 不惩罚。llama.cpp 自身默认 1.1。 */
  repeatPenalty: number
  /** 重复惩罚检查的 token 范围（--repeat-last-n）。 */
  repeatLastN: number
  /** 随机种子（--seed）。-1 = 每次启动都用随机种子。 */
  seed: number

  // ── 多模态图像预算与推理预算 ──────────────────────────────────────────────
  /** 每张图最少编码成多少 token（--image-min-tokens）。只对动态分辨率的视觉模型生效。 */
  imageMinTokens: number
  /** 每张图最多编码成多少 token（--image-max-tokens）。只对动态分辨率的视觉模型生效。 */
  imageMaxTokens: number
  /** 推理过程的 token 预算（--reasoning-budget），限制思考链最大长度。 */
  reasoningBudget: number

  jinja: boolean
  chatTemplate: string
  /** 是否让模型输出思考内容（chat_template_kwargs.enable_thinking）。 */
  enableThinking: boolean
  /** 是否在上下文中保留历史消息里的 think 内容（chat_template_kwargs.preserve_thinking）。 */
  preserveThinking: boolean
  mmap: boolean
  mlock: boolean
  apiKey: string
  extraArgs: string
  envOverrides: Record<string, string>

  idleUnloadMinutes: number
  startupTimeoutMs: number
  shutdownGraceMs: number
  autoRestart: boolean
  maxRestarts: number

  /**
   * dsh 侧路由声明的单次最大输出 tokens。
   *
   * 这是「接入 dsh」那一组里唯一保留的设置项（其余已按用户要求从 schema 中删除，
   * 改为硬编码常量），因此它在设置页里被归入「推理参数」分组。
   */
  maxTokens: number

  logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug'
}

/*
 * 原来放在这里的几个常量（DEFAULT_MODEL_ALIAS / LOCAL_ROUTE_NAME / LOCAL_MODEL_ID /
 * EXPOSE_LOCAL_MODEL_TOOL / ALLOW_MODEL_CONTROL）现在定义在 configResolve.ts。
 *
 * 理由：本文件 import 了 schemastery，而 scripts/ 下的自检脚本必须在没有宿主依赖的环境里
 * 也能 import 这些常量（`lib/config.js` 会直接抛 ERR_MODULE_NOT_FOUND）。
 * configResolve.ts 那一层刻意不碰 schemastery，正是为这种场景准备的。
 */

export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('总开关。关闭后不再监听端口，也不会拉起任何 llama 进程。'),

  modelsDir: Schema.string()
    .default('')
    .description('模型目录。留空 = ${DSH_HOME}/local-model/models。把 GGUF 文件放在这里，可在设置页下拉选择。'),

  runtimeDir: Schema.string()
    .default('')
    .description('运行时目录。留空 = ${DSH_HOME}/local-model/runtime。把 llama.cpp 的 llama-server 可执行文件放在这里。'),

  llamaServerPath: Schema.string()
    .default('')
    .description('llama-server 可执行文件的绝对路径。留空 = 在上面的运行时目录里自动查找（含子目录）。'),

  selectedModel: Schema.string()
    .default('')
    .description('当前选中的本地模型（模型目录下的相对路径）。留空表示尚未选择。'),

  mmprojFile: Schema.string()
    .default('')
    .description(
      '视觉投影文件（mmproj），用于给多模态模型开启图像输入 —— 加载时作为 --mmproj 下发给 llama-server。' +
        '留空 = 保持原有行为：只在模型同目录里能唯一确定归属时自动关联 mmproj-*.gguf；' +
        '选中具体文件 = 强制使用它（覆盖自动关联）。纯文本模型不需要这一项，保持留空即可。' +
        '注意：开启「多 Token 预测（MTP）」时本项会被忽略（MTP 与图像输入不能共存）。',
    ),

  mtp: Schema.boolean()
    .default(false)
    .description(
      '多 Token 预测（Multi-Token Prediction，加载时下发 --spec-type draft-mtp）。' +
        '让模型用它自带的预测头一次猜测并校验多个 token，本地生成速度通常能提升 1.2～2 倍（越长的回复越明显），' +
        '代价是首字前的 prompt 处理略慢、显存多占一点。' +
        '两个前提：① llama.cpp 构建要支持 MTP（2026-05 之后的构建）；② 模型必须是带 MTP 头的 GGUF（文件名常带 MTP 字样），' +
        '普通 GGUF 打开这个开关不会有任何加速。' +
        '开启后本插件会**自动禁用视觉投影文件**（--mmproj）—— llama.cpp 的 MTP 与图像输入目前不能共存，' +
        '强行一起下发会导致加载失败。需要看图时请关掉这一项。',
    ),

  preload: Schema.boolean()
    .default(false)
    .description('预加载：开启后选中模型即开始载入，而不是等到第一条对话。会占用显存但首字更快。'),

  host: Schema.string()
    .default('127.0.0.1')
    .description('本地服务监听地址。默认只监听本机回环，不要改成 0.0.0.0，除非你清楚暴露风险。'),

  port: Schema.number()
    .default(18080)
    .description('本地模型服务的对外端口。dsh 的模型路由要指向这个端口。被占用时会自动改用空闲端口并给出提示。'),

  llamaPort: Schema.number()
    .default(0)
    .description('llama-server 内部端口。0 = 每次自动挑一个空闲端口（推荐，最不容易冲突）。'),

  ctxSize: Schema.number()
    .default(8192)
    .description(
      '上下文长度（llama.cpp 的 -c）。建议 8K 起步，显存够再往上加。' +
        'dsh 侧路由声明的上下文窗口会跟着这一项走（不再单独配置），两者始终对齐，因此不会出现「声明比实际大」导致长会话中途崩的情况。',
    ),

  maxTokens: Schema.number()
    .default(8192)
    .description(
      '单次最大输出 tokens：dsh 侧路由用它决定一次回复的上限。' +
        '必须明显小于上面的上下文长度（要留出提示词占用的空间），否则长会话会挤爆上下文。',
    ),

  gpuLayers: Schema.number()
    .default(-1)
    .description(
      '仅在「GPU 层数策略 = 自定义」时生效。具体卸载到 GPU 的层数（-ngl）；填负数表示全部层。' +
        '显存不够时会直接报错甚至崩，除非你清楚模型的确放得下，否则建议把策略留在「自动」。',
    ),

  gpuLayersMode: Schema.union(['auto', 'all', 'custom'] as const)
    .default('auto')
    .description(
      'GPU 层数策略（-ngl）。自动 = 下发 -ngl auto，让 llama.cpp 的 --fit 按可用显存决定卸载多少层 —— ' +
        '模型放不下时会自动少放几层而不是直接崩；全部 = 全部层上 GPU（-ngl all）；自定义 = 按上面的数字下发。' +
        '注意 --fit 只调整「用户没显式设置」的参数，所以钉死层数会关掉这层保护。',
    ),

  threads: Schema.number()
    .default(0)
    .description('CPU 线程数（-t）。0 = 交给 llama.cpp 自己按核数推断。'),

  threadsBatch: Schema.number()
    .default(0)
    .description('批处理线程数（--threads-batch）。0 = 不指定，使用 llama.cpp 默认。'),

  batchSize: Schema.number()
    .default(2048)
    .description('逻辑批大小（-b）。默认 2048。'),

  ubatchSize: Schema.number()
    .default(512)
    .description('物理批大小（-ub）。默认 512，必须小于等于逻辑批大小，插件会自动收敛。'),

  flashAttention: Schema.union(['auto', 'on', 'off'] as const)
    .default('auto')
    .description(
      'Flash Attention 三态，与 llama.cpp 的 -fa / --flash-attn 对齐。auto（推荐）= 不下发该参数，交给 llama.cpp 自己判断；' +
        'on / off 为显式开关。插件会先探测这个构建的 --flash-attn 是「裸开关」还是「带值」，再决定怎么下发。',
    ),

  cacheTypeK: Schema.union(['auto', 'f16', 'q8_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'bf16', 'f32', 'iq4_nl'] as const)
    .default('q8_0')
    .description(
      'K 缓冲的量化精度（--cache-type-k）。默认 q8_0 —— 长上下文时 KV cache 是显存大头，' +
        'q8_0 比 llama.cpp 默认的 f16 省一半显存、精度损失极小；大模型 + 长上下文发生 OOM 时优先调这里。' +
        'auto = 不下发该参数（用 llama.cpp 默认 f16），仅在你知道自己在做什么时选。',
    ),

  cacheTypeV: Schema.union(['auto', 'f16', 'q8_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'bf16', 'f32', 'iq4_nl'] as const)
    .default('q8_0')
    .description(
      'V 缓冲的量化精度（--cache-type-v）。一般与 K 保持一致（默认 q8_0）。' +
        'auto = 不下发该参数（用 llama.cpp 默认 f16）。',
    ),

  // ── KV 缓存策略 ──────────────────────────────────────────────────────────
  kvUnified: Schema.boolean()
    .default(false)
    .description(
      '统一的 KV 缓存管理策略（--kv-unified）。开启后 KV 缓存用一整块统一缓冲管理，' +
        '在长序列下更容易组织缓存、也能减少「按层分配」造成的显存碎片，长上下文更容易装下。' +
        '代价是这块缓冲在加载时就按完整上下文一次性预留，即使你很少跑满也会占住显存。' +
        '默认关闭 = 不下发该参数，由 llama.cpp 自己决定。',
    ),

  kvStreamStageMib: Schema.number()
    .default(1024)
    .description(
      'KV 缓存主机内存暂存量（MiB，--kv-stream-stage-mib）：把这么多 KV 缓存暂存到主机内存，' +
        '以减轻显存压力，是本插件所适配的那个「自适应 KV 流式」分支的核心参数。' +
        '取值取决于模型、上下文长度、显卡与其它显存占用，建议从保守值起步、逐步加大并观察启动情况与峰值显存。' +
        '注意：这是那个分支的私有参数，上游 llama.cpp 不认识它 —— 插件会先探测构建，认不出来的构建上自动跳过（并在日志里说明）。0 = 不下发。' +
        '★ 它有前缀条件：块级 KV 流式要求**单序列**，所以只要本项 > 0 且构建支持，插件会**自动追加 -np 1**' +
        '（llama.cpp 的 -np 默认是「自动」，会落到多序列并导致加载直接失败）。' +
        '因此开启本项后并发槽位为 1 —— 本地单人使用没有影响，但如果你在「附加参数」里自己设了 -np / --parallel，' +
        '插件不会覆盖它，那里不是 1 就会加载失败。',
    ),

  // ── 采样参数 ────────────────────────────────────────────────────────────
  temp: Schema.number()
    .default(0.75)
    .description(
      '温度（--temp）：控制输出随机性，越高越随机、越低越确定。' +
        '注意 llama.cpp 自身的默认值是 0.8，本项默认 0.75 意味着插件会显式下发这个参数并覆盖它。',
    ),

  topK: Schema.number()
    .default(20)
    .description(
      '仅从概率最高的 K 个 token 中采样（--top-k）。0 = 不过滤（保留全部候选）。' +
        '注意 llama.cpp 自身的默认值是 40。',
    ),

  topP: Schema.number()
    .default(0.95)
    .description(
      '核采样（--top-p）：仅从累计概率达到该比例的 token 集合中采样。与 llama.cpp 自身默认值一致。',
    ),

  minP: Schema.number()
    .default(0)
    .description(
      '最小概率阈值（--min-p）：过滤掉概率低于「最佳候选概率 × 本值」的 token。0 = 不过滤。' +
        '注意 llama.cpp 自身的默认值是 0.05，本项默认 0 意味着过滤被关掉。',
    ),

  presencePenalty: Schema.number()
    .default(0)
    .description('存在惩罚（--presence-penalty）：正值会鼓励模型谈论新话题。0 = 不惩罚。'),

  repeatPenalty: Schema.number()
    .default(1)
    .description(
      '重复惩罚（--repeat-penalty）：1.0 表示不惩罚，大于 1.0 的值会抑制重复内容。' +
        '注意 llama.cpp 自身的默认值是 1.1，本项默认 1.0 意味着惩罚被关掉。',
    ),

  repeatLastN: Schema.number()
    .default(64)
    .description('重复惩罚检查的 token 范围（--repeat-last-n）：检查最近这么多个 token 的重复情况。'),

  seed: Schema.number()
    .default(-1)
    .description('随机数种子（--seed）：-1 = 每次启动都使用随机种子（与 llama.cpp 默认一致）。填固定值可让输出可复现。'),

  // ── 多模态图像预算与推理预算 ──────────────────────────────────────────────
  imageMinTokens: Schema.number()
    .default(1024)
    .description(
      '每张图最少编码成多少 token（--image-min-tokens）。影响视觉理解的精细度与计算开销：' +
        '调大 → 细节更多、更慢更吃显存；调小 → 更省但可能看不清小字。' +
        '只对**动态分辨率**的视觉模型生效（普通视觉模型会忽略），且必须先挂上视觉投影文件（--mmproj）。' +
        '注意：开了「多 Token 预测（MTP）」时视觉投影会被禁用，这两项也就无从生效。',
    ),

  imageMaxTokens: Schema.number()
    .default(4096)
    .description(
      '每张图最多编码成多少 token（--image-max-tokens）。必须 >= 上面的最小 token 数，插件会自动收敛。' +
        '这是单张图的开销上限 —— 显存紧张时优先调小这一项。同样只对动态分辨率的视觉模型生效。',
    ),

  reasoningBudget: Schema.number()
    .default(4096)
    .description(
      '推理过程的 token 预算（--reasoning-budget）：限制思考链的最大长度，超出后强制结束思考直接作答。' +
        '取值语义：-1 = 不限（llama.cpp 默认值）、0 = 立即结束思考、N>0 = 给出预算上限。' +
        '需要模型模板支持思考标记，且需要较新的 llama.cpp 构建（插件会先探测，构建不认就跳过）。' +
        '★ 与「启用思考」的关系：本项是加载时下发的引擎级上限，「启用思考」是每次请求的模板级开关，' +
        '两者不冲突但会叠加，详见「启用思考」那一项的说明。想彻底不思考请优先用「启用思考」，本项用于给思考链设上限。' +
        '两个要注意的地方：① 预算耗尽时模型是被硬掐断的，llama.cpp 的过渡提示语（--reasoning-budget-message）插件不下发，' +
        '预算设得太紧会让回答质量明显下降（官方维护者用 HumanEval 实测 94% → 78%），需要提示语请用「附加参数」自己加；' +
        '② 0 虽然语义上是「立即结束思考」，但在个别模型上并不完全可靠。',
    ),

  jinja: Schema.boolean()
    .default(true)
    .description('使用模型自带 Jinja 对话模板（--jinja）。dsh 的工具调用依赖它，除非模型模板不兼容否则不要关。'),

  chatTemplate: Schema.string()
    .default('')
    .description('手动指定对话模板（--chat-template）。留空 = 用模型内置模板。工具调用异常时可试 chatml 或模板文件路径。'),

  enableThinking: Schema.boolean()
    .default(true)
    .description(
      '启用思考：控制模型推理时是否输出思考过程（think）。' +
        '开启 = 每次请求下发 chat_template_kwargs.enable_thinking=true；关闭 = 下发 false，跳过思考直接作答，明显更快也更省 token。' +
        '这一项改在请求体里，不动模型加载参数，所以旧版 llama.cpp 上最坏也只是「开关无效」，不会导致加载失败。' +
        '★ 与「推理 token 预算」（--reasoning-budget）的关系：两者都能让模型「少想」，但作用层不同 —— ' +
        '本项是**模板级、每次请求生效**（告诉模板别进入思考模式）；预算是**引擎级、加载时下发**（数着思考 token，超了就强制结束思考）。' +
        '两者不互斥、不会互相报错，但会叠加：本项关闭时预算根本不会被触发（模板都不进思考了）；' +
        '而本项开启 + 预算为 0 会形成「先进思考、再被立刻掐断」，通常表现为一个空的思考块，个别模型上还会直接跑偏 —— 这两个组合建议避开。',
    ),

  preserveThinking: Schema.boolean()
    .default(true)
    .description(
      '保留历史 think：多轮对话时是否把历史消息里的 think 思考内容留在上下文中。' +
        '开启 = 下发 chat_template_kwargs.preserve_thinking=true，并原样保留历史消息（模型能看到自己之前的推理，通常更准但更费 token）；' +
        '关闭 = 下发 preserve_thinking=false，并顺带从历史 assistant 消息里剥掉 reasoning_content / think 文本，让上下文更短。' +
        '仅对模板支持该开关的模型（如 Qwen3.6 系列）完全生效，其它模型会忽略。',
    ),

  mmap: Schema.boolean()
    .default(true)
    .description('内存映射加载模型（mmap）。默认开启，加载快、内存占用低；网络盘或特殊文件系统下可关闭。'),

  mlock: Schema.boolean()
    .default(false)
    .description('锁定模型到物理内存（--mlock）。防止被换出，但会导致内存不足时报错，按需开启。'),

  apiKey: Schema.string()
    .default('')
    .description('本地服务访问密钥。留空 = 不校验（仅监听回环地址时推荐）。填写后会同时用于 llama-server 与 dsh 侧路由。')
    .role('secret'),

  extraArgs: Schema.string()
    .default('')
    .description('附加命令行参数，按空格分词、支持引号。例如：--no-warmup --rope-scaling linear。'),

  envOverrides: Schema.dict(Schema.string())
    .default({})
    .description('传递给 llama-server 的额外环境变量，例如 CUDA_VISIBLE_DEVICES=0。'),

  idleUnloadMinutes: Schema.number()
    .default(5)
    .description('空闲卸载：连续多少分钟没有对话交互就自动卸载模型并释放显存/内存。0 = 关闭自动卸载。'),

  startupTimeoutMs: Schema.number()
    .default(180000)
    .description('等待模型加载完成的超时（毫秒）。首次加载大模型可能较慢，默认 3 分钟。'),

  shutdownGraceMs: Schema.number()
    .default(8000)
    .description('卸载时的优雅退出等待时间（毫秒），超时后强制结束进程树。'),

  autoRestart: Schema.boolean()
    .default(true)
    .description('llama-server 意外崩溃且仍在使用中时，自动重启一次。'),

  maxRestarts: Schema.number()
    .default(2)
    .description('连续崩溃时最多自动重启几次，超过后进入失败状态并停止重试，避免无限重启打满 CPU。'),

  logLevel: Schema.union(['silent', 'error', 'warn', 'info', 'debug'] as const)
    .default('info')
    .description('插件日志级别。排查启动问题时设为 debug 可以看到 llama-server 的完整输出。'),
})

/** 从 schemastery schema 反推它的输出类型。 */
type OutputOf<S> = S extends (value: unknown) => infer T ? T : never

/**
 * 编译期护栏：schema 推导出的类型必须能赋给 LocalModelConfig。
 * 以后给 schema 加字段却忘了同步接口（或反之），这里会直接编译失败，
 * 而不是等到运行时 config.xxx 变成 undefined。
 */
const _configShapeCheck: LocalModelConfig = null as unknown as OutputOf<typeof Config>
void _configShapeCheck
