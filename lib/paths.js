import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
/** 插件在 DSH_HOME 下的目录名。 */
export const PLUGIN_DIR_NAME = 'local-model';
/** 解析 $DSH_HOME，与 dsh 自身的规则保持一致；结果一定是全限定绝对路径。 */
export function dshHome(env = process.env) {
    const raw = (env.DSH_HOME ?? '').trim();
    // 用 resolve 而不是 normalize：Windows 上 `\dsh` 这种「有根无盘」的路径会按当前盘符
    // 解析，留着它会导致后续 join 出 D:\dsh\... 与 C:\dsh\... 两种结果。
    if (!raw)
        return path.resolve(path.join(os.homedir(), '.dsh'));
    return path.resolve(expandTilde(raw));
}
function expandTilde(input) {
    return input.replace(/^~(?=$|[\\/])/, os.homedir());
}
/**
 * 展开配置里的路径占位符：`~`、`${DSH_HOME}`、`$DSH_HOME`、`%DSH_HOME%`。
 * 让用户在设置页里既可以用绝对路径，也可以写可移植的 `${DSH_HOME}/local-model/models`。
 */
export function expandVars(input, env = process.env, home = dshHome(env)) {
    return expandTilde(input)
        .replace(/\$\{DSH_HOME\}|\$DSH_HOME|%DSH_HOME%/g, home)
        .replace(/^~(?=$|[\\/])/, os.homedir());
}
/**
 * 把一个配置路径解析成绝对路径。
 * - 空 → 用 fallback；
 * - 相对路径 → 相对 DSH_HOME 解析（而不是相对进程 cwd，cwd 会随启动方式漂移）。
 */
export function resolveDir(value, fallback, env = process.env, home = dshHome(env)) {
    const raw = (value ?? '').trim();
    if (!raw)
        return path.normalize(fallback);
    const expanded = expandVars(raw, env, home);
    return path.isAbsolute(expanded) ? path.normalize(expanded) : path.normalize(path.resolve(home, expanded));
}
export function resolveFile(value, env = process.env, home = dshHome(env)) {
    const raw = (value ?? '').trim();
    if (!raw)
        return '';
    const expanded = expandVars(raw, env, home);
    return path.isAbsolute(expanded) ? path.normalize(expanded) : path.normalize(path.resolve(home, expanded));
}
export function resolveLayout(input, env = process.env) {
    const home = dshHome(env);
    const root = path.join(home, PLUGIN_DIR_NAME);
    const stateDir = path.join(root, 'state');
    return {
        home,
        root,
        modelsDir: resolveDir(input.modelsDir, path.join(root, 'models'), env, home),
        runtimeDir: resolveDir(input.runtimeDir, path.join(root, 'runtime'), env, home),
        stateDir,
        pidFile: path.join(stateDir, 'llama-server.pid'),
        keyFile: path.join(stateDir, 'api-key'),
        logFile: path.join(stateDir, 'llama-server.log'),
        configFile: path.join(stateDir, 'config.json'),
    };
}
const MODELS_HINT = `这里是 DeepSeek Harness「本地模型」插件规定的模型目录。

把下载好的 GGUF 模型文件直接放在这个目录（可以建子目录分类）。

  • 单个文件：  Qwen3-8B-Q4_K_M.gguf
  • 分片文件：  Qwen3-8B-Q4_K_M-00001-of-00003.gguf / -00002-... / -00003-...
                （三片都放齐，插件会自动识别为一个模型）
  • 视觉投影：  mmproj-*.gguf 放在同一目录，会被自动关联并可开启视觉输入

放好后回到 Harness：设置 → 本地模型 → 点「重新扫描」，即可在下拉框里选中。

支持的量化格式：Q4_K_M / Q5_K_M / Q6_K / Q8_0 / IQ* / F16 / BF16 / F32 等。
建议 8B 级别用 Q4_K_M 或 Q5_K_M，精度与显存占用最平衡。
`;
const RUNTIME_HINT = `这里是 DeepSeek Harness「本地模型」插件规定的运行时目录。

需要放 llama.cpp 官方发布的 llama-server 可执行文件（不是模型文件）。

自己去 llama.cpp 的 release 页面下载对应平台的压缩包：
  https://github.com/ggml-org/llama.cpp/releases
  Windows 选  llama-*-bin-win-cuda-x64.zip（NVIDIA）或 win-cpu-x64.zip
  macOS   选  llama-*-bin-macos-arm64.zip
  Linux   选  llama-*-bin-ubuntu-x64.zip

解压后把整个文件夹（里面的 llama-server、llama-server.exe 和各 dll）放进来即可，
放在子目录里也能被自动找到，例如：
  runtime/llama-b6040-bin-win-cuda-x64/llama-server.exe

也可以在本目录执行插件自带的下载脚本：
  node <插件目录>/scripts/fetch-llama.mjs
`;
/** 首次运行时建立目录骨架，并写入说明文件，让用户知道「插件规定的目录」到底在哪。 */
export async function ensureLayout(paths) {
    await Promise.all([
        mkdir(paths.modelsDir, { recursive: true }),
        mkdir(paths.runtimeDir, { recursive: true }),
        mkdir(paths.stateDir, { recursive: true }),
    ]);
}
async function exists(file) {
    try {
        await access(file, FS.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
/** 目录骨架 + 人类可读的放置说明（只在缺失时写，不覆盖用户自己的文件）。 */
export async function ensureReadme(paths) {
    await ensureLayout(paths);
    const modelsHint = path.join(paths.modelsDir, 'PUT_GGUF_MODELS_HERE.txt');
    const runtimeHint = path.join(paths.runtimeDir, 'PUT_LLAMA_RUNTIME_HERE.txt');
    if (!(await exists(modelsHint)))
        await writeFile(modelsHint, MODELS_HINT, 'utf8');
    if (!(await exists(runtimeHint)))
        await writeFile(runtimeHint, RUNTIME_HINT, 'utf8');
}
export function toPosix(p) {
    return p.split(path.sep).join('/');
}
