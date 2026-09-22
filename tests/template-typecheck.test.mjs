/**
 * 产物级判据：`plugin_forge` 生成的骨架必须**真的能通过 tsc**（t-ef0af5ff 端到端复验）
 *
 * ## 为什么需要它
 * 本仓此前的判据**全是源码级字符串断言**（见 `template-config-consumed.test.mjs` 开头的层级声明）。
 * 2026-09-22 首次真跑「生成 + 构建」时当场打脸——**两个骨架（对象体 / 字符串体）都报**：
 *   `src/index.ts(39,47): error TS2339: Property 'trim' does not exist on type 'never'.`
 * 根因：模板的 `const __raw = await (async () => { <用户体> })()` **被推断成用户体的返回类型**；
 * 当用户体返回**对象**（合法用法）时，下面的 `typeof __raw === 'string'` 把它收窄成 `never`
 * ⇒ `__raw.trim()` 报错。**每次生成的骨架出生就不通过 tsc**。
 *
 * 而 `lib/` **照样被产出**（tsc 有类型错误也会 emit）⇒「lib 存在」永远不能证明「构建成功」——
 * 这正是本判据必须**跑真编译器**、而不是断言字符串的原因。
 *
 * ## 判据结构
 * ① **尸体样本**：把修好的 `const __raw: unknown` 还原成旧写法 ⇒ 必须**报错**（证明有分辨力）
 * ② 好样本 ×2：对象体（新用法）与字符串体（旧约定）⇒ 都必须 exit 0
 *
 * 边界：在包内临时目录跑（模块解析沿包根 node_modules 找到 @deepseek-ai/* 与 @types/node），
 * 用完即删；**不触碰生产资产**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const { buildSource, buildTsconfig } = await import('../lib/index.js')

const TSC = join(pkgRoot, 'node_modules', 'typescript', 'bin', 'tsc')

/** 在包内临时目录里对一个生成的 src/index.ts 跑真 tsc。 */
function typecheck(source) {
  const dir = mkdtempSync(join(pkgRoot, '.tmp-typecheck-'))
  try {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'index.ts'), source, 'utf8')
    writeFileSync(join(dir, 'tsconfig.json'), buildTsconfig(), 'utf8')
    execFileSync(process.execPath, [TSC, '-p', join(dir, 'tsconfig.json')], { cwd: dir, stdio: 'pipe' })
    return { ok: true, output: '' }
  } catch (e) {
    return { ok: false, output: String(e?.stdout ?? '') + String(e?.stderr ?? '') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 用户体返回**对象**（合法用法，也是 2026-09-22 现场那次）。 */
const objectBody = {
  name: 'dsh-tc-probe',
  description: '产物级判据用',
  tools: [{ name: 'probe_ping', description: '探针', parameters: {}, execute: "return { ok: true, text: 'pong' }" }],
}

/** 用户体返回**字符串**（文档里的旧约定）。 */
const stringBody = {
  ...objectBody,
  tools: [{ name: 'probe_ping', description: '探针', parameters: {}, execute: 'return \'{"ok":true,"text":"pong"}\'' }],
}

test('★ 尸体样本：旧写法（`const __raw =`，无 unknown 声明）必须被本判据抓住', () => {
  const corpse = buildSource(objectBody).replace('const __raw: unknown =', 'const __raw =')
  assert.ok(
    corpse.includes('const __raw = await'),
    '前置：尸体样本必须真的还原成旧写法（否则这个用例在验空气）',
  )
  const r = typecheck(corpse)
  assert.equal(r.ok, false, '旧写法必须报错——否则本判据没有分辨力（对照组不失败 = 实验无结论）')
  assert.match(r.output, /TS2339|never/, '错误应当是「收窄成 never」的 TS2339，即 2026-09-22 的现场形状')
})

test('好样本：execute 体返回**对象**（新用法）⇒ 生成的骨架必须 tsc 通过', () => {
  const r = typecheck(buildSource(objectBody))
  assert.ok(r.ok, '对象体曾让 `typeof __raw === \'string\'` 收窄成 never ⇒ 出生即不可编译。tsc 输出：\n' + r.output)
})

test('好样本：execute 体返回**字符串**（旧约定）⇒ 生成的骨架同样必须 tsc 通过', () => {
  const r = typecheck(buildSource(stringBody))
  assert.ok(r.ok, '字符串体不得因修 ② 而回归。tsc 输出：\n' + r.output)
})
