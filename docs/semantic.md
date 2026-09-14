# 语义文档：插件创建器（plugin forge）

> 版本 v0.1 · 2026-09-14 · 作者：爱丽丝 · 状态：**draft**
> 开发方式：补课式回填（实现已存在，语义文档事后对齐；后续改动用实践回修）
> 实现落点：`self-plugins/dsh-plugin-forge/src/index.ts`（单文件，含生成器纯函数 + 工具注册）

| 项 | 值 |
|----|----|
| 能力名 | 插件创建器 / plugin forge |
| 主副本路径 | `self-plugins/dsh-plugin-forge/docs/semantic.md` |
| 实现落点 | `self-plugins/dsh-plugin-forge/src/index.ts`（374 行） |
| 包名 / 版本 | `dsh-plugin-forge` / 0.1.0（`package.json`） |
| 组合行 | `id: agent-plugin-forge` · `name: dsh-plugin-forge`（`.dsh/profiles/web/cordis.patch.yml:220`） |
| 状态 | **draft** |

---

## 1 · 定位与反定位

**定位**：把「创建一个 DSH 插件」从手写 `defineTool` DSL 变成「声明式 spec → 生成完整可构建的项目骨架」——
工具 DSL 的正确性（`parameters` 字段级 `required`、`output.schema`、`render` 表达式）由生成器保证，而非由人手抄保证。

**反定位（本文不管什么）**：
- **不管挂载**：生成 ≠ 上线；把插件装进 profile 是 `plugin_mount` / dsh plugin-manager 的职责，本插件只写目录 + 构建
- **不管依赖安装**：正式 `pnpm install` 由挂载链负责；本插件只做 junction 符号链接兜底（离线可构建）
- **不管业务逻辑**：`execute` 函数体由调用方以字符串给出，本插件不审其语义
- **不是** 通用代码生成器（只管 DSH 插件的包骨架），**不是** 版本管理工具（不 commit/push）

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| spec（`ForgeSpec`） | 声明式输入：`name` / `description` / `inject?` / `imports?` / `config?` / `tools?` |
| 生成目录 | `selfPluginsDir/<name>`；`selfPluginsDir` 缺省 `DSH_HOME/self-plugins` |
| 行 id（`pluginId`） | 包名 → 组合行 id：`dsh-xxx` → `agent-xxx`（与 plugin-manager scaffold 同约定） |
| DSL 净化（`sanitizeRequired`） | 把 spec 里的 schema 收窄到 DSH 工具 schema DSL 允许的形状（字段级 `required: true`） |
| built | 生成后 `tsc` 构建是否成功（`plugin_forge` 返回的 `built` 字段） |
| 构建验证 | `execFile(process.execPath, [tsc, '-p', tsconfig.json])`，超时 **120000 ms** |

## 3 · 概念模型

```
调用方（我 / 子代理）
   │  plugin_forge({name, description, inject?, imports?, config?, tools?, build?})
   ▼
┌──────────────────── src/index.ts: apply() ────────────────────┐
│ 名称校验 /^[a-z][a-z0-9-]*$/（去 dsh- 前缀后）→ 不合法即 ok:false │
│ 补 dsh- 前缀 → spec；tools 非空且 inject 无 'tools' → 自动前置  │
│ dir = selfPluginsDir/<name>；已存在 → ok:false（不覆盖）        │
│ mkdir src/ → 写 5 文件（纯函数生成）：                          │
│   src/index.ts · package.json · tsconfig.json                  │
│   cordis.patch.yml · README.md                                 │
│ build !== false → ensureDeps(dir) → tsc -p tsconfig.json       │
│ 返回 { ok, dir, built, files[], buildOutput? }（logger 另记一行）│
└───────────────────────────────────────────────────────────────┘
   ▼
生成目录（未挂载：挂载归 plugin_mount / plugin-manager）
```

不变量（invariants）：
1. **I1 不覆盖**：目标目录已存在时 `plugin_forge` 必返回 `ok:false`（错误串含「目录已存在」），不写任何文件
2. **I2 净化失败即拒绝**：spec 里出现对象级 `required: [...]` 数组时 `sanitizeRequired` 抛错（不是静默剥除）
3. **I3 可测纯函数**：`pluginId` / `sanitizeRequired` / `buildSource` / `buildPackageJson` / `buildTsconfig` / `buildPatch` / `buildReadme` 均无 IO，给定 spec 的输出是确定的
4. **I4 五文件齐备**：一次成功生成的目录必含上述 5 个文件（`files` 字段列出）
5. **I5 行 id 稳定**：`pluginId('dsh-x-y') === 'agent-x-y'`；`cordis.patch.yml` 与 README 里写的 id 同源

