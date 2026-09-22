import type { Log } from './log.js';
import { type ThinkPolicy } from './requestRewrite.js';
import { type ContextGuardLimits } from './contextGuard.js';
export interface ProxyOptions {
    host: string;
    port: number;
    /** 当前 llama-server 的 origin；未运行时返回 null。 */
    upstream: () => string | null;
    /** 保证模型已就绪 —— 首条对话在这里触发加载。 */
    ensureReady: () => Promise<void>;
    /** 每个请求开始/结束时都会调用，用于刷新空闲计时。 */
    onRequestStart: () => void;
    onRequestEnd: () => void;
    /** 暴露给 /local-model/status 的状态快照。 */
    status: () => {
        state: string;
    };
    modelId: () => string;
    modelDisplayName: () => string;
    apiKey: () => string;
    /**
     * 本次请求要用的思考开关策略。返回 null（或压根不提供）= 完全不动请求体、原样直通。
     * 做成回调而不是启动快照：设置随时可能被改，代理必须按最新值走。
     */
    thinkPolicy?: () => ThinkPolicy | null;
    /**
     * 输出上限溢出保护。返回 null（或压根不提供）= 完全不动请求体、原样直通。
     *
     * 同样做成回调：n_ctx 会随「上下文长度」的设置变化，代理必须按最新值走。
     * nCtx 取自配置里的 ctxSize（就是启动时下发的 -c），与真实服务端一致。
     */
    contextGuard?: () => ContextGuardLimits | null;
    log: Log;
}
/**
 * 稳定的本地入口。
 *
 * 为什么不让 dsh 直接连 llama-server 的端口：那样在模型卸载后端口就没人听了，
 * 第一条对话必然连接失败。这里让插件常驻一个极轻量的代理（不占显存），
 * 由它把「模型没加载」这件事消化掉 —— 首个请求进来时拉起 llama-server、
 * 等它就绪、再原样转发（含 SSE 流式）。对 dsh 来说端点始终在线。
 */
export declare class LocalModelProxy {
    private readonly options;
    private server;
    private boundPort;
    constructor(options: ProxyOptions);
    get port(): number;
    get origin(): string;
    get running(): boolean;
    listen(maxPortProbe?: number): Promise<number>;
    close(): Promise<void>;
    private authorized;
    private handle;
    /**
     * 请求分派：决定这一条要不要碰请求体，以及走哪条转发路径。
     *
     * 两条独立的改写通道，各自可以单独关闭：
     *   policy —— 思考开关（模板参数 + 剥离历史 think）
     *   guard  —— 输出上限溢出保护（max_tokens vs n_ctx，见 contextGuard.ts）
     *
     * 两者都不需要时，保持原来的「请求体边读边转发」——一个字节都不在我们的内存里停留。
     */
    private pipe;
    /**
     * 原样转发（可带一个已改写好的请求体）。
     *
     * `body === null` 表示完全不缓冲：请求边读边发、响应边收边发，SSE 流式对话走的就是这条路。
     */
    private pipeDirect;
    /**
     * 带溢出保护地转发一条对话请求。
     *
     * 性能上的关键取舍：**只有 400 才被缓冲下来看一眼**（它的体积极小），其余状态码一律
     * 照旧流式直通 —— 所以正常对话的开销与不带保护时完全一样，连多一次拷贝都没有。
     *
     * 命中溢出判据时，把 max_tokens 逐级减半重发。服务端这项校验发生在解码之前
     * （只需对提示词分词），一次失败的尝试很便宜；而不这么做，用户拿到的那条 400
     * 里既没有 n_ctx 也没有提示词长度，除了乱试没有别的办法。
     */
    private pipeGuarded;
    /**
     * 发一次并等响应。
     *
     * 非 400 的状态码原样流给客户端并返回 `streamed`；400 则把（很小的）响应体整个读下来，
     * 交给调用方判断是「上下文放不下」还是别的错误 —— 只有前者才值得重试。
     */
    private sendOnce;
    /** 组装转发给上游的请求参数：透传头、改 host、按实际体长重算 content-length。 */
    private upstreamOptions;
    private writeHeadFrom;
    /**
     * 把缓冲下来的响应原样还给客户端；给了 hint 就换成一句能读懂的中文说明。
     *
     * 为什么值得替换原文：`prompt + max_tokens exceeds n_ctx` 里**既没有 n_ctx 也没有
     * max_tokens**，用户唯一能做的只有乱试。原文保留在 `detail` 里，便于对着日志排查。
     */
    private flushBuffered;
    private reportUpstreamError;
}
