// 宿主自己服务一个配置面板。
//
// 为什么不走 `dsh.client`（原生设置页）：那条路要求客户端 bundle 是**用 CJS 模块系统包装的
// 已构建产物** —— 直接交 ESM 源码会让 DSH 起不来（真踩过，见 README「面板」一节）。
// 这条路全程是宿主端代码，出错最多是面板不显示。
//
// 桌面端（Electron）的现实，来自 dsh-whale-widget 的实测注释（issue #152/#153/#154）：
//
//   * 桌面壳的 index.html 从安装包静态 dist 直出（`dsh-app://app/`），**永远不经过宿主的
//     renderIndex()** ⇒ `tapIndex` 在桌面端**不生效**。
//   * 桌面端唯一的注入通道是 `webserver/index-inject` 事件推的**结构化行**，宿主启动时
//     `collectIndexInjections()` 收集一次、经 IPC 交给渲染层，**没有任何刷新路径**。
//   * 页面侧解释器对两种行**不对称**：
//       kind: 'script'      createElement + textContent + append —— 没有 await，不可能"加载失败"
//       kind: 'script-src'  await loadScript(src) —— 失败即 reject，而那个 reject 会 reject 掉
//                           __DSH_BOOT_READY__ ⇒ **整个应用起不来**
//
// 所以我们只用**内联 script 行**，而且由那段内联代码**自己**建 `<script src>` 并**吞掉 onerror**：
// 路由在就正常加载，路由不在就静默失败 —— 宿主永远不会因为我们起不来。
//
// 写入接口自带信任栅栏（回环 Host + 同源 Origin + 拒绝 Sec-Fetch-Site: cross-site），
// 防 DNS 重绑定与跨站写入。

export const PANEL_BASE = '/dsh-away-notify'
export const PANEL_SCRIPT_PATH = `${PANEL_BASE}/panel.js`
export const PANEL_STATE_PATH = `${PANEL_BASE}/state`
export const PANEL_SAVE_PATH = `${PANEL_BASE}/config`

/**
 * 桌面端的注入行：内联 + 自己吞掉 onerror。
 * 整段必须是一行、且不能出现 `</script>`（它会被当内联 script 的 textContent 插进去）。
 */
export const INDEX_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;'
  + `var s=document.createElement("script");s.src="${PANEL_SCRIPT_PATH}";`
  + 's.onerror=function(){};s.defer=true;d.appendChild(s)}catch(e){}})()'

/** 把注入行加进宿主推来的表里（去重）。挂到 `webserver/index-inject` 事件上，不依赖任何服务。 */
export function makeIndexRowHandler () {
  return table => {
    try {
      if (!Array.isArray(table)) return
      for (const row of table) {
        if (!row) continue
        if (row.kind === 'script' && typeof row.text === 'string' && row.text.includes(PANEL_SCRIPT_PATH)) return
        if (row.kind === 'script-src' && row.src === PANEL_SCRIPT_PATH) return
      }
      table.push({ kind: 'script', placement: 'body', text: INDEX_ROW_TEXT })
    } catch {
      // 注入表出问题也绝不能影响宿主
    }
  }
}

/** 只认回环：localhost / *.localhost / 127.0.0.0/8（逐段校验）/ ::1 */
export function isLoopbackHostname (hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  if (Number(m[1]) !== 127) return false
  return [m[2], m[3], m[4]].every(x => Number(x) <= 255)
}

/**
 * 信任栅栏。
 * @returns {number|null} 应当拒绝的状态码；null 表示放行。
 */
export function rejectionFor (req) {
  try {
    const headers = req?.headers ?? {}
    const site = String(headers['sec-fetch-site'] ?? '').toLowerCase()
    if (site === 'cross-site' || site === 'cross-origin') return 403

    let hostUrl = null
    try {
      hostUrl = new URL(`http://${String(headers.host ?? '')}`)
    } catch {
      return 403 // 缺 Host / 畸形
    }
    if (!isLoopbackHostname(hostUrl.hostname)) return 403

    const origin = headers.origin
    if (origin) {
      let originUrl = null
      try {
        originUrl = new URL(String(origin))
      } catch {
        return 403
      }
      if (originUrl.host !== hostUrl.host) return 403
    }
    return null
  } catch {
    return 403
  }
}

/** 浏览器端脚本。纯字符串下发 —— 不走任何构建，所以只能自己创建 DOM、不能 import。 */
export function panelScriptText () {
  return SCRIPT
}

/**
 * 注册面板路由。
 * @param {object} options
 * @param {object} options.webServer - 已就绪的 webServer 服务（有 register）
 * @param {() => object} options.readState - 产出下发状态
 * @param {(patch: object) => Promise<object>} options.writeState - 应用并持久化
 * @param {(level: string, message: string) => void} [options.log]
 * @returns {() => void} 卸载
 */
