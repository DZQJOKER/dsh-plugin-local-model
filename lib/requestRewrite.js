/**
 * 请求体改写：推理参数里的两个「思考」开关。
 *
 * 为什么在代理层改请求体，而不是加一条 llama-server 启动参数（--chat-template-kwargs）：
 *   1. 启动参数在旧构建上根本不存在，一旦下发就是「模型起不来」；请求体里多一个字段，
 *      旧构建的 JSON 解析器会直接忽略，最坏也只是开关无效 —— 模型加载这条主线绝不受影响；
 *   2. 这两个开关是「每次请求」的语义（对应 llama.cpp 的 chat_template_kwargs），
 *      改完立即生效，不必为了切一次开关重启模型、重新吃一遍加载时间；
 *   3. 「不保留历史 think」要动的是 messages 本身，启动参数表达不了。
 *
 * 纯函数：不碰进程、不碰 fs，输入确定则输出确定，因此能被单测逐个钉死。
 */
/** 承载模板变量的字段名。与 llama.cpp 的 OpenAI 兼容接口一致。 */
export const CHAT_TEMPLATE_KWARGS_FIELD = 'chat_template_kwargs';
/**
 * 推理档位的字段名。
 *
 * 关键事实（社区实测 + llama.cpp 维护者确认）：llama-server **不认顶层的 `reasoning_effort`**，
 * 它会无报错、无日志地丢掉这个字段，模型就按自己的默认档位跑 ——
 * 表现是「档位选了没反应，而且查不到任何线索」。唯一有效的通道是 `chat_template_kwargs.reasoning_effort`。
 */
export const REASONING_EFFORT_FIELD = 'reasoning_effort';
/**
 * 只改写对话补全。
 *
 * 其它路径（/v1/models、/health、/embeddings…）没有对话模板参数可言，
 * 少改一处就少一处引入回归的可能。
 */
export function isChatCompletionPath(pathname) {
    return pathname.replace(/\/+$/, '').endsWith('/chat/completions');
}
/**
 * 策略 → 插件**希望**呈现的模板变量。
 *
 * 注意这只是一份「意图」，不是最终写进请求体的东西：开关**开启**时的 `enable_thinking: true`
 * 是**默认值**，请求里已经明确表达过就不该覆盖它 —— 真正的合并规则在 {@link mergeThinkKwargs}。
 * （0.3.x 曾经直接把它整体覆盖上去，于是 dsh 的推理档位被抹平，见那里的注释。）
 *
 * 两个值都写出来而不是省略「真」的一侧，是因为这一份同时也被 `--chat-template-kwargs` 的
 * 手工配置场景当作参考 —— 只给 false 会让人以为「打开」不需要下发任何东西。
 */
export function thinkChatTemplateKwargs(policy) {
    return {
        enable_thinking: policy.enableThinking === true,
        preserve_thinking: policy.preserveThinking === true,
    };
}
/** 历史 think 的两种载体：独立的 reasoning 字段，以及正文里的 think 块。 */
const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'thinking'];
const THINK_BLOCK_RE = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi;
/**
 * 按策略改写一条 chat/completions 请求体。
 *
 * 失败一律「原样放行」：认不出来的请求体绝不能因为这两个开关而丢掉，
 * 那会把一个可以降级的设置问题变成一次请求失败。
 */
export function rewriteChatRequestBody(raw, policy) {
    const source = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
    const text = source.toString('utf8');
    if (text.trim().length === 0)
        return { body: source, changed: false, notice: '请求体为空，未改写' };
    let payload;
    try {
        payload = JSON.parse(text);
    }
    catch {
        return { body: source, changed: false, notice: '请求体不是合法 JSON，未改写（原样转发）' };
    }
    if (!isPlainObject(payload)) {
        return { body: source, changed: false, notice: '请求体不是 JSON 对象，未改写（原样转发）' };
    }
    let changed = mergeThinkKwargs(payload, policy);
    if (!policy.preserveThinking && stripHistoryThink(payload.messages))
        changed = true;
    if (!changed)
        return { body: source, changed: false, notice: null };
    return { body: Buffer.from(JSON.stringify(payload), 'utf8'), changed: true, notice: null };
}
/**
 * 合并模板变量。
 *
 * 「谁说了算」必须分清，否则就会出现「滑杆拨了没反应」：
 *
 *   - `preserve_thinking` 由**插件独占**（dsh 侧没有对应的 UI），直接写入；
 *   - `enable_thinking` 在插件开关**关闭**时是硬覆盖（强制 false）—— 用户明确要求不思考；
 *     在开关**开启**时只当**默认值**：请求里已经显式写了这一项，就原样放行。
 *     这一条是 2026-09-16 修掉的：原来无论请求说什么都被改写成 true，
 *     于是 dsh 的「推理等级」选 Off 也照样强制思考，选任何档位看起来都一样。
 *   - 顶层的 `reasoning_effort` 会被**下沉**进 `chat_template_kwargs`（见下面第 1 步）。
 */
