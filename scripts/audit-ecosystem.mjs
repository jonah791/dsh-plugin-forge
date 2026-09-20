/**
 * 自研插件生态审计器（2026-09-20）。
 *
 * 判据**不另写一套**——直接复用 dsh-plugin-forge 的导出（`collectCtxServices` / `findInternalImports`），
 * 保证「生成器要求的」与「审计器检查的」永远是同一把尺子（§5.22 判据单一真源）。
 *
 * 六个判据：
 *  1. 依赖遮蔽：`node_modules/@deepseek-ai` 存在真实副本 ⇒ 会遮蔽宿主 link farm（§5.15 §4 事故）
 *     残留备份 `@deepseek-ai.BAK*` 一并列出（说明曾修过，但现场还在）
 *  2. 组合优先：源码里导入别家包的内部路径（`dsh-x/lib/...`、`@deepseek-ai/x/dist/...`）
 *  3. 声明清晰：源码用到的 `ctx.<svc>` 未出现在 `export const inject` 里 ⇒ cordis 严格代理下**启动期抛错**
 *  4. 可维护性：缺 `tests/`（无回归网）
 *  5. 语义文档：缺 `docs/semantic.md`（§5.20：新能力开工前先落文档）
 *  6. Fabric 契约面：缺 `dsh-plugin.json`（前瞻项——Fabric 仍是 Draft，**不算缺陷**，仅计数）
 *
 * 用法：node scripts/audit-ecosystem.mjs [selfPluginsDir]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectCtxServices, findInternalImports, listPluginDirs, isThirdPartyRepo } from '../lib/index.js'

/** 默认根 = 本脚本所在仓的**父目录**（`self-plugins/`）——从脚本位置推导，Windows/WSL 同一真源 */
const ROOT = process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CORE_EXCLUDE_DIRS = new Set(['node_modules', 'lib', 'dist', '.git', 'docs', 'tests'])

/**
 * **作者判据（2026-09-20 加，主人纠正后）**：self-plugins 目录里**不全是我的**——`dsh-agent-teams` 是
 * `github.com/NanmiCoder/...` 的第三方（走 §5.23 依赖流程：不 fork、不改源码、pin + 黑盒验证）。
 * ⚠ 不要用 `plugin_list` 的分类：它按「是否在 self-plugins 里」归类，会把第三方算成「自研」。
 * 判据实现已上移到 `lib`（`isThirdPartyRepo`）——**与回填器共用一份**，避免两套判据漂移。
 */
const isThirdParty = (dir, pkg) => isThirdPartyRepo(dir, String(pkg.name ?? ''))

function walk(dir, acc = []) {
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (!CORE_EXCLUDE_DIRS.has(e.name)) walk(p, acc) }
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(e.name)) acc.push(p)
  }
  return acc
}

const read = (p) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
/**
 * 剔注释 + **剔字符串字面量**后再判用法。
 * 两类假阳性都踩过（2026-09-20）：
 *  ① 注释里提到包名 ⇒ 被当成违规 import；
 *  ② **模板字符串里**的 `ctx.commands?.handle`（生成器源码里就有）⇒ 被当成真实 service 使用。
 */
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/'(?:[^'\\]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\]|\\.)*"/g, '""')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``')

/** 只审计**宿主侧**文件：客户端 src/client/** 有自己的一套 ctx 契约，与 host inject 不是一回事 */
const isHostSide = (p) => !/[\\/]src[\\/]client[\\/]/.test(p)
/**
 * 非 service 成员（启发式排除）：
 *  - JS 内置成员：被审计代码里 `ctx` 常常是**局部变量**（字符串切片 `ctx.slice`、数组 `ctx.length`、面板命令的 ctx.now）
 *  - 已由 forge 的 collectCtxServices 排除的 cordis 内建成员不在此列
 * 这是启发式而非证明：命中的条目仍应人工看一眼（本文件底部「判据口径」已声明）。
 */
const NON_SERVICE = new Set(['length', 'slice', 'now', 'nowMs', 'map', 'filter', 'push', 'pop', 'forEach', 'find', 'some', 'every', 'reduce', 'join', 'split', 'trim', 'replace', 'indexOf', 'includes', 'concat', 'sort', 'dups', 'refs', 'tagReuse', 'usage', 'size', 'flat', 'flatMap'])
/** 文件是否真的在跟 cordis 打交道（否则里面的 `ctx` 多半是局部对象） */
const touchesCordis = (s) => /@deepseek-ai\/cordis|:\s*Context\b|\bContext\b/.test(s)

