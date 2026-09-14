<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 插件创建插件——声明式 spec → 完整可构建的 DSH 插件项目（7 件：src/index.ts + package.json + tsconfig.json + cordis.patch.yml + README.md + docs/semantic.md + tests/smoke.test.mjs），生成后自动 tsc 构建验证；工具 DSL 正确性由生成器保证，不靠手抄
  inject: 'tools'
  tools: plugin_forge
  runtime: host-only
  envDeps: Node.js + TypeScript（tsc 由 tscPath 配置或自身 node_modules 定位）；无需网络
  boundary: 只生成目录与构建，不管挂载（plugin_mount/plugin-manager）、不管依赖安装、不审 execute 语义；不 overlay 已存在的目录（I1）
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-plugin-forge

<p align="center">
  <a href="https://github.com/jonah791/dsh-plugin-forge"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-21%20passed-brightgreen" alt="tests">
</p>

**一句话**：给一个声明式 spec（插件名/用途/inject/Config 字段/工具列表），生成一个**完整可构建**的 DSH 插件项目并当场跑 `tsc` 验证——把「手写 `defineTool` DSL」换成「填 spec」。

**为什么值得用**：手写插件骨架的失败点全是**结构性**的——`defineTool` 的 schema DSL 写错（对象级 `required: [...]` 数组会让插件加载崩、甚至把 web boot 带崩）、`tsconfig` 的 `declarationDir` 漏了导致 `types` 指向空文件、`cordis.patch.yml` 的行 id 与包名约定不一致。这些「不涉及业务逻辑、但一写错就崩宿主」的部分由生成器保证；业务逻辑（`execute` 函数体）仍由你自由写。生成物还**自带冒烟测试**，第一次构建后就能跑。

## 能力

| 工具 | 用途 |
|------|------|
| `plugin_forge` | 从 spec 生成插件项目：`src/index.ts` + `package.json` + `tsconfig.json` + `cordis.patch.yml` + `README.md` + `docs/semantic.md` + `tests/smoke.test.mjs`（7 件）；生成后自动 `tsc -p tsconfig.json` 构建验证，返回 `{ok, dir, built, files[], error?, buildOutput?}` |

spec 字段：`name`（包名，`dsh-` 前缀可省，自动补）· `description` · `inject`（默认 `["tools"]`）· `imports`（额外 import 行数组）· `config`（Config schema 字段）· `tools`（工具数组）· `build`（默认 `true`）。

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

期望：返回 `ok: true`、`built: true`、`files` 为 7 项；目录落在配置的 `selfPluginsDir/probe-x`；验证完删掉该目录即可。**同名第二次调用应返回 `ok:false` 且 `error` 含「目录已存在」**（不覆盖，I1）。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `selfPluginsDir` | `<DSH_HOME>/self-plugins` | 生成根目录；部署相关，建议由组合层显式给出 |
| `tscPath` | 未设 | `tsc` 可执行路径；缺省时从本插件依赖里 `resolve('typescript/bin/tsc')` |
| `bin` | 未设 | **当前是死字段**：schema 里声明但 `apply` 未读取（见 `docs/semantic.md` §10 U1） |

## 落盘与自证（出问题时先看这里）

**本插件无自证轨迹**（`<DSH_HOME>/plugin-forge-trace.jsonl` 仅是 `docs/semantic.md` §10 U3 的**提案，尚未实现**）：生成过什么、哪次 `built=false`，目前只能从**生成目录本身**与宿主日志反查。

**实际写入物 = 生成目录**（这是它的主产物，不是副作用）：

| 落点 | 内容 |
|------|------|
| `<selfPluginsDir>/<name>/src/index.ts` | `name`（行 id）/ `inject` / `Config` 接口 + `z.object` / `apply` + `defineTool` 注册 |
| `<selfPluginsDir>/<name>/package.json` | `main: lib/index.js` · `types: lib/types/index.d.ts` · peerDeps 固定三件 · `build` / `typecheck` 脚本 |
| `<selfPluginsDir>/<name>/tsconfig.json` | `outDir: lib` · `rootDir: src` · `declarationDir: lib/types` · `strict` |
| `<selfPluginsDir>/<name>/cordis.patch.yml` | `- insert:` / `- id: <行 id>` / `name: <包名>` |
| `<selfPluginsDir>/<name>/README.md` | 工具清单 + 构建与挂载 + 组合行 id |
| `<selfPluginsDir>/<name>/docs/semantic.md` | 语义文档骨架（10 节 + 每节 TODO，状态 `draft`） |
| `<selfPluginsDir>/<name>/tests/smoke.test.mjs` | 生成物自带的冒烟测试（守卫：缺 `docs/semantic.md` 即转红） |

