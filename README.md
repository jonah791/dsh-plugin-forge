<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 插件创建插件——声明式 spec → 完整可构建的 DSH 插件项目（8 件：src/index.ts + package.json + tsconfig.json + cordis.patch.yml + README.md + docs/semantic.md + tests/smoke.test.mjs + .gitignore），生成后自动 tsc 构建验证；工具 DSL 正确性由生成器保证，不靠手抄
  inject: 'tools'
  tools: plugin_forge
  runtime: host-only
  envDeps: Node.js + TypeScript（tsc 由 tscPath 配置或自身 node_modules 定位）；无需网络
  boundary: 只生成目录与构建，不管挂载（plugin_mount/plugin-manager）、不管依赖安装、不审 execute 语义；不 overlay 已存在的目录（I1）；写盘失败会清理自己创建的半成品目录
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.1.0-rc.6
  ecosystem: 组合优先（拒绝跨插件内部路径导入）· 声明清晰（inject 静态对账 + dshForge 静态声明）· 兼容优先（依赖准备不制造 @deepseek-ai 遮蔽）
-->
# dsh-plugin-forge

<p align="center">
  <a href="https://github.com/jonah791/dsh-plugin-forge"><img src="https://img.shields.io/badge/version-0.3.1-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-34%20passed-brightgreen" alt="tests">
</p>

**一句话**：给一个声明式 spec（插件名/用途/inject/Config 字段/工具列表），生成一个**完整可构建**的 DSH 插件项目并当场跑 `tsc` 验证——把「手写 `defineTool` DSL」换成「填 spec」。

**为什么值得用**：手写插件骨架的失败点全是**结构性**的——`defineTool` 的 schema DSL 写错（对象级 `required: [...]` 数组会让插件加载崩、甚至把 web boot 带崩）、`tsconfig` 的 `declarationDir` 漏了导致 `types` 指向空文件、`cordis.patch.yml` 的行 id 与包名约定不一致、`inject` 漏声明某个 `ctx.<service>`（cordis 严格代理下**启动即抛错，而 tsc 查不出来**）。这些「不涉及业务逻辑、但一写错就崩宿主」的部分由生成器保证；业务逻辑（`execute` 函数体）仍由你自由写。生成物还**自带冒烟测试**，第一次构建后就能跑。

## 能力

| 工具 | 用途 |
|------|------|
| `plugin_forge` | 从 spec 生成插件项目：`src/index.ts` + `src/fabric.ts` + `package.json` + `tsconfig.json` + `cordis.patch.yml` + `README.md` + `docs/semantic.md` + `tests/smoke.test.mjs` + `.gitignore` + `dsh-plugin.json`（**10 件**）；生成后自动 `tsc -p tsconfig.json` 构建验证，返回 `{ok, dir, built, files[], notes[], error?, buildOutput?}` |

spec 字段：`name`（包名，`dsh-` 前缀可省，自动补）· `description` · `inject`（默认 `["tools"]`）· `imports`（额外 import 行数组）· `config`（Config schema 字段）· `tools`（工具数组）· `build`（默认 `true`）· `fabric`（`{id?, version?, capabilities?{required,optional}, subscriptions?, contributes?{commands?}}`——Fabric 静态声明，缺省只写真实内容）。

> `fabric.version` = manifest 的 `version`（插件自身版本）。新建插件缺省 `0.1.0`；**存量插件回填时必须传真版本**——给 0.9.0 的插件写 0.1.0 是**假声明**（v0.3.1 修）。

## 生态盘点与回填（`scripts/`）

两个与生成器**共用判据**的姊妹仪器（`scripts/` 目录——排障脚本一律升级成工具，不留一次性碎片）：

| 脚本 | 用途 |
|---|---|
| [`scripts/audit-ecosystem.mjs`](scripts/audit-ecosystem.mjs) | 生态审计：六判据扫全量自研插件（依赖遮蔽 / 内部路径导入 / inject 对账 / 缺 tests / 缺语义文档 / Fabric 面缺失）。**作者判据** = `git remote origin` 非 `jonah791` 即第三方（`self-plugins` 目录 ≠ 自研） |
| [`scripts/backfill-fabric.mjs`](scripts/backfill-fabric.mjs) | Fabric 面回填：给存量插件补 `dsh-plugin.json` + `src/fabric.ts`（+ `package.json.files` 收进 manifest）。能力面**如实推导**（只认 v0.1 三项，其余 cordis service 一律不写）；写盘前跑 `validateFabricSpec`，不过就不写。`--dry-run` / `--only a,b` / `--force` |

