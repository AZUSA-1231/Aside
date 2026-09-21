import { Type } from "@earendil-works/pi-ai";
import {
  AsideContractError,
  byteLength,
  previewValue,
  sanitizeRuntimeText,
  truncateText,
} from "./agent-contracts.mjs";
import { createAsideToolRegistry } from "./capability-contract.mjs";
import {
  DocumentAdapterError,
  isDocumentBlock,
} from "./document-contract.mjs";
import { WorkspaceError } from "./workspace.mjs";
import { DEFAULT_PDF_ADAPTER } from "./pdf-adapter.mjs";
import { DEFAULT_DOCX_ADAPTER } from "./docx-adapter.mjs";

export { DocumentAdapterError };

const textEncoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export const DEFAULT_WORKSPACE_TOOL_LIMITS = Object.freeze({
  maxListEntries: 128,
  maxSearchFiles: 128,
  maxSearchResults: 64,
  maxSearchDepth: 24,
  maxSearchFileBytes: 64 * 1024,
  maxReadBytes: 256 * 1024,
  maxJsonExpandedBytes: 512 * 1024,
  maxJsonNodes: 10_000,
  maxOutputBytes: 24 * 1024,
  maxDetailsBytes: 16 * 1024,
  maxQueryBytes: 512,
  maxPathBytes: 1_024,
});

const unsupportedExtensions = new Set([
  ".7z",
  ".avif",
  ".bmp",
  ".class",
  ".doc",
  ".docm",
  ".docx",
  ".gif",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".ods",
  ".odt",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".rar",
  ".sqlite",
  ".tar",
  ".webp",
  ".xls",
  ".xlsx",
  ".zip",
  ".toml",
  ".xml",
  ".yaml",
  ".yml",
]);

function extensionOf(path) {
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = path.slice(lastSlash + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

function productPath(path) {
  return String(path).split(/[\\/]+/).join("/");
}

function boundedPath(value, limits) {
  if (typeof value !== "string" || value.length === 0) {
    invalidArgument("path", "must be a non-empty string");
  }
  if (byteLength(value) > limits.maxPathBytes) {
    invalidArgument("path", `must be at most ${limits.maxPathBytes} bytes`);
  }
  return value;
}

function invalidArgument(field, message) {
  throw new WorkspaceError(
    "invalid_argument",
    `The workspace tool argument "${field}" ${message}.`,
  );
}

function positiveInteger(value, field, maximum, fallback) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) {
    invalidArgument(field, `must be a positive integer no greater than ${maximum}`);
  }
  return result;
}

function boundedLimits(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AsideContractError("Workspace tool limits must be an object.");
  }
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULT_WORKSPACE_TOOL_LIMITS)) {
    const value = input[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value <= 0 || value > fallback) {
      throw new AsideContractError(
        `Workspace tool limit "${key}" must be a positive integer no greater than ${fallback}.`,
      );
    }
    result[key] = value;
  }
  return Object.freeze(result);
}

function throwIfAborted(signal, path) {
  if (signal?.aborted) {
    throw new WorkspaceError("aborted", "The workspace operation was cancelled.", path);
  }
}

function safeErrorMessage(error) {
  return sanitizeRuntimeText(
    error instanceof Error ? error.message : String(error),
    512,
  ).text;
}

function safeDetails(value, maxBytes, fallback = {}) {
  const preview = previewValue(value, maxBytes);
  if (!preview.truncated) {
    try {
      return JSON.parse(preview.text);
    } catch {
      return fallback;
    }
  }
  return {
    ...(fallback && typeof fallback === "object" ? fallback : {}),
    details_truncated: true,
    details_preview: preview.text,
  };
}

function resultText(value, maxBytes) {
  const bounded = sanitizeRuntimeText(value, maxBytes);
  return { text: bounded.text, truncated: bounded.truncated };
}

function pathDetails(resource) {
  return {
    addressed_path: resource.addressed_path,
    relative_path: resource.relative_path,
    canonical_path: resource.canonical_path,
  };
}

function successfulResult(tool, payload, body, limits, extra = {}) {
  const prefix = `${tool} succeeded\n`;
  const bounded = resultText(`${prefix}${body}`, limits.maxOutputBytes);
  const declaredTruncated = payload.truncated === true || extra.truncated === true;
  const truncated = bounded.truncated || declaredTruncated;
  const details = safeDetails(
    { status: "succeeded", tool, ...payload, ...extra, truncated },
    limits.maxDetailsBytes,
    { status: "succeeded", tool },
  );
  return {
    content: [{ type: "text", text: bounded.text }],
    details,
    ...(truncated ? { truncated: true } : {}),
  };
}

