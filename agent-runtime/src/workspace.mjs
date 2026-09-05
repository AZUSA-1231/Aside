import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

const textEncoder = new TextEncoder();
const nativePath = process.platform === "win32" ? win32 : {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
};

export const MAX_WORKSPACE_PATH_BYTES = 4_096;
export const MAX_WORKSPACE_SOURCE_BYTES = 96;
export const MAX_WORKSPACE_RELATIVE_PATH_BYTES = 1_024;

const workspaceKinds = new Set(["file", "directory"]);
const workspaceSources = new Set([
  "explicit",
  "workspace_descriptor",
  "file_descriptor",
  "previous_task_workspace",
]);

export class WorkspaceError extends Error {
  constructor(code, message, path, details) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.path = path;
    this.details = details;
  }
}

function byteLength(value) {
  return textEncoder.encode(String(value)).byteLength;
}

function safePath(value, field = "path") {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    byteLength(value) > MAX_WORKSPACE_PATH_BYTES ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new WorkspaceError("invalid_path", `The workspace ${field} is invalid.`, value);
  }
  if (!nativePath.isAbsolute(value)) {
    throw new WorkspaceError(
      "invalid_path",
      `The workspace ${field} must be absolute.`,
      value,
    );
  }
  return value;
}

function safeSource(value) {
  if (value === undefined) return "explicit";
  if (
    typeof value !== "string" ||
    !workspaceSources.has(value) ||
    byteLength(value) > MAX_WORKSPACE_SOURCE_BYTES
  ) {
    throw new WorkspaceError("invalid_workspace", "The workspace source is invalid.");
  }
  return value;
}

function safeKind(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !workspaceKinds.has(value)) {
    throw new WorkspaceError("invalid_workspace", "The workspace target kind is invalid.");
  }
  return value;
}

function safeExpiry(value) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkspaceError("invalid_workspace", "The workspace expiry is invalid.");
  }
  return value;
}

function comparisonPath(path) {
  const normalized = nativePath.normalize(path);
  const withoutTrailing = normalized.length > 1
    ? normalized.replace(/[\\/]$/, "")
    : normalized;
  return process.platform === "win32"
    ? withoutTrailing.toLocaleLowerCase("en-US")
    : withoutTrailing;
}

function isWithin(rootPath, candidatePath) {
  const root = comparisonPath(rootPath);
  const candidate = comparisonPath(candidatePath);
  if (root === candidate) return true;
  const child = nativePath.relative(root, candidate);
  return child.length > 0 && child !== ".." && !child.startsWith(`..${sep}`) && !nativePath.isAbsolute(child);
}

function normalizeRelativePath(rootPath, targetPath) {
  const value = nativePath.relative(rootPath, targetPath).split(/[\\/]+/).join("/") || ".";
  if (byteLength(value) > MAX_WORKSPACE_RELATIVE_PATH_BYTES) {
    throw new WorkspaceError("path_too_long", "The workspace-relative path is too long.");
  }
  return value;
}

function mapFsError(error, path, options = {}) {
  if (error instanceof WorkspaceError) return error;
  const code = error?.code;
  const mapped =
    code === "ABORT_ERR" || error?.name === "AbortError"
      ? "aborted"
      : code === "ENOENT" || code === "ENOTDIR"
      ? "not_found"
      : code === "EACCES" || code === "EPERM"
        ? (options.mutation === true ? "filesystem_permission_denied" : "permission_denied")
        : code === "EISDIR"
          ? "is_directory"
          : code === "ENAMETOOLONG"
            ? "path_too_long"
            : "filesystem_error";
  return new WorkspaceError(
    mapped,
    mapped === "permission_denied" || mapped === "filesystem_permission_denied"
      ? "The workspace resource could not be accessed because permission was denied."
      : mapped === "aborted"
        ? "The workspace operation was cancelled."
      : mapped === "not_found"
        ? "The workspace resource was not found."
        : "The workspace resource could not be accessed.",
    path,
  );
}

function expectedKindError(expectedKind, actualKind, path) {
  return new WorkspaceError(
    "wrong_type",
    expectedKind === "directory"
      ? "The workspace target is not a directory."
      : "The workspace target is not a file.",
    path,
    { expected: expectedKind, actual: actualKind },
  );
}

