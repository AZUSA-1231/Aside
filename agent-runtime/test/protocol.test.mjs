import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { parseRuntimeRequest, runProtocol } from "../src/protocol.mjs";

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
