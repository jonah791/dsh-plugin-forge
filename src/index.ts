/**
 * dsh-plugin-forge：插件创建插件
 *
 * 把「创建 DSH 插件」从手写 DSL 变成「声明式描述 → 生成完整可构建项目」。
 * 输入 spec（插件名/用途/工具列表/Config 字段/inject/imports），生成：
 *   src/index.ts（defineTool 注册、Config z.object、inject、apply）
 *   package.json / tsconfig.json / cordis.patch.yml / README.md
 *
 * 价值：工具 DSL 正确性（parameters 内联 required、output.schema、render）由生成器保证，
 * 消除手写 defineTool 的 TS 类型错误与括号配对错误；高自由度 = 任意 execute 逻辑、额外 import、
 * 自定义 Config 字段、render 表达式。生成后可自动 tsc 构建验证。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

export const name = 'plugin-forge'
export const inject = ['tools'] as const

export interface Config {
  selfPluginsDir?: string
  tscPath?: string
  bin?: string
}
export const Config = z.object({
  selfPluginsDir: z.string().required(false),
  tscPath: z.string().required(false),
  bin: z.string().required(false),
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
  const outSchema = sanitizeRequired(t.outputSchema ?? { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } })
  const schemaJson = JSON.stringify(outSchema)
  const renderExpr = t.render ?? 'JSON.stringify(v)'
  const argsType = hasParams ? 'args: ' + paramsType(paramsSan) : 'args: Record<string, unknown>'
  const lines: string[] = [
    '    ctx.tools.register(defineTool({',
    '      name: ' + JSON.stringify(t.name) + ',',
    '      description: ' + JSON.stringify(t.description) + ',',
  ]
  if (hasParams) lines.push('      parameters: ' + JSON.stringify(paramsSan) + ',')
  lines.push(
    '      output: {',
    '        schema: ' + schemaJson + ',',
    '        render: (_a: unknown, v: any) => [{ type: \'text\', text: ' + renderExpr + ' }],',
    '      },',
    '      async execute(' + argsType + ') {',
    '        ' + t.execute.trim().replace(/\n/g, '\n        '),
    '      },',
    '    }))',
  )
  return lines.join('\n')
}

/** 生成 src/index.ts 全文 */
export function buildSource(spec: ForgeSpec): string {
  const id = pluginId(spec.name)
  const inject = spec.inject ?? ['tools']
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
  const lines = [
    '# ' + spec.name,
    '',
    spec.description,
    '',
    '## 工具',
    ...(spec.tools ?? []).map((t) => '- `' + t.name + '`：' + t.description),
    '',
    '## 构建与挂载',
    '',
    '```sh',
    'pnpm build',
    '# 挂载到 web profile（dsh plugin-manager 或 plugin_mount）',
    '```',
    '',
    '组合行 id：`' + id + '`',
    '',
  ]
  return lines.join('\n')
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
  const lines = [
    '/**',
    ' * 骨架冒烟测试（由 dsh-plugin-forge 生成，2026-09-14）。',
    ' * 只断言结构、不依赖构建产物——`npm test` 在生成后立刻可跑；',
    ' * 业务逻辑测试请另加 tests/<主题>.test.mjs（跑 lib/ 产物，与运行时同源）。',
    ' */',
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { readFileSync, existsSync } from 'node:fs'",
    "import { join, dirname } from 'node:path'",
    "import { fileURLToPath } from 'node:url'",
    '',
    "const root = join(dirname(fileURLToPath(import.meta.url)), '..')",
    '',
    "test('package.json 可解析且暴露 build/test 脚本', () => {",
    "  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))",
    '  assert.equal(pkg.name, ' + JSON.stringify(spec.name) + ')',
    "  assert.equal(pkg.type, 'module')",
    "  assert.equal(pkg.main, 'lib/index.js')",
    "  assert.ok(pkg.scripts.build, '必须有 build 脚本')",
    "  assert.ok(pkg.scripts.test, '必须有 test 脚本（回归能力）')",
    '})',
    '',
    "test('src/index.ts 暴露 name / inject / apply', () => {",
    "  const src = readFileSync(join(root, 'src', 'index.ts'), 'utf8')",
    "  assert.ok(src.includes('export const name = '), '必须导出 name')",
    "  assert.ok(src.includes('export const inject = '), '必须导出 inject')",
    "  assert.ok(src.includes('export function apply('), '必须导出 apply')",
    '})',
    '',
    "test('tsconfig.json 是 ESM/NodeNext 配置', () => {",
    "  const ts = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'))",
    "  assert.equal(ts.compilerOptions.module, 'NodeNext')",
    "  assert.equal(ts.compilerOptions.outDir, 'lib')",
    '})',
    '',
    "test('语义文档存在（新能力开工前先落文档）', () => {",
    "  assert.ok(existsSync(join(root, 'docs', 'semantic.md')), '缺 docs/semantic.md')",
    '})',
    '',
    "test('cordis.patch.yml 含组合行 id', () => {",
    "  const yml = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')",
    '  assert.ok(yml.includes(' + JSON.stringify(pluginId(spec.name)) + '))',
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

export function normalizeSpec(args: ForgeArgs): { ok: true; spec: ForgeSpec } | { ok: false; error: string } {
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
  return { ok: true, spec }
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

  async function ensureDeps(dir: string): Promise<{ ok: boolean; output: string }> {
    // 已有真实 node_modules → 直接可用（pnpm install 已跑过）
    if (existsSync(join(dir, 'node_modules', '@deepseek-ai', 'cordis'))) return { ok: true, output: '已有 node_modules' }
    // 兜底：符号链接 forge 的 node_modules（离线即时；正式挂载时 plugin_mount 会做 profile 级 pnpm install）
    try {
      symlinkSync(forgeNodeModules, join(dir, 'node_modules'), 'junction')
      return { ok: true, output: '已符号链接 forge node_modules（挂载时建议 pnpm install）' }
    } catch (e) {
      return { ok: false, output: '依赖准备失败: ' + String(e) }
    }
  }

  async function build(dir: string): Promise<{ ok: boolean; output: string }> {
    const tsc = resolveTsc()
    if (!tsc) return { ok: false, output: '无法定位 tsc（配置 tscPath 或在 forge 依赖中安装 typescript）' }
    const deps = await ensureDeps(dir)
    if (!deps.ok) return { ok: false, output: deps.output }
    return await new Promise((resolve) => {
      execFile(process.execPath, [tsc, '-p', join(dir, 'tsconfig.json')], { cwd: dir, timeout: 120000 }, (err, stdout, stderr) => {
        if (err) resolve({ ok: false, output: (stdout || '') + (stderr || '') })
        else resolve({ ok: true, output: (stdout || stderr || '').trim() })
      })
    })
  }

  ctx.tools.register(defineTool({
    name: 'plugin_forge',
    description: '插件创建插件：声明式 spec → 完整可构建的 DSH 插件项目（src/index.ts + package.json + tsconfig + cordis.patch.yml + README）。生成后自动 tsc 构建验证。spec 字段：name（包名，dsh- 前缀可省）、description、inject（依赖 service，默认 ["tools"]）、imports（额外 import 行数组）、config（Config schema 字段 {字段名:{type:"string|number|boolean",default?,required?}}）、tools（数组，每项 {name,description,parameters:{字段名:{type:"string|number|boolean|array|object",description?,required?}},outputSchema?,render?（v=>string 表达式）,execute（async 函数体语句）}）。生成目录在 selfPluginsDir/<name>。',
    parameters: {
      name: { type: 'string', description: '插件包名（小写 kebab，如 my-tool 或 dsh-my-tool；自动补 dsh- 前缀）', required: true },
      description: { type: 'string', description: '一句话用途（写入 description 与 README）', required: true },
      inject: { type: 'array', items: { type: 'string' }, description: '依赖的必需 service（默认 ["tools"]）' },
      imports: { type: 'array', items: { type: 'string' }, description: '额外 import 行数组（如 "import type {} from \'@deepseek-ai/dsh-session\'"）' },
      config: { type: 'object', additionalProperties: true, description: 'Config schema 字段 {字段名:{type,default?,required?}}；缺省=仅 enabled 开关' },
      tools: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '工具数组 [{name,description,parameters?,outputSchema?,render?,execute}]' },
      build: { type: 'boolean', description: '生成后自动 tsc 构建验证（默认 true）' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, dir: { type: 'string' }, built: { type: 'boolean' }, files: { type: 'array' }, error: { type: 'string' }, buildOutput: { type: 'string' } } }, render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '插件已生成 ' + (v.dir ?? '') + ' built=' + String(v.built) : '生成失败：' + (v.error ?? '') }] },
    async execute(args: ForgeArgs & { build?: boolean }) {
      const norm = normalizeSpec(args)
      if (!norm.ok) return { ok: false, error: norm.error }
      const spec = norm.spec
      const name = spec.name
      const dir = join(selfPluginsDir, name)
      if (existsSync(dir)) return { ok: false, error: '目录已存在: ' + dir }
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
        return { ok: true, dir, built, files: Object.keys(files), buildOutput: buildOutput || undefined }
      } catch (err) {
        return { ok: false, error: '生成失败: ' + String(err) }
      }
    },
  }))
}
