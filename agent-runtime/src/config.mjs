import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";

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
  const localAppData = String(environment?.LOCALAPPDATA ?? "").trim();
  const configRoot =
    localAppData ||
    (process.platform === "win32"
      ? join(homedir(), "AppData", "Local")
      : String(environment?.XDG_CONFIG_HOME ?? "").trim() || join(homedir(), ".config"));
  return join(configRoot, "Aside", ASIDE_PACKAGED_CONFIG_NAME);
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

/**
 * Loads configuration without mutating process.env. Existing environment
 * values win over file values so tests and packaged launchers can override a
 * local default deliberately.
 */
export async function loadAsideConfig({
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

  const values = Object.freeze({
    ...(fileValues ?? {}),
    ...copyEnvironment(environment),
  });
  return Object.freeze({ values, source });
}

export function getAsideConfigValue(values, key) {
  const value = values?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeAsideApiUrl(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return undefined;

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AsideConfigurationError(
      "ASIDE_API_URL must be a valid HTTP or HTTPS provider URL.",
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new AsideConfigurationError(
      "ASIDE_API_URL must be an HTTP or HTTPS provider URL without credentials, query, or fragment.",
    );
  }
  return url.toString().replace(/\/+$/, "");
}
