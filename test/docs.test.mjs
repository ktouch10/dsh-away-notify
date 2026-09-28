// README 结构守卫。
//
// 为什么要测：README 是仓库的门面，也是 npm 页面上展示的内容。它出错的方式很典型
// 而且很尴尬 —— 重复标题、内部锚点写错、链接指向不存在的文件。这些都不会让代码报错，
// 只有人去点才发现。而 npm 包一旦发布就**不能重发同一个版本**，README 的错要发新版才能修。
//
// 真实来源：0.1.0 发布之后才发现 README 里有两个 `## 配置` 标题（一次编辑留下的空标题），
// 已经随包发出去了。这条用例就是为了不再发生。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const README = path.join(ROOT, 'README.md')

/** GitHub 的标题锚点规则：去掉标点、空格转连字符、保留 Unicode 字母（含中文）。 */
function slugify (heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}

function readme () {
  return fs.readFileSync(README, 'utf8')
}

/** 取所有标题（跳过 ``` 代码块里的 # 注释）。 */
function headings (text) {
  const out = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (m) out.push({ level: m[1].length, text: m[2] })
  }
  return out
}

test('README 没有重复标题（发布出去的 README 也改不了）', () => {
  const seen = new Map()
  const duplicates = []
  for (const h of headings(readme())) {
    const key = `${h.level}:${h.text}`
    if (seen.has(key)) duplicates.push(h.text)
    seen.set(key, true)
  }
  assert.deepEqual(duplicates, [], `重复标题：${duplicates.join(' / ')}`)
})

test('README 的内部锚点链接都能落到标题上', () => {
  const text = readme()
  const anchors = new Set(headings(text).map(h => slugify(h.text)))
  const broken = []

  for (const m of text.matchAll(/\]\(#([^)\s]+)\)/g)) {
    const target = decodeURIComponent(m[1])
    if (!anchors.has(target)) broken.push(`#${target}`)
  }

  assert.deepEqual(broken, [], `锚点找不到对应标题：${broken.join(' / ')}`)
})

test('README 里指向仓库文件的相对链接都存在', () => {
  const text = readme()
  const missing = []

  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1]
    if (/^(?:https?:|mailto:|#)/.test(target)) continue
    const clean = target.split('#')[0].split('?')[0]
    if (!clean) continue
    if (!fs.existsSync(path.join(ROOT, clean))) missing.push(target)
  }

  assert.deepEqual(missing, [], `链接指向不存在的文件：${missing.join(' / ')}`)
})

test('README 声明的用例数跟实际测试文件对得上', () => {
  // 每次加测试都要改 README 里的数字很烦，但「文档说 X 个用例、实际是 Y」更糟。
  // 这里只校验 README 里那个数字**存在**且是个合理的大于零的整数，
  // 避免它随着时间漂移到完全离谱的值。
  const m = readme().match(/node --test test\/\s*#\s*(\d+)\s*个用例/)
  assert.ok(m, 'README 的开发章节里应该写明用例数')
  const claimed = Number(m[1])
  assert.ok(Number.isInteger(claimed) && claimed > 0, `用例数不像话：${m[1]}`)

  const testFiles = fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.mjs'))
  assert.ok(claimed >= testFiles.length, `声明的用例数(${claimed})不该少于测试文件数(${testFiles.length})`)
})
