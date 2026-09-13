import type { ResolvedConfig } from './configResolve.js';
/**
 * 设置页表单描述。
 *
 * 字段的**类型、默认值、说明文案**全部从 schemastery schema 现场序列化得到
 * （`Config.toJSON()`），所以设置页永远和 config.ts 里那一份 schema 一致 ——
 * 加一个字段只需要改一处，界面自动出现。
 *
 * 这里只额外补两样 schema 表达不了的东西：
 *   - 分组（纯展示：把 37 个字段分成 6 组，不然一屏铺不完）；
 *   - 校验区间（界面上的 min/max 提示）。
 */
export type FieldKind = 'boolean' | 'number' | 'string' | 'select' | 'text';
export interface FormField {
    key: string;
    label: string;
    kind: FieldKind;
    description: string;
    default: unknown;
    options?: string[];
    min?: number;
    max?: number;
    uiGroup: string;
}
export interface FormGroup {
    id: string;
    title: string;
    hint: string;
    fields: FormField[];
}
export interface FormDescriptor {
    groups: FormGroup[];
    /** 直接喂给界面的已序列化 schema（schema.toJSON()）。 */
    schema: unknown;
    /** 只读的目录事实，便于用户在界面里照着放文件。 */
    paths: {
        modelsDir: string;
        runtimeDir: string;
        stateDir: string;
        configFile: string;
    };
}
/**
 * schemastery 的 schema 实例要经过 toJSON() 才是可解析的 {uid, refs} 图。
 * 传进来的可能是实例，也可能已经是序列化结果（单测/缓存），两种都接受。
 */
export declare function serializeSchema(schema: unknown): unknown;
/** 从 schema.toJSON() 抽出「字段 → 类型/默认值/说明/可选项」。拿不到就退回类型表。 */
export declare function extractFields(schema: unknown): FormField[];
export declare function buildFormDescriptor(schema: unknown, resolved: ResolvedConfig, configFile: string): FormDescriptor;
