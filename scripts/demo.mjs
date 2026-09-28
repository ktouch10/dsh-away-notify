#!/usr/bin/env node
// 端到端演示：用虚拟时钟驱动**真实的**接线层（src/index.mjs 的 createNotifier），
// 不依赖 DSH 进程、不依赖真实邮箱，几十毫秒跑完。
//
// 它同时充当冒烟测试：每个场景都带期望值，偏离就以退出码 1 报错。
//
//   node scripts/demo.mjs
//
// 完整输出同时写入 .demo-outbox/transcript.txt（用 node 直接落盘，不经终端编码）。

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNotifier } from '../src/index.mjs'
import { normalizeConfig } from '../src/config.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const OUTBOX = path.join(here, '..', '.demo-outbox')
const BASE = Date.parse('2026-09-28T02:00:00Z')
const DWELL_MINUTES = 5

const failures = []
const transcript = []

function emit (line = '') {
  transcript.push(line)
  console.log(line)
}

function stamp (at) {
  const total = Math.round((at - BASE) / 1000)
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `+${mm}:${ss}`
}

function makeSim (subdir) {
  let clock = BASE
  const outboxDir = path.join(OUTBOX, subdir)
  const { config } = normalizeConfig({
    dwellMinutes: DWELL_MINUTES,
    maxDwellMinutes: 30,
    transport: 'outbox',
    outboxDir
  })
  const notifier = createNotifier({ config, now: () => clock, log: () => {} })
  const session = { id: 's-demo', name: '修复登录接口超时' }
  const lines = []

  return {
    notifier,
    session,
    lines,
    outboxDir,
    config,
    say (sec, text) {
      lines.push(`  ${stamp(BASE + sec * 1000)}  ${text}`)
    },
    jump (sec) { clock = BASE + sec * 1000 },
    event (sec, type, data = {}) {
      clock = BASE + sec * 1000
      notifier.handleSessionEvent(session, { type, data })
    },
    async tickAt (sec) {
      clock = BASE + sec * 1000
      const fired = notifier.tick()
      await notifier.flush()
      return fired
    },
    files: async () => {
      try { return (await fs.readdir(outboxDir)).sort() } catch { return [] }
    }
  }
}

function turnStart (sim, sec, turn) {
  sim.say(sec, `turn/start       第 ${turn} 轮开始`)
  sim.event(sec, 'turn/start', { turn })
}
function turnEnd (sim, sec, turn, reason = 'completed') {
  sim.say(sec, `turn/end         reason=${reason}`)
  // 真实形状：reason 是对象 { kind }，不是字符串（见 test/fixtures/real-events.mjs）
  sim.event(sec, 'turn/end', { turn, reason: { kind: reason } })
}
function toolCall (sim, sec, turn, name) {
  sim.say(sec, `tool/call        ${name}`)
  sim.event(sec, 'tool/call', { turn, name })
  sim.event(sec, 'tool/result', {
    turn,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId: `call_demo_${turn}_${name}` },
      toolCallId: `call_demo_${turn}_${name}`,
      content: [{ type: 'text', text: 'ok' }],
      isError: false
    }
  })
}
function assistant (sim, sec, turn, text) {
  sim.say(sec, 'assistant/message（收到一段回复）')
  sim.event(sec, 'assistant/message', {
    turn,
    message: {
      // 真实的 content 同时含 reasoning / text / tool-call；摘要只该取 text
      content: [
        { type: 'reasoning', text: '内部推理：先读配置再动手' },
        { type: 'text', text }
      ],
      source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' }
    },
    usage: { inputTokens: 490, outputTokens: 361, cacheReadTokens: 19200, cacheWriteTokens: 0, totalTokens: 20338 }
  })
}

async function printResult (sim, expectDelivered, label) {
  const delivered = sim.notifier.deliveries.filter(d => d.result)
  const suppressed = sim.notifier.deliveries.filter(d => d.suppressed)
  const ok = delivered.length === expectDelivered

  emit(`  判定：${ok ? 'OK' : '不符预期'} —— 投递 ${delivered.length} 封`
    + `，撤销 ${sim.notifier.stats.cancelled} 次，挂起 ${sim.notifier.stats.paused} 次`
    + `，静默 ${suppressed.length} 次`)

  if (delivered.length) {
    const mail = delivered[0].mail
    emit('')
    emit('  ┌─ 发出的邮件 ─────────────────────────────────────────────')
    emit(`  │ Subject: ${mail.subject}`)
    for (const line of mail.text.split('\n')) emit(`  │ ${line}`)
    emit('  └──────────────────────────────────────────────────────────')
    emit(`  落盘：${path.relative(process.cwd(), delivered[0].result.eml)}`)
  }
  emit('')

  if (!ok) failures.push(`${label}：期望投递 ${expectDelivered} 封，实际 ${delivered.length} 封`)
  return delivered
}

