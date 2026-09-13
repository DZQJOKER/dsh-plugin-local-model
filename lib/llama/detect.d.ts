export type LlamaServerSource = 'config' | 'runtime-dir' | 'path-env';
export interface LlamaServerLocation {
    path: string;
    source: LlamaServerSource;
}
export declare function llamaBinaryNames(platform?: NodeJS.Platform): string[];
/**
 * 定位 llama-server。查找顺序（先精确后模糊）：
 *   1. 设置里显式填写的路径（填目录也接受，会自动补可执行文件名）
 *   2. runtimeDir 根目录
 *   3. runtimeDir/bin
 *   4. runtimeDir 下一层子目录（官方 release 解压出来就是 llama-bXXXX-bin-<平台>-<后端>/）
 *   5. 进程 PATH
 */
export declare function locateLlamaServer(opts: {
    explicit?: string;
    runtimeDir: string;
    env?: NodeJS.ProcessEnv;
}): Promise<LlamaServerLocation | null>;
/** 供错误信息使用：告诉用户到底在哪里找过了。 */
export declare function describeSearchScope(opts: {
    explicit?: string;
    runtimeDir: string;
}): string;
