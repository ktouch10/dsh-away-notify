// 设置卡片（面板）。
//
// DSH 自动生成一张**可写**设置卡片需要三个条件同时成立，这里逐条钉住：
//   ① cordis.patch.yml 里 entry 的 id === 命名空间名
//   ② 插件导出 Config
//   ③ Config 里至少有一个 volatile 字段 —— 而且只有 volatile 字段会显示在表单里
//
// 关于 volatile 的语义（本机用 @deepseek-ai/schemastery@3.18.4 实测）：
//   字段是引用对象 { get() }，默认值仍生效，读取必须走 .get()，
//   而 JSON.stringify 会静默丢掉它们。下面有专门的用例守住这个坑。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  NAMESPACE,
  Config,
  SETTINGS_DEFAULTS,
  buildConfig,
  loadSchema,
  registerSettings
} from '../src/settings.mjs'
import { normalizeConfig, unwrapVolatile } from '../src/config.mjs'
import { apply } from '../src/index.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 从序列化后的 schema 里取出顶层每个字段的节点。 */
function fieldNodes (schema) {
  const json = schema.toJSON()
  const root = Object.values(json.refs).find(node => node && node.dict)
  const out = {}
  for (const [field, refId] of Object.entries(root.dict)) out[field] = json.refs[String(refId)]
  return out
}

function fakeCtx ({ withSettings = true } = {}) {
  const calls = []
  const handlers = new Map()
  const logs = []
  const ctx = {
    calls,
    handlers,
    logs,
    on (type, fn) { handlers.set(type, fn); return () => handlers.delete(type) },
    effect (fn) { return fn() },
    logger: { info: m => logs.push(['info', m]), warn: m => logs.push(['warn', m]), error: m => logs.push(['error', m]) }
  }
  if (withSettings) {
    ctx.settings = {
      register: (...args) => { calls.push(args); return { ok: true } }
    }
  }
  return ctx
}

// ─────────────────── schemastery 可用性 ───────────────────

test('schemastery 能解析到，Config 被构造出来', () => {
  assert.ok(loadSchema(), 'devDependency @deepseek-ai/schemastery 应该能解析到')
  assert.ok(Config, 'Config 必须存在 —— 否则设置卡片不可写')
  assert.equal(typeof Config, 'function', 'schemastery 的 schema 是可调用对象')
})

test('buildConfig 拿不到 schemastery 时返回 undefined（而不是抛错）', () => {
  assert.equal(buildConfig(null), undefined)
  assert.equal(buildConfig({}), undefined)
  assert.equal(buildConfig({ object: 'not a function' }), undefined)
})

// ─────────────────── 条件 ③：每个字段都必须是 volatile ───────────────────

test('设置的每个字段都是 volatile 且带描述', () => {
  const nodes = fieldNodes(Config)
  const fields = Object.keys(nodes)

  assert.deepEqual(
    fields.sort(),
    Object.keys(SETTINGS_DEFAULTS).sort(),
    'schema 字段与默认值必须一一对应，不能漂移'
  )

  for (const [field, node] of Object.entries(nodes)) {
    assert.equal(node.meta?.volatile, true, `字段 ${field} 没标 volatile —— 它不会出现在可写表单里`)
    assert.ok(node.meta?.description, `字段 ${field} 缺少描述，卡片上会是空的`)
  }
})

test('密码字段标成 secret，主机不会把它回传给浏览器', () => {
  const nodes = fieldNodes(Config)
  assert.equal(nodes.smtpPass.meta.role, 'secret')
  // 其它字段都不该是 secret（否则用户看不到自己填了什么）
  for (const [field, node] of Object.entries(nodes)) {
    if (field === 'smtpPass') continue
    assert.notEqual(node.meta.role, 'secret', `${field} 不该是 secret`)
  }
})

test('union 字段的取值被限制在允许集合内', () => {
  assert.throws(() => Config({ transport: 'carrier-pigeon' }), /transport/)
  assert.throws(() => Config({ language: 'fr' }), /language/)
  assert.doesNotThrow(() => Config({ transport: 'smtp', language: 'en' }))
})

