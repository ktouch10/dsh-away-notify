// SMTP 通道：用一个真的 TCP 假服务器把整段对话跑一遍，确认信封与正文都对。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { sendSmtp, buildMimeMessage, bareAddress, decodeMimeBody } from '../src/transports.mjs'

/** 极简假 SMTP 服务器：支持 EHLO / AUTH PLAIN / AUTH LOGIN / MAIL / RCPT / DATA / QUIT。 */
function createFakeSmtp ({ user = 'bot@example.com', pass = 'secret' } = {}) {
  const state = { transactions: [], authAttempts: 0 }
  const server = net.createServer(socket => {
    let buffer = ''
    let inData = false
    let current = null
    let loginStep = null
    socket.write('220 fake.example.com ESMTP\r\n')

    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      let idx
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)

        if (inData) {
          if (line === '.') {
            inData = false
            state.transactions.push(current)
            socket.write('250 2.0.0 Ok: queued\r\n')
          } else {
            current.data += `${line}\n`
          }
          continue
        }

        if (loginStep === 'user') {
          loginStep = 'pass'
          socket.write('334 UGFzc3dvcmQ6\r\n')
          continue
        }
        if (loginStep === 'pass') {
          loginStep = null
          state.authAttempts += 1
          const decoded = Buffer.from(line, 'base64').toString('utf8')
          socket.write(decoded === pass ? '235 2.7.0 Accepted\r\n' : '535 5.7.8 Bad credentials\r\n')
          continue
        }

        const upper = line.toUpperCase()
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write('250-fake.example.com\r\n250 AUTH PLAIN LOGIN\r\n')
        } else if (upper.startsWith('AUTH PLAIN')) {
          state.authAttempts += 1
          const decoded = Buffer.from(line.slice(11).trim(), 'base64').toString('utf8')
          socket.write(decoded === `\u0000${user}\u0000${pass}` ? '235 2.7.0 Accepted\r\n' : '535 5.7.8 Bad credentials\r\n')
        } else if (upper.startsWith('AUTH LOGIN')) {
          loginStep = 'user'
          socket.write('334 VXNlcm5hbWU6\r\n')
        } else if (upper.startsWith('MAIL FROM')) {
          current = { mailFrom: line, rcptTo: [], data: '' }
          socket.write('250 2.1.0 Ok\r\n')
        } else if (upper.startsWith('RCPT TO')) {
          current.rcptTo.push(line)
          socket.write('250 2.1.5 Ok\r\n')
        } else if (upper === 'DATA') {
          inData = true
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n')
        } else if (upper === 'STARTTLS') {
          socket.write('502 5.5.1 Not implemented\r\n')
        } else if (upper === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n')
          socket.end()
        } else {
          socket.write('250 2.0.0 Ok\r\n')
        }
      }
    })
    socket.on('error', () => {})
  })

  return {
    state,
    listen: () => new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port))
    }),
    close: () => new Promise(resolve => server.close(resolve))
  }
}

function smtpConfig (port) {
  return {
    host: '127.0.0.1',
    port,
    secure: false,
    user: 'bot@example.com',
    pass: '',
    passEnv: '',
    from: 'DSH <bot@example.com>',
    to: ['me@example.com']
  }
}

const mail = { subject: '任务已结束，5.0 分钟无人应答', text: '会话：修复登录接口超时\n规模：2 轮 · 12 次工具调用' }

test('bareAddress 能从带显示名的地址里取裸地址', () => {
  assert.equal(bareAddress('DSH <bot@example.com>'), 'bot@example.com')
  assert.equal(bareAddress(' me@example.com '), 'me@example.com')
  assert.equal(bareAddress(''), '')
})

test('MIME 报文：非 ASCII 主题走 RFC2047，正文 base64 可还原', () => {
  const eml = buildMimeMessage({ from: 'a@b.c', to: ['d@e.f'], subject: '中文主题', text: '正文内容' })

  assert.match(eml, /^Subject: =\?UTF-8\?B\?/m)
  assert.match(eml, /^Content-Transfer-Encoding: base64$/m)
  assert.equal(decodeMimeBody(eml), '正文内容')

  // 正文 base64 里不该出现裸的中文，也不该有行首的点（免去点填充问题）
  const body = eml.slice(eml.indexOf('\r\n\r\n') + 4)
  assert.ok(!/[\u4e00-\u9fa5]/.test(body))
  assert.ok(!/^\./m.test(body))
})

test('长主题被切成多段 encoded-word，每段都不超过 75 字符', () => {
  const eml = buildMimeMessage({ from: 'a@b.c', to: ['d@e.f'], subject: '很长的中文主题'.repeat(20), text: 'x' })
  const subjectLine = eml.split('\r\nSubject: ')[1].split('\r\n')[0]
  for (const chunk of subjectLine.split('\r\n ')) {
    assert.ok(chunk.length <= 75, `分片过长：${chunk.length}`)
  }
})

