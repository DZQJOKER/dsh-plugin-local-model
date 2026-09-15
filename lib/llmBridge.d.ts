import type { Context } from '@deepseek-ai/cordis';
import type { Log } from './log.js';
import type { ResolvedConfig } from './configResolve.js';
/** dsh 侧应当写入的 llm 路由描述。 */
export interface RouteSpec {
    routeName: string;
    displayName: string;
    baseURL: string;
    modelId: string;
    modelName: string;
    contextWindow: number;
    maxTokens: number;
    /** 凭据环境变量名；未配置 apiKey 时为 ''（= 免鉴权）。 */
    apiKeyEnv: string;
    apiKey: string;
    /** 流式空闲超时。本地模型吐字慢，必须比云端宽松得多。 */
    streamIdleTimeoutMs: number;
}
/**
 * 组装路由描述。
 *
 * 注意哪些值来自常量：路由名、模型 id、别名都曾是设置项，现已按用户要求从 schema 删除、
 * 改为常量 —— 这三个值本来就不该随每次配置漂移，dsh 侧的 settings.yaml 引用的是它们。
 * `contextWindow` 则取 `ctxSize`（不再是独立设置），这样「dsh 声明的窗口」与
 * 「llama.cpp 的 -c」同源，不可能出现声明比实际大、长会话中途崩的情况。
 */
export declare function buildRouteSpec(config: ResolvedConfig, baseURL: string): RouteSpec;
/** 生成 pi-ai 路由 profile（对应 settings.yaml 里 llm-pi-ai.providers.<route>）。 */
export declare function buildRouteProfile(spec: RouteSpec): Record<string, unknown>;
/** 用户需要手写配置时，直接把这段贴进 $DSH_HOME/settings.yaml。 */
export declare function renderRouteYaml(spec: RouteSpec): string;
export interface LlmBridgeResult {
    /** 是否成功把路由注册进宿主。 */
    registered: boolean;
    reason: string;
    profile: Record<string, unknown>;
    yaml: string;
    dispose: () => void;
}
/**
 * 把本地端点接进 dsh 的 llm 缝。
 *
 * 这里是整个插件里**唯一**需要适配宿主版本的地方，因此刻意写得保守：
 *   1. 优先调用宿主 llm 服务暴露的注册方法（feature-detect，逐个试）；
 *   2. 宿主没暴露 / 调用失败 → 不报错、不影响其它能力，改为把可粘贴的
 *      settings.yaml 片段打到日志里，并在 /local-model status 里给出。
 *
 * 之所以不接受「注册失败就整体不可用」：本插件最有价值的部分是进程与显存生命周期
 * 管理，路由只是接线；接线可以人工完成，模型不该因此加载不了。
 */
export declare function bridgeLlmRoute(ctx: Context, spec: RouteSpec, log: Log): LlmBridgeResult;
