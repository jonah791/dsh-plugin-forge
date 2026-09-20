/**
 * dsh-plugin-forge：插件创建插件
 *
 * 把「创建 DSH 插件」从手写 DSL 变成「声明式描述 → 生成完整可构建项目」。
 * 输入 spec（插件名/用途/工具列表/Config 字段/inject/imports），生成 8 件（见 `buildFiles`）。
 *
 * 价值：工具 DSL 正确性（parameters 内联 required、output.schema、render）由生成器保证，
 * 消除手写 defineTool 的 TS 类型错误与括号配对错误；高自由度 = 任意 execute 逻辑、额外 import、
 * 自定义 Config 字段、render 表达式。生成后自动 tsc 构建验证。
 *
 * v0.2.0（2026-09-20）对齐《DSH 插件生态倡议书》三条原则——**每条都落成可机械验证的闸门**：
 *  - 声明清晰：`resolveInject` 静态扫 execute 体里的 `ctx.<svc>`，与 spec.inject 对账并**自动补齐**
 *    （cordis 严格代理下访问未声明 service 是**启动期抛错**，而 tsc 查不出来——生成器是唯一能机械发现它的地方）
 *  - 组合优先：`findInternalImports` 拒绝跨插件/宿主的**内部路径导入**（`dsh-x/lib/...`），
 *    要求改走公开入口，不许假设或覆盖别人的内部实现
 *  - 兼容优先：`prepareBuildEnv` 不再把 forge 的整个 node_modules junction 进新插件
 *    （旧行为会让新插件里的 `pnpm install` **穿透写进 forge 的依赖树**，并可能把 forge 的
 *    `@deepseek-ai` 真实副本复制给每个新插件 ⇒ §5.15.4 的「旧副本遮蔽宿主 link farm」事故）
 *
 * 另：`dshForge` 是**本地静态声明**（不是 Community Fabric manifest——RFC 0001 仍是 Draft、非标准），
 * 由生成物自带的冒烟测试与源码机械对账，避免造出会漂移的第二真源。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

export const name = 'plugin-forge'
export const inject = ['tools'] as const

export interface Config {
  selfPluginsDir?: string
  tscPath?: string
}
export const Config = z.object({
  selfPluginsDir: z.string().required(false),
  tscPath: z.string().required(false),
})

// ════════════════════════ Spec 类型 ════════════════════════

export interface ParamSpec {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  description?: string
  required?: boolean
}
export interface ToolSpec {
  name: string
  description: string
  parameters?: Record<string, ParamSpec>
  /** canonical 返回 schema（JSON Schema 子集；defineTool output.schema） */
  outputSchema?: Record<string, unknown>
  /** render 表达式（v => string 形式，缺省 JSON.stringify） */
  render?: string
  /** execute 函数体（async (args) => {...} 内部语句，可自由写） */
  execute: string
}
export interface ConfigFieldSpec {
  type: 'string' | 'number' | 'boolean'
  description?: string
  default?: string | number | boolean
  required?: boolean
}
export interface ForgeSpec {
  /** 插件包名（小写 kebab，dsh- 前缀可省，自动补） */
  name: string
  description: string
  /** 依赖 service（默认 ['tools']） */
  inject?: string[]
  /** 额外 import 行（如 "import type {} from '@deepseek-ai/dsh-session'"） */
  imports?: string[]
  /** Config schema 字段（缺省 = 仅 enabled 开关） */
  config?: Record<string, ConfigFieldSpec>
  tools?: ToolSpec[]
  /** Fabric（RFC 0001 v0.1 Draft）扩展：缺省=只写真实字段，不编造 capability */
  fabric?: FabricSpec
}

// ════════════════════════ 生成器（纯函数，可离线单测） ════════════════════════

const PACKAGE_DEPS: Record<string, string> = {
  '@deepseek-ai/cordis': '^4.0.1',
  '@deepseek-ai/schemastery': '^3.18.1-rc.1',
  '@deepseek-ai/dsh-tools': '^0.1.0-rc.6',
}

/** 包名 → 行 id / export name：dsh-xxx → agent-xxx（与 plugin-manager scaffold 同约定） */
export function pluginId(pkg: string): string {
  return 'agent-' + pkg.replace(/^dsh-/, '')
}

/**
 * cordis Context 上的**内建成员**（不是 service）——静态扫 `ctx.<x>` 时忽略。
 * 漏掉它们会把 `ctx.logger` / `ctx.on` / `ctx.effect` 误报成「未声明的 service」。
 */
const CORE_CTX_MEMBERS = new Set([
  'logger', 'on', 'once', 'off', 'emit', 'parallel', 'waterfall', 'bail', 'serial',
  'effect', 'set', 'get', 'has', 'inject', 'scope', 'isolate', 'extend', 'plugin',
  'root', 'registry', 'reflect', 'start', 'stop', 'dispose', 'provide', 'accessor',
  'mixin', 'config', 'name', 'active',
])

/** 静态扫出源码里真正用到的 service（`ctx.<svc>`），剔除 cordis 内建成员 */
export function collectCtxServices(text: string): string[] {
  const out = new Set<string>()
  const re = /\bctx\s*\.\s*([A-Za-z_$][\w$]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const svc = m[1] as string
    if (!CORE_CTX_MEMBERS.has(svc)) out.add(svc)
  }
  return Array.from(out).sort()
}

/**
 * 声明清晰闸门（倡议书原则 2：明确声明依赖的 service，不依赖运行时巧合）。
 * 返回最终 inject（缺省 `['tools']` + 源码里用到的全部 service）与两档说明：
 * `added` = 代码在用但 spec 没声明的（**必须补**，否则启动即抛错）；`unused` = 声明了但没用的（只是噪音）。
 */
export function resolveInject(spec: ForgeSpec): { inject: string[]; added: string[]; unused: string[] } {
  const declared = spec.inject ?? ['tools']
  const used = new Set(collectCtxServices((spec.tools ?? []).map((t) => t.execute).join('\n')))
  // 生成的注册块必然引用 ctx.tools —— 有工具时 tools 一定在用
  if ((spec.tools ?? []).length > 0) used.add('tools')
  const added = Array.from(used).filter((s) => !declared.includes(s)).sort()
  const unused = declared.filter((s) => !used.has(s) && !(s === 'tools' && spec.inject === undefined))
  return { inject: [...declared, ...added], added, unused }
}

/**
 * 组合优先闸门（倡议书原则 1：不要假设或覆盖其他插件的内部实现）。
 * 命中 = 导入别家包的**内部路径**（`dsh-x/lib/...`、`@deepseek-ai/x/dist/...`）——这类依赖会随对方的构建布局变化而碎。
 */
