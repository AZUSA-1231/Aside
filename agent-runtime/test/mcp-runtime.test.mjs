import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type, createModels } from "@earendil-works/pi-ai";
import { Agent } from "@earendil-works/pi-agent-core/aside";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createAsideToolRegistry } from "../src/capability-contract.mjs";
import { MCP_CONFIG_LIMITS } from "../src/mcp-config.mjs";
import { loadMcpServerConfigs } from "../src/mcp-runtime.mjs";
import { buildCapabilitySummary, createConversationRuntime } from "../src/runtime.mjs";

/**
 * Wiring tests: what happens between a configured server and the model.
 *
 * `mcp-adapter.test.mjs` covers adaptation. This file covers the two places a
 * correct adapter can still go wrong — the registry the run actually uses, and
 * what the model is told about it (C6-I023).
 */

const SERVER_EXE = "C:\\Program Files\\nodejs\\node.exe";
const SERVER_SCRIPT = "C:\\servers\\search.mjs";

function definition(overrides = {}) {
  return {
    id: "search",
    display_name: "Search server",
    command: SERVER_EXE,
    args: [SERVER_SCRIPT],
    enabled: true,
    trust_acknowledged: true,
    ...overrides,
  };
}

async function withConfigDir(contents, fn) {
  const dir = await mkdtemp(join(tmpdir(), "aside-mcp-"));
  try {
    if (contents !== undefined) {
      await writeFile(
        join(dir, "mcp.json"),
        typeof contents === "string" ? contents : JSON.stringify(contents),
        "utf8",
      );
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("no config directory means no servers and no diagnostics", async () => {
  const loaded = await loadMcpServerConfigs({ configDir: undefined });
  assert.deepEqual(loaded.servers, []);
  assert.deepEqual(loaded.diagnostics, []);
});

test("an absent mcp.json is the ordinary case, not a diagnostic", async () => {
  await withConfigDir(undefined, async (dir) => {
    const loaded = await loadMcpServerConfigs({ configDir: dir });
    assert.deepEqual(loaded.servers, []);
    // A user who does not use MCP must not be shown a warning about it.
    assert.deepEqual(loaded.diagnostics, []);
  });
});

test("loads and validates a server definition", async () => {
  await withConfigDir({ servers: [definition()] }, async (dir) => {
    const loaded = await loadMcpServerConfigs({ configDir: dir });
    assert.equal(loaded.servers.length, 1);
    assert.equal(loaded.servers[0].id, "search");
    assert.equal(loaded.servers[0].enabled, true);
    assert.deepEqual(loaded.diagnostics, []);
  });
});

test("accepts a bare array so a hand-written file does not need a wrapper", async () => {
  await withConfigDir([definition()], async (dir) => {
    const loaded = await loadMcpServerConfigs({ configDir: dir });
    assert.equal(loaded.servers.length, 1);
  });
});

test("an unparseable file is reported and treated as no servers", async () => {
  await withConfigDir("{ not json", async (dir) => {
    const loaded = await loadMcpServerConfigs({ configDir: dir });
    assert.deepEqual(loaded.servers, []);
    assert.equal(loaded.diagnostics[0].code, "mcp_config_unparseable");
  });
});

test("a wrong shape is reported by name rather than silently ignored", async () => {
  await withConfigDir({ programmes: [] }, async (dir) => {
    const loaded = await loadMcpServerConfigs({ configDir: dir });
    assert.deepEqual(loaded.servers, []);
    assert.equal(loaded.diagnostics[0].code, "mcp_config_invalid_shape");
  });
});

test("one malformed definition costs only that server", async () => {
  await withConfigDir(
    {
      servers: [
        definition({ id: "good" }),
        { id: "broken", command: "" },
        definition({ id: "also-good" }),
      ],
    },
    async (dir) => {
      const loaded = await loadMcpServerConfigs({ configDir: dir });
      assert.deepEqual(loaded.servers.map((server) => server.id), ["good", "also-good"]);
      assert.equal(loaded.diagnostics.length, 1);
      assert.equal(loaded.diagnostics[0].server_id, "broken");
      assert.equal(loaded.diagnostics[0].code, "mcp_config_invalid");
    },
  );
});

test("a duplicate id keeps the first and reports the second", async () => {
  await withConfigDir(
    { servers: [definition(), definition({ display_name: "Copy" })] },
    async (dir) => {
      const loaded = await loadMcpServerConfigs({ configDir: dir });
      assert.equal(loaded.servers.length, 1);
      assert.equal(loaded.diagnostics[0].code, "duplicate_mcp_server");
    },
  );
});

/**
 * The tool names the run was actually offered, read from the `run_started`
 * event. That payload is what the model sees, so asserting on it tests the
 * model-visible outcome rather than an internal object.
 */
function runStartedTools(events) {
  const started = events.find((event) => event.type === "run_started");
  assert.ok(started, "expected a run_started event");
  return started.tools.map((tool) => tool.name);
}

function mcpDescriptorTool(name, serverLabel) {
  return {
    name,
    description: `[MCP: ${serverLabel}] A connected tool.`,
    label: `${serverLabel}: tool`,
    parameters: Type.Object({ query: Type.String() }),
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: { status: "succeeded" } };
    },
    descriptor: {
      name,
      description: `[MCP: ${serverLabel}] A connected tool.`,
      label: `${serverLabel}: tool`,
      effect: "execute",
      scope: "host",
      egress: "selected_content",
      replay: "non_replayable",
      source: "user_mcp",
      availability: { prerequisites: [] },
      origin: { id: "mcp:search", label: serverLabel },
    },
  };
}

/**
 * A built-in that needs no workspace.
 *
 * Deliberately `scope: "none"`. A workspace-scoped built-in is removed by the
 * availability filter whenever no workspace is resolved, which would make a
 * registry-merge test fail for a reason that has nothing to do with merging.
 * That filtering is real and is asserted separately below.
 */
function builtinTool(name, scope = "none") {
  return {
    name,
    description: `Built-in ${name}.`,
    label: name,
    parameters: Type.Object({ value: Type.String() }),
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: { status: "succeeded" } };
    },
    descriptor: {
      name,
      effect: "read",
      scope,
      egress: "none",
      replay: "safe",
      source: "builtin",
    },
  };
}

