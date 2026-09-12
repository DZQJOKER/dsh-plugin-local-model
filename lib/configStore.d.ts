import type { LocalModelConfig } from './config.js';
import { type ResolvedConfig } from './configResolve.js';
export declare const EDITABLE_KEYS: (keyof LocalModelConfig)[];
/**
 * 用户层配置。
 *
 * dsh 自身的设置解析是三层的（schema 默认值 → 组合层注册值 → 用户覆盖值），
 * 这里沿用同样的语义，但把用户层落在插件自己的目录里：
 *
 *   schema 默认值  →  组合层（cordis.patch.yml / 部署配置）  →  <stateDir>/config.json（本文件）
 *
 * 为什么不用 dsh 的 settings 命名空间：当前 dsh 版本的 settings apiproxy 只服务
 * 硬编码的命名空间白名单，第三方插件的命名空间一律答复 settings-not-exposed，
 * 浏览器侧读不到也写不进。自建一层同源 HTTP 桥（见 webBridge.ts）是这一版宿主上
 * 唯一可靠的路径，也让这些设置不依赖宿主内部接口的变动。
 */
export declare class ConfigStore {
    private readonly file;
    private readonly base;
    private values;
    constructor(file: string, base: Partial<LocalModelConfig>);
    get filePath(): string;
    /** 读取用户层；文件缺失或损坏都退回空值，绝不因此让插件起不来。 */
    load(): Promise<void>;
    get userValues(): Partial<LocalModelConfig>;
    /** 合并三层，得到运行时配置。 */
    resolve(): ResolvedConfig;
    /** 写入一批字段；只接受白名单内的键，其余静默丢弃。 */
    update(patch: Record<string, unknown>): Promise<ResolvedConfig>;
    /** 清空用户层，回到组合层 + schema 默认值。 */
    reset(): Promise<ResolvedConfig>;
    /** 哪些字段被用户改过（界面用来显示「已覆盖 · 恢复默认」）。 */
    overriddenKeys(): string[];
    private persist;
}
/** 按类型表强制转换；无法转换的键直接丢掉，而不是留下半个值。 */
export declare function sanitize(input: unknown): Partial<LocalModelConfig>;
export declare function editableKeySet(): Set<string>;
/** 供表单渲染使用：字段 → 类型 / 默认值 / 是否可写。 */
export declare function fieldTypeMap(): Record<string, string>;
export declare function defaultsForForm(): LocalModelConfig;
