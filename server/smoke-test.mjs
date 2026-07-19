import assert from "node:assert/strict";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "figma-bridge-smoke-test", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./server.mjs", import.meta.url))],
  env: process.env,
  stderr: "inherit",
});

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "figma_bridge_status",
    "figma_get_local_variables",
    "figma_get_node",
    "figma_get_selection",
    "figma_list_pages",
  ]);

  const result = await client.callTool({
    name: "figma_bridge_status",
    arguments: {},
  });
  assert.equal(result.isError, undefined);
  const status = JSON.parse(result.content[0].text);
  assert.equal(status.connected, false);
  assert.equal(status.bridgeUrl, "http://localhost:3846");

  const healthResponse = await fetch("http://127.0.0.1:3846/health");
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), {
    ok: true,
    pluginConnected: false,
  });

  const nextCommandResponse = await fetch(
    "http://127.0.0.1:3846/v1/commands/next",
  );
  assert.equal(nextCommandResponse.status, 204);

  const offlineRead = await client.callTool({
    name: "figma_get_selection",
    arguments: {},
  });
  assert.equal(offlineRead.isError, true);
  assert.match(offlineRead.content[0].text, /not connected/i);

  process.stdout.write("MCP smoke test passed.\n");
} finally {
  await client.close();
}
