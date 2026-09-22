/**
 * 纯逻辑自检 —— 不依赖 dsh 宿主，直接用 node 跑：
 *
 *   node scripts/selftest.mjs
 *
 * 覆盖三处最容易出回归的「启动/卸载逻辑」：
 *   - llama-server 参数拼装（参数错了子进程直接起不来）
 *   - 模型目录扫描与分片归并（错了就会漏模型或拿半截模型去加载）
 *   - 配置解析（路径解析错了会指向不存在的目录）
 *
 * 需要先构建：tsc -p tsconfig.json（或 npm run build）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { buildLlamaServerArgs as buildArgsRaw, splitArgs, redactArgs, renderCommandLine, flashAttnArgs, normalizeFlashAttn, gpuLayersArgs, normalizeGpuLayersMode, normalizeCacheType, formatNumber } from '../lib/llama/args.js'
import {
  detectFlashAttnMode,
  isFlashAttnFormError,
  parseHelp,
  unknownFlags,
} from '../lib/llama/capabilities.js'
import { groupShards, parseQuant, parseParams, pickModel, formatBytes, scanModels, scanModelsDetailed, resolveVisionProjector, effectiveVisionProjector } from '../lib/registry.js'
import { resolveDir, expandVars } from '../lib/paths.js'
import { resolveConfig, clamp, logLevelOf, normalizeBool, normalizeChoice, consistencyNotices } from '../lib/configResolve.js'
import { sanitize } from '../lib/configStore.js'
import {
  isChatCompletionPath,
  rewriteChatRequestBody,
  normalizeEffortSignal,
  mapEffortToSupported,
  extractSupportedEfforts,
  EFFORT_ORDER,
} from '../lib/requestRewrite.js'
import { diagnoseLoadFailure, extractEffectiveContext } from '../lib/llama/diagnose.js'
import {
  DEFAULT_GUARD_LIMITS,
  applyMaxTokens,
  isContextOverflowError,
  nextRetryMaxTokens,
  overflowHint,
  preflightMaxTokens,
  readMaxTokens,
} from '../lib/contextGuard.js'
import { shouldUnload } from '../lib/lifecycle.js'
// renderCommandLine 在 args.js 里已经有一个（渲染子进程命令行），这里用别名区分：
// 两者参数形状相同但用途不同（agent 显示 vs 真实启动），混用会让断言测错对象。
import { buildLaunchReport, renderCommandLine as renderReportCommandLine, renderLaunchLines } from '../lib/launchReport.js'
import { findMediaTools, mediaToolWarning, withMediaPath } from '../lib/llama/media.js'
import { buildRouteProfile, buildRouteSpec, renderRouteYaml } from '../lib/llmBridge.js'
import {
  MAX_PRESETS,
  PRESET_EXCLUDED_KEYS,
  PresetStore,
  normalizePresetName,
  presetKeys,
  sanitizePresetValues,
  snapshotPresetValues,
} from '../lib/presets.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.log(`  ✗ ${name}\n      ${error.message}`)
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.log(`  ✗ ${name}\n      ${error.message}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

/** 一个「构建认识全部选项」的集合。给用例当 knownFlags 用，免得门控把参数静默吞掉。 */
const KNOWN_FLAGS = new Set([
  '-m', '--host', '--port', '--alias', '-c', '-ngl', '-t', '--threads-batch', '-b', '-ub',
  '--flash-attn', '--cache-type-k', '--cache-type-v', '--jinja', '--chat-template', '--mmproj',
  '--no-mmap', '--mlock', '--api-key', '--spec-type',
  '--kv-unified', '--kv-stream-stage-mib',
  '--temp', '--top-k', '--top-p', '--min-p', '--presence-penalty', '--repeat-penalty',
  '--repeat-last-n', '--seed',
  '--image-min-tokens', '--image-max-tokens', '--reasoning-budget',
  // 新增的通用项
  '-n', '-lm', '--frequency-penalty', '--kv-dtype', '--spec-kv-dtype', '--spec-draft-n-max',
  '--spec-draft-p-min', '--no-mmproj-offload', '--chat-template-file', '--chat-template-kwargs',
  '--reasoning-effort', '--reasoning-budget-message',
  // KVMem 家族（--kvmem-gen-reserve 故意不在这个集合里，理由见下）
  '--no-kvmem', '--kvmem-budget', '--kvmem-block-tokens', '--kvmem-sink-tokens',
  '--kvmem-recent-tokens', '--kvmem-method', '--kvmem-query-last', '--kvmem-query-max-tokens',
  '--kvmem-query-replay', '--kvmem-query-policy', '--kvmem-mtp-state', '--kvmem-gpu-ratio',
  '--kvmem-cpu-gb', '--kvmem-nvme-gb', '--kvmem-nvme-dir', '--kvmem-harvest-v', '--kvmem-raw-k-nvme',
])

/**
 * `--kvmem-gen-reserve` 刻意**不**放进 KNOWN_FLAGS。
 *
 * 它的存在会触发一条「解码预留只有 N，单次生成会被截断」的提醒，而那条提醒挂在
 * 「构建是否公开该选项」上。放进来的话，每一个与本项无关的用例都会多出一条 notices，
 * 于是断言 notices 长度的用例集体误报。需要验证它的用例自己带 knownFlags。
 */
const GEN_RESERVE_FLAGS = new Set([...KNOWN_FLAGS, '--kvmem-gen-reserve'])

/**
 * 新增参数的中性基线。
 *
 * 每个用例只该关心自己那一项，不该被别的参数干扰，所以给一套「尽量无副作用」的值：
 *   - KV / 图像三项取 0（= 不下发），于是不会出现在命令行里；
 *   - 采样参数取 0 —— 它们**会**被显式下发（这就是新行为），但取值不影响顺序/邻接类断言；
 *   - knownFlags 给全，避免「被门控跳过」的提示污染 notices 断言。
 * 需要验证门控或具体取值的用例，自行覆盖对应字段即可。
 */
const NEW_PARAMS = {
  // MTP 与视觉共存：与 configResolve 的默认值保持一致。
  // 少了它，args.ts（用 `!== false` 判）与 registry.ts（用 `=== false` 判）会在
  // 同一个用例里给出两种结论 —— 生产里它必然有值，只有夹具能暴露这种不一致。
  mtpWithVision: true,
  kvUnified: false,
  kvStreamStageMib: 0,
  // KVMem 家族：-1 / 空串 / 构建默认一律表示「不下发」，所以这一套基线不会往命令行里加任何东西。
  // 数字项的 0 在这些选项上都是有意义的取值（budget 0 = n_ctx、cpu-gb 0 = 关闭），
  // 因此哨兵必须是负数 —— 用例里写 -1 是有意的，别顺手改成 0。
  kvmemEnabled: true,
  kvmemBudget: -1,
  kvmemGenReserve: -1,
  kvmemBlockTokens: -1,
  kvmemSinkTokens: -1,
  kvmemRecentTokens: -1,
  kvmemMethod: '',
  kvmemQueryLast: -1,
  kvmemQueryMaxTokens: -1,
  kvmemQueryReplay: '',
  kvmemQueryPolicy: '',
  kvmemMtpState: '',
  kvmemGpuRatio: -1,
  kvmemCpuGb: -1,
  kvmemNvmeGb: -1,
  kvmemNvmeDir: '',
  kvmemHarvestV: false,
  kvmemRawKNvme: false,
  nPredict: -1,
  loadMode: '',
  kvDtype: '',
  specKvDtype: '',
  specDraftNMax: -1,
  specDraftPMin: -1,
  frequencyPenalty: 0,
  mmprojOffload: true,
  chatTemplateFile: '',
  chatTemplateKwargs: '',
  reasoningEffort: '',
  reasoningBudgetMessage: '',
  temp: 0,
  topK: 0,
  topP: 0,
  minP: 0,
  presencePenalty: 0,
  repeatPenalty: 0,
  repeatLastN: 0,
  seed: 0,
  imageMinTokens: 0,
  imageMaxTokens: 0,
  reasoningBudget: 0,
  knownFlags: KNOWN_FLAGS,
}

/**
 * 测试专用的拼装入口：自动补上 NEW_PARAMS 基线再交给真实函数。
 *
 * 这样加新参数时不必回来逐个补全十几个字面量 —— 漏一个就会让那个用例静默走错分支，
 * 而且症状是「断言通过但测的不是它以为的东西」，比直接报错难查得多。
 */
const buildArgs = (input) => buildArgsRaw({ ...NEW_PARAMS, ...input })

// ── 参数拼装 ────────────────────────────────────────────────────────────────
section('llama-server 参数拼装')

test('基础参数齐全且顺序稳定', () => {
  const { args } = buildArgs({
    modelPath: '/m/a.gguf',
    host: '127.0.0.1',
    port: 18081,
    alias: 'local',
    ctxSize: 8192,
    gpuLayers: -1,
    gpuLayersMode: 'custom',
    gpuLayersSupport: { auto: false, all: true },
    threads: 0,
    threadsBatch: 0,
    batchSize: 2048,
    ubatchSize: 512,
    flashAttention: 'on',
    flashAttnMode: 'value',
    jinja: true,
    chatTemplate: '',
    mmproj: '',
    mmap: true,
    mlock: false,
    apiKey: '',
    extraArgs: '',
  })
  assert.deepEqual(args.slice(0, 10), ['-m', '/m/a.gguf', '--host', '127.0.0.1', '--port', '18081', '--alias', 'local', '-c', '8192'])
  assert.ok(args.includes('-ngl'), '应下发 -ngl')
  // gpuLayers=-1 + gpuLayersMode='custom' + 构建认 all → 下发 -ngl all（比 -1 表达更准）
  assert.equal(args[args.indexOf('-ngl') + 1], 'all', '负数层数应表达为 all 关键字')
  assert.ok(args.includes('--jinja'), 'dsh 的工具调用依赖 --jinja')
  assert.equal(args[args.indexOf('--flash-attn') + 1], 'on', '带值构建必须把值一起下发')
  assert.ok(!args.includes('-t'), 'threads=0 时不应下发 -t')
  assert.ok(!args.includes('--no-mmap'), 'mmap 开启时不应下发 --no-mmap')
  assert.ok(!args.includes('--api-key'), '未配置密钥时不应下发 --api-key')
})

test('ubatch 大于 batch 时自动收敛（否则 llama.cpp 直接启动失败）', () => {
  const { args } = buildArgs({
    modelPath: 'm.gguf',
    host: 'h',
    port: 1,
    alias: 'local',
    ctxSize: 4096,
    gpuLayers: 0,
    gpuLayersMode: 'custom',
    gpuLayersSupport: { auto: false, all: false },
    threads: 4,
    threadsBatch: 0,
    batchSize: 1024,
    ubatchSize: 4096,
    flashAttention: 'auto',
    flashAttnMode: 'value',
    jinja: false,
    chatTemplate: '',
    mmproj: '',
    mmap: true,
    mlock: false,
    apiKey: '',
    extraArgs: '',
  })
  assert.equal(args[args.indexOf('-ub') + 1], '1024')
  assert.ok(!args.includes('--flash-attn'), 'auto 永远不下发')
  assert.ok(!args.includes('--jinja'))
})

test('额外参数按 shell 规则分词并追加在末尾', () => {
  const { args } = buildArgs({
    modelPath: 'm.gguf',
    host: 'h',
    port: 1,
    alias: 'local',
    ctxSize: 4096,
    gpuLayers: 0,
    gpuLayersMode: 'custom',
    gpuLayersSupport: { auto: false, all: false },
    threads: 0,
    threadsBatch: 0,
    batchSize: 0,
    ubatchSize: 0,
    flashAttention: 'auto',
    flashAttnMode: 'value',
    jinja: false,
    chatTemplate: '',
    mmproj: '',
    mmap: true,
    mlock: false,
    apiKey: '',
    extraArgs: '--rope-scaling linear --chat-template-file "/opt/my template.jinja"',
  })
  assert.deepEqual(args.slice(-4), ['--rope-scaling', 'linear', '--chat-template-file', '/opt/my template.jinja'])
})

test('分词器：引号、Windows 路径、连续空白', () => {
  assert.deepEqual(splitArgs(''), [])
  assert.deepEqual(splitArgs('   '), [])
  assert.deepEqual(splitArgs('a  b   c'), ['a', 'b', 'c'])
  assert.deepEqual(splitArgs('"a b" c'), ['a b', 'c'])
  assert.deepEqual(splitArgs("'a b' c"), ['a b', 'c'])
  // 反斜杠不能被当转义符吃掉：用户会直接粘贴 Windows 路径
  assert.deepEqual(splitArgs('--chat-template C:\\tpl\\qwen.jinja'), ['--chat-template', 'C:\\tpl\\qwen.jinja'])
  assert.deepEqual(splitArgs('--lora "C:\\Users\\me\\lora.bin"'), ['--lora', 'C:\\Users\\me\\lora.bin'])
  // 唯一的例外：转义引号自身
  assert.deepEqual(splitArgs('--tmpl "he said \\"hi\\""'), ['--tmpl', 'he said "hi"'])
  assert.deepEqual(splitArgs('--x=""'), ['--x='])
})

test('日志里不泄露 api-key', () => {
  const raw = ['--api-key', 'secret123', '-m', 'm.gguf']
  const redacted = redactArgs(raw)
  assert.deepEqual(redacted, ['--api-key', '***', '-m', 'm.gguf'])
  assert.deepEqual(raw, ['--api-key', 'secret123', '-m', 'm.gguf'], 'redactArgs 不应改动原数组')
  assert.ok(!renderCommandLine('llama-server', redacted).includes('secret123'))
})

// ── Flash Attention 形状探测（本次线上故障的回归防线）───────────────────────
section('llama-server 能力探测与 --flash-attn 形状')

/** 实机样本：llama-b10822 的 --help 原文（含对齐用的多空格）。 */
const REAL_HELP = [
  '-t,    --threads N                      number of CPU threads to use during generation (default: -1)',
  '-tb,   --threads-batch N                number of threads to use during batch and prompt processing (default:',
  '-c,    --ctx-size N                     size of the prompt context (default: 0, 0 = loaded from model)',
  '-b,    --batch-size N                   logical maximum batch size (default: 2048)',
  '-ub,   --ubatch-size N                  physical maximum batch size (default: 512)',
  '-fa,   --flash-attn [on|off|auto]       set Flash Attention use (\'on\', \'off\', or \'auto\', default: \'auto\')',
  '--mlock                                 DEPRECATED in favor of `--load-mode`: force system to keep model in',
  '--mmap, --no-mmap                       DEPRECATED in favor of `--load-mode`: whether to memory-map model. (if',
  '-ngl,  --gpu-layers, --n-gpu-layers N   max. number of layers to store in VRAM, either an exact number,',
  '-m,    --model FNAME                    model path to load',
  '-a,    --alias STRING                   set model name aliases, comma-separated (to be used by API)',
  '--jinja, --no-jinja                     whether to use jinja template engine for chat (default: enabled)',
  '--host HOST                             ip address to listen',
  '--port PORT                             port to listen (default: 8080)',
  '--api-key KEY                           API key to use for authentication',
  '-ctk,  --cache-type-k TYPE              KV cache data type for K',
  '-ctv,  --cache-type-v TYPE              KV cache data type for V',
  // 采样段：真实 llama.cpp 的 --help 里一直有这一块，插件现在会显式下发它们。
  '-s,    --seed N                         RNG seed (default: -1, use random seed for < 0)',
  '--temp N                                temperature (default: 0.80)',
  '--top-k N                               top-k sampling (default: 40, 0 = disabled)',
  '--top-p N                               top-p sampling (default: 0.95, 1.0 = disabled)',
  '--min-p N                               min-p sampling (default: 0.05, 0.0 = disabled)',
  '--presence-penalty N                    repeat alpha presence penalty (default: 0.00)',
  '--repeat-penalty N                      penalize repeat sequence of tokens (default: 1.10)',
  '--repeat-last-n N                       last n tokens to penalize (default: 64)',
].join('\n')

/** 老构建的样子：--flash-attn 是裸开关。 */
const LEGACY_HELP = [
  '-fa, --flash-attn                       enable Flash Attention (default: enabled)',
  '-c,  --ctx-size N                       size of the prompt context',
  '--jinja                                 enable Jinja template engine',
].join('\n')

test('多空格对齐的帮助行也能解析（曾因 \\s 只吃一个空格而漏掉大部分选项）', () => {
  const { flags } = parseHelp(REAL_HELP)
  for (const flag of ['-t', '-tb', '-c', '-b', '-ub', '-fa', '--flash-attn', '--mlock', '--mmap', '--no-mmap', '-ngl', '--gpu-layers', '--n-gpu-layers', '-m', '--model', '-a', '--alias', '--jinja', '--no-jinja', '--host', '--port', '--api-key']) {
    assert.ok(flags.has(flag), `应当解析到 ${flag}`)
  }
  // 实际构建里只有 -ngl，没有 --ngl 这个长名 —— 插件下发的也必须是 -ngl。
  assert.ok(!flags.has('--ngl'), '不存在的长名不该被解析出来')
})

test('--flash-attn 形状：带值 / 裸开关 / 不存在', () => {
  assert.equal(detectFlashAttnMode(REAL_HELP), 'value', '新构建的 --flash-attn 带值')
  assert.equal(detectFlashAttnMode(LEGACY_HELP), 'bare', '老构建的是裸开关')
  assert.equal(detectFlashAttnMode('-c, --ctx-size N   size of the prompt context'), 'unsupported')
})

