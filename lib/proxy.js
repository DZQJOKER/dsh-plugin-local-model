import http from 'node:http';
import { isChatCompletionPath, rewriteChatRequestBody } from './requestRewrite.js';
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade']);
/**
 * 需要改写请求体时的读取上限。
 *
 * 对话补全的请求体大小由上下文长度决定（1M ctx 的纯文本也才几 MB），64 MB 足够宽裕；
 * 设这个上限是为了「宁可原样放行，也不把几百 MB 读进内存」。
 */
const MAX_REWRITE_BYTES = 64 * 1024 * 1024;
function json(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.byteLength),
        'cache-control': 'no-store',
    });
    res.end(body);
}
/**
 * 稳定的本地入口。
 *
 * 为什么不让 dsh 直接连 llama-server 的端口：那样在模型卸载后端口就没人听了，
 * 第一条对话必然连接失败。这里让插件常驻一个极轻量的代理（不占显存），
 * 由它把「模型没加载」这件事消化掉 —— 首个请求进来时拉起 llama-server、
 * 等它就绪、再原样转发（含 SSE 流式）。对 dsh 来说端点始终在线。
 */
export class LocalModelProxy {
    options;
    server = null;
    boundPort = 0;
    constructor(options) {
        this.options = options;
    }
    get port() {
        return this.boundPort;
    }
    get origin() {
        return `http://${this.options.host}:${this.boundPort}`;
    }
    get running() {
        return this.server !== null;
    }
    async listen(maxPortProbe = 20) {
        if (this.server)
            return this.boundPort;
        const { host, port } = this.options;
        // 端口被占用时向后找 20 个，仍然不行就让内核分配 —— 保证插件一定能起来。
        let lastError = null;
        const candidates = [];
        for (let i = 0; i < maxPortProbe; i++)
            candidates.push(port + i);
        candidates.push(0);
        for (const candidate of candidates) {
            const server = http.createServer((req, res) => {
                void this.handle(req, res);
            });
            server.on('clientError', (_error, socket) => {
                if (socket.writable)
                    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
            });
            // 本地大模型首字慢、长文生成久，任何默认超时都可能把正常请求掐断。
            server.requestTimeout = 0;
            server.timeout = 0;
            server.keepAliveTimeout = 30_000;
            try {
                await new Promise((resolve, reject) => {
                    const onError = (error) => {
                        server.removeListener('listening', onListening);
                        reject(error);
                    };
                    const onListening = () => {
                        server.removeListener('error', onError);
                        resolve();
                    };
                    server.once('error', onError);
                    server.once('listening', onListening);
                    server.listen(candidate, host);
                });
            }
            catch (error) {
                lastError = error;
                server.close();
                continue;
            }
            const address = server.address();
            this.boundPort = typeof address === 'object' && address ? address.port : candidate;
            this.server = server;
            if (this.boundPort !== port) {
                this.options.log.warn(`端口 ${port} 不可用，本地模型服务已改到 ${this.boundPort}，请同步更新 dsh 侧路由的 baseURL`);
            }
            this.options.log.info(`本地模型入口就绪：${this.origin}/v1`);
            return this.boundPort;
        }
        throw new Error(`无法为本地模型服务绑定端口（尝试 ${candidates.length} 个）：${lastError?.message ?? '未知错误'}`);
    }
    async close() {
        const server = this.server;
        this.server = null;
        if (!server)
            return;
        await new Promise((resolve) => {
            server.close(() => resolve());
            // 正在流式输出的连接不会自己断开，给 1 秒后强制关闭。
            setTimeout(() => resolve(), 1000).unref?.();
        });
    }
    authorized(req) {
        const key = this.options.apiKey().trim();
        if (!key)
            return true;
        const header = req.headers.authorization ?? '';
        const token = header.replace(/^Bearer\s+/i, '').trim();
        return token === key;
    }
    async handle(req, res) {
        try {
            const url = new URL(req.url ?? '/', this.origin);
            const pathname = url.pathname;
            if (req.method === 'GET' && isStatusPath(pathname)) {
                json(res, 200, this.options.status());
                return;
            }
            if (!this.authorized(req)) {
                json(res, 401, { error: { message: '本地模型服务需要 Authorization: Bearer <api-key>', type: 'invalid_request_error' } });
                return;
            }
            if (req.method === 'GET' && (pathname === '/health' || pathname.endsWith('/health'))) {
                const status = this.options.status();
                const ready = status.state === 'ready';
                json(res, ready ? 200 : 503, { status: ready ? 'ok' : status.state });
                return;
            }
            // 模型目录：即使还没加载也照常回答，这样 dsh 的模型下拉框任何时候都能拉到条目。
            if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
                const id = this.options.modelId();
                json(res, 200, {
                    object: 'list',
                    data: [
                        {
                            id,
                            object: 'model',
                            created: 0,
                            owned_by: 'local-model',
                            name: this.options.modelDisplayName(),
                        },
                    ],
                });
                return;
            }
            // 关键路径：首条对话在这里把模型拉起来（已加载时是零成本直通）。
            try {
                await this.options.ensureReady();
            }
            catch (error) {
                json(res, 503, {
                    error: {
                        message: error.message,
                        type: 'local_model_unavailable',
                        hint: '检查 Harness 设置 → 本地模型：模型是否已选中、llama-server 是否已放入运行时目录。',
                    },
                });
                return;
            }
            const target = this.options.upstream();
            if (!target) {
                json(res, 503, { error: { message: 'llama-server 尚未就绪', type: 'local_model_unavailable' } });
                return;
            }
            this.options.onRequestStart();
            let settled = false;
            const finish = () => {
                if (settled)
                    return;
                settled = true;
                this.options.onRequestEnd();
            };
            res.once('close', finish);
            res.once('finish', finish);
            await this.pipe(req, res, target, url);
        }
        catch (error) {
            this.options.log.error(`代理请求失败：${error.message}`);
            if (!res.headersSent)
                json(res, 502, { error: { message: error.message } });
            else
                res.end();
        }
    }
    async pipe(req, res, target, url) {
        // 思考开关只在 POST 的对话补全上生效；其它一切请求连请求体都不必读，保持原来的流式直通。
        const policy = this.options.thinkPolicy?.() ?? null;
        const shouldRewrite = policy !== null && req.method === 'POST' && isChatCompletionPath(url.pathname);
        let body = null;
        if (shouldRewrite && policy) {
            try {
                const outcome = rewriteChatRequestBody(await readRequestBody(req, MAX_REWRITE_BYTES), policy);
                body = outcome.body;
                if (outcome.notice)
                    this.options.log.debug(`未改写请求体：${outcome.notice}`);
            }
            catch (error) {
                this.options.log.error(`读取请求体失败：${error.message}`);
                if (!res.headersSent)
                    json(res, 413, { error: { message: error.message, type: 'local_model_request_error' } });
                return;
            }
        }
        return new Promise((resolve) => {
            const base = new URL(target);
            const headers = {};
            for (const [key, value] of Object.entries(req.headers)) {
                const lower = key.toLowerCase();
                if (HOP_BY_HOP.has(lower))
                    continue;
                if (lower === 'host')
                    continue;
                headers[key] = value;
            }
            headers.host = base.host;
            if (body !== null) {
                // 改写会改变长度：原样透传 content-length / transfer-encoding 会让上游读到半截或直接挂住。
                delete headers['content-length'];
                delete headers['transfer-encoding'];
                headers['content-length'] = String(body.byteLength);
            }
            const upstreamReq = http.request({
                protocol: base.protocol,
                hostname: base.hostname,
                port: base.port,
                path: `${url.pathname}${url.search}`,
                method: req.method,
                headers,
            }, (upstreamRes) => {
                const outHeaders = {};
                for (const [key, value] of Object.entries(upstreamRes.headers)) {
                    if (HOP_BY_HOP.has(key.toLowerCase()))
                        continue;
                    outHeaders[key] = value;
                }
                outHeaders['x-local-model'] = this.options.modelId();
                res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
                upstreamRes.pipe(res);
                upstreamRes.once('end', () => resolve());
                upstreamRes.once('error', () => resolve());
            });
            upstreamReq.once('error', (error) => {
                if (!res.headersSent) {
                    json(res, 502, { error: { message: `连接 llama-server 失败：${error.message}`, type: 'local_model_unavailable' } });
                }
                else {
                    res.end();
                }
                resolve();
            });
            // 客户端中途取消（用户点了停止）：把上游一起掐掉，别让它继续跑推理浪费显存。
            res.once('close', () => upstreamReq.destroy());
            req.once('aborted', () => upstreamReq.destroy());
            if (body !== null)
                upstreamReq.end(body);
            else
                req.pipe(upstreamReq);
        });
    }
}
/**
 * 读满整个请求体；超过上限直接失败，由调用方降级报错而不是把内存吃满。
 *
 * 超过上限时**不** destroy 请求：让它自己流完，否则连那句 413 都发不出去，
 * 用户只会看到连接被重置。之后的 chunk 直接丢掉（failed 之后不再累积）。
 */
function readRequestBody(req, limitBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            chunks.length = 0;
            reject(error);
        };
        req.on('data', (chunk) => {
            if (settled)
                return;
            size += chunk.length;
            if (size > limitBytes) {
                fail(new Error(`请求体超过 ${Math.round(limitBytes / 1024 / 1024)} MB，本地模型代理不处理这么大的对话请求`));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (settled)
                return;
            settled = true;
            resolve(Buffer.concat(chunks));
        });
        req.on('aborted', () => fail(new Error('请求在发送过程中被中断')));
        req.on('error', (error) => fail(error));
    });
}
function isStatusPath(pathname) {
    return pathname === '/local-model/status' || pathname === '/status';
}
