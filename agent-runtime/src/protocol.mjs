import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import readline from "node:readline";
import { createAsideConversationRuntime } from "./session.mjs";
import { sanitizeError } from "./runtime.mjs";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.has(key));
}

function isTerminalEvent(event) {
  return (
    event?.type === "completed" ||
    event?.type === "cancelled" ||
    event?.type === "failed"
  );
}

export function parseRuntimeRequest(value) {
  if (!isRecord(value) || typeof value.type !== "string") {
    return { type: "invalid", request_id: undefined };
  }

  if (value.type === "prompt") {
    const valid =
      hasOnlyKeys(value, new Set(["type", "request_id", "text", "context"])) &&
      typeof value.request_id === "string" &&
      typeof value.text === "string" &&
      (value.context === undefined || isRecord(value.context));
    return valid
      ? {
          type: "prompt",
          request_id: value.request_id,
          text: value.text,
          ...(value.context === undefined ? {} : { context: value.context }),
        }
      : {
          type: "invalid",
          request_id: typeof value.request_id === "string" ? value.request_id : undefined,
        };
  }

  if (value.type === "cancel") {
    const valid =
      hasOnlyKeys(value, new Set(["type", "request_id"])) &&
      typeof value.request_id === "string";
    return valid
      ? { type: "cancel", request_id: value.request_id }
      : {
          type: "invalid",
          request_id: typeof value.request_id === "string" ? value.request_id : undefined,
        };
  }

  return {
    type: "invalid",
    request_id: typeof value.request_id === "string" ? value.request_id : undefined,
  };
}

function invalidRequestEvent(requestId) {
  return {
    type: "failed",
    request_id: requestId ?? "invalid",
    message: "The runtime request was invalid.",
    retryable: true,
  };
}

export async function runProtocol({
  input = process.stdin,
  emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
  runtimeFactory = createAsideConversationRuntime,
} = {}) {
  let runtime;
  let setupError;
  const startupEvents = [];
  const terminalRequestIds = new Set();
  let startupComplete = false;
  const emitRuntimeEvent = (event) => {
    if (isTerminalEvent(event) && typeof event.request_id === "string") {
      if (terminalRequestIds.has(event.request_id)) return;
      terminalRequestIds.add(event.request_id);
    }
    if (startupComplete) emit(event);
    else startupEvents.push(event);
  };
  try {
    runtime = await runtimeFactory({ emit: emitRuntimeEvent });
    emit({
      type: "history_restored",
      messages: Array.isArray(runtime.history) ? runtime.history : [],
    });
    for (const event of startupEvents) emit(event);
    startupComplete = true;
  } catch (error) {
    setupError = sanitizeError(error);
    emit({ type: "runtime_unavailable", message: setupError });
  }

  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      emit(invalidRequestEvent(undefined));
      continue;
    }

    const request = parseRuntimeRequest(parsed);
    if (request.type === "invalid") {
      emit(invalidRequestEvent(request.request_id));
      continue;
    }

    if (request.type === "prompt") {
      if (!runtime) {
        emit({
          type: "failed",
          request_id: request.request_id,
          message: setupError ?? "The Aside runtime is unavailable.",
          retryable: true,
        });
        continue;
      }
      void runtime
        .prompt(request.request_id, request.text, request.context)
        .catch((error) =>
          emitRuntimeEvent({
            type: "failed",
            request_id: request.request_id,
            message: sanitizeError(error),
            retryable: true,
          }),
        );
      continue;
    }

    if (runtime) runtime.cancel(request.request_id);
  }
}

if (
  process.argv[1] &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])
) {
  await runProtocol();
}
