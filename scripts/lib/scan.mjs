// 仓库卫生检查的共享规则。
//
// 目的：这个仓库会公开到 GitHub 并发布到 npm，所以本机路径、凭据、真实邮箱
// 一旦进了 git 历史就很难彻底删除。规则写在一处，两个守卫复用：
//   scripts/check-hygiene.mjs  扫工作区
//   scripts/check-tarball.mjs  扫**真的打出来的 tarball 内容**
//
// 设计要点：**规则里不写任何本机信息**。第一版曾经把「作者的工作区路径」硬编码进
// 规则里 —— 那等于守卫自己在泄漏它要守的东西。现在与机器相关的规则改成运行时从
// `node:os` 读，规则文件本身是通用的。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 这些目录里的东西不可能进包，也没必要扫（体积大、且本来就是本机产物）。 */
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.test-tmp',
  '.demo-outbox'
])

/** 二进制/压缩文件跳过逐行扫描。 */
const TEXT_EXT = new Set([
  '.mjs', '.js', '.cjs', '.json', '.md', '.yml', '.yaml', '.txt',
  '.patch', '.ts', '.html', '.css', ''
])

// ── 占位符白名单 ──────────────────────────────────────────────────────
// 文档与测试里必须能写「看起来像真的但其实是假的」地址，否则守卫会一直误报。
const PLACEHOLDER_LOCALS = new Set([
  'you', 'me', 'bot', 'your', 'user', 'test', 'someone', 'sender', 'recipient', 'nobody'
])
const PLACEHOLDER_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'example.invalid', 'invalid', 'localhost',
  'b.c', 'y.z', 'e.f', 'h.i', 'x.y', 'a.b'
])

// ── 正则小工具 ────────────────────────────────────────────────────────

