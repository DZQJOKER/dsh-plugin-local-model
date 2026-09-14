import type { LogLevel } from './log.js';
import type { LocalModelConfig } from './config.js';
import { type PluginPaths } from './paths.js';
export interface ResolvedConfig extends LocalModelConfig {
    paths: PluginPaths;
    /** 空闲卸载毫秒数，0 表示关闭。 */
    idleUnloadMs: number;
}
/**
 * 这一层刻意不 import schemastery。
 *
 * 好处有三：
 *   1. 配置解析是「启动逻辑稳定可靠」里最容易出回归的一环，独立成纯模块才能被单测钉死；
 *   2. 它不依赖任何宿主包，可以在 dsh 之外直接跑（见 scripts/selftest.mjs）；
 *   3. 用户如果用纯 JS 配置挂载插件，schema 可能没参与校验，这里仍能兜住。
 */
export declare function defaultConfig(): LocalModelConfig;
export declare function clamp(value: number, min: number, max: number, fallback: number): number;
/**
 * 布尔收敛：只有明确的「假」才判为关闭，其余无法识别的值一律回落到 fallback。
 *
 * 为什么需要它：组合层（cordis.patch.yml / 手写 JS 配置）不经过 Web 侧的写入闸门，
 * 一个字符串 `"false"` 直接用 `!== false` 判断会变成「开启」—— 开关方向反了是最难查的一类 bug。
 */
export declare function normalizeBool(value: unknown, fallback: boolean): boolean;
export declare function logLevelOf(value: string | undefined): LogLevel;
export declare function isAutoUnloadDisabled(minutes: number): boolean;
/**
 * 把用户配置收敛成一份可用的运行配置：
 * - 缺字段用默认值兜底；
 * - 目录一律解析成绝对路径，相对路径相对 $DSH_HOME 而不是进程 cwd（cwd 会随启动方式漂移）；
 * - 数值做区间收敛，避免把互相矛盾的参数丢给 llama-server。
 */
export declare function resolveConfig(input: Partial<LocalModelConfig> | undefined, env?: NodeJS.ProcessEnv): ResolvedConfig;
