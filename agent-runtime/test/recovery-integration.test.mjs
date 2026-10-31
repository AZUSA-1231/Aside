import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core/aside";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createDocumentTools } from "../src/docx-tools.mjs";
import { createConversationRuntime } from "../src/runtime.mjs";
import { createWorkspaceReadTools } from "../src/workspace-tools.mjs";
import { createWorkspaceWriteTools } from "../src/workspace-write-tools.mjs";
import { resolveTaskWorkspace } from "../src/workspace.mjs";
import { buildDocx, buildFidelityDocx } from "./docx-fixtures.mjs";
import { buildPdf } from "./pdf-fixtures.mjs";

async function withWorkspace(action) {
  const root = resolve(await mkdtemp(join(tmpdir(), "aside-r3-integration-")));
  try {
    await action(root);
  } finally {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
}

function capturedSelection(root, filename) {
  return {
    flow: { id: "r3-capture-flow", kind: "conversation" },
    blocks: [],
    attachments: [{
      id: "r3-capture", host: "explorer", source: "Explorer",
      capturedAt: Date.now(), expiresAt: Date.now() + 60_000,
      sensitivity: "local_metadata", summary: "R3_CAPTURE_SELECTION",
      blocks: [{ type: "text", text: "R3_CAPTURE_SELECTION" }],
      descriptors: [
        { role: "directory", path: root, kind: "directory" },
        { role: "selected_item", path: join(root, filename), kind: "file" },
      ],
    }],
  };
}

function providerText(context, callId) {
  const result = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === callId);
  assert.ok(result, `the provider never received ${callId}`);
  return result.content.map((block) => block.text ?? "").join("\n");
}

function readHeader(text) {
  return JSON.parse(text.slice(text.indexOf("\n") + 1, text.indexOf("\n\n")));
}

async function runWorkflow(root, filename, responses, { tools, decision = "allow", onPermission } = {}) {
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const agent = new Agent({
    initialState: { systemPrompt: "Use the selected document and report limitations honestly.", model: faux.getModel(), thinkingLevel: "off", tools: [] },
    streamFn: models.streamSimple.bind(models), convertToLlm: (messages) => messages,
  });
  const events = [];
  let runtime;
  try {
    runtime = await createConversationRuntime({
      agent,
      tools: tools ?? [...createWorkspaceReadTools(), ...createWorkspaceWriteTools(), ...createDocumentTools()],
      emit: (event) => {
        events.push(event);
        if (event.type === "permission_requested") {
          onPermission?.(event);
          runtime.resolvePermission(event.permission_id, decision, {
            request_id: event.request_id, task_id: event.task_id, tool_call_id: event.tool_call_id,
          });
        }
      },
    });
    await runtime.prompt("r3-workflow", "Use my captured selection for this document task.", capturedSelection(root, filename));
    const terminal = events.filter((event) => ["completed", "cancelled", "failed"].includes(event.type));
    assert.deepEqual(terminal.map((event) => event.type), ["completed"], JSON.stringify(terminal));
    const environment = events.find((event) => event.type === "workspace_resolved")?.workspace;
    assert.equal(environment?.canonical_path, root);
    assert.equal(environment.source, "descriptor_handoff");
    assert.equal(environment.target.relative_path, filename);
    return {
      events,
      text: events.filter((event) => event.type === "text_delta").map((event) => event.delta).join(""),
    };
  } finally {
    runtime?.dispose();
  }
}

test("R3 INT-02: captured PDF selection reaches summary and page-cited Q&A through provider-visible content", async () => {
  await withWorkspace(async (root) => {
    await writeFile(join(root, "report.pdf"), buildPdf([["SUMMARY_ALPHA launch approved"], ["BUDGET_BETA 42 units"]]));
    let checked = false;
    const answer = "Launch approved (page 1). The budget is 42 units (page 2).";
    const result = await runWorkflow(root, "report.pdf", [
      (context) => {
        assert.ok(JSON.stringify(context.messages).includes("R3_CAPTURE_SELECTION"));
        return fauxAssistantMessage(fauxToolCall("workspace.read", { path: "report.pdf" }, { id: "pdf-read" }));
      },
      (context) => {
        const text = providerText(context, "pdf-read");
        assert.match(text, /--- page 1 ---[\s\S]*SUMMARY_ALPHA[\s\S]*--- page 2 ---[\s\S]*BUDGET_BETA/);
        assert.equal(readHeader(text).partial, false);
        checked = true;
        return fauxAssistantMessage(answer);
      },
    ]);
    assert.equal(checked, true);
    assert.equal(result.text, answer);
    assert.equal(result.events.some((event) => event.type === "permission_requested"), false);
  });
});

