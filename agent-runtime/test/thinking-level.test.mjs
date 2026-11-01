import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core/aside";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { loadAsideConfig } from "../src/config.mjs";
import { createConfiguredAgent, createConversationRuntime } from "../src/runtime.mjs";
import { handleSettingsRequest } from "../src/settings-service.mjs";
import { getProviderCatalog } from "../src/provider-settings.mjs";
import { resolveThinkingLevel, supportedThinkingLevels } from "../src/thinking-level.mjs";

const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "aside-thinking-"));
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

/**
 * A faux model advertising exactly `levels`.
 *
 * Pi treats a `null` map entry as explicitly unsupported and an `undefined`
 * entry as implicitly supported, so every level outside `levels` must be nulled
 * out; leaving them undefined would silently widen the set.
 */
function reasoningModel(levels) {
  const thinkingLevelMap = {};
  for (const level of ALL_LEVELS) thinkingLevelMap[level] = levels.includes(level) ? level : null;
  return {
    id: "faux-reasoner", name: "Faux Reasoner", provider: "faux", api: "faux",
    reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 8_000,
    thinkingLevelMap,
  };
}

test("supported levels come from the model metadata rather than one shared menu", async () => {
  assert.deepEqual(supportedThinkingLevels(undefined), ["off"]);

  const catalog = await getProviderCatalog("deepseek");
  const pro = catalog.models.find((model) => model.id === "deepseek-v4-pro");
  const flash = catalog.models.find((model) => model.id === "deepseek-v4-flash");
  // Two models of the same provider must not be flattened to one list.
  assert.deepEqual(pro.thinking_levels, ["off", "high", "max"]);
  assert.deepEqual(flash.thinking_levels, ["off", "low", "high", "max"]);

  const openai = await getProviderCatalog("openai");
  const standard = openai.models.find((model) => model.reasoning === false);
  assert.deepEqual(standard.thinking_levels, ["off"]);
});

test("a supported level is applied unchanged", () => {
  const model = reasoningModel(["off", "low", "high"]);
  const resolved = resolveThinkingLevel(model, "high");
  assert.equal(resolved.requested, "high");
  assert.equal(resolved.applied, "high");
  assert.equal(resolved.adjusted, false);
  assert.deepEqual(resolved.supported, ["off", "low", "high"]);
});

test("an unavailable level falls back to the nearest supported neighbour instead of off", () => {
  const model = reasoningModel(["off", "high", "max"]);
  // "medium" is not expressible; falling straight to "off" would silently
  // discard the user's preference to reason harder.
  const resolved = resolveThinkingLevel(model, "medium");
  assert.equal(resolved.requested, "medium");
  assert.equal(resolved.applied, "high");
  assert.equal(resolved.adjusted, true);

  // Above the ceiling lands on the top supported level.
  assert.equal(resolveThinkingLevel(model, "xhigh").applied, "max");
  // Below the floor still walks up to the nearest supported level rather than
  // dropping the request to "off".
  assert.equal(resolveThinkingLevel(model, "minimal").applied, "high");
});

test("a model without reasoning collapses every request to off", () => {
  const model = { ...reasoningModel(["off"]), reasoning: false };
  const resolved = resolveThinkingLevel(model, "high");
  assert.equal(resolved.applied, "off");
  assert.equal(resolved.adjusted, true);
  assert.deepEqual(resolved.supported, ["off"]);
});

test("an unknown or empty configured level is treated as off", () => {
  const model = reasoningModel(["off", "low", "high"]);
  assert.equal(resolveThinkingLevel(model, undefined).applied, "off");
  assert.equal(resolveThinkingLevel(model, "unbounded").applied, "off");
  assert.equal(resolveThinkingLevel(model, "  ").applied, "off");
});

