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
/** 两个思考开关。语义与设置页上的两个开关一一对应。 */
export interface ThinkPolicy {
    /** 启用思考 → `chat_template_kwargs.enable_thinking`。**只在请求没有表达档位时才生效。** */
    enableThinking: boolean;
    /** 保留历史 think → `chat_template_kwargs.preserve_thinking`，并在关闭时剥离历史 think。 */
    preserveThinking: boolean;
    /**
     * 模型模板真正支持的档位（从 chat template 里解析出来）。
     *
     * `null` / 省略 = 没探测到 → **不下发 `reasoning_effort`**，只控制思考开关。
     * 宁可少一层粒度，也不能把模板不认的档位发过去：实测模型模板对不认识的档位是
     * `raise_exception`（不是忽略），一个档位名就能让整次请求 500。
     */
    supportedEfforts?: readonly string[] | null;
}
/**
 * llama.cpp 的档位词汇，按「想得多少」从少到多排列。
 *
 * 这只是**我们**用来判断远近的尺子，不代表模型支持全部七档 ——
 * 各家模板的档位表并不一致（实测 Qwen3.8 只认 xhigh/medium/low）。
 */
export declare const EFFORT_ORDER: readonly ["minimal", "low", "medium", "high", "xhigh", "max"];
export type EffortSignal = {
    kind: 'off';
} | {
    kind: 'on';
} | {
    kind: 'level';
    level: string;
};
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
export declare function normalizeEffortSignal(raw: unknown): EffortSignal | null;
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
export declare function mapEffortToSupported(level: string, supported: readonly string[] | null | undefined): string | null;
/**
 * 从模型的 chat template 里读出它认哪几个档位。
 *
 * 为什么必须读而不是写死一份表：各家模板的档位表并不一致，写死必然在别的模型上踩雷
 * （写「七档全给」正是 0.4.1 的错误 —— 在 Qwen3.8 上发 high 直接 500）。
 *
 * 做法：只在「包含 reasoning_effort 的 `not in (...)`」附近找引号里的候选名 ——
 * 这是实测模板的写法。找不到就返回 null，调用方改为不下发档位。
 */
export declare function extractSupportedEfforts(chatTemplate: unknown): string[] | null;
/** 承载模板变量的字段名。与 llama.cpp 的 OpenAI 兼容接口一致。 */
export declare const CHAT_TEMPLATE_KWARGS_FIELD = "chat_template_kwargs";
/**
 * 推理档位的字段名。
 *
 * 关键事实（社区实测 + llama.cpp 维护者确认）：llama-server **不认顶层的 `reasoning_effort`**，
 * 它会无报错、无日志地丢掉这个字段，模型就按自己的默认档位跑 ——
 * 表现是「档位选了没反应，而且查不到任何线索」。唯一有效的通道是 `chat_template_kwargs.reasoning_effort`。
 */
export declare const REASONING_EFFORT_FIELD = "reasoning_effort";
/**
 * 只改写对话补全。
 *
 * 其它路径（/v1/models、/health、/embeddings…）没有对话模板参数可言，
 * 少改一处就少一处引入回归的可能。
 */
export declare function isChatCompletionPath(pathname: string): boolean;
export interface RewriteOutcome {
    body: Buffer;
    /** 真的改动了内容才为 true；false 时调用方原样转发即可。 */
    changed: boolean;
    /** 没能改写时的一句人话说明（交给调用方按 debug 记日志）；成功时为 null。 */
    notice: string | null;
}
/**
 * 按策略改写一条 chat/completions 请求体。
 *
 * 失败一律「原样放行」：认不出来的请求体绝不能因为这两个开关而丢掉，
 * 那会把一个可以降级的设置问题变成一次请求失败。
 */
export declare function rewriteChatRequestBody(raw: Buffer | string, policy: ThinkPolicy): RewriteOutcome;
/**
 * 把历史 assistant 消息里的 think 内容剥掉。
 *
 * 与 preserve_thinking=false 是互补的两条路：模板支持该开关时由模板丢掉，
 * 不支持时（或客户端把思考塞回了正文/独立字段）由这里兜底。
 * 只动 assistant 消息 —— 用户的提问里出现 `<think>` 是内容，不是思考。
 */
export declare function stripHistoryThink(messages: unknown): boolean;
