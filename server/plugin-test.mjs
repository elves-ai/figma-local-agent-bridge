import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const pluginSource = await readFile(
  fileURLToPath(new URL("../plugin/code.js", import.meta.url)),
  "utf8",
);
const pngBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const svgSource =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 12h16"/></svg>';
const svgBytes = new Uint8Array(Buffer.from(svgSource, "utf8"));
const messages = [];
let exportSettings = null;
const exportableNode = {
  id: "1:2",
  name: "Preview",
  type: "FRAME",
  width: 266,
  height: 266,
  async exportAsync(settings) {
    exportSettings = settings;
    return settings.format === "SVG" ? svgBytes : pngBytes;
  },
};
const image = {
  async getBytesAsync() {
    return pngBytes;
  },
  async getSizeAsync() {
    return { width: 1024, height: 1024 };
  },
};
const eventHandlers = new Map();
const figma = {
  mixed: Symbol("mixed"),
  fileKey: undefined,
  showUI() {},
  base64Encode(bytes) {
    return Buffer.from(bytes).toString("base64");
  },
  async getNodeByIdAsync(nodeId) {
    return nodeId === exportableNode.id ? exportableNode : null;
  },
  getImageByHash(imageHash) {
    return imageHash === "image-hash" ? image : null;
  },
  root: {
    name: "Plugin Test",
    children: [],
  },
  currentPage: {
    id: "0:1",
    name: "Page 1",
    selection: [],
  },
  variables: {
    async getLocalVariableCollectionsAsync() {
      return [];
    },
    async getVariableByIdAsync() {
      return null;
    },
  },
  ui: {
    onmessage: null,
    postMessage(message) {
      messages.push(message);
    },
  },
  on(eventName, handler) {
    eventHandlers.set(eventName, handler);
  },
};

vm.runInNewContext(pluginSource, {
  __html__: "",
  Buffer,
  console,
  figma,
  Set,
  Uint8Array,
});

assert.equal(typeof figma.ui.onmessage, "function");
assert.equal(typeof eventHandlers.get("selectionchange"), "function");

await figma.ui.onmessage({
  type: "bridge-command",
  command: {
    id: "export-command",
    action: "export_node",
    input: { nodeId: "1:2", format: "PNG", scale: 1 },
  },
});
const exportResult = messages.at(-1);
assert.equal(exportResult.commandId, "export-command");
assert.equal(exportResult.ok, true);
assert.equal(exportResult.data.kind, "node-render");
assert.equal(exportResult.data.mimeType, "image/png");
assert.equal(exportResult.data.sourceSize.width, 266);
assert.equal(exportResult.data.byteLength, pngBytes.length);
assert.equal(exportResult.data.base64, Buffer.from(pngBytes).toString("base64"));
assert.equal(exportSettings.format, "PNG");
assert.equal(exportSettings.constraint.type, "SCALE");
assert.equal(exportSettings.constraint.value, 1);

await figma.ui.onmessage({
  type: "bridge-command",
  command: {
    id: "svg-export-command",
    action: "export_node",
    input: {
      nodeId: "1:2",
      format: "SVG",
      scale: 4,
      svgOutlineText: false,
      svgIdAttribute: true,
      svgSimplifyStroke: false,
    },
  },
});
const svgExportResult = messages.at(-1);
assert.equal(svgExportResult.commandId, "svg-export-command");
assert.equal(svgExportResult.ok, true);
assert.equal(svgExportResult.data.kind, "node-render");
assert.equal(svgExportResult.data.format, "SVG");
assert.equal(svgExportResult.data.mimeType, "image/svg+xml");
assert.equal(svgExportResult.data.byteLength, svgBytes.length);
assert.equal(svgExportResult.data.base64, Buffer.from(svgBytes).toString("base64"));
assert.equal("scale" in svgExportResult.data, false);
assert.equal(exportSettings.format, "SVG");
assert.equal("constraint" in exportSettings, false);
assert.equal(exportSettings.svgOutlineText, false);
assert.equal(exportSettings.svgIdAttribute, true);
assert.equal(exportSettings.svgSimplifyStroke, false);

await figma.ui.onmessage({
  type: "bridge-command",
  command: {
    id: "image-command",
    action: "get_image",
    input: { imageHash: "image-hash" },
  },
});
const imageResult = messages.at(-1);
assert.equal(imageResult.commandId, "image-command");
assert.equal(imageResult.ok, true);
assert.equal(imageResult.data.kind, "original-image");
assert.equal(imageResult.data.mimeType, "image/png");
assert.equal(imageResult.data.width, 1024);
assert.equal(imageResult.data.height, 1024);
assert.equal(imageResult.data.byteLength, pngBytes.length);
assert.equal(imageResult.data.base64, Buffer.from(pngBytes).toString("base64"));

process.stdout.write("Figma plugin asset export test passed.\n");
