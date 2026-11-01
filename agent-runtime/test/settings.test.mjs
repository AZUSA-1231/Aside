import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { describeAsideSettings, loadAsideConfig } from "../src/config.mjs";
import { createConfiguredAgent } from "../src/runtime.mjs";
import { createAsideConversationRuntime } from "../src/session.mjs";
import { runSettingsControl } from "../src/settings-control.mjs";
import { handleSettingsRequest } from "../src/settings-service.mjs";
import { getAsideSettingsPath, SETTINGS_MAX_BYTES, validateSettingsDocument } from "../src/settings-schema.mjs";
import { readUserSettings, saveUserSettings } from "../src/settings-store.mjs";
import { getProviderCatalog, testProviderConnection } from "../src/provider-settings.mjs";
import { createServer } from "node:http";

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "aside-settings-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const environment = { LOCALAPPDATA: join(root, "data"), ASIDE_SETTINGS_PATH: join(root, "data", "Aside", "settings.json") };
  return { root, environment, cwd: root };
}

async function writeSettings(options, document) {
  await mkdir(dirname(options.environment.ASIDE_SETTINGS_PATH), { recursive: true });
  await writeFile(options.environment.ASIDE_SETTINGS_PATH, JSON.stringify(document));
}

test("native default directory is projected without creating files and obeys settings and environment priority", async (context) => {
  const options = await fixture(context);
  const suggested = join(options.root, "documents", "Aside");
  const environment = { ...options.environment, ASIDE_DEFAULT_WORKSPACE_ROOT: suggested };
  const first = await handleSettingsRequest({ operation: "get" }, { ...options, environment });
  assert.equal(first.effective.workspace_root, suggested);
  assert.equal(first.default_workspace_root, suggested);
  assert.equal(first.sources.workspace_root.kind, "default");
  assert.ok(first.runtime_fields.includes("workspace_root"));
  await assert.rejects(readFile(suggested), { code: "ENOENT" });
  const custom = join(options.root, "custom-output");
  const saved = await handleSettingsRequest({ operation: "save", document: { schema_version: 1, workspace_root: custom }, expected_revision: first.revision }, { ...options, environment });
  assert.equal(saved.effective.workspace_root, custom);
  assert.equal(saved.sources.workspace_root.kind, "settings");
  const overridden = await handleSettingsRequest({ operation: "get" }, { ...options, environment: { ...environment, ASIDE_WORKSPACE_ROOT: join(options.root, "env-output") } });
  assert.equal(overridden.sources.workspace_root.kind, "environment");
  const restored = await handleSettingsRequest({ operation: "save", document: { schema_version: 1, workspace_root: null }, expected_revision: saved.revision }, { ...options, environment });
  assert.equal(restored.effective.workspace_root, suggested);
  assert.notEqual(restored.effective_revision, saved.effective_revision);
  await assert.rejects(readFile(custom), { code: "ENOENT" });
});

test("stored credentials override legacy, remain below process env, and never enter snapshots", async (context) => {
  const options = await fixture(context);
  await writeFile(join(options.root, ".env.local"), "OPENAI_API_KEY=legacy-private\n");
  const stored = await loadAsideConfig({ ...options, credentialValues: { openai: "stored-private" } });
  assert.equal(stored.values.OPENAI_API_KEY, "stored-private");
  assert.equal(stored.credentials.openai.source, "credential_store");
  assert.equal(stored.credentials.openai.stored, true);
  const inherited = await loadAsideConfig({ ...options, credentialValues: { openai: "stored-private" }, environment: { ...options.environment, OPENAI_API_KEY: "inherited-private" } });
  assert.equal(inherited.values.OPENAI_API_KEY, "inherited-private");
  assert.equal(inherited.credentials.openai.source, "environment");
  assert.equal(inherited.credentials.openai.stored, true);
  const blank = await loadAsideConfig({ ...options, credentialValues: { openai: "stored-private" }, environment: { ...options.environment, OPENAI_API_KEY: "" } });
  assert.equal(blank.credentials.openai.configured, false);
  assert.equal(blank.credentials.openai.source, "environment");
  assert.notEqual(stored.effectiveRevision, inherited.effectiveRevision);
  assert.doesNotMatch(JSON.stringify([describeAsideSettings(stored), describeAsideSettings(inherited)]), /stored-private|legacy-private|inherited-private/);
});

