// 事件折叠 + 摘要渲染。
//
// 两个职责：
//   ① createTurnAggregator —— 把 session/event 流折叠成「每个回合一条记录」
//   ② renderNotification  —— 把一批回合记录渲染成一封邮件（主题 + 正文）
//
// 事件形状来自 DSH 的持久 session/event firehose。字段位置在不同 DSH 版本上
// 有差异，所以每个取值都做了兜底，读不到就降级，绝不抛错（抛错会污染 agent 循环）。

const MAX_EXCERPT = 4000

function str (value) {
  return typeof value === 'string' ? value : ''
}

/** 从 assistant 消息里抽出纯文本。content 可能是字符串，也可能是分片数组。 */
export function extractAssistantText (message) {
  const content = message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') { parts.push(part); continue }
    if (!part || typeof part !== 'object') continue
    // 只收文本分片：thinking / tool_use 等分片不算「回复摘要」
    if (part.type && part.type !== 'text') continue
    const t = str(part.text) || str(part.content)
    if (t) parts.push(t)
  }
  return parts.join('\n').trim()
}

/** 判定一次 tool/result 是否失败。
 *
 * 真实形状（已用本机会话日志核对，110 条 tool/result）：
 *   data = { turn, step, message: { role:'tool', source, toolCallId, content, isError, id }, meta }
 * **失败标记在 `data.message.isError`**，不在顶层。顶层只有在抛出带类型的错误时
 * 才额外带一个 `error: { name, code }` 对象——所以只查顶层会漏掉一部分失败。
 * 其余字段名保留为跨版本兜底。 */
export function isToolFailure (data) {
  if (!data || typeof data !== 'object') return false
  if (data.message?.isError === true) return true
  if (data.isError === true) return true
  if (data.error) return true
  if (data.ok === false) return true
  if (data.success === false) return true
  if (data.is_error === true) return true
  const status = str(data.status)
  if (status && /^(error|failed|failure)$/i.test(status)) return true
  return false
}

/**
 * 归一化 turn/end 的 reason。
 *
 * 真实形状是**对象**不是字符串：`data.reason = { kind: 'completed' }`。
 * 直接 String() 会得到 "[object Object]" —— 那样每封邮件的「结束原因」都是错的，
 * 而且会被判成非正常完成、给每封信都挂上「建议看一眼」。这是本插件最容易踩的坑。
 */
export function normalizeReason (value) {
  if (value == null) return 'unknown'
  if (typeof value === 'string') return value.trim() || 'unknown'
  if (typeof value === 'object' && !Array.isArray(value)) {
    return str(value.kind).trim()
      || str(value.reason).trim()
      || str(value.type).trim()
      || 'unknown'
  }
  return String(value)
}

function blankTurn (sessionId, turn) {
  return {
    sessionId,
    sessionTitle: '',
    turn,
    reason: '',
    toolCalls: 0,
    toolFailures: 0,
    toolNames: [],
    models: [],
    lastText: '',
    durationMs: null,
    endedAt: null,
    tokens: { input: 0, output: 0, total: 0 }
  }
}

/**
 * 会话事件 → 回合记录。
 *
 * 用法：note(sid, session, event) 折叠事件；finalize(sid, turn, reason, at) 收口一个回合。
 */
