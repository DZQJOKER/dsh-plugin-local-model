/**
 * 浏览器侧入口。
 *
 * 形状与宿主侧插件一致（具名导出 inject / apply），只是注入的服务是客户端服务：
 *   - 在设置侧栏注册一个一级分区「本地模型」（settings.section）
 *   - 分区内容全部来自宿主通过 /api/local-model 提供的 schema 与状态
 *
 * 约定要点（照 dsh 自带的客户端插件抄的，不是猜的）：
 *   - 必须具名导出，不能有 default 导出；
 *   - 所有注册都通过 ctx.effect / 插槽的 disposer 兜底，注册失败只降级、不抛出去；
 *   - 这个模块最终会被打包成 lazy-CJS factory，由 window.__ModuleLoader__ 加载。
 */
import { LocalModelSection } from './section.jsx'

const NS = 'local-model'

const zh = {
  title: '本地模型',
}

const en = {
  title: 'Local model',
}

/** 客户端服务的硬依赖。slots 提供插槽注册，locale 提供分区标题的取词。 */
export const inject = ['slots', 'locale']

export function apply(ctx) {
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en })
    } catch {
      return () => {}
    }
  }, 'local-model: dictionaries')

  ctx.slots.inject('settings.section', () => {
    try {
      return ctx.slots.register(
        {
          name: 'settings.section',
          id: NS,
          // 排在通用设置/模型之后、插件与市场之前。
          order: 25,
          label: () => {
            try {
              return ctx.locale.bind(NS)('title')
            } catch {
              return '本地模型'
            }
          },
          locale: NS,
        },
        LocalModelSection,
      )
    } catch (error) {
      console.warn('[local-model] 注册设置分区失败：', error && error.message ? error.message : error)
      return () => {}
    }
  })
}
