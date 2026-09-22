/**
 * llama-server 启动参数拼装。
 *
 * 刻意做成纯函数：不碰进程、不碰 fs，输入确定则输出确定 —— 这是「启动逻辑稳定可靠」
 * 里最容易被回归破坏的一环，独立出来才能被单测钉死。
 */
import type { FlashAttnMode } from './capabilities.js';
/** llama.cpp 的 Flash Attention 三态。与 `-fa, --flash-attn [on|off|auto]` 对齐。 */
export type FlashAttnSetting = 'auto' | 'on' | 'off';
/**
 * GPU 层数策略。与 `-ngl, --gpu-layers ... either an exact number, 'auto', or 'all'` 对齐。
 *
 * `auto` 是默认值，原因很具体：新版 llama.cpp 的 `--fit` 会按可用显存自动调整
 * **用户没有显式设置**的参数。一旦把层数钉成具体数字，自适应就被跳过 ——
 * 模型放不下时，行为从「优雅降级（少放几层）」变成「直接 OOM 崩溃」。
 */
export type GpuLayersMode = 'auto' | 'all' | 'custom';
export interface LlamaServerArgInput {
    /** -m 模型文件（分片模型传第一片）。 */
    modelPath: string;
    host: string;
    port: number;
    /** --alias：固定对外暴露的模型名，让 dsh 侧的路由配置不必随模型文件变化。 */
    alias: string;
    ctxSize: number;
    gpuLayersMode: GpuLayersMode;
    /** 仅在 gpuLayersMode = custom 时生效；负数表示「全部层」。 */
    gpuLayers: number;
    /** 该构建的 -ngl 是否接受 'auto' / 'all' 关键字（由 --help 探测得到）。 */
    gpuLayersSupport: {
        auto: boolean;
        all: boolean;
    };
    threads: number;
    threadsBatch: number;
    batchSize: number;
    ubatchSize: number;
    flashAttention: FlashAttnSetting;
    /** 该构建的 --flash-attn 接受哪种形状（由 --help 探测得到）。 */
    flashAttnMode: FlashAttnMode;
    /** K 缓冲的量化精度；'auto' = 不下发（用 llama.cpp 默认 f16）。未传视为 q8_0。 */
    cacheTypeK?: string;
    /** V 缓冲的量化精度；'auto' = 不下发。未传视为 q8_0。 */
    cacheTypeV?: string;
    /** 统一的 KV 缓存管理策略（--kv-unified）。 */
    kvUnified: boolean;
    /** --kv-stream-stage-mib；0 = 不下发。 */
    kvStreamStageMib: number;
    /**
     * 服务端默认输出上限（-n / --n-predict）。负数 = 不下发。
     *
     * 与配置里的 `maxTokens` 不是一回事：那个是 dsh 路由声明、最终体现为**每次请求**的
     * `max_tokens`；这个是**没带 max_tokens 的请求**的兜底上限。kvmem 那个独立 server 上
     * 它默认是 128，小得离谱 —— 任何绕过 dsh 的调用（curl、脚本、别的客户端）都只会吐 128 个 token。
     */
    nPredict: number;
    /** 权重加载方式（-lm / --load-mode）：auto|none|mmap|mlock|mmap+mlock|dio。空串 = 不下发。 */
    loadMode: string;
    /** 频率惩罚（--frequency-penalty）；0 = 不下发（0 即不惩罚，与构建默认一致）。 */
    frequencyPenalty: number;
    /** MTP 草稿的 K/V 精度（--spec-kv-dtype）。空串 = 不下发。 */
    specKvDtype: string;
    /** MTP 单次草稿 token 数（--spec-draft-n-max）。负数 = 不下发。 */
    specDraftNMax: number;
    /** MTP 草稿最小接受概率（--spec-draft-p-min）。负数 = 不下发。 */
    specDraftPMin: number;
    /** GPU KV 缓存类型（--kv-dtype，kvmem 分支的合并写法，一次设 K 和 V）。空串 = 不下发。 */
    kvDtype: string;
    /** 视觉编码器放 GPU（true = 构造默认，不下发；false = 下发 --no-mmproj-offload 放 CPU）。 */
    mmprojOffload: boolean;
    /** 模板文件路径（--chat-template-file）。空串 = 不下发。 */
    chatTemplateFile: string;
    /** 模板默认参数（--chat-template-kwargs，JSON 文本）。空串 = 不下发。 */
    chatTemplateKwargs: string;
    /** 服务端默认推理档位（--reasoning-effort）。空串 = 不下发。 */
    reasoningEffort: string;
    /** 预算耗尽时注入的过渡语（--reasoning-budget-message）。空串 = 不下发。 */
    reasoningBudgetMessage: string;
    /**
     * 是否启用 KVMem（true = 构建默认，不下发；false = 下发 --no-kvmem 退回普通 KV 缓存）。
     */
    kvmemEnabled: boolean;
    /** GPU 工作集 token 数（--kvmem-budget）。负数 = 不下发（构建默认 0 = 等于 n_ctx）。 */
    kvmemBudget: number;
    /**
     * 解码预留（--kvmem-gen-reserve）：**单次生成的上限**（含思考）。
     *
     * 🔴 这个构建的默认值只有 256 —— 也就是说不开这一项，每次回复最多只能生成 256 个 token。
     * 负数 = 不下发。
     */
    kvmemGenReserve: number;
    /** 检索块大小（--kvmem-block-tokens）。负数 = 不下发。 */
    kvmemBlockTokens: number;
    /** 常驻前缀 token 数（--kvmem-sink-tokens）。负数 = 不下发。 */
    kvmemSinkTokens: number;
    /** 常驻后缀 token 数（--kvmem-recent-tokens）。负数 = 不下发。 */
    kvmemRecentTokens: number;
    /** 选择算法：recency | retrieval（--kvmem-method）。空串 = 不下发。 */
    kvmemMethod: string;
    /** 检索查询取提示词末尾多少 token（--kvmem-query-last）。负数 = 不下发。 */
    kvmemQueryLast: number;
    /** 检索查询的上限 token 数（--kvmem-query-max-tokens）。负数 = 不下发。 */
    kvmemQueryMaxTokens: number;
    /** 查询重放模式：legacy | auto（--kvmem-query-replay）。空串 = 不下发。 */
    kvmemQueryReplay: string;
    /** 查询策略：legacy | user（--kvmem-query-policy）。空串 = 不下发。 */
    kvmemQueryPolicy: string;
    /** MTP 状态模式：snapshots | auto | replay（--kvmem-mtp-state）。空串 = 不下发。 */
    kvmemMtpState: string;
    /** 槽池占显存的比例上限（--kvmem-gpu-ratio，如 0.8）。负数 = 不下发（构建默认 0.50）。 */
    kvmemGpuRatio: number;
    /** CPU 溢出场大小 GiB（--kvmem-cpu-gb）。负数 = 不下发（构建默认 0 = 关闭）。 */
    kvmemCpuGb: number;
    /** NVMe 溢出场大小 GiB（--kvmem-nvme-gb）。负数 = 不下发（构建默认 0 = 关闭）。 */
    kvmemNvmeGb: number;
    /** NVMe 溢出场目录（--kvmem-nvme-dir）。空串 = 不下发。 */
    kvmemNvmeDir: string;
    /** 用原始 K 预填 V 到主机内存（--kvmem-harvest-v，裸开关）。 */
    kvmemHarvestV: boolean;
    /** 把原始 K 与 V 落到 NVMe（--kvmem-raw-k-nvme，需要 --kvmem-nvme-gb）。 */
    kvmemRawKNvme: boolean;
    /** 采样参数：全部按配置显式下发（它们的默认值就是用户指定的值）。 */
    temp: number;
    topK: number;
    topP: number;
    minP: number;
    presencePenalty: number;
    repeatPenalty: number;
    repeatLastN: number;
    seed: number;
    /** 每张图的最少/最多 token 数（--image-min-tokens / --image-max-tokens）；0 = 不下发该项。 */
    imageMinTokens: number;
    imageMaxTokens: number;
    /** 推理 token 预算（--reasoning-budget）。0 = 关掉思考，-1 = 不限。 */
    reasoningBudget: number;
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
    knownFlags: ReadonlySet<string> | null;
    /** --jinja：OpenAI 风格 function calling 依赖它，默认开。 */
    jinja: boolean;
    chatTemplate: string;
    mmproj: string;
    /**
     * 多 Token 预测（MTP）：下发 `--spec-type draft-mtp`。
     *
     * 与 `mmproj` 的关系由 `mtpWithVision` 决定 —— 上游 llama.cpp 里两者不能共存，
     * 但 kvmem 分支的 llama-kvmem-server 可以（本机实测同时加载成功）。
     */
    mtp: boolean;
    /**
     * 允许 MTP 与视觉投影同时下发（默认开）。
     *
     * 关掉时恢复旧的互斥行为：MTP 生效、`--mmproj` 被忽略并给出说明。
     */
    mtpWithVision: boolean;
    mmap: boolean;
    mlock: boolean;
    apiKey: string;
    /** 原生附加参数，按 shell 规则分词。 */
    extraArgs: string;
}
export declare const DEFAULT_ALIAS = "local";
export interface BuiltLlamaArgs {
    args: string[];
    /** 本次下发的选项名（不含值、不含 extraArgs）。用来和 --help 对照，提前发现不认识的选项。 */
    usedFlags: string[];
    /** 有参数因为构建形状不支持而没能下发时的说明，交给调用方记日志。 */
    notices: string[];
}
/** 兼容历史布尔值：true → on，false → off；无法识别的一律回到 auto。 */
export declare function normalizeFlashAttn(value: unknown): FlashAttnSetting;
/**
 * KV cache 量化精度。
 *
 * 关键事实：长上下文时 **KV cache 是显存大头**，比模型权重还吃 —— 27B 模型在 16K ctx 下
 * KV cache 的 f16 表示是几个 GB，q8 直接减半。这是大模型最容易 OOM 的隐藏点：
 * 显存够装下模型 + 默认 f16 KV，但装不下模型 + 长 ctx + f16 KV。手动用 q8 减半就装得下。
 *
 * 'auto' 永远不下发（让 llama.cpp 用默认 f16），给专家路径用。
 */
