import { Agent } from "@earendil-works/pi-agent-core/aside";
import { createModels, defaultProviderAuthContext } from "@earendil-works/pi-ai";
import {
  projectAsideContext,
  toProviderMessages,
  validateTurnContext,
} from "./context.mjs";
import {
  getAsideConfigValue,
  loadAsideConfig,
  normalizeAsideApiUrl,
} from "./config.mjs";

export const MAX_REQUEST_ID_LENGTH = 128;
export const MAX_PROMPT_LENGTH = 20_000;
export const DEFAULT_SYSTEM_PROMPT =
  "You are Aside, a concise and thoughtful desktop assistant. Answer directly and keep short requests practical.";

const providerFactories = {
  anthropic: async () =>
    (await import("@earendil-works/pi-ai/providers/anthropic")).anthropicProvider(),
  deepseek: async () =>
    (await import("@earendil-works/pi-ai/providers/deepseek")).deepseekProvider(),
  google: async () =>
    (await import("@earendil-works/pi-ai/providers/google")).googleProvider(),
  openai: async () =>
    (await import("@earendil-works/pi-ai/providers/openai")).openaiProvider(),
};

export function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(api[-_ ]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9._-]{8,}/gi, "[redacted]")
    .replace(/(?:key|token|secret)[-_][A-Za-z0-9._-]{8,}/gi, "[redacted]")
    .replace(/https?:\/\/[^\s]+/gi, "[provider endpoint]")
    .slice(0, 280);
}

export function isUnsuccessfulAssistantMessage(message) {
  return (
    message?.role === "assistant" &&
    (message.stopReason === "error" ||
      message.stopReason === "aborted" ||
      message.stopReason === "deferred" ||
      Boolean(message.errorMessage))
  );
}

function createConfiguredAuthContext(values) {
  const baseContext = defaultProviderAuthContext();
  return {
    env: async (name) => {
      const value = values[name];
      return typeof value === "string" && value.trim().length > 0
        ? value
        : undefined;
    },
    fileExists: baseContext.fileExists,
  };
}

function removeUnsuccessfulAssistantMessages(agent) {
  const messages = agent?.state?.messages;
  if (!Array.isArray(messages)) return;
  agent.state.messages = messages.filter(
    (message) => !isUnsuccessfulAssistantMessage(message),
  );
}

function describeAgent(agent) {
  const model = agent?.state?.model;
  return {
    agent,
    provider: typeof model?.provider === "string" ? model.provider : "unknown",
    model: typeof model?.id === "string" ? model.id : "unknown",
  };
}

function validatePromptInput(requestId, text) {
  if (
    typeof requestId !== "string" ||
    requestId.length === 0 ||
    requestId.length > MAX_REQUEST_ID_LENGTH
  ) {
    return "The conversation request could not be identified.";
  }
  if (
    typeof text !== "string" ||
    text.trim().length === 0 ||
    text.length > MAX_PROMPT_LENGTH
  ) {
    return "The message could not be sent because its input was invalid.";
  }
  return null;
}

export async function createConfiguredAgent({
  initialMessages = [],
  transformContext,
  sessionId,
  environment = process.env,
  configCwd = process.cwd(),
} = {}) {
  const configuration = await loadAsideConfig({
    cwd: configCwd,
    environment,
  });
  const values = configuration.values;
  const providerId = (getAsideConfigValue(values, "ASIDE_PROVIDER") ?? "openai").toLowerCase();
  const factory = providerFactories[providerId];
  if (!factory) {
    throw new Error(
      `Unsupported provider "${providerId}". Use openai, anthropic, deepseek, or google.`,
    );
  }

  const provider = await factory();
  const models = createModels({
    authContext: createConfiguredAuthContext(values),
  });
  models.setProvider(provider);
  const requestedModel = getAsideConfigValue(values, "ASIDE_MODEL");
  const configuredModel = requestedModel
    ? models.getModel(providerId, requestedModel)
    : models.getModels(providerId)[0];
  if (!configuredModel) {
    throw new Error(
      `Model "${requestedModel ?? "default"}" is not available for ${providerId}. Set ASIDE_MODEL to a supported model.`,
    );
  }
  const apiUrl = normalizeAsideApiUrl(getAsideConfigValue(values, "ASIDE_API_URL"));
  const model = apiUrl ? { ...configuredModel, baseUrl: apiUrl } : configuredModel;

  const agent = new Agent({
    initialState: {
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      model,
      thinkingLevel: "off",
      tools: [],
      messages: initialMessages,
    },
    streamFn: models.streamSimple.bind(models),
    transformContext,
    sessionId,
    convertToLlm: (messages) =>
      messages.filter(
        (message) =>
          message.role === "user" ||
          message.role === "assistant" ||
          message.role === "toolResult",
      ),
  });
  return { agent, provider: providerId, model: model.id };
}

