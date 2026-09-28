#!/usr/bin/env node
// 发布产物检查：**真的打一个 tarball 出来**，解开 tar 逐条核对。
//
// 为什么不能只信 package.json 的 `files` 白名单：白名单写错一个路径、漏掉一个源文件、
// 或者多带了 test/ 与凭据文件，只有真打完包才看得见。参考 @alotop/dsh-notify-hub 的 pack:check。
//
// 这个脚本**不允许静默跳过**：打不出包就直接失败。否则 CI 会给人"已检查"的错觉。
//
//   node scripts/check-tarball.mjs
//   DSH_AWAY_PNPM_CJS=/path/to/pnpm.cjs node scripts/check-tarball.mjs   # 指定打包器

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildRules, scanText } from './lib/scan.mjs'
import { teeFromArgv } from './lib/tee.mjs'
import { NAMESPACE } from '../src/settings.mjs'

teeFromArgv()

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORK = path.join(ROOT, '.test-tmp', 'pack')

// 与 check-hygiene 用同一套规则（含运行时从 os 读的本机身份规则）
const RULES = buildRules({ root: ROOT })

/** 包里必须有的文件（相对 package/ 的路径）。 */
const REQUIRED = [
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'LICENSE',
  'src/index.mjs'
]

/** 包路径里禁止出现的前缀/文件。 */
const FORBIDDEN = [
  'test/',
  'scripts/',
  'node_modules/',
  '.test-tmp/',
  '.demo-outbox/',
  '.github/',
  '.git/',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.gitignore',
  '.gitattributes',
  '.env'
]

// ─────────────────────────── 打一个真包 ───────────────────────────

function pack () {
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })

  const attempts = []
  const pnpmCjs = process.env.DSH_AWAY_PNPM_CJS
  if (pnpmCjs) {
    attempts.push({ label: `node ${path.basename(pnpmCjs)} pack`, cmd: process.execPath, args: [pnpmCjs, 'pack', '--pack-destination', WORK] })
  }
  attempts.push({ label: 'npm pack', cmd: 'npm', args: ['pack', '--pack-destination', WORK, '--ignore-scripts'] })
  attempts.push({ label: 'pnpm pack', cmd: 'pnpm', args: ['pack', '--pack-destination', WORK] })

  const failures = []
  for (const attempt of attempts) {
    const result = spawnSync(attempt.cmd, attempt.args, { cwd: ROOT, stdio: 'ignore', shell: false })
    const tgz = fs.existsSync(WORK) ? fs.readdirSync(WORK).filter(f => f.endsWith('.tgz')) : []
    if (tgz.length) return { file: path.join(WORK, tgz[0]), how: attempt.label }
    failures.push(`${attempt.label} → ${result.error ? result.error.code : `exit ${result.status}`}`)
  }
  return { file: null, failures }
}

// ─────────────────────────── 解 tar ───────────────────────────

/** 解析 gzip 后的 tar。只需要文件名、大小与内容，够用就行。 */
function readTarGz (file) {
  const buf = zlib.gunzipSync(fs.readFileSync(file))
  const entries = []
  let offset = 0
  let longName = null

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const size = parseInt(sizeField, 8) || 0
    const type = String.fromCharCode(header[156]) || '0'
    const dataStart = offset + 512
    const data = buf.subarray(dataStart, dataStart + size)

    let name = rawName
    if (longName && (type === '0' || type === '\0')) { name = longName; longName = null }
    if (type === 'L') longName = data.toString('utf8').replace(/\0.*$/, '')
    if (type === 'x') {
      // pax 扩展头：里面的 path= 才是真名
      const m = data.toString('utf8').match(/\d+ path=([^\n]+)\n/)
      if (m) longName = m[1]
    }

    if (type === '0' || type === '\0') {
      entries.push({ name, size, data })
    }

    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return entries
}

// ─────────────────────────── 核对 ───────────────────────────

