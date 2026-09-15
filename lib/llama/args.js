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
/**
 * 把配置里的数字渲染成命令行文本。
 *
 * 为什么不能直接 `String(value)`：采样参数是小数，用户在界面上敲的 0.75 经 JSON 往返后
 * 可能是 0.7500000000000001 这类浮点噪声，直接拼进命令行既难看又可能被 llama.cpp 判为非法。
 * 统一截到 6 位有效小数再去掉尾零。
 */
export function formatNumber(value) {
    if (!Number.isFinite(value))
        return '0';
    return String(Number(value.toFixed(6)));
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
    // ── KV 缓存策略 ──────────────────────────────────────────────────────────
    /**
     * 只在构建公开了这个选项时才下发。
     *
     * 被门控的都是「新」选项：--kv-unified 较新、--kv-stream-stage-mib 更是特定分支的私有参数、
     * --image-*-tokens 要带动态分辨率的 mtmd、--reasoning-budget 也才合并不久。
     * 不认识的构建收到它们会**直接启动失败**，所以宁可跳过并说明，也不能照发。
     * 探测失败（knownFlags 为 null）时同样不下发 —— 与 --flash-attn 的取舍一致。
     */
    const skipped = [];
    /** 返回是否真的下发了 —— 有前置条件的参数要靠这个判断（见下面的 -np 1）。 */
    const gate = (...tokens) => {
        const name = tokens[0];
        if (!input.knownFlags || !input.knownFlags.has(name)) {
            skipped.push(name);
            return false;
        }
        flag(...tokens);
        return true;
    };
    if (input.kvUnified)
        gate('--kv-unified');
    /**
     * 块级 KV 流式 + 单序列约束。
     *
     * 实测错误（那个「自适应 KV 流式」分支）：
     *   E llama_init_from_model: failed to initialize the context:
     *     block KV streaming requires exactly one sequence (-np 1)
     * 而 llama.cpp 的 `-np` 默认是 **-1（自动）**，会落到多序列 —— 于是「开了暂存就加载不了」。
     *
     * 这是参数自身的前置条件，所以在拼参数层强制兜住，不指望用户自己去「附加参数」里补：
     * 少了它，这个开关就是个「一开就崩」的陷阱。
     * 注意 `-np 1` **只在暂存确实下发时才加** —— 构建不认 --kv-stream-stage-mib 时，
     * 平白把并发降到 1 是没有理由的行为变更。
     */
    const stageMib = Math.round(input.kvStreamStageMib);
    if (stageMib > 0 && gate('--kv-stream-stage-mib', String(stageMib))) {
        const extraTokens = splitArgs(input.extraArgs);
        if (extraTokens.some((token) => token === '-np' || token === '--parallel')) {
            // 用户显式写过就不覆盖 —— 但必须说清后果，否则他只会看到一句难懂的英文错误。
            notices.push('你在「附加参数」里指定了 -np / --parallel。KV 流式暂存（--kv-stream-stage-mib）要求**恰好一个序列**，' +
                '那里不是 1 的话加载会直接失败（block KV streaming requires exactly one sequence）。' +
                '插件不覆盖你的显式设置，请自行改成 -np 1，或把 KV 主机内存暂存设为 0 关掉它。');
        }
        else {
            flag('-np', '1');
            notices.push('已自动追加 -np 1：KV 流式暂存要求单序列（llama.cpp 的 -np 默认是自动，会落到多序列并导致加载失败）。');
        }
    }
    // ── 采样参数 ────────────────────────────────────────────────────────────
    // 这些（-s/temp/top-k/top-p/min-p/penalties/repeat-last-n）在几乎所有 llama.cpp 版本里
    // 都存在，因此**不**按探测门控；否则一次探测失败就会静默丢掉全部采样设置。
    flag('--temp', formatNumber(input.temp));
    flag('--top-k', String(Math.round(input.topK)));
    flag('--top-p', formatNumber(input.topP));
    flag('--min-p', formatNumber(input.minP));
    flag('--presence-penalty', formatNumber(input.presencePenalty));
    flag('--repeat-penalty', formatNumber(input.repeatPenalty));
    flag('--repeat-last-n', String(Math.round(input.repeatLastN)));
    flag('--seed', String(Math.round(input.seed)));
    // ── 多模态图像预算 ──────────────────────────────────────────────────────
    // max 必须 >= min，否则 llama.cpp 拒绝启动。就地收敛，与 -ub <= -b 同一处规则。
    const imageMin = Math.max(0, Math.round(input.imageMinTokens));
    const imageMax = Math.max(imageMin, Math.round(input.imageMaxTokens));
    if (imageMin > 0)
        gate('--image-min-tokens', String(imageMin));
    if (imageMax > 0)
        gate('--image-max-tokens', String(imageMax));
    // ── 推理预算 ────────────────────────────────────────────────────────────
    // 0 是有意义的取值（关掉思考），所以不按「> 0」判断，只在构建支持时才下发。
    gate('--reasoning-budget', String(Math.round(input.reasoningBudget)));
    if (skipped.length > 0) {
        notices.push(input.knownFlags
            ? `这个 llama-server 不认识以下选项，已跳过（不影响加载）：${skipped.join('、')}`
            : `无法探测这个 llama-server 支持哪些选项，已跳过：${skipped.join('、')}（宁可退回构建默认值，也不赌它认）`);
    }
    if (input.jinja)
        flag('--jinja');
    if (input.chatTemplate.trim())
        flag('--chat-template', input.chatTemplate.trim());
    // MTP 与视觉投影互斥 —— 这条规则实现在这里而不是调用方，是因为这里才是
    // 「参数真正被拼出来的地方」：只要 mtp 为真，mmproj 就绝不可能漏下去。
    const mmproj = input.mmproj.trim();
    if (input.mtp) {
        flag('--spec-type', 'draft-mtp');
        if (mmproj) {
            notices.push('已开启 MTP，视觉投影文件（--mmproj）被自动忽略：llama.cpp 的 MTP 与图像输入不能同时使用');
        }
    }
    else if (mmproj) {
        flag('--mmproj', mmproj);
    }
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
