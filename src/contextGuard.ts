/**
 * 输出上限溢出保护（max_tokens vs n_ctx）。
 *
 * 要解决的是一类**必然失败**的请求：llama-server 系列里，`prompt + max_tokens > n_ctx`
 * 在标准上游构建上只会打一句 warning 然后把 max_tokens 收敛到装得下的值；但在
 * kvmem 那个独立 server 上，它被改成硬拒绝：
 *
 *     HTTP 400  {"error":"prompt + max_tokens exceeds n_ctx"}
 *
 * 于是「路由里声明的 maxTokens 比服务器真实 n_ctx 大」这种配置漂移
 * （实测：settings.yaml 手写路由声明 maxTokens=128000，而插件以 -c 32768 启动）
 * 会表现成**每条消息都失败**，且错误信息里既没有 prompt 长度也没有 n_ctx，无从下手。
 *
 * ── 为什么不做「估算 prompt token 数」 ────────────────────────────────────────
 * 第一版想过：按字符数估 token、反推 max_tokens。放弃了，因为两头都错：
 *   - 估小了（中英混排的比值差一倍以上）→ 照样 400，保护等于没有；
 *   - 估大了 → **静默把回复截短**，用户看到的是「模型话说到一半停了」，
 *     比一条明确的 400 更难查。
 * 所以这里只在**服务端已经明确拒绝**的前提下收敛，加上一条「必然失败」的预防规则：
 *   - 预防：`max_tokens >= n_ctx` 的请求对任何非空 prompt 都必失败（至少 1 个 token），
 *     直接压到 `n_ctx - reserveForPrompt`。这条规则不依赖任何估算，零假阳。
 *   - 补救：收到溢出报错后逐级减半重试，直到装得下或到底为止。
 * 代价是极端情况下会多跑一两次 prompt 分词（服务端校验发生在解码之前，很便宜），
 * 换来的是「绝不会把能跑通的请求改坏」。
 *
 * 纯函数：不碰进程、不碰 fs、不发请求，输入确定则输出确定，因此能被单测逐个钉死。
 */

/** 请求体里承载输出上限的字段名。`max_completion_tokens` 是 OpenAI 的新写法，一些客户端在发。 */
export const MAX_TOKENS_FIELDS = ['max_tokens', 'max_completion_tokens'] as const

export interface ContextGuardLimits {
  /** llama-server 真实的 n_ctx（就是启动时的 -c）。 */
  nCtx: number
  /** 收敛下限：再挤也要给模型留出这么多输出 token，否则这次请求没有意义。 */
  floor: number
  /** 预防性收敛时为 prompt 预留的 token 数。 */
  reserveForPrompt: number
  /** 溢出后最多重试几次。 */
  maxAttempts: number
}

/**
 * 默认参数。
 *
 * `floor` 取 512：低于它即使成功也没有产出可言，不如把错误交回去。
 * `reserveForPrompt` 取 1024：真实对话的 prompt 很少低于这个数，预防性收敛
 * 压到 `n_ctx - 1024` 之后仍会溢出的话，交给重试路径继续压，不会一步压到底。
 */
export const DEFAULT_GUARD_LIMITS: Omit<ContextGuardLimits, 'nCtx'> = {
  floor: 512,
  reserveForPrompt: 1024,
  maxAttempts: 5,
}

/**
 * 溢出报错的判据。
 *
 * 故意写得宽：这个模式要在多个分支/版本上都能命中（kvmem 独立 server 是
 * `prompt + max_tokens exceeds n_ctx`，上游是 `the request exceeds the available context size`），
 * 而**误命中的代价只是多一次重试**，漏命中的代价是用户继续看到一条无法解读的 400。
 */
export function isContextOverflowError(text: string): boolean {
  return /exceeds\s+n_ctx|exceeds\s+the\s+available\s+context|prompt\s+is\s+too\s+long|prompt\s+too\s+long/i.test(
    text,
  )
}

