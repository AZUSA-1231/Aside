import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import readline from "node:readline";
import { createAsideConversationRuntime } from "./session.mjs";
import { sanitizeError } from "./runtime.mjs";
import { validateCredentialValues } from "./settings-schema.mjs";

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

  if (value.type === "apply_settings") {
    try {
      if (!hasOnlyKeys(value, new Set(["type", "credential_values"]))) return invalidRequest(value);
      return { type: "apply_settings", credential_values: validateCredentialValues(value.credential_values) };
    } catch {
      return invalidRequest(value);
    }
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
  credentialValues = {},
  requireInitialization = false,
} = {}) {
  let runtime;
  let setupError;
  const startupEvents = [];
  const terminalRequestIds = new Set();
  let startupComplete = false;
  let currentSink = { live: true };
  const operations = new Set();
  let pendingApplication;
  let applying = false;
  let applicationPromise = Promise.resolve();
  const runtimeError = (error) => runtime?.redactError?.(error) ?? sanitizeError(error, Object.values(credentialValues));
  const emitRuntimeEvent = (event) => {
    if (!currentSink.live) return;
    if (isTerminalEvent(event) && typeof event.request_id === "string") {
      if (terminalRequestIds.has(event.request_id)) return;
      terminalRequestIds.add(event.request_id);
    }
    if (startupComplete) emit(event);
    else startupEvents.push(event);
  };
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  if (requireInitialization) {
    try {
      const initial = JSON.parse((await iterator.next()).value);
      if (initial.type !== "initialize" || !hasOnlyKeys(initial, new Set(["type", "credential_values"]))) throw new Error();
      credentialValues = validateCredentialValues(initial.credential_values);
    } catch {
      emit({ type: "runtime_unavailable", message: "Aside could not initialize its private configuration channel." });
      lines.close();
      return;
    }
  }
  try {
    const startupSink = currentSink;
    runtime = await runtimeFactory({ emit: (event) => { if (startupSink.live) emitRuntimeEvent(event); }, credentialValues });
    emit({
      type: "history_restored",
      messages: Array.isArray(runtime.history) ? runtime.history : [],
    });
    for (const event of startupEvents) emit(event);
    startupComplete = true;
  } catch (error) {
    setupError = runtimeError(error);
    emit({ type: "runtime_unavailable", message: setupError });
  }

  function applyWhenIdle() {
    if (!pendingApplication || applying || operations.size > 0) return applicationPromise;
    applying = true;
    applicationPromise = applyConfiguration();
    return applicationPromise;
  }

  async function applyConfiguration() {
    const credentials = pendingApplication;
    pendingApplication = undefined;
    emit({ type: "configuration_status", state: "applying" });
    const buffered = [];
    const sink = { live: true, forwarding: false };
    let candidate;
    try {
      candidate = await runtimeFactory({
        previousRuntime: runtime,
        credentialValues: credentials,
        emit: (event) => {
          if (!sink.live) return;
          if (sink.forwarding) emitRuntimeEvent(event);
          else buffered.push(event);
        },
      });
    } catch {
      sink.live = false;
      emit({ type: "configuration_status", state: "failed", message: "The saved configuration could not be applied. The previous runtime is retained; check provider, model and endpoint settings." });
      applying = false;
      void applyWhenIdle();
      return;
    }
    const hadRuntime = Boolean(runtime);
    currentSink.live = false;
    try {
      await runtime?.dispose?.();
    } catch {
      emit({ type: "runtime_warning", code: "runtime_cleanup_failed", message: "The previous runtime could not finish cleanup. Restart Aside before running another task." });
      sink.live = false;
      await candidate.dispose?.();
      runtime = undefined;
      emit({ type: "runtime_unavailable", message: "Runtime cleanup failed. Restart Aside." });
      applying = false;
      return;
    }
    runtime = candidate;
    credentialValues = credentials;
    currentSink = sink;
    setupError = undefined;
    startupComplete = true;
    emit({ type: "runtime_reconfigured" });
    if (!hadRuntime) emit({ type: "history_restored", messages: Array.isArray(candidate.history) ? candidate.history : [] });
    sink.forwarding = true;
    for (const event of buffered) emitRuntimeEvent(event);
    emit({ type: "configuration_status", state: "applied" });
    applying = false;
    void applyWhenIdle();
  }

  function track(operation, onError) {
    const pending = Promise.resolve().then(operation).catch(onError).finally(() => {
      operations.delete(pending);
      void applyWhenIdle();
    });
    operations.add(pending);
  }

  for await (const line of iterator) {
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

    if (request.type === "apply_settings") {
      pendingApplication = request.credential_values;
      emit({ type: "configuration_status", state: "pending" });
      void applyWhenIdle();
      continue;
    }

    if (applying && ["prompt", "set_workspace", "clear_workspace"].includes(request.type)) {
      emit(request.type === "prompt"
        ? { type: "failed", request_id: request.request_id, message: "Configuration is being applied. Try again when it finishes.", retryable: true }
        : { type: "session_warning", message: "Configuration is being applied. Try the workspace change again when it finishes." });
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
      const target = runtime;
      track(() => target.prompt(request.request_id, request.text, request.context), (error) =>
          emitRuntimeEvent({
            type: "failed",
            request_id: request.request_id,
            message: runtimeError(error),
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
      const target = runtime;
      track(() => target.setWorkspace(request.task_id, request.workspace), (error) =>
          emitRuntimeEvent({
            type: "session_warning",
            message: runtimeError(error),
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
      try {
        runtime.clearWorkspace(request.task_id);
      } catch (error) {
        emitRuntimeEvent({ type: "session_warning", message: runtimeError(error) });
      }
      continue;
    }

    if (runtime) runtime.cancel(request.request_id);
  }
  await Promise.allSettled([...operations]);
  while (pendingApplication || applying) {
    await applyWhenIdle();
  }
}

/**
 * The oldest Node the runtime supports.
 *
 * Held to the floor the vendored Pi packages declare in their `engines` field.
 * Below it the runtime starts and then fails on the first provider call, which
 * is the worst outcome: the failure arrives far from its cause, and the message
 * names a provider rather than the Node version.
 *
 * The check exists for installed builds specifically. A packaged application
 * ships its own Node, so a version failure means the staging step or the bundle
 * is wrong — and the user has no way to guess that from a provider error.
 */
const MINIMUM_NODE_MAJOR = 22;
const MINIMUM_NODE_MINOR = 19;

export function checkNodeVersion(version = process.versions.node) {
  const [major, minor] = String(version).split(".").map((part) => Number.parseInt(part, 10));
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
    return { ok: false, message: `Node reported an unreadable version: "${version}".` };
  }
  if (major > MINIMUM_NODE_MAJOR) return { ok: true };
  if (major === MINIMUM_NODE_MAJOR && minor >= MINIMUM_NODE_MINOR) return { ok: true };
  return {
    ok: false,
    message:
      `Aside needs Node ${MINIMUM_NODE_MAJOR}.${MINIMUM_NODE_MINOR} or newer; this is ${version}. `
      + "A packaged build bundles its own Node, so seeing this means the installation is "
      + "incomplete or the wrong Node was placed on PATH.",
  };
}

if (
  process.argv[1] &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])
) {
  const node = checkNodeVersion();
  if (!node.ok) {
    // Emitted on the protocol channel rather than written to stderr, which the
    // launcher discards. The surface reads `runtime_unavailable` and shows the
    // message; a version problem the user cannot see is a version problem they
    // cannot fix.
    process.stdout.write(
      `${JSON.stringify({ type: "runtime_unavailable", message: node.message })}\n`,
    );
    process.exit(1);
  }
  await runProtocol({ requireInitialization: true });
}
