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
  | "pdf_reader"
  | "word"
  | "excel"
  | "generic";
export type AsideHostAvailability =
  | "available"
  | "unsupported"
  | "ambiguous"
  | "unavailable";
export type AsideHostCapability =
  | "identify"
  | "capture_context"
  | "generic_uia_semantic_capture"
  | "chromium_uia_semantic_capture"
  | "browser_url_title"
  | "explorer_metadata"
  | "vscode_workspace"
  | "pdf_document"
  | "word_document"
  | "excel_document"
  | "path_descriptor";
export type AsideContextSensitivity =
  | "public"
  | "local_metadata"
  | "local_content"
  | "restricted";

export type AsidePathRole =
  | "workspace_root"
  | "active_file"
  | "directory"
  | "selected_item"
  | "document";
export type AsidePathKind = "file" | "directory";

export interface AsidePathDescriptor {
  role: AsidePathRole;
  path: string;
  kind: AsidePathKind;
}

export interface AsideHostAttachment {
  id: string;
  host: AsideHostKind;
  /** Optional for attachments produced by an older desktop build. */
  strategy?: string;
  source: string;
  capturedAt: number;
  expiresAt: number;
  sensitivity: AsideContextSensitivity;
  summary: string;
  blocks: AsideContextBlock[];
  /** Optional for attachments produced before path descriptors were added. */
  descriptors?: AsidePathDescriptor[];
}

export interface HostView {
  targetId?: string;
  applicationId?: string;
  kind: AsideHostKind | "unsupported";
  strategy?: string;
  strategyPriority?: number;
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
  | "locator_unavailable"
  | "ambiguous_locator"
  | "invalid_path"
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
  filePath?: string;
  formattedJson?: string;
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

export interface RuntimeWorkspaceState {
  status: string;
  source: string;
  addressed_path: string;
  canonical_path: string;
  kind: string;
  expires_at?: number;
  target?: {
    role: string;
    addressed_path: string;
    canonical_path: string;
    relative_path: string;
    kind: string;
  };
}

export interface RuntimeCapabilityAvailability {
  prerequisites: string[];
}

/**
 * A bounded display projection. Trusted policy metadata stays runtime
 * authoritative; React never feeds these values back as a decision.
 */
export interface RuntimeToolDescriptor {
  contract_version: number;
  name: string;
  description: string;
  label: string;
  effect: string;
  scope: string;
  egress: string;
  source: string;
  replay: string;
  availability: RuntimeCapabilityAvailability;
  origin_label: string;
}

/**
 * The runtime's honest description of a capability's trust boundary. `note` is
 * looked up from a closed table by the runtime, never composed by a caller.
 */
export interface RuntimeCapabilityRisk {
  effect: string;
  egress: string;
  source: string;
  origin_label: string;
  boundary: "aside_enforced" | "external_process";
  note: string;
}

export interface RuntimeSkillEvent {
  name: string;
  description: string;
  source: string;
  model_invocation: boolean;
  expects?: string[];
}

export interface RuntimePermissionRequest {
  permission_id: string;
  request_id: string;
  task_id: string;
  tool_call_id: string;
  operation: string;
  effect: string;
  egress: string;
  source: string;
  risk: RuntimeCapabilityRisk;
  expires_at: number;
  status: string;
}

export interface RuntimeToolResultDetails {
  status: string;
  code?: string;
  [key: string]: unknown;
}

export interface RuntimeVerificationState {
  tool: string;
  path: string;
  status: string;
  format?: string;
}

export type RuntimeEvent =
  | {
      type: "ready";
      provider: string;
      model: string;
      tools?: RuntimeToolDescriptor[];
      skills?: RuntimeSkillEvent[];
      skill_diagnostics?: Array<{ code: string; message: string; path?: string }>;
    }
  | {
      type: "workspace_resolved";
      request_id: string;
      task_id: string;
      workspace: RuntimeWorkspaceState;
    }
  | {
      type: "workspace_unresolved";
      request_id?: string;
      task_id?: string;
      code: string;
      message: string;
    }
  | { type: "workspace_cleared"; task_id?: string }
  | {
      /** An explicit selection outranked a capture in the same prompt. */
      type: "workspace_overridden";
      request_id: string;
      task_id: string;
      replaced_by: string;
      captured_path: string;
    }
  | {
      type: "run_started";
      request_id: string;
      task_id?: string;
      limits?: Record<string, number>;
      tools?: RuntimeToolDescriptor[];
      workspace?: RuntimeWorkspaceState;
      active_skill?: RuntimeSkillEvent;
    }
  | {
      type: "tool_call_started";
      request_id: string;
      task_id: string;
      tool_call_id: string;
      tool: string;
      arguments: string;
      arguments_truncated: boolean;
    }
  | {
      type: "tool_call_update";
      request_id: string;
      task_id: string;
      tool_call_id: string;
      tool: string;
      text: string;
      truncated: boolean;
    }
  | {
      type: "tool_result";
      request_id: string;
      task_id: string;
      tool_call_id: string;
      tool: string;
      status: string;
      text: string;
      details: RuntimeToolResultDetails;
      truncated: boolean;
    }
  | {
      type: "text_delta";
      request_id: string;
      task_id?: string;
      delta: string;
      truncated?: boolean;
    }
  | {
      type: "permission_requested";
      permission_id: string;
      request_id: string;
      task_id: string;
      tool_call_id: string;
      operation: string;
      effect: string;
      egress: string;
      source: string;
      risk: RuntimeCapabilityRisk;
      expires_at: number;
      status: string;
    }
  | {
      type: "run_waiting";
      request_id: string;
      task_id: string;
      reason: string;
      permission_id: string;
      expires_at: number;
    }
  | { type: "skill_activated"; task_id?: string; skill: RuntimeSkillEvent }
  | { type: "skill_cleared"; task_id?: string }
  | {
      type: "verification_started";
      request_id: string;
      task_id: string;
      tool: string;
      path: string;
    }
  | {
      type: "verification_completed";
      request_id: string;
      task_id: string;
      tool: string;
      path: string;
      status: string;
      format?: string;
    }
  | { type: "completed"; request_id: string; task_id?: string }
  | { type: "cancelled"; request_id: string; task_id?: string }
  | {
      type: "failed";
      request_id: string;
      task_id?: string;
      message: string;
      retryable: boolean;
      code?: string;
    }
  | { type: "session_warning"; request_id?: string; message: string }
  | { type: "history_restored"; messages: RuntimeHistoryMessage[] }
  | { type: "runtime_unavailable"; message: string };
