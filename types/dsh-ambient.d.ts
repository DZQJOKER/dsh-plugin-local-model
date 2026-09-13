/**
 * 离线/独立编译用的环境声明。
 *
 * 说明：这个文件**只**用于在没有 dsh 主仓库的情况下做 `tsc` 类型检查与构建。
 * 在 dsh 源码仓库内开发时，请把 tsconfig.verify.json 换成主仓库的 tsconfig，
 * 让真实的 @deepseek-ai/* 包类型生效（真实类型会优先于这里的 ambient 声明）。
 *
 * 这里的签名按 dsh 0.1.x 开发者预览期的公开契约书写，只覆盖本插件用到的部分。
 */

declare module '@deepseek-ai/cordis' {
  export interface Logger {
    error(...args: unknown[]): void
    warn(...args: unknown[]): void
    info(...args: unknown[]): void
    debug(...args: unknown[]): void
  }

  /** cordis 的清理句柄：调用即撤销，重复调用是 no-op。 */
  export type Disposer = () => void

  export interface Context {
    /** 诊断用日志，任何插件都可直接使用，不需要 inject。 */
    readonly logger: Logger

    /**
     * 可选依赖读取：不声明、不等待，可能返回 undefined。
     * 本插件的所有服务依赖都是「缺失即降级」，因此统一走 ctx.get()。
     */
    get<T = unknown>(name: string): T | undefined

    /** 局部硬依赖：服务出现时才执行回调，返回可释放句柄。 */
    inject(names: string[], callback: (ctx: Context) => void): Disposer

    /** 托管一个返回 disposer 的副作用，随插件卸载自动回滚。 */
    effect<T extends Disposer>(callback: () => T, label?: string): T

    /** 事件监听，随插件卸载自动移除。 */
    on(name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): Disposer

    /** 托管定时器（需要 timer 服务；本插件优先用 ctx.get('timer') 降级实现）。 */
    setTimeout(callback: () => void, delay: number): Disposer
    setInterval(callback: () => void, delay: number): Disposer

    /** 挂载子插件。 */
    plugin(plugin: unknown, config?: unknown): { dispose(): Promise<void> }
  }

  export abstract class Service {
    constructor(ctx: Context, name: string)
  }
}

declare module '@deepseek-ai/schemastery' {
  export interface Schema<T> {
    (value: unknown): T
    default(value: T): Schema<T>
    description(text: string): Schema<T>
    comment(text: string): Schema<T>
    required(): Schema<T>
    optional(): Schema<T>
    hidden(): Schema<T>
    /** 标记为敏感字段，Web UI 中不明文显示。 */
    role(name: string): Schema<T>
    min(value: number): Schema<T>
    max(value: number): Schema<T>
  }

  type ObjectValue<S> = {
    [K in keyof S]: S[K] extends Schema<infer U> ? U : never
  }

  export interface SchemaFactory {
    string(): Schema<string>
    number(): Schema<number>
    boolean(): Schema<boolean>
    nat(): Schema<number>
    any(): Schema<unknown>
    const<T>(value: T): Schema<T>
    union<T extends readonly (string | number)[]>(values: T): Schema<T[number]>
    array<T>(inner: Schema<T>): Schema<T[]>
    dict<T>(inner: Schema<T>): Schema<Record<string, T>>
    object<S extends Record<string, Schema<unknown>>>(shape: S): Schema<ObjectValue<S>>
  }

  const Schema: SchemaFactory
  export default Schema
}

declare module '@deepseek-ai/dsh-tools' {
  export interface ToolParameterSpec {
    type?: 'string' | 'number' | 'boolean' | 'object' | 'array'
    required?: boolean
    description?: string
    enum?: readonly (string | number | boolean)[]
    default?: unknown
  }

  export interface ToolExecuteContext {
    signal: AbortSignal
  }

  export interface ToolDefinition {
    name: string
    description: string
    parameters: Record<string, ToolParameterSpec>
    output: {
      schema: Record<string, unknown>
      render: (args: any, value: any) => { type: string; text: string }[]
    }
    execute: (args: any, exec: ToolExecuteContext) => Promise<unknown>
  }

  /** 声明式工具定义；返回的句柄直接交给 ctx.tools.register()。 */
  export function defineTool(definition: ToolDefinition): unknown
}
