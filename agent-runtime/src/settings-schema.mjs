import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const SETTINGS_SCHEMA_VERSION = 1;
export const SETTINGS_MAX_BYTES = 64 * 1024;
export const SETTINGS_PROVIDERS = Object.freeze(["openai", "anthropic", "deepseek", "google"]);
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
});

export class SettingsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SettingsError";
    this.code = code;
  }
}

export function validateCredentialValues(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.entries(value).some(([provider, key]) => !SETTINGS_PROVIDERS.includes(provider)
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
    if (!Object.hasOwn(SETTINGS_FIELDS, field)) {
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
    if (field === "provider" && !SETTINGS_PROVIDERS.includes(normalized)) {
      throw new SettingsError("settings_invalid_provider", "Choose a supported Aside provider.");
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