export function findInternalImports(sources: string[]): string[] {
  const bad = new Set<string>()
  const re = /(?:from|require\s*\()\s*['"]([^'"]+)['"]/g
  for (const text of sources) {
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const specifier = m[1] as string
      if (/^(?:@deepseek-ai\/[a-z0-9.-]+|dsh-[a-z0-9-]+)\/(?:lib|src|dist|build)\//.test(specifier)) bad.add(specifier)
    }
  }
  return Array.from(bad).sort()
}

// ═══════════════ DSH Community Fabric（RFC 0001 v0.1 Draft）═══════════════

/**
 * v0.1 **协商** capability 白名单（RFC 0001 §7.3 命名空间表 + §11 精确范围）。
 * 只收三项：`storage.local` / `commands` / `messages.observe`。
 * `host.info` 与 `log` 是每次 activation 都具备的基础 context、**不是**可协商 capability，故不在表内。
 * `sessions.read` / `ui.panel.basic` 属后续候选、`sessions.actions` / `net.*` / `fs.*` 属暂缓——
 * 一律**拒绝**而不是静默接受（RFC §7.3：不得从正文抓名字，也不得把后续候选当 v0.1）。
 */
export const FABRIC_V01_CAPABILITIES: string[] = ['commands', 'messages.observe', 'storage.local']

/** RFC 0001 §7.1：service-composition contract 被接受前，v0.1 schema **必须拒绝** `provides` 与 `requires.services` */

/**
 * `$schema` 占位——**显式标注 draft**。
 * RFC §7.1 要求顶层 `$schema` 是 canonical identifier，但 §14 开放问题 1 明写
 * 「canonical `$schema` identifier 由谁持有和发布」尚无定论 ⇒ **此刻不存在任何合法值**（RFC 自己的示例值也声明
 * 「不是已发布 identifier，也不是合法 fixture」）。故用 `.invalid`（RFC 2606 保留 TLD，永不可解析）搭一个
 * **自证是占位**的 URL——这也与 RFC 0004 §7.2 自己的占位写法（`https://example.invalid/fabric/manifest/0.1.0`）一致；
 * 绝不用真实 URL 冒充已发布 schema。生成物守卫断言它含 `draft`，防止被误当正式标识符。
 * Fabric Phase 0 发布 schema 后**只需替换本常量**。
 */
export const FABRIC_SCHEMA_PLACEHOLDER = 'https://example.invalid/dsh-community-fabric/dsh-plugin.schema.v0.1.draft.json'

/** Fabric 扩展（全可选：manifest 只写**真实**的东西，缺省不编造 capability） */
export interface FabricSpec {
  /** 反向 DNS 命名空间 id；缺省 `com.jonah791.<包名去 dsh- 前缀>` */
  id?: string
  capabilities?: { required?: string[]; optional?: string[] }
  subscriptions?: string[]
  contributes?: { commands?: Array<{ id: string; title: string }> }
}

/** id 形态（RFC §7.1 要求正式 schema 定义 `id` 语法；此处取反向 DNS 的最小可判形态） */
export function isFabricId(id: string): boolean {
  const parts = id.split('.')
  return parts.length >= 2 && parts.every((p) => /^[a-z][a-z0-9-]*$/.test(p))
}

/** 包名 → 默认 id：`dsh-foo-bar` → `com.jonah791.foo-bar` */
export function defaultFabricId(pkg: string): string {
  return 'com.jonah791.' + pkg.replace(/^dsh-/, '')
}

/** capability key 合法性：标准 v0.1 白名单，或 `x-<org>.<...>` 私有命名空间（RFC §7.3） */
export function isFabricCapability(key: string): boolean {
  return FABRIC_V01_CAPABILITIES.includes(key) || /^x-[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(key)
}

/**
 * Fabric 校验（纯函数）：返回错误串数组，空数组 = 通过。
 * 每条都对应 RFC 0001 的**明文要求**（不是我加的口味）——故可机械判真假、可写尸体测试。
 */
export function validateFabricSpec(spec: ForgeSpec): string[] {
  const f = spec.fabric ?? {}
  const errs: string[] = []
  const id = f.id ?? defaultFabricId(spec.name)
  if (!isFabricId(id)) errs.push('manifest id「' + id + '」不是合法反向 DNS 命名空间（RFC 0001 §7.1：正式 schema 必须定义 id 语法）')
  const req = f.capabilities?.required ?? []
  const opt = f.capabilities?.optional ?? []
  for (const key of [...req, ...opt]) {
    if (key.split('.')[0] === 'provides' || key === 'requires.services') {
      errs.push('capability「' + key + '」属 v0.1 必须拒绝的声明类别（RFC 0001 §7.1：service-composition contract 被接受前，v0.1 schema 必须拒绝 provides 与 requires.services）')
      continue
    }
    if (!isFabricCapability(key)) {
      errs.push('capability「' + key + '」既不在 v0.1 协商白名单（' + FABRIC_V01_CAPABILITIES.join(' / ') + '）内，也不是 x-<org>.* 私有命名空间；sessions.read/ui.panel.basic 属后续、sessions.actions/net.*/fs.* 属暂缓（RFC 0001 §7.3 / §11）')
    }
  }
  for (const ev of f.subscriptions ?? []) {
    if (ev !== 'messages.observe' && !/^x-[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(ev)) {
      errs.push('订阅事件「' + ev + '」不在 v0.1 事件表内（RFC 0001 §7.4：v0.1 只规范一个不可修改的 `messages.observe` 事件，事件名必须来自 Event Registry，实现方不得自行发明「等价」事件名）')
    }
  }
  for (const c of f.contributes?.commands ?? []) {
    if (!c.id.startsWith(id + '.')) errs.push('contributes.commands「' + c.id + '」必须落在插件自己的命名空间「' + id + '.」下（RFC 0001 §7.1 / 兼容层：可发现元数据只有一个权威来源，ID 必须属于插件命名空间）')
  }
  return errs
}

/**
 * Fabric 相关的**非阻断提示**（不写进 errors）。
 * ⚠ 依据：RFC 0003 §3 明确 `subscriptions` 只表示投递意向，**不是** capability/dependency/contribution——
 * 两者是并列的声明类别，**不能混在一起**。故「订阅了事件却没申请同名 capability」只能提示，不能当违规拒绝
 * （RFC 0001 §7.1 的示例两处都写 messages.observe，但那不等于 schema 层的强制关联）。
 */
export function fabricSpecNotes(spec: ForgeSpec): string[] {
  const f = spec.fabric ?? {}
  const declared = [...(f.capabilities?.required ?? []), ...(f.capabilities?.optional ?? [])]
  const out: string[] = []
  for (const ev of f.subscriptions ?? []) {
    if (!declared.includes(ev)) {
      out.push('订阅了事件「' + ev + '」但未申请同名 capability——RFC 0001 §7.1 的示例两处都写（capability 走协商、subscriptions 单独申请投递），建议一并声明以免协商期不一致')
    }
  }
  const cmds = f.contributes?.commands ?? []
  if (cmds.length > 0 && !declared.includes('commands')) {
    out.push('声明了 contributes.commands 但未申请 `commands` capability——RFC 0001 §7.3 把 commands 定义为「为 manifest 中声明的命令绑定 handler」，不申请则 Host 无法绑定（按提示处理：该处 RFC 未写成 MUST，不升级为拒绝）')
  }
  if ((spec.tools ?? []).length > 0) {
    out.push('本插件含 ' + String((spec.tools ?? []).length) + ' 个 Cordis 工具——`tools` 不在 Fabric v0.1 capability 表内，属**非标准扩展路径**：不要写进 Fabric manifest，生成物 README 已把两个面分开标注')
  }
  return out
}

/** 生成 `dsh-plugin.json`（RFC 0001 §7.1 v0.1 冻结形状，逐字段） */
export function buildFabricManifest(spec: ForgeSpec): string {
  const f = spec.fabric ?? {}
  const id = f.id ?? defaultFabricId(spec.name)
  const range = '>=0.1.0 <0.2.0'
  const map = (keys: string[]): Record<string, string> => Object.fromEntries(keys.map((k) => [k, range]))
  const manifest = {
    $schema: FABRIC_SCHEMA_PLACEHOLDER,
    manifestVersion: '0.1.0',
    id,
    name: spec.name,
    version: '0.1.0',
    apiVersion: range,
    entrypoints: { host: 'lib/fabric.js' },
    capabilities: { required: map(f.capabilities?.required ?? []), optional: map(f.capabilities?.optional ?? []) },
    subscriptions: (f.subscriptions ?? []).map((e) => ({ event: e, version: range })),
    contributes: { commands: f.contributes?.commands ?? [] },
  }
  return JSON.stringify(manifest, null, 2) + '\n'
}

/**
 * 生成 Fabric host entrypoint 骨架（`src/fabric.ts` → `lib/fabric.js`）。
 * ⚠ **现在跑不起来**：Fabric 还只有文档（无 SDK / 无正式 schema / 无 runtime，RFC §1 Draft 边界）。
 * 骨架按 §7.1（独立于 DSH/Cordis 的 entrypoint）与 §7.5（未来 SDK 形态）预留，SDK 发布后往 activate 里填实现。
 * 生成物守卫逐条检查本文件的纪律：不 import `@deepseek-ai/*` 或 `cordis`。
 */
export function buildFabricEntrypoint(spec: ForgeSpec): string {
  const f = spec.fabric ?? {}
  const id = f.id ?? defaultFabricId(spec.name)
  const cmds = f.contributes?.commands ?? []
  return [
    '/**',
    ' * Fabric host entrypoint 骨架（DSH Community Fabric · RFC 0001 v0.1 · 由 dsh-plugin-forge 生成）。',
    ' *',
    ' * ⚠ **现在不可运行**：Fabric 仍只有文档——没有 SDK、没有正式 schema、没有 runtime（RFC 0001 §1 Draft 边界）。',
    ' * 本文件按 §7.1（entrypoint 独立于 DSH/Cordis）+ §7.5（未来 SDK 形态）预留；SDK 发布后在 activate 内按',
    ' * 协商到的 capability 绑定实现。**在此之前不得声称本插件通过 Fabric conformance**（RFC §13：只有',
    ' * 存在 v0.1 plugin validation 套件时才可如此声称）。',
    ' *',
    ' * 纪律（生成物自带守卫会逐条检查）：',
    ' *   1. 不 import `@deepseek-ai/*`、不 import `cordis`（§7.1：Fabric entrypoint 运行时不依赖 DSH/Cordis）',
    ' *   2. 只使用 manifest 已声明的 capability（未声明的不调）',
    ' *   3. 清理必须**可重复**（§7.4：同一 entrypoint 可能被重复 activate，deactivate 不保证送达）',
    ' */',
    '',
    'export interface FabricActivationContext {',
    '  /** 基础 context（每次 activation 都有，非协商 capability）：host.info / log / 生命周期取消信号 */',
    '  readonly host?: { readonly id?: string; readonly version?: string }',
    '  readonly log?: { info(message: string, fields?: Record<string, unknown>): void }',
    '}',
    '',
    'export interface FabricActivation {',
    '  /** Host 正常关闭时 best-effort 调用；必须幂等（§7.4） */',
    '  deactivate?(): void | Promise<void>',
    '}',
    '',
    'export const fabricPluginId = ' + JSON.stringify(id),
    '',
    'export default function activate(ctx: FabricActivationContext): FabricActivation {',
    '  ctx.log?.info(' + JSON.stringify(spec.name + ' activated (Fabric skeleton)') + ')',
    ...(cmds.length
      ? ['  // manifest 已声明以下 command（Host 可在插件运行前发现；此处只列 ID，SDK 发布后绑定 handler）：',
         ...cmds.map((c) => '  //   ' + c.id + ' — ' + c.title)]
      : ['  // manifest 未声明 contributes.commands。']),
    '  // TODO(Fabric SDK)：SDK 发布后按 §7.5 形态实现，例如',
    '  //   ctx.commands?.handle(fabricPluginId + \'.show\', async () => { ... })',
    '  //   ctx.messages?.onReceived(async (message) => { ... })',
    '  return {',
    '    deactivate() {',
    '      // TODO：释放本 activation 持有的资源（须可重复调用）',
    '    },',
    '  }',
    '}',
    '',
  ].join('\n')
}

/**
 * 从 `fromDir` 逐级向上找 `<ancestor>/node_modules/<spec>`（Node 解析语义的显式版）。
 * `exists` 注入 ⇒ 纯函数、可离线测；返回 null = 共享解析根不可达（调用方须响亮处理，不得静默兜底）。
 */
export function resolveUpFrom(fromDir: string, spec: string, exists: (p: string) => boolean): string | null {
  let cur = fromDir
  for (;;) {
    const cand = join(cur, 'node_modules', spec)
    if (exists(cand)) return cand
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}


function toTsType(t: ParamSpec['type']): string {
  switch (t) {
    case 'string': return 'string'
    case 'number': return 'number'
    case 'boolean': return 'boolean'
    case 'array': return 'unknown[]'
    case 'object': return 'Record<string, unknown>'
  }
}

function paramsType(params: Record<string, ParamSpec>): string {
  const entries = Object.entries(params).map(([k, p]) => {
    const opt = p.required ? '' : '?'
    return '  ' + k + opt + ': ' + toTsType(p.type)
  })
  return '{\n' + entries.join('\n') + '\n}'
}

function buildConfig(spec: ForgeSpec): { iface: string; schema: string } {
  const fields = spec.config ?? {}
  const entries = Object.entries(fields)
  const all: [string, ConfigFieldSpec][] = entries.length > 0 ? entries : [['enabled', { type: 'boolean', default: true }]]
  const ifaceLines = all.map(([k, f]) => {
    const opt = f.required || f.default !== undefined ? '' : '?'
    return '  ' + k + opt + ': ' + f.type
  })
  const schemaLines = all.map(([k, f]) => {
    let expr: string
    switch (f.type) {
      case 'string': expr = 'z.string()'; break
      case 'number': expr = 'z.number()'; break
      default: expr = 'z.boolean()'; break
    }
    if (f.default !== undefined) {
      expr += '.default(' + JSON.stringify(f.default) + ')'
    } else if (f.required !== true) {
      expr += '.required(false)'
    }
    return '  ' + k + ': ' + expr + ','
  })
  return {
    iface: 'export interface Config {\n' + ifaceLines.join('\n') + '\n}',
    schema: 'export const Config = z.object({\n' + schemaLines.join('\n') + '\n})',
  }
}

/**
 * 净化 DSL：
 * - 对象级 `required: [...]` 数组 → 明确拒绝（2026-09-01 教训：静默剥除会让 spec 意图丢失，
 *   而作者在生成产物上手工补回标准 JSON Schema 数组时，会造出 defineTool 运行期 value schema
 *   DSL 违规——插件加载崩、web boot 崩。harness 规定：required 只允许字段级 required: true）。
 * - 其余值为 false/非 true 的 required 键删除（DSL 只接受 required?: true）。
 * 注：properties 内每个字段各自的 required:true 合法，保留。
 */
export function sanitizeRequired(v: unknown, path = '$'): unknown {
  if (Array.isArray(v)) return v.map((x) => sanitizeRequired(x, path + '[]'))
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'required') {
        if (Array.isArray(val)) {
          throw new Error(`forge spec ${path}: 对象级 required 数组 ${JSON.stringify(val)} 不被 DSH 工具 schema DSL 支持——请改为在对应字段上写 required: true（如 properties.ok.required=true）`)
        }
        if (val !== true) continue
      }
      out[k] = sanitizeRequired(val, path + '.' + k)
    }
    return out
  }
  return v
}

function buildTool(t: ToolSpec): string {
  const params = (t.parameters ?? {}) as Record<string, unknown>
  const paramsSan = sanitizeRequired(params) as Record<string, ParamSpec>
  const hasParams = Object.keys(paramsSan).length > 0
  const outSchema = sanitizeRequired(t.outputSchema ?? { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, text: { type: 'string' } } })
  const schemaJson = JSON.stringify(outSchema)
  const renderExpr = t.render ?? 'JSON.stringify(v)'
  const argsType = hasParams ? 'args: ' + paramsType(paramsSan) : 'args: Record<string, unknown>'
  // 参数名解构：execute 体里可以直接用 name/seed/... 这些名字（旧版只把 parameters 写进 schema，
  // 体里引用参数名会报 `Cannot find name 'seed'`——2026-09-17 实测缺陷）
  const names = Object.keys(paramsSan).filter((n) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n))
  const lines: string[] = [
    '    ctx.tools.register(defineTool({',
    '      name: ' + JSON.stringify(t.name) + ',',
    '      description: ' + JSON.stringify(t.description) + ',',
    // parameters 必须恒定存在（缺省时也要 {}），否则 TS 报 Property 'parameters' is missing
    '      parameters: ' + JSON.stringify(paramsSan) + ',',
    '      output: {',
    '        schema: ' + schemaJson + ',',
    '        render: (_a: unknown, v: any) => [{ type: \'text\', text: ' + renderExpr + ' }],',
    '      },',
    '      async execute(' + argsType + ') {',
    ...(names.length ? ['        const { ' + names.join(', ') + ' } = args as any'] : []),
    '        const __raw = await (async () => {',
    '          ' + t.execute.trim().replace(/\n/g, '\n          '),
    '        })()',
    '        if (__raw && typeof __raw === \'object\' && \'ok\' in (__raw as any)) return __raw as any',
    '        return { ok: true, text: typeof __raw === \'string\' ? __raw : JSON.stringify(__raw) } as any',
    '      },',
    '    }))',
  ]
  return lines.join('\n')
}

