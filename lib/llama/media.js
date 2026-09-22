/**
 * 外部媒体工具（ffmpeg / ffprobe）的定位与注入。
 *
 * 为什么需要这一层 —— 这是本插件里唯一一个「参数全对、模型也加载成功，但看图照样 400」的坑：
 *
 *   llama.cpp 的 mtmd 内置解码器（stb_image）只认 png / jpeg / gif / bmp 这些老格式，
 *   **不认识 webp**。遇到 webp 它会去起外部的 `ffprobe` 探测、再用 `ffmpeg` 转成 rawvideo，
 *   两个都从 **PATH** 里找（这个构建砍掉了 `--ffmpeg-path` 选项，只剩 PATH 一条路）。
 *   于是「机器上没装 ffmpeg」的表现是：
 *       probe: failed to launch ffprobe
 *       mtmd_helper_bitmap_init_from_buf: failed to decode webp buffer
 *   客户端拿到的是 400 `Failed to load image or audio file` —— 既没有 webp 也没有 ffprobe，
 *   看起来像插件或模型坏了。
 *
 *   dsh 会把图片转码后再发，**同一批图里既有 jpeg 也有 webp**（实测
 *   `.dsh/attachments/v1/request-images/` 下两种都存在），所以这不是「某些人偶尔碰到」，
 *   而是一半概率必现。修法只有一条：让 llama-server 的子进程能找到 ffmpeg/ffprobe。
 *
 * 所以这里做两件事：**找到它**，**主动塞进子进程的 PATH**。
 * 后者比「要求用户去改系统 PATH 再重启 dsh」可靠得多：子进程的环境由插件自己拼，
 * 装完立刻生效，也不必让用户理解 PATH 继承。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
/** 需要同时具备的两个可执行文件：ffprobe 负责探测，ffmpeg 负责转码。 */
const TOOL_NAMES = ['ffprobe', 'ffmpeg'];
function exeName(base, platform) {
    return platform === 'win32' ? `${base}.exe` : base;
}
/** 某个目录里是否两个工具都在。 */
function completeIn(dir, platform) {
    return TOOL_NAMES.every((name) => existsSync(path.join(dir, exeName(name, platform))));
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
export function findMediaTools(options = {}) {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const pathValue = env.PATH ?? env.Path ?? env.path ?? '';
    const candidates = [
        ...(options.extraDirs ?? []),
        env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : undefined,
        ...pathValue.split(path.delimiter),
        'C:\\ffmpeg\\bin',
        'C:\\Program Files\\ffmpeg\\bin',
        '/usr/local/bin',
        '/opt/homebrew/bin',
    ];
    const seen = new Set();
    for (const candidate of candidates) {
        if (!candidate)
            continue;
        const dir = candidate.trim().replace(/^"|"$/g, '');
        if (!dir || seen.has(dir))
            continue;
        seen.add(dir);
        try {
            if (!completeIn(dir, platform))
                continue;
        }
        catch {
            continue;
        }
        return { dir, ffprobe: path.join(dir, exeName('ffprobe', platform)) };
    }
    return { dir: null, ffprobe: null };
}
/**
 * 把媒体工具目录**前置**到子进程的 PATH 上。
 *
 * 必须处理 `Path` / `PATH` 两种键名：Windows 上进程环境里实际用的是 `Path`，
 * 只写 `PATH` 会变成「两个键共存」，而取哪个由子进程决定 —— 那是最难查的一类环境 bug。
 * 找不到工具时原样返回，不往环境里塞空值。
 */
export function withMediaPath(env, mediaDir, platform = process.platform) {
    if (!mediaDir)
        return env;
    const key = platform === 'win32' && !('PATH' in env) && 'Path' in env ? 'Path' : 'PATH';
    const current = env[key] ?? env.PATH ?? env.Path ?? '';
    const parts = current.split(path.delimiter).filter(Boolean);
    if (parts.includes(mediaDir))
        return env;
    return { ...env, [key]: [mediaDir, ...parts].join(path.delimiter) };
}
/**
 * 装了视觉投影、却找不到 ffmpeg 时要说的话。
 *
 * 说清三件事，否则用户拿到的只有一句英文 400：**哪个格式会失败**、
 * **为什么只有它失败**（jpeg 能过，所以看起来时好时坏）、**怎么修**。
 */
export function mediaToolWarning() {
    return ('已加载视觉投影文件，但本机找不到 ffmpeg / ffprobe。' +
        'llama.cpp 内置的图像解码器不认识 WebP，而 dsh 会把一部分图片转成 WebP 再发过来 —— ' +
        '所以这种图会直接失败（服务端报 Failed to load image or audio file，客户端看到 400），' +
        '而同一批里的 JPEG 却能正常识别，表现是「时好时坏」。' +
        '装一个 ffmpeg 即可：winget install Gyan.FFmpeg（装完重启 DSH；插件会自动把它加进 llama-server 的 PATH）。');
}
