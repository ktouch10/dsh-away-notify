// 字段规格（面板的单一来源）与 schema 不漂移。
//
// 面板自己不维护字段表 —— 字段描述由宿主根据 FIELD_SPECS + SETTINGS_ENUMS 下发。
// 这样加字段时只需要动 settings.mjs（默认值/描述）和 field-spec.mjs（标签/分组），
// 用例负责保证两边对得上。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SETTINGS_DEFAULTS, SETTINGS_ENUMS, loadSchema, buildConfig } from '../src/settings.mjs'
import { FIELD_SPECS, FIELD_GROUPS } from '../src/field-spec.mjs'

const ALLOWED_TYPES = new Set(['boolean', 'number', 'text', 'secret', 'select'])

test('字段规格的键集合与默认值表完全一致', () => {
  const specKeys = FIELD_SPECS.map(f => f.key).sort()
  const defaultKeys = Object.keys(SETTINGS_DEFAULTS).sort()
  assert.deepEqual(specKeys, defaultKeys, '两边字段集合必须一致（加字段时别忘了另一边）')
  assert.equal(new Set(specKeys).size, specKeys.length, '不该有重复 key')
  assert.equal(FIELD_SPECS.length, 22, '字段数量变了就同步更新这个期望值')
})

test('每个字段都有 label / 合法 type / 认识的分组', () => {
  for (const spec of FIELD_SPECS) {
    assert.ok(spec.label && spec.label.trim(), `${spec.key} 缺 label`)
    assert.ok(ALLOWED_TYPES.has(spec.type), `${spec.key} 的 type 不认识：${spec.type}`)
    assert.ok(FIELD_GROUPS.includes(spec.group), `${spec.key} 的分组不认识：${spec.group}`)
  }
})

test('type 必须与默认值的实际类型一致（否则面板会渲染成错的控件）', () => {
  for (const spec of FIELD_SPECS) {
    const value = SETTINGS_DEFAULTS[spec.key]
    if (spec.type === 'boolean') assert.equal(typeof value, 'boolean', `${spec.key} 说是布尔但默认值是 ${typeof value}`)
    else if (spec.type === 'number') assert.equal(typeof value, 'number', `${spec.key} 说是数字但默认值是 ${typeof value}`)
    else assert.equal(typeof value, 'string', `${spec.key} 说是文本但默认值是 ${typeof value}`)
  }
})

test('数字字段带 min/max，且默认值落在范围内', () => {
  for (const spec of FIELD_SPECS) {
    if (spec.type !== 'number') continue
    assert.equal(typeof spec.min, 'number', `${spec.key} 缺 min`)
    assert.equal(typeof spec.max, 'number', `${spec.key} 缺 max`)
    const value = SETTINGS_DEFAULTS[spec.key]
    assert.ok(value >= spec.min && value <= spec.max, `${spec.key} 的默认值 ${value} 超出 [${spec.min}, ${spec.max}]`)
  }
})

test('select 字段必须有对应枚举，且默认值在枚举里', () => {
  for (const spec of FIELD_SPECS) {
    if (spec.type !== 'select') continue
    const allowed = SETTINGS_ENUMS[spec.key]
    assert.ok(Array.isArray(allowed) && allowed.length >= 2, `${spec.key} 是 select 但 SETTINGS_ENUMS 里没有它`)
    assert.ok(allowed.includes(SETTINGS_DEFAULTS[spec.key]), `${spec.key} 的默认值不在枚举里`)
    // 每个枚举值都要有展示文案，否则下拉框会出现英文裸值
    for (const value of allowed) {
      assert.ok(spec.optionText?.[value], `${spec.key} 的选项 ${value} 缺展示文案`)
    }
  }
})

test('schema 的字段节点与字段规格一一对应', () => {
  const z = loadSchema()
  if (!z) return // 拿不到 schemastery 时降级（与插件行为一致）

  const json = buildConfig(z).toJSON()
  const root = Object.values(json.refs).find(node => node && node.dict)
  assert.deepEqual(Object.keys(root.dict).sort(), FIELD_SPECS.map(f => f.key).sort())
})