/** 生成 src/index.ts 全文 */
export function buildSource(spec: ForgeSpec): string {
  const id = pluginId(spec.name)
  // 声明清晰：inject 取「spec 声明 ∪ 源码实际用到的 service」——见 resolveInject
  const inject = resolveInject(spec).inject
  const config = buildConfig(spec)
  const extraImports = (spec.imports ?? []).map((i) => i + '\n').join('')
  const toolsBlock = (spec.tools ?? []).map(buildTool).join('\n\n')
  return [
    '/**',
    ' * ' + spec.name + '：' + spec.description,
    ' */',
    'import type { Context } from \'@deepseek-ai/cordis\'',
    'import z from \'@deepseek-ai/schemastery\'',
    ...(inject.includes('tools') ? ['import { defineTool } from \'@deepseek-ai/dsh-tools\''] : []),
    ...(extraImports ? [extraImports.trimEnd()] : []),
    '',
    'export const name = ' + JSON.stringify(id),
    'export const inject = ' + JSON.stringify(inject) + ' as const',
    '',
    config.iface,
    config.schema,
    '',
    'export function apply(ctx: Context, config: Config): void {',
    '  const logger = ctx.logger(' + JSON.stringify(id) + ')',
    toolsBlock.length > 0 ? '\n' + toolsBlock : '  // TODO: 在此实现插件逻辑',
    '}',
    '',
  ].join('\n')
}

