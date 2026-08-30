export type Visibility = "hidden" | "visible";
export type Surface = "side" | "workspace";

export interface AgentState {
  visibility: Visibility;
  surface: Surface;
  pinned: boolean;
}

export interface NativeError {
  operation: string;
  recoverable: boolean;
  message: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowContext {
  targetId: string;
  monitorId: string;
  bounds: Rect;
  maximized: boolean;
  workspaceCandidate: boolean;
  workArea: Rect;
}

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
