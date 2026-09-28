// dsh-away-notify —— 客户端半边（浏览器侧）。
//
// 为什么需要它：DSH 的设置表单**不是**宿主半边能生成的。装进真实 DSH 后卡片上只有
// 「完整名称 / 配置状态 / 运行状态」三行 —— 拿装了半年的 qq-mode-console 做对照也一样，
// 它的注释写着「本插件没有 browser/client 半，不会自动生成 WebUI 设置卡片」。
//
// 机制（读 DSH 打包产物里的实现与文档确认，不是猜的）：
//   * package.json 里声明 `dsh.client`，浏览器半边放在 `exports["./client"]`
//     —— 「the browser half ships via exports['./client'], discovered through the
//        package.json dsh.client declaration」
//   * DSH 有个 `clientModules` 服务做「incremental dsh.client scan + bundle route」，
//     即**运行时扫描，不需要重建 Web 产物**
//   * 它只**服务**文件、不打包（`clientPath(id)` 返回「entry's client bundle」的绝对路径，
//     `rebuilt(id)` 是外部构建器的注册钩子）⇒ 所以本文件必须**自包含**：
//     除了 react，不 import 任何东西（相对导入不会被解析）
//
// 注册到设置页：「插件」分区承载 `settings.plugins.tab` 这个 list slot。
// 官方文档给的示例形状就是下面 apply 里那段：
//     ctx.slots.inject(SLOT, () => ctx.slots.register({ name: SLOT, id, order, label }, Component))
// 而且 `label` 可以是 thunk（每次投影重读，便于跟随语言切换）。
//
// 命名空间用 `whileServed` 跟随：宿主没装本插件时，设置页里不会留下任何痕迹
// （官方那几个配置页也走这条路）。
//
// ⚠️ 这个文件里的一切都**不能抛**：客户端插件加载失败会在启动审计里报成
// FAILED fiber，把插件整体搞成「启动失败」。所以 apply 全程 try/catch，
// 组件还会把出错原因**渲染在面板里**（而不是白屏）。
//
// ⚠️ FIELDS 必须与 src/settings.mjs 的 schema 一致（键、顺序、标签、默认值）。
//    这条由 test/client.test.mjs 断言，改了一边不改另一边会红。

import React from 'react'

export const NAMESPACE = 'away-notify'
export const SLOT = 'settings.plugins.tab'

/**
 * 表单字段表 —— 必须是严格 JSON 字面量（测试会原样 JSON.parse 它）。
 * 键集合必须与 src/settings.mjs 的 schema 一致；数组内的顺序决定同一个分组里的先后。
 */
export const FIELDS = [
  { "key": "enabled", "type": "boolean", "group": "基本", "label": "总开关", "help": "关掉后完全不监听事件，但设置页仍可打开" },
  { "key": "dwellMinutes", "type": "number", "group": "基本", "min": 0, "max": 1440, "label": "静默时长（分钟）", "help": "核心旋钮：回合结束后安静这么多分钟仍无用户消息，才提醒。0 = 退化成「干完就发」" },
  { "key": "maxDwellMinutes", "type": "number", "group": "基本", "min": 1, "max": 1440, "label": "最晚推迟（分钟）", "help": "同一批工作反复续跑时，提醒最晚推迟到「首个回合结束 + 这么多分钟」" },
  { "key": "tickSeconds", "type": "number", "group": "基本", "min": 1, "max": 600, "label": "轮询间隔（秒）", "help": "内部多久检查一次到没到点。不影响提醒时机，只影响精度" },
  { "key": "cancelOnUserMessage", "type": "boolean", "group": "触发规则", "label": "真人回话就撤销", "help": "真正的用户消息会撤销待发提醒（DSH 注入的非人类消息不算）" },
  { "key": "cancelOnTurnStart", "type": "boolean", "group": "触发规则", "label": "开新回合也撤销", "help": "默认关闭。目标续跑与后台唤醒都会开新回合，开了这个提醒会被系统行为不断撤销" },
  { "key": "minToolCalls", "type": "number", "group": "触发规则", "min": 0, "max": 1000, "label": "最少工具调用次数", "help": "低于这个次数的批次静默。0 = 关闭该规则" },
  { "key": "suppressEmptyTurns", "type": "boolean", "group": "触发规则", "label": "空回合不提醒", "help": "既没有工具调用、也没有回复文本的空回合不提醒" },
  { "key": "transport", "type": "select", "group": "投递", "options": [["outbox", "outbox（落盘，零配置）"], ["smtp", "smtp（真的发邮件）"]], "label": "通道", "help": "outbox 落盘适合先验证；smtp 才会真的发信" },
  { "key": "outboxDir", "type": "text", "group": "投递", "label": "落盘目录", "help": "留空 = ~/.dsh/dsh-away-notify/outbox" },
  { "key": "subjectPrefix", "type": "text", "group": "投递", "label": "主题前缀", "help": "邮件主题前缀" },
  { "key": "language", "type": "select", "group": "投递", "options": [["zh", "中文"], ["en", "English"]], "label": "邮件语言", "help": "只影响邮件正文，不影响这个界面" },
  { "key": "excerptChars", "type": "number", "group": "投递", "min": 0, "max": 20000, "label": "附带回复字数", "help": "正文里附带「最后一段回复」的最大字符数。0 = 不附带" },
  { "key": "smtpHost", "type": "text", "group": "SMTP", "label": "服务器", "help": "例如 smtp.qq.com" },
  { "key": "smtpPort", "type": "number", "group": "SMTP", "min": 1, "max": 65535, "label": "端口", "help": "465（隐式 TLS）/ 587（STARTTLS）" },
  { "key": "smtpSecure", "type": "boolean", "group": "SMTP", "label": "隐式 TLS", "help": "465 端口通常是 true，587 通常是 false" },
  { "key": "smtpUser", "type": "text", "group": "SMTP", "label": "登录账号", "help": "QQ 邮箱就是完整地址" },
  { "key": "smtpPass", "type": "secret", "group": "SMTP", "label": "密码 / 授权码", "help": "明文落盘有风险，建议留空改用下面那个环境变量。标了 secret，主机端不会把它回传给浏览器" },
  { "key": "smtpPassEnv", "type": "text", "group": "SMTP", "label": "密码所在环境变量", "help": "留空则只认上面那一栏" },
  { "key": "smtpFrom", "type": "text", "group": "SMTP", "label": "发件人", "help": "留空 = 用登录账号" },
  { "key": "smtpTo", "type": "text", "group": "SMTP", "label": "收件人", "help": "多个用逗号分隔。留空 = 发给自己" },
  { "key": "allowInsecureAuth", "type": "boolean", "group": "SMTP", "label": "允许明文认证", "help": "仅限本地测试服务器。生产环境不要开" }
]

