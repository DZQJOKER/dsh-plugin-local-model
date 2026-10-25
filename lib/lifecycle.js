import { existsSync } from 'node:fs';
import { consistencyNotices } from './configResolve.js';
import { scanModelsDetailed, pickModel, formatBytes, effectiveVisionProjector, resolveVisionProjector, } from './registry.js';
import { ensureReadme } from './paths.js';
import { buildLlamaServerArgs, DEFAULT_ALIAS } from './llama/args.js';
import { buildLaunchReport } from './launchReport.js';
import { findMediaTools, mediaToolWarning, withMediaPath } from './llama/media.js';
import { describeSearchScope, locateLlamaServer } from './llama/detect.js';
import { isFlashAttnFormError, probeCapabilities, unknownFlags, } from './llama/capabilities.js';
import { diagnoseLoadFailure, extractEffectiveContext } from './llama/diagnose.js';
import { fetchServerChatTemplate, fetchServerContext, findFreePort, killStaleLlamaProcess, LlamaServer, } from './llama/runner.js';
import { extractSupportedEfforts } from './requestRewrite.js';
/** 模型目录扫描结果的缓存时间：避免每次状态查询都去读盘。 */
const SCAN_TTL_MS = 5000;
export const STATE_LABEL = {
    disabled: 'Disabled',
    idle: 'Idle (model not loaded)',
    starting: 'Loading model...',
    ready: 'Ready',
    stopping: 'Unloading...',
    failed: 'Load failed',
};
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
export function shouldUnload(input) {
    if (input.state !== 'ready')
        return false;
    if (!Number.isFinite(input.idleUnloadMs) || input.idleUnloadMs <= 0)
        return false;
    const idleFor = input.now - input.lastActivityAt;
    if (idleFor < input.idleUnloadMs)
        return false;
    if (input.activeRequests <= 0)
        return true;
    // 计数器说还有活请求，但 lastActivityAt 已经停了 ≥ idleUnloadMs —— 一定是 onRequestEnd
    // 漏调了。卸载以解锁；卸载过程中 activeRequests 会被自然清掉。
    return idleFor >= input.idleUnloadMs * 2;
}
/**
 * 从「配置 + 模型条目 + 本次探测结果」拼出 llama-server 的参数输入。
 *
 * 抽出来的理由很实在：这个字面量有 30 多个字段，而调用点有两处（默认启动器、
 * doStart 的加载尝试循环）。以前是各写一份，加一个参数就得在两处各改一次 ——
 * 漏一处就是「某个参数在重试路径上不生效」这类极难查的错位。现在只有这一个真源。
 */