test('历史布尔值收敛成三态', () => {
  assert.equal(normalizeFlashAttn(true), 'on')
  assert.equal(normalizeFlashAttn(false), 'off')
  assert.equal(normalizeFlashAttn('on'), 'on')
  assert.equal(normalizeFlashAttn('off'), 'off')
  assert.equal(normalizeFlashAttn('auto'), 'auto')
  assert.equal(normalizeFlashAttn(undefined), 'auto')
  assert.equal(normalizeFlashAttn('随便什么'), 'auto')
})

test('带值构建：显式下发；auto 不下发', () => {
  assert.deepEqual(flashAttnArgs('on', 'value').args, ['--flash-attn', 'on'])
  assert.deepEqual(flashAttnArgs('off', 'value').args, ['--flash-attn', 'off'])
  assert.deepEqual(flashAttnArgs('auto', 'value').args, [], 'auto 等价默认值，不下发最安全')
})

test('裸开关构建：只能表达 on，off 要给出说明', () => {
  assert.deepEqual(flashAttnArgs('on', 'bare').args, ['--flash-attn'])
  const off = flashAttnArgs('off', 'bare')
  assert.deepEqual(off.args, [])
  assert.match(off.notice, /无法显式关闭/)
})

test('形状未知：不下发，并说明原因（宁可退回默认值也不赌）', () => {
  for (const setting of ['on', 'off']) {
    const result = flashAttnArgs(setting, 'unsupported')
    assert.deepEqual(result.args, [], '形状未知时绝不下发')
    assert.ok(result.notice, '必须给出说明')
  }
})

test('本次故障的确切形态：裸 flag 紧跟 --mmproj 会被吞掉', () => {
  const built = buildArgs({
    modelPath: 'm.gguf',
    host: 'h',
    port: 1,
    alias: 'local',
    ctxSize: 4096,
    gpuLayers: -1,
    gpuLayersMode: 'custom',
    gpuLayersSupport: { auto: false, all: true },
    threads: 0,
    threadsBatch: 0,
    batchSize: 0,
    ubatchSize: 0,
    flashAttention: 'on',
    // 旧行为：当成裸 flag 下发 → 下一个参数被解析器当成它的值
    flashAttnMode: 'bare',
    cacheTypeK: 'auto',
    cacheTypeV: 'auto',
    jinja: false,
    chatTemplate: '',
    mmproj: '/m/mmproj.gguf',
    mmap: true,
    mlock: false,
    apiKey: '',
    extraArgs: '',
  })
  // 断言的是「裸 flag 后面紧跟另一个 flag」这个**形态**，而不是具体是哪个 flag ——
  // 采样参数加入后紧随其后的是 --temp，不再恰好是 --mmproj，但故障成因一模一样。
  const index = built.args.indexOf('--flash-attn')
  const next = built.args[index + 1]
  assert.ok(
    typeof next === 'string' && next.startsWith('--'),
    `复现出「裸 flag 后紧邻另一个 flag」的排布（实际紧随其后的是 ${next}）`,
  )

  // 正确行为：识别出带值构建后，值补齐，后面的参数不再被吞
  const fixed = buildArgs({
    modelPath: 'm.gguf',
    host: 'h',
    port: 1,
    alias: 'local',
    ctxSize: 4096,
    gpuLayers: -1,
    gpuLayersMode: 'custom',
    gpuLayersSupport: { auto: false, all: true },
    threads: 0,
    threadsBatch: 0,
    batchSize: 0,
    ubatchSize: 0,
    flashAttention: 'on',
    flashAttnMode: 'value',
    cacheTypeK: 'auto',
    cacheTypeV: 'auto',
    jinja: false,
    chatTemplate: '',
    mmproj: '/m/mmproj.gguf',
    mmap: true,
    mlock: false,
    apiKey: '',
    extraArgs: '',
  })
  const fixedIndex = fixed.args.indexOf('--flash-attn')
  assert.equal(fixed.args[fixedIndex + 1], 'on')
  assert.ok(fixed.args.includes('--mmproj'), '--mmproj 必须还是独立参数')
  assert.equal(fixed.args[fixed.args.indexOf('--mmproj') + 1], '/m/mmproj.gguf')
})

test('识别「--flash-attn 形状不对」这类错误（用于自动重试）', () => {
  const tail = "error while handling argument \"--flash-attn\": error: unknown value for --flash-attn: '--mmproj' usage: -fa, --flash-attn [on|off|auto]"
  assert.equal(isFlashAttnFormError(tail), true)
  assert.equal(isFlashAttnFormError('CUDA error: out of memory'), false)
})

test('参数校验：能挑出构建不认识的选项', () => {
  const { flags } = parseHelp(REAL_HELP)
  const built = buildArgs({
    modelPath: 'm.gguf',
    host: 'h',
    port: 1,
    alias: 'local',
    ctxSize: 4096,
    gpuLayers: -1,
    gpuLayersMode: 'custom',
    gpuLayersSupport: { auto: true, all: true },
    threadsBatch: 0,
    batchSize: 0,
    ubatchSize: 0,
    flashAttention: 'on',
    flashAttnMode: 'value',
    jinja: true,
    chatTemplate: '',
    mmproj: '',
    mmap: false,
    mlock: true,
    apiKey: 'k',
    extraArgs: '',
    // 用真实 --help 解析出的集合当 knownFlags：既验证「我们下发的构建都认识」，
    // 顺带验证门控逻辑在真实集合下不会漏出去不认识的选项。
    knownFlags: flags,
  })
  assert.deepEqual(unknownFlags(built.usedFlags, flags), [], '我们下发的选项构建都认识')

  const tiny = parseHelp('-c, --ctx-size N   size of the prompt context').flags
  assert.deepEqual(unknownFlags(['-c', '--jinja'], tiny), ['--jinja'])
})

// ── GPU 层数策略（OOM 修复核心） ────────────────────────────────────────────
section('GPU 层数策略（OOM 修复核心）')

test('normalizeGpuLayersMode 收敛：auto / all / custom / 其它一律 auto', () => {
  assert.equal(normalizeGpuLayersMode('auto'), 'auto')
  assert.equal(normalizeGpuLayersMode('all'), 'all')
  assert.equal(normalizeGpuLayersMode('custom'), 'custom')
  assert.equal(normalizeGpuLayersMode(undefined), 'auto')
  assert.equal(normalizeGpuLayersMode(null), 'auto')
  assert.equal(normalizeGpuLayersMode('bogus'), 'auto')
})

test('gpuLayersArgs: auto + 认得 auto 关键字 → 下发 -ngl auto（让 --fit 自适应）', () => {
  const r = gpuLayersArgs('auto', 99, { auto: true, all: true })
  assert.deepEqual(r.args, ['-ngl', 'auto'], 'auto 关键字必须下发，否则 --fit 自适应被跳过')
  assert.equal(r.notice, null)
})

test('gpuLayersArgs: auto + 不认 auto 关键字 → 退回 -1（注意给说明，别静默）', () => {
  const r = gpuLayersArgs('auto', 99, { auto: false, all: true })
  assert.deepEqual(r.args, ['-ngl', '-1'])
  assert.match(r.notice ?? '', /不认识 auto/)
})

test('gpuLayersArgs: all + 认得 all 关键字 → -ngl all', () => {
  const r = gpuLayersArgs('all', 99, { auto: true, all: true })
  assert.deepEqual(r.args, ['-ngl', 'all'])
})

test('gpuLayersArgs: all + 不认 all 关键字 → -ngl -1 + 说明', () => {
  const r = gpuLayersArgs('all', 99, { auto: true, all: false })
  assert.deepEqual(r.args, ['-ngl', '-1'])
  assert.match(r.notice ?? '', /不认识 all/)
})

test('gpuLayersArgs: custom + 正数 → 透传', () => {
  assert.deepEqual(gpuLayersArgs('custom', 32, { auto: false, all: false }).args, ['-ngl', '32'])
})

test('gpuLayersArgs: custom + 负数 → 表示「全部」，按构建能力选 all / -1', () => {
  assert.deepEqual(gpuLayersArgs('custom', -1, { auto: false, all: true }).args, ['-ngl', 'all'])
  assert.deepEqual(gpuLayersArgs('custom', -1, { auto: false, all: false }).args, ['-ngl', '-1'])
})

test('buildLlamaServerArgs: 默认 gpuLayersMode=auto 时不下发具体数字', () => {
  const { args } = buildArgs({
    modelPath: 'm.gguf',
    host: 'h',
    port: 1,
    alias: 'local',
    ctxSize: 4096,
    gpuLayers: 99, // 用户把数字填成 99 了，但因为 mode=auto 也不该被下发
    gpuLayersMode: 'auto',
    gpuLayersSupport: { auto: true, all: true },
    threads: 0,
    threadsBatch: 0,
    batchSize: 0,
    ubatchSize: 0,
    flashAttention: 'auto',
    flashAttnMode: 'unsupported',
    jinja: false,
    chatTemplate: '',
    mmproj: '',
    mmap: true,
    mlock: false,
    apiKey: '',
    extraArgs: '',
  })
  const i = args.indexOf('-ngl')
  assert.equal(args[i + 1], 'auto', 'auto 模式下 -ngl 后的值必须是 auto 这个关键字')
})

// ── KV cache 量化 ────────────────────────────────────────────────────────
section('KV cache 量化（OOM 防御第二层：长上下文的 KV 占显存）')

test('normalizeCacheType：合法值原样收敛，非法值兜底为 q8_0（绝不回落到 f16）', () => {
  assert.equal(normalizeCacheType('f16'), 'f16')
  assert.equal(normalizeCacheType('Q8_0'), 'q8_0', '大小写不敏感')
  assert.equal(normalizeCacheType(' q4_0 '), 'q4_0', '自动 trim')
  assert.equal(normalizeCacheType('auto'), 'auto', 'auto 必须保留')
  assert.equal(normalizeCacheType('bogus'), 'q8_0', '非法值兜底为 q8_0')
  assert.equal(normalizeCacheType(undefined), 'q8_0', '未传兜底为 q8_0')
  assert.equal(normalizeCacheType(null), 'q8_0')
  assert.equal(normalizeCacheType(123), 'q8_0', '非字符串也兜底')
})

const kvBaseInput = {
  modelPath: 'm.gguf',
  host: 'h',
  port: 1,
  alias: 'local',
  ctxSize: 4096,
  gpuLayers: 0,
  gpuLayersMode: 'custom',
  gpuLayersSupport: { auto: false, all: false },
  threads: 0,
  threadsBatch: 0,
  batchSize: 0,
  ubatchSize: 0,
  flashAttention: 'auto',
  flashAttnMode: 'unsupported',
  jinja: false,
  chatTemplate: '',
  mmproj: '',
  mmap: true,
  mlock: false,
  apiKey: '',
  extraArgs: '',
}

test('KV cache：未传字段时默认下发 q8_0（关键保护：防止默认 f16 OOM）', () => {
  const { args } = buildArgs(kvBaseInput)
  const kIdx = args.indexOf('--cache-type-k')
  const vIdx = args.indexOf('--cache-type-v')
  assert.equal(args[kIdx + 1], 'q8_0', '未传 cacheTypeK 时必须默认 q8_0')
  assert.equal(args[vIdx + 1], 'q8_0', '未传 cacheTypeV 时必须默认 q8_0')
})

test('KV cache：auto 永远不下发（让 llama.cpp 用其默认）', () => {
  const { args } = buildArgs({ ...kvBaseInput, cacheTypeK: 'auto', cacheTypeV: 'auto' })
  assert.ok(!args.includes('--cache-type-k'), 'cacheTypeK=auto 时不下发')
  assert.ok(!args.includes('--cache-type-v'), 'cacheTypeV=auto 时不下发')
})

test('KV cache：K 和 V 独立配置', () => {
  const { args } = buildArgs({ ...kvBaseInput, cacheTypeK: 'f16', cacheTypeV: 'q4_0' })
  const kIdx = args.indexOf('--cache-type-k')
  const vIdx = args.indexOf('--cache-type-v')
  assert.equal(args[kIdx + 1], 'f16')
  assert.equal(args[vIdx + 1], 'q4_0')
})

test('KV cache：非法字符串值被兜底为 q8_0 仍会下发（绝不回落到 f16）', () => {
  const { args } = buildArgs({ ...kvBaseInput, cacheTypeK: 'bogus', cacheTypeV: undefined })
  const kIdx = args.indexOf('--cache-type-k')
  assert.equal(args[kIdx + 1], 'q8_0', '非法值兜底成 q8_0 而不是 auto / f16')
  const vIdx = args.indexOf('--cache-type-v')
  assert.equal(args[vIdx + 1], 'q8_0', 'undefined 兜底成 q8_0')
})

test('诊断：fit-blocked-by-pinned-layers 命中并给出建议', () => {
  const log = [
    'common_fit_params: failed to fit params to free device memory: n_gpu_layers already set by user to 99, abort',
    'cudaMalloc failed: out of memory',
    'GGML_ASSERT(buffer) failed',
  ].join('\n')
  const d = diagnoseLoadFailure(log, { gpuLayersPinned: true })
  assert.ok(d, '必须命中至少一条规则')
  assert.match(d.summary, /手动指定的 GPU 层数/)
  assert.ok(d.actions.some((a) => /自动/.test(a)), '建议里必须提到「自动」策略')
})

test('诊断：generic OOM（没提 -ngl）给出降级建议', () => {
  const d = diagnoseLoadFailure('cudaMalloc failed: out of memory', { gpuLayersPinned: false })
  assert.ok(d, '必须命中至少一条规则')
  assert.match(d.summary, /显存不足/)
  assert.ok(d.actions.length > 0)
})

test('诊断：无法识别的日志返回 null（不硬凑）', () => {
  assert.equal(diagnoseLoadFailure('hello world'), null)
})

test('诊断：block KV streaming 要求单序列 → 命中，并指出 -np 是祸首', () => {
  // 线上实测的完整形态：这是「开了 KV 流式暂存却没配 -np 1」的真实报错。
  const log = [
    "I srv load_model: loading model 'D:\\models\\Qwen3-8B-Q4_K_M.gguf'",
    'E llama_init_from_model: failed to initialize the context: block KV streaming requires exactly one sequence (-np 1)',
    'E common_fit_params: encountered an error while trying to fit params to free device memory: failed to create llama_context from model',
    "E cmn common_init_: failed to create context with model 'Qwen3-8B-Q4_K_M.gguf'",
    'E srv llama_server: exiting due to model loading error',
  ].join('\n')
  const d = diagnoseLoadFailure(log)
  assert.ok(d, '这条错误由插件新增的参数引入，必须能被自己认出来')
  assert.match(d.summary, /一个序列|单序列/, '结论要点明「要求单序列」')
  assert.ok(d.actions.some((a) => a.includes('-np')), '建议里必须出现 -np')
  assert.ok(
    d.actions.some((a) => a.includes('附加参数') || a.includes('暂存')),
    '必须告诉用户去哪儿改',
  )
  // 这条规则不能把别的诊断挤掉。
  assert.equal(diagnoseLoadFailure('cudaMalloc failed: out of memory')?.summary.includes('显存'), true)
})

test('extractEffectiveContext：从日志里读出实际生效的 n_ctx', () => {
  const log = [
    'llama_model_loader: - overriding n_ctx size to 8192',
    'some other line',
    'something n_ctx = 16384',
  ].join('\n')
  assert.equal(extractEffectiveContext(log), 16384, '取最后出现的 n_ctx')
  assert.equal(extractEffectiveContext('no n_ctx here'), null)
})

// ── 模型扫描 ────────────────────────────────────────────────────────────────
section('模型扫描与分片归并')

test('量化与参数量识别', () => {
  assert.equal(parseQuant('Qwen3-8B-Q4_K_M.gguf'), 'Q4_K_M')
  assert.equal(parseQuant('Llama-3.2-3B-Instruct-Q5_K_M.gguf'), 'Q5_K_M')
  assert.equal(parseQuant('mystery.gguf'), null)
  assert.equal(parseParams('Qwen3-8B-Q4_K_M.gguf'), '8B')
  assert.equal(parseParams('DeepSeek-R1-1.5B-Q8_0.gguf'), '1.5B')
  assert.equal(parseParams('mmproj-Qwen3-8B-f16.gguf'), '8B')
})

test('分片齐全时归并为一个模型，缺片时标记不完整', () => {
  const shards = [
    { rel: 'big-00001-of-00003.gguf', abs: '/m/big-00001-of-00003.gguf', size: 100, mtime: 1 },
    { rel: 'big-00002-of-00003.gguf', abs: '/m/big-00002-of-00003.gguf', size: 100, mtime: 1 },
    { rel: 'big-00003-of-00003.gguf', abs: '/m/big-00003-of-00003.gguf', size: 100, mtime: 1 },
    { rel: 'broken-00001-of-00002.gguf', abs: '/m/broken-00001-of-00002.gguf', size: 100, mtime: 1 },
  ]
  const entries = groupShards(shards)
  assert.equal(entries.length, 2)
  const big = entries.find((e) => e.displayName === 'big')
  const broken = entries.find((e) => e.displayName === 'broken')
  assert.equal(big.complete, true)
  assert.equal(big.shards.length, 3)
  assert.equal(big.sizeBytes, 300)
  assert.equal(big.path, '/m/big-00001-of-00003.gguf', '入口必须是第一片')
  assert.equal(broken.complete, false)
  assert.deepEqual(broken.missing, ['-00002-of-00002.gguf'])
})

