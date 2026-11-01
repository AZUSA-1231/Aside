import { isAbsolute, relative, resolve } from "node:path";
import { normalizeWorkspaceHint, resolveTaskWorkspace, selectDescriptorHandoff, WorkspaceError } from "./workspace.mjs";
import { projectWorkspacePath, resolveDefaultOutput, samePath, withinPath } from "./output-workspace.mjs";

export async function resolveTaskFileScopes(options = {}) {
  const { defaultWorkspaceRoot, protectedPaths = [], fileSystem, continuationId, previousWorkspace, context, workspaceHint } = options;
  if (!defaultWorkspaceRoot) return resolveTaskWorkspace(options);
  try {
    const explicit = normalizeWorkspaceHint(workspaceHint);
    const output = explicit
      ? await resolveTaskWorkspace({ ...options, context: undefined, previousWorkspace: undefined, workspaceHint: explicit })
      : await resolveDefaultOutput(defaultWorkspaceRoot, { fileSystem, protectedPaths, continuationId });
    const handoff = selectDescriptorHandoff(context);
    let captured;
    if (handoff) {
      const resolution = await resolveTaskWorkspace({ context, fileSystem, continuationId, now: options.now });
      captured = { ...resolution.state,
        scope_path: handoff.root ? resolution.state.canonical_path : resolution.state.target.canonical_path,
        scope_kind: handoff.root ? "directory" : resolution.state.target.kind };
    } else if (previousWorkspace?.continuation_id === continuationId && previousWorkspace?.captured_source) {
      const resolution = await resolveTaskWorkspace({ previousWorkspace: previousWorkspace.captured_source, fileSystem, continuationId, now: options.now });
      if (resolution.state.status === "resolved") captured = resolution.state;
    }
    const state = { ...output.state, output_path: output.state.canonical_path,
      ...(captured ? { captured_source: captured, source_scope: {
        canonical_path: captured.scope_path, addressed_path: captured.addressed_path,
        kind: captured.scope_kind, access: "read_only",
      }, target: { ...captured.target, relative_path: captured.target.canonical_path } } : {}) };
    const protectedCanonical = await Promise.all(protectedPaths.map(async (path) => (await projectWorkspacePath(path, fileSystem)).canonical_path));
    return { state, environment: scopedEnvironment(output.environment, state, captured
      ? (await resolveTaskWorkspace({ previousWorkspace: captured, fileSystem, continuationId, now: options.now })).environment : undefined, protectedCanonical) };
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError(error?.code === "EACCES" || error?.code === "EPERM" ? "filesystem_permission_denied" : "workspace_unavailable", "The file locations are unavailable. Check the default directory and capture the source again.");
  }
}

function scopedEnvironment(output, state, source, protectedPaths) {
  const captured = state.captured_source;
  const sourcePath = captured?.scope_path;
  const sourceFile = captured?.scope_kind === "file";
  function privatePath(path) {
    return protectedPaths.some((protectedPath) => withinPath(protectedPath, path));
  }
  function route(path, write = false) {
    if (typeof path !== "string" || !path || /[\x00-\x1f\x7f]/.test(path)) throw new WorkspaceError("invalid_path", "The file path is invalid.");
    let absolute = isAbsolute(path) ? resolve(path) : resolve(output.cwd, path);
    if (withinPath(state.addressed_path, absolute)) absolute = resolve(output.cwd, relative(state.addressed_path, absolute));
    const sourceAllowed = Boolean(sourcePath && (sourceFile ? samePath(sourcePath, absolute) : withinPath(sourcePath, absolute)));
    const addressedSource = captured?.addressed_path;
    if (!sourceAllowed && addressedSource && (sourceFile ? samePath(addressedSource, absolute) : withinPath(addressedSource, absolute))) {
      absolute = resolve(sourcePath, relative(addressedSource, absolute));
    }
    if (privatePath(absolute)) throw new WorkspaceError("private_workspace", "Aside's private configuration and session files are outside this task's file scopes.");
    const inSource = Boolean(sourcePath && (sourceFile ? samePath(sourcePath, absolute) : withinPath(sourcePath, absolute)));
    if (write && sourceFile && inSource) throw new WorkspaceError("source_read_only", "The captured source is read-only. Save the result to a new output path.", path);
    if (withinPath(output.cwd, absolute) && !(sourceFile && inSource && !write)) return { environment: output, path: absolute, external: false };
    if (inSource && source) {
      if (write) throw new WorkspaceError("source_read_only", "The captured source is read-only. Save the result inside the output directory.", path);
      return { environment: source, path: absolute, external: true };
    }
    throw new WorkspaceError("scope_escape", "The path is outside this task's source and output scopes.", path);
  }
  function project(resource, external) {
    if (privatePath(resource.canonical_path)) throw new WorkspaceError("private_workspace", "The path resolves to Aside's private storage.");
    if (external && !(sourceFile ? samePath(sourcePath, resource.canonical_path) : withinPath(sourcePath, resource.canonical_path))) {
      throw new WorkspaceError("scope_escape", "The path resolves outside the captured source.");
    }
    return external ? { ...resource, addressed_path: resource.canonical_path, relative_path: resource.canonical_path } : resource;
  }
  async function readRoute(path) {
    const selected = route(path);
    if (selected.external && sourceFile) await source.revalidate(captured.target, { expectedKind: "file" });
    return selected;
  }
  const environment = { cwd: output.cwd, workspace: state,
    assertWithinWorkspace: (path) => route(path).path,
    assertCurrent: () => output.assertCurrent(),
    resolvePath: async (path, options = {}) => {
      const selected = options.forWrite ? route(path, true) : await readRoute(path);
      return project(await selected.environment.resolvePath(selected.path, options), selected.external);
    },
    revalidate: async (target, options = {}) => {
      const selected = await readRoute(target.addressed_path);
      return project(await selected.environment.revalidate(target, options), selected.external);
    },
    listDirectory: async (path = ".", options = {}) => {
      const selected = await readRoute(path);
      const listing = project(await selected.environment.listDirectory(selected.path, options), selected.external);
      return { ...listing, entries: listing.entries.filter((entry) => !protectedPaths.some((protectedPath) => withinPath(entry.canonical_path, protectedPath) || withinPath(protectedPath, entry.canonical_path)))
        .map((entry) => selected.external ? { ...entry, addressed_path: entry.canonical_path } : entry) };
    },
  };
  environment.statPath = (path, options) => environment.resolvePath(path, options);
  environment.exists = async (path) => (await environment.resolvePath(path, { allowMissing: true })).exists;
  for (const method of ["readText", "readBytes"]) environment[method] = async (path, options) => {
    const selected = await readRoute(path);
    await environment.resolvePath(path, { expectedKind: "file" });
    return project(await selected.environment[method](selected.path, options), selected.external);
  };
  for (const method of ["writeTextAtomic", "writeBytesAtomic"]) environment[method] = async (path, payload, options) => {
    const selected = route(path, true);
    await environment.resolvePath(path, { forWrite: true, expectedKind: "file", allowMissing: true });
    return project(await selected.environment[method](selected.path, payload, options), false);
  };
  return environment;
}
