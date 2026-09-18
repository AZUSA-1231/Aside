import { Type } from "@earendil-works/pi-ai";
import { byteLength, previewValue, sanitizeRuntimeText } from "./agent-contracts.mjs";
import { createAsideToolRegistry } from "./capability-contract.mjs";
import {
  deniedToolResult,
  failedToolResultEnvelope,
  toolResultEnvelope,
} from "./capability-result.mjs";
import { DocumentAdapterError } from "./document-contract.mjs";
import { MAX_DOCX_READ_BYTES } from "./docx-adapter.mjs";
import {
  MAX_DOCUMENT_OUTPUT_BYTES,
  renderDocumentBytes,
  summarizeSpec,
  validateDocumentSpec,
} from "./docx-writer.mjs";
import { PermissionError } from "./permission-broker.mjs";
import { DEFAULT_WORKSPACE_WRITE_LIMITS } from "./workspace-write-tools.mjs";
import { WorkspaceError } from "./workspace.mjs";
import {
  createDocumentAdapterRegistry,
  readDocument,
} from "./workspace-tools.mjs";

/**
 * First-party `.docx` generation.
 *
 * Cycle 6 creation and transformation always write a **new** path. Same-path
 * replacement and existing-output overwrite are deferred (C6-I009), so every
 * operation here revalidates at commit that the destination is still absent and
 * that the source, where there is one, is unchanged.
 */

export const DOCX_CREATE_TOOL = "document.create";
export const DOCX_TRANSFORM_TOOL = "document.transform";

const OUTPUT_EXTENSION = ".docx";
const MAX_PREVIEW_BYTES = 4 * 1024;

const documentSpecSchema = Type.Object({
  title: Type.Optional(Type.String({ description: "Document title, stored as a document property." })),
  blocks: Type.Array(
    Type.Object({
      type: Type.Union([
        Type.Literal("heading"),
        Type.Literal("paragraph"),
        Type.Literal("list"),
        Type.Literal("table"),
        Type.Literal("page_break"),
        Type.Literal("link"),
      ]),
      level: Type.Optional(Type.Integer({ minimum: 1, maximum: 6, description: "Heading level, 1 through 6." })),
      text: Type.Optional(Type.String({ description: "Prose text for a heading, paragraph, or link." })),
      runs: Type.Optional(Type.Array(
        Type.Object({
          text: Type.String(),
          bold: Type.Optional(Type.Boolean()),
          italic: Type.Optional(Type.Boolean()),
        }),
        { description: "Inline runs with emphasis, instead of plain text." },
      )),
      href: Type.Optional(Type.String({ description: "Absolute http, https, or mailto URL for a link." })),
      ordered: Type.Optional(Type.Boolean({ description: "Numbered rather than bulleted list." })),
      items: Type.Optional(Type.Array(Type.String(), { description: "List item text." })),
      rows: Type.Optional(
        Type.Array(Type.Array(Type.String()), { description: "Table rows of cell text." }),
      ),
    }),
    { description: "Ordered document blocks. Supported: heading, paragraph, list, table, page_break, link." },
  ),
});

const createSchema = Type.Object({
  path: Type.String({ description: "New .docx path inside the active workspace. It must not already exist." }),
  document: documentSpecSchema,
});

const transformSchema = Type.Object({
  path: Type.String({ description: "Existing .docx source path inside the active workspace." }),
  output_path: Type.String({ description: "New .docx path for the result. It must not already exist and must differ from the source." }),
  document: documentSpecSchema,
});

function boundedPath(value, field, maxBytes = 1_024) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorkspaceError("invalid_argument", `The field "${field}" must be a non-empty path.`);
  }
  if (byteLength(value) > maxBytes) {
    throw new WorkspaceError("invalid_argument", `The field "${field}" is too long.`);
  }
  return value;
}

function assertDocxPath(path, field) {
  if (!path.toLowerCase().endsWith(OUTPUT_EXTENSION)) {
    throw new WorkspaceError(
      "invalid_argument",
      `The field "${field}" must name a ${OUTPUT_EXTENSION} file.`,
    );
  }
  return path;
}

/**
 * The permission preview. It states what will be written, where, and what the
 * source loses — bounded, redacted, and never a raw handle.
 */
