#!/usr/bin/env node

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const HOST = "127.0.0.1";
const PORT = 3846;
const TOKEN = process.env.FIGMA_BRIDGE_TOKEN || randomBytes(18).toString("base64url");
const COMMAND_TIMEOUT_MS = Number(process.env.FIGMA_BRIDGE_TIMEOUT_MS || 30000);
const MAX_BODY_BYTES = 25 * 1024 * 1024;

const queuedCommands = [];
const pendingCommands = new Map();
let pluginState = {
  lastSeen: 0,
  fileName: null,
  pageName: null,
  selection: [],
};

function log(message) {
  process.stderr.write(`[figma-local-bridge] ${message}\n`);
}

function tokenDigest(value) {
  return createHash("sha256").update(String(value)).digest();
}

function tokenMatches(value) {
  return timingSafeEqual(tokenDigest(value || ""), tokenDigest(TOKEN));
}

function pluginConnected() {
  return Date.now() - pluginState.lastSeen < 6000;
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,X-Figma-Bridge-Token",
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
  return host === `${HOST}:${PORT}` || host === `localhost:${PORT}`;
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
    sendJson(response, 200, { ok: true, pluginConnected: pluginConnected() });
    return;
  }
  if (!tokenMatches(request.headers["x-figma-bridge-token"])) {
    sendJson(response, 401, { error: "Invalid bridge token." });
    return;
  }

  try {
    if (request.url === "/v1/plugin/heartbeat" && request.method === "POST") {
      const body = await readJson(request);
      pluginState = {
        lastSeen: Date.now(),
        fileName: body.fileName || null,
        pageName: body.pageName || null,
        selection: Array.isArray(body.selection) ? body.selection.slice(0, 100) : [],
      };
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
      const pending = pendingCommands.get(commandId);
      const body = await readJson(request);
      if (!pending) {
        sendJson(response, 404, { error: "Unknown or expired command." });
        return;
      }
      clearTimeout(pending.timer);
      pendingCommands.delete(commandId);
      pending.resolve(body);
      sendJson(response, 200, { ok: true });
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function sendCommand(action, input = {}) {
  if (!pluginConnected()) {
    return Promise.reject(
      new Error(
        `Figma plugin is not connected. Open the local plugin, use http://${HOST}:${PORT}, and enter bridge token: ${TOKEN}`,
      ),
    );
  }

  const id = randomUUID();
  queuedCommands.push({ id, action, input });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      const queueIndex = queuedCommands.findIndex((item) => item.id === id);
      if (queueIndex >= 0) queuedCommands.splice(queueIndex, 1);
      reject(new Error(`Figma command timed out after ${COMMAND_TIMEOUT_MS}ms.`));
    }, COMMAND_TIMEOUT_MS);
    pendingCommands.set(id, { resolve, reject, timer });
  });
}

function toolResult(value) {
  if (!value.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: value.error || "Figma plugin command failed." }],
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(value.data, null, 2) }],
  };
}

function toolError(error) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}

const traversalSchema = {
  includeChildren: z.boolean().default(true).describe("Include descendant nodes."),
  includeInvisible: z.boolean().default(false).describe("Include invisible children."),
  maxDepth: z.number().int().min(0).max(20).default(8),
  maxNodes: z.number().int().min(1).max(10000).default(2000),
};

const mcp = new McpServer(
  { name: "figma-local-agent-bridge", version: "1.0.0" },
  {
    instructions:
      "This server reads the Figma file currently open in the local development plugin. Call figma_bridge_status first. All tools are read-only and require the plugin window to remain open.",
  },
);

mcp.registerTool(
  "figma_bridge_status",
  {
    description: "Check whether the local Figma plugin is connected and show setup details.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            connected: pluginConnected(),
            bridgeUrl: `http://${HOST}:${PORT}`,
            bridgeToken: TOKEN,
            fileName: pluginState.fileName,
            pageName: pluginState.pageName,
            selection: pluginState.selection,
          },
          null,
          2,
        ),
      },
    ],
  }),
);

mcp.registerTool(
  "figma_get_selection",
  {
    description: "Read the selected Figma nodes and return structured JSON.",
    inputSchema: z.object(traversalSchema),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (input) => {
    try {
      return toolResult(await sendCommand("get_selection", input));
    } catch (error) {
      return toolError(error);
    }
  },
);

mcp.registerTool(
  "figma_get_node",
  {
    description: "Read a Figma node by node ID and return structured JSON.",
    inputSchema: z.object({ nodeId: z.string().min(1), ...traversalSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (input) => {
    try {
      return toolResult(await sendCommand("get_node", input));
    } catch (error) {
      return toolError(error);
    }
  },
);

mcp.registerTool(
  "figma_list_pages",
  {
    description: "List pages in the currently open Figma file.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    try {
      return toolResult(await sendCommand("list_pages"));
    } catch (error) {
      return toolError(error);
    }
  },
);

mcp.registerTool(
  "figma_get_local_variables",
  {
    description: "Read local variable collections and values from the open Figma file.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    try {
      return toolResult(await sendCommand("get_variables"));
    } catch (error) {
      return toolError(error);
    }
  },
);

const bridgeHttpServer = http.createServer(httpHandler);
bridgeHttpServer.listen(PORT, HOST, () => {
  log(`HTTP bridge listening at http://${HOST}:${PORT}`);
  log(`Bridge token: ${TOKEN}`);
});

const transport = new StdioServerTransport();
await mcp.connect(transport);

function shutdown() {
  for (const pending of pendingCommands.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("Bridge server stopped."));
  }
  pendingCommands.clear();
  bridgeHttpServer.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
