import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MCP_SCHEMA_BYTES,
  MAX_MCP_SCHEMA_DEPTH,
  MAX_MCP_SCHEMA_ENUM_VALUES,
  MAX_MCP_SCHEMA_PROPERTIES,
  MAX_MCP_SCHEMA_VARIANTS,
  MCP_SCHEMA_DROPPED_KEYWORDS,
  McpSchemaError,
  acceptMcpToolDefinition,
  assertMcpArguments,
} from "../src/mcp-schema.mjs";

/**
 * The adversarial shapes in this file are not invented. They were observed on a
 * real third-party Web Search MCP server that was read during planning (Cycle 6
 * P6). That server is a fixture source, never a runtime dependency — see
 * C6-I026 and the P6 plan's "Verification Approach and Its Limit".
 */

function expectRefusal(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof McpSchemaError, `expected McpSchemaError, got ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("accepts a plain object schema and rebuilds it", () => {
  const accepted = acceptMcpToolDefinition({
    name: "search",
    description: "Search the web.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  });

  assert.equal(accepted.name, "search");
  assert.deepEqual(accepted.parameters, {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  });
});

test("accepts the anyOf number-or-string union a real server generates", () => {
  // Observed shape: `z.union([z.number(), z.string()])` with `.default(5)`
  // serialized to JSON Schema. The reference server uses this on two of its
  // three tools, so refusing it would make that server wholly unusable.
  const accepted = acceptMcpToolDefinition({
    name: "get-web-search-summaries",
    description: "Search the web and return only the result snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query to execute" },
        limit: {
          anyOf: [{ type: "number" }, { type: "string" }],
          default: 5,
          description: "Number of results to return (1-10)",
        },
      },
      required: ["query"],
    },
  });

  assert.deepEqual(accepted.parameters.properties.limit, {
    anyOf: [{ type: "number" }, { type: "string" }],
    default: 5,
    description: "Number of results to return (1-10)",
  });
});

test("accepts format as an annotation rather than refusing the tool over it", () => {
  // Observed shape: `z.string().url()` serializes to `format: "uri"`. `format`
  // is an annotation in JSON Schema, so carrying it is faithful, not loose.
  const accepted = acceptMcpToolDefinition({
    name: "get-single-web-page-content",
    description: "Extract the full content from a single web page URL.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", format: "uri" } },
      required: ["url"],
    },
  });

  assert.deepEqual(accepted.parameters.properties.url, { type: "string", format: "uri" });
});

test("drops pure annotations instead of refusing the tool", () => {
  const accepted = acceptMcpToolDefinition({
    name: "annotated",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "string", examples: ["a", "b"], readOnly: false, $comment: "internal" },
      },
    },
  });

  assert.deepEqual(accepted.parameters.properties.value, { type: "string" });
  for (const keyword of MCP_SCHEMA_DROPPED_KEYWORDS) {
    assert.equal(keyword in accepted.parameters.properties.value, false);
  }
});

test("refuses a schema it cannot resolve rather than forwarding it", () => {
  expectRefusal(
    () => acceptMcpToolDefinition({
      name: "refs",
      inputSchema: { type: "object", properties: { a: { $ref: "#/$defs/Thing" } } },
    }),
    "mcp_schema_unsupported_keyword",
  );
});

test("refuses conditional validation keywords", () => {
  for (const keyword of ["if", "then", "else", "not", "dependentSchemas"]) {
    expectRefusal(
      () => acceptMcpToolDefinition({
        name: "conditional",
        inputSchema: { type: "object", [keyword]: {} },
      }),
      "mcp_schema_unsupported_keyword",
    );
  }
});

test("refuses structural keywords the provider request cannot express", () => {
  for (const keyword of ["patternProperties", "propertyNames", "prefixItems", "unevaluatedProperties"]) {
    expectRefusal(
      () => acceptMcpToolDefinition({
        name: "structural",
        inputSchema: { type: "object", [keyword]: {} },
      }),
      "mcp_schema_unsupported_keyword",
    );
  }
});

test("refuses a schema nested deeper than the limit", () => {
  let schema = { type: "string" };
  for (let depth = 0; depth <= MAX_MCP_SCHEMA_DEPTH; depth += 1) {
    schema = { type: "object", properties: { nested: schema } };
  }
  expectRefusal(
    () => acceptMcpToolDefinition({ name: "deep", inputSchema: schema }),
    "mcp_schema_too_deep",
  );
});

test("refuses a schema with too many properties", () => {
  const properties = {};
  for (let index = 0; index <= MAX_MCP_SCHEMA_PROPERTIES; index += 1) {
    properties[`field_${index}`] = { type: "string" };
  }
  expectRefusal(
    () => acceptMcpToolDefinition({ name: "wide", inputSchema: { type: "object", properties } }),
    "mcp_schema_too_many_properties",
  );
});

test("refuses an enum past the value limit", () => {
  const values = Array.from({ length: MAX_MCP_SCHEMA_ENUM_VALUES + 1 }, (_v, i) => `v${i}`);
  expectRefusal(
    () => acceptMcpToolDefinition({
      name: "enum",
      inputSchema: { type: "object", properties: { pick: { type: "string", enum: values } } },
    }),
    "mcp_schema_enum_too_large",
  );
});

test("refuses more union variants than the limit", () => {
  const variants = Array.from({ length: MAX_MCP_SCHEMA_VARIANTS + 1 }, () => ({ type: "string" }));
  expectRefusal(
    () => acceptMcpToolDefinition({
      name: "unions",
      inputSchema: { type: "object", properties: { pick: { anyOf: variants } } },
    }),
    "mcp_schema_too_many_variants",
  );
});

test("refuses a schema larger than the byte limit", () => {
  const build = (size) => ({
    type: "object",
    properties: { value: { type: "string", description: "x".repeat(size) } },
  });

  const under = acceptMcpToolDefinition({ name: "big", inputSchema: build(MAX_MCP_SCHEMA_BYTES - 512) });
  assert.ok(under.schema_bytes <= MAX_MCP_SCHEMA_BYTES);
  assert.equal(under.parameters.properties.value.description.length, MAX_MCP_SCHEMA_BYTES - 512);

  // Past the limit the tool is refused, not truncated: a silently shortened
  // description would be a schema the server did not write.
  expectRefusal(
    () => acceptMcpToolDefinition({ name: "big", inputSchema: build(MAX_MCP_SCHEMA_BYTES) }),
    "mcp_schema_too_large",
  );
});

test("refuses a tool name that is absent, blank, or oversized", () => {
  expectRefusal(() => acceptMcpToolDefinition({ description: "no name" }), "mcp_tool_name_invalid");
  expectRefusal(
    () => acceptMcpToolDefinition({ name: "   ", description: "blank" }),
    "mcp_tool_name_invalid",
  );
  expectRefusal(
    () => acceptMcpToolDefinition({ name: "n".repeat(200) }),
    "mcp_tool_name_too_long",
  );
});

test("refuses an oversized description", () => {
  expectRefusal(
    () => acceptMcpToolDefinition({ name: "chatty", description: "d".repeat(4096) }),
    "mcp_tool_description_too_long",
  );
});

test("treats an absent schema as an empty object schema", () => {
  const accepted = acceptMcpToolDefinition({ name: "noargs", description: "No arguments." });
  assert.deepEqual(accepted.parameters, { type: "object" });
  assert.equal(accepted.description, "No arguments.");
});

test("refuses malformed keyword values rather than forwarding them", () => {
  expectRefusal(
    () => acceptMcpToolDefinition({
      name: "bad-required",
      inputSchema: { type: "object", required: "query" },
    }),
    "mcp_schema_invalid",
  );
  expectRefusal(
    () => acceptMcpToolDefinition({
      name: "bad-type",
      inputSchema: { type: "object", properties: { a: { type: "money" } } },
    }),
    "mcp_schema_invalid",
  );
  expectRefusal(
    () => acceptMcpToolDefinition({
      name: "bad-enum",
      inputSchema: { type: "object", properties: { a: { enum: [] } } },
    }),
    "mcp_schema_invalid",
  );
});

test("argument validation refuses a missing required field", () => {
  expectRefusal(
    () => assertMcpArguments({ type: "object", properties: { query: { type: "string" } }, required: ["query"] }, {}),
    "mcp_arguments_invalid",
  );
});

test("argument validation refuses a type mismatch", () => {
  expectRefusal(
    () => assertMcpArguments({ type: "object", properties: { limit: { type: "number" } } }, { limit: "5" }),
    "mcp_arguments_invalid",
  );
});

test("argument validation refuses a value outside the declared enum", () => {
  expectRefusal(
    () => assertMcpArguments(
      { type: "object", properties: { mode: { type: "string", enum: ["fast", "deep"] } } },
      { mode: "turbo" },
    ),
    "mcp_arguments_invalid",
  );
});

test("argument validation honours additionalProperties: false", () => {
  const schema = {
    type: "object",
    properties: { query: { type: "string" } },
    additionalProperties: false,
  };
  assert.deepEqual(assertMcpArguments(schema, { query: "aside" }), { query: "aside" });
  expectRefusal(
    () => assertMcpArguments(schema, { query: "aside", extra: 1 }),
    "mcp_arguments_invalid",
  );
});

test("argument validation does not enforce format", () => {
  // `format` is an annotation, so enforcing it locally would make us stricter
  // than the contract the server wrote. The server stays the authority.
  const schema = { type: "object", properties: { url: { type: "string", format: "uri" } } };
  assert.deepEqual(assertMcpArguments(schema, { url: "not-a-uri" }), { url: "not-a-uri" });
});

test("an accepted definition is frozen", () => {
  const accepted = acceptMcpToolDefinition({ name: "frozen", inputSchema: { type: "object" } });
  assert.ok(Object.isFrozen(accepted));
});