function buildPreview({ operation, summary, sourceWarnings, outputPath, source }) {
  const preview = previewValue({
    output_path: outputPath,
    will_overwrite: false,
    structure: summary,
    ...(source
      ? {
          source_path: source.relative_path,
          source_bytes: source.bytes,
          source_fidelity_warnings: sourceWarnings,
        }
      : {}),
  }, MAX_PREVIEW_BYTES);
  return preview.truncated
    ? { truncated: true, summary: preview.text }
    : (() => {
      try {
        return JSON.parse(preview.text);
      } catch {
        return { summary: preview.text };
      }
    })();
}

function permissionFailure(outcome) {
  const code = outcome?.code === "expired"
    ? "permission_expired"
    : outcome?.code === "aborted" || outcome?.decision === "cancel"
      ? "permission_cancelled"
      : outcome?.decision === "deny"
        ? "permission_denied"
        : "permission_invalidated";
  return new PermissionError(
    code,
    code === "permission_denied"
      ? "The document operation was denied."
      : code === "permission_expired"
        ? "The document permission expired before execution."
        : code === "permission_cancelled"
          ? "The document operation was cancelled."
          : "The document permission is no longer valid.",
  );
}

function failureEnvelope(tool, error, extra = {}) {
  const code = typeof error?.code === "string" ? error.code : "document_failed";
  return failedToolResultEnvelope(tool, {
    code,
    message: error instanceof Error ? error.message : String(error),
    details: extra,
  });
}

/** Resolves the destination and refuses anything but a new, distinct file. */
async function prepareDestination(workspace, outputPath, sourcePath) {
  const target = await workspace.resolvePath(outputPath, { expectedKind: "file", allowMissing: true });
  // Checked before existence: when the destination is the source, "you are
  // replacing the document in place" is the useful diagnosis, and the source
  // necessarily exists so the existence test would always win otherwise.
  if (sourcePath !== undefined) {
    const source = await workspace.resolvePath(sourcePath, { expectedKind: "file" });
    if (source.canonical_path === target.canonical_path) {
      throw new WorkspaceError(
        "same_path_replacement",
        "The output path is the source document; Aside does not replace a document in place.",
        outputPath,
      );
    }
  }
  if (target.exists) {
    throw new WorkspaceError(
      "target_exists",
      "The output file already exists; Aside does not overwrite an existing document.",
      outputPath,
    );
  }
  return target;
}

/** Reads and summarises the source, refusing anything the reader rejects. */
async function inspectSource({ workspace, documentRegistry, limits }, path, signal) {
  const loaded = await readDocument(
    { workspace, documentRegistry, limits },
    path,
    "auto",
    signal,
    MAX_DOCX_READ_BYTES,
  );
  if (loaded.adapter?.id !== "docx") {
    throw new WorkspaceError(
      "unsupported_format",
      "Only a Word .docx document can be transformed.",
      path,
    );
  }
  return {
    relative_path: loaded.resolved.relative_path,
    bytes: loaded.resolved.bytes.byteLength,
    identity: loaded.resolved.identity,
    warnings: (loaded.document.warnings ?? []).map((warning) => warning.code),
    blocks: (loaded.document.blocks ?? []).length,
  };
}

/**
 * Reopens the written package and checks it against what was asked for. This is
 * the independent validation path C6-22 and C6-23 require: a digest match would
 * prove only that bytes were copied, not that the package is a readable
 * document with the intended structure.
 */
