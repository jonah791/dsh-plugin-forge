/**
 * 生成器模板的兼容性回归：`@deepseek-ai/dsh-tools` 的 peer 范围必须是 `>=` 而不是 `^`。
 *
 * 为什么单独立一条（2026-10-11 事故 · 实测证据）：宿主的兼容门拿插件的 peerDependencies 与
 * 运行时版本比对，比对失败就**静默**把该行 disable（报错只在真实启动的 stderr 里，守护预检
 * 因短路而 PASS）。模板里写 `^0.1.0-rc.6` 时，运行时升到 `0.2.x` 后**每一个新 forge 出来的
 * 插件都出生即不兼容、出生即不激活**——而现有 53 条测试全绿，因为它们没有一条看这个字段。
 *
 * 这条判据锁的是「模板不再产出排除当前运行时的范围」，不是锁某个具体版本号。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPackageJson, normalizeSpec, buildFiles } from '../lib/index.js'

function makeSpec(name) {
  const r = normalizeSpec({ name, description: 'peer 范围回归用' })
  assert.equal(r.ok, true, `normalizeSpec 失败：${r.ok === false ? r.error : ''}`)
  return r.spec
}

test('buildPackageJson：dsh-tools 的 peer 范围不得是 caret（caret 排除 0.2.x ⇒ 静默 disable）', () => {
  const pkg = JSON.parse(buildPackageJson(makeSpec('peer-range-probe')))
  const range = pkg.peerDependencies['@deepseek-ai/dsh-tools']
  assert.ok(typeof range === 'string' && range.length > 0, 'dsh-tools 的 peer 范围必须存在')
  assert.ok(
    !range.startsWith('^'),
    `peer 范围 "${range}" 是 caret：^0.x 会排除 0.2.x，宿主兼容门会静默 disable 该插件`,
  )
  assert.ok(range.startsWith('>='), `peer 范围应以 >= 开头（当前 "${range}"）——与全部可用自研插件一致`)
})

test('buildFiles：产出的 package.json 同样带这个范围（端到端，不只是单元）', () => {
  const files = buildFiles(makeSpec('peer-range-probe2'))
  const pkg = JSON.parse(files['package.json'])
  const range = pkg.peerDependencies['@deepseek-ai/dsh-tools']
  assert.ok(!range.startsWith('^'), `buildFiles 产出仍带 caret："${range}"`)
})
