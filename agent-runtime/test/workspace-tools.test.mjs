import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core/aside";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  AsideContractError,
  createAsideToolRegistry,
} from "../src/agent-contracts.mjs";
import {
  DEFAULT_WORKSPACE_TOOL_LIMITS,
  createDocumentAdapterRegistry,
  createWorkspaceReadTools,
} from "../src/workspace-tools.mjs";
import { resolveTaskWorkspace } from "../src/workspace.mjs";
import { createConversationRuntime } from "../src/runtime.mjs";

function resultText(result) {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function taskRun() {
  return { limits: { maxToolResultBytes: 32 * 1024 } };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aside-read-tools-"));
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "notes.md"), "alpha\nbeta\ngamma\n", "utf8");
  await writeFile(join(root, "data.json"), JSON.stringify({ title: "Aside", count: 2 }), "utf8");
  await writeFile(join(root, "nested", "report.txt"), "a report about Aside\n", "utf8");
  await writeFile(join(root, "binary.docx"), Buffer.from([0, 1, 2, 3, 255]));
  return resolve(root);
}

async function bindTool(root, name, options = {}) {
  const resolution = await resolveTaskWorkspace({ workspaceHint: root });
  const tools = createWorkspaceReadTools(options);
  const definition = tools.find((tool) => tool.name === name);
  const implementation = await definition.createForRun({
    workspace: resolution.environment,
    taskRun: taskRun(),
  });
  return { implementation, environment: resolution.environment };
}

test("publishes a validated registry with bounded workspace read tools", () => {
  const tools = createWorkspaceReadTools();
  const registry = createAsideToolRegistry(tools);
  assert.deepEqual(registry.describe().map((tool) => tool.name), [
    "workspace.list",
    "workspace.search",
    "workspace.stat",
    "workspace.read",
  ]);
  for (const descriptor of registry.describe()) {
    assert.equal(descriptor.effect, "read");
    assert.equal(descriptor.scope, "workspace");
    assert.equal(descriptor.replay, "safe");
    assert.ok(descriptor.label);
    assert.ok(registry.get(descriptor.name).tool.createForRun);
  }
  assert.throws(
    () => createAsideToolRegistry([{
      name: "broken.tool",
      description: "broken",
      label: "broken",
      parameters: {},
      execute: async () => ({ content: [] }),
      descriptor: { effect: "read", scope: "workspace", replay: "safe" },
    }]),
    AsideContractError,
  );
});

