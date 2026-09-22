/**
 * 启动参数报告：把「这一次到底下发了什么」整理成给人看的东西。
 *
 * 要解决的是一个很具体的观察困难：插件的参数来自三个地方（设置页、构建的默认值、
 * 探测后的门控跳过），最终只有一行拼好的命令行躺在日志里 —— 几百个字符连成一片，
 * 没人会去逐字比对「我以为设了什么」和「实际发了什么」。
 *
 * 所以这里做两件事：
 *   1. 把命令行拆成**一行一项**，每一项都从真实 args 里读出来（不是从配置读的 ——
 *      那样只能证明「配置是什么」，证明不了「实际发了什么」）；
 *   2. 把没识别到的选项也列出来。**看不见的选项比错误的值更危险**：
 *      识别表会随构建变化而过时，漏掉的项如果不报出来，用户就永远不知道它被发了。
 *
 * 纯函数：不碰进程、不碰 fs，输入确定则输出确定，因此能被单测逐个钉死。
 */

export interface LaunchFact {
  /** 分组标题，客户端据此分栏；同一份报告里按出现顺序去重即得分栏顺序。 */
  group: string
  label: string
  value: string
  /** 需要多解释一句时用（例如「越大召回越好但越吃显存」）。 */
  note?: string
}

export interface LaunchReport {
  executable: string
  /** 逐项一行，给界面直接渲染成代码块。 */
  lines: string[]
  /** 单行版本，方便复制粘贴到终端。 */
  commandLine: string
  /** 参数摘要（已从真实 args 解析）。 */
  facts: LaunchFact[]
  /** 拼参数层给出的提示（被跳过的选项、自动收敛、互斥说明……）。 */
  notices: string[]
  /** 识别表没覆盖到的选项 —— 宁可多列出来，也不要让任何一项隐形。 */
  unrecognized: string[]
}

export interface LaunchReportInput {
  executable: string
  args: string[]
  notices?: string[]
}

/** 选项名 → 是否需要一个取值。用于把 args 切成「项」。 */
const KNOWN_VALUE_FLAGS = new Set([
  '-m', '--model', '--host', '--port', '--alias', '-a', '-c', '--ctx-size', '-n', '--n-predict',
  '-b', '--batch-size', '-ub', '--ubatch-size', '-ngl', '--n-gpu-layers', '--gpu-layers',
  '-t', '--threads', '-tb', '--threads-batch', '-fa', '--flash-attn',
  '-ctk', '--cache-type-k', '-ctv', '--cache-type-v', '--kv-dtype',
  '--temp', '--temperature', '--top-k', '--top-p', '--min-p', '--presence-penalty',
  '--frequency-penalty', '--repeat-penalty', '--repeat-last-n', '--seed',
  '--image-min-tokens', '--image-max-tokens', '--reasoning-budget', '--reasoning-budget-message',
  '--chat-template', '--chat-template-file', '--chat-template-kwargs', '--reasoning-effort',
  '--mmproj', '--spec-type', '--spec-kv-dtype', '--spec-draft-n-max', '--spec-draft-p-min',
  '--no-kvmem', '--kvmem', '--kvmem-budget', '--kvmem-gen-reserve', '--kvmem-block-tokens',
  '--kvmem-sink-tokens', '--kvmem-recent-tokens', '--kvmem-method', '--kvmem-query-last',
  '--kvmem-query-max-tokens', '--kvmem-query-replay', '--kvmem-query-policy', '--kvmem-mtp-state',
  '--kvmem-gpu-ratio', '--kvmem-cpu-gb', '--kvmem-nvme-gb', '--kvmem-nvme-dir',
  '--api-key', '--api-key-file', '-lm', '--load-mode', '--webui', '--no-webui', '--path',
])

/**
 * 裸开关（不带取值）。与 KNOWN_VALUE_FLAGS 一起构成「识别表」。
 *
 * 为什么要单列一份：区分「这个选项我认识」和「这个 token 只是恰好以 - 开头」。
 * 少了这份表，任何以 `-` 开头的 token 都会被当成已知项消费掉，
 * `unrecognized` 就永远是空的 —— 一条永不触发的防线，而它恰恰是这份报告里
 * 最有价值的一栏（识别表会随构建变化而过时）。
 */
const KNOWN_BARE_FLAGS = new Set([
  '--jinja', '--mlock', '--mmap', '--no-mmap', '--direct-io', '--no-direct-io',
  '--mmproj-offload', '--no-mmproj-offload', '--kvmem', '--no-kvmem',
  '--kvmem-harvest-v', '--kvmem-raw-k-nvme', '--kvmem-dump-kv',
  '--enable-thinking', '--no-think', '--tokens-only', '--no-prompt',
  '--server-browser', '--no-server-browser',
])

