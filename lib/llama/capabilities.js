import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
/**
 * 帮助行的形状：`-fa,   --flash-attn [on|off|auto]       set Flash Attention use ...`
 * 前面是一串以 `-` 开头的选项名（逗号分隔、允许对齐用的多空格），后面是参数位与说明。
 *
 * 注意分隔符要写成 `\s+` 而不是 `\s`：help 用空格对齐，选项名与说明之间往往有十几个空格，
 * 只吃一个空格的写法会让整行匹配失败，表现是「大部分选项都解析不到」——
 * 这种漏解析不会报错，只会让后面的「构建认不认识这个选项」判断集体误报。
 */
const HELP_LINE_RE = /^\s*((?:-{1,2}[A-Za-z0-9][A-Za-z0-9_.-]*)(?:\s*,\s*(?:-{1,2}[A-Za-z0-9][A-Za-z0-9_.-]*))*)(?:\s+(.*))?$/;
/** 参数位判定：`[on|off|auto]` / `<n>` / 全大写占位符（N、HOST、FNAME、N0,N1,...）。 */
function looksLikeValuePlaceholder(rest) {
    if (!rest)
        return false;
    if (rest.startsWith('[') || rest.startsWith('<'))
        return true;
    return /^[A-Z][A-Z0-9_]*(?=[\s,]|$)/.test(rest);
}
/**
 * 把 help 文本索引成「选项 → 说明」。说明可能换行（llama.cpp 会把长描述折到下一行），
 * 因此遇到不以选项名开头的后续行要并进上一条 —— 否则 `-ngl` 的说明会被截断在
 * 「either an exact number,」，就看不到下一行的 `'auto', or 'all'`。
 */
export function parseHelp(helpText) {
    const flags = new Set();
    const docs = new Map();
    let current = null;
    for (const line of helpText.split(/\r?\n/)) {
        const match = HELP_LINE_RE.exec(line);
        if (match) {
            const names = (match[1] ?? '')
                .split(',')
                .map((token) => token.trim())
                .filter((name) => name.startsWith('-'));
            if (names.length === 0)
                continue;
            const head = (match[2] ?? '').trim();
            current = { head, text: head, names };
            for (const name of names) {
                flags.add(name);
                docs.set(name, current);
            }
            continue;
        }
        // 续行：并进上一条的说明里（空行或 section 标题只影响关键词检索，无害）。
        if (current && line.trim()) {
            current.text = `${current.text} ${line.trim()}`;
        }
    }
    return {
        flags,
        docs,
        flashAttnMode: modeFromDoc(docs.get('--flash-attn')),
        gpuLayers: detectGpuLayersSupport(docs),
    };
}
/** `--flash-attn` 后面跟的是值位还是说明文字。 */
export function detectFlashAttnMode(helpText) {
    const marker = '--flash-attn';
    const line = helpText.split(/\r?\n/).find((candidate) => candidate.includes(marker));
    if (!line)
        return 'unsupported';
    const after = line.slice(line.indexOf(marker) + marker.length).trim();
    if (!after)
        return 'bare';
    return looksLikeValuePlaceholder(after) ? 'value' : 'bare';
}
function modeFromDoc(doc) {
    if (!doc)
        return 'unsupported';
    if (!doc.head)
        return 'bare';
    return looksLikeValuePlaceholder(doc.head) ? 'value' : 'bare';
}
/** `-ngl` 是否接受 'auto' / 'all' 这两个关键字。 */
export function detectGpuLayersSupport(docs) {
    const doc = docs.get('--n-gpu-layers') ?? docs.get('--gpu-layers') ?? docs.get('-ngl');
    if (!doc)
        return { auto: false, all: false };
    const mentions = (keyword) => new RegExp(`['"\`]?${keyword}['"\`]?`, 'i').test(doc.text);
    return { auto: mentions('auto'), all: mentions('all') };
}
const cache = new Map();
/** 测试用：清掉探测缓存。 */
export function resetCapabilityCache() {
    cache.clear();
}
function failure(detail) {
    return {
        ok: false,
        source: '--help',
        flashAttnMode: 'unsupported',
        gpuLayers: { auto: false, all: false },
        flags: new Set(),
        detail,
    };
}
export async function probeCapabilities(executable, options = {}) {
    let key = executable;
    try {
        const info = await stat(executable);
        key = `${executable}|${info.size}|${info.mtimeMs}`;
    }
    catch {
        // 拿不到 stat 就按路径缓存。
    }
    const hit = cache.get(executable);
    if (hit && hit.key === key)
        return hit.value;
    const value = await runProbe(executable, options.timeoutMs ?? 8000);
    cache.set(executable, { key, value });
    return value;
}
function runProbe(executable, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            resolve(value);
        };
        let child;
        try {
            child = spawn(executable, ['--help'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        }
        catch (error) {
            finish(failure(`无法执行：${error.message}`));
            return;
        }
        let text = '';
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        // llama.cpp 把 usage 写到 stderr 还是 stdout 因版本而异，两边都收。
        child.stdout?.on('data', (chunk) => {
            text += chunk;
        });
        child.stderr?.on('data', (chunk) => {
            text += chunk;
        });
        const timer = setTimeout(() => {
            try {
                child.kill();
            }
            catch {
                // 忽略。
            }
            finish(failure(`--help 超时（${timeoutMs}ms）`));
        }, timeoutMs);
        timer.unref?.();
        child.once('error', (error) => {
            clearTimeout(timer);
            finish(failure(`探测失败：${error.message}`));
        });
        child.once('exit', () => {
            clearTimeout(timer);
            const parsed = parseHelp(text);
            if (parsed.flags.size === 0) {
                finish(failure('--help 输出里没有解析到任何选项'));
                return;
            }
            finish({
                ok: true,
                source: '--help',
                flashAttnMode: parsed.flashAttnMode,
                gpuLayers: parsed.gpuLayers,
                flags: parsed.flags,
                detail: `识别到 ${parsed.flags.size} 个选项；flash-attn 形状 ${parsed.flashAttnMode}；` +
                    `gpu-layers 支持 auto=${parsed.gpuLayers.auto ? '是' : '否'} / all=${parsed.gpuLayers.all ? '是' : '否'}`,
            });
        });
    });
}
/**
 * 我们准备下发的选项里，有哪些是这个构建不认识的。
 *
 * 入参是「我们自己拼出来的 flag 列表」（构建器顺带产出），因此不需要去猜
 * 哪个 token 是值哪个是选项。用来在 spawn 之前就给出可读的警告，
 * 而不是等 llama-server 用一句含糊的 usage 报错。
 */
export function unknownFlags(usedFlags, known) {
    const unknown = new Set();
    for (const flag of usedFlags) {
        if (!known.has(flag))
            unknown.add(flag);
    }
    return [...unknown];
}
/** 是否为「--flash-attn 形状不对」这一类错误（用于自动重试判断）。 */
export function isFlashAttnFormError(text) {
    return /unknown value for --flash-attn|unrecognized argument.*flash-attn|invalid argument.*flash-attn/i.test(text);
}
