import {
  MAX_TOOL_PREVIEW_BYTES,
  byteLength,
  invalid,
  previewValue,
  sanitizeRuntimeText,
} from "./agent-contracts.mjs";

/**
 * One bounded normalized result vocabulary for every adapter. Covers the
 * Cycle 6 PLAN list plus `invalidated`, which Cycle 5 already emits and which
 * cannot be dropped without a wire break.
 */
export const TOOL_RESULT_STATUSES = Object.freeze([
  "succeeded",
  "partial",
  "denied",
  "cancelled",
  "expired",
  "invalidated",
  "stale",
  "unsupported",
  "unavailable",
  "timed_out",
  "disconnected",
  "malformed",
  "failed",
]);

// `succeeded` and `partial` are the only statuses that are not failures.
export const TOOL_RESULT_FAILURE_STATUSES = Object.freeze(
  TOOL_RESULT_STATUSES.filter(
    (status) => status !== "succeeded" && status !== "partial",
  ),
);

export const MAX_TOOL_RESULT_MESSAGE_BYTES = 512;
export const MAX_TOOL_RESULT_DETAIL_BYTES = 8 * 1024;

export function isFailureToolResultStatus(status) {
  return TOOL_RESULT_FAILURE_STATUSES.includes(status);
}

/**
 * Reads a declared status when it is part of the vocabulary; otherwise falls
 * back to the tool's own error flag. A tool that reports `denied`, `expired`,
 * or `invalidated` through `details.status` alone is never counted as success.
 */
export function normalizeToolResultStatus(details, isError = false) {
  const status = details?.status;
  if (typeof status === "string" && TOOL_RESULT_STATUSES.includes(status)) {
    return status;
  }
  return isError === true ? "failed" : "succeeded";
}

/**
 * Maps a thrown runtime error to a result status. Mirrors the mapping the
 * workspace write adapter applies today so every adapter gets it for free.
 */
export function toolResultStatusForError(error) {
  const code = typeof error?.code === "string" ? error.code : undefined;
  if (code === "permission_denied") return "denied";
  if (code === "permission_expired") return "expired";
  if (code === "permission_invalidated") return "invalidated";
  if (code === "aborted" || code === "permission_cancelled") return "cancelled";
  return "failed";
}

const TRUNCATION_MARKER = "\n[tool output truncated]";

/**
 * Below this much content, the truncation notice is dropped rather than the
 * payload. A notice must never be the whole result.
 *
 * Small enough that an ordinary small budget still carries the notice: at 64
 * bytes total the content gets 40 and the notice 24. Only a budget too small to
 * hold both spends itself entirely on content.
 */
const MIN_CONTENT_BYTES = 32;