## 4 · 契约

### 4.1 工具 `plugin_forge`
- 参数：`name`（string，必填）· `description`（string，必填）· `inject?`（string[]）· `imports?`（string[]）· `config?`（object）· `tools?`（object[]）· `build?`（boolean，默认 `true`）
- 返回 schema：`{ ok: boolean(required), dir?, built?, files?, error?, buildOutput? }`；render：`ok ? '插件已生成 ' + dir + ' built=' + built : '生成失败：' + error`
- 插件配置（`Config`）：`selfPluginsDir?` · `tscPath?` · `bin?`（**注意：`bin` 在 schema 里声明但 `apply` 未读取，见 §10 U1**）

### 4.2 生成物形状（生成器纯函数 → 文件）

| 文件 | 生成函数 | 关键内容 |
|------|---------|---------|
| `src/index.ts` | `buildSource` | `export const name = '<行 id>'` · `export const inject = [...]` · `Config` 接口 + `z.object` · `apply(ctx, config)` + `ctx.tools.register(defineTool({...}))` |
| `package.json` | `buildPackageJson` | `main: lib/index.js` · `types: lib/types/index.d.ts` · peerDeps 固定三件（cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.1.0-rc.6）· `build: tsc -p tsconfig.json` · `typecheck` |
| `tsconfig.json` | `buildTsconfig` | `outDir: lib` · `rootDir: src` · `declarationDir: lib/types` · `strict` |
| `cordis.patch.yml` | `buildPatch` | `- insert:` / `- id: <行 id>` / `name: <包名>` / `config: {}` |
| `README.md` | `buildReadme` | 工具清单 + 「构建与挂载」+ 组合行 id |

### 4.3 状态 → 裁决表（`execute`，纯分支）

| 输入状态 | 裁决 | 错误串（逐字） | 语义依据 |
|---------|------|--------------|---------|
| `name` 去 `dsh-` 后不匹配 `/^[a-z][a-z0-9-]*$/` | `{ok:false}` | `插件名须为小写字母开头，仅 [a-z0-9-]` | 包名/行 id 规范 |
| 目标目录已存在 | `{ok:false}` | `目录已存在: <dir>` | I1 不覆盖 |
| spec 含对象级 `required: [...]` | 抛错被捕获 | `forge spec $.…: 对象级 required 数组 …不被 DSH 工具 schema DSL 支持…` | I2（2026-09-01 教训） |
| `tsc` 不可定位 | `{ok:true, built:false}` | `无法定位 tsc（配置 tscPath 或在 forge 依赖中安装 typescript）` | 生成成功 ≠ 构建成功 |
| 构建失败 | `{ok:true, built:false}` | `buildOutput` 回传（尾部 500 字符） | 同上 |
| 其余写盘异常 | `{ok:false}` | `生成失败: <err>` | 显式失败 |

### 4.4 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| 宿主组合 | `.dsh/profiles/web/cordis.patch.yml:220`（`insert: [{id: agent-plugin-forge, name: dsh-plugin-forge, config: {selfPluginsDir: E:/alice/self-plugins, tscPath: E:/alice/self-plugins/dsh-plugin-forge/node_modules/typescript/bin/tsc}}]`） | web 启动装载插件行 |
| DSH 工具面 | `src/index.ts:320` `ctx.tools.register(defineTool({ name: 'plugin_forge' }))` | `apply()` 执行时（注册一次） |
| 我 / 子代理 | 工具调用 `plugin_forge(...)`（本会话可见） | 需要新插件骨架时 |
| `apply` 内部 | `src/index.ts:287` `selfPluginsDir = config.selfPluginsDir ?? join(process.env.DSH_HOME \|\| join(homedir(), '.dsh'), 'self-plugins')` | 每次工具调用前（闭包求值一次） |
| `apply` 内部 | `src/index.ts:288-291` `resolveTsc()` → `config.tscPath` ?? `require.resolve('typescript/bin/tsc')` | 构建前 |
| `apply` 内部 | `src/index.ts:295-305` `ensureDeps(dir)`：已有 `node_modules/@deepseek-ai/cordis` → 直用；否则 `symlinkSync(forgeNodeModules, dir/node_modules, 'junction')`（`forgeNodeModules = <lib/…>/../node_modules`） | 构建前 |
| 生成器纯函数 | `pluginId` / `sanitizeRequired` / `buildSource` / `buildPackageJson` / `buildTsconfig` / `buildPatch` / `buildReadme`（均 `export`，可供离线单测直接调用） | 生成阶段 |
| 下游 | 挂载链 `plugin_mount` / dsh plugin-manager（`cordis.patch.yml` 由它消费）+ `preflight_check` 组合试运行 | 生成之后（不由本插件触发） |

