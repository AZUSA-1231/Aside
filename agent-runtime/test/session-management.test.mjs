import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core/aside";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  AsideSessionError,
  ASIDE_SESSION_NAME_MAX_LENGTH,
  createAsideConversationRuntime,
  createAsideSessionStore,
  deleteAsideSession,
  listAsideSessions,
  normalizeAsideSessionName,
  openAsideSessionById,
  renameAsideSession,
  validateAsideSessionId,
} from "../src/session.mjs";

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "aside-sessions-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return { root, environment: { LOCALAPPDATA: join(root, "data") } };
}

function fauxAgent(responses) {
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  return new Agent({
    initialState: { systemPrompt: "Answer briefly.", model: faux.getModel(), thinkingLevel: "off", tools: [] },
    streamFn: models.streamSimple.bind(models),
    convertToLlm: (messages) => messages,
  });
}

function texts(messages) {
  return messages.map((message) => typeof message.content === "string"
    ? message.content
    : message.content.filter((block) => block.type === "text").map((block) => block.text).join(""));
}

test("the history list contains only Aside sessions in Aside's own directory", async (context) => {
  const { root, environment } = await fixture(context);
  const store = createAsideSessionStore({ root: join(root, "sessions"), environment, cwd: join(root, "aside-session") });
  const first = await store.repository.create({ id: "aside-one", cwd: store.cwd, metadata: { application: "aside", schemaVersion: 1 } });
  // A session from another application in the same root must not be listed as
  // history: opening it would show a conversation this product never wrote.
  await store.repository.create({ id: "other-tool", cwd: store.cwd, metadata: { application: "other", schemaVersion: 1 } });
  await (await first.getMetadata());
  const listed = await listAsideSessions(store);
  assert.deepEqual(listed.sessions.map((session) => session.id), ["aside-one"]);
  assert.deepEqual(listed.warnings, []);
});

test("a renamed session keeps its name across a reopen and appears in the list", async (context) => {
  const { root, environment } = await fixture(context);
  const store = createAsideSessionStore({ root: join(root, "sessions"), environment, cwd: join(root, "aside-session") });
  const created = await createAsideSessionForTest(store);
  await renameAsideSession(store, created.id, "  Planning notes  ");
  const reopened = await openAsideSessionById(store, created.id);
  assert.equal(await reopened.session.getName(), "Planning notes");
  const listed = await listAsideSessions(store);
  assert.equal(listed.sessions.find((session) => session.id === created.id).name, "Planning notes");
});

test("an empty name clears a session name", async (context) => {
  const { root, environment } = await fixture(context);
  const store = createAsideSessionStore({ root: join(root, "sessions"), environment, cwd: join(root, "aside-session") });
  const created = await createAsideSessionForTest(store);
  await renameAsideSession(store, created.id, "Temporary");
  await renameAsideSession(store, created.id, "   ");
  const opened = await openAsideSessionById(store, created.id);
  assert.equal(await opened.session.getName(), undefined);
});

test("session ids and names are validated before they reach a path or a file", () => {
  for (const value of ["", "../escape", "a/b", "a\\b", ".hidden", "trailing.", 42, null]) {
    assert.throws(() => validateAsideSessionId(value), (error) => error.code === "session_invalid_id", String(value));
  }
  assert.equal(validateAsideSessionId("aside-3f2a"), "aside-3f2a");
  assert.equal(normalizeAsideSessionName("  name "), "name");
  assert.equal(normalizeAsideSessionName("   "), undefined);
  assert.equal(normalizeAsideSessionName(null), undefined);
  assert.throws(
    () => normalizeAsideSessionName("x".repeat(ASIDE_SESSION_NAME_MAX_LENGTH + 1)),
    (error) => error.code === "session_invalid_name",
  );
});

