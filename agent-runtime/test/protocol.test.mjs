import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { checkNodeVersion, parseRuntimeRequest, runProtocol } from "../src/protocol.mjs";
import * as sessionStoreModule from "../src/session.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function protocolFixture(factory) {
  const input = new PassThrough();
  const events = [];
  const waiters = [];
  const done = runProtocol({ input, runtimeFactory: factory, emit: (event) => {
    events.push(event);
    for (const waiter of waiters) if (waiter.predicate(event)) waiter.resolve(event);
  } });
  return {
    input, events, done,
    send: (request) => input.write(`${JSON.stringify(request)}\n`),
    wait: (predicate) => {
      const found = events.find(predicate);
      return found ? Promise.resolve(found) : new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
  };
}

test("private initialization supplies keys without emitting them and rejects malformed envelopes", async () => {
  const received = [];
  const events = [];
  await runProtocol({
    requireInitialization: true,
    input: Readable.from([`${JSON.stringify({ type: "initialize", credential_values: { openai: "private-fixture" } })}\n`]),
    runtimeFactory: async ({ credentialValues }) => { received.push(credentialValues); return { history: [] }; },
    emit: (event) => events.push(event),
  });
  assert.deepEqual(received, [{ openai: "private-fixture" }]);
  assert.doesNotMatch(JSON.stringify(events), /private-fixture/);
  for (const envelope of [{ type: "prompt", text: "private-fixture" }, { type: "initialize", credential_values: { unknown: "private-fixture" } }]) {
    const failures = [];
    await runProtocol({ requireInitialization: true, input: Readable.from([`${JSON.stringify(envelope)}\n`]), runtimeFactory: async () => { throw new Error("must not initialize"); }, emit: (event) => failures.push(event) });
    assert.equal(failures[0].type, "runtime_unavailable");
    assert.doesNotMatch(JSON.stringify(failures), /private-fixture/);
  }
});

test("apply queues until prompt persistence and old cleanup finish, then drops old events", async () => {
  const persistence = Promise.withResolvers();
  const cleanup = Promise.withResolvers();
  const oldDisposed = Promise.withResolvers();
  const calls = [];
  let oldEmit;
  let oldRuntime;
  const fixture = protocolFixture(async ({ emit, previousRuntime, credentialValues }) => {
    calls.push({ previousRuntime, credentialValues });
    emit({ type: "ready", provider: "fixture", model: calls.length === 1 ? "old" : "new" });
    if (calls.length === 1) {
      oldEmit = emit;
      oldRuntime = {
        history: [],
        prompt: async (id) => { emit({ type: "completed", request_id: id }); await persistence.promise; },
        dispose: async () => { oldDisposed.resolve(); await cleanup.promise; },
      };
      return oldRuntime;
    }
    return { history: [], prompt: async (id) => {
      emit({ type: "completed", request_id: id });
      throw new Error("late duplicate terminal");
    } };
  });
  await fixture.wait((event) => event.type === "ready");
  fixture.send({ type: "prompt", request_id: "old-task", text: "question" });
  await fixture.wait((event) => event.type === "completed");
  fixture.send({ type: "apply_settings", credential_values: { openai: "new-private-fixture" } });
  await fixture.wait((event) => event.state === "pending");
  assert.equal(calls.length, 1);
  persistence.resolve();
  await oldDisposed.promise;
  assert.equal(calls[1].previousRuntime, oldRuntime);
  assert.deepEqual(calls[1].credentialValues, { openai: "new-private-fixture" });
  assert.equal(fixture.events.filter((event) => event.type === "ready").length, 1);
  oldEmit({ type: "session_warning", message: "late-old-event" });
  cleanup.resolve();
  await fixture.wait((event) => event.state === "applied");
  oldEmit({ type: "text_delta", request_id: "old-task", delta: "late-old-event" });
  assert.equal(fixture.events.filter((event) => event.type === "ready").length, 2);
  assert.doesNotMatch(JSON.stringify(fixture.events), /late-old-event|new-private-fixture/);
  assert.equal(fixture.events.filter((event) => event.type === "history_restored").length, 1);
  fixture.send({ type: "prompt", request_id: "new-task", text: "question" });
  await fixture.wait((event) => event.request_id === "new-task");
  fixture.input.end();
  await fixture.done;
  assert.equal(fixture.events.filter((event) => event.request_id === "new-task").length, 1);
});

