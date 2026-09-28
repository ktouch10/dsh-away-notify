#!/usr/bin/env node
// 从本机真实的 DSH 会话日志里读出**真实的事件契约**。
//
// 为什么需要它：`session/event` 的字段形状没有官方 API 文档，而 DSH 还在 0.1.x，
// 字段位置跨版本变过。本插件的折叠逻辑（summary.mjs）是照着推出来的契约写的，
// 所以必须能拿你自己的会话来核对，而不是靠猜。
//
//   node scripts/inspect-session.mjs                    # 自动找最近改动的会话
//   node scripts/inspect-session.mjs <路径.v4.jsonl.zstd>
//   node scripts/inspect-session.mjs --type turn/end    # 只看某一类事件的完整样本
//   node scripts/inspect-session.mjs --raw 3            # 打印前 N 条原始记录
//   node scripts/inspect-session.mjs --sessions         # 列出所有会话日志
//
// 需要 Node >= 23.8（zstd 内置支持）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

// --out <file>：同时用 node 直接落盘一份（终端代码页在 Windows 上常常不是 UTF-8，
// 中文样本会被终端搞乱；需要留档或贴给 AI 分析时用这个）。
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

// 本插件关心的类型：契约一旦错，折叠与判定就会错
const INTERESTING = [
  'turn/start',
  'turn/end',
  'assistant/message',
  'tool/call',
  'tool/result',
  'user/message',
  'session/title',
  'agent/error',
  'approval/asked'
]

function sessionsRoot () {
  return path.join(os.homedir(), '.dsh', 'sessions')
}

export function findLogs () {
  const root = sessionsRoot()
  const out = []
  const walk = dir => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.jsonl.zstd')) {
        const st = fs.statSync(full)
        out.push({ file: full, size: st.size, mtime: st.mtimeMs })
      }
    }
  }
  walk(root)
  return out.sort((a, b) => b.mtime - a.mtime)
}

/**
 * 解压会话日志。
 *
 * 坑：DSH 是**追加写**的，一个 .jsonl.zstd 里通常有几百个独立的 zstd 帧
 * （实测某个 770 KB 的日志里有 327 帧）。而 `zstdDecompressSync()` 和
 * `createZstdDecompress()` 都**只解第一帧就停**，于是只能读到会话头那一条，
 * 看起来像「这个会话没有任何事件」。这里按帧魔数切分后逐帧解。
 */