function failedResult(tool, error, limits, extra = {}) {
  const code = typeof error?.code === "string" ? error.code : "read_failed";
  const status = code === "unsupported_format" ? "unsupported" :
    code === "aborted" ? "cancelled" : "failed";
  const path = typeof error?.path === "string" ? error.path : undefined;
  const payload = {
    status,
    tool,
    code,
    ...(path ? { addressed_path: path } : {}),
    ...(error?.details && typeof error.details === "object"
      ? { error_details: safeDetails(error.details, 2_048) }
      : {}),
    error: {
      code,
      message: safeErrorMessage(error),
    },
    ...extra,
  };
  const bounded = resultText(`${tool} ${status}\n${JSON.stringify(payload, null, 2)}`, limits.maxOutputBytes);
  return {
    content: [{ type: "text", text: bounded.text }],
    details: safeDetails(payload, limits.maxDetailsBytes, { status, tool, code }),
    isError: true,
    ...(bounded.truncated ? { truncated: true } : {}),
  };
}

function decodeUtf8(bytes, path) {
  try {
    const text = utf8Decoder.decode(bytes);
    let controlCount = 0;
    for (const character of text) {
      const code = character.codePointAt(0);
      if (
        code === 0 ||
        (code < 32 && code !== 9 && code !== 10 && code !== 13 && code !== 12)
      ) {
        controlCount += 1;
      }
    }
    if (controlCount > 0 && controlCount / Math.max(1, text.length) > 0.01) {
      throw new WorkspaceError(
        "unsupported_format",
        "The workspace file is not a supported text representation.",
        path,
      );
    }
    return text;
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError(
      "unsupported_encoding",
      "The workspace file is not valid UTF-8 text.",
      path,
    );
  }
}

function jsonDepthAndNodes(value, maxDepth, maxNodes) {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > maxNodes || current.depth > maxDepth) return { bounded: false, nodes };
    if (!current.value || typeof current.value !== "object") continue;
    const values = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    for (const child of values) stack.push({ value: child, depth: current.depth + 1 });
  }
  return { bounded: true, nodes };
}

const defaultTextAdapter = Object.freeze({
  id: "text",
  formats: Object.freeze(["text", "markdown"]),
  // Content search may only match adapters that produce a text representation.
  textual: true,
  write: true,
  maxReadBytes: DEFAULT_WORKSPACE_TOOL_LIMITS.maxReadBytes,
  maxExpandedBytes: DEFAULT_WORKSPACE_TOOL_LIMITS.maxReadBytes,
  async read({ bytes, path }) {
    return {
      format: extensionOf(path) === ".md" || extensionOf(path) === ".markdown"
        ? "markdown"
        : "text",
      text: decodeUtf8(bytes, path),
      raw_bytes: bytes.byteLength,
    };
  },
});

const defaultJsonAdapter = Object.freeze({
  id: "json",
  formats: Object.freeze(["json"]),
  textual: true,
  write: true,
  maxReadBytes: DEFAULT_WORKSPACE_TOOL_LIMITS.maxReadBytes,
  maxExpandedBytes: DEFAULT_WORKSPACE_TOOL_LIMITS.maxJsonExpandedBytes,
  async read({ bytes, path, limits }) {
    const text = decodeUtf8(bytes, path);
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new DocumentAdapterError(
        "invalid_document",
        "The JSON document could not be parsed.",
        path,
      );
    }
    const bounded = jsonDepthAndNodes(value, 16, limits.maxJsonNodes);
    if (!bounded.bounded) {
      throw new DocumentAdapterError(
        "document_too_complex",
        "The JSON document exceeds the supported depth or node limit.",
        path,
        { nodes: bounded.nodes, max_nodes: limits.maxJsonNodes },
      );
    }
    let formatted;
    try {
      formatted = JSON.stringify(value, null, 2);
    } catch {
      throw new DocumentAdapterError(
        "invalid_document",
        "The JSON document could not be represented safely.",
        path,
      );
    }
    if (byteLength(formatted) > limits.maxJsonExpandedBytes) {
      throw new DocumentAdapterError(
        "document_too_large",
        "The expanded JSON document exceeds the read limit.",
        path,
        { expanded_bytes: byteLength(formatted), max_bytes: limits.maxJsonExpandedBytes },
      );
    }
    return {
      format: "json",
      text: formatted,
      value,
      raw_bytes: bytes.byteLength,
      expanded_bytes: byteLength(formatted),
      nodes: bounded.nodes,
    };
  },
});

export const DEFAULT_DOCUMENT_ADAPTERS = Object.freeze([
  defaultJsonAdapter,
  defaultTextAdapter,
  DEFAULT_PDF_ADAPTER,
  DEFAULT_DOCX_ADAPTER,
]);