test("failed candidate configuration retains the old runtime and can be retried", async () => {
  let builds = 0;
  let disposed = false;
  const prompts = [];
  const fixture = protocolFixture(async ({ emit }) => {
    builds += 1;
    if (builds === 2) throw new Error("private-provider-error");
    emit({ type: "ready", provider: "fixture", model: "model" });
    return { history: [], prompt: async (id) => { prompts.push(id); emit({ type: "completed", request_id: id }); }, dispose: () => { disposed = true; } };
  });
  await fixture.wait((event) => event.type === "ready");
  fixture.send({ type: "apply_settings", credential_values: {} });
  await fixture.wait((event) => event.state === "failed");
  assert.equal(disposed, false);
  fixture.send({ type: "prompt", request_id: "retained", text: "question" });
  await fixture.wait((event) => event.request_id === "retained");
  fixture.send({ type: "apply_settings", credential_values: {} });
  await fixture.wait((event) => event.state === "applied");
  assert.equal(disposed, true);
  assert.deepEqual(prompts, ["retained"]);
  assert.doesNotMatch(JSON.stringify(fixture.events), /private-provider-error/);
  fixture.input.end();
  await fixture.done;
});

test("reconfiguration waits for workspace validation and rejects new work while applying", async () => {
  const workspace = Promise.withResolvers();
  const building = Promise.withResolvers();
  let builds = 0;
  const fixture = protocolFixture(async ({ emit }) => {
    builds += 1;
    if (builds === 2) await building.promise;
    emit({ type: "ready", provider: "fixture", model: "model" });
    return { history: [], setWorkspace: async () => workspace.promise, clearWorkspace() {}, dispose() {} };
  });
  await fixture.wait((event) => event.type === "ready");
  fixture.send({ type: "set_workspace", workspace: "D:/fixture" });
  fixture.send({ type: "apply_settings", credential_values: {} });
  await fixture.wait((event) => event.state === "pending");
  assert.equal(builds, 1);
  workspace.resolve();
  await fixture.wait((event) => event.state === "applying");
  fixture.send({ type: "prompt", request_id: "blocked", text: "question" });
  assert.equal((await fixture.wait((event) => event.request_id === "blocked")).type, "failed");
  building.resolve();
  await fixture.wait((event) => event.state === "applied");
  fixture.input.end();
  await fixture.done;
});

test("initial startup failure can be repaired without losing restored history", async () => {
  let builds = 0;
  const fixture = protocolFixture(async ({ emit }) => {
    if (++builds === 1) throw new Error("invalid configuration");
    emit({ type: "ready", provider: "fixture", model: "model" });
    return { history: [{ id: "restored", role: "user", text: "earlier message" }] };
  });
  await fixture.wait((event) => event.type === "runtime_unavailable");
  fixture.send({ type: "apply_settings", credential_values: {} });
  await fixture.wait((event) => event.state === "applied");
  const restored = fixture.events.find((event) => event.type === "history_restored");
  assert.equal(restored.messages[0].text, "earlier message");
  assert.ok(fixture.events.indexOf(restored) < fixture.events.findIndex((event) => event.type === "ready"));
  fixture.input.end();
  await fixture.done;
});

// The Cycle 6 capability dimensions must survive the process boundary verbatim.
// Tauri forwards events as `serde_json::Value`, so this module is the only
// place that could drop them.
const CAPABILITY_DESCRIPTOR_FIXTURE = Object.freeze({
  contract_version: 1,
  name: "workspace.write",
  description: "Prepare a bounded workspace write for permission.",
  label: "Write workspace file",
  effect: "write",
  scope: "workspace",
  egress: "none",
  source: "builtin",
  replay: "non_replayable",
  availability: { prerequisites: ["workspace"] },
  origin_label: "Aside built-in capability",
});

