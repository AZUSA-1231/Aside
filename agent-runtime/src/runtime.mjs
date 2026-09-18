import { Agent } from "@earendil-works/pi-agent-core/aside";
import { createModels, defaultProviderAuthContext } from "@earendil-works/pi-ai";
import {
  buildSkillProjection,
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
  AsideContractError,
  DEFAULT_AGENT_LIMITS,
  assertSafeText,
  byteLength,
  createTaskRun,
  normalizeAgentLimits,
  truncateText,
  snapshotTaskRun,
} from "./agent-contracts.mjs";
import {
  NO_RUN_FACTS,
  createRunFacts,
  filterAvailableTools,
} from "./capability-availability.mjs";
import { createAsideToolRegistry } from "./capability-contract.mjs";
import { evaluateToolPolicy } from "./capability-policy.mjs";
import {
  boundedToolResult,
  isFailureToolResultStatus,
  normalizeToolResultStatus,
  permissionNotObtainedResult,
} from "./capability-result.mjs";
import { emitToolEvent } from "./tool-events.mjs";
import {
  DEFAULT_BUILTIN_SKILLS_ROOT,
  buildSkillManifest,
  loadSkills,
  skillEvent,
  skillEventList,
} from "./skill-loader.mjs";
import {
  WorkspaceError,
  normalizeWorkspaceHint,
  resolveTaskWorkspace,
} from "./workspace.mjs";
import {
  createWorkspaceReadTools,
  describeDocumentFormats,
} from "./workspace-tools.mjs";
import { createWorkspaceWriteTools } from "./workspace-write-tools.mjs";
import { createDocumentTools } from "./docx-tools.mjs";
import { PermissionBroker } from "./permission-broker.mjs";

export const MAX_REQUEST_ID_LENGTH = 128;
export const MAX_PROMPT_LENGTH = 20_000;
export const MAX_SYSTEM_POLICY_BYTES = 8 * 1024;
export const MAX_CAPABILITY_SUMMARY_BYTES = 1_024;
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

function createDefaultWorkspaceTools() {
  return [
    ...createWorkspaceReadTools(),
    ...createWorkspaceWriteTools(),
    ...createDocumentTools(),
  ];
}

function normalizeSystemPolicy(policy) {
  if (policy === undefined || policy === null || policy === "") return "";
  return assertSafeText(policy, "system_policy", MAX_SYSTEM_POLICY_BYTES);
}

/**
 * States what the registered capabilities actually do, derived from the
 * registry and the document adapters rather than hand-written, so registering
 * an adapter cannot leave the prompt understating it (C6-I023).
 *
 * A tool description is consulted when the model calls a tool; this is what it
 * uses to answer "can you read a PDF?" before it thinks to look.
 */
