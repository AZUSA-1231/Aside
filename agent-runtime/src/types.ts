export const RUNTIME_MAX_REQUEST_ID_LENGTH = 128;
export const RUNTIME_MAX_PROMPT_LENGTH = 20_000;
export const MAX_CONTEXT_BLOCKS = 8;
export const MAX_CONTEXT_TEXT_BYTES = 8 * 1024;
export const MAX_CONTEXT_JSON_BYTES = 16 * 1024;
export const MAX_CONTEXT_TOTAL_BYTES = 24 * 1024;
export const MAX_CONTEXT_JSON_DEPTH = 4;

export interface AsideFlow {
  id: string;
  kind: string;
  label?: string;
}

export interface AsideTextContextBlock {
  type: "text";
  label?: string;
  text: string;
}

export interface AsideJsonContextBlock {
  type: "json";
  label?: string;
  data: unknown;
}

export type AsideContextBlock = AsideTextContextBlock | AsideJsonContextBlock;

export interface AsideTurnContext {
  flow: AsideFlow;
  blocks: AsideContextBlock[];
}

export interface RuntimeHistoryMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: "complete";
  timestamp: number;
}

export type RuntimeRequest =
  | {
      type: "prompt";
      request_id: string;
      text: string;
      context?: AsideTurnContext;
    }
  | { type: "cancel"; request_id: string };

export type RuntimeTerminalStatus = "completed" | "cancelled" | "failed";

export type RuntimeEvent =
  | { type: "ready"; provider: string; model: string }
  | { type: "run_started"; request_id: string }
  | { type: "text_delta"; request_id: string; delta: string }
  | { type: "completed"; request_id: string }
  | { type: "cancelled"; request_id: string }
  | {
      type: "failed";
      request_id: string;
      message: string;
      retryable: boolean;
    }
  | { type: "session_warning"; request_id?: string; message: string }
  | { type: "history_restored"; messages: RuntimeHistoryMessage[] }
  | { type: "runtime_unavailable"; message: string };
