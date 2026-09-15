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
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { buildLlamaServerArgs, splitArgs, redactArgs, renderCommandLine, flashAttnArgs, normalizeFlashAttn, gpuLayersArgs, normalizeGpuLayersMode, normalizeCacheType } from '../lib/llama/args.js'
import {
  detectFlashAttnMode,
  isFlashAttnFormError,
  parseHelp,
  unknownFlags,
} from '../lib/llama/capabilities.js'
import { groupShards, parseQuant, parseParams, pickModel, formatBytes, scanModels, scanModelsDetailed, resolveVisionProjector, effectiveVisionProjector } from '../lib/registry.js'
import { resolveDir, expandVars } from '../lib/paths.js'
import { resolveConfig, clamp, logLevelOf, normalizeBool } from '../lib/configResolve.js'
import { sanitize } from '../lib/configStore.js'
import { isChatCompletionPath, rewriteChatRequestBody, thinkChatTemplateKwargs } from '../lib/requestRewrite.js'
import { diagnoseLoadFailure, extractEffectiveContext } from '../lib/llama/diagnose.js'
import { shouldUnload } from '../lib/lifecycle.js'

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

// ── 参数拼装 ────────────────────────────────────────────────────────────────
section('llama-server 参数拼装')

test('基础参数齐全且顺序稳定', () => {
  const { args } = buildLlamaServerArgs({
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
  const { args } = buildLlamaServerArgs({
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
  const { args } = buildLlamaServerArgs({
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
  const built = buildLlamaServerArgs({
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
    jinja: false, // 关掉 jinja，且模板留空 —— 于是 --flash-attn 紧邻 --mmproj
    chatTemplate: '',
    mmproj: '/m/mmproj.gguf',
    mmap: true,
    mlock: false,
    apiKey: '',
    extraArgs: '',
  })
  const index = built.args.indexOf('--flash-attn')
  assert.equal(built.args[index + 1], '--mmproj', '复现出「裸 flag 后紧邻另一个 flag」的排布')

  // 正确行为：识别出带值构建后，值补齐，后面的参数不再被吞
  const fixed = buildLlamaServerArgs({
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
  const built = buildLlamaServerArgs({
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
  const { args } = buildLlamaServerArgs({
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
  const { args } = buildLlamaServerArgs(kvBaseInput)
  const kIdx = args.indexOf('--cache-type-k')
  const vIdx = args.indexOf('--cache-type-v')
  assert.equal(args[kIdx + 1], 'q8_0', '未传 cacheTypeK 时必须默认 q8_0')
  assert.equal(args[vIdx + 1], 'q8_0', '未传 cacheTypeV 时必须默认 q8_0')
})

test('KV cache：auto 永远不下发（让 llama.cpp 用其默认）', () => {
  const { args } = buildLlamaServerArgs({ ...kvBaseInput, cacheTypeK: 'auto', cacheTypeV: 'auto' })
  assert.ok(!args.includes('--cache-type-k'), 'cacheTypeK=auto 时不下发')
  assert.ok(!args.includes('--cache-type-v'), 'cacheTypeV=auto 时不下发')
})

test('KV cache：K 和 V 独立配置', () => {
  const { args } = buildLlamaServerArgs({ ...kvBaseInput, cacheTypeK: 'f16', cacheTypeV: 'q4_0' })
  const kIdx = args.indexOf('--cache-type-k')
  const vIdx = args.indexOf('--cache-type-v')
  assert.equal(args[kIdx + 1], 'f16')
  assert.equal(args[vIdx + 1], 'q4_0')
})

test('KV cache：非法字符串值被兜底为 q8_0 仍会下发（绝不回落到 f16）', () => {
  const { args } = buildLlamaServerArgs({ ...kvBaseInput, cacheTypeK: 'bogus', cacheTypeV: undefined })
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
  const built = buildLlamaServerArgs(mtpBaseInput)
  assert.equal(flagIndex(built.args, '--spec-type'), -1, '默认必须是关的')
  assert.equal(flagValue(built.args, '--mmproj'), '/m/mmproj-a.gguf', '没开 MTP 时视觉投影照旧下发')
  assert.deepEqual(built.notices, [], '没开 MTP 就不该多出任何提示')
})

test('开启 MTP：下发 --spec-type draft-mtp', () => {
  const built = buildLlamaServerArgs({ ...mtpBaseInput, mtp: true })
  assert.equal(flagValue(built.args, '--spec-type'), 'draft-mtp')
  assert.ok(
    built.usedFlags.includes('--spec-type'),
    '必须进 usedFlags —— 否则「构建不认识这个选项」的 --help 校验发现不了老 llama.cpp',
  )
})

test('互斥：开了 MTP 时 --mmproj 绝不下发（同时给会让加载直接失败）', () => {
  const built = buildLlamaServerArgs({ ...mtpBaseInput, mtp: true })
  assert.equal(flagIndex(built.args, '--mmproj'), -1, 'MTP 与图像输入不能共存')
  assert.equal(built.args.includes('/m/mmproj-a.gguf'), false, '连值都不能残留在命令行里')
})

test('互斥不静默：notices 说清视觉投影为什么没了', () => {
  const built = buildLlamaServerArgs({ ...mtpBaseInput, mtp: true })
  assert.equal(built.notices.length, 1)
  assert.ok(built.notices[0].includes('MTP'), '要点明是 MTP 造成的')
  assert.ok(built.notices[0].includes('--mmproj'), '要点明被丢掉的是哪个参数')
})

test('本来就没有 mmproj：不刷无意义的「已忽略」提示', () => {
  const built = buildLlamaServerArgs({ ...mtpBaseInput, mtp: true, mmproj: '' })
  assert.equal(flagValue(built.args, '--spec-type'), 'draft-mtp', 'MTP 本身照常开')
  assert.deepEqual(built.notices, [], '没有东西被丢，就不该有提示')
})

test('effectiveVisionProjector：四种组合', () => {
  const base = { modelsDir: '/m', mmprojFile: '', autoMmproj: '/m/mmproj-a.gguf' }
  assert.equal(effectiveVisionProjector({ ...base, mtp: false }), '/m/mmproj-a.gguf', '没开 MTP：沿用自动关联')
  assert.equal(effectiveVisionProjector({ ...base, mtp: true }), '', '开了 MTP：视觉投影为空')
  assert.equal(effectiveVisionProjector({ ...base, autoMmproj: null, mtp: false }), '', '本来没有视觉能力：空')
  assert.equal(
    effectiveVisionProjector({ ...base, mmprojFile: 'vision/mmproj-b.gguf', mtp: true }),
    '',
    '显式选了也不生效 —— 互斥优先于用户的显式选择',
  )
})

test('显示值与命令行下发值严格一致（防面板与实参错位）', () => {
  for (const mtp of [false, true]) {
    const shown = effectiveVisionProjector({
      modelsDir: '/m',
      mmprojFile: 'vision/mmproj-b.gguf',
      autoMmproj: '/m/mmproj-a.gguf',
      mtp,
    })
    const built = buildLlamaServerArgs({ ...mtpBaseInput, mtp, mmproj: shown })
    assert.equal(flagValue(built.args, '--mmproj') ?? '', shown, `mtp=${mtp} 时面板显示与实参必须一致`)
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

// ── 思考开关（请求体改写） ──────────────────────────────────────────────────
section('思考开关（请求体改写）')

const policy = (enableThinking, preserveThinking) => ({ enableThinking, preserveThinking })

test('两个开关都显式下发（只下发 false 会让「打开」这一侧失效）', () => {
  assert.deepEqual(thinkChatTemplateKwargs(policy(true, true)), { enable_thinking: true, preserve_thinking: true })
  assert.deepEqual(thinkChatTemplateKwargs(policy(false, false)), { enable_thinking: false, preserve_thinking: false })
  assert.deepEqual(thinkChatTemplateKwargs(policy(false, true)), { enable_thinking: false, preserve_thinking: true })
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

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
