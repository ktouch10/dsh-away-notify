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

import { mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeConfig, DEFAULTS } from './config.mjs'
import { createDwellScheduler } from './dwell.mjs'
import { createTurnAggregator, renderNotification, suppressionReason, normalizeReason, pickSessionName } from './summary.mjs'
import { deliver } from './transports.mjs'
import { NAMESPACE, Config, SETTINGS_ENUMS, readService, registerSettings, setupSettings } from './settings.mjs'
import { createDiagnostics, describeConfig } from './diag.mjs'
import { FIELD_SPECS } from './field-spec.mjs'
import {
  OVERLAY_FILENAME,
  defaultOverlayFile,
  isKnownKey,
  overriddenKeys,
  readOverlay,
  sanitizeOverlay
} from './panel-config.mjs'
import { makeIndexRowHandler, registerPanelRoutes } from './webpanel.mjs'

export const name = 'dsh-away-notify'

/**
 * 归一化后的配置 → 面板要的扁平键。
 *
 * ⚠️ **密码绝不下发到浏览器**：`smtpPass` 一律返回空串（面板里那一栏是「留空即不修改」）。
 * 这与 schema 上 `role('secret')` 的意图一致 —— 主机端不把秘密值送回客户端。
 */
export function flattenForPanel (config) {
  const mail = config?.mail ?? {}
  const smtp = mail.smtp ?? {}
  return {
    enabled: config?.enabled,
    dwellMinutes: config?.dwellMinutes,
    maxDwellMinutes: config?.maxDwellMinutes,
    tickSeconds: config?.tickSeconds,
    cancelOnUserMessage: config?.cancelOnUserMessage,
    cancelOnTurnStart: config?.cancelOnTurnStart,
    minToolCalls: config?.minToolCalls,
    suppressEmptyTurns: config?.suppressEmptyTurns,
    transport: mail.transport,
    outboxDir: mail.outboxDir ?? '',
    subjectPrefix: mail.subjectPrefix ?? '',
    language: mail.language,
    excerptChars: mail.excerptChars,
    allowInsecureAuth: mail.allowInsecureAuth ?? false,
    smtpHost: smtp.host ?? '',
    smtpPort: smtp.port,
    smtpSecure: smtp.secure,
    smtpUser: smtp.user ?? '',
    smtpPass: '',
    smtpPassEnv: smtp.passEnv ?? '',
    smtpFrom: smtp.from ?? '',
    smtpTo: Array.isArray(smtp.to) ? smtp.to.join(', ') : (smtp.to ?? '')
  }
}

// DSH 读的是插件模块的 `Config` 导出（fiber.runtime.Config），
// 而条目 id 必须等于设置命名空间 —— 两者共同决定设置卡片能不能写。
export { Config }

