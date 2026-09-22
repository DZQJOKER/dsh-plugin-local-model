import Schema from '@deepseek-ai/schemastery';
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
        .description('视觉投影文件（mmproj），用于给多模态模型开启图像输入 —— 加载时作为 --mmproj 下发给 llama-server。' +
        '留空 = 保持原有行为：只在模型同目录里能唯一确定归属时自动关联 mmproj-*.gguf；' +
        '选中具体文件 = 强制使用它（覆盖自动关联）。纯文本模型不需要这一项，保持留空即可。' +
        '注意：开启「多 Token 预测（MTP）」时本项会被忽略（MTP 与图像输入不能共存）。'),
    mtp: Schema.boolean()
        .default(false)
        .description('多 Token 预测（Multi-Token Prediction，加载时下发 --spec-type draft-mtp）。' +
        '让模型用它自带的预测头一次猜测并校验多个 token，本地生成速度通常能提升 1.2～2 倍（越长的回复越明显），' +
        '代价是首字前的 prompt 处理略慢、显存多占一点。' +
        '两个前提：① llama.cpp 构建要支持 MTP（2026-05 之后的构建）；② 模型必须是带 MTP 头的 GGUF（文件名常带 MTP 字样），' +
        '普通 GGUF 打开这个开关不会有任何加速。' +
        '与视觉投影的关系见下一项「MTP 与视觉共存」。'),
    mtpWithVision: Schema.boolean()
        .default(true)
        .description('MTP 与视觉投影同时启用（默认开启）。' +
        '**kvmem 分支的 llama-kvmem-server 支持两者共存**（本机实测：视觉头与 MTP 草稿上下文同时加载、看图对话正常），' +
        '所以默认允许「开着 MTP 用图片」。' +
        '⚠️ 官方 llama.cpp 的 llama-server 不行 —— 同时给它 --spec-type draft-mtp 与 --mmproj 会导致**加载失败**。' +
        '如果你换回官方构建并因此在启动时看到加载错误，把本项关掉即可：关闭后两个选项恢复互斥，' +
        'MTP 生效、视觉投影被忽略（插件会给出一条说明，不会静默）。'),
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
        .description('上下文长度（llama.cpp 的 -c）。建议 8K 起步，显存够再往上加。' +
        'dsh 侧路由声明的上下文窗口会跟着这一项走（不再单独配置），两者始终对齐，因此不会出现「声明比实际大」导致长会话中途崩的情况。'),
    maxTokens: Schema.number()
        .default(8192)
        .description('单次最大输出 tokens：dsh 侧路由用它决定一次回复的上限。' +
        '必须明显小于上面的上下文长度（要留出提示词占用的空间），否则长会话会挤爆上下文。'),
    gpuLayers: Schema.number()
        .default(-1)
        .description('仅在「GPU 层数策略 = 自定义」时生效。具体卸载到 GPU 的层数（-ngl）；填负数表示全部层。' +
        '显存不够时会直接报错甚至崩，除非你清楚模型的确放得下，否则建议把策略留在「自动」。'),
    gpuLayersMode: Schema.union(['auto', 'all', 'custom'])
        .default('auto')
        .description('GPU 层数策略（-ngl）。自动 = 下发 -ngl auto，让 llama.cpp 的 --fit 按可用显存决定卸载多少层 —— ' +
        '模型放不下时会自动少放几层而不是直接崩；全部 = 全部层上 GPU（-ngl all）；自定义 = 按上面的数字下发。' +
        '注意 --fit 只调整「用户没显式设置」的参数，所以钉死层数会关掉这层保护。'),
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
    flashAttention: Schema.union(['auto', 'on', 'off'])
        .default('auto')
        .description('Flash Attention 三态，与 llama.cpp 的 -fa / --flash-attn 对齐。auto（推荐）= 不下发该参数，交给 llama.cpp 自己判断；' +
        'on / off 为显式开关。插件会先探测这个构建的 --flash-attn 是「裸开关」还是「带值」，再决定怎么下发。'),
    cacheTypeK: Schema.union(['auto', 'f16', 'q8_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'bf16', 'f32', 'iq4_nl'])
        .default('q8_0')
        .description('K 缓冲的量化精度（--cache-type-k）。默认 q8_0 —— 长上下文时 KV cache 是显存大头，' +
        'q8_0 比 llama.cpp 默认的 f16 省一半显存、精度损失极小；大模型 + 长上下文发生 OOM 时优先调这里。' +
        'auto = 不下发该参数（用 llama.cpp 默认 f16），仅在你知道自己在做什么时选。'),
    cacheTypeV: Schema.union(['auto', 'f16', 'q8_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'bf16', 'f32', 'iq4_nl'])
        .default('q8_0')
        .description('V 缓冲的量化精度（--cache-type-v）。一般与 K 保持一致（默认 q8_0）。' +
        'auto = 不下发该参数（用 llama.cpp 默认 f16）。'),
    // ── KV 缓存策略 ──────────────────────────────────────────────────────────
    kvUnified: Schema.boolean()
        .default(false)
        .description('统一的 KV 缓存管理策略（--kv-unified）。开启后 KV 缓存用一整块统一缓冲管理，' +
        '在长序列下更容易组织缓存、也能减少「按层分配」造成的显存碎片，长上下文更容易装下。' +
        '代价是这块缓冲在加载时就按完整上下文一次性预留，即使你很少跑满也会占住显存。' +
        '默认关闭 = 不下发该参数，由 llama.cpp 自己决定。'),
    kvStreamStageMib: Schema.number()
        .default(1024)
        .description('KV 缓存主机内存暂存量（MiB，--kv-stream-stage-mib）：把这么多 KV 缓存暂存到主机内存，' +
        '以减轻显存压力，是本插件所适配的那个「自适应 KV 流式」分支的核心参数。' +
        '取值取决于模型、上下文长度、显卡与其它显存占用，建议从保守值起步、逐步加大并观察启动情况与峰值显存。' +
        '注意：这是那个分支的私有参数，上游 llama.cpp 不认识它 —— 插件会先探测构建，认不出来的构建上自动跳过（并在日志里说明）。0 = 不下发。' +
        '★ 它有前缀条件：块级 KV 流式要求**单序列**，所以只要本项 > 0 且构建支持，插件会**自动追加 -np 1**' +
        '（llama.cpp 的 -np 默认是「自动」，会落到多序列并导致加载直接失败）。' +
        '因此开启本项后并发槽位为 1 —— 本地单人使用没有影响，但如果你在「附加参数」里自己设了 -np / --parallel，' +
        '插件不会覆盖它，那里不是 1 就会加载失败。'),
    // ── KVMem 分块 KV 检索（kvmem/kvmem-llama.cpp 分支专有）──────────────────
    /*
     * 这一整组的默认值都是「不下发」：-1 表示不传该参数、空串表示不传、
     * 布尔项按构建默认。因此装了官方 llama.cpp 的用户不会受任何影响 ——
     * 这些选项会先经过 --help 探测，构建不认识就整体跳过（并在日志里说明）。
     *
     * 反过来，用 kvmem 分支的人会拿到一个关键提醒：它的 --kvmem-gen-reserve 默认只有 256，
     * 而那是**单次生成的上限**，详见该项的说明。
     */
    kvmemEnabled: Schema.boolean()
        .default(true)
        .description('启用 KVMem 分块 KV 检索（--kvmem / --no-kvmem）。默认开启（不下发参数，用构建默认值）：' +
        '历史 token 按块保存在主机侧，GPU 只留一个工作集，长上下文因此不必整个塞进显存。' +
        '关闭后会下发 --no-kvmem，退回普通 KV 缓存 —— 显存占用与上下文长度强相关，长上下文更容易 OOM。' +
        '仅对 kvmem 分支的 llama-kvmem-server 生效，官方 llama.cpp 构建会跳过本项。'),
    kvmemBudget: Schema.number()
        .default(-1)
        .description('GPU 工作集 token 数（--kvmem-budget）：检索时最多把多少历史 token 留在显存里。' +
        '-1 = 不下发，沿用构建默认（0，含义是「等于 n_ctx」）。' +
        '这是长上下文显存占用的主要旋钮：调小省显存、但检索能触达的历史更少；' +
        '调大则相反。它与下面的「解码预留」共同决定 GPU KV 总量（budget + gen_reserve）。'),
    kvmemGenReserve: Schema.number()
        .default(-1)
        .description('解码预留（--kvmem-gen-reserve）：为「新生成的 token」预留的 GPU 槽位。' +
        '★ 它同时是**单次生成的上限**（含思考内容）—— 一次回复无论你怎么设置都写不过这个长度，' +
        '超出会被硬截断且不报错。' +
        '⚠️ 这个构建的默认值只有 256：不设置它，模型每次回复最多只能写 256 个 token，' +
        '表现是「回答说到一半突然停住」，很容易被误判成模型坏了。' +
        '建议设成不小于 dsh 路由的「单次最大输出 tokens」（例如 8192～16384）。-1 = 不下发（= 沿用 256）。'),
    kvmemBlockTokens: Schema.number()
        .default(-1)
        .description('检索块大小（--kvmem-block-tokens）：KV 按这么大的块组织与搬运。默认 128。-1 = 不下发。'),
    kvmemSinkTokens: Schema.number()
        .default(-1)
        .description('常驻前缀 token 数（--kvmem-sink-tokens）：开头这么多 token 始终留在 GPU 工作集里，不被检索淘汰。' +
        '适合让系统提示词这类「每一轮都要用到」的内容常驻。0 = 只保留一个块（并非关闭）。-1 = 不下发。'),
    kvmemRecentTokens: Schema.number()
        .default(-1)
        .description('常驻后缀 token 数（--kvmem-recent-tokens）：最近这么多 token 始终保留在工作集里。默认 0。-1 = 不下发。'),
    kvmemMethod: Schema.union(['', 'recency', 'retrieval'])
        .default('')
        .description('选择算法（--kvmem-method）：retrieval = 按当前提问检索最相关的历史块（默认，长对话更适合）；' +
        'recency = 只按新旧程度保留最近的块。空 = 不下发。'),
    kvmemQueryLast: Schema.number()
        .default(-1)
        .description('检索查询的兜底长度（--kvmem-query-last）：取末尾这么多 token 当查询。默认 64。-1 = 不下发。'),
    kvmemQueryMaxTokens: Schema.number()
        .default(-1)
        .description('检索查询的长度上限（--kvmem-query-max-tokens）：把「最后一条用户消息」当查询时截到多长。默认 512。-1 = 不下发。'),
    kvmemQueryReplay: Schema.union(['', 'legacy', 'auto'])
        .default('')
        .description('查询重放模式（--kvmem-query-replay）。空 = 不下发（构建默认 auto）。不确定就留空。'),
    kvmemQueryPolicy: Schema.union(['', 'legacy', 'user'])
        .default('')
        .description('查询策略（--kvmem-query-policy）。空 = 不下发（构建默认 user）。不确定就留空。'),
    kvmemMtpState: Schema.union(['', 'snapshots', 'auto', 'replay'])
        .default('')
        .description('MTP 状态模式（--kvmem-mtp-state）：开着多 Token 预测时，草稿状态怎么跨轮复用。' +
        '空 = 不下发（构建默认 replay）。开 MTP 且长对话出现异常时可以先试 auto。'),
    kvmemGpuRatio: Schema.number()
        .default(-1)
        .description('槽池显存占比上限（--kvmem-gpu-ratio，0～1 的小数，例如 0.8）：KV 槽池最多占显卡显存的这个比例。' +
        '默认 0.50；显存富余时可以调大以容纳更长的工作集。-1 = 不下发。'),
    kvmemCpuGb: Schema.number()
        .default(-1)
        .description('CPU 溢出场大小（GiB，--kvmem-cpu-gb）：超出 GPU 工作集的历史可以溢到主机内存多少 GiB。' +
        '0 = 关闭（构建默认）。注意它换的是内存而不是「免费容量」，会拖慢长上下文的取回。-1 = 不下发。'),
    kvmemNvmeGb: Schema.number()
        .default(-1)
        .description('NVMe 溢出场大小（GiB，--kvmem-nvme-gb）：把溢出的 KV 落到 NVMe 文件。0 = 关闭（构建默认）。-1 = 不下发。'),
    kvmemNvmeDir: Schema.string()
        .default('')
        .description('NVMe 溢出场目录（--kvmem-nvme-dir）。留空 = 不下发（构建默认 /tmp/kvmem_nvme，Windows 上建议显式指定一个盘上目录）。'),
    kvmemHarvestV: Schema.boolean()
        .default(false)
        .description('用原始 K 预填 V 到主机内存（--kvmem-harvest-v）。默认关闭。仅在按官方配方调优 NVMe 溢写时才需要。'),
    kvmemRawKNvme: Schema.boolean()
        .default(false)
        .description('把原始 K 与 V 都写到 NVMe（--kvmem-raw-k-nvme）。需要先设置上面的 NVMe 溢出场大小，否则构建会报错。'),
    // ── 输出上限、加载方式、MTP 细节与模板 ────────────────────────────────────
    nPredict: Schema.number()
        .default(-1)
        .description('服务端默认输出上限（-n / --n-predict）：**没有自带 max_tokens 的请求**最多生成多少 token。' +
        '与「单次最大输出 tokens」不是一回事 —— 那个是 dsh 路由声明、每条请求都会带上；' +
        '这一项只影响绕过 dsh 的调用（curl、脚本、其它客户端）。' +
        '⚠️ kvmem 分支的这个默认值只有 128，用外部脚本调本地模型时建议设成 8192 一类的值。-1 = 不下发。'),
    loadMode: Schema.union(['', 'auto', 'none', 'mmap', 'mlock', 'mmap+mlock', 'dio'])
        .default('')
        .description('权重加载方式（-lm / --load-mode）：auto = 自动、none = 不特殊处理、mmap = 内存映射、' +
        'mlock = 锁定物理内存、mmap+mlock = 两者、dio = 直接 IO（绕过页缓存）。' +
        '空 = 不下发，此时沿用下面「内存映射」「锁定内存」两个开关（等价于旧行为）。' +
        'kvmem 分支已把 --mmap / --no-mmap / --mlock 归为 -lm 的过时别名，用本项更可靠。'),
    kvDtype: Schema.union(['', 'f16', 'f32', 'q8_0', 'q5_0', 'q4_0'])
        .default('')
        .description('GPU KV 缓存类型（--kv-dtype）：一次设置 K 和 V 两项，是 kvmem 分支的合并写法。' +
        '空 = 不下发，改用下面「KV cache 精度（K/V）」两项（上游 llama.cpp 只有那两个通道）。' +
        '两者同时设置属于重复配置，插件会给出提示，建议只留一个。仅对 kvmem 分支生效。'),
    specKvDtype: Schema.union(['', 'f16', 'f32', 'q8_0', 'q5_0', 'q4_0'])
        .default('')
        .description('多 Token 预测（MTP）草稿用的 K/V 精度（--spec-kv-dtype）。空 = 不下发（构建默认 f16）。降低它可以省显存。'),
    specDraftNMax: Schema.number()
        .default(-1)
        .description('MTP 单次草稿 token 数（--spec-draft-n-max）：一次猜几个后续 token。默认 3；调大可能更快也可能白猜。-1 = 不下发。'),
    specDraftPMin: Schema.number()
        .default(-1)
        .description('MTP 草稿的最小接受概率（--spec-draft-p-min，0～1）。默认 0（不做此过滤）。-1 = 不下发。'),
    frequencyPenalty: Schema.number()
        .default(0)
        .description('频率惩罚（--frequency-penalty）：按出现次数抑制重复用词，-2～2。0 = 不惩罚，也**不会下发**该参数（与构建默认一致）。'),
    mmprojOffload: Schema.boolean()
        .default(true)
        .description('视觉编码器放 GPU（--mmproj-offload / --no-mmproj-offload）。默认开启（不下发参数）。' +
        '显存紧张时关掉它，视觉编码会改用 CPU 计算 —— 省显存但看图明显变慢。只在挂了视觉投影文件时有意义。'),
    chatTemplateFile: Schema.string()
        .default('')
        .description('对话模板文件路径（--chat-template-file）：直接读一个 Jinja 模板文件，替代模型 GGUF 里内置的那份。' +
        '与上面的「对话模板」是两条通道，同时设置时生效顺序由构建决定，建议只留一个。留空 = 不下发。'),
    chatTemplateKwargs: Schema.string()
        .default('')
        .description('模板默认参数（--chat-template-kwargs，JSON 文本）。例如 {"enable_thinking":true}。' +
        '这是**加载时**的模板默认值，逐条请求里的同名参数会覆盖它。留空 = 不下发。'),
    reasoningEffort: Schema.union(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
        .default('')
        .description('服务端默认推理档位（--reasoning-effort）：**请求没有自己表达档位**时用的值，直接交给模型模板；' +
        'none = 不思考。档位名必须被模型模板认识（kvmem 构建在这点上是宽容的，认不出会退回模板默认档）。' +
        '空 = 不下发。注意：dsh 对话框里的「推理等级」滑杆是逐条请求下发的，两者不冲突，请求优先。'),
    reasoningBudgetMessage: Schema.string()
        .default('')
        .description('推理预算耗尽时的过渡语（--reasoning-budget-message）：思考被强制结束前注入的一句话，' +
        '用于让模型平滑收尾（如「时间到，请直接作答」）。不填时模型是被硬掐断的，回答质量会明显下降。留空 = 不下发。'),
    guardContextOverflow: Schema.boolean()
        .default(true)
        .description('输出上限溢出保护（默认开启）。' +
        '上游 llama.cpp 遇到 prompt + max_tokens 超过上下文时只会打一条 warning 并自行收敛，' +
        '但 kvmem 分支的独立 server 会**直接返回 400**：prompt + max_tokens exceeds n_ctx，' +
        '且报错里既没有 prompt 长度也没有 n_ctx，很难定位。' +
        '开启后插件会在请求进入时把「必然失败」的超大输出上限压到装得下，并在服务端拒绝时逐级减半重试；' +
        '实在装不下才把错误交回，并附上一句说明真实原因的中文提示。' +
        '它只动 max_tokens，不碰你的对话内容，关掉它不会带来任何额外能力 —— 除非你在排查这一层的问题。'),
    // ── 采样参数 ────────────────────────────────────────────────────────────
    temp: Schema.number()
        .default(0.75)
        .description('温度（--temp）：控制输出随机性，越高越随机、越低越确定。' +
        '注意 llama.cpp 自身的默认值是 0.8，本项默认 0.75 意味着插件会显式下发这个参数并覆盖它。'),
    topK: Schema.number()
        .default(20)
        .description('仅从概率最高的 K 个 token 中采样（--top-k）。0 = 不过滤（保留全部候选）。' +
        '注意 llama.cpp 自身的默认值是 40。'),
    topP: Schema.number()
        .default(0.95)
        .description('核采样（--top-p）：仅从累计概率达到该比例的 token 集合中采样。与 llama.cpp 自身默认值一致。'),
    minP: Schema.number()
        .default(0)
        .description('最小概率阈值（--min-p）：过滤掉概率低于「最佳候选概率 × 本值」的 token。0 = 不过滤。' +
        '注意 llama.cpp 自身的默认值是 0.05，本项默认 0 意味着过滤被关掉。'),
    presencePenalty: Schema.number()
        .default(0)
        .description('存在惩罚（--presence-penalty）：正值会鼓励模型谈论新话题。0 = 不惩罚。'),
    repeatPenalty: Schema.number()
        .default(1)
        .description('重复惩罚（--repeat-penalty）：1.0 表示不惩罚，大于 1.0 的值会抑制重复内容。' +
        '注意 llama.cpp 自身的默认值是 1.1，本项默认 1.0 意味着惩罚被关掉。'),
    repeatLastN: Schema.number()
        .default(64)
        .description('重复惩罚检查的 token 范围（--repeat-last-n）：检查最近这么多个 token 的重复情况。'),
    seed: Schema.number()
        .default(-1)
        .description('随机数种子（--seed）：-1 = 每次启动都使用随机种子（与 llama.cpp 默认一致）。填固定值可让输出可复现。'),
    // ── 多模态图像预算与推理预算 ──────────────────────────────────────────────
    imageMinTokens: Schema.number()
        .default(1024)
        .description('每张图最少编码成多少 token（--image-min-tokens）。影响视觉理解的精细度与计算开销：' +
        '调大 → 细节更多、更慢更吃显存；调小 → 更省但可能看不清小字。' +
        '只对**动态分辨率**的视觉模型生效（普通视觉模型会忽略），且必须先挂上视觉投影文件（--mmproj）。' +
        '注意：开了「多 Token 预测（MTP）」时视觉投影会被禁用，这两项也就无从生效。'),
    imageMaxTokens: Schema.number()
        .default(4096)
        .description('每张图最多编码成多少 token（--image-max-tokens）。必须 >= 上面的最小 token 数，插件会自动收敛。' +
        '这是单张图的开销上限 —— 显存紧张时优先调小这一项。同样只对动态分辨率的视觉模型生效。'),
    reasoningBudget: Schema.number()
        .default(4096)
        .description('推理过程的 token 预算（--reasoning-budget）：限制思考链的最大长度，超出后强制结束思考直接作答。' +
        '取值语义：-1 = 不限（llama.cpp 默认值）、0 = 立即结束思考、N>0 = 给出预算上限。' +
        '需要模型模板支持思考标记，且需要较新的 llama.cpp 构建（插件会先探测，构建不认就跳过）。' +
        '★ 与「启用思考」的关系：本项是加载时下发的引擎级上限，「启用思考」是每次请求的模板级开关，' +
        '两者不冲突但会叠加，详见「启用思考」那一项的说明。想彻底不思考请优先用「启用思考」，本项用于给思考链设上限。' +
        '两个要注意的地方：① 预算耗尽时模型是被硬掐断的，llama.cpp 的过渡提示语（--reasoning-budget-message）插件不下发，' +
        '预算设得太紧会让回答质量明显下降（官方维护者用 HumanEval 实测 94% → 78%），需要提示语请用「附加参数」自己加；' +
        '② 0 虽然语义上是「立即结束思考」，但在个别模型上并不完全可靠。'),
    jinja: Schema.boolean()
        .default(true)
        .description('使用模型自带 Jinja 对话模板（--jinja）。dsh 的工具调用依赖它，除非模型模板不兼容否则不要关。'),
    chatTemplate: Schema.string()
        .default('')
        .description('手动指定对话模板（--chat-template）。留空 = 用模型内置模板。工具调用异常时可试 chatml 或模板文件路径。'),
    enableThinking: Schema.boolean()
        .default(true)
        .description('启用思考：让模型推理时输出思考过程（think）。' +
        '开启 = 只当**默认值**：请求里没有自己表达思考状态时，插件才补 chat_template_kwargs.enable_thinking=true；' +
        '请求里已经写了 enable_thinking 或推理档位（reasoning_effort）就**原样放行、不覆盖** —— ' +
        '因此 dsh 对话框里的「推理等级」滑杆选 Off 能真正关掉思考。' +
        '关闭 = 无条件强制 enable_thinking=false，彻底不思考（硬覆盖）。' +
        '这一项改在请求体里，不动模型加载参数，所以旧版 llama.cpp 上最坏也只是「开关无效」，不会导致加载失败。' +
        '★ 与「推理 token 预算」（--reasoning-budget）的关系：两者都能让模型「少想」，但作用层不同 —— ' +
        '本项是**模板级、每次请求生效**（告诉模板别进入思考模式）；预算是**引擎级、加载时下发**（数着思考 token，超了就强制结束思考）。' +
        '两者不互斥、不会互相报错，但会叠加：本项关闭时预算根本不会被触发（模板都不进思考了）；' +
        '而本项开启 + 预算为 0 会形成「先进思考、再被立刻掐断」，通常表现为一个空的思考块，个别模型上还会直接跑偏 —— 这两个组合建议避开。'),
    preserveThinking: Schema.boolean()
        .default(true)
        .description('保留历史 think：多轮对话时是否把历史消息里的 think 思考内容留在上下文中。' +
        '开启 = 下发 chat_template_kwargs.preserve_thinking=true，并原样保留历史消息（模型能看到自己之前的推理，通常更准但更费 token）；' +
        '关闭 = 下发 preserve_thinking=false，并顺带从历史 assistant 消息里剥掉 reasoning_content / think 文本，让上下文更短。' +
        '仅对模板支持该开关的模型（如 Qwen3.6 系列）完全生效，其它模型会忽略。'),
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
    logLevel: Schema.union(['silent', 'error', 'warn', 'info', 'debug'])
        .default('info')
        .description('插件日志级别。排查启动问题时设为 debug 可以看到 llama-server 的完整输出。'),
});
/**
 * 编译期护栏：schema 推导出的类型必须能赋给 LocalModelConfig。
 * 以后给 schema 加字段却忘了同步接口（或反之），这里会直接编译失败，
 * 而不是等到运行时 config.xxx 变成 undefined。
 */
const _configShapeCheck = null;
void _configShapeCheck;
