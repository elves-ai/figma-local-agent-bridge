import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import process from "node:process";
import { fileURLToPath } from "node:url";

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

async function waitForHealth(url, predicate = () => true) {
  const deadline = Date.now() + 2000;
  do {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) {
        const body = await response.json();
        if (predicate(body)) return body;
      }
    } catch (_error) {
      // The bridge may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for the expected bridge health state.");
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
      FIGMA_PLUGIN_STALE_AFTER_MS: "80",
    },
    stdio: ["ignore", "ignore", "pipe"],
  },
);
let daemonLogs = "";
daemon.stderr.on("data", (chunk) => {
  daemonLogs += chunk;
});

try {
  const initialHealth = await waitForHealth(bridgeUrl);
  assert.equal(initialHealth.pluginConnected, false);
  assert.equal(initialHealth.heartbeatAgeMs, null);
  assert.equal(initialHealth.staleAfterMs, 80);

  const heartbeatResponse = await fetch(`${bridgeUrl}/v1/plugin/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: "heartbeat-test-plugin",
      fileName: "Heartbeat Test",
      pageName: "Page 1",
      selection: [],
    }),
  });
  assert.equal(heartbeatResponse.status, 200);

  const connectedHealth = await waitForHealth(
    bridgeUrl,
    (body) => body.pluginConnected === true,
  );
  assert.equal(connectedHealth.fileName, "Heartbeat Test");
  assert.equal(connectedHealth.heartbeatAgeMs < 80, true);

  const staleHealth = await waitForHealth(
    bridgeUrl,
    (body) => body.pluginConnected === false && body.heartbeatAgeMs >= 80,
  );
  assert.equal(staleHealth.fileName, null);
  assert.equal(staleHealth.staleAfterMs, 80);

  process.stdout.write("Figma plugin heartbeat expiry test passed.\n");
} finally {
  if (daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await new Promise((resolve) => daemon.once("exit", resolve));
  }
  if (daemon.exitCode && daemonLogs) process.stderr.write(daemonLogs);
}
