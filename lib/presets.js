import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EDITABLE_KEYS, sanitize } from './configStore.js';
/*
 * 参数预设：把一整套「加载/推理参数」存成一个带名字的条目，之后一键切换。
 *
 * 为什么独立成一个文件而不是塞进 ConfigStore：
 *   1. 预设是**列表**，而用户层配置是**一张扁平表**。混在一起会让 config.json 里
 *      出现一个叫 presets 的巨型字段，还得进写入闸门，得不偿失；
 *   2. 这个文件刻意只依赖 configStore（不碰 schemastery），于是可以在没有宿主依赖的
 *      环境里直接单测 —— 与 configResolve.ts 同样的理由。
 *
 * 存储落在 <stateDir>/presets.json，与 config.json 同一个目录。
 */
/**
 * 不进预设的字段。
 *
 * 判据是「这属于**这台机器**，不属于**这套参数**」：
 *   - 端口 / 监听地址：改了要重启才完全生效，且和别的服务是否占用有关；
 *   - 磁盘路径：模型目录、运行时目录是部署环境，不是可切换的调参；
 *   - 密钥：预设文件里不该再存一份明文（它已经在 config.json 里了）；
 *   - 日志级别：排查问题时的临时开关；
 *   - 总开关：切个参数预设就把插件关掉，只可能是误伤。
 *
 * 其余 41 个字段全部进预设 —— 包括选中的模型与视觉投影文件：像「看图」这种预设，
 * 本来就应该连同模型一起切过去。
 */
export const PRESET_EXCLUDED_KEYS = [
    'enabled',
    'modelsDir',
    'runtimeDir',
    'llamaServerPath',
    'host',
    'port',
    'llamaPort',
    'apiKey',
    'logLevel',
];
/** 预设里允许出现的字段（= 全部可写字段 − 上面那些环境字段）。 */
export function presetKeys() {
    const excluded = new Set(PRESET_EXCLUDED_KEYS);
    return EDITABLE_KEYS.filter((key) => !excluded.has(key));
}
export const MAX_PRESETS = 100;
export const MAX_NAME_LENGTH = 40;
const FILE_VERSION = 1;
/** 名称归一化：去两端空白、把连续空白压成一个空格、按码点截断。 */
export function normalizePresetName(input) {
    const raw = typeof input === 'string' ? input : '';
    const collapsed = raw.replace(/\s+/g, ' ').trim();
    return [...collapsed].slice(0, MAX_NAME_LENGTH).join('');
}
/** 只保留预设作用域内的字段，并复用配置写入闸门做类型强制转换。 */
export function sanitizePresetValues(input) {
    const clean = sanitize(input);
    const allowed = new Set(presetKeys());
    const out = {};
    for (const [key, value] of Object.entries(clean)) {
        if (allowed.has(key))
            out[key] = value;
    }
    return out;
}
/**
 * 预设至少要有一项参数才成立。
 *
 * 空预设应用起来等于「什么都没做，还把模型卸了一遍」，是纯粹的意外 —— 与其存下去，
 * 不如当场报错。真正会导致空的地方是「整份参数都没通过写入闸门」，那本身就说明有 bug。
 */
function requireValues(input) {
    const values = sanitizePresetValues(input);
    if (Object.keys(values).length === 0) {
        throw new Error('这套参数里没有任何可保存的项，预设未被保存');
    }
    return values;
}
/**
 * 从一份完整配置里摘出预设作用域的快照。
 *
 * 参数取 `object` 而不是 `Record<string, unknown>`：调用方给的是 ResolvedConfig
 * （接口 + 额外字段，没有索引签名），强行要求索引签名会逼着调用点到处写断言。
 */
export function snapshotPresetValues(source) {
    const bag = source;
    const out = {};
    for (const key of presetKeys()) {
        if (bag[key] !== undefined)
            out[key] = bag[key];
    }
    return out;
}
/** 值比较：标量直接比，字典/数组按结构比（envOverrides 是对象）。 */
function sameValue(a, b) {
    if (a === b)
        return true;
    if (typeof a !== typeof b)
        return false;
    if (a === null || b === null || typeof a !== 'object')
        return false;
    return JSON.stringify(a) === JSON.stringify(b);
}
/**
 * 预设仓库。
 *
 * 读失败（文件缺失、JSON 损坏、字段离谱）一律降级成「没有预设」而不是抛错 ——
 * 一个坏掉的预设文件不该让插件起不来，它只是便利功能。
 */