export function buildPackageJson(spec: ForgeSpec): string {
  const pkg = {
    name: spec.name,
    version: '0.1.0',
    description: spec.description,
    type: 'module',
    main: 'lib/index.js',
    types: 'lib/types/index.d.ts',
    exports: { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' }, './package.json': './package.json' },
    // dsh-plugin.json 必须随包发布（Fabric manifest 位于 package 根目录，RFC 0001 §7.1）
    files: ['lib', 'README.md', 'dsh-plugin.json'],
    license: 'MIT',
    peerDependencies: PACKAGE_DEPS,
    devDependencies: { '@types/node': '^22.0.0', typescript: '^5.9.3' },
    scripts: {
      build: 'tsc -p tsconfig.json',
      // 2026-09-14：生成物必须自带可跑的回归检查（否则每个新插件都从「无测试」起步，
      // 生态级可维护性缺口 S3 的根因就在模板）。配套生成 tests/smoke.test.mjs。
      test: 'node --test "tests/*.test.mjs"',
      typecheck: 'tsc -p tsconfig.json --noEmit',
    },
  }
  return JSON.stringify(pkg, null, 2) + '\n'
}

export function buildTsconfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2022'],
      strict: true, noImplicitAny: true, noUncheckedIndexedAccess: true, declaration: true,
      declarationDir: 'lib/types', outDir: 'lib', rootDir: 'src', esModuleInterop: true,
      skipLibCheck: true, forceConsistentCasingInFileNames: true, allowImportingTsExtensions: true,
      rewriteRelativeImportExtensions: true, types: ['node'],
    },
    include: ['src'], exclude: [],
  }, null, 2) + '\n'
}

export function buildPatch(spec: ForgeSpec): string {
  const id = pluginId(spec.name)
  return [
    '- insert:',
    '    - id: ' + id,
    '      name: ' + spec.name,
    '      config: {}',
    '',
  ].join('\n')
}

export function buildReadme(spec: ForgeSpec): string {
  const id = pluginId(spec.name)
  const { inject: svc } = resolveInject(spec)
  const toolNames = (spec.tools ?? []).map((t) => t.name)
  const fabReq = spec.fabric?.capabilities?.required ?? []
  const fabOpt = spec.fabric?.capabilities?.optional ?? []
  const fabId = spec.fabric?.id ?? defaultFabricId(spec.name)
  const fmtCaps = (ks: string[]): string => (ks.length ? ks.map((k) => '`' + k + '`').join(' · ') : '（无）')
  const lines = [
    '# ' + spec.name,
    '',
    spec.description,
    '',
    '## 工具',
    ...(spec.tools ?? []).map((t) => '- `' + t.name + '`：' + t.description),
    '',
    '## 生态契约',
    '',
    '> 依据《DSH 插件生态倡议书》三条原则：**组合优先 / 声明清晰 / 兼容优先**。',
    '',
    '- **依赖 service**（`inject`）：' + (svc.length ? svc.map((s) => '`' + s + '`').join(' · ') : '（无）') + ' —— 组合行装载时等待这些 service',
    '- **贡献面**：工具 ' + (toolNames.length ? toolNames.map((n) => '`' + n + '`').join(' · ') : '（无）') + '；slot 无；service 无',
    '- 组合行 id：`' + id + '`',
    '- **Fabric manifest**：`dsh-plugin.json`（RFC 0001 v0.1 **Draft** 形状）——`id` = `' + fabId + '`，required = ' + fmtCaps(fabReq) + '，optional = ' + fmtCaps(fabOpt),
    '- **Fabric 入口**：`src/fabric.ts` → `lib/fabric.js`（骨架，**不依赖 DSH/Cordis**；Fabric SDK 发布后填充实现）',
    '',
    '> ⚠ **不是认证**：Fabric 目前只有文档草案（无正式 schema、无 SDK、无 conformance 套件），因此**不得**声称本插件',
    '> 「通过 Fabric 认证」或「已符合 Fabric 标准」。对齐的是 RFC 0001 的 manifest 形状 + 可机械校验的明文规则；',
    '> `dsh-plugin.json` 的 `$schema` 是**自证 draft 的占位**，Phase 0 发布 canonical identifier 后替换。',
    '',
    '组合片段（`cordis.patch.yml`）：',
    '',
    '```yaml',
    '- insert:',
    '    - id: ' + id,
    '      name: ' + spec.name,
    '      config: {}',
    '```',
    '',
    '## 能力边界（诚实声明）',
    '',
    '本插件与宿主**同进程、全权限**运行。「能力声明」用于兼容判断、用户确认与审计，**不构成安全沙箱**——不要把它当权限边界。',
    '本插件不导入其他插件或宿主的内部路径（组合优先），也不覆盖别人的内部实现。',
    '',
    '### 两个面，别混淆',
    '',
    '- **Fabric 契约面**：`dsh-plugin.json` + `src/fabric.ts`（host entrypoint）。这是**前瞻声明**——Fabric 目前只有 RFC Draft，',
    '  没有正式 schema / SDK / conformance 套件，官方 `docs/plugin-development.md` 明示其**尚不能作为依赖或发布目标**；',
    '  `$schema` 是自证 draft 的 `.invalid` 占位（RFC §14-1 未定 canonical identifier），**不是** schema 校验通过，也**不是**认证。',
    '- **DSH/Cordis 面（非标准扩展路径）**：`src/index.ts` + `cordis.patch.yml`——本插件**现在真正可运行**的形态。',
    '  `tools` 不在 Fabric v0.1 的 capability 表内（v0.1 只有 host.info / log / 生命周期取消 + `storage.local` / `commands` / `messages.observe`），',
    '  故这属标准之外的扩展路径：**不得**当作可移植 API，也**不得**成为 Fabric entrypoint 的依赖。',
    '',
    '## 构建与挂载',
    '',
    '```sh',
    'pnpm build',
    '# 挂载到 web profile（dsh plugin-manager 或 plugin_mount）',
    '```',
    '',
  ]
  return lines.join('\n')
}

