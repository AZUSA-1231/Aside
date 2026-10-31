import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core/aside";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { McpController } from "../src/mcp-adapter.mjs";
import { validateServerConfig } from "../src/mcp-config.mjs";
import { createConversationRuntime } from "../src/runtime.mjs";
import { createDocxAdapter, MAX_DOCX_BLOCKS, MAX_DOCX_CELL_BYTES, MAX_DOCX_TABLE_COLUMNS, MAX_DOCX_TABLE_ROWS } from "../src/docx-adapter.mjs";
import { createPdfAdapter, MAX_PDF_BLOCKS } from "../src/pdf-adapter.mjs";
import { createWorkspaceReadTools } from "../src/workspace-tools.mjs";
import { resolveTaskWorkspace } from "../src/workspace.mjs";
import { buildDocx } from "./docx-fixtures.mjs";
import { buildPdf } from "./pdf-fixtures.mjs";

async function withReader(path, bytes, action, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "aside-r2-"));
  try {
    await writeFile(join(root, path), bytes);
    const workspace = (await resolveTaskWorkspace({ workspaceHint: root })).environment;
    const definition = createWorkspaceReadTools({ ...options, limits: { maxOutputBytes: 2_048 } })
      .find((entry) => entry.name === "workspace.read");
    const reader = await definition.createForRun({ workspace });
    await action(reader, root, definition);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("R2 A01: unsafe page ranges terminate in an isolated process", () => {
  const moduleUrl = new URL("../src/pdf-adapter.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from 'node:assert/strict';
    import { parsePageRange } from ${JSON.stringify(moduleUrl)};
    for (const value of ['9007199254740992', '1-9007199254740992', '999999999999999999999999999999']) {
      assert.throws(() => parsePageRange(value), error => error.code === 'invalid_page_range');
    }
    assert.deepEqual(parsePageRange(String(Number.MAX_SAFE_INTEGER)).pages, [Number.MAX_SAFE_INTEGER]);
  `], { encoding: "utf8", timeout: 5_000, windowsHide: true });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});

for (const maxResults of [2, 4]) {
  test(`R2 A10: search exhausts directory pages and scan budgets with ${maxResults} results per call`, async () => {
    await withReader("seed.txt", "seed", async (_reader, root) => {
      await mkdir(join(root, "nested"));
      const expected = [];
      for (let index = 0; index < 13; index += 1) {
        const name = `match-${String(index).padStart(2, "0")}.txt`;
        const path = index % 2 ? join("nested", name) : name;
        expected.push(path.replaceAll("\\", "/"));
        await writeFile(join(root, path), "fixture");
      }
      const workspace = (await resolveTaskWorkspace({ workspaceHint: root })).environment;
      const definition = createWorkspaceReadTools({ limits: { maxListEntries: 3, maxSearchFiles: 4, maxSearchResults: maxResults } })
        .find((entry) => entry.name === "workspace.search");
      const search = await definition.createForRun({ workspace });
      const found = [];
      let offset;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const result = await search.execute(`search-${attempt}`, { query: "match-", mode: "name", scanned_offset: offset });
        assert.equal(result.details.status, "succeeded");
        found.push(...result.details.results.map((entry) => entry.path));
        if (!result.details.truncated) break;
        assert.ok(result.details.next_scanned_offset > (offset ?? 0), "the search cursor stopped making progress");
        offset = result.details.next_scanned_offset;
      }
      assert.deepEqual(found.toSorted(), expected.toSorted());
    });
  });
}

test("R2 A08: bounded warning details preserve the public document cursor", async () => {
  const adapter = createPdfAdapter({
    load: async () => ({
      promise: Promise.resolve({
        numPages: 700,
        getPage: async (pageNumber) => ({ getTextContent: async () => ({ items: pageNumber % 2 ? [] : [{ str: `page ${pageNumber}`, transform: [1, 0, 0, 1, 0, 700] }] }) }),
        getMetadata: async () => ({ info: {} }), destroy: async () => {},
      }), destroy() {},
    }),
  });
  await withReader("warnings.pdf", new Uint8Array([37, 80, 68, 70]), async (reader) => {
    const result = await reader.execute("warnings", { path: "warnings.pdf" });
    assert.equal(result.details.status, "succeeded");
    assert.equal(typeof result.details.content_version, "string");
    assert.ok(Number.isSafeInteger(result.details.next_block));
    assert.equal(result.details.warning_count, 351);
    assert.equal(result.details.warnings_truncated, true);
  }, { documentAdapters: [adapter] });
});

async function readEverySegment(reader, path) {
  const parts = [];
  let cursor = { block_offset: 0, block_byte_offset: 0 };
  let version;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await reader.execute(`segment-${attempt}`, { path, ...cursor, content_version: version });
    assert.equal(result.details.status, "succeeded", JSON.stringify(result.details));
    const text = result.content.map((block) => block.text ?? "").join("\n");
    assert.ok(Buffer.byteLength(text) <= 2_048);
    const separator = text.indexOf("\n\n");
    assert.ok(separator > 0, "the model-visible header and content must both be present");
    parts.push(text.slice(separator + 2));
    assert.equal(typeof result.details.content_version, "string");
    version ??= result.details.content_version;
    if (!result.details.truncated) return parts.join("");
    const next = {
      block_offset: result.details.next_block,
      block_byte_offset: result.details.next_block_byte_offset ?? 0,
    };
    assert.ok(Number.isSafeInteger(next.block_offset), "a cut result needs a usable block cursor");
    assert.ok(next.block_offset > cursor.block_offset
      || (next.block_offset === cursor.block_offset && next.block_byte_offset > cursor.block_byte_offset),
    `the public read cursor did not advance: ${JSON.stringify({ cursor, next })}`);
    cursor = next;
  }
  assert.fail("the public read path never reached the end");
}

test("R2 A07: the public Word read API exhausts long Unicode blocks without loss or repetition", async () => {
  const paragraph = `BEGIN_WORD_${"\u6bb5\u843d\ud83d\ude00".repeat(1_400)}_END_WORD`;
  await withReader("long.docx", buildDocx([
    { type: "paragraph", text: paragraph },
    { type: "table", rows: [["AFTER_LONG_CELL", "FINAL_CELL"]] },
  ]), async (reader, _root, definition) => {
    assert.ok(definition.parameters.properties.block_offset, "the cursor must be in the model's schema");
    assert.ok(definition.parameters.properties.block_byte_offset);
    const delivered = await readEverySegment(reader, "long.docx");
    assert.ok(delivered.includes(paragraph), "some bytes inside the long block were lost or duplicated");
    for (const marker of ["BEGIN_WORD_", "_END_WORD", "AFTER_LONG_CELL", "FINAL_CELL"]) {
      assert.equal(delivered.split(marker).length - 1, 1, marker);
    }
  });
});

test("R2 A07: the public PDF read API exhausts cuts within pages and following pages", async () => {
  const pages = Array.from({ length: 8 }, (_, pageIndex) =>
    Array.from({ length: 25 }, (_, lineIndex) => `PAGE_${pageIndex}_LINE_${lineIndex}_END`));
  await withReader("long.pdf", buildPdf(pages), async (reader) => {
    const delivered = await readEverySegment(reader, "long.pdf");
    for (const marker of pages.flat()) {
      assert.equal(delivered.split(marker).length - 1, 1, marker);
    }
  });
});

test("R2 A03/A04: Word table cells and the real MCP adapter reach a subsequent provider request", async () => {
  const root = await mkdtemp(join(tmpdir(), "aside-r2-provider-"));
  const controller = new McpController({
    servers: [validateServerConfig({ id: "recheck", display_name: "Recheck", command: process.execPath, enabled: true, trust_acknowledged: true })],
    connectionFactory: async () => ({
      state: "ready",
      listTools: async () => [{ name: "lookup", description: "Look up a fixture.", inputSchema: { type: "object", properties: {} } }],
      callTool: async () => ({ content: [{ type: "text", text: "PROVIDER_MCP_BODY" }], structuredContent: { value: "PROVIDER_STRUCTURED_BODY" } }),
      close: async () => {},
    }),
  });
  let runtime;
  try {
    await writeFile(join(root, "table.docx"), buildDocx([{ type: "table", rows: [["PROVIDER_CELL_ONE", "PROVIDER_CELL_TWO"]] }]));
    const [external] = await controller.tools();
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    let checkedProviderInput = false;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(external.name, {}, { id: "external-call" })),
      fauxAssistantMessage(fauxToolCall("workspace.read", { path: "table.docx" }, { id: "word-call" })),
      (context) => {
        const visible = JSON.stringify(context.messages.filter((message) => message.role === "toolResult").map((message) => message.content));
        for (const marker of ["PROVIDER_MCP_BODY", "PROVIDER_STRUCTURED_BODY", "PROVIDER_CELL_ONE", "PROVIDER_CELL_TWO"]) {
          assert.ok(visible.includes(marker), `${marker} was absent from provider-visible content`);
        }
        checkedProviderInput = true;
        return fauxAssistantMessage("verified");
      },
    ]);
    const agent = new Agent({
      initialState: { systemPrompt: "Read the fixtures.", model: faux.getModel(), thinkingLevel: "off", tools: [] },
      streamFn: models.streamSimple.bind(models), convertToLlm: (messages) => messages,
    });
    runtime = await createConversationRuntime({
      agent, tools: createWorkspaceReadTools(), mcp: { toolFactory: () => controller.tools() },
      emit: (event) => {
        if (event.type === "permission_requested") runtime.resolvePermission(event.permission_id, "allow", {
          request_id: event.request_id, task_id: event.task_id, tool_call_id: event.tool_call_id,
        });
      },
    });
    await runtime.prompt("r2-provider", "Read the fixtures", undefined, root);
    assert.equal(checkedProviderInput, true, "the provider never received both tool results");
  } finally {
    runtime?.dispose();
    await controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("R2 A10: a structured continuation is bound to the original file version", async () => {
  await withReader("changing.docx", buildDocx([{ type: "paragraph", text: "A".repeat(10_000) }]), async (reader, root) => {
    const first = await reader.execute("before", { path: "changing.docx" });
    assert.equal(first.details.truncated, true);
    assert.equal(typeof first.details.content_version, "string");
    await writeFile(join(root, "changing.docx"), buildDocx([{ type: "paragraph", text: "B".repeat(11_000) }]));
    const next = await reader.execute("after", {
      path: "changing.docx", block_offset: first.details.next_block,
      block_byte_offset: first.details.next_block_byte_offset ?? 0,
      content_version: first.details.content_version,
    });
    assert.equal(next.details.code, "stale_content");
  });
});

test("R2 A08: a PDF cut within its last page reports partial extraction and actual progress", async () => {
  let loadedPages = 0;
  const adapter = createPdfAdapter({
    load: async () => ({
      promise: Promise.resolve({
        numPages: 1,
        async getPage() {
          loadedPages += 1;
          return { getTextContent: async () => ({ items: Array.from({ length: MAX_PDF_BLOCKS + 5 }, (_, index) => ({ str: `LINE_${index}`, transform: [1, 0, 0, 1, 0, index] })) }) };
        },
        getMetadata: async () => ({ info: {} }), destroy: async () => {},
      }), destroy() {},
    }),
  });
  const document = await adapter.read({ bytes: new Uint8Array(), path: "dense.pdf" });
  assert.equal(document.partial, true);
  assert.equal(document.truncated, true);
  assert.equal(document.blocks.length, MAX_PDF_BLOCKS);
  assert.equal(loadedPages, 1);
  assert.equal(document.metadata.pages_read, loadedPages);
  assert.ok(document.warnings.some((warning) => warning.code === "block_limit" && warning.page === 1));
});

test("R2 A08: an exact PDF block boundary is complete", async () => {
  const adapter = createPdfAdapter({ load: async () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({ getTextContent: async () => ({ items: Array.from({ length: MAX_PDF_BLOCKS - 1 }, (_, index) => ({ str: `LINE_${index}`, transform: [1, 0, 0, 1, 0, index] })) }) }),
      getMetadata: async () => ({ info: {} }), destroy: async () => {},
    }), destroy() {},
  }) });
  const document = await adapter.read({ bytes: new Uint8Array(), path: "boundary.pdf" });
  assert.equal(document.blocks.length, MAX_PDF_BLOCKS);
  assert.equal(document.partial, false);
  assert.equal(document.truncated, false);
  assert.deepEqual(document.warnings, []);
});

test("R2 A08: a Word page break and empty heading cannot exceed the block ceiling", async () => {
  const blocks = Array.from({ length: MAX_DOCX_BLOCKS - 1 }, (_, index) => ({ type: "paragraph", text: `Paragraph ${index}` }));
  blocks.push({ type: "raw", xml: '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:br w:type="page"/></w:r></w:p>' });
  const document = await createDocxAdapter().read({ bytes: buildDocx(blocks), path: "blocks.docx" });
  assert.equal(document.blocks.length, MAX_DOCX_BLOCKS);
  assert.equal(document.partial, true);
  assert.ok(document.warnings.some((warning) => warning.code === "block_limit"));
});

for (const [kind, rows, code] of [
  ["rows", Array.from({ length: MAX_DOCX_TABLE_ROWS + 1 }, () => ["cell"]), "table_row_limit"],
  ["columns", [Array.from({ length: MAX_DOCX_TABLE_COLUMNS + 1 }, () => "cell")], "table_column_limit"],
  ["cell bytes", [["\u6c49\ud83d\ude00".repeat(MAX_DOCX_CELL_BYTES)]], "table_cell_limit"],
]) {
  test(`R2 A08: a Word table cut by ${kind} reports the reason`, async () => {
    const document = await createDocxAdapter().read({ bytes: buildDocx([{ type: "table", rows }]), path: "table.docx" });
    assert.equal(document.partial, true);
    assert.equal(document.truncated, true);
    assert.equal(document.blocks[0].truncated, true);
    assert.ok(document.warnings.some((warning) => warning.code === code), JSON.stringify(document.warnings));
    for (const row of document.blocks[0].rows) {
      for (const cell of row) assert.ok(Buffer.byteLength(cell) <= MAX_DOCX_CELL_BYTES);
    }
  });
}
