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

export async function handleSettingsRequest(request, { environment = process.env, cwd = process.cwd(), credentialValues } = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request) || !["get", "save", "import_legacy", "catalog", "test_connection"].includes(request.operation)) {
    throw new SettingsError("settings_invalid_request", "The settings request is invalid.");
  }
  const allowed = request.operation === "save"
    ? ["operation", "document", "expected_revision"]
    : request.operation === "import_legacy"
      ? ["operation", "expected_revision"]
      : request.operation === "catalog" ? ["operation", "provider"] : ["operation"];
  if (Object.keys(request).some((field) => !allowed.includes(field))) {
    throw new SettingsError("settings_invalid_request", "The settings request contains unsupported fields.");
  }
  if (request.operation === "catalog") {
    const { getProviderCatalog } = await import("./provider-settings.mjs");
    return getProviderCatalog(request.provider);
  }
  const configuration = await loadAsideConfig({ environment, cwd, credentialValues });
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
