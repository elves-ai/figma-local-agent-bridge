#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import http from "node:http";
import process from "node:process";

const HOST = process.env.FIGMA_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.FIGMA_BRIDGE_PORT || 13846);
const COMMAND_TIMEOUT_MS = Number(process.env.FIGMA_BRIDGE_TIMEOUT_MS || 30000);
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const SERVICE_NAME = "figma-local-agent-bridge";
const SERVICE_VERSION = "1.2.0";

const queuedCommands = [];
const pendingCommands = new Map();
let pluginState = emptyPluginState();
let shuttingDown = false;

function emptyPluginState() {
  return {
    lastSeen: 0,
    clientId: null,
    fileName: null,
    pageName: null,
    selection: [],
  };
}

function log(message) {
  process.stderr.write(`[figma-local-bridge] ${message}\n`);
}

function pluginConnected() {
  return Date.now() - pluginState.lastSeen < 6000;
}

function removeQueuedCommand(commandId) {
  const queueIndex = queuedCommands.findIndex((item) => item.id === commandId);
  if (queueIndex >= 0) queuedCommands.splice(queueIndex, 1);
}

function finishPending(commandId, status, value) {
  const pending = pendingCommands.get(commandId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingCommands.delete(commandId);
  removeQueuedCommand(commandId);
  if (!pending.response.writableEnded) {
    sendJson(pending.response, status, value);
  }
  return true;
}

function disconnectPlugin(reason) {
  pluginState = emptyPluginState();
  queuedCommands.length = 0;
  for (const commandId of [...pendingCommands.keys()]) {
    finishPending(commandId, 409, { ok: false, error: reason });
  }
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type",
  );
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response, status, value) {
  setCors(response);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function validateHost(request) {
  const host = request.headers.host || "";
  return (
    host === `${HOST}:${PORT}` ||
    host === `localhost:${PORT}` ||
    host === `127.0.0.1:${PORT}`
  );
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (_error) {
        reject(new Error("Invalid JSON request body."));
      }
    });
    request.on("error", reject);
  });
}

function statusPayload() {
  const connected = pluginConnected();
  return {
    ok: true,
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    pluginConnected: connected,
    fileName: connected ? pluginState.fileName : null,
    pageName: connected ? pluginState.pageName : null,
    selection: connected ? pluginState.selection : [],
  };
}

function queueAgentCommand(request, response, body) {
  if (!pluginConnected()) {
    sendJson(response, 409, {
      ok: false,
      error:
        "Figma plugin is not connected. Open the local plugin and click Connect.",
    });
    return;
  }
  if (typeof body.action !== "string" || !body.action) {
    sendJson(response, 400, { ok: false, error: "A command action is required." });
    return;
  }

  const id = randomUUID();
  queuedCommands.push({
    id,
    action: body.action,
    input: body.input && typeof body.input === "object" ? body.input : {},
  });

  const timer = setTimeout(() => {
    finishPending(id, 504, {
      ok: false,
      error: `Figma command timed out after ${COMMAND_TIMEOUT_MS}ms.`,
    });
  }, COMMAND_TIMEOUT_MS);
  pendingCommands.set(id, { response, timer });

  response.on("close", () => {
    if (response.writableEnded) return;
    clearTimeout(timer);
    pendingCommands.delete(id);
    removeQueuedCommand(id);
  });
}

async function httpHandler(request, response) {
  setCors(response);
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (!validateHost(request)) {
    sendJson(response, 403, { error: "Invalid Host header." });
    return;
  }

  if (request.url === "/health" && request.method === "GET") {
    sendJson(response, 200, statusPayload());
    return;
  }

  try {
    if (request.url === "/v1/plugin/heartbeat" && request.method === "POST") {
      const body = await readJson(request);
      const clientId = typeof body.clientId === "string" ? body.clientId : null;
      if (
        pluginConnected() &&
        pluginState.clientId &&
        clientId &&
        pluginState.clientId !== clientId
      ) {
        disconnectPlugin("Another Figma plugin window connected.");
      }
      pluginState = {
        lastSeen: Date.now(),
        clientId,
        fileName: body.fileName || null,
        pageName: body.pageName || null,
        selection: Array.isArray(body.selection) ? body.selection.slice(0, 100) : [],
      };
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.url === "/v1/plugin/disconnect" && request.method === "POST") {
      const body = await readJson(request);
      if (!body.clientId || body.clientId === pluginState.clientId) {
        disconnectPlugin("Figma plugin was disconnected by the user.");
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.url === "/v1/commands/next" && request.method === "GET") {
      const command = queuedCommands.shift();
      if (!command) {
        response.writeHead(204);
        response.end();
        return;
      }
      sendJson(response, 200, command);
      return;
    }

    const resultMatch = request.url?.match(/^\/v1\/commands\/([^/]+)\/result$/);
    if (resultMatch && request.method === "POST") {
      const commandId = decodeURIComponent(resultMatch[1]);
      const body = await readJson(request);
      if (!finishPending(commandId, 200, body)) {
        sendJson(response, 404, { error: "Unknown or expired command." });
        return;
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.url === "/v1/agent/commands" && request.method === "POST") {
      const body = await readJson(request);
      queueAgentCommand(request, response, body);
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const bridgeHttpServer = http.createServer(httpHandler);
bridgeHttpServer.listen(PORT, HOST, () => {
  log(`HTTP bridge listening at http://${HOST}:${PORT}`);
});
bridgeHttpServer.on("error", (error) => {
  log(
    error?.code === "EADDRINUSE"
      ? `Port ${PORT} is already in use.`
      : `HTTP bridge failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});

function shutdown(reason = "Bridge service stopped.") {
  if (shuttingDown) return;
  shuttingDown = true;
  disconnectPlugin(reason);
  if (!bridgeHttpServer.listening) {
    process.exit();
    return;
  }
  bridgeHttpServer.close(() => process.exit());
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