// ─────────────────── volatile 引用语义 ───────────────────

test('Config({}) 的 volatile 字段是引用对象，默认值仍然生效', () => {
  const parsed = Config({})
  assert.equal(typeof parsed.dwellMinutes, 'object')
  assert.equal(typeof parsed.dwellMinutes.get, 'function')
  assert.equal(parsed.dwellMinutes.get(), 5)

  // 危险行为：JSON 往返会静默丢掉 volatile 字段的**值**（函数不可序列化），
  // 键还在、值全变成 {}。所以绝不能直接把配置 JSON 落盘/记日志。
  const roundTripped = JSON.parse(JSON.stringify(parsed))
  assert.deepEqual(
    Object.keys(roundTripped).sort(),
    Object.keys(SETTINGS_DEFAULTS).sort(),
    '键还在'
  )
  for (const [field, value] of Object.entries(roundTripped)) {
    assert.deepEqual(value, {}, `字段 ${field} 的值在 JSON 往返后丢光了`)
  }
})

test('unwrapVolatile 把引用对象解成普通值', () => {
  const parsed = Config({})
  assert.deepEqual(unwrapVolatile(parsed), { ...SETTINGS_DEFAULTS })

  const custom = unwrapVolatile(Config({ dwellMinutes: 7, transport: 'smtp', smtpTo: 'a@b.c' }))
  assert.equal(custom.dwellMinutes, 7)
  assert.equal(custom.transport, 'smtp')
  assert.equal(custom.smtpTo, 'a@b.c')
  assert.equal(typeof custom.dwellMinutes, 'number')
})

test('unwrapVolatile 对普通值透传，也不会把恰好带 get 键的普通对象吞掉', () => {
  assert.equal(unwrapVolatile(5), 5)
  assert.equal(unwrapVolatile('x'), 'x')
  assert.equal(unwrapVolatile(null), null)
  assert.deepEqual(unwrapVolatile([1, { a: 2 }]), [1, { a: 2 }])

  // 引用对象的实测形状是恰好一个键 { get }；这个对象有别的键，不该被当成引用
  const weird = unwrapVolatile({ get: () => undefined, other: 1 })
  assert.equal(typeof weird, 'object', '不该被折叠成 undefined')
  assert.equal(weird.other, 1)
})

// ─────────────────── 配置归一化（扁平 → 内部嵌套） ───────────────────

test('normalizeConfig 直接吃 schema 解析结果（含 volatile 引用）', () => {
  const parsed = Config({
    dwellMinutes: 12,
    transport: 'smtp',
    smtpHost: 'smtp.qq.com',
    smtpPort: 465,
    smtpUser: 'me@qq.com',
    smtpTo: 'a@b.c, d@e.f; g@h.i',
    subjectPrefix: '[AWAY]',
    language: 'en'
  })
  const { config, warnings } = normalizeConfig(parsed)

  assert.deepEqual(warnings, [])
  assert.equal(config.dwellMinutes, 12)
  assert.equal(config.mail.transport, 'smtp')
  assert.equal(config.mail.subjectPrefix, '[AWAY]')
  assert.equal(config.mail.language, 'en')
  assert.equal(config.mail.smtp.host, 'smtp.qq.com')
  assert.equal(config.mail.smtp.user, 'me@qq.com')
  // 卡片里收件人是逗号分隔的字符串，要能拆开
  assert.deepEqual(config.mail.smtp.to, ['a@b.c', 'd@e.f', 'g@h.i'])
  // 没填发件人时默认用登录账号
  assert.equal(config.mail.smtp.from, 'me@qq.com')
})

test('normalizeConfig 也吃普通扁平对象（没有 schemastery 时的降级路径）', () => {
  const { config } = normalizeConfig({ dwellMinutes: 3, transport: 'outbox', smtpTo: 'x@y.z' })
  assert.equal(config.dwellMinutes, 3)
  assert.equal(config.mail.transport, 'outbox')
  assert.deepEqual(config.mail.smtp.to, ['x@y.z'])
})