test("private settings envelope accepts credentials without writing or echoing them", async (context) => {
  const options = await fixture(context);
  let output = "";
  await runSettingsControl({ ...options, input: Readable.from([JSON.stringify({ operation: "get", credential_values: { google: "private-test-key" } })]), output: { write: (text) => { output += text; } } });
  assert.equal(JSON.parse(output).settings.credentials.google.source, "credential_store");
  assert.doesNotMatch(output, /private-test-key/);
  assert.deepEqual(await readdir(options.root), []);
});

test("real protocol process initializes from the private channel and rebuilds offline after a settings save", async (context) => {
  const options = await fixture(context);
  const entry = fileURLToPath(new URL("../src/protocol.mjs", import.meta.url));
  const child = spawn(process.execPath, [entry], {
    cwd: options.root, windowsHide: true,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...options.environment, ASIDE_PROVIDER: "deepseek", ASIDE_SESSION_ROOT: join(options.root, "sessions") },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const stopped = new Promise((resolve) => child.once("close", resolve));
  const timeout = setTimeout(() => child.kill(), 10_000);
  context.after(async () => { clearTimeout(timeout); if (child.exitCode === null) child.kill(); await stopped; });
  const events = [];
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  async function nextReady() {
    while (true) {
      const { value, done } = await lines.next();
      if (done) throw new Error("The protocol stopped before ready.");
      const event = JSON.parse(value);
      events.push(event);
      assert.notEqual(event.type, "runtime_unavailable", JSON.stringify(event));
      if (event.type === "ready") return event;
    }
  }
  child.stdin.write(`${JSON.stringify({ type: "initialize", credential_values: { deepseek: "private-process-fixture" } })}\n`);
  const first = await nextReady();
  const sessions = await readdir(join(options.root, "sessions"), { recursive: true });
  await handleSettingsRequest({ operation: "save", expected_revision: "missing", document: { schema_version: 1, api_url: "https://fixture.invalid/v1" } }, options);
  child.stdin.write(`${JSON.stringify({ type: "apply_settings", credential_values: { deepseek: "private-process-fixture" } })}\n`);
  const next = await nextReady();
  assert.notEqual(next.configuration_revision, first.configuration_revision);
  assert.deepEqual(await readdir(join(options.root, "sessions"), { recursive: true }), sessions);
  assert.equal(events.filter((event) => event.type === "history_restored").length, 1);
  assert.ok(events.some((event) => event.type === "runtime_reconfigured"));
  child.stdin.end();
  await stopped;
  assert.equal(child.exitCode, 0);
  assert.doesNotMatch(JSON.stringify(events), /private-process-fixture/);
});

test("provider catalogs are local, bounded projections of supported models", async (context) => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Catalog must not access the network"); };
  context.after(() => { globalThis.fetch = original; });
  for (const provider of ["openai", "anthropic", "deepseek", "google"]) {
    const catalog = await getProviderCatalog(provider);
    assert.equal(catalog.provider, provider);
    assert.ok(catalog.models.some((model) => model.id === catalog.default_model));
    for (const model of catalog.models) {
      assert.ok(model.context_window > 0 && model.max_tokens > 0);
      assert.ok(model.api && model.base_url && Array.isArray(model.thinking_levels));
      if (!model.reasoning) assert.deepEqual(model.thinking_levels, ["off"]);
    }
    assert.ok(Buffer.byteLength(JSON.stringify(catalog)) < 256 * 1024);
  }
  await assert.rejects(getProviderCatalog("private-unknown-provider"), (error) => error.code === "settings_invalid_provider" && !error.message.includes("private-unknown-provider"));
});