/** 生成 .gitignore（新插件不该从「忘记忽略 node_modules / lib」起步） */
export function buildGitignore(): string {
  return ['node_modules/', 'lib/', '*.log', 'data/', '.dsh/', '', '*.bak', '*.bak-*', ''].join('\n')
}

/** 生成 docs/semantic.md 骨架（10 节；2026-09-14：新能力开工前先落语义文档——AGENTS.md §5.20） */
export function buildSemanticDoc(spec: ForgeSpec): string {
  const id = pluginId(spec.name)
  const toolLines = (spec.tools ?? []).length > 0
    ? (spec.tools ?? []).map((t) => '- `' + t.name + '`：' + t.description).join('\n')
    : '- （暂无工具：本插件是 Service/事件型，或尚未实现）'
  return [
    '# ' + spec.name + ' · 语义文档',
    '',
    '> 元信息：版本 v0.1 · 状态 draft · 最近复核 ' + new Date().toISOString().slice(0, 10) + ' · owner ' + id,
    '',
    '## 1 · 定位与反定位',
    '',
    '**是什么**：' + spec.description,
    '',
    '**不是什么**：<TODO 写清边界——本插件不负责什么，避免被误当成万能工具>',
    '',
    '## 2 · 术语表',
    '',
    '| 术语 | 含义 |',
    '|------|------|',
    '| <TODO> | <TODO> |',
    '',
    '## 3 · 概念模型与不变量',
    '',
    '<TODO 画清核心对象与它们的关系>',
    '',
    '不变量（必须永远为真）：',
    '1. <TODO 例如「观测失败不反噬主流程：观测函数一律吞错并返回 bool」>',
    '',
    '## 4 · 契约',
    '',
    '### 4.1 配置（Config schema）',
    '',
    '<TODO 逐字段：名 / 类型 / 默认值 / 语义>',
    '',
    '### 4.2 工具面',
    '',
    toolLines,
    '',
    '### 4.3 调用点清单 [MUST]',
    '',
    '| 调用点 | 位置 | 说明 |',
    '|--------|------|------|',
    '| <TODO 谁调用本插件的能力、本插件调用谁> | <文件:行> | <TODO> |',
    '',
    '## 5 · 边界与信任',
    '',
    '<TODO 输入信任级别 / 沙箱边界 / 凭据与隐私 / 能力边界诚实声明（capability ≠ 沙箱）>',
    '',
    '## 6 · 与既有机制的关系',
    '',
    '<TODO 与宿主/其他插件/官方能力的重叠与分工>',
    '',
    '## 7 · 可证伪验收清单',
    '',
    '| # | 可证伪命题 | 证据（命令/单测名/日志行） | 状态 |',
    '|---|-----------|--------------------------|------|',
    '| A1 | 冒烟测试通过 | `npm test` → 全绿 | 待验收 |',
    '| A2 | <TODO 一条能被一次测量判真假的命题> | <TODO> | 待验收 |',
    '',
    '## 8 · 与实现的关系',
    '',
    '- 主实现：`src/index.ts`；测试：`tests/smoke.test.mjs`（生成器自带的骨架守卫）。',
    '- 同语义副本：无。',
    '',
    '## 9 · 实践修订记录',
    '',
    '- **' + new Date().toISOString().slice(0, 10) + ' 首次生成**：由 `dsh-plugin-forge` 生成骨架——本节的每一次语义修正都追加在下方，不回改历史。',
    '',
    '## 10 · 未决问题',
    '',
    '- **U1 <TODO>**：<TODO 现有设计的已知缺口 / 待决方案>',
    '',
  ].join('\n')
}

