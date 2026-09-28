// 用插件**自己的** SMTP 代码去连真实邮件服务器。
//
// 为什么要有这个脚本：仓库里的 SMTP 测试是对着一个自己写的假 TCP 服务器跑的，
// 能验协议顺序、AUTH 回落、base64 正文，但验不了真服务器的隐式 TLS、真证书、
// 真 AUTH 实现。这个脚本补上那一段 —— 而且它跑的是 src/transports.mjs 里**同一段**
// 连接/TLS/EHLO/AUTH 代码，不是另写一份。
//
// 凭据只从环境变量读：脚本里没有任何账号信息，也不打印密码。
//
// 用法：
//   node scripts/verify-smtp.mjs --probe     # 只探测：连接 + TLS + EHLO，不发信、不送凭据
//   node scripts/verify-smtp.mjs             # 真发一封测试邮件
//
// 环境变量：
//   DSH_SMTP_HOST           例如 smtp.qq.com
//   DSH_SMTP_PORT           465（隐式 TLS）或 587（STARTTLS）
//   DSH_SMTP_SECURE         true / false；省略时按端口推断（465 → true）
//   DSH_SMTP_USER           登录名（QQ 邮箱就是完整地址）
//   DSH_SMTP_PASS           密码 / 授权码（QQ 邮箱必须用「授权码」，不是登录密码）
//   DSH_SMTP_FROM           发件人，默认同 DSH_SMTP_USER
//   DSH_SMTP_TO             收件人，逗号分隔；默认发给发件人自己
//   DSH_SMTP_ALLOW_INSECURE true 时允许在明文连接上送凭据（只给本地测试服务器用）

import { normalizeConfig } from '../src/config.mjs'
import { deliver, sendSmtp } from '../src/transports.mjs'
import { renderNotification } from '../src/summary.mjs'

const argv = process.argv.slice(2)
const probeOnly = argv.includes('--probe') || argv.includes('--test-connection')
const wantHelp = argv.includes('--help') || argv.includes('-h')

if (wantHelp) {
  console.log(`
用法：
  node scripts/verify-smtp.mjs --probe     只探测：连接 + TLS + EHLO（不发信、不送凭据）
  node scripts/verify-smtp.mjs             真发一封测试邮件

环境变量：
  DSH_SMTP_HOST           例如 smtp.qq.com
  DSH_SMTP_PORT           465（隐式 TLS）或 587（STARTTLS）
  DSH_SMTP_SECURE         true / false；省略时按端口推断（465 → true）
  DSH_SMTP_USER           登录名（QQ 邮箱就是完整地址）
  DSH_SMTP_PASS           密码 / 授权码（QQ 邮箱必须用「授权码」）
  DSH_SMTP_FROM           发件人，默认同 DSH_SMTP_USER
  DSH_SMTP_TO             收件人，逗号分隔；默认发给发件人自己
  DSH_SMTP_ALLOW_INSECURE true 时允许在明文连接上送凭据（仅本地测试服务器）

QQ 邮箱示例：
  $env:DSH_SMTP_HOST="smtp.qq.com"; $env:DSH_SMTP_PORT="465"
  $env:DSH_SMTP_USER="you@qq.com";  $env:DSH_SMTP_PASS="你的授权码"
  node scripts/verify-smtp.mjs --probe      # 先探测
  node scripts/verify-smtp.mjs              # 再真发
`)
  process.exit(0)
}

const env = process.env
const text = (name, fallback = '') => String(env[name] ?? fallback).trim()
const bool = (name, fallback) => {
  const v = text(name).toLowerCase()
  if (!v) return fallback
  return v === '1' || v === 'true' || v === 'yes'
}

const host = text('DSH_SMTP_HOST')
if (!host) {
  console.error('✗ 没设 DSH_SMTP_HOST。加 --help 看用法。')
  process.exit(1)
}

const port = Number(text('DSH_SMTP_PORT')) || 465
const secure = bool('DSH_SMTP_SECURE', port === 465)
const user = text('DSH_SMTP_USER')
const pass = text('DSH_SMTP_PASS')
const from = text('DSH_SMTP_FROM') || user
const to = text('DSH_SMTP_TO') || from
const allowInsecure = bool('DSH_SMTP_ALLOW_INSECURE', false)

/** 任何输出都过这里：万一密码哪天漏进某条服务器回显，也不会打到终端上。 */
function redact (value) {
  let s = typeof value === 'string' ? value : JSON.stringify(value)
  if (pass) s = s.split(pass).join('***')
  return s
}

const { config } = normalizeConfig({
  transport: 'smtp',
  smtpHost: host,
  smtpPort: port,
  smtpSecure: secure,
  smtpUser: user,
  smtpFrom: from,
  smtpTo: to,
  allowInsecureAuth: allowInsecure,
  // ⚠️ 必须显式告诉插件去哪儿取密码。脚本自己从 DSH_SMTP_PASS 读到了，但 normalizeConfig
  // 会给 smtpPassEnv 填默认值 DSH_SMTP_PASSWORD —— 于是 resolveSmtpPassword 去那个变量里找，
  // 找不到就报「未取到 SMTP 密码」。真实踩过：脚本显示「已从环境变量读到（16 字符）」，
  // 却紧接着抛这个错，两边看起来自相矛盾。
  // 顺便这样也就顺带验证了生产推荐的那条路径（凭据只走环境变量、不落盘）。
  smtpPassEnv: 'DSH_SMTP_PASS'
})