/**
 * 把 args 拆成「项」：每个项要么是 `flag value`，要么是裸 flag。
 *
 * 不做通用解析而是照 KNOWN_VALUE_FLAGS 判断，是因为 llama.cpp 的参数里
 * 取值可以以 `-` 开头（`-ngl -1`、`--reasoning-budget -1`），
 * 「下一个 token 以 - 开头就当新选项」这条通用规则会在这里直接解析错。
 */
function splitItems(args: string[]): { flag: string; value: string | null; index: number }[] {
  const items: { flag: string; value: string | null; index: number }[] = []
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!
    if (!token.startsWith('-')) continue
    const wantsValue = KNOWN_VALUE_FLAGS.has(token) && i + 1 < args.length
    // 已知需要取值、且下一个 token 不是「另一个已知选项」时才算取值。
    const next = args[i + 1]
    const nextIsFlag = next !== undefined && next.startsWith('-') && KNOWN_VALUE_FLAGS.has(next)
    if (wantsValue && !nextIsFlag) {
      items.push({ flag: token, value: next!, index: i })
      i++
    } else {
      items.push({ flag: token, value: null, index: i })
    }
  }
  return items
}

/** 逐项一行（供界面渲染），顺序与命令行一致。 */
export function renderLaunchLines(executable: string, args: string[]): string[] {
  const lines = [executable]
  for (const item of splitItems(args)) {
    lines.push(item.value === null ? `  ${item.flag}` : `  ${item.flag} ${item.value}`)
  }
  return lines
}

