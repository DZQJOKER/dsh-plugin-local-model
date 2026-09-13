/**
 * 把 llama-server 的失败日志翻译成「人能照着做」的结论。
 *
 * 为什么值得单独做一层：llama-server 挂掉时吐出来的是几十行英文日志，最后一行常常是
 * `GGML_ASSERT(buffer) failed` 这种毫无信息量的断言，真正的病因埋在中间的某一行
 * （比如 `cudaMalloc failed: out of memory`）。用户看到的是一大坨日志，
 * 而其实只要说一句「显存不够，把上下文降到 16K，或者把 GPU 层数策略改回自动」就够了。
 *
 * 这里只做「识别 + 给下一步」，不猜不编：匹配不到就返回 null，交给原始日志尾巴。
 */
export interface Diagnosis {
    /** 一句话结论。 */
    summary: string;
    /** 可操作的建议，按优先级排列。 */
    actions: string[];
    /** 命中的判据（便于用户核对，也便于我们自己排查误判）。 */
    evidence: string;
}
/** 识别失败原因；认不出来就返回 null（不硬凑结论）。 */
export declare function diagnoseLoadFailure(logTail: string, context?: {
    gpuLayersPinned?: boolean;
}): Diagnosis | null;
/**
 * 从日志里读出 llama.cpp 实际生效的上下文长度。
 *
 * 用途：`--fit` 为了塞进显存会把上下文**悄悄调小**，而 dsh 侧声明的 contextWindow 还是原值。
 * 两者不一致时，长会话会在中途崩，且崩得毫无线索 —— 所以启动后对一次账，不一致就提醒。
 */
export declare function extractEffectiveContext(logTail: string): number | null;
