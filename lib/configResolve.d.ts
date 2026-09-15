import type { LogLevel } from './log.js';
import type { LocalModelConfig } from './config.js';
import { type PluginPaths } from './paths.js';
export interface ResolvedConfig extends LocalModelConfig {
    paths: PluginPaths;
    /** 空闲卸载毫秒数，0 表示关闭。 */
    idleUnloadMs: number;
}
/** llama-server 对外暴露的模型别名（--alias），同时用于路由展示名。 */
export declare const DEFAULT_MODEL_ALIAS = "local";
/** 本地路由在 dsh 侧注册用的路由名（pi-ai provider 的 key）。 */
export declare const LOCAL_ROUTE_NAME = "local-llama";
/** dsh 模型选择器里的模型 id。 */
export declare const LOCAL_MODEL_ID = "local";
/**
 * local_model 工具是否暴露给模型（原 `exposeTool` 设置）。
 * 保留原默认值 true：设置页不再提供开关，行为与默认安装一致。
 */
export declare const EXPOSE_LOCAL_MODEL_TOOL = true;
/**
 * 是否允许模型通过 local_model 工具启停模型（原 `allowModelControl` 设置）。
 *
 * 保留原默认值 false：装载/卸载显存属于用户该拍板的资源决策。
 * 注意这是**能力上的取舍** —— 设置项被删除后，这一条从此不可配置。
 */
export declare const ALLOW_MODEL_CONTROL = false;
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
 * 小数版 clamp：**不取整**。
 *
 * 为什么必须单独有一个：`clamp()` 里的 `Math.round` 对整数参数是对的，但用在采样参数上
 * 会静默毁掉它们 —— `temp 0.75 → 1`、`top-p 0.95 → 1`、`min-p 0.05 → 0`，
 * 而且没有任何报错，只会表现为「设了没反应」。
 */
export declare function clampFloat(value: number, min: number, max: number, fallback: number): number;
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