const rows = []
for (const name of listPluginDirs(ROOT)) {
  const dir = join(ROOT, name)
  const pkg = JSON.parse(read('package.json') || '{}')
  const srcFiles = walk(join(dir, 'src')).filter(isHostSide)
  const stripped = srcFiles.map((f) => ({ f, s: strip(read(f)) })).filter((x) => touchesCordis(x.s))
  // 声明 inject 有**两种合法形态**：① 函数插件 `export const inject = [...]`；② Service 类 `static inject = [...]`
  // （2026-09-20 实测两处坑：只认 ① 会把 dsh-agent-compact 误判成「无 inject 导出」；
  //  若在**已剔字符串**的文本上抓 ②，数组内容会被抹成空串 ⇒ 声明必须在**原文**上抓）
  const entry = read(join(dir, 'src', 'index.ts'))
  const rawAll = srcFiles.map((f) => read(f)).join('\n')
  const m = /export const inject[^=]*=\s*(\[[^\]]*\])/.exec(entry)
  const mStatic = /static\s+inject[^=]*=\s*(\[[^\]]*\])/.exec(rawAll)
  const pick = m ?? mStatic
  const declared = pick ? Array.from(pick[1].matchAll(/['"]([^'"]+)['"]/g)).map((x) => x[1]).sort() : null
  const used = [...new Set(stripped.flatMap((x) => collectCtxServices(x.s)))].filter((s) => !NON_SERVICE.has(s)).sort()
  const missing = declared ? used.filter((s) => !declared.includes(s)) : used
  const internal = findInternalImports(stripped.map((x) => x.s))

  let nm = []
  try { nm = readdirSync(join(dir, 'node_modules')) } catch { /* 无 node_modules 属正常 */ }
  // 判据修正（2026-09-20）：`@deepseek-ai` **真实副本**才是遮蔽风险；
  // `@deepseek-ai.BAK-*` 是 2026-09-18/19 修复留下的痕迹（改名后解析回落到宿主共享根）⇒ 属**死重量**，不是缺陷
  const shadow = nm.includes('@deepseek-ai')
  const bak = nm.filter((n) => /^@deepseek-ai\.BAK/.test(n))
  const hasTests = existsSync(join(dir, 'tests'))
  const hasSemantic = existsSync(join(dir, 'docs', 'semantic.md'))
  const hasFabric = existsSync(join(dir, 'dsh-plugin.json'))

  rows.push({ name, version: pkg.version ?? '', third: isThirdParty(dir, pkg), shadow, bak, internal, missing, hasTests, hasSemantic, hasFabric, declared })
}

const mine = rows.filter((r) => !r.third)
const theirs = rows.filter((r) => r.third)
const bad = (r) => r.shadow || r.internal.length > 0 || r.missing.length > 0
const mark = (b) => (b ? '🔴' : '')

console.log(`# 自研插件生态审计（${ROOT}）· ${rows.length} 个目录 = 自研 ${mine.length} + 第三方 ${theirs.length} · 判据与 dsh-plugin-forge 同源\n`)
console.log(`> ⚠ 第三方不算「需重新设计」：它们走 §5.23 依赖流程（不 fork、不改源码、pin + 黑盒验证）。`)
console.log(`> 第三方：${theirs.map((r) => r.name + '@' + r.version).join(', ') || '（无）'}\n`)
console.log('## 🔴 需重新设计（**仅自研**，有硬判据命中）\n')
const flagged = mine.filter(bad)
if (flagged.length === 0) console.log('（无）')
for (const r of flagged) {
  const why = []
  if (r.shadow) why.push('**遮蔽**：node_modules/@deepseek-ai 真实副本存在 ⇒ 遮蔽宿主 link farm（§5.15 §4）')
  if (r.internal.length > 0) why.push('内部路径导入：' + r.internal.join(', '))
  if (r.missing.length > 0) why.push('inject 未声明却被使用：' + r.missing.join(', ') + (r.declared ? `（已声明 ${JSON.stringify(r.declared)}）` : '（**无 inject 导出**）'))
  console.log(`- ${r.name}@${r.version} — ${why.join(' ｜ ')}`)
}
console.log(`\n小计：${flagged.length} / ${mine.length}（自研）`)

const bakOnly = rows.filter((r) => !bad(r) && r.bak.length > 0)
console.log(`\n## 🟡 死重量（不是缺陷，可清理）`)
console.log(`- \`@deepseek-ai.BAK-*\` 残留：${bakOnly.length} 个 —— 这是 2026-09-18/19 修复**留下的痕迹**（把真实副本改名，使解析回落到宿主共享根）。留着无害（解析不会读它），但占磁盘；删掉即可。`)
console.log(`  ${bakOnly.map((r) => r.name).join(', ') || '（无）'}`)

const noTest = rows.filter((r) => !r.hasTests)
const noSem = rows.filter((r) => !r.hasSemantic)
const noFab = rows.filter((r) => !r.hasFabric)
console.log(`\n## 🟡 可维护性缺口（非硬错，但属既有体检项）`)
console.log(`- 缺 tests/：${noTest.length} 个 → ${noTest.map((r) => r.name).join(', ') || '（无）'}`)
console.log(`- 缺 docs/semantic.md：${noSem.length} 个 → ${noSem.map((r) => r.name).join(', ') || '（无）'}`)
console.log(`\n## ⚪ 前瞻项（Fabric 仍是 Draft，不算缺陷）`)
console.log(`- 缺 dsh-plugin.json：${noFab.length} / ${rows.length}${noFab.length ? ' → ' + noFab.map((r) => r.name).join(', ') : '（全覆盖）'}`)
console.log(`\n## 判据口径`)
console.log('- 遮蔽 = `node_modules/@deepseek-ai` 是否作为**真实目录副本**存在（junction/symlink 指向宿主共享根则不算；本脚本按名字存在即报，需人工二次确认链接类型）')
console.log('- inject 对账 = 剔除注释后扫 `ctx.<svc>`，剔除 cordis 内建成员（logger/on/effect…）')
console.log('- 内部导入 = `dsh-x/(lib|src|dist|build)/…` 或 `@deepseek-ai/x/(lib|src|dist|build)/…`')
