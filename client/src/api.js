/** 设置面板的数据面：同源 fetch，不跨端口、不需要 CORS。 */

const BASE = '/api/local-model'

async function request(path, init) {
  const res = await fetch(BASE + path, init)
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!res.ok || (data && data.ok === false)) {
    const message = (data && data.error) || `请求失败（HTTP ${res.status}）`
    throw new Error(message)
  }
  return data
}

const JSON_POST = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
})

export const fetchState = () => request('/state')

export const saveConfig = (values, unset) => request('/config', JSON_POST({ values, unset }))

export const resetConfig = () => request('/reset', JSON_POST({}))

export const runAction = (action) => request('/action', JSON_POST({ action }))

/*
 * 参数预设。五个动作都在同一个前缀下，返回值与 /config 一样是完整 state ——
 * 于是界面拿到结果直接 setState 即可，不需要自己拼状态。
 */
export const savePreset = (name, values) => request('/presets/save', JSON_POST({ name, values }))

export const applyPreset = (id) => request('/presets/apply', JSON_POST({ id }))

export const overwritePreset = (id, values) => request('/presets/overwrite', JSON_POST({ id, values }))

export const renamePreset = (id, name) => request('/presets/rename', JSON_POST({ id, name }))

export const deletePreset = (id) => request('/presets/delete', JSON_POST({ id }))
