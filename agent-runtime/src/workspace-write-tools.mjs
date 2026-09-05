import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import {
  AsideContractError,
  byteLength,
  createAsideToolRegistry,
  previewValue,
  sanitizeRuntimeText,
} from "./agent-contracts.mjs";
import {
  DEFAULT_WORKSPACE_TOOL_LIMITS,
  createDocumentAdapterRegistry,
  readDocument,
  validateDocumentText,
} from "./workspace-tools.mjs";
import { PermissionError } from "./permission-broker.mjs";
import { WorkspaceError } from "./workspace.mjs";

const textEncoder = new TextEncoder();
const mutationQueues = new WeakMap();

export const DEFAULT_WORKSPACE_WRITE_LIMITS = Object.freeze({
  ...DEFAULT_WORKSPACE_TOOL_LIMITS,
  maxWriteBytes: 256 * 1024,
  maxEditOperations: 16,
  maxReplacementBytes: 16 * 1024,
  maxPreviewBytes: 4 * 1024,
});

function productPath(path) {
  return String(path).split(/[\\/]+/).join("/");
}

function boundedLimits(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AsideContractError("Workspace write limits must be an object.");
  }
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULT_WORKSPACE_WRITE_LIMITS)) {
    const value = input[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value <= 0 || value > fallback) {
      throw new AsideContractError(
        `Workspace write limit "${key}" must be a positive integer no greater than ${fallback}.`,
      );
    }
    result[key] = value;
  }
  return Object.freeze(result);
}

function invalidArgument(field, message) {
  throw new WorkspaceError(
    "invalid_argument",
    `The workspace write argument "${field}" ${message}.`,
  );
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

function boundedText(value, field, maxBytes, { allowEmpty = true } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    invalidArgument(field, allowEmpty ? "must be text" : "must be non-empty text");
  }
  if (byteLength(value) > maxBytes) {
    invalidArgument(field, `must be at most ${maxBytes} bytes`);
  }
  return value;
}

function throwIfAborted(signal, path) {
  if (signal?.aborted) {
    throw new WorkspaceError("aborted", "The workspace operation was cancelled.", path);
  }
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

function safeErrorMessage(error) {
  return sanitizeRuntimeText(
    error instanceof Error ? error.message : String(error),
    512,
  ).text;
}

function failedResult(tool, error, limits, extra = {}) {
  const code = typeof error?.code === "string" ? error.code : "write_failed";
  const status = code === "permission_denied"
    ? "denied"
    : code === "permission_expired"
      ? "expired"
      : code === "permission_invalidated"
        ? "invalidated"
        : ["aborted", "permission_cancelled"].includes(code)
          ? "cancelled"
          : "failed";
  const payload = {
    status,
    tool,
    code,
    ...(typeof error?.path === "string" ? { addressed_path: error.path } : {}),
    ...(error?.details && typeof error.details === "object"
      ? { error_details: safeDetails(error.details, 2_048) }
      : {}),
    error: { code, message: safeErrorMessage(error) },
    ...extra,
  };
  const bounded = sanitizeRuntimeText(
    `${tool} ${status}\n${JSON.stringify(payload, null, 2)}`,
    limits.maxOutputBytes,
  );
  return {
    content: [{ type: "text", text: bounded.text }],
    details: safeDetails(payload, limits.maxDetailsBytes, { status, tool, code }),
    isError: true,
    ...(bounded.truncated ? { truncated: true } : {}),
  };
}

function successfulResult(tool, payload, limits) {
  const body = JSON.stringify({
    status: "succeeded",
    tool,
    ...payload,
  }, null, 2);
  const bounded = sanitizeRuntimeText(`${tool} succeeded\n${body}`, limits.maxOutputBytes);
  const details = safeDetails(
    { status: "succeeded", tool, ...payload, truncated: bounded.truncated },
    limits.maxDetailsBytes,
    { status: "succeeded", tool },
  );
  return {
    content: [{ type: "text", text: bounded.text }],
    details,
    ...(bounded.truncated ? { truncated: true } : {}),
  };
}

function publicIdentity(identity) {
  if (!identity) return undefined;
  return {
    kind: identity.kind,
    size: identity.size,
    mtime_ms: identity.mtime_ms,
  };
}

function publicTarget(target) {
  return {
    addressed_path: productPath(target.addressed_path),
    relative_path: productPath(target.relative_path),
    canonical_path: target.canonical_path,
    kind: target.kind ?? "file",
    exists: target.exists,
    ...(target.identity ? { identity: publicIdentity(target.identity) } : {}),
  };
}

function workspaceReference(workspace) {
  const state = workspace.workspace ?? {};
  return {
    addressed_path: state.addressed_path ?? workspace.cwd,
    canonical_path: workspace.cwd,
    relative_path: ".",
    kind: "directory",
  };
}

function previewText(value, limits) {
  const bounded = sanitizeRuntimeText(value, limits.maxPreviewBytes);
  return { text: bounded.text, truncated: bounded.truncated };
}

function preparePreview(operation, limits) {
  const oldPreview = previewText(operation.original_text ?? "", limits);
  const newPreview = previewText(operation.content, limits);
  return {
    kind: operation.kind,
    format: operation.format,
    old_bytes: operation.original_bytes,
    new_bytes: byteLength(operation.content),
    old_preview: oldPreview.text,
    new_preview: newPreview.text,
    truncated: oldPreview.truncated || newPreview.truncated,
    ...(operation.replacement_count === undefined
      ? {}
      : { replacement_count: operation.replacement_count }),
  };
}

function permissionTargets(operation) {
  return [{
    path: productPath(operation.target.addressed_path),
    relative_path: productPath(operation.target.relative_path),
    kind: "file",
    state: operation.expected_missing ? "new" : "modified",
    ...(operation.target.identity
      ? { expected_identity: publicIdentity(operation.target.identity) }
      : {}),
  }];
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
      ? "The workspace write was denied."
      : code === "permission_expired"
        ? "The workspace write permission expired before execution."
        : code === "permission_cancelled"
          ? "The workspace write was cancelled before execution."
          : "The workspace write permission was not accepted.",
    { permission_id: outcome?.permission_id, decision: outcome?.decision },
  );
}

