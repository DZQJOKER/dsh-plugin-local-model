/**
 * 把 llama-server 的失败日志翻译成「人能照着做」的结论。
 *
 * 为什么值得单独做一层：llama-server 挂掉时吐出来的是几十行英文日志，最后一行常常是
 * `GGML_ASSERT(buffer) failed` 这种毫无信息量的断言，真正的病因埋在中间的某一行
 * （比如 `cudaMalloc failed: out of memory`）。用户看到的是一大坨日志，
 * 而其实只要说一句「显存不够，把上下文降到 16K，或者把 GPU 层数策略改回自动」就够了。
 *
 * 这里只做「识别 + 给下一步」，不猜不编：匹配不到就返回 null，交给原始日志尾巴。
 */
const RULES = [
    {
        id: 'fit-blocked-by-pinned-layers',
        // 典型：failed to fit params to free device memory: n_gpu_layers already set by user to 99, abort
        test: /failed to fit params to free device memory[\s\S]{0,200}?(n_gpu_layers|n_gpu_layers already set|already set by user)/i,
        build: (log) => {
            const pinned = /(?:n_gpu_layers|n-gpu-layers)[^\d]{0,30}(\d+)/i.exec(log)?.[1];
            return {
                summary: `显存不够，而 llama.cpp 的自动适配被「手动指定的 GPU 层数」拦住了${pinned ? `（当前 ${pinned} 层）` : ''}。`,
                actions: [
                    '把「设置 → 本地模型 → GPU 层数策略」改成「自动」—— 让 llama.cpp 按可用显存自己决定卸载多少层，模型放不下时会自动少放几层而不是直接崩。',
                    '同时把上下文长度调小（例如 32768 → 16384），KV cache 是显存占用的大头。',
                    '仍然放不下就换更低比特的量化（IQ4_XS → Q3_K_M 之类）。',
                ],
                evidence: 'failed to fit params to free device memory（--fit 只调整用户未显式设置的参数，-ngl 被钉住就跳过自适应）',
            };
        },
    },
    {
        id: 'cuda-oom',
        test: /cudaMalloc failed[^\n]*out of memory|failed to allocate (CUDA|Vulkan|Metal)[^\n]*buffer|out of memory/i,
        build: () => ({
            summary: '显存不足：模型 + KV cache 超出了显卡可用显存。',
            actions: [
                '把上下文长度调小（KV cache 与上下文长度成正比）。',
                '把「GPU 层数策略」改成「自动」，或把自定义层数调小。',
                '关掉 Flash Attention 试试（部分卡上 FA 反而更吃显存）。',
                '换更低比特的量化版本。',
                '关掉占显存的其它程序（浏览器硬件加速、其它推理服务、游戏）。',
            ],
            evidence: 'cudaMalloc failed / failed to allocate buffer',
        }),
    },
    {
        id: 'flash-attn-form',
        test: /unknown value for --flash-attn|unrecognized argument[^\n]*flash-attn/i,
        build: () => ({
            summary: '这个 llama-server 不接受当前形式的 --flash-attn（形状不匹配）。',
            actions: [
                '把「Flash Attention」改成「自动」—— 自动模式下插件不会下发这个参数。',
                '正常情况下插件会自动识别构建形状并重试；若仍失败说明探测失败，可用「附加参数」手动指定。',
            ],
            evidence: 'unknown value for --flash-attn',
        }),
    },
    {
        id: 'model-file',
        test: /failed to open GGUF file|unable to load model|no such file or directory|failed to load model from/i,
        build: () => ({
            summary: '模型文件读不到。',
            actions: [
                '确认「设置 → 本地模型 → 当前模型」指向的文件还在模型目录里。',
                '如果模型是分片（-00001-of-0000N.gguf），确认所有分片都在。',
                '放好后点「重新扫描」。',
            ],
            evidence: 'failed to open GGUF file / unable to load model',
        }),
    },
    {
        id: 'arch-unsupported',
        test: /unknown model architecture|unsupported (model )?architecture/i,
        build: () => ({
            summary: '这个 llama.cpp 版本不认识该模型的架构（多半是 llama.cpp 太旧）。',
            actions: ['下载更新的 llama.cpp release，替换运行时目录里的可执行文件。'],
            evidence: 'unknown model architecture',
        }),
    },
    {
        id: 'mmproj',
        test: /failed to load (mmproj|clip)|mmproj[^\n]*not found|clip_model_load/i,
        build: () => ({
            summary: '视觉投影文件（mmproj）加载失败。',
            actions: [
                '确认 mmproj-*.gguf 与模型在同一目录、且与该模型配套。',
                '不需要视觉能力的话，把「附加参数」里手动指定的 --mmproj 去掉。',
            ],
            evidence: 'failed to load mmproj / clip_model_load',
        }),
    },
];
/** 识别失败原因；认不出来就返回 null（不硬凑结论）。 */
export function diagnoseLoadFailure(logTail, context = {}) {
    const log = logTail ?? '';
    if (!log.trim())
        return null;
    for (const rule of RULES) {
        if (!rule.test.test(log))
            continue;
        const diagnosis = rule.build(log);
        // 「层数被钉住」这条只有在确实由我们下发了具体层数时才更贴切；
        // 即便如此结论也成立（自适应被跳过是客观事实），因此只补一句上下文。
        if (rule.id === 'fit-blocked-by-pinned-layers' && context.gpuLayersPinned === false) {
            diagnosis.actions.unshift('本次并没有手动钉住层数，请把上面的日志连同当前设置一起反馈。');
        }
        return diagnosis;
    }
    return null;
}
const CONTEXT_RE = /n_ctx\s*=\s*(\d+)/i;
/**
 * 从日志里读出 llama.cpp 实际生效的上下文长度。
 *
 * 用途：`--fit` 为了塞进显存会把上下文**悄悄调小**，而 dsh 侧声明的 contextWindow 还是原值。
 * 两者不一致时，长会话会在中途崩，且崩得毫无线索 —— 所以启动后对一次账，不一致就提醒。
 */
export function extractEffectiveContext(logTail) {
    const matches = [...(logTail ?? '').matchAll(new RegExp(CONTEXT_RE, 'gi'))];
    if (matches.length === 0)
        return null;
    const last = matches[matches.length - 1]?.[1];
    const value = Number.parseInt(last ?? '', 10);
    return Number.isFinite(value) && value > 0 ? value : null;
}