export function createTurnAggregator () {
  const current = new Map() // sessionId -> 进行中的回合
  const titles = new Map() // sessionId -> 最近一次会话标题

  function ensure (sessionId, turn) {
    const existing = current.get(sessionId)
    const n = Number.isFinite(turn) ? turn : (existing?.turn ?? null)
    if (existing && (n === null || existing.turn === n)) return existing
    const fresh = blankTurn(sessionId, n)
    fresh.sessionTitle = titles.get(sessionId) || ''
    current.set(sessionId, fresh)
    return fresh
  }

  function noteTitle (sessionId, title) {
    const t = str(title).trim()
    if (!t) return
    titles.set(sessionId, t.slice(0, 160))
    const existing = current.get(sessionId)
    if (existing) existing.sessionTitle = titles.get(sessionId)
  }

  function note (sessionId, session, event) {
    const type = str(event?.type)
    if (!type) return
    const data = event?.data && typeof event.data === 'object' ? event.data : {}
    const turn = Number(data.turn)

    if (type === 'session/title') { noteTitle(sessionId, data.title); return }

    // 会话对象上的标题字段（不同版本可能没有），作为兜底来源
    if (!titles.has(sessionId)) {
      const fromSession = str(session?.name) || str(session?.title) || ''
      if (fromSession.trim()) titles.set(sessionId, fromSession.trim().slice(0, 160))
    }

    if (type === 'turn/start') { current.set(sessionId, blankTurn(sessionId, Number.isFinite(turn) ? turn : null)); current.get(sessionId).sessionTitle = titles.get(sessionId) || ''; return }

    if (type === 'assistant/message') {
      const agg = ensure(sessionId, turn)
      const text = extractAssistantText(data.message)
      if (text) agg.lastText = text.slice(-MAX_EXCERPT)
      const model = str(data.message?.source?.model)
      if (model && !agg.models.includes(model)) agg.models.push(model)
      // 真实的 usage 键名：inputTokens / outputTokens / cacheReadTokens /
      // cacheWriteTokens / totalTokens（本机会话日志已核对）
      const usage = data.usage
      if (usage && typeof usage === 'object') {
        const input = Number(usage.inputTokens) || 0
        const output = Number(usage.outputTokens) || 0
        const total = Number(usage.totalTokens) || (input + output)
        agg.tokens.input += input
        agg.tokens.output += output
        agg.tokens.total += total
      }
      return
    }

    if (type === 'tool/call') {
      const agg = ensure(sessionId, turn)
      agg.toolCalls += 1
      const toolName = str(data.name) || str(data.toolName) || str(data.tool)
      if (toolName && !agg.toolNames.includes(toolName)) agg.toolNames.push(toolName)
      return
    }

    if (type === 'tool/result') {
      const agg = ensure(sessionId, turn)
      if (isToolFailure(data)) agg.toolFailures += 1
      return
    }
  }

  /**
   * 收口一个回合，产出可交给延迟状态机的记录。
   * 没有实际内容的回合返回 null（调用方据此跳过排定）。
   */
  function finalize (sessionId, turn, reason, at) {
    const existing = current.get(sessionId)
    const agg = existing && (existing.turn === turn || !Number.isFinite(turn))
      ? existing
      : null
    if (!agg) return null
    current.delete(sessionId)
    return {
      ...agg,
      sessionTitle: agg.sessionTitle || titles.get(sessionId) || '',
      reason: normalizeReason(reason),
      endedAt: at
    }
  }

  /** 只读快照，供调试/测试。 */
  function inspect (sessionId) {
    return current.get(sessionId) ? { ...current.get(sessionId) } : null
  }

  return { note, finalize, inspect, titleOf: sid => titles.get(sid) || '' }
}

/** 这批回合是否「空转」——没有任何工具调用也没有任何回复文本。 */
export function isEmptyBurst (payloads) {
  return payloads.every(p => p.toolCalls === 0 && !str(p.lastText).trim())
}

/**
 * 该不该发。返回 null 表示要发；返回字符串表示静默原因。
 * 这层单独抽出来，是为了让「什么时候不吵你」也能被测试断言。
 */
export function suppressionReason (notification, config) {
  if (config.suppressEmptyTurns && isEmptyBurst(notification.payloads)) {
    return 'empty-burst'
  }
  const toolCalls = notification.payloads.reduce((sum, p) => sum + p.toolCalls, 0)
  if (toolCalls < config.minToolCalls) {
    return 'below-min-tool-calls'
  }
  return null
}

function minutes (ms) {
  return (ms / 60000).toFixed(1)
}

function fmtTime (ms) {
  if (!Number.isFinite(ms)) return '-'
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')
}

function clip (text, limit) {
  const t = str(text).trim()
  if (!t) return ''
  if (!limit || t.length <= limit) return t
  return `${t.slice(0, limit)}…`
}

/**
 * 一批回合 → 一封邮件。
 * @returns {{subject: string, text: string, meta: object}}
 */