/** 生成 tests/smoke.test.mjs（骨架守卫：不依赖 lib/ 构建产物，生成后 `npm test` 立刻可跑） */
export function buildSmokeTest(spec: ForgeSpec): string {
  const id = pluginId(spec.name)
  const lines = [
    '/**',
    ' * 骨架冒烟测试（由 dsh-plugin-forge 生成，2026-09-20）。',
    ' * 只断言结构、不依赖构建产物——`npm test` 在生成后立刻可跑；',
    ' * 业务逻辑测试请另加 tests/<主题>.test.mjs（跑 lib/ 产物，与运行时同源）。',
    ' * 全 13 条 = 结构 5 + 两组契约守卫：',
    ' *   生态（《DSH 插件生态倡议书》）：inject 覆盖源码 service · 不导入跨插件内部路径 · 能力边界已声明；',
    ' *   Fabric（RFC 0001 v0.1 Draft）：manifest 必填字段 · $schema 必须自证 draft · id/capability 白名单 ·',
    ' *     subscriptions/contributes 自洽 · entrypoint 不依赖 DSH/Cordis。',
    ' */',
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { readFileSync, existsSync } from 'node:fs'",
    "import { join, dirname } from 'node:path'",
    "import { fileURLToPath } from 'node:url'",
    '',
    "const root = join(dirname(fileURLToPath(import.meta.url)), '..')",
    "const readText = (p) => readFileSync(join(root, p), 'utf8')",
    '',
    '/** cordis Context 上的内建成员（非 service）——与生成器同算法 */',
    "const CORE_CTX = new Set(['logger','on','once','off','emit','parallel','waterfall','bail','serial','effect','set','get','has','inject','scope','isolate','extend','plugin','root','registry','reflect','start','stop','dispose','provide','accessor','mixin','config','name','active'])",
    '/** Fabric v0.1 协商 capability 白名单（RFC 0001 §7.3 / §11） */',
    "const FABRIC_CAPS_V01 = ['commands', 'messages.observe', 'storage.local']",
    '/** 剔除注释后再判 import——注释里提到包名不算依赖（否则文档会把自己判违规） */',
    "const stripComments = (s) => s.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '').replace(/^\\s*\\/\\/.*$/gm, '')",
    'function ctxServices(text) {',
    '  const out = new Set()',
    '  const re = /\\bctx\\s*\\.\\s*([A-Za-z_$][\\w$]*)/g',
    '  let m',
    '  while ((m = re.exec(text)) !== null) if (!CORE_CTX.has(m[1])) out.add(m[1])',
    '  return [...out].sort()',
    '}',
    'function declaredInject(text) {',
    '  const m = /export const inject = (\\[[^\\]]*\\]) as const/.exec(text)',
    "  assert.ok(m, 'src/index.ts 必须导出 inject')",
    '  return JSON.parse(m[1])',
    '}',
    '',
    "test('package.json 可解析且暴露 build/test 脚本', () => {",
    "  const pkg = JSON.parse(readText('package.json'))",
    '  assert.equal(pkg.name, ' + JSON.stringify(spec.name) + ')',
    "  assert.equal(pkg.type, 'module')",
    "  assert.equal(pkg.main, 'lib/index.js')",
    "  assert.ok(pkg.scripts.build, '必须有 build 脚本')",
    "  assert.ok(pkg.scripts.test, '必须有 test 脚本（回归能力）')",
    '})',
    '',
    "test('src/index.ts 暴露 name / inject / apply', () => {",
    "  const text = readText(join('src', 'index.ts'))",
    "  assert.ok(text.includes('export const name = '), '必须导出 name')",
    "  assert.ok(text.includes('export const inject = '), '必须导出 inject')",
    "  assert.ok(text.includes('export function apply('), '必须导出 apply')",
    '})',
    '',
    "test('tsconfig.json 是 ESM/NodeNext 配置', () => {",
    "  const ts = JSON.parse(readText('tsconfig.json'))",
    "  assert.equal(ts.compilerOptions.module, 'NodeNext')",
    "  assert.equal(ts.compilerOptions.outDir, 'lib')",
    '})',
    '',
    "test('语义文档存在（新能力开工前先落文档）', () => {",
    "  assert.ok(existsSync(join(root, 'docs', 'semantic.md')), '缺 docs/semantic.md')",
    '})',
    '',
    "test('cordis.patch.yml 含组合行 id', () => {",
    "  const yml = readText('cordis.patch.yml')",
    '  assert.ok(yml.includes(' + JSON.stringify(id) + '))',
    '})',
    '',
    "test('声明清晰：inject 覆盖源码里用到的全部 service', () => {",
    "  const text = readText(join('src', 'index.ts'))",
    '  const declared = new Set(declaredInject(text))',
    '  const missing = ctxServices(text).filter((s) => !declared.has(s))',
    "  assert.deepEqual(missing, [], '源码用到了未声明的 service（cordis 严格代理下启动即抛错）：' + missing.join(', '))",
    '})',
    '',
    "test('组合优先：无跨插件/宿主内部路径导入', () => {",
    "  const text = readText(join('src', 'index.ts'))",
    '  const bad = []',
    "  const re = /(?:from|require\\s*\\()\\s*['\"]([^'\"]+)['\"]/g",
    '  let m',
    '  while ((m = re.exec(text)) !== null) {',
    '    if (/^(?:@deepseek-ai\\/[a-z0-9.-]+|dsh-[a-z0-9-]+)\\/(?:lib|src|dist|build)\\//.test(m[1])) bad.push(m[1])',
    '  }',
    "  assert.deepEqual(bad, [], '导入了别家包的内部路径——请改走公开入口：' + bad.join(', '))",
    '})',
    '',
    "test('Fabric manifest：存在且必填字段齐全（RFC 0001 §7.1）', () => {",
    "  const m = JSON.parse(readText('dsh-plugin.json'))",
    "  for (const k of ['$schema','manifestVersion','id','name','version','apiVersion','entrypoints','capabilities','subscriptions','contributes']) {",
    "    assert.ok(k in m, 'manifest 缺字段 ' + k)",
    '  }',
    '  assert.equal(m.name, ' + JSON.stringify(spec.name) + ')',
    "  assert.equal(m.entrypoints.host, 'lib/fabric.js')",
    "  assert.equal(m.manifestVersion, '0.1.0')",
    '})',
    '',
    "test('Fabric manifest：$schema 必须是**显式 draft 占位**（不得冒充已发布标识符）', () => {",
    "  const m = JSON.parse(readText('dsh-plugin.json'))",
    '  assert.match(String(m.$schema), /draft/, \'RFC §7.1 要求 canonical $schema，但该标识符尚未发布（§14 开放问题 1）⇒ 只能是自证 draft 的占位\')',
    '})',
    '',
    "test('Fabric manifest：id 反向 DNS + capability 只用 v0.1 白名单（§7.3/§11）+ 不得含 provides/requires（§7.1）', () => {",
    "  const m = JSON.parse(readText('dsh-plugin.json'))",
    "  const parts = String(m.id).split('.')",
    "  assert.ok(parts.length >= 2 && parts.every((p) => /^[a-z][a-z0-9-]*$/.test(p)), 'id 形态非法：' + m.id)",
    '  const keys = [...Object.keys(m.capabilities.required), ...Object.keys(m.capabilities.optional)]',
    '  for (const k of keys) {',
    "    assert.ok(FABRIC_CAPS_V01.includes(k) || /^x-[a-z0-9-]+(\\.[a-z0-9-]+)+$/.test(k), 'capability 不在 v0.1 白名单：' + k)",
    '  }',
    "  assert.ok(!('provides' in m) && !('requires' in m), 'RFC §7.1：v0.1 必须拒绝 provides / requires.services')",
    '})',
    '',
    "test('Fabric manifest：subscriptions 与 contributes.commands 形状正确（§7.1；两类声明不可混）', () => {",
    "  const m = JSON.parse(readText('dsh-plugin.json'))",
    '  for (const s of m.subscriptions) {',
    "    assert.ok(s.event && s.version, 'subscription 缺 event/version：' + JSON.stringify(s))",
    '  }',
    '  for (const c of m.contributes.commands) {',
    "    assert.ok(String(c.id).startsWith(m.id + '.'), 'command id 不在自身命名空间：' + c.id)",
    "    assert.ok(c.title, 'command 缺 title：' + c.id)",
    '  }',
    '})',
    '',
    "test('Fabric entrypoint：不依赖 DSH/Cordis（§7.1）且默认导出', () => {",
    "  const src = stripComments(readText(join('src', 'fabric.ts')))",
    "  assert.ok(!/@deepseek-ai\\//.test(src), 'Fabric entrypoint 不得 import @deepseek-ai/*（已剔除注释）')",
    "  assert.ok(!/from\\s+['\\\"]cordis['\\\"]/.test(src), 'Fabric entrypoint 不得 import cordis（已剔除注释）')",
    "  assert.ok(/export default/.test(src), 'Fabric entrypoint 必须默认导出')",
    '})',
    '',
    "test('能力边界与措辞禁令已声明（capability ≠ 沙箱；Draft ≠ 认证）', () => {",
    "  const readme = readText('README.md')",
    "  assert.match(readme, /不构成安全沙箱/, 'RFC 0001 §5：capability 声明不是沙箱')",
    "  assert.match(readme, /不是认证/, 'RFC 0001 §13：插件不得自称「通过 Fabric 认证」或「安全」')",
    "  assert.match(readme, /非标准|未定义/, 'RFC 0001 §7.1：其他扩展路径（Cordis 面）必须明确标为非标准')",
    "  const gi = readText('.gitignore')",
    "  assert.ok(gi.includes('node_modules/'), '.gitignore 必须忽略 node_modules')",
    '})',
    '',
    "test('Fabric manifest：$schema 版本段与 manifestVersion 一致（§7.1：不得成为第二协商轴）', () => {",
    "  const m = JSON.parse(readText('dsh-plugin.json'))",
    "  const mm = String(m.manifestVersion).split('.').slice(0, 2).join('.')",
    "  assert.ok(String(m.$schema).includes('v' + mm), '$schema 版本段(' + mm + ') 必须与 manifestVersion 一致：' + m.$schema)",
    '})',
    '',
  ]
  return lines.join('\n')
}

