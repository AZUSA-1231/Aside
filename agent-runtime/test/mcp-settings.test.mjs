import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleSettingsRequest } from "../src/settings-service.mjs";
import {
  MISSING_MCP_REVISION,
  readMcpConfigFile,
  serverEntriesOf,
  writeMcpConfigFile,
} from "../src/mcp-store.mjs";
import { testMcpServer } from "../src/mcp-test.mjs";

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "aside-mcp-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "Aside", "mcp.json");
  return {
    root,
    configPath,
    environment: { LOCALAPPDATA: join(root, "data"), ASIDE_SETTINGS_PATH: join(root, "data", "Aside", "settings.json"), ASIDE_MCP_CONFIG_PATH: configPath },
    cwd: root,
  };
}

const server = (overrides = {}) => ({
  id: "notes",
  display_name: "Notes",
  transport: "stdio",
  command: "node.exe",
  args: ["server.js"],
  env: { API_KEY: { from_config: "NOTES_API_KEY" } },
  enabled: false,
  trust_acknowledged: false,
  ...overrides,
});

test("a missing MCP file reads as empty rather than an error", async (context) => {
  const { configPath } = await fixture(context);
  const file = await readMcpConfigFile({ path: configPath });
  assert.equal(file.exists, false);
  assert.equal(file.revision, MISSING_MCP_REVISION);
  assert.deepEqual(file.servers, []);
  assert.deepEqual(file.diagnostics, []);
});

test("a saved server round-trips as the user wrote it, without derived fields", async (context) => {
  const { configPath } = await fixture(context);
  await writeMcpConfigFile({ path: configPath, servers: [server()], expectedRevision: MISSING_MCP_REVISION });
  const file = await readMcpConfigFile({ path: configPath });
  assert.equal(file.servers.length, 1);
  assert.deepEqual(file.servers[0].raw, server());
  // `fingerprint` is computed at load time; persisting it would make the next
  // read look like an external edit.
  const onDisk = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(onDisk.servers[0].fingerprint, undefined);
});

test("an invalid server refuses the whole save and leaves the file untouched", async (context) => {
  const { configPath } = await fixture(context);
  const first = await writeMcpConfigFile({ path: configPath, servers: [server()], expectedRevision: MISSING_MCP_REVISION });
  const before = await readFile(configPath, "utf8");
  await assert.rejects(
    writeMcpConfigFile({
      path: configPath,
      servers: [server({ id: "ok" }), server({ id: "Bad ID" })],
      expectedRevision: first.revision,
    }),
    (error) => error.code === "mcp_config_invalid",
  );
  assert.equal(await readFile(configPath, "utf8"), before);
});

test("a literal secret in an environment entry is refused by name", async (context) => {
  const { configPath } = await fixture(context);
  await assert.rejects(
    writeMcpConfigFile({
      path: configPath,
      servers: [server({ env: { API_KEY: "sk-live-value" } })],
      expectedRevision: MISSING_MCP_REVISION,
    }),
    (error) => error.code === "mcp_secret_must_be_indirect",
  );
});

test("a save is refused when the file changed since it was read", async (context) => {
  const { configPath } = await fixture(context);
  const first = await writeMcpConfigFile({ path: configPath, servers: [server()], expectedRevision: MISSING_MCP_REVISION });
  // Simulate an external edit.
  await writeFile(configPath, `${JSON.stringify({ servers: [server({ id: "edited" })] }, null, 2)}\n`);
  await assert.rejects(
    writeMcpConfigFile({ path: configPath, servers: [server({ display_name: "Mine" })], expectedRevision: first.revision }),
    (error) => error.code === "mcp_config_conflict",
  );
});

test("a duplicate id is refused before anything is written", async (context) => {
  const { configPath } = await fixture(context);
  await assert.rejects(
    writeMcpConfigFile({
      path: configPath,
      servers: [server(), server()],
      expectedRevision: MISSING_MCP_REVISION,
    }),
    (error) => error.code === "duplicate_mcp_server",
  );
});

test("saving leaves no temporary file behind", async (context) => {
  const { configPath, root } = await fixture(context);
  await writeMcpConfigFile({ path: configPath, servers: [server()], expectedRevision: MISSING_MCP_REVISION });
  const entries = await readdir(join(root, "Aside"));
  assert.deepEqual(entries.filter((name) => name.endsWith(".tmp") || name.endsWith(".lock")), []);
});