function escapeRe (s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 安全地构造并执行一个全局正则；构造失败当作「没有匹配」而不是崩掉检查。 */
function matchRegex (text, source, flags = 'gi') {
  let re
  try { re = new RegExp(source, flags) } catch { return [] }
  const out = []
  let m
  while ((m = re.exec(text)) !== null) {
    out.push({ snippet: m[0], index: m.index })
    if (m.index === re.lastIndex) re.lastIndex++ // 零宽匹配防死循环
  }
  return out
}

function matchAll (text, re) {
  const out = []
  let m
  while ((m = re.exec(text)) !== null) out.push({ snippet: m[0], index: m.index })
  return out
}

// ── 通用规则（与机器无关）────────────────────────────────────────────

export const RULES = [
  {
    id: 'utf8-bom',
    why: '文件带 UTF-8 BOM（会让 JSON.parse 直接抛 Unexpected token，插件加载也会跟着挂）',
    // 在 Windows 上用 PowerShell 的 `Set-Content -Encoding utf8` 极易带上 BOM。
    // 这条规则是真踩过的：package.json 被加上 BOM 后 JSON.parse 直接报错。
    test: text => (text.charCodeAt(0) === 0xFEFF ? [{ snippet: '<UTF-8 BOM>', index: 0 }] : [])
  },
  {
    id: 'user-home-path',
    why: '用户目录路径（会暴露用户名）',
    // 允许 C:\Users\<name> 这种占位写法；/Users/<name>、/home/<name> 同理
    test: text => matchAll(text, /(?:[A-Za-z]:\\+Users\\+(?!<)[^\\\s"')]+|\/(?:Users|home)\/(?!<)[^/\s"')]+)/g)
  },
  {
    id: 'private-key',
    why: '私钥块',
    test: text => matchAll(text, /-----BEGIN [A-Z ]*PRIVATE KEY-----/g)
  },
  {
    id: 'api-key-shape',
    why: '常见 API key 形状',
    test: text => [
      ...matchAll(text, /\bsk-[A-Za-z0-9_-]{20,}/g),
      ...matchAll(text, /\bAKIA[0-9A-Z]{16}\b/g),
      ...matchAll(text, /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g),
      ...matchAll(text, /\bxox[baprs]-[A-Za-z0-9-]{10,}/g),
      ...matchAll(text, /\bAIza[0-9A-Za-z_-]{30,}/g)
    ]
  },
  {
    id: 'cn-mobile',
    why: '中国大陆手机号',
    test: text => matchAll(text, /(?<!\d)1[3-9]\d{9}(?!\d)/g)
  },
  {
    id: 'credential-literal',
    why: '疑似凭据被写成字面量（应走环境变量）',
    test: text => {
      const out = []
      // 前导边界是必须的：没有它 `smtpPass: '<描述文字>'` 会被误判成凭据字面量
      // （`\b` 在这里不够用，因为 smtpPass 里 Pass 前面是单词字符）。
      const re = /(?<![A-Za-z0-9_])(pass(?:word)?|secret|token|api[_-]?key)\s*[:=]\s*['"]([^'"\n]{8,})['"]/gi
      let m
      while ((m = re.exec(text)) !== null) {
        const value = m[2]
        // 明显是占位/说明文字的不算
        if (/^(?:<|\$\{|your|you_|xxx|placeholder|change|replace|sk-xxx)/i.test(value)) continue
        // 含空格且含中日韩文字的基本是描述文案，不是密码
        if (/\s/.test(value) && /[\u3400-\u9fff]/.test(value)) continue
        out.push({ snippet: m[0], index: m.index })
      }
      return out
    }
  },
  {
    id: 'personal-email',
    why: '真实邮箱（应改用 example.com 之类的占位地址）',
    test: text => {
      const out = []
      const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
      let m
      while ((m = re.exec(text)) !== null) {
        const [local, domain] = m[0].split('@')
        if (PLACEHOLDER_LOCALS.has(local.toLowerCase())) continue
        if (PLACEHOLDER_DOMAINS.has(domain.toLowerCase())) continue
        out.push({ snippet: m[0], index: m.index })
      }
      return out
    }
  }
]

// ── 与运行机器相关的规则（规则文件里不含任何机器信息）────────────────

function safeValue (fn) {
  try { return fn() } catch { return null }
}

/**
 * 生成「本机身份」规则：用户名、家目录、以及仓库自身的绝对路径。
 *
 * 这些值在**运行时**从 os / 传入的 root 取，所以：
 *   · 规则文件本身是通用的，可以直接公开；
 *   · 在作者机器上能抓到真实泄漏（用户名进了路径或邮箱、仓库绝对路径被写进文件）；
 *   · 在 CI 上（用户名是 runner、家目录是 CI 的临时目录）不会误报 —— 因为下面几个模式
 *     只匹配「作为路径段或邮箱 local part 出现」，不会因为正文里出现 runner 这个词就报。
 */
export function identityRules ({ root = null } = {}) {
  const rules = []

  const home = safeValue(() => os.homedir())
  if (home && home.length >= 4) {
    const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')])
    rules.push({
      id: 'own-home-path',
      why: '当前机器的家目录绝对路径',
      test: text => [...variants].flatMap(v => matchRegex(text, escapeRe(v)))
    })
  }

  const username = safeValue(() => os.userInfo().username)
  if (username && username.length >= 3) {
    const u = escapeRe(username)
    const patterns = [
      // Windows：C:\Users\<user>
      `[A-Za-z]:\\\\+Users\\\\+${u}(?:\\\\|/|$)`,
      // macOS / Linux：/Users/<user> 或 /home/<user>
      `/(?:Users|home)/${u}(?:/|$)`,
      // 作为邮箱 local part
      `${u}@`
    ]
    rules.push({
      id: 'own-username',
      why: `当前机器的用户名（${username}）出现在路径或邮箱里`,
      test: text => patterns.flatMap(p => matchRegex(text, p))
    })
  }

  // 仓库自身的绝对路径（以及它的父目录）不该出现在任何被提交的文件里
  for (const [id, why, value] of [
    ['repo-absolute-path', '仓库自身的绝对路径', root],
    ['workspace-absolute-path', '仓库所在目录的绝对路径', root ? path.dirname(root) : null]
  ]) {
    if (!value || value === path.dirname(value)) continue // 跳过空值/盘根
    const variants = new Set([value, value.replace(/\\/g, '/'), value.replace(/\//g, '\\')])
    rules.push({
      id,
      why,
      test: text => [...variants].flatMap(v => matchRegex(text, escapeRe(v)))
    })
  }

  return rules
}

/** 完整规则集：通用 + 本机身份。 */
export function buildRules ({ root = null } = {}) {
  return [...RULES, ...identityRules({ root })]
}

// ── 扫 ───────────────────────────────────────────────────────────────

function isTextFile (file) {
  return TEXT_EXT.has(path.extname(file).toLowerCase())
}

/** 递归收集要扫的文件（跳过 SKIP_DIRS）。 */
export function collectFiles (root, { skipDirs = SKIP_DIRS } = {}) {
  const out = []
  const walk = dir => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue
        walk(full)
      } else if (entry.isFile()) {
        out.push(full)
      }
    }
  }
  walk(root)
  return out.sort()
}

/** 文件名本身就不该被提交的文件。 */
export function forbiddenFileNames (files) {
  return files.filter(f => {
    const base = path.basename(f)
    if (base === '.env.example') return false
    return base === '.env' || base.startsWith('.env.')
  })
}

/**
 * 扫一段文本。
 * @returns {Array<{rule: string, why: string, snippet: string, line: number}>}
 */
export function scanText (text, { rules = RULES } = {}) {
  const findings = []
  for (const rule of rules) {
    for (const hit of rule.test(text)) {
      const index = hit.index ?? text.indexOf(hit.snippet)
      const line = text.slice(0, index).split('\n').length
      findings.push({
        rule: rule.id,
        why: rule.why,
        snippet: hit.snippet.length > 120 ? `${hit.snippet.slice(0, 120)}…` : hit.snippet,
        line
      })
    }
  }
  return findings
}

/** 扫一个文件树。 */
export function scanTree (root, { rules = null } = {}) {
  const activeRules = rules ?? buildRules({ root })
  const findings = []
  const files = collectFiles(root)

  for (const file of forbiddenFileNames(files)) {
    findings.push({ file, line: 1, rule: 'forbidden-file', why: '不该提交的凭据文件', snippet: path.basename(file) })
  }

  for (const file of files) {
    if (!isTextFile(file)) continue
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    // 太大的一律跳过逐行扫（避免把日志/产物拖进来）
    if (text.length > 400_000) continue
    for (const finding of scanText(text, { rules: activeRules })) {
      findings.push({ file, ...finding })
    }
  }
  return findings
}
