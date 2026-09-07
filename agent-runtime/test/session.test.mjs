import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core/aside";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  createAsideConversationRuntime,
  createInMemoryAsideSessionRepository,
  createSessionPersistence,
  resolveSessionRoot,
} from "../src/session.mjs";
import { loadSkills } from "../src/skill-loader.mjs";

function makeAgent(faux) {
  const models = createModels();
  models.setProvider(faux.provider);
  return new Agent({
    initialState: {
      systemPrompt: "Answer briefly.",
      model: faux.getModel(),
      thinkingLevel: "off",
      tools: [],
    },
    streamFn: models.streamSimple.bind(models),
    convertToLlm: (messages) => messages,
  });
}

function messageText(message) {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function makeFauxAgent(responses) {
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  faux.setResponses(responses);
  return { faux, agent: makeAgent(faux) };
}

test("persists finalized messages and restores the active Aside session", async () => {
  const repository = createInMemoryAsideSessionRepository();
  const first = makeFauxAgent([fauxAssistantMessage("first answer")]);
  const firstRuntime = await createAsideConversationRuntime({
    repository,
    agent: first.agent,
    emit: () => undefined,
  });

  await firstRuntime.prompt("session-1", "first question", {
    flow: { id: "flow-session", kind: "conversation" },
    blocks: [{ type: "text", text: "temporary draft context" }],
  });
  const firstEntries = await firstRuntime.session.findEntries({
    type: "message",
    order: "oldestFirst",
  });
  assert.deepEqual(
    firstEntries.map((entry) => entry.message.role),
    ["user", "assistant"],
  );
  assert.equal(
    firstEntries.some((entry) =>
      JSON.stringify(entry).includes("temporary draft context"),
    ),
    false,
  );

  const second = makeFauxAgent([fauxAssistantMessage("second answer")]);
  const secondRuntime = await createAsideConversationRuntime({
    repository,
    agent: second.agent,
    emit: () => undefined,
  });
  assert.deepEqual(
    secondRuntime.history.map((message) => [message.role, message.text]),
    [
      ["user", "first question"],
      ["assistant", "first answer"],
    ],
  );
  assert.deepEqual(
    second.agent.state.messages.map((message) => messageText(message)),
    ["first question", "first answer"],
  );

  await secondRuntime.prompt("session-2", "second question");
  const restoredEntries = await secondRuntime.session.findEntries({
    type: "message",
    order: "oldestFirst",
  });
  assert.deepEqual(
    restoredEntries.map((entry) => messageText(entry.message)),
    ["first question", "first answer", "second question", "second answer"],
  );
});

test("omits failed assistant messages while retaining the finalized user prompt", async () => {
  const repository = createInMemoryAsideSessionRepository();
  const { faux, agent } = makeFauxAgent([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "provider unavailable",
    }),
  ]);
  const events = [];
  const runtime = await createAsideConversationRuntime({
    repository,
    agent,
    emit: (event) => events.push(event),
  });

  await runtime.prompt("session-failed", "retry me");
  const entries = await runtime.session.findEntries({
    type: "message",
    order: "oldestFirst",
  });
  assert.deepEqual(entries.map((entry) => entry.message.role), ["user"]);
  assert.equal(faux.state.callCount, 1);
  assert.ok(
    events.some(
      (event) =>
        event.type === "failed" && event.request_id === "session-failed",
    ),
  );
});

test("serializes duplicate session snapshots without duplicate entries", async () => {
  const repository = createInMemoryAsideSessionRepository();
  const session = await repository.create({ cwd: "aside-memory" });
  const persist = createSessionPersistence(session);
  const messages = [
    {
      role: "user",
      content: [{ type: "text", text: "same prompt" }],
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "same answer" }],
      api: "faux",
      provider: "faux",
      model: "faux-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    },
  ];

  await Promise.all([
    persist({ messages }),
    persist({ messages }),
  ]);
  const entries = await session.findEntries({ type: "message", order: "oldestFirst" });
  assert.equal(entries.length, 2);
});

test("emits a recoverable warning when persistence fails", async () => {
  const baseRepository = createInMemoryAsideSessionRepository();
  let rawSession;
  const failingRepository = {
    async create(options) {
      rawSession = await baseRepository.create(options);
      return {
        getMetadata: () => rawSession.getMetadata(),
        findEntriesOnBranch: (query) => rawSession.findEntriesOnBranch(query),
        appendMessage: async () => {
          throw new Error("write failed at a private path");
        },
      };
    },
    async open(metadata) {
      return this.create({ cwd: metadata.cwd });
    },
    list: (...args) => baseRepository.list(...args),
  };
  const { agent } = makeFauxAgent([fauxAssistantMessage("still visible")]);
  const events = [];
  const runtime = await createAsideConversationRuntime({
    repository: failingRepository,
    agent,
    emit: (event) => events.push(event),
  });

  await runtime.prompt("session-warning", "save this");
  assert.ok(
    events.some(
      (event) =>
        event.type === "text_delta" && event.request_id === "session-warning",
    ),
  );
  const warning = events.find(
    (event) =>
      event.type === "session_warning" &&
      event.request_id === "session-warning",
  );
  assert.ok(warning);
  assert.equal(
    warning.message,
    "The response is available, but Aside could not save it locally.",
  );
  assert.equal((await rawSession.findEntries({ type: "message" })).length, 0);
});

test("resolves the documented session root and rejects a blank override", () => {
  assert.equal(
    resolveSessionRoot({ LOCALAPPDATA: "C:\\Users\\aside-test\\AppData\\Local" }),
    resolve("C:\\Users\\aside-test\\AppData\\Local", "Aside", "sessions"),
  );
  assert.equal(
    resolveSessionRoot({ ASIDE_SESSION_ROOT: "C:\\temp\\aside-sessions" }),
    resolve("C:\\temp\\aside-sessions"),
  );
  assert.throws(
    () => resolveSessionRoot({ ASIDE_SESSION_ROOT: "   " }),
    /ASIDE_SESSION_ROOT must name a local session directory/,
  );
});

