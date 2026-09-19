import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MCP_CONTENT_BLOCKS,
  MAX_MCP_RESULT_BYTES,
  McpResultError,
  normalizeMcpResult,
} from "../src/mcp-result.mjs";

function expectRefusal(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof McpResultError, `expected McpResultError, got ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("concatenates text blocks", () => {
  const normalized = normalizeMcpResult({
    content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
  });
  assert.equal(normalized.text, "first\n\nsecond");
  assert.equal(normalized.is_error, false);
  assert.equal(normalized.truncated, false);
});

test("omits images and audio with a stated reason", () => {
  // Confirmed against the SDK: it validates the content array's shape but
  // passes image and audio members straight through.
  const normalized = normalizeMcpResult({
    content: [
      { type: "text", text: "before" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" },
      { type: "text", text: "after" },
    ],
  });

  assert.equal(normalized.text, "before\n\nafter");
  const omissions = normalized.omissions.map((entry) => entry.omitted);
  assert.deepEqual(omissions, ["image", "audio"]);
  assert.equal(normalized.omissions[0].detail, "image/png");
  // The model is told something was dropped rather than shown an empty result.
  assert.equal(normalized.omitted_anything, true);
});

test("carries an embedded text resource with its uri", () => {
  const normalized = normalizeMcpResult({
    content: [{ type: "resource", resource: { uri: "file:///notes.txt", text: "hello" } }],
  });
  assert.equal(normalized.text, "file:///notes.txt\nhello");
});

test("omits an embedded binary resource and keeps only its uri", () => {
  const normalized = normalizeMcpResult({
    content: [{ type: "resource", resource: { uri: "file:///bg.png", blob: "aGVsbG8=" } }],
  });
  assert.equal(normalized.text, "");
  assert.deepEqual(normalized.omissions[0], { omitted: "embedded_blob_resource", detail: "file:///bg.png" });
});

test("carries resource links as small citable identifiers", () => {
  const normalized = normalizeMcpResult({
    content: [{ type: "resource_link", uri: "https://example.test/a", name: "A" }],
  });
  assert.deepEqual(normalized.links, ["https://example.test/a"]);
  assert.equal(normalized.omitted_anything, false);
});

test("omits an unrecognized block type rather than passing it through", () => {
  const normalized = normalizeMcpResult({
    content: [{ type: "hologram", payload: { deep: "structure" } }],
  });
  assert.equal(normalized.text, "");
  assert.equal(normalized.omissions[0].omitted, "unsupported_block_type");
  assert.equal(normalized.omissions[0].detail, "hologram");
});

test("preserves the server's isError flag separately from the text", () => {
  const normalized = normalizeMcpResult({
    isError: true,
    content: [{ type: "text", text: "The server refused the call." }],
  });
  assert.equal(normalized.is_error, true);
  assert.equal(normalized.text, "The server refused the call.");
});

test("truncates an oversized text block and says so", () => {
  const normalized = normalizeMcpResult(
    { content: [{ type: "text", text: "x".repeat(5_000) }] },
    { maxTextBlockBytes: 1_024 },
  );
  assert.equal(normalized.text.length, 1_024);
  assert.equal(normalized.truncated, true);
});

test("bounds the total result regardless of how many blocks arrive", () => {
  const content = Array.from({ length: 12 }, () => ({ type: "text", text: "y".repeat(4_096) }));
  const normalized = normalizeMcpResult({ content }, { maxResultBytes: 8_192 });
  assert.ok(normalized.bytes <= 8_192);
  assert.equal(normalized.truncated, true);
});

test("stops consuming blocks past the member limit", () => {
  const content = Array.from(
    { length: MAX_MCP_CONTENT_BLOCKS + 5 },
    (_v, index) => ({ type: "text", text: `block-${index}` }),
  );
  const normalized = normalizeMcpResult({ content });
  assert.equal(normalized.omissions[0].omitted, "too_many_content_blocks");
  assert.ok(!normalized.text.includes(`block-${MAX_MCP_CONTENT_BLOCKS + 4}`));
});

test("bounds structured content instead of stringifying it whole", () => {
  const normalized = normalizeMcpResult({
    content: [{ type: "text", text: "ok" }],
    structuredContent: { blob: "z".repeat(200_000) },
  });
  assert.ok(normalized.structured.length <= MAX_MCP_RESULT_BYTES);
  assert.equal(normalized.truncated, true);
});

test("reports an empty result rather than leaving it silent", () => {
  const normalized = normalizeMcpResult({ content: [] });
  assert.equal(normalized.text, "");
  assert.deepEqual(normalized.omissions, [{ omitted: "empty_result" }]);
});

test("drops annotations: they have no path out of normalization", () => {
  const normalized = normalizeMcpResult({
    content: [
      {
        type: "text",
        text: "payload",
        annotations: { audience: ["assistant"], priority: 0.9, lastModified: "2030-01-01" },
      },
    ],
  });
  const serialized = JSON.stringify(normalized);
  assert.equal(serialized.includes("lastModified"), false);
  assert.equal(serialized.includes("priority"), false);
});

test("refuses a malformed result rather than reporting an empty one", () => {
  expectRefusal(() => normalizeMcpResult({ content: "not-an-array" }), "mcp_result_malformed");
  expectRefusal(() => normalizeMcpResult("not-an-object"), "mcp_result_malformed");
});

test("the normalized result is frozen", () => {
  const normalized = normalizeMcpResult({ content: [{ type: "text", text: "a" }] });
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.omissions));
});
