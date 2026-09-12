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
