#!/usr/bin/env node
// 统一检查入口：本地跑的和 CI 跑的是**同一条命令**。
//
//   node scripts/check.mjs      （等价于 pnpm run check）
//
// 两个刻意的选择：
//   1. 子进程用 stdio: 'inherit'。受限沙箱禁止命名管道，Node 默认的 stdio: 'pipe'
//      捕获输出会 EPERM；inherit 不受影响。
//   2. 测试用 --test-isolation=none 并显式列文件。`node --test test/` 会给每个文件
//      开子进程（默认 pipe）→ 同样的 EPERM。单进程模式在普通机器与受限环境都稳。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function list (dir, filter) {
  return fs.readdirSync(path.join(ROOT, dir))
    .filter(filter)
    .sort()
    .map(f => path.join(dir, f))
}

/**
 * 删掉测试可能留下的覆盖层配置。
 *
 * 为什么需要：`--test-isolation=none` 下所有测试文件**共用同一个 process.env**，而覆盖层路径
 * 是从 `DSH_AWAY_NOTIFY_DIAG_DIR` 推出来的 —— 于是所有用例共用一个 `config.json`。
 * 上一轮运行留下的那份会被这一轮所有 `apply()` 读到（真发生过：残留的 `enabled: true`
 * 让这一轮所有「enabled=false」的用例全红）。
 */
function cleanTestOverlays () {
  const base = path.join(ROOT, '.test-tmp')
  if (!fs.existsSync(base)) return
  const stack = [base]
  while (stack.length) {
    const dir = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name === 'config.json') {
        try { fs.rmSync(full, { force: true }) } catch { /* 删不掉也无所谓 */ }
      }
    }
  }
}

const SOURCES = [
  ...list('src', f => f.endsWith('.mjs')),
  ...list('test', f => f.endsWith('.mjs')),
  ...list(path.join('test', 'fixtures'), f => f.endsWith('.mjs')),
  ...list(path.join('scripts', 'lib'), f => f.endsWith('.mjs')),
  ...list('scripts', f => f.endsWith('.mjs'))
]

const TESTS = list('test', f => f.endsWith('.test.mjs'))

function run (args, label) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', shell: false })
  if (result.error) {
    console.error(`\n[${label}] 无法启动：${result.error.code ?? result.error.message}`)
    return false
  }
  return result.status === 0
}

/**
 * 选一个「当前 Node 支持」的关掉测试隔离的 flag。
 *
 * 这个 flag 改过名，而且旧名字在新 Node 上仍然可用、新名字在旧 Node 上直接报错：
 *   · Node 20.14 / 22.x  —— `--experimental-test-isolation`
 *   · Node 23 起          —— `--test-isolation`
 * 实测：Node 22.23.3 传 `--test-isolation=none` 会 `bad option` 并以 9 退出。
 *
 * 第一次推上去的 CI 就是这么挂的：矩阵里有 Node 22，而我硬写了新名字 ——
 * Node 24 的 job 全绿、Node 22 的 job 在第二步直接失败。所以这里探测着用。
 */
function resolveIsolationFlags () {
  const candidates = [
    ['--test-isolation=none'], // Node 23+
    ['--experimental-test-isolation=none'], // Node 20.14 / 22.x
    [] // 都不支持：退回默认（会给每个测试文件开子进程）
  ]
  for (const flags of candidates) {
    const probe = spawnSync(process.execPath, [...flags, '-e', '0'], { stdio: 'ignore', shell: false })
    if (probe.status === 0) return flags
  }
  return []
}

const ISOLATION_FLAGS = resolveIsolationFlags()

const STEPS = [
  {
    label: '语法检查',
    run: () => SOURCES.every(file => run(['--check', file], `syntax ${file}`))
  },
  {
    label: `单元 / 集成测试（${TESTS.length} 个文件${ISOLATION_FLAGS.length ? `，${ISOLATION_FLAGS[0]}` : '，默认隔离'}）`,
    run: () => {
      // 测试之间会共用 process.env 与 .test-tmp，所以**先清掉上一轮留下的覆盖层配置**。
      // 不清的话，上一轮某个用例写进 ~/.dsh/.../config.json 的等价物（.test-tmp/*/config.json）
      // 会被这一轮所有 apply() 读到 —— 真发生过：上一轮失败留下的 config.json 里带着
      // enabled:true，导致这一轮所有「enabled=false」的用例都失败。
      cleanTestOverlays()
      return TESTS.length > 0 && run([...ISOLATION_FLAGS, '--test', ...TESTS], 'tests')
    }
  },
  {
    label: '端到端演示（demo）',
    run: () => run(['scripts/demo.mjs'], 'demo')
  },
  {
    label: '设置卡片预览',
    run: () => run(['scripts/print-settings.mjs'], 'print-settings')
  },
  {
    label: '仓库卫生检查',
    run: () => run(['scripts/check-hygiene.mjs'], 'hygiene')
  },
  {
    label: '发布产物检查',
    run: () => run(['scripts/check-tarball.mjs'], 'tarball')
  }
]

function main () {
  console.log('')
  console.log(`dsh-away-notify · 全量检查（${SOURCES.length} 个源文件，${TESTS.length} 个测试文件）`)
  console.log('='.repeat(78))

  const results = []
  for (const step of STEPS) {
    console.log('')
    console.log(`▶ ${step.label}`)
    const ok = step.run()
    results.push({ label: step.label, ok })
    if (!ok) {
      console.log('')
      console.log(`✗ 在「${step.label}」这一步失败，后续步骤跳过。`)
      break
    }
  }

  console.log('')
  console.log('='.repeat(78))
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label}`)
  const failed = results.filter(r => !r.ok)
  console.log('')

  if (failed.length || results.length !== STEPS.length) {
    console.log('检查未通过。')
    process.exitCode = 1
    return
  }
  console.log('全部通过 ✓')
  console.log('')
}

main()