function makeLogger (ctx, diag = null) {
  // 必须走 readService：cordis 的 ctx 是 Proxy，裸读一个没 inject 的服务会抛
  // `cannot get property "logger" without inject`，可选链挡不住（`ctx?.logger` 同样抛）。
  const sink = readService(ctx, 'logger')
  return (level, message) => {
    const line = `[dsh-away-notify] ${message}`
    // 同时落盘一份：DSH 不保存插件主机端的输出（logs/ 里只有崩溃日志），
    // 没有这份日志就无从排查「为什么没收到提醒」。
    diag?.write(level, message)
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

/**
 * 会话标题解析 —— 三个来源，按可靠性排序。
 *
 * ① DSH 的 `sessionTitle` 服务：`svc.get(session)` 是**折叠会话日志**得来的，
 *    **连插件启动之前写入的标题也能拿到**。
 *    本插件第一次跑出来的邮件里标题回落成了 session id，原因就是 `session/title`
 *    事件（seq=13）在插件加载之前就产生了，插件收不到历史事件。
 * ② `session/title` 事件 —— 由折叠器处理，只能拿到启动后的新增/更新。
 * ③ session 对象上的 name/title/... 字段（跨版本兜底）。
 *
 * svc.get(session) 是同步的，可能返回字符串，也可能返回 { title } / { text }。
 * 用法参照本机 dsh-whale-widget 的实测实现；老宿主没有这个服务就静默回落。
 */
function makeTitleResolver (ctx) {
  return session => {
    try {
      const svc = readService(ctx, 'sessionTitle')
      if (svc && typeof svc.get === 'function' && session) {
        const snapshot = svc.get(session)
        const title = typeof snapshot === 'string' ? snapshot : (snapshot && (snapshot.title || snapshot.text))
        const value = String(title ?? '').trim()
        if (value) return value.slice(0, 160)
      }
    } catch {
      // 没有这个服务 / 调用失败，都交给下面的兜底
    }
    return pickSessionName(session)
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
  now = () => Date.now(),
  resolveTitle = () => ''
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
        // 收口之前先补一次标题：sessionTitle 服务能拿到插件启动**之前**写入的标题，
        // 而 session/title 事件只覆盖启动之后（本会话的标题就是加载前产生的，seq=13）。
        try {
          const title = resolveTitle(session)
          if (title) agg.noteTitle(sessionId, title)
        } catch {
          // 取标题失败绝不能影响提醒本身
        }
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
 * 桌面端的注入行必须是 apply 的**第一件事**。
 *
 * DSH 桌面壳在宿主启动时把注入表**一次性**收集走（`collectIndexInjections()` → IPC → 渲染层），
 * 而且**没有任何刷新路径** —— 订阅一旦晚于那次收集，这一行就永远进不了表（dsh-whale-widget 的
 * #152/#153 就是这个竞态）。所以这里不 inject 任何服务、不依赖任何前置条件，立刻挂上。
 */
function installIndexRow (ctx) {
  try {
    if (typeof ctx?.on !== 'function') return false
    const handler = makeIndexRowHandler()
    ctx.on('webserver/index-inject', handler)
    return true
  } catch {
    return false // 注入行失败不影响任何功能，只是面板按钮不出现
  }
}

/**
 * cordis 入口。
 * @returns {object} 不是 cordis 契约的一部分，只为测试与运维提供抓手。
 */
export function apply (ctx, rawConfig = {}) {
  // ① 最先注册注入行（见 installIndexRow 的说明）
  const rowInstalled = installIndexRow(ctx)

  // ② 用户层覆盖：面板写的那份，优先级高于 cordis.patch.yml
  const overlayFile = process.env.DSH_AWAY_NOTIFY_CONFIG
    || process.env.DSH_AWAY_NOTIFY_DIAG_DIR && join(process.env.DSH_AWAY_NOTIFY_DIAG_DIR, OVERLAY_FILENAME)
    || defaultOverlayFile()
  const initialOverlay = readOverlay(overlayFile)
  const { config, warnings } = normalizeConfig({ ...rawConfig, ...initialOverlay.values })

  // 诊断日志：启动结果 / 配置摘要（凭据脱敏）/ 注册与订阅结果 / 每次决策。
  // 环境变量只用于测试或特殊部署时重定向，免得跑测试污染用户主目录。
  const diag = createDiagnostics({ dir: process.env.DSH_AWAY_NOTIFY_DIAG_DIR || null })
  const log = makeLogger(ctx, diag)

  log('info', '=== apply 开始 ===')
  if (diag.file) log('info', `诊断日志: ${diag.file}`)
  else log('warn', '诊断日志不可写（不影响功能，只是事后没法排查）')
  log('info', `配置: ${describeConfig(config)}`)
  log('info', `面板注入行: ${rowInstalled ? '已挂到 webserver/index-inject' : '未挂上（ctx.on 不可用）'}`)
  if (Object.keys(initialOverlay.values).length) {
    log('info', `面板覆盖层: ${Object.keys(initialOverlay.values).length} 个字段（${overlayFile}）`)
  }
  if (initialOverlay.error) log('warn', initialOverlay.error)
  for (const warning of warnings) log('warn', warning)

  // ③ 必须在 enabled 判断之前注册：否则用户把插件关掉之后，就再也没有 UI 入口把它打开了。
  // setupSettings 全程 try/catch，且会在 settings 服务晚到时延迟绑定。
  log('info', `settings 服务此刻${readService(ctx, 'settings') ? '可用' : '不可用（将尝试延迟绑定）'}`)
  setupSettings(ctx, { log })

  // ─────────────── 面板：读状态 / 写配置 / 实时应用 ───────────────

  let notifier = null
  let timer = null
  /** 订阅/定时器是否已经起来（面板可以把总开关实时拨来拨去）。 */
  let subscriptionsReady = false

  // ctx 是 Proxy：连 `typeof ctx.on` 这样的能力探测都可能抛（属性读取本身就会抛），
  // 所以探测也必须包起来。**必须声明在 writeState 之前** —— 面板在插件处于关闭状态时
  // 也可能改配置，那时若走到还没初始化的 const 会撞 TDZ。
  const can = service => {
    try { return typeof ctx?.[service] === 'function' } catch { return false }
  }
  const disposers = []

  /** 面板下发的字段描述（面板自己不维护字段表，避免两份漂移）。 */
  function describePanelFields () {
    return FIELD_SPECS.map(spec => {
      const field = {
        key: spec.key,
        type: spec.type,
        group: spec.group,
        label: spec.label,
        help: spec.help
      }
      if (spec.min !== undefined) field.min = spec.min
      if (spec.max !== undefined) field.max = spec.max
      const allowed = SETTINGS_ENUMS[spec.key]
      if (allowed) {
        field.options = allowed.map(value => ({
          value,
          text: spec.optionText?.[value] ?? value
        }))
      }
      return field
    })
  }

  function readState () {
    const overlay = readOverlay(overlayFile)
    return {
      fields: describePanelFields(),
      values: flattenForPanel(config),
      overridden: [...overriddenKeys(overlay.values)],
      enabled: config.enabled,
      overlayFile,
      error: overlay.error
    }
  }

  /**
   * 写入并实时应用。
   *
   * 只有 `dwellMinutes` / `maxDwellMinutes` 需要重建调度器（它们是**构造时捕获**的），
   * 其余字段都是**使用时读取**，原地改 `config` 即可。`tickSeconds` 只需要重启定时器。
   * 值传 `null` 表示「清除这个覆盖」，回到 cordis.patch.yml 的值。
   */
  function writeState (patch) {
    const clears = []
    const sets = {}
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (value === null || value === undefined) clears.push(key)
      else sets[key] = value
    }

    const overlay = readOverlay(overlayFile)
    const next = { ...overlay.values }
    for (const key of clears) delete next[key]

    const { values: accepted, rejected } = sanitizeOverlay(sets)
    Object.assign(next, accepted)
    if (clears.length) {
      for (const key of clears) {
        if (!isKnownKey(key)) rejected.push(`未知字段：${key}`)
      }
    }

    let writeError = null
    try {
      mkdirSync(dirname(overlayFile), { recursive: true })
      const tmp = `${overlayFile}.tmp-${process.pid}`
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      renameSync(tmp, overlayFile)
    } catch (error) {
      writeError = `写入失败：${error?.message ?? error}`
    }

    const before = {
      dwell: config.dwellMinutes,
      maxDwell: config.maxDwellMinutes,
      tick: config.tickSeconds
    }
    const merged = normalizeConfig({ ...rawConfig, ...next })
    Object.assign(config, merged.config)
    for (const warning of merged.warnings) log('warn', warning)

    let needsRestart = false
    if (!writeError) {
      const dwellChanged = config.dwellMinutes !== before.dwell || config.maxDwellMinutes !== before.maxDwell
      const tickChanged = config.tickSeconds !== before.tick

      if (!config.enabled) {
        // 面板里关掉总开关 —— 实时生效，不用重启
        if (subscriptionsReady) {
          stopSubscriptions()
          log('info', '面板把插件关掉了：已取消订阅与定时器')
        }
      } else if (!subscriptionsReady) {
        subscriptionsReady = restartSubscription()
        if (subscriptionsReady) log('info', '面板把插件打开了：已订阅会话事件')
      } else if (dwellChanged) {
        // 调度器的 dwellMs 是构造时捕获的 —— 只能重建（待发提醒会重新计时）
        subscriptionsReady = restartSubscription()
        log('info', `面板改动了静默时长，已重建状态机（${before.dwell} → ${config.dwellMinutes} 分钟）`)
      } else if (tickChanged) {
        restartTimer()
        log('info', `面板改动了轮询间隔：${before.tick} → ${config.tickSeconds} 秒`)
      }
      log('info', `面板已保存 ${Object.keys(accepted).length} 个字段${clears.length ? `，清除 ${clears.length} 个覆盖` : ''}`)
    }

    return {
      values: flattenForPanel(config),
      overridden: Object.keys(next),
      rejected: writeError ? [...rejected, writeError] : rejected,
      needsRestart,
      error: writeError
    }
  }

  // 面板必须在 enabled 判断之前挂上：关掉插件之后还得有界面能把它打开
  let disposePanel = () => {}
  try {
    const panelLog = log
    const canInject = (() => {
      try { return typeof ctx?.inject === 'function' } catch { return false }
    })()
    if (canInject) {
      // webServer 是服务，必须等它就绪（对象级 inject 会把整个 apply 推迟，所以用局部 inject）
      ctx.inject(['webServer'], inner => {
        const scope = inner ?? ctx
        let server = null
        try { server = scope?.webServer } catch { server = null }
        disposePanel = registerPanelRoutes({
          webServer: server,
          readState,
          writeState,
          log: panelLog
        })
      })
    } else {
      log('warn', 'ctx.inject 不可用：面板路由未注册（面板不会显示）')
    }
  } catch (error) {
    log('warn', `挂面板失败（面板不会显示，其余功能不受影响）：${error?.message ?? error}`)
  }

  if (!config.enabled) {
    log('info', 'enabled=false，不监听任何事件（面板仍可用，可以从界面里再打开）')
    // notifier 用 getter：面板可以把总开关实时打开，那时这里要能反映出来。
    // 仍然把面板的读写接口交出去 —— 关掉之后就是靠它把插件打开的。
    return {
      config,
      stats: null,
      get notifier () { return notifier },
      dispose () { disposePanel() },
      readState,
      writeState
    }
  }

  // ─────────────── 订阅与定时器（可被面板改动重建） ───────────────
  // 注意：`can` 与 `disposers` 在上面就声明了（面板在插件关闭时也会改配置）。

  function restartTimer () {
    if (timer) clearInterval(timer)
    timer = setInterval(() => {
      try {
        notifier?.tick()
      } catch (error) {
        log('error', `tick 失败：${error?.message ?? error}`)
      }
    }, config.tickSeconds * 1000)
    timer.unref?.()
  }

  /** 取消订阅与定时器（面板把总开关关掉时走这里）。 */
  function stopSubscriptions () {
    for (const disposer of disposers.splice(0)) {
      try { disposer() } catch { /* 卸载失败无所谓 */ }
    }
    if (timer) { clearInterval(timer); timer = null }
    notifier = null
    subscriptionsReady = false
  }

  /**
   * 建 notifier + 订阅 + 定时器。
   * 面板改动静默时长时也走这里（调度器的 dwellMs 是构造时捕获的）。
   * @returns {boolean} 是否成功
   */
  function restartSubscription () {
    for (const disposer of disposers.splice(0)) {
      try { disposer() } catch { /* 卸载失败无所谓 */ }
    }
    if (timer) { clearInterval(timer); timer = null }

    notifier = createNotifier({ config, log, resolveTitle: makeTitleResolver(ctx) })

    if (can('on')) {
      try {
        const disposer = ctx.on('session/event', notifier.handleSessionEvent)
        if (typeof disposer === 'function') disposers.push(disposer)
      } catch (error) {
        log('error', `订阅 session/event 失败：${error?.message ?? error}`)
        return false
      }
    } else {
      log('warn', 'ctx.on 不可用：插件已挂载但收不到事件')
      return false
    }

    restartTimer()
    return true
  }

  subscriptionsReady = restartSubscription()
  if (subscriptionsReady) log('info', 'session/event 订阅成功')

  function dispose () {
    if (timer) clearInterval(timer)
    for (const disposer of disposers) {
      try { disposer() } catch { /* ignore */ }
    }
    disposers.length = 0
    subscriptionsReady = false
    disposePanel()
  }

  if (can('effect')) {
    try {
      // cordis 的 effect：返回的函数在插件卸载 / 热重载时执行
      ctx.effect(() => dispose)
    } catch (error) {
      log('warn', `ctx.effect 注册失败（不影响功能）：${error?.message ?? error}`)
      disposers.push(dispose)
    }
  } else {
    disposers.push(dispose)
  }

  log(
    'info',
    `已启用：回合结束后安静 ${config.dwellMinutes} 分钟（同一会话的连续回合会合并，`
    + `最晚推迟到首个回合结束 + ${config.maxDwellMinutes} 分钟）且期间无用户消息，才提醒；`
    + `通道 = ${config.mail.transport}`
  )

  return {
    config,
    // getter：面板改动静默时长会重建 notifier，写死值会让调用方拿到旧的
    get notifier () { return notifier },
    get stats () { return notifier?.stats ?? null },
    dispose,
    readState,
    writeState
  }
}

export { normalizeConfig, DEFAULTS, unwrapVolatile } from './config.mjs'
export { NAMESPACE, SETTINGS_DEFAULTS, buildConfig, registerSettings, readService, setupSettings } from './settings.mjs'
export { createDiagnostics, describeConfig, defaultDiagDir, DIAG_FILE } from './diag.mjs'
