import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  InMemorySessionStorage,
  JsonlSessionRepo,
  Session,
} from "@earendil-works/pi-agent-core/aside";
import {
  createConfiguredAgent,
  createConversationRuntime,
  isUnsuccessfulAssistantMessage,
} from "./runtime.mjs";
import { createNodeSessionFileSystem } from "./session-fs.mjs";
import { loadAsideConfig } from "./config.mjs";

export const ASIDE_SESSION_APPLICATION = "aside";
export const ASIDE_SESSION_SCHEMA_VERSION = 1;
export const ASIDE_SESSION_CWD_NAME = "aside-session";

const asideMetadata = {
  application: ASIDE_SESSION_APPLICATION,
  schemaVersion: ASIDE_SESSION_SCHEMA_VERSION,
};

export class SessionConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionConfigurationError";
  }
}

export class SessionStoreError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "SessionStoreError";
  }
}

export function resolveSessionRoot(environment = process.env) {
  if (Object.prototype.hasOwnProperty.call(environment, "ASIDE_SESSION_ROOT")) {
    const override = String(environment.ASIDE_SESSION_ROOT ?? "").trim();
    if (!override) {
      throw new SessionConfigurationError(
        "ASIDE_SESSION_ROOT must name a local session directory.",
      );
    }
    return resolve(override);
  }

  const localAppData = String(environment.LOCALAPPDATA ?? "").trim();
  if (localAppData) return resolve(join(localAppData, "Aside", "sessions"));

  const fallback =
    process.platform === "win32"
      ? join(homedir(), "AppData", "Local")
      : String(environment.XDG_DATA_HOME ?? "").trim() ||
        join(homedir(), ".local", "share");
  return resolve(join(fallback, "Aside", "sessions"));
}

function metadataFor(id, cwd) {
  return {
    id,
    createdAt: Date.now(),
    cwd,
    modifiedAt: Date.now(),
    sourceFormat: 4,
    metadata: { ...asideMetadata },
    path: `memory://${id}`,
  };
}

function clone(value) {
  return structuredClone(value);
}

function omitUndefined(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.map((child) => {
      const normalized = omitUndefined(child);
      if (normalized === undefined) {
        throw new SessionStoreError("Aside received an incomplete session message.");
      }
      return normalized;
    });
  }
  if (value && typeof value === "object") {
    const normalized = {};
    for (const [key, child] of Object.entries(value)) {
      const childValue = omitUndefined(child);
      if (childValue !== undefined) {
        Object.defineProperty(normalized, key, {
          configurable: true,
          enumerable: true,
          value: childValue,
          writable: true,
        });
      }
    }
    return normalized;
  }
  return value;
}

function durableMessage(message) {
  const normalized = omitUndefined(message);
  if (!normalized || typeof normalized !== "object") {
    throw new SessionStoreError("Aside received an invalid session message.");
  }
  return normalized;
}

/**
 * Uses Pi's in-memory storage and Session object while keeping Aside-owned
 * metadata, so restart tests exercise the same adapter contract as JSONL.
 */
export function createInMemoryAsideSessionRepository() {
  const sessions = new Map();
  let nextId = 1;

  return {
    async create(options = {}) {
      const id = options.id ?? `memory-aside-${nextId++}`;
      if (sessions.has(id)) throw new SessionStoreError("The Aside session already exists.");
      const cwd = options.cwd ?? "aside-memory";
      const metadata = metadataFor(id, cwd);
      const storage = new InMemorySessionStorage(metadata);
      sessions.set(id, { metadata, storage });
      return new Session(storage);
    },

    async open(metadata) {
      const entry = sessions.get(metadata.id);
      if (!entry) throw new SessionStoreError("The Aside session was not found.");
      return new Session(entry.storage);
    },

    async list() {
      return [...sessions.values()].map(({ metadata }) => clone(metadata));
    },

    async delete(metadata) {
      sessions.delete(metadata.id);
    },
  };
}

function isAsideMetadata(metadata) {
  return (
    metadata?.metadata?.application === ASIDE_SESSION_APPLICATION &&
    metadata?.metadata?.schemaVersion === ASIDE_SESSION_SCHEMA_VERSION
  );
}

