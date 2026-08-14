import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlC6ZkAAAAASUVORK5CYII=";
const SVG_SOURCE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 12h16"/></svg>';
const SVG_BASE64 = Buffer.from(SVG_SOURCE, "utf8").toString("base64");

async function getFreePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert(address && typeof address === "object");
  await new Promise((resolve) => probe.close(resolve));
  return address.port;
}

async function waitForHealth(url) {
  const deadline = Date.now() + 5000;
  do {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch (_error) {
      // The daemon may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for the bridge daemon.");
}

async function waitForCommand(url) {
  const deadline = Date.now() + 3000;
  do {
    const response = await fetch(`${url}/v1/commands/next`);
    if (response.status === 200) return response.json();
    assert.equal(response.status, 204);
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for an MCP command.");
}

const port = await getFreePort();
const bridgeUrl = `http://127.0.0.1:${port}`;
const daemon = spawn(
  process.execPath,
  [fileURLToPath(new URL("./bridge.mjs", import.meta.url))],
  {
    env: {
      ...process.env,
      FIGMA_BRIDGE_PORT: String(port),
      FIGMA_BRIDGE_TIMEOUT_MS: "3000",
      FIGMA_PLUGIN_STALE_AFTER_MS: "30000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let daemonLogs = "";
daemon.stdout.on("data", (chunk) => {
  daemonLogs += chunk;
});
daemon.stderr.on("data", (chunk) => {
  daemonLogs += chunk;
});

const client = new Client({ name: "figma-bridge-smoke-test", version: "1.3.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./server.mjs", import.meta.url))],
  env: {
    ...process.env,
    FIGMA_BRIDGE_URL: bridgeUrl,
    FIGMA_BRIDGE_TIMEOUT_MS: "3000",
  },
  stderr: "inherit",
});

try {
  await waitForHealth(bridgeUrl);
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "figma_bridge_status",
    "figma_export_node",
    "figma_get_image",
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
  assert.equal(status.serviceRunning, true);
  assert.equal(status.connected, false);
  assert.equal(status.bridgeUrl, bridgeUrl);
  assert.equal(status.heartbeatAgeMs, null);
  assert.equal(status.staleAfterMs, 30000);

  const healthResponse = await fetch(`${bridgeUrl}/health`);
  assert.equal(healthResponse.status, 200);
  const initialHealth = await healthResponse.json();
  assert.equal(initialHealth.ok, true);
  assert.equal(initialHealth.service, "figma-local-agent-bridge");
  assert.equal(initialHealth.version, "1.3.1");
  assert.equal(initialHealth.pluginConnected, false);
  assert.equal(initialHealth.heartbeatAgeMs, null);
  assert.equal(initialHealth.staleAfterMs, 30000);

  const heartbeatResponse = await fetch(
    `${bridgeUrl}/v1/plugin/heartbeat`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "smoke-test-plugin",
        fileName: "Smoke Test",
        pageName: "Page 1",
        selection: [],
      }),
    },
  );
  assert.equal(heartbeatResponse.status, 200);

  const connectedStatus = await client.callTool({
    name: "figma_bridge_status",
    arguments: {},
  });
  const connectedStatusBody = JSON.parse(connectedStatus.content[0].text);
  assert.equal(connectedStatusBody.connected, true);
  assert.equal(connectedStatusBody.staleAfterMs, 30000);
  assert.equal(connectedStatusBody.heartbeatAgeMs >= 0, true);
  assert.equal(connectedStatusBody.heartbeatAgeMs < 30000, true);

  const listPagesPromise = client.callTool({
    name: "figma_list_pages",
    arguments: {},
  });
  const command = await waitForCommand(bridgeUrl);
  assert.equal(command.action, "list_pages");
  const commandResultResponse = await fetch(
    `${bridgeUrl}/v1/commands/${encodeURIComponent(command.id)}/result`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ok: true,
        data: { currentPageId: "0:1", pages: [{ id: "0:1", name: "Page 1" }] },
      }),
    },
  );
  assert.equal(commandResultResponse.status, 200);
  const listPagesResult = await listPagesPromise;
  assert.equal(listPagesResult.isError, undefined);
  assert.equal(
    JSON.parse(listPagesResult.content[0].text).pages[0].name,
    "Page 1",
  );

  const exportNodePromise = client.callTool({
    name: "figma_export_node",
    arguments: { nodeId: "1:2", format: "PNG", scale: 1 },
  });
  const exportNodeCommand = await waitForCommand(bridgeUrl);
  assert.equal(exportNodeCommand.action, "export_node");
  assert.deepEqual(exportNodeCommand.input, {
    nodeId: "1:2",
    format: "PNG",
    scale: 1,
  });
  const exportNodeResponse = await fetch(
    `${bridgeUrl}/v1/commands/${encodeURIComponent(exportNodeCommand.id)}/result`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ok: true,
        data: {
          schemaVersion: "1.0.0",
          kind: "node-render",
          node: { id: "1:2", name: "Preview", type: "FRAME" },
          format: "PNG",
          scale: 1,
          mimeType: "image/png",
          sourceSize: { width: 1, height: 1 },
          byteLength: Buffer.byteLength(ONE_PIXEL_PNG, "base64"),
          base64: ONE_PIXEL_PNG,
        },
      }),
    },
  );
  assert.equal(exportNodeResponse.status, 200);
  const exportNodeResult = await exportNodePromise;
  assert.equal(exportNodeResult.isError, undefined);
  assert.equal(exportNodeResult.content[0].type, "text");
  assert.equal(exportNodeResult.content[1].type, "image");
  assert.equal(exportNodeResult.content[1].mimeType, "image/png");
  assert.equal(exportNodeResult.content[1].data, ONE_PIXEL_PNG);
  assert.equal(
    JSON.parse(exportNodeResult.content[0].text).kind,
    "node-render",
  );

  const exportSvgPromise = client.callTool({
    name: "figma_export_node",
    arguments: {
      nodeId: "1:2",
      format: "SVG",
      svgOutlineText: false,
      svgIdAttribute: true,
      svgSimplifyStroke: false,
    },
  });
  const exportSvgCommand = await waitForCommand(bridgeUrl);
  assert.equal(exportSvgCommand.action, "export_node");
  assert.deepEqual(exportSvgCommand.input, {
    nodeId: "1:2",
    format: "SVG",
    scale: 1,
    svgOutlineText: false,
    svgIdAttribute: true,
    svgSimplifyStroke: false,
  });
  const exportSvgResponse = await fetch(
    `${bridgeUrl}/v1/commands/${encodeURIComponent(exportSvgCommand.id)}/result`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ok: true,
        data: {
          schemaVersion: "1.0.0",
          kind: "node-render",
          node: { id: "1:2", name: "Icon", type: "VECTOR" },
          format: "SVG",
          svgOptions: {
            svgOutlineText: false,
            svgIdAttribute: true,
            svgSimplifyStroke: false,
          },
          mimeType: "image/svg+xml",
          sourceSize: { width: 24, height: 24 },
          byteLength: Buffer.byteLength(SVG_SOURCE, "utf8"),
          base64: SVG_BASE64,
        },
      }),
    },
  );
  assert.equal(exportSvgResponse.status, 200);
  const exportSvgResult = await exportSvgPromise;
  assert.equal(exportSvgResult.isError, undefined);
  assert.equal(exportSvgResult.content[0].type, "text");
  assert.equal(exportSvgResult.content[1].type, "resource");
  assert.equal(exportSvgResult.content[1].resource.uri, "figma://node/1%3A2.svg");
  assert.equal(exportSvgResult.content[1].resource.mimeType, "image/svg+xml");
  assert.equal(exportSvgResult.content[1].resource.text, SVG_SOURCE);
  assert.equal(
    JSON.parse(exportSvgResult.content[0].text).format,
    "SVG",
  );

  const getImagePromise = client.callTool({
    name: "figma_get_image",
    arguments: { imageHash: "smoke-test-image-hash" },
  });
  const getImageCommand = await waitForCommand(bridgeUrl);
  assert.equal(getImageCommand.action, "get_image");
  assert.deepEqual(getImageCommand.input, {
    imageHash: "smoke-test-image-hash",
  });
  const getImageResponse = await fetch(
    `${bridgeUrl}/v1/commands/${encodeURIComponent(getImageCommand.id)}/result`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ok: true,
        data: {
          schemaVersion: "1.0.0",
          kind: "original-image",
          imageHash: "smoke-test-image-hash",
          mimeType: "image/png",
          width: 1,
          height: 1,
          byteLength: Buffer.byteLength(ONE_PIXEL_PNG, "base64"),
          base64: ONE_PIXEL_PNG,
        },
      }),
    },
  );
  assert.equal(getImageResponse.status, 200);
  const getImageResult = await getImagePromise;
  assert.equal(getImageResult.isError, undefined);
  assert.equal(getImageResult.content[1].type, "image");
  assert.equal(getImageResult.content[1].mimeType, "image/png");
  assert.equal(getImageResult.content[1].data, ONE_PIXEL_PNG);
  assert.equal(
    JSON.parse(getImageResult.content[0].text).kind,
    "original-image",
  );

  const staleDisconnectResponse = await fetch(
    `${bridgeUrl}/v1/plugin/disconnect`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "older-plugin-window" }),
    },
  );
  assert.equal(staleDisconnectResponse.status, 200);
  const stillConnectedHealth = await fetch(`${bridgeUrl}/health`);
  assert.equal((await stillConnectedHealth.json()).pluginConnected, true);

  const disconnectResponse = await fetch(
    `${bridgeUrl}/v1/plugin/disconnect`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "smoke-test-plugin" }),
    },
  );
  assert.equal(disconnectResponse.status, 200);

  const nextCommandResponse = await fetch(`${bridgeUrl}/v1/commands/next`);
  assert.equal(nextCommandResponse.status, 204);

  const offlineRead = await client.callTool({
    name: "figma_get_selection",
    arguments: {},
  });
  assert.equal(offlineRead.isError, true);
  assert.match(offlineRead.content[0].text, /not connected/i);

  process.stdout.write("Foreground bridge MCP smoke test passed.\n");
} finally {
  await client.close().catch(() => {});
  if (daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await new Promise((resolve) => daemon.once("exit", resolve));
  }
  if (daemon.exitCode && daemonLogs) process.stderr.write(daemonLogs);
}
