import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'

import type { Log } from './log.js'
import type { LocalModelRuntime } from './lifecycle.js'
import type { ConfigStore } from './configStore.js'
import type { FormDescriptor } from './schemaForm.js'
import { formatBytes } from './registry.js'
import {
  PRESET_EXCLUDED_KEYS,
  presetKeys,
  snapshotPresetValues,
  type Preset,
  type PresetStore,
} from './presets.js'

/** 同源路由前缀。浏览器侧直接 fetch 相对路径，不跨端口、不需要 CORS。 */
export const BRIDGE_PREFIX = '/api/local-model'

/** 宿主 webServer 服务里我们用到的那一小部分。 */
export interface WebServerLike {
  readonly port?: number
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => unknown
  }): () => void
}

export interface WebBridgeOptions {
  runtime: LocalModelRuntime
  store: ConfigStore
  /** 参数预设的落盘仓库（与 config.json 同目录）。 */
  presets: PresetStore
  /** 每次配置变化后重建（分组顺序跟着 schema 走）。 */
  form: () => FormDescriptor
  pluginVersion: string
  log: Log
}

const MAX_BODY_BYTES = 256 * 1024

/**
 * 把插件的状态与配置暴露给浏览器半侧。
 *
 * 为什么走自建路由而不是 dsh 的 settings 命名空间：当前 dsh 版本的 settings apiproxy
 * 只服务硬编码的命名空间白名单，第三方插件的命名空间一律答复 settings-not-exposed，
 * 浏览器侧既读不到也写不进。同源 HTTP 是这一版宿主上唯一可靠的通道，也让设置页
 * 不依赖宿主内部接口的变动。
 *
 * 安全姿态（本机工具，无账号体系，因此靠三条硬约束而不是鉴权）：
 *   1. 只接受回环来源的请求 —— 配置变更与进程启停不该被局域网里的谁触发；
 *   2. 写操作要求 `content-type: application/json` —— 普通表单跨站提交做不到这一点，
 *      于是即便有一个恶意页面在浏览器里跑，也发不出能改配置的请求；
 *   3. 全部请求体有大小上限。
 */