function sessionSortKey(metadata) {
  return metadata?.modifiedAt ?? metadata?.createdAt ?? 0;
}

function genericStoreFailure() {
  return new SessionStoreError("Aside could not access its local session.");
}

/**
 * Builds the repository and the Aside session directory this product uses.
 *
 * Both the active conversation and the history list must agree on the cwd,
 * because Pi stores sessions under one directory per cwd. Building it in one
 * place is what keeps the list from showing another tool's sessions, or none
 * of Aside's.
 */
export function createAsideSessionStore({
  repository,
  root,
  environment = process.env,
  cwd,
  fileSystem,
} = {}) {
  const sessionRoot =
    root === undefined && repository === undefined
      ? resolveSessionRoot(environment)
      : root === undefined
        ? undefined
        : resolve(root);
  // An explicit cwd wins. Without one, a caller-supplied repository (in-memory
  // or a custom adapter) gets the historical "aside-memory" label, but a real
  // root must resolve to the same directory the active session lives in. The
  // old `repository ?` test also caught *real* repositories passed alongside a
  // root, which silently pointed the history list at the wrong directory.
  const sessionCwd = cwd ?? (repository
    ? (sessionRoot === undefined ? "aside-memory" : join(sessionRoot, ASIDE_SESSION_CWD_NAME))
    : join(sessionRoot, ASIDE_SESSION_CWD_NAME));
  const activeRepository =
    repository ??
    new JsonlSessionRepo({
      fs: fileSystem ?? createNodeSessionFileSystem(),
      sessionsRoot: sessionRoot,
    });
  return { repository: activeRepository, root: sessionRoot, cwd: sessionCwd };
}

/** Session ids become filenames and directory keys, so only the safe shape is accepted. */
const ASIDE_SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
export const ASIDE_SESSION_NAME_MAX_LENGTH = 120;

export class AsideSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AsideSessionError";
    this.code = code;
  }
}

export function validateAsideSessionId(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 200 || !ASIDE_SESSION_ID.test(value)) {
    throw new AsideSessionError("session_invalid_id", "The selected session is not valid.");
  }
  return value;
}

export function normalizeAsideSessionName(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new AsideSessionError("session_invalid_name", "A session name must be text.");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > ASIDE_SESSION_NAME_MAX_LENGTH) {
    throw new AsideSessionError("session_invalid_name", "The session name is too long.");
  }
  return trimmed;
}

/**
 * The Aside sessions in the history directory, newest first.
 *
 * The name lives in an appended `fact: "name"` record rather than the JSONL
 * header, so it can only be read by opening the session. That is a per-history
 * cost, not a per-task one, and the list is bounded by what a person manages by
 * hand; a second index would have to be kept consistent with the files, which
 * is the trade this avoids.
 *
 * A session that cannot be opened is reported rather than silently missing, so
 * a damaged history does not look like a deleted one.
 */
export async function listAsideSessions(store) {
  const warnings = [];
  let metadataList;
  try {
    metadataList = await store.repository.list({ cwd: store.cwd });
  } catch (error) {
    throw genericStoreFailure(error);
  }
  const sessions = [];
  for (const metadata of metadataList.filter(isAsideMetadata)) {
    try {
      const session = await store.repository.open(metadata);
      const opened = await session.getMetadata();
      if (!isAsideMetadata(opened)) continue;
      sessions.push({
        id: opened.id,
        name: await session.getName(),
        created_at: opened.createdAt,
        modified_at: opened.modifiedAt,
      });
    } catch {
      warnings.push({
        id: metadata?.id ?? "unknown",
        message: "A saved session could not be read. It is left in place.",
      });
    }
  }
  sessions.sort((left, right) => right.modified_at - left.modified_at);
  return { sessions, warnings };
}

