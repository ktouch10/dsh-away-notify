// 静默延迟状态机 —— 本插件唯一真正新的一层。
//
// 现有 DSH 通知插件都在 `turn/end` 上直接发。这里把「发不发」拆成两个条件：
//   ① 活真的干完了（turn/end 且当前没有进行中的回合）
//   ② 干完之后又安静了 dwellMs，期间没有任何「用户回来了」的信号
//
// 设计要点：
//   * **完全确定性**：不持有任何真实定时器，也不读时钟。调用方显式传 `at`，
//     并用 `tick(now)` 推进。所以整个决策层可以在测试里用虚拟时钟精确断言。
//   * **burst 合并**：同一会话反复续跑时不是每轮发一封，而是合并成一条，
//     直到真正安静下来才发（"agent 跑了 6 轮/20 分钟 → 一封邮件"）。
//   * **busy 门**：`turn/start` 会把待发提醒挂起。目标续跑、后台任务唤醒 agent
//     都会开新回合，此时不该发「任务已结束」。
//   * **上限**：`maxDwellMs` 从首个 turn/end 起算，防止提醒被无限推迟。

export function createDwellScheduler ({ dwellMs, maxDwellMs = Number.POSITIVE_INFINITY, onFire = () => {} }) {
  if (!Number.isFinite(dwellMs) || dwellMs < 0) throw new TypeError('dwellMs 必须是非负有限数')
  const pending = new Map() // key -> entry
  const trace = [] // 决策轨迹，便于测试与线上排查

  function record (type, key, at, extra = {}) {
    const row = { type, key, at, ...extra }
    trace.push(row)
    return row
  }

  function scheduleDeadline (entry, at) {
    // 从最后一次「安静起点」算 dwellMs，但整批不得超过首个 turn/end + maxDwellMs。
    const byDwell = at + dwellMs
    const byCap = entry.firstTurnEndAt + maxDwellMs
    entry.deadline = Math.min(byDwell, byCap)
    return entry.deadline
  }

  /**
   * 一个回合结束了。
   * @param {string} key       会话键
   * @param {object} payload   该回合的摘要记录（本模块把它当不透明数据）
   * @param {number} at        时间戳（ms）
   */
  function noteTurnEnd (key, payload, at) {
    const existing = pending.get(key)
    if (existing) {
      existing.payloads.push(payload)
      existing.lastTurnEndAt = at
      existing.busy = false
      const deadline = scheduleDeadline(existing, at)
      return record('coalesced', key, at, { turns: existing.payloads.length, deadline })
    }
    const entry = {
      key,
      payloads: [payload],
      firstTurnEndAt: at,
      lastTurnEndAt: at,
      busy: false,
      deadline: 0
    }
    pending.set(key, entry)
    const deadline = scheduleDeadline(entry, at)
    return record('scheduled', key, at, { deadline })
  }

  /**
   * 该会话开了一个新回合 —— 说明活还没干完，挂起待发提醒。
   * 注意：这**不是**「用户回来了」信号，只做挂起，不撤销。
   */
  function noteTurnStart (key, at) {
    const entry = pending.get(key)
    if (!entry) return null
    entry.busy = true
    return record('paused', key, at, { turns: entry.payloads.length })
  }

  /**
   * 用户真的回来了 —— 撤销待发提醒。
   * 调用方必须只在拿到可靠信号时调用（例如 user/message 且 source.kind === 'user'）。
   */
  function noteUserActivity (key, at, reason = 'user') {
    const entry = pending.get(key)
    if (!entry) return null
    pending.delete(key)
    return record('cancelled', key, at, { reason, turns: entry.payloads.length })
  }

  /**
   * 推进时钟，触发所有到点且不忙的提醒。
   * @returns {Array<object>} 本次真正发出的提醒（按 deadline 升序）
   */
  function tick (at) {
    const due = [...pending.values()]
      .filter(entry => !entry.busy && entry.deadline <= at)
      .sort((a, b) => a.deadline - b.deadline)

    const fired = []
    for (const entry of due) {
      pending.delete(entry.key)
      const notification = {
        key: entry.key,
        payloads: entry.payloads,
        turns: entry.payloads.length,
        firstTurnEndAt: entry.firstTurnEndAt,
        lastTurnEndAt: entry.lastTurnEndAt,
        firedAt: at,
        // 「你离开多久了」：从最后一次安静起点算
        waitedMs: at - entry.lastTurnEndAt,
        // 整批工作跨了多久
        burstMs: at - entry.firstTurnEndAt
      }
      record('fired', entry.key, at, { turns: notification.turns, waitedMs: notification.waitedMs })
      fired.push(notification)
      try {
        onFire(notification)
      } catch (error) {
        record('fire-error', entry.key, at, { message: String(error?.message ?? error) })
      }
    }
    return fired
  }

  return {
    noteTurnEnd,
    noteTurnStart,
    noteUserActivity,
    tick,
    pendingCount: () => pending.size,
    has: key => pending.has(key),
    deadlineOf: key => (pending.has(key) ? pending.get(key).deadline : null),
    isBusy: key => Boolean(pending.get(key)?.busy),
    trace
  }
}