test("opening and deleting an unknown session leave existing history intact", async (context) => {
  const { root, environment } = await fixture(context);
  const store = createAsideSessionStore({ root: join(root, "sessions"), environment, cwd: join(root, "aside-session") });
  const created = await createAsideSessionForTest(store);
  await assert.rejects(openAsideSessionById(store, "aside-missing"), (error) => error.code === "session_not_found");
  await assert.rejects(deleteAsideSession(store, "aside-missing"), (error) => error.code === "session_not_found");
  assert.deepEqual((await listAsideSessions(store)).sessions.map((session) => session.id), [created.id]);
});

test("deleting a session removes only that file and keeps the others", async (context) => {
  const { root, environment } = await fixture(context);
  const sessionsRoot = join(root, "sessions");
  const store = createAsideSessionStore({ root: sessionsRoot, environment, cwd: join(root, "aside-session") });
  const first = await createAsideSessionForTest(store);
  const second = await createAsideSessionForTest(store);
  await deleteAsideSession(store, first.id);
  const remaining = await listAsideSessions(store);
  assert.deepEqual(remaining.sessions.map((session) => session.id), [second.id]);
  // Pi encodes the cwd into a directory name under the sessions root; count the
  // files there rather than assume the layout.
  const directories = await readdir(sessionsRoot);
  const files = await readdir(join(sessionsRoot, directories[0]));
  assert.equal(files.filter((name) => name.endsWith(".jsonl")).length, 1);
});

test("switching conversations does not carry messages or continuation across", async (context) => {
  const { root, environment } = await fixture(context);
  const sessionsRoot = join(root, "sessions");
  const store = createAsideSessionStore({ root: sessionsRoot, environment, cwd: join(root, "aside-session") });

  const firstAgent = fauxAgent([fauxAssistantMessage("first answer")]);
  const first = await createAsideConversationRuntime({ repository: store.repository, root: sessionsRoot, environment, agent: firstAgent, cwd: store.cwd });
  context.after(() => first.dispose());
  await first.prompt("first", "first question");
  const firstId = first.agent.sessionId;

  const secondAgent = fauxAgent([fauxAssistantMessage("second answer")]);
  const second = await createAsideConversationRuntime({
    repository: store.repository,
    root: sessionsRoot,
    environment,
    agent: secondAgent,
    cwd: store.cwd,
    sessionTarget: { mode: "new" },
  });
  context.after(() => second.dispose());

  // A new conversation starts empty and is a different session file.
  assert.equal(second.history.length, 0);
  assert.equal(second.agent.state.messages.length, 0);
  assert.notEqual(second.agent.sessionId, firstId);
  // It must not inherit the first conversation's live getters.
  assert.equal(second.continuation.selectedWorkspace, undefined);

  await second.prompt("second", "second question");
  const listed = await listAsideSessions(store);
  assert.equal(listed.sessions.length, 2);

  // Reopening the first conversation by id restores only its own history.
  const reopened = await createAsideConversationRuntime({
    repository: store.repository,
    root: sessionsRoot,
    environment,
    agent: fauxAgent([]),
    cwd: store.cwd,
    sessionTarget: { mode: "open", id: firstId },
  });
  context.after(() => reopened.dispose());
  assert.deepEqual(texts(reopened.agent.state.messages), ["first question", "first answer"]);
});

test("switching to a session that cannot be read fails without disturbing the current one", async (context) => {
  const { root, environment } = await fixture(context);
  const sessionsRoot = join(root, "sessions");
  const store = createAsideSessionStore({ root: sessionsRoot, environment, cwd: join(root, "aside-session") });
  const agent = fauxAgent([fauxAssistantMessage("kept")]);
  const runtime = await createAsideConversationRuntime({ repository: store.repository, root: sessionsRoot, environment, agent, cwd: store.cwd });
  context.after(() => runtime.dispose());
  await runtime.prompt("kept", "keep this");
  const before = runtime.agent.state.messages.length;

  await assert.rejects(
    createAsideConversationRuntime({
      repository: store.repository,
      root: sessionsRoot,
      environment,
      agent: fauxAgent([]),
      cwd: store.cwd,
      sessionTarget: { mode: "open", id: "aside-does-not-exist" },
    }),
    (error) => error instanceof AsideSessionError && error.code === "session_not_found",
  );
  assert.equal(runtime.agent.state.messages.length, before);
});