export function decompress (file) {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error(`当前 Node ${process.version} 不支持 zstd，需要 >= 23.8`)
  }
  const buf = fs.readFileSync(file)
  const MAGIC = [0x28, 0xB5, 0x2F, 0xFD]

  const offsets = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      offsets.push(i)
    }
  }

  // 单帧（或没找到魔数）：直接整块解
  if (offsets.length <= 1) {
    try { return zlib.zstdDecompressSync(buf).toString('utf8') } catch { return '' }
  }

  const parts = []
  for (const offset of offsets) {
    try {
      const out = zlib.zstdDecompressSync(buf.subarray(offset))
      if (out?.length) parts.push(out)
    } catch {
      // 压缩数据里偶然出现的假魔数，忽略
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

export function eventType (record) {
  return record?.type ?? record?.event?.type ?? record?.kind ?? null
}

export function eventData (record) {
  return record?.data ?? record?.event?.data ?? null
}

/** 读一个会话日志，返回解析好的记录数组（供其他脚本/测试复用）。 */
export function readRecords (file) {
  const records = []
  let malformed = 0
  for (const line of decompress(file).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try { records.push(JSON.parse(trimmed)) } catch { malformed += 1 }
  }
  return { records, malformed }
}

/** 把一个值压成一行短描述。 */
function describe (value, depth = 0) {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    if (!value.length) return 'array(0)'
    const inner = describe(value[0], depth + 1)
    return `array(${value.length}) of ${inner}`
  }
  const t = typeof value
  if (t === 'object') {
    const keys = Object.keys(value)
    if (depth >= 2) return `object{${keys.slice(0, 6).join(',')}}`
    return `object{${keys.slice(0, 8).join(',')}${keys.length > 8 ? ',…' : ''}}`
  }
  if (t === 'string') {
    const s = value.length > 40 ? `${value.slice(0, 40)}…` : value
    return `string(${value.length}) ${JSON.stringify(s)}`
  }
  return `${t} ${JSON.stringify(value)}`
}

/** 收集对象的所有字段路径（含类型），用于对比「我以为的契约」和真实契约。 */
function collectPaths (value, prefix = '', out = new Map(), depth = 0) {
  if (depth > 5 || value === null || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    if (value.length) collectPaths(value[0], `${prefix}[]`, out, depth + 1)
    return out
  }
  for (const [key, val] of Object.entries(value)) {
    const p = prefix ? `${prefix}.${key}` : key
    if (!out.has(p)) out.set(p, new Set())
    out.get(p).add(describe(val, 1))
    if (val && typeof val === 'object') collectPaths(val, p, out, depth + 1)
  }
  return out
}

function clip (text, limit = 700) {
  const s = typeof text === 'string' ? text : JSON.stringify(text)
  return s.length > limit ? `${s.slice(0, limit)}…(${s.length} 字符)` : s
}

function main () {
  const argv = process.argv.slice(2)
  const flag = name => {
    const i = argv.indexOf(name)
    return i >= 0 ? (argv[i + 1] ?? true) : null
  }

  if (flag('--sessions')) {
    const logs = findLogs()
    if (!logs.length) {
      console.log(`没有找到会话日志：${sessionsRoot()}`)
      return
    }
    for (const log of logs) {
      console.log(`${log.file}\n  ${(log.size / 1024).toFixed(0)} KiB  ${new Date(log.mtime).toISOString()}`)
    }
    return
  }

  const explicit = argv.find(a => !a.startsWith('--') && a.endsWith('.zstd'))
  const logs = findLogs()
  const target = explicit ?? logs[0]?.file
  if (!target) {
    console.error(`没有找到会话日志。用 --sessions 列一下，或直接传路径。`)
    process.exitCode = 1
    return
  }

  const text = decompress(target)
  const records = []
  let malformed = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try { records.push(JSON.parse(trimmed)) } catch { malformed += 1 }
  }

  console.log('会话事件契约探针')
  console.log('='.repeat(78))
  console.log(`文件：${target}`)
  console.log(`记录：${records.length} 条${malformed ? `（另有 ${malformed} 行无法解析）` : ''}`)
  console.log('')

  const onlyType = flag('--type')
  if (onlyType && onlyType !== true) {
    const hits = records.filter(r => eventType(r) === onlyType)
    console.log(`「${onlyType}」共 ${hits.length} 条，打印最后 3 条的原始 JSON：\n`)
    for (const hit of hits.slice(-3)) {
      console.log(JSON.stringify(hit, null, 2))
      console.log('-'.repeat(78))
    }
    return
  }

  const rawCount = flag('--raw')
  if (rawCount && rawCount !== true) {
    const n = Math.max(1, Number(rawCount) || 1)
    console.log(`前 ${n} 条原始记录：\n`)
    for (const rec of records.slice(0, n)) console.log(JSON.stringify(rec, null, 2), '\n')
    return
  }

  // 事件类型直方图
  const histogram = new Map()
  for (const rec of records) {
    const t = eventType(rec) ?? '(无 type 字段)'
    histogram.set(t, (histogram.get(t) ?? 0) + 1)
  }
  console.log('事件类型直方图：')
  for (const [t, n] of [...histogram].sort((a, b) => b[1] - a[1])) {
    const mark = INTERESTING.includes(t) ? ' ★' : ''
    console.log(`  ${String(n).padStart(6)}  ${t}${mark}`)
  }
  console.log('  （★ = 本插件的折叠逻辑用到）\n')

  // 关键类型的字段路径与样本
  for (const type of INTERESTING) {
    const hits = records.filter(r => eventType(r) === type)
    if (!hits.length) {
      console.log(`── ${type}：本会话中没有出现\n`)
      continue
    }
    const paths = new Map()
    for (const hit of hits) collectPaths(eventData(hit) ?? {}, '', paths)
    console.log(`── ${type}（${hits.length} 条）`)
    console.log('   字段路径：')
    for (const [p, kinds] of [...paths].sort()) {
      console.log(`     ${p.padEnd(42)} ${[...kinds].join(' | ')}`)
    }
    const last = hits[hits.length - 1]
    console.log(`   最后一条样本（data）：`)
    console.log(`     ${clip(eventData(last))}`)
    console.log('   最后一条样本（完整记录）：')
    console.log(`     ${clip(JSON.stringify(last))}\n`)
  }

  // 外层信封（除了 type/data 还有什么）
  const envelope = new Map()
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue
    for (const key of Object.keys(rec)) {
      if (!envelope.has(key)) envelope.set(key, new Set())
      envelope.get(key).add(describe(rec[key], 1))
    }
  }
  console.log('── 外层信封字段')
  for (const [k, kinds] of [...envelope].sort()) {
    console.log(`   ${k.padEnd(20)} ${[...kinds].join(' | ')}`)
  }
}

// 只在被当作脚本直接运行时才输出；被 import 时只导出工具函数。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
