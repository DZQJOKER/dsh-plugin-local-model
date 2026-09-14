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
    /** 启用思考 → `chat_template_kwargs.enable_thinking`。 */
    enableThinking: boolean;
    /** 保留历史 think → `chat_template_kwargs.preserve_thinking`，并在关闭时剥离历史 think。 */
    preserveThinking: boolean;
}
/** 承载模板变量的字段名。与 llama.cpp 的 OpenAI 兼容接口一致。 */
export declare const CHAT_TEMPLATE_KWARGS_FIELD = "chat_template_kwargs";
/**
 * 只改写对话补全。
 *
 * 其它路径（/v1/models、/health、/embeddings…）没有对话模板参数可言，
 * 少改一处就少一处引入回归的可能。
 */
export declare function isChatCompletionPath(pathname: string): boolean;
/**
 * 策略 → 模板变量。
 *
 * 两个值都**显式**下发：开关打开就下发 true、关闭就下发 false。
 * 只下发 false 的话，「打开」这一侧就没有任何效果 —— 模板默认不思考的模型上，
 * 用户会发现开关拨过去什么都不发生。
 */
export declare function thinkChatTemplateKwargs(policy: ThinkPolicy): Record<string, boolean>;
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