/**
 * The formats the active adapters actually accept, derived from the adapters
 * themselves. The model's self-description is built from this rather than a
 * hand-written list, so adding an adapter cannot leave the prompt stale
 * (C6-I023).
 */
export function describeDocumentFormats(adapters = DEFAULT_DOCUMENT_ADAPTERS) {
  const readable = new Set();
  const writable = new Set();
  const generatable = new Set();
  for (const adapter of adapters) {
    for (const format of adapter.formats ?? []) {
      readable.add(format);
      if (adapter.write === true) writable.add(format);
      if (adapter.generatable === true) generatable.add(format);
    }
  }
  return Object.freeze({
    readable: Object.freeze([...readable].sort()),
    writable: Object.freeze([...writable].sort()),
    generatable: Object.freeze([...generatable].sort()),
  });
}

export function createDocumentAdapterRegistry(adapters = DEFAULT_DOCUMENT_ADAPTERS) {
  if (!Array.isArray(adapters) || adapters.length === 0) {
    throw new AsideContractError("At least one document adapter is required.");
  }
  const byId = new Map();
  for (const adapter of adapters) {
    if (
      !adapter ||
      typeof adapter !== "object" ||
      typeof adapter.id !== "string" ||
      !/^[a-z][a-z0-9_-]{0,31}$/.test(adapter.id) ||
      !Array.isArray(adapter.formats) ||
      adapter.formats.length === 0 ||
      adapter.formats.some((format) => typeof format !== "string") ||
      typeof adapter.write !== "boolean" ||
      (adapter.textual !== undefined && typeof adapter.textual !== "boolean") ||
      typeof adapter.read !== "function" ||
      (adapter.extensions !== undefined &&
        (!Array.isArray(adapter.extensions) ||
          adapter.extensions.some(
            (extension) =>
              typeof extension !== "string" ||
              !/^\.[a-z0-9]+$/.test(extension),
          )))
    ) {
      throw new AsideContractError("A document adapter has an invalid contract.");
    }
    if (byId.has(adapter.id)) {
      throw new AsideContractError(`The document adapter "${adapter.id}" is duplicated.`);
    }
    byId.set(adapter.id, adapter);
  }

  function get(id) {
    return byId.get(id);
  }

  function select(path, requestedFormat = "auto") {
    if (requestedFormat !== "auto") {
      const selected = get(requestedFormat);
      if (!selected || typeof selected.read !== "function") return undefined;
      return selected;
    }
    const extension = extensionOf(path);
    // A registered adapter that claims this extension wins over the built-in
    // unsupported-extension guard. Checking the guard first would make
    // declaring a format like `.pdf` have no effect at all.
    const declared = adapters.find(
      (adapter) =>
        Array.isArray(adapter.extensions) && adapter.extensions.includes(extension),
    );
    if (declared) return declared;
    if (unsupportedExtensions.has(extension)) return undefined;
    if (extension === ".json") return get("json");
    return get("text");
  }

  return Object.freeze({
    adapters: Object.freeze(adapters.slice()),
    get,
    select,
  });
}

const pathSchema = Type.String({
  description: "A relative path inside the active workspace, or an absolute path inside it.",
});
const positiveNumber = (description) => Type.Integer({ minimum: 1, description });
const nonNegativeNumber = (description) => Type.Integer({ minimum: 0, description });

export const WORKSPACE_READ_TOOL_SCHEMAS = Object.freeze({
  list: Type.Object({
    path: Type.Optional(pathSchema),
    limit: Type.Optional(positiveNumber("Maximum number of directory entries.")),
    offset: Type.Optional(
      nonNegativeNumber(
        "Zero-based entry offset. Use next_offset to continue a truncated listing.",
      ),
    ),
  }),
  search: Type.Object({
    query: Type.String({ description: "Text to find in names or supported text content." }),
    path: Type.Optional(pathSchema),
    mode: Type.Optional(Type.Union([
      Type.Literal("name"),
      Type.Literal("content"),
      Type.Literal("both"),
    ])),
    max_results: Type.Optional(positiveNumber("Maximum number of search results.")),
  }),
  stat: Type.Object({ path: pathSchema }),
  read: Type.Object({
    path: pathSchema,
    // Deliberately a bounded string rather than a fixed union: the valid set is
    // whatever the active adapter registry declares, and a union would silently
    // reject every format a later adapter adds. An unknown value is reported as
    // unsupported_format, not silently ignored.
    format: Type.Optional(
      Type.String({
        description:
          "Explicit format id. Omit or use \"auto\" to select by file extension. "
          + "Supported ids: \"text\", \"json\", \"pdf\", \"docx\".",
      }),
    ),
    offset: Type.Optional(positiveNumber("One-based line offset.")),
    limit: Type.Optional(positiveNumber("Maximum number of lines.")),
    byte_offset: Type.Optional(
      nonNegativeNumber(
        "Zero-based byte offset into the decoded text. Use next_byte_offset to continue a truncated read.",
      ),
    ),
    pages: Type.Optional(
      Type.String({
        description:
          "PDF only. A page or page range, for example \"1-3\" or \"2,5\". "
          + "Use next_page from a truncated read to continue.",
      }),
    ),
  }),
});

