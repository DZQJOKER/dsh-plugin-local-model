import type { Context, Logger } from '@deepseek-ai/cordis'

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug'

const RANK: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }

const TAG = '[local-model]'

/**
 * 极薄的日志包装：
 * - 统一加 `[local-model]` 前缀，便于在 dsh 启动日志里 grep；
 * - 级别过滤在插件侧完成，避免把 debug 噪音灌进宿主日志；
 * - 永远只通过 ctx.logger 输出，不直接用 console（宿主可重定向/落盘）。
 */
export class Log {
  constructor(
    private readonly logger: Logger,
    private level: LogLevel = 'info',
  ) {}

  setLevel(level: LogLevel): void {
    this.level = level
  }

  getLevel(): LogLevel {
    return this.level
  }

  enabled(level: Exclude<LogLevel, 'silent'>): boolean {
    return RANK[level] <= RANK[this.level]
  }

  error(...args: unknown[]): void {
    if (this.enabled('error')) this.logger.error(TAG, ...args)
  }

  warn(...args: unknown[]): void {
    if (this.enabled('warn')) this.logger.warn(TAG, ...args)
  }

  info(...args: unknown[]): void {
    if (this.enabled('info')) this.logger.info(TAG, ...args)
  }

  debug(...args: unknown[]): void {
    if (this.enabled('debug')) this.logger.debug(TAG, ...args)
  }
}

export function createLog(ctx: Context, level: LogLevel = 'info'): Log {
  return new Log(ctx.logger, level)
}
