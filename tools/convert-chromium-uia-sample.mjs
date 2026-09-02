import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const sampleDir = path.join(
  root,
  "docs/cycle-4-contextual-sidecar/research/real-test/live-edge-20260901-145713930",
);
const inputPath =
  process.argv[2] ??
  path.join(sampleDir, "trees/live-edge-20260901-145713930/uia-content-view.json");
const outputPath =
  process.argv[3] ?? path.join(sampleDir, "converted-browser-context.json");
const source = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const captureMetadataPath = path.join(sampleDir, "capture-metadata.json");
const captureMetadata = fs.existsSync(captureMetadataPath)
  ? JSON.parse(fs.readFileSync(captureMetadataPath, "utf8"))
  : {};

const maxDepth = source.limits?.maxDepth ?? 16;
const maxNodes = source.limits?.maxNodes ?? 800;
const maxNameBytes = 1024;

function normalizeName(value) {
  let result = "";
  let pendingSpace = false;
  for (const character of String(value ?? "")) {
    const code = character.codePointAt(0);
    const whitespace = /\s/u.test(character);
    if (code < 32 && !whitespace) return null;
    if (whitespace) {
      pendingSpace = result.length > 0;
      continue;
    }
    if (pendingSpace) result += " ";
    pendingSpace = false;
    result += character;
    if (Buffer.byteLength(result, "utf8") > maxNameBytes) return null;
  }
  result = result.trim();
  return result.length === 0 ? null : result;
}

function visible(node, rootBounds) {
  if (node.offscreen === true) return false;
  if (!node.bounds) return true;
  const bounds = node.bounds;
  if (bounds.width <= 0 || bounds.height <= 0) return false;
  if (!rootBounds) return true;
  return (
    bounds.x < rootBounds.x + rootBounds.width &&
    rootBounds.x < bounds.x + bounds.width &&
    bounds.y < rootBounds.y + rootBounds.height &&
    rootBounds.y < bounds.y + bounds.height
  );
}

function roleForType(type) {
  const roles = {
    "ControlType.Document": "document",
    "ControlType.Edit": "edit",
    "ControlType.TabItem": "tabitem",
    "ControlType.Button": "button",
    "ControlType.CheckBox": "checkbox",
    "ControlType.ComboBox": "combobox",
    "ControlType.DataItem": "dataitem",
    "ControlType.Group": "group",
    "ControlType.Header": "header",
    "ControlType.Hyperlink": "link",
    "ControlType.Image": "image",
    "ControlType.List": "list",
    "ControlType.ListItem": "listitem",
    "ControlType.MenuItem": "menuitem",
    "ControlType.Pane": "pane",
    "ControlType.RadioButton": "radiobutton",
    "ControlType.Separator": "separator",
    "ControlType.StatusBar": "statusbar",
    "ControlType.Tab": "tab",
    "ControlType.Table": "table",
    "ControlType.Text": "text",
    "ControlType.TitleBar": "titlebar",
    "ControlType.ToolBar": "toolbar",
    "ControlType.TreeItem": "treeitem",
    "ControlType.Window": "window",
  };
  return roles[type] ?? "unknown";
}

function isDescendant(nodes, index, rootIndex) {
  let current = index;
  while (current >= 0) {
    if (current === rootIndex) return true;
    current = nodes[current]?.parentIndex ?? -1;
  }
  return false;
}

function semanticBounds(bounds) {
  if (
    !bounds ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height)
  ) {
    return null;
  }
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
}

function sanitizeUrl(value) {
  try {
    const parsed = new URL(value.trim());
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function formatJson(value, level = 0, key = undefined) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  const indent = "  ".repeat(level);
  const childIndent = "  ".repeat(level + 1);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (key === "fields") return JSON.stringify(value);
    if (key === "nodes") {
      return `[\n${value
        .map((node) => `${childIndent}${JSON.stringify(node)}`)
        .join(",\n")}\n${indent}]`;
    }
    return `[\n${value
      .map((item) => `${childIndent}${formatJson(item, level + 1)}`)
      .join(",\n")}\n${indent}]`;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) return "{}";
  return `{\n${entries
    .map(
      ([entryKey, entryValue]) =>
        `${childIndent}${JSON.stringify(entryKey)}: ${formatJson(
          entryValue,
          level + 1,
          entryKey,
        )}`,
    )
    .join(",\n")}\n${indent}}`;
}

