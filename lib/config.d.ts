/**
 * 插件配置。这个 schema 就是 dsh 设置页「本地模型」那一栏的全部内容 ——
 * 每一项都带 description / default，设置页会据此自动渲染成表单。
 * 约束：默认值只写在 schema 里，业务代码不再写一份，避免两处漂移。
 */
export interface LocalModelConfig {
    enabled: boolean;
    modelsDir: string;
    runtimeDir: string;
    llamaServerPath: string;
    selectedModel: string;
    /** 手动指定的视觉投影文件（mmproj）；留空 = 沿用同目录的自动关联。 */
    mmprojFile: string;
    /**
     * 多 Token 预测（MTP）。开启后下发 `--spec-type draft-mtp`。
     *
     * 与视觉投影的关系由 `mtpWithVision` 决定：上游 llama.cpp 里两者不能共存，
     * 但 kvmem 那个独立 server 可以（本机实测：`clip_model_loader: has vision encoder`
     * 与 `creating MTP draft context` 同时出现且服务正常）。
     */
    mtp: boolean;
    /**
     * MTP 与视觉投影**同时**下发（默认开启）。
     *
     * true = 两个都发。上游 llama.cpp 上这样会让服务端加载失败，所以那一侧要关掉本项；
     * false = 保持旧的互斥行为（MTP 生效、`--mmproj` 被忽略并给出提示）。
     */
    mtpWithVision: boolean;
    preload: boolean;
    host: string;
    port: number;
    llamaPort: number;
    ctxSize: number;
    /**
     * GPU 层数怎么决定。默认 auto —— 让 llama.cpp 的 --fit 按可用显存自适应。
     * 钉成具体数字会跳过这层保护，模型放不下时从「少放几层」变成「直接 OOM」。
     */
    gpuLayersMode: 'auto' | 'all' | 'custom';
    /** 仅在 gpuLayersMode = custom 时生效；负数表示全部层。 */
    gpuLayers: number;
    threads: number;
    threadsBatch: number;
    batchSize: number;
    ubatchSize: number;
    /** 与 llama.cpp 的 `-fa, --flash-attn [on|off|auto]` 对齐；auto = 不下发。 */
    flashAttention: 'auto' | 'on' | 'off';
    /**
     * K 缓冲的量化精度。默认 q8_0：长上下文时 KV cache 是显存大头，q8_0 比默认 f16 省一半、
     * 精度损失极小，是大模型（≥13B）+ 长 ctx（≥8K）的标配。显存富余或特别在意精度时改 f16。
     * 'auto' = 不下发，由 llama.cpp 用其默认 f16。
     */
    cacheTypeK: 'auto' | 'f16' | 'q8_0' | 'q4_0' | 'q4_1' | 'q5_0' | 'q5_1' | 'bf16' | 'f32' | 'iq4_nl';
    /** V 缓冲的量化精度。默认与 K 同步。 */
    cacheTypeV: 'auto' | 'f16' | 'q8_0' | 'q4_0' | 'q4_1' | 'q5_0' | 'q5_1' | 'bf16' | 'f32' | 'iq4_nl';
    /** 统一的 KV 缓存管理策略（--kv-unified）。默认关闭 = 不下发，交给 llama.cpp 决定。 */
    kvUnified: boolean;
    /**
     * 把这么多 MiB 的 KV 缓存暂存到主机内存，以减轻显存压力（--kv-stream-stage-mib）。
     *
     * **这是特定 llama.cpp 分支（自适应 KV 流式）的私有参数**，上游构建不认识它 ——
     * 插件因此按 `--help` 探测结果决定是否下发，不认识的构建上会被跳过。0 = 不下发。
     */
    kvStreamStageMib: number;
    /** 是否启用 KVMem（--no-kvmem 关闭）。默认开启 = 不下发该参数。 */
    kvmemEnabled: boolean;
    /** GPU 工作集 token 数（--kvmem-budget）。-1 = 不下发（构建默认 0 = 等于 n_ctx）。 */
    kvmemBudget: number;
    /** 解码预留（--kvmem-gen-reserve）：**单次生成的上限**（含思考）。-1 = 不下发。 */
    kvmemGenReserve: number;
    /** 检索块大小（--kvmem-block-tokens）。-1 = 不下发。 */
    kvmemBlockTokens: number;
    /** 常驻前缀 token 数（--kvmem-sink-tokens）。-1 = 不下发。 */
    kvmemSinkTokens: number;
    /** 常驻后缀 token 数（--kvmem-recent-tokens）。-1 = 不下发。 */
    kvmemRecentTokens: number;
    /** 选择算法（--kvmem-method）：recency | retrieval。空串 = 不下发。 */
    kvmemMethod: string;
    /** 检索查询取提示词末尾多少 token（--kvmem-query-last）。-1 = 不下发。 */
    kvmemQueryLast: number;
    /** 检索查询的上限 token 数（--kvmem-query-max-tokens）。-1 = 不下发。 */
    kvmemQueryMaxTokens: number;
    /** 查询重放模式（--kvmem-query-replay）：legacy | auto。空串 = 不下发。 */
    kvmemQueryReplay: string;
    /** 查询策略（--kvmem-query-policy）：legacy | user。空串 = 不下发。 */
    kvmemQueryPolicy: string;
    /** MTP 状态模式（--kvmem-mtp-state）：snapshots | auto | replay。空串 = 不下发。 */
    kvmemMtpState: string;
    /** 槽池占显存比例上限（--kvmem-gpu-ratio，如 0.8）。-1 = 不下发。 */
    kvmemGpuRatio: number;
    /** CPU 溢出场 GiB（--kvmem-cpu-gb）。-1 = 不下发（构建默认 0 = 关闭）。 */
    kvmemCpuGb: number;
    /** NVMe 溢出场 GiB（--kvmem-nvme-gb）。-1 = 不下发（构建默认 0 = 关闭）。 */
    kvmemNvmeGb: number;
    /** NVMe 溢出场目录（--kvmem-nvme-dir）。空串 = 不下发。 */
    kvmemNvmeDir: string;
    /** 用原始 K 预填 V 到主机内存（--kvmem-harvest-v）。 */
    kvmemHarvestV: boolean;
    /** 原始 K 与 V 落 NVMe（--kvmem-raw-k-nvme，需 --kvmem-nvme-gb）。 */
    kvmemRawKNvme: boolean;
    /** 服务端默认输出上限（-n / --n-predict）。-1 = 不下发。 */
    nPredict: number;
    /** 权重加载方式（-lm / --load-mode）：auto|none|mmap|mlock|mmap+mlock|dio。空串 = 不下发。 */
    loadMode: string;
    /** GPU KV 缓存类型（--kv-dtype，一次设 K 和 V）。空串 = 不下发。 */
    kvDtype: string;
    /** MTP 草稿 K/V 精度（--spec-kv-dtype）。空串 = 不下发。 */
    specKvDtype: string;
    /** MTP 单次草稿 token 数（--spec-draft-n-max）。-1 = 不下发。 */
    specDraftNMax: number;
    /** MTP 草稿最小接受概率（--spec-draft-p-min）。-1 = 不下发。 */
    specDraftPMin: number;
    /** 频率惩罚（--frequency-penalty）。0 = 不下发。 */
    frequencyPenalty: number;
    /** 视觉编码器放 GPU；关闭时下发 --no-mmproj-offload。 */
    mmprojOffload: boolean;
    /** 模板文件路径（--chat-template-file）。空串 = 不下发。 */
    chatTemplateFile: string;
    /** 模板默认参数 JSON（--chat-template-kwargs）。空串 = 不下发。 */
    chatTemplateKwargs: string;
    /** 服务端默认推理档位（--reasoning-effort）。空串 = 不下发。 */
    reasoningEffort: string;
    /** 预算耗尽时的过渡语（--reasoning-budget-message）。空串 = 不下发。 */
    reasoningBudgetMessage: string;
    /**
     * 输出上限溢出保护（默认开启）。
     *
     * 关掉它，`prompt + max_tokens > n_ctx` 的请求会原样撞到服务端 ——
     * 上游 llama.cpp 只是打 warning 并自行收敛，kvmem 那个独立 server 则是**硬拒绝 400**。
     */
    guardContextOverflow: boolean;
    /** 温度（--temp）。越高越随机。llama.cpp 自身默认 0.8。 */
    temp: number;
    /** 仅从概率最高的 K 个 token 中采样（--top-k）。0 = 不过滤。llama.cpp 自身默认 40。 */
    topK: number;
    /** 核采样阈值（--top-p）：累计概率达到该比例的 token 集合。llama.cpp 自身默认 0.95。 */
    topP: number;
    /** 最小概率阈值（--min-p）：低于「最佳 token 概率 × 该值」的 token 被过滤。0 = 不过滤。llama.cpp 自身默认 0.05。 */
    minP: number;
    /** 存在惩罚（--presence-penalty）。正值鼓励谈论新话题。 */
    presencePenalty: number;
    /** 重复惩罚（--repeat-penalty）。1.0 = 不惩罚。llama.cpp 自身默认 1.1。 */
    repeatPenalty: number;
    /** 重复惩罚检查的 token 范围（--repeat-last-n）。 */
    repeatLastN: number;
    /** 随机种子（--seed）。-1 = 每次启动都用随机种子。 */
    seed: number;
    /** 每张图最少编码成多少 token（--image-min-tokens）。只对动态分辨率的视觉模型生效。 */
    imageMinTokens: number;
    /** 每张图最多编码成多少 token（--image-max-tokens）。只对动态分辨率的视觉模型生效。 */
    imageMaxTokens: number;
    /** 推理过程的 token 预算（--reasoning-budget），限制思考链最大长度。 */
    reasoningBudget: number;
    jinja: boolean;
    chatTemplate: string;
    /** 是否让模型输出思考内容（chat_template_kwargs.enable_thinking）。 */
    enableThinking: boolean;
    /** 是否在上下文中保留历史消息里的 think 内容（chat_template_kwargs.preserve_thinking）。 */
    preserveThinking: boolean;
    mmap: boolean;
    mlock: boolean;
    apiKey: string;
    extraArgs: string;
    envOverrides: Record<string, string>;
    idleUnloadMinutes: number;
    startupTimeoutMs: number;
    shutdownGraceMs: number;
    autoRestart: boolean;
    maxRestarts: number;
    /**
     * dsh 侧路由声明的单次最大输出 tokens。
     *
     * 这是「接入 dsh」那一组里唯一保留的设置项（其余已按用户要求从 schema 中删除，
     * 改为硬编码常量），因此它在设置页里被归入「推理参数」分组。
     */
    maxTokens: number;
    logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug';
}
export declare const Config: import("@deepseek-ai/schemastery").Schema<{
    enabled: boolean;
    modelsDir: string;
    runtimeDir: string;
    llamaServerPath: string;
    selectedModel: string;
    mmprojFile: string;
    mtp: boolean;
    mtpWithVision: boolean;
    preload: boolean;
    host: string;
    port: number;
    llamaPort: number;
    ctxSize: number;
    maxTokens: number;
    gpuLayers: number;
    gpuLayersMode: "auto" | "all" | "custom";
    threads: number;
    threadsBatch: number;
    batchSize: number;
    ubatchSize: number;
    flashAttention: "auto" | "on" | "off";
    cacheTypeK: "auto" | "f16" | "q8_0" | "q4_0" | "q4_1" | "q5_0" | "q5_1" | "bf16" | "f32" | "iq4_nl";
    cacheTypeV: "auto" | "f16" | "q8_0" | "q4_0" | "q4_1" | "q5_0" | "q5_1" | "bf16" | "f32" | "iq4_nl";
    kvUnified: boolean;
    kvStreamStageMib: number;
    kvmemEnabled: boolean;
    kvmemBudget: number;
    kvmemGenReserve: number;
    kvmemBlockTokens: number;
    kvmemSinkTokens: number;
    kvmemRecentTokens: number;
    kvmemMethod: "" | "recency" | "retrieval";
    kvmemQueryLast: number;
    kvmemQueryMaxTokens: number;
    kvmemQueryReplay: "" | "auto" | "legacy";
    kvmemQueryPolicy: "" | "legacy" | "user";
    kvmemMtpState: "" | "auto" | "snapshots" | "replay";
    kvmemGpuRatio: number;
    kvmemCpuGb: number;
    kvmemNvmeGb: number;
    kvmemNvmeDir: string;
    kvmemHarvestV: boolean;
    kvmemRawKNvme: boolean;
    nPredict: number;
    loadMode: "" | "auto" | "none" | "mmap" | "mlock" | "mmap+mlock" | "dio";
    kvDtype: "" | "f16" | "q8_0" | "q4_0" | "q5_0" | "f32";
    specKvDtype: "" | "f16" | "q8_0" | "q4_0" | "q5_0" | "f32";
    specDraftNMax: number;
    specDraftPMin: number;
    frequencyPenalty: number;
    mmprojOffload: boolean;
    chatTemplateFile: string;
    chatTemplateKwargs: string;
    reasoningEffort: "" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    reasoningBudgetMessage: string;
    guardContextOverflow: boolean;
    temp: number;
    topK: number;
    topP: number;
    minP: number;
    presencePenalty: number;
    repeatPenalty: number;
    repeatLastN: number;
    seed: number;
    imageMinTokens: number;
    imageMaxTokens: number;
    reasoningBudget: number;
    jinja: boolean;
    chatTemplate: string;
    enableThinking: boolean;
    preserveThinking: boolean;
    mmap: boolean;
    mlock: boolean;
    apiKey: string;
    extraArgs: string;
    envOverrides: Record<string, string>;
    idleUnloadMinutes: number;
    startupTimeoutMs: number;
    shutdownGraceMs: number;
    autoRestart: boolean;
    maxRestarts: number;
    logLevel: "silent" | "error" | "warn" | "info" | "debug";
}>;