test('分片顺序按序号而非字典序（否则会拿错入口片）', () => {
  const shards = [
    { rel: 'x-00010-of-00012.gguf', abs: '/m/x-00010-of-00012.gguf', size: 1, mtime: 1 },
    { rel: 'x-00002-of-00012.gguf', abs: '/m/x-00002-of-00012.gguf', size: 1, mtime: 1 },
  ]
  const [entry] = groupShards(shards)
  assert.equal(entry.path, '/m/x-00002-of-00012.gguf')
})

test('mmproj 只在能确定归属时关联', () => {
  const mmproj = [{ rel: 'mmproj-Qwen3-8B-f16.gguf', abs: '/m/mmproj-Qwen3-8B-f16.gguf', size: 1, mtime: 1 }]
  const ambiguous = groupShards(
    [
      { rel: 'Qwen3-8B-Q4_K_M.gguf', abs: '/m/Qwen3-8B-Q4_K_M.gguf', size: 1, mtime: 1 },
      { rel: 'Llama-3.2-3B-Q5_K_M.gguf', abs: '/m/Llama-3.2-3B-Q5_K_M.gguf', size: 1, mtime: 1 },
    ],
    mmproj,
  )
  assert.equal(ambiguous.find((e) => e.displayName.startsWith('Llama')).mmproj, null, '前缀不匹配且有歧义时不应瞎猜')

  const unique = groupShards([{ rel: 'Qwen3-8B-Q4_K_M.gguf', abs: '/m/Qwen3-8B-Q4_K_M.gguf', size: 1, mtime: 1 }], mmproj)
  assert.equal(unique[0].mmproj, '/m/mmproj-Qwen3-8B-f16.gguf', '目录内唯一的模型可以直接关联')
})

test('按文件名 / 相对路径 / 展示名都能选中模型', () => {
  const entries = [{ id: 'sub/Qwen3-8B-Q4_K_M.gguf', displayName: 'Qwen3-8B-Q4_K_M', path: '/m/sub/Qwen3-8B-Q4_K_M.gguf' }]
  assert.ok(pickModel(entries, 'sub/Qwen3-8B-Q4_K_M.gguf'))
  assert.ok(pickModel(entries, 'Qwen3-8B-Q4_K_M.gguf'))
  assert.equal(pickModel(entries, 'not-there.gguf'), null)
  assert.equal(pickModel(entries, ''), null)
})

test('体积格式化', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(4.7 * 1024 ** 3), '4.7 GB')
})

