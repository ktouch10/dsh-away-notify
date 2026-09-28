#!/usr/bin/env node
// 仓库卫生检查：确认公开到 GitHub 之前，仓库里没有本机路径、凭据、真实邮箱。
//
// 为什么值得单独写一个守卫：这些东西一旦进了 git 历史就很难彻底删除，而且
// 会随 npm 包一起发出去。参考 @alotop/dsh-notify-hub 的 check:hygiene 做法。
//
//   node scripts/check-hygiene.mjs

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanTree, SKIP_DIRS } from './lib/scan.mjs'
import { teeFromArgv } from './lib/tee.mjs'

teeFromArgv()

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function main () {
  const findings = scanTree(ROOT)

  console.log('仓库卫生检查')
  console.log('='.repeat(78))
  console.log(`扫描根目录：${ROOT}`)
  console.log(`跳过：${[...SKIP_DIRS].join(', ')}`)
  console.log('')

  if (!findings.length) {
    console.log('没有发现问题 ✓')
    console.log('')
    return
  }

  const byRule = new Map()
  for (const f of findings) {
    if (!byRule.has(f.rule)) byRule.set(f.rule, [])
    byRule.get(f.rule).push(f)
  }

  for (const [rule, list] of byRule) {
    console.log(`✗ ${rule} —— ${list[0].why}（${list.length} 处）`)
    for (const f of list.slice(0, 20)) {
      console.log(`    ${path.relative(ROOT, f.file)}:${f.line}  ${f.snippet}`)
    }
    if (list.length > 20) console.log(`    …还有 ${list.length - 20} 处`)
    console.log('')
  }

  console.log(`共 ${findings.length} 处问题。`)
  process.exitCode = 1
}

main()
