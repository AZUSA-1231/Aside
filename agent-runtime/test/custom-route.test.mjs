import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile as readFileText, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadAsideConfig } from "../src/config.mjs";
import { buildCustomRoute, resolveCustomRoute } from "../src/custom-route.mjs";
import { getProviderCatalog, selectConfiguredProvider, testProviderConnection } from "../src/provider-settings.mjs";
import { createConfiguredAgent } from "../src/runtime.mjs";
import { handleSettingsRequest } from "../src/settings-service.mjs";
import { validateSettingsDocument } from "../src/settings-schema.mjs";

/**
 * These tests exercise the real Pi adapters against two local servers: one
 * speaking Chat Completions and one speaking Responses. Asserting on the
 * captured HTTP request and on the final assistant message proves the route is
 * dispatchable, not merely that a factory returned an object.
 */

const CUSTOM_KEY = "custom-route-fixture-key";

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "aside-custom-route-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const environment = {
    LOCALAPPDATA: join(root, "data"),
    ASIDE_SETTINGS_PATH: join(root, "data", "Aside", "settings.json"),
  };
  return { root, environment, cwd: root };
}

async function writeSettings(options, document) {
  await mkdir(dirname(options.environment.ASIDE_SETTINGS_PATH), { recursive: true });
  await writeFile(options.environment.ASIDE_SETTINGS_PATH, JSON.stringify(document));
}