export async function readDocument(
  { workspace, documentRegistry, limits },
  path,
  format,
  signal,
  maxBytes = limits.maxReadBytes,
  selection,
) {
  throwIfAborted(signal, path);
  const resolved = await workspace.resolvePath(path, { expectedKind: "file" });
  const adapter = documentRegistry.select(path, format ?? "auto");
  if (!adapter) {
    throw new WorkspaceError(
      "unsupported_format",
      "The workspace file format is not supported by the active document adapters.",
      path,
      { extension: extensionOf(path), requested_format: format ?? "auto" },
    );
  }
  const adapterLimit = Number.isSafeInteger(adapter.maxReadBytes)
    ? adapter.maxReadBytes
    : limits.maxReadBytes;
  const bytes = await workspace.readBytes(path, {
    maxBytes: Math.min(maxBytes, adapterLimit),
    signal,
  });
  const document = await adapter.read({ bytes: bytes.bytes, path, limits, signal, selection });
  if (!document || typeof document !== "object") {
    throw new DocumentAdapterError(
      "invalid_document",
      "The document adapter returned an invalid representation.",
      path,
    );
  }
  // An adapter returns either a text representation or structured blocks. It
  // must not be forced to invent a text field it cannot produce honestly.
  const hasText = typeof document.text === "string";
  const hasBlocks = Array.isArray(document.blocks);
  if (!hasText && !hasBlocks) {
    throw new DocumentAdapterError(
      "invalid_document",
      "The document adapter returned neither text nor structured blocks.",
      path,
    );
  }
  const expandedBytes = hasText
    ? byteLength(document.text)
    : byteLength(JSON.stringify(document.blocks));
  const maxExpandedBytes = Number.isSafeInteger(adapter.maxExpandedBytes)
    ? adapter.maxExpandedBytes
    : limits.maxReadBytes;
  if (expandedBytes > maxExpandedBytes) {
    throw new DocumentAdapterError(
      "document_too_large",
      "The expanded document exceeds the adapter limit.",
      path,
      { expanded_bytes: expandedBytes, max_bytes: maxExpandedBytes },
    );
  }
  throwIfAborted(signal, path);
  return {
    resolved: bytes,
    adapter,
    document,
    // Raw text is the exact original bytes for the write path. A binary
    // adapter has none, and decoding its bytes as UTF-8 would either throw or
    // silently corrupt them.
    ...(hasText ? { raw_text: decodeUtf8(bytes.bytes, path) } : {}),
  };
}

export async function validateDocumentText({ documentRegistry, limits, path, format = "auto", text, signal }) {
  if (typeof text !== "string") {
    throw new WorkspaceError("invalid_argument", "Document content must be text.", path);
  }
  const adapter = documentRegistry.select(path, format);
  if (!adapter || adapter.write !== true) {
    throw new WorkspaceError(
      "unsupported_format",
      "The document format cannot be written by the active adapter.",
      path,
    );
  }
  const bytes = textEncoder.encode(text);
  const maxBytes = Number.isSafeInteger(adapter.maxReadBytes)
    ? adapter.maxReadBytes
    : limits.maxReadBytes;
  if (bytes.byteLength > maxBytes) {
    throw new WorkspaceError("result_too_large", "The document content exceeds the write limit.", path, {
      size: bytes.byteLength,
      max_bytes: maxBytes,
    });
  }
  const document = await adapter.read({ bytes, path, limits, signal });
  return { adapter, document, bytes };
}

function selectLines(text, offset, limit) {
  const lines = text.split("\n");
  const start = (offset ?? 1) - 1;
  if (start >= lines.length) {
    throw new WorkspaceError(
      "invalid_offset",
      `The requested line offset is beyond the document (${lines.length} lines).`,
    );
  }
  const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit);
  // Character index of the first selected line, so the selection can also be
  // reported and continued in bytes.
  let startIndex = 0;
  for (let index = 0; index < start; index += 1) startIndex += lines[index].length + 1;
  const hasMore = end < lines.length;
  // Slice rather than re-join, and keep the terminating newline when more lines
  // follow. The returned text is then exactly the file's bytes for those lines,
  // so a byte continuation resumes at the same boundary as a line continuation
  // and iterating either one reconstructs the file without gaps.
  let endIndex = text.length;
  if (hasMore) {
    endIndex = startIndex;
    for (let index = start; index < end; index += 1) {
      endIndex += lines[index].length + 1;
    }
  }
  return {
    text: text.slice(startIndex, endIndex),
    start_line: start + 1,
    end_line: end,
    start_index: startIndex,
    total_lines: lines.length,
    has_more: hasMore,
  };
}

