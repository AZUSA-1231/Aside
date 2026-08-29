import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
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
  const runtime = await createConversationRuntime({
    agent: makeAgent(faux),
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
});
