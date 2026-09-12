export const DEFAULT_ALIAS = 'local';
/** 兼容历史布尔值：true → on，false → off；无法识别的一律回到 auto。 */
export function normalizeFlashAttn(value) {
    if (value === true || value === 'on' || value === 'true')
        return 'on';
    if (value === false || value === 'off' || value === 'false')
        return 'off';
    return 'auto';
}
const KV_CACHE_TYPES = new Set([
    'auto', 'f16', 'q8_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'bf16', 'f32', 'iq4_nl',
]);
export function normalizeCacheType(value) {
    if (typeof value !== 'string')
        return 'q8_0';
    const lower = value.trim().toLowerCase();
    if (KV_CACHE_TYPES.has(lower))
        return lower;
    return 'q8_0';
}
export function normalizeGpuLayersMode(value) {
    if (value === 'all')
        return 'all';
    if (value === 'custom')
        return 'custom';
    return 'auto';
}
/**
 * GPU 层数的下发规则。
 *
 * - `auto`：优先下发 `-ngl auto`（把卸载决策交给 llama.cpp 的 --fit 按可用显存自适应）。
 *   构建不认这个关键字时退回 `-ngl -1`（全部上，即老行为），并出一句说明 ——
 *   老构建上不下发 -ngl 会退化成纯 CPU，那是比「全部上」糟糕得多的意外。
 * - `all`：`-ngl all`，不支持则 `-ngl -1`。
 * - `custom`：`-ngl <数字>`；负数按「全部」处理。
 */
export function gpuLayersArgs(mode, layers, support) {
    if (mode === 'custom') {
        const value = Number.isFinite(layers) ? Math.round(layers) : 0;
        if (value < 0) {
            return support.all ? { args: ['-ngl', 'all'], notice: null } : { args: ['-ngl', '-1'], notice: null };
        }
        return { args: ['-ngl', String(value)], notice: null };
    }
    if (mode === 'all') {
        return support.all
            ? { args: ['-ngl', 'all'], notice: null }
            : { args: ['-ngl', '-1'], notice: '这个构建的 -ngl 不认识 all 关键字，已下发 -1（同样表示全部层）' };
    }
    return support.auto
        ? { args: ['-ngl', 'auto'], notice: null }
        : {
            args: ['-ngl', '-1'],
            notice: '这个构建的 -ngl 不认识 auto 关键字（无法按显存自适应），已下发 -1（全部层）；放不下时会直接报显存不足，可改用「自定义」层数',
        };
}
/**
 * Flash Attention 的下发规则。
 *
 * 核心取舍：**auto 永远不下发**。因为 auto 在所有支持三态的构建里都等于默认值，
 * 而在只支持裸开关的老构建里根本表达不出来 —— 不下发是唯一在两种构建上语义都正确的做法。
 * 这样也顺带避开了「这个构建收不收 auto 这个字面量」的问题。
 */
