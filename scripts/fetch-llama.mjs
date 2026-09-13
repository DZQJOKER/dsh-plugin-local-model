#!/usr/bin/env node
/**
 * 一键把 llama.cpp 的 llama-server 下载到插件规定的运行时目录。
 *
 *   node scripts/fetch-llama.mjs
 *   node scripts/fetch-llama.mjs --variant=cuda
 *   node scripts/fetch-llama.mjs --dir=D:\ai\llama-runtime
 *   node scripts/fetch-llama.mjs --tag=b6040
 *   node scripts/fetch-llama.mjs --dry-run          # 只打印会下载哪个包
 *
 * 说明：这一步是「帮用户省事」，不是插件的必要条件。你也可以完全手动去
 * https://github.com/ggml-org/llama.cpp/releases 下载压缩包，解压到运行时目录即可，
 * 插件会自动识别（含一层子目录）。
 */
import path from 'node:path'
import { mkdir, rm, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { dshHome } from '../lib/paths.js'

const execFileAsync = promisify(execFile)

const REPO = 'ggml-org/llama.cpp'
const API = `https://api.github.com/repos/${REPO}/releases`

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

function fail(message, hint) {
  console.error(`\n✗ ${message}`)
  if (hint) console.error(`\n${hint}`)
  process.exit(1)
}

/** 平台 → 候选包名前缀（按优先级）。 */
async function candidatePatterns(variant) {
  const platform = process.platform
  const arch = process.arch

  if (platform === 'win32') {
    const map = {
      cuda: ['win-cuda'],
      vulkan: ['win-vulkan'],
      hip: ['win-hip'],
      cpu: ['win-cpu', 'win-noavx'],
    }
    if (variant === 'auto') {
      const hasNvidia = await commandExists('nvidia-smi')
      return hasNvidia ? [...map.cuda, ...map.vulkan, ...map.cpu] : [...map.cpu, ...map.vulkan]
    }
    return map[variant] ?? map.cpu
  }

  if (platform === 'darwin') {
    return arch === 'arm64' ? ['macos-arm64'] : ['macos-x64']
  }

  if (platform === 'linux') {
    const map = { vulkan: ['ubuntu-vulkan'], cuda: ['ubuntu-cuda'], cpu: ['ubuntu-x64', 'ubuntu-arm64'] }
    if (variant === 'auto') return [...map.vulkan, ...map.cpu]
    return map[variant] ?? map.cpu
  }

  fail(`暂不支持在 ${platform} 上自动下载，请手动到 https://github.com/${REPO}/releases 下载。`)
  return []
}

async function commandExists(command) {
  try {
    await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [command])
    return true
  } catch {
    return false
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-plugin-local-model' } })
  if (res.status === 403) {
    fail('GitHub API 触发了限流（403）。', '稍后重试，或直接手动下载：https://github.com/' + REPO + '/releases')
  }
  if (!res.ok) fail(`拉取 release 信息失败：HTTP ${res.status}`)
  return res.json()
}

async function pickAsset(tag, patterns) {
  const release = tag
    ? await fetchJson(`${API}/tags/${encodeURIComponent(tag)}`)
    : await fetchJson(`${API}/latest`)

  const assets = (release.assets ?? []).filter((a) => /\.(zip|tar\.gz)$/i.test(a.name ?? ''))
  if (assets.length === 0) {
    fail(
      `release ${release.tag_name} 没有附带二进制包（可能只发布了源码）。`,
      `用 --tag=bXXXX 指定一个带二进制的版本，或手动下载：\n  https://github.com/${REPO}/releases`,
    )
  }

  const archToken = process.arch === 'arm64' ? 'arm64' : 'x64'
  for (const pattern of patterns) {
    const hit =
      assets.find((a) => a.name.includes(pattern) && a.name.includes(archToken)) ??
      assets.find((a) => a.name.includes(pattern))
    if (hit) return { release, asset: hit, pattern }
  }

  const available = assets.map((a) => `  - ${a.name}`).join('\n')
  fail(
    `在 release ${release.tag_name} 里没找到匹配 ${patterns.join(' / ')} 的包。`,
    `该 release 包含：\n${available}\n\n用 --variant= 指定其它后端，或 --tag= 指定其它版本。`,
  )
}

async function download(url, dest, label) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) fail(`下载失败：HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  let lastPrint = 0

  const source = Readable.fromWeb(res.body)
  source.on('data', (chunk) => {
    received += chunk.length
    const now = Date.now()
    if (now - lastPrint < 400) return
    lastPrint = now
    const pct = total ? ` ${((received / total) * 100).toFixed(0)}%` : ''
    const mb = (received / 1024 / 1024).toFixed(1)
    process.stdout.write(`\r  下载 ${label}：${mb} MB${pct}    `)
  })

  await pipeline(source, createWriteStream(dest))
  process.stdout.write('\n')
}

async function extract(archive, outDir) {
  const isZip = /\.zip$/i.test(archive)
  if (process.platform === 'win32' && isZip) {
    // 优先用 tar（Win10 1803+ 自带 bsdtar，能解 zip），避免 PowerShell 的执行策略问题。
    try {
      await execFileAsync('tar', ['-xf', archive, '-C', outDir])
      return
    } catch {
      await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -Force`,
      ])
      return
    }
  }
  if (isZip) {
    try {
      await execFileAsync('unzip', ['-oq', archive, '-d', outDir])
      return
    } catch {
      // 没有 unzip 时退回 tar。
    }
  }
  await execFileAsync('tar', ['-xf', archive, '-C', outDir])
}