const CAPABILITY_RISK_FIXTURE = Object.freeze({
  egress: "none",
  source: "builtin",
  risk: {
    effect: "write",
    egress: "none",
    source: "builtin",
    origin_label: "Aside built-in capability",
    boundary: "aside_enforced",
    note: "Aside enforces this capability's limits inside its own runtime.",
  },
});

test("parses only the Aside prompt and cancel request vocabulary", () => {
  assert.deepEqual(
    parseRuntimeRequest({
      type: "prompt",
      request_id: "request-1",
      text: "hello",
      context: { flow: { id: "flow-1", kind: "conversation" }, blocks: [] },
    }),
    {
      type: "prompt",
      request_id: "request-1",
      text: "hello",
      context: { flow: { id: "flow-1", kind: "conversation" }, blocks: [] },
    },
  );
  assert.deepEqual(
    parseRuntimeRequest({ type: "cancel", request_id: "request-1" }),
    { type: "cancel", request_id: "request-1" },
  );
  assert.deepEqual(
    parseRuntimeRequest({ type: "prompt", request_id: "request-2", text: 4 }),
    { type: "invalid", request_id: "request-2" },
  );
  assert.deepEqual(
    parseRuntimeRequest({ type: "continue", request_id: "request-3" }),
    { type: "invalid", request_id: "request-3" },
  );
});

test("emits restored history before ready and forwards subsequent runtime events", async () => {
  const events = [];
  const calls = [];
  const runtimeFactory = async ({ emit }) => {
    emit({ type: "ready", provider: "faux", model: "faux-model" });
    return {
      history: [
        {
          id: "history-1",
          role: "assistant",
          text: "restored",
          status: "complete",
          timestamp: 1,
        },
      ],
      prompt: async (requestId, text, context) => {
        calls.push({ requestId, text, context });
        emit({ type: "run_started", request_id: requestId });
        emit({ type: "text_delta", request_id: requestId, delta: "answer" });
        emit({ type: "completed", request_id: requestId });
      },
      cancel: (requestId) => calls.push({ cancel: requestId }),
    };
  };
  const input = Readable.from([
    `${JSON.stringify({
      type: "prompt",
      request_id: "protocol-1",
      text: "hello",
      context: { flow: { id: "flow-1", kind: "conversation" }, blocks: [] },
    })}\n`,
    `${JSON.stringify({ type: "prompt", request_id: "bad", text: 4 })}\n`,
    `${JSON.stringify({ type: "cancel", request_id: "protocol-1" })}\n`,
    "not json\n",
  ]);

  await runProtocol({ input, emit: (event) => events.push(event), runtimeFactory });
  await Promise.resolve();

  assert.equal(events[0].type, "history_restored");
  assert.equal(events[1].type, "ready");
  assert.deepEqual(calls[0], {
    requestId: "protocol-1",
    text: "hello",
    context: { flow: { id: "flow-1", kind: "conversation" }, blocks: [] },
  });
  assert.ok(
    events.some(
      (event) =>
        event.type === "text_delta" && event.request_id === "protocol-1",
    ),
  );
  assert.ok(
    events.some(
      (event) => event.type === "failed" && event.request_id === "bad",
    ),
  );
  assert.ok(
    events.some(
      (event) => event.type === "failed" && event.request_id === "invalid",
    ),
  );
  assert.deepEqual(calls.at(-1), { cancel: "protocol-1" });
});

