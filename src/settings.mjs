// 设置命名空间 + 设置卡片 schema。
//
// DSH 自动生成一张**可写**设置卡片，需要同时满足三个条件（来自 qq-mode-console 的踩坑
// 注释，并在本机用 @deepseek-ai/schemastery@3.18.4 实测确认）：
//
//   ① cordis.patch.yml 里那条 entry 的 `id` **恰好等于**命名空间名（这里是 away-notify）
//   ② 插件模块导出 `Config`（DSH 读的是 fiber.runtime.Config）
//   ③ `Config` 里至少有一个字段带 volatile 标记
//      —— 而且**只有 volatile 字段**会出现在可写表单里：DSH 用 volatileForm(schema)
//      过滤，一个非 volatile 字段都不会显示。
//
// volatile 的真实语义（实测，不是猜的）：
//   * 字段被解析成**引用对象**，形状是 { get() }，读取必须走 .get()
//   * 默认值**仍然生效**：Config({}).dwellMinutes.get() === 5
//   * 非 volatile 字段保持普通值
//   * Config.simplify(cfg) 是官方解包方式，返回普通对象
//   * 危险：JSON.stringify(cfg) 会**静默丢掉** volatile 字段（函数不可序列化），
//     直接把配置写日志或落盘会得到 {}。config.mjs 的 unwrapVolatile() 专门处理这件事。

import { createRequire } from 'node:module'

export const NAMESPACE = 'away-notify'

/**
 * 尽力而为地拿 schemastery。
 *
 * 它是 harness 提供的 peer：npm 装法能解析到，link: 装法解析不到（dsh-notify-long 的
 * README 记过这个坑）。**解析不到时必须能降级**，而不是让整个插件加载失败 ——
 * 降级后只是没有可写卡片，配置仍然从 cordis.patch.yml 读取。
 *
 * 用 createRequire 同步 require 它的 CJS 出口，这样 try/catch 能真正兜住，
 * 也避免在模块顶层引入 top-level await（cordis 用 import() 加载插件，
 * TLA 能用但没必要冒这个险）。
 */
export function loadSchema () {
  try {
    const require = createRequire(import.meta.url)
    const mod = require('@deepseek-ai/schemastery')
    return mod?.default ?? mod ?? null
  } catch {
    return null
  }
}

/** 设置卡片的默认值。也是 config.mjs 的默认值来源，保证两边不会漂移。 */
export const SETTINGS_DEFAULTS = Object.freeze({
  enabled: true,
  dwellMinutes: 5,
  maxDwellMinutes: 30,
  tickSeconds: 5,
  cancelOnUserMessage: true,
  cancelOnTurnStart: false,
  minToolCalls: 0,
  suppressEmptyTurns: true,
  transport: 'outbox',
  outboxDir: '',
  subjectPrefix: '[DSH]',
  language: 'zh',
  excerptChars: 400,
  allowInsecureAuth: false,
  smtpHost: '',
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: '',
  smtpPass: '',
  smtpPassEnv: 'DSH_SMTP_PASSWORD',
  smtpFrom: '',
  smtpTo: ''
})

const DESCRIPTION = {
  enabled: '总开关',
  dwellMinutes: '核心旋钮：回合结束后安静多少分钟仍无用户消息，才发出提醒。0 = 退化成「干完就发」',
  maxDwellMinutes: '同一批工作反复续跑时，提醒最晚推迟到「首个回合结束 + 这么多分钟」',
  tickSeconds: '内部轮询间隔（秒），只决定多久检查一次到没到点',
  cancelOnUserMessage: '真正的用户消息会撤销待发提醒',
  cancelOnTurnStart: '是否也把「开了新回合」当成你在场的信号。默认关闭：目标续跑与后台唤醒都会开新回合，开了这个提醒会被系统行为不断撤销',
  minToolCalls: '低于这个工具调用次数的批次静默。0 = 关闭该规则',
  suppressEmptyTurns: '既没有工具调用、也没有回复文本的空回合不提醒',
  transport: 'outbox = 落盘（零配置即可验证）；smtp = 真的发邮件',
  outboxDir: 'outbox 落盘目录。留空 = ~/.dsh/dsh-away-notify/outbox',
  subjectPrefix: '邮件主题前缀',
  language: '邮件语言',
  excerptChars: '正文里附带「最后一段回复」的最大字符数',
  allowInsecureAuth: '仅限本地测试服务器：允许在明文连接上做 AUTH。生产环境不要开',
  smtpHost: 'SMTP 服务器，例如 smtp.qq.com',
  smtpPort: 'SMTP 端口，例如 465（隐式 TLS）/ 587（STARTTLS）',
  smtpSecure: '是否使用隐式 TLS（465 端口通常是 true，587 通常是 false）',
  smtpUser: 'SMTP 登录账号',
  smtpPass: 'SMTP 密码 / 授权码。留空并改用下面那个环境变量更安全（密码明文落盘有风险）',
  smtpPassEnv: '存放 SMTP 密码的环境变量名',
  smtpFrom: '发件人。留空 = 用登录账号',
  smtpTo: '收件人，多个用逗号分隔。留空 = 发给自己'
}

