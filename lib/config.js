import Schema from '@deepseek-ai/schemastery';
/*
 * 原来放在这里的几个常量（DEFAULT_MODEL_ALIAS / LOCAL_ROUTE_NAME / LOCAL_MODEL_ID /
 * EXPOSE_LOCAL_MODEL_TOOL / ALLOW_MODEL_CONTROL）现在定义在 configResolve.ts。
 *
 * 理由：本文件 import 了 schemastery，而 scripts/ 下的自检脚本必须在没有宿主依赖的环境里
 * 也能 import 这些常量（`lib/config.js` 会直接抛 ERR_MODULE_NOT_FOUND）。
 * configResolve.ts 那一层刻意不碰 schemastery，正是为这种场景准备的。
 */
export const Config = Schema.object({
    enabled: Schema.boolean()
        .default(true)
        .description('Master switch. When off, no port is listened on and no llama process is started.'),
    modelsDir: Schema.string()
        .default('')
        .description('Model directory. Empty = ${DSH_HOME}/local-model/models. Put GGUF files here; they can be selected in the settings page dropdown.'),
    runtimeDir: Schema.string()
        .default('')
        .description('Runtime directory. Empty = ${DSH_HOME}/local-model/runtime. Put the llama.cpp llama-server executable here.'),
    llamaServerPath: Schema.string()
        .default('')
        .description('Absolute path to the llama-server executable. Empty = auto-discover in the runtime directory above (including subdirectories).'),
    selectedModel: Schema.string()
        .default('')
        .description('Currently selected local model (relative path under the model directory). Empty = not yet selected.'),
    mmprojFile: Schema.string()
        .default('')
        .description('Vision projector file (mmproj), used to enable image input for multimodal models — passed to llama-server as --mmproj at load time. ' +
        'Empty = keep the original behavior: an mmproj-*.gguf is auto-associated only when its ownership can be uniquely determined in the model directory; ' +
        'selecting a specific file = force it (overrides auto-association). Text-only models do not need this; leave it empty. ' +
        'Note: when Multi-token prediction (MTP) is on, this item is ignored (MTP and image input cannot coexist).'),
    mtp: Schema.boolean()
        .default(false)
        .description('Multi-token prediction (MTP; passes --spec-type draft-mtp at load time). ' +
        'Lets the model guess and verify several tokens at once with its built-in prediction head; local generation speed usually improves by 1.2-2x (more noticeable for longer replies), ' +
        'at the cost of slightly slower prompt processing before the first token and a little extra VRAM. ' +
        'Two prerequisites: (1) the llama.cpp build must support MTP (builds from 2026-05 onward); (2) the model must be a GGUF with an MTP head (file names usually contain "MTP"); ' +
        'toggling this on for a regular GGUF gives no speedup. ' +
        'See the next item, "MTP with vision", for the relation to the vision projector.'),
    mtpWithVision: Schema.boolean()
        .default(true)
        .description('Enable MTP and the vision projector at the same time (on by default). ' +
        '**The kvmem branch\'s llama-kvmem-server supports both coexisting** (verified locally: vision head and MTP draft context load together, image chat works), ' +
        'so using images with MTP on is allowed by default. ' +
        '⚠️ The official llama.cpp llama-server does not — passing both --spec-type draft-mtp and --mmproj causes a **load failure**. ' +
        'If you switch back to the official build and see load errors at startup, turn this item off: the two options become exclusive again, ' +
        'MTP takes effect and the vision projector is ignored (the plugin shows a notice instead of staying silent).'),
    preload: Schema.boolean()
        .default(false)
        .description('Preload: when on, the selected model starts loading immediately instead of waiting for the first message. Uses VRAM but gives a faster first token.'),
    host: Schema.string()
        .default('127.0.0.1')
        .description('Local service listen address. Defaults to loopback only; do not change to 0.0.0.0 unless you understand the exposure risk.'),
    port: Schema.number()
        .default(18080)
        .description('Public port of the local model service. The dsh model route must point at this port. If it is occupied, a free port is used automatically with a notice.'),
    llamaPort: Schema.number()
        .default(0)
        .description('Internal llama-server port. 0 = pick a free port automatically each time (recommended, least likely to conflict).'),
    ctxSize: Schema.number()
        .default(8192)
        .description('Context length (llama.cpp -c). Start at 8K and increase if VRAM allows. ' +
        'The context window declared by the dsh route follows this item (no longer configured separately), so the two always stay aligned and long sessions cannot crash from a declared-larger-than-actual window.'),
    maxTokens: Schema.number()
        .default(8192)
        .description('Max output tokens per reply: the dsh route uses it to cap a single reply. ' +
        'Must be well below the context length above (leaving room for the prompt), otherwise long sessions will overflow the context.'),
    gpuLayers: Schema.number()
        .default(-1)
        .description('Only effective when "GPU layers mode = custom". The exact number of layers offloaded to the GPU (-ngl); a negative value means all layers. ' +
        'If VRAM is insufficient this errors out or even crashes; unless you are sure the model fits, keep the mode on "auto".'),
    gpuLayersMode: Schema.union(['auto', 'all', 'custom'])
        .default('auto')
        .description('GPU layers mode (-ngl). auto = pass -ngl auto and let llama.cpp\'s --fit decide how many layers to offload by available VRAM — ' +
        'when the model does not fit, a few fewer layers are placed automatically instead of crashing; all = put every layer on the GPU (-ngl all); custom = use the number above. ' +
        'Note: --fit only adjusts parameters the user did not set explicitly, so pinning the layer count disables this protection.'),
    threads: Schema.number()
        .default(0)
        .description('CPU thread count (-t). 0 = let llama.cpp infer from the core count.'),
    threadsBatch: Schema.number()
        .default(0)
        .description('Batch thread count (--threads-batch). 0 = unspecified, uses the llama.cpp default.'),
    batchSize: Schema.number()
        .default(2048)
        .description('Logical batch size (-b). Default 2048.'),
    ubatchSize: Schema.number()
        .default(512)
        .description('Physical batch size (-ub). Default 512; must be <= the logical batch size — the plugin converges it automatically.'),
    flashAttention: Schema.union(['auto', 'on', 'off'])
        .default('auto')
        .description('Flash Attention tri-state, aligned with llama.cpp -fa / --flash-attn. auto (recommended) = do not pass the parameter and let llama.cpp decide; ' +
        'on / off are explicit switches. The plugin first probes whether this build\'s --flash-attn is a bare switch or takes a value, then decides how to pass it.'),
    cacheTypeK: Schema.union(['auto', 'f16', 'q8_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'bf16', 'f32', 'iq4_nl'])
        .default('q8_0')
        .description('Quantization of the K buffer (--cache-type-k). Default q8_0 — with long contexts the KV cache is the biggest VRAM consumer, ' +
        'and q8_0 saves half the VRAM of llama.cpp\'s default f16 with minimal accuracy loss; when a large model plus long context OOMs, tune this first. ' +
        'auto = do not pass the parameter (uses llama.cpp\'s default f16); choose only if you know what you are doing.'),
    cacheTypeV: Schema.union(['auto', 'f16', 'q8_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'bf16', 'f32', 'iq4_nl'])
        .default('q8_0')
        .description('Quantization of the V buffer (--cache-type-v). Usually kept in sync with K (default q8_0). ' +
        'auto = do not pass the parameter (uses llama.cpp\'s default f16).'),
    // ── KV 缓存策略 ──────────────────────────────────────────────────────────
    kvUnified: Schema.boolean()
        .default(false)
        .description('Unified KV cache management strategy (--kv-unified). When on, the KV cache is managed as one unified buffer, ' +
        'which organizes the cache better for long sequences and reduces VRAM fragmentation from per-layer allocation, making long contexts easier to fit. ' +
        'The cost: this buffer is reserved in full at load time, so it occupies VRAM even if you rarely use the whole context. ' +
        'Off by default = do not pass the parameter; llama.cpp decides.'),
    kvStreamStageMib: Schema.number()
        .default(1024)
        .description('KV cache host-memory staging amount (MiB, --kv-stream-stage-mib): stage this much of the KV cache in host memory ' +
        'to relieve VRAM pressure; the core parameter of the "adaptive KV streaming" branch this plugin targets. ' +
        'The right value depends on the model, context length, GPU and other VRAM usage — start conservative, increase gradually and watch startup behavior and peak VRAM. ' +
        'Note: this is a private parameter of that branch; upstream llama.cpp does not know it — the plugin probes the build first and skips it automatically on builds that do not recognize it (noted in the log). 0 = do not pass. ' +
        '★ It has a precondition: block-level KV streaming requires **a single sequence**, so whenever this item > 0 and the build supports it, the plugin **automatically appends -np 1** ' +
        '(llama.cpp\'s -np defaults to "auto", which lands on multiple sequences and fails loading outright). ' +
        'So with this item on, concurrency is 1 — no impact for local single-user use, but if you set -np / --parallel yourself in "Extra arguments", ' +
        'the plugin will not override it, and a value other than 1 there will fail loading.'),
    // ── KVMem 分块 KV 检索（kvmem/kvmem-llama.cpp 分支专有）──────────────────
    /*
     * 这一整组的默认值都是「不下发」：-1 表示不传该参数、空串表示不传、
     * 布尔项按构建默认。因此装了官方 llama.cpp 的用户不会受任何影响 ——
     * 这些选项会先经过 --help 探测，构建不认识就整体跳过（并在日志里说明）。
     *
     * 反过来，用 kvmem 分支的人会拿到一个关键提醒：它的 --kvmem-gen-reserve 默认只有 256，
     * 而那是**单次生成的上限**，详见该项的说明。
     */
    kvmemEnabled: Schema.boolean()
        .default(true)
        .description('Enable KVMem block KV retrieval (--kvmem / --no-kvmem). On by default (no parameter passed, build defaults used): ' +
        'historical tokens are stored in blocks on the host side and the GPU keeps only one working set, so long contexts do not have to fit entirely in VRAM. ' +
        'When off, --no-kvmem is passed and plain KV caching is used — VRAM usage scales strongly with context length, making long contexts more prone to OOM. ' +
        'Only applies to the kvmem branch\'s llama-kvmem-server; official llama.cpp builds skip this item.'),
    kvmemBudget: Schema.number()
        .default(-1)
        .description('GPU working-set token count (--kvmem-budget): how many historical tokens may stay in VRAM during retrieval. ' +
        '-1 = do not pass, keep the build default (0, meaning "equal to n_ctx"). ' +
        'This is the main knob for long-context VRAM usage: lower saves VRAM but reaches less history; ' +
        'higher does the opposite. Together with "decode reserve" below it determines total GPU KV (budget + gen_reserve).'),
    kvmemGenReserve: Schema.number()
        .default(-1)
        .description('Decode reserve (--kvmem-gen-reserve): GPU slots reserved for newly generated tokens. ' +
        '★ It is also the **per-generation cap** (including thinking content) — a single reply can never exceed this length no matter what you set; ' +
        'anything beyond it is hard-truncated without an error. ' +
        '⚠️ This build\'s default is only 256: if left unset, the model writes at most 256 tokens per reply, ' +
        'which looks like "the answer stops mid-sentence" and is easily mistaken for a broken model. ' +
        'Set it to at least the dsh route\'s "max output tokens per reply" (e.g. 8192-16384). -1 = do not pass (= keep 256).'),
    kvmemBlockTokens: Schema.number()
        .default(-1)
        .description('Retrieval block size (--kvmem-block-tokens): KV is organized and moved in blocks this large. Default 128. -1 = do not pass.'),
    kvmemSinkTokens: Schema.number()
        .default(-1)
        .description('Resident prefix token count (--kvmem-sink-tokens): this many leading tokens always stay in the GPU working set and are not evicted by retrieval. ' +
        'Good for keeping "needed every turn" content such as the system prompt resident. 0 = keep only one block (not off). -1 = do not pass.'),
    kvmemRecentTokens: Schema.number()
        .default(-1)
        .description('Resident suffix token count (--kvmem-recent-tokens): this many most recent tokens always stay in the working set. Default 0. -1 = do not pass.'),
    kvmemMethod: Schema.union(['', 'recency', 'retrieval'])
        .default('')
        .description('Selection algorithm (--kvmem-method): retrieval = retrieve the most relevant historical blocks for the current prompt (default, better for long conversations); ' +
        'recency = keep recent blocks by recency only. Empty = do not pass.'),
    kvmemQueryLast: Schema.number()
        .default(-1)
        .description('Fallback length for the retrieval query (--kvmem-query-last): use this many trailing tokens as the query. Default 64. -1 = do not pass.'),
    kvmemQueryMaxTokens: Schema.number()
        .default(-1)
        .description('Length cap for the retrieval query (--kvmem-query-max-tokens): how long to truncate "the last user message" when used as the query. Default 512. -1 = do not pass.'),
    kvmemQueryReplay: Schema.union(['', 'legacy', 'auto'])
        .default('')
        .description('Query replay mode (--kvmem-query-replay). Empty = do not pass (build default auto). Leave empty if unsure.'),
    kvmemQueryPolicy: Schema.union(['', 'legacy', 'user'])
        .default('')
        .description('Query policy (--kvmem-query-policy). Empty = do not pass (build default user). Leave empty if unsure.'),
    kvmemMtpState: Schema.union(['', 'snapshots', 'auto', 'replay'])
        .default('')
        .description('MTP state mode (--kvmem-mtp-state): how draft state is reused across turns while multi-token prediction is on. ' +
        'Empty = do not pass (build default replay). If long conversations misbehave with MTP on, try auto first.'),
    kvmemGpuRatio: Schema.number()
        .default(-1)
        .description('Cap on the slot pool\'s share of VRAM (--kvmem-gpu-ratio, a decimal 0-1, e.g. 0.8): the KV slot pool may use at most this fraction of GPU VRAM. ' +
        'Default 0.50; raise it when VRAM is plentiful to fit a longer working set. -1 = do not pass.'),
    kvmemCpuGb: Schema.number()
        .default(-1)
        .description('CPU overflow field size (GiB, --kvmem-cpu-gb): how many GiB of history beyond the GPU working set may spill into host memory. ' +
        '0 = off (build default). Note this trades memory for capacity — it is not free and slows retrieval for long contexts. -1 = do not pass.'),
    kvmemNvmeGb: Schema.number()
        .default(-1)
        .description('NVMe overflow field size (GiB, --kvmem-nvme-gb): spill overflowing KV to an NVMe file. 0 = off (build default). -1 = do not pass.'),
    kvmemNvmeDir: Schema.string()
        .default('')
        .description('NVMe overflow field directory (--kvmem-nvme-dir). Empty = do not pass (build default /tmp/kvmem_nvme; on Windows it is recommended to specify a directory on a drive explicitly).'),
    kvmemHarvestV: Schema.boolean()
        .default(false)
        .description('Pre-fill V into host memory from raw K (--kvmem-harvest-v). Off by default. Only needed when tuning NVMe spill with the official recipe.'),
    kvmemRawKNvme: Schema.boolean()
        .default(false)
        .description('Write both raw K and V to NVMe (--kvmem-raw-k-nvme). The NVMe overflow field size above must be set first, otherwise the build errors.'),
    // ── 输出上限、加载方式、MTP 细节与模板 ────────────────────────────────────
    nPredict: Schema.number()
        .default(-1)
        .description('Server-side default output cap (-n / --n-predict): how many tokens **requests without their own max_tokens** may generate at most. ' +
        'Not the same as "max output tokens per reply" — that one is declared by the dsh route and attached to every request; ' +
        'this item only affects calls that bypass dsh (curl, scripts, other clients). ' +
        '⚠️ On the kvmem branch this default is only 128; when calling the local model from external scripts, set it to a value like 8192. -1 = do not pass.'),
    loadMode: Schema.union(['', 'auto', 'none', 'mmap', 'mlock', 'mmap+mlock', 'dio'])
        .default('')
        .description('Weight loading mode (-lm / --load-mode): auto = automatic, none = no special handling, mmap = memory mapping, ' +
        'mlock = pin in physical memory, mmap+mlock = both, dio = direct IO (bypasses the page cache). ' +
        'Empty = do not pass; the "memory mapping" and "pin memory" switches below then apply (equivalent to the old behavior). ' +
        'The kvmem branch treats --mmap / --no-mmap / --mlock as obsolete aliases of -lm, so this item is more reliable.'),
    kvDtype: Schema.union(['', 'f16', 'f32', 'q8_0', 'q5_0', 'q4_0'])
        .default('')
        .description('GPU KV cache type (--kv-dtype): sets K and V at once; the merged form of the kvmem branch. ' +
        'Empty = do not pass, and use the two "KV cache precision (K/V)" items below instead (upstream llama.cpp only has those two channels). ' +
        'Setting both is a duplicate configuration — the plugin shows a notice and recommends keeping just one. Only applies to the kvmem branch.'),
    specKvDtype: Schema.union(['', 'f16', 'f32', 'q8_0', 'q5_0', 'q4_0'])
        .default('')
        .description('K/V precision for multi-token prediction (MTP) drafts (--spec-kv-dtype). Empty = do not pass (build default f16). Lowering it saves VRAM.'),
    specDraftNMax: Schema.number()
        .default(-1)
        .description('MTP draft tokens per step (--spec-draft-n-max): how many follow-up tokens to guess at once. Default 3; raising it may be faster or may waste guesses. -1 = do not pass.'),
    specDraftPMin: Schema.number()
        .default(-1)
        .description('Minimum acceptance probability for MTP drafts (--spec-draft-p-min, 0-1). Default 0 (no such filtering). -1 = do not pass.'),
    frequencyPenalty: Schema.number()
        .default(0)
        .description('Frequency penalty (--frequency-penalty): suppresses repeated words by occurrence count, -2 to 2. 0 = no penalty, and the parameter is **not passed** (matches the build default).'),
    mmprojOffload: Schema.boolean()
        .default(true)
        .description('Vision encoder on the GPU (--mmproj-offload / --no-mmproj-offload). On by default (no parameter passed). ' +
        'When VRAM is tight, turn it off so vision encoding runs on the CPU — saves VRAM but viewing images is noticeably slower. Only meaningful when a vision projector file is attached.'),
    chatTemplateFile: Schema.string()
        .default('')
        .description('Chat template file path (--chat-template-file): read a Jinja template file directly, replacing the one built into the model GGUF. ' +
        'This and "chat template" above are two channels; if both are set, the build decides which wins — keep only one. Empty = do not pass.'),
    chatTemplateKwargs: Schema.string()
        .default('')
        .description('Template default parameters (--chat-template-kwargs, JSON text). Example: {"enable_thinking":true}. ' +
        'These are **load-time** template defaults; same-named parameters in individual requests override them. Empty = do not pass.'),
    reasoningEffort: Schema.union(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
        .default('')
        .description('Server-side default reasoning effort (--reasoning-effort): the value used when a **request does not express its own effort**, passed straight to the model template; ' +
        'none = no thinking. The effort name must be recognized by the model template (the kvmem build is lenient here and falls back to the template default when unknown). ' +
        'Empty = do not pass. Note: the "reasoning level" slider in the dsh chat box is sent per request; the two do not conflict — the request wins.'),
    reasoningBudgetMessage: Schema.string()
        .default('')
        .description('Transition message when the reasoning budget is exhausted (--reasoning-budget-message): a sentence injected before thinking is force-ended, ' +
        'letting the model wrap up smoothly (e.g. "time is up, please answer directly"). Without it the model is hard-cut off and answer quality drops noticeably. Empty = do not pass.'),
    guardContextOverflow: Schema.boolean()
        .default(true)
        .description('Output-cap overflow protection (on by default). ' +
        'Upstream llama.cpp only logs a warning and converges on its own when prompt + max_tokens exceeds the context, ' +
        'but the kvmem branch\'s standalone server **returns 400 directly**: prompt + max_tokens exceeds n_ctx, ' +
        'and the error contains neither the prompt length nor n_ctx, making it hard to diagnose. ' +
        'When on, the plugin compresses "guaranteed-to-fail" oversized output caps at request entry and retries with halving when the server rejects; ' +
        'only when it truly does not fit is the error returned, with a note explaining the real cause. ' +
        'It only touches max_tokens, never your conversation content; turning it off adds no capability — unless you are debugging this layer.'),
    // ── 采样参数 ────────────────────────────────────────────────────────────
    temp: Schema.number()
        .default(0.75)
        .description('Temperature (--temp): controls output randomness — higher is more random, lower more deterministic. ' +
        'Note llama.cpp\'s own default is 0.8; this item\'s default of 0.75 means the plugin passes the parameter explicitly and overrides it.'),
    topK: Schema.number()
        .default(20)
        .description('Sample only from the K most probable tokens (--top-k). 0 = no filtering (keep all candidates). ' +
        'Note llama.cpp\'s own default is 40.'),
    topP: Schema.number()
        .default(0.95)
        .description('Nucleus sampling (--top-p): sample only from the set of tokens whose cumulative probability reaches this ratio. Matches llama.cpp\'s own default.'),
    minP: Schema.number()
        .default(0)
        .description('Minimum probability threshold (--min-p): filter out tokens whose probability is below "best candidate probability x this value". 0 = no filtering. ' +
        'Note llama.cpp\'s own default is 0.05; this item\'s default of 0 means filtering is off.'),
    presencePenalty: Schema.number()
        .default(0)
        .description('Presence penalty (--presence-penalty): positive values encourage the model to talk about new topics. 0 = no penalty.'),
    repeatPenalty: Schema.number()
        .default(1)
        .description('Repeat penalty (--repeat-penalty): 1.0 means no penalty; values above 1.0 suppress repeated content. ' +
        'Note llama.cpp\'s own default is 1.1; this item\'s default of 1.0 means the penalty is off.'),
    repeatLastN: Schema.number()
        .default(64)
        .description('Token window checked by the repeat penalty (--repeat-last-n): how many recent tokens are inspected for repetition.'),
    seed: Schema.number()
        .default(-1)
        .description('Random seed (--seed): -1 = use a random seed on every start (matches the llama.cpp default). A fixed value makes output reproducible.'),
    // ── 多模态图像预算与推理预算 ──────────────────────────────────────────────
    imageMinTokens: Schema.number()
        .default(1024)
        .description('Minimum tokens per image (--image-min-tokens). Affects the granularity and compute cost of vision understanding: ' +
        'higher → more detail, slower and more VRAM; lower → cheaper but small text may become unreadable. ' +
        'Only applies to **dynamic-resolution** vision models (regular vision models ignore it), and a vision projector file (--mmproj) must be attached first. ' +
        'Note: with "Multi-token prediction (MTP)" on, the vision projector is disabled, so these two items cannot take effect.'),
    imageMaxTokens: Schema.number()
        .default(4096)
        .description('Maximum tokens per image (--image-max-tokens). Must be >= the minimum token count above; the plugin converges it automatically. ' +
        'This is the per-image cost cap — reduce it first when VRAM is tight. Also only applies to dynamic-resolution vision models.'),
    reasoningBudget: Schema.number()
        .default(4096)
        .description('Token budget for the reasoning process (--reasoning-budget): caps the length of the thinking chain; when exceeded, thinking is force-ended and the model answers directly. ' +
        'Value semantics: -1 = unlimited (llama.cpp default), 0 = end thinking immediately, N>0 = set a budget cap. ' +
        'Requires the model template to support thinking markers and a relatively new llama.cpp build (the plugin probes first and skips if the build does not recognize it). ' +
        '★ Relation to "enable thinking": this item is an engine-level cap passed at load time, while "enable thinking" is a per-request template-level switch; ' +
        'they do not conflict but stack — see the "enable thinking" item for details. To disable thinking entirely, prefer "enable thinking"; use this item to cap the thinking chain. ' +
        'Two caveats: (1) when the budget is exhausted the model is hard-cut off, and llama.cpp\'s transition message (--reasoning-budget-message) is not passed by the plugin — ' +
        'a too-tight budget noticeably drops answer quality (an official maintainer measured 94% -> 78% on HumanEval); add the message via "Extra arguments" if you need it; ' +
        '(2) although 0 semantically means "end thinking immediately", it is not fully reliable on some models.'),
    jinja: Schema.boolean()
        .default(true)
        .description('Use the model\'s built-in Jinja chat template (--jinja). dsh tool calling depends on it; do not turn it off unless the model template is incompatible.'),
    chatTemplate: Schema.string()
        .default('')
        .description('Manually specify a chat template (--chat-template). Empty = use the model\'s built-in template. If tool calling misbehaves, try chatml or a template file path.'),
    enableThinking: Schema.boolean()
        .default(true)
        .description('Enable thinking: let the model emit its reasoning process (think) while inferring. ' +
        'On = acts only as a **default**: when a request does not express its own thinking state, the plugin adds chat_template_kwargs.enable_thinking=true; ' +
        'if the request already carries enable_thinking or a reasoning effort (reasoning_effort), it is **passed through untouched** — ' +
        'so selecting Off on the "reasoning level" slider in the dsh chat box truly turns thinking off. ' +
        'Off = unconditionally force enable_thinking=false, no thinking at all (hard override). ' +
        'This item is changed in the request body, not in model load parameters, so on older llama.cpp the worst case is "the switch has no effect" — it cannot break loading. ' +
        '★ Relation to "reasoning token budget" (--reasoning-budget): both can make the model "think less", but at different layers — ' +
        'this item is **template-level, applied per request** (tells the template not to enter thinking mode); the budget is **engine-level, passed at load time** (counts thinking tokens and force-ends when exceeded). ' +
        'They are not mutually exclusive and do not error against each other, but they stack: with this item off the budget is never triggered (the template does not enter thinking at all); ' +
        'with this item on plus a budget of 0 you get "enter thinking, then immediately cut off", usually showing as an empty thinking block and sometimes derailing some models — avoid both combinations.'),
    preserveThinking: Schema.boolean()
        .default(true)
        .description('Preserve historical thinking: in multi-turn conversations, keep the think content of historical messages in context. ' +
        'On = pass chat_template_kwargs.preserve_thinking=true and keep historical messages as-is (the model sees its earlier reasoning — usually more accurate but costs tokens); ' +
        'Off = pass preserve_thinking=false and also strip reasoning_content / think text from historical assistant messages, shortening the context. ' +
        'Fully effective only for models whose template supports the switch (e.g. the Qwen3.6 series); other models ignore it.'),
    mmap: Schema.boolean()
        .default(true)
        .description('Load the model with memory mapping (mmap). On by default — fast loading, low memory use; can be turned off for network drives or special file systems.'),
    mlock: Schema.boolean()
        .default(false)
        .description('Pin the model in physical memory (--mlock). Prevents swapping out, but causes errors when memory runs short; enable as needed.'),
    apiKey: Schema.string()
        .default('')
        .description('Access key for the local service. Empty = no verification (recommended when listening on loopback only). When set, it is used by both llama-server and the dsh-side route.')
        .role('secret'),
    extraArgs: Schema.string()
        .default('')
        .description('Extra command-line arguments, split on whitespace with quote support. Example: --no-warmup --rope-scaling linear.'),
    envOverrides: Schema.dict(Schema.string())
        .default({})
        .description('Extra environment variables passed to llama-server, e.g. CUDA_VISIBLE_DEVICES=0.'),
    idleUnloadMinutes: Schema.number()
        .default(5)
        .description('Idle unload: automatically unload the model and release VRAM/memory after this many minutes without conversation activity. 0 = disable auto-unload.'),
    startupTimeoutMs: Schema.number()
        .default(180000)
        .description('Timeout for waiting on model load completion (ms). The first load of a large model can be slow; default is 3 minutes.'),
    shutdownGraceMs: Schema.number()
        .default(8000)
        .description('Graceful-shutdown wait time on unload (ms); after the timeout the process tree is force-killed.'),
    autoRestart: Schema.boolean()
        .default(true)
        .description('Automatically restart once when llama-server crashes unexpectedly while in use.'),
    maxRestarts: Schema.number()
        .default(2)
        .description('Maximum automatic restarts on consecutive crashes; beyond that the state becomes failed and retries stop, avoiding an infinite restart loop saturating the CPU.'),
    logLevel: Schema.union(['silent', 'error', 'warn', 'info', 'debug'])
        .default('info')
        .description('Plugin log level. Set to debug when troubleshooting startup issues to see llama-server\'s full output.'),
});
/**
 * 编译期护栏：schema 推导出的类型必须能赋给 LocalModelConfig。
 * 以后给 schema 加字段却忘了同步接口（或反之），这里会直接编译失败，
 * 而不是等到运行时 config.xxx 变成 undefined。
 */
const _configShapeCheck = null;
void _configShapeCheck;
