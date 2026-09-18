import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core/aside";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AsideContractError } from "../src/agent-contracts.mjs";
import { createAsideToolRegistry } from "../src/capability-contract.mjs";
import {
  DEFAULT_DOCUMENT_ADAPTERS,
  DEFAULT_WORKSPACE_TOOL_LIMITS,
  createDocumentAdapterRegistry,
  createWorkspaceReadTools,
  readDocument,
  validateDocumentText,
} from "../src/workspace-tools.mjs";
import { createWorkspaceWriteTools } from "../src/workspace-write-tools.mjs";
import { resolveTaskWorkspace } from "../src/workspace.mjs";
import { createConversationRuntime } from "../src/runtime.mjs";
import { buildLargePdf, buildPdf } from "./pdf-fixtures.mjs";

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
  await writeFile(join(root, "binary.xlsx"), Buffer.from([0, 1, 2, 3, 255]));
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

    // .docx and .pdf now have adapters; .xlsx still does not.
    const unsupported = await byName.get("workspace.read").execute("read-binary", { path: "binary.xlsx" });
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
        // Document generation is workspace-scoped too, so it is withheld with
        // the rest until a workspace is resolved.
        "document.create",
        "document.transform",
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

// --- Cycle 6 P2: read continuation -----------------------------------------

async function continuationFixture() {
  const root = await mkdtemp(join(tmpdir(), "aside-continuation-"));
  // The reproduced gap: one line far larger than a single read's budget.
  await writeFile(join(root, "long-line.txt"), `head-${"x".repeat(30_000)}-tail`, "utf8");
  // Multibyte characters so a byte budget lands inside a character.
  await writeFile(join(root, "unicode.txt"), "α".repeat(900) + "\n" + "β".repeat(900), "utf8");
  const numbered = Array.from({ length: 400 }, (_, index) => `line-${index + 1}`).join("\n");
  await writeFile(join(root, "numbered.txt"), `${numbered}\n`, "utf8");
  return resolve(root);
}