export function registerPanelRoutes ({ webServer, readState, writeState, log = () => {} }) {
  const disposers = []
  try {
    if (!webServer || typeof webServer.register !== 'function') {
      log('warn', 'webServer 不可用，面板路由未注册（面板不会显示）')
      return () => {}
    }

    const json = (res, code, body) => {
      const text = JSON.stringify(body)
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(text)
      })
      res.end(text)
    }

    const guard = (req, res) => {
      const code = rejectionFor(req)
      if (code === null) return false
      json(res, code, { error: '请求未通过信任栅栏（仅允许本机同源访问）' })
      return true
    }

    disposers.push(webServer.register({
      kind: 'exact',
      path: PANEL_SCRIPT_PATH,
      handler: (req, res) => {
        if (guard(req, res)) return
        const text = panelScriptText()
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(text)
        })
        res.end(text)
      }
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: PANEL_STATE_PATH,
      handler: (req, res) => {
        if (guard(req, res)) return
        if (String(req.method || 'GET').toUpperCase() !== 'GET') return json(res, 405, { error: '只支持 GET' })
        try {
          json(res, 200, readState())
        } catch (error) {
          json(res, 500, { error: `读取配置失败：${error?.message ?? error}` })
        }
      }
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: PANEL_SAVE_PATH,
      handler: async (req, res) => {
        if (guard(req, res)) return
        if (String(req.method || '').toUpperCase() !== 'POST') return json(res, 405, { error: '只支持 POST' })
        try {
          const body = await readBody(req, 256 * 1024)
          let parsed = null
          try {
            parsed = JSON.parse(body || '{}')
          } catch {
            return json(res, 400, { error: '请求体不是合法 JSON' })
          }
          const result = await writeState(parsed)
          json(res, 200, result)
        } catch (error) {
          json(res, 400, { error: `保存失败：${error?.message ?? error}` })
        }
      }
    }))

    log('info', `面板已注册：${PANEL_BASE}（打开界面后左下角会出现「提醒」按钮）`)
  } catch (error) {
    log('warn', `注册面板路由失败（面板不会显示，其余功能不受影响）：${error?.message ?? error}`)
  }

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* 卸载失败无所谓 */ }
    }
  }
}