export class PresetStore {
    file;
    items = [];
    warning = null;
    constructor(file) {
        this.file = file;
    }
    get filePath() {
        return this.file;
    }
    /** 上一次读取时发现的问题（界面可以直接显示给用户）。正常时为 null。 */
    get loadWarning() {
        return this.warning;
    }
    async load() {
        this.warning = null;
        let raw;
        try {
            raw = await readFile(this.file, 'utf8');
        }
        catch {
            // 从没存过预设：这是最常见的情况，不算问题。
            this.items = [];
            return;
        }
        try {
            const parsed = JSON.parse(raw);
            const list = Array.isArray(parsed?.items) ? parsed.items : [];
            const items = [];
            const seen = new Set();
            for (const entry of list) {
                const candidate = entry;
                const name = normalizePresetName(candidate?.name);
                const id = typeof candidate?.id === 'string' ? candidate.id.trim() : '';
                if (!id || !name || seen.has(id))
                    continue;
                const values = sanitizePresetValues(candidate.values);
                // 一项参数都没有的条目留着只会让用户点出一个「什么都没发生」的按钮。
                if (Object.keys(values).length === 0)
                    continue;
                seen.add(id);
                const at = new Date().toISOString();
                items.push({
                    id,
                    name,
                    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : at,
                    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : at,
                    values,
                });
                if (items.length >= MAX_PRESETS)
                    break;
            }
            this.items = items;
            if (Array.isArray(parsed?.items) && items.length !== parsed.items.length) {
                this.warning = `预设文件里有 ${parsed.items.length - items.length} 条记录不完整，已跳过（文件：${this.file}）`;
            }
        }
        catch (error) {
            this.items = [];
            this.warning = `预设文件解析失败，已按「没有预设」处理：${error.message}`;
        }
    }
    list() {
        return this.items.map((item) => ({ ...item, values: { ...item.values } }));
    }
    /** 查一个预设。返回**副本** —— 调用方改它不会静默绕开落盘（内部改动一律走 require）。 */
    find(id) {
        const key = typeof id === 'string' ? id : '';
        const hit = this.items.find((item) => item.id === key);
        return hit ? { ...hit, values: { ...hit.values } } : undefined;
    }
    /** 保存一组新预设。名称重复会被拒绝 —— 界面上两个同名条目是纯粹的困惑来源。 */
    async create(name, values) {
        const label = this.requireName(name);
        this.assertNameFree(label, null);
        if (this.items.length >= MAX_PRESETS) {
            throw new Error(`预设数量已达上限（${MAX_PRESETS} 组），请先删掉一些`);
        }
        const now = new Date().toISOString();
        const preset = {
            id: randomUUID(),
            name: label,
            createdAt: now,
            updatedAt: now,
            values: requireValues(values),
        };
        this.items.push(preset);
        await this.persist();
        return { ...preset, values: { ...preset.values } };
    }
    /** 用新的一套参数覆盖既有预设；名称保持不变。 */
    async overwrite(id, values) {
        const preset = this.require(id);
        preset.values = requireValues(values);
        preset.updatedAt = new Date().toISOString();
        await this.persist();
        return { ...preset, values: { ...preset.values } };
    }
    async rename(id, name) {
        const preset = this.require(id);
        const label = this.requireName(name);
        this.assertNameFree(label, preset.id);
        preset.name = label;
        preset.updatedAt = new Date().toISOString();
        await this.persist();
        return { ...preset, values: { ...preset.values } };
    }
    async remove(id) {
        const preset = this.require(id);
        this.items = this.items.filter((item) => item.id !== preset.id);
        await this.persist();
        return { ...preset, values: { ...preset.values } };
    }
    /** 当前生效配置与哪一个预设完全一致（都不一致时为 null）。界面用它高亮「当前生效」。 */
    activeId(current) {
        const hit = this.items.find((item) => this.diffCount(item.values, current) === 0 && Object.keys(item.values).length > 0);
        return hit ? hit.id : null;
    }
    /** 这个预设与当前配置有几项不同。 */
    diffCount(values, current) {
        let n = 0;
        for (const key of presetKeys()) {
            if (!Object.prototype.hasOwnProperty.call(values, key))
                continue;
            if (!sameValue(values[key], current[key]))
                n++;
        }
        return n;
    }
    /** 内部专用：拿到**活对象**再改，改完由调用方 persist。 */
    require(id) {
        const key = typeof id === 'string' ? id : '';
        const hit = this.items.find((item) => item.id === key);
        if (!hit)
            throw new Error(`找不到这个预设（id: ${String(id)}），可能已被删除`);
        return hit;
    }
    requireName(name) {
        const label = normalizePresetName(name);
        if (!label)
            throw new Error('预设名称不能为空');
        return label;
    }
    assertNameFree(label, selfId) {
        const lower = label.toLowerCase();
        const hit = this.items.find((item) => item.id !== selfId && item.name.toLowerCase() === lower);
        if (hit)
            throw new Error(`已经有一个叫「${hit.name}」的预设了，换个名字`);
    }
    /** 先写临时文件再改名 —— 中途断电也不会留下半个 JSON。 */
    async persist() {
        await mkdir(path.dirname(this.file), { recursive: true });
        const payload = {
            version: FILE_VERSION,
            updatedAt: new Date().toISOString(),
            items: this.items,
        };
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        await rename(tmp, this.file);
    }
}
