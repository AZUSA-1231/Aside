import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const SETTINGS_SCHEMA_VERSION = 1;
export const SETTINGS_MAX_BYTES = 64 * 1024;
/**
 * Providers with a built-in model catalog.
 *
 * `custom` is deliberately absent: it has no catalog, its model id is
 * user-declared, and treating it as a catalog provider would let a custom
 * model id be looked up as if the vendor shipped it.
 */
export const SETTINGS_PROVIDERS = Object.freeze(["openai", "anthropic", "deepseek", "google"]);
export const CUSTOM_PROVIDER_ID = "custom";
/** Every accepted `provider` setting value. */
export const SETTINGS_PROVIDER_VALUES = Object.freeze([...SETTINGS_PROVIDERS, CUSTOM_PROVIDER_ID]);
/**
 * Credential slots. The custom route keeps its key separate from every
 * built-in vendor's, both in the native store and in this list, so a custom
 * Base URL can never inherit an OpenAI key.
 */
export const SETTINGS_CREDENTIAL_PROVIDERS = SETTINGS_PROVIDER_VALUES;
export const SETTINGS_THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const SETTINGS_FIELDS = Object.freeze({
  provider: "ASIDE_PROVIDER",
  model: "ASIDE_MODEL",
  api_url: "ASIDE_API_URL",
  thinking_level: "ASIDE_THINKING_LEVEL",
  workspace_root: "ASIDE_WORKSPACE_ROOT",
  mcp_config_path: "ASIDE_MCP_CONFIG_PATH",
});
export const PROVIDER_CREDENTIAL_NAMES = Object.freeze({
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  google: ["GEMINI_API_KEY"],
  custom: ["ASIDE_CUSTOM_API_KEY"],
});

/**
 * Custom-route settings fields.
 *
 * The route reuses `provider` (`custom`), `model`, and `api_url`. These fields
 * add what those three cannot express: which wire protocol to speak and the
 * capacity / capabilities the user declares. Keeping them in the same document
 * means one save path, one revision and one effective-source report.
 */
export const SETTINGS_CUSTOM_FIELDS = Object.freeze({
  custom_protocol: "ASIDE_CUSTOM_PROTOCOL",
  custom_model_name: "ASIDE_CUSTOM_MODEL_NAME",
  custom_context_window: "ASIDE_CUSTOM_CONTEXT_WINDOW",
  custom_max_output: "ASIDE_CUSTOM_MAX_OUTPUT",
  custom_reasoning: "ASIDE_CUSTOM_REASONING",
  custom_images: "ASIDE_CUSTOM_IMAGES",
  custom_tools: "ASIDE_CUSTOM_TOOLS",
});

/**
 * The wire protocols a custom route may declare.
 *
 * These are the two adapters the vendored Pi package ships for OpenAI-compatible
 * endpoints. A protocol outside this list is refused rather than routed to a
 * best guess.
 */
export const CUSTOM_PROTOCOLS = Object.freeze(["openai-completions", "openai-responses"]);
/** The environment variable the custom route's key is resolved from. */
export const CUSTOM_CREDENTIAL_NAME = PROVIDER_CREDENTIAL_NAMES.custom[0];

const CUSTOM_BOOLEAN_FIELDS = new Set(["custom_reasoning", "custom_images", "custom_tools"]);
const CUSTOM_CAPACITY_FIELDS = new Set(["custom_context_window", "custom_max_output"]);

export class SettingsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SettingsError";
    this.code = code;
  }
}

export function validateCredentialValues(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.entries(value).some(([provider, key]) => !SETTINGS_CREDENTIAL_PROVIDERS.includes(provider)
      || typeof key !== "string" || !/^[\x21-\x7e]{1,2048}$/.test(key))) {
    throw new SettingsError("credential_invalid", "The API key must contain 1–2048 printable characters without spaces.");
  }
  return { ...value };
}

