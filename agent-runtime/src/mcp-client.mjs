import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Connection lifecycle for a user-configured MCP server.
 *
 * This module owns everything about *talking* to a server: spawning it,
 * negotiating, paging its tool list, timing out, cancelling, and tearing it
 * down. It owns nothing about *trusting* what comes back — classification,
 * policy, namespacing, and permission belong to the adapter above it. Keeping
 * that line sharp is what stops this from becoming a second runtime.
 *
 * Several behaviors here were established by probing the SDK rather than
 * assumed, and they shape the code below:
 *
 *  - The client must drive `tools/list` pagination itself; the SDK returns one
 *    page and a cursor.
 *  - The SDK refuses server-initiated `sampling/createMessage`, `roots/list`,
 *    and `elicitation/create` with `-32601` when the client declares no
 *    capabilities. That is the fail-closed default P6 requires; this module
 *    declares no capabilities so it stays that way.
 *  - A server's `isError: true` arrives as a normal result, not a throw, so it
 *    is preserved as data rather than converted into a transport error.
 *  - A response that violates the protocol throws `-32602`, so a malformed
 *    result becomes an error rather than a silent pass-through.
 *  - stdout carrying non-protocol text is tolerated by the parser. A real
 *    server was observed logging a startup banner this way, so tolerance here
 *    is a robustness requirement, not a nicety.
 */

export const MCP_CLIENT_LIMITS = Object.freeze({
  connectTimeoutMs: 15_000,
  listTimeoutMs: 15_000,
  callTimeoutMs: 60_000,
  closeTimeoutMs: 5_000,
  maxToolsPerServer: 64,
  maxToolListPages: 8,
});

export const MCP_CONNECTION_STATES = Object.freeze(["connecting", "ready", "failed", "closed"]);

export class McpClientError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "McpClientError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** True for the abort the SDK raises when a request's signal fires. */
function isAbortError(error) {
  const name = error?.name ?? "";
  return name === "AbortError" || error?.code === "ABORT_ERR";
}

function isTimeoutError(error) {
  const code = error?.code;
  return code === -32001 || code === "RequestTimeout" || /timed out/i.test(String(error?.message ?? ""));
}

/**
 * Context-specific outcome codes.
 *
 * Cancellation and timeout are distinguished by *cause*, not by the error the
 * SDK produced, because the SDK reports both as `RequestTimeout` when a signal
 * aborts without an explicit reason. See `#request`.
 */
function cancelledCode(context) {
  return context === "call" ? "mcp_call_cancelled" : "mcp_cancelled";
}

function timeoutCode(context) {
  return context === "call" ? "mcp_call_timeout" : "mcp_timeout";
}

/**
 * Maps an SDK or transport failure onto the adapter's own vocabulary.
 *
 * Deliberately exhaustive rather than a pass-through of `error.message`: the
 * adapter's failure taxonomy is part of its contract, and a raw SDK string is
 * neither stable nor safe to show.
 */
function mapError(error, context) {
  if (error instanceof McpClientError) return error;
  if (isAbortError(error)) {
    return new McpClientError(cancelledCode(context), "The MCP operation was cancelled.");
  }
  if (isTimeoutError(error)) {
    return new McpClientError(
      timeoutCode(context),
      `The MCP server did not respond to the ${context} in time.`,
    );
  }
  const code = error?.code;
  if (code === -32602) {
    return new McpClientError("mcp_malformed_response", "The MCP server returned a malformed response.");
  }
  if (code === -32601) {
    return new McpClientError("mcp_method_not_found", "The MCP server does not support the requested method.");
  }
  if (code === -32603) {
    return new McpClientError("mcp_server_error", "The MCP server reported an internal error.");
  }
  return new McpClientError(
    context === "connect" ? "mcp_connect_failed" : `mcp_${context}_failed`,
    context === "connect"
      ? "The MCP server could not be started."
      : `The MCP server failed during ${context}.`,
  );
}

function withTimeout(promise, timeoutMs, onTimeout) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new McpClientError("mcp_timeout", "The MCP server did not respond in time."));
      }, timeoutMs);
    }),
  ]);
}

export class McpConnection {
  #client;
  #transport;
  #config;
  #limits;
  #state = "connecting";
  #failure;
  #closePromise;

  constructor({ client, transport, config, limits }) {
    this.#client = client;
    this.#transport = transport;
    this.#config = config;
    this.#limits = limits;
  }

  get id() {
    return this.#config.id;
  }

  get displayName() {
    return this.#config.display_name;
  }

  get state() {
    return this.#state;
  }

  get failure() {
    return this.#failure;
  }

  get serverInfo() {
    try {
      return this.#client.getServerVersion() ?? undefined;
    } catch {
      return undefined;
    }
  }

  static async connect({ config, environment = {}, limits = MCP_CLIENT_LIMITS, signal } = {}) {
    const merged = { ...MCP_CLIENT_LIMITS, ...limits };
    const transport = new StdioClientTransport({
      command: config.command,
      args: [...(config.args ?? [])],
      cwd: config.cwd,
      // Only the values resolved from Aside's own configuration. The SDK merges
      // these on top of a small safe allow-list; passing the runtime's own
      // environment here would hand every server the user's provider keys.
      env: { ...environment },
      stderr: "pipe",
    });
    // The client declares no capabilities. That is what keeps the SDK's
    // -32601 refusal of sampling, roots, and elicitation in place.
    const client = new Client(
      { name: "aside", version: "1.0.0" },
      { capabilities: {} },
    );
    const connection = new McpConnection({ client, transport, config, limits: merged });
    try {
      await withTimeout(client.connect(transport), merged.connectTimeoutMs, () => {
        client.close().catch(() => {});
      });
    } catch (error) {
      connection.#state = "failed";
      connection.#failure = mapError(error, "connect");
      await connection.close("connect_failed").catch(() => {});
      throw connection.#failure;
    }
    if (signal?.aborted) {
      await connection.close("cancelled");
      throw new McpClientError("mcp_cancelled", "The MCP connection was cancelled before it was established.");
    }
    connection.#state = "ready";
    return connection;
  }

