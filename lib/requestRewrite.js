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
/**
 * llama.cpp 的档位词汇，按「想得多少」从少到多排列。
 *
 * 这只是**我们**用来判断远近的尺子，不代表模型支持全部七档 ——
 * 各家模板的档位表并不一致（实测 Qwen3.8 只认 xhigh/medium/low）。
 */
export const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** 视为「明确不要思考」的取值。dsh 会把 off 经 settings.yaml 往返写成布尔 false，所以也得认。 */
const OFF_VALUES = new Set(['off', 'none', 'no', 'false', 'disable', 'disabled', '0']);
/** 视为「要思考，但没指定档位」的取值。 */
const ON_VALUES = new Set(['on', 'yes', 'true', 'enable', 'enabled', 'auto', 'default']);
/**
 * 把请求里那个五花八门的档位归一化。
 *
 * 为什么必须容忍布尔 / 数字 / 字符串各种形态：实测 dsh 会把档位经 settings.yaml 往返后
 * 变成 `reasoning_effort: false` / `true` / `null` 直接塞进请求（YAML 把 `off`/`on` 读成了布尔），
 * 而模型模板对这些值一律 `raise_exception` —— 一次对话直接 500。
 *
 * `null` 按**没有表态**处理（不是 off）：空值语义上就是「没说」，
 * 若把它当成「不思考」，会在用户没做任何选择时误关思考。
 * 返回 null = 请求没有表达档位。
 */
export function normalizeEffortSignal(raw) {
    if (raw === undefined || raw === null)
        return null;
    if (raw === false)
        return { kind: 'off' };
    if (raw === true)
        return { kind: 'on' };
    if (typeof raw === 'number')
        return raw === 0 ? { kind: 'off' } : { kind: 'on' };
    if (typeof raw !== 'string')
        return null;
    const value = raw.trim().toLowerCase();
    if (value === '')
        return null;
    if (OFF_VALUES.has(value))
        return { kind: 'off' };
    if (ON_VALUES.has(value))
        return { kind: 'on' };
    return { kind: 'level', level: value };
}
/**
 * 把请求的档位映射到模型模板**真正支持**的档位。
 *
 * 为什么不能原样透传：模板对不认识的档位是 raise 而不是忽略。实测 Qwen3.8 的模板写着
 * `not in ('xhigh', 'medium', 'low')` 就抛异常 —— 连 `high` 都会让请求 500。
 *
 * 规则：支持的档位里挑最接近的；距离相同时取**更高**那一档（用户选 High 显然是要更深）。
 * `supported` 为空（没探测到）或档位名我们完全不认识时返回 null —— 不下发这个字段，
 * 让模板用它自己的默认值。
 */
export function mapEffortToSupported(level, supported) {
    if (!supported || supported.length === 0)
        return null;
    const pool = [...new Set(supported.map((item) => item.trim().toLowerCase()).filter(Boolean))];
    if (pool.length === 0)
        return null;
    const want = level.trim().toLowerCase();
    if (pool.includes(want))
        return want;
    const wantRank = rankOf(want);
    if (wantRank < 0)
        return null; // 认不出的档位名（模型自定义的）→ 不猜
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of pool) {
        const rank = rankOf(candidate);
        if (rank < 0)
            continue;
        const distance = Math.abs(rank - wantRank);
        if (distance < bestDistance || (distance === bestDistance && best !== null && rank > rankOf(best))) {
            best = candidate;
            bestDistance = distance;
        }
    }
    return best;
}
function rankOf(level) {
    return EFFORT_ORDER.indexOf(level);
}
/**
 * 从模型的 chat template 里读出它认哪几个档位。
 *
 * 为什么必须读而不是写死一份表：各家模板的档位表并不一致，写死必然在别的模型上踩雷
 * （写「七档全给」正是 0.4.1 的错误 —— 在 Qwen3.8 上发 high 直接 500）。
 *
 * 做法：只在「包含 reasoning_effort 的 `not in (...)`」附近找引号里的候选名 ——
 * 这是实测模板的写法。找不到就返回 null，调用方改为不下发档位。
 */
export function extractSupportedEfforts(chatTemplate) {
    if (typeof chatTemplate !== 'string' || chatTemplate.length === 0)
        return null;
    for (const match of chatTemplate.matchAll(/not\s+in\s*\(([^)]*)\)/gi)) {
        const at = match.index ?? 0;
        const window = chatTemplate.slice(Math.max(0, at - 240), at + match[0].length);
        if (!/reasoning[_\s-]*effort/i.test(window))
            continue;
        const names = [...(match[1] ?? '').matchAll(/['"]([A-Za-z][A-Za-z0-9_-]*)['"]/g)].map((item) => (item[1] ?? '').toLowerCase());
        const unique = [...new Set(names.filter(Boolean))];
        if (unique.length >= 2)
            return unique;
    }
    return null;
}
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
 * 「谁说了算」必须分清，否则就会出现「滑杆拨了没反应」或者「拨了反而 500」：
 *
 *   - `preserve_thinking` 由**插件独占**（dsh 侧没有对应的 UI），直接写入；
 *   - **开 / 关以请求为准**：请求的显式 `enable_thinking` 最优先，其次是档位（有档位就是想思考），
 *     插件开关只在请求**什么都没说**时才起作用。这样「开关开着选 Off 能关掉」和
 *     「开关关着选 High 能开启」两件事同时成立；
 *   - 档位值一律**归一化 + 按模型模板重映射**后再下发（见 normalizeEffortSignal /
 *     mapEffortToSupported）。原来是把 `false`/`null`/`high` 原样塞给模板，
 *     而模板对不认识的档位是 raise —— 用户那边表现为一次对话直接 500。
 */
function mergeThinkKwargs(body, policy) {
    const current = body[CHAT_TEMPLATE_KWARGS_FIELD];
    const before = isPlainObject(current) ? { ...current } : {};
    const merged = { ...before };
    // 候选取值：chat_template_kwargs 里的优先；dsh 的默认（openai）格式发的是顶层字段，
    // 而 llama-server 会把顶层那个静默丢掉，所以要一起看。
    const rawEffort = merged[REASONING_EFFORT_FIELD] !== undefined ? merged[REASONING_EFFORT_FIELD] : body[REASONING_EFFORT_FIELD];
    const signal = normalizeEffortSignal(rawEffort);
    // 1) preserve_thinking 归插件：dsh 侧没有这个开关，不会被请求覆盖。
    merged.preserve_thinking = policy.preserveThinking === true;
    // 2) 开 / 关：请求的显式 enable_thinking 最优先，其次看档位，最后才用插件开关。
    //    最后一步是「插件开关只在请求什么都没说时生效」的落点 ——
    //    于是「开关开着选 Off 能关掉」和「开关关着选 High 能开启」可以同时成立。
    const explicitEnable = merged.enable_thinking;
    if (typeof explicitEnable === 'boolean')
        merged.enable_thinking = explicitEnable;
    else if (signal)
        merged.enable_thinking = signal.kind !== 'off';
    else
        merged.enable_thinking = policy.enableThinking === true;
    // 3) 档位：只有「要思考」且请求给了具体档位、并且能映射到模板支持的值时才下发。
    //    其余情况一律**删掉**这个字段 —— 留着任何模板不认的值（false / null / high）都会 500。
    const effort = merged.enable_thinking === true && signal?.kind === 'level'
        ? mapEffortToSupported(signal.level, policy.supportedEfforts)
        : null;
    if (effort)
        merged[REASONING_EFFORT_FIELD] = effort;
    else
        delete merged[REASONING_EFFORT_FIELD];
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