## 5 · 边界与信任

- **能力边界 ≠ 沙箱**：本插件能写 `selfPluginsDir` 下的任意新目录并 spawn `node tsc`。它**不**校验 `execute` 字符串的安全性、**不**做凭据/隐私扫描、**不**限制生成路径逃逸（`selfPluginsDir` 来自配置）。
- **不越界清单**：不 commit / 不 push / 不挂载 / 不装依赖 / 不删已有目录 / 不改 profile patch / 不生成 `docs/semantic.md`（见 U2）。
- **失败面**：
  - 写盘失败 → 捕获后 `ok:false` + `生成失败: …`（**拒绝 + 报错**，留下可能半写的目录，需人工清）
  - `tsc` 缺失或失败 → **放行生成结果** + `built:false` + `buildOutput`（不删目录，由人裁决）
  - spec 校验失败 → 抛错 → 同上，`ok:false`
  - 依赖兜底失败 → `deps.output` 进 `buildOutput` 路径，返回 `ok:true, built:false`
  - 无静默丢弃分支；唯一「静默」是 `logger.info('forged …')` 走宿主 logger（**不落盘**，故判生效不得依赖它）

## 6 · 与既有机制的关系

- **与 AGENTS.md §5.11（组合变更必验证）**：生成只是造目录；**目录被挂进 profile 之后才是组合变更**——挂载/重启要走 `preflight_check` + 哨兵协议，本插件不参与
- **与 §5.20（语义文档纪律）**：新能力开工前应先有 `docs/semantic.md`；本插件生成的骨架**不含**该文件 → 存在纪律缺口（U2）
- **与 §5.22（可维护性）**：本插件自身只有 `logger`，无侧车轨迹；「上次生成了什么」只能从会话日志/工具返回值重建（U3）
- **与 preflight / 哨兵**：无直接耦合；生成物 `lib/*.js` 变新会改变 `hasUnverifiedBuilds()` 的判定面，从而**影响别人的重启窗口**——生成即可能触发别人的「组合未验证」

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（命令 / 日志行 / 产物） | 状态 |
|---|-----------|------------------------------|------|
| A1 | 插件已挂载进 web 组合 | `Select-String -Path E:\alice\.dsh\profiles\web\cordis.patch.yml -Pattern 'plugin-forge'` → 命中 220-224 行 | **已实测**（2026-09-14） |
| A2 | 宿主产物存在且可加载 | `E:\alice\self-plugins\dsh-plugin-forge\lib\index.js`（15335 B，mtime 2026-09-01 18:42:00）+ `lib/types/index.d.ts` | **已实测** |
| A3 | 工具 `plugin_forge` 在工具面可答 | 调用 `plugin_forge({name:'probe-x', description:'…'})` → 返回含 `ok/dir/built/files`；用不存在目录可验证 → **或**在 `_tmp_review/` 下生成后删除 | 待验收 |
| A4 | 目录已存在时拒绝且零写盘 | 连续两次 `plugin_forge` 同名 → 第二次 `ok:false`、`error` 含「目录已存在」；目录内文件 mtime 不变 | 待验收 |
| A5 | 对象级 `required` 数组被拒绝 | 传 `outputSchema: {type:'object', required:['ok']}` → `ok:false`，`error` 含「不被 DSH 工具 schema DSL 支持」 | 待验收 |
| A6 | 生成产物能通过 `tsc` | `plugin_forge(...)` 返回 `built:true`（`buildOutput` 为空） | 待验收 |
| A7 | `pluginId` 约定稳定 | `node -e "import('…/lib/index.js').then(m=>console.log(m.pluginId('dsh-x-y')))"` → `agent-x-y` | 待验收 |
| A8 | 生成器是纯函数（无 IO） | 对同一 spec 调 `buildSource` 两次结果字符串相等；`src/index.ts` 中这些函数体内无 `fs` 调用 | 已实测（源码审读）／待单测 |
| A9 | 改了代码后确实生效 | 见下方「生效判据」第 ①② 条 | 待验收 |

