import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core/aside";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { validateTurnContext } from "../src/context.mjs";
import { createConversationRuntime } from "../src/runtime.mjs";

function makeAgent(faux) {
  const models = createModels();
  models.setProvider(faux.provider);
  return new Agent({
    initialState: {
      systemPrompt: "Answer briefly.",
      model: faux.getModel(),
      thinkingLevel: "off",
    },
    streamFn: models.streamSimple.bind(models),
    convertToLlm: (messages) => messages,
  });
}

function waitFor(events, predicate) {
  if (events.some(predicate)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (events.some(predicate)) {
        clearInterval(timer);
        resolve();
      }
    }, 5);
  });
}

test("streams a successful response", async () => {
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  faux.setResponses([fauxAssistantMessage("hello from Aside")]);
  const events = [];
  const runtime = await createConversationRuntime({
    agent: makeAgent(faux),
    emit: (event) => events.push(event),
  });

  await runtime.prompt("run-1", "hello");
  assert.ok(events.some((event) => event.type === "text_delta"));
  assert.ok(events.some((event) => event.type === "completed"));
});

test("rejects an overlapping request without disturbing the active run", async () => {
  const faux = fauxProvider({
    tokensPerSecond: 10,
    tokenSize: { min: 1, max: 1 },
  });
  faux.setResponses([fauxAssistantMessage("a response that keeps streaming")]);
  const events = [];
  const runtime = await createConversationRuntime({
    agent: makeAgent(faux),
    emit: (event) => events.push(event),
  });

  const firstRun = runtime.prompt("run-overlap-1", "first");
  await waitFor(events, (event) => event.type === "text_delta");
  await runtime.prompt("run-overlap-2", "second");
  runtime.cancel("run-overlap-1");
  await firstRun;

  assert.ok(
    events.some(
      (event) =>
        event.type === "failed" &&
        event.request_id === "run-overlap-2" &&
        event.retryable,
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "cancelled" && event.request_id === "run-overlap-1",
    ),
  );
  assert.equal(
    events.filter(
      (event) =>
        event.request_id === "run-overlap-1" &&
        ["completed", "cancelled", "failed"].includes(event.type),
    ).length,
    1,
  );
});

test("cancels a streaming response", async () => {
  const faux = fauxProvider({
    tokensPerSecond: 10,
    tokenSize: { min: 1, max: 1 },
  });
  faux.setResponses([fauxAssistantMessage("a long response that can be stopped")]);
  const events = [];
  const runtime = await createConversationRuntime({
    agent: makeAgent(faux),
    emit: (event) => events.push(event),
  });

  const run = runtime.prompt("run-2", "stop this");
  await waitFor(events, (event) => event.type === "text_delta");
  runtime.cancel("run-2");
  await run;
  assert.ok(events.some((event) => event.type === "cancelled"));
});

test("reports a provider failure and can retry", async () => {
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "provider unavailable",
    }),
    fauxAssistantMessage("recovered"),
  ]);
  const events = [];
  const agent = makeAgent(faux);
  const runtime = await createConversationRuntime({
    agent,
    emit: (event) => events.push(event),
  });

  await runtime.prompt("run-3", "try once");
  await runtime.prompt("run-4", "try again");
  assert.ok(
    events.some(
      (event) => event.type === "failed" && event.request_id === "run-3",
    ),
  );
  assert.ok(
    events.some(
      (event) => event.type === "completed" && event.request_id === "run-4",
      ),
  );
  assert.equal(
    agent.state.messages.some(
      (message) =>
        message.role === "assistant" &&
        ["error", "aborted", "deferred"].includes(message.stopReason),
    ),
    false,
  );
});

test("sanitizes provider credentials in failure events", async () => {
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "request failed with apiKey=sk-test-secret-1234567890",
    }),
  ]);
  const events = [];
  const runtime = await createConversationRuntime({
    agent: makeAgent(faux),
    emit: (event) => events.push(event),
  });

  await runtime.prompt("run-secret", "try");
  const failure = events.find(
    (event) => event.type === "failed" && event.request_id === "run-secret",
  );
  assert.ok(failure);
  assert.doesNotMatch(failure.message, /sk-test-secret/);
  assert.match(failure.message, /apiKey=\[redacted\]/i);
});

test("ignores late cancellation after the request has settled", async () => {
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  faux.setResponses([fauxAssistantMessage("done")]);
  const events = [];
  const runtime = await createConversationRuntime({
    agent: makeAgent(faux),
    emit: (event) => events.push(event),
  });

  await runtime.prompt("run-late", "finish");
  const terminalCount = () =>
    events.filter(
      (event) =>
        event.request_id === "run-late" &&
        ["completed", "cancelled", "failed"].includes(event.type),
    ).length;
  assert.equal(terminalCount(), 1);
  runtime.cancel("run-late");
  assert.equal(terminalCount(), 1);
});

