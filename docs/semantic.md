# 语义文档：插件创建器（plugin forge）

> 版本 v0.2 · 2026-09-20 · 作者：爱丽丝 · 状态：**draft**
> 开发方式：补课式回填（实现已存在，语义文档事后对齐；后续改动用实践回修）
> 实现落点：`self-plugins/dsh-plugin-forge/src/index.ts`（单文件，含生成器纯函数 + 工具注册）
> v0.2 主题：**把《DSH 插件生态倡议书》三条原则落成可机械验证的闸门**（见 §4.5 / §5.1 / §9）

| 项 | 值 |
|----|----|
| 能力名 | 插件创建器 / plugin forge |
| 主副本路径 | `self-plugins/dsh-plugin-forge/docs/semantic.md` |
| 实现落点 | `self-plugins/dsh-plugin-forge/src/index.ts` |
| 包名 / 版本 | `dsh-plugin-forge` / 0.2.0（`package.json`） |
| 组合行 | `id: agent-plugin-forge` · `name: dsh-plugin-forge`（`.dsh/profiles/web/cordis.patch.yml:220`） |
| 生态依据 | 《DSH 插件生态倡议书》三条原则（组合优先 / 声明清晰 / 兼容优先）+ Community Fabric RFC 0001（**Draft**，非标准） |
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
| `collectCtxServices`（v0.2） | 静态扫源码里 `ctx.<svc>` 并剔除 cordis 内建成员（`logger`/`on`/`effect`…），得到**实际用到的 service** |
| `resolveInject`（v0.2） | 声明清晰闸门：`inject` = 声明 ∪ 实际使用；`added` = 补进去的，`unused` = 声明了没用的 |
| `findInternalImports`（v0.2） | 组合优先闸门：扫出跨插件/宿主**内部路径**导入（`dsh-x/lib/…`） |
| `dshForge`（v0.2） | `package.json` 里的**本地静态声明**（`contract`/`inject`/`contributes`/`capability`）；**不是** Community Fabric manifest |
| `resolveUpFrom`（v0.2） | Node 解析语义的显式版（注入 `exists` ⇒ 纯函数可测）；返回 `null` = 共享解析根不可达 |
| `prepareBuildEnv`（v0.2） | 依赖准备：能复用共享根就不建；要建只链 `typescript` + `@types`，**绝不链 `@deepseek-ai`** |
| `linkReal`（v0.2） | 建 junction 前先 `realpathSync`——绕开「junction 套 pnpm 相对 symlink」的 Windows 解析失败 |

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
6. **I6 声明一致（v0.2）**：生成物 `package.json` 的 `dshForge.inject` 与源码 `export const inject` **逐字相等**，且覆盖源码里全部 `ctx.<svc>`；由生成物自测守卫（尸体测试证明非空断言）
7. **I7 依赖不遮蔽（v0.2）**：生成目录的 `node_modules` 里**绝不出现 `@deepseek-ai`**——该命名空间一律由宿主共享解析根提供；出现即视为缺陷（旧副本会遮蔽宿主，见 AGENTS.md §5.15 §4）
8. **I8 组合优先（v0.2）**：spec 含跨插件/宿主内部路径导入时，**在写盘之前**拒绝（`ok:false`），不得先写出再报错
9. **I9 半成品自清（v0.2）**：写盘中途失败必须清理本插件自建的目录；清理本身失败不改判语义，但错误串须注明

## 4 · 契约

### 4.1 工具 `plugin_forge`
- 参数：`name`（string，必填）· `description`（string，必填）· `inject?`（string[]）· `imports?`（string[]）· `config?`（object）· `tools?`（object[]）· `build?`（boolean，默认 `true`）
- 返回 schema：`{ ok: boolean(required), dir?, built?, files?, error?, buildOutput? }`；render：`ok ? '插件已生成 ' + dir + ' built=' + built : '生成失败：' + error`
- 插件配置（`Config`）：`selfPluginsDir?` · `tscPath?` · `bin?`（**注意：`bin` 在 schema 里声明但 `apply` 未读取，见 §10 U1**）