test("R3 INT-02: a partial PDF exposes missing-text warnings before the final answer", async () => {
  await withWorkspace(async (root) => {
    await writeFile(join(root, "partial.pdf"), buildPdf([["VISIBLE_PAGE_ONE"], []]));
    let checked = false;
    const result = await runWorkflow(root, "partial.pdf", [
      fauxAssistantMessage(fauxToolCall("workspace.read", { path: "partial.pdf" }, { id: "partial-read" })),
      (context) => {
        const text = providerText(context, "partial-read");
        assert.match(text, /VISIBLE_PAGE_ONE/);
        assert.equal(readHeader(text).partial, true);
        assert.ok(readHeader(text).warning_codes.includes("page_without_text"));
        checked = true;
        return fauxAssistantMessage("Only page 1 has readable text; page 2 needs another source or OCR.");
      },
    ]);
    assert.equal(checked, true);
    assert.match(result.text, /Only page 1/);
    const read = result.events.find((event) => event.type === "tool_result");
    assert.equal(read.details.partial, true);
    assert.equal(read.details.page_count, 2);
    assert.ok(read.details.warnings.some((warning) => warning.code === "page_without_text"));
  });
});

test("R3 INT-02: the provider resumes a truncated PDF using only its public content cursor", async () => {
  await withWorkspace(async (root) => {
    const pages = Array.from({ length: 2 }, (_, page) => Array.from({ length: 30 }, (_, line) => `BODY_${page}_${line.toString().padStart(2, "0")}_${"x".repeat(24)}`));
    pages[0][0] = "FIRST_MARKER";
    pages[1][29] = "LAST_MARKER";
    await writeFile(join(root, "long.pdf"), buildPdf(pages));
    let checked = false;
    const result = await runWorkflow(root, "long.pdf", [
      fauxAssistantMessage(fauxToolCall("workspace.read", { path: "long.pdf" }, { id: "first-read" })),
      (context) => {
        const text = providerText(context, "first-read");
        const header = readHeader(text);
        assert.equal(header.partial, true);
        assert.equal(header.truncated, true);
        assert.ok(Number.isSafeInteger(header.next_block));
        return fauxAssistantMessage(fauxToolCall("workspace.read", {
          path: "long.pdf", block_offset: header.next_block,
          block_byte_offset: header.next_block_byte_offset ?? 0, content_version: header.content_version,
        }, { id: "next-read" }));
      },
      (context) => {
        assert.match(providerText(context, "first-read"), /FIRST_MARKER/);
        const text = providerText(context, "next-read");
        assert.match(text, /LAST_MARKER/);
        assert.equal(readHeader(text).truncated, false);
        checked = true;
        return fauxAssistantMessage("Both the beginning and the final marker were read.");
      },
    ], { tools: createWorkspaceReadTools({ limits: { maxOutputBytes: 2_048 } }) });
    assert.equal(checked, true);
    assert.match(result.text, /final marker/);
    assert.equal(result.events.filter((event) => event.type === "tool_result").length, 2);
  });
});

