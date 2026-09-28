// CI / 发布配置的结构化校验。
//
// 为什么值得测：workflow 写错一个缩进、漏一个 permission、或者把 tag 校验去掉，
// 表现是「CI 静默不跑」或「发出去了半成品」—— 都比测试失败难发现得多。
// 这里用真的 YAML 解析器，不是正则猜。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOWS = path.join(ROOT, '.github', 'workflows')

function load (name) {
  const file = path.join(WORKFLOWS, name)
  assert.ok(fs.existsSync(file), `${name} 不存在`)
  const doc = parse(fs.readFileSync(file, 'utf8'))
  assert.ok(doc && typeof doc === 'object', `${name} 解析不出对象`)
  return doc
}

/** YAML 1.1 会把裸 `on` 解析成布尔 true，两种都兜住。 */
function triggers (workflow) {
  return workflow.on ?? workflow[true] ?? workflow['on']
}

function steps (workflow, jobName) {
  const job = workflow.jobs?.[jobName]
  assert.ok(job, `缺少 job：${jobName}`)
  return job.steps ?? []
}

function allRuns (workflow) {
  const out = []
  for (const job of Object.values(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (typeof step.run === 'string') out.push(step.run)
    }
  }
  return out
}

function allUses (workflow) {
  const out = []
  for (const job of Object.values(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (typeof step.uses === 'string') out.push(step.uses)
    }
  }
  return out
}

// ─────────────────────────── ci.yml ───────────────────────────

test('ci.yml 能被解析，且在 push 与 PR 上触发', () => {
  const ci = load('ci.yml')
  const on = triggers(ci)
  assert.ok(on, '缺少 on 触发器')
  // 注意：`pull_request:` 后面不写值在 GitHub 上是合法的（= 所有 PR 事件），
  // YAML 解析出来是 null，所以这里判键是否存在，而不是判真假。
  assert.ok('push' in on, 'push 未触发')
  assert.ok('pull_request' in on, 'pull_request 未触发')
})

test('ci.yml 的 check job 跑的就是本地那条 `pnpm run check`', () => {
  const ci = load('ci.yml')
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

  assert.ok(pkg.scripts?.check, 'package.json 缺少 check 脚本')
  const runs = allRuns(ci)
  assert.ok(
    runs.some(r => r.includes('pnpm run check')),
    'CI 必须调用 `pnpm run check` —— 否则本地绿、CI 红这类问题迟早出现'
  )
})

test('ci.yml 在 Node 22 与 24 两个版本上跑', () => {
  const ci = load('ci.yml')
  const matrix = ci.jobs.check?.strategy?.matrix?.node
  assert.ok(Array.isArray(matrix), 'check job 应该有 node 版本矩阵')
  assert.deepEqual([...matrix].sort(), ['22', '24'])
})

test('ci.yml 有一个不执行 install 的零依赖 job', () => {
  const ci = load('ci.yml')
  const job = ci.jobs['zero-dependency']
  assert.ok(job, '缺少 zero-dependency job')

  const runs = steps(ci, 'zero-dependency').map(s => s.run ?? '')
  const joined = runs.join('\n')

  assert.ok(!/pnpm install|npm install|npm ci/.test(joined),
    '零依赖 job 里出现 install —— 那它就证明不了「零运行时依赖」')
  assert.ok(joined.includes('node --test'), '应该直接跑核心用例')
  assert.ok(joined.includes('scripts/demo.mjs'), 'demo 也必须能在零依赖下跑完')

  // 顺带验证降级路径：没有 schemastery 时应该提示「未加载」而不是崩
  assert.ok(joined.includes('未加载'), '应该断言缺少 schemastery 时会降级')
})

test('ci.yml 的权限是最小化的', () => {
  const ci = load('ci.yml')
  assert.equal(ci.permissions?.contents, 'read')
  assert.equal(ci.permissions?.['id-token'], undefined, 'CI 不需要 OIDC')
})

// ─────────────────────────── release.yml ───────────────────────────

test('release.yml 由 v* tag 触发', () => {
  const release = load('release.yml')
  const on = triggers(release)
  const tags = on?.push?.tags
  assert.ok(Array.isArray(tags) && tags.includes('v*'), 'push.tags 必须包含 v*')
})

test('release.yml 申请了 OIDC 与建 Release 所需的权限', () => {
  const release = load('release.yml')
  assert.equal(release.permissions?.['id-token'], 'write', 'Trusted Publishing 需要 id-token: write')
  assert.equal(release.permissions?.contents, 'write', '创建 GitHub Release 需要 contents: write')
})

