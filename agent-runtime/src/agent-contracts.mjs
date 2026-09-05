const textEncoder = new TextEncoder();
const controlCharacterPattern = /[\x00-\x1f\x7f]/;

export const MAX_TASK_ID_LENGTH = 160;
export const MAX_TOOL_NAME_LENGTH = 96;
export const MAX_TOOL_DESCRIPTION_LENGTH = 800;
export const MAX_TOOL_LABEL_LENGTH = 120;
export const MAX_TOOL_PREVIEW_BYTES = 2_048;

export const DEFAULT_AGENT_LIMITS = Object.freeze({
  maxModelTurns: 12,
  maxToolCalls: 32,
  maxActiveToolMs: 120_000,
  maxOutputBytes: 64 * 1024,
  maxToolResultBytes: 32 * 1024,
  maxToolUpdateBytes: 4 * 1024,
  maxConcurrentTools: 1,
  maxPendingPermissionMs: 120_000,
});

const LIMIT_MAXIMUMS = Object.freeze({
  maxModelTurns: 64,
  maxToolCalls: 256,
  maxActiveToolMs: 10 * 60 * 1000,
  maxOutputBytes: 512 * 1024,
  maxToolResultBytes: 256 * 1024,
  maxToolUpdateBytes: 32 * 1024,
  maxConcurrentTools: 1,
  maxPendingPermissionMs: 10 * 60 * 1000,
});

const effects = new Set(["read", "write", "external"]);
const scopes = new Set(["workspace", "host", "application", "none"]);
const replayPolicies = new Set(["safe", "non_replayable"]);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export class AsideContractError extends Error {
  constructor(message, code = "invalid_contract") {
    super(message);
    this.name = "AsideContractError";
    this.code = code;
  }
}

function invalid(field, message = "is invalid") {
  throw new AsideContractError(`The runtime field "${field}" ${message}.`);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function byteLength(value) {
  return textEncoder.encode(String(value)).byteLength;
}

export function truncateText(value, maxBytes) {
  const text = String(value ?? "");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) invalid("maxBytes");
  if (byteLength(text) <= maxBytes) return { text, truncated: false };

  let result = "";
  for (const character of text) {
    if (byteLength(result + character) > maxBytes) break;
    result += character;
  }
  return { text: result, truncated: true };
}

function redactText(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(api[-_ ]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9._-]{8,}/gi, "[redacted]")
    .replace(/(?:key|token|secret)[-_][A-Za-z0-9._-]{8,}/gi, "[redacted]");
}

function redactValue(value, depth = 0) {
  if (depth > 4) return "[nested value omitted]";
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((item) => redactValue(item, depth + 1));
  }
  if (!isPlainObject(value)) return "[value omitted]";

  const result = {};
  for (const key of Object.keys(value).slice(0, 64)) {
    if (/key|token|secret|password|authorization|credential/i.test(key)) {
      result[key] = "[redacted]";
    } else {
      result[key] = redactValue(value[key], depth + 1);
    }
  }
  return result;
}

export function previewValue(value, maxBytes = MAX_TOOL_PREVIEW_BYTES) {
  let serialized;
  try {
    serialized = JSON.stringify(redactValue(value));
  } catch {
    serialized = "[unserializable value]";
  }
  return truncateText(serialized ?? "null", maxBytes);
}

function normalizeBoundedString(value, field, maxBytes, { required = true } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && value.length === 0)) invalid(field);
  if (controlCharacterPattern.test(value)) invalid(field);
  const bounded = truncateText(value, maxBytes);
  if (bounded.truncated) invalid(field, `must be at most ${maxBytes} bytes`);
  return value;
}

export function normalizeAgentLimits(input = {}) {
  if (!isPlainObject(input)) invalid("limits");
  for (const key of Object.keys(input)) {
    if (!(key in DEFAULT_AGENT_LIMITS)) invalid(`limits.${key}`);
  }
  const result = {};
  for (const [field, defaultValue] of Object.entries(DEFAULT_AGENT_LIMITS)) {
    const value = input[field] ?? defaultValue;
    const maximum = LIMIT_MAXIMUMS[field];
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      invalid(`limits.${field}`, `must be a positive integer no greater than ${maximum}`);
    }
    result[field] = value;
  }
  return Object.freeze(result);
}

export function createTaskRun({
  requestId,
  taskId = requestId,
  limits,
  now = Date.now(),
} = {}) {
  normalizeBoundedString(requestId, "request_id", MAX_TASK_ID_LENGTH);
  normalizeBoundedString(taskId, "task_id", MAX_TASK_ID_LENGTH);
  if (!Number.isSafeInteger(now) || now < 0) invalid("started_at");

  return {
    id: taskId,
    task_id: taskId,
    request_id: requestId,
    status: "created",
    limits: normalizeAgentLimits(limits),
    counters: {
      model_turns: 0,
      tool_calls: 0,
      output_bytes: 0,
      active_tool_ms: 0,
      concurrent_tools: 0,
    },
    started_at: now,
  };
}

