figma.showUI(__html__, {
  width: 280,
  height: 52,
  themeColors: true,
});

const TEXT_SEGMENT_FIELDS = [
  "fontName",
  "fontSize",
  "fontWeight",
  "textDecoration",
  "textCase",
  "lineHeight",
  "letterSpacing",
  "fills",
  "textStyleId",
  "fillStyleId",
];
const MAX_ASSET_BYTES = 16 * 1024 * 1024;
const EXPORT_MIME_TYPES = {
  PNG: "image/png",
  JPG: "image/jpeg",
  SVG: "image/svg+xml",
};

function jsonValue(value, seen) {
  if (value === figma.mixed || typeof value === "symbol") return "MIXED";
  if (value === null || value === undefined) return value;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  if (typeof value === "function") return undefined;

  const visited = seen || new Set();
  if (typeof value === "object") {
    if (visited.has(value)) return "[Circular]";
    visited.add(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => jsonValue(item, visited));
  }

  const result = {};
  for (const key of Object.keys(value)) {
    try {
      const serialized = jsonValue(value[key], visited);
      if (serialized !== undefined) result[key] = serialized;
    } catch (_error) {
      result[key] = "[Unavailable]";
    }
  }
  return result;
}

function readProperties(node, names) {
  const result = {};
  for (const name of names) {
    if (!(name in node)) continue;
    try {
      const value = jsonValue(node[name]);
      if (value !== undefined) result[name] = value;
    } catch (_error) {
      result[name] = "[Unavailable]";
    }
  }
  return result;
}

function selectionSummary() {
  return figma.currentPage.selection.map((node) => ({
    id: node.id,
    name: node.name,
    type: node.type,
  }));
}

async function serializeNode(node, options, depth, state) {
  if (state.count >= options.maxNodes) {
    state.truncated = true;
    return { id: node.id, name: node.name, type: node.type, truncated: true };
  }
  state.count += 1;

  const result = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  Object.assign(
    result,
    readProperties(node, [
      "visible",
      "locked",
      "opacity",
      "blendMode",
      "isMask",
      "maskType",
      "removed",
    ]),
  );

  const geometry = readProperties(node, [
    "x",
    "y",
    "width",
    "height",
    "rotation",
    "absoluteBoundingBox",
    "absoluteRenderBounds",
    "constraints",
    "minWidth",
    "maxWidth",
    "minHeight",
    "maxHeight",
  ]);
  if (Object.keys(geometry).length) result.geometry = geometry;

  const layout = readProperties(node, [
    "layoutMode",
    "layoutWrap",
    "layoutPositioning",
    "layoutSizingHorizontal",
    "layoutSizingVertical",
    "layoutAlign",
    "layoutGrow",
    "primaryAxisSizingMode",
    "counterAxisSizingMode",
    "primaryAxisAlignItems",
    "counterAxisAlignItems",
    "itemSpacing",
    "counterAxisSpacing",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "clipsContent",
    "overflowDirection",
  ]);
  if (Object.keys(layout).length) result.layout = layout;

  const appearance = readProperties(node, [
    "fills",
    "strokes",
    "strokeWeight",
    "strokeAlign",
    "dashPattern",
    "effects",
    "cornerRadius",
    "topLeftRadius",
    "topRightRadius",
    "bottomRightRadius",
    "bottomLeftRadius",
    "cornerSmoothing",
    "fillStyleId",
    "strokeStyleId",
    "effectStyleId",
    "boundVariables",
  ]);
  if (Object.keys(appearance).length) result.appearance = appearance;

  if (node.type === "TEXT") {
    result.text = readProperties(node, [
      "characters",
      "fontName",
      "fontSize",
      "fontWeight",
      "textAlignHorizontal",
      "textAlignVertical",
      "textAutoResize",
      "textCase",
      "textDecoration",
      "lineHeight",
      "letterSpacing",
      "paragraphIndent",
      "paragraphSpacing",
      "listSpacing",
      "textStyleId",
      "hasMissingFont",
      "autoRename",
    ]);
    try {
      result.text.styledSegments = jsonValue(
        node.getStyledTextSegments(TEXT_SEGMENT_FIELDS),
      );
    } catch (error) {
      result.text.styledSegmentsError = String(error);
    }
  }

  if ("variantProperties" in node) {
    result.variantProperties = jsonValue(node.variantProperties);
  }
  if ("componentProperties" in node) {
    result.componentProperties = jsonValue(node.componentProperties);
  }
  if ("componentPropertyDefinitions" in node) {
    try {
      result.componentPropertyDefinitions = jsonValue(
        node.componentPropertyDefinitions,
      );
    } catch (error) {
      result.componentPropertyDefinitionsError = String(error);
    }
  }
  if (node.type === "INSTANCE") {
    try {
      const mainComponent = await node.getMainComponentAsync();
      result.mainComponent = mainComponent
        ? {
            id: mainComponent.id,
            name: mainComponent.name,
            key: mainComponent.key,
            remote: mainComponent.remote,
          }
        : null;
    } catch (error) {
      result.mainComponentError = String(error);
    }
  }

  if (
    options.includeChildren &&
    depth < options.maxDepth &&
    "children" in node
  ) {
    const children = node.children.filter(
      (child) => options.includeInvisible || child.visible,
    );
    result.children = [];
    for (const child of children) {
      result.children.push(
        await serializeNode(child, options, depth + 1, state),
      );
      if (state.count >= options.maxNodes) break;
    }
  } else if ("children" in node) {
    result.childCount = node.children.length;
    if (depth >= options.maxDepth && node.children.length > 0) {
      result.childrenTruncated = true;
    }
  }

  return result;
}

