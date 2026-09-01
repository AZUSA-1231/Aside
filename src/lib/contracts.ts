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
  applicationId?: string;
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

export type AsideHostKind =
  | "browser"
  | "explorer"
  | "vscode"
  | "pdf_reader";
export type AsideHostAvailability =
  | "available"
  | "unsupported"
  | "ambiguous"
  | "unavailable";
export type AsideHostCapability =
  | "identify"
  | "capture_context"
  | "chromium_uia_semantic_capture"
  | "browser_url_title"
  | "explorer_metadata"
  | "vscode_workspace"
  | "pdf_document";
export type AsideContextSensitivity =
  | "public"
  | "local_metadata"
  | "local_content"
  | "restricted";

export interface AsideHostAttachment {
  id: string;
  host: AsideHostKind;
  source: string;
  capturedAt: number;
  expiresAt: number;
  sensitivity: AsideContextSensitivity;
  summary: string;
  blocks: AsideContextBlock[];
}

export interface HostView {
  targetId?: string;
  applicationId?: string;
  kind: AsideHostKind | "unsupported";
  availability: AsideHostAvailability;
  capabilities: AsideHostCapability[];
}

export type HostCaptureErrorCode =
  | "no_foreground_target"
  | "ambiguous_target"
  | "unsupported_capability"
  | "permission_denied"
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "malformed"
  | "oversized"
  | "expired"
  | "stale_target"
  | "capture_failed";

export interface HostCaptureError {
  code: HostCaptureErrorCode;
  message: string;
  recoverable: boolean;
}

export interface HostCaptureResult {
  captureId: string;
  host: HostView;
  attachment?: AsideHostAttachment;
  error?: HostCaptureError;
}

export interface AsideTurnContext {
  flow: AsideFlow;
  blocks: AsideContextBlock[];
  attachments?: AsideHostAttachment[];
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