/** Number of lines the given text spans, counting a trailing newline as ending
 *  the line it terminates rather than starting a new empty one. */
function countLines(text) {
  if (text.length === 0) return 0;
  let newlines = 0;
  for (const character of text) {
    if (character === "\n") newlines += 1;
  }
  return text.endsWith("\n") ? newlines : newlines + 1;
}

function lineCountAt(text, index, startLine = 1) {
  let lines = startLine;
  for (let position = 0; position < index; position += 1) {
    if (text[position] === "\n") lines += 1;
  }
  return lines;
}

/**
 * Resolves a byte offset to a character index, advancing past any character
 * that straddles the boundary. Advancing rather than retreating means a
 * continuation never re-delivers bytes the caller already received; the
 * returned `bytes` is the position actually used.
 */
function locateByteOffset(text, byteOffset) {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new WorkspaceError("invalid_offset", "The requested byte offset is invalid.");
  }
  const total = byteLength(text);
  if (byteOffset > total) {
    throw new WorkspaceError(
      "invalid_offset",
      `The requested byte offset is beyond the document (${total} bytes).`,
    );
  }
  let bytes = 0;
  let index = 0;
  for (const character of text) {
    if (bytes >= byteOffset) break;
    bytes += byteLength(character);
    index += character.length;
  }
  return { index, bytes };
}

function lineSnippet(text, index, maxBytes = 384) {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const lineEnd = text.indexOf("\n", index);
  const end = lineEnd < 0 ? text.length : lineEnd;
  const line = text.slice(lineStart, end);
  const bounded = sanitizeRuntimeText(line, maxBytes);
  return {
    line: text.slice(0, index).split("\n").length,
    text: bounded.text,
    truncated: bounded.truncated,
  };
}

async function handleList({ workspace, limits }, params, signal) {
  const maxEntries = positiveInteger(
    params?.limit,
    "limit",
    limits.maxListEntries,
    limits.maxListEntries,
  );
  const path = boundedPath(params?.path ?? ".", limits);
  const offset = params?.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new WorkspaceError("invalid_offset", "The directory entry offset is invalid.", path);
  }
  const listed = await workspace.listDirectory(path, {
    maxEntries,
    offset,
    signal,
  });
  throwIfAborted(signal, path);
  // Entries are ordered by name, so a cursor is stable across calls.
  const entries = listed.entries.map((entry) => ({
    name: entry.name,
    path: productPath(entry.addressed_path),
    kind: entry.kind,
    size: entry.size,
    mtime_ms: entry.mtime_ms,
  }));
  const continuation = {
    ...(listed.offset === undefined ? {} : { offset: listed.offset }),
    ...(listed.total_entries === undefined ? {} : { total_entries: listed.total_entries }),
    ...(listed.next_offset === undefined ? {} : { next_offset: listed.next_offset }),
  };
  const payload = {
    ...pathDetails(listed),
    entries,
    entry_count: entries.length,
    truncated: listed.truncated,
    ...continuation,
  };
  return successfulResult(
    "workspace.list",
    payload,
    JSON.stringify({
      path: listed.relative_path,
      entries,
      truncated: listed.truncated,
      ...continuation,
    }, null, 2),
    limits,
  );
}

async function handleStat({ workspace, limits }, params, signal) {
  const path = boundedPath(params?.path, limits);
  const resource = await workspace.statPath(path);
  throwIfAborted(signal, path);
  const payload = {
    ...pathDetails(resource),
    kind: resource.kind,
    exists: resource.exists,
    size: resource.identity?.size ?? 0,
    mtime_ms: resource.identity?.mtime_ms ?? 0,
  };
  return successfulResult("workspace.stat", payload, JSON.stringify(payload, null, 2), limits);
}

/**
 * Renders structured blocks into bounded text and reports whether the byte
 * budget cut the extraction short. Continuation is by page, because that is
 * the locator a paginated document actually has.
 */
