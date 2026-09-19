import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Type, createModels } from "@earendil-works/pi-ai";
import { Agent } from "@earendil-works/pi-agent-core/aside";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { encodeMcpToolName } from "../src/capability-contract.mjs";
import { McpController, createMcpToolFactory } from "../src/mcp-adapter.mjs";
import { McpConnection } from "../src/mcp-client.mjs";
import { validateServerConfig } from "../src/mcp-config.mjs";
import { buildCapabilitySummary, createConversationRuntime } from "../src/runtime.mjs";

/** The Aside name a connected server's tool actually gets. */
function mcpToolName(toolName, serverId = "faux") {
  return encodeMcpToolName({ serverId, toolName });
}

/**
 * P7 evidence audits (tasks 10 and 14).
 *
 * These assert the properties the release boundary rests on, against serialized
 * artifacts rather than against the surface's appearance. P0 established the
 * rule: "UI appearance alone does not prove registry absence or policy
 * authority." The same applies here — a tool list that looks right in the rail
 * is not evidence about what the model was offered, and an event stream that
 * looks clean is not evidence about what it carried.
 *
 * The artifacts inspected are:
 *
 *  - the **run registry** as serialized into `run_started`, which is the
 *    bounded display projection;
 *  - the **provider context**, captured through a faux response factory, which
 *    is what Pi hands to the provider layer;
 *  - the **event stream**, captured from `emit`;
 *  - the **messages handed to persistence**, captured from `onRunSettled`.
 *
 * One thing these audits deliberately do **not** claim: they do not capture a
 * real provider HTTP request, because that needs a network. Pi's wire
 * serialization was read instead and picks `name`, `description`, and the
 * parameter schema explicitly for both the Anthropic and OpenAI paths, so the
 * internal descriptor does not reach it. That is a code-level finding, recorded
 * as such, not a captured payload.
 */

const SERVER_PATH = fileURLToPath(new URL("./fixtures/faux-mcp-server.mjs", import.meta.url));
const FAKE_CREDENTIAL = "sk-live-abcdef0123456789";

/** Tool names that must never be reachable by the model (C6-42, C6-I003). */
const PROHIBITED_TOOL_PATTERNS = [
  /shell/i,
  /powershell/i,
  /terminal/i,
  /\bprocess\b/i,
  /\bexec\b/i,
  /code_exec/i,
  /arbitrary_fetch/i,
  /fetch_url/i,
  /pdf_(edit|write|mutate)/i,
  /excel|powerpoint|notion|github|vscode/i,
];

function configFor(overrides = {}) {
  return validateServerConfig({
    id: "faux",
    display_name: "Faux server",
    command: process.execPath,
    args: [SERVER_PATH],
    enabled: true,
    trust_acknowledged: true,
    ...overrides,
  });
}

function controllerFor(scenario) {
  return new McpController({
    servers: [configFor()],
    connectionFactory: (options) => McpConnection.connect({
      ...options,
      environment: { FAUX_MCP_SCENARIO: scenario },
    }),
  });
}

function builtinTool(name) {
  return {
    name,
    description: `Built-in ${name}.`,
    label: name,
    parameters: Type.Object({ value: Type.String() }),
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: { status: "succeeded" } };
    },
    descriptor: { name, effect: "read", scope: "none", egress: "none", replay: "safe", source: "builtin" },
  };
}

/**
 * Runs one prompt and returns every artifact the audits inspect.
 *
 * The response factory receives Pi's real `Context`, so `capturedContexts[0]`
 * is what the provider layer was actually given — not a reconstruction.
 */
