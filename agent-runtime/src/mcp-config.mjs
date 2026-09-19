import { createHash } from "node:crypto";
import { byteLength, isPlainObject } from "./agent-contracts.mjs";
import {
  TOOL_EFFECTS,
  TOOL_EGRESS_VALUES,
  TOOL_REPLAY_POLICIES,
  TOOL_SCOPES,
} from "./capability-contract.mjs";

/**
 * Validation for user-configured MCP servers.
 *
 * Two properties are structural here rather than advisory, because a rule that
 * depends on the user doing the right thing is not a boundary:
 *
 * 1. **No secret can be written into a server configuration.** The `env` map
 *    holds indirection references only — a name to look up in Aside's own
 *    configuration — never a literal value. A configuration file is ordinary
 *    JSON that gets read, displayed, and potentially copied around, so the way
 *    to keep secrets out of it is to give the format no field that accepts one.
 *
 * 2. **The command cannot route through a shell on Windows.** This one is not
 *    obvious, and it was found by reading the dependency rather than assuming
 *    its behavior: the MCP SDK passes `shell: false` to `cross-spawn`, but
 *    `cross-spawn` overrides that on Windows for any command that is not a
 *    `.exe`/`.com`, building a `cmd.exe` command line instead.
 *
 *    That matters beyond tidiness. We pass secrets to the server through the
 *    environment, and `cmd.exe` expands `%NAME%` inside arguments. A
 *    configuration copied from a forum post containing `%SOME_KEY%` in an
 *    argument would therefore expand a real secret into the server's own
 *    command line. Requiring a directly executable command removes the shell,
 *    and with it the expansion. Node-based servers are configured as
 *    `node.exe <script>` rather than through a `.cmd` shim, which is a small
 *    cost for a boundary that does not depend on escaping being perfect.
 */

export const MCP_CONFIG_LIMITS = Object.freeze({
  maxServers: 8,
  maxServerIdBytes: 64,
  maxDisplayNameBytes: 120,
  maxCommandBytes: 512,
  maxArguments: 32,
  maxArgumentBytes: 1_024,
  maxTotalArgumentBytes: 8 * 1024,
  maxEnvironmentEntries: 16,
  maxEnvironmentNameBytes: 128,
  maxToolClassifications: 64,
});

export const MCP_TRANSPORTS = Object.freeze(["stdio"]);

/**
 * Extensions that are launched directly rather than through `cmd.exe` on
 * Windows. `.cmd` and `.bat` are deliberately absent: they are exactly the
 * cases `cross-spawn` routes through a shell.
 */
const DIRECT_EXECUTABLE_EXTENSIONS = Object.freeze([".exe", ".com"]);

export class McpConfigError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "McpConfigError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function refuse(code, message, details) {
  throw new McpConfigError(code, message, details);
}

function boundedString(value, field, maxBytes) {
  if (typeof value !== "string" || value.trim().length === 0) {
    refuse("mcp_config_invalid", `The MCP server field "${field}" must be a non-empty string.`, { field });
  }
  if (byteLength(value) > maxBytes) {
    refuse("mcp_config_invalid", `The MCP server field "${field}" is too long.`, { field, bytes: byteLength(value) });
  }
  return value;
}

/**
 * Validates the command against the no-shell rule.
 *
 * Applied only on Windows, because that is where the shell appears. Stated as a
 * check on the command rather than on the resolved path because we never
 * resolve anything ourselves: `shell: false` plus a `.exe` command is what
 * makes the property hold without us re-implementing PATH lookup.
 */
function assertDirectlyExecutable(command) {
  if (process.platform !== "win32") return;
  const lower = command.toLowerCase();
  const extension = lower.slice(lower.lastIndexOf("."));
  if (lower.lastIndexOf(".") === -1 || !DIRECT_EXECUTABLE_EXTENSIONS.includes(extension)) {
    refuse(
      "mcp_command_shell_required",
      `The MCP server command "${command}" is not a directly executable file. `
      + "On Windows, a command that is not a .exe or .com is launched through cmd.exe, "
      + "which expands %NAME% inside arguments and would expose environment secrets. "
      + "Configure a directly executable command instead, such as node.exe with the server script as an argument.",
      { command },
    );
  }
}

function assertArguments(args) {
  if (args === undefined) return Object.freeze([]);
  if (!Array.isArray(args)) {
    refuse("mcp_config_invalid", 'The MCP server field "args" must be an array.', { field: "args" });
  }
  if (args.length > MCP_CONFIG_LIMITS.maxArguments) {
    refuse("mcp_config_invalid", `An MCP server may declare at most ${MCP_CONFIG_LIMITS.maxArguments} arguments.`, {
      count: args.length,
    });
  }
  let total = 0;
  const bounded = args.map((argument, index) => {
    if (typeof argument !== "string") {
      refuse("mcp_config_invalid", `The MCP server argument ${index} must be a string.`, { index });
    }
    if (byteLength(argument) > MCP_CONFIG_LIMITS.maxArgumentBytes) {
      refuse("mcp_config_invalid", `The MCP server argument ${index} is too long.`, { index });
    }
    total += byteLength(argument);
    return argument;
  });
  if (total > MCP_CONFIG_LIMITS.maxTotalArgumentBytes) {
    refuse("mcp_config_invalid", "The MCP server argument list is too large.");
  }
  return Object.freeze(bounded);
}