test("catalog remains accessible with corrupt settings and invalid environment provider", async (context) => {
  const options = await fixture(context);
  await mkdir(dirname(options.environment.ASIDE_SETTINGS_PATH), { recursive: true });
  await writeFile(options.environment.ASIDE_SETTINGS_PATH, "broken settings");
  const catalog = await handleSettingsRequest({ operation: "catalog", provider: "deepseek" }, { ...options, environment: { ...options.environment, ASIDE_PROVIDER: "unsupported" } });
  assert.equal(catalog.provider, "deepseek");
});

test("connection test uses a minimal real provider request against a local fixture and never creates a session", async (context) => {
  const options = await fixture(context);
  let requests = 0;
  let deny = false;
  const server = createServer(async (request, response) => {
    requests += 1;
    let input = "";
    for await (const chunk of request) input += chunk;
    const body = JSON.parse(input);
    assert.equal(request.headers.authorization, "Bearer fixture-private-key");
    assert.match(request.url, /chat\/completions$/);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content, "Reply OK.");
    assert.equal(body.tools, undefined);
    if (deny) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Invalid fixture-private-key", type: "authentication_error" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "test", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "test", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  await writeSettings(options, { schema_version: 1, provider: "deepseek", api_url: `http://127.0.0.1:${server.address().port}/v1` });
  const configured = await loadAsideConfig({ ...options, credentialValues: { deepseek: "fixture-private-key" } });
  const result = await testProviderConnection(configured);
  assert.equal(result.ok, true, JSON.stringify(result));
  deny = true;
  const denied = await testProviderConnection(configured);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "connection_denied");
  assert.doesNotMatch(JSON.stringify([result, denied]), /fixture-private-key/);
  assert.equal(requests, 2);
  assert.deepEqual(await readdir(dirname(options.environment.ASIDE_SETTINGS_PATH)), ["settings.json"]);
});

test("test connection never treats empty, rejected, aborted or timed out responses as success", async (context) => {
  const options = await fixture(context);
  const configuration = await loadAsideConfig({ ...options, credentialValues: { openai: "private-fixture-key" } });
  for (const response of [undefined, { role: "assistant", stopReason: "stop", content: [] }, { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "partial" }] }, { role: "assistant", stopReason: "error", errorMessage: "401 private-fixture-key" }]) {
    const result = await testProviderConnection(configuration, { select: async () => ({ providerId: "openai", model: { id: "fixture" }, models: { completeSimple: async () => response } }) });
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /private-fixture-key/);
  }
  let signal;
  const timeout = await testProviderConnection(configuration, { timeoutMs: 10, select: async () => ({ providerId: "openai", model: { id: "fixture" }, models: { completeSimple: (_model, _context, options) => { signal = options.signal; return new Promise(() => {}); } } }) });
  assert.equal(timeout.code, "connection_timeout");
  assert.equal(signal.aborted, true);
});

test("missing keys and unsupported models fail before a provider request", async (context) => {
  const options = await fixture(context);
  const configuration = await loadAsideConfig(options);
  assert.equal((await testProviderConnection(configuration)).code, "credential_missing");
  await writeSettings(options, { schema_version: 1, model: "not-a-supported-model" });
  await assert.rejects(testProviderConnection(await loadAsideConfig(options)), { code: "settings_invalid_model" });
});

