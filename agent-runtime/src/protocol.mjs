import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import readline from "node:readline";
import { createAsideConversationRuntime } from "./session.mjs";
import { sanitizeError } from "./runtime.mjs";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.has(key));
}

function isTerminalEvent(event) {
  return (
    event?.type === "completed" ||
    event?.type === "cancelled" ||
    event?.type === "failed"
  );
}

const PERMISSION_DECISIONS = new Set(["allow", "deny", "cancel"]);
const MAX_WORKSPACE_PATH_BYTES = 4_096;
const MAX_IDENTIFIER_LENGTH = 160;

function boundedIdentifier(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH
  );
}

function isValidPermissionIdentity(value) {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, new Set(["request_id", "task_id", "tool_call_id"]))) {
    return false;
  }
  for (const key of ["request_id", "task_id", "tool_call_id"]) {
    if (value[key] !== undefined && !boundedIdentifier(value[key])) return false;
  }
  return true;
}

function isValidWorkspaceHint(value) {
  if (typeof value === "string") {
    return value.trim().length > 0 && value.length <= MAX_WORKSPACE_PATH_BYTES;
  }
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, new Set(["path", "kind", "source", "expires_at"]))) {
    return false;
  }
  if (
    typeof value.path !== "string" ||
    value.path.trim().length === 0 ||
    value.path.length > MAX_WORKSPACE_PATH_BYTES
  ) {
    return false;
  }
  for (const key of ["kind", "source"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") return false;
  }
  if (
    value.expires_at !== undefined &&
    (typeof value.expires_at !== "number" || !Number.isSafeInteger(value.expires_at) || value.expires_at < 0)
  ) {
    return false;
  }
  return true;
}

function optionalTaskId(value) {
  if (value.task_id === undefined) return {};
  if (typeof value.task_id !== "string" || value.task_id.length === 0) return undefined;
  return { task_id: value.task_id };
}

function invalidRequest(value) {
  return {
    type: "invalid",
    request_id: typeof value.request_id === "string" ? value.request_id : undefined,
  };
}

export function parseRuntimeRequest(value) {
  if (!isRecord(value) || typeof value.type !== "string") {
    return { type: "invalid", request_id: undefined };
  }

  if (value.type === "prompt") {
    const valid =
      hasOnlyKeys(value, new Set(["type", "request_id", "text", "context"])) &&
      typeof value.request_id === "string" &&
      typeof value.text === "string" &&
      (value.context === undefined || isRecord(value.context));
    return valid
      ? {
          type: "prompt",
          request_id: value.request_id,
          text: value.text,
          ...(value.context === undefined ? {} : { context: value.context }),
        }
      : invalidRequest(value);
  }

  if (value.type === "cancel") {
    const valid =
      hasOnlyKeys(value, new Set(["type", "request_id"])) &&
      typeof value.request_id === "string";
    return valid
      ? { type: "cancel", request_id: value.request_id }
      : invalidRequest(value);
  }

  if (value.type === "permission_response") {
    const valid =
      hasOnlyKeys(
        value,
        new Set(["type", "request_id", "permission_id", "decision", "identity"]),
      ) &&
      boundedIdentifier(value.request_id) &&
      boundedIdentifier(value.permission_id) &&
      typeof value.decision === "string" &&
      PERMISSION_DECISIONS.has(value.decision) &&
      (value.identity === undefined || isValidPermissionIdentity(value.identity));
    return valid
      ? {
          type: "permission_response",
          request_id: value.request_id,
          permission_id: value.permission_id,
          decision: value.decision,
          ...(value.identity === undefined ? {} : { identity: value.identity }),
        }
      : invalidRequest(value);
  }

  if (value.type === "set_workspace") {
    const taskId = optionalTaskId(value);
    const valid =
      taskId !== undefined &&
      hasOnlyKeys(value, new Set(["type", "task_id", "workspace"])) &&
      isValidWorkspaceHint(value.workspace);
    return valid
      ? { type: "set_workspace", workspace: value.workspace, ...taskId }
      : invalidRequest(value);
  }

  if (value.type === "clear_workspace") {
    const taskId = optionalTaskId(value);
    const valid =
      taskId !== undefined &&
      hasOnlyKeys(value, new Set(["type", "task_id"]));
    return valid
      ? { type: "clear_workspace", ...taskId }
      : invalidRequest(value);
  }

  return invalidRequest(value);
}

function invalidRequestEvent(requestId) {
  return {
    type: "failed",
    request_id: requestId ?? "invalid",
    message: "The runtime request was invalid.",
    retryable: true,
  };
}

export async function runProtocol({
  input = process.stdin,
  emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
  runtimeFactory = createAsideConversationRuntime,
} = {}) {
  let runtime;
  let setupError;
  const startupEvents = [];
  const terminalRequestIds = new Set();
  let startupComplete = false;
  const emitRuntimeEvent = (event) => {
    if (isTerminalEvent(event) && typeof event.request_id === "string") {
      if (terminalRequestIds.has(event.request_id)) return;
      terminalRequestIds.add(event.request_id);
    }
    if (startupComplete) emit(event);
    else startupEvents.push(event);
  };
  try {
    runtime = await runtimeFactory({ emit: emitRuntimeEvent });
    emit({
      type: "history_restored",
      messages: Array.isArray(runtime.history) ? runtime.history : [],
    });
    for (const event of startupEvents) emit(event);
    startupComplete = true;
  } catch (error) {
    setupError = sanitizeError(error);
    emit({ type: "runtime_unavailable", message: setupError });
  }

  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      emit(invalidRequestEvent(undefined));
      continue;
    }

    const request = parseRuntimeRequest(parsed);
    if (request.type === "invalid") {
      emit(invalidRequestEvent(request.request_id));
      continue;
    }

    if (request.type === "prompt") {
      if (!runtime) {
        emit({
          type: "failed",
          request_id: request.request_id,
          message: setupError ?? "The Aside runtime is unavailable.",
          retryable: true,
        });
        continue;
      }
      void runtime
        .prompt(request.request_id, request.text, request.context)
        .catch((error) =>
          emitRuntimeEvent({
            type: "failed",
            request_id: request.request_id,
            message: sanitizeError(error),
            retryable: true,
          }),
        );
      continue;
    }

    if (request.type === "permission_response") {
      if (!runtime) {
        emit({
          type: "failed",
          request_id: request.request_id,
          message: setupError ?? "The Aside runtime is unavailable.",
          retryable: true,
        });
        continue;
      }
      runtime.resolvePermission(
        request.permission_id,
        request.decision,
        request.identity ?? {},
      );
      continue;
    }

    if (request.type === "set_workspace") {
      if (!runtime) {
        emit({
          type: "session_warning",
          message: setupError ?? "The Aside runtime is unavailable.",
        });
        continue;
      }
      void runtime
        .setWorkspace(request.task_id, request.workspace)
        .catch((error) =>
          emitRuntimeEvent({
            type: "session_warning",
            message: sanitizeError(error),
          }),
        );
      continue;
    }

    if (request.type === "clear_workspace") {
      if (!runtime) {
        emit({
          type: "session_warning",
          message: setupError ?? "The Aside runtime is unavailable.",
        });
        continue;
      }
      runtime.clearWorkspace(request.task_id);
      continue;
    }

    if (runtime) runtime.cancel(request.request_id);
  }
}

if (
  process.argv[1] &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])
) {
  await runProtocol();
}
