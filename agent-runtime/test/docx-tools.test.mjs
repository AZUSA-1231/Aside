import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createDocumentTools } from "../src/docx-tools.mjs";
import { PermissionBroker } from "../src/permission-broker.mjs";
import { resolveTaskWorkspace } from "../src/workspace.mjs";
import { DEFAULT_WORKSPACE_WRITE_LIMITS } from "../src/workspace-write-tools.mjs";

const SPEC = Object.freeze({
  title: "Generated report",
  blocks: [
    { type: "heading", level: 1, text: "Generated report" },
    { type: "paragraph", runs: [{ text: "Revenue " }, { text: "up", bold: true }] },
    { type: "list", ordered: true, items: ["alpha", "beta"] },
    { type: "list", ordered: false, items: ["bullet"] },
    { type: "table", rows: [["A", "B"], ["1", "2"]] },
    { type: "page_break" },
    { type: "heading", level: 2, text: "Appendix" },
  ],
});

async function fixture() {
  const root = resolve(await mkdtemp(join(tmpdir(), "aside-docx-tools-")));
  const environment = (await resolveTaskWorkspace({ workspaceHint: root })).environment;
  return { root, environment };
}

/**
 * Binds a document tool with a broker decided by `decision`. The decision is
 * applied from the event stream, which is the same path a real UI drives.
 */