function normalizeOptions(input) {
  return {
    includeChildren: input.includeChildren !== false,
    includeInvisible: input.includeInvisible === true,
    maxDepth: Math.max(0, Math.min(Number(input.maxDepth) || 8, 20)),
    maxNodes: Math.max(1, Math.min(Number(input.maxNodes) || 2000, 10000)),
  };
}

function encodeAssetResult(bytes, metadata) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("Figma returned invalid asset data.");
  }
  if (bytes.length > MAX_ASSET_BYTES) {
    throw new Error(
      `Asset is too large to transfer (${bytes.length} bytes; maximum ${MAX_ASSET_BYTES} bytes).`,
    );
  }
  return {
    schemaVersion: "1.0.0",
    ...metadata,
    byteLength: bytes.length,
    base64: figma.base64Encode(bytes),
  };
}

function normalizeExportFormat(value) {
  const format = String(value || "PNG").toUpperCase();
  if (!(format in EXPORT_MIME_TYPES)) {
    throw new Error(`Unsupported export format: ${format}. Use PNG, JPG, or SVG.`);
  }
  return format;
}

function normalizeExportScale(value) {
  const scale = value === undefined ? 1 : Number(value);
  if (!Number.isFinite(scale) || scale < 0.01 || scale > 4) {
    throw new Error("Export scale must be between 0.01 and 4.");
  }
  return scale;
}

