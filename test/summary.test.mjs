// 事件折叠 + 摘要渲染 + 抑制规则。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createTurnAggregator,
  extractAssistantText,
  isToolFailure,
  isEmptyBurst,
  renderNotification,
  suppressionReason
} from '../src/summary.mjs'
import { normalizeConfig } from '../src/config.mjs'

const T0 = Date.parse('2026-09-28T09:00:00Z')

function feed (agg, sessionId, events) {
  for (const event of events) agg.note(sessionId, { id: sessionId, name: '会话名' }, event)
}

test('折叠器统计工具调用与失败次数', () => {
  const agg = createTurnAggregator()
  feed(agg, 's1', [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { turn: 1, name: 'bash' } },
    { type: 'tool/result', data: { turn: 1, ok: true } },
    { type: 'tool/call', data: { turn: 1, name: 'read_file' } },
    { type: 'tool/result', data: { turn: 1, ok: false } }
  ])
  const record = agg.finalize('s1', 1, 'completed', T0)

  assert.equal(record.toolCalls, 2)
  assert.equal(record.toolFailures, 1)
  assert.deepEqual(record.toolNames, ['bash', 'read_file'])
})

test('折叠器取到最后一段助手回复与模型名', () => {
  const agg = createTurnAggregator()
  feed(agg, 's1', [
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '第一段' }], source: { model: 'deepseek-flash' } } } },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '最后一段' }], source: { model: 'deepseek-pro' } } } }
  ])
  const record = agg.finalize('s1', 1, 'completed', T0)

  assert.equal(record.lastText, '最后一段')
  assert.deepEqual(record.models, ['deepseek-flash', 'deepseek-pro'])
})

test('会话标题来自 session/title 事件，并带进记录', () => {
  const agg = createTurnAggregator()
  feed(agg, 's1', [
    { type: 'session/title', data: { title: '修复登录接口超时' } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { turn: 1, name: 'bash' } }
  ])
  const record = agg.finalize('s1', 1, 'completed', T0)

  assert.equal(record.sessionTitle, '修复登录接口超时')
})

test('没有在途回合时 finalize 返回 null（由接线层决定怎么兜底）', () => {
  const agg = createTurnAggregator()
  assert.equal(agg.finalize('s1', 1, 'completed', T0), null)
})

test('抽文本时跳过 thinking / tool_use 分片', () => {
  const text = extractAssistantText({
    content: [
      { type: 'thinking', text: '内部推理不该外泄' },
      { type: 'text', text: '这是给用户看的' },
      { type: 'tool_use', name: 'bash' }
    ]
  })
  assert.equal(text, '这是给用户看的')
})

test('抽文本兼容 content 为裸字符串', () => {
  assert.equal(extractAssistantText({ content: ' 直接字符串 ' }), '直接字符串')
  assert.equal(extractAssistantText(null), '')
})

test('失败判定兼容多种字段名', () => {
  assert.equal(isToolFailure({ ok: false }), true)
  assert.equal(isToolFailure({ isError: true }), true)
  assert.equal(isToolFailure({ error: 'boom' }), true)
  assert.equal(isToolFailure({ status: 'failed' }), true)
  assert.equal(isToolFailure({ ok: true }), false)
  assert.equal(isToolFailure(null), false)
})

test('渲染：主题带静默分钟数与会话名，正文带规模与摘要', () => {
  const { config } = normalizeConfig({ dwellMinutes: 5 })
  const mail = renderNotification({
    key: 's1',
    payloads: [{
      sessionId: 's1',
      sessionTitle: '修复登录接口超时',
      turn: 1,
      reason: 'completed',
      toolCalls: 12,
      toolFailures: 1,
      toolNames: ['bash', 'read_file'],
      models: ['deepseek-flash'],
      lastText: '已定位到连接池配置问题，并补了超时重试。'
    }],
    turns: 1,
    firstTurnEndAt: T0,
    lastTurnEndAt: T0,
    firedAt: T0 + 5 * 60000,
    waitedMs: 5 * 60000,
    burstMs: 5 * 60000
  }, config)

  assert.match(mail.subject, /^\[DSH\] 任务已结束，5\.0 分钟无人应答 · 修复登录接口超时$/)
  assert.match(mail.text, /12 次工具调用（1 次失败）/)
  assert.match(mail.text, /静默时长：5\.0 分钟/)
  assert.match(mail.text, /已定位到连接池配置问题/)
  assert.equal(mail.meta.failures, 1)
})

test('渲染：非 clean 完成会在正文里标出来', () => {
  const { config } = normalizeConfig({})
  const mail = renderNotification({
    key: 's1',
    payloads: [{ sessionId: 's1', sessionTitle: 'x', turn: 1, reason: 'error', toolCalls: 3, toolFailures: 3, toolNames: [], models: [], lastText: '' }],
    turns: 1,
    firstTurnEndAt: T0,
    lastTurnEndAt: T0,
    firedAt: T0 + 60000,
    waitedMs: 60000,
    burstMs: 60000
  }, config)

  assert.match(mail.text, /非正常完成/)
  assert.match(mail.text, /error/)
})

test('渲染：摘要按 excerptChars 截断', () => {
  const { config } = normalizeConfig({ excerptChars: 10 })
  const mail = renderNotification({
    key: 's1',
    payloads: [{ sessionId: 's1', turn: 1, reason: 'completed', toolCalls: 1, toolFailures: 0, toolNames: [], models: [], lastText: 'A'.repeat(100) }],
    turns: 1,
    firstTurnEndAt: T0,
    lastTurnEndAt: T0,
    firedAt: T0,
    waitedMs: 0,
    burstMs: 0
  }, config)

  assert.match(mail.text, /AAAAAAAAAA…/)
})

test('抑制规则：空转批次不发', () => {
  const { config } = normalizeConfig({})
  const payloads = [{ toolCalls: 0, lastText: '' }]
  assert.equal(isEmptyBurst(payloads), true)
  assert.equal(suppressionReason({ payloads }, config), 'empty-burst')
})

test('抑制规则：低于 minToolCalls 不发', () => {
  const { config } = normalizeConfig({ minToolCalls: 5, suppressEmptyTurns: false })
  assert.equal(suppressionReason({ payloads: [{ toolCalls: 2, lastText: 'x' }] }, config), 'below-min-tool-calls')
  assert.equal(suppressionReason({ payloads: [{ toolCalls: 5, lastText: 'x' }] }, config), null)
})

test('抑制规则：有回复文本但没工具调用，默认照发', () => {
  const { config } = normalizeConfig({})
  assert.equal(suppressionReason({ payloads: [{ toolCalls: 0, lastText: '普通一问一答' }] }, config), null)
})
