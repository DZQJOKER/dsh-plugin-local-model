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
export declare function scanModels(modelsDir: string): Promise<LocalModelEntry[]>;
export declare function formatBytes(bytes: number): string;
