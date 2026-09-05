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
import {
  DEFAULT_AGENT_LIMITS,
  assertSafeText,
  boundedToolResult,
  byteLength,
  createAsideToolRegistry,
  createTaskRun,
  normalizeAgentLimits,
  previewValue,
  sanitizeRuntimeText,
  toolResultText,
  truncateText,
  snapshotTaskRun,
} from "./agent-contracts.mjs";
import {
  WorkspaceError,
  normalizeWorkspaceHint,
  resolveTaskWorkspace,
} from "./workspace.mjs";
import { createWorkspaceReadTools } from "./workspace-tools.mjs";

export const MAX_REQUEST_ID_LENGTH = 128;
export const MAX_PROMPT_LENGTH = 20_000;
export const MAX_SYSTEM_POLICY_BYTES = 8 * 1024;
export { DEFAULT_AGENT_LIMITS } from "./agent-contracts.mjs";
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

function workspaceEventState(state) {
  if (!state || state.status !== "resolved") return undefined;
  return {
    status: state.status,
    source: state.source,
    addressed_path: state.addressed_path,
    canonical_path: state.canonical_path,
    kind: state.kind,
    ...(state.expires_at === undefined ? {} : { expires_at: state.expires_at }),
    ...(state.target
      ? {
          target: {
            role: state.target.role,
            addressed_path: state.target.addressed_path,
            canonical_path: state.target.canonical_path,
            relative_path: state.target.relative_path,
            kind: state.target.kind,
          },
        }
      : {}),
  };
}

