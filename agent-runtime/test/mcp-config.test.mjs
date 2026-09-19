import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_CONFIG_LIMITS,
  McpConfigError,
  resolveServerEnvironment,
  serverFingerprint,
  validateServerConfig,
  validateServerConfigs,
} from "../src/mcp-config.mjs";

function expectRefusal(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof McpConfigError, `expected McpConfigError, got ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

const NODE_EXE = "C:\\Program Files\\nodejs\\node.exe";
const base = {
  id: "search",
  display_name: "Search server",
  command: NODE_EXE,
  args: ["C:\\servers\\search.mjs"],
};

test("accepts a well-formed stdio server configuration", () => {
  const config = validateServerConfig(base);
  assert.equal(config.id, "search");
  assert.equal(config.display_name, "Search server");
  assert.equal(config.transport, "stdio");
  assert.deepEqual(config.args, ["C:\\servers\\search.mjs"]);
  assert.ok(Object.isFrozen(config));
});

test("a configured server is inert until it is enabled and acknowledged", () => {
  const config = validateServerConfig(base);
  assert.equal(config.enabled, false);
  assert.equal(config.trust_acknowledged, false);
  const enabled = validateServerConfig({ ...base, enabled: true });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.trust_acknowledged, false);
});

test("refuses a server id that is not a stable lowercase identifier", () => {
  expectRefusal(() => validateServerConfig({ ...base, id: "Search" }), "mcp_config_invalid");
  expectRefusal(() => validateServerConfig({ ...base, id: "with space" }), "mcp_config_invalid");
  expectRefusal(() => validateServerConfig({ ...base, id: "" }), "mcp_config_invalid");
  expectRefusal(
    () => validateServerConfig({ ...base, id: "x".repeat(MCP_CONFIG_LIMITS.maxServerIdBytes + 1) }),
    "mcp_config_invalid",
  );
});

test("refuses an unsupported transport", () => {
  expectRefusal(() => validateServerConfig({ ...base, transport: "http" }), "mcp_config_invalid");
});

test("refuses a literal environment value so no secret can live in a server config", () => {
  // A configuration file is ordinary JSON that gets displayed and copied; the
  // format itself has no field that accepts a secret.
  expectRefusal(
    () => validateServerConfig({ ...base, env: { SEARCH_API_KEY: "sk-live-abcdef" } }),
    "mcp_secret_must_be_indirect",
  );
});

test("accepts environment indirection by name", () => {
  const config = validateServerConfig({
    ...base,
    env: { SEARCH_API_KEY: { from_config: "SEARCH_KEY" } },
  });
  assert.deepEqual(config.env, { SEARCH_API_KEY: { from_config: "SEARCH_KEY" } });
});

test("refuses a malformed environment entry", () => {
  expectRefusal(
    () => validateServerConfig({ ...base, env: { KEY: { value: "x" } } }),
    "mcp_config_invalid",
  );
  expectRefusal(
    () => validateServerConfig({ ...base, env: { "not-a-name": { from_config: "X" } } }),
    "mcp_config_invalid",
  );
  expectRefusal(
    () => validateServerConfig({ ...base, env: { KEY: { from_config: "not a name" } } }),
    "mcp_config_invalid",
  );
});

test("refuses an argument list past its bounds", () => {
  expectRefusal(
    () => validateServerConfig({ ...base, args: Array.from({ length: 33 }, () => "a") }),
    "mcp_config_invalid",
  );
  expectRefusal(() => validateServerConfig({ ...base, args: "not-an-array" }), "mcp_config_invalid");
  expectRefusal(() => validateServerConfig({ ...base, args: [42] }), "mcp_config_invalid");
});

test("refuses duplicate server ids", () => {
  expectRefusal(
    () => validateServerConfigs([base, { ...base, display_name: "Another" }]),
    "duplicate_mcp_server",
  );
});

test("refuses more servers than the limit", () => {
  const many = Array.from({ length: MCP_CONFIG_LIMITS.maxServers + 1 }, (_v, index) => ({
    ...base,
    id: `server-${index}`,
  }));
  expectRefusal(() => validateServerConfigs(many), "mcp_config_invalid");
});

test("the fingerprint is stable and covers identity-bearing fields", () => {
  const config = validateServerConfig(base);
  assert.equal(config.fingerprint, validateServerConfig(base).fingerprint);

  const otherArgs = validateServerConfig({ ...base, args: ["other.mjs"] });
  assert.notEqual(config.fingerprint, otherArgs.fingerprint);

  const otherCommand = validateServerConfig({ ...base, command: "C:\\other\\node.exe" });
  assert.notEqual(config.fingerprint, otherCommand.fingerprint);

  const otherEnv = validateServerConfig({ ...base, env: { A: { from_config: "B" } } });
  assert.notEqual(config.fingerprint, otherEnv.fingerprint);
});

test("the fingerprint does not change when only presentation or enablement changes", () => {
  // Repointing the display name or toggling enablement does not change what the
  // server is, so it must not invalidate discovered tools.
  const config = validateServerConfig(base);
  const renamed = validateServerConfig({ ...base, display_name: "Renamed", enabled: true });
  assert.equal(config.fingerprint, renamed.fingerprint);
});

test("environment resolves from Aside's own configuration, not the process environment", () => {
  const config = validateServerConfig({
    ...base,
    env: { SEARCH_API_KEY: { from_config: "SEARCH_KEY" }, OTHER: { from_config: "MISSING_KEY" } },
  });
  const resolved = resolveServerEnvironment(config, { SEARCH_KEY: "sk-live-abcdef" });
  assert.deepEqual(resolved.environment, { SEARCH_API_KEY: "sk-live-abcdef" });
  assert.deepEqual(resolved.missing, [{ name: "OTHER", from_config: "MISSING_KEY" }]);
});

test("a configured-but-unset reference is reported rather than silently omitted", () => {
  const config = validateServerConfig({ ...base, env: { KEY: { from_config: "NOPE" } } });
  const resolved = resolveServerEnvironment(config, {});
  assert.deepEqual(resolved.environment, {});
  assert.equal(resolved.missing.length, 1);
});

test("on Windows a command that would route through cmd.exe is refused", () => {
  // The SDK passes `shell: false`, but cross-spawn overrides it on Windows for
  // anything that is not .exe/.com, and cmd.exe expands %NAME% inside
  // arguments — which is how a copied configuration could expand a secret.
  if (process.platform !== "win32") {
    assert.ok(true, "shell routing is a Windows-only behavior");
    return;
  }
  for (const command of ["npx.cmd", "C:\\tools\\run.bat", "node", "C:\\shims\\server"]) {
    expectRefusal(
      () => validateServerConfig({ ...base, command }),
      "mcp_command_shell_required",
    );
  }
  assert.equal(validateServerConfig({ ...base, command: "C:\\tools\\run.exe" }).command, "C:\\tools\\run.exe");
});
