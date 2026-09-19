import { byteLength, isPlainObject } from "./agent-contracts.mjs";

/**
 * MCP tool schema acceptance policy.
 *
 * An MCP server hands us a JSON Schema for each tool. That schema is untrusted
 * third-party input: it was written by whoever authored the server, it reaches
 * the model verbatim through the provider request, and it is the only contract
 * governing whether a call is well-formed.
 *
 * The Cycle 6 rule is "reject rather than loosely reinterpret unknown validation
 * semantics" (P6 task 5). Keywords therefore fall into three categories, and the
 * distinction between the last two is what keeps the policy honest rather than
 * merely strict:
 *
 *  1. **Forwarded** — keywords whose meaning we can honour or faithfully carry.
 *  2. **Dropped** — annotations with no validation semantics at all (`examples`,
 *     `readOnly`, `$comment`). Dropping one cannot change what a call means, and
 *     refusing the tool over it would make well-formed servers unusable for no
 *     safety gain.
 *  3. **Refused** — keywords that would change validation semantics in a way we
 *     cannot honour: `$ref` (resolution we do not perform), `if`/`then`/`else`
 *     and `dependentSchemas` (conditional validation whose provider support
 *     varies), `patternProperties` and `prefixItems` (structural forms the
 *     provider request cannot express faithfully). Refusing is preferred to
 *     forwarding, because a schema the model saw differently than we validated
 *     is worse than a tool that is honestly unavailable.
 *
 * A rebuild step makes the allow-list authoritative: an accepted schema is
 * reconstructed from its forwarded keywords only, so nothing unrecognized can
 * survive the check even if a future keyword is added to the allow-list by
 * mistake.
 *
 * Bounds are applied at the same time, because a schema is also a
 * denial-of-service surface: it is serialized into every provider request.
 */

export const MAX_MCP_SCHEMA_BYTES = 16 * 1024;
export const MAX_MCP_SCHEMA_DEPTH = 6;
export const MAX_MCP_SCHEMA_PROPERTIES = 64;
export const MAX_MCP_SCHEMA_ENUM_VALUES = 64;
export const MAX_MCP_SCHEMA_VARIANTS = 8;
export const MAX_MCP_TOOL_NAME_BYTES = 64;
export const MAX_MCP_TOOL_DESCRIPTION_BYTES = 2 * 1024;

