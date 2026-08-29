import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";

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
    .replace(/(?:sk|key|token|secret)[-_][A-Za-z0-9._-]+/gi, "[redacted]")
    .replace(/https?:\/\/[^\s]+/gi, "[provider endpoint]")
    .slice(0, 280);
}

async function createConfiguredAgent() {
  const providerId = (process.env.ASIDE_PROVIDER ?? "openai").trim().toLowerCase();
  const factory = providerFactories[providerId];
  if (!factory) {
    throw new Error(
      `Unsupported provider "${providerId}". Use openai, anthropic, deepseek, or google.`,
    );
  }

  const provider = await factory();
  const models = createModels();
  models.setProvider(provider);
  const requestedModel = process.env.ASIDE_MODEL?.trim();
  const model = requestedModel
    ? models.getModel(providerId, requestedModel)
    : models.getModels(providerId)[0];
  if (!model) {
    throw new Error(
      `Model "${requestedModel ?? "default"}" is not available for ${providerId}. Set ASIDE_MODEL to a supported model.`,
    );
  }

  const agent = new Agent({
    initialState: {
      systemPrompt:
        "You are Aside, a concise and thoughtful desktop assistant. Answer directly and keep short requests practical.",
      model,
      thinkingLevel: "off",
    },
    streamFn: models.streamSimple.bind(models),
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

export async function createConversationRuntime({ emit, agent } = {}) {
  const send = emit ?? (() => undefined);
  const configured = agent
    ? { agent, provider: agent.state.model.provider, model: agent.state.model.id }
    : await createConfiguredAgent();
  const conversationAgent = configured.agent;
  let active = null;

  conversationAgent.subscribe((event) => {
    const run = active;
    if (!run) return;

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
      const failure = event.messages.find(
        (message) => message.role === "assistant" && message.errorMessage,
      );
      if (run.cancel_requested || failure?.stopReason === "aborted") {
        run.settled = true;
        send({ type: "cancelled", request_id: run.request_id });
      } else if (failure) {
        run.settled = true;
        send({
          type: "failed",
          request_id: run.request_id,
          message: sanitizeError(failure.errorMessage),
          retryable: true,
        });
      } else {
        run.settled = true;
        send({ type: "completed", request_id: run.request_id });
      }
    }
  });

  send({ type: "ready", provider: configured.provider, model: configured.model });

  async function prompt(requestId, text) {
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
      cancel_requested: false,
      settled: false,
    };
    active = run;
    send({ type: "run_started", request_id: requestId });
    try {
      await conversationAgent.prompt(text);
      if (!run.settled) {
        run.settled = true;
        send({ type: "completed", request_id: requestId });
      }
    } catch (error) {
      if (!run.settled) {
        run.settled = true;
        send({
          type: "failed",
          request_id: requestId,
          message: sanitizeError(error),
          retryable: true,
        });
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

  return { prompt, cancel };
}