test("settings are readable without provider startup and save no credentials", async (context) => {
  const options = await fixture(context);
  const snapshot = await handleSettingsRequest({ operation: "get" }, options);
  assert.equal(snapshot.revision, "missing");
  assert.equal(snapshot.effective.provider, "openai");
  assert.equal(snapshot.credentials.openai.configured, false);
  const saved = await handleSettingsRequest({ operation: "save", expected_revision: snapshot.revision, document: { schema_version: 1, provider: "anthropic" } }, options);
  assert.match(saved.revision, /^[a-f0-9]{64}$/u);
  assert.equal(saved.effective.provider, "anthropic");
  assert.equal(saved.sources.provider.kind, "settings");
  assert.equal(JSON.parse(await readFile(saved.path, "utf8")).provider, "anthropic");
});

test("environment overrides settings, which override legacy, including explicit clearing", async (context) => {
  const options = await fixture(context);
  await writeFile(join(options.root, ".env.local"), "ASIDE_PROVIDER=google\nASIDE_MODEL=legacy-model\nASIDE_API_URL=https://legacy.example/v1\nOPENAI_API_KEY=legacy-private-value\n");
  await writeSettings(options, { schema_version: 1, provider: "anthropic", model: "settings-model", api_url: null });
  const configuration = await loadAsideConfig({ ...options, environment: { ...options.environment, ASIDE_MODEL: "environment-model", OPENAI_API_KEY: "environment-private-value" } });
  assert.equal(configuration.values.ASIDE_PROVIDER, "anthropic");
  assert.equal(configuration.values.ASIDE_MODEL, "environment-model");
  assert.equal(configuration.values.ASIDE_API_URL, "");
  assert.deepEqual(configuration.fieldSources.model, { kind: "environment" });
  assert.equal(configuration.fieldSources.api_url.kind, "settings");
  assert.equal(configuration.credentials.openai.source, "environment");
  const snapshot = JSON.stringify(describeAsideSettings(configuration));
  assert.doesNotMatch(snapshot, /legacy-private-value|environment-private-value/u);
});

test("credential changes change the effective revision without exposing a key", async (context) => {
  const options = await fixture(context);
  const first = describeAsideSettings(await loadAsideConfig({ ...options, environment: { ...options.environment, OPENAI_API_KEY: "first-private-value" } }));
  const second = describeAsideSettings(await loadAsideConfig({ ...options, environment: { ...options.environment, OPENAI_API_KEY: "second-private-value" } }));
  assert.notEqual(first.effective_revision, second.effective_revision);
  assert.doesNotMatch(JSON.stringify([first, second]), /first-private-value|second-private-value/u);
});

test("Google credentials reflect the variable used by the installed provider", async (context) => {
  const options = await fixture(context);
  const unsupported = await handleSettingsRequest({ operation: "get" }, { ...options, environment: { ...options.environment, GOOGLE_API_KEY: "not-used-private-value" } });
  assert.equal(unsupported.credentials.google.configured, false);
  const supported = await handleSettingsRequest({ operation: "get" }, { ...options, environment: { ...options.environment, GEMINI_API_KEY: "used-private-value" } });
  assert.equal(supported.credentials.google.configured, true);
  assert.doesNotMatch(JSON.stringify(supported), /used-private-value/u);
});

test("rejects credentials, unknown fields, invalid versions and malformed values", () => {
  for (const document of [
    { schema_version: 2 },
    { schema_version: 1, api_key: "private-value" },
    { schema_version: 1, OPENAI_API_KEY: "private-value" },
    JSON.parse('{"schema_version":1,"__proto__":{"polluted":true}}'),
    { schema_version: 1, provider: "unsupported" },
    { schema_version: 1, model: "invalid\nmodel" },
    { schema_version: 1, api_url: "https://user:private-value@example.test/v1" },
    { schema_version: 1, api_url: `https://example.test/${"long-path".repeat(1000)}` },
    { schema_version: 1, workspace_root: "relative/path" },
    { schema_version: 1, mcp_config_path: "relative.json" },
    { schema_version: 1, thinking_level: "unbounded" },
  ]) {
    assert.throws(() => validateSettingsDocument(document), (error) => !error.message.includes("private-value") && error.name === "SettingsError");
  }
  assert.equal({}.polluted, undefined);
});