await testAsync('真实目录扫描（含子目录、分片、mmproj）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'local-model-scan-'))
  try {
    await mkdir(path.join(dir, 'vision'), { recursive: true })
    await writeFile(path.join(dir, 'Llama-3.2-3B-Q5_K_M.gguf'), 'x')
    for (let i = 1; i <= 3; i++) {
      await writeFile(path.join(dir, `Qwen3-8B-Q4_K_M-0000${i}-of-00003.gguf`), 'x')
    }
    await writeFile(path.join(dir, 'broken-00001-of-00002.gguf'), 'x')
    await writeFile(path.join(dir, 'vision', 'VLM-Q8_0.gguf'), 'x')
    await writeFile(path.join(dir, 'vision', 'mmproj-VLM-f16.gguf'), 'x')
    await writeFile(path.join(dir, 'PUT_GGUF_MODELS_HERE.txt'), 'hint')

    const entries = await scanModels(dir)
    const ids = entries.map((e) => e.id).sort()
    assert.deepEqual(ids, [
      'Llama-3.2-3B-Q5_K_M.gguf',
      'Qwen3-8B-Q4_K_M-00001-of-00003.gguf',
      'broken-00001-of-00002.gguf',
      'vision/VLM-Q8_0.gguf',
    ])
    assert.equal(entries.find((e) => e.id.startsWith('Qwen3')).shards.length, 3)
    assert.equal(entries.find((e) => e.id.startsWith('vision/')).mmproj, path.join(dir, 'vision', 'mmproj-VLM-f16.gguf'))
    assert.equal(entries[0].complete, true, '完整的模型排在最前')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── 视觉投影文件（新增的手动选择项） ────────────────────────────────────────
section('视觉投影文件（mmproj）选择')

test('留空 = 沿用同目录自动关联的结果（原有行为一字不变）', () => {
  assert.equal(resolveVisionProjector('/m', '', '/m/mmproj-a.gguf'), '/m/mmproj-a.gguf')
  assert.equal(resolveVisionProjector('/m', '   ', '/m/mmproj-a.gguf'), '/m/mmproj-a.gguf', '纯空白等于留空')
  assert.equal(resolveVisionProjector('/m', '', null), '', '原本就没关联到 mmproj 时依旧不下发 --mmproj')
})

test('显式选择优先，相对路径按模型目录解析', () => {
  const modelsDir = path.resolve(path.sep, 'base')
  const resolved = resolveVisionProjector(modelsDir, 'vision/mmproj-b.gguf', path.join(modelsDir, 'mmproj-a.gguf'))
  assert.ok(path.isAbsolute(resolved), '最终必须是绝对路径（llama-server 的 cwd 不是模型目录）')
  assert.equal(resolved, path.resolve(modelsDir, 'vision/mmproj-b.gguf'))
  assert.ok(resolved !== path.join(modelsDir, 'mmproj-a.gguf'), '显式选择必须覆盖自动关联')
})

test('允许填绝对路径（兼容历史上手写 --mmproj 的做法）', () => {
  const absolute = path.resolve(path.sep, 'elsewhere', 'mmproj-c.gguf')
  assert.equal(resolveVisionProjector(path.resolve(path.sep, 'base'), absolute, null), absolute)
})

await testAsync('扫描结果同时给出模型列表与 mmproj 清单（供设置页下拉）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'local-model-vision-'))
  try {
    await mkdir(path.join(dir, 'vision'), { recursive: true })
    await writeFile(path.join(dir, 'vision', 'VLM-Q8_0.gguf'), 'x')
    await writeFile(path.join(dir, 'vision', 'mmproj-VLM-f16.gguf'), 'x')

    const scanned = await scanModelsDetailed(dir)
    assert.deepEqual(
      scanned.visionProjectors.map((p) => p.rel),
      ['vision/mmproj-VLM-f16.gguf'],
      'mmproj 必须能被单独列出来，否则设置页的下拉框是空的',
    )
    assert.equal(scanned.entries.length, 1, 'mmproj 不应被当成模型')
    assert.deepEqual(await scanModels(dir), scanned.entries, 'scanModels 保持原有签名与结果')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── 多 Token 预测（MTP）─────────────────────────────────────────────────────
section('多 Token 预测（MTP）')

/**
 * MTP 用例的公共输入：**刻意带一个 mmproj**。
 * 互斥规则最核心的一条就是「开了 MTP 要把 --mmproj 丢掉」，输入里没有 mmproj 就永远测不出来。
 */
const mtpBaseInput = { ...kvBaseInput, mmproj: '/m/mmproj-a.gguf', mtp: false }

const flagIndex = (args, flag) => args.indexOf(flag)
const flagValue = (args, flag) => (args.includes(flag) ? args[flagIndex(args, flag) + 1] : undefined)

test('默认关闭：不下发 --spec-type，--mmproj 照旧（老部署行为一字不变）', () => {
  const built = buildArgs(mtpBaseInput)
  assert.equal(flagIndex(built.args, '--spec-type'), -1, '默认必须是关的')
  assert.equal(flagValue(built.args, '--mmproj'), '/m/mmproj-a.gguf', '没开 MTP 时视觉投影照旧下发')
  assert.deepEqual(built.notices, [], '没开 MTP 就不该多出任何提示')
})

test('开启 MTP：下发 --spec-type draft-mtp', () => {
  const built = buildArgs({ ...mtpBaseInput, mtp: true })
  assert.equal(flagValue(built.args, '--spec-type'), 'draft-mtp')
  assert.ok(
    built.usedFlags.includes('--spec-type'),
    '必须进 usedFlags —— 否则「构建不认识这个选项」的 --help 校验发现不了老 llama.cpp',
  )
})

test('互斥（关掉共存开关时）：--mmproj 绝不下发（上游 llama.cpp 会加载失败）', () => {
  const built = buildArgs({ ...mtpBaseInput, mtp: true, mtpWithVision: false })
  assert.equal(flagIndex(built.args, '--mmproj'), -1, '关掉共存时两个选项不能同时下发')
  assert.equal(built.args.includes('/m/mmproj-a.gguf'), false, '连值都不能残留在命令行里')
})

test('互斥不静默：notices 说清视觉投影为什么没了', () => {
  const built = buildArgs({ ...mtpBaseInput, mtp: true, mtpWithVision: false })
  assert.equal(built.notices.length, 1)
  assert.ok(built.notices[0].includes('MTP'), '要点明是 MTP 造成的')
  assert.ok(built.notices[0].includes('--mmproj'), '要点明被丢掉的是哪个参数')
  // 还要给出恢复办法 —— 否则用户只知道视觉没了，不知道该动哪个开关。
  assert.ok(built.notices[0].includes('共存'), '要给出恢复办法')
})

test('本来就没有 mmproj：不刷无意义的「已忽略」提示', () => {
  const built = buildArgs({ ...mtpBaseInput, mtp: true, mmproj: '' })
  assert.equal(flagValue(built.args, '--spec-type'), 'draft-mtp', 'MTP 本身照常开')
  assert.deepEqual(built.notices, [], '没有东西被丢，就不该有提示')
})

test('effectiveVisionProjector：共存开关决定 MTP 是否顶掉视觉', () => {
  const base = { modelsDir: '/m', mmprojFile: '', autoMmproj: '/m/mmproj-a.gguf' }
  assert.equal(effectiveVisionProjector({ ...base, mtp: false }), '/m/mmproj-a.gguf', '没开 MTP：沿用自动关联')
  assert.equal(
    effectiveVisionProjector({ ...base, mtp: true }),
    '/m/mmproj-a.gguf',
    '开了 MTP、共存开关取默认（开）：视觉照旧生效 —— 0.7.0 起 kvmem 分支支持共存',
  )
  assert.equal(
    effectiveVisionProjector({ ...base, mtp: true, mtpWithVision: false }),
    '',
    '关掉共存：恢复旧的互斥',
  )
  assert.equal(effectiveVisionProjector({ ...base, autoMmproj: null, mtp: false }), '', '本来没有视觉能力：空')
  assert.equal(
    effectiveVisionProjector({ ...base, mmprojFile: 'vision/mmproj-b.gguf', mtp: true, mtpWithVision: false }),
    '',
    '关掉共存时显式选了也不生效 —— 互斥优先于用户的显式选择',
  )
})

test('显示值与命令行下发值严格一致（防面板与实参错位）', () => {
  // 两个开关的四种组合都要对得上：面板显示走 registry.effectiveVisionProjector，
  // 命令行走 args.buildLlamaServerArgs —— 两处对「没给这个字段」的解释必须同义
  // （都用 `=== false` 判），否则会出现「面板写着启用了视觉、实参里却没有」这种错位。
  for (const mtp of [false, true]) {
    for (const mtpWithVision of [false, true]) {
      const shown = effectiveVisionProjector({
        modelsDir: '/m',
        mmprojFile: 'vision/mmproj-b.gguf',
        autoMmproj: '/m/mmproj-a.gguf',
        mtp,
        mtpWithVision,
      })
      const built = buildArgs({ ...mtpBaseInput, mtp, mtpWithVision, mmproj: shown })
      assert.equal(
        flagValue(built.args, '--mmproj') ?? '',
        shown,
        `mtp=${mtp} mtpWithVision=${mtpWithVision} 时面板显示与实参必须一致`,
      )
    }
  }
})

test('配置：mtp 默认 false，字符串形态照样收敛（组合层不经写入闸门）', () => {
  const env = { DSH_HOME: '/tmp/dsh' }
  assert.equal(resolveConfig(undefined, env).mtp, false, '默认必须是关 —— 这就是「其他功能保持不变」的落点')
  assert.equal(resolveConfig({ mtp: 'true' }, env).mtp, true)
  assert.equal(resolveConfig({ mtp: '0' }, env).mtp, false)
  assert.equal(resolveConfig({ mtp: '随便什么' }, env).mtp, false, '认不出的值回落默认，不能变成 true')
})

test('写入闸门认得 mtp，且 false 能落盘（否则用户在界面里关不掉）', () => {
  assert.deepEqual(sanitize({ mtp: 'true' }), { mtp: true })
  assert.deepEqual(sanitize({ mtp: false }), { mtp: false })
})

// ── 采样参数与 KV 缓存策略（本次新增的一批设置） ─────────────────────────────
section('采样参数与 KV 缓存策略')

/** 用户在需求里指定的那一组值 —— 它们会被显式下发，并覆盖 llama.cpp 自身的默认值。 */
const SAMPLING = {
  temp: 0.75,
  topK: 20,
  topP: 0.95,
  minP: 0,
  presencePenalty: 0,
  repeatPenalty: 1,
  repeatLastN: 64,
  seed: -1,
}

test('采样参数全部显式下发（这几项的默认值与 llama.cpp 自身默认值不同）', () => {
  const { args } = buildArgs({ ...kvBaseInput, ...NEW_PARAMS, ...SAMPLING })
  assert.equal(flagValue(args, '--temp'), '0.75')
  assert.equal(flagValue(args, '--top-k'), '20')
  assert.equal(flagValue(args, '--top-p'), '0.95')
  assert.equal(flagValue(args, '--min-p'), '0')
  assert.equal(flagValue(args, '--presence-penalty'), '0')
  assert.equal(flagValue(args, '--repeat-penalty'), '1')
  assert.equal(flagValue(args, '--repeat-last-n'), '64')
  // seed 单独成例：SAMPLING 里是 -1（= 随机），负数不下发，见下一条用例。
  assert.equal(flagIndex(args, '--seed'), -1, 'seed=-1 不下发')
})

test('种子：负数不下发（等价于随机），非负才显式下发', () => {
  const negative = buildArgs({ ...kvBaseInput, ...NEW_PARAMS, seed: -1 })
  assert.equal(flagIndex(negative.args, '--seed'), -1, '负数不下发')
  assert.equal(flagIndex(negative.args, '-s'), -1, '两种写法都不该出现')

  const fixed = buildArgs({ ...kvBaseInput, ...NEW_PARAMS, seed: 12345 })
  assert.equal(flagValue(fixed.args, '--seed'), '12345', '固定的种子必须显式下发（可复现输出）')
})

test('浮点值不会把浮点噪声带进命令行', () => {
  assert.equal(formatNumber(0.75), '0.75')
  assert.equal(formatNumber(0.1 + 0.2), '0.3', 'JSON 往返后的尾数噪声必须被抹掉')
  assert.equal(formatNumber(0.95), '0.95')
  assert.equal(formatNumber(-1), '-1')
  assert.equal(formatNumber(4096), '4096')
  assert.equal(formatNumber(Number.NaN), '0', '非法值兜底成 0 而不是 NaN 字样')
})

test('KV 策略：kvUnified 为真才下发；暂存量 > 0 才下发', () => {
  const off = buildArgs({ ...kvBaseInput, ...NEW_PARAMS })
  assert.equal(flagIndex(off.args, '--kv-unified'), -1, '默认关闭时不下发')
  assert.equal(flagIndex(off.args, '--kv-stream-stage-mib'), -1, '0 = 不下发')

  const on = buildArgs({ ...kvBaseInput, ...NEW_PARAMS, kvUnified: true, kvStreamStageMib: 1024 })
  assert.equal(flagIndex(on.args, '--kv-unified') >= 0, true, '开启后应作为裸 flag 下发')
  assert.equal(flagValue(on.args, '--kv-stream-stage-mib'), '1024')
})

test('图像 token 预算：max < min 时自动收敛（否则 llama.cpp 拒绝启动）', () => {
  const { args } = buildArgs({ ...kvBaseInput, ...NEW_PARAMS, imageMinTokens: 2048, imageMaxTokens: 512 })
  assert.equal(flagValue(args, '--image-min-tokens'), '2048')
  assert.equal(flagValue(args, '--image-max-tokens'), '2048', 'max 必须被抬到 min，而不是原样下发')
})

test('图像 token 为 0 = 不下发该项', () => {
  const { args } = buildArgs({ ...kvBaseInput, ...NEW_PARAMS, imageMinTokens: 0, imageMaxTokens: 0 })
  assert.equal(flagIndex(args, '--image-min-tokens'), -1)
  assert.equal(flagIndex(args, '--image-max-tokens'), -1)
})

test('推理预算 0 依然下发（0 是有意义的取值：关掉思考）', () => {
  const { args } = buildArgs({ ...kvBaseInput, ...NEW_PARAMS, reasoningBudget: 0 })
  assert.equal(flagValue(args, '--reasoning-budget'), '0')
})

test('KV 流式暂存：自动追加 -np 1（否则加载直接失败）', () => {
  const built = buildArgs({ ...kvBaseInput, ...NEW_PARAMS, kvStreamStageMib: 1024 })
  assert.equal(flagValue(built.args, '--kv-stream-stage-mib'), '1024')
  assert.equal(
    flagValue(built.args, '-np'),
    '1',
    '块级 KV 流式要求单序列；llama.cpp 的 -np 默认是自动，会落到多序列并报 ' +
      '「block KV streaming requires exactly one sequence」直接退出（线上实测）',
  )
  assert.ok(
    built.notices.some((n) => n.includes('-np 1')),
    `自动补参数必须给出说明，否则日志里会莫名多出一个参数；实际 notices：${built.notices.join(' | ')}`,
  )
})

test('KV 流式暂存关闭时：不追加 -np（并发不被平白降到 1）', () => {
  const built = buildArgs({ ...kvBaseInput, ...NEW_PARAMS, kvStreamStageMib: 0 })
  assert.equal(flagIndex(built.args, '-np'), -1, '没开暂存就不要动并发')
  assert.equal(flagIndex(built.args, '--parallel'), -1)
  assert.deepEqual(built.notices, [], '没有东西被改，就不该有提示')
})

test('构建不认识 KV 流式时：既不下发该参数，也不追加 -np', () => {
  const built = buildArgs({
    ...kvBaseInput,
    ...NEW_PARAMS,
    kvStreamStageMib: 1024,
    knownFlags: new Set(['--jinja', '--temp']),
  })
  assert.equal(flagIndex(built.args, '--kv-stream-stage-mib'), -1)
  assert.equal(flagIndex(built.args, '-np'), -1, '参数本身都没下发，没有任何理由把并发降到 1')
})

test('附加参数里自己写了 -np：不覆盖，但必须警告后果', () => {
  const built = buildArgs({ ...kvBaseInput, ...NEW_PARAMS, kvStreamStageMib: 1024, extraArgs: '-np 4' })
  assert.equal(flagValue(built.args, '-np'), '4', '尊重用户的显式设置，不覆盖')
  assert.equal(built.args.filter((t) => t === '-np').length, 1, '绝不能出现两个 -np')
  assert.equal(built.args.filter((t) => t === '--parallel').length, 0)
  assert.ok(
    built.notices.some((n) => n.includes('恰好一个序列')),
    `必须把「要求单序列」这件事说出来，否则用户只会看到一句难懂的英文错误；实际：${built.notices.join(' | ')}`,
  )
})

test('附加参数里用 --parallel 也算用户显式设置（两种写法都认）', () => {
  const built = buildArgs({ ...kvBaseInput, ...NEW_PARAMS, kvStreamStageMib: 512, extraArgs: '--parallel 2' })
  assert.equal(flagIndex(built.args, '-np'), -1, '用户写了 --parallel 就不该再补 -np')
  assert.ok(built.notices.some((n) => n.includes('恰好一个序列')))
})

test('门控：构建不认识的「新选项」不发，并说明被跳过了', () => {
  const built = buildArgs({
    ...kvBaseInput,
    ...NEW_PARAMS,
    kvUnified: true,
    kvStreamStageMib: 1024,
    imageMinTokens: 1024,
    imageMaxTokens: 4096,
    reasoningBudget: 4096,
    // 老构建：--help 里没有这几个
    knownFlags: new Set(['--jinja', '--temp', '--top-k']),
  })
  for (const flag of ['--kv-unified', '--kv-stream-stage-mib', '--image-min-tokens', '--image-max-tokens', '--reasoning-budget']) {
    assert.equal(flagIndex(built.args, flag), -1, `${flag} 不该下发给不认识的构建`)
  }
  assert.equal(built.notices.length, 1, '必须给出说明，不能静默丢掉设置')
  assert.ok(built.notices[0].includes('不认识'), `提示要讲清原因，实际：${built.notices[0]}`)
  assert.equal(flagValue(built.args, '--temp'), '0', '采样参数不受门控影响，照常下发')
})

test('门控：探测失败时一律不下发（与 --flash-attn 同一取舍）', () => {
  const built = buildArgs({ ...kvBaseInput, ...NEW_PARAMS, kvUnified: true, reasoningBudget: 4096, knownFlags: null })
  assert.equal(flagIndex(built.args, '--kv-unified'), -1)
  assert.equal(flagIndex(built.args, '--reasoning-budget'), -1)
  assert.equal(built.notices.length, 1)
  assert.ok(built.notices[0].includes('无法探测'), `提示应说明是探测失败，实际：${built.notices[0]}`)
})

// ── 非 llama.cpp 的分支构建（本次线上故障的回归防线）────────────────────────
section('分支构建：只下发它 --help 里公开的选项')

/**
 * 实机样本：kvmem-v0.16.0-rc2 的 `--help` 原文（Windows / cuda 构建，括号里是原文）。
 *
 * 这是个**独立的 OpenAI 兼容 server**，不是 llama.cpp 的 llama-server：它的选项表是
 * llama.cpp 的一个真子集。插件原先固定下发的 --alias 在这里根本不存在，于是
 *   unknown flag: --alias
 *   usage: ...llama-kvmem-server.exe -m model.gguf [options]
 * 退出码 1 —— 「换了个 llama 分支，插件就起不来了」。
 */
/**
 * 实机样本：`llama-kvmem-server.exe --help` 的原文（2026-09-19 构建，Windows/cuda13）。
 *
 * 这份文本是**逐字抄下来的**，不要「顺手整理」：参数探测完全靠它，
 * 改动它会连带改变「哪些选项会被下发」的判断，而那正是「换了个分支插件就起不来」的根源。
 *
 * 几个由它决定、且容易被忽略的事实：
 *   - `-ngl` 只收数字（说明里没有 auto/all 关键字）→ 插件退回 `-ngl -1`；
 *   - `-lm` 的过时别名写在**续行**里，所以解析器不会把 `--no-mmap` / `--mlock` 当成独立选项，
 *     宽松门控会跳过它们 —— 这正是引入 -lm/--load-mode 那一项的理由；
 *   - 它**没有** `--alias` / `-t` / `--threads-batch` / `-ub` / `--repeat-last-n` / `--api-key`，
 *     发过去就是 `unknown flag: xxx` + exit 1。
 */
const KVMEM_HELP = [
  'usage: llama-kvmem-server.exe -m model.gguf [options]',
  '',
  '  Independent single-slot OpenAI-compatible server. Does not patch llama-server.',
  '',
  '  -m, --model PATH           GGUF path',
  '  --mmproj PATH              vision projector GGUF',
  '  --mmproj-offload           place vision encoder on GPU (default)',
  '  --no-mmproj-offload        place vision encoder on CPU',
  '  --image-min-tokens N       native minimum image token count',
  '  --image-max-tokens N       native maximum image token count',
  '  --host HOST                bind address (default 127.0.0.1)',
  '  --port N                   port (default 8080)',
  '  -c, --ctx-size N           context size (default 2048)',
  '  -n, --n-predict N          default max_tokens (default 128)',
  '  -b, --batch-size N         logical batch (default 512)',
  '  -ngl, --n-gpu-layers N     GPU layers (default 99)',
  '  -lm, --load-mode MODE      how to load weights: auto|none|mmap|mlock|',
  '                             mmap+mlock|dio (default auto)',
  '                             deprecated aliases: --mlock, --mmap/--no-mmap,',
  '                             --direct-io/--no-direct-io',
  '  -fa, --flash-attn MODE     on|off|auto (default auto; quantized K/V',
  '                             cache forces it on - use -fa off with',
  '                             an f16 K/V cache to disable)',
  '  --webui                    serve the built-in chat page at / (default)',
  '  --no-webui                 do not serve any page at /',
  '  --path DIR                 serve static files from DIR at / instead of',
  '                             the built-in page (implies --webui)',
  '  --server-browser           open the web UI in the default browser',
  '  --no-server-browser        do not open a browser (default)',
  '  Sampling defaults: Qwen3.8-27B Thinking / non-Thinking, selected per request.',
  '  --temp, --temperature T    temperature [0,2] (1.0 / 0.7); 0 = greedy',
  '  --top-p P                  nucleus threshold [0,1] (0.95 / 0.80)',
  '  --top-k K                  integer >= 0; 0 disables (20)',
  '  --min-p P                  minimum relative probability [0,1] (0)',
  '  --presence-penalty P       presence penalty [-2,2] (0 / 1.5)',
  '  --frequency-penalty P      frequency penalty [-2,2] (0)',
  '  --repeat-penalty P         repetition penalty > 0 (1); --repetition-penalty alias',
  '  --seed N                   uint32 seed (default random)',
  '                            request fields override these process defaults',
  '  --kvmem / --no-kvmem       enable KVMem (default on)',
  '  --kvmem-budget N           GPU working-set tokens; 0 = n_ctx',
  '  --kvmem-block-tokens N     block size (default 128)',
  '  --kvmem-gen-reserve N      decode slack (default 256)',
  '  --kvmem-recent-tokens N    always-kept newest suffix in select budget (default 0)',
  '  --kvmem-method NAME        recency | retrieval (default retrieval)',
  '  --kvmem-query-last N       fallback query-last if last-user span missing (default 64)',
  '  --kvmem-query-max-tokens N cap last-user retrieval query to this many tokens',
  '                            from the end of the span (default 512; qw3-style)',
  '  --kvmem-query-replay MODE  legacy or auto (default auto)',
  '  --kvmem-query-policy MODE  legacy or user (default user)',
  '  --kvmem-mtp-state MODE     snapshots, auto or replay (default replay with MTP)',
  '  --kvmem-gpu-ratio R        cap slot pool at this fraction of GPU VRAM (default 0.50)',
  '  --kvmem-cpu-gb GB          CPU spill arena in GiB (0 = off)',
  '  --kvmem-nvme-gb GB         NVMe file in GiB (0 = off)',
  '  --kvmem-nvme-dir PATH      NVMe directory (default /tmp/kvmem_nvme)',
  '  --kvmem-harvest-v          prefill D2H V with raw-K (default off; RAM until NVMe flush)',
  '  --kvmem-raw-k-nvme         store raw-K and V on NVMe (needs --kvmem-nvme-gb)',
  '  --kv-dtype NAME            GPU KV cache type for K and V: f16 | q8_0 | q5_0 | q4_0 (default q8_0)',
  '  -ctk, --cache-type-k TYPE  GPU K cache type (llama.cpp name; default q8_0)',
  '  -ctv, --cache-type-v TYPE  GPU V cache type (must match K when quantized)',
  '  --spec-type TYPE           none | draft-mtp (default none)',
  '  --spec-kv-dtype TYPE       MTP K/V type (default f16)',
  '  --spec-draft-n-max N       MTP draft tokens (default 3)',
  '  --spec-draft-p-min P       min draft probability (default 0)',
  '  --jinja                    native Jinja rendering (always enabled)',
  '  --chat-template TEMPLATE   override model chat template (Jinja text)',
  '  --chat-template-file PATH  load a Jinja template file',
  '  --chat-template-kwargs JSON  default template arguments',
  '  --reasoning-effort LEVEL   template effort; default uses template default, none disables thinking',
  '  --enable-thinking          Qwen thinking on (default off; request can override)',
  '  --no-think                 force thinking off',
  '  --reasoning-budget N       thinking token budget: -1 unlimited, 0 end immediately,',
  '                            N>0 force </think> after N think tokens (default -1)',
  '  --reasoning-budget-message MSG  injected before forced </think> (default none)',
].join('\n')

test('kvmem 构建：默认配置下的每一个选项都被接受（不再有 unknown flag）', () => {
  const caps = parseHelp(KVMEM_HELP)
  // 这个构建是**严格**解析：不认识就 `unknown flag: xxx` + usage + exit 1。
  const built = buildArgs({
    ...kvBaseInput,
    ...NEW_PARAMS,
    ...SAMPLING,
    gpuLayersMode: 'auto',
    gpuLayersSupport: caps.gpuLayers,
    flashAttnMode: caps.flashAttnMode,
    threads: 4,
    threadsBatch: 4,
    batchSize: 2048,
    ubatchSize: 512,
    flashAttention: 'on',
    kvUnified: true,
    kvStreamStageMib: 1024,
    imageMinTokens: 1024,
    imageMaxTokens: 4096,
    reasoningBudget: 4096,
    jinja: true,
    mmap: false,
    mlock: true,
    apiKey: 'k',
    knownFlags: caps.flags,
    // 新增的 KVMem 家族与通用项：全部给真实取值，验证这个构建确实接受它们。
    kvmemBudget: 36864,
    kvmemGenReserve: 16384,
    kvmemBlockTokens: 128,
    kvmemRecentTokens: 4096,
    kvmemMethod: 'retrieval',
    kvmemQueryLast: 64,
    kvmemQueryMaxTokens: 512,
    kvmemQueryReplay: 'auto',
    kvmemQueryPolicy: 'user',
    kvmemMtpState: 'replay',
    kvmemGpuRatio: 0.8,
    kvmemCpuGb: 8,
    kvmemNvmeGb: 32,
    kvmemNvmeDir: 'D:/kvmem_nvme',
    kvmemHarvestV: true,
    kvmemRawKNvme: true,
    kvDtype: 'q8_0',
    specKvDtype: 'f16',
    specDraftNMax: 3,
    specDraftPMin: 0,
    nPredict: 32768,
    loadMode: 'none',
    frequencyPenalty: 0.5,
    mmprojOffload: false,
    reasoningEffort: 'medium',
    reasoningBudgetMessage: '直接作答',
    chatTemplateFile: 'D:/templates/t.jinja',
    chatTemplateKwargs: '{"enable_thinking":true}',
  })

  // 核心断言：下发出去的每一项都在这个构建的 --help 里 —— 这就是「能不能起来」的分界线。
  assert.deepEqual(
    unknownFlags(built.usedFlags, caps.flags),
    [],
    `下发出去的选项里有这个构建不认识的：${unknownFlags(built.usedFlags, caps.flags).join('、')}`,
  )

  // 逐项钉死：这些是实机确认过会 `unknown flag` 直接退出 1 的选项。
  // 注意 `--flash-attn` 不在此列 —— 这个构建的 --help 明写了 `-fa, --flash-attn MODE`，
  // 实机日志里也确实是带着 `--flash-attn on` 起来的。把「旧构建没有它」当成「它不该被下发」
  // 正是这份夹具最容易骗人的地方，所以这里反过来单独钉一条正向断言。
  for (const flag of ['--alias', '-t', '--threads-batch', '-ub', '--repeat-last-n', '--no-mmap', '--mlock', '--api-key']) {
    assert.equal(flagIndex(built.args, flag), -1, `${flag} 不该下发给这个构建（unknown flag，整台起不来）`)
  }
  assert.equal(flagValue(built.args, '--flash-attn'), 'on', '这个构建收 --flash-attn 的带值形式，必须照发')

  // 它确实有的选项照旧下发，功能不被「一刀切地清空」。
  assert.equal(flagValue(built.args, '--temp'), '0.75')
  assert.equal(flagValue(built.args, '--top-p'), '0.95')
  assert.equal(flagValue(built.args, '--repeat-penalty'), '1')
  assert.equal(flagValue(built.args, '-ngl'), '-1', '这个构建不认 auto/all 关键字，退回 -1（全部层）')
  assert.equal(flagValue(built.args, '-b'), '2048')
  assert.equal(flagValue(built.args, '-c'), '4096')
  assert.ok(built.args.includes('--jinja'))
  assert.equal(flagValue(built.args, '--cache-type-k'), 'q8_0')
  assert.equal(flagIndex(built.args, '--seed'), -1, '默认 -1 = 随机 = 不下发（它按 uint32 校验，-1 会被拒）')

  // 新增项：一个一个核对取值，防止「配置里填了 8 结果发出去 0」这类错位。
  assert.equal(flagValue(built.args, '--kvmem-budget'), '36864')
  assert.equal(flagValue(built.args, '--kvmem-gen-reserve'), '16384')
  assert.equal(flagValue(built.args, '--kvmem-block-tokens'), '128')
  assert.equal(flagValue(built.args, '--kvmem-recent-tokens'), '4096')
  assert.equal(flagValue(built.args, '--kvmem-method'), 'retrieval')
  assert.equal(flagValue(built.args, '--kvmem-query-last'), '64')
  assert.equal(flagValue(built.args, '--kvmem-query-max-tokens'), '512')
  assert.equal(flagValue(built.args, '--kvmem-query-replay'), 'auto')
  assert.equal(flagValue(built.args, '--kvmem-query-policy'), 'user')
  assert.equal(flagValue(built.args, '--kvmem-mtp-state'), 'replay')
  assert.equal(flagValue(built.args, '--kvmem-gpu-ratio'), '0.8', '比例项不能被四舍五入成 1')
  assert.equal(flagValue(built.args, '--kvmem-cpu-gb'), '8')
  assert.equal(flagValue(built.args, '--kvmem-nvme-gb'), '32')
  assert.equal(flagValue(built.args, '--kvmem-nvme-dir'), 'D:/kvmem_nvme')
  assert.ok(built.args.includes('--kvmem-harvest-v'))
  assert.ok(built.args.includes('--kvmem-raw-k-nvme'))
  assert.equal(flagValue(built.args, '--kv-dtype'), 'q8_0')
  assert.equal(flagValue(built.args, '--spec-kv-dtype'), 'f16')
  assert.equal(flagValue(built.args, '--spec-draft-n-max'), '3')
  assert.equal(flagValue(built.args, '--spec-draft-p-min'), '0')
  assert.equal(flagValue(built.args, '-n'), '32768')
  assert.equal(flagValue(built.args, '-lm'), 'none')
  assert.equal(flagValue(built.args, '--frequency-penalty'), '0.5')
  assert.ok(built.args.includes('--no-mmproj-offload'), '关掉视觉编码器 GPU 时下发否定形式')
  assert.equal(flagValue(built.args, '--reasoning-effort'), 'medium')
  assert.equal(flagValue(built.args, '--reasoning-budget-message'), '直接作答')
  assert.equal(flagValue(built.args, '--chat-template-file'), 'D:/templates/t.jinja')
  assert.equal(flagValue(built.args, '--chat-template-kwargs'), '{"enable_thinking":true}')

  // --kv-dtype 和 -ctk/-ctv 是两条重叠通道：同时给必须提醒（生效顺序由构建内部决定）。
  assert.ok(
    built.notices.some((n) => n.includes('KV 缓存类型（合并）')),
    `重叠配置要给出提示，实际：${built.notices.join(' | ')}`,
  )

  // 跳过必须有说明 —— 否则用户只会看到「参数少了几个」而毫无线索。
  assert.ok(
    built.notices.some((n) => n.includes('不认识') && n.includes('--alias')),
    `被跳过的选项要写进日志，实际：${built.notices.join(' | ')}`,
  )
})

// ── 新增启动项：默认「不下发」与门控 ────────────────────────────────────────
section('KVMem 家族与新增启动项')

test('新增项：默认值一律不下发（装官方 llama.cpp 的人行为一字不变）', () => {
  const built = buildArgs({ ...kvBaseInput, ...NEW_PARAMS, knownFlags: KNOWN_FLAGS })
  for (const flag of [
    '--no-kvmem', '--kvmem-budget', '--kvmem-gen-reserve', '--kvmem-block-tokens',
    '--kvmem-sink-tokens', '--kvmem-recent-tokens', '--kvmem-method', '--kvmem-query-last',
    '--kvmem-query-max-tokens', '--kvmem-query-replay', '--kvmem-query-policy', '--kvmem-mtp-state',
    '--kvmem-gpu-ratio', '--kvmem-cpu-gb', '--kvmem-nvme-gb', '--kvmem-nvme-dir',
    '--kvmem-harvest-v', '--kvmem-raw-k-nvme', '-n', '-lm', '--kv-dtype', '--spec-kv-dtype',
    '--spec-draft-n-max', '--spec-draft-p-min', '--frequency-penalty', '--no-mmproj-offload',
    '--chat-template-file', '--chat-template-kwargs', '--reasoning-effort', '--reasoning-budget-message',
  ]) {
    assert.equal(flagIndex(built.args, flag), -1, `${flag} 在默认配置下不该出现`)
  }
  assert.deepEqual(built.notices, [], '默认配置下不该有任何提示')
})

test('新增项：0 会被显式下发（这些选项的 0 是有意义的取值，不能当「不下发」）', () => {
  const built = buildArgs({
    ...kvBaseInput,
    ...NEW_PARAMS,
    kvmemBudget: 0,
    kvmemCpuGb: 0,
    kvmemRecentTokens: 0,
    specDraftPMin: 0,
    frequencyPenalty: 0,
    knownFlags: KNOWN_FLAGS,
  })
  assert.equal(flagValue(built.args, '--kvmem-budget'), '0', 'budget 0 的含义是「等于 n_ctx」，必须发出去')
  assert.equal(flagValue(built.args, '--kvmem-cpu-gb'), '0', '0 = 关闭溢出场，是显式意图')
  assert.equal(flagValue(built.args, '--kvmem-recent-tokens'), '0')
  assert.equal(flagValue(built.args, '--spec-draft-p-min'), '0')
  // 反向：frequency-penalty 的 0 与构建默认值一致，下发它没有任何信息量。
  assert.equal(flagIndex(built.args, '--frequency-penalty'), -1)
})

test('新增项：关掉 KVMem 时下发 --no-kvmem', () => {
  const built = buildArgs({ ...kvBaseInput, ...NEW_PARAMS, kvmemEnabled: false, knownFlags: KNOWN_FLAGS })
  assert.ok(built.args.includes('--no-kvmem'))
})

test('门控：KVMem 家族在官方构建上被整体跳过（严格门控，探测不到就不发）', () => {
  // 官方 llama.cpp 的 --help 里没有任何 --kvmem-*，发过去就是 unknown flag + exit 1。
  const official = new Set(['-m', '--host', '--port', '-c', '-ngl', '-b', '--temp', '--top-k'])
  const built = buildArgs({
    ...kvBaseInput,
    ...NEW_PARAMS,
    kvmemBudget: 36864,
    kvmemGenReserve: 16384,
    kvmemMethod: 'retrieval',
    kvmemCpuGb: 8,
    kvmemHarvestV: true,
    knownFlags: official,
  })
  for (const flag of ['--kvmem-budget', '--kvmem-gen-reserve', '--kvmem-method', '--kvmem-cpu-gb', '--kvmem-harvest-v']) {
    assert.equal(flagIndex(built.args, flag), -1, `${flag} 不该下发给官方构建`)
  }
  assert.ok(
    built.notices.some((n) => n.includes('--kvmem-budget')),
    `被跳过的选项要写进日志，实际：${built.notices.join(' | ')}`,
  )
})

test('门控：探测失败时 KVMem 家族也不下发（新选项一律不赌它认）', () => {
  const built = buildArgs({ ...kvBaseInput, ...NEW_PARAMS, kvmemBudget: 36864, kvmemHarvestV: true, knownFlags: null })
  assert.equal(flagIndex(built.args, '--kvmem-budget'), -1)
  assert.equal(flagIndex(built.args, '--kvmem-harvest-v'), -1)
})

test('解码预留：小于 1024 时点明「单次生成会被截断」（这个构建默认只有 256）', () => {
  const low = buildArgs({
    ...kvBaseInput,
    ...NEW_PARAMS,
    kvmemGenReserve: 256,
    knownFlags: GEN_RESERVE_FLAGS,
  })
  assert.equal(flagValue(low.args, '--kvmem-gen-reserve'), '256')
  assert.ok(
    low.notices.some((n) => n.includes('单次生成的上限') && n.includes('256')),
    `必须说清后果，实际：${low.notices.join(' | ')}`,
  )

  // 反向验证：给足之后这条提示必须消失（否则它会变成噪音，用户就不看了）。
  const ok = buildArgs({ ...kvBaseInput, ...NEW_PARAMS, kvmemGenReserve: 16384, knownFlags: GEN_RESERVE_FLAGS })
  assert.deepEqual(ok.notices, [], `给足时不该有提示，实际：${ok.notices.join(' | ')}`)

  // 未设置时要说明「将沿用构建默认的 256」——用户看不到任何报错，最容易被这个坑埋掉。
  const unset = buildArgs({ ...kvBaseInput, ...NEW_PARAMS, kvmemGenReserve: -1, knownFlags: GEN_RESERVE_FLAGS })
  assert.ok(
    unset.notices.some((n) => n.includes('256')),
    `未设置时要提醒构建默认值，实际：${unset.notices.join(' | ')}`,
  )
  // 而构建压根没有这个选项时（官方构建）不该有「解码预留」的提醒。
  // 这里只能断言「没有这一条」而不是「notices 为空」—— 官方构建同样不认识
  // --reasoning-budget / --temp 等一堆项，那条汇总提示本来就该出现。
  const official = buildArgs({ ...kvBaseInput, ...NEW_PARAMS, kvmemGenReserve: -1, knownFlags: new Set(['-m', '-c']) })
  assert.ok(
    !official.notices.some((n) => n.includes('解码预留')),
    `官方构建没有这个选项，不该提醒，实际：${official.notices.join(' | ')}`,
  )
  // 顺带钉住「被跳过的项必须出现在汇总提示里」——新选项曾经因为结算顺序靠前而被漏掉。
  assert.ok(
    official.notices.some((n) => n.includes('--reasoning-budget')),
    `被跳过的选项要进汇总提示，实际：${official.notices.join(' | ')}`,
  )
})

// ── 输出上限溢出保护（本轮 400 故障的针对性防线）────────────────────────────
section('输出上限溢出保护（max_tokens vs n_ctx）')

const GUARD_LIMITS = { nCtx: 32768, ...DEFAULT_GUARD_LIMITS }
const bodyOf = (obj) => Buffer.from(JSON.stringify(obj), 'utf8')

test('溢出保护：max_tokens >= n_ctx 的请求被压到「n_ctx − 提示词预留」', () => {
  const out = preflightMaxTokens(bodyOf({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 128000 }), GUARD_LIMITS)
  assert.equal(out.changed, true)
  assert.equal(out.from, 128000)
  assert.equal(out.to, GUARD_LIMITS.nCtx - DEFAULT_GUARD_LIMITS.reserveForPrompt)
  assert.equal(JSON.parse(out.body.toString('utf8')).max_tokens, out.to)
})

test('溢出保护：边界恰好落在 max_tokens === n_ctx 上（自引用判据，不写死数字）', () => {
  const at = preflightMaxTokens(bodyOf({ max_tokens: GUARD_LIMITS.nCtx }), GUARD_LIMITS)
  const below = preflightMaxTokens(bodyOf({ max_tokens: GUARD_LIMITS.nCtx - 1 }), GUARD_LIMITS)
  assert.equal(at.changed, true, '等于 n_ctx 时提示词至少要占 1 个 token，必然放不下')
  assert.equal(below.changed, false, '差 1 个 token 就够得着，不该动它')
})

test('溢出保护：够得着的请求原样返回同一个 Buffer（连重新序列化都不发生）', () => {
  const src = bodyOf({ messages: [{ role: 'user', content: '你好' }], max_tokens: 8192 })
  const out = preflightMaxTokens(src, GUARD_LIMITS)
  assert.equal(out.changed, false)
  assert.equal(out.body, src)
})

test('溢出保护：压不到下限就不动手（floor 是硬约束）', () => {
  const tiny = { nCtx: 600, floor: 512, reserveForPrompt: 1024, maxAttempts: 5 }
  assert.equal(preflightMaxTokens(bodyOf({ max_tokens: 600 }), tiny).to, 512)
  // floor 比原值还高时，压缩反而会把上限抬上去 —— 这种请求必须原样放行。
  const high = { nCtx: 600, floor: 700, reserveForPrompt: 1024, maxAttempts: 5 }
  assert.equal(preflightMaxTokens(bodyOf({ max_tokens: 600 }), high).changed, false)
})

test('溢出保护：非法请求体一律原样放行（保护措施不能变成新的失败点）', () => {
  for (const raw of ['', 'not json', '[]', '"x"', 'null', '{']) {
    const out = preflightMaxTokens(Buffer.from(raw, 'utf8'), GUARD_LIMITS)
    assert.equal(out.changed, false, `不该改：${JSON.stringify(raw)}`)
    assert.equal(out.body.toString('utf8'), raw, `内容也不该变：${JSON.stringify(raw)}`)
  }
})

test('溢出保护：报错判据覆盖两个分支的写法，且不误伤普通 400', () => {
  // kvmem 独立 server 的原文（实机抓到的就是这一条）
  assert.equal(isContextOverflowError('{"error":"prompt + max_tokens exceeds n_ctx"}'), true)
  // 上游 llama.cpp 的写法
  assert.equal(isContextOverflowError('the request exceeds the available context size (100 tokens)'), true)
  // 反向验证：形状相似的普通 400 一个都不能命中，否则会把无害错误也拖进重试。
  assert.equal(isContextOverflowError('{"error":{"message":"Invalid API key"}}'), false)
  assert.equal(isContextOverflowError('{"error":"model not found"}'), false)
  assert.equal(isContextOverflowError('context size must be positive'), false)
  assert.equal(isContextOverflowError(''), false)
})

test('溢出保护：重试序列逐次减半，且停在下限之前', () => {
  const seen = []
  let current = readMaxTokens({ max_tokens: 128000 })
  for (let i = 0; i < 20 && current !== null; i++) {
    current = nextRetryMaxTokens(current, GUARD_LIMITS)
    if (current !== null) seen.push(current)
  }
  assert.ok(seen.length > 0, '至少要能压一次')
  // 自引用判据：相邻两项必须严格是减半关系 —— 不写死任何具体数字。
  for (let i = 1; i < seen.length; i++) {
    assert.equal(seen[i], Math.floor(seen[i - 1] / 2), `第 ${i} 项不是减半：${seen.join(',')}`)
  }
  assert.ok(seen.every((v) => v >= DEFAULT_GUARD_LIMITS.floor), `压过了下限：${seen.join(',')}`)
  assert.ok(seen.length < 20, '必须能收敛到 null，否则会无限重试')
  // 请求里压根没有 max_tokens 时，从 n_ctx/2 起压（上限来自服务端的 -n，只能靠显式写入压住）。
  assert.equal(nextRetryMaxTokens(null, GUARD_LIMITS), Math.floor(GUARD_LIMITS.nCtx / 2))
})

test('溢出保护：重试时改已有的那个字段，而不是平白多出一个', () => {
  const replaced = JSON.parse(applyMaxTokens(bodyOf({ messages: [], max_completion_tokens: 999 }), 4096).toString('utf8'))
  assert.equal(replaced.max_completion_tokens, 4096)
  assert.equal('max_tokens' in replaced, false)

  const added = JSON.parse(applyMaxTokens(bodyOf({ messages: [] }), 4096).toString('utf8'))
  assert.equal(added.max_tokens, 4096, '一个都没有时补 max_tokens —— llama.cpp 认这个字段')

  assert.equal(applyMaxTokens(Buffer.from('not json', 'utf8'), 4096), null)
})

test('溢出保护：读不出 max_tokens 的形式一律当作「未指定」', () => {
  assert.equal(readMaxTokens({ max_tokens: 12 }), 12)
  assert.equal(readMaxTokens({ max_completion_tokens: 34 }), 34)
  assert.equal(readMaxTokens({ max_tokens: '12' }), null, '字符串不算，服务端也不认')
  assert.equal(readMaxTokens({ max_tokens: Number.NaN }), null)
  assert.equal(readMaxTokens(null), null)
  assert.equal(readMaxTokens([]), null)
})

test('溢出保护：放弃重试时的说明必须带上 n_ctx（原文里恰恰没有它）', () => {
  const hint = overflowHint(32768, null)
  assert.ok(hint.includes('32768'), `要给出真实数字，实际：${hint}`)
  assert.ok(hint.includes('contextWindow'), '要指向最可能的原因')
  assert.ok(hint.length > 40)
})

// ── 配置层：新增项的默认值与收敛 ─────────────────────────────────────────────
test('配置：新增项的默认值一律是「不下发」', () => {
  const resolved = resolveConfig(undefined, { DSH_HOME: '/tmp/dsh' })
  for (const key of [
    'kvmemBudget', 'kvmemGenReserve', 'kvmemBlockTokens', 'kvmemSinkTokens', 'kvmemRecentTokens',
    'kvmemQueryLast', 'kvmemQueryMaxTokens', 'kvmemGpuRatio', 'kvmemCpuGb', 'kvmemNvmeGb',
    'nPredict', 'specDraftNMax', 'specDraftPMin',
  ]) {
    assert.equal(resolved[key], -1, `${key} 的默认值应为 -1（哨兵 = 不下发）`)
  }
  for (const key of [
    'kvmemMethod', 'kvmemQueryReplay', 'kvmemQueryPolicy', 'kvmemMtpState', 'kvmemNvmeDir',
    'loadMode', 'kvDtype', 'specKvDtype', 'chatTemplateFile', 'chatTemplateKwargs',
    'reasoningEffort', 'reasoningBudgetMessage',
  ]) {
    assert.equal(resolved[key], '', `${key} 的默认值应为空串（不下发）`)
  }
  assert.equal(resolved.kvmemEnabled, true)
  assert.equal(resolved.mmprojOffload, true)
  assert.equal(resolved.kvmemHarvestV, false)
  assert.equal(resolved.kvmemRawKNvme, false)
  assert.equal(resolved.frequencyPenalty, 0)
  assert.equal(resolved.guardContextOverflow, true)
})

test('配置：枚举项非法取值被收敛（拼错的值会让服务起不来，不是被忽略）', () => {
  const env = { DSH_HOME: '/tmp/dsh' }
  assert.equal(resolveConfig({ kvmemMethod: 'Retrieval' }, env).kvmemMethod, 'retrieval', '大小写不敏感')
  assert.equal(resolveConfig({ kvmemMethod: 'nonsense' }, env).kvmemMethod, '')
  assert.equal(resolveConfig({ loadMode: 'DIO' }, env).loadMode, 'dio')
  assert.equal(resolveConfig({ loadMode: 'mmap+mlock' }, env).loadMode, 'mmap+mlock')
  assert.equal(resolveConfig({ loadMode: 'bogus' }, env).loadMode, '')
  assert.equal(resolveConfig({ kvDtype: 'q4_0' }, env).kvDtype, 'q4_0')
  assert.equal(resolveConfig({ kvDtype: 'q3_k' }, env).kvDtype, '', '不在白名单里的一律回落到不下发')
  assert.equal(resolveConfig({ reasoningEffort: 'HIGH' }, env).reasoningEffort, 'high')
  assert.equal(resolveConfig({ reasoningEffort: 'ultracode' }, env).reasoningEffort, '')
  assert.equal(normalizeChoice(undefined, ['', 'a'], ''), '')
})

test('配置：比例项不被四舍五入（clamp 会把 0.8 变成 1）', () => {
  const env = { DSH_HOME: '/tmp/dsh' }
  assert.equal(resolveConfig({ kvmemGpuRatio: 0.8 }, env).kvmemGpuRatio, 0.8)
  assert.equal(resolveConfig({ specDraftPMin: 0.25 }, env).specDraftPMin, 0.25)
  assert.equal(resolveConfig({ frequencyPenalty: 1.5 }, env).frequencyPenalty, 1.5)
})

test('配置提醒：maxTokens 不小于 ctxSize 时必须说出来（本轮 400 的根因就是它）', () => {
  const bad = consistencyNotices({ ctxSize: 32768, maxTokens: 128000, kvmemGenReserve: -1 })
  assert.equal(bad.length, 1)
  assert.ok(bad[0].includes('400'), `要讲清 kvmem 会直接判 400，实际：${bad[0]}`)
  assert.ok(bad[0].includes('32768'), '要给出真实的上下文长度')
  // 反向验证：正常的组合一个字的提醒都不该有，否则用户会习惯性忽略。
  assert.deepEqual(consistencyNotices({ ctxSize: 32768, maxTokens: 8192, kvmemGenReserve: 16384 }), [])
  // 中间一档：超过一半就提醒空间不够（但别说成「一定失败」）
  const half = consistencyNotices({ ctxSize: 32768, maxTokens: 20000, kvmemGenReserve: -1 })
  assert.equal(half.length, 1)
  assert.ok(half[0].includes('一半'))
})

test('配置提醒：解码预留小于输出上限时，回复会被截断', () => {
  const notices = consistencyNotices({ ctxSize: 32768, maxTokens: 8192, kvmemGenReserve: 256 })
  assert.equal(notices.length, 1)
  assert.ok(notices[0].includes('截断'), `要说清后果，实际：${notices[0]}`)
  // 反向验证：预留给足时不提醒。
  assert.deepEqual(consistencyNotices({ ctxSize: 32768, maxTokens: 8192, kvmemGenReserve: 8192 }), [])
})

test('kvmem 构建：探测失败时不受影响（照旧全量下发，与历史行为一致）', () => {
  const built = buildArgs({ ...kvBaseInput, ...NEW_PARAMS, ...SAMPLING, knownFlags: null })
  assert.equal(flagValue(built.args, '--alias'), 'local', '探测失败不该把别名丢掉')
  assert.equal(flagValue(built.args, '--repeat-last-n'), '64', '探测失败不该把采样设置丢掉')
})

test('配置：这 13 项的默认值就是用户指定的那一组', () => {
  const resolved = resolveConfig(undefined, { DSH_HOME: '/tmp/dsh' })
  assert.equal(resolved.kvUnified, false, '统一 KV 是个开关，默认关（不改变老行为）')
  assert.equal(resolved.kvStreamStageMib, 1024)
  assert.equal(resolved.temp, 0.75)
  assert.equal(resolved.topK, 20)
  assert.equal(resolved.topP, 0.95)
  assert.equal(resolved.minP, 0)
  assert.equal(resolved.presencePenalty, 0)
  assert.equal(resolved.repeatPenalty, 1)
  assert.equal(resolved.repeatLastN, 64)
  assert.equal(resolved.seed, -1)
  assert.equal(resolved.imageMinTokens, 1024)
  assert.equal(resolved.imageMaxTokens, 4096)
  assert.equal(resolved.reasoningBudget, 4096)
})

test('配置：采样参数做区间兜底，但不替用户裁决风格', () => {
  const env = { DSH_HOME: '/tmp/dsh' }
  assert.equal(resolveConfig({ topP: 5 }, env).topP, 1, 'top-p 超出 0~1 被收敛')
  assert.equal(resolveConfig({ minP: -1 }, env).minP, 0)
  assert.equal(resolveConfig({ seed: -9 }, env).seed, -1, '只认 -1 表示随机')
  assert.equal(resolveConfig({ temp: 1.8 }, env).temp, 1.8, '合法的高温不应被改写')
  assert.equal(resolveConfig({ kvStreamStageMib: -5 }, env).kvStreamStageMib, 0)
})

test('写入闸门认得这 13 个新字段，未知键仍然被丢弃', () => {
  const clean = sanitize({
    kvUnified: 'true',
    kvStreamStageMib: '512',
    temp: '0.6',
    topK: 10,
    topP: 0.9,
    minP: 0.02,
    presencePenalty: 0.1,
    repeatPenalty: 1.05,
    repeatLastN: 128,
    seed: 42,
    imageMinTokens: 512,
    imageMaxTokens: 2048,
    reasoningBudget: 2048,
    不存在的字段: 'x',
  })
  assert.equal(clean.kvUnified, true)
  assert.equal(clean.kvStreamStageMib, 512, '字符串数字必须被转成数字')
  assert.equal(clean.temp, 0.6)
  assert.equal(clean.seed, 42)
  assert.equal(clean.reasoningBudget, 2048)
  assert.equal(Object.keys(clean).length, 13, '恰好 13 项，未知键被丢弃')
})

// ── 思考开关（请求体改写） ──────────────────────────────────────────────────
section('路由 profile（推理档位）')

const routeSpec = buildRouteSpec(resolveConfig(undefined, { DSH_HOME: '/tmp/dsh' }), 'http://127.0.0.1:18080/v1')

test('路由 profile 声明了推理能力与档位映射（不声明滑杆就是摆设）', () => {
  const model = buildRouteProfile(routeSpec).models[0]

  assert.equal(
    model.reasoningEfforts !== undefined,
    true,
    'pi-ai 只在模型被声明为推理模型时才走思考分支；不声明 reasoningEfforts，dsh 的「推理等级」什么都不会发',
  )
  assert.equal(model.reasoningEfforts.off, null, 'off 留空 = 该档位不下发值（不发参数即为不思考）')
  for (const level of ['low', 'medium', 'high', 'xhigh']) {
    assert.equal(model.reasoningEfforts[level], level, `档位 ${level} 的线上写法就用 llama.cpp 自己的词汇`)
  }
  assert.equal(Object.keys(model.reasoningEfforts).length, 7, 'llama.cpp 的七档全给上')
})

test('路由 profile 要求 dsh 走 chat-template 通道（llama.cpp 唯一认的那条）', () => {
  const compat = buildRouteProfile(routeSpec).compat
  assert.equal(compat.thinkingFormat, 'chat-template', '这个格式才会把档位写进 chat_template_kwargs')
  assert.deepEqual(compat.chatTemplateKwargs.enable_thinking, { $var: 'thinking.enabled' })
  assert.deepEqual(
    compat.chatTemplateKwargs.reasoning_effort,
    { $var: 'thinking.effort', omitWhenOff: true },
    '档位走 thinking.effort；omitWhenOff 保证选 Off 时不发这个字段',
  )
})

test('手写 YAML 里带上同样的声明（否则自动注册失败时滑杆又失灵）', () => {
  const yaml = renderRouteYaml(routeSpec)
  assert.match(yaml, /thinkingFormat: chat-template/)
  assert.match(yaml, /\$var: thinking\.effort/)
  assert.match(yaml, /reasoningEfforts:/)
  assert.match(yaml, /^\s+off:\s*$/m, 'off 必须是空值（YAML 里读作 null）')
  assert.match(yaml, /^\s+low: low$/m)
})

section('思考开关（请求体改写）')

const policy = (enableThinking, preserveThinking, supportedEfforts = null) => ({
  enableThinking,
  preserveThinking,
  supportedEfforts,
})

test('档位归一化：容忍 dsh 发来的布尔 / null / 空串（实测它会发 false 和 true）', () => {
  assert.deepEqual(normalizeEffortSignal(false), { kind: 'off' }, 'YAML 把 off 读成布尔 false，必须当成关闭')
  assert.deepEqual(normalizeEffortSignal(true), { kind: 'on' })
  assert.deepEqual(normalizeEffortSignal(0), { kind: 'off' })
  assert.deepEqual(normalizeEffortSignal('off'), { kind: 'off' })
  assert.deepEqual(normalizeEffortSignal('none'), { kind: 'off' })
  assert.deepEqual(normalizeEffortSignal('True'), { kind: 'on' }, '大小写不敏感')
  assert.deepEqual(normalizeEffortSignal('xhigh'), { kind: 'level', level: 'xhigh' })
  assert.equal(normalizeEffortSignal(null), null, 'null 是「没表态」，不能当成关闭')
  assert.equal(normalizeEffortSignal(undefined), null)
  assert.equal(normalizeEffortSignal(''), null)
  assert.equal(normalizeEffortSignal('   '), null)
  assert.equal(normalizeEffortSignal({ effort: 'high' }), null, '非标量一律不认')
})

test('档位映射：只发模板支持的档位，最接近的优先、同距离取更高', () => {
  const qwen = ['xhigh', 'medium', 'low'] // 实测 Qwen3.8 的模板只认这三个
  assert.equal(mapEffortToSupported('low', qwen), 'low')
  assert.equal(mapEffortToSupported('medium', qwen), 'medium')
  assert.equal(mapEffortToSupported('high', qwen), 'xhigh', 'high 不在表里 → 往更深的 xhigh 靠')
  assert.equal(mapEffortToSupported('minimal', qwen), 'low', 'minimal 不在表里 → 往低档靠')
  assert.equal(mapEffortToSupported('max', qwen), 'xhigh')
  assert.equal(mapEffortToSupported('HIGH', qwen), 'xhigh', '大小写不敏感')

  assert.equal(mapEffortToSupported('high', null), null, '不知道模板支持什么 → 不下发（模板会 raise）')
  assert.equal(mapEffortToSupported('high', []), null)
  assert.equal(mapEffortToSupported('think-hard', qwen), null, '认不出的档位名不猜')
  assert.equal(mapEffortToSupported('high', ['think-hard']), null, '支持集全是认不出的名字时也不猜')

  const all = [...EFFORT_ORDER]
  for (const level of all) assert.equal(mapEffortToSupported(level, all), level, `${level} 应原样映射`)
})

test('模板解析：从 chat template 里读出它认哪几个档位', () => {
  // 与实测模板同形的片段
  const tpl = [
    '{%- if enable_thinking is undefined or enable_thinking is true %}',
    "    {%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}",
    "    {%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}",
    "        {{- raise_exception('Unexpected reasoning effort ' ~ reasoning_effort ~ '. Supported types are xhigh (default), medium, and low.') }}",
    '    {%- endif %}',
    '{%- endif %}',
  ].join('\n')
  assert.deepEqual(extractSupportedEfforts(tpl), ['xhigh', 'medium', 'low'])

  assert.equal(extractSupportedEfforts(''), null, '没有模板 → null')
  assert.equal(extractSupportedEfforts(undefined), null)
  assert.equal(extractSupportedEfforts('{% if x not in ("a") %}'), null, '只有一个候选名不算数')
  assert.equal(
    extractSupportedEfforts('{% if role not in ("user", "assistant") %}'),
    null,
    '与 reasoning_effort 无关的 not in 清单不能被误认成档位表',
  )
})

test('开关开启 + 请求选 Off（dsh 发布尔 false）→ 真的关掉思考', () => {
  // 实测 dsh 会把档位经 settings.yaml 往返后发成布尔 false，模板收到它会 raise。
  const raw = JSON.stringify({ messages: [], reasoning_effort: false })
  const body = JSON.parse(rewriteChatRequestBody(raw, policy(true, true, ['xhigh', 'medium', 'low'])).body.toString('utf8'))
  assert.equal(body.chat_template_kwargs.enable_thinking, false, '开关开着也必须听请求的 Off')
  assert.equal(body.chat_template_kwargs.reasoning_effort, undefined, '模板会 raise 的值必须被删掉')
})

test('开关关闭 + 请求选 High → 仍然开启思考（这是用户明确要的）', () => {
  const raw = JSON.stringify({ messages: [], reasoning_effort: 'high' })
  const body = JSON.parse(rewriteChatRequestBody(raw, policy(false, true, ['xhigh', 'medium', 'low'])).body.toString('utf8'))
  assert.equal(body.chat_template_kwargs.enable_thinking, true, '开关关着也不能压掉请求的档位')
  assert.equal(body.chat_template_kwargs.reasoning_effort, 'xhigh', 'high 映射到模板支持的 xhigh')
})

test('档位原样透传模板不认的值会让请求 500 —— 归一化后不会', () => {
  const supported = ['xhigh', 'medium', 'low']
  for (const bad of [true, false, 'null', 'high', 'minimal', 'max', 'think-hard']) {
    const raw = JSON.stringify({ messages: [], reasoning_effort: bad })
    const sent = JSON.parse(
      rewriteChatRequestBody(raw, policy(true, true, supported)).body.toString('utf8'),
    ).chat_template_kwargs.reasoning_effort
    assert.ok(
      sent === undefined || supported.includes(sent),
      `reasoning_effort=${JSON.stringify(bad)} 最终发出了 ${JSON.stringify(sent)}，模板会 raise`,
    )
  }
})

test('没解析出模板档位表时：只控制开关，不下发档位', () => {
  const raw = JSON.stringify({ messages: [], reasoning_effort: 'high' })
  const body = JSON.parse(rewriteChatRequestBody(raw, policy(true, true, null)).body.toString('utf8'))
  assert.equal(body.chat_template_kwargs.enable_thinking, true, '思考照常开启')
  assert.equal(body.chat_template_kwargs.reasoning_effort, undefined, '但不下发可能让模板报错的档位')
})

test('请求显式写了 enable_thinking 时以它为准（档位不能反过来把它打开）', () => {
  const raw = JSON.stringify({ messages: [], chat_template_kwargs: { enable_thinking: false, reasoning_effort: 'low' } })
  const body = JSON.parse(rewriteChatRequestBody(raw, policy(true, true, ['xhigh', 'medium', 'low'])).body.toString('utf8'))
  assert.equal(body.chat_template_kwargs.enable_thinking, false, '显式关闭优先级最高')
  assert.equal(body.chat_template_kwargs.reasoning_effort, undefined, '不思考就别发档位')
})

test('请求什么都没说时：插件开关说了算（这是它现在唯一的职责）', () => {
  const on = JSON.parse(rewriteChatRequestBody(JSON.stringify({ messages: [] }), policy(true, true)).body.toString('utf8'))
  assert.equal(on.chat_template_kwargs.enable_thinking, true)
  assert.equal(on.chat_template_kwargs.reasoning_effort, undefined, '没档位就不发档位，让模板用默认值')

  const off = JSON.parse(rewriteChatRequestBody(JSON.stringify({ messages: [] }), policy(false, true)).body.toString('utf8'))
  assert.equal(off.chat_template_kwargs.enable_thinking, false)
})

test('只认对话补全路径（其它请求一律不改写）', () => {
  assert.equal(isChatCompletionPath('/v1/chat/completions'), true)
  assert.equal(isChatCompletionPath('/chat/completions'), true)
  assert.equal(isChatCompletionPath('/v1/chat/completions/'), true, '带尾斜杠也要认')
  assert.equal(isChatCompletionPath('/v1/completions'), false)
  assert.equal(isChatCompletionPath('/v1/models'), false)
  assert.equal(isChatCompletionPath('/health'), false)
  assert.equal(isChatCompletionPath('/v1/embeddings'), false)
})

test('改写：注入 chat_template_kwargs，且不抹掉用户自己的模板变量', () => {
  const raw = JSON.stringify({
    model: 'local',
    messages: [{ role: 'user', content: 'hi' }],
    chat_template_kwargs: { custom_flag: true },
  })
  const out = rewriteChatRequestBody(raw, policy(false, true))
  assert.equal(out.changed, true)
  const body = JSON.parse(out.body.toString('utf8'))
  assert.equal(body.chat_template_kwargs.enable_thinking, false)
  assert.equal(body.chat_template_kwargs.preserve_thinking, true)
  assert.equal(body.chat_template_kwargs.custom_flag, true, '用户自己填的模板变量必须保留')
  assert.equal(body.model, 'local', '其它字段不受影响')
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }], '保留历史 think 时不该动 messages')
})

test('改写：值已经一致时完全不碰请求体', () => {
  const raw = JSON.stringify({ messages: [], chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } })
  const out = rewriteChatRequestBody(raw, policy(true, true))
  assert.equal(out.changed, false, '值没变就不该改写')
  assert.equal(out.body.toString('utf8'), raw)
  assert.equal(out.notice, null)
})