test("projects text and JSON context for one run only", async () => {
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  const providerContexts = [];
  faux.setResponses([
    (context) => {
      providerContexts.push(structuredClone(context));
      return fauxAssistantMessage("first");
    },
    (context) => {
      providerContexts.push(structuredClone(context));
      return fauxAssistantMessage("second");
    },
  ]);
  const agent = makeAgent(faux);
  const runtime = await createConversationRuntime({
    agent,
    emit: () => undefined,
  });

  await runtime.prompt("context-1", "with context", {
    flow: { id: "flow-1", kind: "schedule", label: "Draft" },
    blocks: [
      { type: "text", label: "Goal", text: "move the meeting" },
      { type: "json", label: "Draft event", data: { b: 2, a: 1 } },
    ],
  });
  await runtime.prompt("context-2", "without context");

  const firstText = providerContexts[0].messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((block) => block.text ?? "").join(""),
    )
    .join("\n");
  assert.match(firstText, /move the meeting/);
  assert.match(firstText, /"a":1,"b":2/);
  assert.match(firstText, /untrusted reference data/i);
  const projectionIndex = providerContexts[0].messages.findIndex(
    (message) =>
      message.role === "user" &&
      Array.isArray(message.content) &&
      message.content.some((block) =>
        (block.text ?? "").includes("[Aside reference context]"),
      ),
  );
  const promptIndex = providerContexts[0].messages.findIndex(
    (message) =>
      message.role === "user" &&
      Array.isArray(message.content) &&
      message.content.some((block) => block.text === "with context"),
  );
  assert.equal(
    projectionIndex + 1,
    promptIndex,
  );
  assert.equal(
    providerContexts[1].messages.some((message) =>
      message.role === "user" &&
      Array.isArray(message.content) &&
      message.content.some((block) => /move the meeting/.test(block.text ?? "")),
    ),
    false,
  );
  assert.equal(
    agent.state.messages.some((message) =>
      JSON.stringify(message).includes("move the meeting"),
    ),
    false,
  );
});

test("reuses one context projection across repeated provider turns", async () => {
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  const providerContexts = [];
  faux.setResponses([
    (context) => {
      providerContexts.push(structuredClone(context));
      return fauxAssistantMessage({
        type: "toolCall",
        id: "missing-tool-call",
        name: "missing-tool",
        arguments: {},
      });
    },
    (context) => {
      providerContexts.push(structuredClone(context));
      return fauxAssistantMessage("finished");
    },
  ]);
  const runtime = await createConversationRuntime({
    agent: makeAgent(faux),
    emit: () => undefined,
  });

  await runtime.prompt("context-turns", "use context", {
    flow: { id: "flow-2", kind: "conversation" },
    blocks: [{ type: "text", text: "only once per provider context" }],
  });

  assert.equal(providerContexts.length, 2);
  for (const context of providerContexts) {
    assert.equal(
      context.messages.filter(
        (message) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          message.content.some((block) =>
            (block.text ?? "").includes("only once per provider context"),
          ),
      ).length,
      1,
    );
  }
});

test("rejects malformed and over-limit context before the provider call", async () => {
  const faux = fauxProvider({ tokensPerSecond: 1000 });
  faux.setResponses([fauxAssistantMessage("should not run")]);
  const events = [];
  const runtime = await createConversationRuntime({
    agent: makeAgent(faux),
    emit: (event) => events.push(event),
  });

  await runtime.prompt("context-invalid", "ask", {
    flow: { id: "flow-invalid", kind: "Conversation" },
    blocks: [{ type: "text", text: "invalid kind" }],
  });
  await runtime.prompt("context-large", "ask", {
    flow: { id: "flow-large", kind: "conversation" },
    blocks: [{ type: "text", text: "x".repeat(8 * 1024 + 1) }],
  });

  assert.equal(faux.state.callCount, 0);
  assert.equal(
    events.filter(
      (event) => event.type === "failed" && event.request_id.startsWith("context-"),
    ).length,
    2,
  );
});

test("canonicalizes and bounds standalone turn context", () => {
  const context = validateTurnContext({
    flow: { id: "flow-3", kind: "note" },
    blocks: [{ type: "json", data: { z: 1, a: { d: 4, c: 3 } } }],
  });
  assert.match(context.projectionText, /"a":\{"c":3,"d":4\},"z":1/);
  assert.throws(
    () =>
      validateTurnContext({
        flow: { id: "flow-4", kind: "note" },
        blocks: [{ type: "json", data: { value: Number.NaN } }],
      }),
    /context field "blocks\[0\]\.data\.value" is invalid/,
  );
});