async function main () {
  await fs.rm(OUTBOX, { recursive: true, force: true })
  await fs.mkdir(OUTBOX, { recursive: true })

  emit('')
  emit('dsh-away-notify · 端到端演示（虚拟时钟 / 不依赖 DSH / 不发真实邮件）')
  emit(`规则：回合结束后安静 ${DWELL_MINUTES} 分钟且期间无用户消息 → 提醒；用户回来 → 撤销`)
  emit('='.repeat(78))

  // ── 场景 A：你离开了 ────────────────────────────────────────────────
  emit('\n【场景 A】跑完就走人，5 分钟没回来 → 应该收到提醒\n')
  {
    const sim = makeSim('a-away')
    turnStart(sim, 0, 1)
    toolCall(sim, 12, 1, 'bash')
    toolCall(sim, 30, 1, 'read_file')
    assistant(sim, 61, 1, '已定位到连接池配置问题，补了超时重试并跑通了测试。')
    turnEnd(sim, 65, 1)
    sim.say(65, `→ 排定提醒，deadline = ${stamp(BASE + (65 + DWELL_MINUTES * 60) * 1000)}`)
    sim.say(364, 'tick：还没到点，不发')
    await sim.tickAt(364)
    sim.say(365, 'tick：到点 → 发出')
    await sim.tickAt(365)
    emit(sim.lines.join('\n'))
    emit('')
    await printResult(sim, 1, '场景 A')
  }

  // ── 场景 B：你回来了 ────────────────────────────────────────────────
  emit('\n【场景 B】同样跑完了，但你 2 分钟就回来接着聊 → 不该发\n')
  {
    const sim = makeSim('b-came-back')
    turnStart(sim, 0, 1)
    toolCall(sim, 20, 1, 'bash')
    turnEnd(sim, 60, 1)
    sim.say(120, 'user/message（source.kind=user）→ 撤销待发提醒')
    sim.event(120, 'user/message', { source: { kind: 'user' }, content: '我回来了，继续' })
    sim.say(600, 'tick：已撤销，什么都不发')
    await sim.tickAt(600)
    emit(sim.lines.join('\n'))
    emit('')
    await printResult(sim, 0, '场景 B')
  }

  // ── 场景 C：一晚上续跑多轮 → 合并成一封 ──────────────────────────────
  emit('\n【场景 C】后台任务反复唤醒 agent，续跑 3 轮 → 只该收到一封（合并）\n')
  {
    const sim = makeSim('c-burst')
    turnStart(sim, 0, 1)
    toolCall(sim, 30, 1, 'bash')
    assistant(sim, 60, 1, '第一步完成，继续处理第二步。')
    turnEnd(sim, 70, 1)
    sim.say(70, `→ 排定，deadline = ${stamp(BASE + (70 + DWELL_MINUTES * 60) * 1000)}`)

    turnStart(sim, 240, 2)
    sim.say(240, '→ 活还没干完，挂起（不发）')
    toolCall(sim, 300, 2, 'bash')
    turnEnd(sim, 480, 2)

    turnStart(sim, 840, 3)
    toolCall(sim, 900, 3, 'bash')
    assistant(sim, 1020, 3, '三步都跑完了，最终结果是：测试全绿。')
    turnEnd(sim, 1080, 3)
    sim.say(1080, `→ 合并为正 1 封，deadline = ${stamp(BASE + (1080 + DWELL_MINUTES * 60) * 1000)}`)

    sim.say(1379, 'tick：还没到点')
    await sim.tickAt(1379)
    sim.say(1380, 'tick：到点 → 发出（一封，不是三封）')
    await sim.tickAt(1380)

    emit(sim.lines.join('\n'))
    emit('')
    await printResult(sim, 1, '场景 C')
  }

  // ── 汇总 ────────────────────────────────────────────────────────────
  emit('='.repeat(78))
  const all = (await fs.readdir(OUTBOX, { recursive: true })).filter(f => f.endsWith('.eml'))
  emit(`outbox：${path.relative(process.cwd(), OUTBOX)}（${all.length} 封 .eml + 对应 .txt）`)

  if (failures.length) {
    emit('\n演示失败：')
    for (const f of failures) emit(`  ✗ ${f}`)
    process.exitCode = 1
  } else {
    emit('全部场景符合预期 ✓')
    emit('')
  }

  await fs.writeFile(path.join(OUTBOX, 'transcript.txt'), `${transcript.join('\n')}\n`, 'utf8')
}

await main()