export type KvCacheType = 'auto' | 'f16' | 'q8_0' | 'q4_0' | 'q4_1' | 'q5_0' | 'q5_1' | 'bf16' | 'f32' | 'iq4_nl';
export declare function normalizeCacheType(value: unknown): KvCacheType;
export declare function normalizeGpuLayersMode(value: unknown): GpuLayersMode;
/**
 * GPU 层数的下发规则。
 *
 * - `auto`：优先下发 `-ngl auto`（把卸载决策交给 llama.cpp 的 --fit 按可用显存自适应）。
 *   构建不认这个关键字时退回 `-ngl -1`（全部上，即老行为），并出一句说明 ——
 *   老构建上不下发 -ngl 会退化成纯 CPU，那是比「全部上」糟糕得多的意外。
 * - `all`：`-ngl all`，不支持则 `-ngl -1`。
 * - `custom`：`-ngl <数字>`；负数按「全部」处理。
 */
export declare function gpuLayersArgs(mode: GpuLayersMode, layers: number, support: {
    auto: boolean;
    all: boolean;
}): {
    args: string[];
    notice: string | null;
};
/**
 * Flash Attention 的下发规则。
 *
 * 核心取舍：**auto 永远不下发**。因为 auto 在所有支持三态的构建里都等于默认值，
 * 而在只支持裸开关的老构建里根本表达不出来 —— 不下发是唯一在两种构建上语义都正确的做法。
 * 这样也顺带避开了「这个构建收不收 auto 这个字面量」的问题。
 */
