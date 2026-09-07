# dsh-plugin-forge

插件创建插件：声明式 spec → 完整可构建的 DSH 插件项目。工具 DSL 正确性由生成器保证，消除手写 defineTool 的 TS 类型错误与括号配对错误；高自由度（inject/imports/render/任意 execute 逻辑/自定义 Config）。

## 工具

- `plugin_forge`：生成插件项目（src/index.ts + package.json + tsconfig + cordis.patch.yml + README），生成后自动 tsc 构建验证。

## 用法（spec JSON）

```json
{
  "name": "my-tool",              // 或 dsh-my-tool，自动补前缀
  "description": "一句话用途",
  "inject": ["tools"],
  "config": { "apiKey": { "type": "string", "default": "" } },
  "tools": [
    {
      "name": "my_tool",
      "description": "工具用途",
      "parameters": { "path": { "type": "string", "required": true } },
      "outputSchema": { "type": "object", "properties": { "ok": { "type": "boolean", "required": true } } },
      "render": "v => v.ok ? '成功' : '失败'",
      "execute": "return { ok: true }"
    }
  ]
}
```

生成目录：`selfPluginsDir/<name>`（配置 selfPluginsDir，默认 DSH_HOME/self-plugins）。

## 构建与挂载

```sh
pnpm build
# 挂载到 web profile（plugin_mount 或 dsh plugin-manager）
```
