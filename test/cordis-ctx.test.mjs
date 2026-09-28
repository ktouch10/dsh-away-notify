// 在「真实 cordis ctx 形状」下的启动鲁棒性。
//
// 为什么单独一个文件：本插件第一次装进真实 DSH 时设置页显示 **启动失败**，
// 根因是 cordis 的 ctx 是个 Proxy —— **访问一个没有 inject 的服务会直接抛**
// `cannot get property "x" without inject`，而可选链 `ctx?.x` 挡不住
// （抛的是属性读取这个动作本身，不是访问到了 undefined）。
//
// 我们原来在 apply 里裸读 `ctx?.settings` / `ctx?.logger`，而且都在 try/catch 外面，
// 所以整个插件启动就炸了。下面的假 ctx 精确复刻这个行为，用来钉住修复。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index.mjs'
import { NAMESPACE, readService, setupSettings } from '../src/settings.mjs'

/** 不会被访问的常见属性，避免 Proxy 干扰运行时/测试框架。 */
const IGNORED = new Set(['then', 'toJSON', 'inspect', 'constructor', 'valueOf', 'toString'])

/**
 * 复刻 cordis 的 ctx：自己的属性正常返回，**其它属性读取直接抛**。
 * @param {object} own 这个 ctx 上真正存在的成员（on / effect / get 会自动补）
 */
function cordisLikeCtx (own = {}) {
  const handlers = new Map()
  const logs = []
  const injects = []

  const target = {
    on (type, fn) { handlers.set(type, fn); return () => handlers.delete(type) },
    effect (fn) { fn() },
    get (name) { return Object.prototype.hasOwnProperty.call(target, name) ? target[name] : undefined },
    ...own
  }

  const ctx = new Proxy(target, {
    get (obj, prop) {
      if (typeof prop === 'symbol' || IGNORED.has(prop)) return undefined
      if (Object.prototype.hasOwnProperty.call(obj, prop)) return obj[prop]
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
    has (obj, prop) { return Object.prototype.hasOwnProperty.call(obj, prop) }
  })

  return { ctx, handlers, logs, injects }
}

test('裸读未 inject 的服务在 cordis 形状下确实会抛（证明这个假 ctx 是有效的）', () => {
  const { ctx } = cordisLikeCtx()
  assert.throws(() => ctx.settings, /without inject/)
  assert.throws(() => ctx?.logger, /without inject/)
  assert.throws(() => ctx.nonexistent, /without inject/)
})

test('readService 不会抛，服务不存在时返回 undefined', () => {
  const { ctx } = cordisLikeCtx()
  assert.equal(readService(ctx, 'settings'), undefined)
  assert.equal(readService(ctx, 'logger'), undefined)

  const { ctx: withSettings } = cordisLikeCtx({ settings: { register: () => 'ok' } })
  assert.deepEqual(readService(withSettings, 'settings'), { register: withSettings.settings.register })
})

test('没有任何服务时 apply 也不能抛 —— 这正是「启动失败」的回归测试', () => {
  const { ctx, handlers } = cordisLikeCtx()

  let instance = null
  assert.doesNotThrow(() => {
    instance = apply(ctx, { enabled: true, tickSeconds: 3600 })
  })

  assert.ok(instance, 'apply 应该返回抓手对象')
  assert.ok(instance.notifier, '插件本体应该正常起来')
  assert.equal(handlers.has('session/event'), true, '仍然要订阅 session/event')
  instance.dispose()
})

test('ctx.logger 缺失时退化为 console，不影响启动', () => {
  const { ctx } = cordisLikeCtx()
  const instance = apply(ctx, { enabled: true, tickSeconds: 3600 })
  assert.ok(instance.notifier)
  instance.dispose()
})

test('settings 服务存在时立刻注册命名空间', () => {
  const calls = []
  const { ctx } = cordisLikeCtx({ settings: { register: (...args) => { calls.push(args); return { ok: true } } } })

  const instance = apply(ctx, { enabled: true, tickSeconds: 3600 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], NAMESPACE)
  instance.dispose()
})

test('settings 服务晚到时会延迟绑定（dsh-settings-file 是异步初始化的）', () => {
  const calls = []
  const { ctx, injects } = cordisLikeCtx({
    inject: (deps, cb) => { injects.push({ deps, cb }) }
  })

  const instance = apply(ctx, { enabled: true, tickSeconds: 3600 })
  assert.equal(calls.length, 0, '此刻还没有 settings 服务')
  assert.equal(injects.length, 1, '应该挂一个延迟绑定')
  assert.deepEqual(injects[0].deps, ['settings'])

  // 服务出现后，cordis 会用带该服务的 ctx 调回调
  const late = cordisLikeCtx({ settings: { register: (...args) => { calls.push(args); return { ok: true } } } })
  injects[0].cb(late.ctx)
  assert.equal(calls.length, 1, '服务出现后应该完成注册')
  assert.equal(calls[0][0], NAMESPACE)
  instance.dispose()
})

test('ctx 上连 on / effect 都取不到时，只告警不抛错', () => {
  // 一个极端的 ctx：除了 get 什么都没有，其它属性全部抛
  const target = { get: () => undefined }
  const bare = new Proxy(target, {
    get (obj, prop) {
      if (typeof prop === 'symbol' || IGNORED.has(prop)) return undefined
      if (Object.prototype.hasOwnProperty.call(obj, prop)) return obj[prop]
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    }
  })

  let instance = null
  assert.doesNotThrow(() => { instance = apply(bare, { enabled: true, tickSeconds: 3600 }) })
  assert.ok(instance.notifier, '即使收不到事件，插件也不该崩')
  instance.dispose()
})

test('enabled=false 时仍然尝试注册设置卡片，然后干净退出', () => {
  const calls = []
  const { ctx, handlers } = cordisLikeCtx({ settings: { register: (...args) => { calls.push(args); return {} } } })

  const instance = apply(ctx, { enabled: false })
  assert.equal(calls.length, 1, '关掉插件也必须能注册卡片，否则没有 UI 入口再打开它')
  assert.equal(instance.notifier, null)
  assert.equal(handlers.has('session/event'), false, '关掉时不该订阅事件')
  instance.dispose()
})

test('setupSettings 在没有任何 settings 能力时返回 null 且不抛', () => {
  const { ctx } = cordisLikeCtx()
  assert.doesNotThrow(() => assert.equal(setupSettings(ctx, { log: () => {} }), null))
})
