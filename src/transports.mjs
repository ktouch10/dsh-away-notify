// 投递通道。
//
//   outbox —— 把「本来会发出去的那封邮件」原样落盘（.eml + 便于阅读的 .txt）。
//             默认通道，零配置即可跑通全链路，也是把 demo 与真实发信解耦的关键。
//   smtp   —— 自己实现的极简 SMTP 客户端，只用 node:net / node:tls，不依赖 nodemailer。
//
// 安全默认值：明文连接上拒绝发送凭据（除非显式 allowInsecureAuth）。优先隐式 TLS(465)，
// 其次 STARTTLS 升级(587)。

import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveSmtpPassword } from './config.mjs'

// ─────────────────────────── 地址与 MIME ───────────────────────────

/** 从 "名字 <a@b.c>" 或 "a@b.c" 里取出裸地址。 */
export function bareAddress (value) {
  const s = String(value ?? '').trim()
  const m = s.match(/<([^>]+)>/)
  return (m ? m[1] : s).trim()
}

/** RFC 2047 编码；长串按 45 字节切分（编码后膨胀 4/3，落在 75 字符上限内）。 */
function encodeHeaderValue (value) {
  const s = String(value ?? '')
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(s)) return s
  const bytes = Buffer.from(s, 'utf8')
  const chunks = []
  for (let i = 0; i < bytes.length; i += 45) {
    chunks.push(`=?UTF-8?B?${bytes.subarray(i, i + 45).toString('base64')}?=`)
  }
  return chunks.join('\r\n ')
}

function base64Body (text) {
  return Buffer.from(String(text ?? ''), 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n')
    .replace(/\r\n$/, '')
}

/** 构造一封最简 MIME 邮件。正文一律 base64，绕开点填充与折行问题。 */
export function buildMimeMessage ({ from, to, subject, text, date = new Date() }) {
  const headers = [
    `From: ${from}`,
    `To: ${(Array.isArray(to) ? to : [to]).join(', ')}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${randomUUID()}@dsh-away-notify>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'X-Mailer: dsh-away-notify'
  ]
  return `${headers.join('\r\n')}\r\n\r\n${base64Body(text)}\r\n`
}

/** 从 .eml 字节还原正文，供 outbox 的 .txt 版本使用。 */
export function decodeMimeBody (eml) {
  const split = eml.indexOf('\r\n\r\n')
  if (split < 0) return ''
  return Buffer.from(eml.slice(split + 4).replace(/\r\n/g, ''), 'base64').toString('utf8')
}

// ─────────────────────────── outbox 通道 ───────────────────────────

export function defaultOutboxDir () {
  return path.join(os.homedir(), '.dsh', 'dsh-away-notify', 'outbox')
}

function safeStamp (date) {
  return date.toISOString().replace(/[:.]/g, '-')
}

export async function deliverToOutbox (mail, config, { now = new Date() } = {}) {
  const dir = config.mail.outboxDir || defaultOutboxDir()
  await fs.mkdir(dir, { recursive: true })
  const stem = `${safeStamp(now)}-${randomUUID().slice(0, 8)}`
  const emlPath = path.join(dir, `${stem}.eml`)
  const txtPath = path.join(dir, `${stem}.txt`)

  const eml = buildMimeMessage({
    from: config.mail.smtp.from || 'dsh-away-notify@localhost',
    to: config.mail.smtp.to.length ? config.mail.smtp.to : ['(unconfigured)'],
    subject: mail.subject,
    text: mail.text,
    date: now
  })
  await fs.writeFile(emlPath, eml, 'utf8')
  await fs.writeFile(txtPath, `Subject: ${mail.subject}\n\n${mail.text}\n`, 'utf8')

  return { ok: true, transport: 'outbox', eml: emlPath, text: txtPath }
}

// ─────────────────────────── SMTP 对话 ───────────────────────────

/** 把行式 SMTP 响应读成整段字符串（支持 "250-..." 多行续接）。 */
function createChannel (socket) {
  let sock = socket
  let buffer = ''
  let acc = []
  let waiter = null
  let fatal = null
  let bound = null

  function unbind () {
    if (!sock || !bound) return
    sock.removeListener('data', bound.data)
    sock.removeListener('error', bound.error)
    sock.removeListener('close', bound.close)
    bound = null
  }

  function settle () {
    if (!waiter) return
    const lines = acc.join('\n')
    acc = []
    const w = waiter
    waiter = null
    w.resolve(lines)
  }

  function onData (chunk) {
    buffer += chunk
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
      acc.push(line)
      // 末行形如 "250 xxx"（触发）；续行 "250-xxx" 不触发
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) settle()
    }
  }

  function fail (error) {
    fatal = error
    if (waiter) {
      const w = waiter
      waiter = null
      w.reject(error)
    }
  }

  function bind (next) {
    unbind()
    sock = next
    buffer = ''
    acc = []
    fatal = null
    bound = {
      data: onData,
      error: err => fail(err),
      close: () => fail(fatal || new Error('SMTP 连接被关闭'))
    }
    sock.setEncoding('utf8')
    sock.on('data', bound.data)
    sock.on('error', bound.error)
    sock.on('close', bound.close)
  }

  bind(socket)

  function read (timeoutMs) {
    if (fatal) return Promise.reject(fatal)
    return new Promise((resolve, reject) => {
      if (waiter) { reject(new Error('SMTP 响应读取重叠')); return }
      const timer = setTimeout(() => {
        waiter = null
        reject(new Error(`SMTP 响应超时（${timeoutMs}ms）`))
      }, timeoutMs)
      timer.unref?.()
      waiter = {
        resolve: v => { clearTimeout(timer); resolve(v) },
        reject: e => { clearTimeout(timer); reject(e) }
      }
    })
  }

  return {
    read,
    write: line => sock.write(`${line}\r\n`),
    bind,
    raw: () => sock,
    end: () => { unbind(); try { sock.end() } catch {} }
  }
}

function waitForEvent (emitter, event, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`${label} 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    timer.unref?.()
    function cleanup () {
      clearTimeout(timer)
      emitter.removeListener(event, onOk)
      emitter.removeListener('error', onErr)
    }
    function onOk () { cleanup(); resolve() }
    function onErr (err) { cleanup(); reject(err) }
    emitter.once(event, onOk)
    emitter.once('error', onErr)
  })
}

