import { createHash } from "node:crypto";
import {
  MAX_TOOL_DESCRIPTION_LENGTH,
  previewValue,
  sanitizeRuntimeText,
} from "./agent-contracts.mjs";
import { createAsideToolRegistry, encodeMcpToolName } from "./capability-contract.mjs";
import {
  cancelledToolResult,
  deniedToolResult,
  failedToolResultEnvelope,
  toolResultEnvelope,
} from "./capability-result.mjs";
import { McpClientError, McpConnection, MCP_CLIENT_LIMITS } from "./mcp-client.mjs";
import { resolveServerEnvironment } from "./mcp-config.mjs";
import { normalizeMcpResult } from "./mcp-result.mjs";
import { acceptMcpToolDefinition, assertMcpArguments } from "./mcp-schema.mjs";

/**
 * Adapts a user-connected MCP server's tools into the Aside capability registry.
 *
 * This is the boundary the whole plan exists for, and the line it must hold is
 * narrow: it converts *shape* — names, schemas, results, failures — and supplies
 * *trust metadata Aside owns*. It does not take the server's word for anything.
 *
 * What the server claims is treated as untrusted input throughout. Its tool
 * descriptions are data the model reads, never instructions; its schema
 * annotations cannot classify it as safe; its stated risk, if it states any,
 * carries no authority. The classification attached to each tool comes from
 * Aside, and every call passes through the permission broker regardless.
 */

export const MAX_MCP_TOOLS_TOTAL = 128;
export const MAX_MCP_PREVIEW_BYTES = 4 * 1024;
export const MAX_MCP_EXPLANATION_BYTES = 512;

/**
 * The classification applied to a tool the user has not classified.
 *
 * Deliberately the most cautious reading of an unknown external program, not a
 * guess at what it probably does. Aside cannot see inside the server, so it
 * cannot claim the tool only reads, only touches files, or is safe to repeat.
 * A user who knows better can lower this per tool; nothing the server says can.
 */
export const MCP_DEFAULT_CLASSIFICATION = Object.freeze({
  effect: "execute",
  scope: "host",
  egress: "selected_content",
  replay: "non_replayable",
});

const CLASSIFICATION_FIELDS = Object.freeze(["effect", "scope", "egress", "replay"]);

/** `sanitizeRuntimeText` returns `{text, truncated}`; most callers want the text. */
function boundedText(value, maxBytes) {
  return sanitizeRuntimeText(value, maxBytes).text;
}

/**
 * A short digest of the schema a classification was approved against.
 *
 * Bindings are keyed by tool *name*, and a name is not a contract: a server can
 * ship a benign schema, collect a lowered classification, then change what the
 * tool does without changing what it is called. Recording the digest lets a
 * user who cares pin their approval to the schema they actually read.
 */
export function schemaDigest(parameters) {
  return createHash("sha256").update(JSON.stringify(parameters), "utf8").digest("hex").slice(0, 16);
}

/**
 * Resolves the classification for one tool.
 *
 * A per-tool override must be supplied by the user's configuration, is
 * validated against the contract's closed enums, and is attached here so the
 * registry — not this module — remains the authority that rejects an invalid
 * descriptor.
 *
 * If the override declares `schema_digest` and it does not match the schema the
 * server is currently advertising, the override is refused and the conservative
 * default applies. That is the one part of schema-change invalidation that can
 * be enforced without a settings store; see the note on the unbound case below.
 */
export function classifyMcpTool(config, toolName, parameters) {
  const override = config?.tool_classifications?.[toolName];
  if (override === undefined) return MCP_DEFAULT_CLASSIFICATION;
  if (typeof override !== "object" || override === null) {
    throw new McpClientError("mcp_classification_invalid", "A tool classification override must be an object.");
  }
  if (override.schema_digest !== undefined) {
    const observed = schemaDigest(parameters);
    if (override.schema_digest !== observed) {
      return MCP_DEFAULT_CLASSIFICATION;
    }
  }
  const classification = {};
  for (const field of CLASSIFICATION_FIELDS) {
    classification[field] = override[field] ?? MCP_DEFAULT_CLASSIFICATION[field];
  }
  return Object.freeze(classification);
}

