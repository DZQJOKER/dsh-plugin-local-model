import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
/** Directory name of the plugin under DSH_HOME. */
export const PLUGIN_DIR_NAME = 'local-model';
/** Resolves $DSH_HOME using the same rules as dsh itself; the result is always a fully qualified absolute path. */
export function dshHome(env = process.env) {
    const raw = (env.DSH_HOME ?? '').trim();
    // Use resolve, not normalize: on Windows a root-without-drive path like `\dsh` is resolved against the current drive;
    // leaving it in place makes later joins produce both D:\dsh\... and C:\dsh\... results.
    if (!raw)
        return path.resolve(path.join(os.homedir(), '.dsh'));
    return path.resolve(expandTilde(raw));
}
function expandTilde(input) {
    return input.replace(/^~(?=$|[\\/])/, os.homedir());
}
/**
 * Expands path placeholders in config values: `~`, `${DSH_HOME}`, `$DSH_HOME`, `%DSH_HOME%`.
 * Lets users use absolute paths on the settings page, or portable ones like `${DSH_HOME}/local-model/models`.
 */
export function expandVars(input, env = process.env, home = dshHome(env)) {
    return expandTilde(input)
        .replace(/\$\{DSH_HOME\}|\$DSH_HOME|%DSH_HOME%/g, home)
        .replace(/^~(?=$|[\\/])/, os.homedir());
}
/**
 * Resolves a config path to an absolute path.
 * - empty -> use the fallback;
 * - relative paths are resolved against DSH_HOME (not the process cwd, which drifts with the launch method).
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
const MODELS_HINT = `This is the models directory designated by the DeepSeek Harness "Local model" plugin.

Place your downloaded GGUF model files directly in this directory (you may create subdirectories to organize them).

  • Single file:   Qwen3-8B-Q4_K_M.gguf
  • Split files:   Qwen3-8B-Q4_K_M-00001-of-00003.gguf / -00002-... / -00003-...
                    (place all three parts; the plugin automatically recognizes them as one model)
  • Vision projector: put mmproj-*.gguf in the same directory to have it auto-associated and enable vision input

Once placed, go back to Harness: Settings -> Local model -> click "Rescan", then pick the model from the dropdown.

Supported quantization formats: Q4_K_M / Q5_K_M / Q6_K / Q8_0 / IQ* / F16 / BF16 / F32, etc.
For 8B-class models, Q4_K_M or Q5_K_M is recommended - the best balance of accuracy and VRAM usage.
`;
const RUNTIME_HINT = `This is the runtime directory designated by the DeepSeek Harness "Local model" plugin.

It must contain the llama-server executable officially released by llama.cpp (not model files).

Download the archive for your platform from the llama.cpp releases page:
  https://github.com/ggml-org/llama.cpp/releases
  Windows: pick  llama-*-bin-win-cuda-x64.zip (NVIDIA) or win-cpu-x64.zip
  macOS:   pick  llama-*-bin-macos-arm64.zip
  Linux:   pick  llama-*-bin-ubuntu-x64.zip

After extracting, put the whole folder in here (llama-server, llama-server.exe and the dll files).
It is also found automatically inside subdirectories, e.g.:
  runtime/llama-b6040-bin-win-cuda-x64/llama-server.exe

You can also run the plugin's bundled download script from this directory:
  node <plugin-dir>/scripts/fetch-llama.mjs
`;
/** Creates the directory skeleton on first run and writes hint files so users know where the plugin-designated directories live. */
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
/** Directory skeleton + human-readable placement hints (only written when missing; never overwrites the user's own files). */
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