function dotStuff (text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n+$/, '')
    .split('\n')
    .map(line => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n')
}

/**
 * 极简 SMTP 发信。
 *
 * @param {object}   args
 * @param {object}   args.smtp               归一化后的 smtp 配置
 * @param {{value:string}} args.password     resolveSmtpPassword() 的结果
 * @param {{subject:string,text:string}} args.mail
 * @returns {Promise<{ok:true, transport:'smtp', steps:object[], accepted:string[]}>}
 */
export async function sendSmtp ({
  smtp,
  password,
  mail,
  timeoutMs = 20000,
  allowInsecureAuth = false
}) {
  if (!smtp?.host) throw new Error('未配置 smtp.host')
  const from = bareAddress(smtp.from || smtp.user)
  const recipients = (smtp.to ?? []).map(bareAddress).filter(Boolean)
  if (!from) throw new Error('未配置发件人（smtp.from / smtp.user）')
  if (!recipients.length) throw new Error('未配置收件人（smtp.to）')

  const port = smtp.port || (smtp.secure ? 465 : 587)
  const steps = []

  let raw
  if (smtp.secure) {
    raw = tls.connect({ host: smtp.host, port, servername: smtp.host })
    await waitForEvent(raw, 'secureConnect', timeoutMs, `连接 ${smtp.host}:${port}（隐式 TLS）`)
  } else {
    raw = net.connect({ host: smtp.host, port })
    await waitForEvent(raw, 'connect', timeoutMs, `连接 ${smtp.host}:${port}`)
  }

  const channel = createChannel(raw)
  let upgraded = false

  try {
    const expect = async (codes, label) => {
      const resp = await channel.read(timeoutMs)
      const code = Number(resp.slice(0, 3))
      steps.push({ label, code, resp })
      if (!codes.includes(code)) {
        throw new Error(`${label} 失败：期望 ${codes.join('/')}，收到「${resp.slice(0, 200)}」`)
      }
      return resp
    }

    await expect([220], 'greeting')

    channel.write(`EHLO ${os.hostname() || 'localhost'}`)
    let ehlo = await expect([250], 'EHLO')

    if (!smtp.secure && /STARTTLS/i.test(ehlo)) {
      channel.write('STARTTLS')
      await expect([220], 'STARTTLS')
      const plain = channel.raw()
      plain.removeAllListeners('data')
      const secureSocket = tls.connect({ socket: plain, servername: smtp.host })
      await waitForEvent(secureSocket, 'secureConnect', timeoutMs, 'STARTTLS 升级')
      channel.bind(secureSocket)
      upgraded = true
      channel.write(`EHLO ${os.hostname() || 'localhost'}`)
      ehlo = await expect([250], 'EHLO(STARTTLS)')
    }

    const tlsActive = Boolean(smtp.secure || upgraded)
    const pass = password?.value ?? ''

    if (smtp.user) {
      if (!tlsActive && !allowInsecureAuth) {
        throw new Error(
          '拒绝在明文连接上发送凭据：请设 secure:true（465）或让服务器支持 STARTTLS；'
          + '确实需要明文（仅限本地测试服务器）请显式设置 allowInsecureAuth:true'
        )
      }
      if (!pass) throw new Error('未取到 SMTP 密码（检查 DSH_SMTP_PASSWORD 环境变量）')
      await authenticate({ channel, expect, user: smtp.user, pass, timeoutMs, steps })
    }

    channel.write(`MAIL FROM:<${from}>`)
    await expect([250], 'MAIL FROM')

    for (const rcpt of recipients) {
      channel.write(`RCPT TO:<${rcpt}>`)
      await expect([250, 251], 'RCPT TO')
    }

    channel.write('DATA')
    await expect([354], 'DATA')

    const eml = buildMimeMessage({
      from: smtp.from || from,
      to: recipients,
      subject: mail.subject,
      text: mail.text
    })
    channel.write(dotStuff(eml))
    channel.write('.')
    await expect([250], 'DATA body')

    try {
      channel.write('QUIT')
      await expect([221], 'QUIT')
    } catch {
      // QUIT 失败不影响投递结果
    }

    return { ok: true, transport: 'smtp', steps, accepted: recipients, tlsActive }
  } finally {
    channel.end()
  }
}

