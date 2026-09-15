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
     * `null` = 探测失败/未知。新加入的那些只在较新构建或特定分支存在的选项
     * （--kv-unified / --kv-stream-stage-mib / --image-*-tokens / --reasoning-budget）
     * 只有在确认构建认得时才下发 —— 否则 llama-server 会因为未知参数**直接启动失败**，
     * 那等于「加了个开关，插件反而起不来了」。
     */
    knownFlags: ReadonlySet<string> | null;
    /** --jinja：OpenAI 风格 function calling 依赖它，默认开。 */
    jinja: boolean;
    chatTemplate: string;
    mmproj: string;
    /**
     * 多 Token 预测（MTP）：下发 `--spec-type draft-mtp`。
     *
     * 与 `mmproj` **互斥** —— 互斥由本文件的拼参数层强制保证（见 buildLlamaServerArgs），
     * 调用方即使两个都传了，也不可能拼出一条让 llama-server 加载失败的命令行。
     */
    mtp: boolean;
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