export function flashAttnArgs(setting, mode) {
    const value = normalizeFlashAttn(setting);
    if (value === 'auto')
        return { args: [], notice: null };
    if (mode === 'value')
        return { args: ['--flash-attn', value], notice: null };
    if (mode === 'bare') {
        return value === 'on'
            ? { args: ['--flash-attn'], notice: null }
            : { args: [], notice: '这个 llama-server 的 --flash-attn 是裸开关，无法显式关闭；已不下发该参数' };
    }
    return {
        args: [],
        notice: '无法确定这个 llama-server 的 --flash-attn 形状（探测 --help 失败），已不下发该参数；如需强制指定请用「附加参数」',
    };
}
export function buildLlamaServerArgs(input) {
    const args = [];
    const usedFlags = [];
    const notices = [];
    const flag = (...tokens) => {
        usedFlags.push(tokens[0]);
        args.push(...tokens);
    };
    args.push('-m', input.modelPath, '--host', input.host, '--port', String(input.port), '--alias', input.alias, '-c', String(input.ctxSize));
    usedFlags.push('-m', '--host', '--port', '--alias', '-c');
    // GPU 层数：默认 auto，让 llama.cpp 的 --fit 按可用显存决定，避免「放不下就崩」。
    const gpu = gpuLayersArgs(input.gpuLayersMode, input.gpuLayers, input.gpuLayersSupport);
    if (gpu.args.length > 0)
        flag(...gpu.args);
    if (gpu.notice)
        notices.push(gpu.notice);
    if (input.threads > 0)
        flag('-t', String(input.threads));
    if (input.threadsBatch > 0)
        flag('--threads-batch', String(input.threadsBatch));
    if (input.batchSize > 0)
        flag('-b', String(input.batchSize));
    if (input.ubatchSize > 0) {
        // -ub 必须 <= -b，否则 llama.cpp 直接启动失败。这里就地收敛，避免把矛盾参数丢给子进程。
        const ub = input.batchSize > 0 ? Math.min(input.ubatchSize, input.batchSize) : input.ubatchSize;
        flag('-ub', String(ub));
    }
    const flash = flashAttnArgs(input.flashAttention, input.flashAttnMode);
    if (flash.args.length > 0)
        flag(...flash.args);
    if (flash.notice)
        notices.push(flash.notice);
    // KV cache 量化。'auto' 不下发，其它下发对应值。'auto' 与 flashAttention 的 'auto'
    // 语义一致：不参与决策、把选择权完整交给 llama.cpp。
    const cacheK = normalizeCacheType(input.cacheTypeK);
    if (cacheK !== 'auto')
        flag('--cache-type-k', cacheK);
    const cacheV = normalizeCacheType(input.cacheTypeV);
    if (cacheV !== 'auto')
        flag('--cache-type-v', cacheV);
    if (input.jinja)
        flag('--jinja');
    if (input.chatTemplate.trim())
        flag('--chat-template', input.chatTemplate.trim());
    if (input.mmproj.trim())
        flag('--mmproj', input.mmproj.trim());
    if (!input.mmap)
        flag('--no-mmap');
    if (input.mlock)
        flag('--mlock');
    if (input.apiKey.trim())
        flag('--api-key', input.apiKey.trim());
    args.push(...splitArgs(input.extraArgs));
    return { args: args.filter((token) => token.length > 0), usedFlags, notices };
}
/**
 * 引号感知的参数分词：支持 'a b'、"a b"。
 *
 * 关于反斜杠：**不**把它当通用转义符。用户会往这里贴 Windows 路径
 * （`--lora "C:\users\me\lora.bin"`、`--chat-template C:\tpl\qwen.jinja`），
 * 一旦把 `\` 当转义符，路径会被静默吃掉字符，比分词不准难查得多。
 * 只保留一个例外：`\"` / `\'` 转义它自己所在的那种引号。
 */
export function splitArgs(raw) {
    const out = [];
    let current = '';
    let quote = null;
    let started = false;
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (quote) {
            if (ch === '\\' && raw[i + 1] === quote) {
                current += quote;
                i++;
                continue;
            }
            if (ch === quote) {
                quote = null;
                continue;
            }
            current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            started = true;
            continue;
        }
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            if (started || current.length > 0) {
                out.push(current);
                current = '';
                started = false;
            }
            continue;
        }
        current += ch;
    }
    if (started || current.length > 0)
        out.push(current);
    return out;
}
/** 把参数数组还原成可读命令行（用于日志与 status 输出，注意会暴露 --api-key）。 */
export function renderCommandLine(command, args) {
    return [command, ...args].map(quoteIfNeeded).join(' ');
}
export function redactArgs(args) {
    const out = args.slice();
    const index = out.findIndex((a) => a === '--api-key');
    if (index >= 0 && index + 1 < out.length)
        out[index + 1] = '***';
    return out;
}
function quoteIfNeeded(token) {
    return /[\s"']/.test(token) ? JSON.stringify(token) : token;
}
