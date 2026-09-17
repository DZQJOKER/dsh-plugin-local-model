/**
 * dsh-plugin-local-model —— DeepSeek Harness 的本地模型插件。
 *
 * 四件事：
 *   1. 设置项：设置侧栏出现独立的「本地模型」页（宿主侧 schema + 浏览器侧面板）；
 *   2. 目录约定：用户自行下载的 llama.cpp 运行时与 GGUF 模型放进插件规定的目录；
 *   3. 按需加载：选定模型后，第一条对话自动拉起 llama-server 并载入模型；
 *   4. 空闲卸载：连续 5 分钟（可配）无对话交互即卸载模型、释放显存与内存。
 *
 * 设置页顶部还有一块「参数预设」：把整套加载/推理参数存成带名字的条目，一键切换。
 *
 * 遵循 dsh 插件契约：只用具名导出（name / inject / Config / apply），
 * 绝不使用 export default —— Loader 的 unwrapExports 会把默认导出折叠掉，
 * 连带丢掉 inject 等元数据，且不报错。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type LocalModelConfig } from './config.js';
/** 诊断信息里显示的插件名。 */
export declare const name = "local-model";
/** 与 package.json 的 version 对齐，设置页会显示它，便于确认改动是否生效。 */
export declare const PLUGIN_VERSION = "0.5.2";
/**
 * 硬依赖：无。
 *
 * 本插件的所有宿主服务（webServer / llm / tools / commands / timer）都属于
 * 「有则增强、无则降级」，因此统一用 ctx.get() 读取，而不是 inject。
 * 这样即使某个服务缺失，模型加载与空闲卸载这条主线依然可用。
 */
export declare const inject: string[];
/** 部署期配置 schema —— 设置页的表单直接从它序列化而来。 */
export declare const Config: import("@deepseek-ai/schemastery").Schema<{
    enabled: boolean;
    modelsDir: string;
    runtimeDir: string;
    llamaServerPath: string;
    selectedModel: string;
    mmprojFile: string;
    mtp: boolean;
    preload: boolean;
    host: string;
    port: number;
    llamaPort: number;
    ctxSize: number;
    maxTokens: number;
    gpuLayers: number;
    gpuLayersMode: "auto" | "all" | "custom";
    threads: number;
    threadsBatch: number;
    batchSize: number;
    ubatchSize: number;
    flashAttention: "auto" | "on" | "off";
    cacheTypeK: "auto" | "f16" | "q8_0" | "q4_0" | "q4_1" | "q5_0" | "q5_1" | "bf16" | "f32" | "iq4_nl";
    cacheTypeV: "auto" | "f16" | "q8_0" | "q4_0" | "q4_1" | "q5_0" | "q5_1" | "bf16" | "f32" | "iq4_nl";
    kvUnified: boolean;
    kvStreamStageMib: number;
    temp: number;
    topK: number;
    topP: number;
    minP: number;
    presencePenalty: number;
    repeatPenalty: number;
    repeatLastN: number;
    seed: number;
    imageMinTokens: number;
    imageMaxTokens: number;
    reasoningBudget: number;
    jinja: boolean;
    chatTemplate: string;
    enableThinking: boolean;
    preserveThinking: boolean;
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
    logLevel: "silent" | "error" | "warn" | "info" | "debug";
}>;
export type { LocalModelConfig };
export declare function apply(ctx: Context, config?: Partial<LocalModelConfig>): void;
