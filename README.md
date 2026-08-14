# Figma Local Agent Bridge

一个免费、只读、完全本地的 Figma Plugin API → MCP 桥接器。它不调用 Figma REST API，因此不消耗 `GET file nodes` 的月度额度。

## 能做什么

- 读取当前选中节点的层级、布局、文字、样式、变量绑定和组件信息。
- 按节点 ID 读取节点。
- 列出页面。
- 读取本地变量集合。
- 使用 Figma 原生渲染器按节点导出 PNG/JPG/SVG。
- 按 `imageHash` 提取图片填充中的原始 PNG/JPEG/GIF/WebP。
- 让任何支持 MCP stdio 的 Agent 调用，包括 Codex、Claude Code 和 Cursor。

当前版本刻意保持只读：Agent 不能执行任意 JavaScript，也不能修改或删除设计节点。图片导出只读取并传输现有内容。

## 一、安装依赖并启动 bridge

```bash
cd /home/yangzhe/work/figma-local-agent-bridge/server
npm install
npm start
```

需要 Node.js 20 或更高版本。

MCP 服务和依赖应位于同一个原生文件系统中。Windows Node 直接从 WSL 的 UNC 路径加载大量 npm 模块可能很慢；这种情况下请在 WSL 内安装 Node，或把 `server/` 复制到 Windows 本地目录后运行 `npm install`。

`npm start` 会在当前终端前台运行独立的 HTTP bridge。保持该终端打开；需要停止服务时按 `Ctrl+C`。

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

1. 在 `server/` 目录运行 `npm start`，确认终端显示 bridge 正在监听 `127.0.0.1:13846`。
2. 打开 Figma 插件。插件初始状态为“未连接”，不会自动发起连接。
3. 点击“连接”；插件固定连接 `http://localhost:13846`。
4. 让 Agent 调用 `figma_bridge_status`，应看到 `serviceRunning: true` 和 `connected: true`。

插件只会在点击“连接”后建立连接。点击“断开”或网络中断后，它会保持未连接并展示状态，不会自动重连；需要时再次手动点击“连接”。

Codex 会根据 `[mcp_servers.figmaLocal]` 配置为每个任务拉起短生命周期的 MCP stdio 适配器。HTTP bridge 则由 `npm start` 在单独终端中前台运行，两者生命周期互不影响。

随后 Agent 可以调用：

- `figma_get_selection`
- `figma_get_node`
- `figma_list_pages`
- `figma_get_local_variables`
- `figma_export_node`
- `figma_get_image`

## 图片导出

`figma_export_node` 使用 Figma 原生渲染器导出节点。参数：

- `nodeId`：必填，Figma 节点 ID。
- `format`：`PNG`（默认）、`JPG` 或 `SVG`。
- `scale`：仅用于 PNG/JPG，默认 `1`，范围 `0.01..4`。例如 266 × 266 的节点按 `scale: 1` 导出为 1× 像素结果，按 `scale: 2` 导出为 2×。
- `svgOutlineText`：仅用于 SVG，是否将文字转为矢量轮廓，默认 `true`。
- `svgIdAttribute`：仅用于 SVG，是否使用图层名称生成 `id` 属性，默认 `false`。
- `svgSimplifyStroke`：仅用于 SVG，是否简化内描边和外描边，默认 `true`。

PNG/JPG 返回 JSON 元数据和 MCP 图片内容块；SVG 返回 JSON 元数据和一个 MIME 类型为 `image/svg+xml` 的嵌入文本资源，Agent 可以读取源码并按需保存成 `.svg` 文件。SVG 导出不会使用 `scale`，并保留 Figma 生成的完整矢量标记。

`figma_get_image` 按 `imageHash` 返回图片填充中存储的原始编码文件和原始像素尺寸。它不会应用节点上的裁剪、旋转、滤镜、蒙层或混合效果。

为了避免 Base64 传输超过本地 HTTP bridge 的请求上限，单个导出资源的原始编码数据最多为 16 MiB。

## 多 Agent 使用

每个 Agent 都可以配置同一个 `server.mjs`。所有 MCP 适配器共享本机 `localhost:13846` 上的前台 bridge，不再互相争抢监听端口。Figma 插件仍一次只连接一个 bridge，来自多个 Agent 的只读命令会进入同一队列。

## 安全模型

- 服务只监听 `127.0.0.1`，不会暴露到局域网。
- 校验 `Host` 头，降低 DNS rebinding 风险。
- Agent 只能调用白名单只读命令。
- 单次请求最多读取 10,000 个节点，默认 2,000 个。
- 单个导出资源最多 16 MiB，PNG/JPG 节点导出缩放范围为 `0.01..4`。
- 插件只允许访问 `http://localhost:13846`。

设计文件内容会发送给本机已连接的 Agent，因此仅应连接你信任的 Agent。