export function normalizeAsideApiUrl(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return undefined;
  if (Buffer.byteLength(trimmed) > 4096) {
    throw new SettingsError("settings_invalid_url", "The provider URL exceeds the supported size.");
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new SettingsError("settings_invalid_url", "ASIDE_API_URL must be a valid HTTP or HTTPS provider URL.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new SettingsError("settings_invalid_url", "ASIDE_API_URL must be an HTTP or HTTPS provider URL without credentials, query, or fragment.");
  }
  return url.toString().replace(/\/+$/, "");
}

export function absoluteSettingsPath(value, field) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 4096 || /[\u0000-\u001f]/u.test(value) || !isAbsolute(value.trim())) {
    throw new SettingsError("settings_invalid_path", `${field} must be an absolute local path.`);
  }
  return value.trim();
}

export function getAsideConfigRoot(environment = process.env) {
  const localAppData = String(environment.LOCALAPPDATA ?? "").trim();
  const root = localAppData || (process.platform === "win32"
    ? join(homedir(), "AppData", "Local")
    : String(environment.XDG_CONFIG_HOME ?? "").trim() || join(homedir(), ".config"));
  return join(root, "Aside");
}

export function getAsideSettingsPath(environment = process.env) {
  if (Object.hasOwn(environment, "ASIDE_SETTINGS_PATH")) {
    return absoluteSettingsPath(environment.ASIDE_SETTINGS_PATH, "ASIDE_SETTINGS_PATH");
  }
  return join(getAsideConfigRoot(environment), "settings.json");
}

export function validateSettingsDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema_version !== SETTINGS_SCHEMA_VERSION) {
    throw new SettingsError("settings_invalid_schema", "Aside settings must be an object with schema_version 1.");
  }
  const document = { schema_version: SETTINGS_SCHEMA_VERSION };
  for (const [field, entry] of Object.entries(value)) {
    if (field === "schema_version") continue;
    if (!Object.hasOwn(SETTINGS_FIELDS, field) && !Object.hasOwn(SETTINGS_CUSTOM_FIELDS, field)) {
      throw new SettingsError("settings_unknown_field", "Aside settings contain an unsupported field. Credentials must not be stored in settings.json.");
    }
    if (entry === null && field !== "provider" && field !== "thinking_level") {
      document[field] = null;
      continue;
    }
    if (typeof entry !== "string" || !entry.trim()) {
      throw new SettingsError("settings_invalid_value", `The ${field} setting must be a non-empty string.`);
    }
    const normalized = entry.trim();
    if (field === "provider" && !SETTINGS_PROVIDER_VALUES.includes(normalized)) {
      throw new SettingsError("settings_invalid_provider", "Choose a supported Aside provider.");
    }
    if (CUSTOM_BOOLEAN_FIELDS.has(field) && normalized !== "true" && normalized !== "false") {
      throw new SettingsError("settings_invalid_value", `The ${field} setting must be true or false.`);
    }
    if (CUSTOM_CAPACITY_FIELDS.has(field) && (!/^[0-9]{1,9}$/u.test(normalized) || Number(normalized) < 1)) {
      throw new SettingsError("settings_invalid_value", `The ${field} setting must be a whole number of tokens.`);
    }
    if (field === "custom_protocol" && !CUSTOM_PROTOCOLS.includes(normalized)) {
      throw new SettingsError("settings_invalid_custom_protocol", "Choose Chat Completions or Responses for the custom route.");
    }
    if (field === "thinking_level" && !SETTINGS_THINKING_LEVELS.includes(normalized)) {
      throw new SettingsError("settings_invalid_thinking_level", "Choose a supported thinking level.");
    }
    if (field === "model" && !/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,199}$/u.test(normalized)) {
      throw new SettingsError("settings_invalid_model", "The model ID contains unsupported characters or is too long.");
    }
    document[field] = field === "api_url"
      ? normalizeAsideApiUrl(normalized)
      : field === "workspace_root" || field === "mcp_config_path"
        ? absoluteSettingsPath(normalized, field)
        : normalized;
  }
  return Object.freeze(document);
}
