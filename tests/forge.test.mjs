/**
 * plugin-forge 纯生成器套件（离线、零网络、零部署）。
 * 覆盖：正常路径 + 失败/退化路径（非法 spec、对象级 required 数组、空 tools、缺件产物）。
 * 末尾两条是**尸体测试**：把生成物真正写到临时目录跑一次 `node --test`，
 * 证明「模板产物自带可跑回归检查」这条不变量不是空断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  pluginId, sanitizeRequired, normalizeSpec, buildSource, buildPackageJson, buildTsconfig,
  buildPatch, buildReadme, buildSemanticDoc, buildSmokeTest, buildFiles,
  collectCtxServices, resolveInject, findInternalImports, buildForgeManifest, buildGitignore, resolveUpFrom,
} from '../lib/index.js'

const SPEC = {
  name: 'dsh-demo-tool',
  description: '演示插件：验证生成器',
  tools: [{
    name: 'demo_ping',
    description: 'Ping 一下',
    parameters: { msg: { type: 'string', required: true }, n: { type: 'number' } },
    execute: 'return { ok: true, msg: args.msg }',
  }],
}

/** 把生成物写到临时目录，返回目录（调用方负责清理） */
function materialize(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-test-'))
  for (const [f, content] of Object.entries(buildFiles(spec))) {
    const abs = join(dir, f)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  return dir
}

function runGeneratedTests(dir) {
  // 必须摘掉 NODE_TEST_CONTEXT：否则子进程被 node:test 判定为「递归调用 run()」→
  // **静默跳过所有文件并以 0 退出**（假绿），尸体测试会失去意义。
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return spawnSync(process.execPath, ['--test', 'tests/smoke.test.mjs'], { cwd: dir, encoding: 'utf8', env })
}

// ---------- pluginId ----------

test('pluginId: 去 dsh- 前缀换 agent- 前缀（组合行 id 约定）', () => {
  assert.equal(pluginId('dsh-foo'), 'agent-foo')
  assert.equal(pluginId('dsh-a-b-c'), 'agent-a-b-c')
  assert.equal(pluginId('nodash'), 'agent-nodash')
  assert.equal(pluginId(''), 'agent-')
})

// ---------- sanitizeRequired ----------

test('sanitizeRequired: 保留字段级 required:true、删除 required:false、递归数组/对象', () => {
  const out = sanitizeRequired({ properties: { ok: { type: 'boolean', required: true }, x: { required: false } }, type: 'object' })
  assert.deepEqual(out, { properties: { ok: { type: 'boolean', required: true }, x: {} }, type: 'object' })
  assert.deepEqual(sanitizeRequired([{ required: true }, { required: false }]), [{ required: true }, {}])
  assert.deepEqual(sanitizeRequired('plain'), 'plain')
  assert.equal(sanitizeRequired(null), null)
})

test('sanitizeRequired: 失败路径——对象级 required 数组必须响亮拒绝（不许静默剥除）', () => {
  // 真实语义：报错路径记的是**含 required 的那个对象**的路径（'$'），不是 '$.required'——
  // 抛出发生在读取该键时，尚未把 '.required' 拼进 path。
  assert.throws(
    () => sanitizeRequired({ type: 'object', required: ['a'] }, '$'),
    (e) => e instanceof Error && /对象级 required 数组/.test(e.message) && e.message.startsWith('forge spec $:'),
  )
  assert.throws(() => sanitizeRequired({ properties: { a: { required: ['b'] } } }), /required 数组/)
})

// ---------- normalizeSpec ----------

test('normalizeSpec: 缺 dsh- 前缀自动补齐；显式 inject 原样保留', () => {
  const r = normalizeSpec({ name: 'demo', description: 'd' })
  assert.equal(r.ok, true)
  assert.equal(r.spec.name, 'dsh-demo')
  assert.deepEqual(r.spec.inject, undefined)
  const r2 = normalizeSpec({ name: 'dsh-demo', description: 'd', inject: ['tools', 'subprocess'] })
  assert.deepEqual(r2.spec.inject, ['tools', 'subprocess'])
})

test('normalizeSpec: 有 tools 但未声明 tools service → 自动补在 inject 首位', () => {
  const r = normalizeSpec({ name: 'demo', description: 'd', inject: ['subprocess'], tools: [{ name: 't', description: 'd', execute: 'return {}' }] })
  assert.deepEqual(r.spec.inject, ['tools', 'subprocess'])
  const same = normalizeSpec({ name: 'demo', description: 'd', inject: ['tools'], tools: [{ name: 't', description: 'd', execute: 'return {}' }] })
  assert.deepEqual(same.spec.inject, ['tools'], '已含 tools 时不得重复插入')
})

test('normalizeSpec: 失败路径——非法插件名（大写/数字开头/下划线/空）一律拒绝', () => {
  for (const bad of ['Demo', '1demo', 'de_mo', 'dsh-', '', ' demo']) {
    const r = normalizeSpec({ name: bad, description: 'd' })
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 应被拒绝`)
    assert.match(r.error, /插件名须为小写字母开头/)
  }
})

// ---------- buildSource ----------

test('buildSource: 生成 name/inject/apply/工具注册/Config schema', () => {
  const src = buildSource(SPEC)
  // 真实语义：导出的 name 是**组合行 id**（pluginId → agent-xxx），不是包名
  assert.match(src, /export const name = "agent-demo-tool"/)
  assert.match(src, /export const inject = \["tools"\] as const/)
  assert.match(src, /export function apply\(ctx: Context, config: Config\): void \{/)
  assert.match(src, /ctx\.tools\.register\(defineTool\(\{/)
  assert.match(src, /name: "demo_ping"/)
  assert.match(src, /export interface Config \{/)
  assert.match(src, /export const Config = z\.object\(/)
})

test('buildSource: parameters 内联 required:true（DSH DSL）+ 默认 render 为 JSON.stringify', () => {
  const src = buildSource(SPEC)
  assert.match(src, /"required":true/)
  assert.match(src, /render: \(_a: unknown, v: any\) => \[\{ type: 'text', text: JSON\.stringify\(v\) \}\]/)
  assert.match(src, /async execute\(args: \{\n  msg: string\n  n\?: number\n\}\)/)
})

test('buildSource: 退化路径——无 tools 时留 TODO 占位（不得生成空 apply 崩产物）', () => {
  const src = buildSource({ name: 'dsh-empty', description: 'd' })
  assert.match(src, /\/\/ TODO: 在此实现插件逻辑/)
  // 真实语义：inject 缺省恒为 ['tools']（与是否声明 tools 无关），故 defineTool 仍被 import；
  // 但**不得**出现任何 ctx.tools.register —— 无工具时不生成注册块。
  assert.equal(src.includes('ctx.tools.register'), false, '无工具时不得生成注册块')
  assert.match(src, /export const inject = \["tools"\] as const/)
})

test('buildSource: 退化路径——config 缺省回落 enabled 开关；自定义字段带默认值时可选', () => {
  const def = buildSource({ name: 'dsh-c', description: 'd' })
  assert.match(def, /enabled: boolean/)
  assert.match(def, /enabled: z\.boolean\(\)\.default\(true\)/)
  const custom = buildSource({ name: 'dsh-c', description: 'd', config: { port: { type: 'number', default: 8080 }, host: { type: 'string', required: true } } })
  assert.match(custom, /port: number/)
  assert.match(custom, /host: string/)
  assert.match(custom, /port: z\.number\(\)\.default\(8080\)/)
  assert.match(custom, /host: z\.string\(\)\.default\(""\)|host: z\.string\(\),/)
})

// ---------- package.json / tsconfig / patch / readme ----------

test('buildPackageJson: 可解析、ESM、含 build+test 脚本与 peerDependencies', () => {
  const pkg = JSON.parse(buildPackageJson(SPEC))
  assert.equal(pkg.name, 'dsh-demo-tool')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.scripts.build, 'tsc -p tsconfig.json')
  assert.equal(pkg.scripts.test, 'node --test "tests/*.test.mjs"')
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-tools'])
})

test('buildTsconfig: 可解析且为 NodeNext ESM 配置', () => {
  const ts = JSON.parse(buildTsconfig())
  assert.equal(ts.compilerOptions.module, 'NodeNext')
  assert.equal(ts.compilerOptions.outDir, 'lib')
  assert.equal(ts.compilerOptions.strict, true)
  assert.deepEqual(ts.include, ['src'])
})

test('buildPatch: 组合行结构（insert/id/name/config 缩进固定）', () => {
  assert.equal(buildPatch(SPEC), '- insert:\n    - id: agent-demo-tool\n      name: dsh-demo-tool\n      config: {}\n')
})

test('buildReadme: 含标题/描述/工具清单/组合行 id', () => {
  const md = buildReadme(SPEC)
  assert.match(md, /^# dsh-demo-tool/)
  assert.match(md, /- `demo_ping`：Ping 一下/)
  assert.match(md, /组合行 id：`agent-demo-tool`/)
})

test('buildReadme: 退化路径——无 tools 时清单为空但结构完整', () => {
  const md = buildReadme({ name: 'dsh-empty', description: 'd' })
  assert.match(md, /## 工具/)
  assert.match(md, /## 构建与挂载/)
})

// ---------- 模板产出清单（本次补齐的不变量） ----------

test('buildFiles: 产出清单固定为 8 件（含 docs/semantic.md、tests/smoke.test.mjs、.gitignore）', () => {
  const files = buildFiles(SPEC)
  assert.deepEqual(Object.keys(files).sort(), [
    '.gitignore', 'README.md', 'cordis.patch.yml', 'docs/semantic.md', 'package.json',
    'src/index.ts', 'tests/smoke.test.mjs', 'tsconfig.json',
  ])
  assert.ok(files['package.json'].includes('"test"'), '生成物必须暴露 test 脚本')
})

test('buildSemanticDoc: 必备 10 节齐全（缺节会被 semantic_check D4 报错）', () => {
  const doc = buildSemanticDoc(SPEC)
  for (const h of ['## 1 · 定位与反定位', '## 2 · 术语表', '## 3 · 概念模型与不变量', '## 4 · 契约',
    '### 4.3 调用点清单 [MUST]', '## 5 · 边界与信任', '## 6 · 与既有机制的关系',
    '## 7 · 可证伪验收清单', '## 8 · 与实现的关系', '## 9 · 实践修订记录', '## 10 · 未决问题']) {
    assert.ok(doc.includes(h), `缺节：${h}`)
  }
  assert.match(doc, /> 元信息：/)
})

test('buildSemanticDoc: 工具清单来自 spec（退化：无 tools 时给出占位行）', () => {
  assert.match(buildSemanticDoc(SPEC), /- `demo_ping`：Ping 一下/)
  assert.match(buildSemanticDoc({ name: 'dsh-empty', description: 'd' }), /暂无工具/)
})

test('buildSmokeTest: 引用 spec.name 与组合行 id（不依赖构建产物）', () => {
  const t = buildSmokeTest(SPEC)
  assert.ok(t.includes("assert.equal(pkg.name, \"dsh-demo-tool\")"))
  assert.ok(t.includes('agent-demo-tool'))
  assert.equal(t.includes('lib/index.js'), true)
})

// ---------- 生态倡议书三条原则 → 可机械验证的闸门（v0.2.0） ----------

test('collectCtxServices: 扫出 ctx.<svc>，剔除 cordis 内建成员（logger/on/effect…）', () => {
  const body = 'ctx.logger("x"); ctx.tools.register(t); ctx.llm.call(); ctx.on("e", () => {}); ctx.effect(() => {})'
  assert.deepEqual(collectCtxServices(body), ['llm', 'tools'])
  assert.deepEqual(collectCtxServices('const x = ctx2.foo; ctxX.bar'), [], '不得把 ctx2/ctxX 误当 ctx')
})

test('resolveInject: 声明清晰——源码用到但未声明的 service 自动补齐（启动期抛错的根因）', () => {
  const r = resolveInject({ name: 'dsh-a', description: 'd', inject: ['subprocess'], tools: [{ name: 't', description: 'd', execute: 'return ctx.llm.chat({})' }] })
  assert.deepEqual(r.inject, ['subprocess', 'llm', 'tools'], '声明序在前，新补的按字母序在后')
  assert.deepEqual(r.added, ['llm', 'tools'])
  assert.deepEqual(r.unused, ['subprocess'])
})

test('resolveInject: 退化——无 tools 且未显式声明时不抱怨自带的 tools 缺省', () => {
  const r = resolveInject({ name: 'dsh-a', description: 'd' })
  assert.deepEqual(r.inject, ['tools'])
  assert.deepEqual(r.added, [])
  assert.deepEqual(r.unused, [], '缺省 tools 不该被当成「声明了没用」')
})

test('findInternalImports: 组合优先——别家包的内部路径命中，公开入口不误伤', () => {
  const hit = findInternalImports([
    "import x from 'dsh-plugin-manager/lib/registry.js'",
    "import y from '@deepseek-ai/dsh-tools/src/index.js'",
    "const z = require('dsh-a/dist/x.cjs')",
  ])
  assert.deepEqual(hit, ['@deepseek-ai/dsh-tools/src/index.js', 'dsh-a/dist/x.cjs', 'dsh-plugin-manager/lib/registry.js'])
  assert.deepEqual(findInternalImports([
    "import { defineTool } from '@deepseek-ai/dsh-tools'",
    "import { join } from 'node:path'",
    "import type { Context } from '@deepseek-ai/cordis'",
  ]), [], '包根入口是公开面，不得被当成内部路径')
})

test('buildForgeManifest: 静态声明（本地约定）——contract/inject/contributes/capability 齐全', () => {
  const m = buildForgeManifest(SPEC)
  assert.equal(m.contract, 1)
  assert.deepEqual(m.inject, ['tools'])
  assert.deepEqual(m.contributes.tools, ['demo_ping'])
  assert.equal(m.capability.runtime, 'trusted-in-process')
  assert.equal(m.capability.sandbox, false, '不得把同进程插件伪装成沙箱')
  assert.match(m.capability.note, /不构成技术强制/)
})

test('buildPackageJson: 内嵌 dshForge 静态声明且与源码 inject 同源', () => {
  const pkg = JSON.parse(buildPackageJson(SPEC))
  assert.ok(pkg.dshForge, '必须有 dshForge 声明')
  const src = buildSource(SPEC)
  const declared = JSON.parse(/export const inject = (\[[^\]]*\]) as const/.exec(src)[1])
  assert.deepEqual(pkg.dshForge.inject, declared, '两个表示必须同源（单一真源）')
})

test('buildGitignore: 忽略 node_modules 与 lib（新插件不从「忘记忽略」起步）', () => {
  const gi = buildGitignore()
  assert.ok(gi.includes('node_modules/'))
  assert.ok(gi.includes('lib/'))
})

test('resolveUpFrom: Node 解析语义显式版（注入 exists ⇒ 可离线测）', () => {
  // 路径一律用 join 构造——字面量反斜杠会让本用例在 WSL/Linux 上假红（夹具不得依赖运行平台）
  const farmRoot = join('work')
  const cordis = join(farmRoot, 'node_modules', '@deepseek-ai', 'cordis')
  const present = new Set([cordis])
  const exists = (p) => present.has(p)
  const from = join(farmRoot, 'self-plugins', 'dsh-x')
  assert.equal(resolveUpFrom(from, join('@deepseek-ai', 'cordis'), exists), cordis)
  assert.equal(resolveUpFrom(from, join('@types', 'node'), exists), null, '找不到必须返回 null，不得静默兜底')
})

test('normalizeSpec: 组合优先闸门——内部路径导入在写盘前被拒（错误串含规范与出路）', () => {
  const r = normalizeSpec({ name: 'demo', description: 'd', imports: ["import x from 'dsh-other/lib/deep.js'"] })
  assert.equal(r.ok, false)
  assert.match(r.error, /组合优先违规/)
  assert.match(r.error, /dsh-other\/lib\/deep\.js/)
  assert.match(r.error, /公开入口/)
  const ok = normalizeSpec({ name: 'demo', description: 'd', imports: ["import type { Context } from '@deepseek-ai/cordis'"] })
  assert.equal(ok.ok, true, '公开入口不得被拒')
})

test('normalizeSpec: 声明清晰——notes 报告自动补齐与「声明了没用」', () => {
  const r = normalizeSpec({ name: 'demo', description: 'd', inject: ['subprocess'], tools: [{ name: 't', description: 'd', execute: 'return ctx.llm.chat({})' }] })
  assert.equal(r.ok, true)
  assert.ok(r.notes.some((n) => /已自动补声明 inject: llm/.test(n)), `缺补齐说明：${JSON.stringify(r.notes)}`)
  assert.ok(r.notes.some((n) => /声明了未使用的 service: subprocess/.test(n)), `缺未使用说明：${JSON.stringify(r.notes)}`)
  assert.deepEqual(normalizeSpec({ name: 'demo', description: 'd' }).notes, [], '干净 spec 不得产生噪音说明')
})

test('buildReadme: 生态契约 + 能力边界两节（capability ≠ 沙箱写进产物）', () => {
  const md = buildReadme(SPEC)
  assert.match(md, /## 生态契约/)
  assert.match(md, /依赖 service\*\*（`inject`）：`tools`/)
  assert.match(md, /## 能力边界（诚实声明）/)
  assert.match(md, /不构成安全沙箱/)
  assert.match(md, /组合行 id：`agent-demo-tool`/)
})

// ---------- 尸体测试：生成物真跑起来 ----------

test('生成物自带测试可跑且通过（写出临时目录 → node --test）', () => {
  const dir = materialize(SPEC)
  try {
    const r = runGeneratedTests(dir)
    assert.equal(r.status, 0, `生成物测试未通过：\n${r.stdout}\n${r.stderr}`)
    // 防「假绿」：确认真的跑了 9 条用例，而不是被递归守卫跳过（跳过时也是 status 0）
    assert.match(r.stdout, /# pass 9|pass 9/, `生成物测试疑似被跳过（假绿）：\n${r.stdout}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('尸体测试：删掉生成物的 docs/semantic.md → 生成物测试必须失败（守卫非空断言）', () => {
  const dir = materialize(SPEC)
  try {
    assert.equal(runGeneratedTests(dir).status, 0, '前提：未破坏时应通过')
    unlinkSync(join(dir, 'docs', 'semantic.md'))
    const r = runGeneratedTests(dir)
    assert.notEqual(r.status, 0, `缺 docs/semantic.md 时生成物测试必须变红——否则守卫是空的\nstatus=${r.status} error=${r.error}\n${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout + r.stderr, /semantic\.md/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('尸体测试：把 inject 改空（漏声明 tools）→ 生成物的「声明清晰」守卫必须变红', () => {
  const dir = materialize(SPEC)
  try {
    const srcPath = join(dir, 'src', 'index.ts')
    const before = readFileSync(srcPath, 'utf8')
    assert.ok(before.includes('export const inject = ["tools"] as const'), '前提：未破坏时应通过')
    writeFileSync(srcPath, before.replace('export const inject = ["tools"] as const', 'export const inject = [] as const'), 'utf8')
    const r = runGeneratedTests(dir)
    assert.notEqual(r.status, 0, `inject 与源码不符时必须变红——否则守卫是空的\nstatus=${r.status}\n${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout + r.stderr, /未声明的 service|dshForge\.inject/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('尸体测试：把内部路径导入写进 src → 生成物的「组合优先」守卫必须变红', () => {
  const dir = materialize(SPEC)
  try {
    const srcPath = join(dir, 'src', 'index.ts')
    writeFileSync(srcPath, readFileSync(srcPath, 'utf8').replace(
      "import type { Context } from '@deepseek-ai/cordis'",
      "import type { Context } from '@deepseek-ai/cordis'\nimport { x } from 'dsh-plugin-manager/lib/registry.js'",
    ), 'utf8')
    const r = runGeneratedTests(dir)
    assert.notEqual(r.status, 0, `内部路径导入必须被生成物守卫抓到\nstatus=${r.status}\n${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout + r.stderr, /内部路径/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
