// 浏览器端面板脚本（作为字符串由宿主下发）。
//
// 为什么要单独一个文件：这段代码是**给浏览器**的，不是给 Node 的 —— 它不能 import、
// 不能有构建步骤（DSH 只服务文件、不打包）。把它隔离出来，宿主那边的路由/栅栏逻辑
// 就不会被这一大段字符串淹没。
//
// 两个设计约束：
//   * **不依赖宿主的任何 CSS 变量**。上一版用 `var(--dsw-alias-background-primary, …)`
//     做卡片背景，结果拿到的颜色和文字对不上，成了黑底黑字。现在改成自己注入 <style>，
//     并用**显式配色**；深浅按 body 实际背景亮度自动选（见 isDark）。
//   * 用 String.raw，所以脚本里**不能出现反引号和 `${`**（会被模板串解释掉）。

export const PANEL_SCRIPT = String.raw`(function () {
  if (window.__dshAwayNotifyPanel) return
  window.__dshAwayNotifyPanel = true

  var BASE = '/dsh-away-notify'
  var POS_KEY = 'dsh-away-notify:btn-pos'
  var STYLE_ID = 'dsh-away-notify-style'
  var overlay = null

  var CSS = [
    '#an-btn{position:fixed;left:12px;z-index:2147483000;display:inline-flex;align-items:center;gap:6px;',
    'padding:5px 12px;border-radius:999px;cursor:grab;user-select:none;-webkit-user-select:none;',
    'touch-action:none;font:12px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;',
    'opacity:.55;color:inherit;background:rgba(127,127,127,.18);border:1px solid rgba(127,127,127,.45);',
    'transition:opacity .15s,border-color .15s}',
    '#an-btn:hover{opacity:1}',
    '#an-btn.an-drag{cursor:grabbing;opacity:1}',
    '#an-ov{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;',
    'background:rgba(0,0,0,.45);font:13px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}',
    '#an-card{width:min(660px,94vw);max-height:88vh;overflow:auto;box-sizing:border-box;',
    'padding:18px 20px 14px;border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.45)}',
    'body.an-dark #an-card{background:#1c1c1e;color:#f2f2f4;border:1px solid #3a3a3e}',
    'body.an-light #an-card{background:#ffffff;color:#1b1b1f;border:1px solid #dcdce2}',
    '.an-head{display:flex;align-items:baseline;gap:10px}',
    '.an-title{font-size:15px;font-weight:600;margin:0}',
    '.an-sub{font-size:11px;opacity:.62;margin-top:3px;line-height:1.5}',
    '.an-status{min-height:17px;font-size:12px;opacity:.85;margin:10px 0 2px}',
    '.an-group{margin:16px 0 4px;font-size:11px;font-weight:600;letter-spacing:.06em;opacity:.6}',
    '.an-row{display:flex;gap:12px;align-items:flex-start;padding:5px 0}',
    '.an-label{flex:0 0 176px;font-size:13px;padding-top:5px;word-break:break-word}',
    '.an-right{flex:1;min-width:0}',
    '.an-help{font-size:11px;opacity:.6;margin-top:3px;line-height:1.5}',
    '.an-line{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
    '.an-input{box-sizing:border-box;padding:5px 8px;border-radius:8px;font:inherit;min-width:110px;max-width:100%}',
    'body.an-dark .an-input{background:#2a2a2e;color:#f2f2f4;border:1px solid #4a4a50}',
    'body.an-light .an-input{background:#fafafc;color:#1b1b1f;border:1px solid #d5d5dd}',
    '.an-input:focus{outline:2px solid #4c8dff;outline-offset:1px}',
    '.an-input.an-over{border-color:#4c8dff}',
    '.an-check{width:16px;height:16px;margin:4px 0 0}',
    '.an-hint{font-size:11px;opacity:.55}',
    '.an-foot{display:flex;gap:8px;align-items:center;margin-top:18px;padding-top:12px;',
    'border-top:1px solid rgba(127,127,127,.28)}',
    '.an-b{cursor:pointer;font:inherit;padding:6px 14px;border-radius:8px}',
    '.an-primary{background:#3b74f0;color:#fff;border:1px solid #3b74f0}',
    '.an-primary:hover{background:#3266dc}',
    '.an-ghost{background:transparent;border:1px solid rgba(127,127,127,.45);color:inherit}',
    '.an-ghost:hover{background:rgba(127,127,127,.14)}',
    '.an-spacer{margin-left:auto}'
  ].join('')

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return
    var s = document.createElement('style')
    s.id = STYLE_ID
    s.textContent = CSS
    ;(document.head || document.documentElement).appendChild(s)
  }

  // 按 body 实际背景的亮度选深浅 —— 不依赖任何宿主 CSS 变量，也就不会再黑底黑字
  function isDark() {
    try {
      var bg = getComputedStyle(document.body).backgroundColor
      var m = /rgba?\(\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)/.exec(bg || '')
      if (!m) return true
      var lum = (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255
      return lum < 0.5
    } catch (e) { return true }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = String(text)
    return n
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v) }

  function loadPos() {
    try { return JSON.parse(localStorage.getItem(POS_KEY) || 'null') } catch (e) { return null }
  }
  function savePos(p) {
    try { localStorage.setItem(POS_KEY, JSON.stringify(p)) } catch (e) {}
  }

  // ─────────────── 可拖动按钮 ───────────────

  var button = el('div', null, '提醒')
  button.id = 'an-btn'
  button.title = 'dsh-away-notify 设置（可拖动）'
  var drag = null

  function placeAt(x, y) {
    var w = button.offsetWidth || 60
    var h = button.offsetHeight || 26
    var nx = clamp(x, 4, Math.max(4, window.innerWidth - w - 4))
    var ny = clamp(y, 4, Math.max(4, window.innerHeight - h - 4))
    button.style.left = nx + 'px'
    button.style.top = ny + 'px'
    button.style.bottom = 'auto'
    return { left: nx, top: ny }
  }

  function currentPos() {
    return { left: button.offsetLeft, top: button.offsetTop }
  }

  button.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    var r = button.getBoundingClientRect()
    drag = {
      dx: e.clientX - r.left,
      dy: e.clientY - r.top,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      id: e.pointerId
    }
    button.classList.add('an-drag')
    try { button.setPointerCapture(e.pointerId) } catch (err) {}
    e.preventDefault()
  })

  button.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return
    // 「算不算拖动」要相对**按下点**判断 —— 放在 placeAt 之后比位置差是永远为 0 的
    if (Math.abs(e.clientX - drag.startX) > 3 || Math.abs(e.clientY - drag.startY) > 3) drag.moved = true
    placeAt(e.clientX - drag.dx, e.clientY - drag.dy)
    e.preventDefault()
  })

  function endDrag(e) {
    if (!drag || (e && e.pointerId !== drag.id)) return
    var moved = drag.moved
    drag = null
    button.classList.remove('an-drag')
    try { button.releasePointerCapture(e.pointerId) } catch (err) {}
    if (moved) savePos(currentPos())
    else toggle()
  }

  button.addEventListener('pointerup', endDrag)
  button.addEventListener('pointercancel', endDrag)

  window.addEventListener('resize', function () {
    var p = currentPos()
    placeAt(p.left, p.top)
  })

  // ─────────────── 面板 ───────────────

  function close() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay)
    overlay = null
    document.body.classList.remove('an-dark', 'an-light')
  }

  function toggle() { overlay ? close() : open() }

  function open() {
    injectStyle()
    document.body.classList.remove('an-dark', 'an-light')
    document.body.classList.add(isDark() ? 'an-dark' : 'an-light')

    overlay = el('div')
    overlay.id = 'an-ov'
    var card = el('div')
    card.id = 'an-card'

    var head = el('div', 'an-head')
    head.appendChild(el('h2', 'an-title', 'dsh-away-notify'))
    card.appendChild(head)
    card.appendChild(el('div', 'an-sub', '改完点保存即刻生效。改「静默时长」会让待发提醒重新计时。'))

    var status = el('div', 'an-status', '正在读取配置…')
    card.appendChild(status)
    overlay.appendChild(card)
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close() })
    document.body.appendChild(overlay)

    fetch(BASE + '/state', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json() })
      .then(function (state) {
        if (state.error) status.textContent = state.error
        else status.textContent = '已连接'
        render(card, status, state)
      })
      .catch(function (err) {
        status.textContent = '读取失败：' + (err && err.message ? err.message : String(err))
      })
  }

  function render(card, status, state) {
    var inputs = {}
    var groups = []
    var fields = state.fields || []
    var overridden = {}
    ;(state.overridden || []).forEach(function (k) { overridden[k] = true })

    fields.forEach(function (f) { if (groups.indexOf(f.group) < 0) groups.push(f.group) })

    groups.forEach(function (group) {
      card.appendChild(el('div', 'an-group', group))
      fields.filter(function (f) { return f.group === group }).forEach(function (f) {
        var row = el('div', 'an-row')
        row.appendChild(el('div', 'an-label', f.label))
        var right = el('div', 'an-right')
        var line = el('div', 'an-line')

        var value = state.values ? state.values[f.key] : undefined
        var input
        if (f.type === 'boolean') {
          input = document.createElement('input')
          input.type = 'checkbox'
          input.className = 'an-check'
          input.checked = !!value
        } else if (f.type === 'select') {
          input = document.createElement('select')
          input.className = 'an-input'
          ;(f.options || []).forEach(function (opt) {
            var o = document.createElement('option')
            o.value = opt.value
            o.textContent = opt.text
            if (String(value) === String(opt.value)) o.selected = true
            input.appendChild(o)
          })
        } else {
          input = document.createElement('input')
          input.className = 'an-input'
          input.type = f.type === 'secret' ? 'password' : (f.type === 'number' ? 'number' : 'text')
          input.value = f.type === 'secret' ? '' : (value == null ? '' : String(value))
          if (f.type === 'secret') input.placeholder = '留空即不修改'
          if (f.min != null) input.min = String(f.min)
          if (f.max != null) input.max = String(f.max)
        }
        if (overridden[f.key]) input.classList.add('an-over')
        inputs[f.key] = { spec: f, node: input }

        line.appendChild(input)
        if (f.type === 'secret') line.appendChild(el('span', 'an-hint', '不回传浏览器'))
        right.appendChild(line)
        if (f.help) right.appendChild(el('div', 'an-help', f.help))
        row.appendChild(right)
        card.appendChild(row)
      })
    })

    var foot = el('div', 'an-foot')
    var save = el('button', 'an-b an-primary', '保存')
    save.type = 'button'
    var reset = el('button', 'an-b an-ghost', '清除全部覆盖')
    reset.type = 'button'
    var closeBtn = el('button', 'an-b an-ghost an-spacer', '关闭')
    closeBtn.type = 'button'
    foot.appendChild(save)
    foot.appendChild(reset)
    foot.appendChild(closeBtn)
    card.appendChild(foot)
    closeBtn.addEventListener('click', close)

    save.addEventListener('click', function () {
      var patch = {}
      Object.keys(inputs).forEach(function (key) {
        var item = inputs[key]
        if (item.spec.type === 'boolean') patch[key] = item.node.checked
        else if (item.spec.type === 'secret') { if (item.node.value) patch[key] = item.node.value }
        else if (item.spec.type === 'number') {
          if (String(item.node.value).trim() !== '') patch[key] = Number(item.node.value)
        } else patch[key] = item.node.value
      })
      send(patch, status, '已保存')
    })

    reset.addEventListener('click', function () {
      if (!window.confirm('清除面板保存的所有覆盖，回到 cordis.patch.yml 的值？')) return
      var patch = {}
      fields.forEach(function (f) { patch[f.key] = null })
      send(patch, status, '已清除')
    })
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
        open()
      })
      .catch(function (err) {
        status.textContent = '保存失败：' + (err && err.message ? err.message : String(err))
      })
  }

  function mount() {
    if (!document.body) { setTimeout(mount, 50); return }
    injectStyle()
    var saved = loadPos()
    document.body.appendChild(button)
    if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') placeAt(saved.left, saved.top)
    else placeAt(12, window.innerHeight - (button.offsetHeight || 26) - 12)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
  else mount()
})()`