/** AUTH PLAIN 优先，失败回落 AUTH LOGIN。 */
async function authenticate ({ channel, expect, user, pass, timeoutMs, steps }) {
  const plain = Buffer.from(`\u0000${user}\u0000${pass}`, 'utf8').toString('base64')
  channel.write(`AUTH PLAIN ${plain}`)
  let resp = await channel.read(timeoutMs)
  let code = Number(resp.slice(0, 3))
  steps.push({ label: 'AUTH PLAIN', code, resp })

  if (code === 334) {
    // 少数服务器要求先发命令再单独发初始响应
    channel.write(plain)
    resp = await channel.read(timeoutMs)
    code = Number(resp.slice(0, 3))
    steps.push({ label: 'AUTH PLAIN(continue)', code, resp })
  }
  if (code === 235) return

  channel.write('AUTH LOGIN')
  resp = await channel.read(timeoutMs)
  code = Number(resp.slice(0, 3))
  steps.push({ label: 'AUTH LOGIN', code, resp })
  if (code !== 334) throw new Error(`AUTH 失败：服务器不支持 PLAIN/LOGIN（${resp.slice(0, 120)}）`)

  channel.write(Buffer.from(user, 'utf8').toString('base64'))
  resp = await channel.read(timeoutMs)
  code = Number(resp.slice(0, 3))
  steps.push({ label: 'AUTH LOGIN(user)', code, resp })
  if (code !== 334) throw new Error(`AUTH 用户名被拒（${resp.slice(0, 120)}）`)

  channel.write(Buffer.from(pass, 'utf8').toString('base64'))
  resp = await channel.read(timeoutMs)
  code = Number(resp.slice(0, 3))
  steps.push({ label: 'AUTH LOGIN(pass)', code, resp })
  if (code !== 235) throw new Error(`AUTH 密码被拒（${resp.slice(0, 120)}）`)
}

// ─────────────────────────── 分发 ───────────────────────────

/**
 * 按配置选择通道投递。
 * 失败向上抛，由调用方决定是否记录（绝不允许污染 agent 循环）。
 */
export async function deliver (mail, config, { env = process.env, now = new Date() } = {}) {
  if (config.mail.transport === 'smtp') {
    const password = resolveSmtpPassword(config.mail.smtp, env)
    return sendSmtp({
      smtp: config.mail.smtp,
      password,
      mail,
      allowInsecureAuth: Boolean(config.mail.allowInsecureAuth)
    })
  }
  return deliverToOutbox(mail, config, { now })
}