### 4.2 生成物形状（生成器纯函数 → 文件）

| 文件 | 生成函数 | 关键内容 |
|------|---------|---------|
| `src/index.ts` | `buildSource` | `export const name = '<行 id>'` · `export const inject = [...]`（**对账后的**）· `Config` 接口 + `z.object` · `apply(ctx, config)` + `ctx.tools.register(defineTool({...}))` |
| `package.json` | `buildPackageJson` | `main: lib/index.js` · `types: lib/types/index.d.ts` · peerDeps 固定三件（cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.1.0-rc.6）· **`dshForge` 静态声明** · `build` / `test` / `typecheck` 脚本 |
| `tsconfig.json` | `buildTsconfig` | `outDir: lib` · `rootDir: src` · `declarationDir: lib/types` · `strict` |
| `cordis.patch.yml` | `buildPatch` | `- insert:` / `- id: <行 id>` / `name: <包名>` / `config: {}` |
| `README.md` | `buildReadme` | 工具清单 + **生态契约**（依赖 service / 贡献面 / 组合片段 / 静态声明）+ **能力边界（诚实声明）** + 构建与挂载 + 组合行 id |
| `docs/semantic.md` | `buildSemanticDoc` | 10 节骨架 + 每节 TODO，状态 `draft` |
| `tests/smoke.test.mjs` | `buildSmokeTest` | **9 条**生成物自测：结构 5 + 生态契约守卫 4（inject 覆盖 / 无内部路径导入 / `dshForge` 与源码同源 / 能力边界与 `.gitignore`） |
| `.gitignore` | `buildGitignore` | `node_modules/` · `lib/` · `*.log` · `data/` · `.dsh/` · `*.bak*` |

**生态闸门（v0.2 · 倡议书三条原则的机械化）**

| 原则 | 闸门函数 | 生效点 | 失败形态 |
|------|---------|--------|---------|
| 声明清晰 | `resolveInject` | `buildSource` 生成 inject + `normalizeSpec` 出 `notes` | 不再产生「用了却没声明」；未声明的 service 在 cordis 严格代理下本会**启动期抛错** |
| 声明清晰 | `buildForgeManifest` | `buildPackageJson` 写 `dshForge` | 生成物自测与源码对账（单一真源） |
| 组合优先 | `findInternalImports` | `normalizeSpec`（**写盘前**） | `ok:false` + 错误串给「改走公开入口」的出路 |
| 兼容优先 | `prepareBuildEnv` | `build()` 之前 | 找不到 `@deepseek-ai/cordis` ⇒ `built:false` **响亮失败**，绝不造副本兜底 |

### 4.3 状态 → 裁决表（`execute`，纯分支）

| 输入状态 | 裁决 | 错误串（逐字） | 语义依据 |
|---------|------|--------------|---------|
| `name` 去 `dsh-` 后不匹配 `/^[a-z][a-z0-9-]*$/` | `{ok:false}` | `插件名须为小写字母开头，仅 [a-z0-9-]` | 包名/行 id 规范 |
| spec 含**跨插件/宿主内部路径导入**（v0.2） | `{ok:false}` | `组合优先违规：检测到跨插件/宿主内部路径导入 <specifier> —— 请改走公开入口（包根导出 / 官方 service / slot），不要假设或覆盖其他插件的内部实现` | I8（倡议书原则 1） |
| 目标目录已存在 | `{ok:false}` | `目录已存在: <dir>` | I1 不覆盖 |
| spec 含对象级 `required: [...]` | 抛错被捕获 | `forge spec $.…: 对象级 required 数组 …不被 DSH 工具 schema DSL 支持…` | I2（2026-09-01 教训） |
| `tsc` 不可定位 | `{ok:true, built:false}` | `无法定位 tsc（配置 tscPath 或在 forge 依赖中安装 typescript）` | 生成成功 ≠ 构建成功 |
| 共享解析根找不到 `@deepseek-ai/cordis`（v0.2） | `{ok:true, built:false}` | `共享解析根里找不到 @deepseek-ai/cordis，构建无法进行——请确认插件目录位于宿主工作区内，或先跑一次 profile 级 pnpm install` | I7 依赖不遮蔽：**宁可响亮失败也不造副本兜底** |
| 链接后仍看不见 `@types/node`（v0.2） | `{ok:true, built:false}` | `链接后仍看不到 @types/node/index.d.ts——junction 套 symlink 解析失败，请检查 forge 依赖完整性` | 验证探测（§5.9 先探后信），别把 `TS2688` 留给下游 |
| 构建失败 | `{ok:true, built:false}` | `buildOutput` 回传（尾部 500 字符，前缀为依赖准备方式 `[复用共享解析根 \| 已最小补齐 …]`） | 同上 |
| 其余写盘异常（v0.2 起自动清目录） | `{ok:false}` | `生成失败: <err>（已清理半成品目录）` / `…（半成品目录清理失败，需人工清理）` | I9 + 显式失败 |

