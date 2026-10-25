import { formatBytes } from './registry.js';
import { PRESET_EXCLUDED_KEYS, presetKeys, snapshotPresetValues, } from './presets.js';
/** 同源路由前缀。浏览器侧直接 fetch 相对路径，不跨端口、不需要 CORS。 */
export const BRIDGE_PREFIX = '/api/local-model';
const MAX_BODY_BYTES = 256 * 1024;
/**
 * 把插件的状态与配置暴露给浏览器半侧。
 *
 * 为什么走自建路由而不是 dsh 的 settings 命名空间：当前 dsh 版本的 settings apiproxy
 * 只服务硬编码的命名空间白名单，第三方插件的命名空间一律答复 settings-not-exposed，
 * 浏览器侧既读不到也写不进。同源 HTTP 是这一版宿主上唯一可靠的通道，也让设置页
 * 不依赖宿主内部接口的变动。
 *
 * 安全姿态（本机工具，无账号体系，因此靠三条硬约束而不是鉴权）：
 *   1. 只接受回环来源的请求 —— 配置变更与进程启停不该被局域网里的谁触发；
 *   2. 写操作要求 `content-type: application/json` —— 普通表单跨站提交做不到这一点，
 *      于是即便有一个恶意页面在浏览器里跑，也发不出能改配置的请求；
 *   3. 全部请求体有大小上限。
 */