export const MCP_SCHEMA_JSON_TYPES = Object.freeze([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

/**
 * Keywords this adapter forwards to the provider.
 *
 * `format` is included on purpose and is worth a note, because it looks like it
 * should be refused. In JSON Schema `format` is an annotation, not an
 * assertion: it does not constrain a value unless a validator opts in. Carrying
 * it to the provider is therefore faithful rather than loose. We do **not**
 * enforce it locally (see `assertMcpArguments`), so a server that declares
 * `format: "uri"` and receives something that is not a URI reports its own
 * error, which our failure taxonomy handles like any other server-side refusal.
 *
 * Real servers generate this constantly — the reference vendored server emits
 * `format: "uri"` from `z.string().url()` — so refusing tools over it would
 * reject a large fraction of well-formed servers for no safety gain. The
 * dangerous parameter there is dangerous because it is an arbitrary URL, which
 * policy and permission address, not because its format was unchecked.
 */
export const MCP_SCHEMA_ACCEPTED_KEYWORDS = Object.freeze([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "anyOf",
  "oneOf",
  "allOf",
  "title",
  "description",
  "default",
  "format",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
]);

/**
 * Keywords recognized and deliberately dropped.
 *
 * These are pure annotations. Dropping one cannot change what a call means, so
 * the tool stays available; refusing over them would make ordinary servers
 * unusable for no safety gain. They are listed explicitly rather than ignored
 * so the difference between "understood and dropped" and "not understood" stays
 * visible in the code.
 */
export const MCP_SCHEMA_DROPPED_KEYWORDS = Object.freeze([
  "examples",
  "example",
  "$comment",
  "deprecated",
  "readOnly",
  "writeOnly",
  "contentMediaType",
  "contentEncoding",
  "id",
]);

const ACCEPTED = new Set(MCP_SCHEMA_ACCEPTED_KEYWORDS);
const DROPPED = new Set(MCP_SCHEMA_DROPPED_KEYWORDS);
const JSON_TYPES = new Set(MCP_SCHEMA_JSON_TYPES);
const COMPOSITION_KEYWORDS = Object.freeze(["anyOf", "oneOf", "allOf"]);
const NUMERIC_KEYWORDS = Object.freeze([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);
const INTEGER_KEYWORDS = Object.freeze(["minLength", "maxLength", "minItems", "maxItems"]);

export class McpSchemaError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "McpSchemaError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function refuse(code, message, details) {
  throw new McpSchemaError(code, message, details);
}

/**
 * Walks a schema and returns the first unrecognized keyword it finds.
 *
 * This runs over the raw object before any rebuilding, so a keyword is reported
 * by the name the server actually used.
 */
function findUnsupportedKeyword(node, path, depth) {
  if (depth > MAX_MCP_SCHEMA_DEPTH) {
    refuse("mcp_schema_too_deep", `The tool schema exceeds the supported nesting depth at "${path}".`, {
      path,
      max_depth: MAX_MCP_SCHEMA_DEPTH,
    });
  }
  if (!isPlainObject(node)) {
    refuse("mcp_schema_invalid", `The tool schema node at "${path}" is not an object.`, { path });
  }
  for (const key of Object.keys(node)) {
    // Dropped keywords are understood and deliberately not forwarded; anything
    // in neither set is refused rather than silently reinterpreted.
    if (!ACCEPTED.has(key) && !DROPPED.has(key)) {
      refuse(
        "mcp_schema_unsupported_keyword",
        `The tool schema uses the unsupported keyword "${key}" at "${path}".`,
        { path, keyword: key },
      );
    }
  }
  if (isPlainObject(node.properties)) {
    for (const [name, child] of Object.entries(node.properties)) {
      findUnsupportedKeyword(child, `${path}.properties.${name}`, depth + 1);
    }
  }
  if (isPlainObject(node.items)) {
    findUnsupportedKeyword(node.items, `${path}.items`, depth + 1);
  }
  if (isPlainObject(node.additionalProperties)) {
    findUnsupportedKeyword(node.additionalProperties, `${path}.additionalProperties`, depth + 1);
  }
  for (const keyword of COMPOSITION_KEYWORDS) {
    const variants = node[keyword];
    if (variants === undefined) continue;
    if (!Array.isArray(variants) || variants.length === 0) {
      refuse(
        "mcp_schema_invalid",
        `The tool schema "${keyword}" at "${path}" must be a non-empty array.`,
        { path, keyword },
      );
    }
    if (variants.length > MAX_MCP_SCHEMA_VARIANTS) {
      refuse(
        "mcp_schema_too_many_variants",
        `The tool schema "${keyword}" at "${path}" has more than ${MAX_MCP_SCHEMA_VARIANTS} variants.`,
        { path, keyword, count: variants.length },
      );
    }
    variants.forEach((variant, index) => {
      findUnsupportedKeyword(variant, `${path}.${keyword}[${index}]`, depth + 1);
    });
  }
  return undefined;
}

/**
 * Checks the value shapes of the keywords we accepted by name.
 *
 * An allow-listed keyword with a nonsense value is still a refusal. A server
 * sending `"required": "query"` has a broken schema, and forwarding it would
 * put a malformed declaration in front of the model.
 */
function assertKeywordShapes(node, path, counter, depth) {
  counter.nodes += 1;
  if (depth > MAX_MCP_SCHEMA_DEPTH) {
    refuse("mcp_schema_too_deep", `The tool schema exceeds the supported nesting depth at "${path}".`, {
      path,
      max_depth: MAX_MCP_SCHEMA_DEPTH,
    });
  }
  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    for (const type of types) {
      if (typeof type !== "string" || !JSON_TYPES.has(type)) {
        refuse("mcp_schema_invalid", `The tool schema has an unknown type "${String(type)}" at "${path}".`, {
          path,
          type: String(type),
        });
      }
    }
  }
  if (node.properties !== undefined) {
    if (!isPlainObject(node.properties)) {
      refuse("mcp_schema_invalid", `The tool schema "properties" at "${path}" must be an object.`, { path });
    }
    for (const name of Object.keys(node.properties)) {
      counter.properties += 1;
      if (counter.properties > MAX_MCP_SCHEMA_PROPERTIES) {
        refuse(
          "mcp_schema_too_many_properties",
          `The tool schema declares more than ${MAX_MCP_SCHEMA_PROPERTIES} properties.`,
          { path, count: counter.properties },
        );
      }
      assertKeywordShapes(node.properties[name], `${path}.properties.${name}`, counter, depth + 1);
    }
  }
  if (node.required !== undefined) {
    if (!Array.isArray(node.required) || node.required.some((key) => typeof key !== "string")) {
      refuse("mcp_schema_invalid", `The tool schema "required" at "${path}" must be an array of strings.`, {
        path,
      });
    }
  }
  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum) || node.enum.length === 0) {
      refuse("mcp_schema_invalid", `The tool schema "enum" at "${path}" must be a non-empty array.`, { path });
    }
    if (node.enum.length > MAX_MCP_SCHEMA_ENUM_VALUES) {
      refuse(
        "mcp_schema_enum_too_large",
        `The tool schema "enum" at "${path}" has more than ${MAX_MCP_SCHEMA_ENUM_VALUES} values.`,
        { path, count: node.enum.length },
      );
    }
  }
  if (node.items !== undefined && !isPlainObject(node.items)) {
    refuse("mcp_schema_invalid", `The tool schema "items" at "${path}" must be an object.`, { path });
  }
  if (node.additionalProperties !== undefined && typeof node.additionalProperties !== "boolean") {
    if (!isPlainObject(node.additionalProperties)) {
      refuse(
        "mcp_schema_invalid",
        `The tool schema "additionalProperties" at "${path}" must be a boolean or an object.`,
        { path },
      );
    }
    assertKeywordShapes(node.additionalProperties, `${path}.additionalProperties`, counter, depth + 1);
  }
  for (const keyword of NUMERIC_KEYWORDS) {
    if (node[keyword] !== undefined && typeof node[keyword] !== "number") {
      refuse("mcp_schema_invalid", `The tool schema "${keyword}" at "${path}" must be a number.`, {
        path,
        keyword,
      });
    }
  }
  for (const keyword of INTEGER_KEYWORDS) {
    if (node[keyword] !== undefined && (!Number.isSafeInteger(node[keyword]) || node[keyword] < 0)) {
      refuse(
        "mcp_schema_invalid",
        `The tool schema "${keyword}" at "${path}" must be a non-negative integer.`,
        { path, keyword },
      );
    }
  }
  if (node.pattern !== undefined && typeof node.pattern !== "string") {
    refuse("mcp_schema_invalid", `The tool schema "pattern" at "${path}" must be a string.`, { path });
  }
  if (node.items !== undefined) {
    assertKeywordShapes(node.items, `${path}.items`, counter, depth + 1);
  }
  for (const keyword of COMPOSITION_KEYWORDS) {
    if (Array.isArray(node[keyword])) {
      node[keyword].forEach((variant, index) => {
        assertKeywordShapes(variant, `${path}.${keyword}[${index}]`, counter, depth + 1);
      });
    }
  }
}

