import { byteLength, isPlainObject, truncateText } from "./agent-contracts.mjs";

/**
 * Bounded normalization of MCP tool results.
 *
 * An MCP result is a `content` array whose members were chosen by the server.
 * The SDK validates the array's shape but passes the members through as they
 * are, including images, audio, embedded resources, and resource links — this
 * was confirmed against the SDK rather than assumed, and the faux server's
 * `unsupported-content` scenario reproduces it.
 *
 * Every member type therefore needs an explicit disposition. The rule this
 * module applies is: carry what the model can actually use, account for what is
 * dropped, and never let the server decide how much of the conversation it owns.
 * A silently dropped image reads to the model as "the tool returned nothing",
 * which is a lie of omission, so omissions are reported.
 */

export const MAX_MCP_RESULT_BYTES = 256 * 1024;
export const MAX_MCP_TEXT_BLOCK_BYTES = 64 * 1024;
export const MAX_MCP_CONTENT_BLOCKS = 64;
export const MAX_MCP_RESOURCE_LINKS = 16;
export const MAX_MCP_STRUCTURED_BYTES = 64 * 1024;

export class McpResultError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "McpResultError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function omit(reason, detail) {
  return { omitted: reason, ...(detail ? { detail } : {}) };
}

/**
 * Normalizes one `content` member.
 *
 * Returns `{ text }` for members that carry model-usable text and
 * `{ omission }` for members that are deliberately not carried. Never returns
 * the raw member: annotations, binary payloads, and unknown block types have no
 * path out of this function.
 */
function normalizeBlock(block, limits) {
  if (!isPlainObject(block)) {
    return { omission: omit("unrecognized_block") };
  }
  switch (block.type) {
    case "text": {
      if (typeof block.text !== "string") return { omission: omit("text_block_without_text") };
      const bounded = truncateText(block.text, Math.min(limits.maxTextBlockBytes, MAX_MCP_TEXT_BLOCK_BYTES));
      return { text: bounded.text, truncated: bounded.truncated, omission: bounded.truncated ? omit("text_truncated") : undefined };
    }
    case "image":
      return { omission: omit("image", typeof block.mimeType === "string" ? block.mimeType : undefined) };
    case "audio":
      return { omission: omit("audio", typeof block.mimeType === "string" ? block.mimeType : undefined) };
    case "resource_link":
      // A link is a small identifier the model can cite, so it is carried.
      return {
        link: typeof block.uri === "string" ? truncateText(block.uri, 2_048).text : undefined,
        omission: undefined,
      };
    case "resource": {
      const resource = isPlainObject(block.resource) ? block.resource : undefined;
      // An embedded text resource is carried as text, because refusing useful
      // prose the server already sent would make the tool look empty. A binary
      // blob is not carried: we cannot show it to the model and should not
      // pretend it arrived.
      if (resource && typeof resource.text === "string") {
        const bounded = truncateText(resource.text, Math.min(limits.maxTextBlockBytes, MAX_MCP_TEXT_BLOCK_BYTES));
        const uri = typeof resource.uri === "string" ? truncateText(resource.uri, 2_048).text : undefined;
        return {
          text: bounded.text,
          uri,
          truncated: bounded.truncated,
          omission: bounded.truncated ? omit("text_truncated") : undefined,
        };
      }
      const uri = resource && typeof resource.uri === "string"
        ? truncateText(resource.uri, 2_048).text
        : undefined;
      return { omission: omit("embedded_blob_resource", uri) };
    }
    default:
      return { omission: omit("unsupported_block_type", String(block.type)) };
  }
}

/**
 * Converts an MCP call result into the bounded shape the Aside tool envelope
 * carries.
 *
 * `isError` from the server is preserved as a distinct flag rather than folded
 * into the text: a server reporting a failed call is different from a transport
 * failure, and the adapter's status mapping depends on telling them apart.
 */
export function normalizeMcpResult(result, options = {}) {
  const limits = {
    maxResultBytes: options.maxResultBytes ?? MAX_MCP_RESULT_BYTES,
    maxTextBlockBytes: options.maxTextBlockBytes ?? MAX_MCP_TEXT_BLOCK_BYTES,
  };
  if (!isPlainObject(result)) {
    throw new McpResultError("mcp_result_malformed", "The server returned a result that is not an object.");
  }
  const blocks = Array.isArray(result.content) ? result.content : [];
  if (result.content !== undefined && !Array.isArray(result.content)) {
    throw new McpResultError("mcp_result_malformed", "The server returned a content field that is not an array.");
  }

  const parts = [];
  const omissions = [];
  const links = [];
  let truncated = false;
  let carried = 0;
  let sawOversizedMember = false;

  for (const block of blocks) {
    if (carried >= MAX_MCP_CONTENT_BLOCKS) {
      omissions.push(omit("too_many_content_blocks"));
      sawOversizedMember = true;
      break;
    }
    carried += 1;
    const normalized = normalizeBlock(block, limits);
    if (normalized.truncated) truncated = true;
    if (normalized.omission) {
      if (normalized.omission.omitted === "text_truncated") truncated = true;
      else omissions.push(normalized.omission);
    }
    if (normalized.link) {
      if (links.length < MAX_MCP_RESOURCE_LINKS) links.push(normalized.link);
      else omissions.push(omit("too_many_resource_links"));
      continue;
    }
    if (normalized.text) {
      parts.push(normalized.uri ? `${normalized.uri}\n${normalized.text}` : normalized.text);
    }
  }

  let text = parts.join("\n\n");
  const bounded = truncateText(text, limits.maxResultBytes);
  if (bounded.truncated) truncated = true;
  text = bounded.text;

  let structured;
  if (result.structuredContent !== undefined) {
    try {
      const encoded = JSON.stringify(result.structuredContent);
      if (typeof encoded === "string") {
        const limit = Math.min(limits.maxResultBytes, MAX_MCP_STRUCTURED_BYTES);
        const structuredBounded = truncateText(encoded, limit);
        if (structuredBounded.truncated) truncated = true;
        structured = structuredBounded.text;
      }
    } catch {
      // A value that cannot be serialized is reported as absent rather than
      // crashing the call. It reached us through JSON-RPC, so this is
      // defensive only.
      omissions.push(omit("structured_content_unserializable"));
    }
  }

  if (text.length === 0 && structured === undefined && links.length === 0) {
    omissions.push(omit("empty_result"));
  }

  return Object.freeze({
    text,
    structured,
    links: Object.freeze(links.slice()),
    omissions: Object.freeze(omissions.map((entry) => Object.freeze(entry))),
    truncated,
    is_error: result.isError === true,
    bytes: byteLength(text) + (structured ? byteLength(structured) : 0),
    // A result the server marked as an error still carries its text; the flag
    // is what the adapter keys on, not the presence of text.
    omitted_anything: omissions.length > 0 || sawOversizedMember,
  });
}