test("lists, stats, reads text and JSON, and searches only by explicit call", async () => {
  const root = await fixture();
  try {
    const tools = createWorkspaceReadTools();
    const resolution = await resolveTaskWorkspace({ workspaceHint: root });
    const run = taskRun();
    const implementations = new Map();
    for (const tool of tools) {
      implementations.set(
        tool.name,
        await tool.createForRun({ workspace: resolution.environment, taskRun: run }),
      );
    }

    const listed = await implementations.get("workspace.list").execute("list-1", { path: "." });
    assert.equal(listed.details.status, "succeeded");
    assert.ok(listed.details.entries.some((entry) => entry.name === "notes.md"));
    assert.ok(listed.details.entries.some((entry) => entry.name === "nested"));

    const stat = await implementations.get("workspace.stat").execute("stat-1", { path: "nested/report.txt" });
    assert.equal(stat.details.kind, "file");
    assert.equal(stat.details.relative_path, "nested/report.txt");

    const text = await implementations.get("workspace.read").execute("read-1", { path: "notes.md" });
    assert.equal(text.details.format, "markdown");
    assert.match(resultText(text), /alpha/);
    assert.match(resultText(text), /gamma/);

    const json = await implementations.get("workspace.read").execute("read-2", { path: "data.json" });
    assert.equal(json.details.format, "json");
    assert.match(resultText(json), /Aside/);

    const search = await implementations.get("workspace.search").execute("search-1", {
      query: "report",
      mode: "content",
    });
    assert.equal(search.details.status, "succeeded");
    assert.ok(search.details.results.some((entry) => entry.path === "nested/report.txt"));
    assert.equal(search.details.scanned_files > 0, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns typed unsupported, scope, missing, limit, and cancellation results", async () => {
  const root = await fixture();
  try {
    const limits = {
      ...DEFAULT_WORKSPACE_TOOL_LIMITS,
      maxListEntries: 2,
      maxReadBytes: 64,
      maxOutputBytes: 2_048,
    };
    const tools = createWorkspaceReadTools({ limits });
    const resolution = await resolveTaskWorkspace({ workspaceHint: root });
    const run = taskRun();
    const byName = new Map();
    for (const tool of tools) {
      byName.set(tool.name, await tool.createForRun({ workspace: resolution.environment, taskRun: run }));
    }

    const listed = await byName.get("workspace.list").execute("list-limit", { path: "." });
    assert.equal(listed.details.truncated, true);

    const lines = await byName.get("workspace.read").execute("read-lines", {
      path: "notes.md",
      limit: 1,
    });
    assert.equal(lines.details.truncated, true);
    assert.equal(lines.details.next_offset, 2);

    const unsupported = await byName.get("workspace.read").execute("read-binary", { path: "binary.docx" });
    assert.equal(unsupported.isError, true);
    assert.equal(unsupported.details.code, "unsupported_format");

    const escaped = await byName.get("workspace.read").execute("read-escape", { path: "../outside.txt" });
    assert.equal(escaped.isError, true);
    assert.equal(escaped.details.code, "scope_escape");

    const missing = await byName.get("workspace.stat").execute("stat-missing", { path: "missing.txt" });
    assert.equal(missing.isError, true);
    assert.equal(missing.details.code, "not_found");

    const limitedRead = createWorkspaceReadTools({
      limits: { ...limits, maxReadBytes: 8 },
    }).find((tool) => tool.name === "workspace.read");
    const limitedReadImplementation = await limitedRead.createForRun({
      workspace: resolution.environment,
      taskRun: run,
    });
    const tooLarge = await limitedReadImplementation.execute("read-large", { path: "notes.md" });
    assert.equal(tooLarge.isError, true);
    assert.equal(tooLarge.details.code, "result_too_large");

    const controller = new AbortController();
    controller.abort();
    const cancelled = await byName.get("workspace.read").execute("read-cancel", { path: "notes.md" }, controller.signal);
    assert.equal(cancelled.isError, true);
    assert.equal(cancelled.details.code, "aborted");
    assert.doesNotMatch(resultText(unsupported), /must not run/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the default runtime exposes workspace tools only after workspace activation", async () => {
  const root = await fixture();
  try {
    const faux = fauxProvider({ tokensPerSecond: 1_000 });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("workspace.read", { path: "notes.md" }, { id: "default-read" })),
      fauxAssistantMessage("read complete"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const agent = new Agent({
      initialState: {
        systemPrompt: "Use workspace read tools.",
        model: faux.getModel(),
        thinkingLevel: "off",
      },
      streamFn: models.streamSimple.bind(models),
      convertToLlm: (messages) => messages,
    });
    const events = [];
    const runtime = await createConversationRuntime({
      agent,
      workspaceHint: root,
      emit: (event) => events.push(event),
    });
    assert.deepEqual(events.find((event) => event.type === "ready").tools, []);
    await runtime.prompt("default-read-request", "read notes");
    assert.deepEqual(
      events.find((event) => event.type === "run_started").tools.map((tool) => tool.name),
      [
        "workspace.list",
        "workspace.search",
        "workspace.stat",
        "workspace.read",
        "workspace.write",
        "workspace.edit",
      ],
    );
    assert.ok(events.some((event) => event.type === "tool_result" && event.status === "succeeded"));
    assert.equal(events.at(-1).type, "completed");
    assert.match(await readFile(join(root, "notes.md"), "utf8"), /alpha/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates a custom document adapter seam", () => {
  const registry = createDocumentAdapterRegistry([{
    id: "plain",
    formats: ["text"],
    write: false,
    maxReadBytes: 32,
    async read({ bytes }) {
      return { format: "text", text: new TextDecoder().decode(bytes) };
    },
  }]);
  assert.equal(registry.select("file.custom", "plain").id, "plain");
  assert.equal(registry.select("file.custom", "auto"), undefined);
  assert.throws(
    () => createDocumentAdapterRegistry([{ id: "plain", formats: [], write: false }]),
    AsideContractError,
  );
});
