import type { Context } from '@deepseek-ai/cordis';
import type { Log } from './log.js';
import type { LocalModelRuntime } from './lifecycle.js';
/**
 * 向模型暴露一个 `local_model` 工具。
 *
 * 设计取舍：默认只给「读」能力（status / list）。启停会直接抢占或释放显存，
 * 属于用户该拍板的资源决策，因此 start / stop 需要显式打开 allowModelControl。
 */
export declare function registerLocalModelTool(ctx: Context, runtime: LocalModelRuntime, log: Log): Promise<() => void>;
