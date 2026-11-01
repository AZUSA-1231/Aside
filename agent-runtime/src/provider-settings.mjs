import { createModels, defaultProviderAuthContext, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAsideConfigValue, normalizeAsideApiUrl } from "./config.mjs";
import { SETTINGS_PROVIDERS, SettingsError } from "./settings-schema.mjs";

const providerFactories = {
  anthropic: async () => (await import("@earendil-works/pi-ai/providers/anthropic")).anthropicProvider(),
  deepseek: async () => (await import("@earendil-works/pi-ai/providers/deepseek")).deepseekProvider(),
  google: async () => (await import("@earendil-works/pi-ai/providers/google")).googleProvider(),
  openai: async () => (await import("@earendil-works/pi-ai/providers/openai")).openaiProvider(),
};

async function providerModels(providerId, values = {}) {
  if (!SETTINGS_PROVIDERS.includes(providerId)) {
    throw new SettingsError("settings_invalid_provider", "Select openai, anthropic, deepseek, or google.");
  }
  const provider = await providerFactories[providerId]();
  const base = defaultProviderAuthContext();
  const models = createModels({ authContext: {
    env: async (name) => getAsideConfigValue(values, name),
    fileExists: base.fileExists,
  } });
  models.setProvider(provider);
  return { provider, models };
}

export async function getProviderCatalog(providerId) {
  const { provider, models } = await providerModels(providerId);
  const available = models.getModels(providerId);
  return {
    provider: providerId,
    default_model: available[0]?.id ?? null,
    models: available.map((model) => ({
      id: model.id, name: model.name, api: model.api, base_url: model.baseUrl ?? provider.baseUrl,
      reasoning: model.reasoning, input: model.input,
      context_window: model.contextWindow, max_tokens: model.maxTokens,
      thinking_levels: getSupportedThinkingLevels(model),
    })),
  };
}

export async function selectConfiguredProvider(configuration) {
  const values = configuration.values;
  const providerId = (getAsideConfigValue(values, "ASIDE_PROVIDER") ?? "openai").toLowerCase();
  const { models } = await providerModels(providerId, values);
  const requested = getAsideConfigValue(values, "ASIDE_MODEL");
  const selected = requested ? models.getModel(providerId, requested) : models.getModels(providerId)[0];
  if (!selected) {
    throw new SettingsError("settings_invalid_model", "The model is not in this provider's supported catalog. Select a supported model.");
  }
  const url = normalizeAsideApiUrl(getAsideConfigValue(values, "ASIDE_API_URL"));
  return { models, providerId, model: url ? { ...selected, baseUrl: url } : selected };
}

function connectionFailure(error, timedOut = false) {
  const detail = String(error?.errorMessage ?? error?.message ?? "");
  if (timedOut) return { ok: false, code: "connection_timeout", message: "The model request timed out." };
  if ([401, 403].includes(error?.status) || /\b(?:401|403)\b/.test(detail)) {
    return { ok: false, code: "connection_denied", message: "The API denied authentication or model access (401/403). Check the effective API key and model permissions." };
  }
  if (error?.status === 404 || /\b404\b/.test(detail)) {
    return { ok: false, code: "connection_not_found", message: "The API endpoint or model was not found (404). Check the Base URL and model." };
  }
  return { ok: false, code: "connection_failed", message: "The model request failed. Check the API key, model access, network and endpoint protocol." };
}

export async function testProviderConnection(configuration, { select = selectConfiguredProvider, timeoutMs = 15_000 } = {}) {
  const { models, providerId, model } = await select(configuration);
  if (!configuration.credentials[providerId]?.configured) {
    return { ok: false, code: "credential_missing", message: "No effective API key is configured for this provider." };
  }
  const controller = new AbortController();
  let timer;
  try {
    const response = await Promise.race([
      models.completeSimple(model, { messages: [{ role: "user", content: "Reply OK.", timestamp: Date.now() }] }, {
        maxTokens: 128, reasoning: "off", transport: "sse", signal: controller.signal, timeoutMs, maxRetries: 0,
      }),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort();
        reject(new Error("timeout"));
      }, timeoutMs); }),
    ]);
    if (response?.errorMessage || response?.stopReason === "error") return connectionFailure(response);
    if (!response || response.role !== "assistant" || !["stop", "length"].includes(response.stopReason)
      || !response.content?.some((part) => part.type === "text" && part.text?.trim())) {
      return { ok: false, code: "connection_failed", message: "The model did not return a valid text response. Check the API key, model access, protocol and endpoint." };
    }
    return { ok: true, code: "connection_ok", message: "The model returned a text response.", provider: providerId, model: model.id };
  } catch (error) {
    return connectionFailure(error, controller.signal.aborted);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