/** 单行版本，可直接复制到终端。含空格的值加引号。 */
export function renderCommandLine(executable: string, args: string[]): string {
  const quote = (token: string): string => (/[\s"']/.test(token) ? JSON.stringify(token) : token)
  return [executable, ...args].map(quote).join(' ')
}

/** 从每个选项里取它的值，找不到就跳过。 */
function valueOf(items: { flag: string; value: string | null }[], ...flags: string[]): string | null {
  for (const flag of flags) {
    const hit = items.find((item) => item.flag === flag)
    if (hit && hit.value !== null) return hit.value
  }
  return null
}

function has(items: { flag: string }[], ...flags: string[]): boolean {
  return flags.some((flag) => items.some((item) => item.flag === flag))
}

/**
 * 生成报告。
 *
 * 解析对象是**拼好的 args 数组**而不是 config —— 这是这份报告唯一有意义的口径：
 * 设置页里的值和真正发出去的参数之间隔着一层门控与默认值，
 * 只有从 args 读出来的东西才能回答「现在到底跑在什么参数上」。
 */
export function buildLaunchReport(input: LaunchReportInput): LaunchReport {
  const { executable, args } = input
  const items = splitItems(args)
  const facts: LaunchFact[] = []
  const push = (group: string, label: string, value: string | null, note?: string): void => {
    if (value === null || value === '') return
    facts.push(note ? { group, label, value, note } : { group, label, value })
  }

  const model = valueOf(items, '-m', '--model')
  if (model) {
    const base = model.split(/[\\/]/).pop() ?? model
    push('模型', '模型文件', base, model !== base ? model : undefined)
  }
  push('模型', '上下文长度 -c', valueOf(items, '-c', '--ctx-size'))
  push('模型', '服务端默认输出上限 -n', valueOf(items, '-n', '--n-predict'))

  push('性能', 'GPU 层数 -ngl', valueOf(items, '-ngl', '--n-gpu-layers'), '负数 = 全部层')
  push('性能', '批大小 -b', valueOf(items, '-b', '--batch-size'))
  push('性能', '权重加载 -lm', valueOf(items, '-lm', '--load-mode') ?? (has(items, '--no-mmap') ? '--no-mmap' : null))
  push('性能', 'Flash Attention', valueOf(items, '-fa', '--flash-attn'), '量化 KV 会强制打开')
  push('性能', '线程 -t', valueOf(items, '-t', '--threads'))

  const kvDtype = valueOf(items, '--kv-dtype')
  const ctk = valueOf(items, '-ctk', '--cache-type-k')
  const ctv = valueOf(items, '-ctv', '--cache-type-v')
  push('KV 缓存', 'KV 类型（合并）--kv-dtype', kvDtype)
  push('KV 缓存', 'K 缓冲 -ctk', ctk)
  push('KV 缓存', 'V 缓冲 -ctv', ctv)

  const budget = valueOf(items, '--kvmem-budget')
  const reserve = valueOf(items, '--kvmem-gen-reserve')
  push('KVMem', '启用', has(items, '--no-kvmem') ? '否（--no-kvmem）' : null)
  push('KVMem', 'GPU 工作集 --kvmem-budget', budget, '检索能留在显存里的历史 token 数；0 = 取 n_ctx')
  push('KVMem', '解码预留 --kvmem-gen-reserve', reserve, '★ 单次生成的上限（含思考）')
  // 派生项：这两个数字决定显存账，分开看没有意义。
  const b = Number(budget)
  const r = Number(reserve)
  if (Number.isFinite(b) && Number.isFinite(r) && b >= 0 && r >= 0) {
    push('KVMem', 'GPU KV 合计', `${b + r} token`, '= 工作集 + 解码预留')
  }
  push('KVMem', '检索算法 --kvmem-method', valueOf(items, '--kvmem-method'))
  push('KVMem', '块大小 --kvmem-block-tokens', valueOf(items, '--kvmem-block-tokens'))
  push('KVMem', '槽池显存占比 --kvmem-gpu-ratio', valueOf(items, '--kvmem-gpu-ratio'))
  push('KVMem', '常驻前缀 --kvmem-sink-tokens', valueOf(items, '--kvmem-sink-tokens'))
  push('KVMem', '常驻后缀 --kvmem-recent-tokens', valueOf(items, '--kvmem-recent-tokens'))
  push('KVMem', 'CPU 溢出场 --kvmem-cpu-gb', valueOf(items, '--kvmem-cpu-gb'))
  push('KVMem', 'NVMe 溢出场 --kvmem-nvme-gb', valueOf(items, '--kvmem-nvme-gb'))

  push('MTP 与视觉', 'MTP --spec-type', valueOf(items, '--spec-type'), 'draft-mtp = 多 Token 预测')
  push('MTP 与视觉', 'MTP 草稿数 --spec-draft-n-max', valueOf(items, '--spec-draft-n-max'))
  push('MTP 与视觉', 'MTP KV 精度 --spec-kv-dtype', valueOf(items, '--spec-kv-dtype'))
  push('MTP 与视觉', 'MTP 状态 --kvmem-mtp-state', valueOf(items, '--kvmem-mtp-state'))
  push('MTP 与视觉', '视觉投影 --mmproj', valueOf(items, '--mmproj'))
  if (has(items, '--no-mmproj-offload')) push('MTP 与视觉', '视觉编码器位置', 'CPU（--no-mmproj-offload）')
  if (has(items, '--spec-type') && has(items, '--mmproj')) {
    push('MTP 与视觉', '组合', 'MTP + 视觉 同时启用', 'kvmem 分支支持共存')
  }

  push('采样', '温度 --temp', valueOf(items, '--temp', '--temperature'))
  push('采样', 'Top-K', valueOf(items, '--top-k'))
  push('采样', 'Top-P', valueOf(items, '--top-p'))
  push('采样', 'Min-P', valueOf(items, '--min-p'))
  push('采样', '存在惩罚', valueOf(items, '--presence-penalty'))
  push('采样', '频率惩罚', valueOf(items, '--frequency-penalty'))
  push('采样', '重复惩罚', valueOf(items, '--repeat-penalty'))
  push('采样', '种子 --seed', valueOf(items, '--seed'))
  push('采样', '图像最少 token', valueOf(items, '--image-min-tokens'))
  push('采样', '图像最多 token', valueOf(items, '--image-max-tokens'))

  push('模板与思考', 'Jinja 模板', has(items, '--jinja') ? '开' : null)
  push('模板与思考', '对话模板 --chat-template', valueOf(items, '--chat-template'))
  push('模板与思考', '模板文件 --chat-template-file', valueOf(items, '--chat-template-file'))
  push('模板与思考', '服务端默认档位 --reasoning-effort', valueOf(items, '--reasoning-effort'))
  push('模板与思考', '思考预算 --reasoning-budget', valueOf(items, '--reasoning-budget'), '-1 = 不限')
  push('模板与思考', '预算过渡语', valueOf(items, '--reasoning-budget-message'))

  push('服务', '监听', valueOf(items, '--host'))
  push('服务', '端口', valueOf(items, '--port'))
  push('服务', '别名 --alias', valueOf(items, '--alias', '-a'))

  /**
   * 只把**识别表里认得**的项标记为已消费，未知选项必须留到 `unrecognized` 里报出来。
   *
   * 这里最初无条件消费了所有以 `-` 开头的 token，于是 `unrecognized` 恒为空 ——
   * 表面上「一切正常」，实际是一条永不触发的防线（识别表过时了就彻底失效）。
   */
  const consumed = new Set<number>()
  for (const item of items) {
    if (!KNOWN_VALUE_FLAGS.has(item.flag) && !KNOWN_BARE_FLAGS.has(item.flag)) continue
    consumed.add(item.index)
    if (item.value !== null) consumed.add(item.index + 1)
  }
  const unrecognized = args.filter((token, index) => !consumed.has(index) && token.startsWith('-'))

  return {
    executable,
    lines: renderLaunchLines(executable, args),
    commandLine: renderCommandLine(executable, args),
    facts,
    notices: [...(input.notices ?? [])],
    unrecognized,
  }
}
