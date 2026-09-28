// dsh-away-notify —— 宿主半（cordis 插件）
//
// 分层：
//   dwell.mjs / summary.mjs  —— 纯决策层（不碰时钟、不碰 IO），可确定性测试
//   createNotifier()         —— 接线层：事件流 → 折叠器 → 延迟状态机 → 渲染 → 投递
//   apply()                  —— cordis 入口：读配置、订阅 ctx.on、跑真实定时器
//
// 把接线层单独暴露出来，是为了让测试和 demo 能注入虚拟时钟，
// 复用**同一条**链路，而不是各自再写一份（那样 demo 通过也证明不了插件是对的）。
//
// 铁律：本文件任何异常都必须吞掉。通知插件绝不能把 agent 循环搞挂。

import { normalizeConfig, DEFAULTS } from './config.mjs'
import { createDwellScheduler } from './dwell.mjs'
import { createTurnAggregator, renderNotification, suppressionReason, normalizeReason } from './summary.mjs'
import { deliver } from './transports.mjs'
import { NAMESPACE, Config, registerSettings } from './settings.mjs'

export const name = 'dsh-away-notify'

// DSH 读的是插件模块的 `Config` 导出（fiber.runtime.Config），
// 而条目 id 必须等于设置命名空间 —— 两者共同决定设置卡片能不能写。
export { Config }

function makeLogger (ctx) {
  const sink = ctx?.logger
  return (level, message) => {
    const line = `[dsh-away-notify] ${message}`
    try {
      if (sink && typeof sink[level] === 'function') sink[level](line)
      else if (level === 'error') console.error(line)
      else if (level === 'warn') console.warn(line)
      else console.log(line)
    } catch {
      // 日志失败不该影响任何事
    }
  }
}

function synthesizeRecord (agg, sessionId, turn, reason, at) {
  return {
    sessionId,
    sessionTitle: agg.titleOf(sessionId) || '',
    turn: Number.isFinite(turn) ? turn : null,
    reason: normalizeReason(reason),
    toolCalls: 0,
    toolFailures: 0,
    toolNames: [],
    models: [],
    lastText: '',
    durationMs: null,
    endedAt: at,
    tokens: { input: 0, output: 0, total: 0 },
    synthesized: true
  }
}

/**
 * 事件时间。
 *
 * 真实信封是 `{ type, seq, time, data, surfaceOp }`，`time` 是 epoch 毫秒。
 * 优先用它（比本地时钟准），缺了才回落到注入的 now()。
 */
function readEventTime (event, now) {
  const t = Number(event?.time)
  return Number.isFinite(t) && t > 0 ? t : now()
}

/**
 * 接线层。所有副作用都可注入，时钟可控。
 *
 * @param {object}   args
 * @param {object}   args.config        已归一化的配置（normalizeConfig().config）
 * @param {Function} args.deliver       投递实现，默认真实通道
 * @param {Function} args.log           (level, message) => void
 * @param {Function} args.now           () => number，默认 Date.now
 */
