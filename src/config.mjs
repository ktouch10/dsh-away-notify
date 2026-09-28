// 配置：解包 volatile 引用 → 归一化。
//
// **只有一个配置面，而且是扁平的**（`dwellMinutes` / `transport` / `smtpHost` …）。
// cordis.patch.yml 与设置卡片写的是同一批键，所以不存在"两层配置谁覆盖谁"的歧义 ——
// 合并顺序由 DSH 自己决定（schema 默认 → composition base → 用户设置层），
// 这里只负责把拿到的值读准。
//
// 内部仍然组装成嵌套结构（config.mail.smtp.*），这样 transports.mjs 不用感知扁平键。

import { SETTINGS_DEFAULTS } from './settings.mjs'

/** 扁平默认值。与设置卡片的 schema 默认值同源，避免两边漂移。 */
export const DEFAULTS = SETTINGS_DEFAULTS

/**
 * 解包 schemastery 的 volatile 引用。
 *
 * volatile 字段不是普通值，而是 `{ get() }` 引用对象（本机实测 @deepseek-ai/schemastery@3.18.4）。
 * 直接当普通值读会拿到一个对象 → 数字比较、字符串 trim 全部失效；而
 * `JSON.stringify` 又会静默丢掉它们。所以进归一化之前先整体解包。
 *
 * 普通值原样透传，所以「DSH 传的是解析后的配置」和「传的是原始配置」两种情况都能吃。
 */
export function unwrapVolatile (value) {
  if (Array.isArray(value)) return value.map(unwrapVolatile)
  if (value && typeof value === 'object') {
    if (typeof value.get === 'function') {
      let inner
      let ok = false
      try { inner = value.get(); ok = true } catch { ok = false }
      // 引用对象的实测形状就是恰好一个键 { get }。据此把「volatile 引用」和
      // 「某个配置项恰好叫 get」区分开：后者有别的键，不会被当成引用吞掉。
      const keys = Object.keys(value)
      const looksLikeRef = keys.length === 1 && keys[0] === 'get'
      if (ok && inner !== value && (inner !== undefined || looksLikeRef)) {
        return unwrapVolatile(inner)
      }
    }
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = unwrapVolatile(item)
    return out
  }
  return value
}

function num (value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function bool (value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function text (value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/** 收件人：支持数组，也支持卡片里那种逗号/分号/空白分隔的字符串。 */
function toList (value) {
  if (Array.isArray(value)) return value.flatMap(toList)
  if (typeof value === 'string') {
    return value.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean)
  }
  return []
}

/**
 * 归一化配置。
 * @param {object} raw 可能来自 cordis.patch.yml，也可能来自设置卡片（含 volatile 引用）
 * @returns {{config: object, warnings: string[]}}
 */
export function normalizeConfig (raw = {}) {
  const warnings = []
  const r = unwrapVolatile(raw && typeof raw === 'object' ? raw : {})

  let dwellMinutes = num(r.dwellMinutes, DEFAULTS.dwellMinutes)
  if (dwellMinutes < 0) {
    warnings.push(`dwellMinutes=${dwellMinutes} 非法，已按 0 处理（0 等于「干完就发」，会失去本插件的意义）`)
    dwellMinutes = 0
  }

  let maxDwellMinutes = num(r.maxDwellMinutes, DEFAULTS.maxDwellMinutes)
  if (maxDwellMinutes < dwellMinutes) {
    warnings.push(`maxDwellMinutes(${maxDwellMinutes}) < dwellMinutes(${dwellMinutes})，已提升为 dwellMinutes`)
    maxDwellMinutes = dwellMinutes
  }

  const transport = r.transport === 'smtp' ? 'smtp' : 'outbox'
  const outboxDir = text(r.outboxDir).trim()

  const smtp = {
    host: text(r.smtpHost).trim(),
    port: num(r.smtpPort, DEFAULTS.smtpPort),
    secure: bool(r.smtpSecure, DEFAULTS.smtpSecure),
    user: text(r.smtpUser).trim(),
    pass: text(r.smtpPass),
    passEnv: text(r.smtpPassEnv, DEFAULTS.smtpPassEnv).trim() || DEFAULTS.smtpPassEnv,
    from: text(r.smtpFrom).trim(),
    to: toList(r.smtpTo)
  }
  if (!smtp.from) smtp.from = smtp.user
  if (!smtp.to.length && smtp.from) smtp.to = [smtp.from] // 默认「发给自己」

  if (transport === 'smtp') {
    if (!smtp.host) warnings.push('transport=smtp 但未配置 smtpHost，投递会失败')
    if (!smtp.from) warnings.push('transport=smtp 但 smtpFrom/smtpUser 都为空，投递会失败')
  }

  return {
    config: {
      enabled: bool(r.enabled, DEFAULTS.enabled),
      dwellMinutes,
      maxDwellMinutes,
      tickSeconds: Math.max(1, num(r.tickSeconds, DEFAULTS.tickSeconds)),
      cancelOnUserMessage: bool(r.cancelOnUserMessage, DEFAULTS.cancelOnUserMessage),
      cancelOnTurnStart: bool(r.cancelOnTurnStart, DEFAULTS.cancelOnTurnStart),
      minToolCalls: Math.max(0, num(r.minToolCalls, DEFAULTS.minToolCalls)),
      suppressEmptyTurns: bool(r.suppressEmptyTurns, DEFAULTS.suppressEmptyTurns),
      mail: {
        transport,
        outboxDir: outboxDir || null,
        subjectPrefix: text(r.subjectPrefix, DEFAULTS.subjectPrefix),
        language: r.language === 'en' ? 'en' : 'zh',
        excerptChars: Math.max(0, num(r.excerptChars, DEFAULTS.excerptChars)),
        allowInsecureAuth: bool(r.allowInsecureAuth, DEFAULTS.allowInsecureAuth),
        smtp
      }
    },
    warnings
  }
}

/**
 * 密码优先级：字面量 > 环境变量。
 * 字面量放最后考虑是因为它会明文落盘（设置卡片里的那一栏也建议留空）。
 */
export function resolveSmtpPassword (smtp, env = process.env) {
  if (smtp.pass) return { value: smtp.pass, source: 'config:literal' }
  const name = smtp.passEnv
  if (name && env && env[name]) return { value: env[name], source: `env:${name}` }
  return { value: '', source: 'none' }
}