两者与生成器共用 `lib` 导出（`collectCtxServices` / `findInternalImports` / `listPluginDirs` / `isThirdPartyRepo` / `buildFabricManifest` / `buildFabricEntrypoint` / `validateFabricSpec`）——**同一把尺子**，避免生成器与审计器判据漂移。

> `listPluginDirs` **不做 `dsh-` 前缀过滤**：2026-09-20 实测 `computer-use`（自研、正常在用、无前缀）曾被前缀过滤静默漏掉，审计分母 58→59 才发现（「分派清单会漏格须做集合差」）。

`notes[]` 是闸门结论：**声明清晰**（哪些 service 被自动补进 `inject`、哪些声明了没用）+ **Fabric 提示**（订阅与 capability 未一并声明 / 声明了 commands 但没申请 `commands` capability / 本插件含 `tools` 而它不在 v0.1 capability 表内）——见下节。

## Fabric 对齐（v0.3 主题）

生成物默认自带 **DSH Community Fabric（[RFC 0001](https://github.com/anywhere-labs/dsh-desktop/blob/master/dsh-community-fabric/docs/rfcs/0001-plugin-manifest-capabilities-events.zh.md) v0.1 Draft）** 的静态契约面：

| 项 | 内容 |
|---|---|
| `dsh-plugin.json` | §7.1 冻结形状逐字段：`$schema` · `manifestVersion: 0.1.0` · `id`（反向 DNS，缺省 `com.jonah791.<包名>`）· `name` · `version` · `apiVersion: >=0.1.0 <0.2.0` · `entrypoints.host: lib/fabric.js` · `capabilities.{required,optional}`（**值为版本范围**）· `subscriptions` · `contributes.commands` |
| `src/fabric.ts` → `lib/fabric.js` | host entrypoint 骨架：默认导出 `activate(ctx)` + 幂等 `deactivate()`；**不依赖 DSH/Cordis**。头部显式标注**两个面**（Fabric 契约面 vs DSH/Cordis 非标准面）——骨架**不代表**插件能在 Fabric Host 上运行 |
| 生成器闸门（写盘前） | capability 白名单（`commands` / `messages.observe` / `storage.local` 或 `x-org.*`）· `id` 反向 DNS 形态 · 拒绝 `provides` / `requires.services`（§7.1）· 事件名限 `messages.observe`（§7.4）· `contributes.commands.id` 必须在自身命名空间 |
| 生成物守卫（**14 条**） | manifest 必填字段 · `$schema` 必须自证 draft · `$schema` 版本段 ≡ `manifestVersion` · id/capability 白名单 · subscriptions/commands 形状 · entrypoint 不依赖 DSH/Cordis（剔注释后判）· 能力边界与两个面在 README 里写明 |

> ⚠ **Draft，不是认证**：Fabric 目前只有文档（无正式 schema、无 SDK、无 conformance 套件），RFC §14 的 canonical `$schema` identifier 尚无归属，官方 [plugin-development.md](https://github.com/anywhere-labs/dsh-desktop/blob/master/docs/plugin-development.md) 明示其**尚不能作为依赖或发布目标**。因此：`$schema` 是 `.invalid` 占位（Phase 0 发布后替换单点常量）；生成物的 README 会显式区分「Fabric 契约面（前瞻声明）」与「DSH/Cordis 面（**非标准扩展路径**）」。RFC §13 规定插件**只能**声称「通过 v0.1 plugin validation」——而该套件尚不存在，故**任何声称「已符合 Fabric 标准 / 通过认证」的说法都是不成立的**。

## 生态对齐（v0.2.0 主题）

依据《DSH 插件生态倡议书》（组合优先 / 声明清晰 / 兼容优先），**每条都落成可机械验证的闸门**，而不是写在文档里的态度：

| 原则 | 闸门 | 判据 |
|------|------|------|
| **声明清晰** | `resolveInject()` 静态扫 `execute` 体里的 `ctx.<svc>`，与 spec 的 `inject` 对账并**自动补齐**，差异进 `notes[]` | `inject` 恰为「声明 ∪ 实际使用」；生成物自测断言**没有未声明的 service** |
| **组合优先** | `findInternalImports()` 拒绝跨插件/宿主的**内部路径**导入（`dsh-x/lib/...`、`@deepseek-ai/x/dist/...`） | 命中即 `ok:false`，错误串给出「改走公开入口」的出路；生成物自测同样扫一遍源码 |
| **兼容优先** | `prepareBuildEnv()` **只**链 `typescript` 与 `@types`，**绝不**链 `@deepseek-ai` | 生成目录里 `node_modules/@deepseek-ai` 不存在（解析全部走宿主共享根） |
| —— | **能力边界诚实声明** | 生成物 README 含「不构成安全沙箱」，并显式区分两个面（Fabric 契约面 / DSH-Cordis **非标准扩展路径**） |

> ⚠ v0.2 引入的 `dshForge` **本地声明已于 v0.3.0 删除**（被 `dsh-plugin.json` 取代，避免平行真源）；本节的 `dshForge` 行与守卫随之退场，README 中残留引用于 v0.3.1 清理。

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-plugin-forge": "link:<工作区>/self-plugins/dsh-plugin-forge"
```

**2) 挂组合**（agent 预设行）：

```yaml
- insert:
    - id: agent-plugin-forge
      name: dsh-plugin-forge
      config:
        selfPluginsDir: <工作区>/self-plugins
        tscPath: <工作区>/self-plugins/dsh-plugin-forge/node_modules/typescript/bin/tsc
```

**3) 30 秒验证**：调一次 `plugin_forge`：

```json
{ "name": "probe-x", "description": "冒烟探测", "tools": [{ "name": "probe_x", "description": "返回 ok", "execute": "return { ok: true }" }] }
```

期望：返回 `ok: true`、`built: true`、`files` 为 8 项；目录落在配置的 `selfPluginsDir/probe-x`；验证完删掉该目录即可。**同名第二次调用应返回 `ok:false` 且 `error` 含「目录已存在」**（不覆盖，I1）。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `selfPluginsDir` | `<DSH_HOME>/self-plugins` | 生成根目录；部署相关，建议由组合层显式给出 |
| `tscPath` | 未设 | `tsc` 可执行路径；缺省时从本插件依赖里 `resolve('typescript/bin/tsc')` |

> v0.2.0 起 `bin` 字段已删除（v0.1 声明但从未被读取，属死配置）。

## 落盘与自证（出问题时先看这里）

**自证轨迹**：每次生成落一行 JSONL 到 `<DSH_HOME>/plugin-forge-trace.jsonl`（`{atMs, name, dir, ok, built, files, notes, buildOutput?}`，失败路径带 `stage: normalize|precheck|write`）。落盘失败一律吞错——**观测绝不反噬主流程**。

**实际写入物 = 生成目录**（这是它的主产物，不是副作用）：

| 落点 | 内容 |
|------|------|
| `<selfPluginsDir>/<name>/src/index.ts` | `name`（行 id）/ `inject`（对账后）/ `Config` 接口 + `z.object` / `apply` + `defineTool` 注册 |
| `<selfPluginsDir>/<name>/package.json` | `main: lib/index.js` · `types: lib/types/index.d.ts` · peerDeps 固定三件 · **`dshForge` 静态声明** · `build` / `test` / `typecheck` 脚本 |
| `<selfPluginsDir>/<name>/tsconfig.json` | `outDir: lib` · `rootDir: src` · `declarationDir: lib/types` · `strict` |
| `<selfPluginsDir>/<name>/cordis.patch.yml` | `- insert:` / `- id: <行 id>` / `name: <包名>` |
| `<selfPluginsDir>/<name>/README.md` | 工具清单 + **生态契约** + **能力边界（诚实声明）** + 构建与挂载 + 组合行 id |
| `<selfPluginsDir>/<name>/docs/semantic.md` | 语义文档骨架（10 节 + 每节 TODO，状态 `draft`） |
| `<selfPluginsDir>/<name>/tests/smoke.test.mjs` | 生成物自带冒烟测试（**9 条**：结构 5 + 生态契约守卫 4） |
| `<selfPluginsDir>/<name>/.gitignore` | `node_modules/` · `lib/` · `*.log` · `data/` · `.dsh/` · `*.bak*` |

**一条命令答五问**：

```bash
tail -1 <DSH_HOME>/plugin-forge-trace.jsonl          # 上次生成：谁（name）· 成没成（ok/built）· 断在哪段（stage）· 补了什么（notes）
ls -l <selfPluginsDir>/<name>/ && tail -3 <selfPluginsDir>/<name>/lib/index.js
# ① 跑的是哪个构建 → lib/index.js 的 mtime（生成产物，与 tsc 那次构建同刻）
# ② 谁发起         → trace 的 name/dir（生成目录名 = spec.name 是唯一身份锚）
# ③ 断在哪一段     → stage 枚举：normalize(未写盘) → precheck(目录已存在) → write(生成失败，已清理) → build(返回 built:false + buildOutput)
# ④ 结果质量       → files[] 是否 8 件 + built 布尔 + notes[]（声明闸门的结论）
# ⑤ 耗时与预算     → tsc 调用超时预算 120000 ms（execFile 上限）；生成本身为同步写盘，无独立计时字段
```

**状态 → 裁决表**（`execute` 是纯分支，错误串逐字）：

| 输入状态 | 返回 | 错误串 |
|---------|------|--------|
| `name` 去 `dsh-` 后不匹配 `/^[a-z][a-z0-9-]*$/` | `ok:false` | `插件名须为小写字母开头，仅 [a-z0-9-]` |
| spec 含跨插件/宿主内部路径导入 | `ok:false` | `组合优先违规：检测到跨插件/宿主内部路径导入 <specifier> —— 请改走公开入口…` |
| 目标目录已存在 | `ok:false` | `目录已存在: <dir>` |
| spec 含对象级 `required: [...]` 数组 | `ok:false` | `…对象级 required 数组…不被 DSH 工具 schema DSL 支持…` |
| `tsc` 不可定位 | `ok:true, built:false` | `无法定位 tsc（配置 tscPath 或在 forge 依赖中安装 typescript）` |
| 共享解析根找不到 `@deepseek-ai/cordis` | `ok:true, built:false` | `共享解析根里找不到 @deepseek-ai/cordis，构建无法进行——…` |
| 构建失败 | `ok:true, built:false` | `buildOutput` 回传（尾部 500 字符） |
| 其余写盘异常 | `ok:false` | `生成失败: <err>（已清理半成品目录）` |

> **生成成功 ≠ 构建成功**：`ok:true` + `built:false` 是合法状态（目录已写、`tsc` 没过），必须看 `built`。

## 生效判据与回退

**生效判据**（三选一）：
1. 产物级：`lib/index.js` 的 mtime **晚于** web 进程启动时间 ⇒ 进程在跑当前构建（只看「产物新」不够，见下）；
2. 行为级：调 `plugin_forge` 能返回 `ok:true` 且 `dir` 落在配置的 `selfPluginsDir` ⇒ 工具在跑且配置被读到；
3. 生态级：`plugin_boot_status`（`dsh-plugin-bootreport`）的 `live` 含 `dsh-plugin-forge`、`stale` 不含 ⇒ 判据 1 的机器化版本。

> 注意：**重新构建 ≠ 生效**——`pnpm build` 只是写了一个新产物，**进程启动时间必须晚于产物 mtime** 才算「在跑它」。缺这一条时不得宣称「已生效」。

**回退**：
- 源码级：`git -C self-plugins/dsh-plugin-forge revert <坏提交>`（或 `git checkout <上一提交> -- src/`）→ 重新构建 → 预检 → 重启；
- 组合级：`plugin_stop dsh-plugin-forge` 或预设行加 `disabled: true` → 哨兵重启（工具 `plugin_forge` 从工具面消失）；
- 运行期：本插件**不覆盖任何既有文件**（I1），误生成目录直接 `rm -rf <selfPluginsDir>/<name>` 即可，无外溢副作用。

## 测试

```bash
npm test        # = node --test "tests/*.test.mjs"（跑 lib/ 产物，与运行时同源）
```

**46 例离线测试**（Windows 与 WSL 双平台各 46/46 通过）：

- 正常路径：spec → **10 件**产物齐全、`pluginId` 约定（`dsh-x-y` → `agent-x-y`）、`Config` 生成、`inject` 自动前置 `tools`；
- 失败/退化路径：非法包名、目标目录已存在、对象级 `required` 数组被拒（**这条是 2026-09-01 崩宿主教训的回归**）、跨插件内部路径导入被拒；
- 生态闸门：`collectCtxServices` 剔除 cordis 内建成员、`resolveInject` 自动补齐 + 未使用报告、`findInternalImports` 不误伤公开入口、`resolveUpFrom` 找不到即 `null`；
- Fabric 判据：`defaultFabricId` / `isFabricId` 形态、`validateFabricSpec` 通过与拒绝两路、`fabricSpecNotes` 只提示不拒绝（RFC 0003 §3）、manifest 冻结形状 + `version` 取真版本、entrypoint 两个面标注；
- 生态盘点：`listPluginDirs`（**不做 dsh- 前缀过滤**）、`isThirdPartyRepo`（remote 判据 + 无 remote 回落 scope）；
- 纯函数确定性：同 spec 两次 `buildSource` / `buildFiles` 结果逐字相等（无 IO、无时钟依赖）；
- 生成物自带回归：写临时目录后跑生成物的 `tests/smoke.test.mjs` → **14 pass**；
- **六条尸体测试**：删 `docs/semantic.md` / 把 `inject` 改空（漏声明 `tools`）/ 往 `src` 塞内部路径导入 / 把 manifest capability 改成后续候选 `sessions.read` / 往 `src/fabric.ts` 塞 `@deepseek-ai` import → 生成物测试必须转红（守卫非空断言）。

**无需网络、无需真实外部依赖**；需要本机有 `typescript`（走自身 `node_modules` 或 `tscPath`）。**离线单测不需要已挂载的 web 实例**。

## 设计要点

- **DSL 净化是硬约束**：DSH 的工具 schema DSL **只接受字段级 `required: true`**，不接受对象级 `required: [...]` 数组。spec 里出现后者时生成器**显式拒绝**（而不是静默剥除）——静默剥除会让作者以为写了，再在产物上手工补回标准 JSON Schema 数组，于是造出运行期违规：插件加载崩、web boot 崩。
- **不覆盖是安全设计**：目标目录存在即 `ok:false`。代价是重生成要手删，收益是生成器永远不会吃掉你手改过的产物。
- **依赖准备绝不制造遮蔽**（v0.2.0 重写）：从「junction 整个 forge `node_modules`」改为「能不建就不建；要建只建 `typescript` 与 `@types`」。旧行为有两个事故级后果——① 新插件里跑 `pnpm install` 会**穿透写进 forge 的依赖树**；② forge 的 `@deepseek-ai` 真实副本会被复制给每个新插件 ⇒ 旧副本遮蔽宿主 link farm（类型滞后 + 运行期 class 漂移）。
- **Windows：junction 里套 pnpm 相对 symlink 会解析失败**（2026-09-20 实测）：`readdirSync` 列得出 `@types/node`，但 `existsSync`/`stat` 找不到，`tsc` 报 `TS2688: Cannot find type definition file for 'node'`——而 `realpathSync` 能解析。故链接前一律 `realpathSync`，并对 `@types` **逐条目**链（不整目录 junction）；链完还有一次**验证探测**，别把 TS2688 留给下游。
- **生成物自带语义文档骨架与冒烟测试**：骨架解决 D4（缺节），内容留给人（状态标 `draft`）；冒烟测试把「文档存在 + 声明一致 + 不导入内部路径 + 能力边界诚实」变成**生成即满足**的结构不变量。
- **只写自己创建的目录**：写盘失败会 `rmSync` 清理自己创建的半成品目录（v0.1 不清理，会被 I1 挡住下一次同名生成）；本插件不触碰该目录之外的任何路径。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语、概念模型、契约（生成物形状 + 状态→裁决表 + 调用点清单）、生态闸门、可证伪验收清单（A1–A37）、未决问题 |
| [DSH 插件生态倡议书](https://github.com/anywhere-labs/dsh-desktop/blob/master/docs/plugin-ecosystem.md) | 组合优先 / 声明清晰 / 兼容优先（本插件 v0.2 的闸门依据） |
| [Community Fabric RFC 0001](https://github.com/anywhere-labs/dsh-desktop/blob/master/dsh-community-fabric/docs/rfcs/0001-plugin-manifest-capabilities-events.zh.md) | Manifest / Capability / 事件模型（**Draft**：静态声明思想已借鉴，未声称符合） |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `plugin-forge-design` / `dsh-plugin-development` / `plugin-maintainability` | 插件快速创建方法论、插件开发契约、可维护性工程 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