/** Opens one Aside session by id, rejecting a history that is not ours. */
export async function openAsideSessionById(store, id) {
  validateAsideSessionId(id);
  let metadataList;
  try {
    metadataList = await store.repository.list({ cwd: store.cwd });
  } catch (error) {
    throw genericStoreFailure(error);
  }
  const metadata = metadataList.find((entry) => entry.id === id);
  if (!metadata || !isAsideMetadata(metadata)) {
    throw new AsideSessionError("session_not_found", "The selected session no longer exists.");
  }
  try {
    const session = await store.repository.open(metadata);
    const opened = await session.getMetadata();
    if (!isAsideMetadata(opened)) {
      throw new AsideSessionError("session_not_found", "The selected session no longer exists.");
    }
    return { session, metadata: opened };
  } catch (error) {
    if (error instanceof AsideSessionError) throw error;
    throw new AsideSessionError("session_unreadable", "The selected session could not be read.");
  }
}

/** Resolves an explicit session switch to the session that will be opened. */
async function openSessionTarget(store, target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new AsideSessionError("session_invalid_target", "The session request is invalid.");
  }
  if (target.mode === "new") {
    const created = await createAsideSession(store);
    return { ...created, repository: store.repository, warnings: [], root: store.root, cwd: store.cwd };
  }
  if (target.mode === "open") {
    const opened = await openAsideSessionById(store, target.id);
    return { ...opened, repository: store.repository, warnings: [], root: store.root, cwd: store.cwd };
  }
  throw new AsideSessionError("session_invalid_target", "The session request is invalid.");
}

/** Creates an empty Aside session and returns it with its fresh metadata. */
export async function createAsideSession(store) {
  try {
    const session = await store.repository.create({
      id: `aside-${randomUUID()}`,
      cwd: store.cwd,
      metadata: { ...asideMetadata },
    });
    return { session, metadata: await session.getMetadata() };
  } catch (error) {
    throw new AsideSessionError("session_create_failed", "Aside could not create a new session.");
  }
}

/**
 * Deletes one Aside session file.
 *
 * Only a path that came back from the repository's own listing is removed, so a
 * caller cannot point this at an arbitrary file. Sources and outputs are never
 * touched: deleting a conversation does not delete the user's documents.
 */
export async function deleteAsideSession(store, id) {
  let metadataList;
  try {
    metadataList = await store.repository.list({ cwd: store.cwd });
  } catch (error) {
    throw genericStoreFailure(error);
  }
  const metadata = metadataList.find((entry) => entry.id === id);
  if (!metadata || !isAsideMetadata(metadata)) {
    throw new AsideSessionError("session_not_found", "The selected session no longer exists.");
  }
  try {
    await store.repository.delete(metadata);
  } catch {
    throw new AsideSessionError("session_delete_failed", "Aside could not delete the selected session.");
  }
  return { id };
}

/** Renames one Aside session. An empty name clears it. */
export async function renameAsideSession(store, id, name) {
  const normalized = normalizeAsideSessionName(name);
  const opened = await openAsideSessionById(store, id);
  try {
    await opened.session.setName(normalized);
    return { id, name: normalized ?? null };
  } catch {
    throw new AsideSessionError("session_rename_failed", "Aside could not rename the selected session.");
  }
}

export async function openAsideSession({
  repository,
  root,
  environment = process.env,
  cwd,
  fileSystem,
} = {}) {
  const store = createAsideSessionStore({ repository, root, environment, cwd, fileSystem });
  const sessionRoot = store.root;
  const sessionCwd = store.cwd;
  const activeRepository = store.repository;
  const warnings = [];

  let metadataList;
  try {
    metadataList = await activeRepository.list({ cwd: sessionCwd });
  } catch (error) {
    throw genericStoreFailure(error);
  }

  const candidates = metadataList
    .filter(isAsideMetadata)
    .sort((left, right) => sessionSortKey(right) - sessionSortKey(left));
  for (const metadata of candidates) {
    try {
      const session = await activeRepository.open(metadata);
      const openedMetadata = await session.getMetadata();
      if (!isAsideMetadata(openedMetadata)) throw genericStoreFailure();
      return {
        repository: activeRepository,
        session,
        metadata: openedMetadata,
        root: sessionRoot,
        cwd: sessionCwd,
        warnings,
      };
    } catch {
      warnings.push(
        "A saved Aside session could not be restored; a new local session was created.",
      );
    }
  }

  try {
    const session = await activeRepository.create({
      id: `aside-${randomUUID()}`,
      cwd: sessionCwd,
      metadata: { ...asideMetadata },
    });
    const metadata = await session.getMetadata();
    return {
      repository: activeRepository,
      session,
      metadata,
      root: sessionRoot,
      cwd: sessionCwd,
      warnings,
    };
  } catch (error) {
    throw genericStoreFailure(error);
  }
}

