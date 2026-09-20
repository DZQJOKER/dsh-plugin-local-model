#!/usr/bin/env node
/**
 * 拿本机的 llama-server 做一次「参数验收」。
 *
 *   node scripts/verify-llama.mjs
 *   node scripts/verify-llama.mjs --exe="D:/path/to/llama-server.exe"
 *   node scripts/verify-llama.mjs --model="D:/path/to/model.gguf"
 *
 * 回答的问题是：**我这份 llama.cpp 会不会接受插件下发的参数？**
 * 它会读你的实际配置，按插件的方式拼参数，然后真的把 llama-server 起一次 ——
 * 但把 -m 换成一个不存在的路径，因此不会真的去加载模型（参数解析发生在加载之前）：
 *   - 如果参数有问题 → 立刻报参数错误（比如 unknown value for --flash-attn），本脚本判为失败；
 *   - 如果参数没问题 → 报的是「模型文件读不到」，说明参数被接受了，判为通过。
 *
 * 这样既拿到了确定性结论，又不用为了一次检查去占满显存。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { probeCapabilities, unknownFlags } from '../lib/llama/capabilities.js'
import { buildLlamaServerArgs, renderCommandLine, redactArgs, normalizeFlashAttn } from '../lib/llama/args.js'
import { buildArgInput } from '../lib/lifecycle.js'
import { locateLlamaServer } from '../lib/llama/detect.js'
import { ConfigStore } from '../lib/configStore.js'
import { resolveConfig } from '../lib/configResolve.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')

const args = process.argv.slice(2)
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

const SENTINEL_MODEL = path.join(os.tmpdir(), '__local_model_arg_probe__.gguf')

const ARG_ERROR_PATTERNS = [
  // 分支构建（如 kvmem 那个独立 server）对不认识的选项是 `unknown flag: --alias` + usage + exit 1。
  // 少了这一条，这类「参数被拒」会被下面的判断漏成「没有出现参数错误」—— 本脚本也就白跑了。
  /unknown flag/i,
  /error while handling argument/i,
  /unknown (value|argument)/i,
  /unrecognized argument/i,
  /invalid argument/i,
  // 取值范围/形态错误也是参数问题：实测 kvmem 会对 -1 的 --seed 报
  // `invalid --seed: seed out of range [0.000000, 4294967295.000000]` 并退出。
  /invalid --[A-Za-z0-9-]+:/i,
  /to show complete usage/i,
]

async function main() {
  const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const bootstrap = resolveConfig({}, process.env)
  const store = new ConfigStore(bootstrap.paths.configFile, {})
  await store.load()
  const resolved = store.resolve()

  console.log('llama-server 参数验收')
  console.log(`  DSH_HOME：${dshHome}`)
  console.log(`  配置文件：${store.filePath}（${store.overriddenKeys().length} 项用户覆盖）`)

  const explicit = flag('exe') ?? resolved.llamaServerPath
  const runtimeDir = flag('runtimeDir') ?? resolved.runtimeDir
  const located = await locateLlamaServer({ explicit, runtimeDir })
  if (!located) {
    console.error('\n✗ 找不到 llama-server。用 --exe=<路径> 指定，或把它放进运行时目录。')
    process.exit(1)
  }
  console.log(`  可执行文件：${located.path}（来源 ${located.source}）`)

  const capabilities = await probeCapabilities(located.path)
  if (!capabilities.ok) {
    console.error(`\n✗ 无法探测该构建：${capabilities.detail}`)
    process.exit(1)
  }
  console.log(`  构建能力：${capabilities.detail}`)

  const model = flag('model') ?? path.join(resolved.modelsDir, resolved.selectedModel || '')
  const flashSetting = normalizeFlashAttn(resolved.flashAttention)

  // 复用生命周期层的 buildArgInput，而不是在这里再抄一份参数字面量。
  // 这个脚本的全部价值就是「插件实际会下发什么」，抄一份就会随着加参数而悄悄过期
  // （症状是最新加的开关永远不被验收）。
  const built = buildLlamaServerArgs(
    buildArgInput(
      resolved,
      // 只为凑出 --mmproj 与 -m：哨兵路径保证不会真的加载模型。
      { path: SENTINEL_MODEL, mmproj: null },
      {
        port: resolved.port + 1,
        flashAttnMode: capabilities.flashAttnMode,
        gpuLayersSupport: capabilities.gpuLayers,
        knownFlags: capabilities.flags,
      },
    ),
  )

  console.log(`\n  配置里的模型：${model || '(尚未选择)'}`)
  console.log(`  Flash Attention 设置：${flashSetting}（构建形状 ${capabilities.flashAttnMode}）`)
  console.log(`  将要下发的参数：\n    ${renderCommandLine(located.path, redactArgs(built.args))}`)

  for (const notice of built.notices) console.log(`  ! ${notice}`)

  const unknown = unknownFlags(built.usedFlags, capabilities.flags)
  if (unknown.length > 0) {
    console.log(`\n  ! 这个构建不认识以下选项：${unknown.join('、')}（加载可能失败）`)
  } else {
    console.log('  ✓ 下发的选项这个构建全都认识')
  }

  // 真正起一次：模型换成哨兵路径，因此只会走到「读不到模型」这一步。
  const probe = spawnSync(located.path, built.args, { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`

  const argErrors = ARG_ERROR_PATTERNS.filter((re) => re.test(output)).map((re) => re.source)
  const looksLikeModelError = /failed to load model|unable to load model|no such file|model file|Failed to open|read model/i.test(output)

  console.log('\n  实测输出（截取）：')
  for (const line of output.split(/\r?\n/).filter(Boolean).slice(0, 8)) console.log(`    ${line}`)

  if (argErrors.length > 0) {
    console.log('\n✗ 参数被拒绝了。相关判据：' + argErrors.join(' / '))
    console.log('  处理：把「设置 → 本地模型 → 附加参数」留空后重试；仍不行就把上面的参数贴回给我。')
    process.exit(1)
  }

  console.log(
    looksLikeModelError
      ? '\n✓ 参数被接受（失败点已经走到读模型这一步，说明参数解析全部通过）'
      : '\n✓ 没有出现参数错误',
  )
  console.log('  结论：插件下发的参数与这份 llama.cpp 兼容。')
}

main().catch((error) => {
  console.error(`\n✗ 验收失败：${error.stack ?? error.message}`)
  process.exit(1)
})
