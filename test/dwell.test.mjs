// 延迟状态机：本插件唯一真正新的一层，必须逐条钉死。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDwellScheduler } from '../src/dwell.mjs'

const MIN = 60_000
const T0 = Date.parse('2026-09-28T09:00:00Z')

function make (opts = {}) {
  const fired = []
  const scheduler = createDwellScheduler({
    dwellMs: 5 * MIN,
    maxDwellMs: 30 * MIN,
    onFire: n => fired.push(n),
    ...opts
  })
  return { scheduler, fired }
}

test('干完活之后安静满 dwellMs 才发出，之前不发', () => {
  const { scheduler, fired } = make()
  scheduler.noteTurnEnd('s1', { turn: 1 }, T0)

  assert.equal(scheduler.pendingCount(), 1)
  assert.equal(scheduler.deadlineOf('s1'), T0 + 5 * MIN)

  scheduler.tick(T0 + 5 * MIN - 1)
  assert.equal(fired.length, 0, '差 1ms 也不该发')

  scheduler.tick(T0 + 5 * MIN)
  assert.equal(fired.length, 1)
  assert.equal(fired[0].turns, 1)
  assert.equal(fired[0].waitedMs, 5 * MIN)
  assert.equal(scheduler.pendingCount(), 0, '发过之后不能重复发')
})

test('用户回来了就撤销待发提醒', () => {
  const { scheduler, fired } = make()
  scheduler.noteTurnEnd('s1', { turn: 1 }, T0)
  const cancelled = scheduler.noteUserActivity('s1', T0 + 2 * MIN, 'user-message:user')

  assert.equal(cancelled.type, 'cancelled')
  assert.equal(scheduler.pendingCount(), 0)

  scheduler.tick(T0 + 60 * MIN)
  assert.equal(fired.length, 0, '撤销后永远不该再发')
})

test('没有待发提醒时，用户活动是空操作', () => {
  const { scheduler } = make()
  assert.equal(scheduler.noteUserActivity('nobody', T0), null)
  assert.equal(scheduler.pendingCount(), 0)
})

test('连续回合合并成一封，且以最后一次安静起点重新计时', () => {
  const { scheduler, fired } = make()
  scheduler.noteTurnEnd('s1', { turn: 1 }, T0)
  scheduler.noteTurnEnd('s1', { turn: 2 }, T0 + 3 * MIN)

  assert.equal(scheduler.pendingCount(), 1, '同一会话只留一条待发')
  assert.equal(scheduler.deadlineOf('s1'), T0 + 3 * MIN + 5 * MIN, 'deadline 从最后一次 turn/end 起算')

  scheduler.tick(T0 + 3 * MIN + 5 * MIN)
  assert.equal(fired.length, 1, '合并后只发一封，不是每轮一封')
  assert.equal(fired[0].turns, 2)
  assert.equal(fired[0].payloads.length, 2)
  assert.equal(fired[0].burstMs, 8 * MIN)
})

test('busy 门：回合进行中不发，即使已经过点', () => {
  const { scheduler, fired } = make()
  scheduler.noteTurnEnd('s1', { turn: 1 }, T0)
  scheduler.noteTurnStart('s1', T0 + MIN)

  assert.equal(scheduler.isBusy('s1'), true)
  scheduler.tick(T0 + 20 * MIN)
  assert.equal(fired.length, 0, 'busy 期间绝不该发「任务已结束」')
  assert.equal(scheduler.pendingCount(), 1, '挂起不等于取消')

  scheduler.noteTurnEnd('s1', { turn: 2 }, T0 + 20 * MIN)
  assert.equal(scheduler.isBusy('s1'), false)
  scheduler.tick(T0 + 25 * MIN)
  assert.equal(fired.length, 1)
  assert.equal(fired[0].turns, 2)
})

test('maxDwellMs 上限：提醒不能被无限推迟', () => {
  const { scheduler, fired } = make()
  scheduler.noteTurnEnd('s1', { turn: 1 }, T0)
  // 之后每 4 分钟续一轮，dwell 5 分钟 —— 若不设上限，永远不会到点
  for (let i = 2; i <= 10; i++) scheduler.noteTurnEnd('s1', { turn: i }, T0 + (i - 1) * 4 * MIN)

  assert.equal(scheduler.deadlineOf('s1'), T0 + 30 * MIN, '被 maxDwellMs 钉在首个回合结束 + 30 分钟')

  scheduler.tick(T0 + 30 * MIN)
  assert.equal(fired.length, 1)
  assert.equal(fired[0].turns, 10, '整批合并成一封')
})

test('多会话互不干扰', () => {
  const { scheduler, fired } = make()
  scheduler.noteTurnEnd('s1', { turn: 1 }, T0)
  scheduler.noteTurnEnd('s2', { turn: 1 }, T0 + 2 * MIN)

  scheduler.noteUserActivity('s1', T0 + MIN, 'user')
  scheduler.tick(T0 + 7 * MIN)

  assert.equal(fired.length, 1)
  assert.equal(fired[0].key, 's2', '只有没被撤销的那个会话发')
})

test('onFire 抛错不会中断其它提醒', () => {
  const boom = []
  let first = true
  const scheduler = createDwellScheduler({
    dwellMs: MIN,
    onFire: n => {
      if (first) { first = false; throw new Error('boom') }
      boom.push(n.key)
    }
  })
  scheduler.noteTurnEnd('a', {}, T0)
  scheduler.noteTurnEnd('b', {}, T0)
  const fired = scheduler.tick(T0 + MIN)

  assert.equal(fired.length, 2, '两个都应该被判定为到点')
  assert.deepEqual(boom, ['b'], '第二个仍然执行')
  assert.ok(scheduler.trace.some(r => r.type === 'fire-error'))
})

test('非法 dwellMs 直接报错，而不是静默变成 0', () => {
  assert.throws(() => createDwellScheduler({ dwellMs: -1 }), TypeError)
  assert.throws(() => createDwellScheduler({ dwellMs: NaN }), TypeError)
})
