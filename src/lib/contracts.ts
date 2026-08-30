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
  | { type: "runtime_unavailable"; message: string };