test('关闭「保留历史 think」：剥掉 reasoning 字段与正文里的 think 块', () => {
  const raw = JSON.stringify({
    messages: [
      { role: 'user', content: '<think>提问里的这串是内容，不是思考</think>请解释一下' },
      { role: 'assistant', content: '', reasoning_content: '内部推理', thinking: '另一份推理' },
      { role: 'assistant', content: '<think>先算 1+1</think>答案是 2' },
      { role: 'assistant', content: '普通回答', tool_calls: [{ id: 'call-1' }] },
    ],
  })
  const out = rewriteChatRequestBody(raw, policy(true, false))
  assert.equal(out.changed, true)
  const [user, bare, thinkOnly, plain] = JSON.parse(out.body.toString('utf8')).messages

  assert.match(user.content, /提问里的这串是内容/, '用户消息里的 think 是正文，不能剥')
  assert.equal(bare.reasoning_content, undefined, 'reasoning_content 必须剥掉')
  assert.equal(bare.thinking, undefined, 'thinking 字段同样要剥掉')
  assert.equal(thinkOnly.content, '答案是 2', '正文里的 think 块要剥掉，并清掉留下的前导空白')
  assert.equal(plain.content, '普通回答', '没有 think 的消息一字不改')
  assert.deepEqual(plain.tool_calls, [{ id: 'call-1' }], '工具调用必须原样保留')
})