function main () {
  const problems = []
  const warnings = []
  const note = (message) => problems.push(message)

  console.log('发布产物检查')
  console.log('='.repeat(78))

  const packed = pack()
  if (!packed.file) {
    console.log('✗ 打不出包，无法检查。尝试过的打包器：')
    for (const line of packed.failures ?? []) console.log(`    ${line}`)
    console.log('')
    console.log('可用 DSH_AWAY_PNPM_CJS 指定 pnpm.cjs 的路径。')
    process.exitCode = 1
    return
  }

  const entries = readTarGz(packed.file)
  const names = entries.map(e => e.name)
  const rel = names.map(n => n.replace(/^package\//, ''))

  console.log(`打包器：${packed.how}`)
  console.log(`产物  ：${path.relative(ROOT, packed.file)}（${(fs.statSync(packed.file).size / 1024).toFixed(1)} KiB，${entries.length} 个文件）`)
  console.log('')

  // 1) 全部都得在 package/ 前缀下
  for (const name of names) {
    if (!name.startsWith('package/')) note(`条目不在 package/ 前缀下：${name}`)
  }

  // 2) 必需文件
  for (const file of REQUIRED) {
    if (!rel.includes(file)) note(`缺少必需文件：${file}`)
  }

  // 3) 禁止文件
  for (const entry of rel) {
    for (const bad of FORBIDDEN) {
      if (entry === bad || entry.startsWith(bad)) note(`包里不该出现：${entry}（命中禁用规则 ${bad}）`)
    }
  }

  // 4) src 一个都不能漏 —— 漏一个源文件插件就装不起来
  const localSrc = fs.readdirSync(path.join(ROOT, 'src')).filter(f => f.endsWith('.mjs')).sort()
  const packedSrc = rel.filter(f => f.startsWith('src/')).sort()
  const missing = localSrc.map(f => `src/${f}`).filter(f => !packedSrc.includes(f))
  const extra = packedSrc.filter(f => !localSrc.includes(f.replace(/^src\//, '')))
  for (const f of missing) note(`源文件没打进包：${f}`)
  for (const f of extra) note(`包里有多余的源文件：${f}`)

  // 5) 包内 package.json 必须仍然能被 DSH 识别，且 main 指向真实存在的文件
  const pkgEntry = entries.find(e => e.name === 'package/package.json')
  if (pkgEntry) {
    let pkg = null
    try { pkg = JSON.parse(pkgEntry.data.toString('utf8')) } catch (error) { note(`包内 package.json 解析失败：${error.message}`) }
    if (pkg) {
      if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') note('包内 package.json 丢了 dsh.bundle.patch —— 装进 profile 不会生效')
      if (!pkg.main) note('包内 package.json 缺 main')
      else if (!rel.includes(pkg.main.replace(/^\.\//, ''))) note(`main 指向的文件不在包里：${pkg.main}`)
      if (pkg.private === true) note('package.json 标了 private: true，npm publish 会被拒')
      if (!pkg.version) note('缺 version')

      // 发布元数据只是提醒，不算失败 —— 本地和 CI 不该因为还没建仓库就红。
      // 真正的硬门在 .github/workflows/release.yml 里（占位符会拦住发布）。
      const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
      if (!repoUrl) warnings.push('package.json 还没填 repository')
      else if (repoUrl.includes('OWNER')) warnings.push('package.json 的 repository 还是 OWNER 占位符')
    }
  }

  // 6) 包内 cordis.patch.yml 的 entry id 必须等于设置命名空间
  const patchEntry = entries.find(e => e.name === 'package/cordis.patch.yml')
  if (patchEntry) {
    const yml = patchEntry.data.toString('utf8')
    if (!new RegExp(`^\\s*- id: ${NAMESPACE}\\s*$`, 'm').test(yml)) {
      note(`包内 cordis.patch.yml 的 entry id 不等于设置命名空间 ${NAMESPACE}`)
    }
  }

  // 7) 对包里每个文本文件再跑一遍敏感信息规则（白名单之外的兜底）
  for (const entry of entries) {
    const text = entry.data.toString('utf8')
    if (text.length > 400_000) continue
    for (const finding of scanText(text, { rules: RULES })) {
      note(`包内 ${entry.name} 命中 ${finding.rule}（${finding.why}）：${finding.snippet}`)
    }
  }

  // 输出清单
  console.log('包内文件：')
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${(entry.size / 1024).toFixed(1).padStart(8)} KiB  ${entry.name}`)
  }
  console.log('')

  // 警告要在所有检查跑完之后再打 —— 它们是后面几步才填进去的
  if (warnings.length) {
    for (const w of warnings) console.log(`提示：${w}（发布前必须填好）`)
    console.log('')
  }

  if (problems.length) {
    console.log(`✗ ${problems.length} 个问题：`)
    for (const p of problems) console.log(`  - ${p}`)
    console.log('')
    process.exitCode = 1
    return
  }

  console.log(`没有发现问题 ✓（${entries.length} 个文件，${(fs.statSync(packed.file).size / 1024).toFixed(1)} KiB）`)
  console.log('')
}

main()