console.log('─'.repeat(72))
console.log(`目标      : ${host}:${port}  ${secure ? '隐式 TLS' : 'STARTTLS/明文'}`)
console.log(`登录名    : ${user || '(未设 — 探测模式可以不带)'}`)
console.log(`密码      : ${pass ? `已从环境变量读到（${pass.length} 字符，不显示）` : '(未设)'}`)
console.log(`发件人    : ${from || '(未设)'}`)
console.log(`收件人    : ${to || '(未设)'}`)
console.log(`模式      : ${probeOnly ? '只探测（不发信、不送凭据）' : '真发一封测试邮件'}`)
console.log('─'.repeat(72))

const started = Date.now()

try {
  if (probeOnly) {
    const result = await sendSmtp({
      smtp: config.mail.smtp,
      password: { value: '', source: 'none' },
      mail: null,
      allowInsecureAuth: allowInsecure,
      probeOnly: true
    })

    console.log('\n握手过程：')
    for (const step of result.steps) {
      console.log(`  ${String(step.code).padEnd(4)} ${step.label.padEnd(22)} ${redact(step.resp).slice(0, 90).replace(/\s+/g, ' ')}`)
    }
    console.log('\n能力：')
    console.log(`  TLS          ${result.tlsActive ? '✓ 已加密' : '✗ 明文'}`)
    console.log(`  STARTTLS     ${result.starttlsAdvertised ? '✓ 服务器支持' : '— 未声明'}`)
    console.log(`  AUTH         ${result.authAdvertised ? '✓ 服务器要求认证' : '— 未声明'}`)
    if (result.capabilities.length) console.log(`  其余         ${redact(result.capabilities.join(' / ')).slice(0, 160)}`)

    console.log(`\n✓ 探测通过（${Date.now() - started} ms）：连接、TLS 握手、EHLO 都正常。`)
    if (!result.tlsActive) {
      console.log('⚠️ 但这条连接是明文的 —— 本插件拒绝在明文连接上发送凭据（除非 allowInsecureAuth）。')
    }
    process.exit(0)
  }

  if (!user || !pass) {
    console.error('\n✗ 真发信需要 DSH_SMTP_USER 和 DSH_SMTP_PASS（先用 --probe 验证可达性）。')
    process.exit(1)
  }

  // 用插件真实的渲染器产出邮件内容，这样连「渲染 → 投递」整条链都验到了
  const now = Date.now()
  const mail = renderNotification({
    key: 'verify',
    payloads: [{
      sessionId: 'verify-smtp',
      sessionTitle: 'dsh-away-notify SMTP 验收',
      turn: 1,
      reason: 'completed',
      toolCalls: 3,
      toolFailures: 0,
      toolNames: ['pwsh', 'read'],
      models: ['deepseek-flash'],
      lastText: '这是一封由 scripts/verify-smtp.mjs 发出的真实验收邮件。收到即说明 SMTP 通道可用。',
      tokens: { input: 1200, output: 340, cacheRead: 8000, cacheWrite: 0, total: 9540 }
    }],
    turns: 1,
    firstTurnEndAt: now - 300_000,
    lastTurnEndAt: now - 300_000,
    firedAt: now,
    waitedMs: 300_000,
    burstMs: 300_000
  }, config)

  console.log(`\n主题：${redact(mail.subject)}`)
  console.log('正在投递…\n')

  const result = await deliver(mail, config, { env })

  console.log('SMTP 过程：')
  for (const step of result.steps) {
    console.log(`  ${String(step.code).padEnd(4)} ${step.label.padEnd(22)} ${redact(step.resp).slice(0, 90).replace(/\s+/g, ' ')}`)
  }
  console.log(`\n✓ 投递成功（${Date.now() - started} ms）`)
  console.log(`  服务器接受了 ${result.accepted.length} 个收件人：${result.accepted.join(', ')}`)
  console.log(`  TLS：${result.tlsActive ? '已加密' : '明文'}`)
  console.log(`\n去收件箱看看（可能在垃圾邮件里）。`)
} catch (error) {
  const message = redact(error?.message ?? String(error))
  console.error(`\n✗ 失败（${Date.now() - started} ms）：${message}`)
  console.error('')
  if (/535|认证|AUTH|auth/i.test(message)) {
    console.error('  多半是凭据问题：')
    console.error('  · QQ 邮箱必须用「设置 → 账户 → POP3/SMTP服务」里生成的**授权码**，不是登录密码')
    console.error('  · 确认那个开关是「已开启」状态')
  } else if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    console.error('  连不上：检查 host/port，以及 465 要用 secure:true、587 要用 false')
  } else if (/证书|CERT|self.signed|altname/i.test(message)) {
    console.error('  证书问题：确认 host 与证书域名一致（用 smtp.qq.com 而不是 IP）')
  } else if (/明文/i.test(message)) {
    console.error('  服务器没提供 STARTTLS：改 secure:true（465），或对本地测试服务器设 DSH_SMTP_ALLOW_INSECURE=true')
  }
  process.exit(1)
}