**说明字段（v0.2 新增 `notes[]`）**：`ok:true` 时随结果返回——`已自动补声明 inject: X（源码里用到了 ctx.<svc>；不声明会在 cordis 严格代理下启动抛错）` / `声明了未使用的 service: Y（不影响加载，但属声明的噪音）`。干净 spec 返回空数组（无噪音）。

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
- **v0.2 · 三处新边界（都写进了生成物，不只写在这里）**：
  1. **不制造依赖遮蔽**（I7）：依赖准备**只**链 `typescript` 与 `@types`，`@deepseek-ai/*` 一律由宿主共享解析根提供；找不到就 `built:false` 响亮失败，**不造副本兜底**。
  2. **只清理自己创建的目录**（I9）：写盘失败 `rmSync(dir)`，且只对本次 `mkdirSync` 出来的路径动手；清理失败不改判语义但要在错误串里说明。
  3. **能力声明是声明、不是强制**：`dshForge.capability = { runtime: 'trusted-in-process', sandbox: false }`——插件与宿主同进程、全权限，生成物 README 里也写明「不构成安全沙箱」。
- **自证轨迹的观测边界**：轨迹落 `<DSH_HOME>/plugin-forge-trace.jsonl`（一行一次生成），**写失败一律吞错**（观测绝不反噬主流程）。轨迹不是审计级凭据：它证明「本插件发起过这次生成」，不证明「产物此刻仍在磁盘上」。
- **不越界清单**：不 commit / 不 push / 不挂载 / 不装依赖 / 不删既有目录（只删自己刚建的半成品）/ 不改 profile patch / 不登记 `docs/semantics/registry.json`（U6）。**生成 `docs/semantic.md` 骨架**属既定职责（U2 已裁决 2026-09-14）。
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
| A10 | 回归能力存在且绿 | `npm test`（= `node --test "tests/*.test.mjs"`，跑 `lib/` 产物）→ **21 pass / 0 fail** | ✅ 2026-09-14 |
| A11 | `pluginId` 约定（A7 的离线版） | `tests/forge.test.mjs`「pluginId: 去 dsh- 前缀换 agent- 前缀」 | ✅ 2026-09-14 |
| A12 | 生成器纯函数确定性（A8 的离线版） | 同 spec 两次 `buildSource`/`buildFiles` 结果逐字相等（无 IO、无时钟依赖，除语义文档日期行） | ✅ 2026-09-14 |
| A13 | **生成物自带可跑回归检查**（模板不变量） | `buildFiles(spec)` 产出清单固定 7 件（含 `docs/semantic.md` + `tests/smoke.test.mjs`）；写出临时目录后 `node --test tests/smoke.test.mjs` → **5 pass** | ✅ 2026-09-14 |
| A14 | A13 的守卫**非空断言**（尸体测试） | 删掉生成物的 `docs/semantic.md` → 生成物测试转红（退出码 1、报 `缺 docs/semantic.md`） | ✅ 2026-09-14 |