test("revision mismatch preserves a concurrent external edit", async (context) => {
  const options = await fixture(context);
  const first = await saveUserSettings({ environment: options.environment, expectedRevision: "missing", document: { schema_version: 1, provider: "openai" } });
  const external = '{"schema_version":1,"provider":"google"}\n';
  await writeFile(first.path, external);
  await assert.rejects(saveUserSettings({ environment: options.environment, expectedRevision: first.revision, document: { schema_version: 1, provider: "anthropic" } }), { code: "settings_conflict" });
  assert.equal(await readFile(first.path, "utf8"), external);
  assert.deepEqual(await readdir(dirname(first.path)), ["settings.json"]);
});

test("requires a revision instead of silently overwriting settings", async (context) => {
  const options = await fixture(context);
  await assert.rejects(saveUserSettings({ environment: options.environment, document: { schema_version: 1 } }), { code: "settings_revision_required" });
  assert.equal((await readUserSettings(options)).revision, "missing");
});

test("failed atomic replacement preserves the old file and cleans temporary files", async (context) => {
  const options = await fixture(context);
  const first = await saveUserSettings({ environment: options.environment, expectedRevision: "missing", document: { schema_version: 1, provider: "openai" } });
  const oldText = await readFile(first.path, "utf8");
  await assert.rejects(saveUserSettings({ environment: options.environment, expectedRevision: first.revision, document: { schema_version: 1, provider: "google" }, replaceFile: async () => { throw Object.assign(new Error("private filesystem details"), { code: "EACCES" }); } }), (error) => error.code === "settings_write_failed" && !error.message.includes("private filesystem details"));
  assert.equal(await readFile(first.path, "utf8"), oldText);
  assert.deepEqual(await readdir(dirname(first.path)), ["settings.json"]);
});

