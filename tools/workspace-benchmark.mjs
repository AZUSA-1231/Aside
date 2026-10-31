import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, release, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DEFAULT_WORKSPACE_TOOL_LIMITS, createWorkspaceReadTools } from "../agent-runtime/src/workspace-tools.mjs";
import { resolveTaskWorkspace } from "../agent-runtime/src/workspace.mjs";

const cases = [];
for (const specification of [
  { name: "small", files: 32, bytesPerFile: 64 },
  { name: "medium", files: 512, bytesPerFile: 1_024 },
  { name: "over-limit", files: 2_048, bytesPerFile: 1_024, oversizedBytes: 300 * 1_024 },
]) {
  const root = resolve(await mkdtemp(join(tmpdir(), "aside-r3-benchmark-")));
  try {
    const setupStarted = performance.now();
    for (let batch = 0; batch < specification.files; batch += 32) {
      await Promise.all(Array.from({ length: Math.min(32, specification.files - batch) }, async (_, offset) => {
        const index = batch + offset;
        const prefix = index % 8 === 0 ? "BENCHMARK_NEEDLE " : "ordinary ";
        await writeFile(join(root, `file-${index.toString().padStart(4, "0")}.txt`), prefix.padEnd(specification.bytesPerFile, "x"));
      }));
    }
    if (specification.oversizedBytes) {
      await writeFile(join(root, "oversized.txt"), Buffer.alloc(specification.oversizedBytes, 97));
    }
    const setupMs = performance.now() - setupStarted;
    const workspace = (await resolveTaskWorkspace({ workspaceHint: root })).environment;
    const definitions = createWorkspaceReadTools();
    const operations = [];
    for (const [name, args] of [
      ["workspace.list", { path: "." }],
      ["workspace.read", { path: "file-0000.txt" }],
      ["workspace.search", { query: "BENCHMARK_NEEDLE", mode: "content" }],
      ...(specification.oversizedBytes ? [["workspace.read", { path: "oversized.txt" }]] : []),
    ]) {
      const implementation = await definitions.find((entry) => entry.name === name).createForRun({ workspace });
      const started = performance.now();
      const result = await implementation.execute(`benchmark-${operations.length}`, args);
      const elapsedMs = performance.now() - started;
      const contentBytes = Buffer.byteLength(result.content.map((block) => block.text ?? "").join("\n"));
      assert.ok(contentBytes <= DEFAULT_WORKSPACE_TOOL_LIMITS.maxOutputBytes);
      assert.equal(result.details.status, args.path === "oversized.txt" ? "failed" : "succeeded");
      if (args.path === "oversized.txt") assert.equal(result.details.code, "result_too_large");
      if (name === "workspace.search") assert.equal(result.details.truncated, specification.files > 128);
      operations.push({
        tool: name, arguments: args, elapsed_ms: Number(elapsedMs.toFixed(3)),
        content_bytes: contentBytes, status: result.details.status,
        ...(result.details.code ? { code: result.details.code } : {}),
        truncated: result.details.truncated ?? result.truncated ?? false,
        ...(result.details.entry_count === undefined ? {} : {
          entry_count: result.details.entry_count,
          details_preview_entries: result.details.entries?.length ?? 0,
        }),
        ...(result.details.result_count === undefined ? {} : { result_count: result.details.result_count }),
        ...(result.details.scanned_files === undefined ? {} : { scanned_files: result.details.scanned_files }),
        ...(result.details.next_offset === undefined ? {} : { next_offset: result.details.next_offset }),
        ...(result.details.next_scanned_offset === undefined ? {} : { next_scanned_offset: result.details.next_scanned_offset }),
      });
    }
    cases.push({ ...specification, setup_ms: Number(setupMs.toFixed(3)), operations });
  } finally {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("aside-r3-benchmark-"));
    await rm(root, { recursive: true, force: true });
  }
}

const evidence = {
  date: "2026-10-31", recorded_at: new Date().toISOString(),
  scope: "Synthetic local workspace development benchmark; no desktop, provider, installer, or clean-environment acceptance.",
  node: process.version, platform: process.platform, os_release: release(), arch: arch(),
  limits: DEFAULT_WORKSPACE_TOOL_LIMITS, cases,
};
const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
if (process.argv[2]) {
  const output = resolve(process.argv[2]);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, serialized);
}
process.stdout.write(serialized);