export function buildArgInput(config, entry, options) {
    return {
        modelPath: entry.path,
        host: config.host,
        port: options.port,
        // 别名固定成常量（原 modelAlias 设置已删除），dsh 侧配置因此不必随模型文件变化。
        alias: DEFAULT_ALIAS,
        ctxSize: config.ctxSize,
        gpuLayersMode: config.gpuLayersMode,
        gpuLayers: config.gpuLayers,
        gpuLayersSupport: options.gpuLayersSupport,
        threads: config.threads,
        threadsBatch: config.threadsBatch,
        batchSize: config.batchSize,
        ubatchSize: config.ubatchSize,
        flashAttention: config.flashAttention,
        flashAttnMode: options.flashAttnMode,
        cacheTypeK: config.cacheTypeK,
        cacheTypeV: config.cacheTypeV,
        kvUnified: config.kvUnified,
        kvStreamStageMib: config.kvStreamStageMib,
        // ── KVMem 家族与新增启动项 ──────────────────────────────────────────────
        // 全部原样透传：拼参数层（args.ts）才是唯一决定「这一项发不发」的地方，
        // 门控与「-1 = 不下发」哨兵都写在那里，这里再判断一次只会造成两处规则漂移。
        kvmemEnabled: config.kvmemEnabled,
        kvmemBudget: config.kvmemBudget,
        kvmemGenReserve: config.kvmemGenReserve,
        kvmemBlockTokens: config.kvmemBlockTokens,
        kvmemSinkTokens: config.kvmemSinkTokens,
        kvmemRecentTokens: config.kvmemRecentTokens,
        kvmemMethod: config.kvmemMethod,
        kvmemQueryLast: config.kvmemQueryLast,
        kvmemQueryMaxTokens: config.kvmemQueryMaxTokens,
        kvmemQueryReplay: config.kvmemQueryReplay,
        kvmemQueryPolicy: config.kvmemQueryPolicy,
        kvmemMtpState: config.kvmemMtpState,
        kvmemGpuRatio: config.kvmemGpuRatio,
        kvmemCpuGb: config.kvmemCpuGb,
        kvmemNvmeGb: config.kvmemNvmeGb,
        kvmemNvmeDir: config.kvmemNvmeDir,
        kvmemHarvestV: config.kvmemHarvestV,
        kvmemRawKNvme: config.kvmemRawKNvme,
        nPredict: config.nPredict,
        loadMode: config.loadMode,
        kvDtype: config.kvDtype,
        specKvDtype: config.specKvDtype,
        specDraftNMax: config.specDraftNMax,
        specDraftPMin: config.specDraftPMin,
        frequencyPenalty: config.frequencyPenalty,
        mmprojOffload: config.mmprojOffload,
        chatTemplateFile: config.chatTemplateFile,
        chatTemplateKwargs: config.chatTemplateKwargs,
        reasoningEffort: config.reasoningEffort,
        reasoningBudgetMessage: config.reasoningBudgetMessage,
        temp: config.temp,
        topK: config.topK,
        topP: config.topP,
        minP: config.minP,
        presencePenalty: config.presencePenalty,
        repeatPenalty: config.repeatPenalty,
        repeatLastN: config.repeatLastN,
        seed: config.seed,
        imageMinTokens: config.imageMinTokens,
        imageMaxTokens: config.imageMaxTokens,
        reasoningBudget: config.reasoningBudget,
        knownFlags: options.knownFlags,
        jinja: config.jinja,
        chatTemplate: config.chatTemplate,
        // 视觉投影的实际取值与状态面板共用 effectiveVisionProjector —— 开 MTP 时这里拿到空串，
        // 因为 MTP 与图像输入不能共存（互斥的权威落点仍在 args.ts 的拼参数层）。
        mmproj: effectiveVisionProjector({
            modelsDir: config.modelsDir,
            mmprojFile: config.mmprojFile,
            autoMmproj: entry.mmproj,
            mtp: config.mtp,
            mtpWithVision: config.mtpWithVision,
        }),
        mtp: config.mtp,
        mtpWithVision: config.mtpWithVision,
        mmap: config.mmap,
        mlock: config.mlock,
        apiKey: config.apiKey,
        extraArgs: config.extraArgs,
    };
}
/** 默认启动方式：拼参数 → 起真进程。 */
export function defaultServerLauncher(input) {
    const { config, entry, port, executable, log, onExit, flashAttnMode, gpuLayersSupport, knownFlags } = input;
    const built = buildLlamaServerArgs(buildArgInput(config, entry, { port, flashAttnMode, gpuLayersSupport, knownFlags }));
    /**
     * 外部媒体工具（ffmpeg / ffprobe）—— 本插件里唯一「参数全对、模型也加载成功，
     * 但看图照样 400」的坑。
     *
     * llama.cpp 内置的图像解码器认识 png / jpeg / gif / bmp，**不认识 webp**；
     * 遇到 webp 它会去起外部的 `ffprobe` 探测、`ffmpeg` 转码，而这两个是从 **PATH** 里找的
     * （这个构建砍掉了 `--ffmpeg-path`，只剩 PATH 一条路）。机器上没装 ffmpeg 时：
     *     probe: failed to launch ffprobe
     *     mtmd_helper_bitmap_init_from_buf: failed to decode webp buffer
     * 客户端拿到 400「Failed to load image or audio file」，而同一批里的 jpeg 却正常识别 ——
     * 表现是「时好时坏」，很容易被当成插件或模型坏了。
     *
     * 所以这里把它**前置进子进程的 PATH**：装完 ffmpeg 立刻生效，不必让用户改系统 PATH
     * 再重启 dsh（winget 装完那个别名目录并不保证进入已运行进程的环境）。
     */
    const media = findMediaTools();
    if (media.dir) {
        log.info(`Media tool ready: ${media.dir} (decodes images such as WebP / AVIF)`);
    }
    else if (built.args.includes('--mmproj')) {
        log.warn(mediaToolWarning());
    }
    return new LlamaServer({
        command: executable,
        args: built.args,
        cwd: dirnameOf(executable),
        env: withMediaPath({ ...process.env, ...config.envOverrides }, media.dir),
        pidFile: config.paths.pidFile,
        log,
        onExit,
    });
}
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
export class LocalModelRuntime {
    log;
    hooks;
    state = 'idle';
    server = null;
    proxy = null;
    startPromise = null;
    stopPromise = null;
    ticker = null;
    restartTimer = null;
    models = [];
    visionProjectors = [];
    modelsScannedAt = 0;
    selectedOverride = null;
    upstreamPort = 0;
    commandLine = '';
    /** 本次启动的参数报告（设置页顶部的面板用它渲染）；未加载时为 null。 */
    launch = null;
    loadedAt = null;
    lastActivityAt = Date.now();
    /** 上次 tick() 跑过的时间；用来回答"5 分钟过去了吗" —— 即使 tick 没真的触发卸载。 */
    lastTickAt = null;
    activeRequests = 0;
    restarts = 0;
    lastError = null;
    disposed = false;
    started = false;
    /** 启动后探测到的 llama.cpp 实际生效的上下文（受 --fit 影响，可能小于声明值）。 */
    effectiveContext = null;
    /**
     * 当前模型模板支持的推理档位（启动后从 chat template 解析得到）。
     *
     * `null` = 没解析出来 → 代理层不下发 `reasoning_effort`，只控制思考开关。
     * 这是刻意的保守取舍：模板对不认识的档位是 raise，发错一次就是整次请求 500。
     */
    supportedEfforts = null;
    /** 探测结果与实际不符时（--flash-attn 形状），本次会话内记住「不下发」。 */
    flashAttnOverride = null;
    listeners = new Set();
    currentConfig;
    constructor(config, log, hooks = {}) {
        this.log = log;
        this.hooks = hooks;
        this.currentConfig = config;
    }
    /** 当前生效的配置（可被设置页改写，见 applyConfig）。 */
    get config() {
        return this.currentConfig;
    }
    /**
     * 换一份配置并让它立即生效。
     *
     * 规则：会改变 llama-server 进程形态的设置（模型、参数、端口、路径）只影响「下一次加载」，
     * 所以这里直接把已加载的模型卸掉 —— 用户刚改完设置，期望的是下次对话按新参数来，
     * 而不是继续用旧参数跑着。有请求正在生成时不打断它，等它跑完再卸。
     */
    async applyConfig(next, options = {}) {
        const previous = this.currentConfig;
        this.currentConfig = next;
        if (previous.selectedModel !== next.selectedModel) {
            // 设置页的选择优先于会话内临时选择，否则界面改了模型却毫无反应。
            this.selectedOverride = null;
        }
        // init 之前只换配置：此时还没有代理、定时器和子进程，任何副作用都无从谈起。
        if (!this.started)
            return;
        // 只有影响卸载时机的字段变了才重排定时器，避免每次保存配置都刷一条日志。
        if (previous.idleUnloadMs !== next.idleUnloadMs || previous.enabled !== next.enabled) {
            this.restartTicker();
        }
        if (!next.enabled) {
            // doUnload 会依据 config.enabled 自行落到 disabled 状态。
            await this.unload('Master switch turned off');
            this.setState('disabled');
            return;
        }
        if (this.state === 'disabled')
            this.setState('idle');
        if (options.reload && this.state === 'ready') {
            if (this.activeRequests > 0) {
                this.log.info('Settings updated; a request is currently generating — it will be reloaded with the new parameters once it finishes');
                return;
            }
            await this.unload('Settings updated');
        }
    }
    // ── 生命周期 ────────────────────────────────────────────────────────────
    attachProxy(proxy) {
        this.proxy = proxy;
    }
    async init() {
        await ensureReadme(this.config.paths);
        await this.refreshModels(true);
        if (!this.config.enabled) {
            this.setState('disabled');
            this.log.info('Local model disabled (Settings -> Local model -> master switch)');
            return;
        }
        try {
            await this.bootstrap();
        }
        catch (error) {
            this.lastError = error.message;
            this.setState('failed');
            this.log.error(`Local model plugin initialization failed: ${this.lastError}`);
            throw error;
        }
    }
    async bootstrap() {
        // 顺序很重要：先回收上次残留的进程，再启动新的，否则两个进程会抢同一块显存。
        try {
            await killStaleLlamaProcess(this.config.paths.pidFile, this.log);
        }
        catch (error) {
            this.log.debug(`Error while cleaning up a stale process: ${error.message}`);
        }
        // 常驻代理很轻（不加载模型），但它让端点「永远在线」—— 这正是首条对话能触发加载的前提。
        if (!this.proxy)
            throw new Error('Proxy not injected');
        await this.proxy.listen();
        this.armTicker();
        this.setState('idle');
        this.log.info(`Model directory: ${this.config.modelsDir}`);
        this.log.info(`Runtime directory: ${this.config.runtimeDir}`);
        if (this.models.length === 0) {
            this.log.warn('No .gguf files in the model directory yet. After adding models, go to Settings -> Local model and click "Rescan"');
        }
        else if (!this.selectedModelId) {
            this.log.info(`Found ${this.models.length} local models, but none is selected yet. Settings -> Local model -> select a model`);
        }
        this.started = true;
        if (this.config.preload && this.selectedModelId) {
            this.log.info('preload is on; starting to preload the selected model');
            void this.ensureReady().catch((error) => this.log.warn(`Preload failed: ${error.message}`));
        }
    }
    async dispose() {
        this.disposed = true;
        if (this.ticker) {
            clearInterval(this.ticker);
            this.ticker = null;
        }
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        if (this.startPromise)
            await this.startPromise.catch(() => undefined);
        await this.stopServerQuietly();
        const proxy = this.proxy;
        this.proxy = null;
        if (proxy)
            await proxy.close();
        this.listeners.clear();
        this.log.info('Local model plugin unloaded; proxy port closed');
    }
    // ── 对外能力 ────────────────────────────────────────────────────────────
    /**
     * 「首条对话自动拉起模型」的唯一入口。
     * 所有请求路径都收敛到这里：没加载就加载，正在加载就复用同一个 promise。
     */
    async ensureReady() {
        if (this.disposed)
            throw new Error('The plugin has been unloaded');
        if (!this.config.enabled)
            throw new Error('The local model plugin is disabled. Open the master switch in Harness settings -> Local model.');
        for (;;) {
            if (this.stopPromise) {
                await this.stopPromise.catch(() => undefined);
                continue;
            }
            if (this.state === 'ready' && this.server?.running) {
                this.touch();
                return;
            }
            if (!this.startPromise) {
                this.startPromise = this.doStart().finally(() => {
                    this.startPromise = null;
                });
            }
            return this.startPromise;
        }
    }
    /** 卸载模型并释放资源。空闲超时、切换模型、手动停止都走这里。 */
    async unload(reason) {
        if (this.stopPromise)
            return this.stopPromise;
        this.stopPromise = this.doUnload(reason).finally(() => {
            this.stopPromise = null;
        });
        return this.stopPromise;
    }
    async reload(reason = 'Manual reload') {
        await this.unload(reason);
        await this.ensureReady();
    }
    async refreshModels(force = false) {
        const now = Date.now();
        if (!force && now - this.modelsScannedAt < SCAN_TTL_MS)
            return this.models;
        try {
            const scanned = await scanModelsDetailed(this.config.modelsDir);
            this.models = scanned.entries;
            this.visionProjectors = scanned.visionProjectors;
        }
        catch (error) {
            this.log.error(`Failed to scan the model directory: ${error.message}`);
            this.models = [];
            this.visionProjectors = [];
        }
        this.modelsScannedAt = now;
        this.emit();
        return this.models;
    }
    listModels() {
        return this.models;
    }
    /** 模型目录里扫到的全部视觉投影文件（供设置页的下拉框）。 */
    listVisionProjectors() {
        return this.visionProjectors;
    }
    /**
     * 本次加载实际会下发的 --mmproj（绝对路径）；没有视觉能力时为 null。
     * 取值规则与拼参数时完全一致 —— 界面显示的和真正下发的不该是两回事。
     */
    effectiveVisionProjector(entry = pickModel(this.models, this.selectedModelId)) {
        if (!entry)
            return null;
        const resolved = effectiveVisionProjector({
            modelsDir: this.config.modelsDir,
            mmprojFile: this.config.mmprojFile,
            autoMmproj: entry.mmproj,
            mtp: this.config.mtp,
        });
        return resolved.length > 0 ? resolved : null;
    }
    /**
     * 「视觉投影被 MTP 顶掉了」时给一句人话，其余情况返回 null。
     *
     * 判据刻意用 resolveVisionProjector（**不含** MTP 互斥）而不是 effectiveVisionProjector：
     * 问的是「本来会不会有视觉投影」，而不是「最终下发什么」—— 后者在开了 MTP 时恒为空，
     * 拿它判断等于永远拿不到答案。
     */
    visionDisabledByMtp(entry) {
        if (!this.config.mtp)
            return null;
        // 「MTP 与视觉共存」默认为开（kvmem 分支支持），此时视觉并没有被顶掉。
        if (this.config.mtpWithVision)
            return null;
        const wouldBe = resolveVisionProjector(this.config.modelsDir, this.config.mmprojFile, entry.mmproj);
        if (!wouldBe)
            return null;
        return (`Multi-token prediction (MTP) is on, so --mmproj (${wouldBe}) will not be passed for this load: ` +
            '"MTP with vision" is turned off, so the two options are exclusive again. ' +
            'To use MTP and images together, turn it on (the kvmem branch\'s llama-kvmem-server supports this combination).');
    }
    /** 会话内切换模型：能找到持久化钩子就落盘，否则只在本进程生效。 */
    async selectModel(id) {
        await this.refreshModels(true);
        const entry = pickModel(this.models, id);
        if (!entry) {
            const available = this.models.map((m) => m.id).slice(0, 20);
            throw new Error(`"${id}" was not found in the model directory. Currently available (${this.models.length}):\n${available.map((m) => `  - ${m}`).join('\n') || '  (directory is empty)'}`);
        }
        if (!entry.complete) {
            throw new Error(`Model "${entry.displayName}" has incomplete shards, missing: ${entry.missing.join(', ') || '(unknown)'}`);
        }
        const changed = entry.id !== this.selectedModelId;
        this.selectedOverride = entry.id;
        await this.hooks.persistSelectedModel?.(entry.id);
        if (changed && (this.state === 'ready' || this.startPromise)) {
            await this.unload('Model switched');
        }
        this.emit();
        return entry;
    }
    /**
     * 当前模型模板支持的推理档位；`null` = 没解析出来。
     *
     * 代理层拿它把请求里的档位重映射成模板真正认的值 —— 这是「档位拨了会 500」的根治点。
     */
    get reasoningEfforts() {
        return this.supportedEfforts;
    }
    get selectedModelId() {
        return (this.selectedOverride ?? this.config.selectedModel ?? '').trim();
    }
    get currentState() {
        return this.state;
    }
    /** 请求开始时计数：有活跃请求时绝不卸载。 */
    beginRequest() {
        this.activeRequests++;
        this.touch();
    }
    /** 请求结束时计数并刷新空闲计时。 */
    endRequest() {
        this.activeRequests = Math.max(0, this.activeRequests - 1);
        this.touch();
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    status() {
        const entry = pickModel(this.models, this.selectedModelId);
        const idleMs = this.config.idleUnloadMs;
        const unloadAt = this.state === 'ready' && idleMs > 0 ? this.lastActivityAt + idleMs : null;
        return {
            state: this.state,
            stateLabel: STATE_LABEL[this.state],
            model: entry
                ? {
                    id: entry.id,
                    displayName: entry.displayName,
                    quant: entry.quant,
                    params: entry.params,
                    sizeBytes: entry.sizeBytes,
                }
                : null,
            endpoint: this.proxy ? `${this.proxy.origin}/v1` : '(proxy not started)',
            upstream: this.upstreamOrigin(),
            pid: this.server?.pid ?? null,
            loadedAt: this.loadedAt,
            lastActivityAt: this.lastActivityAt,
            unloadAt,
            unloadInMs: unloadAt !== null ? Math.max(0, unloadAt - Date.now()) : null,
            unloadBlockedBy: this.explainUnloadBlocked(idleMs),
            lastTickAt: this.lastTickAt,
            idleUnloadMinutes: this.config.idleUnloadMinutes,
            activeRequests: this.activeRequests,
            restarts: this.restarts,
            lastError: this.lastError,
            logTail: this.server?.logTail.slice(-10) ?? [],
            modelsFound: this.models.length,
            modelsDir: this.config.modelsDir,
            runtimeDir: this.config.runtimeDir,
            visionProjector: this.effectiveVisionProjector(entry),
            mtp: this.config.mtp,
            visionDisabledByMtp: entry ? this.visionDisabledByMtp(entry) : null,
            reasoningEfforts: this.supportedEfforts ? [...this.supportedEfforts] : null,
            launch: this.launch,
        };
    }
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
    explainUnloadBlocked(idleMs) {
        if (idleMs <= 0)
            return 'Idle unload is disabled (idleUnloadMinutes = 0)';
        if (this.state !== 'ready') {
            if (this.lastError)
                return `State ${this.state}; loading did not succeed (${this.lastError})`;
            return `State ${this.state}; model not ready`;
        }
        if (this.activeRequests > 0)
            return `${this.activeRequests} request(s) still in progress (finish() missed?)`;
        const remaining = idleMs - (Date.now() - this.lastActivityAt);
        if (remaining > 0)
            return `due in ${(remaining / 60_000).toFixed(1)} min`;
        return null;
    }
    /** 人类可读状态，供 /local-model status 与日志使用。 */
    describe() {
        const status = this.status();
        const lines = [];
        lines.push(`State: ${status.stateLabel}`);
        lines.push(`Model: ${status.model
            ? `${status.model.displayName} (${status.model.quant ?? 'unknown quantization'}, ${formatBytes(status.model.sizeBytes)})`
            : 'not selected'}`);
        lines.push(`Entry: ${status.endpoint}`);
        if (status.upstream)
            lines.push(`Upstream: ${status.upstream}${status.pid ? ` (pid ${status.pid})` : ''}`);
        if (status.visionProjector)
            lines.push(`Vision projector: ${status.visionProjector}`);
        lines.push(status.reasoningEfforts
            ? `Reasoning efforts supported by the model: ${status.reasoningEfforts.join(' / ')} (the chat box effort is remapped against this)`
            : 'Reasoning efforts supported by the model: not resolved (no effort is sent this time; only the on/off switch controls thinking)');
        if (status.state === 'ready') {
            lines.push(this.config.idleUnloadMinutes > 0
                ? `Idle unload: releases after ${this.config.idleUnloadMinutes} consecutive idle minutes${status.unloadAt ? ` (approx. ${new Date(status.unloadAt).toLocaleTimeString()})` : ''}`
                : 'Idle unload: disabled');
        }
        if (status.activeRequests > 0)
            lines.push(`In-progress requests: ${status.activeRequests}`);
        if (status.modelsFound === 0)
            lines.push(`Model directory is empty: ${status.modelsDir}`);
        if (status.lastError)
            lines.push(`Last error: ${status.lastError}`);
        return lines.join('\n');
    }
    // ── 内部实现 ────────────────────────────────────────────────────────────
    upstreamOrigin() {
        if (!this.server?.running || !this.upstreamPort)
            return null;
        return `http://${this.config.host}:${this.upstreamPort}`;
    }
    async doStart() {
        this.setState('starting');
        this.lastError = null;
        try {
            const entry = await this.resolveSelectedModel();
            const location = await locateLlamaServer({
                explicit: this.config.llamaServerPath,
                runtimeDir: this.config.runtimeDir,
            });
            if (!location) {
                throw new Error('No llama-server executable found. Download llama.cpp and extract it into the runtime directory, or enter an absolute path in settings.\nSearched locations:\n' +
                    describeSearchScope({ explicit: this.config.llamaServerPath, runtimeDir: this.config.runtimeDir }));
            }
            // 起进程前先问清楚这个构建认识哪些选项、--flash-attn 是哪种形状。
            // 同一个参数在不同版本里形状不同，猜错会让解析器把下一个参数当成它的值吃掉。
            const capabilities = await probeCapabilities(location.path);
            if (!capabilities.ok) {
                this.log.warn(`Could not probe the option support of llama-server (${capabilities.detail}). Flash Attention will not be sent; llama.cpp's own default decides.`);
            }
            else {
                this.log.debug(`Probed ${location.path}: ${capabilities.detail}`);
            }
            // 内部端口优先用配置值，被占用就自动挑空闲端口 —— 绝不和别的服务抢端口。
            const port = await findFreePort(this.config.host, this.config.llamaPort);
            this.upstreamPort = port;
            const launcher = this.hooks.launchServer ?? defaultServerLauncher;
            const preferred = this.flashAttnOverride ?? capabilities.flashAttnMode;
            // 第二种形状只在「按第一种加载失败且失败原因是 flash-attn 形状」时才会被用到。
            const attempts = preferred === 'unsupported' ? ['unsupported'] : [preferred, 'unsupported'];
            // 配置一致性提醒：与 flash-attn 的两种尝试无关，所以放在循环外面只打一次。
            // 这些数字各自写在不同的地方（dsh 路由声明 / 启动参数 / kvmem 解码预留），
            // 对不上时加载阶段一声不响，要等到某次对话才以一条读不懂的服务端错误爆出来。
            for (const notice of consistencyNotices(this.config))
                this.log.warn(`Config notice: ${notice}`);
            let server = null;
            let failure = null;
            /**
             * 最后一次拼出来的参数，用于启动后生成「本次启动参数」报告。
             *
             * 必须在循环外面接住：`built` 的作用域只在循环体内，出来就没了，
             * 而报告要的正是**实际下发的那一份**（含门控跳过与自动收敛的结果，
             * 不是设置页里填的那一份）。
             */
            let lastBuilt = null;
            for (const mode of attempts) {
                const built = buildLlamaServerArgs(buildArgInput(this.config, entry, {
                    port,
                    flashAttnMode: mode,
                    gpuLayersSupport: capabilities.gpuLayers,
                    // 探测失败时传 null：新增的「新版本才有」的选项一律不下发，宁可退回构建默认值。
                    knownFlags: capabilities.ok ? capabilities.flags : null,
                }));
                lastBuilt = built;
                for (const notice of built.notices)
                    this.log.warn(`Parameter notice: ${notice}`);
                if (capabilities.ok) {
                    const unknown = unknownFlags(built.usedFlags, capabilities.flags);
                    if (unknown.length > 0) {
                        this.log.warn(`This llama-server does not recognize the following options: ${unknown.join(', ')}; loading may fail.` +
                            'You can adjust them under "Settings -> Local model -> Extra arguments" or upgrade llama.cpp.');
                    }
                }
                const candidate = launcher({
                    config: this.config,
                    entry,
                    port,
                    executable: location.path,
                    flashAttnMode: mode,
                    gpuLayersSupport: capabilities.gpuLayers,
                    knownFlags: capabilities.ok ? capabilities.flags : null,
                    log: this.log,
                    onExit: (info) => this.handleExit(info),
                });
                this.log.info(`Loading ${entry.displayName} (${formatBytes(entry.sizeBytes)}, executable from ${location.source})`);
                try {
                    await candidate.start();
                    await candidate.waitUntilReady(this.config.host, port, this.config.startupTimeoutMs);
                    server = candidate;
                    break;
                }
                catch (error) {
                    failure = error;
                    const tail = candidate.logTail.join('\n');
                    if (mode !== 'unsupported' && isFlashAttnFormError(tail)) {
                        // 探测结果与实际不符（或探测不可用）。退一步：不下发这个参数再试一次。
                        this.flashAttnOverride = 'unsupported';
                        this.log.warn('llama-server rejected the current form of --flash-attn; it will not be sent and one retry was made');
                        await candidate.stop(this.config.shutdownGraceMs).catch(() => undefined);
                        continue;
                    }
                    await candidate.stop(this.config.shutdownGraceMs).catch(() => undefined);
                    throw new Error(explainServerFailure(tail, error, this.config));
                }
            }
            if (!server)
                throw failure ?? new Error('Could not start llama-server');
            this.server = server;
            this.commandLine = server.commandLine;
            /**
             * 启动参数报告：从**真实下发的 args** 生成，不是从配置读的。
             *
             * 两者之间隔着门控跳过、构建默认值与自动收敛（`-ub <= -b`、`-np 1` 之类），
             * 所以只有 args 能回答「现在到底跑在什么参数上」。
             * 设置页顶部把它渲染成代码块 + 参数摘要 + 提示，用户不必再去日志里翻命令行。
             */
            this.launch = lastBuilt
                ? buildLaunchReport({ executable: location.path, args: lastBuilt.args, notices: lastBuilt.notices })
                : null;
            this.loadedAt = Date.now();
            // 这两件事必须在宣布 ready **之前**做完，否则「加载后的第一个请求」会用到空状态：
            // 上下文对账没做 → 状态卡显示不全；档位表没拿到 → 代理层不敢下发档位，
            // 用户看到的就是「刚加载完那一下档位不生效」（/props 是本地请求，代价只有几毫秒）。
            await this.reconcileContext(port);
            await this.discoverEffortVocabulary(port);
            this.touch();
            this.setState('ready');
            this.log.info(`Local model ready: ${this.proxy?.origin ?? ''}/v1 (model alias ${DEFAULT_ALIAS})`);
        }
        catch (error) {
            const message = error.message;
            this.lastError = message;
            await this.stopServerQuietly();
            this.setState('failed');
            this.log.error(`Failed to load the local model: ${message}`);
            throw new Error(message);
        }
    }
    async doUnload(reason) {
        if (this.startPromise)
            await this.startPromise.catch(() => undefined);
        const hadServer = this.server !== null;
        this.setState('stopping');
        await this.stopServerQuietly();
        this.loadedAt = null;
        this.restarts = 0;
        if (hadServer)
            this.log.info(`Local model unloaded (${reason}); VRAM and memory released`);
        this.touch();
        this.setState(this.config.enabled ? 'idle' : 'disabled');
    }
    async stopServerQuietly() {
        const server = this.server;
        this.server = null;
        this.upstreamPort = 0;
        if (!server)
            return;
        try {
            await server.stop(this.config.shutdownGraceMs);
        }
        catch (error) {
            this.log.warn(`Error while stopping llama-server: ${error.message}`);
        }
    }
    handleExit(info) {
        if (this.disposed)
            return;
        this.server = null;
        this.upstreamPort = 0;
        if (info.expected) {
            this.emit();
            return;
        }
        this.lastError = `llama-server exited unexpectedly (code=${info.code} signal=${info.signal})`;
        if (this.config.autoRestart && this.restarts < this.config.maxRestarts) {
            this.restarts++;
            const backoffMs = 1000 * this.restarts;
            this.log.warn(`llama-server crashed; auto-restarting in ${backoffMs}ms (attempt ${this.restarts}/${this.config.maxRestarts})`);
            this.setState('starting');
            this.restartTimer = setTimeout(() => {
                this.restartTimer = null;
                if (this.disposed || this.startPromise)
                    return;
                this.startPromise = this.doStart()
                    .catch(() => undefined)
                    .finally(() => {
                    this.startPromise = null;
                });
            }, backoffMs);
            this.restartTimer.unref?.();
        }
        else {
            this.setState('failed');
            this.log.error(`${this.lastError}; restart limit reached, please check the settings or the model file`);
        }
    }
    async resolveSelectedModel() {
        await this.refreshModels(true);
        const id = this.selectedModelId;
        if (!id) {
            const available = this.models.map((m) => m.id).slice(0, 20);
            throw new Error(`No local model selected yet.\nPut a GGUF file into ${this.config.modelsDir}, then pick it in the "Model" dropdown under Harness settings -> Local model.\n` +
                (available.length ? `Currently available:\n${available.map((m) => `  - ${m}`).join('\n')}` : '(the model directory is currently empty)'));
        }
        const entry = pickModel(this.models, id);
        if (!entry) {
            throw new Error(`The selected model "${id}" is no longer in the model directory (it may have been moved or deleted). Currently available: ${this.models.map((m) => m.id).join(', ') || '(none)'}`);
        }
        if (!entry.complete) {
            throw new Error(`Model "${entry.displayName}" has incomplete shards, missing: ${entry.missing.join(', ') || '(unknown)'}`);
        }
        if (!existsSync(entry.path)) {
            throw new Error(`Model file does not exist: ${entry.path}`);
        }
        return entry;
    }
    /** 空闲计时的唯一时间源：每个请求开始/结束、加载完成、卸载完成都会刷新。 */
    touch() {
        this.lastActivityAt = Date.now();
        this.emit();
    }
    /**
     * 启动后核对「实际生效的上下文」。
     *
     * `--fit` 会在显存紧张时把上下文调小，而 dsh 侧声明的窗口是 `ctxSize`（两者同源）。
     * 一旦实际值小于声明值，长会话会在超出实际 ctx 后中断，且现场看不出原因 —— 因此主动对一次账。
     */
    async reconcileContext(port) {
        const fromProps = await fetchServerContext(this.config.host, port);
        const effective = fromProps ?? extractEffectiveContext(this.server?.logTail.join('\n') ?? '');
        if (effective === null)
            return;
        this.effectiveContext = effective;
        this.emit();
        // 声明的上下文窗口就是 ctxSize（原 contextWindow 设置已删除，改为跟着 ctxSize 走）。
        const declared = this.config.ctxSize;
        if (effective < declared) {
            this.log.warn(`The effective context of llama.cpp is ${effective}, smaller than the configured context size ${declared}.` +
                'This is usually because VRAM auto-fit (--fit) shrank the context. To avoid long conversations breaking mid-way,' +
                ` set "Settings -> Local model -> Context size" to no more than ${effective}, or use a smaller model/quantization to free up VRAM.`);
        }
        else if (effective > declared) {
            this.log.debug(`Effective context of llama.cpp ${effective}, not below the declared ${declared}`);
        }
    }
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
    async discoverEffortVocabulary(port) {
        if (this.disposed)
            return;
        const template = await fetchServerChatTemplate(this.config.host, port);
        const efforts = extractSupportedEfforts(template);
        this.supportedEfforts = efforts;
        if (efforts) {
            this.log.info(`Reasoning efforts supported by the model template: ${efforts.join(' / ')}.` +
                'The chat box effort is remapped against it (the template throws on unknown efforts, so it cannot be passed through as-is).');
        }
        else {
            this.log.info('Could not resolve the effort vocabulary from the model template. This time only the on/off switch controls thinking; no specific effort is sent — ' +
                'better to lose one level of granularity than to risk a template error.');
        }
    }
    armTicker() {
        if (this.ticker)
            return;
        if (this.config.idleUnloadMs <= 0) {
            this.log.info('Idle unload is disabled (idleUnloadMinutes = 0)');
            return;
        }
        const period = Math.max(2000, Math.min(15_000, Math.floor(this.config.idleUnloadMs / 4)));
        this.ticker = setInterval(() => this.tick(), period);
        this.ticker.unref?.();
        this.log.info(`Idle unload enabled: the model is released after ${this.config.idleUnloadMinutes} consecutive minutes without conversation activity`);
    }
    /** 配置变了（可能关掉了自动卸载、或改了时长），重排定时器。 */
    restartTicker() {
        if (this.ticker) {
            clearInterval(this.ticker);
            this.ticker = null;
        }
        if (!this.disposed && this.config.enabled)
            this.armTicker();
    }
    tick() {
        if (this.disposed)
            return;
        const now = Date.now();
        this.lastTickAt = now;
        if (!shouldUnload({
            state: this.state,
            activeRequests: this.activeRequests,
            idleUnloadMs: this.config.idleUnloadMs,
            lastActivityAt: this.lastActivityAt,
            now,
        })) {
            return;
        }
        const minutes = ((now - this.lastActivityAt) / 60_000).toFixed(1);
        this.log.info(`No conversation activity for ${minutes} idle minutes; preparing to unload the model`);
        void this.unload(`Idle for ${minutes} minutes without conversation activity`).catch((error) => {
            // unload 抛错绝不能让 ticker 死掉 —— 下一轮 tick 仍要重试。
            this.log.warn(`Idle unload failed (${error.message}); will retry on the next tick`);
        });
    }
    setState(state) {
        this.state = state;
        this.emit();
    }
    emit() {
        for (const listener of this.listeners) {
            try {
                listener();
            }
            catch {
                // 订阅者自己的异常不应该影响运行时。
            }
        }
    }
}
function dirnameOf(file) {
    const index = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
    return index > 0 ? file.slice(0, index) : '.';
}
/**
 * 把 llama-server 的失败原因翻译成可读错误。
 *
 * 优先调用 `diagnoseLoadFailure`：它知道十几种典型错误模式（OOM、--fit 被钉住、
 * --flash-attn 形状不对、模型分片缺失、架构不支持等），命中就直接给出「结论 + 建议」，
 * 不再让用户对着几十行 GGML_ASSERT 排查。认不出来时回退到原错误信息加日志尾巴，
 * 保留排查线索但不会让用户完全看到一堆未加工的英文。
 */
function explainServerFailure(logTail, original, config) {
    const gpuLayersPinned = config.gpuLayersMode === 'custom' || config.gpuLayersMode === 'all';
    const diagnosis = diagnoseLoadFailure(logTail, { gpuLayersPinned });
    if (diagnosis) {
        const lines = [diagnosis.summary];
        for (const action of diagnosis.actions)
            lines.push(`  · ${action}`);
        if (diagnosis.evidence)
            lines.push(`(evidence: ${diagnosis.evidence})`);
        if (logTail.trim()) {
            const tail = logTail.trim().split(/\r?\n/).slice(-3).join('\n');
            lines.push('', 'Recent log tail:', tail);
        }
        return lines.join('\n');
    }
    const message = original?.message?.trim() || 'llama-server exited without a readable reason';
    const tail = logTail.trim().split(/\r?\n/).slice(-6);
    if (tail.length === 0)
        return message;
    return `${message}\nRecent log:\n${tail.join('\n')}`;
}
