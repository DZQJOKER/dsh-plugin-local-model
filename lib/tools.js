import { formatBytes } from './registry.js';
/** 始终声明全部动作，是否允许启停由运行时配置决定 —— schema 只编译一次，不能随设置变。 */
const ACTIONS = ['status', 'list', 'start', 'stop'];
const CONTROL_ACTIONS = ['start', 'stop'];
/**
 * 向模型暴露一个 `local_model` 工具。
 *
 * 设计取舍：默认只给「读」能力（status / list）。启停会直接抢占或释放显存，
 * 属于用户该拍板的资源决策，因此 start / stop 需要显式打开 allowModelControl。
 */
export async function registerLocalModelTool(ctx, runtime, log) {
    if (!runtime.config.exposeTool) {
        log.debug('exposeTool = false，不注册 local_model 工具');
        return () => undefined;
    }
    const tools = ctx.get('tools');
    if (!tools || typeof tools.register !== 'function') {
        log.warn('宿主未提供 tools 服务，跳过 local_model 工具注册（其余能力不受影响）');
        return () => undefined;
    }
    let defineTool;
    try {
        const mod = (await import('@deepseek-ai/dsh-tools'));
        if (typeof mod.defineTool !== 'function')
            throw new Error('模块没有导出 defineTool');
        defineTool = mod.defineTool;
    }
    catch (error) {
        log.warn(`无法加载 @deepseek-ai/dsh-tools（${error.message}），跳过 local_model 工具注册`);
        return () => undefined;
    }
    const tool = defineTool({
        name: 'local_model',
        description: '查询和操作本机的本地大模型（llama.cpp）。action=status 看当前是否已加载/何时自动卸载；' +
            'action=list 列出模型目录里可选的模型；action=start 立即加载已选定的模型；action=stop 立即卸载并释放显存。' +
            '模型由用户在 Harness 设置 → 本地模型 中选择，首个对话会自动加载，空闲一段时间会自动卸载。',
        parameters: {
            action: {
                type: 'string',
                required: true,
                enum: ACTIONS,
                description: '要执行的动作。',
            },
            model: {
                type: 'string',
                required: false,
                description: '仅 action=start 且需要临时切换时使用：模型目录下的相对路径或文件名。',
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
                return { ok: false, action: String(args?.action ?? ''), message: `action 必须是 ${ACTIONS.join(' / ')} 之一` };
            }
            if (CONTROL_ACTIONS.includes(action) && !runtime.config.allowModelControl) {
                return {
                    ok: false,
                    action,
                    message: '启停操作默认关闭（避免模型擅自占用/释放显存）。如需开启：Harness 设置 → 本地模型 → 允许模型控制启停。',
                };
            }
            if (exec.signal.aborted) {
                return { ok: false, action, message: '操作已取消' };
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
                            ? `模型目录（${runtime.config.modelsDir}）里还没有 .gguf 文件。`
                            : models
                                .map((m) => `${m.id === runtime.selectedModelId ? '* ' : '  '}${m.displayName}` +
                                `${m.quant ? ` [${m.quant}]` : ''}${m.params ? ` ${m.params}` : ''} ${formatBytes(m.sizeBytes)}` +
                                `${m.complete ? '' : ' ⚠ 分片不完整'}`)
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
                    return { ok: true, action, message: `模型已加载。\n${runtime.describe()}` };
                }
                case 'stop': {
                    await runtime.unload('模型主动调用 local_model 工具卸载');
                    return { ok: true, action, message: `模型已卸载，显存与内存已释放。\n${runtime.describe()}` };
                }
            }
        },
    });
    tools.register(tool);
    log.info(`已注册 local_model 工具（可用动作：${ACTIONS.join(' / ')}）`);
    return () => undefined;
}
function normalizeAction(value, allowed) {
    const raw = (value ?? '').trim().toLowerCase();
    return allowed.includes(raw) ? raw : null;
}