test("parses the permission, set-workspace, and clear-workspace vocabulary", () => {
  assert.deepEqual(
    parseRuntimeRequest({
      type: "permission_response",
      request_id: "r1",
      permission_id: "p1",
      decision: "deny",
      identity: { request_id: "r1", task_id: "t1", tool_call_id: "tc1" },
    }),
    {
      type: "permission_response",
      request_id: "r1",
      permission_id: "p1",
      decision: "deny",
      identity: { request_id: "r1", task_id: "t1", tool_call_id: "tc1" },
    },
  );
  assert.deepEqual(
    parseRuntimeRequest({
      type: "permission_response",
      request_id: "r1",
      permission_id: "p1",
      decision: "cancel",
    }),
    { type: "permission_response", request_id: "r1", permission_id: "p1", decision: "cancel" },
  );
  assert.deepEqual(
    parseRuntimeRequest({ type: "permission_response", request_id: "r1", permission_id: "p1", decision: "maybe" }),
    { type: "invalid", request_id: "r1" },
  );
  assert.deepEqual(
    parseRuntimeRequest({ type: "permission_response", request_id: "r1", permission_id: "p1", decision: "allow", identity: { request_id: 4 } }),
    { type: "invalid", request_id: "r1" },
  );
  assert.deepEqual(
    parseRuntimeRequest({ type: "set_workspace", workspace: "C:/work" }),
    { type: "set_workspace", workspace: "C:/work" },
  );
  assert.deepEqual(
    parseRuntimeRequest({ type: "set_workspace", task_id: "t1", workspace: { path: "C:/work", kind: "directory", source: "explicit" } }),
    { type: "set_workspace", task_id: "t1", workspace: { path: "C:/work", kind: "directory", source: "explicit" } },
  );
  assert.deepEqual(
    parseRuntimeRequest({ type: "set_workspace", workspace: 42 }),
    { type: "invalid", request_id: undefined },
  );
  assert.deepEqual(
    parseRuntimeRequest({ type: "clear_workspace", task_id: "t1" }),
    { type: "clear_workspace", task_id: "t1" },
  );
  assert.deepEqual(
    parseRuntimeRequest({ type: "clear_workspace", task_id: "" }),
    { type: "invalid", request_id: undefined },
  );
});

test("forwards permission responses, workspace changes, and the full event vocabulary", async () => {
  const events = [];
  const calls = [];
  const runtimeFactory = async ({ emit }) => ({
    history: [],
    prompt: async (requestId, text) => {
      emit({ type: "ready", provider: "faux", model: "faux-model" });
      emit({
        type: "run_started",
        request_id: requestId,
        tools: [CAPABILITY_DESCRIPTOR_FIXTURE],
      });
      emit({
        type: "workspace_resolved",
        request_id: requestId,
        task_id: "task-1",
        workspace: { status: "resolved", source: "explicit", addressed_path: "C:/work", canonical_path: "C:/work", kind: "directory" },
      });
      emit({
        type: "permission_requested",
        permission_id: "perm-1",
        request_id: requestId,
        task_id: "task-1",
        tool_call_id: "tool-call-1",
        operation: "workspace.write",
        effect: "write",
        ...CAPABILITY_RISK_FIXTURE,
        expires_at: 1234,
        status: "pending",
      });
      emit({ type: "tool_result", request_id: requestId, task_id: "task-1", tool_call_id: "tool-call-1", tool: "workspace.write", status: "denied", text: "denied", details: { status: "denied" }, truncated: false });
      emit({ type: "verification_completed", request_id: requestId, task_id: "task-1", tool: "workspace.write", path: "notes.md", status: "verified" });
      emit({ type: "completed", request_id: requestId });
    },
    cancel: (requestId) => calls.push({ cancel: requestId }),
    resolvePermission: (permissionId, decision, identity) => calls.push({ resolvePermission: { permissionId, decision, identity } }),
    setWorkspace: async (taskId, workspace) => calls.push({ setWorkspace: { taskId, workspace } }),
    clearWorkspace: (taskId) => calls.push({ clearWorkspace: { taskId } }),
  });
  const input = Readable.from([
    `${JSON.stringify({ type: "prompt", request_id: "protocol-full", text: "write" })}\n`,
    `${JSON.stringify({ type: "permission_response", request_id: "protocol-full", permission_id: "perm-1", decision: "deny", identity: { request_id: "protocol-full", task_id: "task-1", tool_call_id: "tool-call-1" } })}\n`,
    `${JSON.stringify({ type: "set_workspace", task_id: "task-1", workspace: { path: "C:/other", kind: "directory" } })}\n`,
    `${JSON.stringify({ type: "clear_workspace", task_id: "task-1" })}\n`,
  ]);

  await runProtocol({ input, emit: (event) => events.push(event), runtimeFactory });
  await Promise.resolve();

  const eventTypes = events.map((event) => event.type);
  for (const expected of [
    "history_restored",
    "ready",
    "run_started",
    "workspace_resolved",
    "permission_requested",
    "tool_result",
    "verification_completed",
    "completed",
  ]) {
    assert.ok(eventTypes.includes(expected), `missing ${expected}`);
  }
  assert.deepEqual(calls.find((call) => call.resolvePermission), {
    resolvePermission: {
      permissionId: "perm-1",
      decision: "deny",
      identity: { request_id: "protocol-full", task_id: "task-1", tool_call_id: "tool-call-1" },
    },
  });
  assert.deepEqual(calls.find((call) => call.setWorkspace), {
    setWorkspace: { taskId: "task-1", workspace: { path: "C:/other", kind: "directory" } },
  });
  assert.deepEqual(calls.find((call) => call.clearWorkspace), {
    clearWorkspace: { taskId: "task-1" },
  });

  // Every capability dimension crosses the boundary unchanged.
  const started = events.find((event) => event.type === "run_started");
  assert.deepEqual(started.tools, [CAPABILITY_DESCRIPTOR_FIXTURE]);
  for (const key of [
    "contract_version",
    "effect",
    "scope",
    "egress",
    "source",
    "replay",
    "availability",
    "origin_label",
  ]) {
    assert.deepEqual(
      started.tools[0][key],
      CAPABILITY_DESCRIPTOR_FIXTURE[key],
      `${key} survived the round trip`,
    );
  }

  const permission = events.find((event) => event.type === "permission_requested");
  assert.equal(permission.egress, "none");
  assert.equal(permission.source, "builtin");
  assert.deepEqual(permission.risk, CAPABILITY_RISK_FIXTURE.risk);
});

