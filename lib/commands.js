import { formatBytes } from './registry.js';
const HELP = [
    '/local-model status  Show current state (loaded or not, when it auto-unloads)',
    '/local-model list    List the models available in the model directory',
    '/local-model start   Load the selected model now',
    '/local-model stop    Unload now and release VRAM',
    '/local-model reload  Unload and load again (use after changing parameters)',
    '/local-model route   Print the route configuration needed on the dsh side',
].join('\n');
/**
 * In-conversation slash commands. The host's commands service is still changing during the preview period,
 * so everything here is "probe + degrade on failure": failing to register does not affect any other capability.
 */
export function registerLocalModelCommands(ctx, runtime, log, routeYaml) {
    const commands = ctx.get('commands');
    if (!commands || typeof commands.register !== 'function') {
        log.debug('Host does not provide a commands service; skipping /local-model command registration');
        return () => undefined;
    }
    const run = async (input) => {
        const action = normalize(extractAction(input));
        switch (action) {
            case 'status':
                return runtime.describe();
            case 'list': {
                const models = await runtime.refreshModels(true);
                if (models.length === 0)
                    return `Model directory is empty: ${runtime.config.modelsDir}`;
                return models
                    .map((m) => `${m.id === runtime.selectedModelId ? '* ' : '  '}${m.displayName}` +
                    `${m.quant ? ` [${m.quant}]` : ''}${m.params ? ` ${m.params}` : ''} ${formatBytes(m.sizeBytes)}` +
                    `${m.complete ? '' : ' ⚠ incomplete shards'}`)
                    .join('\n');
            }
            case 'start':
                await runtime.ensureReady();
                return `Model loaded.\n${runtime.describe()}`;
            case 'stop':
                await runtime.unload('User ran /local-model stop');
                return `Model unloaded; VRAM and memory released.\n${runtime.describe()}`;
            case 'reload':
                await runtime.reload('User ran /local-model reload');
                return `Reloaded with the latest settings.\n${runtime.describe()}`;
            case 'route':
                return `Write the following to $DSH_HOME/settings.yaml:\n\n${routeYaml()}`;
            case 'help':
                return HELP;
            default:
                return `Unknown action "${extractAction(input) ?? ''}".\n\n${HELP}`;
        }
    };
    const command = {
        name: 'local-model',
        description: 'Inspect and control the local model (status / list / start / stop / reload / route)',
        arguments: [
            {
                name: 'action',
                required: false,
                description: 'status | list | start | stop | reload | route',
            },
        ],
        execute: run,
        // Some hosts use run(), others execute(); both are registered to avoid version differences.
        run,
    };
    try {
        commands.register(command);
        log.info('/local-model command registered');
        return () => undefined;
    }
    catch (error) {
        log.debug(`Failed to register /local-model command: ${error.message}`);
        return () => undefined;
    }
}
function extractAction(input) {
    if (typeof input === 'string') {
        const [first] = input.trim().split(/\s+/);
        return first;
    }
    if (input && typeof input === 'object') {
        const record = input;
        for (const key of ['action', 'args', 'argv', 'arguments', 'input']) {
            const value = record[key];
            if (typeof value === 'string')
                return value.trim().split(/\s+/)[0];
            if (Array.isArray(value) && typeof value[0] === 'string')
                return value[0];
        }
    }
    return undefined;
}
function normalize(value) {
    const raw = (value ?? 'status').trim().toLowerCase().replace(/^\/+/, '');
    if (!raw || raw === 'local-model' || raw === 'localmodel')
        return 'status';
    return raw;
}