async function withMutationQueue(workspace, path, operation) {
  let queues = mutationQueues.get(workspace);
  if (!queues) {
    queues = new Map();
    mutationQueues.set(workspace, queues);
  }
  const key = productPath(path).toLocaleLowerCase();
  const previous = queues.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  queues.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(key) === queued) queues.delete(key);
  }
}

function replacementInputs(params, limits) {
  if (Array.isArray(params?.edits)) {
    if (params.edits.length === 0 || params.edits.length > limits.maxEditOperations) {
      invalidArgument("edits", `must contain between 1 and ${limits.maxEditOperations} replacements`);
    }
    return params.edits.map((edit, index) => ({
      old_text: boundedText(edit?.old_text, `edits[${index}].old_text`, limits.maxReplacementBytes, { allowEmpty: false }),
      new_text: boundedText(edit?.new_text, `edits[${index}].new_text`, limits.maxReplacementBytes),
    }));
  }
  return [{
    old_text: boundedText(params?.old_text, "old_text", limits.maxReplacementBytes, { allowEmpty: false }),
    new_text: boundedText(params?.new_text, "new_text", limits.maxReplacementBytes),
  }];
}

function findOccurrences(content, needle) {
  const positions = [];
  let from = 0;
  while (from <= content.length - needle.length) {
    const index = content.indexOf(needle, from);
    if (index < 0) break;
    positions.push(index);
    from = index + needle.length;
  }
  return positions;
}

function applyReplacements(content, edits, replaceAll) {
  const replacements = [];
  for (let editIndex = 0; editIndex < edits.length; editIndex += 1) {
    const edit = edits[editIndex];
    const positions = findOccurrences(content, edit.old_text);
    if (positions.length === 0) {
      throw new WorkspaceError("edit_not_found", "The exact replacement text was not found.", undefined, {
        edit_index: editIndex,
      });
    }
    if (!replaceAll && positions.length !== 1) {
      throw new WorkspaceError("edit_not_unique", "The replacement text must match exactly once.", undefined, {
        edit_index: editIndex,
        matches: positions.length,
      });
    }
    for (const position of replaceAll ? positions : positions.slice(0, 1)) {
      replacements.push({
        start: position,
        end: position + edit.old_text.length,
        text: edit.new_text,
        edit_index: editIndex,
      });
    }
  }
  replacements.sort((left, right) => left.start - right.start);
  for (let index = 1; index < replacements.length; index += 1) {
    if (replacements[index].start < replacements[index - 1].end) {
      throw new WorkspaceError("edit_overlap", "Replacement ranges overlap.");
    }
  }
  let result = "";
  let cursor = 0;
  for (const replacement of replacements) {
    result += content.slice(cursor, replacement.start);
    result += replacement.text;
    cursor = replacement.end;
  }
  result += content.slice(cursor);
  return { content: result, replacement_count: replacements.length };
}

