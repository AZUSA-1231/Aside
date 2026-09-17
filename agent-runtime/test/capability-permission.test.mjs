import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PERMISSION_GRANTS,
  PERMISSION_EFFECTS,
  PermissionBroker,
  PermissionError,
} from "../src/permission-broker.mjs";
import { TOOL_EGRESS_VALUES } from "../src/capability-contract.mjs";

const MAX_PENDING_MS = 10 * 60 * 1000;

function createBroker({ now = () => 1_000, emit } = {}) {
  const events = [];
  const broker = new PermissionBroker({
    emit: (event) => {
      events.push(event);
      emit?.(event);
    },
    now,
    maxPendingMs: 120_000,
  });
  return { broker, events };
}

function identity(overrides = {}) {
  return {
    request_id: "request-1",
    task_id: "task-1",
    tool_call_id: "call-1",
    operation: "workspace.write",
    ...overrides,
  };
}

test("accepts the capability effects and rejects the removed external value", () => {
  assert.deepEqual(PERMISSION_EFFECTS, ["read", "write", "execute"]);
  for (const effect of PERMISSION_EFFECTS) {
    const { broker } = createBroker();
    const pending = broker.request(identity({ permission_id: `p-${effect}`, effect }));
    broker.resolve(`p-${effect}`, "deny", identity());
    assert.equal(typeof pending.then, "function");
  }
  for (const effect of ["external", "shell", "network", ""]) {
    const { broker } = createBroker();
    assert.throws(
      () => broker.request(identity({ effect })),
      PermissionError,
      effect,
    );
  }
});

test("defaults a legacy request to the same public record as Cycle 5", () => {
  const { broker, events } = createBroker();
  broker.request(identity({ permission_id: "legacy-1" }));
  const requested = events.find((event) => event.type === "permission_requested");
  assert.equal(requested.effect, "write");
  assert.equal(requested.egress, "none");
  assert.equal(requested.source, "builtin");
  assert.equal(requested.risk.boundary, "aside_enforced");
  assert.equal(requested.risk.origin_label, "Aside built-in capability");
  assert.equal(requested.operation, "workspace.write");
  assert.equal(requested.request_id, "request-1");
  assert.equal(requested.status, "pending");
  broker.dispose();
});

test("recomputes risk instead of accepting a caller's description of itself", () => {
  const { broker, events } = createBroker();
  broker.request(
    identity({
      permission_id: "self-described",
      request_id: "request-mcp",
      task_id: "task-mcp",
      tool_call_id: "call-mcp",
      source: "user_mcp",
      egress: "query",
      origin_label: "Local files helper",
      // A caller that tries to soften its own boundary is ignored.
      risk: { boundary: "aside_enforced", note: "Fully sandboxed." },
      boundary: "aside_enforced",
    }),
  );
  const requested = events.find((event) => event.type === "permission_requested");
  assert.equal(requested.source, "user_mcp");
  assert.equal(requested.egress, "query");
  assert.equal(requested.risk.boundary, "external_process");
  assert.equal(requested.risk.origin_label, "Local files helper");
  // The note comes from the frozen table, not from the caller, and it states
  // the boundary honestly rather than claiming a sandbox.
  assert.equal(
    requested.risk.note,
    "This tool runs in a separate program that Aside does not sandbox.",
  );
  assert.equal(requested.risk.note.includes("Fully sandboxed."), false);
  broker.dispose();
});

test("bounds and redacts the reported origin label", () => {
  const { broker, events } = createBroker();
  broker.request(
    identity({
      permission_id: "labelled",
      origin_label: `helper ${"x".repeat(60)}`,
    }),
  );
  const requested = events.find((event) => event.type === "permission_requested");
  assert.ok(
    Buffer.byteLength(requested.risk.origin_label, "utf8") <= 120,
    "the label is bounded",
  );
  broker.dispose();

  // An over-long label is rejected rather than silently truncated, matching
  // how every other bounded permission field behaves.
  const long = createBroker();
  assert.throws(
    () =>
      long.broker.request(
        identity({ permission_id: "too-long", origin_label: "y".repeat(400) }),
      ),
    PermissionError,
  );
  long.broker.dispose();

  // A secret-shaped label is redacted rather than echoed.
  const secret = createBroker();
  secret.broker.request(
    identity({ permission_id: "secret", origin_label: "token=abcdefghijkl" }),
  );
  const event = secret.events.find((item) => item.type === "permission_requested");
  assert.equal(event.risk.origin_label.includes("abcdefghijkl"), false);
  secret.broker.dispose();
});

test("rejects an unknown egress or source value", () => {
  for (const field of ["egress", "source"]) {
    const { broker } = createBroker();
    assert.throws(
      () => broker.request(identity({ [field]: "invented" })),
      PermissionError,
      field,
    );
  }
  assert.ok(TOOL_EGRESS_VALUES.includes("none"));
});

test("keeps the exact-operation binding and duplicate rejection", async () => {
  const { broker } = createBroker();
  const pending = broker.request(identity({ permission_id: "bound-1" }));

  // A mismatched identity cannot resolve someone else's pending operation.
  assert.equal(
    broker.resolve("bound-1", "allow", { task_id: "another-task" }).code,
    "permission_mismatch",
  );
  assert.equal(broker.resolve("missing", "allow", identity()).code, "permission_not_found");
  assert.equal(broker.resolve("bound-1", "maybe", identity()).code, "invalid_decision");

  assert.throws(
    () => broker.request(identity({ permission_id: "bound-1" })),
    (error) => error.code === "duplicate_permission",
  );

  assert.deepEqual(broker.resolve("bound-1", "allow", identity()), {
    status: "accepted",
    code: "allow",
    permission_id: "bound-1",
  });
  const result = await pending;
  assert.equal(result.status, "allowed");
  assert.equal(result.effect, "write");
  broker.dispose();
});

