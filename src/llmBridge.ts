import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_MODEL_ALIAS, LOCAL_MODEL_ID, LOCAL_ROUTE_NAME } from './configResolve.js'
import type { Log } from './log.js'
import type { ResolvedConfig } from './configResolve.js'

/** dsh 侧应当写入的 llm 路由描述。 */
export interface RouteSpec {
  routeName: string
  displayName: string
  baseURL: string
  modelId: string
  modelName: string
  contextWindow: number
  maxTokens: number
  /** 凭据环境变量名；未配置 apiKey 时为 ''（= 免鉴权）。 */
  apiKeyEnv: string
  apiKey: string
  /** 流式空闲超时。本地模型吐字慢，必须比云端宽松得多。 */
  streamIdleTimeoutMs: number
}

/**
 * 组装路由描述。
 *
 * 注意哪些值来自常量：路由名、模型 id、别名都曾是设置项，现已按用户要求从 schema 删除、
 * 改为常量 —— 这三个值本来就不该随每次配置漂移，dsh 侧的 settings.yaml 引用的是它们。
 * `contextWindow` 则取 `ctxSize`（不再是独立设置），这样「dsh 声明的窗口」与
 * 「llama.cpp 的 -c」同源，不可能出现声明比实际大、长会话中途崩的情况。
 */
export function buildRouteSpec(config: ResolvedConfig, baseURL: string): RouteSpec {
  return {
    routeName: LOCAL_ROUTE_NAME,
    displayName: '本地模型（llama.cpp）',
    baseURL,
    modelId: LOCAL_MODEL_ID,
    modelName: `本地模型 · ${DEFAULT_MODEL_ALIAS}`,
    contextWindow: config.ctxSize,
    maxTokens: config.maxTokens,
    apiKeyEnv: config.apiKey ? 'DSH_LOCAL_MODEL_API_KEY' : '',
    apiKey: config.apiKey,
    streamIdleTimeoutMs: 600_000,
  }
}

/**
 * 告诉 dsh「这个模型的思考档位该怎么下发」。
 *
 * **不声明这一块，滑杆就是个摆设**：pi-ai 只在 `model.reasoning` 为真时才走思考分支，
 * 模型有没有推理能力又完全由 profile 里的 `reasoningEfforts` 决定 ——
 * 我们既没声明、dsh 的内置目录里也没有 `local` 这个模型，于是 pi-ai 什么思考参数都不发。
 * 用户看到的现象就是「推理等级选哪个都没反应」（2026-09-16 实测）。
 *
 * `thinkingFormat: 'chat-template'` 让 dsh 把档位写进 `chat_template_kwargs`，
 * 而这正是 llama.cpp **唯一**认的通道；同样的值放在顶层 `reasoning_effort` 会被它静默丢掉。
 */
const THINKING_COMPAT = {
  thinkingFormat: 'chat-template',
  chatTemplateKwargs: {
    // 档位开关：Off 档位下发 false，其余档位 true。
    enable_thinking: { $var: 'thinking.enabled' },
    // 档位本身。omitWhenOff 保证选 Off 时不发这个字段。
    reasoning_effort: { $var: 'thinking.effort', omitWhenOff: true },
  },
}

/**
 * 档位 → 线上写法。
 *
 * 直接用 **llama.cpp 自己的词汇**（minimal/low/medium/high/xhigh/max），不做模型专用的猜测：
 * 传一个模板没定义的档位名有可能在模板层直接报错，而「哪个模型定义了哪几档」只有模型自己知道。
 * `off: null` = 该档位不下发值，正是 dsh 侧「不发参数即为不思考」的正确表达。
 */
const REASONING_EFFORTS: Record<string, string | null> = {
  off: null,
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}

/** 生成 pi-ai 路由 profile（对应 settings.yaml 里 llm-pi-ai.providers.<route>）。 */
export function buildRouteProfile(spec: RouteSpec): Record<string, unknown> {
  const profile: Record<string, unknown> = {
    displayName: spec.displayName,
    api: 'openai-completions',
    baseURL: spec.baseURL,
    streamIdleTimeoutMs: spec.streamIdleTimeoutMs,
    compat: THINKING_COMPAT,
    models: [
      {
        id: spec.modelId,
        name: spec.modelName,
        contextWindow: spec.contextWindow,
        maxTokens: spec.maxTokens,
        // 声明推理能力 + 档位映射：这一步决定 dsh 的滑杆是否连到模型。
        reasoningEfforts: REASONING_EFFORTS,
      },
    ],
  }
  if (spec.apiKeyEnv) profile.apiKeyEnv = spec.apiKeyEnv
  return profile
}