/**
 * Bounds what a server may call its own tool.
 *
 * The description is prefixed with the server's display name because the model
 * needs to know which external program a tool belongs to, and attributing it is
 * Aside's job — a server naming itself in its own description would be a claim,
 * not information.
 */
function buildDescription(config, accepted) {
  const prefix = `[MCP: ${config.display_name}] `;
  // Bounded to the registry's own limit, not to a number chosen here. The first
  // version used 1200, which the registry rejects at 800: an adapted tool with a
  // long description therefore passed this layer and failed in the registry,
  // taking every other tool down with it. See A05.
  return boundedText(`${prefix}${accepted.description}`, MAX_TOOL_DESCRIPTION_LENGTH);
}

/**
 * The permission preview.
 *
 * Must let a user decide without reading a protocol dump: which server, which
 * tool, that the program is not sandboxed, and what arguments are being sent —
 * bounded and redacted. It never carries a raw handle or a credential.
 */
function buildPreview({ config, toolName, args, classification }) {
  const bounded = previewValue(
    {
      server: config.display_name,
      tool: toolName,
      boundary: "external_process",
      sandboxed: false,
      arguments: args ?? {},
      classification,
    },
    MAX_MCP_PREVIEW_BYTES,
  );
  return bounded.truncated ? { truncated: true, summary: bounded.text } : bounded.text;
}

/**
 * Composes the model-visible body of an MCP result.
 *
 * Everything the model could use is included, and nothing the server did not
 * send is invented. Omissions are stated rather than left implicit, because a
 * silently dropped image reads as "the tool returned nothing" — which is a
 * different claim from "the tool returned something this adapter could not
 * carry", and the model cannot tell them apart otherwise.
 */
function mcpResultBody(normalized) {
  const parts = [];
  if (normalized.text.length > 0) parts.push(normalized.text);
  if (normalized.links.length > 0) parts.push(`Sources:\n${normalized.links.join("\n")}`);
  if (normalized.structured !== undefined) parts.push(normalized.structured);
  if (normalized.omissions.length > 0) {
    const described = normalized.omissions
      .map((entry) => (entry.detail ? `${entry.omitted} (${entry.detail})` : entry.omitted))
      .join(", ");
    parts.push(`[Not carried: ${described}]`);
  }
  // No truncation notice here: the envelope adds its own when it cuts the
  // content, and a second marker placed inside the body is the first thing lost
  // when the body is what gets cut.
  return parts.join("\n\n");
}

function failureEnvelope(tool, error, extra = {}) {
  const code = typeof error?.code === "string" ? error.code : "mcp_call_failed";
  return failedToolResultEnvelope(tool, {
    code,
    message: error instanceof Error ? error.message : String(error),
    details: extra,
  });
}

/**
 * Builds the Aside tool for one accepted MCP tool.
 *
 * The permission decision is requested here, and this is the only place a
 * `tools/call` can originate. That is what makes "denial sends no call" a
 * structural property: there is no path to the transport that skips the check,
 * because the check is in the same function that reaches it.
 */
