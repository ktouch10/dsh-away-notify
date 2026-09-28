// 宿主接线层：用虚拟时钟驱动**真实的** createNotifier，验证整条链路。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNotifier, apply } from '../src/index.mjs'
import { normalizeConfig } from '../src/config.mjs'

const MIN = 60_000
const T0 = Date.parse('2026-09-28T09:00:00Z')

// 临时目录放在仓库内而不是系统 temp：受限环境（如 DSH 的文件沙箱）常常不允许
// 在 TMPDIR 下新建子目录，用 os.tmpdir() 会让整套投递用例无辜失败。
const TEST_TMP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-tmp')

// apply() 会写诊断日志；重定向到仓库内，免得跑测试污染 ~/.dsh
process.env.DSH_AWAY_NOTIFY_DIAG_DIR = path.join(TEST_TMP, 'diag-notifier')

async function tempDir () {
  const dir = path.join(TEST_TMP, `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function setup ({ outboxDir, ...overrides }) {
  let clock = T0
  const { config } = normalizeConfig({
    dwellMinutes: 5,
    transport: 'outbox',
    outboxDir,
    ...overrides
  })
  const notifier = createNotifier({ config, now: () => clock, log: () => {} })
  return {
    notifier,
    config,
    advance: ms => { clock += ms },
    at: () => clock
  }
}

const SESSION = { id: 's1', name: '修复登录接口超时' }
const ev = (type, data = {}) => ({ type, data })

function runTurn (notifier, { turn = 1, toolCalls = 2, text = '已完成' } = {}) {
  notifier.handleSessionEvent(SESSION, ev('turn/start', { turn }))
  for (let i = 0; i < toolCalls; i++) {
    notifier.handleSessionEvent(SESSION, ev('tool/call', { turn, name: 'bash' }))
    notifier.handleSessionEvent(SESSION, ev('tool/result', { turn, ok: true }))
  }
  if (text) {
    notifier.handleSessionEvent(SESSION, ev('assistant/message', {
      turn,
      message: { content: [{ type: 'text', text }], source: { model: 'deepseek-flash' } }
    }))
  }
  notifier.handleSessionEvent(SESSION, ev('turn/end', { turn, reason: 'completed' }))
}

async function listOutbox (dir) {
  return (await fs.readdir(dir)).sort()
}

test('你离开满 5 分钟 → 收到一封提醒', async () => {
  const dir = await tempDir()
  const { notifier, advance } = setup({ outboxDir: dir })

  runTurn(notifier)
  assert.equal(notifier.scheduler.pendingCount(), 1, '回合结束后应该有一条待发提醒')

  advance(4 * MIN)
  notifier.tick()
  await notifier.flush()
  assert.equal(await listOutbox(dir).then(r => r.length), 0, '还没到 5 分钟，不该发')

  advance(MIN)
  notifier.tick()
  await notifier.flush()

  const files = await listOutbox(dir)
  assert.equal(files.filter(f => f.endsWith('.eml')).length, 1)
  assert.equal(files.filter(f => f.endsWith('.txt')).length, 1)

  const delivered = notifier.deliveries.filter(d => d.result)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0].mail.subject, /5\.0 分钟无人应答/)
  assert.match(delivered[0].mail.text, /2 次工具调用/)
  assert.equal(notifier.stats.delivered, 1)
})

test('你 2 分钟就回来了 → 不发', async () => {
  const dir = await tempDir()
  const { notifier, advance } = setup({ outboxDir: dir })

  runTurn(notifier)
  advance(2 * MIN)
  notifier.handleSessionEvent(SESSION, ev('user/message', {
    source: { kind: 'user' }, content: '我回来了，继续'
  }))

  assert.equal(notifier.scheduler.pendingCount(), 0, '用户消息应撤销待发提醒')
  assert.equal(notifier.stats.cancelled, 1)

  advance(60 * MIN)
  notifier.tick()
  await notifier.flush()

  assert.equal((await listOutbox(dir)).length, 0)
  assert.equal(notifier.stats.delivered, 0)
})

test('plugin/system 注入的用户角色消息不算「人回来了」', async () => {
  const dir = await tempDir()
  const { notifier, advance } = setup({ outboxDir: dir })

  runTurn(notifier)
  notifier.handleSessionEvent(SESSION, ev('user/message', { source: { kind: 'plugin' }, content: 'goal 续跑' }))
  assert.equal(notifier.scheduler.pendingCount(), 1, '系统注入不该撤销')

  advance(5 * MIN)
  notifier.tick()
  await notifier.flush()
  assert.equal(notifier.stats.delivered, 1)
})

test('连续多轮合并成一封，不是每轮一封', async () => {
  const dir = await tempDir()
  const { notifier, advance } = setup({ outboxDir: dir })

  runTurn(notifier, { turn: 1 })
  advance(4 * MIN)
  runTurn(notifier, { turn: 2 })

  advance(5 * MIN)
  notifier.tick()
  await notifier.flush()

  assert.equal(notifier.stats.delivered, 1, '两轮只发一封')
  const entry = notifier.deliveries.find(d => d.result)
  assert.match(entry.mail.text, /2 轮 · 4 次工具调用/)
})

test('回合进行中不发（busy 门），回合真正结束后才发', async () => {
  const dir = await tempDir()
  const { notifier, advance } = setup({ outboxDir: dir })

  runTurn(notifier, { turn: 1 })
  // 后台任务结束唤醒 agent，开了新回合 —— 活还没干完
  notifier.handleSessionEvent(SESSION, ev('turn/start', { turn: 2 }))
  assert.equal(notifier.stats.paused, 1)

  advance(30 * MIN)
  notifier.tick()
  await notifier.flush()
  assert.equal(notifier.stats.delivered, 0, 'busy 期间绝不能发')

  // 这一轮也结束了
  notifier.handleSessionEvent(SESSION, ev('tool/call', { turn: 2, name: 'bash' }))
  notifier.handleSessionEvent(SESSION, ev('turn/end', { turn: 2, reason: 'completed' }))

  advance(5 * MIN)
  notifier.tick()
  await notifier.flush()

  assert.equal(notifier.stats.delivered, 1)
  assert.match(notifier.deliveries.find(d => d.result).mail.text, /2 轮/)
})

test('空转回合被抑制，不吵人', async () => {
  const dir = await tempDir()
  const { notifier, advance } = setup({ outboxDir: dir })

  // 只有 turn/end，没有任何工具调用与回复
  notifier.handleSessionEvent(SESSION, ev('turn/end', { turn: 1, reason: 'completed' }))
  advance(5 * MIN)
  notifier.tick()
  await notifier.flush()

  assert.equal(notifier.stats.suppressed, 1)
  assert.equal(notifier.deliveries[0].suppressed, 'empty-burst')
  assert.equal((await listOutbox(dir)).length, 0)
})

test('minToolCalls 生效', async () => {
  const dir = await tempDir()
  const { notifier, advance } = setup({ outboxDir: dir, minToolCalls: 5, suppressEmptyTurns: false })

  runTurn(notifier, { toolCalls: 2 })
  advance(5 * MIN)
  notifier.tick()
  await notifier.flush()

  assert.equal(notifier.stats.suppressed, 1)
  assert.equal(notifier.deliveries[0].suppressed, 'below-min-tool-calls')
})

test('投递失败只记错误，不抛给调用方', async () => {
  const dir = await tempDir()
  let clock = T0
  const { config } = normalizeConfig({ dwellMinutes: 5, transport: 'outbox', outboxDir: dir })
  const notifier = createNotifier({
    config,
    now: () => clock,
    log: () => {},
    deliver: async () => { throw new Error('SMTP 挂了') }
  })

  runTurn(notifier)
  clock += 5 * MIN
  notifier.tick()
  await notifier.flush()

  assert.equal(notifier.stats.failed, 1)
  assert.equal(notifier.stats.delivered, 0)
  assert.match(notifier.deliveries[0].error.message, /SMTP 挂了/)
})

// ─────────────────── cordis 入口 ───────────────────

function fakeCtx () {
  const handlers = new Map()
  return {
    handlers,
    on (type, fn) { handlers.set(type, fn); return () => handlers.delete(type) },
    effect (fn) { return fn() },
    logger: { info () {}, warn () {}, error () {} }
  }
}

test('apply() 挂到 ctx.on，并能通过 dispose 卸载', async () => {
  const dir = await tempDir()
  const ctx = fakeCtx()
  const instance = apply(ctx, {
    enabled: true,
    tickSeconds: 3600, // 避免真实定时器干扰
    transport: 'outbox',
    outboxDir: dir
  })

  assert.ok(ctx.handlers.has('session/event'), '应该订阅了 session/event')
  assert.ok(instance.notifier)

  runTurn(instance.notifier)
  assert.equal(instance.notifier.scheduler.pendingCount(), 1)

  instance.dispose()
  assert.equal(ctx.handlers.has('session/event'), false, 'dispose 后应取消订阅')
})

test('ctx.on 不可用时只告警，不抛错', () => {
  assert.doesNotThrow(() => {
    const instance = apply({ logger: { info () {}, warn () {}, error () {} } }, { enabled: true, tickSeconds: 3600 })
    instance.dispose()
  })
})

test('enabled=false 时完全不监听', () => {
  const ctx = fakeCtx()
  const instance = apply(ctx, { enabled: false })
  assert.equal(ctx.handlers.size, 0)
  assert.equal(instance.notifier, null)
})