function readText(result) {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** The content below the JSON header the read tool prints above the body. */
function readContent(result) {
  const text = readText(result);
  const separator = text.indexOf("\n\n");
  return separator < 0 ? text : text.slice(separator + 2);
}

/** Reads once, then follows next_byte_offset until the content is complete. */
async function readAllSegments(implementation, path, maxSegments = 60) {
  const segments = [];
  let params = { path };
  for (let index = 0; index < maxSegments; index += 1) {
    const result = await implementation.execute(`segment-${index}`, params);
    assert.equal(result.details.status, "succeeded", readText(result));
    segments.push({ result, content: readContent(result) });
    if (!result.details.truncated) {
      return { segments, details: result.details };
    }
    assert.equal(
      Number.isSafeInteger(result.details.next_byte_offset),
      true,
      "a truncated read must say where to continue",
    );
    assert.ok(
      result.details.next_byte_offset > (params.byte_offset ?? 0),
      "the continuation must advance",
    );
    params = { path, byte_offset: result.details.next_byte_offset };
  }
  throw new Error("continuation did not terminate");
}

test("C6-10: a truncated long line can be continued without losing bytes", async () => {
  const root = await continuationFixture();
  try {
    const { implementation } = await bindTool(root, "workspace.read");
    const first = await implementation.execute("long-1", { path: "long-line.txt" });

    assert.equal(first.details.truncated, true);
    assert.equal(first.details.offset, 1);
    assert.equal(first.details.offset_bytes, 0);
    // The reproduced gap: truncation used to omit any continuation.
    assert.equal(Number.isSafeInteger(first.details.next_byte_offset), true);
    assert.equal(first.details.next_byte_offset, first.details.content_bytes);
    assert.ok(first.details.content_bytes <= DEFAULT_WORKSPACE_TOOL_LIMITS.maxOutputBytes);

    const { segments, details } = await readAllSegments(implementation, "long-line.txt");
    const content = segments.map((segment) => segment.content).join("");
    // Every byte of the file is delivered exactly once, in order.
    assert.equal(content, `head-${"x".repeat(30_000)}-tail`);
    assert.equal(content.length, details.total_bytes);
    assert.equal(segments.length > 1, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C6-10: byte continuation never splits a multibyte character", async () => {
  const root = await continuationFixture();
  try {
    const { implementation } = await bindTool(root, "workspace.read");
    const expected = `${"α".repeat(900)}\n${"β".repeat(900)}`;

    const { segments, details } = await readAllSegments(implementation, "unicode.txt");
    const content = segments.map((segment) => segment.content).join("");

    assert.equal(content, expected, "reconstruction is byte-exact");
    assert.equal(content.includes("\uFFFD"), false, "no replacement characters");
    assert.equal(details.total_bytes, Buffer.byteLength(expected, "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C6-09: line ranges and byte ranges agree about where content resumes", async () => {
  const root = await continuationFixture();
  try {
    const { implementation } = await bindTool(root, "workspace.read");

    const head = await implementation.execute("lines-1", { path: "numbered.txt", limit: 5 });
    assert.equal(head.details.offset, 1);
    assert.equal(head.details.offset_bytes, 0);
    assert.equal(head.details.lines, 5);
    assert.equal(head.details.truncated, true);
    assert.equal(head.details.next_offset, 6);
    // Both continuations are offered and both land on the same byte.
    const byLine = await implementation.execute("lines-2", {
      path: "numbered.txt",
      offset: head.details.next_offset,
      limit: 5,
    });
    const byByte = await implementation.execute("lines-3", {
      path: "numbered.txt",
      byte_offset: head.details.next_byte_offset,
      limit: 5,
    });
    assert.equal(byLine.details.offset, 6);
    assert.equal(byByte.details.offset_bytes, head.details.next_byte_offset);
    assert.equal(byByte.details.offset, 6, "the same position, described two ways");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads a locator range that ends partway through a multiline region", async () => {
  const root = await continuationFixture();
  try {
    const { implementation } = await bindTool(root, "workspace.read");
    const middle = await implementation.execute("span-1", {
      path: "numbered.txt",
      offset: 120,
      limit: 10,
    });
    assert.equal(middle.details.offset, 120);
    assert.equal(middle.details.lines, 10);
    assert.match(readText(middle), /line-120/);
    assert.match(readText(middle), /line-129/);
    assert.equal(middle.details.truncated, true);
    assert.equal(middle.details.next_offset, 130);
    assert.equal(
      middle.details.next_byte_offset,
      middle.details.offset_bytes + middle.details.content_bytes,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a byte offset past the end without advancing silently", async () => {
  const root = await continuationFixture();
  try {
    const { implementation } = await bindTool(root, "workspace.read");
    const total = Buffer.byteLength(`${"α".repeat(900)}\n${"β".repeat(900)}`, "utf8");

    const atEnd = await implementation.execute("end-1", {
      path: "unicode.txt",
      byte_offset: total,
    });
    assert.equal(atEnd.details.content_bytes, 0);
    assert.equal(atEnd.details.truncated, false);

    const beyond = await implementation.execute("end-2", {
      path: "unicode.txt",
      byte_offset: total + 1,
    });
    assert.equal(beyond.details.status, "failed");
    assert.equal(beyond.details.code, "invalid_offset");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- Cycle 6 P2: directory listing pagination -------------------------------

async function wideFixture() {
  const root = await mkdtemp(join(tmpdir(), "aside-list-cursor-"));
  // Names chosen so filesystem readdir order is unlikely to match sorted order.
  for (const name of ["zeta", "Alpha", "beta", "delta", "gamma", "epsilon"]) {
    await writeFile(join(root, `${name}.txt`), name, "utf8");
  }
  return resolve(root);
}

async function listAllPages(implementation, params, maxPages = 20) {
  const seen = [];
  let page = params;
  for (let index = 0; index < maxPages; index += 1) {
    const result = await implementation.execute(`list-${index}`, page);
    assert.equal(result.details.status, "succeeded", readText(result));
    seen.push(...result.details.entries.map((entry) => entry.name));
    if (!result.details.truncated) {
      return { names: seen, details: result.details };
    }
    assert.equal(Number.isSafeInteger(result.details.next_offset), true);
    page = { ...params, offset: result.details.next_offset };
  }
  throw new Error("listing did not terminate");
}

test("C6-09: lists entries in a stable order with an explicit cursor", async () => {
  const root = await wideFixture();
  try {
    const { implementation } = await bindTool(root, "workspace.list");

    // The cursor only means anything if the order is reproducible.
    const first = await implementation.execute("order-1", { path: "." });
    const second = await implementation.execute("order-2", { path: "." });
    assert.deepEqual(
      first.details.entries.map((entry) => entry.name),
      second.details.entries.map((entry) => entry.name),
    );
    assert.deepEqual(
      first.details.entries.map((entry) => entry.name),
      [...first.details.entries.map((entry) => entry.name)].sort(),
    );
    assert.equal(first.details.total_entries, 6);
    assert.equal(first.details.offset, 0);
    assert.equal(first.details.truncated, false);
    assert.equal(first.details.next_offset, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C6-09: paging a directory yields every entry exactly once", async () => {
  const root = await wideFixture();
  try {
    const { implementation } = await bindTool(root, "workspace.list");
    const { names, details } = await listAllPages(implementation, { path: ".", limit: 2 });
    const whole = await implementation.execute("list-all", { path: "." });

    assert.deepEqual(names, whole.details.entries.map((entry) => entry.name));
    assert.equal(new Set(names).size, names.length, "no entry is repeated");
    assert.equal(names.length, details.total_entries);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a directory cursor beyond the listing bounds", async () => {
  const root = await wideFixture();
  try {
    const { implementation } = await bindTool(root, "workspace.list");

    // Past the end is an empty page, not an error, so a caller can stop safely.
    const past = await implementation.execute("past-end", { path: ".", offset: 99 });
    assert.equal(past.details.entries.length, 0);
    assert.equal(past.details.truncated, false);

    const invalid = await implementation.execute("bad-offset", { path: ".", offset: -1 });
    assert.equal(invalid.details.status, "failed");
    assert.equal(invalid.details.code, "invalid_offset");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- Cycle 6 P3: common document envelope and binary routing ---------------

function structuredAdapter(collected = []) {
  return {
    id: "pdfish",
    formats: ["pdfish"],
    extensions: [".pdfish"],
    write: false,
    maxReadBytes: 64 * 1024,
    async read({ bytes, path, signal }) {
      collected.push({ byteLength: bytes.byteLength, signal });
      return {
        format: "pdfish",
        metadata: { pages: 2 },
        blocks: [
          { type: "page_break", locator: { page: 1 } },
          { type: "paragraph", text: "first page", locator: { page: 1, block: 1 } },
          { type: "page_break", locator: { page: 2 } },
          { type: "paragraph", text: "second page", locator: { page: 2, block: 1 } },
        ],
        warnings: [],
      };
    },
  };
}

async function binaryFixture() {
  const root = await mkdtemp(join(tmpdir(), "aside-doc-envelope-"));
  // Bytes that are deliberately not valid UTF-8, like a real binary format.
  await writeFile(join(root, "sample.pdfish"), Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80]));
  await writeFile(join(root, "note.txt"), "plain text\n", "utf8");
  return resolve(root);
}

test("C6-15: a declared adapter takes precedence over the unsupported guard", async () => {
  const root = await binaryFixture();
  try {
    const collected = [];
    const registry = createDocumentAdapterRegistry([
      ...DEFAULT_DOCUMENT_ADAPTERS,
      structuredAdapter(collected),
    ]);

    // An unregistered binary stays honestly unsupported...
    assert.equal(registry.select("file.xlsx", "auto"), undefined);
    assert.equal(registry.select("file.pptx", "auto"), undefined);
    // ...and a declared one is selected even though it is an unknown extension.
    assert.equal(registry.select("sample.pdfish", "auto").id, "pdfish");
    // The built-in text and JSON behaviour is unchanged.
    assert.equal(registry.select("note.txt", "auto").id, "text");
    assert.equal(registry.select("data.json", "auto").id, "json");
    assert.equal(registry.select("anything", "auto").id, "text");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C6-15: a structured adapter returns blocks without a text field", async () => {
  const root = await binaryFixture();
  try {
    const collected = [];
    const registry = createDocumentAdapterRegistry([
      ...DEFAULT_DOCUMENT_ADAPTERS,
      structuredAdapter(collected),
    ]);
    const loaded = await readDocument(
      { workspace: (await resolveTaskWorkspace({ workspaceHint: root })).environment, documentRegistry: registry, limits: DEFAULT_WORKSPACE_TOOL_LIMITS },
      "sample.pdfish",
      "auto",
      undefined,
    );

    assert.equal(loaded.document.format, "pdfish");
    assert.equal(loaded.document.text, undefined);
    assert.equal(loaded.document.blocks.length, 4);
    assert.deepEqual(loaded.document.blocks[1].locator, { page: 1, block: 1 });
    // The binary bytes were never decoded as UTF-8 (the reproduced defect).
    assert.equal("raw_text" in loaded, false);
    assert.equal(collected.length, 1);
    assert.equal(collected[0].byteLength, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps raw text for a text adapter so the write path still works", async () => {
  const root = await binaryFixture();
  try {
    const registry = createDocumentAdapterRegistry(DEFAULT_DOCUMENT_ADAPTERS);
    const loaded = await readDocument(
      { workspace: (await resolveTaskWorkspace({ workspaceHint: root })).environment, documentRegistry: registry, limits: DEFAULT_WORKSPACE_TOOL_LIMITS },
      "note.txt",
      "auto",
      undefined,
    );
    assert.equal(loaded.document.text, "plain text\n");
    assert.equal(loaded.raw_text, "plain text\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("passes the abort signal into the adapter contract", async () => {
  const root = await binaryFixture();
  try {
    const collected = [];
    const registry = createDocumentAdapterRegistry([
      ...DEFAULT_DOCUMENT_ADAPTERS,
      structuredAdapter(collected),
    ]);
    const environment = (await resolveTaskWorkspace({ workspaceHint: root })).environment;
    const controller = new AbortController();

    await readDocument(
      { workspace: environment, documentRegistry: registry, limits: DEFAULT_WORKSPACE_TOOL_LIMITS },
      "sample.pdfish",
      "auto",
      controller.signal,
    );
    assert.equal(collected[0].signal, controller.signal, "the adapter can observe cancellation");

    // An already-cancelled read never reaches the adapter at all.
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      () =>
        readDocument(
          { workspace: environment, documentRegistry: registry, limits: DEFAULT_WORKSPACE_TOOL_LIMITS },
          "sample.pdfish",
          "auto",
          aborted.signal,
        ),
      (error) => error.code === "aborted",
    );
    assert.equal(collected.length, 1, "no second parse was started");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C6-18: PDF is read-only and no write path can claim it", async () => {
  const root = await binaryFixture();
  try {
    const registry = createDocumentAdapterRegistry(DEFAULT_DOCUMENT_ADAPTERS);
    const pdf = registry.select("doc.pdf", "auto");
    assert.equal(pdf.id, "pdf");
    // Read-only: the adapter itself declares no write capability.
    assert.equal(pdf.write, false);
    assert.equal(registry.select("doc.pdf", "pdf").write, false);

    // The write registry must not expose any PDF mutation.
    const writes = createWorkspaceWriteTools();
    assert.deepEqual(writes.map((entry) => entry.name).sort(), ["workspace.edit", "workspace.write"]);
    for (const entry of writes) {
      assert.equal(/pdf/i.test(JSON.stringify(entry.parameters)), false, entry.name);
    }

    // Attempting to route PDF content through the write path is refused.
    const environment = (await resolveTaskWorkspace({ workspaceHint: root })).environment;
    await assert.rejects(
      () =>
        validateDocumentText({
          documentRegistry: registry,
          limits: DEFAULT_WORKSPACE_TOOL_LIMITS,
          path: "doc.pdf",
          format: "pdf",
          text: "replacement content",
        }),
      (error) => error.code === "unsupported_format",
    );

    // Bytes that are not a PDF at all are rejected as unreadable, not guessed.
    await writeFile(join(root, "broken.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0xfe]));
    await assert.rejects(
      () =>
        readDocument(
          {
            workspace: environment,
            documentRegistry: registry,
            limits: DEFAULT_WORKSPACE_TOOL_LIMITS,
          },
          "broken.pdf",
          "auto",
        ),
      (error) => error.code === "invalid_document",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an invalid adapter extension declaration", () => {
  assert.throws(
    () =>
      createDocumentAdapterRegistry([
        { ...structuredAdapter(), extensions: ["pdf"] },
      ]),
    AsideContractError,
  );
  assert.throws(
    () =>
      createDocumentAdapterRegistry([
        { ...structuredAdapter(), extensions: ".pdf" },
      ]),
    AsideContractError,
  );
  assert.throws(
    () =>
      createDocumentAdapterRegistry([
        { ...structuredAdapter(), extensions: [".PDF"] },
      ]),
    AsideContractError,
  );
});

// --- Cycle 6 P3: model-facing descriptions and search routing --------------

test("the read description tells the model that PDF is supported", () => {
  const tools = createWorkspaceReadTools();
  const read = tools.find((tool) => tool.name === "workspace.read");
  const search = tools.find((tool) => tool.name === "workspace.search");

  // The model decides what it can do from these strings. When the PDF adapter
  // landed without updating them, the model correctly reported that it had no
  // PDF capability.
  assert.match(read.description, /PDF/i);
  assert.match(read.description, /no images, no OCR/i);
  assert.match(read.description, /docx/i);
  assert.match(String(read.parameters.properties.format.description), /pdf/i);
  assert.match(String(read.parameters.properties.format.description), /docx/i);
  assert.match(String(read.parameters.properties.pages.description), /PDF/i);
  // Search must not promise content it will not scan.
  assert.match(search.description, /PDF/i);
  assert.match(search.description, /not searched|listed by name/i);
  for (const tool of tools) {
    assert.ok(
      Buffer.byteLength(tool.description, "utf8") <= 800,
      `${tool.name} description stays inside the contract bound`,
    );
  }
});

test("content search skips a PDF instead of failing the whole search", async () => {
  const root = await mkdtemp(join(tmpdir(), "aside-search-binary-"));
  try {
    await writeFile(join(root, "notes.txt"), "alpha needle here\n", "utf8");
    await writeFile(join(root, "report.pdf"), buildPdf([["beta needle in a pdf"]]));
    const { implementation } = await bindTool(root, "workspace.search");

    const content = await implementation.execute("search-content", {
      query: "needle",
      mode: "content",
    });
    assert.equal(content.details.status, "succeeded");
    assert.deepEqual(
      content.details.results.map((result) => result.path),
      ["notes.txt"],
      "the text file matches and the PDF does not",
    );
    assert.deepEqual(content.details.diagnostics, [
      { path: "report.pdf", code: "unsupported_format" },
    ]);

    // Name search still sees it: the file is listed, only its content is not read.
    const byName = await implementation.execute("search-name", {
      query: "report",
      mode: "name",
    });
    assert.deepEqual(byName.details.results.map((result) => result.path), ["report.pdf"]);

    const both = await implementation.execute("search-both", {
      query: "needle",
      mode: "both",
    });
    assert.equal(both.details.status, "succeeded");
    assert.deepEqual(both.details.results.map((result) => result.path), ["notes.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C6-16: the read tool renders PDF pages with a page continuation", async () => {
  const root = await mkdtemp(join(tmpdir(), "aside-pdf-tool-"));
  try {
    await writeFile(join(root, "long.pdf"), buildLargePdf(30));
    const limits = { ...DEFAULT_WORKSPACE_TOOL_LIMITS, maxOutputBytes: 900 };
    const { implementation } = await bindTool(root, "workspace.read", { limits });

    const first = await implementation.execute("pdf-1", { path: "long.pdf" });
    assert.equal(first.details.status, "succeeded");
    assert.equal(first.details.format, "pdf");
    assert.equal(first.details.page_count, 30);
    assert.equal(first.details.truncated, true);
    assert.equal(Number.isSafeInteger(first.details.next_page), true);
    assert.match(resultText(first), /--- page 1 ---/);

    const next = await implementation.execute("pdf-2", {
      path: "long.pdf",
      pages: `${first.details.next_page}-${first.details.next_page + 1}`,
    });
    assert.equal(next.details.status, "succeeded");
    assert.match(resultText(next), new RegExp(`--- page ${first.details.next_page} ---`));
    assert.equal(next.details.pages_read, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
