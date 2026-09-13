import type { Context, Logger } from '@deepseek-ai/cordis';
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';
/**
 * 极薄的日志包装：
 * - 统一加 `[local-model]` 前缀，便于在 dsh 启动日志里 grep；
 * - 级别过滤在插件侧完成，避免把 debug 噪音灌进宿主日志；
 * - 永远只通过 ctx.logger 输出，不直接用 console（宿主可重定向/落盘）。
 */
export declare class Log {
    private readonly logger;
    private level;
    constructor(logger: Logger, level?: LogLevel);
    setLevel(level: LogLevel): void;
    getLevel(): LogLevel;
    enabled(level: Exclude<LogLevel, 'silent'>): boolean;
    error(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    info(...args: unknown[]): void;
    debug(...args: unknown[]): void;
}
export declare function createLog(ctx: Context, level?: LogLevel): Log;