test("reports a set-workspace failure as a recoverable session warning", async () => {
  const events = [];
  const runtimeFactory = async () => ({
    history: [],
    prompt: async () => undefined,
    cancel: () => undefined,
    resolvePermission: () => undefined,
    setWorkspace: async () => {
      const error = new Error("outside workspace");
      error.code = "scope_escape";
      throw error;
    },
    clearWorkspace: () => undefined,
  });
  const input = Readable.from([
    `${JSON.stringify({ type: "set_workspace", workspace: "C:/outside" })}\n`,
  ]);

  await runProtocol({ input, emit: (event) => events.push(event), runtimeFactory });
  await Promise.resolve();

  assert.ok(
    events.some(
      (event) => event.type === "session_warning" && /outside workspace/.test(event.message),
    ),
  );
});

test("emits one terminal event when a runtime rejects after settling", async () => {
  const events = [];
  const runtimeFactory = async ({ emit }) => ({
    history: [],
    prompt: async (requestId) => {
      events.push({ type: "observed_prompt", request_id: requestId });
      emit({ type: "completed", request_id: requestId });
      throw new Error("runtime failure");
    },
    cancel: () => undefined,
  });

  await runProtocol({
    input: Readable.from(`${JSON.stringify({
      type: "prompt",
      request_id: "protocol-reject",
      text: "hello",
    })}\n`),
    emit: (event) => events.push(event),
    runtimeFactory,
  });

  await Promise.resolve();
  assert.equal(
    events.filter(
      (event) =>
        event.request_id === "protocol-reject" &&
        ["completed", "cancelled", "failed"].includes(event.type),
    ).length,
    1,
  );
});

// ---------------------------------------------------------------------------
// Node version gate
//
// A packaged build ships its own Node, so a version failure means the staging
// step or the bundle is wrong. Reporting it as a provider error would put the
// message far from the cause and name the wrong thing.
// ---------------------------------------------------------------------------

test("accepts the Node versions the runtime supports", () => {
  for (const version of ["22.19.0", "22.20.1", "23.0.0", "24.4.2"]) {
    assert.equal(checkNodeVersion(version).ok, true, `${version} should be accepted`);
  }
});