async function runOnce({ responses, mcp, allowPermission = false } = {}) {
  const faux = fauxProvider({ tokensPerSecond: 1_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const capturedContexts = [];
  const events = [];
  const persisted = [];

  const agent = new Agent({
    initialState: {
      systemPrompt: "Use the registered tools when needed.",
      model: faux.getModel(),
      thinkingLevel: "off",
      tools: [builtinTool("aside.echo")],
    },
    streamFn: models.streamSimple.bind(models),
    convertToLlm: (messages) => messages,
  });

  // Every step is wrapped so each turn's real provider context is captured.
  // Putting the capture *first* as a separate step would consume the first turn
  // and the scripted tool call would never be reached — the audit would then be
  // inspecting a run that never called anything.
  const steps = responses ?? [fauxAssistantMessage("done")];
  faux.setResponses(
    steps.map((step) => (context) => {
      capturedContexts.push(context);
      return typeof step === "function" ? step(context) : step;
    }),
  );

  let runtime;
  const emit = (event) => {
    events.push(event);
    // Approval goes through the runtime's own broker rather than a stub. A
    // stub that answers "allow" without producing a grant is refused by the
    // runtime's post-call verification (C6-I013), so the audit would end up
    // inspecting the artifacts of a denial while claiming to inspect a result.
    if (allowPermission && event.type === "permission_requested") {
      runtime.resolvePermission(event.permission_id, "allow", {
        request_id: event.request_id,
        task_id: event.task_id,
        tool_call_id: event.tool_call_id,
      });
    }
  };

  runtime = await createConversationRuntime({
    emit,
    agent,
    onRunSettled: (messages) => persisted.push(...messages),
    // The same builder `createConfiguredAgent` supplies. Without it the runtime
    // leaves the agent's initial prompt alone, and the capability summary would
    // never be part of what the provider receives — which is correct behavior
    // but would make this audit assert nothing.
    buildSystemPromptFor: (registry) =>
      `Use the registered tools when needed.\n\n${buildCapabilitySummary(registry)}`,
    mcp,
  });
  try {
    await runtime.prompt("audit-1", "do the thing");
  } finally {
    runtime.dispose();
  }
  return { events, capturedContexts, persisted };
}

function runStartedTools(events) {
  const started = events.find((event) => event.type === "run_started");
  assert.ok(started, "expected a run_started event");
  return started.tools ?? [];
}

// ---------------------------------------------------------------------------
// C6-42 / C6-I003 — the model-visible registry contains no deferred capability
// ---------------------------------------------------------------------------

test("audit: the run registry exposes no prohibited capability, with MCP connected", async () => {
  const controller = controllerFor("normal");
  const { events } = await (async () => {
    const result = await runOnce({ mcp: { toolFactory: createMcpToolFactory(controller) } });
    await controller.close();
    return result;
  })();

  const names = runStartedTools(events).map((tool) => tool.name);
  assert.ok(names.length > 0, "the run offered no tools at all, which proves nothing");
  for (const name of names) {
    for (const pattern of PROHIBITED_TOOL_PATTERNS) {
      assert.equal(
        pattern.test(name),
        false,
        `the model-visible registry contains "${name}", which matches ${pattern}`,
      );
    }
  }
  // The audit is only meaningful because the adapter did contribute tools.
  assert.ok(
    names.some((name) => name.startsWith("mcp.")),
    `expected adapted tools in the registry, got ${JSON.stringify(names)}`,
  );
});

test("audit: the provider context offers exactly the registry's tools", async () => {
  const controller = controllerFor("normal");
  const { events, capturedContexts } = await (async () => {
    const result = await runOnce({ mcp: { toolFactory: createMcpToolFactory(controller) } });
    await controller.close();
    return result;
  })();

  const registryNames = runStartedTools(events).map((tool) => tool.name).sort();
  const contextNames = (capturedContexts[0]?.tools ?? []).map((tool) => tool.name).sort();
  assert.deepEqual(
    contextNames,
    registryNames,
    "the tools handed to the provider differ from the tools the run reported",
  );
});

test("audit: the display projection carries no trusted identity", async () => {
  const controller = controllerFor("normal");
  const { events } = await (async () => {
    const result = await runOnce({ mcp: { toolFactory: createMcpToolFactory(controller) } });
    await controller.close();
    return result;
  })();

  for (const tool of runStartedTools(events)) {
    // `origin.id` may embed a path or a URL, so it is deliberately not
    // published. Only the label travels.
    assert.equal("origin" in tool, false, `${tool.name} published an origin object`);
    assert.equal(typeof tool.origin_label, "string");
    // And no smuggled trust claim rides along on the display shape.
    assert.equal("trusted" in tool, false, `${tool.name} published a trusted field`);
    assert.equal("policy" in tool, false, `${tool.name} published a policy field`);
  }
});

// ---------------------------------------------------------------------------
// C6-29 / C6-36 / C6-41 — nothing prohibited reaches events or persistence
// ---------------------------------------------------------------------------

test("audit: a credential returned by a server is absent from every serialized artifact", async () => {
  const controller = controllerFor("secret-echo");
  const { events, capturedContexts, persisted } = await (async () => {
    const result = await runOnce({
      mcp: { toolFactory: createMcpToolFactory(controller) },
      allowPermission: true,
      responses: [
        // `secret-echo` advertises the normal tool set and answers any call
        // with a credential-shaped payload. Naming a tool the scenario does not
        // offer would produce no result, and the audit would then pass by
        // inspecting nothing.
        fauxAssistantMessage(
          fauxToolCall(mcpToolName("echo-search"), { query: "x" }, { id: "c1" }),
        ),
        fauxAssistantMessage("done"),
      ],
    });
    await controller.close();
    return result;
  })();

  // The run must actually have happened for the absence to mean anything.
  assert.ok(events.some((event) => event.type === "tool_result"), "no tool result was produced");

  const artifacts = {
    events: JSON.stringify(events),
    // Pi's internal context, which is the closest available proxy for what the
    // provider layer receives.
    provider_context: JSON.stringify(capturedContexts),
    persisted: JSON.stringify(persisted),
  };
  for (const [name, serialized] of Object.entries(artifacts)) {
    assert.equal(
      serialized.includes(FAKE_CREDENTIAL),
      false,
      `${name} carries the credential verbatim`,
    );
  }
});

test("audit: persistence receives no active permission, connection, or extracted document", async () => {
  const controller = controllerFor("normal");
  const { persisted } = await (async () => {
    const result = await runOnce({ mcp: { toolFactory: createMcpToolFactory(controller) } });
    await controller.close();
    return result;
  })();

  const serialized = JSON.stringify(persisted);
  // No authority survives a restart: the messages are conversation only.
  for (const prohibited of ["permission_id", "tool_call_id", "canonical_path", "descriptor"]) {
    assert.equal(
      serialized.includes(prohibited),
      false,
      `persistence carries "${prohibited}", which is not conversation`,
    );
  }
});

// ---------------------------------------------------------------------------
// The advertised shape of what a connected server contributes
// ---------------------------------------------------------------------------

test("audit: adapted tools are marked external and carry no containment claim", async () => {
  const controller = controllerFor("normal");
  const { events } = await (async () => {
    const result = await runOnce({ mcp: { toolFactory: createMcpToolFactory(controller) } });
    await controller.close();
    return result;
  })();

  const adapted = runStartedTools(events).filter((tool) => tool.source === "user_mcp");
  assert.ok(adapted.length > 0, "no adapted tools were reported");
  for (const tool of adapted) {
    // The runtime's own classification, not the server's self-description.
    assert.notEqual(tool.scope, "workspace", `${tool.name} claims workspace containment`);
    assert.equal(tool.replay, "non_replayable", `${tool.name} claims replay safety`);
    assert.equal(tool.egress === "none", false, `${tool.name} claims no egress`);
  }
});

test("audit: the system prompt describes connected tools as external and un-sandboxed", async () => {
  const controller = controllerFor("normal");
  const { capturedContexts } = await (async () => {
    const result = await runOnce({ mcp: { toolFactory: createMcpToolFactory(controller) } });
    await controller.close();
    return result;
  })();

  const systemPrompt = String(capturedContexts[0]?.systemPrompt ?? "");
  assert.ok(systemPrompt.length > 0, "the provider context carried no system prompt");
  assert.match(systemPrompt, /not sandboxed/);
  assert.match(systemPrompt, /explicit approval/);
  assert.match(systemPrompt, /descriptions come from the program itself/);
});