test("the resolved level reaches the outbound request as reasoning", async (context) => {
  const model = reasoningModel(["off", "low", "high"]);
  const captured = [];
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([(providerContext, streamOptions) => {
    captured.push(streamOptions?.reasoning);
    return fauxAssistantMessage("done");
  }]);

  const requested = resolveThinkingLevel(model, "high").applied;
  const agent = new Agent({
    initialState: { systemPrompt: "Answer briefly.", model, thinkingLevel: requested },
    streamFn: models.streamSimple.bind(models),
    convertToLlm: (messages) => messages,
  });
  const runtime = await createConversationRuntime({ agent });
  context.after(() => runtime.dispose?.());
  await runtime.prompt("thinking-request", "question");

  // The agent loop translates "off" into no reasoning field at all, so the
  // assertion is on what the provider stream actually received.
  assert.deepEqual(captured, ["high"]);
});

test("level off sends no reasoning field at all", async (context) => {
  const model = reasoningModel(["off", "low", "high"]);
  const captured = [];
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([(providerContext, streamOptions) => {
    captured.push(streamOptions?.reasoning);
    return fauxAssistantMessage("done");
  }]);

  const agent = new Agent({
    initialState: { systemPrompt: "Answer briefly.", model, thinkingLevel: "off" },
    streamFn: models.streamSimple.bind(models),
    convertToLlm: (messages) => messages,
  });
  const runtime = await createConversationRuntime({ agent });
  context.after(() => runtime.dispose?.());
  await runtime.prompt("thinking-off", "question");

  assert.deepEqual(captured, [undefined]);
});

test("the configured level reaches the agent the runtime builds", async (context) => {
  const options = await fixture(context);
  await writeSettings(options, { schema_version: 1, provider: "deepseek", model: "deepseek-v4-flash", thinking_level: "high" });
  const configuration = await loadAsideConfig({ ...options });
  const configured = await createConfiguredAgent({ configuration });
  assert.equal(configured.thinking.requested, "high");
  assert.equal(configured.thinking.applied, "high");
  // The value is not merely reported; the agent that will run carries it.
  assert.equal(configured.agent.state.thinkingLevel, "high");
});

test("settings snapshot reports the resolved level the runtime would use", async (context) => {
  const options = await fixture(context);
  await writeSettings(options, { schema_version: 1, provider: "deepseek", model: "deepseek-v4-pro", thinking_level: "low" });
  const snapshot = await handleSettingsRequest({ operation: "get" }, { ...options });

  // deepseek-v4-pro supports only off/high/max, so the saved "low" walks up.
  assert.equal(snapshot.thinking.requested, "low");
  assert.equal(snapshot.thinking.applied, "high");
  assert.equal(snapshot.thinking.adjusted, true);
  assert.deepEqual(snapshot.thinking.supported, ["off", "high", "max"]);
  assert.ok(snapshot.runtime_fields.includes("thinking_level"));
});

test("saving a level round-trips through the settings document", async (context) => {
  const options = await fixture(context);
  const first = await handleSettingsRequest({ operation: "get" }, { ...options });
  assert.equal(first.thinking.applied, "off");
  const saved = await handleSettingsRequest(
    { operation: "save", document: { schema_version: 1, provider: "deepseek", model: "deepseek-v4-flash", thinking_level: "max" }, expected_revision: first.revision },
    { ...options },
  );
  assert.equal(saved.document.thinking_level, "max");
  assert.equal(saved.thinking.applied, "max");
  assert.equal(saved.thinking.adjusted, false);
  const reloaded = await handleSettingsRequest({ operation: "get" }, { ...options });
  assert.equal(reloaded.thinking.applied, "max");
});

test("an invalid level is rejected when the settings file is read", async (context) => {
  const options = await fixture(context);
  await writeSettings(options, { schema_version: 1, thinking_level: "unbounded" });
  await assert.rejects(
    handleSettingsRequest({ operation: "get" }, { ...options }),
    (error) => error.code === "settings_invalid_thinking_level",
  );
});

test("a settings snapshot still loads when the selected model cannot be resolved", async (context) => {
  const options = await fixture(context);
  await writeSettings(options, { schema_version: 1, provider: "deepseek", model: "not-a-real-model", thinking_level: "high" });
  const snapshot = await handleSettingsRequest({ operation: "get" }, { ...options });
  // The unselectable model is an existing diagnostic; thinking simply has no
  // resolution rather than inventing one.
  assert.equal(snapshot.thinking, null);
  assert.equal(snapshot.document.thinking_level, "high");
});