function mergeThinkKwargs(body, policy) {
    const current = body[CHAT_TEMPLATE_KWARGS_FIELD];
    const before = isPlainObject(current) ? { ...current } : {};
    const merged = { ...before };
    // 1) 顶层档位下沉。llama.cpp 只读 chat_template_kwargs 里的那一个，留在顶层会被静默丢掉。
    const topLevelEffort = body[REASONING_EFFORT_FIELD];
    if (typeof topLevelEffort === 'string' &&
        topLevelEffort.trim() !== '' &&
        merged[REASONING_EFFORT_FIELD] === undefined) {
        merged[REASONING_EFFORT_FIELD] = topLevelEffort.trim();
    }
    // 2) preserve_thinking 归插件：dsh 侧没有这个开关，不会被请求覆盖。
    merged.preserve_thinking = policy.preserveThinking === true;
    // 3) enable_thinking：关闭 = 硬覆盖；开启 = 只补默认值，不夺走请求自己的决定。
    if (policy.enableThinking !== true)
        merged.enable_thinking = false;
    else if (!Object.prototype.hasOwnProperty.call(before, 'enable_thinking'))
        merged.enable_thinking = true;
    if (shallowEqual(before, merged))
        return false;
    body[CHAT_TEMPLATE_KWARGS_FIELD] = merged;
    return true;
}
/** 值都是标量，浅比较就够；用来保住「没什么可改就不碰请求体」这条路径。 */
function shallowEqual(a, b) {
    const keysA = Object.keys(a);
    if (keysA.length !== Object.keys(b).length)
        return false;
    return keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key]);
}
/**
 * 把历史 assistant 消息里的 think 内容剥掉。
 *
 * 与 preserve_thinking=false 是互补的两条路：模板支持该开关时由模板丢掉，
 * 不支持时（或客户端把思考塞回了正文/独立字段）由这里兜底。
 * 只动 assistant 消息 —— 用户的提问里出现 `<think>` 是内容，不是思考。
 */
export function stripHistoryThink(messages) {
    if (!Array.isArray(messages))
        return false;
    let changed = false;
    for (const message of messages) {
        if (!isPlainObject(message))
            continue;
        if (message.role !== 'assistant')
            continue;
        for (const field of REASONING_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(message, field)) {
                delete message[field];
                changed = true;
            }
        }
        if (stripThinkText(message))
            changed = true;
    }
    return changed;
}
/** 剥掉 content 里的 think 块；content 可能是字符串，也可能是多模态的 parts 数组。 */
function stripThinkText(message) {
    const content = message.content;
    if (typeof content === 'string') {
        const replaced = content.replace(THINK_BLOCK_RE, '');
        // 只有真的命中过 think 块才回写，避免顺手把普通正文的空白也改了。
        if (replaced === content)
            return false;
        message.content = replaced.replace(/^\s+/, '');
        return true;
    }
    if (Array.isArray(content)) {
        let changed = false;
        for (const part of content) {
            if (!isPlainObject(part))
                continue;
            if (part.type !== 'text' || typeof part.text !== 'string')
                continue;
            const replaced = part.text.replace(THINK_BLOCK_RE, '');
            if (replaced === part.text)
                continue;
            part.text = replaced.replace(/^\s+/, '');
            changed = true;
        }
        return changed;
    }
    return false;
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