**v0.2.0（2026-09-20）新增验收**

| # | 可证伪命题 | 证据（命令 / 单测名 / 产物） | 状态 |
|---|-----------|------------------------------|------|
| A15 | `inject` 覆盖源码里**全部** `ctx.<svc>`（声明清晰） | 单测 `resolveInject: 声明清晰——…自动补齐` + `collectCtxServices: 扫出 ctx.<svc>…` | **已实测** |
| A16 | 内建成员不被误判为 service | 单测 `collectCtxServices` 断言 `ctx.logger/on/effect` 被剔除、`ctx2/ctxX` 不误伤 | **已实测** |
| A17 | 跨插件内部路径导入在**写盘前**被拒 | 单测 `normalizeSpec: 组合优先闸门…`（断言错误串含「组合优先违规」与 specifier）；生成物自测同扫一遍源码 | **已实测** |
| A18 | 生成物**没有**本地 `@deepseek-ai` 且仍能构建 | 探针 `_tmp_review/forge-smoke.mjs`：`LOCAL @deepseek-ai? false` + `BUILD OK → lib/index.js true` | **已实测**（2026-09-20） |
| A19 | 生成物自带测试 9 条全绿 | 生成目录内 `node --test tests/smoke.test.mjs` → `ℹ tests 9 / pass 9 / fail 0` | **已实测**（2026-09-20） |
| A20 | `dshForge` 与源码 inject **逐字一致**（单一真源） | 单测 `buildPackageJson: 内嵌 dshForge 静态声明且与源码 inject 同源` + 生成物自测「静态声明 dshForge 与源码一致」 | **已实测** |
| A21 | 尸体测试：把 `inject` 改空 → 生成物守卫转红 | 单测 `尸体测试：把 inject 改空…`；另一条 `…把内部路径导入写进 src…` | **已实测** |
| A22 | **junction 套 pnpm 相对 symlink** 的解析失败已修 | 前后对照：`existsSync(@types/node)=false` + `TS2688` ⇒ 改逐条目 junction→realpath 后 `existsSync(index.d.ts)=true` + `BUILD OK` | **已实测**（2026-09-20） |
| A23 | 双平台测试一致 | Windows `ℹ pass 34 / fail 0` · WSL `# pass 34 / fail 0` | **已实测**（2026-09-20） |
| A24 | 自证轨迹真的落盘 | `tail -1 <DSH_HOME>/plugin-forge-trace.jsonl` → 2026-09-20 重启后真调实测行：`{"atMs":1789873526823,"name":"dsh-forge-smoke","ok":true,"built":true,"files":[…8 项…],"notes":[…2 条…],"buildOutput":"[已最小补齐 node_modules（typescript + @types/*；未链 @deepseek-ai，解析仍走共享根）] "}` | **已实测**（2026-09-20 线上） |
| A25 | 旧版整目录 junction 会被迁移清理 | —— | **不可达（当前路径）**：`execute` 先写目录再 `prepareBuildEnv`，而 I1 保证该目录此前不存在 ⇒ `node_modules` 必然不存在，分支 ①②（清理旧 junction / 保留真实 node_modules）**进不去**，故**不宣称已验收**。保留为防御性分支，待 `--force` 重生成落地才可达（U8） |
| A26 | 线上真调：8 件产物 + 依赖只链两样 | 真实 `plugin_forge` 调用后：顶层含 `.gitignore`/`cordis.patch.yml`/`package.json`/`README.md`/`tsconfig.json`/`docs`/`src`/`tests`；`node_modules` 内容 = **仅 `@types, typescript`**；`Test-Path node_modules/@deepseek-ai` = **False**；`lib/index.js` 产出；`notes[]` 2 条（补 `llm` / 未用 `subprocess`） | **已实测**（2026-09-20 线上） |

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
  - ~~**无自动化测试**~~ **已补（2026-09-14）**：`tests/forge.test.mjs`（v0.2.0 起 **34 用例**，含失败路径 + **四条**尸体测试）。A3–A6/A9 属**接线/构建**行为（真跑 `tsc`、真写盘），仍需真实调用验收。
  - ~~`Config.bin` 字段声明未被读取（死配置）~~ **已删（2026-09-20，U1 闭环）**
  - ~~生成骨架不含 `docs/semantic.md` / `.gitignore` / 测试脚本~~ **已改（2026-09-14 / 09-20）**：现含 `docs/semantic.md`（10 节骨架）+ `tests/smoke.test.mjs`（9 条守卫）+ `.gitignore` + `package.json.scripts.test`。
  - 生成物清单的单一真源 = `buildFiles(spec)`（`execute` 只负责写盘，不再内联拼清单）。
  - **仍未验证（v0.2 显式标注）**：`prepareBuildEnv` 的旧 junction 迁移分支（A25）与自证轨迹落盘（A24）只在真实工具调用里触发 ⇒ **待线上验收**（需构建 → 预检 → 重启后真调一次）。
  - **未覆盖**：`execute` 体的语义（生成器不审其安全性）；`dshForge` 没有任何**消费方**——目前只有生成物自测在读它（RFC 0001 落地前，它不是标准，别把它当兼容契约）。