function buildTool({ config, connection, accepted, classification }) {
  const name = encodeMcpToolName({ serverId: config.id, toolName: accepted.name });
  const description = buildDescription(config, accepted);
  const label = `${config.display_name}: ${accepted.name}`;

  return {
    name,
    description,
    label,
    parameters: accepted.parameters,
    descriptor: {
      name,
      description,
      label,
      effect: classification.effect,
      scope: classification.scope,
      egress: classification.egress,
      replay: classification.replay,
      source: "user_mcp",
      availability: { prerequisites: [] },
      origin: { id: `mcp:${config.id}`, label: config.display_name },
    },
    async createForRun({ taskRun, permissionBroker, signal: runSignal } = {}) {
      if (!permissionBroker || typeof permissionBroker.waitForDecision !== "function") {
        throw new McpClientError(
          "mcp_permission_unavailable",
          "A permission broker is required before an MCP tool can run.",
        );
      }
      return {
        async execute(toolCallId, params, callSignal) {
          // The per-call signal wins when present; the run's is the fallback.
          // Named distinctly from the destructured parameter on purpose: an
          // inner `const signal = … ?? signal` reads itself before it is
          // initialized and throws.
          const signal = callSignal ?? runSignal;
          // Validated before anything else: a malformed call should fail fast
          // rather than interrupt the user with a permission card for a request
          // that could never have been sent.
          let args;
          try {
            args = assertMcpArguments(accepted.parameters, params);
          } catch (error) {
            return failureEnvelope(name, error);
          }

          let decision;
          try {
            decision = await permissionBroker.waitForDecision({
              request_id: taskRun?.request_id ?? "direct-request",
              task_id: taskRun?.task_id ?? "direct-task",
              tool_call_id: toolCallId,
              operation: name,
              // effect, egress, source, and origin_label are overwritten by the
              // runtime's scoped broker from the trusted descriptor; they are
              // supplied here only so the request is well-formed on any path.
              effect: classification.effect,
              egress: classification.egress,
              explanation: boundedText(
                `Aside is requesting permission to run "${accepted.name}" on the `
                + `"${config.display_name}" server. Aside does not sandbox that program.`,
                MAX_MCP_EXPLANATION_BYTES,
              ),
              workspace: { canonical_path: undefined, relative_path: ".", kind: "directory" },
              targets: [],
              preview: buildPreview({ config, toolName: accepted.name, args, classification }),
              pending_ms: taskRun?.limits?.maxPendingPermissionMs,
            }, signal);
          } catch (error) {
            return failureEnvelope(name, error);
          }

          if (decision?.decision === "deny") {
            return deniedToolResult(name, {
              code: "permission_denied",
              message: "The MCP tool call was denied.",
            });
          }
          if (decision?.status !== "allowed" && decision?.decision !== "allow") {
            return failureEnvelope(name, new McpClientError(
              decision?.code === "expired" ? "permission_expired" : "permission_not_granted",
              "The MCP tool call was not permitted.",
            ));
          }

          // Only past this point does anything reach the server.
          try {
            const raw = await connection.callTool(accepted.name, args, { signal });
            const normalized = normalizeMcpResult(raw);
            const status = normalized.is_error ? "failed" : "succeeded";
            return toolResultEnvelope({
              tool: name,
              status,
              code: normalized.is_error ? "mcp_tool_error" : undefined,
              message: normalized.is_error
                ? `The server "${config.display_name}" reported that "${accepted.name}" failed.`
                : `The server "${config.display_name}" completed "${accepted.name}".`,
              // The payload the model is meant to work from. `content` is what Pi
              // serializes into the provider request; `details` below reaches the
              // UI and the session store only. Putting the result in `details`
              // alone produced a call that reported success and handed the model
              // nothing — it was shown "server completed tool" and no more. See A04.
              body: mcpResultBody(normalized),
              details: {
                server_id: config.id,
                tool: accepted.name,
                text: normalized.text,
                ...(normalized.structured === undefined ? {} : { structured: normalized.structured }),
                ...(normalized.links.length === 0 ? {} : { links: normalized.links }),
                ...(normalized.omissions.length === 0 ? {} : { omissions: normalized.omissions }),
                truncated: normalized.truncated,
              },
            });
          } catch (error) {
            if (error?.code === "mcp_call_cancelled" || error?.code === "mcp_cancelled") {
              return cancelledToolResult(name, { code: error.code, message: "The MCP tool call was cancelled." });
            }
            return failureEnvelope(name, error, { server_id: config.id, tool: accepted.name });
          }
        },
      };
    },
  };
}

/**
 * Adapts one server's advertised tools.
 *
 * A tool that fails adaptation is skipped with a diagnostic. One malformed
 * schema must not cost the user the rest of the server's tools, and must never
 * cost them the built-in ones — which is why this returns diagnostics rather
 * than throwing.
 */