/**
 * 需要的服务。
 *
 * ⚠️ 少了这个，下面 `ctx.slots` / `ctx.configForms` 的**属性读取本身**就会抛
 * `cannot get property "x" without inject`（cordis 的 ctx 是 Proxy）——
 * 宿主半边当初就是踩了这个才显示「启动失败」。
 */
export const inject = ['slots', 'configForms']

const GROUPS = ['基本', '触发规则', '投递', 'SMTP']

/** 把 snapshot.value 里的值转成输入框能吃的形状。 */
function asInputValue (value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return String(value)
  return String(value)
}

/** 输入 → 要写回的 JSON 值（按字段类型收敛）。 */
function asStoredValue (field, raw, checked) {
  if (field.type === 'boolean') return Boolean(checked)
  if (field.type === 'number') {
    // 输入框被清空时不要写 0 —— 那会在用户还没输完时就把配置改掉
    if (String(raw).trim() === '') return undefined
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  }
  return String(raw)
}

/**
 * form 还没就绪时的占位快照。
 * 必须是**同一个对象引用** —— useSyncExternalStore 的 getSnapshot 每次返回新对象会被
 * React 判成「无限变化」并直接抛错（这条测试抓不到，只能靠想清楚）。
 */
const LOADING_SNAPSHOT = Object.freeze({
  status: 'loading',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
  mode: 'memory'
})

const el = React.createElement

/**
 * 面板组件工厂。
 * @param getForm - 返回当前 ConfigForm 的函数（延迟取，避免注册时还没就绪）
 */