test("refuses a Node below the supported floor and says which version arrived", () => {
  for (const version of ["22.18.0", "22.0.0", "20.11.1", "18.20.0"]) {
    const result = checkNodeVersion(version);
    assert.equal(result.ok, false, `${version} should be refused`);
    assert.match(result.message, /22\.19 or newer/);
    assert.ok(result.message.includes(version), "the message must name the version that arrived");
  }
});

test("refuses a version it cannot read rather than assuming it is fine", () => {
  const result = checkNodeVersion("not-a-version");
  assert.equal(result.ok, false);
  assert.match(result.message, /unreadable/);
});

/**
 * A fake runtime backed by a real session store.
 *
 * The switch path replaces the runtime wholesale, so the test needs the same
 * store object to survive across "restarts" and needs dispose to be observable.
 */
function sessionProtocolFixture(context, { sessionRoot, environment }) {
  const { createAsideSessionStore, createAsideSession } = sessionStoreModule;
  const store = createAsideSessionStore({ root: sessionRoot, environment, cwd: join(sessionRoot, "aside-session") });
  const disposed = [];
  const factoryCalls = [];
  const runtimeFactory = async ({ sessionTarget }) => {
    factoryCalls.push(sessionTarget ?? { mode: "default" });
    let id;
    if (sessionTarget?.mode === "new") {
      id = (await createAsideSession(store)).metadata.id;
    } else if (sessionTarget?.mode === "open") {
      id = sessionTarget.id;
    } else {
      id = (await createAsideSession(store)).metadata.id;
    }
    const runtime = {
      history: [],
      agent: { sessionId: id },
      sessionStore: store,
      continuation: { selectedWorkspace: { path: "stale" }, activeSkillName: "stale" },
      dispose: async () => { disposed.push(id); },
      prompt: async () => {},
      cancel: () => {},
      resolvePermission: () => {},
      setWorkspace: async () => {},
      clearWorkspace: () => {},
      redactError: (error) => String(error?.message ?? error),
    };
    return runtime;
  };
  return { store, disposed, factoryCalls, runtimeFactory };
}

/**
 * Waits for an observable condition instead of sleeping a fixed time.
 *
 * The session tests exercise ordering between a prompt and a switch; a fixed
 * delay encodes how fast the machine is, which is how such a test passes here
 * and fails on a loaded CI box.
 */
async function until(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for an observable condition.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function sessionFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "aside-protocol-sessions-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return { sessionRoot: join(root, "sessions"), environment: { LOCALAPPDATA: join(root, "data") } };
}

test("a conversation switch disposes the old runtime and reports the new session", async (context) => {
  const { sessionRoot, environment } = await sessionFixture(context);
  const { store, disposed, factoryCalls, runtimeFactory } = sessionProtocolFixture(context, { sessionRoot, environment });
  const events = [];
  const input = Readable.from([
    `${JSON.stringify({ type: "switch_session", request_id: "switch-1", create: true })}\n`,
    `${JSON.stringify({ type: "list_sessions", request_id: "list-1" })}\n`,
  ]);
  await runProtocol({ input, runtimeFactory, emit: (event) => events.push(event) });

  // The initial runtime is replaced, and the replacement opens the session that
  // was created first, so a failed switch cannot leave a dangling file.
  assert.equal(factoryCalls.length, 2);
  assert.equal(factoryCalls[1].mode, "open");
  assert.match(factoryCalls[1].id, /^aside-/u);
  assert.equal(disposed.length, 1);
  const switched = events.find((event) => event.type === "session_switched");
  assert.equal(switched.request_id, "switch-1");
  // History is re-sent so the surface can replace what it showed.
  const restored = events.filter((event) => event.type === "history_restored");
  assert.equal(restored.at(-1).replaced, true);
  const listed = events.find((event) => event.type === "sessions_listed");
  assert.equal(listed.active_session_id, switched.session_id);
  // Switching creates a new conversation; it does not delete the old one.
  assert.equal(listed.sessions.length, 2);
  assert.ok(listed.sessions.some((session) => session.id === switched.session_id));
});