async function verifyWrittenDocument({ workspace, documentRegistry, limits, emit }, operation, signal) {
  if (emit) {
    emit({
      type: "verification_started",
      request_id: operation.request_id,
      task_id: operation.task_id,
      tool: operation.tool,
      path: operation.output_relative_path,
    });
  }
  const loaded = await readDocument(
    { workspace, documentRegistry, limits },
    operation.output_path,
    "auto",
    signal,
    MAX_DOCX_READ_BYTES,
  );
  if (loaded.adapter?.id !== "docx") {
    throw new WorkspaceError(
      "verification_failed",
      "The written file did not reopen as a Word document.",
      operation.output_path,
    );
  }
  const reopened = summarizeBlocks(loaded.document.blocks ?? []);
  const expected = operation.expected_structure;
  const mismatches = [];
  for (const key of ["headings", "paragraphs", "list_items", "tables", "page_breaks"]) {
    if (expected[key] !== undefined && reopened[key] !== expected[key]) {
      mismatches.push({ key, expected: expected[key], actual: reopened[key] });
    }
  }
  if (mismatches.length > 0) {
    throw new WorkspaceError(
      "verification_failed",
      "The written document did not reopen with the structure that was requested.",
      operation.output_path,
      { mismatches },
    );
  }
  if (emit) {
    emit({
      type: "verification_completed",
      request_id: operation.request_id,
      task_id: operation.task_id,
      tool: operation.tool,
      path: operation.output_relative_path,
      status: "verified",
      format: "docx",
    });
  }
  return {
    status: "verified",
    format: "docx",
    bytes: loaded.resolved.bytes.byteLength,
    structure: reopened,
  };
}

/** Counts what a reopen actually found, for comparison with the request. */
function summarizeBlocks(blocks) {
  const summary = {
    headings: 0,
    paragraphs: 0,
    list_items: 0,
    tables: 0,
    page_breaks: 0,
  };
  for (const block of blocks) {
    if (block.type === "heading") summary.headings += 1;
    else if (block.type === "paragraph") summary.paragraphs += 1;
    else if (block.type === "list_item") summary.list_items += 1;
    else if (block.type === "table") summary.tables += 1;
    else if (block.type === "page_break") summary.page_breaks += 1;
  }
  return summary;
}

function expectedStructure(summary) {
  return {
    headings: summary.headings,
    paragraphs: summary.paragraphs + summary.links,
    list_items: summary.list_items,
    tables: summary.tables,
    page_breaks: summary.page_breaks,
  };
}

async function runDocumentOperation({
  tool,
  toolCallId,
  definition,
  workspace,
  documentRegistry,
  limits,
  taskRun,
  permissionBroker,
  emit,
  params,
  signal,
  transform,
}) {
  // `document.create` names the file it creates `path`; `document.transform`
  // reads `path` as the source and `output_path` as the destination.
  const outputField = transform ? "output_path" : "path";
  const outputPath = assertDocxPath(
    boundedPath(params?.[outputField], outputField),
    outputField,
  );
  const spec = validateDocumentSpec(params?.document);
  const summary = summarizeSpec(spec);

  let source;
  if (transform) {
    source = await inspectSource(
      { workspace, documentRegistry, limits },
      boundedPath(params?.path, "path"),
      signal,
    );
  }

  const target = await prepareDestination(
    workspace,
    outputPath,
    transform ? params.path : undefined,
  );

  const decision = await permissionBroker.waitForDecision({
    request_id: taskRun?.request_id ?? "direct-request",
    task_id: taskRun?.task_id ?? "direct-task",
    tool_call_id: toolCallId,
    operation: tool,
    effect: "write",
    egress: "none",
    explanation: transform
      ? "Aside is requesting permission to write a new document transformed from the source."
      : "Aside is requesting permission to create a new document.",
    workspace: { canonical_path: workspace.cwd, relative_path: ".", kind: "directory" },
    targets: [{
      path: outputPath.split(/[\\/]+/).join("/"),
      kind: "file",
      state: "new",
    }],
    preview: buildPreview({
      operation: tool,
      summary,
      sourceWarnings: source?.warnings ?? [],
      outputPath,
      source,
    }),
    pending_ms: taskRun?.limits?.maxPendingPermissionMs,
  }, signal);

  if (decision?.status !== "allowed" && decision?.decision !== "allow") {
    if (decision?.decision === "deny") {
      return deniedToolResult(tool, {
        code: "permission_denied",
        message: "The document operation was denied.",
      });
    }
    throw permissionFailure(decision);
  }

  const bytes = await renderDocumentBytes(spec);
  if (bytes.byteLength > MAX_DOCUMENT_OUTPUT_BYTES) {
    throw new DocumentAdapterError(
      "document_too_large",
      "The generated document exceeds the output limit.",
    );
  }

  const operation = {
    request_id: taskRun?.request_id ?? "direct-request",
    task_id: taskRun?.task_id ?? "direct-task",
    tool,
    output_path: outputPath,
    output_relative_path: target.relative_path,
    expected_structure: expectedStructure(summary),
  };

  await workspace.writeBytesAtomic(outputPath, bytes, {
    maxBytes: limits.maxWriteBytes,
    signal,
    expected: target,
    expectMissing: true,
    // The destination must still be absent at the moment of the rename, so an
    // output that appeared after approval is refused rather than overwritten.
    beforeRename: async () => {
      const current = await workspace.revalidate(target, {
        expectedKind: "file",
        allowMissing: true,
        expectMissing: true,
      });
      if (current.exists) {
        throw new WorkspaceError(
          "stale_target",
          "The output path now exists and must be reviewed again.",
          outputPath,
        );
      }
    },
  });

  const verification = await verifyWrittenDocument(
    { workspace, documentRegistry, limits, emit },
    operation,
    signal,
  );

  return toolResultEnvelope({
    tool,
    status: "succeeded",
    details: {
      output_path: target.relative_path.split(/[\\/]+/).join("/"),
      operation: transform ? "transform" : "create",
      bytes: bytes.byteLength,
      structure: summary,
      ...(source
        ? { source_path: source.relative_path, source_fidelity_warnings: source.warnings, source_preserved: true }
        : {}),
      verification,
    },
    message: transform
      ? `Transformed ${source.relative_path} into ${operation.output_relative_path}.`
      : `Created ${operation.output_relative_path}.`,
  });
}

