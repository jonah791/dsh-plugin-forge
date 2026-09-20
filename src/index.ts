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

/**
 * `dshForge` 静态声明：让 Host / 目录 / 启动器**不执行插件代码**就能读到身份与能力需求（RFC 0001 §3 目标 1）。
 * ⚠ 这是**本地约定**，不是 Community Fabric manifest（RFC 0001 仍是 Draft，不是已发布标准）；
 * 字段刻意与 package.json 官方命名空间分开，避免与未来的官方语义撞名。
 */
export function buildForgeManifest(spec: ForgeSpec): Record<string, unknown> {
  const { inject: svc } = resolveInject(spec)
  return {
    contract: 1,
    inject: svc,
    contributes: { tools: (spec.tools ?? []).map((t) => t.name), slots: [] as string[], services: [] as string[] },
    capability: {
      runtime: 'trusted-in-process',
      sandbox: false,
      note: 'capability ≠ 沙箱：插件与宿主同进程、全权限；此声明用于兼容判断与审计，不构成技术强制',
    },
  }
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
    files: ['lib', 'README.md'],
    license: 'MIT',
    // 静态声明（本地约定，非 Fabric manifest）：Host/目录无需执行代码即可读取能力需求（RFC 0001 §3 目标 1）
    dshForge: buildForgeManifest(spec),
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
    '- **静态声明**：`package.json` → `dshForge`（**本地约定**，不是 Community Fabric manifest——RFC 0001 仍是 Draft）',
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
    '本插件与宿主**同进程、全权限**运行（`dshForge.capability.sandbox = false`）。',
    '「能力声明」用于兼容判断、用户确认与审计，**不构成安全沙箱**——不要把它当权限边界。',
    '本插件不导入其他插件或宿主的内部路径（组合优先），也不覆盖别人的内部实现。',
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
  const toolNames = (spec.tools ?? []).map((t) => t.name)
  const lines = [
    '/**',
    ' * 骨架冒烟测试（由 dsh-plugin-forge 生成，2026-09-20）。',
    ' * 只断言结构、不依赖构建产物——`npm test` 在生成后立刻可跑；',
    ' * 业务逻辑测试请另加 tests/<主题>.test.mjs（跑 lib/ 产物，与运行时同源）。',
    ' * 后四条是**生态契约守卫**（对应《DSH 插件生态倡议书》的声明清晰/组合优先）：',
    ' * inject 覆盖源码用到的 service · 无跨插件内部路径导入 · 静态声明与源码一致 · 能力边界已声明。',
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
    "test('静态声明 dshForge 与源码一致（单一真源）', () => {",
    "  const pkg = JSON.parse(readText('package.json'))",
    "  const text = readText(join('src', 'index.ts'))",
    "  assert.ok(pkg.dshForge, 'package.json 必须有 dshForge 静态声明')",
    '  assert.deepEqual(pkg.dshForge.inject, declaredInject(text), \'dshForge.inject 必须与源码 inject 逐字一致\')',
    '  const declaredTools = pkg.dshForge.contributes.tools',
    '  assert.deepEqual(declaredTools, ' + JSON.stringify(toolNames) + ', \'dshForge.contributes.tools 必须与 spec 工具清单一致\')',
    '  for (const t of declaredTools) {',
    "    assert.ok(text.includes('name: ' + JSON.stringify(t)), '源码里找不到声明的工具 ' + t)",
    '  }',
    '})',
    '',
    "test('能力边界与忽略规则已声明（capability ≠ 沙箱）', () => {",
    "  const pkg = JSON.parse(readText('package.json'))",
    "  assert.equal(pkg.dshForge.capability.sandbox, false, '必须显式声明不是沙箱')",
    "  assert.match(readText('README.md'), /不构成安全沙箱/)",
    "  const gi = readText('.gitignore')",
    "  assert.ok(gi.includes('node_modules/'), '.gitignore 必须忽略 node_modules')",
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
  // 声明清晰：对账并报告（补齐由 resolveInject 在 buildSource 里统一生效，此处只出说明，避免两处逻辑）
  const { added, unused } = resolveInject(spec)
  const notes: string[] = []
  if (added.length > 0) notes.push('已自动补声明 inject: ' + added.join('、') + '（源码里用到了 ctx.<svc>；不声明会在 cordis 严格代理下启动抛错）')
  if (unused.length > 0) notes.push('声明了未使用的 service: ' + unused.join('、') + '（不影响加载，但属声明的噪音）')
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
    description: '插件创建插件：声明式 spec → 完整可构建的 DSH 插件项目（8 件：src/index.ts + package.json + tsconfig + cordis.patch.yml + README + docs/semantic.md + tests/smoke.test.mjs + .gitignore）。生成后自动 tsc 构建验证。三条生态闸门：① 声明清晰——静态扫 execute 体里的 ctx.<svc> 与 spec.inject 对账并自动补齐（未声明 service 在 cordis 严格代理下启动即抛错）；② 组合优先——拒绝跨插件/宿主内部路径导入（dsh-x/lib/...）；③ 兼容优先——依赖准备绝不把 forge 的 @deepseek-ai 副本链进新插件（防遮蔽宿主 link farm）。spec 字段：name（包名，dsh- 前缀可省）、description、inject（依赖 service，默认 ["tools"]）、imports（额外 import 行数组）、config（Config schema 字段 {字段名:{type:"string|number|boolean",default?,required?}}）、tools（数组，每项 {name,description,parameters:{字段名:{type:"string|number|boolean|array|object",description?,required?}},outputSchema?,render?（v=>string 表达式）,execute（async 函数体语句）}）。生成目录在 selfPluginsDir/<name>。',
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
