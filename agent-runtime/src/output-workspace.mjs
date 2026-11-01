import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createWorkspaceEnvironment, normalizeWorkspaceHint, WorkspaceError } from "./workspace.mjs";

export function samePath(left, right) {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

export function withinPath(root, path) {
  if (samePath(root, path)) return true;
  const child = relative(resolve(root), resolve(path));
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function backendFor(fileSystem) {
  return { lstat, mkdir, realpath, stat, ...fileSystem };
}

export async function projectWorkspacePath(path, fileSystem) {
  const backend = backendFor(fileSystem);
  const addressed = normalizeWorkspaceHint(path).path;
  let ancestor = resolve(addressed);
  const missing = [];
  for (let depth = 0; depth < 128; depth += 1) {
    try {
      const info = await backend.stat(ancestor);
      const canonical = await backend.realpath(ancestor);
      if (missing.length && !info.isDirectory()) throw new WorkspaceError("not_directory", "The default directory has a non-directory parent.", path);
      return { addressed_path: resolve(addressed), canonical_path: join(canonical, ...missing),
        ancestor, anchor: canonical, anchor_identity: { dev: info.dev, ino: info.ino },
        missing, kind: info.isDirectory() ? "directory" : "file" };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      try {
        await backend.lstat(ancestor);
        throw new WorkspaceError("stale_workspace", "The default directory contains an unavailable link.", path);
      } catch (linkError) {
        if (linkError?.code !== "ENOENT") throw linkError;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new WorkspaceError("not_found", "The default directory has no available parent.", path);
      missing.unshift(relative(parent, ancestor));
      ancestor = parent;
    }
  }
  throw new WorkspaceError("invalid_workspace", "The default directory is too deeply nested.", path);
}

export async function resolveDefaultOutput(path, { fileSystem, protectedPaths = [], continuationId } = {}) {
  const plan = await projectWorkspacePath(path, fileSystem);
  if (!plan.missing.length && plan.kind !== "directory") throw new WorkspaceError("not_directory", "The default output path is not a directory.", path);
  for (const protectedPath of protectedPaths) {
    const protectedPlan = await projectWorkspacePath(protectedPath, fileSystem);
    if (withinPath(plan.canonical_path, protectedPlan.canonical_path) || withinPath(protectedPlan.canonical_path, plan.canonical_path)) {
      throw new WorkspaceError("private_workspace", "Choose a default directory separate from Aside's configuration and session storage.", path);
    }
  }
  const state = { status: "resolved", source: "default_workspace", addressed_path: plan.addressed_path,
    canonical_path: plan.canonical_path, kind: "directory", continuation_id: continuationId,
    pending_creation: plan.missing.length > 0 };
  return { state, environment: createPendingOutput(state, plan, fileSystem) };
}

function createPendingOutput(state, plan, fileSystem) {
  const backend = backendFor(fileSystem);
  const workspace = createWorkspaceEnvironment({ state, fileSystem });
  let materialized = plan.missing.length === 0;
  let rootIdentity = materialized ? plan.anchor_identity : undefined;

  async function available() {
    const anchor = await backend.stat(plan.anchor);
    if (anchor.dev !== plan.anchor_identity.dev || anchor.ino !== plan.anchor_identity.ino
      || !samePath(await backend.realpath(plan.ancestor), plan.anchor)) {
      throw new WorkspaceError("stale_workspace", "The default directory parent changed; start a new task.");
    }
    const current = await projectWorkspacePath(plan.addressed_path, fileSystem);
    if (!samePath(current.canonical_path, state.canonical_path) || (materialized && current.missing.length)) {
      throw new WorkspaceError("stale_workspace", "The default directory changed; start a new task.");
    }
    if (!current.missing.length) {
      if (current.kind !== "directory") throw new WorkspaceError("not_directory", "The default output path is not a directory.");
      if (rootIdentity && (current.anchor_identity.dev !== rootIdentity.dev || current.anchor_identity.ino !== rootIdentity.ino)) {
        throw new WorkspaceError("stale_workspace", "The output directory was replaced; start a new task.");
      }
      rootIdentity = current.anchor_identity;
      materialized = true;
    }
    return materialized;
  }

  async function resolvePath(path, options = {}) {
    if (await available()) return workspace.resolvePath(path, options);
    const absolute = workspace.assertWithinWorkspace(path);
    const root = samePath(absolute, state.canonical_path);
    if ((!root && options.allowMissing !== true) || (!root && !samePath(dirname(absolute), state.canonical_path))) {
      throw new WorkspaceError("not_found", "The output file or its parent does not exist.", path);
    }
    if (root && options.expectedKind === "file") throw new WorkspaceError("is_directory", "The output path is a directory.", path);
    return { addressed_path: path, absolute_path: absolute, canonical_path: absolute,
      relative_path: root ? "." : relative(state.canonical_path, absolute).split(sep).join("/"),
      ...(root ? { kind: "directory" } : {}), exists: false, identity: undefined };
  }

  async function revalidate(target, options = {}) {
    if (await available()) return workspace.revalidate(target, options);
    const current = await resolvePath(target.addressed_path, options);
    if (!samePath(current.canonical_path, target.canonical_path) || target.identity) {
      throw new WorkspaceError("stale_target", "The prepared output changed; review it again.");
    }
    return current;
  }

  async function materialize(signal) {
    if (await available()) return;
    let parent = plan.anchor;
    for (const segment of plan.missing) {
      if (signal?.aborted) throw new WorkspaceError("aborted", "The output operation was cancelled.");
      if (!samePath(await backend.realpath(parent), parent)) throw new WorkspaceError("stale_workspace", "The output parent was redirected.");
      const child = join(parent, segment);
      try { await backend.mkdir(child); }
      catch (error) { if (error?.code !== "EEXIST") throw new WorkspaceError(error?.code === "EACCES" || error?.code === "EPERM" ? "filesystem_permission_denied" : "filesystem_error", "The default directory could not be created. Check its location and permissions."); }
      if (!samePath(await backend.realpath(child), child) || !(await backend.stat(child)).isDirectory()) {
        throw new WorkspaceError("stale_workspace", "The output directory was redirected or replaced.");
      }
      parent = child;
    }
    materialized = true;
    const info = await backend.stat(state.canonical_path);
    rootIdentity = { dev: info.dev, ino: info.ino };
  }

  const pending = { ...workspace, resolvePath, revalidate,
    assertCurrent: async () => { await available(); return true; },
    statPath: (path, options) => resolvePath(path, options),
    exists: async (path) => (await resolvePath(path, { allowMissing: true })).exists,
    listDirectory: async (path = ".", options = {}) => {
      if (await available()) return workspace.listDirectory(path, options);
      const target = await resolvePath(path, { expectedKind: "directory" });
      return { ...target, entries: [], truncated: false, offset: 0, total_entries: 0 };
    },
  };
  for (const method of ["readText", "readBytes"]) pending[method] = async (...args) => {
    if (!(await available())) throw new WorkspaceError("not_found", "The output file does not exist.", args[0]);
    return workspace[method](...args);
  };
  for (const method of ["writeTextAtomic", "writeBytesAtomic"]) pending[method] = async (path, payload, options = {}) => {
    if (options.expected) await revalidate(options.expected, { allowMissing: true, expectMissing: options.expectMissing });
    await materialize(options.signal);
    return workspace[method](path, payload, { ...options, beforeRename: async (current) => {
      await available();
      await options.beforeRename?.(current);
    } });
  };
  return pending;
}
