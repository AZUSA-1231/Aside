import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { parseRuntimeRequest, runProtocol } from "../src/protocol.mjs";

test("parses only the Aside prompt and cancel request vocabulary", () => {
  assert.deepEqual(
    parseRuntimeRequest({
      type: "prompt",
      request_id: "request-1",
      text: "hello",
      context: { flow: { id: "flow-1", kind: "conversation" }, blocks: [] },
    }),
    {
      type: "prompt",
      request_id: "request-1",
      text: "hello",
      context: { flow: { id: "flow-1", kind: "conversation" }, blocks: [] },
    },
  );
  assert.deepEqual(
    parseRuntimeRequest({ type: "cancel", request_id: "request-1" }),
    { type: "cancel", request_id: "request-1" },
  );
  assert.deepEqual(
    parseRuntimeRequest({ type: "prompt", request_id: "request-2", text: 4 }),
    { type: "invalid", request_id: "request-2" },
  );
  assert.deepEqual(
    parseRuntimeRequest({ type: "continue", request_id: "request-3" }),
    { type: "invalid", request_id: "request-3" },
  );
});

test("emits restored history before ready and forwards subsequent runtime events", async () => {
  const events = [];
  const calls = [];
  const runtimeFactory = async ({ emit }) => {
    emit({ type: "ready", provider: "faux", model: "faux-model" });
    return {
      history: [
        {
          id: "history-1",
          role: "assistant",
          text: "restored",
          status: "complete",
          timestamp: 1,
        },
      ],
      prompt: async (requestId, text, context) => {
        calls.push({ requestId, text, context });
        emit({ type: "run_started", request_id: requestId });
        emit({ type: "text_delta", request_id: requestId, delta: "answer" });
        emit({ type: "completed", request_id: requestId });
      },
      cancel: (requestId) => calls.push({ cancel: requestId }),
    };
  };
  const input = Readable.from([
    `${JSON.stringify({
      type: "prompt",
      request_id: "protocol-1",
      text: "hello",
      context: { flow: { id: "flow-1", kind: "conversation" }, blocks: [] },
    })}\n`,
    `${JSON.stringify({ type: "prompt", request_id: "bad", text: 4 })}\n`,
    `${JSON.stringify({ type: "cancel", request_id: "protocol-1" })}\n`,
    "not json\n",
  ]);

  await runProtocol({ input, emit: (event) => events.push(event), runtimeFactory });
  await Promise.resolve();

  assert.equal(events[0].type, "history_restored");
  assert.equal(events[1].type, "ready");
  assert.deepEqual(calls[0], {
    requestId: "protocol-1",
    text: "hello",
    context: { flow: { id: "flow-1", kind: "conversation" }, blocks: [] },
  });
  assert.ok(
    events.some(
      (event) =>
        event.type === "text_delta" && event.request_id === "protocol-1",
    ),
  );
  assert.ok(
    events.some(
      (event) => event.type === "failed" && event.request_id === "bad",
    ),
  );
  assert.ok(
    events.some(
      (event) => event.type === "failed" && event.request_id === "invalid",
    ),
  );
  assert.deepEqual(calls.at(-1), { cancel: "protocol-1" });
});

test("emits one terminal event when a runtime rejects after settling", async () => {
  const events = [];
  const runtimeFactory = async ({ emit }) => ({
    history: [],
    prompt: async (requestId) => {
      events.push({ type: "observed_prompt", request_id: requestId });
      emit({ type: "completed", request_id: requestId });
      throw new Error("runtime failure");
    },
    cancel: () => undefined,
  });

  await runProtocol({
    input: Readable.from(`${JSON.stringify({
      type: "prompt",
      request_id: "protocol-reject",
      text: "hello",
    })}\n`),
    emit: (event) => events.push(event),
    runtimeFactory,
  });

  await Promise.resolve();
  assert.equal(
    events.filter(
      (event) =>
        event.request_id === "protocol-reject" &&
        ["completed", "cancelled", "failed"].includes(event.type),
    ).length,
    1,
  );
});
