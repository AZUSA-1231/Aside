import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import {
  absoluteSettingsPath,
  getAsideConfigRoot,
  normalizeAsideApiUrl,
  PROVIDER_CREDENTIAL_NAMES,
  SETTINGS_FIELDS,
  validateCredentialValues,
} from "./settings-schema.mjs";
import { readUserSettings } from "./settings-store.mjs";

export { normalizeAsideApiUrl } from "./settings-schema.mjs";

export const ASIDE_PROJECT_CONFIG_NAME = ".env.local";
export const ASIDE_PACKAGED_CONFIG_NAME = "config.env";

export class AsideConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AsideConfigurationError";
  }
}

function isMissingFile(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

function copyEnvironment(environment) {
  const values = {};
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (typeof value === "string") values[key] = value;
  }
  return values;
}

function projectConfigCandidates(startDirectory) {
  const candidates = [];
  let directory = resolve(startDirectory);
  while (true) {
    candidates.push(join(directory, ASIDE_PROJECT_CONFIG_NAME));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return candidates;
}

function packagedConfigPath(environment) {
  return join(getAsideConfigRoot(environment), ASIDE_PACKAGED_CONFIG_NAME);
}

export function getAsideConfigCandidates({ cwd = process.cwd(), environment = process.env } = {}) {
  const candidates = projectConfigCandidates(cwd);
  const packaged = packagedConfigPath(environment);
  if (!candidates.includes(packaged)) candidates.push(packaged);
  return candidates;
}

export function parseAsideEnv(content, source = ASIDE_PROJECT_CONFIG_NAME) {
  if (typeof content !== "string") {
    throw new AsideConfigurationError(`Aside configuration file ${source} is invalid.`);
  }

  let parsed;
  try {
    parsed = parseEnv(content);
  } catch {
    throw new AsideConfigurationError(`Aside configuration file ${source} is invalid.`);
  }

  const values = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string") {
      throw new AsideConfigurationError(`Aside configuration file ${source} is invalid.`);
    }
    values[key] = value;
  }
  return values;
}

async function readConfigFile(path, readTextFile) {
  let content;
  try {
    content = await readTextFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw new AsideConfigurationError(`Aside could not read configuration file ${path}.`);
  }
  return parseAsideEnv(content, path);
}

