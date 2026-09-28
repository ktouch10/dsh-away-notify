// 面板的持久化后端：一份「用户层」覆盖配置。
//
// 为什么不用官方 settings 服务：实测 `settings` 服务在 apply 时不可用，而延迟绑定的回调里也
// 拿不到它（见诊断日志）。面板要能真的读写配置，就得有个自己能掌控的落点。
//
// 分层与 DSH 自己的模型一致：
//
//     schema 默认值  <  cordis.patch.yml（组合层）  <  config.json（用户层，面板写的）
//
// 覆盖层是**白名单**的：只认 SETTINGS_DEFAULTS 里的键，并且按类型收敛。这样即使有人在
// 请求里塞 `{"__proto__": {...}}` 或未知键，也进不了配置对象。
//
// 写入是**原子**的：先写临时文件再 rename，避免断电/崩溃时留下半截 JSON。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SETTINGS_DEFAULTS, SETTINGS_ENUMS } from './settings.mjs'

export const OVERLAY_FILENAME = 'config.json'

/** 与诊断日志放在一起：~/.dsh/dsh-away-notify/ */
export function defaultOverlayDir () {
  return path.join(os.homedir(), '.dsh', 'dsh-away-notify')
}

export function defaultOverlayFile () {
  return path.join(defaultOverlayDir(), OVERLAY_FILENAME)
}

/** 某个键的期望类型（由默认值推断，避免再维护一张表）。 */
export function typeOfKey (key) {
  const fallback = SETTINGS_DEFAULTS[key]
  if (typeof fallback === 'boolean') return 'boolean'
  if (typeof fallback === 'number') return 'number'
  return 'string'
}

export function isKnownKey (key) {
  return Object.prototype.hasOwnProperty.call(SETTINGS_DEFAULTS, key)
}

/**
 * 把一个外来值收敛成该键期望的类型。
 * @returns {{ok: true, value: unknown} | {ok: false, reason: string}}
 */
export function coerceValue (key, raw) {
  if (!isKnownKey(key)) return { ok: false, reason: `未知字段：${key}` }

  const type = typeOfKey(key)

  if (type === 'boolean') {
    if (typeof raw === 'boolean') return { ok: true, value: raw }
    if (raw === 'true' || raw === 1 || raw === '1') return { ok: true, value: true }
    if (raw === 'false' || raw === 0 || raw === '0') return { ok: true, value: false }
    return { ok: false, reason: `${key} 需要布尔值` }
  }

  if (type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
    if (!Number.isFinite(n)) return { ok: false, reason: `${key} 需要数字` }
    if (n < 0) return { ok: false, reason: `${key} 不能是负数` }
    return { ok: true, value: n }
  }

  const s = String(raw ?? '')
  const allowed = SETTINGS_ENUMS[key]
  if (allowed && !allowed.includes(s)) {
    return { ok: false, reason: `${key} 只接受 ${allowed.join(' / ')}` }
  }
  return { ok: true, value: s }
}

/**
 * 把一份外来对象过滤成干净的覆盖层。
 * @returns {{values: object, rejected: string[]}}
 */
export function sanitizeOverlay (input) {
  const values = {}
  const rejected = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { values, rejected }
  }
  for (const [key, raw] of Object.entries(input)) {
    const result = coerceValue(key, raw)
    if (result.ok) values[key] = result.value
    else rejected.push(result.reason)
  }
  return { values, rejected }
}

/**
 * 读覆盖层。文件缺失或坏掉都不抛 —— 返回空覆盖 + 一条说明。
 * @returns {{values: object, error: string|null}}
 */
export function readOverlay (file = defaultOverlayFile()) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(text)
    const { values, rejected } = sanitizeOverlay(parsed)
    return { values, error: rejected.length ? `忽略了非法字段：${rejected.join('；')}` : null }
  } catch (error) {
    if (error?.code === 'ENOENT') return { values: {}, error: null }
    return { values: {}, error: `读不到覆盖配置（${error?.message ?? error}），已按空处理` }
  }
}

/**
 * 原子写入：合并到已有覆盖层上。
 * @returns {{values: object, rejected: string[], error: string|null}}
 */
export function writeOverlay (file, patch) {
  const current = readOverlay(file)
  const { values, rejected } = sanitizeOverlay(patch)
  const merged = { ...current.values, ...values }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, file)
    return { values: merged, rejected, error: null }
  } catch (error) {
    return { values: current.values, rejected, error: `写入失败：${error?.message ?? error}` }
  }
}

/** 覆盖层的键集合（用于面板显示「哪些字段被覆盖过」）。 */
export function overriddenKeys (overlay) {
  return new Set(Object.keys(sanitizeOverlay(overlay).values))
}
