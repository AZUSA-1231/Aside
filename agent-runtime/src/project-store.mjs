import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rmdir, stat, unlink } from "node:fs/promises";
import { isAbsolute, basename, dirname, join, resolve } from "node:path";

/**
 * The project layer: a directory that holds a README and its own sessions.
 *
 * A project is not an index kept beside the session store — it *is* the
 * session store, one directory per project. Organizing a session therefore
 * moves a JSONL file without rewriting it, which only stays true because the
 * session cwd is a constant (`aside-session`); see `openProjectSessionStore`.
 *
 * This module is the storage foundation. It reads through bounded projections
 * and moves files; it does not expose the raw JSONL, does not decide relevance,
 * and is not wired into the app yet. 06c does that.
 */

export const PROJECTS_ROOT_ENV = "ASIDE_PROJECTS_ROOT";
export const PROJECT_SCHEMA_VERSION = 1;
export const INBOX_PROJECT_ID = "inbox";
export const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export const PROJECT_LIMITS = Object.freeze({
  maxProjects: 64,
  maxNameChars: 120,
  maxDescriptionBytes: 240,
  maxDirectories: 8,
  maxDirectoryPathBytes: 4096,
  maxReadmeBytes: 16 * 1024,
});

const METADATA_FILE = "project.json";
const README_FILE = "README.md";
const SESSIONS_DIRECTORY = "sessions";

export class ProjectStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProjectStoreError";
    this.code = code;
  }
}

function refuse(code, message) {
  throw new ProjectStoreError(code, message);
}