test('release.yml 在发布前校验 tag 与 package.json 的 version 一致', () => {
  const release = load('release.yml')
  const runs = allRuns(release).join('\n')
  assert.ok(runs.includes('GITHUB_REF_NAME'), '应该读取 tag 名')
  assert.ok(/version/.test(runs), '应该比较 package.json 的 version')
  assert.ok(/exit 1/.test(runs), '不一致时必须让 workflow 失败')
})

test('release.yml 拦住还没填的 OWNER 占位符', () => {
  const release = load('release.yml')
  const runs = allRuns(release).join('\n')
  assert.ok(runs.includes('OWNER'), '应该在发布前拦下 repository 还是占位符的情况')
})

test('release.yml 的长期发布方式是 OIDC，且那条路径不依赖任何仓库凭据', () => {
  const release = load('release.yml')
  const publishSteps = steps(release, 'publish')
    .filter(s => typeof s.run === 'string' && s.run.includes('npm publish'))

  assert.equal(publishSteps.length, 2, '应该有两条发布路径：引导 + OIDC')

  const oidc = publishSteps.find(s => String(s.if ?? '').includes("env.NPM_TOKEN == ''"))
  assert.ok(oidc, '缺少 OIDC 发布步骤')
  assert.ok(oidc.run.includes('--provenance'), 'OIDC 发布应带 --provenance')
  assert.ok(oidc.run.includes('--access public'), 'OIDC 发布应显式声明 public')
  assert.equal(
    JSON.stringify(oidc.env ?? {}).includes('TOKEN'), false,
    'OIDC 那条路径不该注入任何令牌 —— 那正是它存在的意义'
  )
})

test('release.yml 保留了引导发布路径（npm 要求包已存在才能配 Trusted Publisher）', () => {
  const raw = fs.readFileSync(path.join(WORKFLOWS, 'release.yml'), 'utf8')
  // npm-trust 文档的硬约束：包不存在就配不了 trusted publisher，OIDC 首次发布必然 404。
  // 这条断言的作用是防止后来者"顺手清理"掉引导路径，把首次发布直接弄坏。
  assert.ok(raw.includes('must already exist'), '应当把 npm 的这条约束写在 workflow 里')

  const release = load('release.yml')
  const publishSteps = steps(release, 'publish')
    .filter(s => typeof s.run === 'string' && s.run.includes('npm publish'))

  const bootstrap = publishSteps.find(s => String(s.if ?? '').includes("env.NPM_TOKEN != ''"))
  assert.ok(bootstrap, '缺少引导发布步骤')
  assert.ok(
    bootstrap.run.includes('NPM_TOKEN'),
    '引导步骤需要真的消费令牌（令牌由 job 级 env 注入，不需要在此重复声明）'
  )
})

test('NPM_TOKEN 映射在 job 级 env —— step 级 env 在自己的 if 里读不到', () => {
  const release = load('release.yml')
  assert.equal(
    release.jobs.publish.env?.NPM_TOKEN,
    '${{ secrets.NPM_TOKEN }}',
    'NPM_TOKEN 必须放在 job 级 env，否则两个发布步骤的 if 都判断不出来'
  )
})

test('release.yml 会创建 GitHub Release', () => {
  const release = load('release.yml')
  const runs = allRuns(release).join('\n')
  assert.ok(/gh release create/.test(runs), '应该用 gh release create 建 Release')
})

test('两个 workflow 都使用官方的 action 且锁在大版本上', () => {
  for (const name of ['ci.yml', 'release.yml']) {
    const workflow = load(name)
    const uses = allUses(workflow)
    assert.ok(uses.length >= 2, `${name} 里 action 太少了，检查是否漏写`)

    for (const use of uses) {
      // 允许 owner/repo@vN 或 owner/repo@<sha>
      assert.match(use, /^[\w.-]+\/[\w.-]+@(v?\d+[\w.-]*|[0-9a-f]{40})$/,
        `${name} 的 action 没有锁版本：${use}`)
    }
    assert.ok(uses.some(u => u.startsWith('actions/checkout@')), `${name} 应该 checkout`)
  }
})

test('workflow 文件本身不含敏感信息', () => {
  // 与仓库卫生检查同一套规则，这里只确认 workflow 目录被覆盖到了
  for (const name of ['ci.yml', 'release.yml']) {
    const text = fs.readFileSync(path.join(WORKFLOWS, name), 'utf8')
    assert.ok(!/C:\\+Users\\+(?!<)/.test(text), `${name} 里有本机用户目录路径`)
    assert.equal(text.charCodeAt(0) === 0xFEFF, false, `${name} 带了 UTF-8 BOM`)
  }
})