**一条命令答五问**（无 trace 时的行为级等价物）：

```bash
ls -l <selfPluginsDir>/<name>/ && tail -3 <selfPluginsDir>/<name>/lib/index.js
# ① 跑的是哪个构建 → lib/index.js 的 mtime（生成产物，与 tsc 那次构建同刻）
# ② 谁发起         → 无 caller 字段；发起者即调用方会话（生成目录名 = spec.name 是唯一身份锚）
# ③ 断在哪一段     → 阶段枚举由调用返回值给出：目录已存在(未开始) → 写盘(生成失败) → ensureDeps → tsc(返回 built:false + buildOutput 尾部 500 字符)
# ④ 结果质量       → files[] 是否 7 件 + built 布尔（built:false 时看 buildOutput）
# ⑤ 耗时与预算     → tsc 调用超时预算 120000 ms（execFile 上限）；生成本身为同步写盘，无独立计时字段
```

**状态 → 裁决表**（`execute` 是纯分支，错误串逐字）：

| 输入状态 | 返回 | 错误串 |
|---------|------|--------|
| `name` 去 `dsh-` 后不匹配 `/^[a-z][a-z0-9-]*$/` | `ok:false` | `插件名须为小写字母开头，仅 [a-z0-9-]` |
| 目标目录已存在 | `ok:false` | `目录已存在: <dir>` |
| spec 含对象级 `required: [...]` 数组 | `ok:false` | `…对象级 required 数组…不被 DSH 工具 schema DSL 支持…` |
| `tsc` 不可定位 | `ok:true, built:false` | `无法定位 tsc（配置 tscPath 或在 forge 依赖中安装 typescript）` |
| 构建失败 | `ok:true, built:false` | `buildOutput` 回传（尾部 500 字符） |
| 其余写盘异常 | `ok:false` | `生成失败: <err>` |

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

**21 例离线测试**（21/21 通过）：

- 正常路径：spec → 7 件产物齐全、`pluginId` 约定（`dsh-x-y` → `agent-x-y`）、`Config` 生成、`inject` 自动前置 `tools`；
- 失败/退化路径：非法包名、目标目录已存在、对象级 `required` 数组被拒（**这条是 2026-09-01 崩宿主教训的回归**）；
- 纯函数确定性：同 spec 两次 `buildSource` / `buildFiles` 结果逐字相等（无 IO、无时钟依赖）；
- 生成物自带回归：写临时目录后跑生成物的 `tests/smoke.test.mjs` → 5 pass；
- **尸体测试**：删掉生成物的 `docs/semantic.md` → 生成物测试必须转红（守卫非空断言）。

**无需网络、无需真实外部依赖**；需要本机有 `typescript`（走自身 `node_modules` 或 `tscPath`）。**离线单测不需要已挂载的 web 实例**。

## 设计要点

- **DSL 净化是硬约束**：DSH 的工具 schema DSL **只接受字段级 `required: true`**，不接受对象级 `required: [...]` 数组。spec 里出现后者时生成器**显式拒绝**（而不是静默剥除）——静默剥除会让作者以为写了，再在产物上手工补回标准 JSON Schema 数组，于是造出运行期违规：插件加载崩、web boot 崩。
- **不覆盖是安全设计**：目标目录存在即 `ok:false`。代价是重生成要手删，收益是生成器永远不会吃掉你手改过的产物。
- **`ensureDeps` 走 junction 兜底**：生成目录没有 `node_modules/@deepseek-ai/cordis` 时，symlink 本插件的 `node_modules` 过去，使新插件**离线即可构建**；正式依赖安装仍归挂载链。
- **生成物自带语义文档骨架与冒烟测试**：骨架解决 D4（缺节），内容留给人（状态标 `draft`）；冒烟测试立刻检查文档存在——把「文档不在不算开工」变成生成即满足的结构不变量。
- **只写自己创建的目录**：写盘失败会留半成品目录（同名重生成会被 I1 拒），当前**不自动清理**（是否 `rmSync` 见 §10 U5）；本插件不触碰该目录之外的任何路径。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语、概念模型、契约（生成物形状 + 状态→裁决表 + 调用点清单）、可证伪验收清单（A1–A14）、未决问题（U1–U6） |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `plugin-forge-design` / `dsh-plugin-development` / `plugin-maintainability` | 插件快速创建方法论、插件开发契约、可维护性工程 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