function workspaceErrorEvent(error) {
  return {
    code: error?.code ?? "workspace_error",
    message: sanitizeError(error),
  };
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

function normalizeToolSet(tools) {
  return createAsideToolRegistry(tools ?? []);
}

function normalizeSystemPolicy(policy) {
  if (policy === undefined || policy === null || policy === "") return "";
  return assertSafeText(policy, "system_policy", MAX_SYSTEM_POLICY_BYTES);
}

function describeToolCall(event, limits) {
  const args = previewValue(event.args, Math.min(limits.maxToolUpdateBytes, 1_024));
  return {
    tool_call_id: sanitizeRuntimeText(event.toolCallId, 160).text,
    tool: sanitizeRuntimeText(event.toolName, 96).text,
    arguments: args.text,
    arguments_truncated: args.truncated,
  };
}

function emitToolEvent(send, run, event) {
  if (event.type === "tool_execution_start") {
    send({
      type: "tool_call_started",
      request_id: run.request_id,
      task_id: run.task_id,
      ...describeToolCall(event, run.limits),
    });
    return;
  }

  if (event.type === "tool_execution_update") {
    const update = boundedToolResult(
      event.partialResult,
      run.limits.maxToolUpdateBytes,
    );
    send({
      type: "tool_call_update",
      request_id: run.request_id,
      task_id: run.task_id,
      tool_call_id: sanitizeRuntimeText(event.toolCallId, 160).text,
      tool: sanitizeRuntimeText(event.toolName, 96).text,
      text: toolResultText(update),
      truncated: update.truncated,
    });
    return;
  }

  if (event.type === "tool_execution_end") {
    const result = boundedToolResult(
      event.result,
      run.limits.maxToolResultBytes,
    );
    send({
      type: "tool_result",
      request_id: run.request_id,
      task_id: run.task_id,
      tool_call_id: sanitizeRuntimeText(event.toolCallId, 160).text,
      tool: sanitizeRuntimeText(event.toolName, 96).text,
      status: event.isError ? "failed" : "succeeded",
      text: toolResultText(result),
      details: result.details,
      truncated: result.truncated,
    });
  }
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
  tools,
  systemPolicy = "",
  limits = DEFAULT_AGENT_LIMITS,
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
  const normalizedLimits = normalizeAgentLimits(limits);
  const registry = normalizeToolSet(tools ?? createWorkspaceReadTools());
  const normalizedSystemPolicy = normalizeSystemPolicy(systemPolicy);
  const systemPrompt = [DEFAULT_SYSTEM_PROMPT, normalizedSystemPolicy]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join("\n\n");

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: "off",
      tools: registry.tools,
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
  return {
    agent,
    provider: providerId,
    model: model.id,
    registry,
    limits: normalizedLimits,
  };
}

export async function createConversationRuntime({
  emit,
  agent,
  onRunSettled,
  tools,
  toolFactory,
  systemPolicy = "",
  limits = DEFAULT_AGENT_LIMITS,
  taskId,
  now = Date.now,
  workspaceHint: configuredWorkspaceHint,
  workspaceFileSystem,
  environment = process.env,
  configCwd = process.cwd(),
} = {}) {
  const send = emit ?? (() => undefined);
  const normalizedLimits = normalizeAgentLimits(limits);
  const normalizedSystemPolicy = normalizeSystemPolicy(systemPolicy);
  const requestedRegistry = tools === undefined
    ? undefined
    : normalizeToolSet(tools);
  const configured = agent
    ? {
        ...describeAgent(agent),
        registry: requestedRegistry ?? normalizeToolSet([]),
        limits: normalizedLimits,
      }
    : await createConfiguredAgent({
        environment,
        configCwd,
        tools,
        systemPolicy: normalizedSystemPolicy,
        limits: normalizedLimits,
      });
  const conversationAgent = configured.agent;
  let active = null;
  let disposed = false;
  let selectedWorkspace;
  let previousWorkspace;
  if (requestedRegistry) conversationAgent.state.tools = requestedRegistry.tools;
  const initialTools = conversationAgent.state.tools ?? [];
  const baseRegistry = requestedRegistry ?? normalizeToolSet(
    initialTools.length > 0 ? initialTools : createWorkspaceReadTools(),
  );
  let activeRegistry = baseRegistry.filter(
    ({ descriptor }) => descriptor.scope !== "workspace",
  );
  conversationAgent.toolExecution = "sequential";

  function wrapRuntimeTool(tool) {
    return {
      ...tool,
      async execute(toolCallId, params, signal, onUpdate) {
        const run = active;
        if (run) run.counters.concurrent_tools += 1;
        const startedAt = Date.now();
        const controller = new AbortController();
        let timedOut = false;
        let timeoutId;
        const abort = () => controller.abort();
        if (signal?.aborted) controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        const remainingToolMs = run
          ? Math.max(1, run.limits.maxActiveToolMs - run.counters.active_tool_ms)
          : normalizedLimits.maxActiveToolMs;
        const timeout = new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error("The tool exceeded its active-time limit."));
          }, remainingToolMs);
        });
        try {
          const implementation = typeof tool.createForRun === "function"
            ? await tool.createForRun({
                taskRun: run,
                workspace: run?.environment,
                workspaceState: run?.workspace,
              })
            : tool;
          if (!implementation || typeof implementation.execute !== "function") {
            throw new Error("The tool did not provide a run-scoped implementation.");
          }
          const execution = implementation.execute(
            toolCallId,
            params,
            controller.signal,
            onUpdate,
          );
          return await Promise.race([execution, timeout]);
        } catch (error) {
          if (timedOut) {
            throw new Error("The tool exceeded its active-time limit.");
          }
          throw error;
        } finally {
          clearTimeout(timeoutId);
          signal?.removeEventListener("abort", abort);
          if (run) {
            run.counters.active_tool_ms += Date.now() - startedAt;
            run.counters.concurrent_tools = Math.max(
              0,
              run.counters.concurrent_tools - 1,
            );
          }
        }
      },
    };
  }

  function installRegistry(registry) {
    activeRegistry = registry;
    conversationAgent.state.tools = registry.tools.map(wrapRuntimeTool);
  }

  async function registryForRun(run, resolution) {
    const candidateTools = toolFactory
      ? await toolFactory({
          taskRun: run,
          workspace: resolution.environment,
          workspaceState: resolution.state,
        })
      : baseRegistry.tools;
    const registry = normalizeToolSet(candidateTools ?? []);
    return resolution.environment
      ? registry
      : registry.filter(({ descriptor }) => descriptor.scope !== "workspace");
  }

  installRegistry(activeRegistry);

  const baseTransformContext = conversationAgent.transformContext;
  const baseConvertToLlm = conversationAgent.convertToLlm;
  const baseBeforeToolCall = conversationAgent.beforeToolCall;
  const baseAfterToolCall = conversationAgent.afterToolCall;
  const baseShouldStopAfterTurn = conversationAgent.shouldStopAfterTurn;
  conversationAgent.transformContext = async (messages, signal) => {
    const transformed = baseTransformContext
      ? await baseTransformContext(messages, signal)
      : messages;
    const run = active;
    return projectAsideContext(transformed, run?.context, run?.text);
  };
  conversationAgent.convertToLlm = async (messages) =>
    baseConvertToLlm(toProviderMessages(messages));

  conversationAgent.beforeToolCall = async (context, signal) => {
    const run = active;
    if (!run) return { block: true, reason: "No active Aside task is available.", terminate: true };
    if (signal?.aborted || run.cancel_requested) {
      return { block: true, reason: "The Aside task was cancelled.", terminate: true };
    }
    if (run.counters.tool_calls > run.limits.maxToolCalls) {
      run.limit_code = "tool_call_limit";
      run.limit_message = "The task reached its tool-call limit.";
      return {
        block: true,
        reason: "The task reached its tool-call limit.",
        terminate: true,
      };
    }
    if (run.counters.active_tool_ms >= run.limits.maxActiveToolMs) {
      run.limit_code = "active_tool_time_limit";
      run.limit_message = "The task reached its active-tool-time limit.";
      return {
        block: true,
        reason: "The task reached its active-tool-time limit.",
        terminate: true,
      };
    }
    if (run.counters.concurrent_tools >= run.limits.maxConcurrentTools) {
      run.limit_code = "concurrent_tool_limit";
      run.limit_message = "The task reached its concurrent-tool limit.";
      return {
        block: true,
        reason: "The task reached its concurrent-tool limit.",
        terminate: true,
      };
    }
    const registered = activeRegistry.get(context.toolCall.name);
    if (registered?.descriptor.scope === "workspace" && !run.environment) {
      run.limit_code = "workspace_required";
      run.limit_message = "Select a workspace before using file capabilities.";
      return {
        block: true,
        reason: run.limit_message,
        terminate: true,
      };
    }
    const result = await baseBeforeToolCall?.(context, signal);
    if (result?.block) return result;
    return result;
  };

  conversationAgent.afterToolCall = async (context, signal) => {
    const baseResult = baseAfterToolCall
      ? await baseAfterToolCall(context, signal)
      : undefined;
    const candidate = {
      ...context.result,
      ...(baseResult ?? {}),
    };
    const resultDetails = candidate.details;
    const resultIsError =
      candidate.isError === true ||
      ["failed", "unsupported", "cancelled"].includes(resultDetails?.status);
    const bounded = boundedToolResult(candidate, normalizedLimits.maxToolResultBytes);
    return {
      content: bounded.content,
      details: bounded.details,
      isError: Boolean(baseResult?.isError ?? context.isError) || resultIsError,
      ...(bounded.terminate || baseResult?.terminate ? { terminate: true } : {}),
    };
  };

  conversationAgent.shouldStopAfterTurn = async (context, signal) => {
    const baseStop = baseShouldStopAfterTurn
      ? await baseShouldStopAfterTurn(context, signal)
      : false;
    const run = active;
    return Boolean(baseStop);
  };

  async function notifyRunSettled(run, status) {
    if (!onRunSettled) return;
    try {
      const result = await onRunSettled({
        request_id: run.request_id,
        task_id: run.task_id,
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
    const terminalStatus = run.limit_code ? "failed" : status;
    run.status = terminalStatus;

    if (status !== "completed") {
      removeUnsuccessfulAssistantMessages(conversationAgent);
    }

    if (run.limit_code) {
      send({
        type: "failed",
        request_id: run.request_id,
        task_id: run.task_id,
        message: run.limit_message,
        retryable: true,
        code: run.limit_code,
      });
    } else if (status === "cancelled") {
      send({
        type: "cancelled",
        request_id: run.request_id,
        task_id: run.task_id,
      });
    } else if (status === "failed") {
      send({
        type: "failed",
        request_id: run.request_id,
        task_id: run.task_id,
        message: sanitizeError(failure?.errorMessage ?? failure),
        retryable: true,
      });
    } else {
      send({
        type: "completed",
        request_id: run.request_id,
        task_id: run.task_id,
      });
    }

    await notifyRunSettled(run, terminalStatus);
  }

  const unsubscribe = conversationAgent.subscribe(async (event) => {
    const run = active;
    if (!run || run.settled || disposed) return;

    if (event.type === "turn_start") {
      run.counters.model_turns += 1;
      if (run.counters.model_turns > run.limits.maxModelTurns) {
        run.limit_code = "model_turn_limit";
        run.limit_message = "The task reached its model-turn limit.";
        conversationAgent.abort();
      }
    }

    if (event.type === "tool_execution_start") {
      run.counters.tool_calls += 1;
      emitToolEvent(send, run, event);
      if (run.counters.tool_calls > run.limits.maxToolCalls) {
        run.limit_code = "tool_call_limit";
        run.limit_message = "The task reached its tool-call limit.";
        conversationAgent.abort();
      }
    }

    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      const remaining = Math.max(
        0,
        run.limits.maxOutputBytes - run.counters.output_bytes,
      );
      const delta = truncateText(event.assistantMessageEvent.delta, remaining);
      run.counters.output_bytes += byteLength(delta.text);
      send({
        type: "text_delta",
        request_id: run.request_id,
        task_id: run.task_id,
        delta: delta.text,
        truncated: delta.truncated,
      });
      if (delta.truncated) {
        run.limit_code = "output_limit";
        run.limit_message = "The task reached its output limit.";
        conversationAgent.abort();
      }
    }

    if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      emitToolEvent(send, run, event);
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

  send({
    type: "ready",
    provider: configured.provider,
    model: configured.model,
    tools: activeRegistry.describe(),
  });

  async function prompt(requestId, text, context, workspaceHint) {
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

    const run = createTaskRun({
      requestId,
      taskId,
      limits: normalizedLimits,
      now: now(),
    });
    Object.assign(run, {
      text,
      context: normalizedContext,
      cancel_requested: false,
      settled: false,
      status: "running",
    });
    active = run;
    try {
      const resolution = await resolveTaskWorkspace({
        context: normalizedContext,
        workspaceHint: workspaceHint ?? configuredWorkspaceHint ?? selectedWorkspace,
        previousWorkspace,
        fileSystem: workspaceFileSystem,
        now: now(),
      });
      run.workspace = resolution.state.status === "resolved"
        ? workspaceEventState(resolution.state)
        : undefined;
      run.environment = resolution.environment;
      if (resolution.state.status === "resolved") {
        previousWorkspace = resolution.state;
        send({
          type: "workspace_resolved",
          request_id: requestId,
          task_id: run.task_id,
          workspace: workspaceEventState(resolution.state),
        });
      } else {
        send({
          type: "workspace_unresolved",
          request_id: requestId,
          task_id: run.task_id,
          code: resolution.state.code,
          message: resolution.state.message,
        });
      }
      installRegistry(await registryForRun(run, resolution));
      send({
        type: "run_started",
        request_id: requestId,
        task_id: run.task_id,
        limits: run.limits,
        tools: activeRegistry.describe(),
        ...(run.workspace ? { workspace: run.workspace } : {}),
      });
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
      installRegistry(
        baseRegistry.filter(({ descriptor }) => descriptor.scope !== "workspace"),
      );
    }
  }

  async function setWorkspace(ownerTaskId, workspaceHint) {
    if (ownerTaskId !== undefined && ownerTaskId !== (taskId ?? ownerTaskId)) {
      throw new WorkspaceError("workspace_mismatch", "The workspace belongs to another task.");
    }
    if (active) {
      throw new WorkspaceError("workspace_busy", "The workspace cannot change while a task is running.");
    }
    const normalized = normalizeWorkspaceHint(workspaceHint);
    if (!normalized) {
      throw new WorkspaceError("invalid_workspace", "A workspace selection is required.");
    }
    const resolution = await resolveTaskWorkspace({
      workspaceHint: normalized,
      fileSystem: workspaceFileSystem,
      now: now(),
    });
    if (!resolution.environment) {
      throw new WorkspaceError(
        resolution.state.code,
        resolution.state.message,
      );
    }
    selectedWorkspace = normalized;
    previousWorkspace = resolution.state;
    send({
      type: "workspace_resolved",
      task_id: ownerTaskId ?? taskId,
      workspace: workspaceEventState(resolution.state),
    });
    return workspaceEventState(resolution.state);
  }

  function clearWorkspace(ownerTaskId) {
    if (ownerTaskId !== undefined && ownerTaskId !== (taskId ?? ownerTaskId)) {
      throw new WorkspaceError("workspace_mismatch", "The workspace belongs to another task.");
    }
    if (active) {
      throw new WorkspaceError("workspace_busy", "The workspace cannot change while a task is running.");
    }
    selectedWorkspace = undefined;
    previousWorkspace = undefined;
    send({ type: "workspace_cleared", task_id: ownerTaskId ?? taskId });
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

  return {
    prompt,
    cancel,
    dispose,
    agent: conversationAgent,
    get registry() {
      return activeRegistry;
    },
    limits: configured.limits,
    setWorkspace,
    clearWorkspace,
    get activeTaskRun() {
      return snapshotTaskRun(active);
    },
  };
}