function kindFromStats(info) {
  if (info?.isFile?.()) return "file";
  if (info?.isDirectory?.()) return "directory";
  return undefined;
}

function identityFromStats(info, kind) {
  return {
    kind,
    size: Number.isSafeInteger(info.size) ? info.size : 0,
    mtime_ms: Number.isFinite(info.mtimeMs) ? Math.trunc(info.mtimeMs) : 0,
    ...(Number.isSafeInteger(info.dev) ? { device: info.dev } : {}),
    ...(Number.isSafeInteger(info.ino) ? { inode: info.ino } : {}),
  };
}

export function sameWorkspaceIdentity(left, right) {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.size !== right.size || left.mtime_ms !== right.mtime_ms) return false;
  if (left.device !== undefined && right.device !== undefined && left.device !== right.device) {
    return false;
  }
  if (left.inode !== undefined && right.inode !== undefined && left.inode !== right.inode) {
    return false;
  }
  return true;
}

export function normalizeWorkspaceHint(input) {
  if (typeof input === "string") {
    return { path: safePath(input), source: "explicit" };
  }
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new WorkspaceError("invalid_workspace", "The workspace hint is invalid.");
  }
  const allowed = new Set(["path", "kind", "source", "expires_at"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new WorkspaceError("invalid_workspace", "The workspace hint contains an unsupported field.");
  }
  return {
    path: safePath(input.path),
    ...(input.kind === undefined ? {} : { kind: safeKind(input.kind) }),
    source: safeSource(input.source),
    ...(input.expires_at === undefined
      ? {}
      : { expires_at: safeExpiry(input.expires_at) }),
  };
}

function descriptorCandidates(context) {
  const candidates = [];
  for (const attachment of context?.attachments ?? []) {
    for (const descriptor of attachment.descriptors ?? []) {
      const source = descriptor.role === "workspace_root" || descriptor.role === "directory"
        ? "workspace_descriptor"
        : "file_descriptor";
      candidates.push({
        path: descriptor.path,
        kind: descriptor.kind,
        source,
        role: descriptor.role,
        expires_at: attachment.expiresAt,
      });
    }
  }
  return candidates;
}

function descriptorCandidate(context) {
  return descriptorCandidates(context)[0];
}

function backendWithDefaults(fileSystem = {}) {
  return {
    access: fileSystem.access ?? access,
    lstat: fileSystem.lstat ?? lstat,
    mkdir: fileSystem.mkdir ?? mkdir,
    readFile: fileSystem.readFile ?? readFile,
    readdir: fileSystem.readdir ?? readdir,
    realpath: fileSystem.realpath ?? realpath,
    rename: fileSystem.rename ?? rename,
    stat: fileSystem.stat ?? stat,
    unlink: fileSystem.unlink ?? unlink,
    writeFile: fileSystem.writeFile ?? writeFile,
  };
}

async function existingResource(backend, addressedPath, expectedKind) {
  let canonicalPath;
  let info;
  try {
    canonicalPath = await backend.realpath(addressedPath);
    info = await backend.stat(canonicalPath);
  } catch (error) {
    throw mapFsError(error, addressedPath);
  }
  const kind = kindFromStats(info);
  if (!kind) {
    throw new WorkspaceError("unsupported_resource", "The workspace resource type is unsupported.", addressedPath);
  }
  if (expectedKind && expectedKind !== kind) {
    throw expectedKindError(expectedKind, kind, addressedPath);
  }
  return { canonicalPath, kind, info };
}

async function canonicalDirectory(backend, addressedPath) {
  const resource = await existingResource(backend, addressedPath, "directory");
  return resource;
}

function targetReference(candidate, resource, workspacePath) {
  const targetPath = resource.kind === "directory" && candidate.role !== "active_file" && candidate.role !== "document"
    ? resource.canonicalPath
    : resource.canonicalPath;
  const root = resource.kind === "directory" && (candidate.role === "workspace_root" || candidate.role === "directory" || candidate.role === "selected_item")
    ? resource.canonicalPath
    : workspacePath;
  return {
    role: candidate.role ?? (resource.kind === "file" ? "document" : "workspace_root"),
    addressed_path: candidate.path,
    canonical_path: targetPath,
    relative_path: normalizeRelativePath(root, targetPath),
    kind: resource.kind,
    ...(candidate.expires_at === undefined ? {} : { expires_at: candidate.expires_at }),
  };
}

