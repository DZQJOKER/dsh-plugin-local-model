#!/usr/bin/env node
/**
 * 插件清单自检 —— 专门用来提前发现「装了但未生效」。
 *
 *   node scripts/verify-bundle.mjs
 *   node scripts/verify-bundle.mjs --dsh-home "D:/some/other/harness"
 *
 * 检查两类问题：
 *   A. 本包自己是不是一个合法的 dsh bundle
 *      （dsh.bundle.patch 存在、指向真实文件、files 里带上了它、main 产物存在、
 *        patch 里的 name 是包名而不是相对路径）
 *   B. 本包在哪些 profile 里「装了但没生效」
 *      （出现在 dependencies 却没出现在 dsh.profile.bundles —— 这正是 dsh 打印
 *        "declares no dsh.bundle … never a profile-layer plugin" 的成因）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')

const args = process.argv.slice(2)
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}
/** A 段（本包是否是合法 bundle）永远算失败；B 段默认只提醒 —— 在没装本插件的机器上跑不该报错。 */
const strictProfile = args.includes('--strict')

let failures = 0
let warnings = 0

function ok(msg) {
  console.log(`  ✓ ${msg}`)
}
function bad(msg, hint) {
  failures++
  console.log(`  ✗ ${msg}`)
  if (hint) console.log(`      → ${hint}`)
}
function warn(msg, hint) {
  warnings++
  console.log(`  ! ${msg}`)
  if (hint) console.log(`      → ${hint}`)
}

// ── A. 本包是不是合法的 bundle ───────────────────────────────────────────────
console.log('\nA. bundle 清单')

