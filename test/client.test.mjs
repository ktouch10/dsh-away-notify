// 客户端半边（设置表单）的守卫。
//
// 为什么值得单独测：客户端半边的失败模式很难受 —— DSH 的 clientModules 服务在启动时
// 同步扫描 `dsh.client` 声明，**声明写坏或 bundle 找不到会聚合成一次响亮的抛错
// （FAILED fiber）**，插件在设置页会显示成「启动失败」。而这条路径离线没法端到端跑，
// 所以把能静态查的都查掉。
//
// 另外一个关键约束：DSH 只**服务**客户端 bundle、不打包它（clientPath(id) 返回
// 「entry's client bundle」的绝对路径，rebuilt(id) 是外部构建器的钩子），
// 所以这个文件必须**自包含** —— 除了 react 不能 import 任何东西。下面有专门的用例。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SETTINGS_DEFAULTS, NAMESPACE, loadSchema, buildConfig } from '../src/settings.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_PATH = path.join(ROOT, 'src', 'client.mjs')

function clientText () {
  return fs.readFileSync(CLIENT_PATH, 'utf8')
}

/** 把客户端里的 FIELDS 当数据读出来（它是严格 JSON 字面量，就是为了这个）。 */
function clientFields () {
  const match = clientText().match(/export const FIELDS = (\[[\s\S]*?\n\])/)
  assert.ok(match, 'src/client.mjs 里应该有 `export const FIELDS = [...]`')
  return JSON.parse(match[1])
}

const ALLOWED_TYPES = new Set(['boolean', 'number', 'text', 'secret', 'select'])

test('客户端字段表是合法 JSON，且键集合与宿主 schema 完全一致', () => {
  const fields = clientFields()
  const clientKeys = fields.map(f => f.key).sort()
  const hostKeys = Object.keys(SETTINGS_DEFAULTS).sort()

  assert.deepEqual(clientKeys, hostKeys, '两边字段集合必须一致（加字段时别忘了另一边）')
  assert.equal(new Set(clientKeys).size, clientKeys.length, '字段表里不该有重复 key')
  assert.equal(fields.length, 22, '字段数量变了就同步更新这里的期望值')
})

test('每个字段都有 label / 合法 type，select 有选项，分组认识', () => {
  const groups = new Set(['基本', '触发规则', '投递', 'SMTP'])
  for (const field of clientFields()) {
    assert.ok(field.label && field.label.trim(), `${field.key} 缺 label`)
    assert.ok(ALLOWED_TYPES.has(field.type), `${field.key} 的 type 不认识：${field.type}`)
    assert.ok(groups.has(field.group), `${field.key} 的分组不认识：${field.group}`)
    if (field.type === 'select') {
      assert.ok(Array.isArray(field.options) && field.options.length >= 2, `${field.key} 的 options 不合法`)
      for (const option of field.options) assert.equal(option.length, 2, `${field.key} 的选项应是 [值, 文案]`)
    }
    if (field.type === 'number') {
      assert.equal(typeof field.min, 'number', `${field.key} 缺 min`)
      assert.equal(typeof field.max, 'number', `${field.key} 缺 max`)
    }
  }
})

test('select 的默认值必须落在选项里（否则表单会显示成空白）', () => {
  for (const field of clientFields()) {
    if (field.type !== 'select') continue
    const values = field.options.map(o => o[0])
    assert.ok(
      values.includes(SETTINGS_DEFAULTS[field.key]),
      `${field.key} 的默认值 ${SETTINGS_DEFAULTS[field.key]} 不在选项 ${values.join('/')} 里`
    )
  }
})

test('宿主 schema 的字段节点与客户端字段表一一对应', () => {
  const z = loadSchema()
  if (!z) return // 拿不到 schemastery 时降级（与插件行为一致）

  const schema = buildConfig(z)
  const json = schema.toJSON()
  const root = Object.values(json.refs).find(node => node && node.dict)
  const hostKeys = Object.keys(root.dict).sort()

  assert.deepEqual(hostKeys, clientFields().map(f => f.key).sort())
})

test('客户端半边必须自包含：除了 react 不能 import 任何东西', () => {
  const text = clientText()
  const imports = [...text.matchAll(/^\s*import\s[^\n]*from\s+['"]([^'"]+)['"]/gm)].map(m => m[1])
  assert.deepEqual(imports, ['react'], `客户端只能 import react，实际：${imports.join(', ')}`)
  assert.ok(!/from\s+['"]\.\.?\//.test(text), '不能有相对导入（DSH 不打包，解析不到）')
})

test('客户端半边声明了需要的服务', () => {
  const text = clientText()
  const match = text.match(/export const inject = \[([^\]]*)\]/)
  assert.ok(match, '客户端应该导出 inject')
  const services = match[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean)
  assert.ok(services.includes('slots'), '要往 slot 里注册组件，必须 inject slots')
  assert.ok(services.includes('configForms'), '要读写配置，必须 inject configForms')
})

test('客户端半边目前**不**在 package.json 里声明（等 boot 路径验证通过再打开）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

  // 2026-09-28：加上 `dsh.client` 声明之后，**DSH 起不来了**。
  // DSH 自己的文档写着：clientModules「Construction runs the activation scan
  // synchronously — a malformed declaration or missing bundle among the already-loaded
  // entries aggregates into one loud throw (FAILED fiber; the boot activation audit
  // reports it)」。宿主半边在两次失败的启动里都正常 apply 了（status.log 有记录），
  // 所以问题出在启动后半段的客户端插件清单上 —— 而那是这次唯一新增的启动路径改动。
  //
  // 所以先把声明停用：宿主半边照常工作，等能在一个可控的启动里确认 DSH 接受的
  // bundle 形态（是单个已构建产物？还是会被改写？）之后再打开。
  // 这条断言是刻意的「减速带」——重新打开前先把失败原因搞清楚。
  assert.equal(pkg.dsh?.client, undefined, '要重新打开 dsh.client，先确认 bundle 形态被 DSH 接受')

  // 实现本身留着并被下面的用例检查（自包含、字段表不漂移），只是暂时不挂出去
  assert.ok(fs.existsSync(CLIENT_PATH), 'src/client.mjs 应该留着（实现是好的，只是暂不声明）')

  // exports["./client"] 留着无害；若存在就必须指向真文件
  const target = typeof pkg.exports?.['./client'] === 'string'
    ? pkg.exports['./client']
    : pkg.exports?.['./client']?.default
  if (target) assert.ok(fs.existsSync(path.join(ROOT, target)), `exports["./client"] 指向的文件不存在：${target}`)
})

test('客户端与宿主用的是同一个命名空间（写成字面量会漂移）', () => {
  const text = clientText()
  assert.match(text, /export const NAMESPACE = 'away-notify'/, '客户端命名空间应与 settings.mjs 的 NAMESPACE 一致')
  assert.equal(NAMESPACE, 'away-notify')
  // slot 名也必须是官方文档里那个
  assert.match(text, /export const SLOT = 'settings\.plugins\.tab'/)
})