## 9 · 实践修订记录

- 2026-09-14 补课：本插件此前无语义文档（可维护性工程）
- 2026-09-14 补课
  - 语义**被确认**：`plugin_forge` 的职责边界＝「生成 + 构建验证」，不含挂载/依赖安装/版本管理；`selfPluginsDir` 缺省 `DSH_HOME/self-plugins`
  - 语义**被补充**：写入「生效判据」两条（产物 mtime vs 进程启动时间 + 行为可答）与「回退」三条（git / plugin_stop / 删生成目录）
  - 语义**被修正**：此前无文档，不存在被推翻的旧表述；新记录两处与直觉不符的事实——① `Config.bin` 声明未使用；② 本插件**无单测**，因此 §7 多数条目为「待验收」
  - 教训：生成器类能力的语义核心是「拒绝条件」（何时不生成），而非「生成什么」——先把拒绝条件写清，才能防「半吊子生成」

- **2026-09-14 可维护性补课（批次 W3）：生成器上测试 + 补模板缺口（docs/semantic.md 与 test 脚本）**
  - 语义**被确认**：`sanitizeRequired` 对对象级 `required` 数组**响亮拒绝**（不静默剥除）；`pluginId('dsh-x')='agent-x'`；`buildSource` 的 `name` 导出是**组合行 id（agent-xxx）而非包名**；`inject` 缺省恒为 `['tools']`（与 spec 是否含 tools 无关），`defineTools` 的 import 跟随 inject，而**工具注册块**跟随 `spec.tools`。
  - 语义**被补充**：新增四个导出——`normalizeSpec`（原 `execute` 内联的「校验名 + 补前缀 + 有工具则强制 inject tools」抽出）、`buildFiles`（生成物清单 = **单一真源**，7 件）、`buildSemanticDoc`（10 节语义文档骨架）、`buildSmokeTest`（骨架守卫测试）。
  - 语义**被修正（模板缺口，行为变更）**：生成骨架原先**不含 `docs/semantic.md`、不含 `test` 脚本**——这正是「每个新插件都从 S1/S3 缺口起步」的**根因**（可维护性体检的缺口在源头被持续复制）。现生成物自带：`docs/semantic.md`（必备 10 节，含调用点清单节）+ `tests/smoke.test.mjs`（5 条骨架断言，**不依赖 lib/ 构建产物**，故生成后 `npm test` 立刻可跑）+ `package.json.scripts.test`。`execute` 相应改为「按文件路径逐级 `mkdirSync(dirname(abs))`」，以支持 `docs/`、`tests/` 子目录。
  - 语义**被修正（测试方法学，非插件缺陷）**：从 `node --test` 内部再 `spawnSync('node', ['--test', ...])` 时，子进程继承 `NODE_TEST_CONTEXT` → node:test 判定「递归调用 run()」并**静默跳过全部文件、以退出码 0 结束（假绿）**。测试须 `delete env.NODE_TEST_CONTEXT`，并额外断言子进程真的跑了 5 条用例（只断 status===0 会漏掉这类假绿）。
  - 教训：**模板是「缺口复制器」**——一个生成器缺什么，未来每个新插件就缺什么；给生成器写测试时，最该锁住的不是「生成了什么字符串」，而是「生成物本身能不能通过体检」（本次：生成物自带可跑测试 + 尸体测试证明删件即红）。