export async function createConversationRuntime({
  emit,
  agent,
  onRunSettled,
  environment = process.env,
  configCwd = process.cwd(),
} = {}) {
  const send = emit ?? (() => undefined);
  const configured = agent
    ? describeAgent(agent)
    : await createConfiguredAgent({ environment, configCwd });
  const conversationAgent = configured.agent;
  let active = null;
  let disposed = false;

  const baseTransformContext = conversationAgent.transformContext;
  const baseConvertToLlm = conversationAgent.convertToLlm;
  conversationAgent.transformContext = async (messages, signal) => {
    const transformed = baseTransformContext
      ? await baseTransformContext(messages, signal)
      : messages;
    const run = active;
    return projectAsideContext(transformed, run?.context, run?.text);
  };
  conversationAgent.convertToLlm = async (messages) =>
    baseConvertToLlm(toProviderMessages(messages));

  async function notifyRunSettled(run, status) {
    if (!onRunSettled) return;
    try {
      const result = await onRunSettled({
        request_id: run.request_id,
        status,
        messages: Array.isArray(conversationAgent?.state?.messages)
          ? conversationAgent.state.messages.slice()
          : [],
      });
      if (result?.warning) {
        send({
          type: "session_warning",
          request_id: run.request_id,
          message: sanitizeError(result.warning),
        });
      }
    } catch (error) {
      send({
        type: "session_warning",
        request_id: run.request_id,
        message: sanitizeError(error),
      });
    }
  }

  async function settle(run, status, failure) {
    if (run.settled || active !== run || disposed) return;
    run.settled = true;

    if (status !== "completed") {
      removeUnsuccessfulAssistantMessages(conversationAgent);
    }

    if (status === "cancelled") {
      send({ type: "cancelled", request_id: run.request_id });
    } else if (status === "failed") {
      send({
        type: "failed",
        request_id: run.request_id,
        message: sanitizeError(failure?.errorMessage ?? failure),
        retryable: true,
      });
    } else {
      send({ type: "completed", request_id: run.request_id });
    }

    await notifyRunSettled(run, status);
  }

  const unsubscribe = conversationAgent.subscribe(async (event) => {
    const run = active;
    if (!run || run.settled || disposed) return;

    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      send({
        type: "text_delta",
        request_id: run.request_id,
        delta: event.assistantMessageEvent.delta,
      });
    }

    if (event.type === "agent_end") {
      const failure = event.messages.find(isUnsuccessfulAssistantMessage);
      if (failure?.stopReason === "aborted") {
        await settle(run, "cancelled", failure);
      } else if (failure) {
        await settle(run, "failed", failure);
      } else {
        await settle(run, "completed");
      }
    }
  });

  send({ type: "ready", provider: configured.provider, model: configured.model });

  async function prompt(requestId, text, context) {
    const validationError = validatePromptInput(requestId, text);
    if (validationError) {
      send({
        type: "failed",
        request_id: typeof requestId === "string" ? requestId : "invalid",
        message: validationError,
        retryable: true,
      });
      return;
    }

    let normalizedContext;
    try {
      normalizedContext = validateTurnContext(context);
    } catch (error) {
      send({
        type: "failed",
        request_id: requestId,
        message: sanitizeError(error),
        retryable: true,
      });
      return;
    }

    if (active) {
      send({
        type: "failed",
        request_id: requestId,
        message: "A response is already in progress.",
        retryable: true,
      });
      return;
    }

    const run = {
      request_id: requestId,
      text,
      context: normalizedContext,
      cancel_requested: false,
      settled: false,
    };
    active = run;
    send({ type: "run_started", request_id: requestId });
    try {
      await conversationAgent.prompt(text);
      if (!run.settled && active === run) {
        await settle(run, "completed");
      }
    } catch (error) {
      if (!run.settled && active === run) {
        if (run.cancel_requested) {
          await settle(run, "cancelled", error);
        } else {
          await settle(run, "failed", error);
        }
      }
    } finally {
      if (active === run) active = null;
    }
  }

  function cancel(requestId) {
    if (!active || active.request_id !== requestId) return;
    active.cancel_requested = true;
    conversationAgent.abort();
  }

  function dispose() {
    disposed = true;
    unsubscribe?.();
    active = null;
  }

  return { prompt, cancel, dispose, agent: conversationAgent };
}