export function registerWebBridge(ctx: Context, options: WebBridgeOptions): () => void {
  const server = ctx.get<WebServerLike>('webServer')
  if (!server || typeof server.register !== 'function') {
    options.log.warn('宿主未提供 webServer 服务，设置页的「本地模型」配置面板将不可用（其余功能不受影响）')
    return () => undefined
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void handle(req, res, options).catch((error) => {
      options.log.error(`设置桥接处理失败：${(error as Error).message}`)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: (error as Error).message })
      else res.end()
    })
  }

  try {
    const dispose = server.register({ kind: 'prefix', path: BRIDGE_PREFIX, handler })
    const port = server.port
    options.log.info(
      `设置面板已挂载：同源前缀 ${BRIDGE_PREFIX}（随 dsh web 服务器${port ? ` :${port}` : ''}）`,
    )
    return dispose
  } catch (error) {
    options.log.warn(`挂载设置桥接失败：${(error as Error).message}`)
    return () => undefined
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, options: WebBridgeOptions): Promise<void> {
  const { runtime, store, presets, log } = options

  if (!isLoopback(req)) {
    sendJson(res, 403, { ok: false, error: '本地模型插件只接受来自本机的请求' })
    return
  }

  const url = new URL(req.url ?? '/', 'http://localhost')
  const route = url.pathname.slice(BRIDGE_PREFIX.length).replace(/\/+$/, '') || '/'

  if (req.method === 'GET' && route === '/state') {
    await runtime.refreshModels()
    sendJson(res, 200, buildState(options))
    return
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: `不支持的方法：${req.method}` })
    return
  }

  if (!isJsonContentType(req)) {
    sendJson(res, 415, { ok: false, error: '写操作要求 content-type: application/json' })
    return
  }

  const body = await readJson(req)

  switch (route) {
    case '/config': {
      const patch = (body as { values?: unknown })?.values ?? body
      const next = await store.update(patch as Record<string, unknown>)
      await runtime.applyConfig(next, { reload: true })
      log.info(`设置已更新（${Object.keys(patch as object).length} 项），已按新配置重新加载`)
      sendJson(res, 200, buildState(options))
      return
    }
    case '/reset': {
      const next = await store.reset()
      await runtime.applyConfig(next, { reload: true })
      log.info('设置已恢复为部署默认值，并已重新加载')
      sendJson(res, 200, buildState(options))
      return
    }
    case '/action': {
      const action = String((body as { action?: unknown })?.action ?? '')
      const message = await runAction(runtime, action)
      sendJson(res, 200, { ...buildState(options), message })
      return
    }
    /*
     * ── 参数预设 ────────────────────────────────────────────────────────────
     * 五个动作都走同一条配置落盘路径（store.update + applyConfig），
     * 与「保存设置」完全一致 —— 于是行为、提示、卸载时机都不会两套逻辑漂移。
     * 「应用预设」本身不额外做别的：预设里没有的字段（端口/路径/密钥等）保持原样。
     */
    case '/presets/save': {
      const request = body as { name?: unknown; values?: unknown }
      // 界面会把「当前看到的参数（含未保存的修改）」一起送过来；没送就从生效配置里摘快照。
      const source = request.values === undefined ? snapshotPresetValues(runtime.config) : request.values
      const preset = await presets.create(request.name, source)
      log.info(`已保存参数预设「${preset.name}」（${presetFieldCount(preset)} 项）`)
      sendJson(res, 200, { ...buildState(options), message: `已保存预设「${preset.name}」（${presetFieldCount(preset)} 项参数）` })
      return
    }
    case '/presets/apply': {
      const preset = requirePreset(presets, (body as { id?: unknown })?.id)
      const next = await store.update(preset.values)
      await runtime.applyConfig(next, { reload: true })
      log.info(`已应用参数预设「${preset.name}」，模型已按新参数卸载`)
      sendJson(res, 200, {
        ...buildState(options),
        appliedId: preset.id,
        message: `已应用预设「${preset.name}」；模型已卸载，下次对话按新参数加载`,
      })
      return
    }
    case '/presets/overwrite': {
      const request = body as { id?: unknown; values?: unknown }
      const target = requirePreset(presets, request.id)
      const source = request.values === undefined ? snapshotPresetValues(runtime.config) : request.values
      const preset = await presets.overwrite(target.id, source)
      log.info(`参数预设「${preset.name}」已用当前参数更新（${presetFieldCount(preset)} 项）`)
      sendJson(res, 200, {
        ...buildState(options),
        message: `已用当前参数更新预设「${preset.name}」（${presetFieldCount(preset)} 项）`,
      })
      return
    }
    case '/presets/rename': {
      const request = body as { id?: unknown; name?: unknown }
      const target = requirePreset(presets, request.id)
      const preset = await presets.rename(target.id, request.name)
      log.info(`参数预设已重命名为「${preset.name}」`)
      sendJson(res, 200, { ...buildState(options), message: `预设已重命名为「${preset.name}」` })
      return
    }
    case '/presets/delete': {
      const target = requirePreset(presets, (body as { id?: unknown })?.id)
      const preset = await presets.remove(target.id)
      log.info(`已删除参数预设「${preset.name}」`)
      sendJson(res, 200, { ...buildState(options), message: `已删除预设「${preset.name}」` })
      return
    }
    default:
      sendJson(res, 404, { ok: false, error: `未知路径：${route}` })
  }
}

function presetFieldCount(preset: Preset): number {
  return Object.keys(preset.values).length
}

function requirePreset(presets: PresetStore, id: unknown): Preset {
  const preset = presets.find(id)
  if (!preset) throw new Error('找不到这个预设，可能已被删除，请刷新后再试')
  return preset
}

