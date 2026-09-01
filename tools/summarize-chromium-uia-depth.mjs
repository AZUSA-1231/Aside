#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const rootArg = args.find((arg) => !arg.startsWith("-"));

if (!rootArg) {
  console.error("Usage: node tools/summarize-chromium-uia-depth.mjs <run-directory> [--json]");
  process.exit(2);
}

const root = path.resolve(rootArg);

function findFiles(directory, fileName, result = []) {
  if (!fs.existsSync(directory)) {
    return result;
  }

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      findFiles(entryPath, fileName, result);
    } else if (entry.name === fileName) {
      result.push(entryPath);
    }
  }

  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function countType(nodes, type) {
  return nodes.filter((node) => node.type === type).length;
}

function sumTextMetrics(summary, metricName, type) {
  return (summary?.textProviders ?? []).reduce((total, provider) => {
    if (type && provider.type !== type) {
      return total;
    }
    return total + (provider.metrics?.[metricName]?.length ?? 0);
  }, 0);
}

function summarizeView(probe, tree, view) {
  const viewResult = probe.uia?.[view] ?? {};
  const nodes = tree?.nodes ?? [];
  const summary = viewResult.summary ?? {};

  return {
    depth: probe.limits?.maxDepth ?? tree?.limits?.maxDepth ?? null,
    view,
    nodeCount: tree?.nodeCount ?? viewResult.nodeCount ?? 0,
    namedNodeCount: nodes.filter((node) => (node.nameMetrics?.length ?? 0) > 0).length,
    imageCount: countType(nodes, "ControlType.Image"),
    hyperlinkCount: countType(nodes, "ControlType.Hyperlink"),
    buttonCount: countType(nodes, "ControlType.Button"),
    listItemCount: countType(nodes, "ControlType.ListItem"),
    maxObservedDepth: nodes.reduce((max, node) => Math.max(max, node.depth ?? 0), 0),
    documentChars: sumTextMetrics(summary, "documentSample", "ControlType.Document"),
    visibleChars: sumTextMetrics(summary, "visibleText"),
    selectionChars: sumTextMetrics(summary, "selectionText"),
    truncated: Boolean(viewResult.truncated ?? tree?.truncated),
    depthTruncated: Boolean(viewResult.depthTruncated ?? tree?.depthTruncated),
    depthLimitedNodeCount: viewResult.depthLimitedNodeCount ?? tree?.depthLimitedNodeCount ?? 0,
    depthProbeErrorCount: viewResult.depthProbeErrorCount ?? tree?.depthProbeErrorCount ?? 0,
    traversalErrorCount: viewResult.traversalErrorCount ?? tree?.traversalErrorCount ?? 0,
    durationMs: viewResult.durationMs ?? null,
  };
}

function findTree(runDirectory, view) {
  return findFiles(runDirectory, `uia-${view}-view.json`)[0] ?? null;
}

const probeFiles = findFiles(root, "probe-output.txt");
if (probeFiles.length === 0) {
  console.error(`No probe-output.txt files found under ${root}`);
  process.exit(1);
}

const rows = [];
for (const probeFile of probeFiles) {
  const runDirectory = path.dirname(probeFile);
  let probe;
  try {
    probe = readJson(probeFile);
  } catch (error) {
    console.error(`Skipping invalid probe output ${probeFile}: ${error.message}`);
    continue;
  }

  for (const view of ["controlView", "contentView"]) {
    const treeFile = findTree(runDirectory, view.replace("View", "").toLowerCase());
    const tree = treeFile ? readJson(treeFile) : null;
    rows.push({
      run: path.relative(root, runDirectory) || ".",
      ...summarizeView(probe, tree, view),
    });
  }
}

rows.sort((left, right) => {
  return (left.depth ?? 0) - (right.depth ?? 0) || left.view.localeCompare(right.view) || left.run.localeCompare(right.run);
});

if (jsonOutput) {
  console.log(JSON.stringify({ root, runs: rows }, null, 2));
  process.exit(0);
}

const columns = [
  ["run", "run"],
  ["depth", "depth"],
  ["view", "view"],
  ["nodeCount", "nodes"],
  ["namedNodeCount", "named"],
  ["imageCount", "images"],
  ["hyperlinkCount", "links"],
  ["buttonCount", "buttons"],
  ["listItemCount", "items"],
  ["documentChars", "docChars"],
  ["visibleChars", "visible"],
  ["selectionChars", "selection"],
  ["maxObservedDepth", "maxSeen"],
  ["depthTruncated", "depthCut"],
  ["depthLimitedNodeCount", "cutNodes"],
  ["traversalErrorCount", "walkErr"],
  ["durationMs", "ms"],
];

const widths = columns.map(([key, label]) => {
  const values = rows.map((row) => String(row[key] ?? ""));
  return Math.max(label.length, ...values.map((value) => value.length));
});

const formatRow = (row) => columns.map(([key], index) => String(row[key] ?? "").padEnd(widths[index])).join("  ");
console.log(columns.map(([, label], index) => label.padEnd(widths[index])).join("  "));
console.log(widths.map((width) => "-".repeat(width)).join("  "));
for (const row of rows) {
  console.log(formatRow(row));
}
