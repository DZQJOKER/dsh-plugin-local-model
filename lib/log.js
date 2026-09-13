const RANK = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const TAG = '[local-model]';
/**
 * 极薄的日志包装：
 * - 统一加 `[local-model]` 前缀，便于在 dsh 启动日志里 grep；
 * - 级别过滤在插件侧完成，避免把 debug 噪音灌进宿主日志；
 * - 永远只通过 ctx.logger 输出，不直接用 console（宿主可重定向/落盘）。
 */
export class Log {
    logger;
    level;
    constructor(logger, level = 'info') {
        this.logger = logger;
        this.level = level;
    }
    setLevel(level) {
        this.level = level;
    }
    getLevel() {
        return this.level;
    }
    enabled(level) {
        return RANK[level] <= RANK[this.level];
    }
    error(...args) {
        if (this.enabled('error'))
            this.logger.error(TAG, ...args);
    }
    warn(...args) {
        if (this.enabled('warn'))
            this.logger.warn(TAG, ...args);
    }
    info(...args) {
        if (this.enabled('info'))
            this.logger.info(TAG, ...args);
    }
    debug(...args) {
        if (this.enabled('debug'))
            this.logger.debug(TAG, ...args);
    }
}
export function createLog(ctx, level = 'info') {
    return new Log(ctx.logger, level);
}
