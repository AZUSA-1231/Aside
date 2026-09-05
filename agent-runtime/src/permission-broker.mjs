import {
  MAX_TASK_ID_LENGTH,
  previewValue,
  sanitizeRuntimeText,
} from "./agent-contracts.mjs";

export const PERMISSION_DECISIONS = Object.freeze(["allow", "deny", "cancel"]);
export const MAX_PERMISSION_ID_LENGTH = 160;
export const MAX_PERMISSION_OPERATION_LENGTH = 96;
export const MAX_PERMISSION_EXPLANATION_BYTES = 512;
export const MAX_PERMISSION_PREVIEW_BYTES = 8 * 1024;

function boundedString(value, field, maxBytes, { required = true } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && value.length === 0)) {
    throw new PermissionError("invalid_permission", `The permission field "${field}" is invalid.`);
  }
  const bounded = sanitizeRuntimeText(value, maxBytes);
  if (bounded.truncated) {
    throw new PermissionError("invalid_permission", `The permission field "${field}" is too long.`);
  }
  return value;
}

function safePreview(value, maxBytes = MAX_PERMISSION_PREVIEW_BYTES) {
  const preview = previewValue(value, maxBytes);
  if (!preview.truncated) {
    try {
      return JSON.parse(preview.text);
    } catch {
      return { summary: preview.text };
    }
  }
  return { truncated: true, summary: preview.text };
}

function identityValue(value, field) {
  if (value === undefined) return undefined;
  return boundedString(value, field, MAX_TASK_ID_LENGTH);
}

export class PermissionError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "PermissionError";
    this.code = code;
    this.details = details;
  }
}

function normalizeRecord(input, now, defaultPendingMs) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PermissionError("invalid_permission", "The permission request is invalid.");
  }
  const permissionId = boundedString(
    input.permission_id,
    "permission_id",
    MAX_PERMISSION_ID_LENGTH,
  );
  const requestId = boundedString(input.request_id, "request_id", MAX_TASK_ID_LENGTH);
  const taskId = boundedString(input.task_id, "task_id", MAX_TASK_ID_LENGTH);
  const toolCallId = boundedString(input.tool_call_id, "tool_call_id", MAX_PERMISSION_ID_LENGTH);
  const operation = boundedString(
    input.operation,
    "operation",
    MAX_PERMISSION_OPERATION_LENGTH,
  );
  const effect = input.effect ?? "write";
  if (effect !== "write") {
    throw new PermissionError("invalid_permission", "Only write permissions are supported.");
  }
  const pendingMs = input.pending_ms ?? defaultPendingMs;
  if (!Number.isSafeInteger(pendingMs) || pendingMs <= 0 || pendingMs > 10 * 60 * 1000) {
    throw new PermissionError("invalid_permission", "The permission expiry is invalid.");
  }
  const expiresAt = input.expires_at ?? now + pendingMs;
  if (!Number.isSafeInteger(expiresAt) || expiresAt < now) {
    throw new PermissionError("invalid_permission", "The permission expiry is invalid.");
  }
  return {
    permission_id: permissionId,
    request_id: requestId,
    task_id: taskId,
    tool_call_id: toolCallId,
    operation,
    effect,
    explanation: boundedString(
      input.explanation ?? "Aside is requesting permission for this workspace change.",
      "explanation",
      MAX_PERMISSION_EXPLANATION_BYTES,
    ),
    workspace: safePreview(input.workspace ?? {}, MAX_PERMISSION_PREVIEW_BYTES),
    targets: safePreview(input.targets ?? [], MAX_PERMISSION_PREVIEW_BYTES),
    preview: safePreview(input.preview ?? {}, MAX_PERMISSION_PREVIEW_BYTES),
    expires_at: expiresAt,
    pending_ms: pendingMs,
  };
}

function publicRecord(record) {
  return {
    permission_id: record.permission_id,
    request_id: record.request_id,
    task_id: record.task_id,
    tool_call_id: record.tool_call_id,
    effect: record.effect,
    operation: record.operation,
    explanation: record.explanation,
    workspace: record.workspace,
    targets: record.targets,
    preview: record.preview,
    expires_at: record.expires_at,
  };
}

function outcomeStatus(decision, code) {
  if (code === "expired") return "expired";
  if (code === "aborted" || decision === "cancel") return "cancelled";
  if (decision === "allow") return "allowed";
  return "denied";
}

export class PermissionBroker {
  #pending = new Map();
  #sequence = 0;
  #emit;
  #now;
  #defaultPendingMs;
  #disposed = false;

  constructor({ emit, now = Date.now, maxPendingMs = 120_000 } = {}) {
    this.#emit = emit ?? (() => undefined);
    this.#now = now;
    this.#defaultPendingMs = maxPendingMs;
    if (!Number.isSafeInteger(maxPendingMs) || maxPendingMs <= 0 || maxPendingMs > 10 * 60 * 1000) {
      throw new PermissionError("invalid_permission", "The default permission expiry is invalid.");
    }
  }

