import { defaultConfig } from './configResolve.js';
import { fieldTypeMap } from './configStore.js';
/** 展示分组。序列化 schema 里出现的、但没列在这里的字段会落到「其他」。 */
const GROUP_DEFS = [
    {
        id: 'model',
        title: 'Model & directories',
        hint: 'Where models are read from and which one is selected; attach a vision projector file and set the image token budget when image input is needed.',
        keys: [
            'enabled',
            'selectedModel',
            'mmprojFile',
            'mtp',
            'mtpWithVision',
            'imageMinTokens',
            'imageMaxTokens',
            'modelsDir',
            'runtimeDir',
            'llamaServerPath',
            'preload',
        ],
    },
    {
        id: 'mtp',
        title: 'Multi-token prediction (MTP) details',
        hint: 'Only active when "Multi-token prediction (MTP)" is on in "Model & directories" above. ' +
            'These three parameters decide how many tokens a draft guesses at once and at what precision the draft KV is stored.',
        keys: ['specKvDtype', 'specDraftNMax', 'specDraftPMin'],
    },
    {
        id: 'server',
        title: 'Service & ports',
        hint: 'The dsh model route must point at the "public port". Leave the internal port at 0 for the least hassle.',
        keys: ['host', 'port', 'llamaPort'],
    },
    {
        id: 'infer',
        title: 'Inference parameters',
        hint: 'Mapped directly to the llama-server command line. When VRAM is short, lower the context length or switch to a lower-bit quantization first. ' +
            '"Output-cap overflow protection" should stay on — the kvmem branch\'s server rejects prompt + max_tokens exceeding the context with a straight 400.',
        keys: [
            'ctxSize',
            'maxTokens',
            'nPredict',
            'guardContextOverflow',
            'gpuLayersMode',
            'gpuLayers',
            'cacheTypeK',
            'cacheTypeV',
            'loadMode',
            'threads',
            'threadsBatch',
            'batchSize',
            'ubatchSize',
            'flashAttention',
            'mmprojOffload',
            'reasoningBudget',
            'reasoningBudgetMessage',
            'reasoningEffort',
            'jinja',
            'chatTemplate',
            'chatTemplateFile',
            'chatTemplateKwargs',
            'enableThinking',
            'preserveThinking',
            'mmap',
            'mlock',
        ],
    },
    {
        id: 'sampling',
        title: 'Sampling & KV cache',
        hint: 'Sampling parameters are passed to llama-server explicitly and override its own defaults (this group\'s defaults differ from llama.cpp\'s — see each item\'s description). ' +
            'The KV options serve long contexts: unified buffering reduces fragmentation, streaming staging moves part of the KV into host memory.',
        keys: [
            'kvUnified',
            'kvStreamStageMib',
            'kvDtype',
            'temp',
            'topK',
            'topP',
            'minP',
            'presencePenalty',
            'frequencyPenalty',
            'repeatPenalty',
            'repeatLastN',
            'seed',
        ],
    },
    {
        id: 'kvmem',
        title: 'KVMem block cache (kvmem branch only)',
        hint: 'The whole group applies only to llama-kvmem-server; official llama.cpp builds skip everything here (nothing is passed when not detected). ' +
            'All defaults are "do not pass", so leaving this untouched means the build\'s own default behavior. ' +
            '★ Look at "decode reserve" first: this build\'s default is only 256, and it is the **per-generation cap**.',
        keys: [
            'kvmemEnabled',
            'kvmemBudget',
            'kvmemGenReserve',
            'kvmemBlockTokens',
            'kvmemSinkTokens',
            'kvmemRecentTokens',
            'kvmemMethod',
            'kvmemQueryLast',
            'kvmemQueryMaxTokens',
            'kvmemQueryReplay',
            'kvmemQueryPolicy',
            'kvmemMtpState',
            'kvmemGpuRatio',
            'kvmemCpuGb',
            'kvmemNvmeGb',
            'kvmemNvmeDir',
            'kvmemHarvestV',
            'kvmemRawKNvme',
        ],
    },
    {
        id: 'lifecycle',
        title: 'Loading & unloading',
        hint: 'How long to stay idle before releasing VRAM, plus load timeout and crash retry.',
        keys: ['idleUnloadMinutes', 'startupTimeoutMs', 'shutdownGraceMs', 'autoRestart', 'maxRestarts'],
    },
    {
        id: 'advanced',
        title: 'Diagnostics & advanced',
        hint: 'For troubleshooting. An empty key means no verification (recommended when listening on loopback only).',
        keys: ['apiKey', 'extraArgs', 'envOverrides', 'logLevel'],
    },
];
/** 数值字段的界面区间（与 configResolve.ts 的收敛区间一致，只是为了让输入框不给出荒谬值）。 */
const RANGES = {
    port: [1, 65535],
    llamaPort: [0, 65535],
    ctxSize: [512, 1_048_576],
    gpuLayers: [-1, 4096],
    threads: [0, 1024],
    threadsBatch: [0, 1024],
    batchSize: [0, 1_048_576],
    ubatchSize: [0, 1_048_576],
    idleUnloadMinutes: [0, 1_000_000],
    startupTimeoutMs: [5_000, 3_600_000],
    shutdownGraceMs: [500, 120_000],
    maxRestarts: [0, 10],
    maxTokens: [64, 131_072],
    kvStreamStageMib: [0, 1_048_576],
    temp: [0, 100],
    topK: [0, 1_048_576],
    topP: [0, 1],
    minP: [0, 1],
    presencePenalty: [-10, 10],
    repeatPenalty: [0, 10],
    repeatLastN: [-1, 1_048_576],
    seed: [-1, 2_147_483_647],
    imageMinTokens: [0, 1_048_576],
    imageMaxTokens: [0, 1_048_576],
    reasoningBudget: [-1, 1_048_576],
    // ── KVMem 家族与新增启动项（区间与 configResolve 的收敛区间一致）──────────
    kvmemBudget: [-1, 1_048_576],
    kvmemGenReserve: [-1, 1_048_576],
    kvmemBlockTokens: [-1, 1_048_576],
    kvmemSinkTokens: [-1, 1_048_576],
    kvmemRecentTokens: [-1, 1_048_576],
    kvmemQueryLast: [-1, 1_048_576],
    kvmemQueryMaxTokens: [-1, 1_048_576],
    kvmemGpuRatio: [-1, 1],
    kvmemCpuGb: [-1, 4096],
    kvmemNvmeGb: [-1, 4096],
    nPredict: [-1, 1_048_576],
    specDraftNMax: [-1, 1024],
    specDraftPMin: [-1, 1],
    frequencyPenalty: [-2, 2],
};
/** 字段的中文短标签。schema 的 description 是句子，这里是控件旁边的短名。 */
const LABELS = {
    enabled: 'Enabled',
    modelsDir: 'Model directory',
    runtimeDir: 'Runtime directory',
    llamaServerPath: 'llama-server path',
    selectedModel: 'Current model',
    mmprojFile: 'Vision projector file',
    mtp: 'Multi-token prediction (MTP)',
    mtpWithVision: 'MTP with vision',
    preload: 'Preload',
    host: 'Listen address',
    port: 'Public port',
    llamaPort: 'Internal port',
    ctxSize: 'Context length',
    gpuLayersMode: 'GPU layers mode',
    gpuLayers: 'GPU layers (when custom)',
    threads: 'CPU threads',
    threadsBatch: 'Batch threads',
    batchSize: 'Logical batch size',
    ubatchSize: 'Physical batch size',
    flashAttention: 'Flash Attention',
    cacheTypeK: 'KV cache precision (K)',
    cacheTypeV: 'KV cache precision (V)',
    kvUnified: 'Unified KV cache',
    kvStreamStageMib: 'KV host-memory staging (MiB)',
    temp: 'Temperature (temp)',
    topK: 'Top-K',
    topP: 'Top-P (nucleus sampling)',
    minP: 'Min-P',
    presencePenalty: 'Presence penalty',
    repeatPenalty: 'Repeat penalty',
    repeatLastN: 'Repeat penalty window',
    seed: 'Random seed',
    imageMinTokens: 'Min image tokens',
    imageMaxTokens: 'Max image tokens',
    reasoningBudget: 'Reasoning token budget',
    jinja: 'Jinja template',
    chatTemplate: 'Chat template',
    enableThinking: 'Enable thinking',
    preserveThinking: 'Preserve historical thinking',
    mmap: 'Memory mapping',
    mlock: 'Pin memory',
    apiKey: 'Access key',
    extraArgs: 'Extra arguments',
    envOverrides: 'Environment variables',
    idleUnloadMinutes: 'Idle unload (minutes)',
    startupTimeoutMs: 'Load timeout (ms)',
    shutdownGraceMs: 'Unload grace (ms)',
    autoRestart: 'Auto-restart on crash',
    maxRestarts: 'Max restarts',
    maxTokens: 'Max output tokens per reply',
    logLevel: 'Log level',
    // ── KVMem 家族与新增启动项 ────────────────────────────────────────────────
    kvmemEnabled: 'Enable KVMem',
    kvmemBudget: 'GPU working-set tokens',
    kvmemGenReserve: 'Decode reserve (generation cap)',
    kvmemBlockTokens: 'Retrieval block size',
    kvmemSinkTokens: 'Resident prefix tokens',
    kvmemRecentTokens: 'Resident suffix tokens',
    kvmemMethod: 'Retrieval algorithm',
    kvmemQueryLast: 'Query fallback length',
    kvmemQueryMaxTokens: 'Query cap tokens',
    kvmemQueryReplay: 'Query replay mode',
    kvmemQueryPolicy: 'Query policy',
    kvmemMtpState: 'MTP state mode',
    kvmemGpuRatio: 'Slot-pool VRAM share',
    kvmemCpuGb: 'CPU overflow field (GiB)',
    kvmemNvmeGb: 'NVMe overflow field (GiB)',
    kvmemNvmeDir: 'NVMe overflow directory',
    kvmemHarvestV: 'Pre-fill V from raw K',
    kvmemRawKNvme: 'Raw K/V to NVMe',
    nPredict: 'Server default output cap',
    loadMode: 'Weight loading mode',
    kvDtype: 'KV cache type (merged)',
    specKvDtype: 'MTP draft KV precision',
    specDraftNMax: 'MTP draft tokens',
    specDraftPMin: 'MTP draft min probability',
    frequencyPenalty: 'Frequency penalty',
    mmprojOffload: 'Vision encoder on GPU',
    chatTemplateFile: 'Template file path',
    chatTemplateKwargs: 'Template defaults (JSON)',
    reasoningEffort: 'Server default reasoning effort',
    reasoningBudgetMessage: 'Budget-exhausted message',
    guardContextOverflow: 'Output-cap overflow protection',
};
/**
 * schemastery 的 schema 实例要经过 toJSON() 才是可解析的 {uid, refs} 图。
 * 传进来的可能是实例，也可能已经是序列化结果（单测/缓存），两种都接受。
 */