function readBody (req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ───────────────────────── 浏览器端脚本 ─────────────────────────
// 纯字符串：没有任何 import / 构建步骤。字段描述由宿主下发，这里只负责渲染。

const SCRIPT = String.raw`(function () {
  if (window.__dshAwayNotifyPanel) return
  window.__dshAwayNotifyPanel = true
  var BASE = '/dsh-away-notify'
  var open = false
  var overlay = null

  function el(tag, style, text) {
    var n = document.createElement(tag)
    if (style) n.setAttribute('style', style)
    if (text != null) n.textContent = String(text)
    return n
  }

  var button = el('button', [
    'position:fixed', 'left:12px', 'bottom:12px', 'z-index:2147483000',
    'padding:4px 10px', 'border-radius:999px', 'cursor:pointer',
    'font:12px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif',
    'color:inherit', 'background:rgba(127,127,127,.16)',
    'border:1px solid rgba(127,127,127,.35)', 'opacity:.55'
  ].join(';'), '提醒')
  button.title = 'dsh-away-notify 设置'
  button.onmouseenter = function () { button.style.opacity = '1' }
  button.onmouseleave = function () { button.style.opacity = '.55' }
  button.onclick = function () { open ? close() : show() }

  function close() {
    open = false
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay)
    overlay = null
  }

  function show() {
    open = true
    overlay = el('div', [
      'position:fixed', 'inset:0', 'z-index:2147483001',
      'background:rgba(0,0,0,.35)', 'display:flex',
      'align-items:center', 'justify-content:center',
      'font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif'
    ].join(';'))
    var card = el('div', [
      'width:min(620px,92vw)', 'max-height:86vh', 'overflow:auto',
      'box-sizing:border-box', 'padding:16px 18px', 'border-radius:12px',
      'background:var(--dsw-alias-background-primary,#1e1e1e)',
      'color:inherit', 'border:1px solid rgba(127,127,127,.35)',
      'box-shadow:0 12px 40px rgba(0,0,0,.45)'
    ].join(';'))
    var status = el('div', 'min-height:18px;font-size:12px;opacity:.75;margin:6px 0 10px', '正在读取配置…')
    card.appendChild(el('div', 'font-weight:600;font-size:14px', 'dsh-away-notify 设置'))
    card.appendChild(el('div', 'font-size:11px;opacity:.6;margin-top:2px',
      '改完点保存即刻生效（改动静默时长会让待发提醒重新计时）'))
    card.appendChild(status)
    overlay.appendChild(card)
    overlay.onclick = function (e) { if (e.target === overlay) close() }
    document.body.appendChild(overlay)

    fetch(BASE + '/state', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json() })
      .then(function (state) {
        status.textContent = state.error || '已连接'
        render(card, status, state)
      })
      .catch(function (err) {
        status.textContent = '读取失败：' + (err && err.message ? err.message : err)
      })
  }

  function render(card, status, state) {
    var inputs = {}
    var groups = []
    ;(state.fields || []).forEach(function (f) {
      if (groups.indexOf(f.group) < 0) groups.push(f.group)
    })
    var overridden = {}
    ;(state.overridden || []).forEach(function (k) { overridden[k] = true })

    groups.forEach(function (group) {
      card.appendChild(el('div', 'margin:14px 0 6px;font-weight:600;font-size:13px', group))
      ;(state.fields || []).filter(function (f) { return f.group === group }).forEach(function (f) {
        var row = el('div', 'display:flex;gap:10px;align-items:flex-start;padding:3px 0')
        row.appendChild(el('label', 'flex:0 0 168px;font-size:13px;padding-top:4px', f.label))
        var right = el('div', 'flex:1;min-width:0')
        var line = el('div', 'display:flex;gap:8px;align-items:center;flex-wrap:wrap')
        var value = state.values ? state.values[f.key] : undefined
        var input
        if (f.type === 'boolean') {
          input = document.createElement('input')
          input.type = 'checkbox'
          input.checked = !!value
        } else if (f.type === 'select') {
          input = document.createElement('select')
          ;(f.options || []).forEach(function (opt) {
            var o = document.createElement('option')
            o.value = opt.value
            o.textContent = opt.text
            if (String(value) === String(opt.value)) o.selected = true
            input.appendChild(o)
          })
          input.style.minWidth = '200px'
        } else {
          input = document.createElement('input')
          input.type = f.type === 'secret' ? 'password' : (f.type === 'number' ? 'number' : 'text')
          input.value = f.type === 'secret' ? '' : (value == null ? '' : String(value))
          if (f.type === 'secret') input.placeholder = '留空即不修改'
          if (f.min != null) input.min = String(f.min)
          if (f.max != null) input.max = String(f.max)
          input.style.minWidth = '260px'
          input.style.color = 'inherit'
        }
        if (overridden[f.key]) {
          input.style.outline = '1px solid rgba(127,127,127,.5)'
        }
        inputs[f.key] = { spec: f, node: input }
        line.appendChild(input)
        right.appendChild(line)
        if (f.help) right.appendChild(el('div', 'font-size:11px;opacity:.6;margin-top:3px', f.help))
        row.appendChild(right)
        card.appendChild(row)
      })
    })

    var actions = el('div', 'display:flex;gap:10px;margin-top:16px;align-items:center')
    var save = el('button', 'padding:6px 16px;border-radius:8px;cursor:pointer;color:inherit;background:rgba(127,127,127,.18);border:1px solid rgba(127,127,127,.4)', '保存')
    var reset = el('button', 'padding:6px 12px;border-radius:8px;cursor:pointer;color:inherit;background:transparent;border:1px solid rgba(127,127,127,.35)', '清除全部覆盖')
    var closeBtn = el('button', 'margin-left:auto;padding:6px 12px;border-radius:8px;cursor:pointer;color:inherit;background:transparent;border:0', '关闭')
    actions.appendChild(save)
    actions.appendChild(reset)
    actions.appendChild(closeBtn)
    card.appendChild(actions)
    closeBtn.onclick = close

    save.onclick = function () {
      var patch = {}
      Object.keys(inputs).forEach(function (key) {
        var item = inputs[key]
        if (item.spec.type === 'boolean') patch[key] = item.node.checked
        else if (item.spec.type === 'secret') { if (item.node.value) patch[key] = item.node.value }
        else if (item.spec.type === 'number') { if (String(item.node.value).trim() !== '') patch[key] = Number(item.node.value) }
        else patch[key] = item.node.value
      })
      send(patch, status, '已保存')
    }

    reset.onclick = function () {
      if (!window.confirm('清除面板保存的所有覆盖，回到 cordis.patch.yml 的值？')) return
      var patch = {}
      ;(state.fields || []).forEach(function (f) { patch[f.key] = null })
      send(patch, status, '已清除')
    }
  }

  function send(patch, status, okText) {
    status.textContent = '正在保存…'
    fetch(BASE + '/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch)
    })
      .then(function (r) { return r.json() })
      .then(function (result) {
        if (result.error) { status.textContent = result.error; return }
        var extra = (result.rejected && result.rejected.length) ? '（忽略：' + result.rejected.join('；') + '）' : ''
        status.textContent = okText + extra + (result.needsRestart ? ' · 部分设置重启后生效' : '')
        close()
        show()
      })
      .catch(function (err) {
        status.textContent = '保存失败：' + (err && err.message ? err.message : err)
      })
  }

  function mount() {
    if (!document.body) { setTimeout(mount, 50); return }
    document.body.appendChild(button)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
  else mount()
})()`
