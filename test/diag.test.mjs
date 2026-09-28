// 诊断日志。
//
// 存在的理由：通知插件最糟的失败方式是「什么都不发生」—— DSH 又不把插件主机端的
// 输出落盘（logs/ 里只有崩溃日志），所以「为什么没收到提醒」根本无从查起。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDiagnostics, describeConfig, defaultDiagDir, DIAG_FILE } from '../src/diag.mjs'
import { normalizeConfig } from '../src/config.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = path.join(ROOT, '.test-tmp')

function tempDir (name) {
  const dir = path.join(TMP, `diag-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

test('默认目录在 ~/.dsh/dsh-away-notify 下', () => {
  assert.equal(defaultDiagDir(), path.join(defaultDiagDir(), '').replace(/[\\/]$/, ''))
  assert.match(defaultDiagDir(), /\.dsh[\\/]dsh-away-notify$/)
})

test('会创建目录并写日志', () => {
  const dir = tempDir('write')
  const diag = createDiagnostics({ dir, now: () => new Date('2026-09-28T00:00:00Z') })

  assert.equal(diag.enabled, true)
  assert.equal(diag.file, path.join(dir, DIAG_FILE))

  diag.write('info', '第一条')
  diag.write('warn', '第二条')

  const text = fs.readFileSync(diag.file, 'utf8')
  assert.match(text, /2026-09-28T00:00:00\.000Z {2}info {2}第一条/)
  assert.match(text, /warn {2}第二条/)
})

test('目录不可写时静默降级，不抛错', () => {
  // 用一个「父路径是文件」的目录让 mkdir 必然失败
  const dir = tempDir('blocked')
  const blocker = path.join(dir, 'file')
  fs.writeFileSync(blocker, 'x')

  let diag = null
  assert.doesNotThrow(() => { diag = createDiagnostics({ dir: path.join(blocker, 'sub') }) })
  assert.equal(diag.enabled, false)
  assert.equal(diag.file, null)
  assert.doesNotThrow(() => diag.write('info', '随便写'))
})

test('enabled=false 时什么都不做', () => {
  const diag = createDiagnostics({ enabled: false })
  assert.equal(diag.enabled, false)
  assert.equal(diag.file, null)
  assert.doesNotThrow(() => diag.write('info', 'x'))
})

test('超过上限会整份重写，不会无限增长', () => {
  const dir = tempDir('rotate')
  const diag = createDiagnostics({ dir, maxBytes: 200 })
  for (let i = 0; i < 50; i++) diag.write('info', `第 ${i} 行，故意写长一点好触发轮转 ................`)
  const size = fs.statSync(diag.file).size
  assert.ok(size <= 400, `轮转后不该远超上限，实际 ${size}`)
})

test('describeConfig 绝不能泄漏密码', () => {
  const { config } = normalizeConfig({
    dwellMinutes: 3,
    transport: 'smtp',
    smtpHost: 'smtp.example.com',
    smtpUser: 'bot@example.com',
    smtpPass: 'super-secret-token-12345',
    smtpTo: 'a@b.c, d@e.f'
  })

  const summary = describeConfig(config)
  assert.ok(!summary.includes('super-secret-token-12345'), '日志里绝不能出现密码明文')
  assert.ok(!summary.includes('smtpPass=super'), '也不该出现部分密码')
  assert.match(summary, /smtpPass=字面量\(已脱敏\)/)
  assert.match(summary, /dwell=3min/)
  assert.match(summary, /transport=smtp/)
  assert.match(summary, /smtpHost=smtp\.example\.com/)
  assert.match(summary, /2 个收件人/)
})

test('describeConfig 在密码走环境变量时只记变量名', () => {
  const { config } = normalizeConfig({ transport: 'smtp', smtpHost: 'h', smtpUser: 'u', smtpPassEnv: 'MY_SECRET' })
  const summary = describeConfig(config)
  assert.match(summary, /smtpPass=env:MY_SECRET/)
})