- **2026-09-20 v0.2.0：对齐《DSH 插件生态倡议书》，把三条原则落成机械闸门**
  - 触发：主人给 [plugin-ecosystem.md](https://github.com/anywhere-labs/dsh-desktop/blob/master/docs/plugin-ecosystem.md) + 指令「改进插件生成插件」；同时读了 Community Fabric RFC 0001（**Draft**）。
  - 语义**被补充（三条闸门）**：① 声明清晰 → `resolveInject` 静态扫 `ctx.<svc>` 与 spec.inject 对账并补齐（未声明 service 在 cordis 严格代理下**启动期抛错而 tsc 查不出**，生成器是唯一能机械发现它的地方），差异进 `notes[]`；② 组合优先 → `findInternalImports` 拒绝 `dsh-x/lib/…` 这类内部路径导入，**在写盘之前**；③ 兼容优先 → `prepareBuildEnv` 重写依赖准备。
  - 语义**被修正（行为变更，事故级）**：旧 `ensureDeps` 把 forge 整个 `node_modules` junction 给新插件，后果有二——① 新插件里跑 `pnpm install` 会**穿透写进 forge 的依赖树**；② forge 的 `@deepseek-ai` 真实副本会复制给每个新插件，正是 AGENTS.md §5.15 §4 的「旧副本遮蔽宿主 link farm」。现改为「能复用共享解析根就不建；要建只链 `typescript` + `@types`」。
  - 语义**被补充（静态声明）**：新增 `package.json` 的 `dshForge`（`contract`/`inject`/`contributes`/`capability`）。**明确不是 Fabric manifest**——RFC 0001 仍是 Draft、当前插件继续用 DSH/Cordis 接口，故字段与官方命名空间分开，且由生成物自测与源码机械对账，避免造出会漂移的第二真源。
  - 语义**被补充（产物）**：生成物 7 → **8 件**（新增 `.gitignore`）；生成物自测 5 → **9 条**（新增 4 条生态契约守卫）；新增 `notes[]` 返回字段；`Config.bin` 死字段删除（U1 闭环）；自证轨迹落地（U3 闭环）；写盘失败自动清理半成品目录（U5 闭环）。
  - 语义**被修正（文档自身）**：§4.2 与 I4 长期写着「五文件」，而实现自 2026-09-14 起已是 7 件——**文档比实现旧**（`semantic_check` D3 的典型形态）；本次一并对齐到 8 件。
  - **实测踩坑（Windows 链路，已写进代码注释与 README）**：`junction` 里套 pnpm 的**相对 symlink** 会解析失败——`readdirSync` 列得出 `@types/node`，但 Node 的 `existsSync`/`stat` 找不到（`.NET` 的 `Test-Path` 却报 true，**两套读数分歧**），tsc 报 `TS2688: Cannot find type definition file for 'node'`，而 `realpathSync` 能解析。故 `linkReal` 先 realpath、`@types` **逐条目**链、链完再做一次**验证探测**。
  - **教训**：给生成器加「原则」时，原则必须先变成**产物里的守卫**（生成物自测）才算落地——写在 README 里的原则会随产物一起漂走，写在生成物测试里的原则每次都重跑。本条也是这一版的真实收益：新插件的「声明一致 / 不导入内部路径 / 能力边界诚实」从**每次靠人记得**变成**生成即满足**。

## 10 · 未决问题

> **v0.2.0（2026-09-20）对本节的一次性处置**：U1（死字段）→ **已删**；U3（无自证轨迹）→ **已实现** `<DSH_HOME>/plugin-forge-trace.jsonl`（吞错、不反噬）；U5（半写目录）→ **已实现**自清（只清本插件自建目录）；U6（缺 `.gitignore`）→ **已生成**（`docs/semantics/registry.json` 登记仍保留人工——跨仓库写入不该由生成器代劳，理由不变）。U2/U4 已于 2026-09-14 闭环。**新增 U7**：`dshForge` 只有生成物自测在消费，尚无 Host/目录读它（RFC 0001 落地前不等于兼容契约）。

- **U1 `Config.bin` 是死字段**：schema 里声明但 `apply` 未读。倾向：删除声明（或让它真的参与 `execFile` 的启动器选择）。需实现者裁决。
  → **已闭环（2026-09-20）**：删除 `bin`（v0.1 声明但从未被读取）。删前确认无调用方依赖：profile 组合行只配 `selfPluginsDir` + `tscPath`。
- **U2 生成物缺语义文档**：与 AGENTS.md §5.20「新能力开工前先落 `docs/semantic.md`」冲突。倾向：`buildSource` 同级增加 `docs/semantic.md` 草稿（引用 `docs/semantics/templates/semantic.md`）——但**应先裁决**「生成器该不该替人写文档」，避免生成空壳模板。
  → **已裁决并实现（2026-09-14）**：生成器**替人写骨架**（10 节 + 每节 TODO，状态标 `draft`），人只填空不改结构。裁决依据：D4（缺节）正是骨架能一次性解决的部分，而「填内容」才是人的判断面——空壳风险由「必备节齐全 + 状态 draft」控制，且生成物自带冒烟测试会立刻检查它存在。
- **U4 生成器无回归网**：纯函数已 `export` 就是在等单测；是否补 `tests/forge.test.mjs`（node --test 直测 lib 产物）由实现者定。
  → **已闭环（2026-09-14）**：`tests/forge.test.mjs` 21 用例（正常 + 失败/退化 + 两条尸体测试），A10–A14 全绿。
- **U3 无自证轨迹**：生成过什么插件、哪次 `built=false`，只存在于会话日志。倾向：落 `<DSH_HOME>/plugin-forge-trace.jsonl`（一行一次 `{atMs, name, dir, built, tscMs}`），符合 §5.22「机制必须自证」。
- **U5 失败时的半写目录**：写盘中途失败会留半成品目录（下次同名生成会被 I1 拒绝）。倾向：写失败即 `rmSync(dir, {recursive:true})` 清理（需裁决「删除是否越界」——本插件自建的目录，倾向可删）。
- **U6 生成物仍无 `.gitignore` / 无 registry 登记**（本次新增登记）：`node_modules`、`lib` 是否随仓提交由生成物自行决定；`docs/semantics/registry.json`（S2 登记）仍需人工完成。倾向：生成 `.gitignore`（忽略 `node_modules`）；registry 登记保留人工——跨仓库写入不该由生成器代劳。
  → **部分闭环（2026-09-20）**：`.gitignore` 已生成（8 件之一，含 `node_modules/` 与 `lib/`）；registry 登记**仍保留人工**，理由不变。
- **U8 `prepareBuildEnv` 的分支 ①②（清理旧 junction / 保留真实 node_modules）当前不可达**（2026-09-20 识别）：`execute` 的 I1 保证目标目录此前不存在，故 `node_modules` 必然不存在。三个选项：① 删掉这两条分支（最简，但 `--force` 重生成落地时遮蔽风险会回来）；② 抽成可注入 fs 的导出函数并补单测（可测，但要重构 `apply` 闭包）；③ **保留为防御性分支 + 显式标注不可达**（本次选择，代价已在 A25 处如实写明「不宣称已验收」）。倾向：等真要做 `--force` 重生成时一并处置——届时它立刻变成**必须可达且必须测**的路径。