function adaptTools({ config, connection, rawTools, diagnostics }) {
  const tools = [];
  for (const raw of rawTools) {
    try {
      const accepted = acceptMcpToolDefinition({
        name: raw?.name,
        description: raw?.description,
        inputSchema: raw?.inputSchema,
      });
      const override = config.tool_classifications?.[accepted.name];
      const classification = classifyMcpTool(config, accepted.name, accepted.parameters);
      if (override !== undefined && override.schema_digest === undefined) {
        // The override is applied, but it is bound to a name rather than a
        // schema. Recorded so it is visible rather than assumed safe: see
        // C6-I030.
        diagnostics.push(Object.freeze({
          server_id: config.id,
          tool: accepted.name,
          code: "mcp_classification_unbound",
          message: boundedText(
            `The classification for "${accepted.name}" is applied without a schema_digest, `
            + `so it is not invalidated if the server changes the tool's schema. `
            + `Current schema digest: ${schemaDigest(accepted.parameters)}.`,
            512,
          ),
        }));
      }
      const tool = buildTool({
        config,
        connection,
        accepted,
        classification,
      });

      // Validated as the *final* Aside descriptor, not as the server's
      // definition of it. Accepting a server's tool individually does not mean
      // the tool Aside produces from it is acceptable: two same-named server
      // tools encode to the same Aside name, and a description the adapter
      // allowed can exceed the registry's limit. Either one used to reach the
      // aggregate registry and throw there, which happens before `agent.prompt`
      // and so took down every unrelated capability in the task, not just the
      // offending tool. See A05.
      //
      // Asking the registry is deliberate: it is the authority on what it
      // accepts, and reimplementing its rules here would be a second copy that
      // could drift.
      try {
        createAsideToolRegistry([...tools, tool]);
      } catch (error) {
        diagnostics.push(Object.freeze({
          server_id: config.id,
          tool: accepted.name,
          code: typeof error?.code === "string" ? error.code : "mcp_tool_rejected",
          message: boundedText(
            `The tool "${accepted.name}" was rejected by the capability registry: `
            + `${error instanceof Error ? error.message : String(error)}`,
            512,
          ),
        }));
        continue;
      }

      tools.push(tool);
    } catch (error) {
      diagnostics.push(Object.freeze({
        server_id: config.id,
        tool: typeof raw?.name === "string" ? raw.name : undefined,
        code: typeof error?.code === "string" ? error.code : "mcp_tool_rejected",
        message: boundedText(error instanceof Error ? error.message : String(error), 512),
      }));
    }
  }
  return tools;
}

/**
 * Owns the live connections for a set of configured servers.
 *
 * Connections are cached and reused across task runs because spawning a process
 * per prompt would make every server interaction cost a startup. A connection
 * is dropped and rebuilt when its configuration's fingerprint changes, which is
 * how "an executable or environment change invalidates discovered tools" is
 * enforced rather than hoped for: the cached tools were built from the old
 * identity and are discarded with it.
 */
export class McpController {
  #servers;
  #configValues;
  #limits;
  #connectionFactory;
  #connections = new Map();
  #diagnostics = [];
  #closed = false;

  constructor({
    servers = [],
    configValues = {},
    limits,
    connectionFactory,
  } = {}) {
    this.#servers = servers;
    this.#configValues = configValues;
    this.#limits = { ...MCP_CLIENT_LIMITS, ...(limits ?? {}) };
    this.#connectionFactory = connectionFactory ?? ((options) => McpConnection.connect(options));
  }

  get diagnostics() {
    return Object.freeze(this.#diagnostics.slice());
  }

  /** Servers that are configured, enabled, and acknowledged. */
  #activeServers() {
    return this.#servers.filter((config) => config.enabled === true && config.trust_acknowledged === true);
  }