export function serializeSchema(schema) {
    const candidate = schema;
    if (candidate && typeof candidate.toJSON === 'function') {
        try {
            return candidate.toJSON();
        }
        catch {
            return schema;
        }
    }
    return schema;
}
/** 从 schema.toJSON() 抽出「字段 → 类型/默认值/说明/可选项」。拿不到就退回类型表。 */
export function extractFields(schema) {
    const types = fieldTypeMap();
    const defaults = defaultConfig();
    const serialized = serializeSchema(schema);
    const refs = serialized?.refs;
    // 根节点的编号是 toJSON() 自报的 uid，不是固定值 —— 写死会静默退化成「没有说明文案」。
    const root = serialized?.uid !== undefined ? refs?.[String(serialized.uid)] : undefined;
    const dict = root?.type === 'object' ? root.dict : undefined;
    const keys = dict ? Object.keys(dict) : Object.keys(types);
    const fields = [];
    for (const key of keys) {
        const refId = dict?.[key];
        const ref = refId !== undefined ? refs?.[String(refId)] : undefined;
        const description = ref?.meta?.description ?? '';
        const type = ref?.type ?? types[key] ?? 'string';
        let kind = 'string';
        let options;
        if (type === 'boolean')
            kind = 'boolean';
        else if (type === 'number')
            kind = 'number';
        else if (type === 'union') {
            const list = ref?.list ?? [];
            options = list
                .map((id) => refs?.[String(id)]?.value)
                .filter((v) => typeof v === 'string');
            kind = options.length > 0 ? 'select' : 'string';
        }
        else if (type === 'object')
            kind = 'text';
        else
            kind = 'string';
        const range = RANGES[key];
        fields.push({
            key,
            label: LABELS[key] ?? key,
            kind,
            description,
            default: ref?.meta?.default ?? defaults[key],
            ...(options ? { options } : {}),
            ...(range ? { min: range[0], max: range[1] } : {}),
            uiGroup: groupOf(key),
        });
    }
    return fields;
}
function groupOf(key) {
    for (const group of GROUP_DEFS) {
        if (group.keys.includes(key))
            return group.id;
    }
    return 'other';
}
export function buildFormDescriptor(schema, resolved, configFile) {
    const fields = extractFields(schema);
    const groups = [];
    for (const def of GROUP_DEFS) {
        const groupFields = fields.filter((f) => f.uiGroup === def.id);
        if (groupFields.length === 0)
            continue;
        groups.push({ id: def.id, title: def.title, hint: def.hint, fields: groupFields });
    }
    const orphans = fields.filter((f) => f.uiGroup === 'other');
    if (orphans.length > 0) {
        groups.push({ id: 'other', title: 'Other', hint: '', fields: orphans });
    }
    return {
        groups,
        schema: serializeSchema(schema),
        paths: {
            modelsDir: resolved.paths.modelsDir,
            runtimeDir: resolved.paths.runtimeDir,
            stateDir: resolved.paths.stateDir,
            configFile,
        },
    };
}
