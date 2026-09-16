import { formatBytes } from './registry.js';
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
        options.log.warn('宿主未提供 webServer 服务，设置页的「本地模型」配置面板将不可用（其余功能不受影响）');
        return () => undefined;
    }
    const handler = (req, res) => {
        void handle(req, res, options).catch((error) => {
            options.log.error(`设置桥接处理失败：${error.message}`);
            if (!res.headersSent)
                sendJson(res, 500, { ok: false, error: error.message });
            else
                res.end();
        });
    };
    try {
        const dispose = server.register({ kind: 'prefix', path: BRIDGE_PREFIX, handler });
        const port = server.port;
        options.log.info(`设置面板已挂载：同源前缀 ${BRIDGE_PREFIX}（随 dsh web 服务器${port ? ` :${port}` : ''}）`);
        return dispose;
    }
    catch (error) {
        options.log.warn(`挂载设置桥接失败：${error.message}`);
        return () => undefined;
    }
}
async function handle(req, res, options) {
    const { runtime, store, log } = options;
    if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: '本地模型插件只接受来自本机的请求' });
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
        sendJson(res, 405, { ok: false, error: `不支持的方法：${req.method}` });
        return;
    }
    if (!isJsonContentType(req)) {
        sendJson(res, 415, { ok: false, error: '写操作要求 content-type: application/json' });
        return;
    }
    const body = await readJson(req);
    switch (route) {
        case '/config': {
            const patch = body?.values ?? body;
            const next = await store.update(patch);
            await runtime.applyConfig(next, { reload: true });
            log.info(`设置已更新（${Object.keys(patch).length} 项），已按新配置重新加载`);
            sendJson(res, 200, buildState(options));
            return;
        }
        case '/reset': {
            const next = await store.reset();
            await runtime.applyConfig(next, { reload: true });
            log.info('设置已恢复为部署默认值，并已重新加载');
            sendJson(res, 200, buildState(options));
            return;
        }
        case '/action': {
            const action = String(body?.action ?? '');
            const message = await runAction(runtime, action);
            sendJson(res, 200, { ...buildState(options), message });
            return;
        }
        default:
            sendJson(res, 404, { ok: false, error: `未知路径：${route}` });
    }
}
async function runAction(runtime, action) {
    switch (action) {
        case 'scan': {
            const models = await runtime.refreshModels(true);
            return `已重新扫描，发现 ${models.length} 个模型`;
        }
        case 'start':
            await runtime.ensureReady();
            return '模型已加载';
        case 'stop':
            await runtime.unload('用户在设置页手动卸载');
            return '模型已卸载，显存与内存已释放';
        case 'reload':
            await runtime.reload('用户在设置页手动重新加载');
            return '已按最新设置重新加载';
        default:
            throw new Error(`未知操作：${action}（可用：scan / start / stop / reload）`);
    }
}
export function buildState(options) {
    const { runtime, store } = options;
    const status = runtime.status();
    const models = runtime.listModels();
    return {
        ok: true,
        plugin: { name: 'dsh-plugin-local-model', version: options.pluginVersion },
        form: options.form(),
        config: runtime.config,
        configFile: store.filePath,
        overridden: store.overriddenKeys(),
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
            throw new Error('请求体过大');
        chunks.push(chunk);
    }
    if (size === 0)
        return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new Error('请求体不是合法 JSON');
    }
}
