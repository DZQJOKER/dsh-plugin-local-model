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
        id: 'kv-stream-needs-single-sequence',
        // 实测原文：failed to initialize the context: block KV streaming requires exactly one sequence (-np 1)
        test: /block KV streaming requires exactly one sequence|KV streaming requires[^\n]{0,40}-np\s*1/i,
        build: () => ({
            summary: '"KV cache host-memory staging" requires **exactly one sequence**, but this llama-server did not get 1 sequence, so context initialization failed outright.',
            actions: [
                'The plugin appends -np 1 automatically when staging is on; the most common cause of this error is an -np / --parallel in "Extra arguments" overriding it — remove it.',
                'You can also set "settings -> Local model -> KV host-memory staging (MiB)" to 0 so the parameter is not passed at all.',
                'This parameter is a private feature of a specific llama.cpp branch; upstream builds do not have it, so turning it off has no effect on loading.',
            ],
            evidence: 'block KV streaming requires exactly one sequence (-np 1)',
        }),
    },
    {
        id: 'fit-blocked-by-pinned-layers',
        // 典型：failed to fit params to free device memory: n_gpu_layers already set by user to 99, abort
        test: /failed to fit params to free device memory[\s\S]{0,200}?(n_gpu_layers|n_gpu_layers already set|already set by user)/i,
        build: (log) => {
            const pinned = /(?:n_gpu_layers|n-gpu-layers)[^\d]{0,30}(\d+)/i.exec(log)?.[1];
            return {
                summary: `Not enough VRAM, and llama.cpp's auto-fit is blocked by the "manually pinned GPU layer count"${pinned ? ` (currently ${pinned} layers)` : ''}.`,
                actions: [
                    'Set "settings -> Local model -> GPU layers mode" to "auto" — let llama.cpp decide how many layers to offload by available VRAM; when the model does not fit it places a few fewer layers instead of crashing.',
                    'Also lower the context length (e.g. 32768 -> 16384); the KV cache is the biggest VRAM consumer.',
                    'If it still does not fit, switch to a lower-bit quantization (e.g. IQ4_XS -> Q3_K_M).',
                ],
                evidence: 'failed to fit params to free device memory (--fit only adjusts parameters the user did not set explicitly; a pinned -ngl skips auto-fit)',
            };
        },
    },
    {
        id: 'cuda-oom',
        test: /cudaMalloc failed[^\n]*out of memory|failed to allocate (CUDA|Vulkan|Metal)[^\n]*buffer|out of memory/i,
        build: () => ({
            summary: 'Out of VRAM: model + KV cache exceed the GPU\'s available memory.',
            actions: [
                'Lower the context length (the KV cache scales with it).',
                'Set "GPU layers mode" to "auto", or lower the custom layer count.',
                'Try turning Flash Attention off (on some cards FA uses even more VRAM).',
                'Switch to a lower-bit quantization.',
                'Close other VRAM-hungry programs (browser hardware acceleration, other inference services, games).'
            ],
            evidence: 'cudaMalloc failed / failed to allocate buffer',
        }),
    },
    {
        id: 'flash-attn-form',
        test: /unknown value for --flash-attn|unrecognized argument[^\n]*flash-attn/i,
        build: () => ({
            summary: 'This llama-server does not accept the current form of --flash-attn (shape mismatch).',
            actions: [
                'Set "Flash Attention" to "auto" — in auto mode the plugin does not pass this parameter.',
                'Normally the plugin detects the build shape automatically and retries; if it still fails, detection failed and you can specify it manually via "Extra arguments".',
            ],
            evidence: 'unknown value for --flash-attn',
        }),
    },
    {
        id: 'model-file',
        test: /failed to open GGUF file|unable to load model|no such file or directory|failed to load model from/i,
        build: () => ({
            summary: 'The model file cannot be read.',
            actions: [
                'Confirm that the file pointed to by "settings -> Local model -> Current model" is still in the model directory.',
                'If the model is sharded (-00001-of-0000N.gguf), confirm all shards are present.',
                'Once in place, click "Rescan".',
            ],
            evidence: 'failed to open GGUF file / unable to load model',
        }),
    },
    {
        id: 'arch-unsupported',
        test: /unknown model architecture|unsupported (model )?architecture/i,
        build: () => ({
            summary: 'This llama.cpp version does not recognize the model architecture (most likely llama.cpp is too old).',
            actions: ['Download a newer llama.cpp release and replace the executable in the runtime directory.'],
            evidence: 'unknown model architecture',
        }),
    },
    {
        id: 'mmproj',
        test: /failed to load (mmproj|clip)|mmproj[^\n]*not found|clip_model_load/i,
        build: () => ({
            summary: 'The vision projector file (mmproj) failed to load.',
            actions: [
                'Confirm that mmproj-*.gguf is in the same directory as the model and belongs to it.',
                'If you do not need vision, remove the manually specified --mmproj from "Extra arguments".',
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
            diagnosis.actions.unshift('No layer count was pinned manually this time; please report the log above together with the current settings.');
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
