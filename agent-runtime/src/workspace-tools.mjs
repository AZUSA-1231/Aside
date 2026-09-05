import { Type } from "@earendil-works/pi-ai";
import {
  AsideContractError,
  byteLength,
  createAsideToolRegistry,
  previewValue,
  sanitizeRuntimeText,
  truncateText,
} from "./agent-contracts.mjs";
import { WorkspaceError } from "./workspace.mjs";

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

export class DocumentAdapterError extends Error {
  constructor(code, message, path, details) {
    super(message);
    this.name = "DocumentAdapterError";
    this.code = code;
    this.path = path;
    this.details = details;
  }
}

const defaultTextAdapter = Object.freeze({
  id: "text",
  formats: Object.freeze(["text", "markdown"]),
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
]);

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
      typeof adapter.read !== "function"
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
    if (unsupportedExtensions.has(extensionOf(path))) return undefined;
    if (extensionOf(path) === ".json") return get("json");
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

export const WORKSPACE_READ_TOOL_SCHEMAS = Object.freeze({
  list: Type.Object({
    path: Type.Optional(pathSchema),
    limit: Type.Optional(positiveNumber("Maximum number of directory entries.")),
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
    format: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("text"), Type.Literal("json")])),
    offset: Type.Optional(positiveNumber("One-based line offset.")),
    limit: Type.Optional(positiveNumber("Maximum number of lines.")),
  }),
});

export async function readDocument({ workspace, documentRegistry, limits }, path, format, signal, maxBytes = limits.maxReadBytes) {
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
  const document = await adapter.read({ bytes: bytes.bytes, path, limits });
  if (!document || typeof document !== "object" || typeof document.text !== "string") {
    throw new DocumentAdapterError(
      "invalid_document",
      "The document adapter returned an invalid text representation.",
      path,
    );
  }
  const maxExpandedBytes = Number.isSafeInteger(adapter.maxExpandedBytes)
    ? adapter.maxExpandedBytes
    : limits.maxReadBytes;
  if (byteLength(document.text) > maxExpandedBytes) {
    throw new DocumentAdapterError(
      "document_too_large",
      "The expanded document exceeds the adapter limit.",
      path,
      { expanded_bytes: byteLength(document.text), max_bytes: maxExpandedBytes },
    );
  }
  return { resolved: bytes, adapter, document, raw_text: decodeUtf8(bytes.bytes, path) };
}

export async function validateDocumentText({ documentRegistry, limits, path, format = "auto", text }) {
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
  const document = await adapter.read({ bytes, path, limits });
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
  return {
    text: lines.slice(start, end).join("\n"),
    start_line: start + 1,
    end_line: end,
    total_lines: lines.length,
    has_more: end < lines.length,
  };
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
  const listed = await workspace.listDirectory(path, {
    maxEntries,
    signal,
  });
  throwIfAborted(signal, path);
  const entries = listed.entries.map((entry) => ({
    name: entry.name,
    path: productPath(entry.addressed_path),
    kind: entry.kind,
    size: entry.size,
    mtime_ms: entry.mtime_ms,
  }));
  const payload = {
    ...pathDetails(listed),
    entries,
    entry_count: entries.length,
    truncated: listed.truncated,
  };
  return successfulResult(
    "workspace.list",
    payload,
    JSON.stringify({
      path: listed.relative_path,
      entries,
      truncated: listed.truncated,
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

async function handleRead({ workspace, documentRegistry, limits }, params, signal) {
  const path = boundedPath(params?.path, limits);
  const loaded = await readDocument(
    { workspace, documentRegistry, limits },
    path,
    params?.format,
    signal,
  );
  const selected = selectLines(loaded.document.text, params?.offset, params?.limit);
  const contentBudget = Math.max(128, limits.maxOutputBytes - 512);
  const boundedContent = truncateText(selected.text, contentBudget);
  const truncated = selected.has_more || boundedContent.truncated;
  const payload = {
    ...pathDetails(loaded.resolved),
    format: loaded.document.format,
    size: loaded.resolved.identity.size,
    offset: selected.start_line,
    lines: selected.end_line - selected.start_line + 1,
    total_lines: selected.total_lines,
    content_bytes: byteLength(boundedContent.text),
    truncated,
    ...(selected.has_more ? { next_offset: selected.end_line + 1 } : {}),
    ...(loaded.document.nodes === undefined ? {} : { json_nodes: loaded.document.nodes }),
  };
  const header = JSON.stringify({
    path: loaded.resolved.relative_path,
    format: loaded.document.format,
    offset: selected.start_line,
    truncated,
    ...(selected.has_more ? { next_offset: selected.end_line + 1 } : {}),
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
      try {
        const loaded = await readDocument(
          { workspace, documentRegistry, limits },
          path,
          "auto",
          signal,
          limits.maxSearchFileBytes,
        );
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
    descriptor: { effect: "read", scope: "workspace", replay: "safe" },
  },
  {
    name: "workspace.search",
    description: "Search bounded names or supported text content in the active workspace.",
    label: "Search workspace",
    parameters: WORKSPACE_READ_TOOL_SCHEMAS.search,
    descriptor: { effect: "read", scope: "workspace", replay: "safe" },
  },
  {
    name: "workspace.stat",
    description: "Inspect bounded metadata for one active-workspace file or directory.",
    label: "Inspect workspace item",
    parameters: WORKSPACE_READ_TOOL_SCHEMAS.stat,
    descriptor: { effect: "read", scope: "workspace", replay: "safe" },
  },
  {
    name: "workspace.read",
    description: "Read bounded UTF-8 text, Markdown, or JSON from the active workspace.",
    label: "Read workspace file",
    parameters: WORKSPACE_READ_TOOL_SCHEMAS.read,
    descriptor: { effect: "read", scope: "workspace", replay: "safe" },
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
