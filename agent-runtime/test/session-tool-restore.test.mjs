import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_RESTORED_TOOL_BYTES,
  MAX_RESTORED_TOOL_CALLS,
  restoreAsideSession,
} from "../src/session.mjs";

/**
 * R1-04a: bounded restore of tool calls already recorded in the session.
 *
 * These exercise the projection directly with a minimal session object. The
 * question under test is what the saved record supports — a status it can
 * prove, a source the namespace enforces, and an honest account of anything
 * the bounds dropped — not how Pi happens to store it.
 */

let sequence = 0;
function entry(message) {
  sequence += 1;
  return { type: "message", id: `entry-${sequence}`, timestamp: sequence, message };
}

const usage = Object.freeze({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const userMessage = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistantText = (text) => ({
  role: "assistant", content: [{ type: "text", text }], api: "faux", provider: "faux", model: "m",
  usage, stopReason: "stop", timestamp: 2,
});
const toolCallFrame = (calls) => ({
  role: "assistant",
  content: calls.map(({ id, name, args }) => ({ type: "toolCall", id, name, arguments: args ?? {} })),
  api: "faux", provider: "faux", model: "m", usage, stopReason: "toolUse", timestamp: 3,
});
const toolResult = (id, name, text, { status = "succeeded", isError = false } = {}) => ({
  role: "toolResult", toolCallId: id, toolName: name,
  content: [{ type: "text", text }], details: { status }, isError, timestamp: 4,
});

const restore = (entries) => restoreAsideSession({ findEntriesOnBranch: async () => entries });
const toolsOf = (restored) => restored.history.flatMap((message) => message.tools ?? []);

test("R1-04a: multiple calls in one turn restore in order and pair with their own results", async () => {
  sequence = 0;
  const restored = await restore([
    entry(userMessage("do the work")),
    entry(toolCallFrame([
      { id: "call-a", name: "workspace.read", args: { path: "a.md" } },
      { id: "call-b", name: "workspace.search", args: { query: "x" } },
      { id: "call-c", name: "mcp.notes.write_note", args: { text: "y" } },
    ])),
    entry(toolResult("call-a", "workspace.read", "alpha")),
    entry(toolResult("call-b", "workspace.search", "found x", { status: "failed", isError: true })),
    entry(toolResult("call-c", "mcp.notes.write_note", "written")),
    entry(assistantText("done")),
  ]);

  const tools = toolsOf(restored);
  assert.deepEqual(tools.map((call) => call.call_id), ["call-a", "call-b", "call-c"]);
  assert.deepEqual(tools.map((call) => call.text), ["alpha", "found x", "written"]);
  assert.deepEqual(tools.map((call) => call.status), ["succeeded", "failed", "succeeded"]);
  // The prose survives alongside the restored calls.
  assert.deepEqual(restored.history.map((message) => message.text), ["do the work", "", "done"]);
});

test("R1-04a: a call without a recorded result restores as unknown, never as success", async () => {
  sequence = 0;
  const restored = await restore([
    entry(userMessage("interrupted")),
    entry(toolCallFrame([{ id: "call-lost", name: "workspace.write" }])),
    entry(assistantText("after")),
  ]);
  const [call] = toolsOf(restored);
  assert.equal(call.status, "unknown");
  assert.equal(call.text, "");
  assert.equal(call.truncated, false);
});

test("R1-04a: source follows the enforced mcp namespace, not a name guess", async () => {
  sequence = 0;
  const restored = await restore([
    entry(userMessage("q")),
    entry(toolCallFrame([
      { id: "builtin-1", name: "workspace.read" },
      { id: "mcp-1", name: "mcp.notes.read_note" },
      // A later segment may look like a namespace; only the leading one
      // decides, which is exactly what the contract enforces.
      { id: "builtin-2", name: "workspace.search" },
    ])),
    entry(toolResult("builtin-1", "workspace.read", "a")),
    entry(toolResult("mcp-1", "mcp.notes.read_note", "b")),
    entry(toolResult("builtin-2", "workspace.search", "c")),
  ]);
  assert.deepEqual(toolsOf(restored).map((call) => call.source), ["builtin", "user_mcp", "builtin"]);
});

test("R1-04a: an orphan result is not projected and does not break the restore", async () => {
  sequence = 0;
  const restored = await restore([
    entry(userMessage("q")),
    entry(toolResult("orphan", "workspace.read", "no call")),
    entry(assistantText("answer")),
  ]);
  assert.deepEqual(restored.history.map((message) => message.text), ["q", "answer"]);
  assert.equal(restored.hiddenToolCalls, 0);
});

test("R1-04a: the projection is bounded by count and reports what it left out", async () => {
  sequence = 0;
  const calls = Array.from({ length: MAX_RESTORED_TOOL_CALLS + 3 }, (_, index) => ({ id: `call-${index}`, name: "workspace.read" }));
  const entries = [entry(userMessage("many")), entry(toolCallFrame(calls))];
  for (const [index] of calls.entries()) entries.push(entry(toolResult(`call-${index}`, "workspace.read", "x")));
  entries.push(entry(assistantText("end")));

  const restored = await restore(entries);
  const tools = toolsOf(restored);
  assert.equal(tools.length, MAX_RESTORED_TOOL_CALLS);
  assert.equal(restored.hiddenToolCalls, 3);
  // The most recent calls survive, so the tail of the list is what ran last.
  assert.equal(tools.at(-1).call_id, `call-${calls.length - 1}`);
  assert.equal(tools[0].call_id, "call-3");
});

test("R1-04a: per-result text is truncated at the preview limit and marked", async () => {
  sequence = 0;
  const restored = await restore([
    entry(userMessage("q")),
    entry(toolCallFrame([{ id: "call-big", name: "workspace.read" }])),
    entry(toolResult("call-big", "workspace.read", "a".repeat(8 * 1024))),
  ]);
  const [call] = toolsOf(restored);
  assert.equal(call.truncated, true);
  assert.ok(Buffer.byteLength(call.text) <= 2 * 1024);
});

test("R1-04a: total text across calls is bounded by the byte budget", async () => {
  sequence = 0;
  const perCall = "b".repeat(1800);
  const calls = Array.from({ length: 20 }, (_, index) => ({ id: `call-${index}`, name: "workspace.read" }));
  const entries = [entry(userMessage("q")), entry(toolCallFrame(calls))];
  for (const [index] of calls.entries()) entries.push(entry(toolResult(`call-${index}`, "workspace.read", perCall)));

  const restored = await restore(entries);
  const tools = toolsOf(restored);
  const total = tools.reduce((sum, call) => sum + Buffer.byteLength(call.text), 0);
  assert.ok(total <= MAX_RESTORED_TOOL_BYTES, `restored ${total} bytes`);
  assert.ok(restored.hiddenToolCalls > 0, "an over-budget projection must report what it left out");
  assert.equal(tools.at(-1).call_id, `call-${calls.length - 1}`);
});

test("R1-04a: a history with no tool records restores exactly as before", async () => {
  sequence = 0;
  const restored = await restore([
    entry(userMessage("plain")),
    entry(assistantText("answer")),
  ]);
  assert.deepEqual(restored.history.map((message) => [message.role, message.text]), [["user", "plain"], ["assistant", "answer"]]);
  assert.equal(restored.history.every((message) => message.tools === undefined), true);
  assert.equal(restored.hiddenToolCalls, 0);
});

test("R1-04a: restoring is read-only and does not rewrite the record", async () => {
  sequence = 0;
  const entries = [
    entry(userMessage("q")),
    entry(toolCallFrame([{ id: "call-1", name: "workspace.read" }])),
    entry(toolResult("call-1", "workspace.read", "alpha")),
  ];
  const before = JSON.stringify(entries);
  await restore(entries);
  assert.equal(JSON.stringify(entries), before);
});

/* ---------------------------------------------------------------------------
 * R1-06a: the artifact a restored call produced.
 * ------------------------------------------------------------------------- */

const absolute = (name) => join(tmpdir(), "aside-artifacts", name);

test("R1-06a: a successful write restores its artifact through the whitelist", async () => {
  sequence = 0;
  const output = absolute("report.docx");
  const restored = await restore([
    entry(userMessage("make a report")),
    entry(toolCallFrame([{ id: "write-1", name: "workspace.write_docx" }])),
    entry({
      role: "toolResult", toolCallId: "write-1", toolName: "workspace.write_docx",
      content: [{ type: "text", text: "created" }],
      details: {
        status: "succeeded",
        output_absolute_path: output,
        output_path: "report.docx",
        operation: "transform",
        bytes: 2048,
        structure: { paragraphs: 3, tables: 1 },
        verification: { status: "verified" },
        source_path: "D:/src/report.docx",
        source_fidelity_warnings: ["list_type_lost"],
        // Not an artifact field: must not travel into the restored event.
        private_note: "do not carry this",
      },
      isError: false, timestamp: 4,
    }),
  ]);
  const [call] = toolsOf(restored);
  assert.equal(call.artifact.output_absolute_path, output);
  assert.equal(call.artifact.operation, "transform");
  assert.equal(call.artifact.verification.status, "verified");
  assert.deepEqual(call.artifact.source_fidelity_warnings, ["list_type_lost"]);
  assert.equal(call.artifact.private_note, undefined);
});

test("R1-06a: a relative-only result restores without an artifact", async () => {
  sequence = 0;
  const restored = await restore([
    entry(userMessage("write")),
    entry(toolCallFrame([{ id: "write-1", name: "workspace.write" }])),
    entry({
      role: "toolResult", toolCallId: "write-1", toolName: "workspace.write",
      content: [{ type: "text", text: "written" }],
      details: { status: "succeeded", output_path: "notes.md", operation: "write" },
      isError: false, timestamp: 4,
    }),
  ]);
  assert.equal(toolsOf(restored)[0].artifact, undefined);
});

test("R1-06a: a failed call never restores an artifact, whatever path it carries", async () => {
  sequence = 0;
  const restored = await restore([
    entry(userMessage("write")),
    entry(toolCallFrame([{ id: "write-1", name: "workspace.write" }])),
    entry({
      role: "toolResult", toolCallId: "write-1", toolName: "workspace.write",
      content: [{ type: "text", text: "failed" }],
      details: { status: "failed", output_absolute_path: absolute("partial.md"), operation: "write" },
      isError: true, timestamp: 4,
    }),
  ]);
  const [call] = toolsOf(restored);
  assert.equal(call.status, "failed");
  assert.equal(call.artifact, undefined);
});

test("R1-06a: an invalid absolute path is treated as not recorded", async () => {
  sequence = 0;
  for (const bad of ["relative/path.md", `${absolute("x")}\n`, `C:${"x".repeat(8 * 1024)}`]) {
    const restored = await restore([
      entry(userMessage("write")),
      entry(toolCallFrame([{ id: "write-1", name: "workspace.write" }])),
      entry({
        role: "toolResult", toolCallId: "write-1", toolName: "workspace.write",
        content: [{ type: "text", text: "written" }],
        details: { status: "succeeded", output_absolute_path: bad, operation: "write" },
        isError: false, timestamp: 4,
      }),
    ]);
    assert.equal(toolsOf(restored)[0].artifact, undefined, `accepted ${JSON.stringify(bad.slice(0, 40))}`);
  }
});

test("R1-06a: two writes in one session keep their own artifacts", async () => {
  sequence = 0;
  const first = absolute("one.docx");
  const second = absolute("two.md");
  const restored = await restore([
    entry(userMessage("first")),
    entry(toolCallFrame([{ id: "write-1", name: "workspace.write_docx" }])),
    entry({
      role: "toolResult", toolCallId: "write-1", toolName: "workspace.write_docx",
      content: [{ type: "text", text: "created" }],
      details: { status: "succeeded", output_absolute_path: first, operation: "create" },
      isError: false, timestamp: 4,
    }),
    entry(assistantText("done one")),
    entry(userMessage("second")),
    entry(toolCallFrame([{ id: "write-2", name: "workspace.write" }])),
    entry({
      role: "toolResult", toolCallId: "write-2", toolName: "workspace.write",
      content: [{ type: "text", text: "written" }],
      details: { status: "succeeded", output_absolute_path: second, operation: "write" },
      isError: false, timestamp: 4,
    }),
  ]);
  assert.deepEqual(toolsOf(restored).map((call) => call.artifact.output_absolute_path), [first, second]);
});
