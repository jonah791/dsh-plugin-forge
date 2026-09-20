/**
 * Fabric 契约面回填器（2026-09-20）。
 *
 * 给**存量自研插件**补上生成器 v0.3 产出的两个 Fabric 面文件：
 *   - `dsh-plugin.json`：RFC 0001 §7.1 冻结形状；`version` 取插件**真版本**（写死 0.1.0 即对外假声明）
 *   - `src/fabric.ts`：不依赖 DSH/Cordis 的 host entrypoint 骨架
 * 外加：把 `dsh-plugin.json` 加进 `package.json` 的 `files`（manifest 须随包发布，RFC §7.1）。
 *
 * 判据与生成器**同一把尺子**：manifest / entrypoint 一律由 forge 的导出渲染（不另写模板），
 * 写盘前跑 `validateFabricSpec`——校验不过**不写盘**并如实报错（不造半成品）。幂等：内容相同即跳过。
 *
 * ⚠ 事实边界：Fabric 仍是 Draft（无 schema / SDK / conformance 套件）。本器补的是**契约面声明**，
 *   既不表示插件能在 Fabric Host 上运行，也不构成任何「符合标准 / 已认证」的说法（RFC §13）。
 * ⚠ 能力面如实推导：v0.1 只有 `commands` / `messages.observe` / `storage.local` 三项可协商，
 *   其余 cordis service（含 `tools`）属**非标准扩展路径**，一律不写进 manifest。
 *
 * 用法：
 *   node scripts/backfill-fabric.mjs [--root DIR] [--only a,b] [--dry-run] [--force]
 *   退出码：0 = 全部成功或已是最新；1 = 有插件校验失败（明细见输出）
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildFabricManifest, buildFabricEntrypoint, validateFabricSpec, defaultFabricId,
  listPluginDirs, isThirdPartyRepo,
} from '../lib/index.js'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
/** 默认根 = 本脚本所在仓的**父目录**（`self-plugins/`）——从脚本位置推导，Windows/WSL 同一真源 */
const ROOT = value('--root', '') || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ONLY = value('--only', '') ? value('--only', '').split(',').map((s) => s.trim()).filter(Boolean) : null
const DRY = flag('--dry-run')
const FORCE = flag('--force')

const read = (p) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
/** 剔注释 + 剔字符串字面量（否则注释/模板里的 `ctx.x` 会被当成真实用法） */
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/'(?:[^'\\]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\]|\\.)*"/g, '""')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``')

/**
 * 往 `"files": [...]` 数组里插一行 `"dsh-plugin.json"`——**保留原缩进风格**的最小文本改动。
 * 返回 null = 找不到该数组；找不到单独一行时回落到 `keyIndent + 2 空格`。
 * （不用 JSON.stringify 重排：为加一行而重排整个文件会让 diff 淹没真改动，也让 review 变难。）
 */