export async function loadAsideConfig({
  credentialValues = {},
  cwd = process.cwd(),
  environment = process.env,
  readTextFile = readFile,
} = {}) {
  let fileValues;
  let source;
  for (const candidate of getAsideConfigCandidates({ cwd, environment })) {
    const values = await readConfigFile(candidate, readTextFile);
    if (values === undefined) continue;
    fileValues = values;
    source = candidate;
    break;
  }

  const settings = await readUserSettings({ environment, ...(readTextFile === readFile ? {} : { readTextFile }) });
  const settingsValues = {};
  const fieldSources = {};
  const environmentValues = copyEnvironment(environment);
  for (const [field, variable] of Object.entries(SETTINGS_FIELDS)) {
    if (Object.hasOwn(settings.document, field)) settingsValues[variable] = settings.document[field] ?? "";
    fieldSources[field] = Object.freeze(Object.hasOwn(environmentValues, variable)
      ? { kind: "environment" }
      : Object.hasOwn(settingsValues, variable)
        ? { kind: "settings", path: settings.path }
        : Object.hasOwn(fileValues ?? {}, variable)
          ? { kind: "legacy", path: source }
          : { kind: "default" });
  }
  const storedCredentials = validateCredentialValues(credentialValues);
  const credentialEnvironment = Object.fromEntries(Object.entries(storedCredentials)
    .map(([provider, key]) => [PROVIDER_CREDENTIAL_NAMES[provider][0], key]));
  const values = Object.freeze({
    ...(fileValues ?? {}),
    ...settingsValues,
    ...credentialEnvironment,
    ...environmentValues,
  });
  let defaultMcpConfigPath = join(source ? dirname(source) : dirname(settings.path), "mcp.json");
  if (!source) {
    const oldPath = join(cwd, "mcp.json");
    try {
      if ((await stat(oldPath)).isFile()) defaultMcpConfigPath = oldPath;
    } catch (error) {
      if (error?.code !== "ENOENT") defaultMcpConfigPath = oldPath;
    }
  }
  const mcpConfigPath = getAsideConfigValue(values, "ASIDE_MCP_CONFIG_PATH")
    ?? (fieldSources.mcp_config_path.kind === "settings"
      ? join(dirname(settings.path), "mcp.json")
      : defaultMcpConfigPath);
  const publicValues = {};
  for (const [field, variable] of Object.entries(SETTINGS_FIELDS)) {
    publicValues[field] = getAsideConfigValue(values, variable) ?? null;
  }
  publicValues.provider ??= "openai";
  const defaultWorkspaceRoot = getAsideConfigValue(environmentValues, "ASIDE_DEFAULT_WORKSPACE_ROOT") ?? null;
  publicValues.workspace_root ??= defaultWorkspaceRoot;
  publicValues.thinking_level ??= "off";
  publicValues.mcp_config_path = mcpConfigPath;
  const credentials = {};
  for (const [provider, names] of Object.entries(PROVIDER_CREDENTIAL_NAMES)) {
    const name = names.find((candidate) => getAsideConfigValue(values, candidate));
    credentials[provider] = Object.freeze({
      configured: name !== undefined,
      source: names.some((candidate) => Object.hasOwn(environmentValues, candidate)) ? "environment" : !name ? "none"
        : Object.hasOwn(storedCredentials, provider) ? "credential_store" : "legacy",
      stored: Object.hasOwn(storedCredentials, provider),
    });
  }
  const effectiveRevision = createHash("sha256")
    .update(JSON.stringify({
      values: publicValues,
      credentials,
      credential_revision: createHash("sha256")
        .update(JSON.stringify(Object.values(PROVIDER_CREDENTIAL_NAMES).flat().map((name) => values[name] ?? null)))
        .digest("hex"),
      session_root: getAsideConfigValue(values, "ASIDE_SESSION_ROOT") ?? null,
    }))
    .digest("hex");
  return Object.freeze({
    values,
    source,
    legacyValues: Object.freeze({ ...fileValues }),
    settings,
    fieldSources: Object.freeze(fieldSources),
    publicValues: Object.freeze(publicValues),
    credentials: Object.freeze(credentials),
    mcpConfigPath,
    defaultMcpConfigPath,
    defaultWorkspaceRoot,
    protectedWorkspacePaths: [getAsideConfigRoot(values), settings.path, source, mcpConfigPath,
      getAsideConfigValue(values, "ASIDE_SESSION_ROOT")].filter(Boolean).map((path) => resolve(path)),
    effectiveRevision,
  });
}

export function getAsideConfigValue(values, key) {
  const value = values?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function describeAsideSettings(configuration) {
  const values = { ...configuration.publicValues };
  const diagnostics = [];
  try {
    if (values.workspace_root) values.workspace_root = absoluteSettingsPath(values.workspace_root, "Default directory");
  } catch {
    diagnostics.push({ code: "settings_invalid_workspace", field: "workspace_root", message: "The effective default directory must be an absolute local path. Correct its configuration source." });
  }
  try {
    values.api_url = normalizeAsideApiUrl(values.api_url) ?? null;
  } catch {
    values.api_url = null;
    diagnostics.push({ code: "settings_invalid_url", field: "api_url", message: "The effective API URL is invalid. Correct its configuration source." });
  }
  return {
    schema_version: 1,
    path: configuration.settings.path,
    revision: configuration.settings.revision,
    effective_revision: configuration.effectiveRevision,
    document: configuration.settings.document,
    effective: values,
    sources: configuration.fieldSources,
    credentials: configuration.credentials,
    legacy_source: configuration.source ?? null,
    default_workspace_root: configuration.defaultWorkspaceRoot,
    diagnostics,
    runtime_fields: ["provider", "model", "api_url", "workspace_root", "mcp_config_path"],
  };
}