const pkgPath = path.join(projectRoot, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

const bundle = pkg.dsh?.bundle
const patchRel = typeof bundle === 'object' && bundle !== null ? bundle.patch : null

if (typeof bundle === 'string') {
  bad(
    `dsh.bundle 被写成了字符串（"${bundle}"）`,
    '正确形状是对象：{"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}。写成字符串时 dsh 会判定为「未声明 dsh.bundle」。',
  )
} else if (!patchRel) {
  bad('缺少 dsh.bundle.patch 声明', '缺少它，dsh 只会把它当普通依赖装上，永远不进插件树。')
} else {
  ok(`dsh.bundle.patch = ${patchRel}`)
}

const patchAbs = patchRel ? path.resolve(projectRoot, patchRel) : null
if (patchAbs && fs.existsSync(patchAbs)) {
  ok('patch 文件存在')
} else if (patchAbs) {
  bad(`patch 文件不存在：${patchAbs}`)
}

if (patchRel && Array.isArray(pkg.files)) {
  const included = pkg.files.some((f) => path.normalize(f) === path.normalize(patchRel.replace(/^\.\//, '')))
  if (included) ok('patch 文件已列入 files（发布后不会丢）')
  else warn(`files 里没有 ${patchRel}`, '如果将来发布到 npm，patch 文件会被漏掉。')
}

const mainAbs = pkg.main ? path.resolve(projectRoot, pkg.main) : null
if (mainAbs && fs.existsSync(mainAbs)) ok(`main 产物存在（${pkg.main}）`)
else if (mainAbs) bad(`main 指向的文件不存在：${pkg.main}`, '先跑 npm run build。')
else bad('缺少 main 字段')

if (patchAbs && fs.existsSync(patchAbs)) {
  const text = fs.readFileSync(patchAbs, 'utf8')
  if (/^\s*-\s*insert:/m.test(text)) ok('patch 使用 insert 形式（新增插件行）')
  else bad('patch 里找不到 `- insert:`', '新增插件行必须用 insert；用覆盖语法会报 patch: entry "X" not found。')

  const names = [...text.matchAll(/^\s*name:\s*['"]?([^'"\n]+?)['"]?\s*$/gm)].map((m) => m[1].trim())
  if (names.length === 0) {
    bad('patch 里没有 name 字段')
  } else {
    for (const name of names) {
      if (name.startsWith('.') || name.startsWith('/') || name.includes('\\') || name.endsWith('.ts') || name.endsWith('.js')) {
        bad(
          `patch 的 name 看起来是文件路径：「${name}」`,
          '装进 profile 的 node_modules 后相对路径无法解析；这里必须写包名（本包应为 ' + pkg.name + '）。',
        )
      } else {
        ok(`patch 的 name 是包名：${name}`)
      }
    }
    if (!names.includes(pkg.name)) {
      warn(`patch 里的 name 与包名 ${pkg.name} 不一致`, 'dsh 会从 profile 的 node_modules 解析这个名字，写错就加载不到。')
    }
  }
}

// ── A2. 浏览器半侧是不是合规的 dsh.client 包 ────────────────────────────────
console.log('\nA2. 客户端（浏览器半侧）')

const client = pkg.dsh?.client
if (!client) {
  warn(
    '没有声明 dsh.client —— 设置页里不会出现这个插件的任何界面',
    '宿主侧 Config 只负责配置的读写；侧栏那一页必须由 dsh.client 的浏览器 bundle 贡献。',
  )
} else {
  if (client.platform === 'web') ok('dsh.client.platform = web')
  else bad(`dsh.client.platform 应为 "web"，实际是 ${JSON.stringify(client.platform)}`)

  if (Array.isArray(client.inject) && client.inject.length > 0) {
    const bads = client.inject.filter((n) => typeof n !== 'string' || !n.startsWith('@'))
    if (bads.length > 0) bad(`dsh.client.inject 里出现了不像包名的项：${bads.join(', ')}`)
    else ok(`dsh.client.inject 声明了 ${client.inject.length} 个客户端依赖包`)
  } else {
    bad('dsh.client.inject 必须是非空数组', '它是客户端包的加载顺序声明，缺了会导致注入的服务不存在。')
  }

  const clientExport =
    typeof pkg.exports === 'string' ? null : pkg.exports?.['./client']
  const clientRel = typeof clientExport === 'string' ? clientExport : clientExport?.default
  if (!clientRel) {
    bad('缺少 exports["./client"]', 'dsh 靠这个子路径导出找到浏览器 bundle。')
  } else if (!fs.existsSync(path.resolve(projectRoot, clientRel))) {
    bad(`exports["./client"] 指向的文件不存在：${clientRel}`, '先跑 npm run build:client。')
  } else {
    ok(`exports["./client"] = ${clientRel}`)
    const bundle = fs.readFileSync(path.resolve(projectRoot, clientRel), 'utf8')
    if (/window\.__ModuleLoader__\.load\(/.test(bundle)) ok('bundle 使用 dsh 的 lazy-CJS factory 包装')
    else bad('bundle 缺少 window.__ModuleLoader__.load 包装', 'dsh 客户端模块系统不会加载裸 ESM/UMD 产物。')
    if (/\bmodule\.exports\b/.test(bundle)) ok('factory 体内有 module.exports 赋值')
    else bad('factory 体内没有 module.exports', '入口没有具名导出时，factory 会返回空对象。')

    const included = (pkg.files ?? []).some((f) => f === 'client' || clientRel.startsWith(`${f}/`))
    if (included) ok('客户端产物已列入 files')
    else warn('files 里没有包含客户端产物', '发布到 npm 后浏览器半侧会丢失。')
  }
}

// ── B. 在哪些 profile 里「装了但没生效」──────────────────────────────────────
console.log('\nB. profile 挂载状态')

const homeCandidates = []
const explicitHome = flag('dsh-home') ?? process.env.DSH_HOME
if (explicitHome) homeCandidates.push(path.resolve(explicitHome))
homeCandidates.push(path.join(os.homedir(), '.dsh'))
if (process.platform === 'win32' && process.env.APPDATA) {
  homeCandidates.push(path.join(process.env.APPDATA, 'dsh-desktop', 'harness'))
  // DSH Desktop 允许把数据目录搬到别处（迁移/重装后会做），活动 home 记在
  // %APPDATA%\DSH Desktop\data-directory\state.json 的 activeHome。
  // 不读它的话，搬家之后本脚本会静默少扫一个 —— 而那个才是真正在用的 profile ——
  // 于是报出「未安装本插件」这种假结论。
  try {
    const statePath = path.join(
      process.env.APPDATA, 'DSH Desktop', 'data-directory', 'state.json',
    )
    const activeHome = JSON.parse(fs.readFileSync(statePath, 'utf8'))?.activeHome
    if (typeof activeHome === 'string' && activeHome.length > 0) {
      homeCandidates.push(path.resolve(activeHome))
    }
  } catch {
    // 没有这个文件 = 从没搬过数据目录，用上面的默认位置就够了。
  }
}

const seen = new Set()
let scannedProfiles = 0

for (const home of homeCandidates) {
  if (seen.has(home)) continue
  seen.add(home)
  const profilesDir = path.join(home, 'profiles')
  if (!fs.existsSync(profilesDir)) continue

  for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    const manifestPath = path.join(profilesDir, entry.name, 'package.json')
    if (!fs.existsSync(manifestPath)) continue

    scannedProfiles++
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      warn(`${entry.name}: package.json 解析失败（${error.message}）`)
      continue
    }

    const asDependency = Boolean(manifest.dependencies?.[pkg.name])
    const asBundle = (manifest.dsh?.profile?.bundles ?? []).includes(pkg.name)
    const label = `${entry.name}  (${manifestPath})`

    if (asBundle) {
      ok(`${label} → 已作为 bundle 挂载`)
    } else if (asDependency) {
      const msg =
        `${label} → 已安装为依赖，但不在 dsh.profile.bundles 里（这就是「已安装，未生效」）`
      const hint =
        `把 "${pkg.name}" 加进该 profile 的 dsh.profile.bundles，或重跑：\n` +
        `        dsh plugin --profile ${entry.name} add ${projectRoot}`
      if (strictProfile) bad(msg, hint)
      else warn(msg, hint)
    } else {
      console.log(`  · ${label} → 未安装本插件`)
    }
  }
}

if (scannedProfiles === 0) {
  warn('没有找到任何 profile', `已查找：\n      ${[...seen].join('\n      ')}`)
}

console.log(`\n失败 ${failures}，警告 ${warnings}`)
process.exit(failures === 0 ? 0 : 1)
