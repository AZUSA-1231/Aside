import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createDocumentTools } from "../src/docx-tools.mjs";
import { PermissionBroker } from "../src/permission-broker.mjs";
import { resolveTaskFileScopes } from "../src/task-workspace.mjs";
import { createWorkspaceWriteTools } from "../src/workspace-write-tools.mjs";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAsideConversationRuntime } from "../src/session.mjs";
import { handleSettingsRequest } from "../src/settings-service.mjs";

const documentSpec = { title: "Output", blocks: [{ type: "paragraph", runs: [{ text: "Preserved source" }] }] };
const capture = (path, kind = "file", expiresAt = Date.now() + 60_000) => ({ flow: { id: "capture-flow", kind: "conversation" }, blocks: [], attachments: [{ id: "capture", host: "word", source: "Captured file", capturedAt: Math.min(Date.now(), expiresAt - 1), expiresAt, sensitivity: "local_content", summary: "Local file", blocks: [{ type: "text", text: "Captured path metadata" }], descriptors: [{ path, kind, role: kind === "file" ? "document" : "workspace_root" }] }] });
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function fixture(operation) {
  const root = resolve(await mkdtemp(join(tmpdir(), "aside-file-scopes-")));
  try {
    const output = join(root, "outputs");
    const sources = join(root, "sources");
    await mkdir(sources);
    const source = join(sources, "input.md");
    await writeFile(source, "original");
    await writeFile(join(sources, "sibling.md"), "not captured");
    await operation({ root, output, sources, source });
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function bind(environment, name, { decision = "allow", onPermission } = {}) {
  const events = [];
  const broker = new PermissionBroker({ maxPendingMs: 5_000, emit: async (event) => {
    events.push(event);
    if (event.type === "permission_requested") {
      await onPermission?.(event);
      broker.resolve(event.permission_id, decision);
    }
  } });
  const tool = [...createWorkspaceWriteTools(), ...createDocumentTools()].find((entry) => entry.name === name);
  const implementation = await tool.createForRun({ workspace: environment, permissionBroker: broker,
    taskRun: { request_id: "req", task_id: "task", limits: { maxPendingPermissionMs: 5_000 } }, emit: (event) => events.push(event) });
  return { implementation, events };
}

test("default output is lazy: denied writes create nothing; approved text writes are verified at an absolute output path", async () => fixture(async ({ output }) => {
  const resolution = await resolveTaskFileScopes({ defaultWorkspaceRoot: output, continuationId: "session" });
  assert.equal(resolution.state.source, "default_workspace");
  assert.equal(resolution.state.pending_creation, true);
  assert.equal(await exists(output), false);
  assert.equal((await resolution.environment.listDirectory(".", { maxEntries: 10 })).entries.length, 0);
  const denied = await bind(resolution.environment, "workspace.write", { decision: "deny" });
  const deniedResult = await denied.implementation.execute("denied", { path: "result.md", content: "new output" });
  assert.equal(deniedResult.isError, true);
  assert.equal(await exists(output), false);
  const allowed = await bind(resolution.environment, "workspace.write", { onPermission: async (event) => {
    assert.equal(event.workspace.canonical_path, output);
    assert.equal(await exists(output), false);
  } });
  const result = await allowed.implementation.execute("allowed", { path: "result.md", content: "new output" });
  assert.equal(result.details.status, "succeeded", JSON.stringify(result));
  assert.equal(result.details.output_absolute_path, join(output, "result.md"));
  assert.equal(result.details.verification.status, "verified");
  assert.equal(await readFile(join(output, "result.md"), "utf8"), "new output");
}));

test("an external captured file is readable without exposing siblings or allowing source edits", async () => fixture(async ({ output, source, sources }) => {
  const { environment, state } = await resolveTaskFileScopes({ defaultWorkspaceRoot: output, context: capture(source), continuationId: "session" });
  assert.equal(state.source_scope.canonical_path, source);
  assert.equal((await environment.readText(source, { maxBytes: 128 })).text, "original");
  assert.equal((await environment.resolvePath(source)).relative_path, source);
  await assert.rejects(environment.readText(join(sources, "sibling.md"), { maxBytes: 128 }), { code: "scope_escape" });
  await assert.rejects(environment.listDirectory(sources, { maxEntries: 10 }), { code: "scope_escape" });
  const edit = await bind(environment, "workspace.edit");
  const result = await edit.implementation.execute("edit-source", { path: source, old_text: "original", new_text: "changed" });
  assert.equal(result.details.code, "source_read_only");
  assert.equal(edit.events.some((event) => event.type === "permission_requested"), false);
  assert.equal(await readFile(source, "utf8"), "original");
  const overlapping = await resolveTaskFileScopes({ defaultWorkspaceRoot: sources, context: capture(source), continuationId: "session" });
  await assert.rejects(overlapping.environment.resolvePath("input.md", { forWrite: true, expectedKind: "file" }), { code: "source_read_only" });
  assert.equal((await overlapping.environment.resolvePath("new-output.md", { forWrite: true, allowMissing: true })).exists, false);
}));

test("directory captures allow bounded discovery; explicit output wins without discarding the source", async () => fixture(async ({ root, output, sources, source }) => {
  const selected = join(root, "selected");
  await mkdir(selected);
  const { environment, state } = await resolveTaskFileScopes({ defaultWorkspaceRoot: output, workspaceHint: selected, context: capture(sources, "directory"), continuationId: "session" });
  assert.equal(state.canonical_path, selected);
  assert.equal(state.source_scope.canonical_path, sources);
  const listing = await environment.listDirectory(sources, { maxEntries: 10 });
  assert.equal(listing.entries.length, 2);
  assert.equal(listing.entries[0].addressed_path, source);
  assert.equal((await environment.readText(listing.entries[0].addressed_path, { maxBytes: 128 })).text, "original");
  await assert.rejects(environment.resolvePath(join(sources, "new.md"), { forWrite: true, allowMissing: true }), { code: "source_read_only" });
  await assert.rejects(environment.resolvePath(join(root, "escape.md")), { code: "scope_escape" });
}));

test("source scope survives only the same unexpired conversation; a new default replaces the old output", async () => fixture(async ({ root, output, source }) => {
  const expires = Date.now() + 30_000;
  const first = await resolveTaskFileScopes({ defaultWorkspaceRoot: output, context: capture(source, "file", expires), continuationId: "session" });
  const nextOutput = join(root, "next-output");
  const continued = await resolveTaskFileScopes({ defaultWorkspaceRoot: nextOutput, previousWorkspace: first.state, continuationId: "session" });
  assert.equal(continued.state.canonical_path, nextOutput);
  assert.equal(continued.state.source_scope.canonical_path, source);
  const other = await resolveTaskFileScopes({ defaultWorkspaceRoot: nextOutput, previousWorkspace: first.state, continuationId: "other" });
  assert.equal(other.state.source_scope, undefined);
  await assert.rejects(other.environment.readText(source, { maxBytes: 128 }), { code: "scope_escape" });
  await assert.rejects(resolveTaskFileScopes({ defaultWorkspaceRoot: output, previousWorkspace: first.state, continuationId: "session", now: expires }), { code: "descriptor_expired" });
}));

test("default roots never include private storage, including missing paths and directory links", async () => fixture(async ({ root, output }) => {
  const privateRoot = join(root, "private");
  await mkdir(privateRoot);
  for (const path of [root, privateRoot, join(privateRoot, "nested")]) {
    await assert.rejects(resolveTaskFileScopes({ defaultWorkspaceRoot: path, protectedPaths: [privateRoot] }), { code: "private_workspace" });
  }
  await symlink(privateRoot, output, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(resolveTaskFileScopes({ defaultWorkspaceRoot: output, protectedPaths: [privateRoot] }), { code: "private_workspace" });
}));

test("pending output rejects parent redirection and permission failures without writing elsewhere", async () => fixture(async ({ root, output, sources }) => {
  const first = await resolveTaskFileScopes({ defaultWorkspaceRoot: output });
  const deniedFs = { mkdir: async () => { throw Object.assign(new Error("private OS error"), { code: "EACCES" }); } };
  const denied = await resolveTaskFileScopes({ defaultWorkspaceRoot: output, fileSystem: deniedFs });
  const deniedTool = await bind(denied.environment, "workspace.write");
  const result = await deniedTool.implementation.execute("permissions", { path: "result.md", content: "test" });
  assert.equal(result.details.code, "filesystem_permission_denied");
  assert.equal(await exists(output), false);
  await symlink(sources, output, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(first.environment.resolvePath("result.md", { allowMissing: true }), { code: "stale_workspace" });
  assert.equal(await exists(join(sources, "result.md")), false);
  await unlink(output);
  await writeFile(join(root, "not-directory"), "file");
  await assert.rejects(resolveTaskFileScopes({ defaultWorkspaceRoot: join(root, "not-directory", "child") }));
}));

test("existing output deletion and a newly appeared file fail closed after approval", async () => fixture(async ({ output }) => {
  await mkdir(output);
  const existing = await resolveTaskFileScopes({ defaultWorkspaceRoot: output });
  const deleted = await bind(existing.environment, "workspace.write", { onPermission: () => rm(output, { recursive: true }) });
  const result = await deleted.implementation.execute("deleted", { path: "result.md", content: "test" });
  assert.equal(result.isError, true);
  assert.equal(await exists(output), false);
  const pending = await resolveTaskFileScopes({ defaultWorkspaceRoot: output });
  const race = await bind(pending.environment, "workspace.write", { onPermission: async () => { await mkdir(output); await writeFile(join(output, "result.md"), "other writer"); } });
  const raced = await race.implementation.execute("race", { path: "result.md", content: "test" });
  assert.equal(raced.isError, true);
  assert.equal(await readFile(join(output, "result.md"), "utf8"), "other writer");
}));

test("real Word transform reads a captured external source and verifies a new document in lazy default output", async () => fixture(async ({ root, output, sources }) => {
  const initial = await resolveTaskFileScopes({ defaultWorkspaceRoot: sources });
  const create = await bind(initial.environment, "document.create");
  const generated = await create.implementation.execute("make-source", { path: "source.docx", document: documentSpec });
  assert.equal(generated.details.status, "succeeded", JSON.stringify(generated));
  const source = join(sources, "source.docx");
  const original = await readFile(source);
  const resolution = await resolveTaskFileScopes({ defaultWorkspaceRoot: output, context: capture(source), continuationId: "session" });
  const transform = await bind(resolution.environment, "document.transform", { onPermission: async (event) => {
    assert.equal(event.workspace.canonical_path, output);
    assert.equal(await exists(output), false);
  } });
  const transformed = await transform.implementation.execute("transform", { path: source, output_path: "result.docx", document: documentSpec });
  assert.equal(transformed.details.status, "succeeded", JSON.stringify(transformed));
  assert.equal(transformed.details.output_absolute_path, join(output, "result.docx"));
  assert.equal(transformed.details.source_preserved, true);
  assert.equal(transformed.details.verification.status, "verified");
  assert.deepEqual(await readFile(source), original);
  assert.equal(await exists(join(root, "result.docx")), false);
}));

test("replacing an output directory during approval is refused even at the same canonical path", async () => fixture(async ({ root, output }) => {
  await mkdir(output);
  const resolution = await resolveTaskFileScopes({ defaultWorkspaceRoot: output });
  const tool = await bind(resolution.environment, "workspace.write", { onPermission: async () => {
    await rename(output, join(root, "old-output"));
    await mkdir(output);
  } });
  const result = await tool.implementation.execute("replaced", { path: "result.md", content: "test" });
  assert.equal(result.isError, true);
  assert.equal(await exists(join(output, "result.md")), false);
}));

test("captured source changes during Word approval invalidate the transformation without creating output", async () => fixture(async ({ output, sources }) => {
  const initial = await resolveTaskFileScopes({ defaultWorkspaceRoot: sources });
  const create = await bind(initial.environment, "document.create");
  await create.implementation.execute("make-source", { path: "source.docx", document: documentSpec });
  const source = join(sources, "source.docx");
  const scoped = await resolveTaskFileScopes({ defaultWorkspaceRoot: output, context: capture(source), continuationId: "session" });
  const transform = await bind(scoped.environment, "document.transform", { onPermission: () => writeFile(source, "a changed version") });
  const result = await transform.implementation.execute("stale-source", { path: source, output_path: "result.docx", document: documentSpec });
  assert.equal(result.isError, true);
  assert.equal(await exists(join(output, "result.docx")), false);
}));

test("runtime uses configured default output and captured source, then safely applies a new directory in the same session", async () => fixture(async ({ root, output, source }) => {
  const environment = { LOCALAPPDATA: join(root, "app-data"), ASIDE_SETTINGS_PATH: join(root, "app-data", "Aside", "settings.json"),
    ASIDE_PROVIDER: "deepseek", ASIDE_DEFAULT_WORKSPACE_ROOT: output, ASIDE_SESSION_ROOT: join(root, "history") };
  const events = [];
  let runtime;
  const emit = (event) => {
    events.push(event);
    if (event.type === "permission_requested") runtime.resolvePermission(event.permission_id, "allow");
  };
  runtime = await createAsideConversationRuntime({ environment, configCwd: root, emit });
  function connectFaux(current, content, expectedOutput = content === "first" ? output : join(root, "next-output")) {
    const faux = fauxProvider({ tokensPerSecond: 10_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([(providerContext) => {
      assert.match(providerContext.systemPrompt, /read-only source/);
      assert.ok(providerContext.systemPrompt.includes(JSON.stringify(expectedOutput)));
      return fauxAssistantMessage(fauxToolCall("workspace.write", { path: "result.md", content }, { id: `write-${content}` }));
    }, fauxAssistantMessage("Saved output.")]);
    current.agent.state.model = faux.getModel();
    current.agent.streamFunction = models.streamSimple.bind(models);
  }
  try {
    connectFaux(runtime, "first");
    await runtime.prompt("first-run", "Save a result", capture(source));
    assert.ok(events.some((event) => event.type === "completed"), JSON.stringify(events));
    assert.equal(await readFile(join(output, "result.md"), "utf8"), "first");
    assert.doesNotMatch(runtime.agent.state.systemPrompt, /Task file scopes:/);
    const workspace = events.find((event) => event.type === "run_started").workspace;
    assert.equal(workspace.source_scope.canonical_path, source);
    assert.equal(workspace.output_path, output);
    assert.equal(runtime.continuation.previousWorkspace.source_scope.canonical_path, source);
    const settings = await handleSettingsRequest({ operation: "get" }, { environment, cwd: root });
    const nextOutput = join(root, "next-output");
    await handleSettingsRequest({ operation: "save", expected_revision: settings.revision, document: { schema_version: 1, workspace_root: nextOutput } }, { environment, cwd: root });
    const oldRuntime = runtime;
    const sessionId = oldRuntime.agent.sessionId;
    runtime = await createAsideConversationRuntime({ environment, configCwd: root, previousRuntime: oldRuntime, emit });
    await oldRuntime.dispose();
    assert.equal(runtime.agent.sessionId, sessionId);
    connectFaux(runtime, "second");
    await runtime.prompt("second-run", "Save another result");
    assert.ok(events.some((event) => event.type === "completed" && event.request_id === "second-run"), JSON.stringify(events.filter((event) => event.request_id === "second-run")));
    assert.equal(await readFile(join(nextOutput, "result.md"), "utf8"), "second");
    assert.equal(await readFile(join(output, "result.md"), "utf8"), "first");
    assert.equal(await readFile(source, "utf8"), "original");
    const selected = await runtime.setWorkspace(undefined, output);
    assert.equal(selected.source_scope.canonical_path, source);
    connectFaux(runtime, "selected", output);
    await runtime.prompt("selected-run", "Use the selected output directory");
    assert.equal(await readFile(join(output, "result.md"), "utf8"), "selected");
    await runtime.dispose();
    await rm(environment.ASIDE_SESSION_ROOT, { recursive: true });
    assert.equal(await readFile(join(nextOutput, "result.md"), "utf8"), "second");
    assert.equal(await readFile(join(output, "result.md"), "utf8"), "selected");
  } finally { await runtime?.dispose(); }
}));
