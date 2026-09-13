import type { Log } from './log.js';
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
    private pipe;
}
