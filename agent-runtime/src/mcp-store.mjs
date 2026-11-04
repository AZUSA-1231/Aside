import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { MCP_CONFIG_LIMITS, McpConfigError, validateServerConfig } from "./mcp-config.mjs";

/**
 * Read/write access to the user's `mcp.json`.
 *
 * Until P5 this file was read-only: the runtime loaded it, the user hand-wrote
 * it. A GUI needs the other direction, and the other direction is where
 * configuration files go wrong — a partial write, a save racing an external
 * edit, a derived field leaking back into the file. This module exists so those
 * three properties hold in one place rather than in the panel.
 *
 * The shape on disk stays `{ "servers": [...] }`. Writes are atomic (temporary
 * file + rename), guarded by a lock, and rejected when the file changed since
 * the caller read it.
 */

export const MISSING_MCP_REVISION = "missing";
export const MCP_CONFIG_MAX_BYTES = 128 * 1024;

export class McpStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "McpStoreError";
    this.code = code;
  }
}

function revisionOf(text) {
  return createHash("sha256").update(text).digest("hex");
}

function refuse(code, message) {
  throw new McpStoreError(code, message);
}

async function readBoundedText(path) {
  const handle = await open(path, "r");
  try {
    const entry = await handle.stat();
    if (!entry.isFile()) refuse("mcp_config_unsafe_file", "The MCP configuration must be a regular file.");
    if (entry.size > MCP_CONFIG_MAX_BYTES) refuse("mcp_config_too_large", "The MCP configuration exceeds the supported size.");
    const buffer = Buffer.alloc(MCP_CONFIG_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MCP_CONFIG_MAX_BYTES) refuse("mcp_config_too_large", "The MCP configuration exceeds the supported size.");
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function removeFile(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function requireRegularFile(path) {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      refuse("mcp_config_unsafe_file", "The MCP configuration must be a regular file, not a link or directory.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function acquireLock(path) {
  const lockPath = `${path}.lock`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const { readFile } = await import("node:fs/promises");
        const owner = JSON.parse(await readFile(lockPath, "utf8"));
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) break;
        try {
          process.kill(owner.pid, 0);
          break;
        } catch (probeError) {
          if (probeError?.code !== "ESRCH") break;
        }
        await removeFile(lockPath);
        continue;
      } catch {
        break;
      }
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      await handle.close();
      return () => removeFile(lockPath);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await removeFile(lockPath);
      throw error;
    }
  }
  refuse("mcp_config_busy", "Another MCP configuration update is in progress, or its lock needs recovery. Retry after it finishes.");
}

/**
 * Extracts the raw server entries from a parsed file.
 *
 * The documented shape is an object with a `servers` array; a bare array is
 * accepted because a hand-written file should not fail over a wrapper nobody
 * needed. When the shape is not recognizable the caller gets an empty list and
 * a diagnostic, matching how the runtime treats the same file.
 */
export function serverEntriesOf(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.servers)) return parsed.servers;
  return undefined;
}

/**
 * Reads `mcp.json` for editing.
 *
 * Returns the raw entries, not the runtime's normalized configs: a caller that
 * wrote back a normalized server would persist computed fields (`fingerprint`)
 * and make the next read look like an external edit. Per-entry validity is
 * reported alongside the entries rather than thrown, because one broken server
 * must not make the others uneditable — the same isolation the loader applies.
 */