function isDurableMessage(message) {
  if (message?.role === "user" || message?.role === "toolResult") return true;
  return message?.role === "assistant" && !isUnsuccessfulAssistantMessage(message);
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("");
}

function displayRole(message) {
  return message?.role === "user" ? "user" : "assistant";
}

export async function restoreAsideSession(session) {
  let entries;
  try {
    entries = await session.findEntriesOnBranch({ order: "oldestFirst" });
  } catch (error) {
    throw genericStoreFailure(error);
  }

  const messages = [];
  const history = [];
  for (const entry of entries) {
    if (entry.type !== "message" || !isDurableMessage(entry.message)) continue;
    const message = clone(entry.message);
    messages.push(message);
    if (message.role === "user" || message.role === "assistant") {
      const text = messageText(message);
      // Assistant tool-call frames carry no user-visible text and would only
      // render as empty bubbles in the restored UI history. The full message
      // still restores the agent transcript; only the projection skips it.
      if (message.role === "assistant" && text.trim().length === 0) continue;
      history.push({
        id: entry.id,
        role: displayRole(message),
        text,
        status: "complete",
        timestamp: entry.timestamp,
      });
    }
  }
  return { messages, history };
}

function persistenceWarning() {
  return "The response is available, but Aside could not save it locally.";
}

function isPrefix(prefix, full) {
  return prefix.every(
    (message, index) => JSON.stringify(message) === JSON.stringify(full[index]),
  );
}

export function createSessionPersistence(session, restoredMessages = []) {
  let persistedMessages = restoredMessages
    .filter(isDurableMessage)
    .map(durableMessage);
  let writeTail = Promise.resolve();

  async function appendSnapshot(messages) {
    const snapshot = messages.filter(isDurableMessage).map(durableMessage);
    if (!isPrefix(persistedMessages, snapshot)) {
      throw new SessionStoreError("Aside session state changed unexpectedly.");
    }
    for (const message of snapshot.slice(persistedMessages.length)) {
      await session.appendMessage(message);
      persistedMessages.push(message);
    }
  }

  return async function persistRun({ messages }) {
    const operation = writeTail.then(() => appendSnapshot(messages));
    writeTail = operation.catch(() => undefined);
    try {
      await operation;
      return undefined;
    } catch {
      return { warning: persistenceWarning() };
    }
  };
}