const nodes = source.nodes ?? [];
const documents = nodes
  .map((node, index) => ({ node, index }))
  .filter(
    ({ node }) =>
      node.type === "ControlType.Document" &&
      node.offscreen !== true &&
      node.bounds &&
      node.bounds.width > 0 &&
      node.bounds.height > 0,
  );
if (documents.length !== 1) {
  throw new Error(`Expected one visible Document, found ${documents.length}`);
}

const documentEntry = documents[0];
const documentNode = documentEntry.node;
const documentIndex = documentEntry.index;
const rootBounds = documentNode.bounds;
const documentSubtreeNodeCount = nodes.filter((_, index) =>
  isDescendant(nodes, index, documentIndex),
).length;
const semanticNodes = [];
let observedDepth = 0;
let nodeTruncated = false;

for (let index = documentIndex; index < nodes.length; index += 1) {
  const node = nodes[index];
  if (!isDescendant(nodes, index, documentIndex)) continue;
  const name = normalizeName(node.name);
  if (!visible(node, rootBounds) || (index !== documentIndex && !name)) continue;
  const relativeDepth = Math.max(0, (node.depth ?? 0) - (documentNode.depth ?? 0));
  if (relativeDepth >= maxDepth) {
    nodeTruncated = true;
    break;
  }
  if (semanticNodes.length >= maxNodes) {
    nodeTruncated = true;
    break;
  }
  observedDepth = Math.max(observedDepth, relativeDepth);
  semanticNodes.push([
    roleForType(node.type),
    name ?? "",
    semanticBounds(node.bounds),
  ]);
}

if (semanticNodes.length === 1 && semanticNodes[0][1] === "") {
  semanticNodes.length = 0;
  observedDepth = 0;
}

const target = source.target ?? {};
const captureTarget = captureMetadata.target ?? {};
const application =
  String(target.processName ?? "").toLowerCase() === "chrome"
    ? "Google Chrome"
    : "Microsoft Edge";
const tabNode = nodes.find(
  (node) => node.type === "ControlType.TabItem" && node.selected === true,
);
const tabName = normalizeName(tabNode?.name);
const title = normalizeName(documentNode.name) ?? tabName;
const url = sanitizeUrl("https://github.com");
const metadataComplete = Boolean(tabName && title && url);
const captureQuality =
  semanticNodes.length === 0
    ? "metadata_only"
    : metadataComplete && source.traversalErrorCount === 0
      ? nodeTruncated
        ? "partial"
        : "complete"
      : "partial";
const capturedAt = Date.parse(source.generatedAt ?? new Date().toISOString());

const metadata = {
  application,
  pid: target.processId ?? captureTarget.processId ?? null,
  tabName,
  url,
  title,
  quality: captureQuality,
  view: "content",
  depth: {
    limit: maxDepth,
    observed: observedDepth,
    depthTruncated: false,
  },
  nodeLimit: maxNodes,
  nodeCount: semanticNodes.length,
  nodeTruncated,
};

const attachment = {
  id: "research-github-live-edge-20260901-145713930",
  host: "browser",
  source: application,
  capturedAt,
  expiresAt: capturedAt + 5 * 60 * 1000,
  sensitivity: "local_content",
  summary: `${title ?? application} | ${semanticNodes.length} semantic nodes | ${captureQuality.replace("_", " ")}`,
  blocks: [
    { type: "json", label: "browser.metadata", data: metadata },
    {
      type: "json",
      label: "browser.semantic_page",
      data: {
        fields: ["role", "name", "bounds"],
        nodes: semanticNodes,
      },
    },
  ],
};

fs.writeFileSync(outputPath, `${formatJson(attachment)}\n`, "utf8");
console.log(`Wrote ${outputPath}`);
console.log(
  JSON.stringify(
    {
      rawNodeCount: nodes.length,
      documentSubtreeNodeCount,
      application,
      nodeCount: semanticNodes.length,
      filteredNodeCount: documentSubtreeNodeCount - semanticNodes.length,
      observedDepth,
      nodeTruncated,
      quality: captureQuality,
    },
    null,
    2,
  ),
);
