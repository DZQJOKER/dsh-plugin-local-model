import type { Context } from '@deepseek-ai/cordis'
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

export function buildRouteSpec(config: ResolvedConfig, baseURL: string): RouteSpec {
  return {
    routeName: config.routeName,
    displayName: '本地模型（llama.cpp）',
    baseURL,
    modelId: config.routeModelId,
    modelName: `本地模型 · ${config.modelAlias}`,
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    apiKeyEnv: config.apiKey ? 'DSH_LOCAL_MODEL_API_KEY' : '',
    apiKey: config.apiKey,
    streamIdleTimeoutMs: 600_000,
  }
}

/** 生成 pi-ai 路由 profile（对应 settings.yaml 里 llm-pi-ai.providers.<route>）。 */
export function buildRouteProfile(spec: RouteSpec): Record<string, unknown> {
  const profile: Record<string, unknown> = {
    displayName: spec.displayName,
    api: 'openai-completions',
    baseURL: spec.baseURL,
    streamIdleTimeoutMs: spec.streamIdleTimeoutMs,
    models: [
      {
        id: spec.modelId,
        name: spec.modelName,
        contextWindow: spec.contextWindow,
        maxTokens: spec.maxTokens,
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
  ]
  if (spec.apiKeyEnv) lines.push(`      apiKeyEnv: ${spec.apiKeyEnv}`)
  lines.push('      models:')
  lines.push(`        - id: ${spec.modelId}`)
  lines.push(`          name: ${spec.modelName}`)
  lines.push(`          contextWindow: ${spec.contextWindow}`)
  lines.push(`          maxTokens: ${spec.maxTokens}`)
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
