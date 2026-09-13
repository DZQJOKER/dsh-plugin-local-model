import path from 'node:path'
import { access, readdir, stat } from 'node:fs/promises'
import { constants as FS } from 'node:fs'
import { expandVars, dshHome } from '../paths.js'

export type LlamaServerSource = 'config' | 'runtime-dir' | 'path-env'

export interface LlamaServerLocation {
  path: string
  source: LlamaServerSource
}

export function llamaBinaryNames(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') return ['llama-server.exe', 'llama-server']
  return ['llama-server']
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    const info = await stat(file)
    if (!info.isFile()) return false
    await access(file, process.platform === 'win32' ? FS.F_OK : FS.F_OK | FS.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 定位 llama-server。查找顺序（先精确后模糊）：
 *   1. 设置里显式填写的路径（填目录也接受，会自动补可执行文件名）
 *   2. runtimeDir 根目录
 *   3. runtimeDir/bin
 *   4. runtimeDir 下一层子目录（官方 release 解压出来就是 llama-bXXXX-bin-<平台>-<后端>/）
 *   5. 进程 PATH
 */
export async function locateLlamaServer(opts: {
  explicit?: string
  runtimeDir: string
  env?: NodeJS.ProcessEnv
}): Promise<LlamaServerLocation | null> {
  const env = opts.env ?? process.env
  const names = llamaBinaryNames()

  const explicit = (opts.explicit ?? '').trim()
  if (explicit) {
    const resolved = expandVars(explicit, env, dshHome(env))
    const candidates = path.extname(resolved).toLowerCase() === '.exe' ? [resolved] : [resolved, ...names.map((n) => path.join(resolved, n))]
    for (const candidate of candidates) {
      if (await isExecutableFile(candidate)) return { path: candidate, source: 'config' }
    }
  }

  const roots = [opts.runtimeDir, path.join(opts.runtimeDir, 'bin')]
  for (const root of roots) {
    for (const name of names) {
      const candidate = path.join(root, name)
      if (await isExecutableFile(candidate)) return { path: candidate, source: 'runtime-dir' }
    }
  }

  // 官方 release 包会解压成一层子目录，这里向下找一层；再深就不找了，避免扫全盘。
  try {
    const entries = await readdir(opts.runtimeDir, { withFileTypes: true })
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
      .map((e) => path.join(opts.runtimeDir, e.name))
      .sort()
      .reverse()
    for (const dir of dirs) {
      for (const name of names) {
        const candidate = path.join(dir, name)
        if (await isExecutableFile(candidate)) return { path: candidate, source: 'runtime-dir' }
      }
      for (const nested of ['bin', 'build/bin'].map((s) => path.join(dir, s))) {
        for (const name of names) {
          const candidate = path.join(nested, name)
          if (await isExecutableFile(candidate)) return { path: candidate, source: 'runtime-dir' }
        }
      }
    }
  } catch {
    // runtimeDir 不存在时直接跳过，交给调用方给出可操作的提示。
  }

  const pathEnv = env.PATH ?? env.Path ?? ''
  for (const segment of pathEnv.split(path.delimiter)) {
    if (!segment.trim()) continue
    for (const name of names) {
      const candidate = path.join(segment.trim(), name)
      if (await isExecutableFile(candidate)) return { path: candidate, source: 'path-env' }
    }
  }

  return null
}

/** 供错误信息使用：告诉用户到底在哪里找过了。 */
export function describeSearchScope(opts: { explicit?: string; runtimeDir: string }): string {
  const lines = [`  1. 设置里的「llama-server 路径」：${(opts.explicit ?? '').trim() || '(未填写)'}`]
  lines.push(`  2. 运行时目录：${opts.runtimeDir}`)
  lines.push(`     （含 ${path.join(opts.runtimeDir, 'bin')} 与下一层子目录）`)
  lines.push('  3. 系统 PATH')
  return lines.join('\n')
}
