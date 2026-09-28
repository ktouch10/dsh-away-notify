// 诊断日志。
//
// 为什么需要：通知插件最糟的失败方式是「什么都不发生」—— 没有报错、没有邮件，
// 用户完全不知道是没触发、还是投递失败了。DSH 又不会把插件的主机端输出落盘
// （实测 logs/ 里只有崩溃日志），所以「为什么没收到提醒」根本无从查起。
//
// 于是插件自己写一份很小的状态日志：启动结果、配置摘要（**凭据已脱敏**）、
// 设置命名空间注册结果、订阅结果，以及每一次排定 / 撤销 / 挂起 / 投递。
//
// 有大小上限，超了就整份重写，不会无限增长。写日志失败永远不影响功能。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 默认放 <DSH_HOME 的兄弟位置>：~/.dsh/dsh-away-notify */
export function defaultDiagDir () {
  return path.join(os.homedir(), '.dsh', 'dsh-away-notify')
}

export const DIAG_FILE = 'status.log'

export function createDiagnostics ({
  enabled = true,
  dir = null,
  maxBytes = 256 * 1024,
  now = () => new Date()
} = {}) {
  let file = null
  if (enabled) {
    const base = dir || defaultDiagDir()
    try {
      fs.mkdirSync(base, { recursive: true })
      file = path.join(base, DIAG_FILE)
    } catch {
      file = null // 目录不可写就静默放弃，绝不能因此影响提醒功能
    }
  }

  function rotateIfNeeded () {
    try {
      if (fs.statSync(file).size > maxBytes) fs.rmSync(file, { force: true })
    } catch {
      // 文件还不存在 / 读不到，都不用管
    }
  }

  function write (level, message) {
    if (!file) return
    try {
      rotateIfNeeded()
      fs.appendFileSync(file, `${now().toISOString()}  ${String(level).padEnd(5)} ${message}\n`, 'utf8')
    } catch {
      // 写不进去就算了
    }
  }

  return { write, file, enabled: Boolean(file) }
}

/**
 * 配置摘要 —— **绝不能包含密码**。
 * 日志会留在磁盘上，明文写 smtpPass 等于把凭据抄了一份。
 */
export function describeConfig (config) {
  const mail = config?.mail ?? {}
  const smtp = mail.smtp ?? {}
  return [
    `enabled=${config?.enabled}`,
    `dwell=${config?.dwellMinutes}min`,
    `maxDwell=${config?.maxDwellMinutes}min`,
    `tick=${config?.tickSeconds}s`,
    `transport=${mail.transport}`,
    `outboxDir=${mail.outboxDir ?? '(默认)'}`,
    `smtpHost=${smtp.host || '(未配)'}`,
    `smtpUser=${smtp.user ? '(已配)' : '(未配)'}`,
    `smtpPass=${smtp.pass ? '字面量(已脱敏)' : (smtp.passEnv ? `env:${smtp.passEnv}` : '(未配)')}`,
    `smtpTo=${(smtp.to ?? []).length} 个收件人`
  ].join('  ')
}
