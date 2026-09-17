import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_TOOL_RESULT_MESSAGE_BYTES,
  TOOL_RESULT_FAILURE_STATUSES,
  TOOL_RESULT_STATUSES,
  boundedToolResult,
  cancelledToolResult,
  deniedToolResult,
  isFailureToolResultStatus,
  normalizeToolResultStatus,
  permissionNotObtainedResult,
  toolResultEnvelope,
  toolResultStatusForError,
  unavailableToolResult,
} from "../src/capability-result.mjs";
import { toolResultText } from "../src/agent-contracts.mjs";

const TRUSTED_DETAIL_KEYS = ["descriptor", "risk", "origin", "policy"];

function envelopeDetails(result) {
  return result.details ?? {};
}

test("exposes one closed status vocabulary with a complete failure set", () => {
  for (const status of [
    "succeeded",
    "partial",
    "denied",
    "cancelled",
    "expired",
    "invalidated",
    "stale",
    "unsupported",
    "unavailable",
    "timed_out",
    "disconnected",
    "malformed",
    "failed",
  ]) {
    assert.ok(TOOL_RESULT_STATUSES.includes(status), `${status} is declared`);
  }
  assert.deepEqual(
    TOOL_RESULT_FAILURE_STATUSES.filter(
      (status) => status === "succeeded" || status === "partial",
    ),
    [],
  );
  // Every status is either a success or a failure, never both and never neither.
  assert.equal(
    TOOL_RESULT_STATUSES.length,
    TOOL_RESULT_FAILURE_STATUSES.length + 2,
  );
  assert.equal(isFailureToolResultStatus("succeeded"), false);
  assert.equal(isFailureToolResultStatus("partial"), false);
  for (const status of TOOL_RESULT_FAILURE_STATUSES) {
    assert.equal(isFailureToolResultStatus(status), true, status);
  }
});

test("normalizes a declared status and falls back to the error flag", () => {
  assert.equal(normalizeToolResultStatus({ status: "succeeded" }), "succeeded");
  assert.equal(normalizeToolResultStatus({ status: "partial" }), "partial");
  assert.equal(normalizeToolResultStatus({ status: "timed_out" }), "timed_out");
  // A failure reported only through details.status must not read as success.
  for (const status of TOOL_RESULT_FAILURE_STATUSES) {
    assert.equal(normalizeToolResultStatus({ status }), status);
    assert.equal(isFailureToolResultStatus(normalizeToolResultStatus({ status })), true);
  }
  assert.equal(normalizeToolResultStatus(undefined, true), "failed");
  assert.equal(normalizeToolResultStatus(undefined, false), "succeeded");
  assert.equal(normalizeToolResultStatus({ status: "invented" }, true), "failed");
  assert.equal(normalizeToolResultStatus({ status: 7 }), "succeeded");
});

test("maps runtime errors to the statuses the write adapter already emits", () => {
  assert.equal(toolResultStatusForError({ code: "permission_denied" }), "denied");
  assert.equal(toolResultStatusForError({ code: "permission_expired" }), "expired");
  assert.equal(
    toolResultStatusForError({ code: "permission_invalidated" }),
    "invalidated",
  );
  assert.equal(toolResultStatusForError({ code: "aborted" }), "cancelled");
  assert.equal(
    toolResultStatusForError({ code: "permission_cancelled" }),
    "cancelled",
  );
  assert.equal(toolResultStatusForError({ code: "write_failed" }), "failed");
  assert.equal(toolResultStatusForError(new Error("boom")), "failed");
  assert.equal(toolResultStatusForError(undefined), "failed");
});

test("bounds and redacts an envelope without carrying trusted metadata", () => {
  const oversized = "x".repeat(MAX_TOOL_RESULT_MESSAGE_BYTES * 4);
  const result = toolResultEnvelope({
    tool: "document.read",
    status: "partial",
    code: "page_limit",
    message: oversized,
    details: { pages: 3 },
  });

  assert.equal(result.isError, false);
  assert.equal(result.details.status, "partial");
  assert.equal(result.details.tool, "document.read");
  assert.equal(result.details.code, "page_limit");
  assert.equal(result.details.pages, 3);
  assert.ok(
    Buffer.byteLength(result.details.message, "utf8") <=
      MAX_TOOL_RESULT_MESSAGE_BYTES,
  );
  assert.ok(toolResultText(result).length > 0);
  for (const key of TRUSTED_DETAIL_KEYS) {
    assert.equal(
      Object.hasOwn(envelopeDetails(result), key),
      false,
      `${key} must not reach a durable tool result`,
    );
  }
});

test("redacts secret-shaped values inside envelope details", () => {
  const result = toolResultEnvelope({
    tool: "web.search",
    status: "succeeded",
    message: "ok",
    details: { api_key: "sk-abcdefghijklmnop", note: "Bearer abcdefghijklmnop" },
  });
  const serialized = JSON.stringify(result.details);
  assert.equal(serialized.includes("sk-abcdefghijklmnop"), false);
  assert.equal(serialized.includes("Bearer abcdefghijklmnop"), false);
});

test("builds failure envelopes for denied, cancelled, and unavailable", () => {
  for (const [result, status] of [
    [deniedToolResult("workspace.write"), "denied"],
    [cancelledToolResult("workspace.write"), "cancelled"],
    [unavailableToolResult("workspace.read"), "unavailable"],
    [permissionNotObtainedResult("web.search"), "denied"],
  ]) {
    assert.equal(result.isError, true, status);
    assert.equal(result.details.status, status);
    assert.equal(isFailureToolResultStatus(result.details.status), true);
  }
  assert.equal(
    permissionNotObtainedResult("web.search").details.code,
    "permission_not_obtained",
  );
  assert.equal(
    deniedToolResult("workspace.write", { code: "permission_denied" }).details.code,
    "permission_denied",
  );
});

test("keeps the moved boundedToolResult contract intact", () => {
  // An oversize text block is truncated to the remaining budget.
  const truncated = boundedToolResult(
    {
      content: [
        { type: "text", text: "a".repeat(20) },
        { type: "image", data: "ignored" },
        { type: "text", text: "b".repeat(100) },
      ],
      details: { status: "succeeded", big: "c".repeat(4096) },
    },
    64,
  );
  assert.equal(truncated.truncated, true);
  assert.ok(
    truncated.content.every((block) => block.type === "text"),
    "non-text blocks are dropped",
  );
  const textBytes = truncated.content.reduce(
    (total, block) => total + Buffer.byteLength(block.text, "utf8"),
    0,
  );
  assert.ok(textBytes <= 64, "bounded content stays inside the byte budget");
  assert.equal(typeof truncated.details, "object");
  // At a budget this small the details preview is truncated too, so the
  // declared status no longer survives parsing; the flag still reports it.
  assert.equal(truncated.truncated, true);

  // With room for the detail payload, the declared status survives intact.
  const roomy = boundedToolResult(
    { content: [{ type: "text", text: "a".repeat(8) }], details: { status: "succeeded" } },
    4096,
  );
  assert.equal(roomy.details.status, "succeeded");
  assert.equal(roomy.truncated, false);

  // The marker is appended only when budget remains for it.
  const marked = boundedToolResult(
    { content: [{ type: "text", text: "a".repeat(20) }, { type: "image", data: "x" }] },
    64,
  );
  assert.ok(
    marked.content.some((block) => block.text.includes("[tool output truncated]")),
  );

  assert.throws(() => boundedToolResult({}, 0), /maxBytes/);
});
