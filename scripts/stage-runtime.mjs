#!/usr/bin/env node
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Stages everything the installed application needs into `src-tauri/resources`.
 *
 * The packaged app must not depend on the source checkout, so the runtime, its
 * dependency closure, the bundled skills, and a Node binary are all copied into
 * the bundle here. `runtime.rs` resolves them from the bundle's resource
 * directory; this script is what puts them there.
 *
 * **This script needs the network**, and only for one step: fetching Node. The
 * rest is local copying. Run it before `tauri build`; running it is a
 * prerequisite for the two `tauri.conf.json` entries described at the end of
 * this file, which cannot be added until the staged tree exists because Tauri
 * resolves those paths at build time and fails if they are missing.
 *
 * Usage:
 *   node scripts/stage-runtime.mjs            stage everything
 *   node scripts/stage-runtime.mjs --no-node  skip the Node download
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const resourcesDir = join(repoRoot, "src-tauri", "resources");
const runtimeDir = join(resourcesDir, "runtime");
const nodeDir = join(resourcesDir, "node");

/**
 * The Node version the runtime requires.
 *
 * Held to the same floor the vendored Pi packages declare in their `engines`
 * field. Shipping a version below it would produce a runtime that starts and
 * then fails on the first provider call, which is the worst of both outcomes.
 */
const NODE_VERSION = "22.19.0";

/** Packages present in the closure that are build-time only. */
const BUILD_ONLY_PACKAGES = new Set(["@types/node"]);

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function pathSize(target) {
  let total = 0;
  const walk = async (current) => {
    let entry;
    try {
      entry = await stat(current);
    } catch {
      return;
    }
    if (entry.isFile()) {
      total += entry.size;
      return;
    }
    if (!entry.isDirectory()) return;
    const { readdir } = await import("node:fs/promises");
    for (const child of await readdir(current)) await walk(join(current, child));
  };
  await walk(target);
  return total;
}

async function copyInto(from, to) {
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
}

/**
 * Resolves the runtime's dependency closure by walking `dependencies` from the
 * entry packages. Mirrors how Node resolves: every package a package declares,
 * transitively.
 */
async function dependencyClosure(roots) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length > 0) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    let manifest;
    try {
      manifest = JSON.parse(
        await readFile(join(repoRoot, "node_modules", name, "package.json"), "utf8"),
      );
    } catch {
      log(`  ! ${name} is declared but not installed; the staged runtime will be incomplete`);
      continue;
    }
    for (const dependency of Object.keys(manifest.dependencies ?? {})) stack.push(dependency);
  }
  return seen;
}

async function stageNodeSource() {
  log("\n1. runtime source and skills");
  await rm(runtimeDir, { recursive: true, force: true });
  await copyInto(join(repoRoot, "agent-runtime", "src"), join(runtimeDir, "src"));
  await copyInto(join(repoRoot, "agent-runtime", "skills"), join(runtimeDir, "skills"));
  log("   staged runtime/src and runtime/skills");
}

async function stageDependencies() {
  log("\n2. runtime dependency closure");
  const entryPoints = ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai"];
  const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  // Anything the runtime imports directly is a root, plus whatever Pi needs.
  const direct = ["@modelcontextprotocol/sdk", "@xmldom/xmldom", "docx", "fflate"];
  const closure = await dependencyClosure([...entryPoints, ...direct]);

  let copied = 0;
  let skipped = 0;
  for (const name of [...closure].sort()) {
    if (BUILD_ONLY_PACKAGES.has(name)) {
      skipped += 1;
      continue;
    }
    await copyInto(
      join(repoRoot, "node_modules", name),
      join(runtimeDir, "node_modules", name),
    );
    copied += 1;
  }
  log(`   copied ${copied} packages, skipped ${skipped} build-only`);
  const bytes = await pathSize(join(runtimeDir, "node_modules"));
  log(`   runtime/node_modules is ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  void manifest;
}

/**
 * Fetches and unpacks the Node binary.
 *
 * The only step that needs the network, and therefore the only step that can
 * fail for a reason unrelated to this repository. It is isolated here so the
 * rest of the staging still runs and reports when this one cannot.
 */
async function stageNode() {
  log(`\n3. bundled Node ${NODE_VERSION}`);
  const platform = process.platform === "win32" ? "win" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const extension = platform === "win" ? "zip" : "tar.gz";
  const folder = `node-v${NODE_VERSION}-${platform}-${arch}`;
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${folder}.${extension}`;

  log(`   fetching ${url}`);
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(
      `Node could not be downloaded: ${error.message}. `
      + "Re-run with network access, or pass --no-node and rely on a system Node.",
    );
  }
  if (!response.ok) {
    throw new Error(`Node could not be downloaded: HTTP ${response.status} for ${url}`);
  }

  const archive = join(resourcesDir, `node.${extension}`);
  await mkdir(resourcesDir, { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
  log(`   downloaded ${(await pathSize(archive) / 1024 / 1024).toFixed(1)} MB`);

  // Extraction is left to the platform's own tool. Unpacking a zip or a
  // tarball in Node would mean either a new dependency or a partial
  // reimplementation, and both are worse than one shell command in a script a
  // human runs deliberately.
  const { spawnSync } = await import("node:child_process");
  const extract = join(resourcesDir, "extract");
  await rm(extract, { recursive: true, force: true });
  await mkdir(extract, { recursive: true });
  const command = platform === "win"
    ? ["powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${extract}' -Force`]]
    : ["tar", ["-xzf", archive, "-C", extract]];
  const result = spawnSync(command[0], command[1], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Node could not be unpacked (exit ${result.status}). The archive is at ${archive}.`);
  }

  await rm(nodeDir, { recursive: true, force: true });
  await mkdir(nodeDir, { recursive: true });
  if (platform === "win") {
    await copyInto(join(extract, folder, "node.exe"), join(nodeDir, "node.exe"));
  } else {
    await copyInto(join(extract, folder, "bin"), join(nodeDir, "bin"));
    for (const library of ["lib"]) {
      await copyInto(join(extract, folder, library), join(nodeDir, library)).catch(() => {});
    }
  }
  await rm(extract, { recursive: true, force: true });
  await rm(archive, { force: true });
  log(`   staged node/${platform === "win" ? "node.exe" : "bin/node"}`);
}

async function writeManifest(includeNode) {
  const manifest = {
    node_version: includeNode ? NODE_VERSION : null,
    staged_at: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
  };
  await writeFile(
    join(resourcesDir, "staging.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function main() {
  const includeNode = !process.argv.includes("--no-node");
  log(`Staging the Aside runtime into ${resourcesDir}`);
  await stageNodeSource();
  await stageDependencies();
  if (includeNode) {
    await stageNode();
  } else {
    log("\n3. bundled Node: skipped (--no-node)");
  }
  await writeManifest(includeNode);

  const total = await pathSize(resourcesDir);
  log(`\nStaged ${(total / 1024 / 1024).toFixed(1)} MB into src-tauri/resources.`);
  log(
    "\nNext: add these to src-tauri/tauri.conf.json under \"bundle\", then run\n"
    + "`npm run tauri build`. They are not committed because Tauri resolves them\n"
    + "at build time and fails when the staged tree is absent, which would break\n"
    + "the build for anyone who has not run this script.\n\n"
    + '  "resources": ["resources/runtime/**/*", "resources/node/**/*"],\n'
    + '  "externalBin": ["binaries/node"]   // see scripts/stage-node-bin.mjs\n',
  );
}

main().catch((error) => {
  process.stderr.write(`\n${error.message}\n`);
  process.exitCode = 1;
});