export function snapshotTaskRun(run) {
  if (!run) return undefined;
  return {
    id: run.id,
    task_id: run.task_id,
    request_id: run.request_id,
    status: run.status,
    limits: { ...run.limits },
    counters: { ...run.counters },
    started_at: run.started_at,
    ...(run.workspace ? { workspace: { ...run.workspace } } : {}),
    ...(run.active_skill ? { active_skill: { ...run.active_skill } } : {}),
  };
}

export function normalizeToolDescriptor(input = {}) {
  if (!isPlainObject(input)) invalid("tool");
  const name = normalizeBoundedString(input.name, "tool.name", MAX_TOOL_NAME_LENGTH);
  if (!identifierPattern.test(name)) invalid("tool.name");
  const description = normalizeBoundedString(
    input.description,
    "tool.description",
    MAX_TOOL_DESCRIPTION_LENGTH,
  );
  const label = normalizeBoundedString(
    input.label ?? name,
    "tool.label",
    MAX_TOOL_LABEL_LENGTH,
  );
  const effect = input.effect;
  const scope = input.scope;
  const replay = input.replay;
  if (!effects.has(effect)) invalid("tool.effect");
  if (!scopes.has(scope)) invalid("tool.scope");
  if (!replayPolicies.has(replay)) invalid("tool.replay");

  return Object.freeze({ name, description, label, effect, scope, replay });
}

export function createAsideToolRegistry(tools = []) {
  if (!Array.isArray(tools)) invalid("tools");
  const entries = [];
  const byName = new Map();
  for (const entry of tools) {
    if (!entry || typeof entry !== "object") invalid("tools[]");
    const tool = entry.tool ?? entry;
    const sourceDescriptor = entry.descriptor ?? entry;
    const descriptor = normalizeToolDescriptor({
      ...sourceDescriptor,
      name: sourceDescriptor.name ?? tool.name,
      description: sourceDescriptor.description ?? tool.description,
      label: sourceDescriptor.label ?? tool.label ?? tool.name,
    });
    if (
      typeof tool.name !== "string" ||
      tool.name !== descriptor.name ||
      (typeof tool.execute !== "function" && typeof tool.createForRun !== "function") ||
      !tool.parameters
    ) {
      invalid(`tools.${descriptor.name}`);
    }
    if (byName.has(descriptor.name)) {
      throw new AsideContractError(
        `The runtime tool "${descriptor.name}" is registered more than once.`,
        "duplicate_tool",
      );
    }
    byName.set(descriptor.name, { tool, descriptor });
    entries.push({ tool, descriptor });
  }

  return Object.freeze({
    entries: Object.freeze(entries.slice()),
    tools: Object.freeze(entries.map(({ tool }) => tool)),
    descriptors: Object.freeze(entries.map(({ descriptor }) => descriptor)),
    get(name) {
      return byName.get(name);
    },
    has(name) {
      return byName.has(name);
    },
    describe() {
      return entries.map(({ descriptor }) => ({ ...descriptor }));
    },
    filter(predicate) {
      return createAsideToolRegistry(entries.filter(predicate));
    },
  });
}

export function boundedToolResult(result, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) invalid("maxBytes");
  const content = Array.isArray(result?.content) ? result.content : [];
  let remaining = maxBytes;
  let truncated = false;
  const boundedContent = [];
  for (const block of content) {
    if (block?.type !== "text" || remaining <= 0) {
      truncated = true;
      continue;
    }
    const bounded = truncateText(redactText(block.text), remaining);
    boundedContent.push({ type: "text", text: bounded.text });
    remaining -= byteLength(bounded.text);
    truncated ||= bounded.truncated;
  }
  const marker = "\n[tool output truncated]";
  if (truncated && remaining >= byteLength(marker)) {
    boundedContent.push({ type: "text", text: marker });
  }

  const detailsPreview = previewValue(
    result?.details ?? {},
    Math.min(maxBytes, MAX_TOOL_PREVIEW_BYTES),
  );
  let details;
  try {
    details = JSON.parse(detailsPreview.text);
  } catch {
    details = { summary: detailsPreview.text };
  }

  return {
    content: boundedContent,
    details,
    ...(result?.usage ? { usage: result.usage } : {}),
    ...(Array.isArray(result?.addedToolNames)
      ? { addedToolNames: result.addedToolNames.slice(0, 16) }
      : {}),
    ...(result?.terminate === true ? { terminate: true } : {}),
    truncated: truncated || detailsPreview.truncated,
  };
}

export function boundedAgentMessage(message, maxBytes) {
  if (!message || typeof message !== "object") return message;
  if (!Array.isArray(message.content)) return message;
  let remaining = maxBytes;
  let truncated = false;
  const content = message.content.map((block) => {
    if (block?.type !== "text") return block;
    const bounded = truncateText(block.text, remaining);
    remaining = Math.max(0, remaining - byteLength(bounded.text));
    truncated ||= bounded.truncated;
    return { ...block, text: bounded.text };
  });
  return { ...message, content, ...(truncated ? { truncated: true } : {}) };
}

export function toolResultText(result) {
  return (result?.content ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function sanitizeRuntimeText(value, maxBytes = MAX_TOOL_PREVIEW_BYTES) {
  return truncateText(redactText(value), maxBytes);
}

export function assertSafeText(value, field, maxBytes = MAX_TOOL_PREVIEW_BYTES) {
  return normalizeBoundedString(value, field, maxBytes);
}