export function renderNotification (notification, config) {
  const zh = config.mail.language !== 'en'
  const prefix = config.mail.subjectPrefix
  const turns = notification.payloads
  const toolCalls = turns.reduce((s, t) => s + t.toolCalls, 0)
  const failures = turns.reduce((s, t) => s + t.toolFailures, 0)
  const tokens = turns.reduce((acc, t) => {
    const tk = t.tokens || {}
    acc.input += Number(tk.input) || 0
    acc.output += Number(tk.output) || 0
    acc.total += Number(tk.total) || 0
    return acc
  }, { input: 0, output: 0, total: 0 })
  const n = v => v.toLocaleString('en-US')
  const reasons = [...new Set(turns.map(t => t.reason).filter(Boolean))]
  const models = [...new Set(turns.flatMap(t => t.models || []))]
  const toolNames = [...new Set(turns.flatMap(t => t.toolNames || []))]
  const lastWithText = [...turns].reverse().find(t => str(t.lastText).trim())
  const title = turns.find(t => str(t.sessionTitle).trim())?.sessionTitle
    || lastWithText?.sessionTitle
    || turns[0]?.sessionId
    || 'default'
  const waited = minutes(notification.waitedMs)
  const burst = minutes(notification.burstMs)
  const allCompleted = reasons.length === 1 && reasons[0] === 'completed'
  const excerpt = clip(lastWithText?.lastText, config.mail.excerptChars)

  const subject = zh
    ? `${prefix} 任务已结束，${waited} 分钟无人应答 · ${title}`
    : `${prefix} Finished — no reply for ${waited} min · ${title}`

  const lines = zh ? [
    `会话：${title}`,
    `会话 ID：${turns[0]?.sessionId ?? '-'}`,
    `结束原因：${reasons.join(' / ') || 'unknown'}${allCompleted ? '' : '（非正常完成，建议看一眼）'}`,
    `规模：${turns.length} 轮 · ${toolCalls} 次工具调用${failures ? `（${failures} 次失败）` : ''}`,
    `静默时长：${waited} 分钟（自最后一次回合结束起）`,
    `整批跨度：${burst} 分钟`,
    `首个回合结束：${fmtTime(notification.firstTurnEndAt)}`,
    `发出提醒：${fmtTime(notification.firedAt)}`
  ] : [
    `Session: ${title}`,
    `Session ID: ${turns[0]?.sessionId ?? '-'}`,
    `Reason: ${reasons.join(' / ') || 'unknown'}${allCompleted ? '' : ' (not a clean completion)'}`,
    `Scale: ${turns.length} turn(s) · ${toolCalls} tool call(s)${failures ? ` (${failures} failed)` : ''}`,
    `Quiet for: ${waited} min (since the last turn ended)`,
    `Burst span: ${burst} min`,
    `First turn ended: ${fmtTime(notification.firstTurnEndAt)}`,
    `Notified at: ${fmtTime(notification.firedAt)}`
  ]

  if (tokens.total > 0) {
    lines.push(zh
      ? `消耗：${n(tokens.total)} tokens（输入 ${n(tokens.input)} / 输出 ${n(tokens.output)}）`
      : `Usage: ${n(tokens.total)} tokens (in ${n(tokens.input)} / out ${n(tokens.output)})`)
  }
  if (toolNames.length) lines.push(zh ? `用到的工具：${toolNames.join(', ')}` : `Tools: ${toolNames.join(', ')}`)
  if (models.length) lines.push(zh ? `模型：${models.join(', ')}` : `Models: ${models.join(', ')}`)

  if (excerpt) {
    lines.push('', zh ? '最后一段回复：' : 'Last assistant message:', excerpt)
  }

  lines.push(
    '',
    zh
      ? `—— 这条提醒的规则：回合结束后安静满 ${config.dwellMinutes} 分钟且期间你没有回过话，才会发出；`
        + '你若在此期间回到会话，它会被撤销。'
      : `—— Rule: fires only after ${config.dwellMinutes} min of quiet with no activity from you; `
        + 'if you come back to the session in that window, it is cancelled.'
  )

  return {
    subject,
    text: lines.join('\n'),
    meta: {
      turns: turns.length,
      toolCalls,
      failures,
      reasons,
      tokens,
      waitedMs: notification.waitedMs,
      burstMs: notification.burstMs,
      sessionTitle: title
    }
  }
}
