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
    jinja: boolean;
    chatTemplate: string;
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
    routeName: string;
    modelAlias: string;
    routeModelId: string;
    contextWindow: number;
    maxTokens: number;
    registerRoute: boolean;
    exposeTool: boolean;
    allowModelControl: boolean;
    logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug';
}
export declare const DEFAULT_MODEL_ALIAS = "local";
export declare const Config: import("@deepseek-ai/schemastery").Schema<{
    enabled: boolean;
    modelsDir: string;
    runtimeDir: string;
    llamaServerPath: string;
    selectedModel: string;
    preload: boolean;
    host: string;
    port: number;
    llamaPort: number;
    ctxSize: number;
    gpuLayers: number;
    gpuLayersMode: "auto" | "all" | "custom";
    threads: number;
    threadsBatch: number;
    batchSize: number;
    ubatchSize: number;
    flashAttention: "auto" | "on" | "off";
    cacheTypeK: "auto" | "f16" | "q8_0" | "q4_0" | "q4_1" | "q5_0" | "q5_1" | "bf16" | "f32" | "iq4_nl";
    cacheTypeV: "auto" | "f16" | "q8_0" | "q4_0" | "q4_1" | "q5_0" | "q5_1" | "bf16" | "f32" | "iq4_nl";
    jinja: boolean;
    chatTemplate: string;
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
    routeName: string;
    modelAlias: string;
    routeModelId: string;
    contextWindow: number;
    maxTokens: number;
    registerRoute: boolean;
    exposeTool: boolean;
    allowModelControl: boolean;
    logLevel: "silent" | "error" | "warn" | "info" | "debug";
}>;