async function activateCandidate(candidate, backend, now) {
  const expiry = safeExpiry(candidate.expires_at);
  if (expiry !== undefined && expiry <= now) {
    throw new WorkspaceError("descriptor_expired", "The workspace descriptor has expired.", candidate.path);
  }
  const expectedKind = safeKind(candidate.kind);
  const resource = await existingResource(backend, candidate.path, expectedKind);
  const addressedPath = nativePath.resolve(candidate.path);
  const workspacePath = resource.kind === "directory"
    ? resource.canonicalPath
    : nativePath.dirname(addressedPath);
  const workspace = await canonicalDirectory(backend, workspacePath);
  if (!isWithin(workspace.canonicalPath, resource.canonicalPath)) {
    throw new WorkspaceError("scope_escape", "The target is outside the active workspace.", candidate.path);
  }
  return {
    status: "resolved",
    source: safeSource(candidate.source),
    addressed_path: candidate.path,
    canonical_path: workspace.canonicalPath,
    kind: "directory",
    target: targetReference(candidate, resource, workspace.canonicalPath),
    ...(expiry === undefined ? {} : { expires_at: expiry }),
  };
}

async function revalidatePrevious(previous, backend, now) {
  if (!previous || previous.status !== "resolved") return undefined;
  if (previous.expires_at !== undefined && previous.expires_at <= now) {
    throw new WorkspaceError("descriptor_expired", "The previous workspace descriptor has expired.");
  }
  const root = await canonicalDirectory(backend, previous.canonical_path);
  if (comparisonPath(root.canonicalPath) !== comparisonPath(previous.canonical_path)) {
    throw new WorkspaceError("stale_workspace", "The active workspace changed and must be selected again.");
  }
  if (!previous.target) return { ...previous, canonical_path: root.canonicalPath };
  const target = await existingResource(backend, previous.target.addressed_path, previous.target.kind);
  if (!isWithin(root.canonicalPath, target.canonicalPath)) {
    throw new WorkspaceError("scope_escape", "The target is outside the active workspace.");
  }
  if (comparisonPath(target.canonicalPath) !== comparisonPath(previous.target.canonical_path)) {
    throw new WorkspaceError("stale_target", "The target changed and must be selected again.");
  }
  if (
    previous.target.identity &&
    !sameWorkspaceIdentity(
      previous.target.identity,
      identityFromStats(target.info, target.kind),
    )
  ) {
    throw new WorkspaceError("stale_target", "The target changed and must be selected again.");
  }
  return {
    ...previous,
    canonical_path: root.canonicalPath,
    target: {
      ...previous.target,
      canonical_path: target.canonicalPath,
      relative_path: normalizeRelativePath(root.canonicalPath, target.canonicalPath),
      identity: identityFromStats(target.info, target.kind),
    },
  };
}

export async function resolveTaskWorkspace({
  context,
  workspaceHint,
  previousWorkspace,
  fileSystem,
  now = Date.now(),
} = {}) {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new WorkspaceError("invalid_workspace", "The workspace clock value is invalid.");
  }
  const backend = backendWithDefaults(fileSystem);
  const explicit = normalizeWorkspaceHint(workspaceHint);
  const candidate = explicit ?? descriptorCandidate(context);
  if (candidate) {
    const state = await activateCandidate(candidate, backend, now);
    if (state.target) {
      const target = await existingResource(backend, state.target.canonical_path, state.target.kind);
      state.target.identity = identityFromStats(target.info, target.kind);
    }
    return {
      state,
      environment: createWorkspaceEnvironment({ state, fileSystem: backend }),
    };
  }

  const previous = await revalidatePrevious(previousWorkspace, backend, now);
  if (!previous) {
    return {
      state: {
        status: "unresolved",
        code: "workspace_required",
        message: "Select a workspace before using file capabilities.",
      },
      environment: undefined,
    };
  }
  return {
    state: previous,
    environment: createWorkspaceEnvironment({ state: previous, fileSystem: backend }),
  };
}

