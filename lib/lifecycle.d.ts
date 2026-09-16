import type { Log } from './log.js';
import type { ResolvedConfig } from './configResolve.js';
import { type LocalModelEntry, type ModelShard } from './registry.js';
import { type LlamaServerArgInput } from './llama/args.js';
import { type FlashAttnMode } from './llama/capabilities.js';
import { type LlamaServerExitInfo } from './llama/runner.js';
export type RuntimeState = 'disabled' | 'idle' | 'starting' | 'ready' | 'stopping' | 'failed';
export declare const STATE_LABEL: Record<RuntimeState, string>;
export interface RuntimeStatus {
    state: RuntimeState;
    stateLabel: string;
    model: {
        id: string;
        displayName: string;
        quant: string | null;
        params: string | null;
        sizeBytes: number;
    } | null;
    /** dsh 侧应当配置的 baseURL。 */
    endpoint: string;
    /** llama-server 实际监听地址，未运行时为 null。 */
    upstream: string | null;
    pid: number | null;
    loadedAt: number | null;
    lastActivityAt: number;
    /** 预计卸载时间；空闲卸载关闭时为 null。 */
    unloadAt: number | null;
    /** 距离自动卸载还剩多少毫秒（≤0 表示已经过期，tick 下次巡检就会触发）；关闭时为 null。 */
    unloadInMs: number | null;
    /** 当前被什么挡住没有卸载；null 表示「已到期，等下次 tick」。这是定位"5 分钟没卸载"的第一现场。 */
    unloadBlockedBy: string | null;
    /** 上次巡检 unload 条件的时间戳。 */
    lastTickAt: number | null;
    idleUnloadMinutes: number;
    activeRequests: number;
    restarts: number;
    lastError: string | null;
    logTail: string[];
    modelsFound: number;
    modelsDir: string;
    runtimeDir: string;
    /** 本次加载会下发给 llama-server 的 --mmproj（绝对路径）；无视觉能力时为 null。 */
    visionProjector: string | null;
    /** 多 Token 预测（MTP）当前是否开启。 */
    mtp: boolean;
    /**
     * 视觉投影**因为开了 MTP 而被顶掉**时的说明（一句人话）；不是这种情况时为 null。
     *
     * 与 visionProjector 的区别：后者只说「最终下发什么」，这里回答「为什么本来该有的没了」——
     * 用户开了 MTP 之后看到视觉投影变空，不给理由的话只会以为是插件坏了。
     */
    visionDisabledByMtp: string | null;
    /**
     * 当前模型模板支持的推理档位；`null` = 没解析出来（此时不下发档位，只控制开关）。
     *
     * 暴露到状态里是刻意的：档位表决定了「面板上选的那个档位最后变成什么」，
     * 排查「拨了没反应」时第一眼就该看到它。
     */
    reasoningEfforts: string[] | null;
}
/** 插件向生命周期层注入的代理句柄，避免 lifecycle 直接依赖 http 实现。 */
export interface ProxyHost {
    readonly origin: string;
    listen(): Promise<number>;
    close(): Promise<void>;
}
/** llama-server 子进程的最小接口。默认实现是真实进程，测试可注入替身。 */
export interface LlamaServerLike {
    readonly running: boolean;
    readonly pid: number | null;
    readonly logTail: string[];
    readonly commandLine: string;
    start(): Promise<void>;
    waitUntilReady(host: string, port: number, timeoutMs: number): Promise<void>;
    stop(graceMs: number): Promise<void>;
}
export interface LaunchInput {
    config: ResolvedConfig;
    entry: LocalModelEntry;
    /** 已经挑好的内部端口。 */
    port: number;
    /** 已经定位好的可执行文件绝对路径。 */
    executable: string;
    /** 该构建的 --flash-attn 形状（由 --help 探测得到）。 */
    flashAttnMode: FlashAttnMode;
    /** 该构建的 -ngl 是否接受 auto / all 关键字。 */
    gpuLayersSupport: {
        auto: boolean;
        all: boolean;
    };
    /** 该构建公开的选项名集合；null = 探测失败（新选项一律不下发）。 */
    knownFlags: ReadonlySet<string> | null;
    log: Log;
    /** 子进程退出回调。默认实现会把它挂到真实进程上，用于崩溃自愈。 */
    onExit: (info: LlamaServerExitInfo) => void;
}
export type ServerLauncher = (input: LaunchInput) => LlamaServerLike;
export interface RuntimeHooks {
    /** 通过会话内工具/命令切换模型时，尝试写回设置。 */
    persistSelectedModel?: (id: string) => Promise<void> | void;
    /**
     * 子进程启动方式。默认走「定位 llama-server → 拼参数 → spawn 真实进程」，
     * 留这个注入点是为了让「首请求拉起 / 空闲卸载」这条主线能跑真实的端到端测试
     * （见 scripts/e2e.mjs），而不是只测到状态机的表面。
     */
    launchServer?: ServerLauncher;
}
/**
 * 空闲卸载判定的纯函数形式。
 *
 * 之所以抽出来：这是本插件最核心的业务规则（连续 N 分钟无交互即释放资源），
 * 边界条件（正在加载、有活跃请求、关闭了自动卸载）必须能被逐个钉死，
 * 而不是埋在定时器回调里靠肉眼看。
 *
 * 「activeRequests 计数被卡住」的自愈：SSE 长连接若因为 TCP 异常没正常 close，
 * finish() 永远不被调，计数永远 > 0，卸载就再也触发不了。但**只要还有活请求在跑，
 * lastActivityAt 就会被不断刷新**；反过来说，如果 lastActivityAt 已经 5 分钟没动，
 * activeRequests > 0 一定是计数器泄漏，把这一路也判为可卸载。这是用两条独立信号交叉
 * 验证避免「单点卡死整个生命周期」。
 */
