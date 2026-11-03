import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import readline from "node:readline";
import {
  createAsideConversationRuntime,
  createAsideSession,
  deleteAsideSession,
  listAsideSessions,
  openAsideSessionById,
  renameAsideSession,
} from "./session.mjs";
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

  // Session requests carry a request id so their outcome can be reported on a
  // failure the surface can attribute, rather than as a bare status change.
  if (value.type === "switch_session") {
    const valid =
      hasOnlyKeys(value, new Set(["type", "request_id", "session_id", "create"])) &&
      boundedIdentifier(value.request_id) &&
      ((value.create === true && value.session_id === undefined)
        || (value.create === undefined && typeof value.session_id === "string"));
    return valid
      ? {
          type: "switch_session",
          request_id: value.request_id,
          ...(value.create === true ? { create: true } : { session_id: value.session_id }),
        }
      : invalidRequest(value);
  }

  if (value.type === "rename_session") {
    const valid =
      hasOnlyKeys(value, new Set(["type", "request_id", "session_id", "name"])) &&
      boundedIdentifier(value.request_id) &&
      typeof value.session_id === "string" &&
      (value.name === null || typeof value.name === "string");
    return valid
      ? { type: "rename_session", request_id: value.request_id, session_id: value.session_id, name: value.name }
      : invalidRequest(value);
  }

  if (value.type === "delete_session") {
    const valid =
      hasOnlyKeys(value, new Set(["type", "request_id", "session_id"])) &&
      boundedIdentifier(value.request_id) &&
      typeof value.session_id === "string";
    return valid
      ? { type: "delete_session", request_id: value.request_id, session_id: value.session_id }
      : invalidRequest(value);
  }

  if (value.type === "list_sessions") {
    const valid =
      hasOnlyKeys(value, new Set(["type", "request_id"])) &&
      boundedIdentifier(value.request_id);
    return valid
      ? { type: "list_sessions", request_id: value.request_id }
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
  // Set while a conversation switch is in flight, so a prompt cannot be routed
  // to the runtime that is being disposed on its way out.
  let switching = false;
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

  // Session bookkeeping is serialized in arrival order rather than fired
  // concurrently: the operations touch the same files, and the surface expects
  // a rename to land before a delete it just asked for.
  let sessionQueue = Promise.resolve();
  function enqueueSessionOperation(operation, requestId) {
    const pending = sessionQueue.then(async () => {
      // Wait out every in-flight run and workspace change before touching the
      // session files. A switch that disposed the runtime under a running
      // prompt would drop a conversation before it was saved. This entry joins
      // `operations` only after that wait: joining first would make it wait on
      // itself.
      while (operations.size > 0) await Promise.allSettled([...operations]);
      operations.add(pending);
      try {
        return await operation();
      } finally {
        operations.delete(pending);
        void applyWhenIdle();
      }
    }).catch((error) => emitSessionFailure(requestId, error));
    sessionQueue = pending;
    return pending;
  }

  function emitSessionFailure(requestId, error) {
    emitRuntimeEvent({
      type: "session_failed",
      request_id: requestId,
      message: runtimeError(error),
    });
  }

  /** The history list that belongs to the conversation's own session directory. */
  async function listSessions(requestId) {
    if (!runtime) throw new Error(setupError ?? "The Aside runtime is unavailable.");
    const result = await listAsideSessions(runtime.sessionStore);
    emit({
      type: "sessions_listed",
      request_id: requestId,
      active_session_id: runtime.agent?.sessionId ?? null,
      sessions: result.sessions,
      warnings: result.warnings,
    });
  }

  /**
   * Replaces the active conversation with another session.
   *
   * On any failure the previous runtime is left exactly as it was: a failed
   * switch must not leave the surface pointing at a half-opened conversation.
   */
  async function switchSession(request) {
    if (!runtime) throw new Error(setupError ?? "The Aside runtime is unavailable.");
    const store = runtime.sessionStore;
    if (request.create) {
      // Create first so the new session exists before anything is torn down.
      const created = await createAsideSession(store);
      await replaceRuntime({ mode: "open", id: created.metadata.id }, request.request_id);
      return;
    }
    // Verify the target is readable before disposing the current runtime.
    await openAsideSessionById(store, request.session_id);
    await replaceRuntime({ mode: "open", id: request.session_id }, request.request_id);
  }

  async function replaceRuntime(sessionTarget, requestId) {
    switching = true;
    try {
      const candidate = await runtimeFactory({ sessionTarget, credentialValues });
      currentSink.live = false;
      try {
        await runtime?.dispose?.();
      } catch {
        // The new conversation is already built; failing to close the old one
        // must not leave two runtimes claiming the same session directory.
        currentSink.live = false;
        await candidate?.dispose?.();
        setupError = "The previous conversation could not be closed.";
        runtime = undefined;
        emit({ type: "runtime_unavailable", message: "The previous conversation could not be closed. Restart Aside." });
        throw new Error("The previous conversation could not be closed.");
      }
      runtime = candidate;
      currentSink = { live: true, forwarding: true };
      setupError = undefined;
      startupComplete = true;
      const history = Array.isArray(candidate.history) ? candidate.history : [];
      emit({ type: "history_restored", messages: history, replaced: true });
      emit({ type: "session_switched", request_id: requestId, session_id: candidate.agent?.sessionId ?? null });
    } finally {
      switching = false;
    }
  }

  /** Rename and delete act on a session other than the active one, so they do not rebuild. */
  async function mutateSession(request) {
    if (!runtime) throw new Error(setupError ?? "The Aside runtime is unavailable.");
    const store = runtime.sessionStore;
    if (request.type === "rename_session") {
      const result = await renameAsideSession(store, request.session_id, request.name);
      emit({ type: "session_renamed", request_id: request.request_id, ...result });
      return;
    }
    // Deleting the conversation that is open would leave the surface pointing
    // at a file that no longer exists. Move to a new session first; if that
    // fails, nothing is deleted and the current conversation stays usable.
    if (request.session_id === runtime.agent?.sessionId) {
      await switchSession({ create: true, request_id: request.request_id });
    }
    const result = await deleteAsideSession(store, request.session_id);
    emit({ type: "session_deleted", request_id: request.request_id, ...result });
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

    if (switching && ["prompt", "set_workspace", "clear_workspace"].includes(request.type)) {
      emit(request.type === "prompt"
        ? { type: "failed", request_id: request.request_id, message: "Another conversation is being opened. Try again when it finishes.", retryable: true }
        : { type: "session_warning", message: "Another conversation is being opened. Try the workspace change again when it finishes." });
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

    // Session requests all run through one serialized queue. They touch the
    // same small set of files, and the surface issues them in quick succession
    // (switch, then list to refresh), so concurrent execution would let a list
    // read a directory that the switch has not finished writing.
    if (request.type === "switch_session") {
      enqueueSessionOperation(() => switchSession(request), request.request_id);
      continue;
    }

    if (request.type === "rename_session" || request.type === "delete_session" || request.type === "list_sessions") {
      enqueueSessionOperation(() => (request.type === "list_sessions"
        ? listSessions(request.request_id)
        : mutateSession(request)), request.request_id);
      continue;
    }

    if (runtime) runtime.cancel(request.request_id);
  }
  // Drain the session queue explicitly: an entry adds itself to `operations`
  // only once its wait begins, so a snapshot taken here can miss one that is
  // still queued behind a prompt.
  await sessionQueue;
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