function hasControlCharacters(value) {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function validateProjectId(id) {
  if (typeof id !== "string" || !PROJECT_SLUG_PATTERN.test(id)) {
    refuse("project_invalid_id", 'A project id must be lowercase letters, digits and "-", and start with a letter or digit.');
  }
  return id;
}

/**
 * Resolves the projects root.
 *
 * The root is a **sibling** of the default output directory (`Documents/
 * AsideProjects` vs `Documents/Aside`), not a child of it. The default-output
 * rule refuses a root that contains protected storage, and the projects
 * directory is protected — nesting it under the output root would make every
 * task with a default directory fail. The native side publishes the value; this
 * only validates it.
 */
export function resolveProjectsRoot({ environment = process.env } = {}) {
  const override = String(environment?.[PROJECTS_ROOT_ENV] ?? "").trim();
  if (!override) return undefined;
  if (!isAbsolute(override) || hasControlCharacters(override) || Buffer.byteLength(override) > 4096) {
    refuse("projects_root_invalid", `${PROJECTS_ROOT_ENV} must be an absolute local path.`);
  }
  return resolve(override);
}

/**
 * The read switch, default on.
 *
 * Organizing is user-triggered, so this governs only whether a task reads
 * across sessions. Default on because a project exists only after the user
 * created it; reading it is not mining content nobody handed over.
 */
function configValue(values, key) {
  const raw = values?.[key];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function memoryEnabled(values = {}) {
  const raw = configValue(values, "ASIDE_MEMORY_ENABLED");
  return raw === undefined ? true : raw.toLowerCase() !== "false";
}

function projectDirectory(root, id) {
  return join(root, validateProjectId(id));
}

function sessionsDirectory(root, id) {
  return join(projectDirectory(root, id), SESSIONS_DIRECTORY);
}

/**
 * Lists the session group directories under one project.
 *
 * The repository derives the group name from the session cwd, so this module
 * must not hardcode it. It is the same name in every project (the cwd is the
 * library root), which is exactly why a session can be moved by renaming.
 */
async function sessionGroups(root, id) {
  let entries;
  try {
    entries = await readdir(sessionsDirectory(root, id), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function validateMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    refuse("project_metadata_invalid", "The project metadata must be an object with schemaVersion 1.");
  }
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > PROJECT_LIMITS.maxNameChars || hasControlCharacters(name)) {
    refuse("project_metadata_invalid", "A project name must be 1–120 characters without control characters.");
  }
  const description = typeof value.description === "string" ? value.description.trim() : "";
  if (Buffer.byteLength(description) > PROJECT_LIMITS.maxDescriptionBytes || hasControlCharacters(description)) {
    refuse("project_metadata_invalid", "A project description must be at most 240 bytes without control characters.");
  }
  const directories = value.directories ?? [];
  if (!Array.isArray(directories) || directories.length > PROJECT_LIMITS.maxDirectories) {
    refuse("project_metadata_invalid", `A project may reference at most ${PROJECT_LIMITS.maxDirectories} directories.`);
  }
  const normalizedDirectories = [];
  for (const directory of directories) {
    if (typeof directory !== "string"
      || !isAbsolute(directory)
      || hasControlCharacters(directory)
      || Buffer.byteLength(directory) > PROJECT_LIMITS.maxDirectoryPathBytes) {
      refuse("project_metadata_invalid", "Referenced directories must be absolute local paths.");
    }
    if (!normalizedDirectories.includes(directory)) normalizedDirectories.push(directory);
  }
  return Object.freeze({
    schemaVersion: PROJECT_SCHEMA_VERSION,
    name,
    description,
    directories: Object.freeze(normalizedDirectories),
  });
}

function validateReadme(text) {
  if (typeof text !== "string") refuse("project_readme_invalid", "A project README must be text.");
  if (Buffer.byteLength(text) > PROJECT_LIMITS.maxReadmeBytes) {
    refuse("project_readme_too_large", `A project README may be at most ${PROJECT_LIMITS.maxReadmeBytes} bytes.`);
  }
  return text;
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function countSessions(root, id) {
  let total = 0;
  for (const group of await sessionGroups(root, id)) {
    const entries = await readdir(join(sessionsDirectory(root, id), group));
    total += entries.filter((entry) => entry.endsWith(".jsonl")).length;
  }
  return total;
}

async function readMetadataDocument(root, id) {
  const path = join(projectDirectory(root, id), METADATA_FILE);
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") refuse("project_metadata_missing", `The project "${id}" has no metadata file.`);
    refuse("project_metadata_unreadable", `The project "${id}" metadata could not be read.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    refuse("project_metadata_invalid", `The project "${id}" metadata is not valid JSON.`);
  }
  return validateMetadata(parsed);
}

/**
 * Lists projects with the one-line description a task reads first.
 *
 * A project whose metadata is unreadable is listed with a diagnostic rather
 * than dropped: a corrupt file must not look like a deleted project.
 */
export async function listProjects({ root, values = {} } = {}) {
  if (!root) {
    return Object.freeze({
      enabled: false,
      projects: Object.freeze([]),
      diagnostics: Object.freeze([{
        code: "projects_unavailable",
        message: "Aside could not resolve a projects directory. Set a default document directory first.",
      }]),
    });
  }
  if (!memoryEnabled(values)) {
    return Object.freeze({
      enabled: false,
      projects: Object.freeze([]),
      diagnostics: Object.freeze([{ code: "memory_disabled", message: "Project memory is turned off." }]),
    });
  }
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ enabled: true, projects: Object.freeze([]), diagnostics: Object.freeze([]) });
    refuse("projects_unreadable", "Aside could not read its projects directory.");
  }
  const projects = [];
  const diagnostics = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !PROJECT_SLUG_PATTERN.test(entry.name)) continue;
    const id = entry.name;
    const metadataPath = join(projectDirectory(root, id), METADATA_FILE);
    let modifiedAt = 0;
    try {
      modifiedAt = (await stat(metadataPath)).mtimeMs;
    } catch {
      modifiedAt = 0;
    }
    try {
      const metadata = await readMetadataDocument(root, id);
      projects.push(Object.freeze({
        id,
        name: metadata.name,
        description: metadata.description,
        directories: metadata.directories,
        sessionCount: await countSessions(root, id),
        modifiedAt,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push(Object.freeze({ id, code: error?.code ?? "project_metadata_invalid", message }));
      projects.push(Object.freeze({
        id,
        name: id,
        description: "",
        directories: Object.freeze([]),
        sessionCount: 0,
        modifiedAt,
        invalid: true,
      }));
    }
  }
  if (projects.length > PROJECT_LIMITS.maxProjects) {
    refuse("projects_too_many", `At most ${PROJECT_LIMITS.maxProjects} projects are supported.`);
  }
  projects.sort((left, right) => right.modifiedAt - left.modifiedAt || left.id.localeCompare(right.id));
  return Object.freeze({ enabled: true, projects: Object.freeze(projects), diagnostics: Object.freeze(diagnostics) });
}

/** Reads the project README, bounded. A missing file is empty, not an error. */
export async function readProjectReadme({ root, id } = {}) {
  if (!root) refuse("projects_unavailable", "Aside could not resolve a projects directory.");
  const path = join(projectDirectory(root, id), README_FILE);
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ id, exists: false, text: "" });
    refuse("project_readme_unreadable", `The project "${id}" README could not be read.`);
  }
  return Object.freeze({ id, exists: true, text: validateReadme(text) });
}

async function writeFileAtomic(path, text) {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    return () => undefined;
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/** Creates a project directory with metadata, an empty README and its sessions. */
export async function createProject({ root, id, name, description = "" } = {}) {
  if (!root) refuse("projects_unavailable", "Aside could not resolve a projects directory.");
  validateProjectId(id);
  const metadata = validateMetadata({ schemaVersion: PROJECT_SCHEMA_VERSION, name, description, directories: [] });
  const directory = projectDirectory(root, id);
  if (await pathExists(directory)) refuse("project_exists", `A project with the id "${id}" already exists.`);
  await mkdir(root, { recursive: true });
  await mkdir(directory);
  try {
    await writeFileAtomic(join(directory, METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`);
    await writeFileAtomic(join(directory, README_FILE), "");
    await mkdir(join(directory, SESSIONS_DIRECTORY), { recursive: true });
  } catch (error) {
    // A half-created project is worse than none: clean up so a retry does not
    // meet a directory that exists but cannot be read.
    await rmDirectory(directory);
    throw error;
  }
  return Object.freeze({ id, ...metadata });
}

async function rmDirectory(directory) {
  try {
    await rmdir(directory, { recursive: true });
  } catch {
    // Cleanup is best effort; the original error is what the caller needs.
  }
}

/** Writes the project README, bounded. */
export async function writeProjectReadme({ root, id, text } = {}) {
  if (!root) refuse("projects_unavailable", "Aside could not resolve a projects directory.");
  validateProjectId(id);
  const bounded = validateReadme(text);
  if (!(await pathExists(join(projectDirectory(root, id), METADATA_FILE)))) {
    refuse("project_missing", `The project "${id}" does not exist.`);
  }
  await writeFileAtomic(join(projectDirectory(root, id), README_FILE), bounded);
  return Object.freeze({ id, bytes: Buffer.byteLength(bounded) });
}

async function findSessionFile(root, id, sessionId) {
  const matches = [];
  for (const group of await sessionGroups(root, id)) {
    const directory = join(sessionsDirectory(root, id), group);
    const entries = await readdir(directory);
    for (const entry of entries) {
      if (entry.endsWith(`_${sessionId}.jsonl`)) matches.push({ group, path: join(directory, entry) });
    }
  }
  if (matches.length > 1) refuse("session_ambiguous", `The session "${sessionId}" appears more than once.`);
  return matches[0];
}

/**
 * Moves a session between projects by renaming its JSONL file.
 *
 * Content is never rewritten: the session cwd stays `aside-session`, so the
 * file remains valid at its new location. A cross-device rename fails instead
 * of falling back to copy-then-delete, because a partial copy is worse than an
 * explicit failure.
 */
export async function moveSession({ root, sessionId, from, to } = {}) {
  if (!root) refuse("projects_unavailable", "Aside could not resolve a projects directory.");
  validateProjectId(from);
  validateProjectId(to);
  if (from === to) refuse("session_move_redundant", "The session is already in that project.");
  const found = await findSessionFile(root, from, sessionId);
  if (!found) refuse("session_missing", `The session "${sessionId}" is not in the "${from}" project.`);
  if (!(await pathExists(join(projectDirectory(root, to), METADATA_FILE)))) {
    refuse("project_missing", `The project "${to}" does not exist.`);
  }
  // The group name is derived from the constant cwd, so it is the same in
  // every project; the file keeps its name and only its directory changes.
  const target = join(sessionsDirectory(root, to), found.group, basename(found.path));
  if (await pathExists(target)) refuse("session_exists", `The "${to}" project already contains "${sessionId}".`);
  await mkdir(dirname(target), { recursive: true });
  try {
    await rename(found.path, target);
  } catch (error) {
    refuse("session_move_failed", `The session "${sessionId}" could not be moved. It was left in "${from}".`);
  }
  return Object.freeze({ sessionId, from, to, fileName: basename(found.path) });
}

/** Creates the inbox project on first use; repeated calls are idempotent. */
export async function ensureInbox({ root } = {}) {
  if (!root) refuse("projects_unavailable", "Aside could not resolve a projects directory.");
  const directory = projectDirectory(root, INBOX_PROJECT_ID);
  if (await pathExists(join(directory, METADATA_FILE))) return Object.freeze({ id: INBOX_PROJECT_ID, created: false });
  if (await pathExists(directory)) {
    // A directory without readable metadata is not something to overwrite.
    refuse("project_metadata_missing", "The inbox directory exists but has no readable metadata.");
  }
  await createProject({ root, id: INBOX_PROJECT_ID, name: "Inbox", description: "Unfiled work" });
  return Object.freeze({ id: INBOX_PROJECT_ID, created: true });
}

/**
 * Opens the session store for one project.
 *
 * `cwd` is the **library root**, deliberately not the project directory. The
 * session repository derives both the on-disk group directory name and the
 * session header from `cwd`; if `cwd` varied per project, moving a file to
 * another project would change the group it belongs to and invalidate its
 * header. Keeping `cwd` constant is what makes "organizing = rename" true, so
 * this value must not be "fixed" to point at the project.
 *
 * Imported lazily to keep this module free of the session runtime's
 * dependency graph.
 */
export async function openProjectSessionStore({ root, id, environment = process.env, fileSystem } = {}) {
  if (!root) refuse("projects_unavailable", "Aside could not resolve a projects directory.");
  validateProjectId(id);
  const directory = projectDirectory(root, id);
  if (!(await pathExists(join(directory, METADATA_FILE)))) {
    refuse("project_missing", `The project "${id}" does not exist.`);
  }
  const { createAsideSessionStore } = await import("./session.mjs");
  return createAsideSessionStore({
    root: join(directory, SESSIONS_DIRECTORY),
    cwd: resolve(root),
    environment,
    fileSystem,
  });
}
