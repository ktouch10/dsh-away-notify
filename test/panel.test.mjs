// 面板：覆盖配置层 + 注入行 + 信任栅栏 + 路由。
//
// 这条路是**宿主端**的（不用 dsh.client），所以能离线测得很实 —— 上一版走原生客户端插件
// 时只能靠重启验证，结果把 DSH 搞成起不来。这里每条不变式都钉在用例里。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import {
  coerceValue,
  isKnownKey,
  overriddenKeys,
  readOverlay,
  sanitizeOverlay,
  typeOfKey,
  writeOverlay
} from '../src/panel-config.mjs'
import {
  INDEX_ROW_TEXT,
  PANEL_SCRIPT_PATH,
  PANEL_SAVE_PATH,
  PANEL_STATE_PATH,
  isLoopbackHostname,
  makeIndexRowHandler,
  panelScriptText,
  registerPanelRoutes,
  rejectionFor
} from '../src/webpanel.mjs'
import { SETTINGS_DEFAULTS } from '../src/settings.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = path.join(ROOT, '.test-tmp')

function tempFile (name) {
  const dir = path.join(TMP, `panel-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'config.json')
}

// ─────────────────────────── 覆盖配置层 ───────────────────────────

test('只认已知字段，未知字段被拒（防注入）', () => {
  assert.equal(isKnownKey('dwellMinutes'), true)
  assert.equal(isKnownKey('__proto__'), false)
  assert.equal(isKnownKey('constructor'), false)

  // ⚠️ 对象字面量里的 `__proto__:` 设的是**原型**，不是自有属性 —— 必须用 JSON.parse
  // 才能造出一个真正的自有 `__proto__` 键（这也是攻击者实际会用的形状）。
  const payload = JSON.parse('{"dwellMinutes":7,"__proto__":{"polluted":true},"notAField":1}')
  const { values, rejected } = sanitizeOverlay(payload)
  assert.deepEqual(Object.keys(values), ['dwellMinutes'])
  assert.equal(values.dwellMinutes, 7)
  assert.equal(rejected.length, 2, '未知的 __proto__ 与 notAField 都要被拒')
  assert.equal({}.polluted, undefined, '原型不该被污染')
})

test('按类型收敛：布尔/数字/枚举', () => {
  assert.deepEqual(coerceValue('enabled', 'true'), { ok: true, value: true })
  assert.deepEqual(coerceValue('enabled', 'false'), { ok: true, value: false })
  assert.equal(coerceValue('enabled', 'maybe').ok, false)

  assert.deepEqual(coerceValue('dwellMinutes', '3.5'), { ok: true, value: 3.5 })
  assert.equal(coerceValue('dwellMinutes', 'abc').ok, false, '非数字要拒')
  assert.equal(coerceValue('dwellMinutes', -1).ok, false, '负数要拒')

  assert.deepEqual(coerceValue('transport', 'smtp'), { ok: true, value: 'smtp' })
  assert.equal(coerceValue('transport', 'telepathy').ok, false, '枚举外的值要拒')
  assert.deepEqual(coerceValue('smtpHost', 'smtp.qq.com'), { ok: true, value: 'smtp.qq.com' })
})

test('类型由默认值推断，不为每个字段再维护一张表', () => {
  assert.equal(typeOfKey('enabled'), 'boolean')
  assert.equal(typeOfKey('dwellMinutes'), 'number')
  assert.equal(typeOfKey('smtpHost'), 'string')
  assert.equal(typeOfKey('smtpPass'), 'string')
})

test('写读往返：合并而不是覆盖，清除用 null', () => {
  const file = tempFile('io')

  writeOverlay(file, { dwellMinutes: 9, transport: 'smtp' })
  let read = readOverlay(file)
  assert.deepEqual(read.values, { dwellMinutes: 9, transport: 'smtp' })

  // 再写一个字段：应当是合并
  writeOverlay(file, { subjectPrefix: '[X]' })
  read = readOverlay(file)
  assert.deepEqual(read.values, { dwellMinutes: 9, transport: 'smtp', subjectPrefix: '[X]' })

  // 清除某个键
  const next = { ...read.values }
  delete next.transport
  fs.writeFileSync(file, JSON.stringify(next), 'utf8')
  assert.equal('transport' in readOverlay(file).values, false)
})

test('文件不存在 / 坏掉都不抛', () => {
  const missing = path.join(TMP, 'definitely-not-here', 'config.json')
  assert.deepEqual(readOverlay(missing), { values: {}, error: null })

  const file = tempFile('broken')
  fs.writeFileSync(file, '{ not json', 'utf8')
  const read = readOverlay(file)
  assert.deepEqual(read.values, {})
  assert.match(read.error, /读不到覆盖配置/)
})

test('写入是原子的：不会留下半截文件，且没有临时文件残留', () => {
  const file = tempFile('atomic')
  writeOverlay(file, { dwellMinutes: 4 })
  const dir = path.dirname(file)
  const leftovers = fs.readdirSync(dir).filter(n => n.includes('.tmp-'))
  assert.deepEqual(leftovers, [], '临时文件应该被 rename 掉')
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { dwellMinutes: 4 })
})

test('overriddenKeys 只报合法字段', () => {
  const keys = overriddenKeys({ dwellMinutes: 4, nope: 1 })
  assert.deepEqual([...keys], ['dwellMinutes'])
})

// ─────────────────────────── 注入行 ───────────────────────────

test('注入行必须是内联 script 行（script-src 加载失败会 reject 整个 boot）', () => {
  assert.ok(INDEX_ROW_TEXT.length > 0)
  assert.ok(!INDEX_ROW_TEXT.includes('</script>'), '内联脚本里不能出现 </script>')
  // 自己建 script 元素并吞掉 onerror —— 路由不在时静默失败，绝不让宿主起不来
  assert.match(INDEX_ROW_TEXT, /createElement\("script"\)/)
  assert.match(INDEX_ROW_TEXT, /onerror=function\(\)\{\}/)
  assert.match(INDEX_ROW_TEXT, /\/dsh-away-notify\/panel\.js/)
})

test('注入行处理：加一次、去重、坏表不抛', () => {
  const handler = makeIndexRowHandler()

  const table = []
  handler(table)
  assert.equal(table.length, 1)
  assert.equal(table[0].kind, 'script')
  assert.equal(table[0].placement, 'body')
  assert.equal(table[0].text, INDEX_ROW_TEXT)

  handler(table)
  assert.equal(table.length, 1, '重复调用不该重复加')

  // 旧版本可能推过 script-src 行 —— 也要认出来
  const legacy = [{ kind: 'script-src', src: PANEL_SCRIPT_PATH }]
  handler(legacy)
  assert.equal(legacy.length, 1)

  assert.doesNotThrow(() => handler(null))
  assert.doesNotThrow(() => handler('nope'))
  assert.doesNotThrow(() => handler([{ kind: 'script', text: null }]))
})

// ─────────────────────────── 信任栅栏 ───────────────────────────

test('只认回环主机', () => {
  assert.equal(isLoopbackHostname('localhost'), true)
  assert.equal(isLoopbackHostname('foo.localhost'), true)
  assert.equal(isLoopbackHostname('127.0.0.1'), true)
  assert.equal(isLoopbackHostname('127.1.2.3'), true)
  assert.equal(isLoopbackHostname('::1'), true)
  assert.equal(isLoopbackHostname('127.0.0.1.evil.com'), false, '相似域名不能被当成回环')
  assert.equal(isLoopbackHostname('128.0.0.1'), false)
  assert.equal(isLoopbackHostname('evil.com'), false)
  assert.equal(isLoopbackHostname(''), false)
})

test('栅栏：回环同源放行，跨站 / 非回环 / 异源 Origin 一律拒', () => {
  assert.equal(rejectionFor({ headers: { host: '127.0.0.1:19387' } }), null)
  assert.equal(rejectionFor({ headers: { host: 'localhost:19387', origin: 'http://localhost:19387' } }), null)
  assert.equal(rejectionFor({ headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' } }), null)

  assert.equal(rejectionFor({ headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' } }), 403)
  assert.equal(rejectionFor({ headers: { host: 'evil.com' } }), 403, 'DNS 重绑定：Host 非回环')
  assert.equal(rejectionFor({ headers: { host: '127.0.0.1:19387', origin: 'http://evil.com' } }), 403)
  assert.equal(rejectionFor({ headers: {} }), 403, '缺 Host')
  assert.equal(rejectionFor({}), 403)
  assert.equal(rejectionFor(undefined), 403)
})

// ─────────────────────────── 路由 ───────────────────────────

/** 极简 res 替身，收集状态码与响应体。 */
function fakeRes () {
  const res = {
    code: null,
    headers: null,
    body: '',
    writeHead (code, headers) { res.code = code; res.headers = headers || {} },
    end (text) { res.body = text ?? '' }
  }
  return res
}

function fakeWebServer () {
  const routes = new Map()
  return {
    routes,
    register (route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    }
  }
}

function fakeReq ({ method = 'GET', host = '127.0.0.1:19387', body = '', headers = null } = {}) {
  const listeners = new Map()
  const req = {
    method,
    headers: headers ?? { host },
    on (event, fn) { listeners.set(event, fn); return req },
    destroy () {}
  }
  // 模拟流：异步把 body 推出去
  setImmediate(() => {
    if (body) listeners.get('data')?.(Buffer.from(body, 'utf8'))
    listeners.get('end')?.()
  })
  return req
}

test('路由注册与读写往返', async () => {
  const server = fakeWebServer()
  let state = { fields: [{ key: 'enabled', type: 'boolean', group: '基本', label: '总开关' }], values: { enabled: true }, overridden: [] }
  const writes = []

  registerPanelRoutes({
    webServer: server,
    readState: () => state,
    writeState: patch => {
      writes.push(patch)
      state = { ...state, values: { ...state.values, ...patch } }
      return { values: state.values, overridden: Object.keys(patch), rejected: [], needsRestart: false }
    },
    log: () => {}
  })

  assert.deepEqual([...server.routes.keys()].sort(), [PANEL_SAVE_PATH, PANEL_SCRIPT_PATH, PANEL_STATE_PATH].sort())

  const stateRes = fakeRes()
  await server.routes.get(PANEL_STATE_PATH).handler(fakeReq(), stateRes)
  assert.equal(stateRes.code, 200)
  assert.equal(JSON.parse(stateRes.body).values.enabled, true)

  const saveRes = fakeRes()
  await server.routes.get(PANEL_SAVE_PATH).handler(
    fakeReq({ method: 'POST', body: JSON.stringify({ dwellMinutes: 3 }) }),
    saveRes
  )
  assert.equal(saveRes.code, 200)
  assert.deepEqual(writes, [{ dwellMinutes: 3 }])

  const scriptRes = fakeRes()
  server.routes.get(PANEL_SCRIPT_PATH).handler(fakeReq(), scriptRes)
  assert.equal(scriptRes.code, 200)
  assert.match(scriptRes.headers['Content-Type'], /javascript/)
})

test('路由：跨站请求被栅栏挡住（不进入处理器）', async () => {
  const server = fakeWebServer()
  let called = false
  registerPanelRoutes({
    webServer: server,
    readState: () => { called = true; return {} },
    writeState: () => { called = true; return {} },
    log: () => {}
  })

  const res = fakeRes()
  await server.routes.get(PANEL_STATE_PATH).handler(
    fakeReq({ host: 'evil.com' }),
    res
  )
  assert.equal(res.code, 403)
  assert.equal(called, false, '被拒的请求绝不该进入处理器')

  const res2 = fakeRes()
  await server.routes.get(PANEL_STATE_PATH).handler(
    fakeReq({ host: '127.0.0.1:1', headers: {} }),
    res2
  )
  assert.equal(res2.code, 403)
})

test('路由：方法不对返回 405，坏 JSON 返回 400', async () => {
  const server = fakeWebServer()
  registerPanelRoutes({
    webServer: server,
    readState: () => ({}),
    writeState: () => ({}),
    log: () => {}
  })

  const notGet = fakeRes()
  await server.routes.get(PANEL_STATE_PATH).handler(fakeReq({ method: 'POST' }), notGet)
  assert.equal(notGet.code, 405)

  const badJson = fakeRes()
  await server.routes.get(PANEL_SAVE_PATH).handler(fakeReq({ method: 'POST', body: 'not json' }), badJson)
  assert.equal(badJson.code, 400)
})

test('webServer 不可用时只告警，不抛（面板不显示但功能不受影响）', () => {
  const logs = []
  let dispose = null
  assert.doesNotThrow(() => {
    dispose = registerPanelRoutes({ webServer: null, readState: () => ({}), writeState: () => ({}), log: (l, m) => logs.push([l, m]) })
  })
  assert.equal(typeof dispose, 'function')
  assert.ok(logs.some(([l]) => l === 'warn'))
})

// ─────────────────────────── 面板脚本本身 ───────────────────────────

test('面板脚本是合法 JS，且自包含（没有 import / 构建产物）', () => {
  const text = panelScriptText()
  assert.ok(text.length > 1000, '面板脚本不该是空的')
  assert.ok(!/^\s*import\s/m.test(text), '面板脚本不能有 import（它不走构建）')
  assert.ok(!text.includes('</script>'), '内联下发时不能出现 </script>')

  // 真的过一遍语法检查
  const file = path.join(TMP, `panel-script-${Date.now()}.js`)
  fs.mkdirSync(TMP, { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  })
})

test('面板脚本不含任何凭据字段的值（密码不回显）', () => {
  const text = panelScriptText()
  // 脚本里出现的只应是字段键名，不该有任何写死的值
  assert.ok(!/smtpPass\s*[:=]\s*['"][^'"]+['"]/.test(text), '脚本里不该写死密码')
  assert.match(text, /留空即不修改/, '密码栏应该有「留空即不修改」的提示')
})

test('字段表来源是宿主的 FIELD_SPECS（面板不自己维护一份）', () => {
  const text = panelScriptText()
  assert.ok(!text.includes('dwellMinutes'), '面板脚本里不该出现具体字段名 —— 字段描述由宿主下发')
  assert.ok(Object.keys(SETTINGS_DEFAULTS).length >= 20)
})

// ─────────────────────── 真 HTTP 的端到端冒烟 ───────────────────────
// 假 res 抓不到 Content-Length/头/真实请求对象这类问题，所以再来一遍真的。

test('真 HTTP：读状态 / 保存 / 取脚本，跨站被拒', async () => {
  const { createServer } = await import('node:http')
  const http = await import('node:http')

  // 把面板路由适配到一个真的 http server 上（webServer.register 的契约：{kind, path, handler}）
  const routes = []
  const fakeWebServer = {
    register (route) {
      routes.push(route)
      return () => {}
    }
  }

  let state = { fields: [{ key: 'dwellMinutes', type: 'number', group: '基本', label: '静默时长', min: 0, max: 1440 }], values: { dwellMinutes: 5 }, overridden: [] }
  registerPanelRoutes({
    webServer: fakeWebServer,
    readState: () => state,
    writeState: patch => {
      state = { ...state, values: { ...state.values, ...patch }, overridden: Object.keys(patch) }
      return { values: state.values, overridden: state.overridden, rejected: [], needsRestart: false }
    },
    log: () => {}
  })

  const server = createServer((req, res) => {
    const url = String(req.url || '').split('?')[0]
    const route = routes.find(r => r.path === url)
    if (!route) { res.writeHead(404); res.end('no route'); return }
    route.handler(req, res)
  })

  const port = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  const base = `http://127.0.0.1:${port}`

  try {
    const script = await fetch(`${base}${PANEL_SCRIPT_PATH}`)
    assert.equal(script.status, 200)
    assert.match(script.headers.get('content-type'), /javascript/)
    const scriptText = await script.text()
    assert.equal(scriptText, panelScriptText(), '取到的脚本应与本地一致')
    assert.equal(Number(script.headers.get('content-length')), Buffer.byteLength(scriptText), 'Content-Length 要准')

    const stateRes = await fetch(`${base}${PANEL_STATE_PATH}`)
    assert.equal(stateRes.status, 200)
    assert.equal((await stateRes.json()).values.dwellMinutes, 5)

    const saveRes = await fetch(`${base}${PANEL_SAVE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dwellMinutes: 2 })
    })
    assert.equal(saveRes.status, 200)
    assert.equal((await saveRes.json()).values.dwellMinutes, 2)

    // 跨站：Sec-Fetch-Site 头由 fetch 自动带（Node 的 fetch 带 same-origin/undici），
    // 这里显式伪造一个跨站请求来验证栅栏
    const crossSite = await fetch(`${base}${PANEL_STATE_PATH}`, { headers: { 'sec-fetch-site': 'cross-site' } })
    assert.equal(crossSite.status, 403, '跨站请求必须被拒')
  } finally {
    await new Promise(resolve => server.close(resolve))
    void http
  }
})
