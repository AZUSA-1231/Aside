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

export async function openAsideSession({
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
  const sessionCwd = cwd ?? (repository ? "aside-memory" : join(sessionRoot, ASIDE_SESSION_CWD_NAME));
  const activeRepository =
    repository ??
    new JsonlSessionRepo({
      fs: fileSystem ?? createNodeSessionFileSystem(),
      sessionsRoot: sessionRoot,
    });
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
} = {}) {
  const send = emit ?? (() => undefined);
  const opened = await openAsideSession({
    repository,
    root,
    environment,
    cwd,
    fileSystem,
  });
  const restored = await restoreAsideSession(opened.session);
  for (const warning of opened.warnings) send({ type: "session_warning", message: warning });

  let conversationAgent = agent;
  let configuredSkills = skills ?? [];
  let configuredSkillDiagnostics = skillDiagnostics ?? [];
  let configuredMcp;
  let configuredBuildSystemPromptFor;
  if (conversationAgent) {
    conversationAgent.state.messages = restored.messages;
    conversationAgent.sessionId = opened.metadata.id;
  } else {
    const configured = await createConfiguredAgent({
      initialMessages: restored.messages,
      sessionId: opened.metadata.id,
      skills: configuredSkills.length > 0 ? configuredSkills : undefined,
    });
    conversationAgent = configured.agent;
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

  const persistRun = createSessionPersistence(opened.session, restored.messages);
  const runtime = await createConversationRuntime({
    emit: send,
    agent: conversationAgent,
    onRunSettled: persistRun,
    environment,
    configCwd,
    skills: configuredSkills,
    skillDiagnostics: configuredSkillDiagnostics,
    mcp: configuredMcp,
    buildSystemPromptFor: configuredBuildSystemPromptFor,
  });
  return {
    ...runtime,
    history: restored.history,
    session: opened.session,
    sessionRepository: opened.repository,
  };
}
