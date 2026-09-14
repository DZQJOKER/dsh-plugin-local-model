import { Config as LocalModelConfigSchema } from './config.js';
import { resolveConfig, logLevelOf } from './configResolve.js';
import { createLog } from './log.js';
import { LocalModelProxy } from './proxy.js';
import { LocalModelRuntime } from './lifecycle.js';
import { ConfigStore } from './configStore.js';
import { buildFormDescriptor } from './schemaForm.js';
import { registerWebBridge } from './webBridge.js';
import { bridgeLlmRoute, buildRouteSpec, renderRouteYaml } from './llmBridge.js';
import { registerLocalModelTool } from './tools.js';
import { registerLocalModelCommands } from './commands.js';
/** 诊断信息里显示的插件名。 */
export const name = 'local-model';
/** 与 package.json 的 version 对齐，设置页会显示它，便于确认改动是否生效。 */
export const PLUGIN_VERSION = '0.3.0';
/**
 * 硬依赖：无。
 *
 * 本插件的所有宿主服务（webServer / llm / tools / commands / timer）都属于
 * 「有则增强、无则降级」，因此统一用 ctx.get() 读取，而不是 inject。
 * 这样即使某个服务缺失，模型加载与空闲卸载这条主线依然可用。
 */
export const inject = [];
/** 部署期配置 schema —— 设置页的表单直接从它序列化而来。 */
export const Config = LocalModelConfigSchema;
export function apply(ctx, config) {
    const composition = config ?? {};
    const boot = resolveConfig(composition);
    const log = createLog(ctx, logLevelOf(boot.logLevel));
    // 用户层配置独立落盘：schema 默认值 → 组合层（部署配置）→ 这个文件。
    const store = new ConfigStore(boot.paths.configFile, composition);
    const runtime = new LocalModelRuntime(boot, log, {
        persistSelectedModel: (id) => {
            void store.update({ selectedModel: id }).catch((error) => {
                log.warn(`保存所选模型失败：${error.message}`);
            });
            log.info(`本地模型已切换为 ${id}`);
        },
    });
    const proxy = new LocalModelProxy({
        host: boot.host,
        port: boot.port,
        upstream: () => runtime.status().upstream,
        ensureReady: () => runtime.ensureReady(),
        onRequestStart: () => runtime.beginRequest(),
        onRequestEnd: () => runtime.endRequest(),
        status: () => runtime.status(),
        modelId: () => runtime.config.routeModelId,
        modelDisplayName: () => runtime.status().model?.displayName ?? runtime.config.routeModelId,
        apiKey: () => runtime.config.apiKey,
        // 两个思考开关按「每次请求」生效：设置在会话中改了立刻跟上，不必重启模型。
        thinkPolicy: () => ({
            enableThinking: runtime.config.enableThinking,
            preserveThinking: runtime.config.preserveThinking,
        }),
        log,
    });
    runtime.attachProxy(proxy);
    let disposeRoute = () => undefined;
    let disposeBridge = () => undefined;
    ctx.effect(() => {
        void (async () => {
            // 先读用户层：模型目录、端口这些可能已被设置页改过，init 必须按最终值跑。
            await store.load();
            await runtime.applyConfig(store.resolve(), { reload: false });
            try {
                await runtime.init();
            }
            catch {
                // init 内部已经把错误写进状态与日志，这里不重复刷屏。
                return;
            }
            // 设置页的数据面：同源 HTTP，随 dsh web 服务器一起存在。
            disposeBridge = registerWebBridge(ctx, {
                runtime,
                store,
                form: () => buildFormDescriptor(LocalModelConfigSchema, runtime.config, store.filePath),
                pluginVersion: PLUGIN_VERSION,
                log,
            });
            const spec = buildRouteSpec(runtime.config, `${proxy.origin}/v1`);
            if (runtime.config.registerRoute) {
                disposeRoute = bridgeLlmRoute(ctx, spec, log).dispose;
            }
            else {
                log.info(`registerRoute = false，请手动把下面的路由写入 $DSH_HOME/settings.yaml：\n${renderRouteYaml(spec)}`);
            }
        })();
        return () => {
            disposeBridge();
            disposeRoute();
            void runtime.dispose();
        };
    }, 'local-model:runtime');
    registerLocalModelCommands(ctx, runtime, log, () => renderRouteYaml(buildRouteSpec(runtime.config, `${proxy.origin}/v1`)));
    void registerLocalModelTool(ctx, runtime, log).catch((error) => {
        log.warn(`注册 local_model 工具失败：${error.message}`);
    });
    log.info(`已加载 v${PLUGIN_VERSION}。模型目录 ${boot.paths.modelsDir}；空闲卸载 ${boot.idleUnloadMinutes > 0 ? `${boot.idleUnloadMinutes} 分钟` : '已关闭'}；入口端口 ${boot.port}`);
}