/** 生成物清单（纯函数：让「模板必须产出哪些文件」成为可断言的不变量） */
export function buildFiles(spec: ForgeSpec): Record<string, string> {
  return {
    'src/index.ts': buildSource(spec),
    'package.json': buildPackageJson(spec),
    'tsconfig.json': buildTsconfig(),
    'cordis.patch.yml': buildPatch(spec),
    'README.md': buildReadme(spec),
    'docs/semantic.md': buildSemanticDoc(spec),
    'tests/smoke.test.mjs': buildSmokeTest(spec),
    '.gitignore': buildGitignore(),
    // Fabric（RFC 0001 v0.1 Draft）：静态 manifest + 不依赖 Cordis 的 host entrypoint 骨架
    'dsh-plugin.json': buildFabricManifest(spec),
    'src/fabric.ts': buildFabricEntrypoint(spec),
  }
}

/** spec 归一（原 execute 内联逻辑抽出：校验名 + 补 dsh- 前缀 + 有工具则强制 inject tools） */
export interface ForgeArgs {
  name: string
  description: string
  inject?: string[]
  imports?: string[]
  config?: Record<string, unknown>
  tools?: Array<Record<string, unknown>>
  fabric?: FabricSpec
}

export function normalizeSpec(args: ForgeArgs): { ok: true; spec: ForgeSpec; notes: string[] } | { ok: false; error: string } {
  const raw = args.name
  if (!/^[a-z][a-z0-9-]*$/.test(raw.replace(/^dsh-/, ''))) return { ok: false, error: '插件名须为小写字母开头，仅 [a-z0-9-]' }
  const name = raw.startsWith('dsh-') ? raw : 'dsh-' + raw
  const spec: ForgeSpec = {
    name,
    description: args.description,
    inject: args.inject,
    imports: args.imports,
    config: args.config as Record<string, ConfigFieldSpec> | undefined,
    tools: args.tools as ToolSpec[] | undefined,
    fabric: args.fabric,
  }
  if ((args.tools ?? []).length > 0 && !(spec.inject ?? []).includes('tools')) {
    spec.inject = ['tools', ...(spec.inject ?? [])]
  }
  // 组合优先闸门：spec 层的错**不留给产物**——跨插件/宿主内部路径导入在此拒绝（写盘之前）
  const internal = findInternalImports([...(args.imports ?? []), ...(args.tools ?? []).map((t) => String(t.execute ?? ''))])
  if (internal.length > 0) {
    return {
      ok: false,
      error: '组合优先违规：检测到跨插件/宿主内部路径导入 ' + internal.join('、')
        + ' —— 请改走公开入口（包根导出 / 官方 service / slot），不要假设或覆盖其他插件的内部实现',
    }
  }
  // Fabric 契约闸门（RFC 0001 v0.1）：白名单 / 命名空间 / 必拒类别——同样在写盘之前拒绝
  const fabricErrs = validateFabricSpec(spec)
  if (fabricErrs.length > 0) {
    return { ok: false, error: 'Fabric 契约违规：' + fabricErrs.join('；') }
  }
  // 声明清晰：对账并报告（补齐由 resolveInject 在 buildSource 里统一生效，此处只出说明，避免两处逻辑）
  const { added, unused } = resolveInject(spec)
  const notes: string[] = []
  if (added.length > 0) notes.push('已自动补声明 inject: ' + added.join('、') + '（源码里用到了 ctx.<svc>；不声明会在 cordis 严格代理下启动抛错）')
  if (unused.length > 0) notes.push('声明了未使用的 service: ' + unused.join('、') + '（不影响加载，但属声明的噪音）')
  for (const n of fabricSpecNotes(spec)) notes.push(n)
  if (!args.fabric) {
    notes.push('Fabric manifest 已按默认生成（id=' + defaultFabricId(name) + '，capabilities 为空）——要声明 capability / commands 请传 fabric 字段（v0.1 白名单：' + FABRIC_V01_CAPABILITIES.join(' / ') + '）')
  }
  return { ok: true, spec, notes }
}