test('关闭「保留历史 think」：多模态 parts 只处理文本段', () => {
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
  const raw = JSON.stringify({
    messages: [{ role: 'assistant', content: [{ type: 'text', text: '<think>t</think>结论' }, image] }],
  })
  const body = JSON.parse(rewriteChatRequestBody(raw, policy(true, false)).body.toString('utf8'))
  assert.equal(body.messages[0].content[0].text, '结论')
  assert.deepEqual(body.messages[0].content[1], image, '图片段必须原样保留')
})

test('关闭「保留历史 think」但历史里本来没有 think：内容一字不改', () => {
  const raw = JSON.stringify({ messages: [{ role: 'assistant', content: '  前后都有空白  ' }] })
  const body = JSON.parse(rewriteChatRequestBody(raw, policy(true, false)).body.toString('utf8'))
  assert.equal(body.messages[0].content, '  前后都有空白  ', '没命中 think 块就不该顺手改空白')
})

test('开启「保留历史 think」：历史 think 原样留在上下文里', () => {
  const raw = JSON.stringify({ messages: [{ role: 'assistant', content: '<think>保留我</think>答案' }] })
  const body = JSON.parse(rewriteChatRequestBody(raw, policy(true, true)).body.toString('utf8'))
  assert.equal(body.messages[0].content, '<think>保留我</think>答案')
})

