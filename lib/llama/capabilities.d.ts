/**
 * llama-server 的构建能力探测。
 *
 * 为什么需要它：同一个参数在不同版本里形状会变，而且变了不一定报错——可能只是「按旧语义生效」。
 * 两个已经踩过的实例：
 *
 *   1. `--flash-attn`：老版本是裸开关（`-fa`），新版本变成带值（`-fa, --flash-attn [on|off|auto]`）。
 *      按旧形状发裸 flag，参数解析器会把**下一个 token 当成它的值**吃掉，
 *      报出来的却是被吞掉的那个参数名（`unknown value for --flash-attn: '--mmproj'`），排查方向直接跑偏。
 *
 *   2. `-ngl`：新版本接受 `'auto' | 'all' | 数字`，并且 `--fit` 默认开启、会按可用显存自动调整
 *      **用户没有显式设置**的参数。一旦把 `-ngl` 钉成具体数字，自适应就被跳过 —— 模型放不下时
 *      从「优雅降级」变成「直接 OOM」。所以默认值必须是 `auto`，且下发前要确认这个构建认得这个关键字。
 *
 * 做法：起进程前跑一次 `--help`，把选项与说明索引出来，再据此决定参数怎么拼。
 * 结果按可执行文件（含大小与 mtime）缓存，每次加载只付一次代价。
 */
export type FlashAttnMode = 'value' | 'bare' | 'unsupported';
export interface GpuLayersSupport {
    /** -ngl 是否接受 'auto'（= 交给 llama.cpp 按可用显存自适应）。 */
    auto: boolean;
    /** -ngl 是否接受 'all'。 */
    all: boolean;
}
export interface FlagDoc {
    /** 选项行本身的参数位与说明（不含续行）。 */
    head: string;
    /** 含续行的完整说明，关键词检索用。 */
    text: string;
    /** 该行声明的所有选项名。 */
    names: string[];
}
export interface HelpIndex {
    flags: Set<string>;
    /** 选项名 → 说明文档。 */
    docs: Map<string, FlagDoc>;
    flashAttnMode: FlashAttnMode;
    gpuLayers: GpuLayersSupport;
}
export interface LlamaCapabilities {
    ok: boolean;
    /** 探测来源，目前固定是 --help。 */
    source: string;
    flashAttnMode: FlashAttnMode;
    gpuLayers: GpuLayersSupport;
    /** 该构建认识的全部选项名（短名与长名都收）。 */
    flags: Set<string>;
    detail: string;
}
/**
 * 把 help 文本索引成「选项 → 说明」。说明可能换行（llama.cpp 会把长描述折到下一行），
 * 因此遇到不以选项名开头的后续行要并进上一条 —— 否则 `-ngl` 的说明会被截断在
 * 「either an exact number,」，就看不到下一行的 `'auto', or 'all'`。
 */
export declare function parseHelp(helpText: string): HelpIndex;
/** `--flash-attn` 后面跟的是值位还是说明文字。 */
export declare function detectFlashAttnMode(helpText: string): FlashAttnMode;
/** `-ngl` 是否接受 'auto' / 'all' 这两个关键字。 */
export declare function detectGpuLayersSupport(docs: Map<string, FlagDoc>): GpuLayersSupport;
/** 测试用：清掉探测缓存。 */
export declare function resetCapabilityCache(): void;
export declare function probeCapabilities(executable: string, options?: {
    timeoutMs?: number;
}): Promise<LlamaCapabilities>;
/**
 * 我们准备下发的选项里，有哪些是这个构建不认识的。
 *
 * 入参是「我们自己拼出来的 flag 列表」（构建器顺带产出），因此不需要去猜
 * 哪个 token 是值哪个是选项。用来在 spawn 之前就给出可读的警告，
 * 而不是等 llama-server 用一句含糊的 usage 报错。
 */
export declare function unknownFlags(usedFlags: readonly string[], known: ReadonlySet<string>): string[];
/** 是否为「--flash-attn 形状不对」这一类错误（用于自动重试判断）。 */
export declare function isFlashAttnFormError(text: string): boolean;