export async function readMcpConfigFile({ path, readTextFile = readBoundedText } = {}) {
  if (typeof path !== "string" || path.length === 0) {
    refuse("mcp_config_missing_path", "Aside does not know where its MCP configuration lives.");
  }
  let text;
  try {
    text = await readTextFile(path, "utf8");
  } catch (error) {
    if (error instanceof McpStoreError) throw error;
    if (error?.code === "ENOENT") {
      return Object.freeze({
        path,
        revision: MISSING_MCP_REVISION,
        exists: false,
        servers: Object.freeze([]),
        diagnostics: Object.freeze([]),
      });
    }
    refuse("mcp_config_read_failed", "Aside could not read its MCP configuration.");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    refuse("mcp_config_invalid_json", "The MCP configuration is not valid JSON. The existing file has been preserved.");
  }
  const entries = serverEntriesOf(parsed);
  if (entries === undefined) {
    refuse("mcp_config_invalid_shape", 'The MCP configuration must be an array or an object with a "servers" array.');
  }
  const diagnostics = [];
  const servers = [];
  const seen = new Set();
  entries.forEach((entry, index) => {
    try {
      const validated = validateServerConfig(entry, MCP_CONFIG_LIMITS);
      if (seen.has(validated.id)) {
        diagnostics.push(Object.freeze({ index, id: validated.id, code: "duplicate_mcp_server", message: `The MCP server id "${validated.id}" appears more than once.` }));
        return;
      }
      seen.add(validated.id);
      // Keep the file's own fields, drop nothing the user wrote.
      servers.push(Object.freeze({ index, raw: entry, config: validated }));
    } catch (error) {
      diagnostics.push(Object.freeze({
        index,
        id: typeof entry?.id === "string" ? entry.id : undefined,
        code: typeof error?.code === "string" ? error.code : "mcp_config_invalid",
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  });
  if (entries.length > MCP_CONFIG_LIMITS.maxServers) {
    refuse("mcp_config_too_many_servers", `The MCP configuration defines ${entries.length} servers; at most ${MCP_CONFIG_LIMITS.maxServers} are supported.`);
  }
  return Object.freeze({
    path,
    revision: revisionOf(text),
    exists: true,
    servers: Object.freeze(servers),
    diagnostics: Object.freeze(diagnostics),
  });
}

/**
 * Writes the server list, preserving the file's outer shape.
 *
 * Validates every entry before writing and refuses the whole save on the first
 * invalid one. A partial save would leave the file describing a set of servers
 * the user never assembled.
 */
export async function writeMcpConfigFile({
  path,
  servers,
  expectedRevision,
  replaceFile = rename,
} = {}) {
  if (typeof path !== "string" || path.length === 0) {
    refuse("mcp_config_missing_path", "Aside does not know where its MCP configuration lives.");
  }
  if (!Array.isArray(servers)) {
    refuse("mcp_config_invalid", "The MCP server list must be an array.");
  }
  if (servers.length > MCP_CONFIG_LIMITS.maxServers) {
    refuse("mcp_config_too_many_servers", `At most ${MCP_CONFIG_LIMITS.maxServers} MCP servers may be configured.`);
  }
  if (expectedRevision !== MISSING_MCP_REVISION && !/^[a-f0-9]{64}$/u.test(expectedRevision ?? "")) {
    refuse("mcp_config_revision_required", "Read the MCP configuration before saving changes.");
  }
  // Validate first: nothing below this point should touch the filesystem when
  // an entry is invalid.
  const seen = new Set();
  const raw = servers.map((entry, index) => {
    let validated;
    try {
      validated = validateServerConfig(entry, MCP_CONFIG_LIMITS);
    } catch (error) {
      if (error instanceof McpConfigError) {
        throw new McpStoreError(error.code, `Server ${index + 1}: ${error.message}`);
      }
      throw error;
    }
    if (seen.has(validated.id)) {
      refuse("duplicate_mcp_server", `The MCP server id "${validated.id}" appears more than once.`);
    }
    seen.add(validated.id);
    return entry;
  });
  const text = `${JSON.stringify({ servers: raw }, null, 2)}\n`;
  if (Buffer.byteLength(text) > MCP_CONFIG_MAX_BYTES) {
    refuse("mcp_config_too_large", "The MCP configuration exceeds the supported size.");
  }

  let releaseLock;
  let temporaryPath;
  try {
    await mkdir(dirname(path), { recursive: true });
    releaseLock = await acquireLock(path);
    await requireRegularFile(path);
    const current = await readMcpConfigFile({ path });
    if (current.revision !== expectedRevision) {
      refuse("mcp_config_conflict", "The MCP configuration changed outside this editor. Reload before saving.");
    }
    temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await requireRegularFile(path);
    // Re-check immediately before the rename: the first check cannot cover an
    // edit that lands while this process is writing the temporary file.
    const beforeReplace = await readMcpConfigFile({ path });
    if (beforeReplace.revision !== expectedRevision) {
      refuse("mcp_config_conflict", "The MCP configuration changed outside this editor. Reload before saving.");
    }
    await replaceFile(temporaryPath, path);
    temporaryPath = undefined;
    return Object.freeze({ path, revision: revisionOf(text), servers: Object.freeze(raw) });
  } catch (error) {
    if (error instanceof McpStoreError) throw error;
    throw new McpStoreError("mcp_config_write_failed", "Aside could not save the MCP configuration. The previous file has been preserved.");
  } finally {
    if (temporaryPath) await removeFile(temporaryPath).catch(() => undefined);
    if (releaseLock) await releaseLock().catch(() => undefined);
  }
}
