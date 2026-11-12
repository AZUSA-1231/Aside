import {
  createModels,
  createProvider,
  defaultProviderAuthContext,
  envApiKeyAuth,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import { getAsideConfigValue, normalizeAsideApiUrl } from "./config.mjs";
import {
  CUSTOM_CREDENTIAL_NAME,
  CUSTOM_PROVIDER_ID,
  CUSTOM_PROTOCOLS,
  SETTINGS_CUSTOM_FIELDS,
  SettingsError,
} from "./settings-schema.mjs";

/**
 * One user-declared API route.
 *
 * The route is deliberately not a second provider catalog. It describes a
 * single endpoint the user configured: which wire protocol it speaks, which
 * model id to send, and the capacity the user knows. Anything not declared is
 * treated as unsupported rather than guessed — claiming a reasoning level, an
 * image input or tool support the endpoint cannot accept would be a success
 * the request never had.
 *
 * The route reuses the existing `provider` / `model` / `api_url` settings
 * fields. Only the protocol and the declared capabilities are new, so a user
 * switching between a built-in provider and the custom route edits the same
 * familiar fields rather than a parallel settings shape.
 */

export const CUSTOM_MAX_CAPACITY = 10_000_000;

const CUSTOM_MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,199}$/u;

function invalid(code, message) {
  return new SettingsError(code, message);
}

function positiveCapacity(raw, field, code) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!/^[0-9]{1,9}$/u.test(text)) {
    throw invalid(code, `${field} must be a whole number of tokens.`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1 || value > CUSTOM_MAX_CAPACITY) {
    throw invalid(code, `${field} must be between 1 and ${CUSTOM_MAX_CAPACITY}.`);
  }
  return value;
}

/**
 * A declared capability is exactly `true`/`false`; anything else is a
 * configuration error, because silently choosing a default would let the
 * stored document disagree with what is sent on the wire.
 */
function declaredFlag(raw, field, code, fallback) {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!text) return fallback;
  if (text === "true" || text === "1") return true;
  if (text === "false" || text === "0") return false;
  throw invalid(code, `${field} must be declared as true or false.`);
}

/**
 * Validate the declared route without touching the network.
 *
 * A route that reaches `buildCustomRoute` has passed every check, so an
 * invalid protocol, capacity or capability combination never gets as far as
 * replacing a working configuration or sending a request.
 */
export function resolveCustomRoute(values = {}) {
  const protocol = (getAsideConfigValue(values, SETTINGS_CUSTOM_FIELDS.custom_protocol) ?? "").toLowerCase();
  if (!CUSTOM_PROTOCOLS.includes(protocol)) {
    throw invalid("custom_route_invalid_protocol", "Choose Chat Completions or Responses for the custom route.");
  }
  const modelId = getAsideConfigValue(values, "ASIDE_MODEL") ?? "";
  if (!CUSTOM_MODEL_ID_PATTERN.test(modelId)) {
    throw invalid("custom_route_invalid_model", "Enter the model ID the custom endpoint expects.");
  }
  let baseUrl;
  try {
    baseUrl = normalizeAsideApiUrl(getAsideConfigValue(values, "ASIDE_API_URL"));
  } catch {
    throw invalid("custom_route_invalid_url", "Enter the custom endpoint's HTTP or HTTPS Base URL.");
  }
  if (!baseUrl) {
    throw invalid("custom_route_invalid_url", "Enter the custom endpoint's HTTP or HTTPS Base URL.");
  }
  const contextWindow = positiveCapacity(getAsideConfigValue(values, SETTINGS_CUSTOM_FIELDS.custom_context_window),
    "The context window", "custom_route_invalid_context_window");
  const maxOutput = positiveCapacity(getAsideConfigValue(values, SETTINGS_CUSTOM_FIELDS.custom_max_output),
    "The maximum output", "custom_route_invalid_max_output");
  if (maxOutput > contextWindow) {
    throw invalid("custom_route_invalid_max_output", "The maximum output cannot exceed the context window.");
  }
  const displayName = getAsideConfigValue(values, SETTINGS_CUSTOM_FIELDS.custom_model_name) ?? modelId;
  if (Buffer.byteLength(displayName) > 200 || /[\u0000-\u001f]/u.test(displayName)) {
    throw invalid("custom_route_invalid_model_name", "The custom model name contains unsupported characters or is too long.");
  }
  return Object.freeze({
    protocol,
    modelId,
    displayName,
    baseUrl,
    contextWindow,
    maxOutput,
    reasoning: declaredFlag(getAsideConfigValue(values, SETTINGS_CUSTOM_FIELDS.custom_reasoning),
      "Reasoning support", "custom_route_invalid_reasoning", false),
    images: declaredFlag(getAsideConfigValue(values, SETTINGS_CUSTOM_FIELDS.custom_images),
      "Image input support", "custom_route_invalid_images", false),
    // Tools default to supported: Aside's product is a tool-using file agent,
    // and a route that cannot call tools would fail at the first task rather
    // than at configuration time. A user whose endpoint rejects tool
    // definitions must say so explicitly.
    tools: declaredFlag(getAsideConfigValue(values, SETTINGS_CUSTOM_FIELDS.custom_tools),
      "Tool-call support", "custom_route_invalid_tools", true),
  });
}