async function listen(context, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}/v1`;
}

async function readJsonBody(request) {
  let input = "";
  for await (const chunk of request) input += chunk;
  return JSON.parse(input);
}

function completionsChunk(delta, finish = null) {
  return JSON.stringify({ id: "chatcmpl-fixture", model: "route-model", choices: [{ index: 0, delta, finish_reason: finish }] });
}

function sse(response, ...events) {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (const event of events) response.write(`data: ${event}\n\n`);
  response.end("data: [DONE]\n\n");
}

function responsesSse(response, events) {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

function responsesBase(id = "resp_fixture") {
  return {
    id,
    object: "response",
    created_at: 0,
    model: "route-model",
    status: "in_progress",
    output: [],
    parallel_tool_calls: false,
    tool_choice: "auto",
    tools: [],
  };
}

async function customConfiguration(options, overrides = {}) {
  await writeSettings(options, {
    schema_version: 1,
    provider: "custom",
    custom_protocol: "openai-completions",
    custom_context_window: "128000",
    custom_max_output: "8192",
    ...overrides,
  });
  return loadAsideConfig({ ...options, credentialValues: { custom: CUSTOM_KEY } });
}

test("the custom route validates its declaration before any network access", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Validation must not access the network"); };
  try {
    for (const values of [
      { ASIDE_PROVIDER: "custom" },
      { ASIDE_PROVIDER: "custom", ASIDE_CUSTOM_PROTOCOL: "anthropic-messages", ASIDE_MODEL: "m", ASIDE_API_URL: "https://route.test/v1", ASIDE_CUSTOM_CONTEXT_WINDOW: "100", ASIDE_CUSTOM_MAX_OUTPUT: "10" },
      { ASIDE_PROVIDER: "custom", ASIDE_CUSTOM_PROTOCOL: "openai-completions", ASIDE_CUSTOM_CONTEXT_WINDOW: "100", ASIDE_CUSTOM_MAX_OUTPUT: "10" },
      { ASIDE_PROVIDER: "custom", ASIDE_CUSTOM_PROTOCOL: "openai-completions", ASIDE_MODEL: "bad\nmodel", ASIDE_API_URL: "https://route.test/v1", ASIDE_CUSTOM_CONTEXT_WINDOW: "100", ASIDE_CUSTOM_MAX_OUTPUT: "10" },
      { ASIDE_PROVIDER: "custom", ASIDE_CUSTOM_PROTOCOL: "openai-completions", ASIDE_MODEL: "m", ASIDE_CUSTOM_CONTEXT_WINDOW: "100", ASIDE_CUSTOM_MAX_OUTPUT: "10" },
      { ASIDE_PROVIDER: "custom", ASIDE_CUSTOM_PROTOCOL: "openai-completions", ASIDE_MODEL: "m", ASIDE_API_URL: "https://route.test/v1", ASIDE_CUSTOM_CONTEXT_WINDOW: "0", ASIDE_CUSTOM_MAX_OUTPUT: "10" },
      { ASIDE_PROVIDER: "custom", ASIDE_CUSTOM_PROTOCOL: "openai-completions", ASIDE_MODEL: "m", ASIDE_API_URL: "https://route.test/v1", ASIDE_CUSTOM_CONTEXT_WINDOW: "100", ASIDE_CUSTOM_MAX_OUTPUT: "200" },
      { ASIDE_PROVIDER: "custom", ASIDE_CUSTOM_PROTOCOL: "openai-completions", ASIDE_MODEL: "m", ASIDE_API_URL: "https://route.test/v1", ASIDE_CUSTOM_CONTEXT_WINDOW: "100", ASIDE_CUSTOM_MAX_OUTPUT: "10", ASIDE_CUSTOM_TOOLS: "maybe" },
    ]) {
      assert.throws(() => resolveCustomRoute(values), (error) => error.name === "SettingsError");
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("an undeclared custom route is rejected instead of projected as a model", async () => {
  await assert.rejects(getProviderCatalog("custom"), (error) => error.name === "SettingsError");
  const declared = await getProviderCatalog("custom", {
    ASIDE_PROVIDER: "custom",
    ASIDE_CUSTOM_PROTOCOL: "openai-completions",
    ASIDE_MODEL: "route-model",
    ASIDE_API_URL: "https://route.test/v1",
    ASIDE_CUSTOM_CONTEXT_WINDOW: "128000",
    ASIDE_CUSTOM_MAX_OUTPUT: "8192",
  });
  assert.equal(declared.custom, true);
  assert.equal(declared.protocol, "openai-completions");
  assert.deepEqual(declared.models.map((model) => model.id), ["route-model"]);
  assert.deepEqual(declared.models[0].thinking_levels, ["off"]);
  assert.deepEqual(declared.models[0].input, ["text"]);
});

test("the custom route sends Chat Completions, streaming text and a tool round trip", async (context) => {
  const options = await fixture(context);
  const requests = [];
  let call = 0;
  const baseUrl = await listen(context, async (request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    const body = await readJsonBody(request);
    requests.at(-1).body = body;
    call += 1;
    if (call === 1) {
      sse(response,
        completionsChunk({ role: "assistant", content: "Reading " }),
        completionsChunk({ content: "the file." }),
        completionsChunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "list", arguments: "{\"path\":\".\"}" } }] }),
        completionsChunk({}, "tool_calls"));
      return;
    }
    assert.ok(requests.at(-1).body.messages.some((message) => message.role === "tool"), "the tool result must be replayed");
    sse(response,
      completionsChunk({ role: "assistant", content: "Done." }),
      completionsChunk({}, "stop"));
  });
  await writeSettings(options, {
    schema_version: 1, provider: "custom", custom_protocol: "openai-completions",
    model: "route-model", api_url: baseUrl, custom_context_window: "128000", custom_max_output: "8192",
  });
  const configuration = await loadAsideConfig({ ...options, credentialValues: { custom: CUSTOM_KEY } });
  const { models, providerId, model } = await selectConfiguredProvider(configuration);
  assert.equal(providerId, "custom");
  assert.equal(model.id, "route-model");
  assert.equal(model.input.includes("image"), false);

  const tools = [{ name: "list", description: "List a directory", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
  const first = await models.completeSimple(model, { systemPrompt: "Be brief.", messages: [{ role: "user", content: "What is here?", timestamp: Date.now() }], tools }, { maxTokens: 256 });
  assert.equal(first.stopReason, "toolUse");
  const call1 = first.content.find((block) => block.type === "toolCall");
  assert.equal(call1.name, "list");
  assert.deepEqual(call1.arguments, { path: "." });

  assert.match(requests[0].url, /\/v1\/chat\/completions$/u);
  assert.equal(requests[0].authorization, `Bearer ${CUSTOM_KEY}`);
  assert.equal(requests[0].body.model, "route-model");
  assert.equal(requests[0].body.stream, true);
  assert.equal(requests[0].body.max_tokens, 256);
  assert.equal(requests[0].body.max_completion_tokens, undefined);
  assert.equal(requests[0].body.store, undefined);
  assert.equal(requests[0].body.tools?.[0]?.function?.name, "list");
  assert.equal(requests[0].body.reasoning_effort, undefined, "an undeclared reasoning capability must send no reasoning field");

  const second = await models.completeSimple(model, {
    messages: [
      { role: "user", content: "What is here?", timestamp: Date.now() },
      first,
      { role: "toolResult", toolCallId: call1.id, toolName: "list", content: [{ type: "text", text: "a.txt" }], isError: false, timestamp: Date.now() },
    ],
    tools,
  }, { maxTokens: 256 });
  assert.equal(second.stopReason, "stop");
  assert.equal(second.content.find((block) => block.type === "text").text, "Done.");
  assert.equal(call, 2);
});

test("the custom route sends Responses events and a tool round trip", async (context) => {
  const options = await fixture(context);
  const requests = [];
  let call = 0;
  const baseUrl = await listen(context, async (request, response) => {
    const body = await readJsonBody(request);
    requests.push({ url: request.url, authorization: request.headers.authorization, body });
    call += 1;
    const base = responsesBase();
    if (call === 1) {
      responsesSse(response, [
        { type: "response.created", sequence_number: 1, response: base },
        { type: "response.output_item.added", sequence_number: 2, output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] } },
        { type: "response.output_text.delta", sequence_number: 3, output_index: 0, content_index: 0, delta: "Listing." },
        { type: "response.output_item.done", sequence_number: 4, output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Listing." }] } },
        { type: "response.output_item.added", sequence_number: 5, output_index: 1, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "list", arguments: "" } },
        { type: "response.function_call_arguments.delta", sequence_number: 6, output_index: 1, delta: "{\"path\":\".\"}" },
        { type: "response.output_item.done", sequence_number: 7, output_index: 1, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "list", arguments: "{\"path\":\".\"}" } },
        { type: "response.completed", sequence_number: 8, response: { ...base, status: "completed", output: [] , usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
      ]);
      return;
    }
    responsesSse(response, [
      { type: "response.created", sequence_number: 1, response: responsesBase("resp_2") },
      { type: "response.output_item.added", sequence_number: 2, output_index: 0, item: { id: "msg_2", type: "message", role: "assistant", status: "in_progress", content: [] } },
      { type: "response.output_text.delta", sequence_number: 3, output_index: 0, content_index: 0, delta: "Done." },
      { type: "response.output_item.done", sequence_number: 4, output_index: 0, item: { id: "msg_2", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done." }] } },
      { type: "response.completed", sequence_number: 5, response: { ...responsesBase("resp_2"), status: "completed", output: [] } },
    ]);
  });
  await writeSettings(options, {
    schema_version: 1, provider: "custom", custom_protocol: "openai-responses",
    model: "route-model", api_url: baseUrl, custom_context_window: "64000", custom_max_output: "4096",
  });
  const configuration = await loadAsideConfig({ ...options, credentialValues: { custom: CUSTOM_KEY } });
  const { models, model } = await selectConfiguredProvider(configuration);
  assert.equal(model.api, "openai-responses");
  assert.equal(model.contextWindow, 64000);
  assert.equal(model.maxTokens, 4096);

  const tools = [{ name: "list", description: "List a directory", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
  const first = await models.completeSimple(model, { messages: [{ role: "user", content: "What is here?", timestamp: Date.now() }], tools }, { maxTokens: 256 });
  assert.equal(first.stopReason, "toolUse");
  const call1 = first.content.find((block) => block.type === "toolCall");
  assert.equal(call1.name, "list");
  assert.deepEqual(call1.arguments, { path: "." });

  assert.match(requests[0].url, /\/v1\/responses$/u);
  assert.equal(requests[0].authorization, `Bearer ${CUSTOM_KEY}`);
  assert.equal(requests[0].body.model, "route-model");
  assert.equal(requests[0].body.stream, true);
  assert.equal(requests[0].body.max_output_tokens, 256);
  assert.equal(requests[0].body.tools?.[0]?.name, "list");
  assert.equal(requests[0].body.reasoning, undefined, "an undeclared reasoning capability must send no reasoning field");

  const second = await models.completeSimple(model, {
    messages: [
      { role: "user", content: "What is here?", timestamp: Date.now() },
      first,
      { role: "toolResult", toolCallId: call1.id, toolName: "list", content: [{ type: "text", text: "a.txt" }], isError: false, timestamp: Date.now() },
    ],
    tools,
  }, { maxTokens: 256 });
  assert.equal(second.stopReason, "stop");
  assert.equal(second.content.find((block) => block.type === "text").text, "Done.");
  assert.equal(call, 2);
});

test("declared capabilities govern the wire request rather than the caller", async (context) => {
  const options = await fixture(context);
  const bodies = [];
  const baseUrl = await listen(context, async (request, response) => {
    bodies.push(await readJsonBody(request));
    sse(response, completionsChunk({ role: "assistant", content: "ok" }), completionsChunk({}, "stop"));
  });
  await writeSettings(options, {
    schema_version: 1, provider: "custom", custom_protocol: "openai-completions",
    model: "route-model", api_url: baseUrl, custom_context_window: "32000", custom_max_output: "2048",
    custom_tools: "false", custom_reasoning: "true",
  });
  const configuration = await loadAsideConfig({ ...options, credentialValues: { custom: CUSTOM_KEY } });
  const { models, model } = await selectConfiguredProvider(configuration);
  assert.equal(model.reasoning, true);
  const tools = [{ name: "list", description: "List a directory", parameters: { type: "object", properties: {} } }];
  await models.completeSimple(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools }, { maxTokens: 128, reasoning: "high" });
  // The caller passed tools and a reasoning level; the route declared tools
  // unsupported, so definitions must not reach the endpoint, while the declared
  // reasoning capability is expressed.
  assert.equal(bodies[0].tools, undefined);
  assert.equal(bodies[0].reasoning_effort, "high");
});

test("the connection test and an actual task share the resolved custom route", async (context) => {
  const options = await fixture(context);
  const urls = [];
  const baseUrl = await listen(context, async (request, response) => {
    urls.push(request.url);
    await readJsonBody(request);
    sse(response, completionsChunk({ role: "assistant", content: "OK" }), completionsChunk({}, "stop"));
  });
  const configuration = await customConfiguration(options, { model: "route-model", api_url: baseUrl });
  const tested = await testProviderConnection(configuration);
  assert.equal(tested.ok, true, JSON.stringify(tested));
  assert.equal(tested.provider, "custom");
  assert.equal(tested.model, "route-model");

  const configured = await createConfiguredAgent({ configuration });
  assert.equal(configured.provider, "custom");
  assert.equal(configured.model, "route-model");
  assert.equal(configured.agent.state.model.id, "route-model");
  assert.equal(configured.agent.state.model.contextWindow, 128000);
  assert.equal(configured.agent.state.model.maxTokens, 8192);
  assert.ok(urls.every((url) => url === "/v1/chat/completions"));
});

test("a custom route never borrows a built-in vendor's key and never echoes its own", async (context) => {
  const options = await fixture(context);
  const authorizations = [];
  let deny = false;
  const baseUrl = await listen(context, async (request, response) => {
    authorizations.push(request.headers.authorization);
    await readJsonBody(request);
    if (deny) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: `invalid ${CUSTOM_KEY}`, type: "authentication_error" } }));
      return;
    }
    sse(response, completionsChunk({ role: "assistant", content: "OK" }), completionsChunk({}, "stop"));
  });
  await writeSettings(options, {
    schema_version: 1, provider: "custom", custom_protocol: "openai-completions",
    model: "route-model", api_url: baseUrl, custom_context_window: "16000", custom_max_output: "1024",
  });
  // An OpenAI key is present in the environment; it must not reach the custom endpoint.
  const environment = { ...options.environment, OPENAI_API_KEY: "openai-fixture-key" };
  const configuration = await loadAsideConfig({ ...options, environment, credentialValues: { custom: CUSTOM_KEY } });
  const tested = await testProviderConnection(configuration);
  assert.equal(tested.ok, true, JSON.stringify(tested));
  assert.deepEqual(authorizations, [`Bearer ${CUSTOM_KEY}`]);

  deny = true;
  const denied = await testProviderConnection(configuration);
  assert.equal(denied.code, "connection_denied");
  assert.doesNotMatch(JSON.stringify(denied), /custom-route-fixture-key|openai-fixture-key/u);
  assert.equal(configuration.credentials.custom.configured, true);
  assert.equal(configuration.credentials.custom.source, "credential_store");
});

test("custom credentials cannot be stored in the settings document", () => {
  for (const document of [
    { schema_version: 1, custom_api_key: CUSTOM_KEY },
    { schema_version: 1, ASIDE_CUSTOM_API_KEY: CUSTOM_KEY },
  ]) {
    assert.throws(
      () => validateSettingsDocument(document),
      (error) => error.name === "SettingsError" && !error.message.includes(CUSTOM_KEY),
    );
  }
  // Declaring the route itself is a normal document, not a credential store.
  assert.deepEqual(
    { ...validateSettingsDocument({ schema_version: 1, provider: "custom", custom_protocol: "openai-responses", custom_context_window: "32000", custom_max_output: "4096", custom_tools: "false" }) },
    { schema_version: 1, provider: "custom", custom_protocol: "openai-responses", custom_context_window: "32000", custom_max_output: "4096", custom_tools: "false" },
  );
});

test("a malformed stream fails the request instead of reporting an empty success", async (context) => {
  const options = await fixture(context);
  const baseUrl = await listen(context, async (request, response) => {
    await readJsonBody(request);
    // No finish_reason and no [DONE]: the adapter must not invent a stop.
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${completionsChunk({ role: "assistant", content: "partial" })}\n\n`);
    response.end();
  });
  const configuration = await customConfiguration(options, {
    model: "route-model", api_url: baseUrl, custom_protocol: "openai-responses",
  });
  const { models, model } = await selectConfiguredProvider(configuration);
  const result = await models.completeSimple(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, { maxTokens: 64 });
  assert.equal(result.stopReason, "error");
  assert.ok(result.errorMessage);
});