function patchFilesField(raw) {
  const fm = /([ \t]*)"files"\s*:\s*\[([\s\S]*?)\]/.exec(raw)
  if (!fm) return null
  if (/"dsh-plugin.json"/.test(fm[2])) return raw
  const keyIndent = fm[1]
  const itemIndent = (/[\r\n]([ \t]+)"/.exec(fm[2]) ?? [null, keyIndent + '  '])[1]
  const body = fm[2].replace(/\s+$/, '')
  return raw.slice(0, fm.index) + keyIndent + '"files": [' + body + ',\n' + itemIndent + '"dsh-plugin.json"\n' + keyIndent + ']' + raw.slice(fm.index + fm[0].length)
}

/** 剔注释（**保留字符串**）——抓 command 名必须用它，否则 `name: 'context'` 会被抹成空串 */const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/**
 * 从宿主侧源码推导 v0.1 capability + contributes.commands（**只写证据支持的**）。
 * 两种读法各司其职（2026-09-20 实测踩坑：在**已剔字符串**的文本上抓 command 名必然抓空）：
 *  - 服务用法（storage / messages）判在 `stripped`（剔注释+剔字符串）上——模板串里的示例不算用法；
 *  - command 名判在 `noComments`（只剔注释）上——名字本身是字符串字面量。
 * 另加一道闸：先在 `stripped` 上确认存在**代码态**的 `ctx.commands.register(`，否则（例如生成器源码里
 * 把示例写在模板字符串中）一律不声明 commands——防模板假阳性。
 */
function deriveFabric(id, stripped, noComments) {
  const required = []
  const commands = []
  if (/\bctx\s*\.\s*storage\b/.test(stripped)) required.push('storage.local')
  if (/\bctx\s*\.\s*messages\b/.test(stripped)) required.push('messages.observe')
  const hasCodeCall = /\bctx\s*\.\s*commands\s*\.\s*register\s*\(/.test(stripped)
  if (hasCodeCall) {
    required.push('commands')
    const reg = /\bctx\s*\.\s*commands\s*\.\s*register\s*\(\s*\{([\s\S]{0,500}?)\}\s*\)/g
    let m
    while ((m = reg.exec(noComments)) !== null) {
      const nm = /name\s*:\s*['"]([a-zA-Z0-9_.:-]+)['"]/.exec(m[1])
      const desc = /description\s*:\s*['"]([^'"]*)['"]/.exec(m[1])
      if (nm) commands.push({ id: id + '.' + nm[1], title: desc ? desc[1] : nm[1] })
    }
  }
  return { required, commands }
}

const rows = []
for (const name of listPluginDirs(ROOT)) {
  if (ONLY && !ONLY.includes(name)) continue
  const dir = join(ROOT, name)
  const pkgRaw = read(join(dir, 'package.json'))
  let pkg
  try { pkg = JSON.parse(pkgRaw) } catch (e) { rows.push({ name, error: 'package.json 解析失败: ' + e.message }); continue }
  if (isThirdPartyRepo(dir, String(pkg.name ?? ''))) { rows.push({ name, third: true }); continue }

  const id = defaultFabricId(String(pkg.name))
  const srcFiles = []
  const srcDir = join(dir, 'src')
  if (existsSync(srcDir)) {
    const stack = [srcDir]
    while (stack.length) {
      const cur = stack.pop()
      for (const e of readdirSyncSafe(cur)) {
        const p = join(cur, e.name)
        if (e.isDirectory()) { if (e.name !== 'client' && e.name !== 'node_modules') stack.push(p) }
        else if (/\.(ts|mts|js|mjs)$/.test(e.name)) srcFiles.push(p)
      }
    }
  }
  const srcText = srcFiles.map((f) => read(f)).join('\n')
  const hostText = strip(srcText)
  const derived = deriveFabric(id, hostText, stripComments(srcText))
  const spec = {
    name: String(pkg.name),
    description: String(pkg.description ?? ''),
    fabric: {
      version: String(pkg.version ?? '0.0.0'),
      capabilities: { required: derived.required },
      subscriptions: derived.required.includes('messages.observe') ? ['messages.observe'] : [],
      contributes: { commands: derived.commands },
    },
  }
  const errs = validateFabricSpec(spec)
  if (errs.length) { rows.push({ name, errors: errs }); continue }

  const manifest = buildFabricManifest(spec)
  const entry = buildFabricEntrypoint(spec)
  const actions = []
  const mPath = join(dir, 'dsh-plugin.json')
  const fPath = join(dir, 'src', 'fabric.ts')
  const curM = read(mPath)
  const curF = read(fPath)
  if (curM === manifest) actions.push('manifest 已最新')
  else if (curM && !FORCE) actions.push('⚠ manifest 已存在且不同——跳过（--force 覆盖）')
  else { actions.push(curM ? 'manifest 覆盖' : 'manifest 新建'); if (!DRY) writeFileSync(mPath, manifest) }
  if (!existsSync(srcDir)) actions.push('⚠ 无 src/ —— 跳过 entrypoint')
  else if (curF === entry) actions.push('entrypoint 已最新')
  else if (curF && !FORCE) actions.push('⚠ entrypoint 已存在且不同——跳过（--force 覆盖）')
  else { actions.push(curF ? 'entrypoint 覆盖' : 'entrypoint 新建'); if (!DRY) writeFileSync(fPath, entry) }

  // manifest 随包发布：`files` 是 npm 打包白名单，缺它则 manifest 不进包（RFC §7.1 要求位于包根）
  // 用**保风格的最小文本插入**（不 re-serialize——否则加一行会重排整个 package.json）；
  // 改完必须 JSON.parse 回读通过才写盘（改坏宁可不改）。
  let filesPatched = false
  if (Array.isArray(pkg.files)) {
    if (pkg.files.includes('dsh-plugin.json')) { /* 已含，无需补 */ }
    else {
      const patched = patchFilesField(pkgRaw)
      if (!patched) actions.push('⚠ 找不到可插入的 files 数组字面量——files 未改')
      else {
        let ok = true
        try { JSON.parse(patched) } catch { ok = false }
        if (!ok) actions.push('⚠ files 文本插入后 JSON 不可解析——未写（保风格插入失败，需人工）')
        else {
          filesPatched = true
          actions.push('files += dsh-plugin.json')
          if (!DRY) writeFileSync(join(dir, 'package.json'), patched)
        }
      }
    }
  } else actions.push('（package.json 无 files 字段——npm 默认全打包，无需补）')

  rows.push({ name, version: pkg.version, id, caps: derived.required, cmds: derived.commands.map((c) => c.id), actions, filesPatched })
}

function readdirSyncSafe(p) {
  try { return readdirSync(p, { withFileTypes: true }) } catch { return [] }
}

const wrote = rows.filter((r) => !r.third && !r.error && !r.errors)
console.log(`# Fabric 契约面回填${DRY ? '（DRY-RUN，未写盘）' : ''} · ${ROOT}`)
console.log(`扫描 ${rows.length} 个目录：自研待处理 ${wrote.length} · 第三方跳过 ${rows.filter((r) => r.third).length}\n`)
for (const r of rows) {
  if (r.third) { console.log(`- ⏭ ${r.name}（第三方，走 §5.23 依赖流程，不改）`); continue }
  if (r.error) { console.log(`- ❌ ${r.name} — ${r.error}`); continue }
  if (r.errors) { console.log(`- ❌ ${r.name} — 校验未过，**未写盘**：${r.errors.join('；')}`); continue }
  const caps = r.caps.length ? r.caps.join(',') : '（无——功能面全在非标准 Cordis 侧）'
  console.log(`- ✅ ${r.name}@${r.version} · id=${r.id} · caps=${caps}${r.cmds.length ? ' · commands=' + r.cmds.join(',') : ''}`)
  console.log(`     ${r.actions.join(' · ')}`)
}
const failed = rows.filter((r) => r.error || r.errors)
console.log(`\n小计：成功 ${wrote.length} · 失败 ${failed.length} · 第三方 ${rows.filter((r) => r.third).length}`)
process.exit(failed.length ? 1 : 0)
