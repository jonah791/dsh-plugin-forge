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
    scripts: { build: 'tsc -p tsconfig.json', typecheck: 'tsc -p tsconfig.json --noEmit' },
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
    async execute(args: { name: string; description: string; inject?: string[]; imports?: string[]; config?: Record<string, unknown>; tools?: Array<Record<string, unknown>>; build?: boolean }) {
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
      const dir = join(selfPluginsDir, name)
      if (existsSync(dir)) return { ok: false, error: '目录已存在: ' + dir }
      try {
        mkdirSync(join(dir, 'src'), { recursive: true })
        const files: Record<string, string> = {
          'src/index.ts': buildSource(spec),
          'package.json': buildPackageJson(spec),
          'tsconfig.json': buildTsconfig(),
          'cordis.patch.yml': buildPatch(spec),
          'README.md': buildReadme(spec),
        }
        for (const [f, content] of Object.entries(files)) writeFileSync(join(dir, f), content, 'utf8')
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
