import type { LocalModelConfig } from './config.js';
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
export declare const PRESET_EXCLUDED_KEYS: readonly string[];
/** 预设里允许出现的字段（= 全部可写字段 − 上面那些环境字段）。 */
export declare function presetKeys(): string[];
export interface Preset {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    /** 只含 presetKeys() 里的字段，且已按类型强制转换过。 */
    values: Partial<LocalModelConfig>;
}
export declare const MAX_PRESETS = 100;
export declare const MAX_NAME_LENGTH = 40;
/** 名称归一化：去两端空白、把连续空白压成一个空格、按码点截断。 */
export declare function normalizePresetName(input: unknown): string;
/** 只保留预设作用域内的字段，并复用配置写入闸门做类型强制转换。 */
export declare function sanitizePresetValues(input: unknown): Partial<LocalModelConfig>;
/**
 * 从一份完整配置里摘出预设作用域的快照。
 *
 * 参数取 `object` 而不是 `Record<string, unknown>`：调用方给的是 ResolvedConfig
 * （接口 + 额外字段，没有索引签名），强行要求索引签名会逼着调用点到处写断言。
 */
export declare function snapshotPresetValues(source: object): Partial<LocalModelConfig>;
/**
 * 预设仓库。
 *
 * 读失败（文件缺失、JSON 损坏、字段离谱）一律降级成「没有预设」而不是抛错 ——
 * 一个坏掉的预设文件不该让插件起不来，它只是便利功能。
 */
export declare class PresetStore {
    private readonly file;
    private items;
    private warning;
    constructor(file: string);
    get filePath(): string;
    /** 上一次读取时发现的问题（界面可以直接显示给用户）。正常时为 null。 */
    get loadWarning(): string | null;
    load(): Promise<void>;
    list(): Preset[];
    /** 查一个预设。返回**副本** —— 调用方改它不会静默绕开落盘（内部改动一律走 require）。 */
    find(id: unknown): Preset | undefined;
    /** 保存一组新预设。名称重复会被拒绝 —— 界面上两个同名条目是纯粹的困惑来源。 */
    create(name: unknown, values: unknown): Promise<Preset>;
    /** 用新的一套参数覆盖既有预设；名称保持不变。 */
    overwrite(id: unknown, values: unknown): Promise<Preset>;
    rename(id: unknown, name: unknown): Promise<Preset>;
    remove(id: unknown): Promise<Preset>;
    /** 当前生效配置与哪一个预设完全一致（都不一致时为 null）。界面用它高亮「当前生效」。 */
    activeId(current: Record<string, unknown>): string | null;
    /** 这个预设与当前配置有几项不同。 */
    diffCount(values: Partial<LocalModelConfig>, current: Record<string, unknown>): number;
    /** 内部专用：拿到**活对象**再改，改完由调用方 persist。 */
    private require;
    private requireName;
    private assertNameFree;
    /** 先写临时文件再改名 —— 中途断电也不会留下半个 JSON。 */
    private persist;
}
