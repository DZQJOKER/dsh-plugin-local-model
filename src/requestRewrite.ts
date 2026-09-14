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
  enableThinking: boolean
  /** 保留历史 think → `chat_template_kwargs.preserve_thinking`，并在关闭时剥离历史 think。 */
  preserveThinking: boolean
}

/** 承载模板变量的字段名。与 llama.cpp 的 OpenAI 兼容接口一致。 */
export const CHAT_TEMPLATE_KWARGS_FIELD = 'chat_template_kwargs'

/**
 * 只改写对话补全。
 *
 * 其它路径（/v1/models、/health、/embeddings…）没有对话模板参数可言，
 * 少改一处就少一处引入回归的可能。
 */
export function isChatCompletionPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, '').endsWith('/chat/completions')
}

/**
 * 策略 → 模板变量。
 *
 * 两个值都**显式**下发：开关打开就下发 true、关闭就下发 false。
 * 只下发 false 的话，「打开」这一侧就没有任何效果 —— 模板默认不思考的模型上，
 * 用户会发现开关拨过去什么都不发生。
 */
export function thinkChatTemplateKwargs(policy: ThinkPolicy): Record<string, boolean> {
  return {
    enable_thinking: policy.enableThinking === true,
    preserve_thinking: policy.preserveThinking === true,
  }
}

/** 历史 think 的两种载体：独立的 reasoning 字段，以及正文里的 think 块。 */
const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'thinking'] as const
const THINK_BLOCK_RE = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi

export interface RewriteOutcome {
  body: Buffer
  /** 真的改动了内容才为 true；false 时调用方原样转发即可。 */
  changed: boolean
  /** 没能改写时的一句人话说明（交给调用方按 debug 记日志）；成功时为 null。 */
  notice: string | null
}

/**
 * 按策略改写一条 chat/completions 请求体。
 *
 * 失败一律「原样放行」：认不出来的请求体绝不能因为这两个开关而丢掉，
 * 那会把一个可以降级的设置问题变成一次请求失败。
 */
export function rewriteChatRequestBody(raw: Buffer | string, policy: ThinkPolicy): RewriteOutcome {
  const source = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8')
  const text = source.toString('utf8')
  if (text.trim().length === 0) return { body: source, changed: false, notice: '请求体为空，未改写' }

  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return { body: source, changed: false, notice: '请求体不是合法 JSON，未改写（原样转发）' }
  }
  if (!isPlainObject(payload)) {
    return { body: source, changed: false, notice: '请求体不是 JSON 对象，未改写（原样转发）' }
  }

  let changed = mergeThinkKwargs(payload, policy)
  if (!policy.preserveThinking && stripHistoryThink(payload.messages)) changed = true
  if (!changed) return { body: source, changed: false, notice: null }

  return { body: Buffer.from(JSON.stringify(payload), 'utf8'), changed: true, notice: null }
}

/**
 * 合并模板变量。
 *
 * 必须「合」而不是「覆盖」：用户完全可能自己在请求里塞了别的模板变量
 * （比如自定义模板的开关），覆盖掉等于替他删参数。
 */
function mergeThinkKwargs(body: Record<string, unknown>, policy: ThinkPolicy): boolean {
  const desired = thinkChatTemplateKwargs(policy)
  const current = body[CHAT_TEMPLATE_KWARGS_FIELD]
  const existing = isPlainObject(current) ? current : {}

  // 需要下发的值已经在了，就不动它 —— 让「值没变」的路径保持零改写。
  if (Object.entries(desired).every(([key, value]) => existing[key] === value)) return false

  body[CHAT_TEMPLATE_KWARGS_FIELD] = { ...existing, ...desired }
  return true
}

/**
 * 把历史 assistant 消息里的 think 内容剥掉。
 *
 * 与 preserve_thinking=false 是互补的两条路：模板支持该开关时由模板丢掉，
 * 不支持时（或客户端把思考塞回了正文/独立字段）由这里兜底。
 * 只动 assistant 消息 —— 用户的提问里出现 `<think>` 是内容，不是思考。
 */
export function stripHistoryThink(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false
  let changed = false
  for (const message of messages) {
    if (!isPlainObject(message)) continue
    if (message.role !== 'assistant') continue

    for (const field of REASONING_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(message, field)) {
        delete message[field]
        changed = true
      }
    }
    if (stripThinkText(message)) changed = true
  }
  return changed
}

/** 剥掉 content 里的 think 块；content 可能是字符串，也可能是多模态的 parts 数组。 */
function stripThinkText(message: Record<string, unknown>): boolean {
  const content = message.content

  if (typeof content === 'string') {
    const replaced = content.replace(THINK_BLOCK_RE, '')
    // 只有真的命中过 think 块才回写，避免顺手把普通正文的空白也改了。
    if (replaced === content) return false
    message.content = replaced.replace(/^\s+/, '')
    return true
  }

  if (Array.isArray(content)) {
    let changed = false
    for (const part of content) {
      if (!isPlainObject(part)) continue
      if (part.type !== 'text' || typeof part.text !== 'string') continue
      const replaced = part.text.replace(THINK_BLOCK_RE, '')
      if (replaced === part.text) continue
      part.text = replaced.replace(/^\s+/, '')
      changed = true
    }
    return changed
  }

  return false
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
