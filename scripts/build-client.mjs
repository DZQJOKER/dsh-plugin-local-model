#!/usr/bin/env node
/**
 * 把 client/src 打包成 dsh 客户端模块系统要求的「lazy-CJS factory」。
 *
 *   node scripts/build-client.mjs
 *
 * 产物形状（照 dsh 自带客户端插件逐字节对照出来的）：
 *
 *   window.__ModuleLoader__.load({
 *     id: "<包名>",
 *     factory: (require) => {
 *       var module = { exports: {} }; var exports = module.exports;
 *       ...esbuild 打出来的 CJS 体...
 *       return module.exports;
 *     }
 *   });
 *
 * 要点：
 *   - react / react/jsx-runtime 必须 external —— 由宿主提供，打进包里会出现两份 React；
 *   - 只有 ESM 具名导出的 apply / inject 会被 dsh 读取，所以不能有 default 导出；
 *   - 构建完由 scripts/client-check.mjs 用假 loader 真正加载一次，确认格式没跑偏。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')

/** 宿主提供的模块，一律 external。 */
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis/client',
]

/** esbuild 可能在用户的 devDependencies 里，也可能在隔离的构建工作区里。 */
async function loadEsbuild() {
  try {
    return await import('esbuild')
  } catch {
    // 继续找。
  }

  const candidates = [
    process.env.LOCAL_MODEL_BUILDER_ROOT,
    path.join(process.env.USERPROFILE ?? '', '.workbuddy', 'binaries', 'node', 'workspace'),
    path.join(process.env.HOME ?? '', '.workbuddy', 'binaries', 'node', 'workspace'),
  ].filter((candidate) => candidate && fs.existsSync(candidate))

  for (const root of candidates) {
    try {
      const requireFrom = createRequire(path.join(root, 'noop.js'))
      return requireFrom('esbuild')
    } catch {
      // 继续找。
    }
  }

  throw new Error(
    '找不到 esbuild。请先安装：npm i -D esbuild（或设置 LOCAL_MODEL_BUILDER_ROOT 指向含有 esbuild 的目录）',
  )
}

function indent(text, prefix) {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? prefix + line : line))
    .join('\n')
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  const entry = path.join(projectRoot, 'client', 'src', 'index.jsx')
  const outFile = path.join(projectRoot, 'client', 'client.js')

  if (!fs.existsSync(entry)) throw new Error(`客户端入口不存在：${entry}`)

  const esbuild = await loadEsbuild()
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'neutral',
    target: ['es2020'],
    jsx: 'automatic',
    external: EXTERNALS,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'warning',
  })

  const body = result.outputFiles[0].text
  if (!/\bmodule\.exports\b/.test(body)) {
    throw new Error('打包结果里没有 module.exports —— 入口可能没有具名导出，factory 会返回空对象')
  }

  const wrapped = [
    '// 由 scripts/build-client.mjs 生成，请勿手改；改 client/src 后重新运行 npm run build:client。',
    'window.__ModuleLoader__.load({',
    `\tid: ${JSON.stringify(pkg.name)},`,
    '\tfactory: (require) => {',
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    indent(body.trimEnd(), '\t\t'),
    '\t\treturn module.exports;',
    '\t}',
    '});',
    '',
  ].join('\n')

  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, wrapped, 'utf8')

  const sizeKb = (Buffer.byteLength(wrapped, 'utf8') / 1024).toFixed(1)
  console.log(`✓ 已生成 ${path.relative(projectRoot, outFile)}（${sizeKb} KB，外部依赖：${EXTERNALS.join(', ')}）`)
}

main().catch((error) => {
  console.error(`\n✗ 客户端打包失败：${error.message}`)
  process.exit(1)
})
