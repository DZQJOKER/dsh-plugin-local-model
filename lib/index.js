import path from 'node:path';
import { Config as LocalModelConfigSchema } from './config.js';
import { resolveConfig, logLevelOf, LOCAL_MODEL_ID } from './configResolve.js';
import { createLog } from './log.js';
import { LocalModelProxy } from './proxy.js';
import { LocalModelRuntime } from './lifecycle.js';
import { ConfigStore } from './configStore.js';
import { PresetStore } from './presets.js';
import { buildFormDescriptor } from './schemaForm.js';
import { registerWebBridge } from './webBridge.js';
import { bridgeLlmRoute, buildRouteSpec, renderRouteYaml } from './llmBridge.js';
import { registerLocalModelTool } from './tools.js';
import { registerLocalModelCommands } from './commands.js';
import { DEFAULT_GUARD_LIMITS } from './contextGuard.js';
/** Plugin name shown in diagnostics. */
export const name = 'local-model';
/** Kept in sync with the version in package.json; the settings page displays it so you can confirm changes took effect. */
export const PLUGIN_VERSION = '0.7.1';
/**
 * Hard dependencies: none.
 *
 * Every host service used by this plugin (webServer / llm / tools / commands / timer) is
 * "enhance if present, degrade if absent", so all are read via ctx.get() instead of inject.
 * That way, even if a service is missing, the main path — model loading and idle unloading — keeps working.
 */
export const inject = [];
/** Deployment-time config schema — the settings page form is serialized directly from it. */
export const Config = LocalModelConfigSchema;
export function apply(ctx, config) {
    const composition = config ?? {};
    const boot = resolveConfig(composition);
    const log = createLog(ctx, logLevelOf(boot.logLevel));
    // The user-layer config is persisted separately: schema defaults -> composition layer (deployment config) -> this file.
    const store = new ConfigStore(boot.paths.configFile, composition);
    // Parameter presets live in the same directory as config.json: one config + several switchable parameter sets. All reads/writes happen here; the runtime never touches it directly.
    const presets = new PresetStore(path.join(boot.paths.stateDir, 'presets.json'));
    const runtime = new LocalModelRuntime(boot, log, {
        persistSelectedModel: (id) => {
            void store.update({ selectedModel: id }).catch((error) => {
                log.warn(`Failed to save selected model: ${error.message}`);
            });
            log.info(`Local model switched to ${id}`);
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
        modelId: () => LOCAL_MODEL_ID,
        modelDisplayName: () => runtime.status().model?.displayName ?? LOCAL_MODEL_ID,
        apiKey: () => runtime.config.apiKey,
        // The two thinking switches take effect "per request": changes made mid-conversation apply immediately, no model restart needed.
        // The effort vocabulary is resolved after the model loads, so it must be fetched fresh here — switching models means a different set of efforts.
        thinkPolicy: () => ({
            enableThinking: runtime.config.enableThinking,
            preserveThinking: runtime.config.preserveThinking,
            supportedEfforts: runtime.reasoningEfforts,
        }),
        // Output-limit overflow guard: n_ctx takes ctxSize (the -c sent at startup), matching the real server.
        // When turned off this returns null and the proxy skips this path entirely (no request-body buffering at all).
        contextGuard: () => runtime.config.guardContextOverflow
            ? { nCtx: runtime.config.ctxSize, ...DEFAULT_GUARD_LIMITS }
            : null,
        log,
    });
    runtime.attachProxy(proxy);
    let disposeRoute = () => undefined;
    let disposeBridge = () => undefined;
    ctx.effect(() => {
        void (async () => {
            // Read the user layer first: the model directory, port, etc. may have been changed in the settings page; init must run with the final values.
            await store.load();
            // A preset read failure only degrades to "no presets" (handled internally); it does not affect the main path below.
            await presets.load();
            await runtime.applyConfig(store.resolve(), { reload: false });
            try {
                await runtime.init();
            }
            catch {
                // init already wrote the error to state and log; don't spam it again here.
                return;
            }
            // Data plane for the settings page: same-origin HTTP, living alongside the dsh web server.
            disposeBridge = registerWebBridge(ctx, {
                runtime,
                store,
                presets,
                form: () => buildFormDescriptor(LocalModelConfigSchema, runtime.config, store.filePath),
                pluginVersion: PLUGIN_VERSION,
                log,
            });
            // Route registration is always on (the old registerRoute setting was removed and became constant behavior).
            // When the host exposes no registration API, bridgeLlmRoute degrades to "print pasteable YAML" on its own; other features are unaffected.
            const spec = buildRouteSpec(runtime.config, `${proxy.origin}/v1`);
            disposeRoute = bridgeLlmRoute(ctx, spec, log).dispose;
        })();
        return () => {
            disposeBridge();
            disposeRoute();
            void runtime.dispose();
        };
    }, 'local-model:runtime');
    registerLocalModelCommands(ctx, runtime, log, () => renderRouteYaml(buildRouteSpec(runtime.config, `${proxy.origin}/v1`)));
    void registerLocalModelTool(ctx, runtime, log).catch((error) => {
        log.warn(`Failed to register local_model tool: ${error.message}`);
    });
    log.info(`Loaded v${PLUGIN_VERSION}. Model directory ${boot.paths.modelsDir}; idle unload ${boot.idleUnloadMinutes > 0 ? `${boot.idleUnloadMinutes} min` : 'disabled'}; entry port ${boot.port}`);
}
