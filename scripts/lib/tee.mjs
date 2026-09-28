// `--out <file>` 支持：把 console.log 同时用 node 直接落盘一份。
//
// 为什么需要：Windows 终端代码页通常不是 UTF-8，中文输出经 PowerShell 转发会被搞乱；
// 而且有些环境根本拿不到干净的 stdout。让 node 自己写文件最稳。
//
// 用法（放在脚本最前面）：
//   import { teeFromArgv } from './lib/tee.mjs'
//   teeFromArgv()

import fs from 'node:fs'

export function teeFromArgv (argv = process.argv.slice(2)) {
  const index = argv.indexOf('--out')
  const file = index >= 0 ? argv[index + 1] : null
  if (!file) return null

  const buffer = []
  const original = console.log
  console.log = (...args) => {
    buffer.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '))
    original(...args)
  }
  process.on('exit', () => {
    try { fs.writeFileSync(file, `${buffer.join('\n')}\n`, 'utf8') } catch { /* ignore */ }
  })
  return file
}