  async #connectionFor(config) {
    const cached = this.#connections.get(config.id);
    if (cached && cached.fingerprint === config.fingerprint && cached.connection.state === "ready") {
      return cached.connection;
    }
    if (cached) {
      // The identity changed, or the connection died. Either way the tools
      // built against it are no longer trustworthy.
      await cached.connection.close("invalidated").catch(() => {});
      this.#connections.delete(config.id);
    }
    const { environment, missing } = resolveServerEnvironment(config, this.#configValues);
    if (missing.length > 0) {
      this.#diagnostics.push(Object.freeze({
        server_id: config.id,
        code: "mcp_environment_incomplete",
        message: boundedText(
          `The server "${config.display_name}" is missing configured values for: `
          + `${missing.map((entry) => entry.from_config).join(", ")}.`,
          512,
        ),
      }));
      return undefined;
    }
    const connection = await this.#connectionFactory({ config, environment, limits: this.#limits });
    this.#connections.set(config.id, { fingerprint: config.fingerprint, connection });
    return connection;
  }

  /**
   * Produces the adapted tools for the servers that are currently usable.
   *
   * Never throws for a server-side problem. A server that will not start, will
   * not list, or advertises a schema we cannot accept contributes a diagnostic
   * and nothing else; the built-in registry and every other server are
   * unaffected. That isolation is the requirement, so it is also the control
   * flow rather than a try/catch bolted around the outside.
   */
  async tools() {
    if (this.#closed) return Object.freeze([]);
    const tools = [];
    for (const config of this.#activeServers()) {
      try {
        const connection = await this.#connectionFor(config);
        if (!connection) continue;
        const rawTools = await connection.listTools();
        const before = tools.length;
        tools.push(...adaptTools({ config, connection, rawTools, diagnostics: this.#diagnostics }));

        // The aggregate is what the runtime will hand to `normalizeToolSet`, so
        // it is validated here while dropping this server's contribution is
        // still possible. Without this a collision the adapter did not
        // anticipate — across servers, or against something neither layer
        // tracked — would throw before `agent.prompt` and take the whole task
        // with it, built-ins included. A server's tools are the right thing to
        // lose; everyone else's are not.
        try {
          createAsideToolRegistry(tools);
        } catch (error) {
          tools.length = before;
          this.#diagnostics.push(Object.freeze({
            server_id: config.id,
            code: typeof error?.code === "string" ? error.code : "mcp_server_rejected",
            message: boundedText(
              `The tools from "${config.display_name}" were rejected as a group: `
              + `${error instanceof Error ? error.message : String(error)}`,
              512,
            ),
          }));
          continue;
        }

        if (tools.length > MAX_MCP_TOOLS_TOTAL) {
          tools.length = before;
          this.#diagnostics.push(Object.freeze({
            server_id: config.id,
            code: "mcp_tool_budget_exceeded",
            message: boundedText(
              `Adapting "${config.display_name}" would exceed the ${MAX_MCP_TOOLS_TOTAL}-tool budget for connected servers.`,
              512,
            ),
          }));
        }
      } catch (error) {
        await this.#connections.get(config.id)?.connection.close("failed").catch(() => {});
        this.#connections.delete(config.id);
        this.#diagnostics.push(Object.freeze({
          server_id: config.id,
          code: typeof error?.code === "string" ? error.code : "mcp_server_failed",
          message: boundedText(
            error instanceof Error ? error.message : String(error),
            512,
          ),
        }));
      }
    }
    return Object.freeze(tools);
  }

  /** Tears down every connection. Idempotent. */
  async close(reason = "closed") {
    this.#closed = true;
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    await Promise.all(connections.map((entry) => entry.connection.close(reason).catch(() => {})));
  }

  /** Clears accumulated diagnostics; called at a registry boundary. */
  resetDiagnostics() {
    this.#diagnostics = [];
  }
}

/**
 * The factory shape the runtime's `toolFactory` seam expects.
 *
 * The controller is created once and reused; `close()` is the caller's, which
 * is what keeps a server from outliving the app or a configuration change.
 */
export function createMcpToolFactory(controller) {
  if (!(controller instanceof McpController)) {
    throw new McpClientError("mcp_controller_required", "An McpController is required.");
  }
  return async function mcpToolFactory() {
    return controller.tools();
  };
}