  setEmitter(emit) {
    this.#emit = emit ?? (() => undefined);
  }

  #send(event) {
    try {
      this.#emit(event);
    } catch {
      // Permission state must not be lost because a passive event sink failed.
    }
  }

  #newPermissionId() {
    this.#sequence += 1;
    return `permission-${this.#sequence}`;
  }

  #settle(pending, decision, code = decision) {
    if (this.#pending.get(pending.record.permission_id) !== pending) return false;
    this.#pending.delete(pending.record.permission_id);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.onAbort);
    const record = publicRecord(pending.record);
    const result = {
      ...record,
      decision,
      status: outcomeStatus(decision, code),
      code,
    };
    this.#send({
      type: "permission_resolved",
      ...record,
      decision,
      status: result.status,
      code,
    });
    pending.resolve(result);
    return true;
  }

  request(input, signal) {
    if (this.#disposed) {
      return Promise.resolve({
        permission_id: input?.permission_id,
        decision: "cancel",
        status: "cancelled",
        code: "broker_disposed",
      });
    }
    const now = this.#now();
    const record = normalizeRecord(
      {
        ...input,
        permission_id: input?.permission_id ?? this.#newPermissionId(),
      },
      now,
      this.#defaultPendingMs,
    );
    if (this.#pending.has(record.permission_id)) {
      throw new PermissionError("duplicate_permission", "The permission id is already pending.");
    }
    if (signal?.aborted) {
      return Promise.resolve({
        ...publicRecord(record),
        decision: "cancel",
        status: "cancelled",
        code: "aborted",
      });
    }

    return new Promise((resolve) => {
      const pending = { record, resolve, signal, timer: undefined, onAbort: undefined };
      pending.onAbort = () => this.#settle(pending, "cancel", "aborted");
      this.#pending.set(record.permission_id, pending);
      signal?.addEventListener("abort", pending.onAbort, { once: true });
      pending.timer = setTimeout(
        () => this.#settle(pending, "cancel", "expired"),
        Math.max(1, record.expires_at - now),
      );
      pending.timer.unref?.();
      this.#send({
        type: "permission_requested",
        ...publicRecord(record),
        status: "pending",
      });
      this.#send({
        type: "run_waiting",
        request_id: record.request_id,
        task_id: record.task_id,
        reason: "permission",
        permission_id: record.permission_id,
        expires_at: record.expires_at,
      });
    });
  }

  waitForDecision(input, signal) {
    return this.request(input, signal);
  }

  resolve(permissionId, decision, identity = {}) {
    if (typeof permissionId !== "string" || permissionId.length === 0) {
      return { status: "ignored", code: "invalid_permission" };
    }
    if (!PERMISSION_DECISIONS.includes(decision)) {
      return { status: "ignored", code: "invalid_decision" };
    }
    const pending = this.#pending.get(permissionId);
    if (!pending) return { status: "ignored", code: "permission_not_found" };
    for (const [field, recordField] of [
      ["request_id", "request_id"],
      ["task_id", "task_id"],
      ["tool_call_id", "tool_call_id"],
    ]) {
      const expected = identityValue(identity?.[field], field);
      if (expected !== undefined && expected !== pending.record[recordField]) {
        return { status: "ignored", code: "permission_mismatch" };
      }
    }
    if (pending.record.expires_at <= this.#now()) {
      this.#settle(pending, "cancel", "expired");
      return { status: "expired", code: "expired", permission_id: permissionId };
    }
    this.#settle(pending, decision, decision);
    return { status: "accepted", code: decision, permission_id: permissionId };
  }

  cancelForRun({ requestId, taskId } = {}, code = "aborted") {
    const pending = [...this.#pending.values()];
    let count = 0;
    for (const entry of pending) {
      if (
        (requestId === undefined || entry.record.request_id === requestId) &&
        (taskId === undefined || entry.record.task_id === taskId)
      ) {
        count += Number(this.#settle(entry, "cancel", code));
      }
    }
    return count;
  }

  cancel(permissionId, code = "aborted") {
    const pending = this.#pending.get(permissionId);
    if (!pending) return { status: "ignored", code: "permission_not_found" };
    this.#settle(pending, "cancel", code);
    return { status: "accepted", code, permission_id: permissionId };
  }

  snapshot() {
    return [...this.#pending.values()].map(({ record }) => ({
      ...publicRecord(record),
      status: "pending",
    }));
  }

  get pendingCount() {
    return this.#pending.size;
  }

  dispose() {
    this.#disposed = true;
    for (const pending of [...this.#pending.values()]) {
      this.#settle(pending, "cancel", "broker_disposed");
    }
  }
}

export function createPermissionBroker(options) {
  return new PermissionBroker(options);
}