export function registerWebBridge(ctx, options) {
    const server = ctx.get('webServer');
    if (!server || typeof server.register !== 'function') {
        options.log.warn('Host does not provide a webServer service; the Local model settings panel will be unavailable (other features unaffected)');
        return () => undefined;
    }
    const handler = (req, res) => {
        void handle(req, res, options).catch((error) => {
            options.log.error(`Settings bridge handling failed: ${error.message}`);
            if (!res.headersSent)
                sendJson(res, 500, { ok: false, error: error.message });
            else
                res.end();
        });
    };
    try {
        const dispose = server.register({ kind: 'prefix', path: BRIDGE_PREFIX, handler });
        const port = server.port;
        options.log.info(`Settings panel mounted: same-origin prefix ${BRIDGE_PREFIX} (served by the dsh web server${port ? ` :${port}` : ''})`);
        return dispose;
    }
    catch (error) {
        options.log.warn(`Failed to mount settings bridge: ${error.message}`);
        return () => undefined;
    }
}
async function handle(req, res, options) {
    const { runtime, store, presets, log } = options;
    if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: 'The local model plugin only accepts requests from this machine' });
        return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = url.pathname.slice(BRIDGE_PREFIX.length).replace(/\/+$/, '') || '/';
    if (req.method === 'GET' && route === '/state') {
        await runtime.refreshModels();
        sendJson(res, 200, buildState(options));
        return;
    }
    if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: `Method not supported: ${req.method}` });
        return;
    }
    if (!isJsonContentType(req)) {
        sendJson(res, 415, { ok: false, error: 'Write operations require content-type: application/json' });
        return;
    }
    const body = await readJson(req);
    switch (route) {
        case '/config': {
            const patch = body?.values ?? body;
            const next = await store.update(patch);
            await runtime.applyConfig(next, { reload: true });
            log.info(`Settings updated (${Object.keys(patch).length} item(s)); reloaded with the new configuration`);
            sendJson(res, 200, buildState(options));
            return;
        }
        case '/reset': {
            const next = await store.reset();
            await runtime.applyConfig(next, { reload: true });
            log.info('Settings restored to deployment defaults and reloaded');
            sendJson(res, 200, buildState(options));
            return;
        }
        case '/action': {
            const action = String(body?.action ?? '');
            const message = await runAction(runtime, action);
            sendJson(res, 200, { ...buildState(options), message });
            return;
        }
        /*
         * ── 参数预设 ────────────────────────────────────────────────────────────
         * 五个动作都走同一条配置落盘路径（store.update + applyConfig），
         * 与「保存设置」完全一致 —— 于是行为、提示、卸载时机都不会两套逻辑漂移。
         * 「应用预设」本身不额外做别的：预设里没有的字段（端口/路径/密钥等）保持原样。
         */
        case '/presets/save': {
            const request = body;
            // 界面会把「当前看到的参数（含未保存的修改）」一起送过来；没送就从生效配置里摘快照。
            const source = request.values === undefined ? snapshotPresetValues(runtime.config) : request.values;
            const preset = await presets.create(request.name, source);
            log.info(`Saved parameter preset "${preset.name}" (${presetFieldCount(preset)} field(s))`);
            sendJson(res, 200, { ...buildState(options), message: `Preset "${preset.name}" saved (${presetFieldCount(preset)} parameters)` });
            return;
        }
        case '/presets/apply': {
            const preset = requirePreset(presets, body?.id);
            const next = await store.update(preset.values);
            await runtime.applyConfig(next, { reload: true });
            log.info(`Applied parameter preset "${preset.name}"; the model was unloaded with the new parameters`);
            sendJson(res, 200, {
                ...buildState(options),
                appliedId: preset.id,
                message: `Preset "${preset.name}" applied; the model was unloaded and will load with the new parameters on the next message`,
            });
            return;
        }
        case '/presets/overwrite': {
            const request = body;
            const target = requirePreset(presets, request.id);
            const source = request.values === undefined ? snapshotPresetValues(runtime.config) : request.values;
            const preset = await presets.overwrite(target.id, source);
            log.info(`Updated parameter preset "${preset.name}" with the current parameters (${presetFieldCount(preset)} field(s))`);
            sendJson(res, 200, {
                ...buildState(options),
                message: `Preset "${preset.name}" updated with the current parameters (${presetFieldCount(preset)} items)`,
            });
            return;
        }
        case '/presets/rename': {
            const request = body;
            const target = requirePreset(presets, request.id);
            const preset = await presets.rename(target.id, request.name);
            log.info(`Renamed the parameter preset to "${preset.name}"`);
            sendJson(res, 200, { ...buildState(options), message: `Preset renamed to "${preset.name}"` });
            return;
        }
        case '/presets/delete': {
            const target = requirePreset(presets, body?.id);
            const preset = await presets.remove(target.id);
            log.info(`Deleted parameter preset "${preset.name}"`);
            sendJson(res, 200, { ...buildState(options), message: `Preset "${preset.name}" deleted` });
            return;
        }
        default:
            sendJson(res, 404, { ok: false, error: `Unknown path: ${route}` });
    }
}
function presetFieldCount(preset) {
    return Object.keys(preset.values).length;
}
function requirePreset(presets, id) {
    const preset = presets.find(id);
    if (!preset)
        throw new Error('Preset not found — it may have been deleted. Refresh and try again');
    return preset;
}
async function runAction(runtime, action) {
    switch (action) {
        case 'scan': {
            const models = await runtime.refreshModels(true);
            return `Rescanned; found ${models.length} models`;
        }
        case 'start':
            await runtime.ensureReady();
            return 'Model loaded';
        case 'stop':
            await runtime.unload('User unloaded from the settings page');
            return 'Model unloaded; VRAM and memory released';
        case 'reload':
            await runtime.reload('User reloaded from the settings page');
            return 'Reloaded with the latest settings';
        default:
            throw new Error(`Unknown action: ${action} (available: scan / start / stop / reload)`);
    }
}
export function buildState(options) {
    const { runtime, store, presets } = options;
    const status = runtime.status();
    const models = runtime.listModels();
    const current = runtime.config;
    return {
        ok: true,
        plugin: { name: 'dsh-plugin-local-model', version: options.pluginVersion },
        form: options.form(),
        config: runtime.config,
        configFile: store.filePath,
        overridden: store.overriddenKeys(),
        /*
         * 参数预设。只送元信息（名字 / 项数 / 与当前配置的差异），不送 values ——
         * 界面只需要渲染与切换，把整份参数来回搬没有意义。
         */
        presets: {
            items: presets.list().map((preset) => ({
                id: preset.id,
                name: preset.name,
                createdAt: preset.createdAt,
                updatedAt: preset.updatedAt,
                fieldCount: Object.keys(preset.values).length,
                /** 与当前生效配置有几项不同 —— 界面直接显示「N 项不同」，不必自己算。 */
                changed: presets.diffCount(preset.values, current),
            })),
            /** 与当前生效配置完全一致的那一个（没有则为 null），界面用它高亮。 */
            activeId: presets.activeId(current),
            /** 参与预设的字段，以及被排除的环境字段（界面的说明文案用）。 */
            keys: presetKeys(),
            excluded: [...PRESET_EXCLUDED_KEYS],
            file: presets.filePath,
            warning: presets.loadWarning,
        },
        models: models.map((m) => ({
            id: m.id,
            displayName: m.displayName,
            quant: m.quant,
            params: m.params,
            sizeBytes: m.sizeBytes,
            sizeText: formatBytes(m.sizeBytes),
            complete: m.complete,
            missing: m.missing,
            hasVisionProjector: m.mmproj !== null,
        })),
        /** 视觉投影文件下拉框的数据源：模型目录里扫到的全部 mmproj。 */
        visionFiles: runtime.listVisionProjectors().map((p) => ({
            id: p.rel,
            sizeBytes: p.size,
            sizeText: formatBytes(p.size),
            absolute: p.abs,
        })),
        runtime: {
            state: status.state,
            stateLabel: status.stateLabel,
            model: status.model,
            endpoint: status.endpoint,
            upstream: status.upstream,
            pid: status.pid,
            loadedAt: status.loadedAt,
            lastActivityAt: status.lastActivityAt,
            unloadAt: status.unloadAt,
            unloadInMs: status.unloadInMs,
            unloadBlockedBy: status.unloadBlockedBy,
            lastTickAt: status.lastTickAt,
            idleUnloadMinutes: status.idleUnloadMinutes,
            activeRequests: status.activeRequests,
            restarts: status.restarts,
            lastError: status.lastError,
            modelsFound: status.modelsFound,
            visionProjector: status.visionProjector,
            mtp: status.mtp,
            visionDisabledByMtp: status.visionDisabledByMtp,
            reasoningEfforts: status.reasoningEfforts,
            // 启动参数报告：设置页顶部的「本次启动参数」面板就是靠它渲染的。
            // 放在 status 里而不是单独开一个路由，是因为它天然属于「当前运行状态」的一部分，
            // 而且这样它跟 state 一起被轮询刷新 —— 换模型/改参数后不必再取一次。
            launch: status.launch,
        },
    };
}
// ── HTTP 小工具 ───────────────────────────────────────────────────────────────
function sendJson(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.byteLength),
        'cache-control': 'no-store',
    });
    res.end(body);
}
function isLoopback(req) {
    const address = req.socket.remoteAddress ?? '';
    const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
    return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}
function isJsonContentType(req) {
    const raw = req.headers['content-type'] ?? '';
    return raw.toLowerCase().includes('application/json');
}
async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES)
            throw new Error('Request body too large');
        chunks.push(chunk);
    }
    if (size === 0)
        return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new Error('Request body is not valid JSON');
    }
}