/** 用户需要手写配置时，直接把这段贴进 $DSH_HOME/settings.yaml。 */
export function renderRouteYaml(spec: RouteSpec): string {
  const lines = [
    'llm-pi-ai:',
    '  providers:',
    `    ${spec.routeName}:`,
    `      displayName: ${spec.displayName}`,
    '      api: openai-completions',
    `      baseURL: ${spec.baseURL}`,
    `      streamIdleTimeoutMs: ${spec.streamIdleTimeoutMs}`,
    '      # 推理档位：让 dsh 的「推理等级」滑杆把档位写进 chat_template_kwargs',
    '      # （llama.cpp 只认这个通道；顶层 reasoning_effort 会被静默丢掉）。',
    '      compat:',
    `        thinkingFormat: ${THINKING_COMPAT.thinkingFormat}`,
    '        chatTemplateKwargs:',
    '          enable_thinking:',
    '            $var: thinking.enabled',
    '          reasoning_effort:',
    '            $var: thinking.effort',
    '            omitWhenOff: true',
  ]
  if (spec.apiKeyEnv) lines.push(`      apiKeyEnv: ${spec.apiKeyEnv}`)
  lines.push('      models:')
  lines.push(`        - id: ${spec.modelId}`)
  lines.push(`          name: ${spec.modelName}`)
  lines.push(`          contextWindow: ${spec.contextWindow}`)
  lines.push(`          maxTokens: ${spec.maxTokens}`)
  lines.push('          reasoningEfforts:')
  for (const [level, wire] of Object.entries(REASONING_EFFORTS)) {
    lines.push(`            ${level}:${wire === null ? '' : ` ${wire}`}`)
  }
  return lines.join('\n')
}

/** 依次尝试宿主可能暴露的路由注册入口。名字来自 dsh 各版本公开文档，取交集最稳的顺序。 */
const REGISTER_METHODS = ['registerProvider', 'upsertProvider', 'registerRoute', 'addRoute', 'setRoute'] as const
const REMOVE_METHODS = ['removeProvider', 'unregisterProvider', 'removeRoute', 'deleteRoute'] as const

export interface LlmBridgeResult {
  /** 是否成功把路由注册进宿主。 */
  registered: boolean
  reason: string
  profile: Record<string, unknown>
  yaml: string
  dispose: () => void
}

/**
 * 把本地端点接进 dsh 的 llm 缝。
 *
 * 这里是整个插件里**唯一**需要适配宿主版本的地方，因此刻意写得保守：
 *   1. 优先调用宿主 llm 服务暴露的注册方法（feature-detect，逐个试）；
 *   2. 宿主没暴露 / 调用失败 → 不报错、不影响其它能力，改为把可粘贴的
 *      settings.yaml 片段打到日志里，并在 /local-model status 里给出。
 *
 * 之所以不接受「注册失败就整体不可用」：本插件最有价值的部分是进程与显存生命周期
 * 管理，路由只是接线；接线可以人工完成，模型不该因此加载不了。
 */
export function bridgeLlmRoute(ctx: Context, spec: RouteSpec, log: Log): LlmBridgeResult {
  const profile = buildRouteProfile(spec)
  const yaml = renderRouteYaml(spec)

  if (spec.apiKeyEnv && spec.apiKey) {
    process.env[spec.apiKeyEnv] = spec.apiKey
  }

  const llm = ctx.get<Record<string, unknown>>('llm')
  if (!llm) {
    const reason = '宿主未提供 llm 服务'
    log.warn(`${reason}，本地端点仍会正常提供服务，请手动把下面的路由配置写入 $DSH_HOME/settings.yaml：\n${yaml}`)
    return { registered: false, reason, profile, yaml, dispose: () => undefined }
  }

  for (const method of REGISTER_METHODS) {
    const fn = llm[method]
    if (typeof fn !== 'function') continue
    try {
      const result = (fn as (name: string, profile: unknown) => unknown).call(llm, spec.routeName, profile)
      log.info(`已通过 llm.${method}() 注册本地模型路由「${spec.routeName}」`)
      const dispose =
        typeof result === 'function'
          ? (result as () => void)
          : () => {
              for (const removeMethod of REMOVE_METHODS) {
                const remove = llm[removeMethod]
                if (typeof remove === 'function') {
                  try {
                    ;(remove as (name: string) => void).call(llm, spec.routeName)
                  } catch {
                    // 卸载期尽力而为。
                  }
                  return
                }
              }
            }
      return { registered: true, reason: `llm.${method}`, profile, yaml, dispose }
    } catch (error) {
      log.warn(`llm.${method}() 注册失败：${(error as Error).message}，尝试下一个入口`)
    }
  }

  const reason = `llm 服务未暴露可用的路由注册方法（已尝试 ${REGISTER_METHODS.join(' / ')}）`
  log.warn(`${reason}。本地端点仍可用，请手动把下面的路由配置写入 $DSH_HOME/settings.yaml：\n${yaml}`)
  return { registered: false, reason, profile, yaml, dispose: () => undefined }
}