async function bindDocumentTool(root, environment, name, { decision = "allow", onPermission } = {}) {
  const events = [];
  const broker = new PermissionBroker({
    emit: (event) => {
      events.push(event);
      if (event.type === "permission_requested") {
        onPermission?.(event);
        broker.resolve(event.permission_id, decision, {
          request_id: event.request_id,
          task_id: event.task_id,
          tool_call_id: event.tool_call_id,
        });
      }
    },
    maxPendingMs: 5_000,
  });
  const tool = createDocumentTools({ limits: DEFAULT_WORKSPACE_WRITE_LIMITS })
    .find((entry) => entry.name === name);
  const implementation = await tool.createForRun({
    workspace: environment,
    taskRun: { request_id: "req-1", task_id: "task-1", limits: { maxPendingPermissionMs: 5_000 } },
    permissionBroker: broker,
    emit: (event) => events.push(event),
  });
  return { implementation, events, broker };
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test("C6-22: creates a valid .docx and verifies it by reopening", async () => {
  const { root, environment } = await fixture();
  try {
    const { implementation, events } = await bindDocumentTool(root, environment, "document.create");
    const result = await implementation.execute("create-1", { path: "report.docx", document: SPEC });

    assert.equal(result.details.status, "succeeded");
    assert.equal(result.isError, false);
    assert.equal(result.details.operation, "create");
    assert.equal(result.details.output_path, "report.docx");

    // The reopen is the evidence: a digest match would prove only that bytes
    // were copied, not that the package is a readable document.
    assert.equal(result.details.verification.status, "verified");
    assert.deepEqual(result.details.verification.structure, {
      headings: 2,
      paragraphs: 1,
      list_items: 3,
      tables: 1,
      page_breaks: 1,
    });

    // The permission preview stated the structure before the decision.
    const requested = events.find((event) => event.type === "permission_requested");
    assert.equal(requested.effect, "write");
    assert.equal(requested.egress, "none");
    assert.equal(requested.source, "builtin");
    assert.equal(requested.targets[0].state, "new");
    assert.equal(requested.preview.will_overwrite, false);
    assert.equal(requested.preview.structure.headings, 2);

    const written = await readFile(join(root, "report.docx"));
    assert.ok(written.byteLength > 0);
    // A .docx is a ZIP container.
    assert.equal(written[0], 0x50);
    assert.equal(written[1], 0x4b);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C6-23: transforms to a new path and leaves the source untouched", async () => {
  const { root, environment } = await fixture();
  try {
    const create = await bindDocumentTool(root, environment, "document.create");
    await create.implementation.execute("create-1", { path: "source.docx", document: SPEC });
    const sourceBefore = await readFile(join(root, "source.docx"));

    const { implementation, events } = await bindDocumentTool(root, environment, "document.transform");
    const result = await implementation.execute("transform-1", {
      path: "source.docx",
      output_path: "transformed.docx",
      document: {
        title: "Transformed",
        blocks: [
          { type: "heading", level: 1, text: "Transformed" },
          { type: "paragraph", text: "Shorter." },
        ],
      },
    });

    assert.equal(result.details.status, "succeeded");
    assert.equal(result.details.operation, "transform");
    assert.equal(result.details.source_path, "source.docx");
    assert.equal(result.details.source_preserved, true);
    assert.equal(result.details.verification.status, "verified");
    assert.deepEqual(result.details.verification.structure, {
      headings: 1,
      paragraphs: 1,
      list_items: 0,
      tables: 0,
      page_breaks: 0,
    });

    // The source is byte-identical, and the output is a different file.
    assert.deepEqual(await readFile(join(root, "source.docx")), sourceBefore);
    assert.equal(await exists(join(root, "transformed.docx")), true);

    // Fidelity warnings from the source travel into the permission preview.
    const requested = events.find((event) => event.type === "permission_requested");
    assert.deepEqual(requested.preview.source_fidelity_warnings, []);
    assert.equal(requested.preview.source_path, "source.docx");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C6-24: refuses same-path replacement without touching the file", async () => {
  const { root, environment } = await fixture();
  try {
    const create = await bindDocumentTool(root, environment, "document.create");
    await create.implementation.execute("create-1", { path: "doc.docx", document: SPEC });
    const before = await readFile(join(root, "doc.docx"));

    const { implementation, events } = await bindDocumentTool(root, environment, "document.transform");
    const result = await implementation.execute("transform-same", {
      path: "doc.docx",
      output_path: "doc.docx",
      document: SPEC,
    });

    assert.equal(result.isError, true);
    assert.equal(result.details.code, "same_path_replacement");
    assert.deepEqual(await readFile(join(root, "doc.docx")), before, "the file is unchanged");
    // The refusal happens before any permission is requested.
    assert.equal(events.some((event) => event.type === "permission_requested"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C6-24: refuses existing-output overwrite and preserves both files", async () => {
  const { root, environment } = await fixture();
  try {
    await writeFile(join(root, "taken.docx"), "pre-existing bytes", "utf8");
    const { implementation, events } = await bindDocumentTool(root, environment, "document.create");
    const result = await implementation.execute("create-taken", {
      path: "taken.docx",
      document: SPEC,
    });

    assert.equal(result.isError, true);
    assert.equal(result.details.code, "target_exists");
    assert.equal(await readFile(join(root, "taken.docx"), "utf8"), "pre-existing bytes");
    assert.equal(events.some((event) => event.type === "permission_requested"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C6-24: an output that appears after approval is refused, not overwritten", async () => {
  const { root, environment } = await fixture();
  try {
    // The race: the destination is created while the decision is pending.
    const { implementation, events } = await bindDocumentTool(root, environment, "document.create", {
      onPermission: () => undefined,
    });
    // Pre-create the file between preparation and commit by intercepting the
    // rename precondition through a competing write.
    const pending = implementation.execute("create-race", {
      path: "race.docx",
      document: SPEC,
    });
    await writeFile(join(root, "race.docx"), "racing writer", "utf8");
    const result = await pending;

    assert.equal(result.isError, true);
    assert.equal(
      ["stale_target", "target_exists"].includes(result.details.code),
      true,
      `unexpected code ${result.details.code}`,
    );
    assert.equal(await readFile(join(root, "race.docx"), "utf8"), "racing writer");
    assert.equal(
      events.some((event) => event.type === "verification_completed"),
      false,
      "a refused write is never reported as verified",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a denied decision writes nothing and reports the denial", async () => {
  const { root, environment } = await fixture();
  try {
    const { implementation } = await bindDocumentTool(root, environment, "document.create", {
      decision: "deny",
    });
    const result = await implementation.execute("create-denied", {
      path: "denied.docx",
      document: SPEC,
    });

    assert.equal(result.isError, true);
    assert.equal(result.details.status, "denied");
    assert.equal(result.details.code, "permission_denied");
    assert.equal(await exists(join(root, "denied.docx")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C6-25: an invalid specification is refused before any permission", async () => {
  const { root, environment } = await fixture();
  try {
    const cases = [
      [{ blocks: [{ type: "script", text: "x" }] }, "invalid_document_spec"],
      [{ blocks: [{ type: "heading", level: 9, text: "x" }] }, "invalid_document_spec"],
      [{ blocks: [{ type: "link", text: "x", href: "file:///C:/Windows/win.ini" }] }, "invalid_document_spec"],
      [{ blocks: [{ type: "paragraph", text: "x", extra: true }] }, "invalid_document_spec"],
      [{ blocks: [] }, "invalid_document_spec"],
    ];
    for (const [document, code] of cases) {
      const { implementation, events } = await bindDocumentTool(root, environment, "document.create");
      const result = await implementation.execute("create-invalid", { path: "bad.docx", document });
      assert.equal(result.isError, true, JSON.stringify(document));
      assert.equal(result.details.code, code);
      assert.equal(
        events.some((event) => event.type === "permission_requested"),
        false,
        "validation precedes the permission decision",
      );
      assert.equal(await exists(join(root, "bad.docx")), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the output path must be a new .docx inside the workspace", async () => {
  const { root, environment } = await fixture();
  try {
    const { implementation } = await bindDocumentTool(root, environment, "document.create");

    const wrongExtension = await implementation.execute("create-ext", {
      path: "report.txt",
      document: SPEC,
    });
    assert.equal(wrongExtension.details.code, "invalid_argument");

    const escape = await implementation.execute("create-escape", {
      path: "../outside.docx",
      document: SPEC,
    });
    assert.equal(escape.isError, true);
    assert.equal(escape.details.code, "scope_escape");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transforming a non-Word document is refused", async () => {
  const { root, environment } = await fixture();
  try {
    await writeFile(join(root, "notes.txt"), "not a word document\n", "utf8");
    const { implementation } = await bindDocumentTool(root, environment, "document.transform");
    const result = await implementation.execute("transform-txt", {
      path: "notes.txt",
      output_path: "out.docx",
      document: SPEC,
    });
    assert.equal(result.isError, true);
    assert.equal(result.details.code, "unsupported_format");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
