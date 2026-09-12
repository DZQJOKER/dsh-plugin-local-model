import { formatBytes } from './registry.js';
const HELP = [
    '/local-model status  查看当前状态（是否已加载、何时自动卸载）',
    '/local-model list    列出模型目录里可选的模型',
    '/local-model start   立即加载已选定的模型',
    '/local-model stop    立即卸载并释放显存',
    '/local-model reload  卸载后重新加载（改了参数后用它）',
    '/local-model route   打印 dsh 侧需要的路由配置',
].join('\n');
/**
 * 会话内斜杠命令。宿主的 commands 服务在预览期接口还在动，因此这里
 * 全部走「探测 + 失败即降级」：注册不上不影响任何其它能力。
 */
export function registerLocalModelCommands(ctx, runtime, log, routeYaml) {
    const commands = ctx.get('commands');
    if (!commands || typeof commands.register !== 'function') {
        log.debug('宿主未提供 commands 服务，跳过 /local-model 命令注册');
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
                    return `模型目录为空：${runtime.config.modelsDir}`;
                return models
                    .map((m) => `${m.id === runtime.selectedModelId ? '* ' : '  '}${m.displayName}` +
                    `${m.quant ? ` [${m.quant}]` : ''}${m.params ? ` ${m.params}` : ''} ${formatBytes(m.sizeBytes)}` +
                    `${m.complete ? '' : ' ⚠ 分片不完整'}`)
                    .join('\n');
            }
            case 'start':
                await runtime.ensureReady();
                return `模型已加载。\n${runtime.describe()}`;
            case 'stop':
                await runtime.unload('用户执行 /local-model stop');
                return `模型已卸载，显存与内存已释放。\n${runtime.describe()}`;
            case 'reload':
                await runtime.reload('用户执行 /local-model reload');
                return `已按最新设置重新加载。\n${runtime.describe()}`;
            case 'route':
                return `把下面这段写入 $DSH_HOME/settings.yaml：\n\n${routeYaml()}`;
            case 'help':
                return HELP;
            default:
                return `未知动作「${extractAction(input) ?? ''}」。\n\n${HELP}`;
        }
    };
    const command = {
        name: 'local-model',
        description: '查看与控制本地模型（status / list / start / stop / reload / route）',
        arguments: [
            {
                name: 'action',
                required: false,
                description: 'status | list | start | stop | reload | route',
            },
        ],
        execute: run,
        // 有的宿主用 run()，有的用 execute()，两个都挂上，避免版本差异。
        run,
    };
    try {
        commands.register(command);
        log.info('已注册 /local-model 命令');
        return () => undefined;
    }
    catch (error) {
        log.debug(`注册 /local-model 命令失败：${error.message}`);
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
