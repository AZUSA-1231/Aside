import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeRuntimeText } from "./agent-contracts.mjs";
import { createMcpToolFactory, McpController } from "./mcp-adapter.mjs";
import { MCP_CONFIG_LIMITS, validateServerConfig } from "./mcp-config.mjs";

/**
 * Wires configured MCP servers into the conversation runtime.
 *
 * Two files, deliberately separate. Aside's own configuration lives in
 * `.env.local` and holds Aside's settings; a server definition is a different
 * kind of thing — a program with arguments, an environment, and a trust
 * acknowledgement — and putting it in an env file would mean embedding JSON in
 * a shell-syntax file, which is where configuration errors come from.
 *
 * Server definitions live in `mcp.json` beside the resolved Aside configuration.
 * The file is optional: with no MCP configuration, everything here is inert and
 * the runtime behaves exactly as it did before.
 */

export const MCP_CONFIG_FILENAME = "mcp.json";

function boundedMessage(value) {
  return sanitizeRuntimeText(value, 512).text;
}

/**
 * Reads and validates `mcp.json`.
 *
 * Failures are per-server wherever possible. A single malformed definition
 * costs the user that server and nothing else — not their other servers, and
 * never the built-in tools. An unreadable or unparseable *file* is reported but
 * also non-fatal, because an MCP misconfiguration must not prevent Aside from
 * starting and doing ordinary file work.
 */
export async function loadMcpServerConfigs({
  configDir,
  readTextFile = readFile,
  limits = MCP_CONFIG_LIMITS,
} = {}) {
  const diagnostics = [];
  if (!configDir) {
    return Object.freeze({ servers: Object.freeze([]), diagnostics: Object.freeze([]), source: undefined });
  }
  const source = join(configDir, MCP_CONFIG_FILENAME);
  let text;
  try {
    text = await readTextFile(source, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      // No MCP configuration is the ordinary case, not a problem.
      return Object.freeze({ servers: Object.freeze([]), diagnostics: Object.freeze([]), source: undefined });
    }
    diagnostics.push(Object.freeze({
      code: "mcp_config_unreadable",
      message: boundedMessage(`The MCP configuration at ${source} could not be read.`),
    }));
    return Object.freeze({ servers: Object.freeze([]), diagnostics: Object.freeze(diagnostics), source });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    diagnostics.push(Object.freeze({
      code: "mcp_config_unparseable",
      message: boundedMessage(`The MCP configuration at ${source} is not valid JSON.`),
    }));
    return Object.freeze({ servers: Object.freeze([]), diagnostics: Object.freeze(diagnostics), source });
  }

  // `{ "servers": [...] }` is the documented shape; a bare array is accepted so
  // a hand-written file does not fail over a wrapper nobody needed.
  const entries = Array.isArray(parsed) ? parsed : parsed?.servers;
  if (!Array.isArray(entries)) {
    diagnostics.push(Object.freeze({
      code: "mcp_config_invalid_shape",
      message: boundedMessage('The MCP configuration must be an array or an object with a "servers" array.'),
    }));
    return Object.freeze({ servers: Object.freeze([]), diagnostics: Object.freeze(diagnostics), source });
  }

  const servers = [];
  const seen = new Set();
  for (const entry of entries) {
    try {
      const config = validateServerConfig(entry, limits);
      if (seen.has(config.id)) {
        diagnostics.push(Object.freeze({
          server_id: config.id,
          code: "duplicate_mcp_server",
          message: boundedMessage(`The MCP server id "${config.id}" is configured more than once.`),
        }));
        continue;
      }
      seen.add(config.id);
      servers.push(config);
    } catch (error) {
      diagnostics.push(Object.freeze({
        server_id: typeof entry?.id === "string" ? entry.id : undefined,
        code: typeof error?.code === "string" ? error.code : "mcp_config_invalid",
        message: boundedMessage(error instanceof Error ? error.message : String(error)),
      }));
    }
  }

  return Object.freeze({
    servers: Object.freeze(servers),
    diagnostics: Object.freeze(diagnostics),
    source,
  });
}

/**
 * Builds the per-run tool source for a set of configured servers.
 *
 * The runtime already has a `toolFactory` seam for exactly this, and using it
 * rather than registering MCP tools statically is deliberate: an adapted tool
 * exists only while its server is reachable, and a registry that claimed
 * otherwise would offer the model tools that cannot run.
 */
export function createMcpIntegration({
  servers = [],
  configValues = {},
  limits,
  connectionFactory,
} = {}) {
  const controller = new McpController({ servers, configValues, limits, connectionFactory });
  return Object.freeze({
    controller,
    /**
     * Returns only the adapted MCP tools for the servers currently reachable.
     *
     * Deliberately not merged with the built-ins here: the runtime owns registry
     * assembly, and an adapter that assembled its own would be the second
     * registry this plan forbids. When nothing is reachable this resolves to an
     * empty list, so the seam is inert when unused.
     */
    toolFactory: createMcpToolFactory(controller),
    close: (reason) => controller.close(reason),
  });
}

export { McpController };