test("the settings surface reports a usable route and its effective sources", async (context) => {
  const options = await fixture(context);
  await writeSettings(options, {
    schema_version: 1, provider: "custom", custom_protocol: "openai-responses",
    model: "route-model", api_url: "https://route.test/v1",
    custom_context_window: "32000", custom_max_output: "4096", custom_reasoning: "true",
  });
  const snapshot = await handleSettingsRequest({ operation: "get" }, { ...options, credentialValues: { custom: CUSTOM_KEY } });
  assert.equal(snapshot.effective.provider, "custom");
  assert.equal(snapshot.sources.custom_protocol.kind, "settings");
  assert.equal(snapshot.sources.custom_context_window.kind, "settings");
  assert.equal(snapshot.custom_route.ok, true);
  assert.equal(snapshot.custom_route.route.protocol, "openai-responses");
  assert.deepEqual(snapshot.custom_route.route.models.map((model) => model.id), ["route-model"]);
  assert.deepEqual(snapshot.custom_route.route.models[0].thinking_levels, ["off", "minimal", "low", "medium", "high"]);
  assert.equal(snapshot.credentials.custom.configured, true);
  assert.equal(snapshot.credentials.custom.source, "credential_store");
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(CUSTOM_KEY, "u"));
});

test("an incomplete route is reported as a diagnostic instead of breaking the settings surface", async (context) => {
  const options = await fixture(context);
  await writeSettings(options, { schema_version: 1, provider: "custom" });
  const snapshot = await handleSettingsRequest({ operation: "get" }, options);
  assert.equal(snapshot.effective.provider, "custom");
  assert.equal(snapshot.custom_route.ok, false);
  assert.equal(snapshot.custom_route.code, "custom_route_invalid_protocol");
  // The rest of the surface, including the settings revision, still works.
  assert.equal(typeof snapshot.revision, "string");
  assert.equal(snapshot.path.endsWith("settings.json"), true);
});