test('完整 SMTP 对话：信封与正文都正确', async () => {
  const fake = createFakeSmtp()
  const port = await fake.listen()
  try {
    const result = await sendSmtp({
      smtp: smtpConfig(port),
      password: { value: 'secret', source: 'test' },
      mail,
      allowInsecureAuth: true
    })

    assert.equal(result.ok, true)
    assert.equal(result.tlsActive, false)
    assert.equal(result.accepted.length, 1)
    assert.equal(fake.state.transactions.length, 1)

    const tx = fake.state.transactions[0]
    assert.match(tx.mailFrom, /<bot@example\.com>/)
    assert.match(tx.rcptTo[0], /<me@example\.com>/)

    const body = decodeMimeBody(tx.data.replace(/\n/g, '\r\n'))
    assert.match(body, /12 次工具调用/)

    // 对话步骤齐全
    const labels = result.steps.map(s => s.label)
    assert.ok(labels.includes('greeting'))
    assert.ok(labels.includes('EHLO'))
    assert.ok(labels.includes('AUTH PLAIN'))
    assert.ok(labels.includes('MAIL FROM'))
    assert.ok(labels.includes('DATA body'))
  } finally {
    await fake.close()
  }
})

test('拒绝在明文连接上发送凭据（默认安全行为）', async () => {
  const fake = createFakeSmtp()
  const port = await fake.listen()
  try {
    await assert.rejects(
      () => sendSmtp({
        smtp: smtpConfig(port),
        password: { value: 'secret', source: 'test' },
        mail
      }),
      /拒绝在明文连接上发送凭据/
    )
    assert.equal(fake.state.authAttempts, 0, '拒绝时不该真的发出凭据')
  } finally {
    await fake.close()
  }
})

test('密码错误会带着服务器原文报错', async () => {
  const fake = createFakeSmtp()
  const port = await fake.listen()
  try {
    await assert.rejects(
      () => sendSmtp({
        smtp: smtpConfig(port),
        password: { value: 'wrong', source: 'test' },
        mail,
        allowInsecureAuth: true
      }),
      /535|AUTH 密码被拒/
    )
    assert.equal(fake.state.transactions.length, 0)
  } finally {
    await fake.close()
  }
})

test('AUTH PLAIN 不被接受时自动回落 AUTH LOGIN', async () => {
  // 只支持 LOGIN 的服务器
  const seen = { transactions: [] }
  const server = net.createServer(socket => {
    let buffer = ''
    let loginStep = null
    let inData = false
    let current = null
    socket.write('220 login-only ESMTP\r\n')
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      let idx
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)

        if (inData) {
          if (line === '.') {
            inData = false
            seen.transactions.push(current)
            socket.write('250 queued\r\n')
          } else {
            current.data += `${line}\n`
          }
          continue
        }
        if (loginStep === 'user') { loginStep = 'pass'; socket.write('334 UGFzc3dvcmQ6\r\n'); continue }
        if (loginStep === 'pass') {
          loginStep = null
          socket.write(Buffer.from(line, 'base64').toString('utf8') === 'secret' ? '235 ok\r\n' : '535 bad\r\n')
          continue
        }

        const upper = line.toUpperCase()
        if (upper.startsWith('EHLO')) socket.write('250-login-only\r\n250 AUTH LOGIN\r\n')
        else if (upper.startsWith('AUTH PLAIN')) socket.write('504 5.5.4 Unrecognized authentication type\r\n')
        else if (upper.startsWith('AUTH LOGIN')) { loginStep = 'user'; socket.write('334 VXNlcm5hbWU6\r\n') }
        else if (upper.startsWith('MAIL FROM')) { current = { data: '' }; socket.write('250 ok\r\n') }
        else if (upper.startsWith('RCPT TO')) socket.write('250 ok\r\n')
        else if (upper === 'DATA') { inData = true; socket.write('354 go\r\n') }
        else if (upper === 'QUIT') { socket.write('221 bye\r\n'); socket.end() }
        else socket.write('250 ok\r\n')
      }
    })
    socket.on('error', () => {})
  })
  const port = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  try {
    const result = await sendSmtp({
      smtp: smtpConfig(port),
      password: { value: 'secret', source: 'test' },
      mail,
      allowInsecureAuth: true
    })
    const labels = result.steps.map(s => s.label)
    assert.ok(labels.includes('AUTH PLAIN'), '先试 PLAIN')
    assert.ok(labels.includes('AUTH LOGIN'), '再回落 LOGIN')
    assert.ok(labels.includes('AUTH LOGIN(pass)'))
    assert.equal(seen.transactions.length, 1, '回落成功后仍然把邮件投出去了')
    assert.match(decodeMimeBody(seen.transactions[0].data.replace(/\n/g, '\r\n')), /12 次工具调用/)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
