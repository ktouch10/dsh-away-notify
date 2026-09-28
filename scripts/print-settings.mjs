#!/usr/bin/env node
// 打印设置卡片（面板）的字段表。
//
// 用途：设置卡片是 DSH 从 schema 自动生成的，只有真跑起来才看得到。这个脚本让你
// **不重启 DSH** 就能先看清卡片会长成什么样：字段名、类型、默认值、是否密码、说明。
//
//   node scripts/print-settings.mjs

import fs from 'node:fs'
import { NAMESPACE, Config, SETTINGS_DEFAULTS, loadSchema } from '../src/settings.mjs'

// --out <file>：同时用 node 直接落盘一份（Windows 终端代码页常常不是 UTF-8，
// 中文说明会被终端搞乱）。
{
  const argv = process.argv.slice(2)
  const idx = argv.indexOf('--out')
  const outFile = idx >= 0 ? argv[idx + 1] : null
  if (outFile) {
    const buffer = []
    const original = console.log
    console.log = (...args) => {
      buffer.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '))
      original(...args)
    }
    process.on('exit', () => {
      try { fs.writeFileSync(outFile, `${buffer.join('\n')}\n`, 'utf8') } catch { /* ignore */ }
    })
  }
}

function typeOf (node) {
  if (!node) return '?'
  if (node.type === 'union') return 'union'
  return node.type
}

function allowed (node, refs) {
  if (node?.type !== 'union' || !Array.isArray(node.list)) return ''
  const values = node.list.map(id => refs[String(id)]?.value).filter(v => v !== undefined)
  return values.length ? `（${values.map(v => JSON.stringify(v)).join(' | ')}）` : ''
}

function main () {
  const Schema = loadSchema()
  console.log('')
  console.log('dsh-away-notify · 设置卡片（面板）预览')
  console.log('='.repeat(96))
  console.log(`设置命名空间        : ${NAMESPACE}`)
  console.log(`cordis.patch.yml id : ${NAMESPACE}   ← 必须与命名空间同名，否则卡片保存会抛`)
  console.log(`schemastery         : ${Schema ? '已加载' : '未加载（降级：无卡片，只读 cordis.patch.yml）'}`)

  if (!Config) {
    console.log('')
    console.log('没有 Config，无法预览。装上 @deepseek-ai/schemastery 后重试。')
    return
  }

  const json = Config.toJSON()
  const root = Object.values(json.refs).find(node => node && node.dict)
  const fields = Object.entries(root.dict).map(([name, id]) => [name, json.refs[String(id)]])

  console.log(`字段数              : ${fields.length}（全部 volatile —— 只有 volatile 字段会出现在可写表单里）`)
  console.log('')

  // 动态列宽：union 的类型串比其他长，固定宽度会把后面几列挤到一起
  const rows = fields.map(([name, node]) => ({
    name,
    type: typeOf(node) + allowed(node, json.refs),
    def: JSON.stringify(SETTINGS_DEFAULTS[name] ?? ''),
    desc: (node.meta?.description ?? '') + (node.meta?.role === 'secret' ? ' 🔒不回传浏览器' : '')
  }))
  const w = (key, min) => Math.max(min, ...rows.map(r => r[key].length))

  const nameW = w('name', 4) + 2
  const typeW = w('type', 4) + 2
  const defW = w('def', 5) + 2
  console.log(`${'字段'.padEnd(nameW)}${'类型'.padEnd(typeW)}${'默认'.padEnd(defW)}说明`)
  console.log('-'.repeat(nameW + typeW + defW + 40))
  for (const row of rows) {
    console.log(`${row.name.padEnd(nameW)}${row.type.padEnd(typeW)}${row.def.padEnd(defW)}${row.desc}`)
  }

  console.log('')
  console.log('在 DSH 里的位置：设置 → 插件 → dsh-away-notify（改完立即生效，applies: live）')
  console.log('')
}

main()