function structuredReadResult(loaded, limits) {
  const document = loaded.document;
  const blocks = Array.isArray(document.blocks) ? document.blocks : [];
  const { text, truncated, lastPage } = renderDocumentBlocks(blocks, limits);
  const metadata = document.metadata ?? {};
  const pageCount = metadata.pages;
  const nextPage = truncated && lastPage !== undefined && lastPage < pageCount
    ? lastPage + 1
    : undefined;
  const warnings = Array.isArray(document.warnings) ? document.warnings : [];
  const payload = {
    ...pathDetails(loaded.resolved),
    format: document.format,
    ...(document.media_type ? { media_type: document.media_type } : {}),
    size: loaded.resolved.identity.size,
    ...(pageCount === undefined ? {} : { page_count: pageCount }),
    ...(metadata.pages_read === undefined ? {} : { pages_read: metadata.pages_read }),
    ...(metadata.title ? { title: metadata.title } : {}),
    ...(metadata.author ? { author: metadata.author } : {}),
    block_count: blocks.length,
    partial: document.partial === true,
    warnings,
    truncated,
    ...(nextPage === undefined ? {} : { next_page: nextPage }),
  };
  const header = JSON.stringify({
    path: loaded.resolved.relative_path,
    format: document.format,
    ...(pageCount === undefined ? {} : { page_count: pageCount }),
    ...(nextPage === undefined ? {} : { next_page: nextPage }),
    truncated,
    ...(warnings.length === 0 ? {} : { warnings }),
  }, null, 2);
  return successfulResult(
    "workspace.read",
    payload,
    `${header}\n\n${text}`,
    limits,
    { truncated },
  );
}

/**
 * Renders one block into the text the model reads.
 *
 * Every supported type renders its own content and its own kind. The first
 * version took `block.text` for anything that was not a page break, which
 * quietly discarded every block whose content lives elsewhere — a Word table
 * carries `rows` — and flattened headings and list items into plain paragraphs
 * even though the adapter had distinguished them. The model saw an empty line,
 * which reads as "this document has a blank paragraph here": a claim about the
 * document rather than about the renderer. See A03.
 */
function renderDocumentBlock(block) {
  switch (block?.type) {
    case "page_break":
      return `\n--- page ${block.locator?.page ?? "?"} ---`;
    case "heading": {
      const level = Math.min(Math.max(Number(block.level) || 1, 1), 6);
      return `${"#".repeat(level)} ${String(block.text ?? "")}`;
    }
    case "list_item":
      return `- ${String(block.text ?? "")}`;
    case "paragraph":
      return String(block.text ?? "");
    case "table": {
      const rows = Array.isArray(block.rows) ? block.rows : [];
      if (rows.length === 0) return "[empty table]";
      const rendered = rows
        .map((row) => {
          const cells = Array.isArray(row) ? row : [row];
          return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
        })
        .join("\n");
      // The adapter marks a table whose rows were cut, and that has to travel
      // with the table rather than only into `details`.
      return block.truncated === true ? `${rendered}\n[table truncated]` : rendered;
    }
    default:
      // Never an empty line. A block this renderer does not understand must say
      // so, because silence is indistinguishable from an empty paragraph in the
      // document — and the model has no way to tell which it is looking at.
      return `[unsupported block: ${String(block?.type ?? "unknown")}]`;
  }
}

/**
 * Exported so the model-visible rendering of a document can be tested directly.
 *
 * This function decides what the model is told a document contains, and A03 was
 * a defect in it that the adapter tests could not reach — they asserted the
 * blocks the adapter produced, one layer below where the loss happened. A pure
 * function this load-bearing should be reachable without a synthetic adapter.
 */
export function renderDocumentBlocks(blocks, limits) {
  const budget = Math.max(128, limits.maxOutputBytes - 512);
  const lines = [];
  let bytes = 0;
  let truncated = false;
  let lastPage;
  for (const block of blocks) {
    const line = renderDocumentBlock(block);
    const cost = byteLength(line) + 1;
    if (bytes + cost > budget) {
      truncated = true;
      break;
    }
    bytes += cost;
    lines.push(line);
    if (block.locator?.page !== undefined) lastPage = block.locator.page;
  }
  return { text: lines.join("\n"), truncated, lastPage };
}

