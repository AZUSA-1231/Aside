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

/**
 * A warning the runtime raised outside a run, or about a run's environment.
 *
 * `server_id` and `tool` are present only when the warning concerns a connected
 * MCP server. There is no field for a command, argument, or environment value:
 * this projection is for display, and those are never displayed.
 */
export interface RuntimeWarning {
  code: string;
  message: string;
  server_id?: string;
  tool?: string;
}

/**
 * A configured MCP server, as the surface may describe it.
 *
 * Configuration facts only. Whether the server is reachable and how many tools
 * it contributed are per-run facts, and are read from the run's own tool list
 * rather than announced here — a server that is configured and reachable is not
 * the same as one that is configured and broken, and the surface must not
 * conflate them.
 */
export interface RuntimeMcpServerConfig {
  id: string;
  display_name: string;
  enabled: boolean;
  trust_acknowledged: boolean;
}

/**
 * A connected tool's provenance, derived from a run's tool descriptors.
 *
 * `boundary` is the runtime's own value, not a label this layer composes. An
 * MCP tool is `external_process`; nothing in the surface may upgrade that.
 */
export interface RuntimeToolProvenance {
  source: "builtin" | "user_mcp";
  originLabel: string;
  isExternal: boolean;
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

/**
 * A bounded warning from a document adapter.
 *
 * `page` is present only when the warning concerns one page of a paginated
 * document — a PDF page with no extractable text, for instance.
 */
export interface RuntimeDocumentWarning {
  code: string;
  message: string;
  page?: number;
}

/**
 * A structured read of a PDF or Word document.
 *
 * `partial` and `truncated` are separate facts and both matter: a PDF whose
 * extraction stopped at a block limit is partial even when nothing was
 * truncated for length. Neither may be rendered as a complete read.
 */
export interface RuntimeDocumentReadStatus {
  format: string;
  blockCount: number;
  pageCount?: number;
  pagesRead?: number;
  nextPage?: number;
  partial: boolean;
  truncated: boolean;
  warnings: RuntimeDocumentWarning[];
  /** A one-line description of the extent actually read. */
  scope: string;
}

/**
 * A generated or transformed document.
 *
 * `verification` is the runtime's reopen check. Absent means the document was
 * not reopened, which is not the same as a check that passed.
 */
export interface RuntimeDocumentWriteStatus {
  operation: "create" | "transform";
  outputPath: string;
  bytes?: number;
  structure: Record<string, number>;
  sourcePath?: string;
  /**
   * Fidelity warning codes from the **source** document, not messages.
   *
   * The write tools report codes only — the reader already produced the
   * messages during its own pass, and re-sending them would duplicate bounded
   * output for no gain. The surface therefore shows codes here, and the user
   * sees the full text when the source was read.
   */
  sourceWarnings: string[];
  verification?: string;
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
  | { type: "runtime_unavailable"; message: string }
  /**
   * A runtime warning raised outside a run. MCP configuration and adaptation
   * problems arrive here, which is why it carries optional server identity.
   */
  | ({ type: "runtime_warning" } & RuntimeWarning)
  /**
   * The MCP servers configured for this session, emitted once at startup.
   *
   * Configuration only. A server being listed here says nothing about whether
   * it started; the run's own tool list is the evidence for that, and the
   * surface must not present one as the other.
   */
  | { type: "mcp_servers"; servers: RuntimeMcpServerConfig[] };
