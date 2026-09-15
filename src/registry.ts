import path from 'node:path'
import { readdir, stat } from 'node:fs/promises'

/** 扫描到的一个分片（或单片模型）。 */
export interface ModelShard {
  /** 相对 modelsDir 的路径，统一用 `/` 分隔，作为稳定 id。 */
  rel: string
  abs: string
  size: number
  mtime: number
}

/** 对外暴露的「一个可被选择的模型」。 */
export interface LocalModelEntry {
  /** 选择器里存下来的值：主分片相对路径。 */
  id: string
  /** 展示名：去掉扩展名和量化后缀前的可读名字。 */
  displayName: string
  /** 主分片绝对路径，直接喂给 llama-server -m。 */
  path: string
  shards: string[]
  sizeBytes: number
  modifiedAt: number
  quant: string | null
  params: string | null
  /** 同目录下自动关联的视觉投影文件（可选）。 */
  mmproj: string | null
  /** 分片是否齐全；缺片时不建议载入。 */
  complete: boolean
  missing: string[]
}

/** 分片命名：name-00001-of-00003.gguf */
const SHARD_RE = /^(?<stem>.+?)-(?<idx>\d{5})-of-(?<total>\d{5})\.gguf$/i

/** 量化标识，按「更具体优先」排列。 */
const QUANT_RE = /\b(IQ\d+_[A-Z0-9_]+|Q\d+_K_[A-Z]+|Q\d+_K|Q\d+_\d+|MXFP4|BF16|F16|F32|Q8_0)\b/i

/** 参数量：8B / 1.5B / 27b */
const PARAMS_RE = /(?<![0-9A-Za-z.])(\d+(?:\.\d+)?)\s*[Bb](?![0-9A-Za-z])/

const MAX_DEPTH = 3

export function parseQuant(fileName: string): string | null {
  const m = QUANT_RE.exec(fileName)
  return m ? m[1]!.toUpperCase() : null
}

export function parseParams(fileName: string): string | null {
  const m = PARAMS_RE.exec(fileName)
  return m ? `${m[1]}B` : null
}

export function isMmproj(fileName: string): boolean {
  return /^mmproj/i.test(path.basename(fileName)) || /mmproj/i.test(path.basename(fileName))
}

function isShard(fileName: string): boolean {
  return /\.gguf$/i.test(fileName) && !isMmproj(fileName)
}

function displayNameOf(rel: string): string {
  const base = path.basename(rel).replace(/\.gguf$/i, '')
  return base.replace(/-\d{5}-of-\d{5}$/i, '')
}

/**
 * 把平铺的分片列表归并成模型列表。
 * 纯函数，方便单测：喂进去任意文件集合，都能得到确定结果。
 */
export function groupShards(shards: ModelShard[], mmprojs: ModelShard[] = []): LocalModelEntry[] {
  const singles = new Map<string, ModelShard[]>()
  const groups = new Map<string, { total: number; byIndex: Map<number, ModelShard> }>()

  for (const shard of shards) {
    const base = path.basename(shard.rel)
    const m = SHARD_RE.exec(base)
    if (!m || !m.groups) {
      const key = `single:${shard.rel}`
      const list = singles.get(key) ?? []
      list.push(shard)
      singles.set(key, list)
      continue
    }
    const dir = path.posix.dirname(shard.rel)
    const key = `group:${dir}/${m.groups.stem}`
    const entry = groups.get(key) ?? { total: Number(m.groups.total), byIndex: new Map<number, ModelShard>() }
    entry.total = Number(m.groups.total)
    entry.byIndex.set(Number(m.groups.idx), shard)
    groups.set(key, entry)
  }

  const entries: LocalModelEntry[] = []

  // 先数一下每个目录里有几个「模型主体」——决定 mmproj 能不能靠「唯一性」直接关联。
  const modelsPerDir = new Map<string, number>()
  for (const list of singles.values()) {
    const dir = path.posix.dirname(list[0]!.rel)
    modelsPerDir.set(dir, (modelsPerDir.get(dir) ?? 0) + 1)
  }
  for (const group of groups.values()) {
    const first = [...group.byIndex.values()].sort((a, b) => a.rel.localeCompare(b.rel))[0]!
    const dir = path.posix.dirname(first.rel)
    modelsPerDir.set(dir, (modelsPerDir.get(dir) ?? 0) + 1)
  }

  for (const list of singles.values()) {
    const first = list[0]!
    entries.push(buildEntry([first], mmprojs, modelsPerDir.get(path.posix.dirname(first.rel)) ?? 1))
  }

  for (const group of groups.values()) {
    const list = [...group.byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s)
    const missing: string[] = []
    for (let i = 1; i <= group.total; i++) {
      if (!group.byIndex.has(i)) missing.push(`-${String(i).padStart(5, '0')}-of-${String(group.total).padStart(5, '0')}.gguf`)
    }
    const entry = buildEntry(list, mmprojs, modelsPerDir.get(path.posix.dirname(list[0]!.rel)) ?? 1)
    entry.complete = missing.length === 0 && list.length === group.total
    entry.missing = missing
    entries.push(entry)
  }

  entries.sort((a, b) => {
    if (a.complete !== b.complete) return a.complete ? -1 : 1
    return b.modifiedAt - a.modifiedAt
  })
  return entries
}

function buildEntry(shards: ModelShard[], mmprojs: ModelShard[], modelsInDir: number): LocalModelEntry {
  const first = shards[0]!
  const sizeBytes = shards.reduce((sum, s) => sum + s.size, 0)
  const modifiedAt = shards.reduce((max, s) => Math.max(max, s.mtime), 0)
  return {
    id: first.rel,
    displayName: displayNameOf(first.rel),
    path: first.abs,
    shards: shards.map((s) => s.abs),
    sizeBytes,
    modifiedAt,
    quant: parseQuant(first.rel),
    params: parseParams(first.rel),
    mmproj: matchMmproj(first.rel, mmprojs, modelsInDir),
    complete: true,
    missing: [],
  }
}