async function main() {
  const variant = flag('variant', 'auto')
  const tag = flag('tag', process.env.LLAMA_TAG ?? '')
  const runtimeDir = path.resolve(flag('dir', path.join(dshHome(), 'local-model', 'runtime')))

  console.log('DeepSeek Harness 本地模型插件 —— llama.cpp 运行时下载')
  console.log(`  平台：${process.platform}-${process.arch}`)
  console.log(`  后端：${variant}`)
  console.log(`  目标目录：${runtimeDir}`)
  console.log(`  版本：${tag || 'latest'}\n`)

  const patterns = await candidatePatterns(variant)
  const { release, asset } = await pickAsset(tag, patterns)
  console.log(`  选中：${asset.name}  （release ${release.tag_name}）`)

  if (dryRun) {
    console.log(`\n--dry-run：仅预览，不下载。\n  ${asset.browser_download_url}`)
    return
  }

  const archive = path.join(runtimeDir, asset.name)
  await mkdir(runtimeDir, { recursive: true })
  await download(asset.browser_download_url, archive, asset.name)

  console.log('  解压中…')
  await extract(archive, runtimeDir)
  await rm(archive, { force: true })

  const candidates = process.platform === 'win32' ? ['llama-server.exe'] : ['llama-server']
  let found = null
  for (const name of candidates) {
    for (const candidate of [path.join(runtimeDir, name), ...(await listSubdirs(runtimeDir)).map((d) => path.join(d, name))]) {
      try {
        const info = await stat(candidate)
        if (info.isFile()) {
          found = candidate
          break
        }
      } catch {
        // 继续找。
      }
    }
    if (found) break
  }

  if (!found) {
    console.log(`\n⚠ 解压完成，但没有在 ${runtimeDir} 下找到 llama-server，请检查压缩包内容。`)
    return
  }

  console.log(`\n✓ 就绪：${found}`)
  console.log('\n下一步：')
  console.log('  1. 把 GGUF 模型放进模型目录：' + path.join(dshHome(), 'local-model', 'models'))
  console.log('  2. 打开 Harness → 设置 → 本地模型，点「重新扫描」并在模型下拉框里选择')
  console.log('  3. 发起第一条对话，模型会自动加载；连续 5 分钟无交互会自动卸载')
}

async function listSubdirs(dir) {
  const { readdir } = await import('node:fs/promises')
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name))
  } catch {
    return []
  }
}

main().catch((error) => fail(error.stack ?? error.message))
