import type { Log } from '../log.js';
export interface LlamaServerExitInfo {
    code: number | null;
    signal: NodeJS.Signals | null;
    /** true = 我们自己要求它退出的，不是崩溃。 */
    expected: boolean;
}
export interface LlamaServerOptions {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    pidFile: string;
    log: Log;
    onExit?: (info: LlamaServerExitInfo) => void;
}
/** 探测端口是否被占用（能 listen 就是空闲）。 */
export declare function isPortFree(host: string, port: number): Promise<boolean>;
/** 优先用 preferred，被占用则让内核分配一个空闲端口。 */
export declare function findFreePort(host: string, preferred: number): Promise<number>;
export declare function isProcessAlive(pid: number): boolean;
export interface HealthResult {
    state: 'ok' | 'loading' | 'unreachable';
    detail: string;
}
/** 读 llama-server 的 /health：加载中返回 503，就绪返回 200 {"status":"ok"}。 */
export declare function probeHealth(host: string, port: number, timeoutMs?: number): Promise<HealthResult>;
/**
 * 从 llama-server 的 /props 读出**实际生效**的上下文长度。
 *
 * 为什么不能只看配置：新版 llama.cpp 的 `--fit` 为了塞进显存会把上下文悄悄调小，
 * 而 dsh 侧声明的 contextWindow 还是原值。两者不一致时，长会话会在中途崩，
 * 且崩得毫无线索 —— 所以启动后要对一次账，把偏差明说。
 */
export declare function fetchServerContext(host: string, port: number, timeoutMs?: number): Promise<number | null>;
/**
 * llama-server 子进程的一次生命周期。
 * 只负责「起、等就绪、停」，不懂业务语义 —— 状态机在 lifecycle.ts。
 */
export declare class LlamaServer {
    private readonly options;
    private child;
    private expectedStop;
    private tail;
    private remainder;
    constructor(options: LlamaServerOptions);
    get running(): boolean;
    get pid(): number | null;
    get logTail(): string[];
    get commandLine(): string;
    /** 拉起进程并写 pid 文件。不等待模型加载完成。 */
    start(): Promise<void>;
    /** 轮询 /health 直到就绪；超时抛错，错误里带日志尾巴，方便定位。 */
    waitUntilReady(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<void>;
    /**
     * 优雅停：先请它自己退，等 graceMs；还没走就强杀整个进程树。
     * 进程树很关键 —— llama-server 在某些后端下会派生 worker，只杀父进程会留下占显存的孤儿。
     */
    stop(graceMs?: number): Promise<void>;
    /** 启动时调用：清掉上一次 dsh 异常退出残留的 llama-server，避免白占显存。 */
    killStaleProcess(): Promise<number | null>;
    private consume;
    private append;
    private writePidFile;
    private clearPidFile;
}
/**
 * 插件加载时回收上一次 dsh 异常退出留下的 llama-server。
 * 不做这件事的后果很具体：旧进程一直握着显存，新模型加载直接 OOM。
 */
export declare function killStaleLlamaProcess(pidFile: string, log: Log): Promise<number | null>;