test("the summary describes connected tools as external and un-sandboxed", () => {
  const registry = createAsideToolRegistry([
    builtinTool("workspace.read"),
    mcpDescriptorTool("mcp.search.find.0123456789", "Search server"),
  ]);
  const summary = buildCapabilitySummary(registry);

  assert.match(summary, /workspace\.read/);
  assert.match(summary, /mcp\.search\.find\.0123456789/);
  assert.match(summary, /Search server/);
  // The three things a model must be told about an external program, stated
  // rather than left for it to infer.
  assert.match(summary, /not sandboxed/);
  assert.match(summary, /explicit approval/);
  assert.match(summary, /descriptions come from the program itself/);
});

test("connected tools are not described as workspace file tools", () => {
  const registry = createAsideToolRegistry([mcpDescriptorTool("mcp.s.t.0123456789", "Server")]);
  const summary = buildCapabilitySummary(registry);
  // With no built-in tools present, the workspace sentence must not appear:
  // telling the model to work with files using a connected program would be a
  // description of the wrong capability.
  assert.equal(/work with files in the active workspace using these tools/.test(summary), false);
});

test("with no MCP tools the summary is what it was before P6", () => {
  const registry = createAsideToolRegistry([builtinTool("workspace.read")]);
  const summary = buildCapabilitySummary(registry);
  assert.equal(/MCP/.test(summary), false);
  assert.match(summary, /work with files in the active workspace/);
});