test("R3 INT-02: read-only document edits and writes refuse auto and explicit text before approval", async () => {
  await withWorkspace(async (root) => {
    for (const [filename, source] of [
      ["source.pdf", buildPdf([["ORIGINAL_SOURCE"]])],
      ["source.docx", buildDocx([{ type: "paragraph", text: "ORIGINAL_SOURCE" }])],
    ]) {
      await writeFile(join(root, filename), source);
      for (const tool of ["workspace.edit", "workspace.write"]) {
        for (const format of ["auto", "text"]) {
          let checked = false;
          const params = tool === "workspace.edit"
            ? { path: filename, format, old_text: "ORIGINAL_SOURCE", new_text: "changed" }
            : { path: filename, format, content: "replacement text" };
          const result = await runWorkflow(root, filename, [
            fauxAssistantMessage(fauxToolCall(tool, params, { id: "readonly-mutation" })),
            (context) => {
              assert.match(providerText(context, "readonly-mutation"), /unsupported_format/, `${filename} ${tool} ${format}`);
              checked = true;
              return fauxAssistantMessage("This format needs its document capability; the source was preserved.");
            },
          ]);
          assert.equal(checked, true);
          assert.equal(result.events.some((event) => event.type === "permission_requested"), false);
          assert.equal(result.events.find((event) => event.type === "tool_result").status, "unsupported");
          assert.deepEqual(await readFile(join(root, filename)), source);
        }
      }
    }
  });
});

test("R3 INT-03: an existing Word document supplies headings and table cells to a summary workflow", async () => {
  await withWorkspace(async (root) => {
    await writeFile(join(root, "report.docx"), buildDocx([
      { type: "heading", level: 1, text: "WORD_SUMMARY_TITLE" },
      { type: "paragraph", text: "The milestone is complete." },
      { type: "table", rows: [["WORD_TABLE_METRIC", "73 percent"]] },
    ]));
    let checked = false;
    const result = await runWorkflow(root, "report.docx", [
      fauxAssistantMessage(fauxToolCall("workspace.read", { path: "report.docx" }, { id: "word-read" })),
      (context) => {
        const text = providerText(context, "word-read");
        for (const marker of ["WORD_SUMMARY_TITLE", "milestone is complete", "WORD_TABLE_METRIC", "73 percent"]) assert.ok(text.includes(marker), marker);
        checked = true;
        return fauxAssistantMessage("The milestone is complete, with the reported metric at 73 percent.");
      },
    ]);
    assert.equal(checked, true);
    assert.match(result.text, /73 percent/);
  });
});

for (const decision of ["allow", "deny"]) {
  test(`R3 INT-03: Word fidelity warnings reach the provider and ${decision} transformation preview`, async () => {
    await withWorkspace(async (root) => {
      const source = buildFidelityDocx();
      await writeFile(join(root, "source.docx"), source);
      let checked = false;
      let previewChecked = false;
      const result = await runWorkflow(root, "source.docx", [
        fauxAssistantMessage(fauxToolCall("workspace.read", { path: "source.docx" }, { id: "word-source" })),
        (context) => {
          const text = providerText(context, "word-source");
          assert.match(text, /kept text/);
          const header = readHeader(text);
          assert.equal(header.partial, true);
          for (const warning of ["tracked_changes", "drawings", "comments"]) assert.ok(header.warning_codes.includes(warning), warning);
          return fauxAssistantMessage(fauxToolCall("document.transform", {
            path: "source.docx", output_path: "summary.docx",
            document: { blocks: [{ type: "paragraph", text: "Summary from extracted text; drawings and tracked changes require review." }] },
          }, { id: "word-transform" }));
        },
        (context) => {
          assert.match(providerText(context, "word-transform"), decision === "allow" ? /succeeded/ : /denied/);
          checked = true;
          return fauxAssistantMessage(decision === "allow" ? "Saved summary.docx with fidelity limitations; the source was preserved." : "Permission denied; no summary file was created.");
        },
      ], {
        decision,
        onPermission: (event) => {
          assert.equal(event.operation, "document.transform");
          assert.equal(event.preview.source_path, "source.docx");
          assert.equal(event.preview.output_path, "summary.docx");
          for (const warning of ["tracked_changes", "drawings", "comments"]) assert.ok(event.preview.source_fidelity_warnings.includes(warning), warning);
          previewChecked = true;
        },
      });
      assert.equal(checked, true);
      assert.equal(previewChecked, true);
      assert.equal(result.events.filter((event) => event.type === "permission_requested").length, 1);
      assert.deepEqual(await readFile(join(root, "source.docx")), source);
      const transformed = result.events.find((event) => event.type === "tool_result" && event.tool_call_id === "word-transform");
      assert.equal(transformed.status, decision === "allow" ? "succeeded" : "denied");
      if (decision === "allow") {
        assert.equal(transformed.details.output_path, "summary.docx");
        assert.equal(transformed.details.verification.status, "verified");
        assert.equal(transformed.details.source_preserved, true);
        assert.ok(result.events.some((event) => event.type === "verification_completed"));
        const workspace = (await resolveTaskWorkspace({ workspaceHint: root })).environment;
        const read = await createWorkspaceReadTools().find((entry) => entry.name === "workspace.read").createForRun({ workspace });
        const reopened = await read.execute("reopen-summary", { path: "summary.docx" });
        assert.equal(reopened.details.status, "succeeded");
        assert.match(reopened.content[0].text, /drawings and tracked changes require review/);
      } else {
        await assert.rejects(readFile(join(root, "summary.docx")), { code: "ENOENT" });
        assert.equal(result.events.some((event) => event.type === "verification_completed"), false);
      }
    });
  });
}

