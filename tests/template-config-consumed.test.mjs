/**
 * t-ef0af5ff 回归：模板生成的两个「撒谎」缺陷必须有判据。
 *
 * 判定层级声明：本文件是**源码级断言**（对 buildSource 的产出做字符串判定），
 * 不是行为断言——行为面（指向不存在脚本 ⇒ ok:false）未在本文件覆盖，见 card 未决项。
 * 对照组存在是必要的：「守卫被生成」与「守卫无条件被生成」必须可区分。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { buildSource } = await import('../lib/index.js')

const base = { name: 'dsh-demo-probe', description: '测试用' }

test('enabled 被生成时，apply() 必须真的消费它（否则是撒谎的开关）', () => {
  const src = buildSource(base)
  assert.ok(src.includes('enabled'), '缺省 spec 应生成 enabled 配置字段')
  assert.ok(
    src.includes('if (config.enabled === false) return'),
    'apply() 必须消费 enabled —— 旧模板只声明不检查（t-ef0af5ff 缺陷 ①）',
  )
})

test('对照组：自定义 config 不含 enabled 时，不得生成 config.enabled 守卫', () => {
  const src = buildSource({
    ...base,
    config: { threshold: { type: 'number', default: 5 } },
  })
  assert.ok(src.includes('threshold'), '自定义配置字段应被生成')
  assert.ok(
    !src.includes('config.enabled'),
    '配置里没有 enabled 却生成 config.enabled 守卫 ⇒ 生成物编译不过（守卫必须条件生成）',
  )
})

test('对照组：spec 自带 enabled 时，守卫同样要生成', () => {
  const src = buildSource({
    ...base,
    config: { enabled: { type: 'boolean', default: true } },
  })
  assert.ok(src.includes('if (config.enabled === false) return'), 'spec 显式声明 enabled 也应被消费')
})

test('脚本级裁决分支必须可达：产出里要有对字符串输出的 JSON 解析', () => {
  const src = buildSource({
    ...base,
    tools: [{ name: 'probe', description: '探针', execute: 'return "{}"' }],
  })
  assert.ok(
    src.includes('JSON.parse(__raw.trim())'),
    'execute 体约定返回字符串 ⇒ 旧模板的 typeof __raw === \'object\' 恒假、分支是死代码；' +
      '必须补字符串解析路径，否则脚本的 ok:false 永不生效（t-ef0af5ff 缺陷 ②）',
  )
  assert.ok(src.includes("'ok' in __parsed"), '解析结果含 ok 时应采纳它作为裁决')
})