export declare function flashAttnArgs(setting: unknown, mode: FlashAttnMode): {
    args: string[];
    notice: string | null;
};
/**
 * 把配置里的数字渲染成命令行文本。
 *
 * 为什么不能直接 `String(value)`：采样参数是小数，用户在界面上敲的 0.75 经 JSON 往返后
 * 可能是 0.7500000000000001 这类浮点噪声，直接拼进命令行既难看又可能被 llama.cpp 判为非法。
 * 统一截到 6 位有效小数再去掉尾零。
 */
export declare function formatNumber(value: number): string;
export declare function buildLlamaServerArgs(input: LlamaServerArgInput): BuiltLlamaArgs;
/**
 * 引号感知的参数分词：支持 'a b'、"a b"。
 *
 * 关于反斜杠：**不**把它当通用转义符。用户会往这里贴 Windows 路径
 * （`--lora "C:\users\me\lora.bin"`、`--chat-template C:\tpl\qwen.jinja`），
 * 一旦把 `\` 当转义符，路径会被静默吃掉字符，比分词不准难查得多。
 * 只保留一个例外：`\"` / `\'` 转义它自己所在的那种引号。
 */
export declare function splitArgs(raw: string): string[];
/** 把参数数组还原成可读命令行（用于日志与 status 输出，注意会暴露 --api-key）。 */
export declare function renderCommandLine(command: string, args: string[]): string;
export declare function redactArgs(args: string[]): string[];
