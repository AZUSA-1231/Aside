import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAsideConfig } from "../src/config.mjs";
import {
  INBOX_PROJECT_ID,
  PROJECT_LIMITS,
  createProject,
  ensureInbox,
  listProjects,
  memoryEnabled,
  moveSession,
  openProjectSessionStore,
  readProjectReadme,
  resolveProjectsRoot,
  writeProjectReadme,
} from "../src/project-store.mjs";

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "aside-projects-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return { root, projectsRoot: join(root, "projects") };
}

const projectMetadata = (name, description = "") => ({ schemaVersion: 1, name, description, directories: [] });

async function writeSession(projectsRoot, project, sessionId, content = "{\"role\":\"user\"}\n") {
  const directory = join(projectsRoot, project, "sessions", "--aside-session--");
  await mkdir(directory, { recursive: true });
  const file = join(directory, `1700000000000_${sessionId}.jsonl`);
  await writeFile(file, content, "utf8");
  return file;
}

test("the projects root comes from the native environment and is validated", () => {
  assert.equal(resolveProjectsRoot({ environment: { ASIDE_PROJECTS_ROOT: "D:/Documents/AsideProjects" } }), "D:\\Documents\\AsideProjects");
  // A relative override is refused rather than resolved against the process cwd.
  assert.throws(() => resolveProjectsRoot({ environment: { ASIDE_PROJECTS_ROOT: "relative/projects" } }),
    (error) => error.code === "projects_root_invalid");
  // No native value means the project layer is unavailable, not a guess.
  assert.equal(resolveProjectsRoot({ environment: {} }), undefined);
});

test("the read switch defaults on and an explicit false turns it off", () => {
  assert.equal(memoryEnabled({}), true);
  assert.equal(memoryEnabled({ ASIDE_MEMORY_ENABLED: "true" }), true);
  assert.equal(memoryEnabled({ ASIDE_MEMORY_ENABLED: "false" }), false);
  assert.equal(memoryEnabled({ ASIDE_MEMORY_ENABLED: " FALSE " }), false);
});

test("the inbox is created once with metadata, README and a session directory", async (context) => {
  const { projectsRoot } = await fixture(context);
  assert.deepEqual(await ensureInbox({ root: projectsRoot }), { id: INBOX_PROJECT_ID, created: true });
  assert.deepEqual(await ensureInbox({ root: projectsRoot }), { id: INBOX_PROJECT_ID, created: false });
  const metadata = JSON.parse(await readFile(join(projectsRoot, INBOX_PROJECT_ID, "project.json"), "utf8"));
  assert.equal(metadata.name, "Inbox");
  assert.equal(metadata.schemaVersion, 1);
  assert.deepEqual(metadata.directories, []);
  assert.equal(await readFile(join(projectsRoot, INBOX_PROJECT_ID, "README.md"), "utf8"), "");
  assert.deepEqual(await readdir(join(projectsRoot, INBOX_PROJECT_ID, "sessions")), []);
});

test("a project can be created and lists its own description and session count", async (context) => {
  const { projectsRoot } = await fixture(context);
  await ensureInbox({ root: projectsRoot });
  await createProject({ root: projectsRoot, id: "job-search", name: "Job search", description: "Applications" });
  await writeSession(projectsRoot, "job-search", "session-1");
  const listed = await listProjects({ root: projectsRoot });
  assert.equal(listed.enabled, true);
  assert.deepEqual(listed.projects.map((project) => project.id).sort(), ["inbox", "job-search"]);
  const job = listed.projects.find((project) => project.id === "job-search");
  assert.equal(job.description, "Applications");
  assert.equal(job.sessionCount, 1);
});

test("an invalid project id or metadata is refused and leaves nothing behind", async (context) => {
  const { projectsRoot } = await fixture(context);
  for (const id of ["Job Search", "job/search", "-leading", ""]) {
    await assert.rejects(createProject({ root: projectsRoot, id, name: "x" }), (error) => error.code === "project_invalid_id");
  }
  await assert.rejects(createProject({ root: projectsRoot, id: "ok", name: "" }), (error) => error.code === "project_metadata_invalid");
  await assert.rejects(createProject({ root: projectsRoot, id: "ok", name: "x", description: "y".repeat(300) }),
    (error) => error.code === "project_metadata_invalid");
  await createProject({ root: projectsRoot, id: "ok", name: "Ok" });
  await assert.rejects(createProject({ root: projectsRoot, id: "ok", name: "Again" }), (error) => error.code === "project_exists");
});

test("a corrupt project is listed with a diagnostic instead of disappearing", async (context) => {
  const { projectsRoot } = await fixture(context);
  await ensureInbox({ root: projectsRoot });
  await mkdir(join(projectsRoot, "broken"), { recursive: true });
  await writeFile(join(projectsRoot, "broken", "project.json"), "{ not json", "utf8");
  const listed = await listProjects({ root: projectsRoot });
  const broken = listed.projects.find((project) => project.id === "broken");
  assert.ok(broken);
  assert.equal(broken.invalid, true);
  assert.equal(listed.diagnostics.length, 1);
  assert.equal(listed.diagnostics[0].id, "broken");
});

