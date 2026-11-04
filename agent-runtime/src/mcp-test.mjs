import { McpController } from "./mcp-adapter.mjs";
import { MCP_CLIENT_LIMITS } from "./mcp-client.mjs";
import { resolveServerEnvironment, validateServerConfig } from "./mcp-config.mjs";
import { sanitizeRuntimeText } from "./agent-contracts.mjs";

/**
 * One-shot connection test for a single configured server.
 *
 * Deliberately separate from the conversation runtime. Testing a server is a
 * question the user asked at a moment they chose; it must not start tools,
 * touch the registry, or leave a connection behind for a task to inherit. The
 * controller is created for this call and closed in the same one.
 *
 * The three outcomes are kept distinct because they mean different things and
 * the user's next action differs:
 *
 *  - `unreachable` — the process did not start or did not speak MCP.
 *  - `tools_rejected` — it started, but every tool it advertised failed schema
 *    acceptance. A working server with tools this product refuses is not the
 *    same as a broken server, and telling the user "connection failed" would
 *    send them looking in the wrong place.
 *  - `ok` — at least one tool is usable.
 */

export const MCP_TEST_TIMEOUT_MS = 20_000;

function bounded(value, maxBytes = 512) {
  return sanitizeRuntimeText(value, maxBytes).text;
}

/**
 * Runs the test.
 *
 * `environment` is Aside's own configuration bag, which is where `from_config`
 * references resolve. Missing names are reported by name only: the value is the
 * secret, and a test result travels back through IPC.
 */
export async function testMcpServer({
  entry,
  configValues = {},
  timeoutMs = MCP_TEST_TIMEOUT_MS,
  controllerFactory,
  now = Date.now,
} = {}) {
  const startedAt = now();
  let config;
  try {
    config = validateServerConfig(entry);
  } catch (error) {
    return Object.freeze({
      outcome: "invalid",
      code: typeof error?.code === "string" ? error.code : "mcp_config_invalid",
      message: bounded(error instanceof Error ? error.message : String(error)),
      tools: Object.freeze([]),
      diagnostics: Object.freeze([]),
    });
  }

  const { environment, missing } = resolveServerEnvironment(config, configValues);
  if (missing.length > 0) {
    return Object.freeze({
      outcome: "missing_environment",
      server_id: config.id,
      display_name: config.display_name,
      // Names, never values.
      missing: Object.freeze(missing.map((entryValue) => Object.freeze({ name: entryValue.name, from_config: entryValue.from_config }))),
      message: `The server needs ${missing.map((item) => item.from_config).join(", ")} from Aside's configuration; ${missing.length === 1 ? "that name is" : "those names are"} not set.`,
      tools: Object.freeze([]),
      diagnostics: Object.freeze([]),
    });
  }

  // A test runs one server, but `McpController.tools()` only works on servers
  // that are enabled and acknowledged. Those flags are about what the
  // conversation may start, not about whether the program runs, so the probe
  // copy sets both and leaves the user's file alone.
  const probeConfig = Object.freeze({ ...config, enabled: true, trust_acknowledged: true });
  const controller = (controllerFactory ?? ((options) => new McpController(options)))({
    servers: [probeConfig],
    configValues,
    limits: { ...MCP_CLIENT_LIMITS, connectTimeoutMs: timeoutMs, listTimeoutMs: timeoutMs, closeTimeoutMs: timeoutMs },
  });

  try {
    const tools = await controller.tools();
    const diagnostics = controller.diagnostics;
    const elapsed = now() - startedAt;
    if (tools.length > 0) {
      return Object.freeze({
        outcome: "ok",
        server_id: config.id,
        display_name: config.display_name,
        elapsed_ms: elapsed,
        tools: Object.freeze(tools.map((tool) => Object.freeze({ name: tool.name }))),
        diagnostics: Object.freeze(diagnostics.map((entry) => Object.freeze({ code: entry.code, message: bounded(entry.message) }))),
      });
    }
    // The server may have started and listed tools that were all refused, or it
    // may never have started. The diagnostics say which; the outcome names the
    // fact the user needs either way.
    const rejected = diagnostics.some((entry) => /schema|tool_/u.test(String(entry.code)));
    return Object.freeze({
      outcome: rejected ? "tools_rejected" : "unreachable",
      server_id: config.id,
      display_name: config.display_name,
      elapsed_ms: elapsed,
      message: rejected
        ? "The server responded, but none of its tools could be accepted."
        : "The server did not start or did not respond to a tool listing.",
      tools: Object.freeze([]),
      diagnostics: Object.freeze(diagnostics.map((entry) => Object.freeze({ code: entry.code, message: bounded(entry.message) }))),
    });
  } catch (error) {
    return Object.freeze({
      outcome: "unreachable",
      server_id: config.id,
      display_name: config.display_name,
      elapsed_ms: now() - startedAt,
      code: typeof error?.code === "string" ? error.code : "mcp_server_failed",
      message: bounded(error instanceof Error ? error.message : String(error)),
      tools: Object.freeze([]),
      diagnostics: Object.freeze([]),
    });
  } finally {
    // Always, and before returning: a test that leaves a process running is a
    // leak the user cannot see.
    await controller.close("tested").catch(() => undefined);
  }
}
