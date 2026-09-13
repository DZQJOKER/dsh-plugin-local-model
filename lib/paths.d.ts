/** 插件在 DSH_HOME 下的目录名。 */
export declare const PLUGIN_DIR_NAME = "local-model";
/** 目录约定 —— 用户在设置页里看到的所有路径都由这里推导，保证「插件规定的目录」唯一。 */
export interface PluginPaths {
    /** dsh 的 Harness home（$DSH_HOME，默认 ~/.dsh）。 */
    home: string;
    /** <home>/local-model —— 插件的全部落盘数据都在这个目录下。 */
    root: string;
    /** 用户放 .gguf 的地方（可被 config.modelsDir 覆盖）。 */
    modelsDir: string;
    /** 用户放 llama.cpp 二进制的地方（可被 config.runtimeDir 覆盖）。 */
    runtimeDir: string;
    /** 插件自管：pid、api key、日志、用户层配置。 */
    stateDir: string;
    pidFile: string;
    keyFile: string;
    logFile: string;
    /** 设置页写入的用户层配置（三层合并的最上层）。 */
    configFile: string;
}
/** 解析 $DSH_HOME，与 dsh 自身的规则保持一致；结果一定是全限定绝对路径。 */
export declare function dshHome(env?: NodeJS.ProcessEnv): string;
/**
 * 展开配置里的路径占位符：`~`、`${DSH_HOME}`、`$DSH_HOME`、`%DSH_HOME%`。
 * 让用户在设置页里既可以用绝对路径，也可以写可移植的 `${DSH_HOME}/local-model/models`。
 */
export declare function expandVars(input: string, env?: NodeJS.ProcessEnv, home?: string): string;
/**
 * 把一个配置路径解析成绝对路径。
 * - 空 → 用 fallback；
 * - 相对路径 → 相对 DSH_HOME 解析（而不是相对进程 cwd，cwd 会随启动方式漂移）。
 */
export declare function resolveDir(value: string | undefined, fallback: string, env?: NodeJS.ProcessEnv, home?: string): string;
export declare function resolveFile(value: string | undefined, env?: NodeJS.ProcessEnv, home?: string): string;
export declare function resolveLayout(input: {
    modelsDir?: string;
    runtimeDir?: string;
}, env?: NodeJS.ProcessEnv): PluginPaths;
/** 首次运行时建立目录骨架，并写入说明文件，让用户知道「插件规定的目录」到底在哪。 */
export declare function ensureLayout(paths: PluginPaths): Promise<void>;
/** 目录骨架 + 人类可读的放置说明（只在缺失时写，不覆盖用户自己的文件）。 */
export declare function ensureReadme(paths: PluginPaths): Promise<void>;
export declare function toPosix(p: string): string;