/**
 * 构造设置 schema。拿不到 schemastery 时返回 undefined（调用方据此降级）。
 *
 * 每个字段都标 volatile —— 只有 volatile 字段会出现在可写表单里，漏标就等于
 * 该字段在卡片上不显示。
 */
export function buildConfig (z) {
  if (!z || typeof z.object !== 'function') return undefined

  const V = field => field.extra('volatile', true)
  // DSH 支持 role('secret')：标记后主机端**不会**把该值回传给浏览器。
  // 老版本没有这个方法，所以按存在性降级。
  const secret = field => (typeof field.role === 'function' ? field.role('secret') : field)
  const desc = (field, key) => (typeof field.description === 'function' && DESCRIPTION[key]
    ? field.description(DESCRIPTION[key])
    : field)

  return z.object({
    enabled: desc(V(z.boolean().default(SETTINGS_DEFAULTS.enabled)), 'enabled'),
    dwellMinutes: desc(V(z.number().default(SETTINGS_DEFAULTS.dwellMinutes)), 'dwellMinutes'),
    maxDwellMinutes: desc(V(z.number().default(SETTINGS_DEFAULTS.maxDwellMinutes)), 'maxDwellMinutes'),
    tickSeconds: desc(V(z.number().default(SETTINGS_DEFAULTS.tickSeconds)), 'tickSeconds'),
    cancelOnUserMessage: desc(V(z.boolean().default(SETTINGS_DEFAULTS.cancelOnUserMessage)), 'cancelOnUserMessage'),
    cancelOnTurnStart: desc(V(z.boolean().default(SETTINGS_DEFAULTS.cancelOnTurnStart)), 'cancelOnTurnStart'),
    minToolCalls: desc(V(z.number().default(SETTINGS_DEFAULTS.minToolCalls)), 'minToolCalls'),
    suppressEmptyTurns: desc(V(z.boolean().default(SETTINGS_DEFAULTS.suppressEmptyTurns)), 'suppressEmptyTurns'),

    transport: desc(V(z.union(['outbox', 'smtp']).default(SETTINGS_DEFAULTS.transport)), 'transport'),
    outboxDir: desc(V(z.string().default(SETTINGS_DEFAULTS.outboxDir)), 'outboxDir'),
    subjectPrefix: desc(V(z.string().default(SETTINGS_DEFAULTS.subjectPrefix)), 'subjectPrefix'),
    language: desc(V(z.union(['zh', 'en']).default(SETTINGS_DEFAULTS.language)), 'language'),
    excerptChars: desc(V(z.number().default(SETTINGS_DEFAULTS.excerptChars)), 'excerptChars'),
    allowInsecureAuth: desc(V(z.boolean().default(SETTINGS_DEFAULTS.allowInsecureAuth)), 'allowInsecureAuth'),

    smtpHost: desc(V(z.string().default(SETTINGS_DEFAULTS.smtpHost)), 'smtpHost'),
    smtpPort: desc(V(z.number().default(SETTINGS_DEFAULTS.smtpPort)), 'smtpPort'),
    smtpSecure: desc(V(z.boolean().default(SETTINGS_DEFAULTS.smtpSecure)), 'smtpSecure'),
    smtpUser: desc(V(z.string().default(SETTINGS_DEFAULTS.smtpUser)), 'smtpUser'),
    smtpPass: desc(secret(V(z.string().default(SETTINGS_DEFAULTS.smtpPass))), 'smtpPass'),
    smtpPassEnv: desc(V(z.string().default(SETTINGS_DEFAULTS.smtpPassEnv)), 'smtpPassEnv'),
    smtpFrom: desc(V(z.string().default(SETTINGS_DEFAULTS.smtpFrom)), 'smtpFrom'),
    smtpTo: desc(V(z.string().default(SETTINGS_DEFAULTS.smtpTo)), 'smtpTo')
  })
}