async function prepareWrite({ workspace, documentRegistry, limits }, params, signal) {
  const path = boundedPath(params?.path, limits);
  const content = boundedText(params?.content, "content", limits.maxWriteBytes);
  const format = params?.format ?? "auto";
  const target = await workspace.resolvePath(path, { expectedKind: "file", allowMissing: true });
  const validated = await validateDocumentText({
    documentRegistry,
    limits,
    path,
    format,
    text: content,
  });
  let originalText = "";
  let originalBytes = 0;
  let originalDigest;
  if (target.exists) {
    const current = await readDocument(
      { workspace, documentRegistry, limits },
      path,
      format,
      signal,
      limits.maxWriteBytes,
    );
    originalText = current.raw_text;
    originalBytes = current.resolved.bytes.byteLength;
    originalDigest = hashBytes(current.resolved.bytes);
  }
  return {
    kind: "write",
    path,
    target,
    expected_missing: !target.exists,
    expected_identity: target.identity,
    expected_digest: originalDigest,
    original_text: originalText,
    original_bytes: originalBytes,
    content,
    new_digest: hashBytes(textEncoder.encode(content)),
    format: validated.adapter.id,
  };
}

async function prepareEdit({ workspace, documentRegistry, limits }, params, signal) {
  const path = boundedPath(params?.path, limits);
  const format = params?.format ?? "auto";
  const current = await readDocument(
    { workspace, documentRegistry, limits },
    path,
    format,
    signal,
    limits.maxWriteBytes,
  );
  const edits = replacementInputs(params, limits);
  const applied = applyReplacements(current.raw_text, edits, params?.replace_all === true);
  const content = boundedText(applied.content, "result", limits.maxWriteBytes);
  const validated = await validateDocumentText({
    documentRegistry,
    limits,
    path,
    format,
    text: content,
  });
  return {
    kind: "edit",
    path,
    target: current.resolved,
    expected_missing: false,
    expected_identity: current.resolved.identity,
    expected_digest: hashBytes(current.resolved.bytes),
    original_text: current.raw_text,
    original_bytes: current.resolved.bytes.byteLength,
    content,
    new_digest: hashBytes(textEncoder.encode(content)),
    format: validated.adapter.id,
    replacement_count: applied.replacement_count,
  };
}

async function revalidateOperation(operation, workspace, limits, signal) {
  throwIfAborted(signal, operation.path);
  const current = await workspace.revalidate(operation.target, {
    expectedKind: "file",
    allowMissing: true,
    expectMissing: operation.expected_missing,
  });
  if (operation.expected_digest) {
    const bytes = await workspace.readBytes(operation.path, {
      maxBytes: limits.maxWriteBytes,
      signal,
    });
    if (hashBytes(bytes.bytes) !== operation.expected_digest) {
      throw new WorkspaceError("stale_target", "The file changed after the write was prepared.", operation.path);
    }
  }
  return current;
}

async function verifyWrite({ workspace, documentRegistry, limits, emit }, operation, signal) {
  if (emit) {
    emit({
      type: "verification_started",
      request_id: operation.request_id,
      task_id: operation.task_id,
      tool: operation.tool,
      path: productPath(operation.target.relative_path),
    });
  }
  const verified = await readDocument(
    { workspace, documentRegistry, limits },
    operation.path,
    operation.format,
    signal,
    limits.maxWriteBytes,
  );
  if (hashBytes(verified.resolved.bytes) !== operation.new_digest) {
    throw new WorkspaceError("verification_failed", "The saved file did not match the prepared content.", operation.path);
  }
  if (emit) {
    emit({
      type: "verification_completed",
      request_id: operation.request_id,
      task_id: operation.task_id,
      tool: operation.tool,
      path: productPath(operation.target.relative_path),
      status: "verified",
      format: verified.document.format,
    });
  }
  return {
    status: "verified",
    format: verified.document.format,
    bytes: verified.resolved.bytes.byteLength,
  };
}

const writeSchema = Type.Object({
  path: Type.String({ description: "A file path inside the active workspace." }),
  content: Type.String({ description: "The bounded UTF-8 text or JSON to save." }),
  format: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("text"), Type.Literal("json")])),
});

const editSchema = Type.Object({
  path: Type.String({ description: "A file path inside the active workspace." }),
  old_text: Type.Optional(Type.String({ description: "One exact text region to replace." })),
  new_text: Type.Optional(Type.String({ description: "Replacement text for old_text." })),
  edits: Type.Optional(Type.Array(Type.Object({
    old_text: Type.String({ description: "One exact text region to replace." }),
    new_text: Type.String({ description: "Replacement text." }),
  }))),
  replace_all: Type.Optional(Type.Boolean({ description: "Replace every exact match instead of requiring one." })),
  format: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("text"), Type.Literal("json")])),
});