test("saving the route round-trips through the document and keeps built-in settings intact", async (context) => {
  const options = await fixture(context);
  await writeSettings(options, { schema_version: 1, provider: "deepseek", model: "deepseek-v4-flash" });
  const initial = await handleSettingsRequest({ operation: "get" }, options);
  const saved = await handleSettingsRequest({
    operation: "save",
    expected_revision: initial.revision,
    document: {
      ...initial.document,
      provider: "custom",
      custom_protocol: "openai-completions",
      custom_context_window: "64000",
      custom_max_output: "2048",
    },
  }, { ...options, credentialValues: { custom: CUSTOM_KEY } });
  assert.equal(saved.effective.provider, "custom");
  // The built-in model value is preserved in the document rather than lost on
  // the switch, so switching back does not silently pick another model.
  assert.equal(saved.document.model, "deepseek-v4-flash");
  assert.equal(JSON.parse(await readFileText(options.environment.ASIDE_SETTINGS_PATH)).custom_context_window, "64000");
});

test("an invalid route save is rejected without replacing the previous value", async (context) => {
  const options = await fixture(context);
  await writeSettings(options, { schema_version: 1, provider: "deepseek" });
  const initial = await handleSettingsRequest({ operation: "get" }, options);
  await assert.rejects(handleSettingsRequest({
    operation: "save",
    expected_revision: initial.revision,
    document: { ...initial.document, provider: "custom", custom_protocol: "anthropic-messages" },
  }, options), (error) => error.code === "settings_invalid_custom_protocol");
  const after = await handleSettingsRequest({ operation: "get" }, options);
  assert.equal(after.effective.provider, "deepseek");
  assert.equal(after.revision, initial.revision);
});

