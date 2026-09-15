import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { LocalModelConfig } from './config.js'
import { defaultConfig, resolveConfig, type ResolvedConfig } from './configResolve.js'

/**
 * Web 界面可写字段的类型表。
 *
 * 这份表是「写入闸门」：来自浏览器的 JSON 只按这里的类型做强制转换，
 * 表里没有的键一律丢弃。它同时是唯一需要跟着 LocalModelConfig 维护的地方 ——
 * 字段在 schema 里加了却忘了加进来，只会表现为「这项在界面里改不了」，
 * 不会变成一条能塞进子进程参数的脏数据。
 */
const FIELD_TYPES: Record<keyof LocalModelConfig, 'number' | 'boolean' | 'string' | 'dict'> = {
  enabled: 'boolean',
  modelsDir: 'string',
  runtimeDir: 'string',
  llamaServerPath: 'string',
  selectedModel: 'string',
  mmprojFile: 'string',
  mtp: 'boolean',
  preload: 'boolean',
  host: 'string',
  port: 'number',
  llamaPort: 'number',
  ctxSize: 'number',
  gpuLayers: 'number',
  gpuLayersMode: 'string',
  threads: 'number',
  threadsBatch: 'number',
  batchSize: 'number',
  ubatchSize: 'number',
  flashAttention: 'string',
  cacheTypeK: 'string',
  cacheTypeV: 'string',
  jinja: 'boolean',
  chatTemplate: 'string',
  enableThinking: 'boolean',
  preserveThinking: 'boolean',
  mmap: 'boolean',
  mlock: 'boolean',
  apiKey: 'string',
  extraArgs: 'string',
  envOverrides: 'dict',
  idleUnloadMinutes: 'number',
  startupTimeoutMs: 'number',
  shutdownGraceMs: 'number',
  autoRestart: 'boolean',
  maxRestarts: 'number',
  routeName: 'string',
  modelAlias: 'string',
  routeModelId: 'string',
  contextWindow: 'number',
  maxTokens: 'number',
  registerRoute: 'boolean',
  exposeTool: 'boolean',
  allowModelControl: 'boolean',
  logLevel: 'string',
}

export const EDITABLE_KEYS = Object.keys(FIELD_TYPES) as (keyof LocalModelConfig)[]

interface UserConfigFile {
  version: number
  updatedAt: string
  values: Partial<LocalModelConfig>
}

const FILE_VERSION = 1

/**
 * 用户层配置。
 *
 * dsh 自身的设置解析是三层的（schema 默认值 → 组合层注册值 → 用户覆盖值），
 * 这里沿用同样的语义，但把用户层落在插件自己的目录里：
 *
 *   schema 默认值  →  组合层（cordis.patch.yml / 部署配置）  →  <stateDir>/config.json（本文件）
 *
 * 为什么不用 dsh 的 settings 命名空间：当前 dsh 版本的 settings apiproxy 只服务
 * 硬编码的命名空间白名单，第三方插件的命名空间一律答复 settings-not-exposed，
 * 浏览器侧读不到也写不进。自建一层同源 HTTP 桥（见 webBridge.ts）是这一版宿主上
 * 唯一可靠的路径，也让这些设置不依赖宿主内部接口的变动。
 */
export class ConfigStore {
  private values: Partial<LocalModelConfig> = {}

  constructor(
    private readonly file: string,
    private readonly base: Partial<LocalModelConfig>,
  ) {}

  get filePath(): string {
    return this.file
  }

  /** 读取用户层；文件缺失或损坏都退回空值，绝不因此让插件起不来。 */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<UserConfigFile>
      this.values = sanitize(parsed?.values)
    } catch {
      this.values = {}
    }
  }

  get userValues(): Partial<LocalModelConfig> {
    return { ...this.values }
  }

  /** 合并三层，得到运行时配置。 */
  resolve(): ResolvedConfig {
    return resolveConfig({ ...this.base, ...this.values })
  }

  /** 写入一批字段；只接受白名单内的键，其余静默丢弃。 */
  async update(patch: Record<string, unknown>): Promise<ResolvedConfig> {
    const clean = sanitize(patch)
    this.values = { ...this.values, ...clean }
    await this.persist()
    return this.resolve()
  }

  /** 清空用户层，回到组合层 + schema 默认值。 */
  async reset(): Promise<ResolvedConfig> {
    this.values = {}
    await rm(this.file, { force: true })
    return this.resolve()
  }

  /** 哪些字段被用户改过（界面用来显示「已覆盖 · 恢复默认」）。 */
  overriddenKeys(): string[] {
    return Object.keys(this.values)
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true })
    const payload: UserConfigFile = {
      version: FILE_VERSION,
      updatedAt: new Date().toISOString(),
      values: this.values,
    }
    await writeFile(this.file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  }
}

/** 按类型表强制转换；无法转换的键直接丢掉，而不是留下半个值。 */
export function sanitize(input: unknown): Partial<LocalModelConfig> {
  if (typeof input !== 'object' || input === null) return {}
  const out: Record<string, unknown> = {}

  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const type = FIELD_TYPES[key as keyof LocalModelConfig]
    if (!type) continue
    if (raw === null || raw === undefined) continue

    switch (type) {
      case 'number': {
        const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw))
        if (!Number.isFinite(n)) continue
        out[key] = n
        break
      }
      case 'boolean':
        out[key] = raw === true || raw === 'true' || raw === 1 || raw === '1'
        break
      case 'string': {
        // 表单里的空输入就是空串，不能当「未设置」丢掉 —— 那会让用户清不掉一项。
        out[key] = typeof raw === 'string' ? raw : String(raw)
        break
      }
      case 'dict': {
        if (typeof raw !== 'object' || Array.isArray(raw)) continue
        const entries = Object.entries(raw as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'string')
          .map(([k, v]) => [k, v as string])
        out[key] = Object.fromEntries(entries)
        break
      }
    }
  }
  return out as Partial<LocalModelConfig>
}

export function editableKeySet(): Set<string> {
  return new Set(EDITABLE_KEYS as string[])
}

/** 供表单渲染使用：字段 → 类型 / 默认值 / 是否可写。 */
export function fieldTypeMap(): Record<string, string> {
  return { ...FIELD_TYPES }
}

export function defaultsForForm(): LocalModelConfig {
  return defaultConfig()
}
