import Schema from '@deepseek-ai/schemastery';
export const DEFAULT_MODEL_ALIAS = 'local';
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
        '开启后本插件会**自动禁用视觉投影文件**（--mmproj）—— llama.cpp 的 MTP 与图像输入目前不能共存，' +
        '强行一起下发会导致加载失败。需要看图时请关掉这一项。'),
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
        .description('上下文长度（llama.cpp 的 -c）。必须 >= dsh 侧路由声明的 contextWindow 含输出预算，建议 8K 起步，显存够再往上加。'),
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
    jinja: Schema.boolean()
        .default(true)
        .description('使用模型自带 Jinja 对话模板（--jinja）。dsh 的工具调用依赖它，除非模型模板不兼容否则不要关。'),
    chatTemplate: Schema.string()
        .default('')
        .description('手动指定对话模板（--chat-template）。留空 = 用模型内置模板。工具调用异常时可试 chatml 或模板文件路径。'),
    enableThinking: Schema.boolean()
        .default(true)
        .description('启用思考：控制模型推理时是否输出思考过程（think）。' +
        '开启 = 每次请求下发 chat_template_kwargs.enable_thinking=true；关闭 = 下发 false，跳过思考直接作答，明显更快也更省 token。' +
        '这一项改在请求体里，不动模型加载参数，所以旧版 llama.cpp 上最坏也只是「开关无效」，不会导致加载失败。'),
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
    routeName: Schema.string()
        .default('local-llama')
        .description('dsh 模型路由名（pi-ai provider 的 key）。dsh 侧配置的 providers.<这个名字> 需要指向本插件的端口。'),
    modelAlias: Schema.string()
        .default(DEFAULT_MODEL_ALIAS)
        .description('llama-server 对外暴露的模型别名（--alias）。固定别名可以让 dsh 侧配置不用随模型文件变化。'),
    routeModelId: Schema.string()
        .default(DEFAULT_MODEL_ALIAS)
        .description('dsh 模型选择器里显示的模型 id。建议与上面的别名保持一致。'),
    contextWindow: Schema.number()
        .default(32768)
        .description('dsh 侧路由声明的上下文窗口。必须与 llama.cpp 的 -c 对齐，不要大于它，否则长会话会中途崩。'),
    maxTokens: Schema.number()
        .default(8192)
        .description('dsh 侧路由声明的单次最大输出 tokens。'),
    registerRoute: Schema.boolean()
        .default(true)
        .description('自动把本地端点注册进 dsh 的 llm 缝。宿主未暴露该接口时会自动降级为提示手写配置，不影响其它功能。'),
    exposeTool: Schema.boolean()
        .default(true)
        .description('向模型暴露 local_model 工具（查询状态/列出模型）。'),
    allowModelControl: Schema.boolean()
        .default(false)
        .description('允许模型通过 local_model 工具启停模型。默认关闭：装载/卸载显存由用户掌控更安全。'),
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
