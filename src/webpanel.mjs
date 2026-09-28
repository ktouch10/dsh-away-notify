import { PANEL_SCRIPT } from './panel-script.mjs'

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
  return PANEL_SCRIPT
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
