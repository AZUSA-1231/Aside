import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core/aside";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { DEFAULT_AGENT_LIMITS } from "../src/agent-contracts.mjs";
import { createAsideToolRegistry } from "../src/capability-contract.mjs";
import {
  PermissionBroker,
  PermissionError,
} from "../src/permission-broker.mjs";
import { createConversationRuntime } from "../src/runtime.mjs";
import {
  createDocumentAdapterRegistry,
} from "../src/workspace-tools.mjs";
import {
  DEFAULT_WORKSPACE_WRITE_LIMITS,
  createWorkspaceWriteTools,
} from "../src/workspace-write-tools.mjs";
import { resolveTaskWorkspace } from "../src/workspace.mjs";

function taskRun(overrides = {}) {
  return {
    request_id: "request-write",
    task_id: "task-write",
    limits: {
      ...DEFAULT_AGENT_LIMITS,
      maxToolResultBytes: 32 * 1024,
      ...overrides,
    },
  };
}

function resultText(result) {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aside-write-tools-"));
  await writeFile(join(root, "notes.md"), "alpha\nbeta\n", "utf8");
  await writeFile(join(root, "data.json"), JSON.stringify({ title: "Aside", count: 1 }, null, 2), "utf8");
  return resolve(root);
}

async function boundWrite(root, name, options = {}, runOverrides = {}) {
  const resolution = await resolveTaskWorkspace({ workspaceHint: root });
  const events = [];
  const broker = new PermissionBroker({
    emit: (event) => events.push(event),
    maxPendingMs: 5_000,
  });
  const tool = createWorkspaceWriteTools(options).find((entry) => entry.name === name);
  const implementation = await tool.createForRun({
    workspace: resolution.environment,
    taskRun: taskRun(runOverrides),
    permissionBroker: broker,
    emit: (event) => events.push(event),
  });
  return { implementation, broker, events, environment: resolution.environment };
}

async function waitFor(events, predicate) {
  if (events.some(predicate)) return events.find(predicate);
  return new Promise((resolveWait) => {
    const timer = setInterval(() => {
      const event = events.find(predicate);
      if (event) {
        clearInterval(timer);
        resolveWait(event);
      }
    }, 1);
  });
}

test("permission broker binds one exact operation and rejects duplicate or mismatched responses", async () => {
  const events = [];
  const broker = new PermissionBroker({ emit: (event) => events.push(event), maxPendingMs: 1_000 });
  const pending = broker.request({
    request_id: "request-1",
    task_id: "task-1",
    tool_call_id: "call-1",
    operation: "workspace.write",
    workspace: { relative_path: "." },
    targets: [{ path: "notes.md" }],
    preview: { new_preview: "updated" },
  });
  const requested = events.find((event) => event.type === "permission_requested");
  assert.equal(requested.status, "pending");
  assert.equal(broker.pendingCount, 1);
  assert.deepEqual(
    broker.resolve(requested.permission_id, "allow", { request_id: "other" }),
    { status: "ignored", code: "permission_mismatch" },
  );
  assert.deepEqual(
    broker.resolve(requested.permission_id, "allow", {
      request_id: "request-1",
      task_id: "task-1",
      tool_call_id: "call-1",
    }),
    { status: "accepted", code: "allow", permission_id: requested.permission_id },
  );
  const outcome = await pending;
  assert.equal(outcome.status, "allowed");
  assert.equal(outcome.decision, "allow");
  assert.equal(broker.pendingCount, 0);
  assert.deepEqual(
    broker.resolve(requested.permission_id, "allow"),
    { status: "ignored", code: "permission_not_found" },
  );
  assert.equal(events.filter((event) => event.type === "permission_resolved").length, 1);
});