/**
 * Validates the environment map.
 *
 * Every entry is `{ from_config: "NAME" }`. A literal string is refused by
 * name rather than by pattern, because pattern-matching for secrets is exactly
 * the unreliable approach this design avoids: the format simply has no way to
 * express a literal.
 */
function assertEnvironment(env) {
  if (env === undefined) return Object.freeze({});
  if (!isPlainObject(env)) {
    refuse("mcp_config_invalid", 'The MCP server field "env" must be an object.', { field: "env" });
  }
  const entries = Object.entries(env);
  if (entries.length > MCP_CONFIG_LIMITS.maxEnvironmentEntries) {
    refuse(
      "mcp_config_invalid",
      `An MCP server may declare at most ${MCP_CONFIG_LIMITS.maxEnvironmentEntries} environment entries.`,
      { count: entries.length },
    );
  }
  const resolved = {};
  for (const [name, reference] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || byteLength(name) > MCP_CONFIG_LIMITS.maxEnvironmentNameBytes) {
      refuse("mcp_config_invalid", `The MCP server environment name "${name}" is not a valid variable name.`, { name });
    }
    if (typeof reference === "string") {
      refuse(
        "mcp_secret_must_be_indirect",
        `The MCP server environment entry "${name}" holds a literal value. `
        + "Secrets must be referenced by name from Aside's own configuration, never stored in a server configuration.",
        { name },
      );
    }
    if (!isPlainObject(reference) || typeof reference.from_config !== "string") {
      refuse(
        "mcp_config_invalid",
        `The MCP server environment entry "${name}" must be { from_config: "NAME" }.`,
        { name },
      );
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference.from_config)) {
      refuse("mcp_config_invalid", `The MCP server environment entry "${name}" references an invalid configuration name.`, {
        name,
      });
    }
    resolved[name] = Object.freeze({ from_config: reference.from_config });
  }
  return Object.freeze(resolved);
}

const CLASSIFICATION_ENUMS = Object.freeze({
  effect: TOOL_EFFECTS,
  scope: TOOL_SCOPES,
  egress: TOOL_EGRESS_VALUES,
  replay: TOOL_REPLAY_POLICIES,
});

/**
 * Validates per-tool classification overrides.
 *
 * These are the user's assertions about what a tool does, and they are the only
 * thing that can lower a tool's classification below the conservative default.
 * Nothing the server says participates: a server that describes itself as
 * read-only is making a claim, and a claim is not a classification.
 *
 * Values are checked against the contract's own enums here so a typo fails at
 * configuration time with a clear message, rather than surfacing later as an
 * opaque registry rejection.
 */
function assertToolClassifications(value) {
  if (value === undefined) return Object.freeze({});
  if (!isPlainObject(value)) {
    refuse("mcp_config_invalid", 'The MCP server field "tool_classifications" must be an object.', {
      field: "tool_classifications",
    });
  }
  const entries = Object.entries(value);
  if (entries.length > MCP_CONFIG_LIMITS.maxToolClassifications) {
    refuse(
      "mcp_config_invalid",
      `An MCP server may classify at most ${MCP_CONFIG_LIMITS.maxToolClassifications} tools.`,
      { count: entries.length },
    );
  }
  const classifications = {};
  for (const [toolName, classification] of entries) {
    if (!isPlainObject(classification)) {
      refuse(
        "mcp_config_invalid",
        `The classification for tool "${toolName}" must be an object.`,
        { tool: toolName },
      );
    }
    const accepted = {};
    for (const [field, allowed] of Object.entries(CLASSIFICATION_ENUMS)) {
      if (classification[field] === undefined) continue;
      if (!allowed.includes(classification[field])) {
        refuse(
          "mcp_config_invalid",
          `The classification for tool "${toolName}" has an unknown ${field} "${String(classification[field])}".`,
          { tool: toolName, field, allowed: [...allowed] },
        );
      }
      accepted[field] = classification[field];
    }
    for (const key of Object.keys(classification)) {
      if (key === "schema_digest") {
        // Optional binding of the override to the schema the user approved.
        // Without it the override is name-keyed and cannot be invalidated
        // automatically; see C6-I030.
        if (!/^[a-f0-9]{8,64}$/i.test(String(classification.schema_digest))) {
          refuse(
            "mcp_config_invalid",
            `The classification for tool "${toolName}" has a malformed schema_digest.`,
            { tool: toolName },
          );
        }
        accepted.schema_digest = classification.schema_digest;
        continue;
      }
      if (!(key in CLASSIFICATION_ENUMS)) {
        refuse(
          "mcp_config_invalid",
          `The classification for tool "${toolName}" has an unknown field "${key}".`,
          { tool: toolName, field: key },
        );
      }
    }
    classifications[toolName] = Object.freeze(accepted);
  }
  return Object.freeze(classifications);
}