export async function createAsideConversationRuntime({
  emit,
  agent,
  repository,
  root,
  environment,
  cwd,
  fileSystem,
  configCwd,
  skills,
  skillDiagnostics,
  credentialValues,
  previousRuntime,
  sessionTarget,
} = {}) {
  const send = emit ?? (() => undefined);
  const configuration = agent ? undefined : await loadAsideConfig({ environment, cwd: configCwd, credentialValues });
  // A session target is an explicit switch, so it never takes the
  // `previousRuntime` path: that path is a same-session rebuild for settings and
  // carries the old persistence cursor, continuation and permission state with
  // it. Reusing it here would let one conversation's state reach another's.
  const store = sessionTarget
    ? createAsideSessionStore({ repository, root, environment: configuration?.values ?? environment, cwd, fileSystem })
    : undefined;
  const opened = previousRuntime && !sessionTarget ? {
    session: previousRuntime.session,
    repository: previousRuntime.sessionRepository,
    metadata: { id: previousRuntime.agent.sessionId },
    warnings: [],
    // A same-session rebuild keeps pointing at the store the runtime already
    // resolved, so the history list and the open conversation agree.
    root: previousRuntime.sessionStore?.root,
    cwd: previousRuntime.sessionStore?.cwd,
  } : sessionTarget
    ? await openSessionTarget(store, sessionTarget)
    : await openAsideSession({
        repository,
        root,
        environment: configuration?.values ?? environment,
        cwd,
        fileSystem,
      });
  const restored = previousRuntime && !sessionTarget
    ? { messages: previousRuntime.agent.state.messages.slice(), history: [] }
    : await restoreAsideSession(opened.session);
  for (const warning of opened.warnings) send({ type: "session_warning", message: warning });

  let conversationAgent = agent;
  let configuredSkills = skills ?? [];
  let configuredSkillDiagnostics = skillDiagnostics ?? [];
  let configuredMcp;
  let configuredBuildSystemPromptFor;
  let configurationRevision;
  let settingsRevision;
  let thinking;
  let resolveThinking;
  let sensitiveValues;
  if (conversationAgent) {
    conversationAgent.state.messages = restored.messages;
    conversationAgent.sessionId = opened.metadata.id;
  } else {
    const configured = await createConfiguredAgent({
      initialMessages: restored.messages,
      sessionId: opened.metadata.id,
      configuration,
      environment,
      configCwd,
      skills: configuredSkills.length > 0 ? configuredSkills : undefined,
    });
    conversationAgent = configured.agent;
    configurationRevision = configured.configurationRevision;
    settingsRevision = configured.settingsRevision;
    thinking = configured.thinking;
    resolveThinking = configured.resolveThinking;
    sensitiveValues = configured.sensitiveValues;
    configuredSkills = configured.skills ?? [];
    configuredSkillDiagnostics = configured.skillDiagnostics ?? [];
    configuredMcp = configured.mcp;
    configuredBuildSystemPromptFor = configured.buildSystemPromptFor;
    // Configuration facts only, and only when there is something to report. A
    // session with no MCP configured emits nothing, so the surface has no empty
    // MCP section to explain away. Whether a listed server actually started is
    // a per-run fact the surface reads from the run's tool list.
    const configuredServers = configured.mcpServers ?? [];
    if (configuredServers.length > 0) {
      send({
        type: "mcp_servers",
        servers: configuredServers.map((server) => ({
          id: server.id,
          display_name: server.display_name,
          enabled: server.enabled,
          trust_acknowledged: server.trust_acknowledged,
        })),
      });
    }
    for (const diagnostic of configured.mcpDiagnostics ?? []) {
      send({ type: "runtime_warning", ...diagnostic });
    }
  }

  const persistRun = previousRuntime?.persistRun ?? createSessionPersistence(opened.session, restored.messages);
  const runtime = await createConversationRuntime({
    emit: send,
    agent: conversationAgent,
    onRunSettled: persistRun,
    environment,
    configCwd,
    configurationRevision,
    settingsRevision,
    thinking,
    resolveThinking,
    skills: configuredSkills,
    skillDiagnostics: configuredSkillDiagnostics,
    mcp: configuredMcp,
    buildSystemPromptFor: configuredBuildSystemPromptFor,
    // Continuation is per conversation: a captured source, selected workspace
    // or active skill belongs to the session that produced it. Carrying it
    // across a switch would hand the new conversation state it never captured.
    continuation: previousRuntime && !sessionTarget ? previousRuntime.continuation : undefined,
    sensitiveValues,
    defaultWorkspaceRoot: configuration?.publicValues.workspace_root,
    protectedWorkspacePaths: configuration ? [...configuration.protectedWorkspacePaths, root ?? resolveSessionRoot(configuration.values)] : [],
  });
  return Object.assign(runtime, {
    history: restored.history,
    session: opened.session,
    sessionRepository: opened.repository,
    // Built from what the session was actually opened with, not from the raw
    // arguments: a caller that passed only `environment` leaves `root`/`cwd`
    // undefined here, and falling back to the in-memory conventions would point
    // the history list at a directory the conversation is not in.
    sessionStore: store ?? createAsideSessionStore({
      repository: opened.repository,
      root: opened.root,
      environment: configuration?.values ?? environment,
      cwd: opened.cwd,
      fileSystem,
    }),
    persistRun,
  });
}
