/**
 * 预设快照：把「界面上当前这套参数」算成要交给宿主的那份值。
 *
 * 刻意做成不依赖 React 的纯函数 —— 这样它能被 `scripts/client-check.mjs` 直接单测，
 * 而不是只能等浏览器里点一遍才知道对不对。「存错一套参数」是这个功能最贵的失败方式。
 */

/** 字段 key → 控件类型（来自宿主送来的表单描述）。 */
export function fieldKindMap(groups) {
  const map = {}
  for (const group of groups ?? []) {
    for (const field of group.fields ?? []) map[field.key] = field.kind
  }
  return map
}

/**
 * @param {object} input
 * @param {string[]} input.keys      参与预设的字段（宿主认定，界面不自己猜）
 * @param {object} input.kinds       fieldKindMap 的结果
 * @param {object} input.draft       未保存的修改
 * @param {object} input.config      已保存的生效配置
 */
export function buildPresetSnapshot({ keys, kinds, draft, config }) {
  const out = {}
  for (const key of keys ?? []) {
    const edited = Object.prototype.hasOwnProperty.call(draft ?? {}, key)
    const value = edited ? draft[key] : config?.[key]
    /*
     * 数字框被清空时草稿里是空串，而空串送到宿主会被写入闸门直接丢掉 ——
     * 于是「界面看到的」与「预设存下来的」对不上。按本插件既有的语义
     * （空数字 = 未设置）回落到已保存的值。
     *
     * 只对数字字段这么做：字符串字段的空串是合法取值（比如「当前模型 = 未选择」），
     * 一律回落到旧值会悄悄改掉用户的意思。
     */
    const blankNumber = kinds?.[key] === 'number' && typeof value === 'string' && value.trim() === ''
    out[key] = blankNumber ? config?.[key] : value
  }
  return out
}
