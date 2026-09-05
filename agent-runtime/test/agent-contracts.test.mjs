import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  AsideContractError,
  DEFAULT_AGENT_LIMITS,
  boundedToolResult,
  createAsideToolRegistry,
  createTaskRun,
  normalizeAgentLimits,
  previewValue,
  truncateText,
} from "../src/agent-contracts.mjs";
import { createConversationRuntime } from "../src/runtime.mjs";
import { Agent } from "@earendil-works/pi-agent-core/aside";
import { createModels } from "@earendil-works/pi-ai";

function makeAgent(faux, tools = []) {
  const models = createModels();
  models.setProvider(faux.provider);
  return new Agent({
    initialState: {
      systemPrompt: "Use the registered tools when needed.",
      model: faux.getModel(),
      thinkingLevel: "off",
      tools,
    },
    streamFn: models.streamSimple.bind(models),
    convertToLlm: (messages) => messages,
  });
}

function resultText(result) {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function readTool(name, calls) {
  return {
    name,
    description: `Read with ${name}.`,
    label: name,
    parameters: Type.Object({ value: Type.String() }),
    async execute(_toolCallId, params) {
      calls.push(params.value);
      return {
        content: [{ type: "text", text: `read:${params.value}` }],
        details: { status: "succeeded", value: params.value },
      };
    },
    descriptor: {
      effect: "read",
      scope: "workspace",
      replay: "safe",
    },
  };
}

test("validates task, limit, registry, and bounded result contracts", () => {
  const run = createTaskRun({ requestId: "request-1", now: 10 });
  assert.equal(run.task_id, "request-1");
  assert.deepEqual(run.limits, DEFAULT_AGENT_LIMITS);
  assert.equal(normalizeAgentLimits({ maxToolCalls: 2 }).maxToolCalls, 2);
  assert.throws(
    () => normalizeAgentLimits({ maxToolCalls: 0 }),
    AsideContractError,
  );
  assert.throws(
    () => createAsideToolRegistry([readTool("same", []), readTool("same", [])]),
    /registered more than once/,
  );

  const preview = previewValue({ token: "secret-value", text: "safe" });
  assert.match(preview.text, /redacted/);
  assert.doesNotMatch(preview.text, /secret-value/);
  assert.deepEqual(truncateText("你好世界", 7), { text: "你好", truncated: true });
  const bounded = boundedToolResult(
    { content: [{ type: "text", text: "abcdefghij" }], details: { ok: true } },
    5,
  );
  assert.equal(resultText(bounded), "abcde");
  assert.equal(bounded.truncated, true);
});

test("continues the same Pi loop across two registered tool results", async () => {
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  const calls = [];
  const tools = [readTool("workspace.first", calls), readTool("workspace.second", calls)];
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("workspace.first", { value: "one" }, { id: "tool-1" })),
    fauxAssistantMessage(fauxToolCall("workspace.second", { value: "two" }, { id: "tool-2" })),
    fauxAssistantMessage("finished after two reads"),
  ]);
  const events = [];
  const runtime = await createConversationRuntime({
    agent: makeAgent(faux, tools),
    emit: (event) => events.push(event),
    taskId: "task-1",
    workspaceHint: process.cwd(),
  });

  await runtime.prompt("request-1", "inspect both values");

  assert.equal(faux.state.callCount, 3);
  assert.deepEqual(calls, ["one", "two"]);
  assert.equal(events.filter((event) => event.type === "tool_call_started").length, 2);
  assert.equal(events.filter((event) => event.type === "tool_result").length, 2);
  assert.equal(events.at(-1).type, "completed");
  assert.equal(events.at(-1).task_id, "task-1");
  assert.deepEqual(
    events.filter((event) => event.type === "tool_result").map((event) => event.status),
    ["succeeded", "succeeded"],
  );
});

test("tool limits fail closed with one terminal event", async () => {
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  const calls = [];
  const tool = readTool("workspace.read", calls);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("workspace.read", { value: "one" }, { id: "tool-limit" })),
    fauxAssistantMessage(fauxToolCall("workspace.read", { value: "two" }, { id: "tool-limit-2" })),
  ]);
  const events = [];
  const runtime = await createConversationRuntime({
    agent: makeAgent(faux, [tool]),
    emit: (event) => events.push(event),
    limits: { maxToolCalls: 1 },
    workspaceHint: process.cwd(),
  });

  await runtime.prompt("request-limit", "read once");

  assert.equal(calls.length, 1);
  assert.equal(events.filter((event) => ["completed", "cancelled", "failed"].includes(event.type)).length, 1);
  assert.equal(events.at(-1).type, "failed");
  assert.equal(events.at(-1).code, "tool_call_limit");
});
