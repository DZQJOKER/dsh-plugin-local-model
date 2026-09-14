/** 扫描到的一个分片（或单片模型）。 */
export interface ModelShard {
    /** 相对 modelsDir 的路径，统一用 `/` 分隔，作为稳定 id。 */
    rel: string;
    abs: string;
    size: number;
    mtime: number;
}
/** 对外暴露的「一个可被选择的模型」。 */
export interface LocalModelEntry {
    /** 选择器里存下来的值：主分片相对路径。 */
    id: string;
    /** 展示名：去掉扩展名和量化后缀前的可读名字。 */
    displayName: string;
    /** 主分片绝对路径，直接喂给 llama-server -m。 */
    path: string;
    shards: string[];
    sizeBytes: number;
    modifiedAt: number;
    quant: string | null;
    params: string | null;
    /** 同目录下自动关联的视觉投影文件（可选）。 */
    mmproj: string | null;
    /** 分片是否齐全；缺片时不建议载入。 */
    complete: boolean;
    missing: string[];
}
export declare function parseQuant(fileName: string): string | null;
export declare function parseParams(fileName: string): string | null;
export declare function isMmproj(fileName: string): boolean;
/**
 * 把平铺的分片列表归并成模型列表。
 * 纯函数，方便单测：喂进去任意文件集合，都能得到确定结果。
 */
export declare function groupShards(shards: ModelShard[], mmprojs?: ModelShard[]): LocalModelEntry[];
export declare function pickModel(entries: LocalModelEntry[], selected: string): LocalModelEntry | null;
/** 扫描目录（深度 ≤ 3，跳过隐藏目录与 `_` 前缀目录）。 */
export interface ScanResult {
    entries: LocalModelEntry[];
    /** 目录下扫到的全部视觉投影文件（mmproj），供设置页下拉选择。 */
    visionProjectors: ModelShard[];
}
/**
 * 一次遍历同时拿到「模型列表」与「视觉投影文件列表」。
 *
 * 分成两个函数会导致同一份目录被读两遍，而 mmproj 关联本身就需要两者同时在场。
 */
export declare function scanModelsDetailed(modelsDir: string): Promise<ScanResult>;
export declare function scanModels(modelsDir: string): Promise<LocalModelEntry[]>;
/**
 * 决定本次加载实际下发的 `--mmproj`。
 *
 * 优先级刻意做成「显式选择 → 同目录自动关联」，这样新增的手动选择项是纯粹的能力增强：
 * 留空时拿到的仍是 `entry.mmproj`，也就是插件原有的行为一字不变，
 * 纯文本模型（目录里本来就没有 mmproj）也依旧不会多出任何参数。
 *
 * 允许填绝对路径，是为了兼容历史上已经用「附加参数」手写过 --mmproj 的场景。
 */
export declare function resolveVisionProjector(modelsDir: string, selected: string, fallback: string | null): string;
export declare function formatBytes(bytes: number): string;