test("permission broker returns bounded denial, cancellation, and expiry outcomes", async () => {
  const events = [];
  let clock = 100;
  const broker = new PermissionBroker({
    emit: (event) => events.push(event),
    now: () => clock,
    maxPendingMs: 100,
  });
  const denied = broker.request({
    permission_id: "deny-1",
    request_id: "request-2",
    task_id: "task-2",
    tool_call_id: "call-2",
    operation: "workspace.edit",
    explanation: "replace text",
  });
  broker.resolve("deny-1", "deny");
  assert.equal((await denied).status, "denied");

  const expired = broker.request({
    permission_id: "expire-1",
    request_id: "request-3",
    task_id: "task-3",
    tool_call_id: "call-3",
    operation: "workspace.write",
    expires_at: 105,
  });
  clock = 106;
  assert.deepEqual(
    broker.resolve("expire-1", "allow"),
    { status: "expired", code: "expired", permission_id: "expire-1" },
  );
  assert.equal((await expired).status, "expired");

  const controller = new AbortController();
  const cancelled = broker.request({
    permission_id: "cancel-1",
    request_id: "request-4",
    task_id: "task-4",
    tool_call_id: "call-4",
    operation: "workspace.write",
  }, controller.signal);
  controller.abort();
  assert.equal((await cancelled).code, "aborted");
  assert.equal(events.filter((event) => event.type === "permission_requested").length, 3);
  assert.throws(
    () => broker.request({
      permission_id: "bad-1",
      request_id: "request-5",
      task_id: "task-5",
      tool_call_id: "call-5",
      operation: "workspace.write",
      effect: "external",
    }),
    PermissionError,
  );
});