function createPanel (getForm) {
  return function AwayNotifyPanel () {
    // useSyncExternalStore：getSnapshot 在两次变更之间必须返回稳定引用（契约里有保证）
    const form = getForm()
    const subscribe = React.useCallback(
      listener => (form ? form.subscribe(listener) : () => {}),
      [form]
    )
    const getSnapshot = React.useCallback(
      () => (form ? form.getSnapshot() : LOADING_SNAPSHOT),
      [form]
    )
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot)
    const [note, setNote] = React.useState('')

    const status = snapshot?.status ?? 'loading'
    const value = snapshot?.value ?? {}
    const writable = Boolean(snapshot?.writable)
    const user = snapshot?.user && typeof snapshot.user === 'object' ? snapshot.user : {}

    const write = (key, next) => {
      if (!form) return
      if (next === undefined) {
        // 数字框被清空 / 输到一半：不写，等用户输完
        setNote(`${key}：还没输完，暂不保存`)
        return
      }
      setNote(`正在保存 ${key}…`)
      Promise.resolve(form.set(key, next))
        .then(ok => setNote(ok ? `已保存 ${key}` : `${key} 被宿主拒绝（已回到最新值）`))
        .catch(error => setNote(`保存 ${key} 失败：${error?.message ?? error}`))
    }

    const clear = key => {
      if (!form) return
      setNote(`正在恢复 ${key}…`)
      Promise.resolve(form.unset(key))
        .then(ok => setNote(ok ? `${key} 已恢复默认` : `${key} 恢复被拒绝`))
        .catch(error => setNote(`恢复 ${key} 失败：${error?.message ?? error}`))
    }

    const head = el('div', { style: { marginBottom: 10, fontSize: 12, opacity: 0.75 } },
      status === 'ready' && writable
        ? `命名空间 ${NAMESPACE} · 已连接（revision ${snapshot?.revision ?? '?'}，${snapshot?.mode ?? '?'}）`
        : status === 'ready'
          ? `命名空间 ${NAMESPACE} · 只读`
          : status === 'unavailable'
            ? `命名空间 ${NAMESPACE} 在这个客户端不可写（远程页面通常如此）`
            : '正在读取配置…'
    )

    const rows = []
    for (const group of GROUPS) {
      rows.push(el('div', {
        key: `g-${group}`,
        style: { margin: '14px 0 6px', fontWeight: 600, fontSize: 13, opacity: 0.9 }
      }, group))

      for (const field of FIELDS.filter(f => f.group === group)) {
        const current = value[field.key]
        const overridden = Object.prototype.hasOwnProperty.call(user, field.key)
        const disabled = !writable || status !== 'ready'

        let control
        if (field.type === 'boolean') {
          control = el('input', {
            type: 'checkbox',
            checked: Boolean(current),
            disabled,
            onChange: event => write(field.key, asStoredValue(field, '', event.target.checked))
          })
        } else if (field.type === 'select') {
          control = el('select', {
            value: asInputValue(current),
            disabled,
            onChange: event => write(field.key, event.target.value),
            style: { minWidth: 200, color: 'inherit' }
          }, (field.options ?? []).map(([v, text]) => el('option', { key: v, value: v }, text)))
        } else {
          control = el('input', {
            type: field.type === 'secret' ? 'password' : field.type === 'number' ? 'number' : 'text',
            value: field.type === 'secret' ? '' : asInputValue(current),
            placeholder: field.type === 'secret' ? '（留空即不修改）' : '',
            min: field.min,
            max: field.max,
            disabled,
            onChange: event => write(field.key, asStoredValue(field, event.target.value, false)),
            style: { minWidth: 260, color: 'inherit' }
          })
        }

        rows.push(el('div', {
          key: field.key,
          style: { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '4px 0' }
        },
        el('label', { style: { flex: '0 0 168px', fontSize: 13, paddingTop: 3 } }, field.label),
        el('div', { style: { flex: 1, minWidth: 0 } },
          el('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            control,
            field.type === 'secret'
              ? el('span', { style: { fontSize: 11, opacity: 0.6 } }, '不回传浏览器，留空不改')
              : null,
            overridden && !disabled
              ? el('button', {
                type: 'button',
                onClick: () => clear(field.key),
                style: { fontSize: 11, cursor: 'pointer' }
              }, '恢复默认')
              : null
          ),
          field.help ? el('div', { style: { fontSize: 11, opacity: 0.6, marginTop: 3, lineHeight: 1.5 } }, field.help) : null
        )))
      }
    }

    return el('div', { style: { padding: '4px 2px 18px', fontSize: 13 } },
      el('div', { style: { marginBottom: 4, fontWeight: 600 } }, 'dsh-away-notify'),
      head,
      note ? el('div', { style: { fontSize: 12, marginBottom: 6, opacity: 0.85 } }, note) : null,
      disabledHint(status, writable),
      ...rows,
      el('div', { style: { marginTop: 16, fontSize: 11, opacity: 0.55, lineHeight: 1.6 } },
        '改完立即生效（applies: live），不用重启。',
        el('br'),
        '排查「为什么没收到提醒」：看 ~/.dsh/dsh-away-notify/status.log'
      )
    )
  }
}

function disabledHint (status, writable) {
  if (status === 'ready' && writable) return null
  return el('div', {
    style: {
      fontSize: 12, padding: '6px 8px', marginBottom: 8,
      border: '1px solid currentColor', borderRadius: 6, opacity: 0.8
    }
  }, status === 'loading'
    ? '正在从宿主读取配置，稍等…'
    : status === 'unavailable'
      ? '宿主没有向这个客户端开放该命名空间（或当前是非 loopback 页面），表单只能看不能改。'
      : '当前不可写。')
}

/**
 * cordis 客户端插件入口。
 * @param ctx - 客户端根 context
 */
export function apply (ctx) {
  try {
    const log = (...args) => {
      try { console.log('[dsh-away-notify/client]', ...args) } catch { /* 忽略 */ }
    }

    let form = null
    const getForm = () => form

    // 命名空间晚一点才被宿主服务是常态，whileServed 负责「出现就挂、撤下就摘」
    ctx.effect(() => ctx.configForms.whileServed([NAMESPACE], served => {
      if (!served || !served.has(NAMESPACE)) return () => {}
      try {
        form = ctx.configForms.get(NAMESPACE)
      } catch (error) {
        log('拿不到配置表单：', error?.message ?? error)
      }

      const Panel = createPanel(getForm)
      // slots.inject 等 slot 被声明出来（它的所有者是另一个客户端插件，激活顺序无保证）
      return ctx.slots.inject(SLOT, () => ctx.slots.register(
        { name: SLOT, id: NAMESPACE, order: 90, label: () => 'away-notify' },
        Panel
      ))
    }))

    log('已挂载，等待设置页的「插件」分区声明出来')
  } catch (error) {
    // 客户端半边永远不能把插件搞成启动失败
    try { console.error('[dsh-away-notify/client] apply 失败：', error) } catch { /* 忽略 */ }
  }
}