export function createWorkspaceEnvironment({ state, fileSystem } = {}) {
  if (!state || state.status !== "resolved") {
    throw new WorkspaceError("workspace_required", "A valid workspace is required.");
  }
  const backend = backendWithDefaults(fileSystem);
  const rootPath = safePath(state.canonical_path, "canonical path");

  function assertWithinWorkspace(addressedPath) {
    const addressed = typeof addressedPath === "string" ? addressedPath : "";
    if (addressed.length === 0 || /[\x00-\x1f\x7f]/.test(addressed)) {
      throw new WorkspaceError("invalid_path", "The workspace target path is invalid.", addressed);
    }
    const absolutePath = nativePath.isAbsolute(addressed)
      ? nativePath.resolve(addressed)
      : nativePath.resolve(rootPath, addressed);
    if (!isWithin(rootPath, absolutePath)) {
      throw new WorkspaceError("scope_escape", "The target is outside the active workspace.", addressed);
    }
    return absolutePath;
  }

  async function resolvePath(addressedPath, options = {}) {
    const expectedKind = safeKind(options.expectedKind);
    const allowMissing = options.allowMissing === true;
    const absolutePath = assertWithinWorkspace(addressedPath);
    let resource;
    try {
      resource = await existingResource(backend, absolutePath, expectedKind);
    } catch (error) {
      if (!(allowMissing && error.code === "not_found")) throw error;
      const parent = await existingResource(backend, nativePath.dirname(absolutePath), "directory");
      if (!isWithin(rootPath, parent.canonicalPath)) {
        throw new WorkspaceError("scope_escape", "The target parent is outside the active workspace.", addressedPath);
      }
      resource = {
        canonicalPath: nativePath.join(parent.canonicalPath, nativePath.basename(absolutePath)),
        kind: undefined,
        info: undefined,
      };
    }
    if (!isWithin(rootPath, resource.canonicalPath)) {
      throw new WorkspaceError("scope_escape", "The target is outside the active workspace.", addressedPath);
    }
    return {
      addressed_path: addressedPath,
      absolute_path: absolutePath,
      canonical_path: resource.canonicalPath,
      relative_path: normalizeRelativePath(rootPath, resource.canonicalPath),
      ...(resource.kind ? { kind: resource.kind } : {}),
      ...(resource.info ? { identity: identityFromStats(resource.info, resource.kind) } : { identity: undefined }),
      exists: Boolean(resource.info),
    };
  }

  async function revalidate(resolved, options = {}) {
    if (!resolved || typeof resolved !== "object") {
      throw new WorkspaceError("invalid_target", "The prepared workspace target is invalid.");
    }
    const currentRoot = await canonicalDirectory(backend, rootPath);
    if (comparisonPath(currentRoot.canonicalPath) !== comparisonPath(rootPath)) {
      throw new WorkspaceError("stale_workspace", "The active workspace changed and must be selected again.");
    }
    const current = await resolvePath(resolved.addressed_path, {
      expectedKind: options.expectedKind ?? resolved.kind,
      allowMissing: options.allowMissing === true,
    });
    if (comparisonPath(current.canonical_path) !== comparisonPath(resolved.canonical_path)) {
      throw new WorkspaceError("stale_target", "The target changed and must be selected again.", resolved.addressed_path);
    }
    if (options.expectMissing === true && current.exists) {
      throw new WorkspaceError("stale_target", "The prepared new target now exists and must be reviewed again.", resolved.addressed_path);
    }
    if (options.requireIdentity !== false) {
      if (resolved.identity && !current.identity) {
        throw new WorkspaceError("stale_target", "The prepared target no longer exists.", resolved.addressed_path);
      }
      if (resolved.identity && current.identity && !sameWorkspaceIdentity(resolved.identity, current.identity)) {
        throw new WorkspaceError("stale_target", "The target changed and must be selected again.", resolved.addressed_path);
      }
    }
    return current;
  }

  async function statPath(addressedPath, options = {}) {
    return resolvePath(addressedPath, { expectedKind: options.expectedKind });
  }

  async function readText(addressedPath, options = {}) {
    const maxBytes = options.maxBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new WorkspaceError("invalid_limit", "A positive text read limit is required.");
    }
    const resolved = await resolvePath(addressedPath, { expectedKind: "file" });
    if (resolved.identity.size > maxBytes) {
      throw new WorkspaceError("result_too_large", "The workspace file exceeds the read limit.", addressedPath, {
        size: resolved.identity.size,
        max_bytes: maxBytes,
      });
    }
    try {
      const value = await backend.readFile(resolved.canonical_path, {
        encoding: "utf8",
        signal: options.signal,
      });
      if (byteLength(value) > maxBytes) {
        throw new WorkspaceError("result_too_large", "The workspace file exceeds the read limit.", addressedPath);
      }
      return { ...resolved, text: value };
    } catch (error) {
      throw mapFsError(error, addressedPath);
    }
  }

  async function readBytes(addressedPath, options = {}) {
    const maxBytes = options.maxBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new WorkspaceError("invalid_limit", "A positive binary read limit is required.");
    }
    if (options.signal?.aborted) {
      throw new WorkspaceError("aborted", "The workspace operation was cancelled.", addressedPath);
    }
    const resolved = await resolvePath(addressedPath, { expectedKind: "file" });
    if (resolved.identity.size > maxBytes) {
      throw new WorkspaceError("result_too_large", "The workspace file exceeds the read limit.", addressedPath, {
        size: resolved.identity.size,
        max_bytes: maxBytes,
      });
    }
    try {
      const value = await backend.readFile(resolved.canonical_path, {
        signal: options.signal,
      });
      const bytes = value instanceof Uint8Array
        ? value
        : textEncoder.encode(String(value));
      if (options.signal?.aborted) {
        throw new WorkspaceError("aborted", "The workspace operation was cancelled.", addressedPath);
      }
      if (bytes.byteLength > maxBytes) {
        throw new WorkspaceError("result_too_large", "The workspace file exceeds the read limit.", addressedPath, {
          size: bytes.byteLength,
          max_bytes: maxBytes,
        });
      }
      return { ...resolved, bytes };
    } catch (error) {
      throw mapFsError(error, addressedPath);
    }
  }

  async function listDirectory(addressedPath = ".", options = {}) {
    const maxEntries = options.maxEntries;
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new WorkspaceError("invalid_limit", "A positive directory entry limit is required.");
    }
    const resolved = await resolvePath(addressedPath, { expectedKind: "directory" });
    let entries;
    try {
      entries = await backend.readdir(resolved.canonical_path, { withFileTypes: true });
    } catch (error) {
      throw mapFsError(error, addressedPath);
    }
    const truncated = entries.length > maxEntries;
    if (truncated) entries = entries.slice(0, maxEntries);
    const values = [];
    for (const entry of entries) {
      if (options.signal?.aborted) {
        throw new WorkspaceError("aborted", "The workspace operation was cancelled.", addressedPath);
      }
      const childAddressed = nativePath.join(resolved.relative_path === "." ? "" : resolved.relative_path, entry.name) || entry.name;
      const childAbsolute = assertWithinWorkspace(childAddressed);
      let child;
      try {
        const metadata = await backend.lstat(nativePath.join(resolved.canonical_path, entry.name));
        const kind = kindFromStats(metadata);
        child = {
          name: entry.name,
          addressed_path: childAddressed,
          canonical_path: kind === "file" || kind === "directory"
            ? (await existingResource(backend, childAbsolute, kind)).canonicalPath
            : childAbsolute,
          kind: kind ?? "unsupported",
          size: Number.isSafeInteger(metadata.size) ? metadata.size : 0,
          mtime_ms: Number.isFinite(metadata.mtimeMs) ? Math.trunc(metadata.mtimeMs) : 0,
        };
      } catch (error) {
        throw mapFsError(error, childAddressed);
      }
      if (child.kind === "file" || child.kind === "directory") values.push(child);
    }
    return { ...resolved, entries: values, truncated };
  }

  async function assertCurrent() {
    const current = await canonicalDirectory(backend, rootPath);
    if (comparisonPath(current.canonicalPath) !== comparisonPath(rootPath)) {
      throw new WorkspaceError("stale_workspace", "The active workspace changed and must be selected again.");
    }
    return true;
  }

  return {
    cwd: rootPath,
    workspace: { ...state },
    assertWithinWorkspace,
    resolvePath,
    revalidate,
    statPath,
    readText,
    readBytes,
    listDirectory,
    assertCurrent,
    async exists(addressedPath) {
      const absolutePath = assertWithinWorkspace(addressedPath);
      try {
        await backend.access(absolutePath, constants.F_OK);
        await existingResource(backend, absolutePath);
        return true;
      } catch (error) {
        const mapped = mapFsError(error, addressedPath);
        if (mapped.code === "not_found") return false;
        throw mapped;
      }
    },
    async writeText(addressedPath, text, options = {}) {
      const resolved = await resolvePath(addressedPath, { expectedKind: "file", allowMissing: true });
      if (typeof text !== "string" || !Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
        throw new WorkspaceError("invalid_limit", "A positive text write limit is required.", addressedPath);
      }
      if (byteLength(text) > options.maxBytes) {
        throw new WorkspaceError("result_too_large", "The workspace write exceeds the content limit.", addressedPath);
      }
      try {
        await backend.writeFile(resolved.canonical_path, text, {
          encoding: "utf8",
          signal: options.signal,
        });
      } catch (error) {
        throw mapFsError(error, addressedPath);
      }
      return resolvePath(addressedPath, { expectedKind: "file" });
    },
    async writeTextAtomic(addressedPath, text, options = {}) {
      if (typeof text !== "string" || !Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
        throw new WorkspaceError("invalid_limit", "A positive text write limit is required.", addressedPath);
      }
      if (byteLength(text) > options.maxBytes) {
        throw new WorkspaceError("result_too_large", "The workspace write exceeds the content limit.", addressedPath);
      }
      if (options.signal?.aborted) {
        throw new WorkspaceError("aborted", "The workspace operation was cancelled.", addressedPath);
      }
      const prepared = options.expected ?? await resolvePath(addressedPath, {
        expectedKind: "file",
        allowMissing: true,
      });
      const current = await revalidate(prepared, {
        expectedKind: "file",
        allowMissing: true,
        expectMissing: options.expectMissing === true,
      });
      const parent = await existingResource(backend, nativePath.dirname(current.canonical_path), "directory");
      if (!isWithin(rootPath, parent.canonicalPath)) {
        throw new WorkspaceError("scope_escape", "The write parent is outside the active workspace.", addressedPath);
      }
      const temporaryPath = nativePath.join(parent.canonicalPath, `.aside-write-${randomUUID()}.tmp`);
      let temporaryCreated = false;
      try {
        await backend.writeFile(temporaryPath, text, {
          encoding: "utf8",
          signal: options.signal,
        });
        temporaryCreated = true;
        if (options.signal?.aborted) {
          throw new WorkspaceError("aborted", "The workspace operation was cancelled.", addressedPath);
        }
        if (options.beforeRename) await options.beforeRename(current);
        await backend.rename(temporaryPath, current.canonical_path);
        temporaryCreated = false;
      } catch (error) {
        throw mapFsError(error, addressedPath, { mutation: true });
      } finally {
        if (temporaryCreated) {
          try {
            await backend.unlink(temporaryPath);
          } catch {
            // Best-effort cleanup; the write result remains failed.
          }
        }
      }
      return resolvePath(addressedPath, { expectedKind: "file" });
    },
    async renamePath(sourcePath, destinationPath, options = {}) {
      const source = await resolvePath(sourcePath, { expectedKind: "file" });
      const destination = await resolvePath(destinationPath, { expectedKind: "file", allowMissing: true });
      try {
        await backend.rename(source.canonical_path, destination.canonical_path);
      } catch (error) {
        throw mapFsError(error, destinationPath);
      }
      return resolvePath(destinationPath, { expectedKind: "file" });
    },
    async ensureDirectory(addressedPath) {
      const absolutePath = assertWithinWorkspace(addressedPath);
      try {
        await backend.mkdir(absolutePath, { recursive: true });
      } catch (error) {
        throw mapFsError(error, addressedPath);
      }
      return resolvePath(addressedPath, { expectedKind: "directory" });
    },
  };
}