export declare function shouldUnload(input: {
    state: RuntimeState;
    activeRequests: number;
    idleUnloadMs: number;
    lastActivityAt: number;
    now: number;
}): boolean;
/**
 * 从「配置 + 模型条目 + 本次探测结果」拼出 llama-server 的参数输入。
 *
 * 抽出来的理由很实在：这个字面量有 30 多个字段，而调用点有两处（默认启动器、
 * doStart 的加载尝试循环）。以前是各写一份，加一个参数就得在两处各改一次 ——
 * 漏一处就是「某个参数在重试路径上不生效」这类极难查的错位。现在只有这一个真源。
 */
export declare function buildArgInput(config: ResolvedConfig, entry: LocalModelEntry, options: {
    port: number;
    flashAttnMode: FlashAttnMode;
    gpuLayersSupport: {
        auto: boolean;
        all: boolean;
    };
    knownFlags: ReadonlySet<string> | null;
}): LlamaServerArgInput;
/** 默认启动方式：拼参数 → 起真进程。 */
export declare function defaultServerLauncher(input: LaunchInput): LlamaServerLike;
/**
 * 本地模型的运行时状态机。
 *
 *   disabled ──(启用)──▶ idle ──首条对话──▶ starting ──就绪──▶ ready
 *                          ▲                                     │
 *                          └──── 空闲 5 分钟 / 切换模型 / 手动 ────┘
 *
 * 两条硬约束：
 *   1. 任意时刻最多一个 llama-server 进程；
 *   2. 加载与卸载都做单飞（single-flight），并发请求共享同一次加载，不会重复拉起。
 */