async function runAction(runtime: LocalModelRuntime, action: string): Promise<string> {
  switch (action) {
    case 'scan': {
      const models = await runtime.refreshModels(true)
      return `已重新扫描，发现 ${models.length} 个模型`
    }
    case 'start':
      await runtime.ensureReady()
      return '模型已加载'
    case 'stop':
      await runtime.unload('用户在设置页手动卸载')
      return '模型已卸载，显存与内存已释放'
    case 'reload':
      await runtime.reload('用户在设置页手动重新加载')
      return '已按最新设置重新加载'
    default:
      throw new Error(`未知操作：${action}（可用：scan / start / stop / reload）`)
  }
}

export function buildState(options: WebBridgeOptions): Record<string, unknown> {
  const { runtime, store, presets } = options
  const status = runtime.status()
  const models = runtime.listModels()
  const current = runtime.config as unknown as Record<string, unknown>

  return {
    ok: true,
    plugin: { name: 'dsh-plugin-local-model', version: options.pluginVersion },
    form: options.form(),
    config: runtime.config,
    configFile: store.filePath,
    overridden: store.overriddenKeys(),
    /*
     * 参数预设。只送元信息（名字 / 项数 / 与当前配置的差异），不送 values ——
     * 界面只需要渲染与切换，把整份参数来回搬没有意义。
     */
    presets: {
      items: presets.list().map((preset) => ({
        id: preset.id,
        name: preset.name,
        createdAt: preset.createdAt,
        updatedAt: preset.updatedAt,
        fieldCount: Object.keys(preset.values).length,
        /** 与当前生效配置有几项不同 —— 界面直接显示「N 项不同」，不必自己算。 */
        changed: presets.diffCount(preset.values, current),
      })),
      /** 与当前生效配置完全一致的那一个（没有则为 null），界面用它高亮。 */
      activeId: presets.activeId(current),
      /** 参与预设的字段，以及被排除的环境字段（界面的说明文案用）。 */
      keys: presetKeys(),
      excluded: [...PRESET_EXCLUDED_KEYS],
      file: presets.filePath,
      warning: presets.loadWarning,
    },
    models: models.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      quant: m.quant,
      params: m.params,
      sizeBytes: m.sizeBytes,
      sizeText: formatBytes(m.sizeBytes),
      complete: m.complete,
      missing: m.missing,
      hasVisionProjector: m.mmproj !== null,
    })),
    /** 视觉投影文件下拉框的数据源：模型目录里扫到的全部 mmproj。 */
    visionFiles: runtime.listVisionProjectors().map((p) => ({
      id: p.rel,
      sizeBytes: p.size,
      sizeText: formatBytes(p.size),
      absolute: p.abs,
    })),
    runtime: {
      state: status.state,
      stateLabel: status.stateLabel,
      model: status.model,
      endpoint: status.endpoint,
      upstream: status.upstream,
      pid: status.pid,
      loadedAt: status.loadedAt,
      lastActivityAt: status.lastActivityAt,
      unloadAt: status.unloadAt,
      unloadInMs: status.unloadInMs,
      unloadBlockedBy: status.unloadBlockedBy,
      lastTickAt: status.lastTickAt,
      idleUnloadMinutes: status.idleUnloadMinutes,
      activeRequests: status.activeRequests,
      restarts: status.restarts,
      lastError: status.lastError,
      modelsFound: status.modelsFound,
      visionProjector: status.visionProjector,
      mtp: status.mtp,
      visionDisabledByMtp: status.visionDisabledByMtp,
      reasoningEfforts: status.reasoningEfforts,
    },
  }
}

// ── HTTP 小工具 ───────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? ''
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost'
}

function isJsonContentType(req: IncomingMessage): boolean {
  const raw = req.headers['content-type'] ?? ''
  return raw.toLowerCase().includes('application/json')
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}
