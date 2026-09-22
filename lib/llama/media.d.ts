export interface MediaTools {
    /** 同时含 ffprobe 与 ffmpeg 的目录；找不到为 null。 */
    dir: string | null;
    /** ffprobe 的绝对路径（找到时）。 */
    ffprobe: string | null;
}
/**
 * 按优先级找 ffmpeg 目录。
 *
 * 顺序是「越确定越靠前」：
 *   1. 调用方给的显式目录（将来接设置项用）；
 *   2. winget 的别名目录 —— `winget install Gyan.FFmpeg` 会把 ffprobe.exe 放在这里，
 *      而它**不保证**进入已运行进程的环境（用户装完不重启就找不到），所以必须显式认它；
 *   3. PATH 里的每一项（用户自己装到别处、或系统 PATH 已包含）；
 *   4. 几个常见安装位置（裸解压到 C:\ffmpeg 这类）。
 *
 * 每个候选都要求**两个工具都在**：只有 ffprobe 没有 ffmpeg 时 mtmd 探测完照样转不了码，
 * 那种「半套工具」会让人以为已经修好了。
 */
export declare function findMediaTools(options?: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    extraDirs?: (string | undefined)[];
}): MediaTools;
/**
 * 把媒体工具目录**前置**到子进程的 PATH 上。
 *
 * 必须处理 `Path` / `PATH` 两种键名：Windows 上进程环境里实际用的是 `Path`，
 * 只写 `PATH` 会变成「两个键共存」，而取哪个由子进程决定 —— 那是最难查的一类环境 bug。
 * 找不到工具时原样返回，不往环境里塞空值。
 */
export declare function withMediaPath(env: NodeJS.ProcessEnv, mediaDir: string | null, platform?: NodeJS.Platform): NodeJS.ProcessEnv;
/**
 * 装了视觉投影、却找不到 ffmpeg 时要说的话。
 *
 * 说清三件事，否则用户拿到的只有一句英文 400：**哪个格式会失败**、
 * **为什么只有它失败**（jpeg 能过，所以看起来时好时坏）、**怎么修**。
 */
export declare function mediaToolWarning(): string;
