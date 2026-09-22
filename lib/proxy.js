import http from 'node:http';
import { isChatCompletionPath, rewriteChatRequestBody } from './requestRewrite.js';
import { applyMaxTokens, isContextOverflowError, nextRetryMaxTokens, overflowHint, preflightMaxTokens, readMaxTokens, } from './contextGuard.js';
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade']);
/**
 * 把改写后的思考相关字段摘出来打日志。
 *
 * 为什么值得单独做：排查「档位拨了没反应」时，最缺的就是**第一手事实** ——
 * dsh 到底发了什么、插件最后发了什么。没有这一行，只能靠猜；
 * 有了它可以一句话定位是「上游没发档位」还是「插件把它改错了」。
 */
function describeThinking(body) {
    try {
        const payload = JSON.parse(body.toString('utf8'));
        const kwargs = payload.chat_template_kwargs;
        return `发给 llama-server 的思考参数 ${JSON.stringify(kwargs ?? {})}`;
    }
    catch {
        return '(请求体无法解析，仅记录发生了改写)';
    }
}
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
    /**
     * 请求分派：决定这一条要不要碰请求体，以及走哪条转发路径。
     *
     * 两条独立的改写通道，各自可以单独关闭：
     *   policy —— 思考开关（模板参数 + 剥离历史 think）
     *   guard  —— 输出上限溢出保护（max_tokens vs n_ctx，见 contextGuard.ts）
     *
     * 两者都不需要时，保持原来的「请求体边读边转发」——一个字节都不在我们的内存里停留。
     */
    async pipe(req, res, target, url) {
        const policy = this.options.thinkPolicy?.() ?? null;
        const guard = this.options.contextGuard?.() ?? null;
        const isChat = req.method === 'POST' && isChatCompletionPath(url.pathname);
        const wantRewrite = isChat && policy !== null;
        const wantGuard = isChat && guard !== null && Number.isFinite(guard.nCtx) && guard.nCtx > 0;
        if (!wantRewrite && !wantGuard)
            return this.pipeDirect(req, res, target, url, null);
        let body;
        try {
            body = await readRequestBody(req, MAX_REWRITE_BYTES);
        }
        catch (error) {
            this.options.log.error(`读取请求体失败：${error.message}`);
            if (!res.headersSent) {
                json(res, 413, { error: { message: error.message, type: 'local_model_request_error' } });
            }
            return;
        }
        if (wantRewrite && policy) {
            const outcome = rewriteChatRequestBody(body, policy);
            body = outcome.body;
            if (outcome.notice)
                this.options.log.debug(`未改写请求体：${outcome.notice}`);
            else if (outcome.changed)
                this.options.log.debug(`已改写请求体：${describeThinking(body)}`);
        }
        if (!wantGuard || !guard)
            return this.pipeDirect(req, res, target, url, body);
        // 预防性收敛：`max_tokens >= n_ctx` 的请求对任何非空提示词都必然放不下，先压到装得下。
        // 这一步不依赖任何 token 估算，因此零假阳性 —— 它绝不会改坏一个本来能跑通的请求。
        const pre = preflightMaxTokens(body, guard);
        if (pre.changed) {
            body = pre.body;
            this.options.log.warn(`请求里的输出上限（${pre.from}）不小于服务端上下文长度（${guard.nCtx}），已先压到 ${pre.to}。` +
                '根治办法是把 dsh 路由里那个模型的「单次最大输出 tokens」改小 —— 否则每次对话都要走这条补救路径。');
        }
        return this.pipeGuarded(req, res, target, url, body, guard);
    }
    /**
     * 原样转发（可带一个已改写好的请求体）。
     *
     * `body === null` 表示完全不缓冲：请求边读边发、响应边收边发，SSE 流式对话走的就是这条路。
     */
    pipeDirect(req, res, target, url, body) {
        return new Promise((resolve) => {
            const upstreamReq = http.request(this.upstreamOptions(req, target, url, body), (upstreamRes) => {
                this.writeHeadFrom(res, upstreamRes);
                upstreamRes.pipe(res);
                upstreamRes.once('end', () => resolve());
                upstreamRes.once('error', () => resolve());
            });
            upstreamReq.once('error', (error) => {
                this.reportUpstreamError(res, error);
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
    /**
     * 带溢出保护地转发一条对话请求。
     *
     * 性能上的关键取舍：**只有 400 才被缓冲下来看一眼**（它的体积极小），其余状态码一律
     * 照旧流式直通 —— 所以正常对话的开销与不带保护时完全一样，连多一次拷贝都没有。
     *
     * 命中溢出判据时，把 max_tokens 逐级减半重发。服务端这项校验发生在解码之前
     * （只需对提示词分词），一次失败的尝试很便宜；而不这么做，用户拿到的那条 400
     * 里既没有 n_ctx 也没有提示词长度，除了乱试没有别的办法。
     */
    async pipeGuarded(req, res, target, url, body, guard) {
        let current = body;
        let limit = parseMaxTokens(body);
        let lastBuffered = null;
        for (let attempt = 0;; attempt++) {
            // 用户可能在重试期间关掉了这一轮对话；此时上游已经没人在等，不必再打字。
            if (res.writableEnded || res.destroyed)
                return;
            const outcome = await this.sendOnce(req, res, target, url, current);
            if (outcome.kind === 'streamed')
                return;
            lastBuffered = outcome;
            if (!isContextOverflowError(outcome.body.toString('utf8'))) {
                this.flushBuffered(res, outcome);
                return;
            }
            const next = attempt >= guard.maxAttempts ? null : nextRetryMaxTokens(limit, guard);
            const nextBody = next === null ? null : applyMaxTokens(body, next);
            if (next === null || nextBody === null) {
                this.options.log.error(`上下文装不下这次请求（n_ctx=${guard.nCtx}）：已把输出上限压到 ${limit ?? '未指定'} 仍被拒绝。` +
                    '提示词本身就快占满上下文了，请调大「上下文长度」或让 dsh 侧早点压缩历史。');
                this.flushBuffered(res, outcome, overflowHint(guard.nCtx, null));
                return;
            }
            this.options.log.warn(`服务端报「上下文放不下」，已把输出上限从 ${limit ?? '未指定'} 压到 ${next} 后重试（第 ${attempt + 1} 次）。` +
                '根治办法是把 dsh 路由里那个模型的 contextWindow / maxTokens 改成与实际启动参数 -c 一致的值。');
            current = nextBody;
            limit = next;
        }
    }
    /**
     * 发一次并等响应。
     *
     * 非 400 的状态码原样流给客户端并返回 `streamed`；400 则把（很小的）响应体整个读下来，
     * 交给调用方判断是「上下文放不下」还是别的错误 —— 只有前者才值得重试。
     */
    sendOnce(req, res, target, url, body) {
        /**
         * 缓冲 400 响应体的上限。
         *
         * 只缓冲 400，且只为读那句几十字节的报错 —— 设这个上限是「宁可当普通错误放行，
         * 也不把几百 MB 的响应读进内存」的兜底（攒多了说明上游返回的是别的东西，
         * 那种情况我们本来也不认识）。
         */
        const MAX_ERROR_BYTES = 64 * 1024;
        return new Promise((resolve) => {
            const upstreamReq = http.request(this.upstreamOptions(req, target, url, body), (upstreamRes) => {
                const status = upstreamRes.statusCode ?? 502;
                if (status !== 400) {
                    this.writeHeadFrom(res, upstreamRes);
                    upstreamRes.pipe(res);
                    upstreamRes.once('end', () => resolve({ kind: 'streamed' }));
                    upstreamRes.once('error', () => resolve({ kind: 'streamed' }));
                    return;
                }
                const chunks = [];
                let size = 0;
                const done = () => {
                    resolve({ kind: 'buffered', status, headers: upstreamRes.headers, body: Buffer.concat(chunks) });
                };
                upstreamRes.on('data', (chunk) => {
                    size += chunk.length;
                    if (size <= MAX_ERROR_BYTES)
                        chunks.push(chunk);
                });
                upstreamRes.once('end', done);
                upstreamRes.once('error', done);
            });
            upstreamReq.once('error', (error) => {
                this.reportUpstreamError(res, error);
                resolve({ kind: 'streamed' });
            });
            res.once('close', () => upstreamReq.destroy());
            req.once('aborted', () => upstreamReq.destroy());
            upstreamReq.end(body);
        });
    }
    /** 组装转发给上游的请求参数：透传头、改 host、按实际体长重算 content-length。 */
    upstreamOptions(req, target, url, body) {
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
        return {
            protocol: base.protocol,
            hostname: base.hostname,
            port: base.port,
            path: `${url.pathname}${url.search}`,
            method: req.method,
            headers,
        };
    }
    writeHeadFrom(res, upstreamRes) {
        const outHeaders = {};
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
            if (HOP_BY_HOP.has(key.toLowerCase()))
                continue;
            outHeaders[key] = value;
        }
        outHeaders['x-local-model'] = this.options.modelId();
        res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
    }
    /**
     * 把缓冲下来的响应原样还给客户端；给了 hint 就换成一句能读懂的中文说明。
     *
     * 为什么值得替换原文：`prompt + max_tokens exceeds n_ctx` 里**既没有 n_ctx 也没有
     * max_tokens**，用户唯一能做的只有乱试。原文保留在 `detail` 里，便于对着日志排查。
     */
    flushBuffered(res, outcome, hint) {
        if (res.headersSent || res.writableEnded)
            return;
        const outHeaders = {};
        for (const [key, value] of Object.entries(outcome.headers)) {
            if (HOP_BY_HOP.has(key.toLowerCase()))
                continue;
            outHeaders[key] = value;
        }
        outHeaders['x-local-model'] = this.options.modelId();
        const payload = hint
            ? Buffer.from(JSON.stringify({
                error: {
                    message: hint,
                    type: 'context_overflow',
                    detail: outcome.body.toString('utf8').slice(0, 2000),
                },
            }), 'utf8')
            : outcome.body;
        if (hint)
            outHeaders['content-type'] = 'application/json; charset=utf-8';
        outHeaders['content-length'] = String(payload.byteLength);
        res.writeHead(outcome.status, outHeaders);
        res.end(payload);
    }
    reportUpstreamError(res, error) {
        if (!res.headersSent) {
            json(res, 502, { error: { message: `连接 llama-server 失败：${error.message}`, type: 'local_model_unavailable' } });
        }
        else {
            res.end();
        }
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
/**
 * 读出请求体里的输出上限；解析不了就当没指定。
 *
 * 这里刻意不复用 contextGuard.readMaxTokens 的入参形态：那个吃的是已经解析好的对象，
 * 而代理手上只有 Buffer。解析失败一律回落到 null —— 溢出保护是补救措施，
 * 不能因为「读不出来」反而把一条正常的请求挡下来。
 */
function parseMaxTokens(body) {
    try {
        const payload = JSON.parse(body.toString('utf8'));
        return readMaxTokens(payload);
    }
    catch {
        return null;
    }
}
function isStatusPath(pathname) {
    return pathname === '/local-model/status' || pathname === '/status';
}