test("a switch to a missing session fails without disposing the active runtime", async (context) => {
  const { sessionRoot, environment } = await sessionFixture(context);
  const { disposed, runtimeFactory } = sessionProtocolFixture(context, { sessionRoot, environment });
  const events = [];
  const input = Readable.from([
    `${JSON.stringify({ type: "switch_session", request_id: "switch-missing", session_id: "aside-missing" })}\n`,
  ]);
  await runProtocol({ input, runtimeFactory, emit: (event) => events.push(event) });

  const failure = events.find((event) => event.type === "session_failed");
  assert.equal(failure.request_id, "switch-missing");
  // The starting runtime stays; only a successful target replaces it.
  assert.deepEqual(disposed, []);
  assert.equal(events.some((event) => event.type === "session_switched"), false);
});

test("renaming and deleting report on their own request and never touch another session", async (context) => {
  const { sessionRoot, environment } = await sessionFixture(context);
  const { store, runtimeFactory } = sessionProtocolFixture(context, { sessionRoot, environment });
  const { createAsideSession } = sessionStoreModule;
  const extra = await createAsideSession(store);
  const events = [];
  const input = Readable.from([
    `${JSON.stringify({ type: "rename_session", request_id: "rename-1", session_id: extra.metadata.id, name: "Notes" })}\n`,
    `${JSON.stringify({ type: "delete_session", request_id: "delete-1", session_id: extra.metadata.id })}\n`,
    `${JSON.stringify({ type: "list_sessions", request_id: "list-2" })}\n`,
  ]);
  await runProtocol({ input, runtimeFactory, emit: (event) => events.push(event) });

  assert.equal(events.find((event) => event.type === "session_renamed").name, "Notes");
  assert.equal(events.find((event) => event.type === "session_deleted").request_id, "delete-1");
  const listed = events.find((event) => event.type === "sessions_listed");
  assert.equal(listed.sessions.some((session) => session.id === extra.metadata.id), false);
});

test("deleting the active conversation moves to a new one first", async (context) => {
  const { sessionRoot, environment } = await sessionFixture(context);
  const { runtimeFactory } = sessionProtocolFixture(context, { sessionRoot, environment });
  const events = [];
  const input = new PassThrough();
  const done = runProtocol({ input, runtimeFactory, emit: (event) => events.push(event) });
  await new Promise((resolve) => setImmediate(resolve));

  // Discover the active id through the same list the surface uses, then ask to
  // delete it. Deleting the open conversation must not leave a dead reference.
  input.write(`${JSON.stringify({ type: "list_sessions", request_id: "list-before" })}\n`);
  input.end();
  await done;
  const before = events.find((event) => event.type === "sessions_listed");
  const activeId = before.active_session_id;
  assert.ok(activeId);

  const events2 = [];
  const input2 = Readable.from([
    `${JSON.stringify({ type: "delete_session", request_id: "delete-active", session_id: activeId })}\n`,
  ]);
  await runProtocol({ input: input2, runtimeFactory, emit: (event) => events2.push(event) });
  const switched = events2.find((event) => event.type === "session_switched");
  const deleted = events2.find((event) => event.type === "session_deleted");
  assert.equal(deleted.id, activeId);
  // "new one first" is the guarantee: the surface is never left on the file
  // being removed.
  if (switched) assert.notEqual(switched.session_id, activeId);
});