/**
 * Validates and freezes one server configuration.
 *
 * `enabled` and `trust_acknowledged` are separate on purpose. A server that is
 * configured but not acknowledged is inert: the user has supplied the details
 * but has not yet accepted that this is external code executing on their
 * machine, and P6 requires that distinction to be visible rather than implied
 * by the presence of a configuration.
 */
export function validateServerConfig(raw, limits = MCP_CONFIG_LIMITS) {
  if (!isPlainObject(raw)) {
    refuse("mcp_config_invalid", "An MCP server configuration must be an object.");
  }
  const id = boundedString(raw.id, "id", limits.maxServerIdBytes);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    refuse(
      "mcp_config_invalid",
      `The MCP server id "${id}" must be lowercase alphanumeric with dashes or underscores.`,
      { id },
    );
  }
  const displayName = raw.display_name === undefined
    ? id
    : boundedString(raw.display_name, "display_name", limits.maxDisplayNameBytes);
  const transport = raw.transport ?? "stdio";
  if (!MCP_TRANSPORTS.includes(transport)) {
    refuse("mcp_config_invalid", `The MCP server transport "${String(transport)}" is not supported.`, { transport });
  }
  const command = boundedString(raw.command, "command", limits.maxCommandBytes);
  assertDirectlyExecutable(command);
  const args = assertArguments(raw.args);
  const env = assertEnvironment(raw.env);
  const toolClassifications = assertToolClassifications(raw.tool_classifications);
  if (raw.cwd !== undefined) {
    boundedString(raw.cwd, "cwd", limits.maxCommandBytes);
  }

  const config = {
    id,
    display_name: displayName,
    transport,
    command,
    args,
    env,
    tool_classifications: toolClassifications,
    cwd: raw.cwd === undefined ? undefined : String(raw.cwd),
    enabled: raw.enabled === true,
    trust_acknowledged: raw.trust_acknowledged === true,
  };
  return Object.freeze({
    ...config,
    fingerprint: serverFingerprint(config),
  });
}

export function validateServerConfigs(rawServers, limits = MCP_CONFIG_LIMITS) {
  if (!Array.isArray(rawServers)) {
    refuse("mcp_config_invalid", "The MCP server list must be an array.");
  }
  if (rawServers.length > limits.maxServers) {
    refuse("mcp_config_invalid", `At most ${limits.maxServers} MCP servers may be configured.`, {
      count: rawServers.length,
    });
  }
  const configs = rawServers.map((entry) => validateServerConfig(entry, limits));
  const seen = new Set();
  for (const config of configs) {
    if (seen.has(config.id)) {
      refuse("duplicate_mcp_server", `The MCP server id "${config.id}" is configured more than once.`, {
        id: config.id,
      });
    }
    seen.add(config.id);
  }
  return Object.freeze(configs);
}

/**
 * A stable digest of everything that determines what the server *is*.
 *
 * P6 requires that a material change to the executable, its arguments, or the
 * environment it receives invalidates previously discovered tools and their
 * trust classification. Hashing the identity-bearing fields makes that a
 * comparison rather than a guess, and it deliberately includes environment
 * *names* — repointing `API_KEY` at a different configuration value changes the
 * server's behavior even though no path did.
 */
export function serverFingerprint(config) {
  const identity = {
    transport: config.transport,
    command: config.command,
    args: config.args ?? [],
    cwd: config.cwd ?? null,
    env: Object.entries(config.env ?? {})
      .map(([name, reference]) => [name, reference.from_config])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  };
  return createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex").slice(0, 32);
}

/**
 * Resolves the environment to hand to the spawned server.
 *
 * Values are read from Aside's own configuration bag, which is where the user's
 * provider credentials already live. A name that is not configured is reported
 * rather than silently omitted: a server started without the variable it asked
 * for fails in a way that is hard to attribute, and being explicit here is what
 * makes "the secret never reaches Aside's storage" true without making it
 * invisible.
 */
export function resolveServerEnvironment(config, configValues = {}) {
  const environment = {};
  const missing = [];
  for (const [name, reference] of Object.entries(config.env ?? {})) {
    const value = configValues[reference.from_config];
    if (typeof value !== "string" || value.trim().length === 0) {
      missing.push({ name, from_config: reference.from_config });
      continue;
    }
    environment[name] = value;
  }
  return Object.freeze({ environment: Object.freeze(environment), missing: Object.freeze(missing) });
}