function buildCapabilitySummary(registry) {
  const names = registry.descriptors.map((descriptor) => descriptor.name);
  if (names.length === 0) return "";
  const { readable, writable, generatable } = describeDocumentFormats();
  const lines = [
    `You can work with files in the active workspace using these tools: ${names.join(", ")}.`,
    readable.length > 0 ? `Readable formats: ${readable.join(", ")}.` : "",
    writable.length > 0
      ? `Writable formats: ${writable.join(", ")}; every write or edit requires the user's explicit approval.`
      : "",
    generatable.length > 0
      ? `You can also create new ${generatable.join(", ")} documents from a structured specification, always to a new path and never over an existing file.`
      : "",
    // PDF is readable but not writable, which is worth saying outright.
    readable.includes("pdf") && !writable.includes("pdf")
      ? "PDF is read-only: text and page numbers are returned, images are not described, and no OCR is performed."
      : "",
    "A workspace must be resolved before any file tool becomes available; if one is not, ask the user to select a file or folder.",
  ].filter((line) => line.length > 0);
  return truncateText(lines.join(" "), MAX_CAPABILITY_SUMMARY_BYTES).text;
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

async function loadRuntimeSkills(skills, skillLoader) {
  if (skills !== undefined) {
    if (!Array.isArray(skills)) {
      throw new AsideContractError(
        'The runtime field "skills" must be an array.',
        "invalid_skills",
      );
    }
    return { skills, diagnostics: [] };
  }
  const loaded = await (skillLoader ?? (() =>
    loadSkills({ builtinRoot: DEFAULT_BUILTIN_SKILLS_ROOT })))();
  return {
    skills: Array.isArray(loaded?.skills) ? loaded.skills : [],
    diagnostics: Array.isArray(loaded?.diagnostics) ? loaded.diagnostics : [],
  };
}

function normalizeSkillOptions(skills, skillDiagnostics) {
  if (skills !== undefined && !Array.isArray(skills)) {
    throw new AsideContractError(
      'The runtime field "skills" must be an array.',
      "invalid_skills",
    );
  }
  if (skillDiagnostics !== undefined && !Array.isArray(skillDiagnostics)) {
    throw new AsideContractError(
      'The runtime field "skill_diagnostics" must be an array.',
      "invalid_skills",
    );
  }
  return { skills, skillDiagnostics };
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
  skills,
  skillLoader,
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
  const registry = normalizeToolSet(tools ?? createDefaultWorkspaceTools());
  const normalizedSystemPolicy = normalizeSystemPolicy(systemPolicy);
  const loadedSkills = await loadRuntimeSkills(skills, skillLoader);
  const skillManifestText = buildSkillManifest(loadedSkills.skills);
  const systemPrompt = [
    DEFAULT_SYSTEM_PROMPT,
    buildCapabilitySummary(registry),
    normalizedSystemPolicy,
    skillManifestText,
  ]
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
    skills: loadedSkills.skills,
    skillDiagnostics: loadedSkills.diagnostics,
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
  permissionBroker,
  environment = process.env,
  configCwd = process.cwd(),
  skills,
  skillDiagnostics,
} = {}) {
  const send = emit ?? (() => undefined);
  const normalizedLimits = normalizeAgentLimits(limits);
  const normalizedSystemPolicy = normalizeSystemPolicy(systemPolicy);
  const runtimePermissionBroker = permissionBroker ?? new PermissionBroker({
    emit: send,
    now,
    maxPendingMs: normalizedLimits.maxPendingPermissionMs,
  });
  runtimePermissionBroker.setEmitter?.(send);
  const requestedRegistry = tools === undefined
    ? undefined
    : normalizeToolSet(tools);
  normalizeSkillOptions(skills, skillDiagnostics);
  const configured = agent
    ? {
        ...describeAgent(agent),
        registry: requestedRegistry ?? normalizeToolSet([]),
        limits: normalizedLimits,
        skills: skills ?? [],
        skillDiagnostics: skillDiagnostics ?? [],
      }
    : await createConfiguredAgent({
        environment,
        configCwd,
        tools,
        systemPolicy: normalizedSystemPolicy,
        limits: normalizedLimits,
        skills,
      });
  const conversationAgent = configured.agent;
  const runtimeSkills = configured.skills ?? [];
  let activeSkillName;
  let active = null;
  let disposed = false;
  let selectedWorkspace;
  let previousWorkspace;

  /**
   * The identity of the conversation that owns the current workspace. It comes
   * from the durable session, not from how long this process has been running,
   * so a new conversation starts without a workspace instead of inheriting one.
   * The task id (or the runtime instance) is the fallback for an agent that has
   * no session identity, as in tests.
   */
  function currentContinuationId() {
    const sessionId = conversationAgent.sessionId;
    if (typeof sessionId === "string" && sessionId.length > 0) return sessionId;
    return taskId ?? "runtime";
  }
  if (requestedRegistry) conversationAgent.state.tools = requestedRegistry.tools;
  const initialTools = conversationAgent.state.tools ?? [];
  const baseRegistry = requestedRegistry ?? normalizeToolSet(
    initialTools.length > 0 ? initialTools : createDefaultWorkspaceTools(),
  );
  let activeRegistry = filterAvailableTools(baseRegistry, NO_RUN_FACTS);
  conversationAgent.toolExecution = "sequential";

  /**
   * A broker view whose trust metadata comes from the trusted descriptor, not
   * from the adapter. An adapter cannot describe itself as built-in or claim a
   * softer boundary than the registry recorded (C6-I006, PRD section 12).
   */
  function scopedPermissionBroker(broker, descriptor) {
    if (!broker || typeof broker.waitForDecision !== "function") return broker;
    const trusted = (input) => ({
      ...input,
      effect: descriptor.effect,
      egress: descriptor.egress,
      source: descriptor.source,
      origin_label: descriptor.origin.label,
    });
    return {
      waitForDecision: (input, signal) => broker.waitForDecision(trusted(input), signal),
      request: (input, signal) => broker.request(trusted(input), signal),
      resolve: (permissionId, decision, identity) =>
        broker.resolve(permissionId, decision, identity),
      cancel: (permissionId, code) => broker.cancel(permissionId, code),
      cancelForRun: (identity, code) => broker.cancelForRun(identity, code),
      snapshot: () => broker.snapshot(),
      get pendingCount() {
        return broker.pendingCount;
      },
    };
  }

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
              permissionBroker: run?.policy?.descriptor
                ? scopedPermissionBroker(
                  runtimePermissionBroker,
                  run.policy.descriptor,
                )
                : runtimePermissionBroker,
              emit: send,
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
          const outcome = await Promise.race([execution, timeout]);
          // An adapter whose policy required a permission decision must have
          // obtained one, for this run and this call. A success without a
          // consumable grant is refused rather than reported as complete.
          if (
            run?.policy?.decision === "permission_required" &&
            !isFailureToolResultStatus(
              normalizeToolResultStatus(
                outcome?.details,
                outcome?.isError === true,
              ),
            ) &&
            !runtimePermissionBroker.consumeGrant?.(toolCallId, {
              request_id: run.request_id,
              task_id: run.task_id,
            })
          ) {
            return permissionNotObtainedResult(tool.name);
          }
          return outcome;
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
    return filterAvailableTools(
      normalizeToolSet(candidateTools ?? []),
      createRunFacts(run),
    );
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
    const skillProjection = run?.active_skill
      ? buildSkillProjection(run.active_skill, run.skill_instructions)
      : undefined;
    return projectAsideContext(transformed, run?.context, run?.text, skillProjection);
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
    // Defense in depth: the Pi loop rejects unknown tools and the run registry
    // already excludes unavailable ones, but the policy authority must hold
    // even if either of those changes.
    const policy = evaluateToolPolicy({
      registry: activeRegistry,
      toolName: context.toolCall.name,
      facts: run.facts,
    });
    if (policy.decision === "unavailable") {
      run.limit_code = policy.reason_code;
      run.limit_message = policy.reason;
      return {
        block: true,
        reason: policy.reason,
        terminate: true,
      };
    }
    run.policy = policy;
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
    const bounded = boundedToolResult(candidate, normalizedLimits.maxToolResultBytes);
    // Read the tool's own flag, not the loop's: the loop reports isError=false
    // for any tool that returns rather than throws. A tool that reports a
    // failure only through details.status is still a failure.
    const status = normalizeToolResultStatus(
      bounded.details ?? candidate.details,
      candidate.isError === true || baseResult?.isError === true,
    );
    return {
      content: bounded.content,
      details: bounded.details,
      isError: isFailureToolResultStatus(status),
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
    // An approval that was never spent must not outlive its run.
    runtimePermissionBroker.clearGrantsForRun?.({
      requestId: run.request_id,
      taskId: run.task_id,
    });

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
      // A run the user stopped is cancelled regardless of which turn it was
      // in. Aborting mid-tool-call surfaces as an error message rather than an
      // aborted stop reason, so the request flag is the authoritative signal —
      // the same rule `prompt()` already applies to a thrown abort.
      if (run.cancel_requested || failure?.stopReason === "aborted") {
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
    ...(runtimeSkills.length > 0 ? { skills: skillEventList(runtimeSkills) } : {}),
    ...(configured.skillDiagnostics?.length > 0
      ? { skill_diagnostics: configured.skillDiagnostics }
      : {}),
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
    const activeSkill = activeSkillName
      ? runtimeSkills.find((candidate) => candidate.name === activeSkillName)
      : undefined;
    Object.assign(run, {
      text,
      context: normalizedContext,
      cancel_requested: false,
      settled: false,
      status: "running",
      ...(activeSkill
        ? {
            active_skill: skillEvent(activeSkill),
            skill_instructions: activeSkill.instructions,
          }
        : {}),
    });
    active = run;
    try {
      // Process lifetime is not task continuity: a changed conversation
      // identity must not inherit the previous run's workspace (C6-I021).
      const continuationId = currentContinuationId();
      let resolution;
      try {
        resolution = await resolveTaskWorkspace({
          context: normalizedContext,
          workspaceHint: workspaceHint ?? configuredWorkspaceHint ?? selectedWorkspace,
          previousWorkspace,
          continuationId,
          fileSystem: workspaceFileSystem,
          now: now(),
        });
      } catch (error) {
        // A stale, inaccessible, or ambiguous descriptor is a recoverable
        // state, not a run failure: the model still answers without scoped
        // tools rather than having the task killed (C6-08).
        if (!(error instanceof WorkspaceError)) throw error;
        resolution = {
          state: {
            status: "unresolved",
            code: typeof error.code === "string" ? error.code : "workspace_error",
            message: sanitizeError(error),
          },
          environment: undefined,
        };
      }
      if (resolution.overridden) {
        send({
          type: "workspace_overridden",
          request_id: requestId,
          task_id: run.task_id,
          replaced_by: resolution.overridden.source,
          captured_path: resolution.overridden.captured_path,
        });
      }
      run.workspace = resolution.state.status === "resolved"
        ? workspaceEventState(resolution.state)
        : undefined;
      run.environment = resolution.environment;
      // The single run-scoped fact bag, computed once. Availability filtering
      // and the policy evaluator both read it.
      run.facts = createRunFacts(run);
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
        ...(run.active_skill ? { active_skill: run.active_skill } : {}),
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
      installRegistry(filterAvailableTools(baseRegistry, NO_RUN_FACTS));
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
      continuationId: currentContinuationId(),
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
    runtimePermissionBroker.cancelForRun?.({
      requestId: active.request_id,
      taskId: active.task_id,
    }, "aborted");
    conversationAgent.abort();
  }

  function resolvePermission(permissionId, decision, identity = {}) {
    return runtimePermissionBroker.resolve(permissionId, decision, identity);
  }

  function setActiveSkill(name) {
    const skill = runtimeSkills.find((candidate) => candidate.name === name);
    if (!skill) {
      throw new AsideContractError(
        `The skill "${name}" is not available.`,
        "unknown_skill",
      );
    }
    activeSkillName = name;
    send({
      type: "skill_activated",
      ...(taskId ? { task_id: taskId } : {}),
      skill: skillEvent(skill),
    });
    return skillEvent(skill);
  }

  function clearActiveSkill() {
    activeSkillName = undefined;
    send({
      type: "skill_cleared",
      ...(taskId ? { task_id: taskId } : {}),
    });
  }

  function dispose() {
    disposed = true;
    runtimePermissionBroker.dispose?.();
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
    resolvePermission,
    permissionBroker: runtimePermissionBroker,
    setActiveSkill,
    clearActiveSkill,
    get skills() {
      return skillEventList(runtimeSkills);
    },
    get activeSkill() {
      return activeSkillName
        ? skillEvent(
            runtimeSkills.find((candidate) => candidate.name === activeSkillName),
          )
        : undefined;
    },
    get pendingPermissions() {
      return runtimePermissionBroker.snapshot?.() ?? [];
    },
    get activeTaskRun() {
      return snapshotTaskRun(active);
    },
  };
}