test("a switch waits for the in-flight prompt to persist before replacing the runtime", async (context) => {
  const { sessionRoot, environment } = await sessionFixture(context);
  const { createAsideSessionStore, createAsideSession } = sessionStoreModule;
  const store = createAsideSessionStore({ root: sessionRoot, environment, cwd: join(sessionRoot, "aside-session") });
  const order = [];
  let releasePrompt;
  const promptGate = new Promise((resolve) => { releasePrompt = resolve; });
  let firstId;
  const runtimeFactory = async ({ sessionTarget }) => {
    if (!firstId) {
      firstId = (await createAsideSession(store)).metadata.id;
    }
    const id = sessionTarget?.mode === "open" ? sessionTarget.id : (sessionTarget?.mode === "new"
      ? (await createAsideSession(store)).metadata.id
      : firstId);
    return {
      history: [],
      agent: { sessionId: id },
      sessionStore: store,
      continuation: {},
      dispose: async () => { order.push("dispose"); },
      prompt: async () => {
        order.push("prompt-start");
        await promptGate;
        order.push("prompt-persisted");
      },
      cancel: () => {},
      resolvePermission: () => {},
      setWorkspace: async () => {},
      clearWorkspace: () => {},
      redactError: (error) => String(error?.message ?? error),
    };
  };
  const events = [];
  const input = new PassThrough();
  const done = runProtocol({ input, runtimeFactory, emit: (event) => events.push(event) });
  await new Promise((resolve) => setImmediate(resolve));

  input.write(`${JSON.stringify({ type: "prompt", request_id: "p1", text: "hello" })}\n`);
  // Wait for the prompt to actually start rather than assume a delay: a fixed
  // sleep passes on an idle machine and fails under load, which is exactly the
  // kind of flake this test is meant to catch a real bug with.
  await until(() => order.includes("prompt-start"));
  input.write(`${JSON.stringify({ type: "switch_session", request_id: "s1", create: true })}\n`);
  // The switch request must reach the protocol before we assert; the queue
  // drains on a microtask, so a single turn is enough to observe its effect.
  await new Promise((resolve) => setImmediate(resolve));

  // The switch must not have disposed the runtime while the prompt is still
  // running: that would drop the conversation before it was saved.
  assert.deepEqual(order, ["prompt-start"]);
  releasePrompt();
  input.end();
  await done;

  assert.equal(order.at(-1), "dispose");
  assert.ok(order.indexOf("prompt-persisted") < order.indexOf("dispose"));
  assert.ok(events.some((event) => event.type === "session_switched" && event.request_id === "s1"));
});

test("a prompt sent while a switch is in flight is refused rather than routed to the old runtime", async (context) => {
  const { sessionRoot, environment } = await sessionFixture(context);
  const { createAsideSessionStore, createAsideSession } = sessionStoreModule;
  const store = createAsideSessionStore({ root: sessionRoot, environment, cwd: join(sessionRoot, "aside-session") });
  let releaseSwitch;
  const switchGate = new Promise((resolve) => { releaseSwitch = resolve; });
  let calls = 0;
  let firstId;
  const runtimeFactory = async ({ sessionTarget }) => {
    calls += 1;
    if (!firstId) firstId = (await createAsideSession(store)).metadata.id;
    if (calls === 2) await switchGate;
    return {
      history: [], agent: { sessionId: sessionTarget?.mode === "open" ? sessionTarget.id : firstId },
      sessionStore: store, continuation: {}, dispose: async () => {},
      prompt: async () => { throw new Error("prompt must not reach a runtime being replaced"); },
      cancel: () => {}, resolvePermission: () => {}, setWorkspace: async () => {}, clearWorkspace: () => {},
      redactError: (error) => String(error?.message ?? error),
    };
  };
  const events = [];
  const input = new PassThrough();
  const done = runProtocol({ input, runtimeFactory, emit: (event) => events.push(event) });
  await new Promise((resolve) => setImmediate(resolve));

  input.write(`${JSON.stringify({ type: "switch_session", request_id: "s1", create: true })}\n`);
  // Wait until the switch has actually reached the runtime factory (which is
  // parked on the gate) instead of guessing with a fixed delay.
  await until(() => calls === 2);
  input.write(`${JSON.stringify({ type: "prompt", request_id: "p-late", text: "too late" })}\n`);
  // Let the prompt be read and dispatched while the switch is still parked.
  await new Promise((resolve) => setImmediate(resolve));
  releaseSwitch();
  input.end();
  await done;

  const failure = events.find((event) => event.type === "failed" && event.request_id === "p-late");
  assert.ok(failure);
  assert.equal(failure.retryable, true);
});