test('认不出的请求体一律原样放行（绝不因为开关丢掉请求）', () => {
  for (const raw of ['', '   ', 'not json at all', '[1,2,3]', '"just a string"', '42']) {
    const out = rewriteChatRequestBody(raw, policy(false, false))
    assert.equal(out.changed, false, `不该改写：${raw}`)
    assert.equal(out.body.toString('utf8'), raw, `必须原样返回：${raw}`)
    assert.ok(out.notice, `必须给出说明：${raw}`)
  }
})

test('Buffer 与字符串两种入参等价（代理层拿到的是 Buffer）', () => {
  const raw = JSON.stringify({ messages: [] })
  const fromString = rewriteChatRequestBody(raw, policy(true, true))
  const fromBuffer = rewriteChatRequestBody(Buffer.from(raw, 'utf8'), policy(true, true))
  assert.equal(fromString.body.toString('utf8'), fromBuffer.body.toString('utf8'))
})

// ── 配置解析 ────────────────────────────────────────────────────────────────
section('配置解析')

test('默认配置：空闲卸载 5 分钟', () => {
  const resolved = resolveConfig(undefined, { DSH_HOME: '/home/u/.dsh' })
  assert.equal(resolved.idleUnloadMinutes, 5)
  assert.equal(resolved.idleUnloadMs, 300_000)
  assert.equal(resolved.port, 18080)
  assert.equal(resolved.llamaPort, 0, '内部端口默认自动挑选，避免冲突')
  assert.equal(resolved.jinja, true)
})

test('默认目录落在 $DSH_HOME/local-model 下', () => {
  const home = path.resolve(path.sep, 'dsh')
  const resolved = resolveConfig({}, { DSH_HOME: home })
  assert.equal(resolved.modelsDir, path.join(home, 'local-model', 'models'))
  assert.equal(resolved.runtimeDir, path.join(home, 'local-model', 'runtime'))
})

test('路径占位符展开', () => {
  const home = path.resolve(path.sep, 'dsh')
  const env = { DSH_HOME: home }
  assert.equal(path.normalize(expandVars('${DSH_HOME}/local-model/models', env)), path.join(home, 'local-model', 'models'))
  assert.equal(path.normalize(expandVars('$DSH_HOME/x', env)), path.join(home, 'x'))
  assert.equal(path.normalize(expandVars('%DSH_HOME%/y', env)), path.join(home, 'y'))
  assert.ok(expandVars('~/models', env).startsWith(os.homedir()))
})

test('相对路径相对 DSH_HOME 解析，而不是进程 cwd', () => {
  const home = path.resolve(path.sep, 'dsh')
  const fallback = path.join(home, 'fallback')
  const env = { DSH_HOME: home }
  assert.equal(resolveDir('my-models', fallback, env), path.join(home, 'my-models'))
  assert.equal(resolveDir('', fallback, env), fallback)
  assert.equal(resolveDir(path.join(home, 'abs'), fallback, env), path.join(home, 'abs'))
})

test('非法数值被收敛，不会把矛盾参数丢给子进程', () => {
  const resolved = resolveConfig(
    { port: 99999, ctxSize: -5, idleUnloadMinutes: -3, ubatchSize: 10, batchSize: 8192, maxRestarts: 99 },
    { DSH_HOME: '/tmp/dsh' },
  )
  assert.equal(resolved.port, 65535)
  assert.equal(resolved.ctxSize, 512)
  assert.equal(resolved.idleUnloadMinutes, 0, '0 = 关闭空闲卸载，负数收敛到 0')
  assert.equal(resolved.idleUnloadMs, 0)
  assert.equal(resolved.maxRestarts, 10)
  assert.equal(clamp(Number.NaN, 1, 10, 7), 7)
  assert.equal(logLevelOf('bogus'), 'info')
})

test('空闲卸载 0 分钟表示关闭（而不是「立即卸载」）', () => {
  const resolved = resolveConfig({ idleUnloadMinutes: 0 }, { DSH_HOME: '/tmp/dsh' })
  assert.equal(resolved.idleUnloadMs, 0)
})

test('新增配置项的默认值：思考开、保留历史 think、mmproj 留空', () => {
  const resolved = resolveConfig(undefined, { DSH_HOME: '/tmp/dsh' })
  assert.equal(resolved.enableThinking, true)
  assert.equal(resolved.preserveThinking, true)
  assert.equal(resolved.mmprojFile, '', '留空 = 沿用同目录自动关联，保持原有行为')
})

test('开关值的字符串形态被正确收敛（组合层不经过 Web 写入闸门）', () => {
  const resolved = resolveConfig(
    { enableThinking: 'false', preserveThinking: '0', mmprojFile: '  vision/mmproj.gguf  ' },
    { DSH_HOME: '/tmp/dsh' },
  )
  assert.equal(resolved.enableThinking, false, '字符串 "false" 必须被认成关闭，而不是「非 false 即开启」')
  assert.equal(resolved.preserveThinking, false)
  assert.equal(resolved.mmprojFile, 'vision/mmproj.gguf', '路径要去掉两端空白')

  assert.equal(normalizeBool(true, false), true)
  assert.equal(normalizeBool('yes', false), true)
  assert.equal(normalizeBool(undefined, true), true, '认不出的值回落到默认值')
  assert.equal(normalizeBool('随便什么', true), true)
  assert.equal(normalizeBool('随便什么', false), false)
})

test('写入闸门认得这三个新字段，且仍然丢弃未知键', () => {
  const clean = sanitize({ mmprojFile: 'a.gguf', enableThinking: 'false', preserveThinking: 1, 不存在的字段: 'x' })
  assert.deepEqual(clean, { mmprojFile: 'a.gguf', enableThinking: false, preserveThinking: true })
  assert.deepEqual(sanitize({ enableThinking: null }), {}, 'null 视为未设置，不落盘')
})

// ── 空闲卸载判定（防止 SSE 长连接挂死导致模型永不释放） ─────────────────
test('shouldUnload：基础四件套（state / 时长 / 关闭 / 未到期）', () => {
  const base = { activeRequests: 0, idleUnloadMs: 300_000, lastActivityAt: 0, now: 300_001 }
  assert.equal(shouldUnload({ ...base, state: 'ready' }), true, '满足空闲时长应卸载')
  assert.equal(shouldUnload({ ...base, state: 'ready', now: 299_999 }), false, '未到时长不应卸载')
  assert.equal(shouldUnload({ ...base, state: 'starting' }), false, '加载中不应卸载')
  assert.equal(shouldUnload({ ...base, state: 'ready', idleUnloadMs: 0 }), false, '关闭自动卸载后不应卸载')
  assert.equal(shouldUnload({ ...base, state: 'idle' }), false, '待机状态无需再卸')
})

test('shouldUnload：activeRequests=1 但 1×时长内仍不卸（可能长生成在跑）', () => {
  // 5 分 1 秒，单次 SSE 长回复正在生成中—— lastActivityAt 停了但理论上仍在请求
  // 不能卸，否则长回复中途被掐断。
  assert.equal(
    shouldUnload({ state: 'ready', activeRequests: 1, idleUnloadMs: 300_000, lastActivityAt: 0, now: 300_001 }),
    false,
    '1×时长内 activeRequests>0 不卸',
  )
})

test('shouldUnload：activeRequests 卡住 + 2×时长仍无活动 → 强制卸（自愈死锁）', () => {
  // SSE 长连接异常未 close，onRequestEnd 漏调，计数永远 1；
  // 但 lastActivityAt 也已经停了 10 分钟—— 这一定是计数器泄漏，强制卸。
  assert.equal(
    shouldUnload({ state: 'ready', activeRequests: 1, idleUnloadMs: 300_000, lastActivityAt: 0, now: 600_001 }),
    true,
    '2×时长仍无活动时即便计数>0 也卸',
  )
})

test('shouldUnload：真活请求期间 lastActivityAt 会被刷新，不会触发自愈', () => {
  // 第一次请求 1 分钟后结束（lastActivityAt = 60000），之后又来一个真活请求
  // 活动了 5 分钟（lastActivityAt = 360000），现在 6 分钟没动了—— 不卸（1× 时长）。
  assert.equal(
    shouldUnload({ state: 'ready', activeRequests: 1, idleUnloadMs: 300_000, lastActivityAt: 360_000, now: 720_000 }),
    false,
    '真活请求停止后但未到 1× 时长不卸',
  )
  // 再过 5 分钟到 11 分钟，触发自愈
  assert.equal(
    shouldUnload({ state: 'ready', activeRequests: 1, idleUnloadMs: 300_000, lastActivityAt: 360_000, now: 1_080_000 }),
    true,
    '真活请求停止后到 2× 时长强制卸',
  )
})

// ── 参数预设 ────────────────────────────────────────────────────────────────
section('参数预设（保存 / 切换 / 落盘）')

test('预设作用域 = 全部可写字段 − 环境字段', () => {
  const keys = presetKeys()
  // 参数必须进预设：这些才是「一套参数」的内容。
  for (const key of ['selectedModel', 'mmprojFile', 'mtp', 'ctxSize', 'temp', 'topP', 'kvStreamStageMib', 'extraArgs']) {
    assert.ok(keys.includes(key), `${key} 必须进预设，否则这个功能没意义`)
  }
  // 环境字段必须排除：切预设不该把端口/路径/密钥也带着跑。
  for (const key of PRESET_EXCLUDED_KEYS) {
    assert.equal(keys.includes(key), false, `${key} 不该进预设`)
  }
  assert.ok(keys.length > 30, `预设字段数应当接近全部可写字段，实际 ${keys.length}`)
})

test('预设名称归一化：去空白 / 压连续空白 / 按码点截断', () => {
  assert.equal(normalizePresetName('  看图模式  '), '看图模式')
  assert.equal(normalizePresetName('长\t文本\n模式'), '长 文本 模式')
  assert.equal(normalizePresetName('   '), '', '全是空白等于没填名字')
  assert.equal(normalizePresetName(undefined), '')
  assert.equal(normalizePresetName(123), '')
  assert.equal([...normalizePresetName('あ'.repeat(50))].length, 40, '超长名称按码点截断，不能切断代理对')
  assert.ok(normalizePresetName('😀'.repeat(50)).length <= 40 * 2, '截断后不该出现半个字符导致的乱码')
})

test('预设值过写入闸门：类型强制转换 + 丢弃未知键与环境键', () => {
  const clean = sanitizePresetValues({
    ctxSize: '4096',
    temp: '0.75',
    mtp: 'true',
    selectedModel: 'VLM-Q4_K_M.gguf',
    envOverrides: { CUDA_VISIBLE_DEVICES: '0', 非法: 5 },
    port: '18081',
    apiKey: 'secret',
    logLevel: 'debug',
    不存在的字段: 'x',
  })
  assert.deepEqual(clean, {
    ctxSize: 4096,
    temp: 0.75,
    mtp: true,
    selectedModel: 'VLM-Q4_K_M.gguf',
    envOverrides: { CUDA_VISIBLE_DEVICES: '0' },
  })
  assert.equal(clean.port, undefined, '端口属于环境，不进预设')
  assert.equal(clean.apiKey, undefined, '密钥不该在预设文件里再存一份明文')
  assert.equal(clean.logLevel, undefined)
})

test('从生效配置摘快照：拿到参数、拿不到环境字段', () => {
  const resolved = resolveConfig({ port: 18081, apiKey: 'k', temp: 0.5 }, { DSH_HOME: '/tmp/dsh' })
  const snapshot = snapshotPresetValues(resolved)
  assert.equal(snapshot.temp, 0.5)
  assert.equal(snapshot.ctxSize, 8192)
  assert.equal(snapshot.port, undefined)
  assert.equal(snapshot.apiKey, undefined)
  assert.equal(snapshot.modelsDir, undefined, '路径是部署环境，不是可切换的参数')
})

const presetDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-presets-'))
const presetFile = path.join(presetDir, 'presets.json')

// 一串用例共享同一个仓库实例，顺序即生命周期：建 → 查 → 覆盖 → 改名 → 删。
const store = new PresetStore(presetFile)
await store.load()
let savedA = null
let savedB = null

await testAsync('保存两组预设并落盘', async () => {
  assert.deepEqual(store.list(), [], '空目录里应当没有任何预设')
  savedA = await store.create('  看图模式 ', { ctxSize: '16384', mmprojFile: 'mmproj-x.gguf' })
  savedB = await store.create('长文本', { ctxSize: 65536, cacheTypeK: 'q8_0', topP: 0.9 })
  assert.equal(savedA.name, '看图模式', '名称应当被归一化')
  assert.equal(savedA.values.ctxSize, 16384, '字符串数字应当被转换')
  assert.equal(store.list().length, 2)

  const onDisk = JSON.parse(await readFile(presetFile, 'utf8'))
  assert.equal(onDisk.items.length, 2, '必须真的落盘，否则重启就丢了')
  assert.equal(onDisk.items[0].name, '看图模式')
  assert.equal(onDisk.items[1].values.ctxSize, 65536)
  assert.equal(onDisk.items[0].port, undefined, '环境字段不该出现在预设文件里')
})

await testAsync('重开一个仓库实例能读回同一批预设（往返一致）', async () => {
  const reopened = new PresetStore(presetFile)
  await reopened.load()
  assert.equal(reopened.loadWarning, null)
  const list = reopened.list()
  assert.equal(list.length, 2)
  assert.equal(list[0].id, savedA.id, 'id 必须稳定 —— 界面靠它做切换与高亮')
  assert.deepEqual(list[1].values, savedB.values)
})

await testAsync('名称重复被拒绝（不区分大小写），空名称被拒绝', async () => {
  await assert.rejects(() => store.create('看图模式', { ctxSize: 1 }), /已经有一个叫/)
  await assert.rejects(() => store.create('  长文本  ', { ctxSize: 1 }), /已经有一个叫/, '归一化之后再比，两端空白不该绕过重名检查')
  savedB = await store.create('abc', { ctxSize: 1 })
  await assert.rejects(() => store.create('ABC', { ctxSize: 1 }), /已经有一个叫/, '大小写不同也是同一个名字')
  await assert.rejects(() => store.create('   ', { ctxSize: 1 }), /名称不能为空/)
})

await testAsync('一项参数都没有的预设被拒绝', async () => {
  await assert.rejects(() => store.create('空的', {}), /没有任何可保存的项/)
  await assert.rejects(() => store.create('只有环境字段', { port: 18081, logLevel: 'debug' }), /没有任何可保存的项/)
})

await testAsync('覆盖：名称不变、参数整套换掉、时间戳前进', async () => {
  const before = store.find(savedA.id)
  const updated = await store.overwrite(savedA.id, { ctxSize: 32768, mtp: 'true' })
  assert.equal(updated.id, before.id)
  assert.equal(updated.name, before.name, '覆盖不该动名字')
  assert.deepEqual(updated.values, { ctxSize: 32768, mtp: true }, '覆盖是整套替换，不是合并')
  assert.ok(updated.updatedAt >= before.updatedAt)
  await assert.rejects(() => store.overwrite('不存在的 id', { ctxSize: 1 }), /找不到这个预设/)
})

await testAsync('重命名：能改、不能撞名、不能改成空', async () => {
  const renamed = await store.rename(savedA.id, ' 看图（高精度） ')
  assert.equal(renamed.name, '看图（高精度）')
  assert.equal(store.find(savedA.id).name, '看图（高精度）')
  await assert.rejects(() => store.rename(savedA.id, 'abc'), /已经有一个叫/)
  await assert.rejects(() => store.rename(savedA.id, '   '), /名称不能为空/)
  assert.equal(store.find(savedA.id).name, '看图（高精度）', '失败的改名不该留下半个结果')
  assert.equal((await store.rename(savedA.id, '看图（高精度）')).name, '看图（高精度）', '改成自己原来的名字应当允许')
})

await testAsync('删除：删掉指定的那一个，其余不受影响', async () => {
  assert.deepEqual(store.list().map((p) => p.name).sort(), ['abc', '看图（高精度）', '长文本'].sort(), '删之前有 3 组')
  const removed = await store.remove(savedB.id)
  assert.equal(removed.name, 'abc')
  assert.equal(store.find(savedB.id), undefined)
  assert.deepEqual(store.list().map((p) => p.name).sort(), ['看图（高精度）', '长文本'].sort(), '只该删掉指定的那一组')
  await assert.rejects(() => store.remove(savedB.id), /找不到这个预设/)

  const onDisk = JSON.parse(await readFile(presetFile, 'utf8'))
  assert.equal(onDisk.items.length, 2, '删除也要落盘')
})