function normalizeBooleanOption(value, defaultValue, name) {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean.`);
  }
  return value;
}

function detectImageMimeType(bytes) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  throw new Error("Unsupported or unrecognized image format.");
}

async function exportNodeImage(input) {
  const node = await figma.getNodeByIdAsync(input.nodeId);
  if (!node) throw new Error(`Node not found: ${input.nodeId}`);
  if (typeof node.exportAsync !== "function") {
    throw new Error(`Node cannot be exported: ${input.nodeId} (${node.type})`);
  }

  const format = normalizeExportFormat(input.format);
  let bytes;
  let exportMetadata;
  if (format === "SVG") {
    const svgOptions = {
      svgOutlineText: normalizeBooleanOption(
        input.svgOutlineText,
        true,
        "svgOutlineText",
      ),
      svgIdAttribute: normalizeBooleanOption(
        input.svgIdAttribute,
        false,
        "svgIdAttribute",
      ),
      svgSimplifyStroke: normalizeBooleanOption(
        input.svgSimplifyStroke,
        true,
        "svgSimplifyStroke",
      ),
    };
    bytes = await node.exportAsync({ format, ...svgOptions });
    exportMetadata = { svgOptions };
  } else {
    const scale = normalizeExportScale(input.scale);
    bytes = await node.exportAsync({
      format,
      constraint: { type: "SCALE", value: scale },
    });
    exportMetadata = { scale };
  }
  const sourceSize =
    typeof node.width === "number" && typeof node.height === "number"
      ? { width: node.width, height: node.height }
      : null;
  return encodeAssetResult(bytes, {
    kind: "node-render",
    node: { id: node.id, name: node.name, type: node.type },
    format,
    ...exportMetadata,
    mimeType: EXPORT_MIME_TYPES[format],
    sourceSize,
  });
}

async function getOriginalImage(input) {
  const imageHash = String(input.imageHash || "").trim();
  if (!imageHash) throw new Error("An imageHash is required.");
  const image = figma.getImageByHash(imageHash);
  if (!image) throw new Error(`Image not found: ${imageHash}`);
  const [bytes, size] = await Promise.all([
    image.getBytesAsync(),
    image.getSizeAsync(),
  ]);
  return encodeAssetResult(bytes, {
    kind: "original-image",
    imageHash,
    mimeType: detectImageMimeType(bytes),
    width: size.width,
    height: size.height,
  });
}

async function exportNodes(nodes, input) {
  const options = normalizeOptions(input || {});
  const state = { count: 0, truncated: false };
  const exported = [];
  for (const node of nodes) {
    exported.push(await serializeNode(node, options, 0, state));
    if (state.count >= options.maxNodes) break;
  }
  return {
    schemaVersion: "1.0.0",
    exportedAt: new Date().toISOString(),
    file: { name: figma.root.name, key: figma.fileKey || null },
    page: { id: figma.currentPage.id, name: figma.currentPage.name },
    options,
    nodeCount: state.count,
    truncated: state.truncated,
    nodes: exported,
  };
}

async function listPages() {
  return {
    schemaVersion: "1.0.0",
    file: { name: figma.root.name, key: figma.fileKey || null },
    currentPageId: figma.currentPage.id,
    pages: figma.root.children.map((page) => ({
      id: page.id,
      name: page.name,
      loaded: page === figma.currentPage,
    })),
  };
}

async function getVariables() {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const result = [];
  for (const collection of collections) {
    const variables = await Promise.all(
      collection.variableIds.map((id) => figma.variables.getVariableByIdAsync(id)),
    );
    result.push({
      id: collection.id,
      name: collection.name,
      defaultModeId: collection.defaultModeId,
      modes: jsonValue(collection.modes),
      variables: variables.filter(Boolean).map((variable) => ({
        id: variable.id,
        key: variable.key,
        name: variable.name,
        resolvedType: variable.resolvedType,
        scopes: jsonValue(variable.scopes),
        valuesByMode: jsonValue(variable.valuesByMode),
        codeSyntax: jsonValue(variable.codeSyntax),
        hiddenFromPublishing: variable.hiddenFromPublishing,
      })),
    });
  }
  return {
    schemaVersion: "1.0.0",
    file: { name: figma.root.name, key: figma.fileKey || null },
    collections: result,
  };
}

async function executeCommand(command) {
  switch (command.action) {
    case "ping":
      return {
        fileName: figma.root.name,
        pageName: figma.currentPage.name,
        selection: selectionSummary(),
      };
    case "get_selection": {
      const selection = figma.currentPage.selection;
      if (!selection.length) throw new Error("No Figma nodes are selected.");
      return exportNodes(selection, command.input);
    }
    case "get_node": {
      const node = await figma.getNodeByIdAsync(command.input.nodeId);
      if (!node) throw new Error(`Node not found: ${command.input.nodeId}`);
      return exportNodes([node], command.input);
    }
    case "list_pages":
      return listPages();
    case "get_variables":
      return getVariables();
    case "export_node":
      return exportNodeImage(command.input);
    case "get_image":
      return getOriginalImage(command.input);
    default:
      throw new Error(`Unsupported bridge action: ${command.action}`);
  }
}

figma.ui.onmessage = async (message) => {
  if (!message) return;
  if (message.type !== "bridge-command") return;
  try {
    const data = await executeCommand(message.command);
    figma.ui.postMessage({
      type: "bridge-result",
      commandId: message.command.id,
      ok: true,
      data,
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "bridge-result",
      commandId: message.command.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

function sendContext() {
  figma.ui.postMessage({
    type: "figma-context",
    fileName: figma.root.name,
    pageName: figma.currentPage.name,
    selection: selectionSummary(),
  });
}

figma.on("selectionchange", sendContext);
figma.on("currentpagechange", sendContext);
sendContext();
