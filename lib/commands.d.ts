import type { Context } from '@deepseek-ai/cordis';
import type { Log } from './log.js';
import type { LocalModelRuntime } from './lifecycle.js';
/**
 * 会话内斜杠命令。宿主的 commands 服务在预览期接口还在动，因此这里
 * 全部走「探测 + 失败即降级」：注册不上不影响任何其它能力。
 */
export declare function registerLocalModelCommands(ctx: Context, runtime: LocalModelRuntime, log: Log, routeYaml: () => string): () => void;