**生效判据（S7）**：改动 `src/index.ts` 后，按序取证——
① **产物新**：`lib/index.js` 的 mtime **晚于** web 进程启动时间（仅此一条不足，见 AGENTS.md §5.11 §6）；
② **进程在跑它**：web 进程启动时间 **晚于** `lib/index.js` mtime（否则线上仍是旧构建）；
③ **行为可答**：调 `plugin_forge`，返回 `ok:true` 且 `dir` 落在配置的 `selfPluginsDir`（`E:/alice/self-plugins`）——工具存在且参数被接受即证明新代码在跑。
缺 ② 时不得宣称「已生效」。

**回退（S7）**：本插件只新增目录、不改既有文件，回退面小——
① 代码回退：`git -C E:\alice\self-plugins\dsh-plugin-forge revert <坏提交>`（或 `git checkout <上一提交> -- src/`）→ `pnpm build` → 走 `preflight_check` + 哨兵重启；
② 能力回退：`plugin_stop dsh-plugin-forge`（或 `plugin_unmount`）→ 工具 `plugin_forge` 从工具面消失；
③ 误生成目录：直接删 `selfPluginsDir/<name>`（本插件不写该目录之外的任何位置，删除无外溢副作用）。

## 8 · 与实现的关系

- 主实现：`self-plugins/dsh-plugin-forge/src/index.ts`（唯一源文件）
- 构建产物：`lib/index.js`、`lib/types/index.d.ts`（`tsc -p tsconfig.json`）
- 同语义副本：无（本文件是唯一主副本）
- 未实现 / 未验证部分（**显式标注**）：
  - **无自动化测试**：仓库内没有 `tests/`，`package.json` 也没有 `test` 脚本 → 生成器纯函数的正确性只有源码审读，没有回归网
  - `Config.bin` 字段声明未被读取（死配置）
  - 生成骨架不含 `docs/semantic.md` / `.gitignore` / 测试脚本

## 9 · 实践修订记录

- 2026-09-14 补课：本插件此前无语义文档（可维护性工程）
- 2026-09-14 补课
  - 语义**被确认**：`plugin_forge` 的职责边界＝「生成 + 构建验证」，不含挂载/依赖安装/版本管理；`selfPluginsDir` 缺省 `DSH_HOME/self-plugins`
  - 语义**被补充**：写入「生效判据」两条（产物 mtime vs 进程启动时间 + 行为可答）与「回退」三条（git / plugin_stop / 删生成目录）
  - 语义**被修正**：此前无文档，不存在被推翻的旧表述；新记录两处与直觉不符的事实——① `Config.bin` 声明未使用；② 本插件**无单测**，因此 §7 多数条目为「待验收」
  - 教训：生成器类能力的语义核心是「拒绝条件」（何时不生成），而非「生成什么」——先把拒绝条件写清，才能防「半吊子生成」

## 10 · 未决问题

- **U1 `Config.bin` 是死字段**：schema 里声明但 `apply` 未读。倾向：删除声明（或让它真的参与 `execFile` 的启动器选择）。需实现者裁决。
- **U2 生成物缺语义文档**：与 AGENTS.md §5.20「新能力开工前先落 `docs/semantic.md`」冲突。倾向：`buildSource` 同级增加 `docs/semantic.md` 草稿（引用 `docs/semantics/templates/semantic.md`）——但**应先裁决**「生成器该不该替人写文档」，避免生成空壳模板。
- **U3 无自证轨迹**：生成过什么插件、哪次 `built=false`，只存在于会话日志。倾向：落 `<DSH_HOME>/plugin-forge-trace.jsonl`（一行一次 `{atMs, name, dir, built, tscMs}`），符合 §5.22「机制必须自证」。
- **U4 生成器无回归网**：纯函数已 `export` 就是在等单测；是否补 `tests/forge.test.mjs`（node --test 直测 lib 产物）由实现者定。
- **U5 失败时的半写目录**：写盘中途失败会留半成品目录（下次同名生成会被 I1 拒绝）。倾向：写失败即 `rmSync(dir, {recursive:true})` 清理（需裁决「删除是否越界」——本插件自建的目录，倾向可删）。
