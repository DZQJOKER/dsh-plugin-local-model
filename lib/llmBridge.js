import { DEFAULT_MODEL_ALIAS, LOCAL_MODEL_ID, LOCAL_ROUTE_NAME } from './configResolve.js';
/**
 * 组装路由描述。
 *
 * 注意哪些值来自常量：路由名、模型 id、别名都曾是设置项，现已按用户要求从 schema 删除、
 * 改为常量 —— 这三个值本来就不该随每次配置漂移，dsh 侧的 settings.yaml 引用的是它们。
 * `contextWindow` 则取 `ctxSize`（不再是独立设置），这样「dsh 声明的窗口」与
 * 「llama.cpp 的 -c」同源，不可能出现声明比实际大、长会话中途崩的情况。
 */
export function buildRouteSpec(config, baseURL) {
    return {
        routeName: LOCAL_ROUTE_NAME,
        displayName: '本地模型（llama.cpp）',
        baseURL,
        modelId: LOCAL_MODEL_ID,
        modelName: `本地模型 · ${DEFAULT_MODEL_ALIAS}`,
        contextWindow: config.ctxSize,
        maxTokens: config.maxTokens,
        apiKeyEnv: config.apiKey ? 'DSH_LOCAL_MODEL_API_KEY' : '',
        apiKey: config.apiKey,
        streamIdleTimeoutMs: 600_000,
    };
}
/** 生成 pi-ai 路由 profile（对应 settings.yaml 里 llm-pi-ai.providers.<route>）。 */
export function buildRouteProfile(spec) {
    const profile = {
        displayName: spec.displayName,
        api: 'openai-completions',
        baseURL: spec.baseURL,
        streamIdleTimeoutMs: spec.streamIdleTimeoutMs,
        models: [
            {
                id: spec.modelId,
                name: spec.modelName,
                contextWindow: spec.contextWindow,
                maxTokens: spec.maxTokens,
            },
        ],
    };
    if (spec.apiKeyEnv)
        profile.apiKeyEnv = spec.apiKeyEnv;
    return profile;
}
/** 用户需要手写配置时，直接把这段贴进 $DSH_HOME/settings.yaml。 */
export function renderRouteYaml(spec) {
    const lines = [
        'llm-pi-ai:',
        '  providers:',
        `    ${spec.routeName}:`,
        `      displayName: ${spec.displayName}`,
        '      api: openai-completions',
        `      baseURL: ${spec.baseURL}`,
        `      streamIdleTimeoutMs: ${spec.streamIdleTimeoutMs}`,
    ];
    if (spec.apiKeyEnv)
        lines.push(`      apiKeyEnv: ${spec.apiKeyEnv}`);
    lines.push('      models:');
    lines.push(`        - id: ${spec.modelId}`);
    lines.push(`          name: ${spec.modelName}`);
    lines.push(`          contextWindow: ${spec.contextWindow}`);
    lines.push(`          maxTokens: ${spec.maxTokens}`);
    return lines.join('\n');
}
/** 依次尝试宿主可能暴露的路由注册入口。名字来自 dsh 各版本公开文档，取交集最稳的顺序。 */
const REGISTER_METHODS = ['registerProvider', 'upsertProvider', 'registerRoute', 'addRoute', 'setRoute'];
const REMOVE_METHODS = ['removeProvider', 'unregisterProvider', 'removeRoute', 'deleteRoute'];
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
export function bridgeLlmRoute(ctx, spec, log) {
    const profile = buildRouteProfile(spec);
    const yaml = renderRouteYaml(spec);
    if (spec.apiKeyEnv && spec.apiKey) {
        process.env[spec.apiKeyEnv] = spec.apiKey;
    }
    const llm = ctx.get('llm');
    if (!llm) {
        const reason = '宿主未提供 llm 服务';
        log.warn(`${reason}，本地端点仍会正常提供服务，请手动把下面的路由配置写入 $DSH_HOME/settings.yaml：\n${yaml}`);
        return { registered: false, reason, profile, yaml, dispose: () => undefined };
    }
    for (const method of REGISTER_METHODS) {
        const fn = llm[method];
        if (typeof fn !== 'function')
            continue;
        try {
            const result = fn.call(llm, spec.routeName, profile);
            log.info(`已通过 llm.${method}() 注册本地模型路由「${spec.routeName}」`);
            const dispose = typeof result === 'function'
                ? result
                : () => {
                    for (const removeMethod of REMOVE_METHODS) {
                        const remove = llm[removeMethod];
                        if (typeof remove === 'function') {
                            try {
                                ;
                                remove.call(llm, spec.routeName);
                            }
                            catch {
                                // 卸载期尽力而为。
                            }
                            return;
                        }
                    }
                };
            return { registered: true, reason: `llm.${method}`, profile, yaml, dispose };
        }
        catch (error) {
            log.warn(`llm.${method}() 注册失败：${error.message}，尝试下一个入口`);
        }
    }
    const reason = `llm 服务未暴露可用的路由注册方法（已尝试 ${REGISTER_METHODS.join(' / ')}）`;
    log.warn(`${reason}。本地端点仍可用，请手动把下面的路由配置写入 $DSH_HOME/settings.yaml：\n${yaml}`);
    return { registered: false, reason, profile, yaml, dispose: () => undefined };
}