test("settles expiry and cancellation exactly once", async () => {
  let now = 1_000;
  const { broker } = createBroker({ now: () => now });
  const expiring = broker.request(identity({ permission_id: "expires", pending_ms: 50 }));
  now += 100;
  assert.equal(broker.resolve("expires", "allow", identity()).status, "expired");
  assert.equal((await expiring).status, "expired");

  const cancelled = broker.request(identity({ permission_id: "cancels" }));
  assert.equal(broker.cancelForRun({ taskId: "task-1" }), 1);
  assert.equal((await cancelled).status, "cancelled");
  assert.equal(broker.cancelForRun({ taskId: "task-1" }), 0);
  broker.dispose();
});

test("records a single-use grant only for an approved operation", async () => {
  const { broker } = createBroker();

  const allowed = broker.request(identity({ permission_id: "granted", tool_call_id: "call-allow" }));
  broker.resolve("granted", "allow", identity({ tool_call_id: "call-allow" }));
  await allowed;
  assert.equal(broker.consumeGrant("call-allow"), true, "consumed once");
  assert.equal(broker.consumeGrant("call-allow"), false, "never twice");
  assert.equal(broker.grantCount, 0);

  for (const [permissionId, toolCallId, decision, expected] of [
    ["denied", "call-deny", "deny", "denied"],
    ["cancelled", "call-cancel", "cancel", "cancelled"],
    ["expired-grant", "call-expire", "cancel", "expired"],
  ]) {
    const pending = broker.request(identity({ permission_id: permissionId, tool_call_id: toolCallId }));
    if (permissionId === "expired-grant") {
      broker.cancel(permissionId, "expired");
    } else {
      broker.resolve(permissionId, decision, identity({ tool_call_id: toolCallId }));
    }
    assert.equal((await pending).status, expected);
    assert.equal(broker.consumeGrant(toolCallId), false, `${decision} grants nothing`);
  }

  assert.equal(broker.consumeGrant("never-seen"), false);
  assert.equal(broker.consumeGrant(""), false);
  assert.equal(broker.consumeGrant(undefined), false);
  broker.dispose();
});

test("binds a grant to the run that earned it", async () => {
  const { broker } = createBroker();
  const pending = broker.request(
    identity({ permission_id: "bound-grant", request_id: "run-a", task_id: "task-a" }),
  );
  broker.resolve("bound-grant", "allow", identity({ request_id: "run-a", task_id: "task-a" }));
  await pending;

  // A later run reusing the same call id must not inherit the approval.
  assert.equal(
    broker.consumeGrant("call-1", { request_id: "run-b", task_id: "task-a" }),
    false,
    "another run cannot spend this grant",
  );
  assert.equal(
    broker.consumeGrant("call-1", { request_id: "run-a", task_id: "task-b" }),
    false,
    "another task cannot spend this grant",
  );
  assert.equal(broker.grantCount, 1, "the rejected attempts did not consume it");
  assert.equal(
    broker.consumeGrant("call-1", { request_id: "run-a", task_id: "task-a" }),
    true,
    "the owning run still can",
  );
  broker.dispose();
});

test("drops a settled run's unspent grants", async () => {
  const { broker } = createBroker();
  for (const [requestId, toolCallId] of [
    ["run-a", "call-a1"],
    ["run-a", "call-a2"],
    ["run-b", "call-b1"],
  ]) {
    const pending = broker.request(
      identity({ permission_id: `p-${toolCallId}`, request_id: requestId, tool_call_id: toolCallId }),
    );
    broker.resolve(`p-${toolCallId}`, "allow", identity({ request_id: requestId, tool_call_id: toolCallId }));
    await pending;
  }
  assert.equal(broker.grantCount, 3);

  assert.equal(broker.clearGrantsForRun({ requestId: "run-a" }), 2);
  assert.equal(broker.grantCount, 1);
  assert.equal(broker.consumeGrant("call-a1", { request_id: "run-a" }), false);
  assert.equal(broker.consumeGrant("call-b1", { request_id: "run-b" }), true);
  broker.dispose();
});

test("caps the grant ledger and clears it on dispose", async () => {
  const { broker } = createBroker();
  for (let index = 0; index < MAX_PERMISSION_GRANTS + 5; index += 1) {
    const toolCallId = `call-${index}`;
    const pending = broker.request(
      identity({ permission_id: `p-${index}`, tool_call_id: toolCallId }),
    );
    broker.resolve(`p-${index}`, "allow", identity({ tool_call_id: toolCallId }));
    await pending;
  }
  assert.equal(broker.grantCount, MAX_PERMISSION_GRANTS);
  assert.equal(broker.consumeGrant("call-0"), false, "the oldest grant was evicted");
  assert.equal(broker.consumeGrant(`call-${MAX_PERMISSION_GRANTS + 4}`), true);

  broker.dispose();
  assert.equal(broker.grantCount, 0, "no grant survives dispose");
});

test("a cancelled run leaves no grant behind", async () => {
  const { broker } = createBroker();
  const approved = broker.request(identity({ permission_id: "ok", tool_call_id: "call-ok" }));
  broker.resolve("ok", "allow", identity({ tool_call_id: "call-ok" }));
  await approved;

  const waiting = broker.request(identity({ permission_id: "waiting", tool_call_id: "call-waiting" }));
  broker.cancelForRun({ taskId: "task-1" }, "aborted");
  assert.equal((await waiting).code, "aborted");
  assert.equal(broker.consumeGrant("call-waiting"), false);

  // Cancelling a run does not retroactively revoke an already-earned grant.
  assert.equal(broker.consumeGrant("call-ok"), true);
  broker.dispose();
});