export function createNotifier ({
  config,
  deliver: deliverFn = deliver,
  log = () => {},
  now = () => Date.now()
}) {
  const stats = {
    turnEnds: 0,
    scheduled: 0,
    cancelled: 0,
    paused: 0,
    fired: 0,
    suppressed: 0,
    delivered: 0,
    failed: 0,
    duplicateEvents: 0
  }

  const agg = createTurnAggregator()
  const deliveries = [] // {notification, mail, result?, error?}
  const inflight = new Set()
  const lastSeq = new Map() // sessionId -> 已处理的最大 seq

  async function run (notification) {
    stats.fired += 1
    const entry = { notification, mail: null, result: null, error: null }
    deliveries.push(entry)

    const reason = suppressionReason(notification, config)
    if (reason) {
      stats.suppressed += 1
      entry.suppressed = reason
      log('info', `静默跳过（${reason}）：会话 ${notification.key}，${notification.turns} 轮`)
      return entry
    }

    entry.mail = renderNotification(notification, config)
    try {
      const result = await deliverFn(entry.mail, config)
      entry.result = result
      stats.delivered += 1
      const where = result?.eml || (result?.accepted ?? []).join(',') || result?.transport
      log('info', `已投递（${result?.transport}）→ ${where}`)
    } catch (error) {
      entry.error = error
      stats.failed += 1
      log('error', `投递失败：${error?.message ?? error}`)
    }
    return entry
  }

  function dispatch (notification) {
    const task = run(notification)
    inflight.add(task)
    task.then(() => inflight.delete(task), () => inflight.delete(task))
    return task
  }

  const scheduler = createDwellScheduler({
    dwellMs: config.dwellMinutes * 60000,
    maxDwellMs: config.maxDwellMinutes * 60000,
    // onFire 是同步回调；投递是异步的，所以只发起、不等待
    onFire: notification => { void dispatch(notification) }
  })

  function handleSessionEvent (session, event) {
    try {
      const sessionId = String(session?.id ?? 'default')
      const type = String(event?.type ?? '')
      if (!type) return

      // seq 去重。真实信封带单调递增的 seq；DSH 在重连 / 回放时会重投已投过的事件，
      // 不去重的话同一轮会被折进两次，邮件里的「N 轮」和工具次数就虚高。
      const seq = Number(event?.seq)
      if (Number.isFinite(seq)) {
        const last = lastSeq.get(sessionId)
        if (last !== undefined && seq <= last) {
          stats.duplicateEvents += 1
          return
        }
        lastSeq.set(sessionId, seq)
      }

      const at = readEventTime(event, now)
      agg.note(sessionId, session, event)

      if (type === 'turn/end') {
        stats.turnEnds += 1
        const data = event?.data && typeof event.data === 'object' ? event.data : {}
        const turn = Number(data.turn)
        const record = agg.finalize(sessionId, turn, data.reason, at)
          || synthesizeRecord(agg, sessionId, turn, data.reason, at)
        scheduler.noteTurnEnd(sessionId, record, at)
        stats.scheduled += 1
        return
      }

      if (type === 'turn/start') {
        if (config.cancelOnTurnStart) {
          // 显式开启时，才把「开新回合」也当成人在的信号（见 cordis.patch.yml 说明）
          if (scheduler.noteUserActivity(sessionId, at, 'turn-start')) stats.cancelled += 1
        } else if (scheduler.noteTurnStart(sessionId, at)) {
          // 默认语义：只挂起，不撤销 —— 活还没干完，不该发「任务已结束」
          stats.paused += 1
        }
        return
      }

      if (type === 'user/message') {
        // 只认真正的用户消息。
        //
        // 这一条是拿本机会话日志核对出来的：DSH 会往 user/message 里注入
        // **role 同样是 "user"** 的非人类消息，真实出现过的 kind 有：
        //   runtime-context   每回合注入的运行时快照
        //   skill-catalog     技能清单注入
        //   agent-message     子代理回传
        //   subagent-settled  后台子代理落定
        // 只按 role === 'user' 判断的话，这些每回合都会到，待发提醒会被系统行为
        // 一次次撤销 —— 插件看起来"正常"，其实永远不发信。
        const kind = String(event?.data?.source?.kind ?? '')
        const fromHuman = kind === '' || kind === 'user'
        if (config.cancelOnUserMessage && fromHuman) {
          if (scheduler.noteUserActivity(sessionId, at, `user-message:${kind || 'unknown'}`)) {
            stats.cancelled += 1
          }
        }
      }
    } catch (error) {
      log('error', `处理 session/event 失败：${error?.message ?? error}`)
    }
  }

  /** 推进时钟并触发到点的提醒。返回本次发出的提醒数组。 */
  function tick () {
    return scheduler.tick(now())
  }

  /** 等待所有在途投递结束（测试与 demo 用，避免轮询）。 */
  async function flush () {
    while (inflight.size) {
      await Promise.all([...inflight])
    }
    return deliveries
  }

  return { config, scheduler, stats, deliveries, handleSessionEvent, tick, dispatch, flush, aggregator: agg }
}

/**
 * cordis 入口。
 * @returns {object} 不是 cordis 契约的一部分，只为测试与运维提供抓手。
 */
export function apply (ctx, rawConfig = {}) {
  const { config, warnings } = normalizeConfig(rawConfig)
  const log = makeLogger(ctx)
  for (const warning of warnings) log('warn', warning)

  // 必须在 enabled 判断之前注册：否则用户把插件关掉之后，就再也没有 UI 入口把它打开了。
  // 注册失败只告警不抛错 —— 配置仍然可以从 cordis.patch.yml 读。
  registerSettings(ctx, { log })

  if (!config.enabled) {
    log('info', 'enabled=false，不监听任何事件')
    return { config, stats: null, notifier: null, dispose () {} }
  }

  const notifier = createNotifier({ config, log })

  const disposers = []
  if (typeof ctx?.on === 'function') {
    const disposer = ctx.on('session/event', notifier.handleSessionEvent)
    if (typeof disposer === 'function') disposers.push(disposer)
  } else {
    log('warn', 'ctx.on 不可用：插件已挂载但收不到事件')
  }

  // 定时器只负责「检查是否到点」，不决定提醒时机；决策全在 scheduler.tick 里。
  const timer = setInterval(() => {
    try {
      notifier.tick()
    } catch (error) {
      log('error', `tick 失败：${error?.message ?? error}`)
    }
  }, config.tickSeconds * 1000)
  timer.unref?.()

  function dispose () {
    clearInterval(timer)
    for (const disposer of disposers) {
      try { disposer() } catch { /* ignore */ }
    }
    disposers.length = 0
  }

  if (typeof ctx?.effect === 'function') {
    // cordis 的 effect：返回的函数在插件卸载 / 热重载时执行
    ctx.effect(() => dispose)
  } else {
    disposers.push(dispose)
  }

  log(
    'info',
    `已启用：回合结束后安静 ${config.dwellMinutes} 分钟（同一会话的连续回合会合并，`
    + `最晚推迟到首个回合结束 + ${config.maxDwellMinutes} 分钟）且期间无用户消息，才提醒；`
    + `通道 = ${config.mail.transport}`
  )

  return { config, notifier, stats: notifier.stats, dispose }
}

export { normalizeConfig, DEFAULTS, unwrapVolatile } from './config.mjs'
export { NAMESPACE, SETTINGS_DEFAULTS, buildConfig, registerSettings } from './settings.mjs'
