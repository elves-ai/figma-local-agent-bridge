#!/usr/bin/env node

import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BRIDGE_URL = (
  process.env.FIGMA_BRIDGE_URL || "http://localhost:3846"
).replace(/\/$/, "");
const COMMAND_TIMEOUT_MS = Number(process.env.FIGMA_BRIDGE_TIMEOUT_MS || 30000);

async function bridgeRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(`${BRIDGE_URL}${path}`, {
      ...options,
      signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS + 2000),
    });
  } catch (error) {
    throw new Error(
      `Local bridge service is not running at ${BRIDGE_URL}. Start it with "npm start" in the server directory.`,
      { cause: error },
    );
  }

  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch (_error) {
    throw new Error(`Local bridge returned invalid JSON (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(body.error || `Local bridge HTTP ${response.status}.`);
  }
  return body;
}

async function bridgeStatus() {
  try {
    const status = await bridgeRequest("/health");
    return {
      serviceRunning: true,
      connected: status.pluginConnected === true,
      bridgeUrl: BRIDGE_URL,
      fileName: status.fileName || null,
      pageName: status.pageName || null,
      selection: Array.isArray(status.selection) ? status.selection : [],
    };
  } catch (error) {
    return {
      serviceRunning: false,
      connected: false,
      bridgeUrl: BRIDGE_URL,
      fileName: null,
      pageName: null,
      selection: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function sendCommand(action, input = {}) {
  return bridgeRequest("/v1/agent/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, input }),
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

function imageToolResult(value) {
  if (!value.ok) return toolResult(value);
  const data = value.data || {};
  if (
    typeof data.base64 !== "string" ||
    !data.base64 ||
    typeof data.mimeType !== "string" ||
    !data.mimeType.startsWith("image/")
  ) {
    return {
      isError: true,
      content: [{ type: "text", text: "Figma plugin returned invalid image data." }],
    };
  }
  const { base64, ...metadata } = data;
  return {
    content: [
      { type: "text", text: JSON.stringify(metadata, null, 2) },
      { type: "image", data: base64, mimeType: data.mimeType },
    ],
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
  { name: "figma-local-agent-bridge", version: "1.2.0" },
  {
    instructions:
      "This server reads and exports from the Figma file connected to the local foreground bridge. Call figma_bridge_status first. All tools are read-only.",
  },
);

mcp.registerTool(
  "figma_bridge_status",
  {
    description:
      "Check whether the local foreground bridge service and Figma plugin are connected.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(await bridgeStatus(), null, 2),
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

mcp.registerTool(
  "figma_export_node",
  {
    description:
      "Export a Figma node with Figma's native renderer and return the image plus metadata.",
    inputSchema: z.object({
      nodeId: z.string().min(1),
      format: z.enum(["PNG", "JPG"]).default("PNG"),
      scale: z.number().min(0.01).max(4).default(1),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (input) => {
    try {
      return imageToolResult(await sendCommand("export_node", input));
    } catch (error) {
      return toolError(error);
    }
  },
);

mcp.registerTool(
  "figma_get_image",
  {
    description:
      "Read the original encoded image bytes for a Figma image fill by imageHash.",
    inputSchema: z.object({ imageHash: z.string().min(1) }),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (input) => {
    try {
      return imageToolResult(await sendCommand("get_image", input));
    } catch (error) {
      return toolError(error);
    }
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