export const WORKSPACE_WRITE_TOOL_SCHEMAS = Object.freeze({
  write: writeSchema,
  edit: editSchema,
});

function createRunWriteTool(definition, prepare, configuredLimits, documentRegistry) {
  return {
    ...definition,
    async createForRun({ workspace, taskRun, permissionBroker, emit } = {}) {
      if (!workspace) {
        throw new WorkspaceError("workspace_required", "A valid workspace is required.");
      }
      if (!permissionBroker || typeof permissionBroker.waitForDecision !== "function") {
        throw new PermissionError("permission_unavailable", "A permission broker is required for workspace writes.");
      }
      const limits = Object.freeze({
        ...configuredLimits,
        maxOutputBytes: Math.min(
          configuredLimits.maxOutputBytes,
          taskRun?.limits?.maxToolResultBytes ?? configuredLimits.maxOutputBytes,
        ),
      });
      return {
        ...definition,
        async execute(toolCallId, params, signal) {
          let operation;
          try {
            operation = await prepare({ workspace, documentRegistry, limits }, params, signal);
            operation.request_id = taskRun?.request_id ?? "direct-request";
            operation.task_id = taskRun?.task_id ?? "direct-task";
            operation.tool_call_id = toolCallId;
            operation.tool = definition.name;
            const preview = preparePreview(operation, limits);
            const decision = await permissionBroker.waitForDecision({
              request_id: operation.request_id,
              task_id: operation.task_id,
              tool_call_id: toolCallId,
              operation: definition.name,
              effect: "write",
              explanation: definition.name === "workspace.edit"
                ? "Aside is requesting permission to apply the exact proposed text replacement."
                : "Aside is requesting permission to create or replace this workspace file.",
              workspace: workspaceReference(workspace),
              targets: permissionTargets(operation),
              preview,
              pending_ms: taskRun?.limits?.maxPendingPermissionMs,
            }, signal);
            if (decision?.status !== "allowed" && decision?.decision !== "allow") {
              throw permissionFailure(decision);
            }
            await withMutationQueue(workspace, operation.target.canonical_path, async () => {
              await revalidateOperation(operation, workspace, limits, signal);
              if (emit) {
                emit({
                  type: "write_execution_started",
                  request_id: operation.request_id,
                  task_id: operation.task_id,
                  tool: definition.name,
                  path: productPath(operation.target.relative_path),
                });
              }
              await workspace.writeTextAtomic(operation.path, operation.content, {
                maxBytes: limits.maxWriteBytes,
                signal,
                expected: operation.target,
                expectMissing: operation.expected_missing,
                beforeRename: () => revalidateOperation(operation, workspace, limits, signal),
              });
            });
            const verification = await verifyWrite({
              workspace,
              documentRegistry,
              limits,
              emit,
            }, operation, signal);
            return successfulResult(definition.name, {
              operation: operation.kind,
              target: publicTarget(operation.target),
              format: operation.format,
              bytes: byteLength(operation.content),
              replacement_count: operation.replacement_count,
              verification,
            }, limits);
          } catch (error) {
            return failedResult(definition.name, error, limits, operation
              ? { target: publicTarget(operation.target) }
              : {});
          }
        },
      };
    },
  };
}

export function createWorkspaceWriteTools({ limits, documentAdapters } = {}) {
  const configuredLimits = boundedLimits(limits);
  const documentRegistry = documentAdapters?.select
    ? documentAdapters
    : documentAdapters
      ? createDocumentAdapterRegistry(documentAdapters)
      : createDocumentAdapterRegistry();
  return Object.freeze([
    createRunWriteTool(
      {
        name: "workspace.write",
        description: "Prepare a bounded UTF-8 text or JSON file create/replace for permission.",
        label: "Write workspace file",
        parameters: writeSchema,
        descriptor: { effect: "write", scope: "workspace", replay: "non_replayable" },
      },
      prepareWrite,
      configuredLimits,
      documentRegistry,
    ),
    createRunWriteTool(
      {
        name: "workspace.edit",
        description: "Prepare an exact bounded text replacement for permission and verification.",
        label: "Edit workspace file",
        parameters: editSchema,
        descriptor: { effect: "write", scope: "workspace", replay: "non_replayable" },
      },
      prepareEdit,
      configuredLimits,
      documentRegistry,
    ),
  ]);
}

export function createWorkspaceWriteRegistry(options) {
  return createAsideToolRegistry(createWorkspaceWriteTools(options));
}