/** 本插件自己导出的 Config，供 apply() 与测试复用。 */
export const Config = buildConfig(loadSchema())

/**
 * 安全地读一个 cordis 服务。
 *
 * ⚠️ cordis 的 `ctx` 是 Proxy：**访问一个没有 `inject` 的服务会直接抛**
 * `cannot get property "x" without inject` —— 可选链 `ctx?.x` 挡不住，
 * 因为抛的是属性读取这个动作本身。
 *
 * 本插件第一次装进真实 DSH 时就是「启动失败」，根因正是 `ctx?.settings` /
 * `ctx?.logger` 这样的裸读。所以统一走这里：
 *   1. `ctx.get(name)` —— cordis 的安全访问器，服务不存在返回 undefined
 *   2. 再退回直接属性访问，用 try/catch 包住
 * 两条都不通才算「没有这个服务」。
 */
export function readService (ctx, name) {
  if (!ctx) return undefined
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get(name)
      if (viaGet !== undefined) return viaGet
    }
  } catch {
    // ctx.get 本身不可用，继续往下试
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

/**
 * 注册设置命名空间。
 *
 * 命名空间能被**写入**还依赖上面那三个条件，本函数只负责让设置页出现这个域。
 *
 * **注册失败绝不能让插件挂掉** —— 设置卡片是可选功能，配置始终能从 cordis.patch.yml 读。
 * 所以整个函数体（包括读服务那一步）都在 try/catch 里。
 */
export function registerSettings (ctx, { schema = Config, log = () => {} } = {}) {
  try {
    const settings = readService(ctx, 'settings')
    if (!settings || typeof settings.register !== 'function') {
      log('warn', `settings 服务不可用，跳过「${NAMESPACE}」命名空间注册（配置仍从 cordis.patch.yml 读取）`)
      return null
    }
    if (!schema) {
      log('warn', '没拿到 @deepseek-ai/schemastery，跳过设置卡片（配置仍从 cordis.patch.yml 读取）')
      return null
    }

    const scope = settings.register(NAMESPACE, schema, {
      base: { ...SETTINGS_DEFAULTS },
      applies: 'live'
    })
    log('info', `已注册设置命名空间「${NAMESPACE}」`)
    return scope
  } catch (error) {
    const message = String(error?.message ?? error)
    if (/already registered/i.test(message)) {
      log('info', `命名空间「${NAMESPACE}」已注册，跳过`)
      return null
    }
    log('error', `注册设置命名空间失败：${message}`)
    return null
  }
}

/**
 * 把设置命名空间挂上去 —— 现在挂，或者等 settings 服务出现再挂。
 *
 * 为什么要等：`dsh-settings-file` 的异步初始化在本插件激活**之后**才完成，
 * 所以 apply 时一次性读 `ctx.get('settings')` 常常是 undefined。
 * 设置域没挂上，设置页里那张卡片就什么都不渲染（dsh-notify-long 的 README 记过这个坑）。
 */
export function setupSettings (ctx, { schema = Config, log = () => {} } = {}) {
  if (readService(ctx, 'settings')) {
    return registerSettings(ctx, { schema, log })
  }

  log('info', 'settings 服务尚未就绪，等它出现后再注册设置命名空间')

  let canInject = false
  try {
    canInject = typeof ctx?.inject === 'function'
  } catch {
    canInject = false
  }

  if (!canInject) {
    log('warn', 'ctx.inject 不可用，本次不注册设置卡片（配置仍从 cordis.patch.yml 读取）')
    return null
  }

  try {
    ctx.inject(['settings'], inner => registerSettings(inner ?? ctx, { schema, log }))
  } catch (error) {
    log('warn', `延迟注册设置命名空间失败：${error?.message ?? error}`)
  }
  return null
}