/**
 * Rebuilds a schema from accepted keywords only.
 *
 * Rebuilding is not cosmetic. It is what makes the allow-list authoritative:
 * whatever the check above admits, this function decides what actually travels
 * to the provider, so an unrecognized keyword has no path to the model even if
 * it somehow passed the check.
 */
function rebuildSchema(node) {
  const rebuilt = {};
  for (const key of MCP_SCHEMA_ACCEPTED_KEYWORDS) {
    if (node[key] === undefined) continue;
    if (key === "properties") {
      const properties = {};
      for (const [name, child] of Object.entries(node.properties ?? {})) {
        properties[name] = rebuildSchema(child);
      }
      rebuilt.properties = properties;
    } else if (key === "items" || key === "additionalProperties") {
      rebuilt[key] = typeof node[key] === "boolean" ? node[key] : rebuildSchema(node[key]);
    } else if (COMPOSITION_KEYWORDS.includes(key)) {
      rebuilt[key] = (node[key] ?? []).map(rebuildSchema);
    } else if (key === "enum") {
      rebuilt.enum = node.enum.slice();
    } else {
      rebuilt[key] = node[key];
    }
  }
  return rebuilt;
}

/**
 * Accepts or refuses one MCP tool definition.
 *
 * Returns a rebuilt, bounded `{name, description, parameters}` on success and
 * throws `McpSchemaError` otherwise. The caller treats a throw as "this tool is
 * unavailable", never as "this tool is available with a looser schema".
 */
