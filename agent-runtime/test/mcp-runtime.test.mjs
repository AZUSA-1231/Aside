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