test("concurrent saves from one revision cannot silently overwrite one another", async (context) => {
  const options = await fixture(context);
  const results = await Promise.allSettled(["google", "anthropic"].map((provider) => saveUserSettings({ environment: options.environment, expectedRevision: "missing", document: { schema_version: 1, provider } })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const failure = results.find((result) => result.status === "rejected");
  assert.ok(["settings_busy", "settings_conflict"].includes(failure.reason.code));
  assert.deepEqual(await readdir(dirname(options.environment.ASIDE_SETTINGS_PATH)), ["settings.json"]);
});

test("a live writer lock is not removed by a competing save", async (context) => {
  const options = await fixture(context);
  const lockPath = `${options.environment.ASIDE_SETTINGS_PATH}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  const lock = JSON.stringify({ pid: process.pid });
  await writeFile(lockPath, lock);
  await assert.rejects(saveUserSettings({ environment: options.environment, expectedRevision: "missing", document: { schema_version: 1 } }), { code: "settings_busy" });
  assert.equal(await readFile(lockPath, "utf8"), lock);
});

test("corrupt or oversized settings are reported and never replaced by defaults", async (context) => {
  const options = await fixture(context);
  for (const content of ["{ invalid private-value", JSON.stringify({ schema_version: 1, api_key: "private-value" }), " ".repeat(SETTINGS_MAX_BYTES + 1)]) {
    await mkdir(dirname(options.environment.ASIDE_SETTINGS_PATH), { recursive: true });
    await writeFile(options.environment.ASIDE_SETTINGS_PATH, content);
    await assert.rejects(handleSettingsRequest({ operation: "get" }, options));
    await assert.rejects(saveUserSettings({ environment: options.environment, expectedRevision: "missing", document: { schema_version: 1 } }));
    assert.equal(await readFile(options.environment.ASIDE_SETTINGS_PATH, "utf8"), content);
  }
});

test("legacy import copies ordinary fields and pins the old MCP path without copying keys", async (context) => {
  const options = await fixture(context);
  const legacy = join(options.root, ".env.local");
  const content = "ASIDE_PROVIDER=google\nASIDE_MODEL=legacy-model\nOPENAI_API_KEY=legacy-private-value\n";
  await writeFile(legacy, content);
  const snapshot = await handleSettingsRequest({ operation: "import_legacy", expected_revision: "missing" }, { ...options, environment: { ...options.environment, ASIDE_MODEL: "environment-model" } });
  const saved = JSON.parse(await readFile(snapshot.path, "utf8"));
  assert.equal(saved.model, "legacy-model");
  assert.equal(snapshot.effective.model, "environment-model");
  assert.equal(saved.mcp_config_path, join(options.root, "mcp.json"));
  assert.doesNotMatch(JSON.stringify(saved), /KEY|legacy-private-value/u);
  assert.equal(await readFile(legacy, "utf8"), content);
  await unlink(legacy);
  const afterRemoval = await handleSettingsRequest({ operation: "get" }, options);
  assert.equal(afterRemoval.effective.mcp_config_path, saved.mcp_config_path);
});

test("a first settings save preserves legacy MCP location even without import", async (context) => {
  const options = await fixture(context);
  await writeFile(join(options.root, ".env.local"), "ASIDE_PROVIDER=openai\n");
  const saved = await handleSettingsRequest({ operation: "save", expected_revision: "missing", document: { schema_version: 1, model: "gpt-4.1" } }, options);
  assert.equal(saved.document.mcp_config_path, join(options.root, "mcp.json"));
});

test("new users resolve MCP beside settings rather than the process working directory", async (context) => {
  const options = await fixture(context);
  const snapshot = await handleSettingsRequest({ operation: "get" }, options);
  assert.equal(snapshot.effective.mcp_config_path, join(dirname(snapshot.path), "mcp.json"));
});

test("an existing cwd MCP file remains selected and is pinned on first save", async (context) => {
  const options = await fixture(context);
  const path = join(options.root, "mcp.json");
  await writeFile(path, '{"servers":[]}');
  const snapshot = await handleSettingsRequest({ operation: "get" }, options);
  assert.equal(snapshot.effective.mcp_config_path, path);
  const saved = await handleSettingsRequest({ operation: "save", expected_revision: "missing", document: { schema_version: 1 } }, options);
  assert.equal(saved.document.mcp_config_path, path);
});

test("an explicit MCP default survives later edits without falling back to legacy", async (context) => {
  const options = await fixture(context);
  await writeFile(join(options.root, ".env.local"), "ASIDE_PROVIDER=openai\n");
  const first = await handleSettingsRequest({ operation: "save", expected_revision: "missing", document: { schema_version: 1, mcp_config_path: null } }, options);
  const second = await handleSettingsRequest({ operation: "save", expected_revision: first.revision, document: { schema_version: 1, model: "gpt-4.1" } }, options);
  assert.equal(second.document.mcp_config_path, null);
  assert.equal(second.effective.mcp_config_path, join(dirname(first.path), "mcp.json"));
});

test("an invalid legacy endpoint is redacted from the settings readback", async (context) => {
  const options = await fixture(context);
  await writeFile(join(options.root, ".env.local"), "ASIDE_API_URL=https://user:private-value@example.test/v1\n");
  const snapshot = await handleSettingsRequest({ operation: "get" }, options);
  assert.equal(snapshot.effective.api_url, null);
  assert.equal(snapshot.diagnostics[0].code, "settings_invalid_url");
  assert.doesNotMatch(JSON.stringify(snapshot), /private-value/u);
});

test("settings service rejects unknown request fields without echoing payloads", async (context) => {
  const options = await fixture(context);
  await assert.rejects(handleSettingsRequest({ operation: "get", api_key: "private-value" }, options), (error) => error.code === "settings_invalid_request" && !error.message.includes("private-value"));
});

test("settings control is usable as an independent packaged sibling process", async (context) => {
  const options = await fixture(context);
  const helper = fileURLToPath(new URL("../src/settings-control.mjs", import.meta.url));
  const child = spawnSync(process.execPath, [helper], { cwd: options.cwd, env: { ...options.environment, ASIDE_PROVIDER: "invalid-provider", OPENAI_API_KEY: "private-value" }, input: JSON.stringify({ operation: "get" }), encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.settings.effective.provider, "invalid-provider");
  assert.doesNotMatch(child.stdout, /private-value/u);
  assert.equal((await readdir(options.root)).length, 0);
});

test("control reports bounded, sanitized JSON errors", async (context) => {
  const options = await fixture(context);
  for (const text of ["{ private-value", " ".repeat(SETTINGS_MAX_BYTES + 1)]) {
    let output = "";
    await runSettingsControl({ ...options, input: Readable.from([text]), output: { write: (chunk) => { output += chunk; } } });
    const result = JSON.parse(output);
    assert.equal(result.ok, false);
    assert.doesNotMatch(output, /private-value/u);
  }
});

test("settings path override must be absolute", () => {
  assert.throws(() => getAsideSettingsPath({ ASIDE_SETTINGS_PATH: "relative.json" }), { code: "settings_invalid_path" });
  assert.equal(getAsideSettingsPath({ LOCALAPPDATA: join(tmpdir(), "aside-test") }), join(tmpdir(), "aside-test", "Aside", "settings.json"));
});

test("an agent retains its loaded snapshot after settings change", async (context) => {
  const options = await fixture(context);
  const first = await handleSettingsRequest({ operation: "save", expected_revision: "missing", document: { schema_version: 1, provider: "openai", model: "gpt-4.1", api_url: "https://first.example/v1" } }, options);
  const configured = await createConfiguredAgent({ configCwd: options.cwd, environment: options.environment });
  const second = await handleSettingsRequest({ operation: "save", expected_revision: first.revision, document: { ...first.document, api_url: "https://second.example/v1" } }, options);
  assert.equal(configured.agent.state.model.baseUrl, "https://first.example/v1");
  assert.equal(configured.configurationRevision, first.effective_revision);
  assert.notEqual(configured.configurationRevision, second.effective_revision);
  const next = await createConfiguredAgent({ configCwd: options.cwd, environment: options.environment });
  assert.equal(next.agent.state.model.baseUrl, "https://second.example/v1");
  assert.equal(next.configurationRevision, second.effective_revision);
});

test("session initialization honors configCwd, environment and the file-configured session root", async (context) => {
  const options = await fixture(context);
  const sessionRoot = join(options.root, "history");
  const mcpPath = join(options.root, "custom-mcp.json");
  await writeFile(join(options.root, ".env.local"), `ASIDE_PROVIDER=unsupported\nASIDE_MODEL=gpt-4.1\nASIDE_API_URL=https://configured.example/v1\nASIDE_SESSION_ROOT=${sessionRoot}\n`);
  await writeFile(mcpPath, "not-json");
  await writeSettings(options, { schema_version: 1, mcp_config_path: mcpPath });
  const events = [];
  const runtime = await createAsideConversationRuntime({ configCwd: options.cwd, environment: { ...options.environment, ASIDE_PROVIDER: "openai" }, emit: (event) => events.push(event) });
  context.after(() => runtime.dispose());
  assert.equal(runtime.agent.state.model.id, "gpt-4.1");
  assert.equal(runtime.agent.state.model.baseUrl, "https://configured.example/v1");
  assert.ok((await readdir(sessionRoot)).length > 0);
  assert.ok(events.some((event) => event.type === "runtime_warning" && event.code === "mcp_config_unparseable"));
  const ready = events.find((event) => event.type === "ready");
  assert.equal(ready.configuration_revision, (await handleSettingsRequest({ operation: "get" }, { ...options, environment: { ...options.environment, ASIDE_PROVIDER: "openai" } })).effective_revision);
});