test("R3 INT-01: search reviews literal queries, case folding, hidden files, and UTF-8 refusal", async () => {
  await withWorkspace(async (root) => {
    await mkdir(join(root, "ignored"));
    await writeFile(join(root, ".gitignore"), "ignored/\n");
    await writeFile(join(root, ".hidden.txt"), "MiXeD Needle");
    await writeFile(join(root, "ignored", "file.txt"), "mixed needle");
    await writeFile(join(root, "legacy.txt"), Buffer.from([0xff, 0xfe, 0x41, 0x00]));
    const workspace = (await resolveTaskWorkspace({ workspaceHint: root })).environment;
    const tools = createWorkspaceReadTools();
    const search = await tools.find((entry) => entry.name === "workspace.search").createForRun({ workspace });
    const found = await search.execute("review-case", { query: "MIXED NEEDLE", mode: "content" });
    assert.equal(found.details.status, "succeeded");
    assert.deepEqual(found.details.results.map((entry) => entry.path).toSorted(), [".hidden.txt", "ignored/file.txt"]);
    assert.ok(found.details.diagnostics.some((entry) => entry.path === "legacy.txt" && entry.code === "unsupported_encoding"));
    const literal = await search.execute("review-literal", { query: "*.txt", mode: "name" });
    assert.equal(literal.details.result_count, 0);
    const read = await tools.find((entry) => entry.name === "workspace.read").createForRun({ workspace });
    const refused = await read.execute("review-encoding", { path: "legacy.txt" });
    assert.equal(refused.details.code, "unsupported_encoding");
    const casePath = await read.execute("review-windows-case", { path: ".HIDDEN.TXT" });
    if (process.platform === "win32") assert.equal(casePath.details.status, "succeeded");
  });
});

test("R3 INT-01: both-mode search retains a binary document's name match without parsing its content", async () => {
  await withWorkspace(async (root) => {
    await writeFile(join(root, "needle.pdf"), buildPdf([["BINARY_ONLY_TEXT"]]));
    await writeFile(join(root, "needle.docx"), buildDocx([{ type: "paragraph", text: "BINARY_ONLY_TEXT" }]));
    const workspace = (await resolveTaskWorkspace({ workspaceHint: root })).environment;
    const search = await createWorkspaceReadTools().find((entry) => entry.name === "workspace.search").createForRun({ workspace });
    const result = await search.execute("binary-names", { query: "NEEDLE", mode: "both" });
    assert.equal(result.details.status, "succeeded");
    assert.deepEqual(result.details.results.map((entry) => entry.path).toSorted(), ["needle.docx", "needle.pdf"]);
    assert.ok(result.details.results.every((entry) => entry.matches.length === 1 && entry.matches[0].type === "name"));
    assert.equal(result.details.diagnostics.filter((entry) => entry.code === "unsupported_format").length, 2);
  });
});