test("the switch off returns disabled without touching the projects on disk", async (context) => {
  const { projectsRoot } = await fixture(context);
  await ensureInbox({ root: projectsRoot });
  const listed = await listProjects({ root: projectsRoot, values: { ASIDE_MEMORY_ENABLED: "false" } });
  assert.equal(listed.enabled, false);
  assert.deepEqual(listed.projects, []);
  assert.equal(listed.diagnostics[0].code, "memory_disabled");
  // Still on disk: turning the switch off is not a delete.
  assert.ok((await readdir(projectsRoot)).includes(INBOX_PROJECT_ID));
});

test("the README round-trips, is bounded, and a missing one is empty rather than an error", async (context) => {
  const { projectsRoot } = await fixture(context);
  await createProject({ root: projectsRoot, id: "docs", name: "Docs" });
  assert.deepEqual(await readProjectReadme({ root: projectsRoot, id: "docs" }), { id: "docs", exists: true, text: "" });
  await writeProjectReadme({ root: projectsRoot, id: "docs", text: "# Docs\n\nCurrent work.\n" });
  assert.equal((await readProjectReadme({ root: projectsRoot, id: "docs" })).text, "# Docs\n\nCurrent work.\n");
  await assert.rejects(writeProjectReadme({ root: projectsRoot, id: "docs", text: "x".repeat(PROJECT_LIMITS.maxReadmeBytes + 1) }),
    (error) => error.code === "project_readme_too_large");
  await assert.rejects(writeProjectReadme({ root: projectsRoot, id: "missing", text: "x" }), (error) => error.code === "project_missing");
  assert.deepEqual(await readProjectReadme({ root: projectsRoot, id: "missing" }), { id: "missing", exists: false, text: "" });
});

test("moving a session renames its file and leaves the content byte-identical", async (context) => {
  const { projectsRoot } = await fixture(context);
  await ensureInbox({ root: projectsRoot });
  await createProject({ root: projectsRoot, id: "job-search", name: "Job search" });
  const content = "{\"role\":\"user\",\"content\":\"hello\"}\n";
  const source = await writeSession(projectsRoot, INBOX_PROJECT_ID, "session-1", content);

  const moved = await moveSession({ root: projectsRoot, sessionId: "session-1", from: INBOX_PROJECT_ID, to: "job-search" });
  assert.equal(moved.to, "job-search");
  assert.equal(await readFile(join(projectsRoot, "job-search", "sessions", "--aside-session--", "1700000000000_session-1.jsonl"), "utf8"), content);
  await assert.rejects(readFile(source), (error) => error.code === "ENOENT");
});

test("an impossible move is refused and leaves the session where it was", async (context) => {
  const { projectsRoot } = await fixture(context);
  await ensureInbox({ root: projectsRoot });
  await createProject({ root: projectsRoot, id: "target", name: "Target" });
  const content = "{\"role\":\"user\"}\n";
  const source = await writeSession(projectsRoot, INBOX_PROJECT_ID, "session-1", content);

  await assert.rejects(moveSession({ root: projectsRoot, sessionId: "session-1", from: INBOX_PROJECT_ID, to: INBOX_PROJECT_ID }),
    (error) => error.code === "session_move_redundant");
  await assert.rejects(moveSession({ root: projectsRoot, sessionId: "session-1", from: INBOX_PROJECT_ID, to: "missing" }),
    (error) => error.code === "project_missing");
  await assert.rejects(moveSession({ root: projectsRoot, sessionId: "absent", from: INBOX_PROJECT_ID, to: "target" }),
    (error) => error.code === "session_missing");
  // A same-named session already in the target is a conflict, not an overwrite.
  await writeSession(projectsRoot, "target", "session-1", "other\n");
  await assert.rejects(moveSession({ root: projectsRoot, sessionId: "session-1", from: INBOX_PROJECT_ID, to: "target" }),
    (error) => error.code === "session_exists");
  assert.equal(await readFile(source, "utf8"), content);
});

test("a project opens a session store under its own sessions directory", async (context) => {
  const { projectsRoot } = await fixture(context);
  await createProject({ root: projectsRoot, id: "docs", name: "Docs" });
  const store = await openProjectSessionStore({ root: projectsRoot, id: "docs", environment: {} });
  // The cwd is the library root, not the project: it must not change when a
  // session moves between projects.
  assert.equal(store.cwd, join(projectsRoot));
  const session = await store.repository.create({ cwd: store.cwd, metadata: { application: "aside", schemaVersion: 1 } });
  assert.ok(session);
  const groups = await readdir(join(projectsRoot, "docs", "sessions"));
  const files = (await Promise.all(groups.map((group) => readdir(join(projectsRoot, "docs", "sessions", group))))).flat();
  assert.ok(files.some((entry) => entry.endsWith(".jsonl")));
});

test("the projects root joins the protected workspace paths", async (context) => {
  const { root } = await fixture(context);
  const environment = {
    LOCALAPPDATA: join(root, "data"),
    ASIDE_SETTINGS_PATH: join(root, "data", "Aside", "settings.json"),
    ASIDE_DEFAULT_WORKSPACE_ROOT: join(root, "Documents", "Aside"),
    ASIDE_PROJECTS_ROOT: join(root, "Documents", "AsideProjects"),
  };
  const configuration = await loadAsideConfig({ environment, cwd: root });
  assert.ok(configuration.projectsRoot);
  assert.ok(configuration.protectedWorkspacePaths.includes(configuration.projectsRoot));
  assert.equal(configuration.publicValues.memory_enabled, "true");
});