export function acceptMcpToolDefinition({ name, description, inputSchema } = {}) {
  if (typeof name !== "string" || name.trim().length === 0) {
    refuse("mcp_tool_name_invalid", "The server advertised a tool without a usable name.");
  }
  if (byteLength(name) > MAX_MCP_TOOL_NAME_BYTES) {
    refuse(
      "mcp_tool_name_too_long",
      `The server advertised a tool name longer than ${MAX_MCP_TOOL_NAME_BYTES} bytes.`,
      { bytes: byteLength(name) },
    );
  }
  if (description !== undefined && typeof description !== "string") {
    refuse("mcp_tool_description_invalid", "The server advertised a non-string tool description.");
  }
  if (byteLength(description ?? "") > MAX_MCP_TOOL_DESCRIPTION_BYTES) {
    refuse(
      "mcp_tool_description_too_long",
      `The server advertised a tool description longer than ${MAX_MCP_TOOL_DESCRIPTION_BYTES} bytes.`,
      { bytes: byteLength(description ?? "") },
    );
  }
  // A server may legitimately advertise a tool with no parameters. Absent and
  // `null` are both treated as an empty object schema; anything else must be a
  // real schema we can validate.
  const schema = inputSchema === undefined || inputSchema === null ? { type: "object" } : inputSchema;
  if (!isPlainObject(schema)) {
    refuse("mcp_schema_invalid", "The server advertised a tool schema that is not an object.");
  }

  findUnsupportedKeyword(schema, "input", 0);
  assertKeywordShapes(schema, "input", { nodes: 0, properties: 0 }, 0);
  const rebuilt = rebuildSchema(schema);
  const bytes = byteLength(JSON.stringify(rebuilt));
  if (bytes > MAX_MCP_SCHEMA_BYTES) {
    refuse(
      "mcp_schema_too_large",
      `The tool schema exceeds ${MAX_MCP_SCHEMA_BYTES} bytes.`,
      { bytes },
    );
  }

  return Object.freeze({
    name,
    description: description ?? "",
    parameters: rebuilt,
    schema_bytes: bytes,
  });
}

/**
 * Validates call arguments against the rebuilt schema.
 *
 * This is a local, best-effort check whose purpose is to catch a malformed call
 * before it crosses the process boundary, not to be a complete JSON Schema
 * implementation. It deliberately does not "repair" anything: an argument that
 * fails a declared constraint is refused, because a server is entitled to
 * assume its own declared contract was honored.
 *
 * Unknown argument names are refused only when the schema says so. A schema
 * without `properties` accepts any object, matching JSON Schema.
 *
 * `format` is deliberately not enforced. It is an annotation in JSON Schema, so
 * enforcing it locally would make us stricter than the contract the server
 * wrote. Bounds (`minLength`, `maximum`, and the rest) are also not enforced
 * here: they are forwarded to the provider, which is where the model is told
 * them, and the server remains the authority on its own contract.
 */
export function assertMcpArguments(schema, args, path = "arguments") {
  if (args === undefined || args === null) {
    if (Array.isArray(schema?.required) && schema.required.length > 0) {
      refuse("mcp_arguments_invalid", `The call is missing required ${path}.`, {
        required: schema.required.slice(),
      });
    }
    return {};
  }
  if (!isPlainObject(args)) {
    refuse("mcp_arguments_invalid", `The ${path} must be an object.`, { path });
  }
  const expected = schema?.properties;
  if (isPlainObject(expected)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (args[key] === undefined) {
        refuse("mcp_arguments_invalid", `The ${path} are missing the required field "${key}".`, { field: key });
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(args)) {
        if (!Object.prototype.hasOwnProperty.call(expected, key)) {
          refuse("mcp_arguments_invalid", `The ${path} contain the undeclared field "${key}".`, { field: key });
        }
      }
    }
    for (const [key, value] of Object.entries(args)) {
      const property = expected[key];
      if (property === undefined || value === undefined) continue;
      assertMcpValue(property, value, `${path}.${key}`);
    }
  }
  return args;
}

function assertMcpValue(property, value, path) {
  if (Array.isArray(property.enum) && property.enum.length > 0) {
    if (!property.enum.some((candidate) => candidate === value)) {
      refuse("mcp_arguments_invalid", `The field "${path}" is not one of the declared values.`, { path });
    }
    return;
  }
  const declared = Array.isArray(property.type) ? property.type : [property.type];
  if (declared.every((type) => type === undefined)) return;
  const matches = declared.some((type) => valueMatchesType(type, value));
  if (!matches) {
    // `anyOf`/`oneOf` are satisfied by any variant; a value that reaches here
    // failed the top-level type and has no variant to fall back on.
    if (COMPOSITION_KEYWORDS.some((keyword) => Array.isArray(property[keyword]))) return;
    refuse("mcp_arguments_invalid", `The field "${path}" does not match the declared type.`, {
      path,
      expected: declared.filter((type) => type !== undefined),
    });
  }
  if (property.type === "object" || (Array.isArray(property.type) && property.type.includes("object"))) {
    if (isPlainObject(value) && isPlainObject(property.properties)) {
      assertMcpArguments(property, value, path);
    }
  }
}

function valueMatchesType(type, value) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isSafeInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    default:
      return true;
  }
}