test("a session created by another application cannot be opened as history", async (context) => {
  const { root, environment } = await fixture(context);
  const store = createAsideSessionStore({ root: join(root, "sessions"), environment, cwd: join(root, "aside-session") });
  await store.repository.create({ id: "foreign-session", cwd: store.cwd, metadata: { application: "other", schemaVersion: 1 } });
  await assert.rejects(
    openAsideSessionById(store, "foreign-session"),
    (error) => error.code === "session_not_found",
  );
});

async function createAsideSessionForTest(store) {
  const { createAsideSession } = await import("../src/session.mjs");
  const created = await createAsideSession(store);
  return created.metadata;
}

test("two named conversations survive a restart and can be reopened by id", async (context) => {
  const { root, environment } = await fixture(context);
  const sessionsRoot = join(root, "sessions");

  // First process: create two conversations with distinct names.
  const firstStore = createAsideSessionStore({ root: sessionsRoot, environment, cwd: join(sessionsRoot, "aside-session") });
  const a = await createAsideSessionForTest(firstStore);
  const b = await createAsideSessionForTest(firstStore);
  await renameAsideSession(firstStore, a.id, "Alpha");
  await renameAsideSession(firstStore, b.id, "Beta");

  // Second process: a fresh store object over the same directory.
  const secondStore = createAsideSessionStore({ root: sessionsRoot, environment, cwd: join(sessionsRoot, "aside-session") });
  const listed = await listAsideSessions(secondStore);
  const names = Object.fromEntries(listed.sessions.map((session) => [session.id, session.name]));
  assert.equal(names[a.id], "Alpha");
  assert.equal(names[b.id], "Beta");

  const opened = await createAsideConversationRuntime({
    repository: secondStore.repository,
    root: sessionsRoot,
    environment,
    agent: fauxAgent([]),
    cwd: secondStore.cwd,
    sessionTarget: { mode: "open", id: b.id },
  });
  context.after(() => opened.dispose());
  assert.equal(opened.agent.sessionId, b.id);
});

test("the history list sees the active session however the runtime was constructed", async (context) => {
  const { root, environment } = await fixture(context);
  // Real entry points pass only `environment` (or a root) rather than the
  // store's own cwd. The list must still resolve to the same directory, or a
  // freshly created conversation reads as "no longer exists" until restart.
  for (const options of [
    { environment },
    { root: join(root, "sessions"), environment },
  ]) {
    const runtime = await createAsideConversationRuntime({ ...options, emit: () => undefined });
    context.after(() => runtime.dispose());
    const listed = await listAsideSessions(runtime.sessionStore);
    assert.ok(
      listed.sessions.some((session) => session.id === runtime.agent.sessionId),
      `active session missing from list for ${JSON.stringify(Object.keys(options))}`,
    );
  }
});

test("a session created through a switch is immediately listed as the active one", async (context) => {
  const { root, environment } = await fixture(context);
  const sessionsRoot = join(root, "sessions");
  const first = await createAsideConversationRuntime({ root: sessionsRoot, environment, emit: () => undefined });
  context.after(() => first.dispose());
  const created = await createAsideConversationRuntime({
    root: sessionsRoot,
    environment,
    emit: () => undefined,
    sessionTarget: { mode: "new" },
  });
  context.after(() => created.dispose());
  const listed = await listAsideSessions(created.sessionStore);
  // Both conversations are history; the new one is what is open now.
  assert.ok(listed.sessions.some((session) => session.id === created.agent.sessionId));
  assert.ok(listed.sessions.some((session) => session.id === first.agent.sessionId));
  // The new session's store must point at the same directory the first one used.
  assert.equal(created.sessionStore.cwd, first.sessionStore.cwd);
});