test("the route can be declared entirely through environment overrides", async (context) => {
  const options = await fixture(context);
  const urls = [];
  const baseUrl = await listen(context, async (request, response) => {
    urls.push(request.url);
    await readJsonBody(request);
    sse(response, completionsChunk({ role: "assistant", content: "OK" }), completionsChunk({}, "stop"));
  });
  const environment = {
    ...options.environment,
    ASIDE_PROVIDER: "custom",
    ASIDE_CUSTOM_PROTOCOL: "openai-completions",
    ASIDE_MODEL: "route-model",
    ASIDE_API_URL: baseUrl,
    ASIDE_CUSTOM_CONTEXT_WINDOW: "16000",
    ASIDE_CUSTOM_MAX_OUTPUT: "1024",
    ASIDE_CUSTOM_API_KEY: CUSTOM_KEY,
  };
  const configuration = await loadAsideConfig({ ...options, environment });
  assert.equal(configuration.fieldSources.provider.kind, "environment");
  assert.equal(configuration.fieldSources.custom_protocol.kind, "environment");
  assert.equal(configuration.credentials.custom.source, "environment");
  const tested = await testProviderConnection(configuration);
  assert.equal(tested.ok, true, JSON.stringify(tested));
  assert.deepEqual(urls, ["/v1/chat/completions"]);
});
