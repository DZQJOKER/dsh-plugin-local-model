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
]);
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
]);
/**
 * 把 args 拆成「项」：每个项要么是 `flag value`，要么是裸 flag。
 *
 * 不做通用解析而是照 KNOWN_VALUE_FLAGS 判断，是因为 llama.cpp 的参数里
 * 取值可以以 `-` 开头（`-ngl -1`、`--reasoning-budget -1`），
 * 「下一个 token 以 - 开头就当新选项」这条通用规则会在这里直接解析错。
 */
function splitItems(args) {
    const items = [];
    for (let i = 0; i < args.length; i++) {
        const token = args[i];
        if (!token.startsWith('-'))
            continue;
        const wantsValue = KNOWN_VALUE_FLAGS.has(token) && i + 1 < args.length;
        // 已知需要取值、且下一个 token 不是「另一个已知选项」时才算取值。
        const next = args[i + 1];
        const nextIsFlag = next !== undefined && next.startsWith('-') && KNOWN_VALUE_FLAGS.has(next);
        if (wantsValue && !nextIsFlag) {
            items.push({ flag: token, value: next, index: i });
            i++;
        }
        else {
            items.push({ flag: token, value: null, index: i });
        }
    }
    return items;
}
/** 逐项一行（供界面渲染），顺序与命令行一致。 */
export function renderLaunchLines(executable, args) {
    const lines = [executable];
    for (const item of splitItems(args)) {
        lines.push(item.value === null ? `  ${item.flag}` : `  ${item.flag} ${item.value}`);
    }
    return lines;
}
/** 单行版本，可直接复制到终端。含空格的值加引号。 */
export function renderCommandLine(executable, args) {
    const quote = (token) => (/[\s"']/.test(token) ? JSON.stringify(token) : token);
    return [executable, ...args].map(quote).join(' ');
}
/** 从每个选项里取它的值，找不到就跳过。 */
function valueOf(items, ...flags) {
    for (const flag of flags) {
        const hit = items.find((item) => item.flag === flag);
        if (hit && hit.value !== null)
            return hit.value;
    }
    return null;
}
function has(items, ...flags) {
    return flags.some((flag) => items.some((item) => item.flag === flag));
}
/**
 * 生成报告。
 *
 * 解析对象是**拼好的 args 数组**而不是 config —— 这是这份报告唯一有意义的口径：
 * 设置页里的值和真正发出去的参数之间隔着一层门控与默认值，
 * 只有从 args 读出来的东西才能回答「现在到底跑在什么参数上」。
 */
export function buildLaunchReport(input) {
    const { executable, args } = input;
    const items = splitItems(args);
    const facts = [];
    const push = (group, label, value, note) => {
        if (value === null || value === '')
            return;
        facts.push(note ? { group, label, value, note } : { group, label, value });
    };
    const model = valueOf(items, '-m', '--model');
    if (model) {
        const base = model.split(/[\\/]/).pop() ?? model;
        push('Model', 'Model file', base, model !== base ? model : undefined);
    }
    push('Model', 'Context length -c', valueOf(items, '-c', '--ctx-size'));
    push('Model', 'Server default output cap -n', valueOf(items, '-n', '--n-predict'));
    push('Performance', 'GPU layers -ngl', valueOf(items, '-ngl', '--n-gpu-layers'), 'negative = all layers');
    push('Performance', 'Batch size -b', valueOf(items, '-b', '--batch-size'));
    push('Performance', 'Weight loading -lm', valueOf(items, '-lm', '--load-mode') ?? (has(items, '--no-mmap') ? '--no-mmap' : null));
    push('Performance', 'Flash Attention', valueOf(items, '-fa', '--flash-attn'), 'quantized KV forces it on');
    push('Performance', 'Threads -t', valueOf(items, '-t', '--threads'));
    const kvDtype = valueOf(items, '--kv-dtype');
    const ctk = valueOf(items, '-ctk', '--cache-type-k');
    const ctv = valueOf(items, '-ctv', '--cache-type-v');
    push('KV cache', 'KV type (merged) --kv-dtype', kvDtype);
    push('KV cache', 'K buffer -ctk', ctk);
    push('KV cache', 'V buffer -ctv', ctv);
    const budget = valueOf(items, '--kvmem-budget');
    const reserve = valueOf(items, '--kvmem-gen-reserve');
    push('KVMem', 'Enabled', has(items, '--no-kvmem') ? 'off (--no-kvmem)' : null);
    push('KVMem', 'GPU working set --kvmem-budget', budget, 'historical tokens retrieval may keep in VRAM; 0 = take n_ctx');
    push('KVMem', 'Decode reserve --kvmem-gen-reserve', reserve, '★ per-generation cap (including thinking)');
    // 派生项：这两个数字决定显存账，分开看没有意义。
    const b = Number(budget);
    const r = Number(reserve);
    if (Number.isFinite(b) && Number.isFinite(r) && b >= 0 && r >= 0) {
        push('KVMem', 'Total GPU KV', `${b + r} tokens`, '= working set + decode reserve');
    }
    push('KVMem', 'Retrieval algorithm --kvmem-method', valueOf(items, '--kvmem-method'));
    push('KVMem', 'Block size --kvmem-block-tokens', valueOf(items, '--kvmem-block-tokens'));
    push('KVMem', 'Slot-pool VRAM share --kvmem-gpu-ratio', valueOf(items, '--kvmem-gpu-ratio'));
    push('KVMem', 'Resident prefix --kvmem-sink-tokens', valueOf(items, '--kvmem-sink-tokens'));
    push('KVMem', 'Resident suffix --kvmem-recent-tokens', valueOf(items, '--kvmem-recent-tokens'));
    push('KVMem', 'CPU overflow field --kvmem-cpu-gb', valueOf(items, '--kvmem-cpu-gb'));
    push('KVMem', 'NVMe overflow field --kvmem-nvme-gb', valueOf(items, '--kvmem-nvme-gb'));
    push('MTP & vision', 'MTP --spec-type', valueOf(items, '--spec-type'), 'draft-mtp = multi-token prediction');
    push('MTP & vision', 'MTP draft count --spec-draft-n-max', valueOf(items, '--spec-draft-n-max'));
    push('MTP & vision', 'MTP KV precision --spec-kv-dtype', valueOf(items, '--spec-kv-dtype'));
    push('MTP & vision', 'MTP state --kvmem-mtp-state', valueOf(items, '--kvmem-mtp-state'));
    push('MTP & vision', 'Vision projector --mmproj', valueOf(items, '--mmproj'));
    if (has(items, '--no-mmproj-offload'))
        push('MTP & vision', 'Vision encoder location', 'CPU (--no-mmproj-offload)');
    if (has(items, '--spec-type') && has(items, '--mmproj')) {
        push('MTP & vision', 'Combination', 'MTP + vision enabled together', 'the kvmem branch supports coexistence');
    }
    push('Sampling', 'Temperature --temp', valueOf(items, '--temp', '--temperature'));
    push('Sampling', 'Top-K', valueOf(items, '--top-k'));
    push('Sampling', 'Top-P', valueOf(items, '--top-p'));
    push('Sampling', 'Min-P', valueOf(items, '--min-p'));
    push('Sampling', 'Presence penalty', valueOf(items, '--presence-penalty'));
    push('Sampling', 'Frequency penalty', valueOf(items, '--frequency-penalty'));
    push('Sampling', 'Repeat penalty', valueOf(items, '--repeat-penalty'));
    push('Sampling', 'Seed --seed', valueOf(items, '--seed'));
    push('Sampling', 'Min image tokens', valueOf(items, '--image-min-tokens'));
    push('Sampling', 'Max image tokens', valueOf(items, '--image-max-tokens'));
    push('Template & thinking', 'Jinja template', has(items, '--jinja') ? 'on' : null);
    push('Template & thinking', 'Chat template --chat-template', valueOf(items, '--chat-template'));
    push('Template & thinking', 'Template file --chat-template-file', valueOf(items, '--chat-template-file'));
    push('Template & thinking', 'Server default effort --reasoning-effort', valueOf(items, '--reasoning-effort'));
    push('Template & thinking', 'Thinking budget --reasoning-budget', valueOf(items, '--reasoning-budget'), '-1 = unlimited');
    push('Template & thinking', 'Budget transition message', valueOf(items, '--reasoning-budget-message'));
    push('Service', 'Listen', valueOf(items, '--host'));
    push('Service', 'Port', valueOf(items, '--port'));
    push('Service', 'Alias --alias', valueOf(items, '--alias', '-a'));
    /**
     * 只把**识别表里认得**的项标记为已消费，未知选项必须留到 `unrecognized` 里报出来。
     *
     * 这里最初无条件消费了所有以 `-` 开头的 token，于是 `unrecognized` 恒为空 ——
     * 表面上「一切正常」，实际是一条永不触发的防线（识别表过时了就彻底失效）。
     */
    const consumed = new Set();
    for (const item of items) {
        if (!KNOWN_VALUE_FLAGS.has(item.flag) && !KNOWN_BARE_FLAGS.has(item.flag))
            continue;
        consumed.add(item.index);
        if (item.value !== null)
            consumed.add(item.index + 1);
    }
    const unrecognized = args.filter((token, index) => !consumed.has(index) && token.startsWith('-'));
    return {
        executable,
        lines: renderLaunchLines(executable, args),
        commandLine: renderCommandLine(executable, args),
        facts,
        notices: [...(input.notices ?? [])],
        unrecognized,
    };
}
