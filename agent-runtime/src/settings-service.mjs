import { describeAsideSettings, loadAsideConfig } from "./config.mjs";
import { SETTINGS_FIELDS, SettingsError, validateSettingsDocument } from "./settings-schema.mjs";
import { saveUserSettings } from "./settings-store.mjs";

/**
 * Resolve the saved thinking level against the model the configuration selects.
 *
 * The settings surface must show what a task would actually use, not the raw
 * saved string. Resolution reuses the provider selection the runtime performs,
 * so an unsupported level is reported as adjusted here exactly as it will be at
 * runtime. A model that cannot be selected is reported without an applied
 * level rather than guessing one.
 */
async function describeThinking(configuration) {
  try {
    const { selectConfiguredProvider } = await import("./provider-settings.mjs");
    const { resolveThinkingLevel } = await import("./thinking-level.mjs");
    const { model } = await selectConfiguredProvider(configuration);
    return resolveThinkingLevel(model, configuration.publicValues.thinking_level);
  } catch {
    // An unselectable model already surfaces through the existing diagnostics.
    return null;
  }
}

/**
 * Projects the MCP file for the settings surface.
 *
 * The server entries travel as the user wrote them, because that is what the
 * editor has to show and save. Environment entries are references by
 * construction — `validateServerConfig` refuses a literal — so including them
 * cannot leak a secret. The classified-tool digests are included so the surface
 * can say a classification still matches this server.
 */
function describeMcpFile(file) {
  return {
    path: file.path,
    revision: file.revision,
    exists: file.exists === true,
    servers: file.servers.map(({ raw, config }) => ({
      raw,
      id: config.id,
      display_name: config.display_name,
      enabled: config.enabled,
      trust_acknowledged: config.trust_acknowledged,
      fingerprint: config.fingerprint,
      command: config.command,
      args: config.args,
      cwd: config.cwd ?? null,
      // Names only: this is a reference map, not a value map.
      environment: Object.entries(config.env).map(([name, reference]) => ({
        name,
        from_config: reference.from_config,
      })),
      classifications: Object.entries(config.tool_classifications).map(([tool, classification]) => ({
        tool,
        ...classification,
        // A digest that no longer matches the current server means the
        // classification was approved against a different configuration.
        stale: classification.server_fingerprint !== undefined
          && classification.server_fingerprint !== config.fingerprint,
      })),
    })),
    diagnostics: file.diagnostics,
  };
}

const SETTINGS_OPERATIONS = Object.freeze([
  "get",
  "save",
  "import_legacy",
  "catalog",
  "test_connection",
  // MCP configuration is edited through this service rather than a second
  // control process: it is the same file lifecycle (read, validate, atomically
  // replace, detect external edits) applied to `mcp.json`.
  "get_mcp",
  "save_mcp",
  "test_mcp",
]);

export async function handleSettingsRequest(request, { environment = process.env, cwd = process.cwd(), credentialValues, mcpControllerFactory } = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request) || !SETTINGS_OPERATIONS.includes(request.operation)) {
    throw new SettingsError("settings_invalid_request", "The settings request is invalid.");
  }
  const allowed = request.operation === "save"
    ? ["operation", "document", "expected_revision"]
    : request.operation === "import_legacy"
      ? ["operation", "expected_revision"]
      : request.operation === "save_mcp"
        ? ["operation", "servers", "expected_revision"]
        : request.operation === "test_mcp" ? ["operation", "server"]
          : request.operation === "catalog" ? ["operation", "provider"] : ["operation"];
  if (Object.keys(request).some((field) => !allowed.includes(field))) {
    throw new SettingsError("settings_invalid_request", "The settings request contains unsupported fields.");
  }
  if (request.operation === "catalog") {
    const { getProviderCatalog } = await import("./provider-settings.mjs");
    return getProviderCatalog(request.provider);
  }
  const configuration = await loadAsideConfig({ environment, cwd, credentialValues });
  if (request.operation === "get_mcp") {
    const { readMcpConfigFile } = await import("./mcp-store.mjs");
    const file = await readMcpConfigFile({ path: configuration.mcpConfigPath });
    return { ...describeMcpFile(file), effective_revision: configuration.effectiveRevision };
  }
  if (request.operation === "save_mcp") {
    const { writeMcpConfigFile, readMcpConfigFile } = await import("./mcp-store.mjs");
    await writeMcpConfigFile({
      path: configuration.mcpConfigPath,
      servers: request.servers,
      expectedRevision: request.expected_revision,
    });
    const saved = await readMcpConfigFile({ path: configuration.mcpConfigPath });
    return { ...describeMcpFile(saved), effective_revision: configuration.effectiveRevision };
  }
  if (request.operation === "test_mcp") {
    const { testMcpServer } = await import("./mcp-test.mjs");
    return testMcpServer({
      entry: request.server,
      configValues: configuration.values,
      controllerFactory: mcpControllerFactory,
    });
  }
  if (request.operation === "test_connection") {
    const { testProviderConnection } = await import("./provider-settings.mjs");
    const result = await testProviderConnection(configuration);
    return { ...result, effective_revision: configuration.effectiveRevision };
  }
  if (request.operation === "get") {
    return { ...describeAsideSettings(configuration), thinking: await describeThinking(configuration) };
  }
  const document = request.operation === "save"
    ? { ...validateSettingsDocument(request.document) }
    : { ...configuration.settings.document };
  if (request.operation === "import_legacy") {
    for (const [field, variable] of Object.entries(SETTINGS_FIELDS)) {
      if (Object.hasOwn(configuration.legacyValues, variable) && !Object.hasOwn(document, field)) {
        document[field] = configuration.legacyValues[variable].trim() || null;
      }
    }
  }
  if (!Object.hasOwn(document, "mcp_config_path")) {
    document.mcp_config_path = Object.hasOwn(configuration.settings.document, "mcp_config_path")
      ? configuration.settings.document.mcp_config_path
      : configuration.legacyValues.ASIDE_MCP_CONFIG_PATH?.trim()
        || configuration.defaultMcpConfigPath;
  }
  await saveUserSettings({ document, expectedRevision: request.expected_revision, environment });
  const saved = await loadAsideConfig({ environment, cwd, credentialValues });
  return { ...describeAsideSettings(saved), thinking: await describeThinking(saved) };
}