/**
 * 视觉投影文件关联策略（宁可漏配，不可错配）：
 * 1. 文件名公共前缀足够长 → 关联（mmproj-Qwen3-8B 配 Qwen3-8B-Q4_K_M）；
 * 2. 该目录下有且只有一个模型、且只有一个 mmproj → 直接关联（社区最常见的扁平布局）；
 * 3. 其余情况不猜 —— 错配一个投影文件会让模型直接加载失败或输出乱码，
 *    比"没识别到、需要用户用 extraArgs 手动指定 --mmproj"糟得多。
 */
function matchMmproj(modelRel: string, mmprojs: ModelShard[], modelsInDir: number): string | null {
  const dir = path.posix.dirname(modelRel)
  const sameDir = mmprojs.filter((m) => path.posix.dirname(m.rel) === dir)
  if (sameDir.length === 0) return null

  const stem = displayNameOf(modelRel).toLowerCase()
  let best: ModelShard | null = null
  let bestScore = 0
  for (const candidate of sameDir) {
    const candidateStem = path.basename(candidate.rel).replace(/\.gguf$/i, '').toLowerCase()
    const score = commonPrefixLength(stem, candidateStem)
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  if (best && bestScore >= MIN_MMPROJ_PREFIX) return best.abs
  if (sameDir.length === 1 && modelsInDir === 1) return sameDir[0]!.abs
  return null
}

const MIN_MMPROJ_PREFIX = 4

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

export function pickModel(entries: LocalModelEntry[], selected: string): LocalModelEntry | null {
  const wanted = (selected ?? '').trim().replace(/\\/g, '/')
  if (!wanted) return null
  const lower = wanted.toLowerCase()
  return (
    entries.find((e) => e.id === wanted) ??
    entries.find((e) => e.id.toLowerCase() === lower) ??
    entries.find((e) => path.posix.basename(e.id).toLowerCase() === lower) ??
    entries.find((e) => e.displayName.toLowerCase() === lower) ??
    null
  )
}

/** 扫描目录（深度 ≤ 3，跳过隐藏目录与 `_` 前缀目录）。 */
export interface ScanResult {
  entries: LocalModelEntry[]
  /** 目录下扫到的全部视觉投影文件（mmproj），供设置页下拉选择。 */
  visionProjectors: ModelShard[]
}

/**
 * 一次遍历同时拿到「模型列表」与「视觉投影文件列表」。
 *
 * 分成两个函数会导致同一份目录被读两遍，而 mmproj 关联本身就需要两者同时在场。
 */
export async function scanModelsDetailed(modelsDir: string): Promise<ScanResult> {
  const shards: ModelShard[] = []
  const mmprojs: ModelShard[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.') || dirent.name.startsWith('_')) continue
      const abs = path.join(dir, dirent.name)
      if (dirent.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(abs, depth + 1)
        continue
      }
      if (!dirent.isFile() || !/\.gguf$/i.test(dirent.name)) continue
      let info
      try {
        info = await stat(abs)
      } catch {
        continue
      }
      const shard: ModelShard = {
        rel: path.posix.join(path.relative(modelsDir, dir).split(path.sep).join('/'), dirent.name),
        abs,
        size: info.size,
        mtime: info.mtimeMs,
      }
      if (isMmproj(dirent.name)) mmprojs.push(shard)
      else if (isShard(dirent.name)) shards.push(shard)
    }
  }

  await walk(modelsDir, 0)
  return {
    entries: groupShards(shards, mmprojs),
    visionProjectors: mmprojs.slice().sort((a, b) => a.rel.localeCompare(b.rel)),
  }
}

export async function scanModels(modelsDir: string): Promise<LocalModelEntry[]> {
  return (await scanModelsDetailed(modelsDir)).entries
}

/**
 * 决定本次加载实际下发的 `--mmproj`。
 *
 * 优先级刻意做成「显式选择 → 同目录自动关联」，这样新增的手动选择项是纯粹的能力增强：
 * 留空时拿到的仍是 `entry.mmproj`，也就是插件原有的行为一字不变，
 * 纯文本模型（目录里本来就没有 mmproj）也依旧不会多出任何参数。
 *
 * 允许填绝对路径，是为了兼容历史上已经用「附加参数」手写过 --mmproj 的场景。
 */
export function resolveVisionProjector(modelsDir: string, selected: string, fallback: string | null): string {
  const wanted = (selected ?? '').trim()
  if (!wanted) return (fallback ?? '').trim()
  if (path.isAbsolute(wanted)) return wanted
  return path.resolve(modelsDir, wanted)
}

/**
 * 本次加载**实际**会下发的 `--mmproj`：在 `resolveVisionProjector` 之上再叠加 MTP 互斥。
 *
 * 界面显示与命令行下发必须走同一个函数，否则会出现「面板上写着启用了视觉投影、
 * 实际命令行里却没有 --mmproj」这种无从排查的错位（本插件在 --flash-attn 上吃过一次同样的亏）。
 * 互斥的**权威**落点仍在 llama/args.ts 的拼参数层，这里只是让显示跟上那个事实。
 */
export function effectiveVisionProjector(options: {
  modelsDir: string
  mmprojFile: string
  autoMmproj: string | null
  mtp: boolean
}): string {
  if (options.mtp) return ''
  return resolveVisionProjector(options.modelsDir, options.mmprojFile, options.autoMmproj)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}