function createRunDocumentTool({ tool, definition, schema, transform, limits, documentRegistry }) {
  return {
    ...definition,
    parameters: schema,
    async createForRun({ workspace, taskRun, permissionBroker, emit } = {}) {
      if (!workspace) {
        throw new WorkspaceError("workspace_required", "A valid workspace is required.");
      }
      if (!permissionBroker || typeof permissionBroker.waitForDecision !== "function") {
        throw new PermissionError(
          "permission_unavailable",
          "A permission broker is required for document writes.",
        );
      }
      return {
        async execute(toolCallId, params, signal) {
          try {
            return await runDocumentOperation({
              tool,
              toolCallId,
              definition,
              workspace,
              documentRegistry,
              limits,
              taskRun,
              permissionBroker,
              emit,
              params,
              signal,
              transform,
            });
          } catch (error) {
            return failureEnvelope(tool, error);
          }
        },
      };
    },
  };
}

export function createDocumentTools({ limits, documentAdapters } = {}) {
  const registry = documentAdapters?.select
    ? documentAdapters
    : createDocumentAdapterRegistry(documentAdapters);
  const configuredLimits = Object.freeze({
    ...DEFAULT_WORKSPACE_WRITE_LIMITS,
    ...(limits ?? {}),
  });
  return [
    createRunDocumentTool({
      tool: DOCX_CREATE_TOOL,
      definition: {
        name: DOCX_CREATE_TOOL,
        description:
          "Create a new Word .docx from a structured specification. Supports headings, "
          + "paragraphs with bold/italic runs, bulleted or numbered lists, tables, page "
          + "breaks, and links. Writes a new file only: it never replaces or overwrites an "
          + "existing document, and the write requires the user's explicit approval.",
        label: "Create Word document",
      descriptor: {
        effect: "write",
        scope: "workspace",
        egress: "none",
        replay: "non_replayable",
        availability: { prerequisites: ["workspace"] },
      },
      },
      schema: createSchema,
      transform: false,
      limits: configuredLimits,
      documentRegistry: registry,
    }),
    createRunDocumentTool({
      tool: DOCX_TRANSFORM_TOOL,
      definition: {
        name: DOCX_TRANSFORM_TOOL,
        description:
          "Write a new Word .docx transformed from an existing .docx in the workspace. "
          + "The source is read for its structure and reported fidelity warnings, then left "
          + "completely unchanged. Creates a new output path only; it never replaces the "
          + "source or overwrites an existing file.",
        label: "Transform Word document",
      descriptor: {
        effect: "write",
        scope: "workspace",
        egress: "none",
        replay: "non_replayable",
        availability: { prerequisites: ["workspace"] },
      },
      },
      schema: transformSchema,
      transform: true,
      limits: configuredLimits,
      documentRegistry: registry,
    }),
  ];
}

export function createDocumentToolRegistry(options) {
  return createAsideToolRegistry(createDocumentTools(options));
}