export declare class LocalModelRuntime {
    private readonly log;
    private readonly hooks;
    private state;
    private server;
    private proxy;
    private startPromise;
    private stopPromise;
    private ticker;
    private restartTimer;
    private models;
    private visionProjectors;
    private modelsScannedAt;
    private selectedOverride;
    private upstreamPort;
    private commandLine;
    private loadedAt;
    private lastActivityAt;
    /** 上次 tick() 跑过的时间；用来回答"5 分钟过去了吗" —— 即使 tick 没真的触发卸载。 */
    private lastTickAt;
    private activeRequests;
    private restarts;
    private lastError;
    private disposed;
    private started;
    /** 启动后探测到的 llama.cpp 实际生效的上下文（受 --fit 影响，可能小于声明值）。 */
    private effectiveContext;
    /**
     * 当前模型模板支持的推理档位（启动后从 chat template 解析得到）。
     *
     * `null` = 没解析出来 → 代理层不下发 `reasoning_effort`，只控制思考开关。
     * 这是刻意的保守取舍：模板对不认识的档位是 raise，发错一次就是整次请求 500。
     */
    private supportedEfforts;
    /** 探测结果与实际不符时（--flash-attn 形状），本次会话内记住「不下发」。 */
    private flashAttnOverride;
    private readonly listeners;
    private currentConfig;
    constructor(config: ResolvedConfig, log: Log, hooks?: RuntimeHooks);
    /** 当前生效的配置（可被设置页改写，见 applyConfig）。 */
    get config(): ResolvedConfig;
    /**
     * 换一份配置并让它立即生效。
     *
     * 规则：会改变 llama-server 进程形态的设置（模型、参数、端口、路径）只影响「下一次加载」，
     * 所以这里直接把已加载的模型卸掉 —— 用户刚改完设置，期望的是下次对话按新参数来，
     * 而不是继续用旧参数跑着。有请求正在生成时不打断它，等它跑完再卸。
     */
    applyConfig(next: ResolvedConfig, options?: {
        reload?: boolean;
    }): Promise<void>;
    attachProxy(proxy: ProxyHost): void;
    init(): Promise<void>;
    private bootstrap;
    dispose(): Promise<void>;
    /**
     * 「首条对话自动拉起模型」的唯一入口。
     * 所有请求路径都收敛到这里：没加载就加载，正在加载就复用同一个 promise。
     */
    ensureReady(): Promise<void>;
    /** 卸载模型并释放资源。空闲超时、切换模型、手动停止都走这里。 */
    unload(reason: string): Promise<void>;
    reload(reason?: string): Promise<void>;
    refreshModels(force?: boolean): Promise<LocalModelEntry[]>;
    listModels(): LocalModelEntry[];
    /** 模型目录里扫到的全部视觉投影文件（供设置页的下拉框）。 */
    listVisionProjectors(): ModelShard[];
    /**
     * 本次加载实际会下发的 --mmproj（绝对路径）；没有视觉能力时为 null。
     * 取值规则与拼参数时完全一致 —— 界面显示的和真正下发的不该是两回事。
     */
    effectiveVisionProjector(entry?: LocalModelEntry | null): string | null;
    /**
     * 「视觉投影被 MTP 顶掉了」时给一句人话，其余情况返回 null。
     *
     * 判据刻意用 resolveVisionProjector（**不含** MTP 互斥）而不是 effectiveVisionProjector：
     * 问的是「本来会不会有视觉投影」，而不是「最终下发什么」—— 后者在开了 MTP 时恒为空，
     * 拿它判断等于永远拿不到答案。
     */
    private visionDisabledByMtp;
    /** 会话内切换模型：能找到持久化钩子就落盘，否则只在本进程生效。 */
    selectModel(id: string): Promise<LocalModelEntry>;
    /**
     * 当前模型模板支持的推理档位；`null` = 没解析出来。
     *
     * 代理层拿它把请求里的档位重映射成模板真正认的值 —— 这是「档位拨了会 500」的根治点。
     */
    get reasoningEfforts(): readonly string[] | null;
    get selectedModelId(): string;
    get currentState(): RuntimeState;
    /** 请求开始时计数：有活跃请求时绝不卸载。 */
    beginRequest(): void;
    /** 请求结束时计数并刷新空闲计时。 */
    endRequest(): void;
    subscribe(listener: () => void): () => void;
    status(): RuntimeStatus;
    /**
     * 把"为什么没卸载"翻译成一句人话。
     *
     * 这是排查"5 分钟过去模型还在"的第一个现场 —— 不打开插件代码也能照着看：
     *   - "空闲卸载已关闭"：用户把 idleUnloadMinutes 设成了 0，或 schema 默认值被改过；
     *   - "尚未就绪"：首条对话没进来过，状态卡在 idle/starting/failed；
     *   - "还有 N 个进行中请求"：activeRequests 计数异常，多半是某次请求 finish() 漏调；
     *   - "还有 4.8 分钟到期"：tick 正常，5 分钟还没到；
     *   - null：到期了，下次 tick 就会触发卸载。
     */
    private explainUnloadBlocked;
    /** 人类可读状态，供 /local-model status 与日志使用。 */
    describe(): string;
    private upstreamOrigin;
    private doStart;
    private doUnload;
    private stopServerQuietly;
    private handleExit;
    private resolveSelectedModel;
    /** 空闲计时的唯一时间源：每个请求开始/结束、加载完成、卸载完成都会刷新。 */
    touch(): void;
    /**
     * 启动后核对「实际生效的上下文」。
     *
     * `--fit` 会在显存紧张时把上下文调小，而 dsh 侧声明的窗口是 `ctxSize`（两者同源）。
     * 一旦实际值小于声明值，长会话会在超出实际 ctx 后中断，且现场看不出原因 —— 因此主动对一次账。
     */
    private reconcileContext;
    /**
     * 启动后从模型模板解析「它认哪几个推理档位」。
     *
     * 为什么必须做：模板对不认识的档位是 **raise_exception**，不是忽略 ——
     * 实测 Qwen3.8 的模板只认 xhigh/medium/low，面板上选个 High 就能让整次对话 500。
     * 而各家模板的档位表并不一致，所以只能读、不能写死。
     *
     * 解析不出来时不报错，只把代理层切到「不下发档位」的保守策略（思考开关照常工作）——
     * 少一层颗粒度，好过一开口就失败。
     */
    private discoverEffortVocabulary;
    private armTicker;
    /** 配置变了（可能关掉了自动卸载、或改了时长），重排定时器。 */
    private restartTicker;
    private tick;
    private setState;
    private emit;
}