// ════════════════════════ 工具 ════════════════════════
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('plugin-forge')
  const require = createRequire(import.meta.url)

  const selfPluginsDir = config.selfPluginsDir ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'self-plugins')
  const resolveTsc = (): string => {
    if (config.tscPath) return config.tscPath
    try { return require.resolve('typescript/bin/tsc') } catch { return '' }
  }
  /** forge 自身 node_modules 根（供生成插件依赖解析兜底） */
  const forgeNodeModules = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules')

  /** 侧车轨迹（§5.22「机制必须自证」）；观测绝不反噬主流程——吞错、不留痕、不抛 */
  const tracePath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugin-forge-trace.jsonl')
  function trace(rec: Record<string, unknown>): void {
    try { appendFileSync(tracePath, JSON.stringify({ atMs: Date.now(), ...rec }) + '\n', 'utf8') } catch { /* 观测不反噬 */ }
  }

  /**
   * 建 junction 前先 realpath——**junction 里套 pnpm 相对 symlink 在 Windows 上会解析失败**：
   * 2026-09-20 实测，readdirSync 能列出 `@types` 下的 `node`，但 `existsSync('@types/node')` 为 false、
   * `realpathSync` 却解析得到——tsc 的症状是 `TS2688: Cannot find type definition file for 'node'`。
   * 直接指向解析后的真实目录可绕开这条链路。
   */
  function linkReal(dest: string, src: string): void {
    let target = src
    try { target = realpathSync(src) } catch { /* 解析失败就用原路径 */ }
    symlinkSync(target, dest, 'junction')
  }

  /**
   * 生成插件的依赖准备——**绝不制造遮蔽**。
   * 旧行为（v0.1）把 forge 整个 node_modules 以 junction 链进新插件，两个后果都是事故级的：
   *  ① 新插件里跑 `pnpm install` 会**穿透写进 forge 的依赖树**（两个插件的依赖互相污染）；
   *  ② forge 的 `@deepseek-ai` 真实副本会被复制给每个新插件 ⇒ §5.15.4「旧副本遮蔽宿主 link farm，
   *     类型滞后 + 运行期 class 漂移」。故改为：能不建就不建；要建只建 typescript 与 @types。
   */
  async function prepareBuildEnv(dir: string): Promise<{ ok: boolean; output: string }> {
    const nm = join(dir, 'node_modules')
    // ① 清理旧版整目录 junction（迁移既有生成物，防止穿透/遮蔽继续传播）
    if (existsSync(nm) && lstatSync(nm).isSymbolicLink()) {
      try { unlinkSync(nm) } catch (e) { return { ok: false, output: '清除旧版 node_modules junction 失败: ' + String(e) } }
    }
    // ② 已有真实 node_modules（pnpm install 跑过）→ 保持不动，不越界
    if (existsSync(nm)) return { ok: true, output: '已有 node_modules（保持不动）' }
    // ③ 共享解析根已够用 → 一个文件都不建（最理想：依赖全部跟随宿主）
    const hasCordis = resolveUpFrom(dir, join('@deepseek-ai', 'cordis'), existsSync)
    const hasTypes = resolveUpFrom(dir, join('@types', 'node'), existsSync)
    if (hasCordis && hasTypes) return { ok: true, output: '复用共享解析根（未建 node_modules）' }
    // ④ 缺 @deepseek-ai 时**响亮失败**，绝不造副本兜底（那正是遮蔽源）
    if (!hasCordis) {
      return { ok: false, output: '共享解析根里找不到 @deepseek-ai/cordis，构建无法进行——请确认插件目录位于宿主工作区内，或先跑一次 profile 级 pnpm install' }
    }
    // ⑤ 最小补齐：只链 typescript（构建器）与 @types（tsconfig 的 types:["node"] 需要）
    mkdirSync(nm, { recursive: true })
    const linked: string[] = []
    try {
      for (const dep of ['typescript', '@types']) {
        const src = join(forgeNodeModules, dep)
        if (!existsSync(src)) continue
        if (dep === '@types') {
          // **逐条目**链接，而不是把 @types 整个 junction 过来：整目录 junction 内层若再是 pnpm 的
          // **相对 symlink**，Windows 上会解析失败——readdirSync 列得出 `node`，但 existsSync/stat 找不到，
          // 现象是 tsc 报 `TS2688: Cannot find type definition file for 'node'`（2026-09-20 实测踩中）。
          mkdirSync(join(nm, '@types'), { recursive: true })
          for (const entry of readdirSync(src)) linkReal(join(nm, '@types', entry), join(src, entry))
          linked.push('@types/*')
        } else {
          linkReal(join(nm, dep), src)
          linked.push(dep)
        }
      }
    } catch (e) {
      return { ok: false, output: '最小补齐 node_modules 失败: ' + String(e) }
    }
    if (!existsSync(join(nm, 'typescript'))) return { ok: false, output: 'forge 依赖里找不到 typescript，无法构建（可配置 tscPath）' }
    // 验证探测（§5.9 先探后信）：链接后必须真能看见 @types/node，别把 TS2688 留给下游
    if (!existsSync(join(nm, '@types', 'node', 'index.d.ts'))) {
      return { ok: false, output: '链接后仍看不到 @types/node/index.d.ts——junction 套 symlink 解析失败，请检查 forge 依赖完整性' }
    }
    return { ok: true, output: '已最小补齐 node_modules（' + linked.join(' + ') + '；未链 @deepseek-ai，解析仍走共享根）' }
  }

  async function build(dir: string): Promise<{ ok: boolean; output: string }> {
    const tsc = resolveTsc()
    if (!tsc) return { ok: false, output: '无法定位 tsc（配置 tscPath 或在 forge 依赖中安装 typescript）' }
    const deps = await prepareBuildEnv(dir)
    if (!deps.ok) return { ok: false, output: deps.output }
    const r = await new Promise<{ ok: boolean; output: string }>((resolve) => {
      execFile(process.execPath, [tsc, '-p', join(dir, 'tsconfig.json')], { cwd: dir, timeout: 120000 }, (err, stdout, stderr) => {
        if (err) resolve({ ok: false, output: (stdout || '') + (stderr || '') })
        else resolve({ ok: true, output: (stdout || stderr || '').trim() })
      })
    })
    // 依赖准备方式随构建结果一起回传：判「构建为何失败」时先看它是复用共享根还是最小补齐
    return { ok: r.ok, output: '[' + deps.output + '] ' + r.output }
  }

  ctx.tools.register(defineTool({
    name: 'plugin_forge',
    description: '插件创建插件：声明式 spec → 完整可构建的 DSH 插件项目（10 件：src/index.ts + src/fabric.ts + package.json + tsconfig + cordis.patch.yml + README + docs/semantic.md + tests/smoke.test.mjs + .gitignore + dsh-plugin.json）。生成后自动 tsc 构建验证。**Fabric（RFC 0001 v0.1 Draft）对齐**：默认产出静态 manifest `dsh-plugin.json` + 不依赖 DSH/Cordis 的 host entrypoint 骨架 `src/fabric.ts`，并在写盘前校验 capability 白名单 / 命名空间 / 必拒类别（provides、requires.services）。⚠ Fabric 目前只有文档（无正式 schema / SDK / conformance 套件，官方 plugin-development.md 明示其**尚不能作为依赖或发布目标**）⇒ manifest 的 `$schema` 是自证 draft 的 `.invalid` 占位，**不得声称已通过 Fabric 认证**。三条生态闸门：① 声明清晰——静态扫 execute 体里的 ctx.<svc> 与 spec.inject 对账并自动补齐（未声明 service 在 cordis 严格代理下启动即抛错）；② 组合优先——拒绝跨插件/宿主内部路径导入（dsh-x/lib/...）；③ 兼容优先——依赖准备绝不把 forge 的 @deepseek-ai 副本链进新插件（防遮蔽宿主 link farm）。spec 字段：name（包名，dsh- 前缀可省）、description、inject（依赖 service，默认 ["tools"]）、imports（额外 import 行数组）、config（Config schema 字段 {字段名:{type:"string|number|boolean",default?,required?}}）、tools（数组，每项 {name,description,parameters:{字段名:{type:"string|number|boolean|array|object",description?,required?}},outputSchema?,render?（v=>string 表达式）,execute（async 函数体语句）}）。生成目录在 selfPluginsDir/<name>。',
    parameters: {
      name: { type: 'string', description: '插件包名（小写 kebab，如 my-tool 或 dsh-my-tool；自动补 dsh- 前缀）', required: true },
      description: { type: 'string', description: '一句话用途（写入 description 与 README）', required: true },
      inject: { type: 'array', items: { type: 'string' }, description: '依赖的必需 service（默认 ["tools"]）' },
      imports: { type: 'array', items: { type: 'string' }, description: '额外 import 行数组（如 "import type {} from \'@deepseek-ai/dsh-session\'"）' },
      config: { type: 'object', additionalProperties: true, description: 'Config schema 字段 {字段名:{type,default?,required?}}；缺省=仅 enabled 开关' },
      tools: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '工具数组 [{name,description,parameters?,outputSchema?,render?,execute}]' },
      build: { type: 'boolean', description: '生成后自动 tsc 构建验证（默认 true）' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, dir: { type: 'string' }, built: { type: 'boolean' }, files: { type: 'array' }, notes: { type: 'array' }, error: { type: 'string' }, buildOutput: { type: 'string' } } }, render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '插件已生成 ' + (v.dir ?? '') + ' built=' + String(v.built) + ((v.notes ?? []).length ? '\n' + (v.notes as string[]).map((n: string) => '· ' + n).join('\n') : '') : '生成失败：' + (v.error ?? '') }] },
    async execute(args: ForgeArgs & { build?: boolean }) {
      const norm = normalizeSpec(args)
      if (!norm.ok) {
        trace({ name: args.name, ok: false, stage: 'normalize', error: norm.error })
        return { ok: false, error: norm.error }
      }
      const spec = norm.spec
      const name = spec.name
      const dir = join(selfPluginsDir, name)
      if (existsSync(dir)) {
        trace({ name, ok: false, stage: 'precheck', error: '目录已存在' })
        return { ok: false, error: '目录已存在: ' + dir }
      }
      try {
        const files = buildFiles(spec)
        for (const [f, content] of Object.entries(files)) {
          const abs = join(dir, f)
          mkdirSync(dirname(abs), { recursive: true })
          writeFileSync(abs, content, 'utf8')
        }
        let built = false
        let buildOutput = ''
        if (args.build !== false) {
          const r = await build(dir)
          built = r.ok
          buildOutput = r.output.slice(-500)
        }
        logger.info('forged ' + name + ' @ ' + dir + ' built=' + String(built))
        trace({ name, dir, ok: true, built, files: Object.keys(files), notes: norm.notes, buildOutput: buildOutput.slice(0, 200) })
        const out: Record<string, unknown> = { ok: true, dir, built, files: Object.keys(files), notes: norm.notes }
        // 注意：不要写 `buildOutput: undefined`——宿主 output.schema 是严格校验，值为 undefined 的键会校验失败
        if (buildOutput) out.buildOutput = buildOutput
        return out as any
      } catch (err) {
        // U5：写盘中途失败不留半成品目录（否则下一次同名生成会被自己的残骸按 I1 挡掉）
        let cleaned = false
        try { rmSync(dir, { recursive: true, force: true }); cleaned = true } catch { /* 清理失败不改判语义 */ }
        trace({ name, dir, ok: false, stage: 'write', error: String(err), cleaned })
        return { ok: false, error: '生成失败: ' + String(err) + (cleaned ? '（已清理半成品目录）' : '（半成品目录清理失败，需人工清理）') }
      }
    },
  }))
}