test("writes an Aside-owned JSONL header and can reopen it", async () => {
  const root = await mkdtemp(join(tmpdir(), "aside-session-"));
  try {
    const first = makeFauxAgent([fauxAssistantMessage("jsonl answer")]);
    const firstRuntime = await createAsideConversationRuntime({
      root,
      agent: first.agent,
      emit: () => undefined,
    });
    await firstRuntime.prompt("jsonl-1", "jsonl question");

    const directories = await readdir(root, { withFileTypes: true });
    const sessionDirectory = directories.find((entry) => entry.isDirectory());
    assert.ok(sessionDirectory);
    const files = await readdir(join(root, sessionDirectory.name));
    const sessionFile = files.find((file) => file.endsWith(".jsonl"));
    assert.ok(sessionFile);
    const content = await readFile(
      join(root, sessionDirectory.name, sessionFile),
      "utf8",
    );
    assert.match(content.split(/\r?\n/, 1)[0], /"application":"aside"/);
    assert.match(content, /jsonl question/);
    assert.match(content, /jsonl answer/);

    const second = makeFauxAgent([fauxAssistantMessage("after reopen")]);
    const secondRuntime = await createAsideConversationRuntime({
      root,
      agent: second.agent,
      emit: () => undefined,
    });
    assert.deepEqual(
      secondRuntime.history.map((message) => message.text),
      ["jsonl question", "jsonl answer"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creates a fresh session when the active JSONL session is corrupt", async () => {
  const root = await mkdtemp(join(tmpdir(), "aside-corrupt-session-"));
  try {
    const first = makeFauxAgent([fauxAssistantMessage("old answer")]);
    const firstRuntime = await createAsideConversationRuntime({
      root,
      agent: first.agent,
      emit: () => undefined,
    });
    await firstRuntime.prompt("corrupt-1", "old question");

    const directories = await readdir(root, { withFileTypes: true });
    const sessionDirectory = directories.find((entry) => entry.isDirectory());
    assert.ok(sessionDirectory);
    const files = await readdir(join(root, sessionDirectory.name));
    const sessionFile = files.find((file) => file.endsWith(".jsonl"));
    assert.ok(sessionFile);
    const sessionPath = join(root, sessionDirectory.name, sessionFile);
    const content = await readFile(sessionPath, "utf8");
    await writeFile(`${sessionPath}`, `${content}{"kind":"broken"}\n`);

    const events = [];
    const second = makeFauxAgent([fauxAssistantMessage("new answer")]);
    const secondRuntime = await createAsideConversationRuntime({
      root,
      agent: second.agent,
      emit: (event) => events.push(event),
    });
    assert.deepEqual(secondRuntime.history, []);
    assert.ok(
      events.some(
        (event) =>
          event.type === "session_warning" && event.request_id === undefined,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists only bounded messages and restores no workspace, permission, or skill state", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "aside-session-workspace-"));
  await writeFile(join(workspaceRoot, "notes.md"), "alpha\n", "utf8");
  const repository = createInMemoryAsideSessionRepository();
  const skills = (await loadSkills()).skills;
  const faux = fauxProvider({ tokensPerSecond: 1_000 });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("workspace.write", { path: "notes.md", content: "alpha\nbeta\n" }, { id: "session-privacy-write" }),
    ),
    fauxAssistantMessage("saved with an approved decision"),
  ]);
  const agent = makeAgent(faux);
  const events = [];
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
  runtime = await createAsideConversationRuntime({
    repository,
    agent,
    skills,
    emit,
  });
  runtime.setActiveSkill("revise-document");
  await runtime.prompt(
    "session-privacy-1",
    "revise notes",
    {
      flow: { id: "flow-skill", kind: "conversation" },
      blocks: [],
      attachments: [
        {
          id: "capture-dir",
          host: "explorer",
          strategy: "explorer",
          source: "Explorer folder",
          capturedAt: 1,
          expiresAt: Date.now() + 60_000,
          sensitivity: "local_metadata",
          summary: "workspace root",
          blocks: [{ type: "text", label: "Path", text: workspaceRoot }],
          descriptors: [{ role: "workspace_root", path: workspaceRoot, kind: "directory" }],
        },
      ],
    },
    workspaceRoot,
  );

  const entries = await runtime.session.findEntries({ type: "message", order: "oldestFirst" });
  const serialized = JSON.stringify(entries);
  assert.doesNotMatch(serialized, /permission_id/);
  assert.doesNotMatch(serialized, /aside_context/);
  assert.doesNotMatch(serialized, /workspace_root/);
  assert.doesNotMatch(serialized, /Preserve heading/);
  assert.ok(
    entries.some((entry) => entry.message.role === "user" && /revise notes/.test(entry.message.content?.[0]?.text ?? "")),
  );

  const second = makeFauxAgent([fauxAssistantMessage("restored answer")]);
  const restoredRuntime = await createAsideConversationRuntime({
    repository,
    agent: second.agent,
    skills,
    emit: () => undefined,
  });
  assert.deepEqual(
    restoredRuntime.history.map((message) => [message.role, message.text]),
    [
      ["user", "revise notes"],
      ["assistant", "saved with an approved decision"],
    ],
  );
  assert.equal(restoredRuntime.activeSkill, undefined);
  assert.deepEqual(restoredRuntime.pendingPermissions, []);
  await rm(workspaceRoot, { recursive: true, force: true });
});