test('归一化仍保持原有校验与告警', () => {
  const negative = normalizeConfig({ dwellMinutes: -1 })
  assert.equal(negative.config.dwellMinutes, 0)
  assert.equal(negative.warnings.length, 1)

  const capped = normalizeConfig({ dwellMinutes: 10, maxDwellMinutes: 1 })
  assert.equal(capped.config.maxDwellMinutes, 10)
  assert.equal(capped.warnings.length, 1)

  const smtpWarn = normalizeConfig({ transport: 'smtp' }).warnings
  assert.ok(smtpWarn.some(w => w.includes('smtpHost')))
  assert.ok(smtpWarn.some(w => w.includes('smtpFrom')))
})

// ─────────────────── 命名空间注册 ───────────────────

test('registerSettings 用命名空间 + live 生效模式注册', () => {
  const ctx = fakeCtx()
  const scope = registerSettings(ctx, { log: () => {} })

  assert.equal(ctx.calls.length, 1)
  const [namespace, schema, options] = ctx.calls[0]
  assert.equal(namespace, NAMESPACE)
  assert.equal(schema, Config)
  assert.equal(options.applies, 'live', '必须是 live，否则改配置要重启')
  assert.deepEqual(options.base, { ...SETTINGS_DEFAULTS })
  assert.ok(scope)
})

test('settings 服务不可用只告警，不抛错', () => {
  const ctx = fakeCtx({ withSettings: false })
  assert.doesNotThrow(() => {
    assert.equal(registerSettings(ctx, { log: () => {} }), null)
  })
})

test('拿不到 schemastery 时跳过卡片，但不抛错', () => {
  const ctx = fakeCtx()
  assert.equal(registerSettings(ctx, { schema: null, log: () => {} }), null)
  assert.equal(ctx.calls.length, 0)
})

test('重复注册（already registered）被吞掉', () => {
  const ctx = fakeCtx()
  ctx.settings.register = () => { throw new Error('namespace "away-notify" already registered') }
  assert.doesNotThrow(() => {
    assert.equal(registerSettings(ctx, { log: () => {} }), null)
  })
})

test('注册失败不阻断插件挂载', () => {
  const ctx = fakeCtx()
  ctx.settings.register = () => { throw new Error('boom') }
  const logs = []
  assert.doesNotThrow(() => registerSettings(ctx, { log: (l, m) => logs.push([l, m]) }))
  assert.ok(logs.some(([level]) => level === 'error'))
})

test('即使插件被关掉，也要先把设置卡片注册上（否则没有 UI 入口再打开它）', () => {
  const ctx = fakeCtx()
  const instance = apply(ctx, { enabled: false })
  assert.equal(ctx.calls.length, 1, 'enabled=false 也必须注册设置命名空间')
  assert.equal(instance.notifier, null)
  instance.dispose()
})

// ─────────────────── 条件 ①：entry id === 命名空间 ───────────────────

test('cordis.patch.yml 的 entry id 必须等于命名空间名，name 必须是包名', () => {
  const yml = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')

  assert.match(yml, new RegExp(`^\\s*- id: ${NAMESPACE}\\s*$`, 'm'),
    `entry id 必须是 ${NAMESPACE}（DSH 靠 row.options.id === ns 定位设置目标）`)
  assert.match(yml, /^\s*name: dsh-away-notify\s*$/m, 'name 必须是包名')

  // 反向确认：不能残留旧的 id，否则设置保存会抛 No configurable plugin entry
  assert.doesNotMatch(yml, /^\s*- id: dsh-away-notify\s*$/m)
})

test('package.json 声明了 dsh.bundle.patch 与可选的 schemastery peer', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.peerDependenciesMeta?.['@deepseek-ai/schemastery']?.optional, true,
    'schemastery 是可降级的 peer，不能声明成硬依赖')
  assert.ok(pkg.files.includes('cordis.patch.yml'))
})