test("a run's registry contains both built-in and connected tools", async () => {
  const faux = fauxProvider({ tokensPerSecond: 1_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const builtin = builtinTool("workspace.read");
  const connected = mcpDescriptorTool("mcp.search.find.0123456789", "Search server");
  const agent = new Agent({
    initialState: {
      systemPrompt: "Use the registered tools when needed.",
      model: faux.getModel(),
      thinkingLevel: "off",
      tools: [builtin],
    },
    streamFn: models.streamSimple.bind(models),
    convertToLlm: (messages) => messages,
  });

  faux.setResponses([fauxAssistantMessage("no tools needed")]);
  const events = [];
  const runtime = await createConversationRuntime({
    emit: (event) => events.push(event),
    agent,
    mcp: { toolFactory: async () => [connected] },
  });
  try {
    await runtime.prompt("req-1", "hello");
    // Asserted on the run's own tool list rather than on the runtime's registry
    // afterwards: the registry is rebound when the run settles, so reading it
    // later would not show what the model was actually offered. `run_started`
    // is the serialized, model-visible list, which is the stronger evidence.
    const names = runStartedTools(events);
    assert.ok(names.includes("workspace.read"), `got ${JSON.stringify(names)}`);
    assert.ok(names.includes("mcp.search.find.0123456789"), `got ${JSON.stringify(names)}`);
  } finally {
    runtime.dispose();
  }
});

test("a connected tool is available without a workspace, a file tool is not", async () => {
  // The distinction the adapter's `availability: { prerequisites: [] }` buys:
  // an adapted tool needs a reachable server, not a workspace. A workspace-scoped
  // built-in is still correctly unavailable until one is resolved.
  const faux = fauxProvider({ tokensPerSecond: 1_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const agent = new Agent({
    initialState: {
      systemPrompt: "Use the registered tools when needed.",
      model: faux.getModel(),
      thinkingLevel: "off",
      tools: [builtinTool("workspace.read", "workspace")],
    },
    streamFn: models.streamSimple.bind(models),
    convertToLlm: (messages) => messages,
  });

  faux.setResponses([fauxAssistantMessage("no tools needed")]);
  const events = [];
  const runtime = await createConversationRuntime({
    emit: (event) => events.push(event),
    agent,
    mcp: { toolFactory: async () => [mcpDescriptorTool("mcp.search.find.0123456789", "Search server")] },
  });
  try {
    await runtime.prompt("req-1", "hello");
    assert.deepEqual(runStartedTools(events), ["mcp.search.find.0123456789"]);
  } finally {
    runtime.dispose();
  }
});

test("a server that contributes nothing leaves the built-in registry intact", async () => {
  const faux = fauxProvider({ tokensPerSecond: 1_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const builtin = builtinTool("workspace.read");
  const agent = new Agent({
    initialState: {
      systemPrompt: "Use the registered tools when needed.",
      model: faux.getModel(),
      thinkingLevel: "off",
      tools: [builtin],
    },
    streamFn: models.streamSimple.bind(models),
    convertToLlm: (messages) => messages,
  });

  faux.setResponses([fauxAssistantMessage("no tools needed")]);
  const runtime = await createConversationRuntime({
    emit: () => {},
    agent,
    // A server that failed: its factory reports nothing.
    mcp: { toolFactory: async () => [] },
  });
  try {
    await runtime.prompt("req-1", "hello");
    assert.deepEqual(
      runtime.registry.descriptors.map((descriptor) => descriptor.name),
      ["workspace.read"],
    );
  } finally {
    runtime.dispose();
  }
});

test("an MCP tool reaches the model as a callable tool, end to end", async () => {
  const faux = fauxProvider({ tokensPerSecond: 1_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const seen = [];
  const connected = {
    ...mcpDescriptorTool("mcp.search.find.0123456789", "Search server"),
    async createForRun() {
      return {
        async execute(_toolCallId, params) {
          seen.push(params);
          return {
            content: [{ type: "text", text: "external result" }],
            details: { status: "succeeded" },
          };
        },
      };
    },
  };
  const agent = new Agent({
    initialState: {
      systemPrompt: "Use the registered tools when needed.",
      model: faux.getModel(),
      thinkingLevel: "off",
      tools: [],
    },
    streamFn: models.streamSimple.bind(models),
    convertToLlm: (messages) => messages,
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("mcp.search.find.0123456789", { query: "aside" }, { id: "c1" }),
    ),
    fauxAssistantMessage("done"),
  ]);

  const runtime = await createConversationRuntime({
    emit: () => {},
    agent,
    mcp: { toolFactory: async () => [connected] },
  });
  try {
    await runtime.prompt("req-1", "search for aside");
    assert.deepEqual(seen, [{ query: "aside" }]);
  } finally {
    runtime.dispose();
  }
});

// ---------------------------------------------------------------------------
// A06 — Stop during MCP discovery must not still submit the prompt
//
// Found by the independent audit. `registryForRun` awaits the connected
// servers, and `cancel()` sets `run.cancel_requested` without being able to
// interrupt work already in flight. The run then continued to `agent.prompt()`,
// so the provider was called after the user pressed Stop. The terminal event
// was `cancelled`, which is correct and misleading: it said nothing about the
// request having been sent.
// ---------------------------------------------------------------------------

async function runWithSlowDiscovery({ cancelDuringDiscovery }) {
  const faux = fauxProvider({ tokensPerSecond: 1_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("should not be reached")]);

  const agent = new Agent({
    initialState: {
      systemPrompt: "x",
      model: faux.getModel(),
      thinkingLevel: "off",
      tools: [],
    },
    streamFn: models.streamSimple.bind(models),
    convertToLlm: (messages) => messages,
  });

  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const runtime = await createConversationRuntime({
    emit: (event) => events.push(event),
    agent,
    // A discovery that has not returned yet is exactly the window a user's Stop
    // lands in when a server is slow to start.
    mcp: {
      toolFactory: async () => {
        await gate;
        return [];
      },
    },
  });

  const pending = runtime.prompt("a06", "do the thing");
  if (cancelDuringDiscovery) {
    await Promise.resolve();
    runtime.cancel("a06");
  }
  release();
  await pending;
  runtime.dispose();
  return { events, callCount: faux.state.callCount };
}

test("A06: Stop during discovery means the provider is never called", async () => {
  const { events, callCount } = await runWithSlowDiscovery({ cancelDuringDiscovery: true });

  assert.equal(
    callCount,
    0,
    "the provider was called after the user pressed Stop during discovery",
  );
  assert.equal(
    events.some((event) => event.type === "run_started"),
    false,
    "a cancelled run reported itself as started",
  );
  const terminals = events.filter((event) =>
    ["completed", "cancelled", "failed"].includes(event.type));
  assert.equal(terminals.length, 1, "exactly one terminal event");
  assert.equal(terminals[0].type, "cancelled");
});

test("A06: the same run without a Stop still reaches the provider", async () => {
  // The guard must not be a blanket refusal to start, which would pass the test
  // above while breaking every ordinary run.
  const { events, callCount } = await runWithSlowDiscovery({ cancelDuringDiscovery: false });
  assert.equal(callCount, 1, "an uncancelled run reaches the provider exactly once");
  assert.ok(events.some((event) => event.type === "run_started"));
});

// ---------------------------------------------------------------------------
// A12 — the server cap must apply on the path a user actually takes
//
// Found by the independent audit. `validateServerConfigs` enforces
// `maxServers`, but the file loader called `validateServerConfig` per entry and
// never the batch validator, so a file with any number of valid definitions
// loaded all of them. A bounded contract enforced only by an unused function is
// not enforced.
// ---------------------------------------------------------------------------

test("A12: a configuration past the server cap loads none of them", async () => {
  const many = Array.from({ length: MCP_CONFIG_LIMITS.maxServers + 1 }, (_v, index) =>
    definition({ id: `server-${index}` }));
  await withConfigDir({ servers: many }, async (dir) => {
    const loaded = await loadMcpServerConfigs({ configDir: dir });
    assert.deepEqual(loaded.servers, [], "an over-cap file must not load partially");
    assert.equal(loaded.diagnostics[0].code, "mcp_config_too_many_servers");
  });
});

test("A12: a configuration at the cap still loads", async () => {
  const atCap = Array.from({ length: MCP_CONFIG_LIMITS.maxServers }, (_v, index) =>
    definition({ id: `server-${index}` }));
  await withConfigDir({ servers: atCap }, async (dir) => {
    const loaded = await loadMcpServerConfigs({ configDir: dir });
    assert.equal(loaded.servers.length, MCP_CONFIG_LIMITS.maxServers);
    assert.deepEqual(loaded.diagnostics, []);
  });
});

// ---------------------------------------------------------------------------
// A11 — the override notice must survive the run it describes
//
// Found by the independent audit. The runtime emitted `workspace_overridden`
// and then `run_started`, and the surface resets its per-run state on
// `run_started` — so the notice was cleared by the very event that began the
// run it was about. The user never saw it.
//
// The surface has no test runner (C6-I031), so the ordering is asserted here,
// where it is decidable: the notice must arrive *with* the run, not before it.
// ---------------------------------------------------------------------------

test("A11: an overridden capture arrives with the run it belongs to", async () => {
  const faux = fauxProvider({ tokensPerSecond: 1_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("done")]);

  const agent = new Agent({
    initialState: { systemPrompt: "x", model: faux.getModel(), thinkingLevel: "off", tools: [] },
    streamFn: models.streamSimple.bind(models),
    convertToLlm: (messages) => messages,
  });

  const events = [];
  const runtime = await createConversationRuntime({
    emit: (event) => events.push(event),
    agent,
  });
  try {
    // An explicit workspace hint outranks a captured descriptor in the same
    // prompt, which is the condition that produces the override.
    const workspace = await mkdtemp(join(tmpdir(), "aside-override-"));
    await runtime.prompt("a11", "do the thing", {
      flow: { id: "f1", kind: "conversation" },
      blocks: [],
      attachments: [
        {
          id: "att-1",
          host: "explorer",
          source: "capture",
          capturedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          sensitivity: "local_metadata",
          summary: "captured",
          blocks: [],
          descriptors: [{ role: "active_file", path: join(workspace, "other.txt"), kind: "file" }],
        },
      ],
    }, workspace);
    await rm(workspace, { recursive: true, force: true });

    const started = events.findIndex((event) => event.type === "run_started");
    const standalone = events.findIndex((event) => event.type === "workspace_overridden");

    // Either there is no override (the explicit hint and the capture agreed),
    // or it travels on the run. What must not happen is a standalone notice
    // arriving before the run that then clears it.
    if (standalone >= 0) {
      assert.fail(
        "a standalone workspace_overridden event precedes run_started and will be cleared by it",
      );
    }
    if (started >= 0 && events[started].workspace_overridden) {
      assert.equal(typeof events[started].workspace_overridden.replaced_by, "string");
      assert.equal(typeof events[started].workspace_overridden.captured_path, "string");
    }
  } finally {
    runtime.dispose();
  }
});