test("write and edit prepare exact previews and execute only after allow", async () => {
  const root = await fixture();
  try {
    const write = await boundWrite(root, "workspace.write");
    const writeExecution = write.implementation.execute("write-call", {
      path: "new.md",
      content: "created content\n",
    });
    const request = await waitFor(write.events, (event) => event.type === "permission_requested");
    assert.equal(await write.environment.exists("new.md"), false);
    assert.equal(request.effect, "write");
    assert.equal(request.targets[0].state, "new");
    assert.match(request.preview.new_preview, /created content/);
    write.broker.resolve(request.permission_id, "allow", {
      request_id: "request-write",
      task_id: "task-write",
      tool_call_id: "write-call",
    });
    const writeResult = await writeExecution;
    assert.equal(writeResult.details.status, "succeeded");
    assert.equal(writeResult.details.verification.status, "verified");
    assert.equal(await readFile(join(root, "new.md"), "utf8"), "created content\n");

    const edit = await boundWrite(root, "workspace.edit");
    const editExecution = edit.implementation.execute("edit-call", {
      path: "notes.md",
      old_text: "beta",
      new_text: "revised",
    });
    const editRequest = await waitFor(edit.events, (event) => event.type === "permission_requested");
    assert.equal(editRequest.targets[0].state, "modified");
    assert.match(editRequest.preview.old_preview, /beta/);
    assert.match(editRequest.preview.new_preview, /revised/);
    edit.broker.resolve(editRequest.permission_id, "allow");
    const editResult = await editExecution;
    assert.equal(editResult.details.status, "succeeded");
    assert.equal(editResult.details.replacement_count, 1);
    assert.equal(await readFile(join(root, "notes.md"), "utf8"), "alpha\nrevised\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deny, expiry, cancellation, invalid edits, and stale targets never mutate the workspace", async () => {
  const root = await fixture();
  try {
    const denied = await boundWrite(root, "workspace.write");
    const deniedExecution = denied.implementation.execute("deny-call", {
      path: "denied.txt",
      content: "must not be written",
    });
    const deniedRequest = await waitFor(denied.events, (event) => event.type === "permission_requested");
    denied.broker.resolve(deniedRequest.permission_id, "deny");
    const deniedResult = await deniedExecution;
    assert.equal(deniedResult.details.status, "denied");
    assert.equal(await denied.environment.exists("denied.txt"), false);

    const stale = await boundWrite(root, "workspace.edit");
    const staleExecution = stale.implementation.execute("stale-call", {
      path: "notes.md",
      old_text: "beta",
      new_text: "stale replacement",
    });
    const staleRequest = await waitFor(stale.events, (event) => event.type === "permission_requested");
    await writeFile(join(root, "notes.md"), "alpha\nchanged externally\n", "utf8");
    stale.broker.resolve(staleRequest.permission_id, "allow");
    const staleResult = await staleExecution;
    assert.equal(staleResult.details.code, "stale_target");
    assert.equal(await readFile(join(root, "notes.md"), "utf8"), "alpha\nchanged externally\n");

    const invalid = await boundWrite(root, "workspace.edit");
    const invalidResult = await invalid.implementation.execute("invalid-call", {
      path: "notes.md",
      old_text: "does not exist",
      new_text: "anything",
    });
    assert.equal(invalidResult.details.code, "edit_not_found");
    assert.equal(invalid.broker.pendingCount, 0);

    const cancellation = await boundWrite(root, "workspace.write");
    const controller = new AbortController();
    const cancellationExecution = cancellation.implementation.execute(
      "cancel-call",
      { path: "cancelled.txt", content: "must not be written" },
      controller.signal,
    );
    const cancellationRequest = await waitFor(cancellation.events, (event) => event.type === "permission_requested");
    controller.abort();
    const cancellationResult = await cancellationExecution;
    assert.equal(cancellationResult.details.status, "cancelled");
    assert.equal(cancellationResult.details.code, "permission_cancelled");
    assert.equal(await cancellation.environment.exists("cancelled.txt"), false);
    assert.equal(cancellation.broker.resolve(cancellationRequest.permission_id, "allow").code, "permission_not_found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JSON writes require parse validation and report verified content", async () => {
  const root = await fixture();
  try {
    const write = await boundWrite(root, "workspace.write");
    const invalid = await write.implementation.execute("json-invalid", {
      path: "new.json",
      content: "{invalid",
    });
    assert.equal(invalid.details.code, "invalid_document");
    assert.equal(write.broker.pendingCount, 0);
    assert.equal(await write.environment.exists("new.json"), false);

    const valid = await boundWrite(root, "workspace.write");
    const execution = valid.implementation.execute("json-valid", {
      path: "new.json",
      content: JSON.stringify({ ok: true, count: 3 }),
    });
    const request = await waitFor(valid.events, (event) => event.type === "permission_requested");
    valid.broker.resolve(request.permission_id, "allow");
    const result = await execution;
    assert.equal(result.details.format, "json");
    assert.equal(result.details.verification.status, "verified");
    assert.deepEqual(JSON.parse(await readFile(join(root, "new.json"), "utf8")), { ok: true, count: 3 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("permission expiry and target creation races fail closed", async () => {
  const root = await fixture();
  try {
    const expiry = await boundWrite(root, "workspace.write", {}, {
      maxPendingPermissionMs: 20,
    });
    const expiryExecution = expiry.implementation.execute("expiry-call", {
      path: "expired.txt",
      content: "must not be written",
    });
    const expiryRequest = await waitFor(expiry.events, (event) => event.type === "permission_requested");
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    const expiryResult = await expiryExecution;
    assert.equal(expiryResult.details.status, "expired");
    assert.equal(expiryResult.details.code, "permission_expired");
    assert.equal(await expiry.environment.exists("expired.txt"), false);
    assert.equal(expiry.broker.resolve(expiryRequest.permission_id, "allow").code, "permission_not_found");

    const race = await boundWrite(root, "workspace.write");
    const raceExecution = race.implementation.execute("race-call", {
      path: "race.txt",
      content: "prepared content",
    });
    const raceRequest = await waitFor(race.events, (event) => event.type === "permission_requested");
    await writeFile(join(root, "race.txt"), "created by another actor", "utf8");
    race.broker.resolve(raceRequest.permission_id, "allow");
    const raceResult = await raceExecution;
    assert.equal(raceResult.details.code, "stale_target");
    assert.equal(await readFile(join(root, "race.txt"), "utf8"), "created by another actor");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an approved write reports an underlying atomic failure without claiming success", async () => {
  const root = await fixture();
  try {
    const resolution = await resolveTaskWorkspace({
      workspaceHint: root,
      fileSystem: {
        async rename() {
          const error = new Error("rename denied");
          error.code = "EACCES";
          throw error;
        },
      },
    });
    const events = [];
    const broker = new PermissionBroker({ emit: (event) => events.push(event), maxPendingMs: 5_000 });
    const tool = createWorkspaceWriteTools().find((entry) => entry.name === "workspace.edit");
    const implementation = await tool.createForRun({
      workspace: resolution.environment,
      taskRun: taskRun(),
      permissionBroker: broker,
      emit: (event) => events.push(event),
    });
    const execution = implementation.execute("atomic-failure-call", {
      path: "notes.md",
      old_text: "beta",
      new_text: "cannot save",
    });
    const request = await waitFor(events, (event) => event.type === "permission_requested");
    broker.resolve(request.permission_id, "allow");
    const result = await execution;
    assert.equal(result.details.status, "failed");
    assert.equal(result.details.code, "filesystem_permission_denied");
    assert.equal(await readFile(join(root, "notes.md"), "utf8"), "alpha\nbeta\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two writes in one assistant response require two independent approvals", async () => {
  const root = await fixture();
  try {
    const faux = fauxProvider({ tokensPerSecond: 1_000 });
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("workspace.write", { path: "first.txt", content: "first" }, { id: "batch-write-1" }),
        fauxToolCall("workspace.write", { path: "second.txt", content: "second" }, { id: "batch-write-2" }),
      ]),
      fauxAssistantMessage("both writes approved"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const agent = new Agent({
      initialState: {
        systemPrompt: "Use workspace tools.",
        model: faux.getModel(),
        thinkingLevel: "off",
      },
      streamFn: models.streamSimple.bind(models),
      convertToLlm: (messages) => messages,
    });
    const events = [];
    const broker = new PermissionBroker({ emit: () => undefined, maxPendingMs: 5_000 });
    let runtime;
    const emit = (event) => {
      events.push(event);
      if (event.type === "permission_requested") {
        runtime.resolvePermission(event.permission_id, "allow", {
          request_id: event.request_id,
          task_id: event.task_id,
          tool_call_id: event.tool_call_id,
        });
      }
    };
    runtime = await createConversationRuntime({
      agent,
      workspaceHint: root,
      permissionBroker: broker,
      emit,
    });
    await runtime.prompt("batch-write-request", "write two files");
    const permissions = events.filter((event) => event.type === "permission_requested");
    assert.equal(permissions.length, 2);
    assert.notEqual(permissions[0].permission_id, permissions[1].permission_id);
    assert.deepEqual(await readFile(join(root, "first.txt"), "utf8"), "first");
    assert.deepEqual(await readFile(join(root, "second.txt"), "utf8"), "second");
    assert.equal(events.at(-1).type, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a runtime write resumes the same Pi loop only after the exact permission response", async () => {
  const root = await fixture();
  try {
    const faux = fauxProvider({ tokensPerSecond: 1_000 });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("workspace.write", {
        path: "runtime.txt",
        content: "runtime write\n",
      }, { id: "runtime-write-call" })),
      fauxAssistantMessage(fauxToolCall("workspace.read", {
        path: "runtime.txt",
      }, { id: "runtime-read-call" })),
      fauxAssistantMessage("verified runtime write"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const agent = new Agent({
      initialState: {
        systemPrompt: "Use the workspace tools.",
        model: faux.getModel(),
        thinkingLevel: "off",
      },
      streamFn: models.streamSimple.bind(models),
      convertToLlm: (messages) => messages,
    });
    const events = [];
    const broker = new PermissionBroker({ emit: () => undefined, maxPendingMs: 5_000 });
    let runtime;
    let writeResultText;
    const emit = (event) => {
      events.push(event);
      if (event.type === "permission_requested") {
        runtime.resolvePermission(event.permission_id, "allow", {
          request_id: event.request_id,
          task_id: event.task_id,
          tool_call_id: event.tool_call_id,
        });
      }
      if (event.type === "tool_result" && event.tool === "workspace.write") {
        writeResultText = event.text;
      }
    };
    runtime = await createConversationRuntime({
      agent,
      workspaceHint: root,
      permissionBroker: broker,
      emit,
    });
    await runtime.prompt("runtime-write-request", "write and verify");
    assert.ok(events.some((event) => event.type === "permission_requested"));
    assert.ok(events.some((event) => event.type === "permission_resolved" && event.status === "allowed"));
    assert.ok(events.some((event) => event.type === "verification_completed"));
    assert.match(writeResultText, /succeeded/);
    assert.equal(events.at(-1).type, "completed");
    assert.equal(await readFile(join(root, "runtime.txt"), "utf8"), "runtime write\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("write registry keeps non-replayable descriptors and accepts the shared adapter seam", () => {
  const adapters = createDocumentAdapterRegistry();
  const registry = createAsideToolRegistry(createWorkspaceWriteTools({ documentAdapters: adapters }));
  assert.deepEqual(registry.describe().map((tool) => tool.replay), ["non_replayable", "non_replayable"]);
  assert.equal(registry.describe().every((tool) => tool.effect === "write"), true);
  assert.equal(DEFAULT_WORKSPACE_WRITE_LIMITS.maxEditOperations, 16);
});
