// 真实契约回归测试。
//
// 这个文件存在的理由：本插件的事件折叠逻辑是照着 session/event 的契约写的，而那份
// 契约没有官方文档，是靠读别人插件的 README 推出来的。用本机真实会话日志核对之后，
// 抓到了两个会让插件"看起来正常、实际全错"的 bug。下面每条断言都钉住一个真实形状，
// 防止回退。
//
//   bug 1（致命）：turn/end 的 reason 是对象 { kind }，不是字符串。
//                  String() 会得到 "[object Object]" ⇒ 每封邮件原因错 + 全被判成非正常完成。
//   bug 2：tool/result 的失败标记在 message.isError，不在顶层。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNotifier } from '../src/index.mjs'
import { normalizeConfig } from '../src/config.mjs'
import {
  createTurnAggregator,
  isToolFailure,
  normalizeReason
} from '../src/summary.mjs'
import * as real from './fixtures/real-events.mjs'

const TEST_TMP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-tmp')
const SESSION = { id: 's-real' }

async function tempDir () {
  const dir = path.join(TEST_TMP, `real-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function makeNotifier (outboxDir, overrides = {}) {
  const { config } = normalizeConfig({
    dwellMinutes: 60, // 默认别在断言过程中真的到点
    transport: 'outbox',
    outboxDir,
    ...overrides
  })
  return createNotifier({ config, log: () => {} })
}

// ─────────────────── bug 1：reason 是对象 ───────────────────

test('真实 turn/end.data.reason 是对象，normalizeReason 必须取出 kind', () => {
  assert.deepEqual(real.TURN_END_COMPLETED.data.reason, { kind: 'completed' })
  assert.equal(normalizeReason(real.TURN_END_COMPLETED.data.reason), 'completed')
  assert.equal(normalizeReason(real.TURN_END_ERROR.data.reason), 'error')
  // 跨版本兜底
  assert.equal(normalizeReason('aborted'), 'aborted')
  assert.equal(normalizeReason({ reason: 'blocked' }), 'blocked')
  assert.equal(normalizeReason(null), 'unknown')
  assert.equal(normalizeReason(''), 'unknown')
  // 绝不能出现字符串化的对象
  assert.notEqual(normalizeReason(real.TURN_END_COMPLETED.data.reason), '[object Object]')
})

test('折叠真实回合：reason 归一化，不会污染成 [object Object]', () => {
  const agg = createTurnAggregator()
  agg.note(SESSION.id, SESSION, real.SESSION_TITLE)
  for (const event of real.FULL_TURN) agg.note(SESSION.id, SESSION, event)
  const record = agg.finalize(SESSION.id, 5, real.TURN_END_COMPLETED.data.reason, real.TURN_END_COMPLETED.time)

  assert.equal(record.reason, 'completed')
  assert.notEqual(record.reason, '[object Object]')
})

// ─────────────────── bug 2：失败标记位置 ───────────────────

test('tool/result 的失败标记在 message.isError —— 只有它的样本也要被判为失败', () => {
  assert.equal(real.TOOL_RESULT_ERROR.data.error, undefined, '这个样本顶层刻意没有 error')
  assert.equal(real.TOOL_RESULT_ERROR.data.message.isError, true)
  assert.equal(isToolFailure(real.TOOL_RESULT_ERROR.data), true, '靠 message.isError 识别')
  assert.equal(isToolFailure(real.TOOL_RESULT_OK.data), false)
  assert.equal(isToolFailure(real.TOOL_RESULT_ERROR_TYPED.data), true, '顶层带 error 的也要识别')

  // 回归：旧实现只查顶层，会漏掉样本 A
  assert.equal(real.TOOL_RESULT_ERROR.data.isError, undefined)
})

// ─────────────────── 真实回合的完整折叠 ───────────────────

test('真实回合：工具数、失败数、文本摘要、模型、token 全部正确', () => {
  const agg = createTurnAggregator()
  agg.note(SESSION.id, SESSION, real.SESSION_TITLE)
  for (const event of real.FULL_TURN) agg.note(SESSION.id, SESSION, event)
  const record = agg.finalize(SESSION.id, 5, real.TURN_END_COMPLETED.data.reason, real.TURN_END_COMPLETED.time)

  assert.equal(record.toolCalls, 3)
  assert.equal(record.toolFailures, 2, '两次失败都要数到（含只有 message.isError 的那次）')
  assert.deepEqual(record.toolNames, ['pwsh', 'web_fetch'])
  assert.deepEqual(record.models, ['deepseek-flash'])
  // 摘要只取 text 分片，不能把 reasoning 或 tool-call 混进来
  assert.equal(record.lastText, '示例回复：任务已完成，测试通过。')
  assert.ok(!record.lastText.includes('示例推理'))
  // 真实 usage 键名
  assert.deepEqual(record.tokens, { input: 490, output: 361, total: 20338 })
  assert.equal(record.sessionTitle, '示例会话标题')
})

// ─────────────────── 真实注入消息不得撤销提醒 ───────────────────

test('role=user 的系统注入消息不撤销待发提醒，只有真人消息才撤销', async () => {
  const notifier = makeNotifier(await tempDir())
  notifier.handleSessionEvent(SESSION, real.SESSION_TITLE)
  for (const event of real.FULL_TURN) notifier.handleSessionEvent(SESSION, event)

  assert.equal(notifier.scheduler.pendingCount(), 1, '回合结束后应有一条待发提醒')

  for (const injected of real.INJECTED_USER_MESSAGES) {
    const kind = injected.data.source.kind
    notifier.handleSessionEvent(SESSION, injected)
    assert.equal(
      notifier.scheduler.pendingCount(),
      1,
      `source.kind="${kind}" 是系统注入（role 同样是 user），绝不能当成「人回来了」`
    )
  }
  assert.equal(notifier.stats.cancelled, 0)

  notifier.handleSessionEvent(SESSION, real.USER_MESSAGE)
  assert.equal(notifier.scheduler.pendingCount(), 0, '真人消息才撤销')
  assert.equal(notifier.stats.cancelled, 1)
})

test('后台子代理落定不会撤销提醒（这是「合并」场景的前提）', async () => {
  const notifier = makeNotifier(await tempDir())
  for (const event of real.FULL_TURN) notifier.handleSessionEvent(SESSION, event)
  notifier.handleSessionEvent(SESSION, real.SUBAGENT_SETTLED)

  assert.equal(notifier.scheduler.pendingCount(), 1)
  const fired = notifier.scheduler.tick(real.TURN_END_COMPLETED.time + 61 * 60000)
  await notifier.flush()
  assert.equal(fired.length, 1, '子代理落定之后，提醒仍应照常发出')
  assert.match(notifier.deliveries[0].mail.text, /结束原因：completed/)
})

// ─────────────────── seq 去重 ───────────────────

test('同一事件重投（重连 / 回放）不会把同一轮算两次', async () => {
  const notifier = makeNotifier(await tempDir())
  notifier.handleSessionEvent(SESSION, real.TURN_END_COMPLETED)
  notifier.handleSessionEvent(SESSION, real.TURN_END_COMPLETED) // 重投同一条

  assert.equal(notifier.stats.duplicateEvents, 1)
  assert.equal(notifier.stats.scheduled, 1)

  const fired = notifier.scheduler.tick(real.TURN_END_COMPLETED.time + 61 * 60000)
  await notifier.flush()
  assert.equal(fired.length, 1)
  assert.equal(fired[0].turns, 1, '重投不该把轮数虚增成 2')
})

// ─────────────────── 用事件自己的 time ───────────────────

test('用事件的 time 定位「什么时候干完的」，而不是本地时钟', async () => {
  const notifier = makeNotifier(await tempDir())
  notifier.handleSessionEvent(SESSION, real.TURN_END_COMPLETED)

  const beforeDeadline = notifier.scheduler.tick(real.TURN_END_COMPLETED.time + 59 * 60000)
  assert.equal(beforeDeadline.length, 0)

  const fired = notifier.scheduler.tick(real.TURN_END_COMPLETED.time + 60 * 60000)
  await notifier.flush()
  assert.equal(fired.length, 1)
  assert.equal(fired[0].lastTurnEndAt, real.TURN_END_COMPLETED.time)
  assert.equal(fired[0].firstTurnEndAt, real.TURN_END_COMPLETED.time)
})

// ─────────────────── 邮件内容端到端 ───────────────────

test('用真实记录渲染的邮件：原因正确、不出现 [object Object]、带 token', async () => {
  const notifier = makeNotifier(await tempDir(), { dwellMinutes: 5 })
  notifier.handleSessionEvent(SESSION, real.SESSION_TITLE)
  for (const event of real.FULL_TURN) notifier.handleSessionEvent(SESSION, event)
  notifier.scheduler.tick(real.TURN_END_COMPLETED.time + 5 * 60000)
  await notifier.flush()

  const mail = notifier.deliveries[0].mail
  assert.ok(!mail.text.includes('[object Object]'), '绝不能出现字符串化的对象')
  assert.ok(!mail.text.includes('非正常完成'), 'completed 不该被判成非正常完成')
  assert.match(mail.text, /结束原因：completed/)
  assert.match(mail.text, /3 次工具调用（2 次失败）/)
  assert.match(mail.text, /消耗：20,338 tokens/)
  assert.match(mail.text, /示例回复：任务已完成/)
  assert.match(mail.subject, /5\.0 分钟无人应答/)
})

test('真实 error 结束的回合会被标出来', async () => {
  const notifier = makeNotifier(await tempDir())
  for (const event of real.FULL_TURN) notifier.handleSessionEvent(SESSION, event)
  notifier.handleSessionEvent(SESSION, real.TURN_END_ERROR)
  notifier.scheduler.tick(real.TURN_END_ERROR.time + 60 * 60000)
  await notifier.flush()

  const mail = notifier.deliveries[0].mail
  assert.match(mail.text, /结束原因：completed \/ error/)
  assert.match(mail.text, /非正常完成/)
})