/** 请求体里的输出上限；没有该字段时返回 null（= 由服务端的 -n 决定）。 */
export function readMaxTokens(body: unknown): number | null {
  if (!isPlainObject(body)) return null
  for (const field of MAX_TOKENS_FIELDS) {
    const value = body[field]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

/** 写回输出上限：已有哪个字段就改哪个，都没有就加 `max_tokens`（llama.cpp 认它）。 */
export function writeMaxTokens(body: Record<string, unknown>, value: number): void {
  for (const field of MAX_TOKENS_FIELDS) {
    if (typeof body[field] === 'number') {
      body[field] = value
      return
    }
  }
  body[MAX_TOKENS_FIELDS[0]] = value
}

export interface PreflightOutcome {
  body: Buffer
  /** 真的改动了才为 true；false 时调用方原样转发即可。 */
  changed: boolean
  from: number | null
  to: number | null
}

/**
 * 预防性收敛：只处理「必然失败」的那一种请求。
 *
 * 判据是 `max_tokens >= n_ctx` 而不是「有可能失败」—— 任何非空 prompt 都至少占 1 个
 * token，所以这个条件下 `prompt + max_tokens > n_ctx` 恒成立。**没有任何假阳性**，
 * 因此不需要用户为它做取舍，默认开启也不会改坏任何一个本来能跑的请求。
 *
 * 解析失败一律原样放行：这是保护措施，不能反过来变成一个新的失败点。
 */
export function preflightMaxTokens(raw: Buffer | string, limits: ContextGuardLimits): PreflightOutcome {
  const source = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8')
  const unchanged: PreflightOutcome = { body: source, changed: false, from: null, to: null }

  let payload: unknown
  try {
    payload = JSON.parse(source.toString('utf8'))
  } catch {
    return unchanged
  }
  if (!isPlainObject(payload)) return unchanged

  const from = readMaxTokens(payload)
  if (from === null || !Number.isFinite(limits.nCtx) || limits.nCtx <= 0) return unchanged
  if (from < limits.nCtx) return unchanged

  const to = Math.max(limits.floor, Math.floor(limits.nCtx - limits.reserveForPrompt))
  if (to >= from) return unchanged

  writeMaxTokens(payload, to)
  return { body: Buffer.from(JSON.stringify(payload), 'utf8'), changed: true, from, to }
}

/**
 * 溢出之后的下一个候选上限；返回 null = 已经压到 floor，放弃重试（同一条请求再试也不会成功）。
 *
 * 收敛用减半而不是「减一个固定值」：不知道差多少，减半在对数步数内覆盖全部量级，
 * 而 n_ctx 通常是 2 的幂，减半后仍落在整齐的数字上，日志也好读。
 *
 * `current === null`（请求里压根没有 max_tokens 字段）时从 `n_ctx / 2` 起压：
 * 这种情况下上限来自服务端的 -n，只能靠显式写入 `max_tokens` 才能压住。
 */
export function nextRetryMaxTokens(current: number | null, limits: ContextGuardLimits): number | null {
  if (!Number.isFinite(limits.nCtx) || limits.nCtx <= 0) return null
  const base = current === null ? limits.nCtx : Math.min(current, limits.nCtx)
  const next = Math.floor(base / 2)
  return next >= limits.floor ? next : null
}

/** 把新的上限写进已经解析过的请求体，返回新 body；解析失败返回 null。 */
export function applyMaxTokens(raw: Buffer | string, value: number): Buffer | null {
  const source = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8')
  let payload: unknown
  try {
    payload = JSON.parse(source.toString('utf8'))
  } catch {
    return null
  }
  if (!isPlainObject(payload)) return null
  writeMaxTokens(payload, value)
  return Buffer.from(JSON.stringify(payload), 'utf8')
}

/**
 * 放弃重试时交给用户的话。
 *
 * 为什么值得替换掉服务端那句原文：`prompt + max_tokens exceeds n_ctx` 里
 * **既没有 n_ctx 也没有 max_tokens**，用户唯一能做的只有乱试。这句话把两个数字、
 * 以及「最可能的原因（路由里声明的上下文/输出上限和启动参数对不上）」一次说清。
 */
export function overflowHint(nCtx: number, promptTokens: number | null): string {
  const parts = [
    `本轮请求的上下文放不下：服务端 n_ctx = ${nCtx}（就是启动时的 -c）`,
    promptTokens === null ? '提示词长度：未知' : `提示词已占用 ${promptTokens} 个 token`,
  ]
  return (
    `${parts.join('，')}。` +
    '常见原因是 dsh 侧路由里声明的「上下文窗口 / 单次最大输出」比这里的 n_ctx 还大' +
    '（手写进 settings.yaml 的路由最容易出现这种漂移）。' +
    `请把该模型的 contextWindow 改成 ${nCtx}、maxTokens 调到 8192 一类的安全值，或把本地模型的「上下文长度」调大后重新加载。`
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
