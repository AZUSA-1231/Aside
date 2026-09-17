import { previewValue, sanitizeRuntimeText, toolResultText } from "./agent-contracts.mjs";
import { boundedToolResult, normalizeToolResultStatus } from "./capability-result.mjs";

const MAX_TOOL_CALL_ID_BYTES = 160;
const MAX_TOOL_NAME_BYTES = 96;
const MAX_ARGUMENT_PREVIEW_BYTES = 1_024;

export function describeToolCall(event, limits) {
  const args = previewValue(
    event.args,
    Math.min(limits.maxToolUpdateBytes, MAX_ARGUMENT_PREVIEW_BYTES),
  );
  return {
    tool_call_id: sanitizeRuntimeText(event.toolCallId, MAX_TOOL_CALL_ID_BYTES).text,
    tool: sanitizeRuntimeText(event.toolName, MAX_TOOL_NAME_BYTES).text,
    arguments: args.text,
    arguments_truncated: args.truncated,
  };
}

/**
 * Projects one Pi tool-execution event onto the Aside event vocabulary. Every
 * result status comes from the shared normalized vocabulary, so a status this
 * runtime has never seen cannot be reported as a success.
 */
export function emitToolEvent(send, run, event) {
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
      tool_call_id: sanitizeRuntimeText(event.toolCallId, MAX_TOOL_CALL_ID_BYTES).text,
      tool: sanitizeRuntimeText(event.toolName, MAX_TOOL_NAME_BYTES).text,
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
      tool_call_id: sanitizeRuntimeText(event.toolCallId, MAX_TOOL_CALL_ID_BYTES).text,
      tool: sanitizeRuntimeText(event.toolName, MAX_TOOL_NAME_BYTES).text,
      status: normalizeToolResultStatus(result.details, event.isError),
      text: toolResultText(result),
      details: result.details,
      truncated: result.truncated,
    });
  }
}