  /**
   * Runs one request under an explicit timeout and the caller's signal.
   *
   * The timeout and the cancellation are driven by this method rather than
   * handed to the SDK, because the SDK cannot tell them apart. Its abort path
   * is:
   *
   *     options?.signal?.addEventListener('abort', () => cancel(options?.signal?.reason));
   *     const error = reason instanceof McpError ? reason : new McpError(ErrorCode.RequestTimeout, String(reason));
   *
   * An `AbortController.abort()` with no explicit reason therefore arrives as
   * `McpError(RequestTimeout, "undefined")` — the same code a real timeout
   * produces. Since P6 requires a cancelled call and a timed-out call to be
   * distinct bounded outcomes, the distinction is tracked here, where the cause
   * is actually known, instead of being inferred from the error shape.
   *
   * The SDK still emits `notifications/cancelled` to the server, so the server
   * learns about the cancellation as the protocol intends.
   */
  async #request(context, operation, { signal, timeoutMs }) {
    if (signal?.aborted) {
      throw new McpClientError(cancelledCode(context), "The MCP operation was cancelled.");
    }
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      return await operation(controller.signal);
    } catch (error) {
      if (error instanceof McpClientError) throw error;
      if (timedOut) {
        throw new McpClientError(
          timeoutCode(context),
          `The MCP server did not respond to the ${context} in time.`,
        );
      }
      if (signal?.aborted) {
        throw new McpClientError(cancelledCode(context), "The MCP operation was cancelled.");
      }
      throw mapError(error, context);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Lists every tool the server advertises, following pages up to a bound.
   *
   * Both bounds matter independently: a server can advertise few tools per page
   * and still page forever, so the page count is capped as well as the count.
   */
  async listTools({ signal } = {}) {
    this.#assertUsable("list");
    const tools = [];
    const seenCursors = new Set();
    let cursor;
    let pages = 0;
    try {
      for (;;) {
        pages += 1;
        if (pages > this.#limits.maxToolListPages) {
          throw new McpClientError(
            "mcp_too_many_pages",
            `The MCP server paged its tool list past ${this.#limits.maxToolListPages} pages.`,
          );
        }
        const page = await this.#request(
          "list",
          (requestSignal) => this.#client.listTools(
            cursor === undefined ? {} : { cursor },
            { signal: requestSignal },
          ),
          { signal, timeoutMs: this.#limits.listTimeoutMs },
        );
        for (const tool of page?.tools ?? []) {
          tools.push(tool);
          if (tools.length > this.#limits.maxToolsPerServer) {
            throw new McpClientError(
              "mcp_too_many_tools",
              `The MCP server advertises more than ${this.#limits.maxToolsPerServer} tools.`,
              { count: tools.length },
            );
          }
        }
        const next = page?.nextCursor;
        if (typeof next !== "string" || next.length === 0) break;
        // A server that repeats a cursor would otherwise loop until the page cap
        // silently truncates its list, which reads as success.
        if (seenCursors.has(next)) {
          throw new McpClientError("mcp_pagination_loop", "The MCP server repeated a tool-list cursor.");
        }
        seenCursors.add(next);
        cursor = next;
      }
    } catch (error) {
      throw this.#recordFailure(error instanceof McpClientError ? error : mapError(error, "list"));
    }
    return Object.freeze(tools.slice());
  }

  /**
   * Sends one `tools/call`.
   *
   * The raw result is returned unnormalized: bounding and content disposition
   * belong to the result module, and keeping them separate is what lets the
   * adapter apply the same normalization to every adapter type.
   */
  async callTool(name, args, { signal } = {}) {
    this.#assertUsable("call");
    try {
      return await this.#request(
        "call",
        (requestSignal) => this.#client.callTool(
          { name, arguments: args ?? {} },
          undefined,
          { signal: requestSignal },
        ),
        { signal, timeoutMs: this.#limits.callTimeoutMs },
      );
    } catch (error) {
      throw this.#recordFailure(error instanceof McpClientError ? error : mapError(error, "call"));
    }
  }

  /**
   * Tears the connection down.
   *
   * Idempotent and bounded: a server that ignores the shutdown is killed rather
   * than awaited indefinitely, because a lingering process is exactly the
   * outcome a teardown path exists to prevent.
   */
  async close(reason = "closed") {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = (async () => {
      try {
        await withTimeout(this.#client.close(), this.#limits.closeTimeoutMs);
      } catch {
        // A server that will not close politely is closed impolitely below.
      }
      try {
        await this.#transport.close();
      } catch {
        // Already gone.
      }
      if (this.#state !== "failed") this.#state = "closed";
      this.#failure = this.#failure ?? undefined;
      return reason;
    })();
    return this.#closePromise;
  }

  #assertUsable(context) {
    if (this.#state === "ready") return;
    throw new McpClientError(
      this.#state === "closed" ? "mcp_disconnected" : "mcp_unavailable",
      `The MCP server is not ${context === "call" ? "connected" : "available"}.`,
      { state: this.#state },
    );
  }

  #recordFailure(error) {
    // A transport-level failure means the connection is no longer trustworthy.
    // Cancellation is excluded: an aborted call says nothing about the server.
    if (!["mcp_call_cancelled", "mcp_cancelled"].includes(error.code)) {
      this.#state = "failed";
      this.#failure = error;
    }
    return error;
  }
}