async function handleRead({ workspace, documentRegistry, limits }, params, signal) {
  const path = boundedPath(params?.path, limits);
  const loaded = await readDocument(
    { workspace, documentRegistry, limits },
    path,
    params?.format,
    signal,
    limits.maxReadBytes,
    { pages: params?.pages },
  );
  if (typeof loaded.document.text !== "string") {
    return structuredReadResult(loaded, limits);
  }
  const text = loaded.document.text;
  const totalBytes = byteLength(text);
  const totalLines = lineCountAt(text, text.length);
  const contentBudget = Math.max(128, limits.maxOutputBytes - 512);

  // A byte offset resumes a truncated read; a line offset selects whole lines.
  let remainder;
  let offsetBytes;
  let startLine;
  let hasMoreLines = false;
  if (params?.byte_offset !== undefined) {
    const located = locateByteOffset(text, params.byte_offset);
    remainder = text.slice(located.index);
    offsetBytes = located.bytes;
    startLine = lineCountAt(text, located.index);
  } else {
    const selected = selectLines(text, params?.offset, params?.limit);
    remainder = selected.text;
    offsetBytes = byteLength(text.slice(0, selected.start_index));
    startLine = selected.start_line;
    hasMoreLines = selected.has_more;
  }

  const boundedContent = truncateText(remainder, contentBudget);
  const contentBytes = byteLength(boundedContent.text);
  const truncated = hasMoreLines || boundedContent.truncated;
  // The continuation is the byte immediately after the last byte actually
  // returned, so a caller iterating on it can never skip or duplicate content —
  // including when the cut falls inside one very long line.
  const nextByteOffset = truncated ? offsetBytes + contentBytes : undefined;
  const returnedLines = countLines(boundedContent.text);
  const continuation = {
    ...(nextByteOffset === undefined ? {} : { next_byte_offset: nextByteOffset }),
    ...(hasMoreLines ? { next_offset: startLine + returnedLines } : {}),
  };
  const payload = {
    ...pathDetails(loaded.resolved),
    format: loaded.document.format,
    size: loaded.resolved.identity.size,
    offset: startLine,
    offset_bytes: offsetBytes,
    lines: returnedLines,
    total_lines: totalLines,
    total_bytes: totalBytes,
    content_bytes: contentBytes,
    truncated,
    ...continuation,
    ...(loaded.document.nodes === undefined ? {} : { json_nodes: loaded.document.nodes }),
  };
  const header = JSON.stringify({
    path: loaded.resolved.relative_path,
    format: loaded.document.format,
    offset: startLine,
    offset_bytes: offsetBytes,
    truncated,
    ...continuation,
  }, null, 2);
  const body = `${header}\n\n${boundedContent.text}`;
  return successfulResult("workspace.read", payload, body, limits, { truncated });
}

async function handleSearch({ workspace, documentRegistry, limits }, params, signal) {
  const query = typeof params?.query === "string" ? params.query : "";
  if (query.trim().length === 0 || byteLength(query) > limits.maxQueryBytes) {
    invalidArgument("query", `must be non-empty and at most ${limits.maxQueryBytes} bytes`);
  }
  const mode = params?.mode ?? "both";
  if (!["name", "content", "both"].includes(mode)) invalidArgument("mode", "is unsupported");
  const maxResults = positiveInteger(
    params?.max_results,
    "max_results",
    limits.maxSearchResults,
    limits.maxSearchResults,
  );
  const queryLower = query.toLocaleLowerCase();
  const searchPath = boundedPath(params?.path ?? ".", limits);
  const results = [];
  const diagnostics = [];
  const visitedDirectories = new Set();
  let scannedFiles = 0;
  let truncated = false;

  async function inspectFile(path) {
    throwIfAborted(signal, path);
    if (scannedFiles >= limits.maxSearchFiles) {
      truncated = true;
      return;
    }
    scannedFiles += 1;
    const displayPath = productPath(path);
    const matches = [];
    if (mode === "name" || mode === "both") {
      if (displayPath.toLocaleLowerCase().includes(queryLower)) matches.push({ type: "name" });
    }
    if (mode === "content" || mode === "both") {
      // A binary adapter has no text representation to match against, and
      // parsing it here would be both wrong and expensive.
      const selected = documentRegistry.select(path, "auto");
      if (selected && selected.textual !== true) {
        diagnostics.push({ path: displayPath, code: "unsupported_format" });
        return;
      }
      try {
        const loaded = await readDocument(
          { workspace, documentRegistry, limits },
          path,
          "auto",
          signal,
          limits.maxSearchFileBytes,
        );
        if (typeof loaded.document.text !== "string") {
          diagnostics.push({ path: displayPath, code: "unsupported_format" });
          return;
        }
        const contentLower = loaded.document.text.toLocaleLowerCase();
        const index = contentLower.indexOf(queryLower);
        if (index >= 0) {
          matches.push({
            type: "content",
            format: loaded.document.format,
            ...lineSnippet(loaded.document.text, index),
          });
        }
      } catch (error) {
        if (error?.code === "unsupported_format" || error?.code === "result_too_large") {
          diagnostics.push({ path: displayPath, code: error.code });
          return;
        }
        if (error?.code === "invalid_document" || error?.code === "unsupported_encoding") {
          diagnostics.push({ path: displayPath, code: error.code });
          return;
        }
        throw error;
      }
    }
    if (matches.length > 0) {
      if (results.length >= maxResults) {
        truncated = true;
        return;
      }
      results.push({ path: displayPath, matches });
    }
  }

  async function visit(path, depth) {
    throwIfAborted(signal, path);
    const resource = await workspace.resolvePath(path);
    if (resource.kind === "file") {
      await inspectFile(resource.relative_path);
      return;
    }
    if (depth > limits.maxSearchDepth) {
      truncated = true;
      return;
    }
    if (visitedDirectories.has(resource.canonical_path)) return;
    visitedDirectories.add(resource.canonical_path);
    const listed = await workspace.listDirectory(path, {
      maxEntries: limits.maxListEntries,
      signal,
    });
    truncated ||= listed.truncated;
    for (const entry of listed.entries) {
      throwIfAborted(signal, entry.addressed_path);
      if (results.length >= maxResults) {
        truncated = true;
        return;
      }
      if (entry.kind === "directory") await visit(entry.addressed_path, depth + 1);
      else if (entry.kind === "file") await inspectFile(entry.addressed_path);
    }
  }

  await visit(searchPath, 0);
  const payload = {
    query: sanitizeRuntimeText(query, limits.maxQueryBytes).text,
    mode,
    path: productPath(searchPath),
    results,
    result_count: results.length,
    scanned_files: scannedFiles,
    diagnostics,
    truncated,
  };
  return successfulResult(
    "workspace.search",
    payload,
    JSON.stringify({
      query: payload.query,
      mode,
      results,
      diagnostics,
      truncated,
    }, null, 2),
    limits,
    { truncated },
  );
}