test("a broken entry is reported while the rest remain editable", async (context) => {
  const { configPath } = await fixture(context);
  await mkdir(join(configPath, ".."), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    servers: [server(), { id: "Bad ID", command: "node.exe" }],
  }, null, 2)}\n`);
  const file = await readMcpConfigFile({ path: configPath });
  assert.equal(file.servers.length, 1);
  assert.equal(file.servers[0].config.id, "notes");
  assert.equal(file.diagnostics.length, 1);
  assert.equal(file.diagnostics[0].code, "mcp_config_invalid");
});

test("the outer shape accepts a bare array and an object with servers", () => {
  assert.deepEqual(serverEntriesOf([{ id: "a" }]), [{ id: "a" }]);
  assert.deepEqual(serverEntriesOf({ servers: [{ id: "a" }] }), [{ id: "a" }]);
  assert.equal(serverEntriesOf({ nope: true }), undefined);
});

test("read and save are available through the settings service", async (context) => {
  const { environment, cwd, configPath } = await fixture(context);
  const empty = await handleSettingsRequest({ operation: "get_mcp" }, { environment, cwd });
  assert.equal(empty.exists, false);
  assert.equal(empty.path, configPath);
  const saved = await handleSettingsRequest(
    { operation: "save_mcp", servers: [server()], expected_revision: MISSING_MCP_REVISION },
    { environment, cwd },
  );
  assert.equal(saved.servers.length, 1);
  // The projection names the environment reference and never carries a value.
  assert.deepEqual(saved.servers[0].environment, [{ name: "API_KEY", from_config: "NOTES_API_KEY" }]);
  assert.equal(saved.servers[0].enabled, false);
  assert.equal(saved.servers[0].trust_acknowledged, false);
  const reloaded = await handleSettingsRequest({ operation: "get_mcp" }, { environment, cwd });
  assert.equal(reloaded.revision, saved.revision);
});

test("the settings service rejects unexpected fields on MCP operations", async (context) => {
  const { environment, cwd } = await fixture(context);
  await assert.rejects(
    handleSettingsRequest({ operation: "save_mcp", servers: [], expected_revision: "missing", path: "C:/elsewhere.json" }, { environment, cwd }),
    (error) => error.code === "settings_invalid_request",
  );
});

/** A controller double: no processes, observable close. */
function fakeController({ tools = [], diagnostics = [], failWith } = {}) {
  const calls = { closed: [], created: 0 };
  const factory = (options) => {
    calls.created += 1;
    calls.options = options;
    return {
      tools: async () => {
        if (failWith) throw failWith;
        return tools;
      },
      get diagnostics() { return diagnostics; },
      close: async (reason) => { calls.closed.push(reason); },
    };
  };
  return { factory, calls };
}

test("a connection test reports the tools a working server offers and always closes", async () => {
  const { factory, calls } = fakeController({ tools: [{ name: "search" }, { name: "fetch" }] });
  const result = await testMcpServer({ entry: server(), configValues: { NOTES_API_KEY: "configured" }, controllerFactory: factory });
  assert.equal(result.outcome, "ok");
  assert.deepEqual(result.tools.map((tool) => tool.name), ["search", "fetch"]);
  // The probe enables and trusts for its own run without touching the file.
  assert.equal(calls.options.servers[0].enabled, true);
  assert.equal(calls.options.servers[0].trust_acknowledged, true);
  assert.deepEqual(calls.closed, ["tested"]);
});

test("a test that cannot start the server reports unreachable and still closes", async () => {
  const { factory, calls } = fakeController({ tools: [], diagnostics: [{ code: "mcp_server_failed", message: "spawn failed" }] });
  const result = await testMcpServer({ entry: server(), configValues: { NOTES_API_KEY: "configured" }, controllerFactory: factory });
  assert.equal(result.outcome, "unreachable");
  assert.deepEqual(calls.closed, ["tested"]);
});

test("a server whose tools are all refused is reported as tools_rejected, not as unreachable", async () => {
  const { factory } = fakeController({ tools: [], diagnostics: [{ code: "mcp_schema_unsupported_keyword", message: "unsupported keyword" }] });
  const result = await testMcpServer({ entry: server(), configValues: { NOTES_API_KEY: "configured" }, controllerFactory: factory });
  assert.equal(result.outcome, "tools_rejected");
});

test("missing configuration is reported by name and never starts the server", async () => {
  const { factory, calls } = fakeController({ tools: [] });
  const result = await testMcpServer({ entry: server(), configValues: {}, controllerFactory: factory });
  assert.equal(result.outcome, "missing_environment");
  assert.deepEqual(result.missing, [{ name: "API_KEY", from_config: "NOTES_API_KEY" }]);
  // Nothing was spawned: a missing name is decided before the connection.
  assert.equal(calls.created, 0);
  assert.doesNotMatch(JSON.stringify(result), /sk-live|secret/u);
});

test("an invalid entry is reported without starting anything", async () => {
  const { factory, calls } = fakeController({ tools: [] });
  const result = await testMcpServer({ entry: server({ id: "Bad ID" }), controllerFactory: factory });
  assert.equal(result.outcome, "invalid");
  assert.equal(calls.created, 0);
});

test("a throwing controller is reported as unreachable and closed", async () => {
  const { factory, calls } = fakeController({ failWith: Object.assign(new Error("boom"), { code: "mcp_timeout" }) });
  const result = await testMcpServer({ entry: server(), configValues: { NOTES_API_KEY: "configured" }, controllerFactory: factory });
  assert.equal(result.outcome, "unreachable");
  assert.equal(result.code, "mcp_timeout");
  assert.deepEqual(calls.closed, ["tested"]);
});

test("saving the MCP file changes the effective configuration revision", async (context) => {
  const { environment, cwd } = await fixture(context);
  const before = await handleSettingsRequest({ operation: "get" }, { environment, cwd });
  await handleSettingsRequest(
    { operation: "save_mcp", servers: [server()], expected_revision: MISSING_MCP_REVISION },
    { environment, cwd },
  );
  const after = await handleSettingsRequest({ operation: "get" }, { environment, cwd });
  // Without this the surface would report the new server list as already
  // loaded, when the runtime has not read it yet.
  assert.notEqual(after.effective_revision, before.effective_revision);
});

test("an untouched MCP file keeps the revision stable", async (context) => {
  const { environment, cwd } = await fixture(context);
  const first = await handleSettingsRequest({ operation: "get" }, { environment, cwd });
  const second = await handleSettingsRequest({ operation: "get" }, { environment, cwd });
  assert.equal(first.effective_revision, second.effective_revision);
});
