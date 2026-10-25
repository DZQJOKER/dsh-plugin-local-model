import { formatBytes } from './registry.js';
import { ALLOW_MODEL_CONTROL, EXPOSE_LOCAL_MODEL_TOOL } from './configResolve.js';
/** Always declare all actions; whether start/stop is allowed is decided by a constant — the schema is compiled once and cannot change with settings. */
const ACTIONS = ['status', 'list', 'start', 'stop'];
const CONTROL_ACTIONS = ['start', 'stop'];
/**
 * Expose a `local_model` tool to the model.
 *
 * Design trade-off: only "read" capabilities (status / list). Start/stop directly grabs or frees VRAM,
 * which is a resource decision the user should make — so start / stop are always rejected.
 *
 * These two switches used to be settings (exposeTool / allowModelControl); they were removed from the schema
 * together with the "dsh integration" group and became constants in config.ts. The values follow the original
 * defaults, so behavior is identical to a default install; the cost is that it is **no longer configurable**:
 * to let the model start/stop the model within a conversation, change the constant in the code.
 */
export async function registerLocalModelTool(ctx, runtime, log) {
    if (!EXPOSE_LOCAL_MODEL_TOOL) {
        log.debug('EXPOSE_LOCAL_MODEL_TOOL = false; not registering the local_model tool');
        return () => undefined;
    }
    const tools = ctx.get('tools');
    if (!tools || typeof tools.register !== 'function') {
        log.warn('Host does not provide a tools service; skipping local_model tool registration (other capabilities unaffected)');
        return () => undefined;
    }
    let defineTool;
    try {
        const mod = (await import('@deepseek-ai/dsh-tools'));
        if (typeof mod.defineTool !== 'function')
            throw new Error('Module does not export defineTool');
        defineTool = mod.defineTool;
    }
    catch (error) {
        log.warn(`Cannot load @deepseek-ai/dsh-tools (${error.message}); skipping local_model tool registration`);
        return () => undefined;
    }
    const tool = defineTool({
        name: 'local_model',
        description: 'Query and operate the local LLM on this machine (llama.cpp). action=status shows whether it is loaded and when it auto-unloads; ' +
            'action=list lists the models available in the model directory; action=start loads the selected model now; action=stop unloads it now and frees VRAM. ' +
            'The model is chosen by the user in Harness Settings -> Local model; the first conversation loads it automatically, and it auto-unloads after a period of idleness.',
        parameters: {
            action: {
                type: 'string',
                required: true,
                enum: ACTIONS,
                description: 'The action to perform.',
            },
            model: {
                type: 'string',
                required: false,
                description: 'Only for action=start when a temporary switch is needed: relative path or file name under the model directory.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    ok: { type: 'boolean', required: true },
                    action: { type: 'string', required: true },
                    message: { type: 'string', required: true },
                },
            },
            render: (_args, value) => {
                const payload = value;
                return [{ type: 'text', text: payload?.message ?? JSON.stringify(value, null, 2) }];
            },
        },
        async execute(args, exec) {
            const action = normalizeAction(args?.action, ACTIONS);
            if (!action) {
                return { ok: false, action: String(args?.action ?? ''), message: `action must be one of ${ACTIONS.join(' / ')}` };
            }
            if (CONTROL_ACTIONS.includes(action) && !ALLOW_MODEL_CONTROL) {
                return {
                    ok: false,
                    action,
                    message: `Action ${action} is not available in this plugin: start/stop directly grabs or frees VRAM, which is a resource decision the user should make,` +
                        'so it can only be done manually on the Settings -> Local model page.',
                };
            }
            if (exec.signal.aborted) {
                return { ok: false, action, message: 'Operation cancelled' };
            }
            switch (action) {
                case 'status': {
                    const status = runtime.status();
                    return {
                        ok: true,
                        action,
                        message: runtime.describe(),
                        state: status.state,
                        stateLabel: status.stateLabel,
                        loaded: status.state === 'ready',
                        model: status.model?.displayName ?? null,
                        endpoint: status.endpoint,
                        pid: status.pid,
                        idleUnloadMinutes: status.idleUnloadMinutes,
                        unloadAt: status.unloadAt ? new Date(status.unloadAt).toISOString() : null,
                        lastError: status.lastError,
                    };
                }
                case 'list': {
                    const models = await runtime.refreshModels(true);
                    return {
                        ok: true,
                        action,
                        message: models.length === 0
                            ? `No .gguf files in the model directory (${runtime.config.modelsDir}) yet.`
                            : models
                                .map((m) => `${m.id === runtime.selectedModelId ? '* ' : '  '}${m.displayName}` +
                                `${m.quant ? ` [${m.quant}]` : ''}${m.params ? ` ${m.params}` : ''} ${formatBytes(m.sizeBytes)}` +
                                `${m.complete ? '' : ' ⚠ incomplete shards'}`)
                                .join('\n'),
                        selected: runtime.selectedModelId,
                        models: models.map((m) => ({
                            id: m.id,
                            displayName: m.displayName,
                            quant: m.quant,
                            params: m.params,
                            sizeBytes: m.sizeBytes,
                            complete: m.complete,
                            hasVisionProjector: m.mmproj !== null,
                        })),
                    };
                }
                case 'start': {
                    if (args?.model)
                        await runtime.selectModel(args.model);
                    await runtime.ensureReady();
                    return { ok: true, action, message: `Model loaded.\n${runtime.describe()}` };
                }
                case 'stop': {
                    await runtime.unload('Unloaded via the local_model tool');
                    return { ok: true, action, message: `Model unloaded; VRAM and memory released.\n${runtime.describe()}` };
                }
            }
        },
    });
    tools.register(tool);
    log.info(`local_model tool registered (available actions: ${ACTIONS.join(' / ')})`);
    return () => undefined;
}
function normalizeAction(value, allowed) {
    const raw = (value ?? '').trim().toLowerCase();
    return allowed.includes(raw) ? raw : null;
}
