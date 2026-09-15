import type { Context } from '@deepseek-ai/cordis';
import type { Log } from './log.js';
import type { LocalModelRuntime } from './lifecycle.js';
/**
 * 向模型暴露一个 `local_model` 工具。
 *
 * 设计取舍：只给「读」能力（status / list）。启停会直接抢占或释放显存，
 * 属于用户该拍板的资源决策 —— 因此 start / stop 恒被拒绝。
 *
 * 这两个开关过去是设置项（exposeTool / allowModelControl），随「接入 dsh」那一组一起
 * 从 schema 中删除，改为 config.ts 里的常量。取值沿用原默认值，所以行为与默认安装完全一致；
 * 代价是**从此不可配置**：想在会话里让模型自己启停模型，需要改代码里的常量。
 */
export declare function registerLocalModelTool(ctx: Context, runtime: LocalModelRuntime, log: Log): Promise<() => void>;
