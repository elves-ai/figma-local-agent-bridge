# Figma Local Agent Bridge

一个免费、只读、完全本地的 Figma Plugin API → MCP 桥接器。它不调用 Figma REST API，因此不消耗 `GET file nodes` 的月度额度。

## 能做什么

- 读取当前选中节点的层级、布局、文字、样式、变量绑定和组件信息。
- 按节点 ID 读取节点。
- 列出页面。
- 读取本地变量集合。
- 让任何支持 MCP stdio 的 Agent 调用，包括 Codex、Claude Code 和 Cursor。

当前版本刻意保持只读：Agent 不能执行任意 JavaScript，也不能修改或删除设计节点。

## 一、安装依赖

```bash
cd /home/yangzhe/work/figma-local-agent-bridge/server
npm install
```

需要 Node.js 20 或更高版本。

MCP 服务和依赖应位于同一个原生文件系统中。Windows Node 直接从 WSL 的 UNC 路径加载大量 npm 模块可能很慢；这种情况下请在 WSL 内安装 Node，或把 `server/` 复制到 Windows 本地目录后运行 `npm install`。

## 二、在 Figma 中安装本地插件

1. 打开 Figma 桌面版。
2. 打开任意 Figma Design 文件。
3. 进入 `Plugins → Development → Import plugin from manifest...`。
4. 选择 `/home/yangzhe/work/figma-local-agent-bridge/plugin/manifest.json`。
5. 运行 `Figma Local Agent Bridge`，并保持插件窗口打开。

免费 Starter 账号可以在 Figma Design 中运行开发插件。

如果项目位于 WSL，Windows 文件选择器中的对应路径通常是：

```text
\\wsl.localhost\<发行版名称>\home\<用户名>\...\tools\figma-local-agent-bridge\plugin\manifest.json
```

## 三、配置 Agent

### Codex

将以下内容加入 Codex 的 MCP 配置；路径替换为本机绝对路径：

```toml
[mcp_servers.figmaLocal]
command = "node"
args = ["/absolute/path/figma-local-agent-bridge/server/server.mjs"]
startup_timeout_sec = 30
tool_timeout_sec = 60

[mcp_servers.figmaLocal.env]
FIGMA_BRIDGE_TOKEN = "replace-with-a-long-random-value"
```

### Claude Code

```bash
claude mcp add figma-local -- node /absolute/path/figma-local-agent-bridge/server/server.mjs
```

### Cursor / VS Code

```json
{
  "mcpServers": {
    "figma-local": {
      "command": "node",
      "args": [
        "/absolute/path/figma-local-agent-bridge/server/server.mjs"
      ]
    }
  }
}
```

## 四、连接插件

1. 重启或刷新 Agent 的 MCP 服务。
2. 为 MCP 服务配置固定的 `FIGMA_BRIDGE_TOKEN`，并让插件使用相同令牌。
3. 打开插件后，它会自动连接；如果 MCP 服务尚未启动，插件会持续重试。
4. 让 Agent 调用 `figma_bridge_status`，应看到 `connected: true`。

随后 Agent 可以调用：

- `figma_get_selection`
- `figma_get_node`
- `figma_list_pages`
- `figma_get_local_variables`

## 多 Agent 使用

每个 Agent 都可以配置此 MCP 服务。由于插件固定连接 `localhost:3846`，同一时间只运行一个 Agent 的桥接实例；切换 Agent 时关闭前一个实例，再启动另一个即可。

自动重连需要固定令牌。可设置：

```bash
FIGMA_BRIDGE_TOKEN="replace-with-a-long-random-value" node server.mjs
```

## 安全模型

- 服务只监听 `127.0.0.1`，不会暴露到局域网。
- 所有插件请求都必须携带本机共享令牌；为支持自动重连，该令牌应固定配置并妥善保管。
- 校验 `Host` 头，降低 DNS rebinding 风险。
- Agent 只能调用白名单只读命令。
- 单次请求最多读取 10,000 个节点，默认 2,000 个。
- 插件只允许访问 `http://localhost:3846`。

设计文件内容会发送给本机已连接的 Agent，因此仅应连接你信任的 Agent。