const toolDefinitions = [
  {
    name: "workspace.list",
    description: "List bounded file and directory metadata in the active workspace.",
    label: "List workspace",
    parameters: WORKSPACE_READ_TOOL_SCHEMAS.list,
    descriptor: {
      effect: "read",
      scope: "workspace",
      egress: "none",
      replay: "safe",
      availability: { prerequisites: ["workspace"] },
    },
  },
  {
    name: "workspace.search",
    description:
      "Search bounded names, or the text content of text, Markdown, and JSON "
      + "files, in the active workspace. PDF and Word documents are listed by "
      + "name but their content is not searched.",
    label: "Search workspace",
    parameters: WORKSPACE_READ_TOOL_SCHEMAS.search,
    descriptor: {
      effect: "read",
      scope: "workspace",
      egress: "none",
      replay: "safe",
      availability: { prerequisites: ["workspace"] },
    },
  },
  {
    name: "workspace.stat",
    description: "Inspect bounded metadata for one active-workspace file or directory.",
    label: "Inspect workspace item",
    parameters: WORKSPACE_READ_TOOL_SCHEMAS.stat,
    descriptor: {
      effect: "read",
      scope: "workspace",
      egress: "none",
      replay: "safe",
      availability: { prerequisites: ["workspace"] },
    },
  },
  {
    name: "workspace.read",
    description:
      "Read bounded content from one file in the active workspace. Supports UTF-8 "
      + "text, Markdown, JSON, PDF, and Word .docx. PDF returns text and page "
      + "numbers (no images, no OCR). Word returns headings, paragraphs, lists, "
      + "tables and links in document order. Long content is truncated and "
      + "reports how to continue.",
    label: "Read workspace file",
    parameters: WORKSPACE_READ_TOOL_SCHEMAS.read,
    descriptor: {
      effect: "read",
      scope: "workspace",
      egress: "none",
      replay: "safe",
      availability: { prerequisites: ["workspace"] },
    },
  },
];

export function createWorkspaceReadTools({ limits, documentAdapters } = {}) {
  const configuredLimits = boundedLimits(limits);
  const documentRegistry = documentAdapters?.select
    ? documentAdapters
    : documentAdapters
      ? createDocumentAdapterRegistry(documentAdapters)
      : createDocumentAdapterRegistry();
  return Object.freeze(toolDefinitions.map((definition) => ({
    ...definition,
    async createForRun({ workspace, taskRun } = {}) {
      if (!workspace) {
        throw new WorkspaceError("workspace_required", "A valid workspace is required.");
      }
      const runLimits = Object.freeze({
        ...configuredLimits,
        maxOutputBytes: Math.min(
          configuredLimits.maxOutputBytes,
          taskRun?.limits?.maxToolResultBytes ?? configuredLimits.maxOutputBytes,
        ),
      });
      return {
        ...definition,
        async execute(_toolCallId, params, signal) {
          try {
            throwIfAborted(signal, params?.path);
            const handler = definition.name === "workspace.list"
              ? handleList
              : definition.name === "workspace.search"
                ? handleSearch
                : definition.name === "workspace.stat"
                  ? handleStat
                  : handleRead;
            return await handler({
              workspace,
              taskRun,
              limits: runLimits,
              documentRegistry,
            }, params, signal);
          } catch (error) {
            return failedResult(definition.name, error, runLimits);
          }
        },
      };
    },
  })));
}

export function createWorkspaceReadRegistry(options) {
  return createAsideToolRegistry(createWorkspaceReadTools(options));
}
