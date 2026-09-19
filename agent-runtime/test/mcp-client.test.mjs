import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { McpClientError, McpConnection } from "../src/mcp-client.mjs";
import { validateServerConfig } from "../src/mcp-config.mjs";

/**
 * Integration tests against a real child process.
 *
 * The faux server is spawned for real rather than stubbed, because the
 * behaviors under test — timeouts, cancellation, teardown, a crashing server —
 * only exist in a real process boundary. A stub would prove the stub works.
 */

const SERVER_PATH = fileURLToPath(new URL("./fixtures/faux-mcp-server.mjs", import.meta.url));

function configFor(overrides = {}) {
  return validateServerConfig({
    id: "faux",
    display_name: "Faux server",
    // An absolute .exe path: the config layer refuses anything that would route
    // through cmd.exe on Windows, and node.exe is the realistic case.
    command: process.execPath,
    args: [SERVER_PATH],
    env: { FAUX_MCP_SCENARIO: { from_config: "FAUX_SCENARIO" } },
    enabled: true,
    trust_acknowledged: true,
    ...overrides,
  });
}

async function connect(scenario, options = {}) {
  return McpConnection.connect({
    config: configFor(),
    environment: { FAUX_MCP_SCENARIO: scenario },
    ...options,
  });
}

async function expectRefusal(fn, code) {
  await assert.rejects(fn, (error) => {
    assert.ok(error instanceof McpClientError, `expected McpClientError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("connects, identifies the server, lists tools, and calls one", async () => {
  const connection = await connect("normal");
  try {
    assert.equal(connection.state, "ready");
    assert.equal(connection.serverInfo?.name, "faux-mcp");

    const tools = await connection.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["echo-search", "summarise"]);
    // The observed union shape survives the round trip untouched.
    assert.deepEqual(tools[0].inputSchema.properties.limit.anyOf, [{ type: "number" }, { type: "string" }]);

    const result = await connection.callTool("echo-search", { query: "aside", limit: 3 });
    assert.equal(result.content[0].text, "faux result for echo-search");
  } finally {
    await connection.close();
  }
});

test("follows tool-list pagination to the end", async () => {
  const connection = await connect("paginated");
  try {
    const tools = await connection.listTools();
    assert.equal(tools.length, 7);
    assert.equal(tools[6].name, "paged-tool-6");
  } finally {
    await connection.close();
  }
});

test("refuses a server that repeats a cursor instead of looping forever", async () => {
  const connection = await connect("pagination-loop");
  try {
    await expectRefusal(() => connection.listTools(), "mcp_pagination_loop");
  } finally {
    await connection.close();
  }
});

test("bounds a server that pages forever with fresh cursors", async () => {
  const connection = await connect("pagination-endless");
  try {
    // Distinct from the repeated-cursor case: nothing is wrong with any single
    // page, the server simply never stops, so only the page bound ends it.
    await expectRefusal(() => connection.listTools(), "mcp_too_many_pages");
  } finally {
    await connection.close();
  }
});

test("refuses a server advertising more tools than the bound", async () => {
  const connection = await connect("too-many-tools");
  try {
    await expectRefusal(() => connection.listTools(), "mcp_too_many_tools");
  } finally {
    await connection.close();
  }
});

test("a failing tool list is a typed failure, not an empty list", async () => {
  const connection = await connect("list-fails");
  try {
    // The server's own JSON-RPC internal error (-32603) is preserved rather
    // than flattened into a generic list failure: it is what the server said.
    await expectRefusal(() => connection.listTools(), "mcp_server_error");
  } finally {
    await connection.close();
  }
});

test("a server-reported tool error is preserved as data, not raised", async () => {
  const connection = await connect("call-fails");
  try {
    const result = await connection.callTool("echo-search", {});
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "The server refused the call.");
  } finally {
    await connection.close();
  }
});

test("a thrown server error and a malformed response are distinct failures", async () => {
  const throwing = await connect("call-throws");
  try {
    await expectRefusal(() => throwing.callTool("echo-search", {}), "mcp_server_error");
  } finally {
    await throwing.close();
  }

  const malformed = await connect("malformed-content");
  try {
    await expectRefusal(() => malformed.callTool("helpful", {}), "mcp_malformed_response");
  } finally {
    await malformed.close();
  }
});

test("a call that exceeds its timeout fails rather than hanging", async () => {
  const connection = await connect("call-hangs", {
    limits: { callTimeoutMs: 750, closeTimeoutMs: 1_000 },
  });
  try {
    await expectRefusal(() => connection.callTool("echo-search", {}), "mcp_call_timeout");
  } finally {
    await connection.close();
  }
});

test("cancellation reports as cancelled, not as a server failure", async () => {
  const connection = await connect("call-delays", { limits: { callTimeoutMs: 30_000 } });
  try {
    const controller = new AbortController();
    const pending = connection.callTool("echo-search", {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    await expectRefusal(() => pending, "mcp_call_cancelled");
    // Cancelling one call says nothing about the server, so the connection
    // stays usable rather than being torn down as failed.
    assert.equal(connection.state, "ready");
  } finally {
    await connection.close();
  }
});

test("a server that crashes mid-call fails that call and the connection", async () => {
  const connection = await connect("crash", { limits: { callTimeoutMs: 5_000 } });
  try {
    await assert.rejects(async () => connection.callTool("echo-search", {}), (error) => {
      assert.ok(error instanceof McpClientError);
      assert.notEqual(error.code, "mcp_call_cancelled");
      return true;
    });
    assert.equal(connection.state, "failed");
  } finally {
    await connection.close();
  }
});

test("calling on a closed connection is refused without touching the server", async () => {
  const connection = await connect("normal");
  await connection.close();
  assert.equal(connection.state, "closed");
  await expectRefusal(() => connection.callTool("echo-search", {}), "mcp_disconnected");
  await expectRefusal(() => connection.listTools(), "mcp_disconnected");
});

test("close is idempotent and safe after a crash", async () => {
  const connection = await connect("normal");
  await connection.close();
  await connection.close();
  assert.equal(connection.state, "closed");

  const crashed = await connect("crash", { limits: { callTimeoutMs: 5_000 } });
  await crashed.callTool("echo-search", {}).catch(() => {});
  await crashed.close();
  assert.equal(crashed.state, "failed");
});

test("tolerates a server that writes non-protocol text to stdout", async () => {
  // Observed on a real server: a startup banner written with console.log before
  // the transport starts. It is a defect there, but a client that assumes
  // stdout carries only protocol frames breaks on it.
  const connection = await connect("noisy-stdout");
  try {
    const tools = await connection.listTools();
    assert.equal(tools.length, 2);
  } finally {
    await connection.close();
  }
});

test("refuses every server-initiated request the client does not declare", async () => {
  // The SDK answers -32601 for sampling, roots, and elicitation when the client
  // declares no capabilities. This asserts the fail-closed default holds on our
  // configuration of it, rather than assuming it does.
  const connection = await connect("forbidden-requests");
  try {
    const result = await connection.callTool("helpful", {});
    const text = result.content[0].text;
    assert.match(text, /sampling\/createMessage:refused\(-32601\)/);
    assert.match(text, /roots\/list:refused\(-32601\)/);
    assert.match(text, /elicitation\/create:refused\(-32601\)/);
  } finally {
    await connection.close();
  }
});

test("the server does not inherit the runtime's own environment", async () => {
  // A server that echoes its environment must not be able to show a provider
  // key. The connection passes only values resolved from Aside's configuration,
  // never process.env.
  const secretName = "ASIDE_TEST_ONLY_PROVIDER_KEY";
  const previous = process.env[secretName];
  process.env[secretName] = "sk-live-this-must-not-reach-a-server";
  try {
    const connection = await connect("secret-echo");
    try {
      const result = await connection.callTool("helpful", {});
      const text = result.content[0].text;
      assert.equal(text.includes("sk-live-this-must-not-reach-a-server"), false);
      assert.equal(text.includes(secretName), false);
    } finally {
      await connection.close();
    }
  } finally {
    if (previous === undefined) delete process.env[secretName];
    else process.env[secretName] = previous;
  }
});

test("a server that cannot be started fails at connect with a typed error", async () => {
  const config = validateServerConfig({
    id: "missing",
    command: process.execPath,
    args: ["C:\\definitely\\not\\a\\server.mjs"],
    enabled: true,
    trust_acknowledged: true,
  });
  await assert.rejects(
    () => McpConnection.connect({ config, limits: { connectTimeoutMs: 10_000 } }),
    (error) => {
      assert.ok(error instanceof McpClientError);
      assert.ok(["mcp_connect_failed", "mcp_server_error"].includes(error.code), `unexpected code ${error.code}`);
      return true;
    },
  );
});