/**
 * A route that declared no tool support must not be sent tool definitions.
 * Filtering here (rather than trusting the caller to omit them) is what makes
 * the declaration govern the wire request.
 */
function withoutTools(streams) {
  const strip = (context) => ({ ...context, tools: undefined });
  return {
    stream: (model, context, options) => streams.stream(model, strip(context), options),
    streamSimple: (model, context, options) => streams.streamSimple(model, strip(context), options),
  };
}

/**
 * Build the Pi provider and model for the declared route.
 *
 * Compatibility flags are conservative for an arbitrary OpenAI-compatible
 * endpoint: no `store`, no `developer` role, `max_tokens` rather than
 * `max_completion_tokens`, and no strict tool schemas. These are choices such
 * an endpoint is most likely to accept; vendor extensions are not enabled at
 * all. An undeclared reasoning capability produces a model with
 * `reasoning: false`, so Pi sends no reasoning field rather than silently
 * dropping one.
 */
export async function buildCustomRoute(route, values = {}) {
  const [{ openAICompletionsApi }, { openAIResponsesApi }] = await Promise.all([
    import("@earendil-works/pi-ai/api/openai-completions.lazy"),
    import("@earendil-works/pi-ai/api/openai-responses.lazy"),
  ]);
  const stream = route.protocol === "openai-completions" ? openAICompletionsApi() : openAIResponsesApi();
  const api = route.tools ? stream : withoutTools(stream);
  const model = {
    id: route.modelId,
    name: route.displayName,
    api: route.protocol,
    provider: CUSTOM_PROVIDER_ID,
    baseUrl: route.baseUrl,
    reasoning: route.reasoning,
    // No thinkingLevelMap: xhigh/max stay unadvertised on a route whose
    // endpoint we know nothing else about, and the remaining levels map to
    // themselves through the adapter's default behaviour.
    input: route.images ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: route.contextWindow,
    maxTokens: route.maxOutput,
    compat: route.protocol === "openai-completions"
      ? {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        supportsUsageInStreaming: true,
        supportsFinishReason: true,
        maxTokensField: "max_tokens",
        supportsStrictMode: false,
      }
      : {
        supportsDeveloperRole: false,
        supportsStrictMode: false,
        supportsLongCacheRetention: false,
        sessionAffinityFormat: "openai-nosession",
      },
  };
  const provider = createProvider({
    id: CUSTOM_PROVIDER_ID,
    name: "Custom API",
    baseUrl: route.baseUrl,
    auth: { apiKey: envApiKeyAuth("Custom API key", [CUSTOM_CREDENTIAL_NAME]) },
    models: [model],
    api,
  });
  const base = defaultProviderAuthContext();
  const models = createModels({ authContext: {
    env: async (name) => getAsideConfigValue(values, name),
    fileExists: base.fileExists,
  } });
  models.setProvider(provider);
  return { provider, models, model };
}

/** The single model a route advertises, in the same projection built-in catalogs use. */
export function describeCustomRoute(route) {
  return {
    provider: CUSTOM_PROVIDER_ID,
    default_model: route.modelId,
    custom: true,
    protocol: route.protocol,
    tools: route.tools,
    models: [{
      id: route.modelId,
      name: route.displayName,
      api: route.protocol,
      base_url: route.baseUrl,
      reasoning: route.reasoning,
      input: route.images ? ["text", "image"] : ["text"],
      context_window: route.contextWindow,
      max_tokens: route.maxOutput,
      thinking_levels: getSupportedThinkingLevels({
        reasoning: route.reasoning,
        thinkingLevelMap: undefined,
      }),
    }],
  };
}