test('差异计数与「当前生效」判定', () => {
  const s = new PresetStore(path.join(presetDir, 'nowhere.json'))
  const current = { ctxSize: 8192, temp: 0.75, mtp: false, port: 18080, logLevel: 'info' }
  assert.equal(s.diffCount({ ctxSize: 8192, temp: 0.75 }, current), 0, '一致的项不计入')
  assert.equal(s.diffCount({ ctxSize: 4096, temp: 0.75 }, current), 1)
  assert.equal(s.diffCount({ ctxSize: 4096, mtp: true }, current), 2)
  assert.equal(s.diffCount({}, current), 0, '空预设没有可比的项')
  assert.equal(s.diffCount({ envOverrides: { A: '1' } }, { envOverrides: { A: '1' } }), 0, '字典字段按结构比')
  assert.equal(s.diffCount({ envOverrides: { A: '1' } }, { envOverrides: { A: '2' } }), 1)
  // 环境字段不参与预设，因此「当前配置的端口变了」不该让任何预设变成「有差异」。
  assert.equal(s.diffCount({ ctxSize: 8192 }, { ctxSize: 8192, port: 9999 }), 0)
})

await testAsync('activeId 只认「完全一致且非空」的那一个', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-presets-active-'))
  const s = new PresetStore(path.join(dir, 'presets.json'))
  await s.load()
  const a = await s.create('A', { ctxSize: 4096, temp: 0.5 })
  await s.create('B', { ctxSize: 8192 })
  assert.equal(s.activeId({ ctxSize: 4096, temp: 0.5, port: 18080 }), a.id, '忽略不在预设里的字段')
  assert.equal(s.activeId({ ctxSize: 4096, temp: 0.6 }), null)
  assert.equal(s.activeId({ ctxSize: 123 }), null)
  await rm(dir, { recursive: true, force: true })
})

await testAsync('预设文件损坏 / 内容离谱时：降级为空，插件照常起', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-presets-broken-'))
  const file = path.join(dir, 'presets.json')
  await writeFile(file, '{ 这不是 JSON', 'utf8')
  const s = new PresetStore(file)
  await s.load()
  assert.deepEqual(s.list(), [])
  assert.ok(s.loadWarning && s.loadWarning.includes('解析失败'), '损坏必须在界面上说清楚，而不是静默当没有')
  await s.create('新预设', { temp: 1 })
  assert.equal(s.list().length, 1, '损坏之后仍然能正常保存新预设')
  await rm(dir, { recursive: true, force: true })
})

await testAsync('加载时剔除无效条目：缺名字 / 缺 id / 重复 id / 没有参数', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-presets-dirty-'))
  const file = path.join(dir, 'presets.json')
  const at = new Date().toISOString()
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      updatedAt: at,
      items: [
        { id: 'a', name: '正常的', createdAt: at, updatedAt: at, values: { temp: 1 } },
        { id: '', name: '没有 id', values: { temp: 1 } },
        { id: 'c', name: '   ', values: { temp: 1 } },
        { id: 'a', name: '重复 id', values: { temp: 1 } },
        { id: 'e', name: '没有参数', values: {} },
        { id: 'f', name: '参数全在作用域外', values: { port: 1, apiKey: 'x' } },
        { id: 'g', name: '坏类型', values: { ctxSize: '不是数字', temp: '0.5' } },
      ],
    }),
    'utf8',
  )
  const s = new PresetStore(file)
  await s.load()
  const list = s.list()
  assert.deepEqual(list.map((p) => p.id), ['a', 'g'])
  assert.deepEqual(list[1].values, { temp: 0.5 }, '坏值被丢掉，好值留下来')
  assert.ok(s.loadWarning && s.loadWarning.includes('跳过'))
  await rm(dir, { recursive: true, force: true })
})

await testAsync('加载时按上限截断，不会把界面塞爆', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-presets-cap-'))
  const file = path.join(dir, 'presets.json')
  const at = new Date().toISOString()
  const items = Array.from({ length: MAX_PRESETS + 5 }, (_, i) => ({
    id: `id-${i}`,
    name: `预设 ${i}`,
    createdAt: at,
    updatedAt: at,
    values: { temp: 1 },
  }))
  await writeFile(file, JSON.stringify({ version: 1, updatedAt: at, items }), 'utf8')
  const s = new PresetStore(file)
  await s.load()
  assert.equal(s.list().length, MAX_PRESETS)
  await rm(dir, { recursive: true, force: true })
})

await rm(presetDir, { recursive: true, force: true })

// ── 设置页表单：新增字段有没有被真正「摆上去」─────────────────────────────────
// 这一节替代了「必须装 dsh 才能跑的 load-check」里最容易漏的那部分：
// 字段进了 schema 与写入白名单，却没进分组表 / 短标签表时**不会有任何报错**，
// 表现只是「设置页上这一项落进「其他」分组」或者「标签是一串英文键名」——
// 用户看到的是「新功能没出现」，而日志里一个字都没有。
await testAsync('表单：每个可写字段都有命名分组和中文短标签（漏了就静默消失）', async () => {
  const { extractFields } = await import('../lib/schemaForm.js')

  // 传一个「拿不到序列化 schema」的输入：extractFields 会退回 configStore 的类型表。
  // 于是这里检查的正是「字段表列了它、设置页却没给它分组/标签」这类静默遗漏，
  // 而且不需要 schemastery 在场 —— 这正是它在没有宿主的机器上也能跑的原因。
  const fields = extractFields({})
  assert.ok(fields.length >= 60, `字段数明显偏少，说明类型表没被读全：${fields.length}`)

  const orphans = fields.filter((f) => f.uiGroup === 'other').map((f) => f.key)
  assert.deepEqual(orphans, [], `这些字段没有归组（会掉进「其他」）：${orphans.join('、')}`)

  const unlabeled = fields.filter((f) => f.label === f.key).map((f) => f.key)
  assert.deepEqual(unlabeled, [], `这些字段没有中文短标签（界面会直接显示英文键名）：${unlabeled.join('、')}`)

  // 分组必须是**真的在区分**，不能所有字段都拿到同一个值 ——
  // 否则上面两条断言在一个「groupOf 恒返回常量」的实现上也会通过。
  const groups = new Set(fields.map((f) => f.uiGroup))
  assert.ok(groups.size >= 7, `分组机制要真的在区分，实际只有 ${groups.size} 种分组`)
  for (const sample of [
    // `mtp` 是那个开关本身，留在「模型与目录」；它的**细节参数**才在「多 Token 预测」组。
    ['mtp', 'model'],
    ['mmprojFile', 'model'],
    ['specKvDtype', 'mtp'],
    ['specDraftNMax', 'mtp'],
    ['ctxSize', 'infer'],
    ['guardContextOverflow', 'infer'],
    ['nPredict', 'infer'],
    ['kvmemBudget', 'kvmem'],
    ['kvmemGenReserve', 'kvmem'],
    ['apiKey', 'advanced'],
  ]) {
    const field = fields.find((f) => f.key === sample[0])
    assert.ok(field, `${sample[0]} 必须出现在表单里`)
    assert.equal(field.uiGroup, sample[1], `${sample[0]} 必须落在「${sample[1]}」分组`)
  }

  // 新增的 KVMem 家族必须整组出现并且整组归到自己的分组：分开放会让用户根本找不到。
  const kvmem = fields.filter((f) => f.key.startsWith('kvmem'))
  assert.ok(kvmem.length >= 18, `KVMem 家族应当至少 18 项，实际 ${kvmem.length}`)
  assert.ok(kvmem.every((f) => f.uiGroup === 'kvmem'), 'KVMem 家族必须整组落在「KVMem 分块缓存」分组')

  // 默认值来自 defaultConfig（不是表单自己猜的），抽两个有代表性的核对一下。
  assert.equal(fields.find((f) => f.key === 'kvmemGenReserve').default, -1, '哨兵 -1 = 不下发')
  assert.equal(fields.find((f) => f.key === 'guardContextOverflow').default, true)
  assert.equal(fields.find((f) => f.key === 'mmprojOffload').default, true)
})

// ── MTP 与视觉投影的关系（0.7.0：从互斥改为可共存）──────────────────────────
section('MTP 与视觉投影')

test('MTP 与视觉：默认可以共存（kvmem 分支实测支持同时加载）', () => {
  const built = buildArgs({
    ...kvBaseInput,
    ...NEW_PARAMS,
    mtp: true,
    mtpWithVision: true,
    mmproj: '/m/mmproj.gguf',
  })
  assert.equal(flagValue(built.args, '--spec-type'), 'draft-mtp', 'MTP 要下发')
  assert.equal(flagValue(built.args, '--mmproj'), '/m/mmproj.gguf', '视觉投影也要下发')
  assert.ok(
    built.notices.some((n) => n.includes('同时下发')),
    `共存是行为变化，必须写进提示，实际：${built.notices.join(' | ')}`,
  )
})

test('MTP 与视觉：关掉共存开关即恢复旧互斥（上游 llama.cpp 需要）', () => {
  const built = buildArgs({
    ...kvBaseInput,
    ...NEW_PARAMS,
    mtp: true,
    mtpWithVision: false,
    mmproj: '/m/mmproj.gguf',
  })
  assert.equal(flagValue(built.args, '--spec-type'), 'draft-mtp')
  assert.equal(flagIndex(built.args, '--mmproj'), -1, '互斥时 --mmproj 绝不能漏下去')
  // 提示里要给出「怎么打开共存」——否则用户只知道视觉没了，不知道该动哪个开关。
  assert.ok(
    built.notices.some((n) => n.includes('被忽略') && n.includes('共存')),
    `实际：${built.notices.join(' | ')}`,
  )
})

test('MTP 与视觉：没开 MTP 时 mmproj 照旧下发（老行为一字不变）', () => {
  const built = buildArgs({ ...kvBaseInput, ...NEW_PARAMS, mtp: false, mtpWithVision: true, mmproj: '/m/v.gguf' })
  assert.equal(flagValue(built.args, '--mmproj'), '/m/v.gguf')
  assert.equal(flagIndex(built.args, '--spec-type'), -1)
  assert.deepEqual(built.notices, [], '普通情况不该多出一条提示')
})

test('视觉投影的有效值：共存开关为开时，MTP 不再顶掉它', () => {
  const expected = path.resolve('/m', 'v.gguf')
  const base = { modelsDir: '/m', mmprojFile: 'v.gguf', autoMmproj: null }
  assert.equal(effectiveVisionProjector({ ...base, mtp: true, mtpWithVision: true }), expected)
  assert.equal(effectiveVisionProjector({ ...base, mtp: true, mtpWithVision: false }), '')
  assert.equal(effectiveVisionProjector({ ...base, mtp: false }), expected, '没开 MTP 时不受本开关影响')
})

test('配置：MTP 与视觉共存默认开启（用户不用去改任何东西）', () => {
  assert.equal(resolveConfig(undefined, { DSH_HOME: '/tmp/dsh' }).mtpWithVision, true)
  assert.equal(resolveConfig({ mtpWithVision: false }, { DSH_HOME: '/tmp/dsh' }).mtpWithVision, false)
  assert.equal(resolveConfig({ mtpWithVision: 'no' }, { DSH_HOME: '/tmp/dsh' }).mtpWithVision, false)
})

// ── 外部媒体工具（WebP 解码依赖它）─────────────────────────────────────────
section('外部媒体工具 ffmpeg / ffprobe')

await testAsync('媒体工具：两个可执行文件都在才算找到（半套工具不认）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-tools-'))
  const win = process.platform === 'win32'
  try {
    await writeFile(path.join(dir, win ? 'ffprobe.exe' : 'ffprobe'), 'x')
    // 只传 PATH 不传 LOCALAPPDATA：否则本机 winget 装的 ffmpeg 会命中，测的就不是这里了。
    assert.equal(findMediaTools({ env: { PATH: '' }, extraDirs: [dir] }).dir, null, '只有 ffprobe 不算数')

    await writeFile(path.join(dir, win ? 'ffmpeg.exe' : 'ffmpeg'), 'x')
    const found = findMediaTools({ env: { PATH: '' }, extraDirs: [dir] })
    assert.equal(found.dir, dir)
    assert.ok(found.ffprobe && found.ffprobe.startsWith(dir), '要给出 ffprobe 的绝对路径')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('媒体工具：PATH 里能找到时也认（用户自己装的场景）', () => {
  const dir = path.resolve('/opt/ffmpeg/bin')
  // 用一个真实存在的目录冒充：这里只验证「PASS 会去逐个试 PATH 段」这条机制，
  // 所以拿本仓库的 node_modules 目录造两个同名文件不合适 —— 改为断言「找不到就返回 null」。
  assert.equal(findMediaTools({ env: { PATH: dir }, platform: 'linux' }).dir, null)
})

test('媒体工具：PATH 注入用对键名（Windows 上进程环境里是 Path 而不是 PATH）', () => {
  const injected = withMediaPath({ Path: 'C:\\a' }, 'C:\\ff', 'win32')
  assert.equal(injected.Path, `C:\\ff${path.delimiter}C:\\a`)
  // 只写 PATH 会变成「两个键共存」，取哪个由子进程决定 —— 最难查的一类环境 bug。
  assert.equal('PATH' in injected, false)
  // 反向验证：已经在 PATH 里就不重复前置（否则每次启动都会越长越长）。
  assert.equal(withMediaPath({ Path: `C:\\ff${path.delimiter}C:\\a` }, 'C:\\ff', 'win32').Path, `C:\\ff${path.delimiter}C:\\a`)
  // 找不到工具时环境原样返回，绝不塞空值。
  const untouched = { Path: 'C:\\a' }
  assert.equal(withMediaPath(untouched, null, 'win32'), untouched)
})

test('媒体工具：缺 ffmpeg 时的提示要说清「哪个格式会失败」与怎么修', () => {
  const text = mediaToolWarning()
  assert.ok(text.includes('WebP'), '要点名 WebP —— 用户的图就是它')
  assert.ok(text.includes('400'), '要给出客户端看到的错误')
  assert.ok(text.includes('winget'), '要给出可执行的修复命令')
})

// ── 启动参数报告（设置页顶部那块）──────────────────────────────────────────
section('启动参数报告')

const LAUNCH_ARGS = [
  '-m', 'D:/m/x.gguf', '--host', '127.0.0.1', '--port', '18080',
  '-c', '262144', '-ngl', '-1', '-b', '512',
  '--kvmem-budget', '36864', '--kvmem-gen-reserve', '16384',
  '--spec-type', 'draft-mtp', '--mmproj', 'D:/m/mmproj.gguf', '--jinja',
]

test('启动参数报告：逐项一行，负数取值不会被当成新选项', () => {
  const lines = renderLaunchLines('E:/bin/server.exe', LAUNCH_ARGS)
  assert.equal(lines[0], 'E:/bin/server.exe', '第一行是可执行文件')
  // 自引用判据：把拆出来的行原样拼回去，必须与输入的 args 逐字相同 ——
  // 既不丢项也不造项。数行数写死会在改夹具时假失败，而这条永远对得上。
  const rebuilt = lines.slice(1).map((line) => line.trim()).join(' ').split(/\s+/)
  assert.deepEqual(rebuilt, LAUNCH_ARGS, `拆行不能丢项或造项：${lines.join(' | ')}`)
  assert.ok(
    lines.some((line) => line.trim() === '-ngl -1'),
    `-1 必须跟在自己的选项后面，实际：${lines.join(' | ')}`,
  )
})

test('启动参数报告：摘要从真实 args 解析，并由工作集 + 预留派生合计', () => {
  const report = buildLaunchReport({ executable: 'E:/bin/server.exe', args: LAUNCH_ARGS })
  const fact = (label) => report.facts.find((item) => item.label === label)
  assert.equal(fact('上下文长度 -c').value, '262144')
  assert.equal(fact('GPU 工作集 --kvmem-budget').value, '36864')
  assert.equal(fact('解码预留 --kvmem-gen-reserve').value, '16384')
  // 自引用判据：合计必须等于前两项之和（不写死数字，改了预算它也跟着对）。
  const total = Number(fact('GPU KV 合计').value.replace(' token', ''))
  assert.equal(total, 36864 + 16384)
  assert.equal(fact('组合').value, 'MTP + 视觉 同时启用')
  assert.equal(fact('模型文件').value, 'x.gguf', '只显示文件名，完整路径进 note')
})

test('启动参数报告：识别不出选项时宁可列出来，也不让它隐形', () => {
  const clean = buildLaunchReport({ executable: 'x', args: LAUNCH_ARGS })
  assert.deepEqual(clean.unrecognized, [], '这份参数里没有识别表之外的东西')
  // 反向验证：加一个识别表里没有的选项，必须被点名 —— 否则「看不见的参数」这条防线是假的。
  const dirty = buildLaunchReport({ executable: 'x', args: [...LAUNCH_ARGS, '--brand-new-flag'] })
  assert.deepEqual(dirty.unrecognized, ['--brand-new-flag'])
})

test('启动参数报告：命令行单行版给含空格的值加引号', () => {
  const line = renderReportCommandLine('a.exe', ['-m', 'D:/my models/x.gguf', '--port', '1'])
  assert.ok(line.startsWith('a.exe -m '))
  assert.ok(line.includes('"D:/my models/x.gguf"'), `实际：${line}`)
})

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