export function boundedToolResult(result, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) invalid("maxBytes");
  const content = Array.isArray(result?.content) ? result.content : [];
  // Room for the marker is reserved up front, but only when there is room to
  // spare. Both halves of that matter, and each was learned by getting it wrong:
  //
  //  - Appending the marker afterwards, if bytes remain, never fires. After a
  //    content-filled truncation `remaining` is 0 exactly when the notice is
  //    needed, so it was absent in the one case it existed for.
  //  - Reserving unconditionally crowds out the content itself when the budget
  //    is smaller than the marker, turning a truncated result into a result
  //    consisting only of a notice about truncation.
  //
  // So: reserve when the budget can hold both, and otherwise spend it all on
  // content. The `truncated` flag is the contract callers rely on; the marker is
  // a courtesy for the model, and a courtesy must not displace the payload.
  const markerBytes = byteLength(TRUNCATION_MARKER);
  const reserve = maxBytes > markerBytes + MIN_CONTENT_BYTES ? markerBytes : 0;
  let remaining = Math.max(0, maxBytes - reserve);
  let truncated = false;
  const boundedContent = [];
  for (const block of content) {
    if (block?.type !== "text" || remaining <= 0) {
      truncated = true;
      continue;
    }
    const bounded = sanitizeRuntimeText(block.text, remaining);
    boundedContent.push({ type: "text", text: bounded.text });
    remaining -= byteLength(bounded.text);
    truncated ||= bounded.truncated;
  }
  // `reserve > 0` is the condition, not `remaining >= markerBytes`: the content
  // was allowed exactly `maxBytes - reserve`, so a truncation consumes all of
  // `remaining` while the reserved bytes sit untouched beside it.
  if (truncated && reserve > 0) {
    boundedContent.push({ type: "text", text: TRUNCATION_MARKER });
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

/**
 * Builds one bounded, redacted envelope. `details` must carry only bounded
 * operation data: `session.mjs` persists tool results verbatim, so trusted
 * policy metadata (descriptor, risk, origin, policy) must never reach it.
 */
/**
 * Builds a bounded tool result envelope.
 *
 * `content` is what Pi serializes into the provider request — it is the only
 * part of a result the model actually reads. `details` reaches the UI and the
 * session store, and is deliberately richer.
 *
 * `body` exists because that distinction was got wrong. An adapter that placed
 * a tool's payload only in `details` produced a result the model saw as
 * "succeeded" with no content: the call worked, and the model had nothing to
 * work with. Anything the model is meant to use belongs in `body`, and
 * anything only the UI needs belongs in `details`.
 */
export function toolResultEnvelope({
  tool,
  status,
  code,
  message,
  body,
  details = {},
  maxBytes = MAX_TOOL_RESULT_DETAIL_BYTES,
} = {}) {
  const normalizedStatus =
    typeof status === "string" && TOOL_RESULT_STATUSES.includes(status)
      ? status
      : "failed";
  const boundedMessage = sanitizeRuntimeText(
    typeof message === "string" && message.length > 0
      ? message
      : `${tool} ${normalizedStatus}`,
    MAX_TOOL_RESULT_MESSAGE_BYTES,
  ).text;
  const header = `${tool} ${normalizedStatus}\n${boundedMessage}`;
  const contentText = typeof body === "string" && body.length > 0
    ? `${header}\n\n${body}`
    : header;
  const bounded = boundedToolResult(
    {
      content: [{ type: "text", text: contentText }],
      details: {
        status: normalizedStatus,
        tool,
        ...(typeof code === "string" && code.length > 0 ? { code } : {}),
        message: boundedMessage,
        ...details,
      },
    },
    maxBytes,
  );
  return {
    ...bounded,
    isError: isFailureToolResultStatus(bounded.details?.status ?? normalizedStatus),
  };
}

/**
 * A failure envelope built from a typed error. Kept here rather than in each
 * adapter so every family reports failures the same way.
 */
export function failedToolResultEnvelope(
  tool,
  { code = "failed", message, details = {} } = {},
) {
  return toolResultEnvelope({
    tool,
    status: "failed",
    code,
    message,
    details,
  });
}

export function cancelledToolResult(tool, { code = "cancelled", message } = {}) {
  return toolResultEnvelope({
    tool,
    status: "cancelled",
    code,
    message: message ?? "The operation was cancelled before it completed.",
  });
}

export function deniedToolResult(tool, { code = "denied", message } = {}) {
  return toolResultEnvelope({
    tool,
    status: "denied",
    code,
    message: message ?? "The operation was not approved.",
  });
}

export function unavailableToolResult(tool, { code = "unavailable", message } = {}) {
  return toolResultEnvelope({
    tool,
    status: "unavailable",
    code,
    message: message ?? "This capability is not available for the current task.",
  });
}

/**
 * Returned when a policy decision required a permission decision and the
 * adapter returned a success without obtaining one. Fails loudly rather than
 * letting an unapproved effect be reported as complete.
 */
export function permissionNotObtainedResult(tool) {
  return toolResultEnvelope({
    tool,
    status: "denied",
    code: "permission_not_obtained",
    message:
      "This capability requires a permission decision and none was obtained.",
  });
}

