import {
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Bot,
  Check,
  CheckCheck,
  CircleAlert,
  Command,
  FileJson,
  FolderOpen,
  LoaderCircle,
  PanelRightClose,
  Paperclip,
  Pin,
  RotateCcw,
  ScanSearch,
  Send,
  Shield,
  ShieldCheck,
  Sparkles,
  Square,
  Wrench,
  X,
} from "lucide-react";
import type {
  AgentState,
  AsideHostAttachment,
  AsidePathDescriptor,
  HostView,
  HostCaptureResult,
  NativeError,
  RuntimeEvent,
  RuntimeHistoryMessage,
  RuntimePermissionRequest,
  RuntimeSkillEvent,
  RuntimeVerificationState,
  RuntimeWorkspaceState,
} from "./lib/contracts";
import {
  canAppendHostAttachment,
  createHostTurnContext,
  normalizeHostAttachment,
} from "./lib/context";
import { isDesktopRuntime, nativeClient, toNativeError } from "./lib/ipc";
import "./App.css";

type ChatMessageStatus = "complete" | "streaming" | "cancelled" | "error";
type CaptureStatus = "idle" | "capturing" | "captured" | "unavailable" | "failed";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: ChatMessageStatus;
  prompt?: string;
  error?: string;
}

interface ActiveRun {
  requestId: string;
  userId: string;
  assistantId: string;
  prompt: string;
  isRetry: boolean;
  cancelRequested: boolean;
}

interface ToolActivity {
  tool: string;
  status: string;
  text: string;
  truncated: boolean;
}

const initialMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    text: "I am ready when you are. Ask a short question or drop in a thought.",
    status: "complete",
  },
];

const initialAgentState: AgentState = {
  visibility: isDesktopRuntime() ? "hidden" : "visible",
  surface: "side",
  pinned: false,
};

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function runtimeError(message: string): NativeError {
  return { operation: "conversation", recoverable: true, message };
}

function attachmentExpiry(expiresAt: number): string {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return "Expired";
  if (remaining < 60_000) return "Expires soon";
  return `Expires ${new Date(expiresAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function hostKindLabel(host: HostView["kind"]): string {
  switch (host) {
    case "pdf_reader":
      return "PDF reader";
    case "vscode":
      return "VS Code";
    case "generic":
      return "Generic UIA";
    case "unsupported":
      return "Unsupported host";
    default:
      return host.charAt(0).toUpperCase() + host.slice(1);
  }
}

function captureStatusLabel(status: CaptureStatus): string {
  switch (status) {
    case "capturing":
      return "Capturing";
    case "captured":
      return "Captured";
    case "failed":
      return "Capture failed";
    case "unavailable":
      return "Unavailable";
    default:
      return "Capture ready"
  }
}

function pathRoleLabel(descriptor: AsidePathDescriptor): string {
  switch (descriptor.role) {
    case "workspace_root":
      return "Workspace"
    case "active_file":
      return "Active file"
    case "selected_item":
      return "Selected"
    case "document":
      return "Document"
    default:
      return "Directory"
  }
}

function toChatMessage(message: RuntimeHistoryMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    status: "complete",
  };
}

function workspaceSourceLabel(source: string): string {
  switch (source) {
    case "explicit":
      return "Selected";
    case "descriptor":
      return "Captured";
    case "previous":
      return "Previous";
    case "attachment":
      return "Attachment";
    default:
      return source.charAt(0).toUpperCase() + source.slice(1);
  }
}

function toolStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "Running";
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "denied":
      return "Denied";
    case "cancelled":
      return "Cancelled";
    case "expired":
      return "Expired";
    case "unsupported":
      return "Unsupported";
    case "verified":
      return "Verified";
    case "in_progress":
      return "In progress";
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

function shortToolName(tool: string): string {
  const dot = tool.lastIndexOf(".");
  return dot >= 0 ? tool.slice(dot + 1) : tool;
}

function App() {
  const [agentState, setAgentState] = useState<AgentState>(initialAgentState);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<AsideHostAttachment[]>([]);
  const [capturePaths, setCapturePaths] = useState<Record<string, string>>({});
  const [captureJson, setCaptureJson] = useState<Record<string, string>>({});
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>("idle");
  const [captureHost, setCaptureHost] = useState<HostView | null>(null);
  const [previewAttachment, setPreviewAttachment] =
    useState<AsideHostAttachment | null>(null);
  const [nativeError, setNativeError] = useState<NativeError | null>(null);
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [runtimeWorkspace, setRuntimeWorkspace] = useState<RuntimeWorkspaceState | null>(null);
  const [activeSkill, setActiveSkill] = useState<RuntimeSkillEvent | null>(null);
  const [pendingPermission, setPendingPermission] =
    useState<RuntimePermissionRequest | null>(null);
  const pendingPermissionRef = useRef<RuntimePermissionRequest | null>(null);
  const updatePendingPermission = useCallback(
    (value: RuntimePermissionRequest | null) => {
      pendingPermissionRef.current = value;
      setPendingPermission(value);
    },
    [],
  );
  const [toolActivity, setToolActivity] = useState<ToolActivity | null>(null);
  const [verification, setVerification] = useState<RuntimeVerificationState | null>(null);
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const activeRunRef = useRef<ActiveRun | null>(null);
  // Late one-shot capture results must not leak into a later prompt.
  const captureDiscardBeforeRef = useRef(-1);
  const attachmentsRef = useRef<AsideHostAttachment[]>([]);
  const historyHydratedRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const setCurrentRun = useCallback((run: ActiveRun | null) => {
    if (run === null && activeRunRef.current !== null) {
      captureDiscardBeforeRef.current = Date.now();
    }
    activeRunRef.current = run;
    setActiveRun(run);
  }, []);

  const updateAssistant = useCallback(
    (assistantId: string, update: (message: ChatMessage) => ChatMessage) => {
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId ? update(message) : message,
        ),
      );
    },
    [],
  );

  const failRun = useCallback(
    (run: ActiveRun, message: string) => {
      updateAssistant(run.assistantId, (assistant) => ({
        ...assistant,
        status: "error",
        error: message,
      }));
      setCurrentRun(null);
    },
    [setCurrentRun, updateAssistant],
  );

  const hydrateHistory = useCallback((history: RuntimeHistoryMessage[]) => {
    const restored = history.map(toChatMessage);
    const currentRun = activeRunRef.current;
    if (!currentRun) {
      setMessages(restored.length > 0 ? restored : initialMessages);
      return;
    }

    setMessages((current) => {
      const assistant = current.find(
        (message) => message.id === currentRun.assistantId,
      );
      const currentUser = current.find(
        (message) => message.id === currentRun.userId,
      );
      const restoredHasUser = restored.some(
        (message) =>
          message.role === "user" && message.text === currentRun.prompt,
      );
      const pendingUser =
        currentUser ?? {
          id: currentRun.userId,
          role: "user" as const,
          text: currentRun.prompt,
          status: "complete" as const,
        };
      const pendingAssistant: ChatMessage = {
        id: currentRun.assistantId,
        role: "assistant",
        text: assistant?.text ?? "",
        status: "streaming",
        prompt: currentRun.prompt,
      };
      return [
        ...restored,
        ...(currentRun.isRetry && restoredHasUser
          ? []
          : [pendingUser]),
        assistant ? { ...pendingAssistant, ...assistant } : pendingAssistant,
      ];
    });
  }, []);

  const startRun = useCallback(
    async (prompt: string, assistantId?: string): Promise<void> => {
      const trimmed = prompt.trim();
      if (!trimmed || activeRunRef.current) return;
      const promptAttachments = attachmentsRef.current;

      const retryAssistantIndex = assistantId
        ? messages.findIndex((message) => message.id === assistantId)
        : -1;
      const retryUserId =
        retryAssistantIndex >= 0
          ? [...messages]
              .slice(0, retryAssistantIndex)
              .reverse()
              .find(
                (message) =>
                  message.role === "user" && message.text === trimmed,
              )?.id
          : undefined;
      const userId = retryUserId ?? makeId("user");
      const responseId = assistantId ?? makeId("assistant");
      if (assistantId) {
        updateAssistant(responseId, (assistant) => ({
          ...assistant,
          text: "",
          status: "streaming",
          prompt: trimmed,
          error: undefined,
        }));
      } else {
        setMessages((current) => [
          ...current,
          { id: userId, role: "user", text: trimmed, status: "complete" },
          {
            id: responseId,
            role: "assistant",
            text: "",
            status: "streaming",
            prompt: trimmed,
          },
        ]);
      }

      const run: ActiveRun = {
        requestId: makeId("request"),
        userId,
        assistantId: responseId,
        prompt: trimmed,
        isRetry: Boolean(assistantId),
        cancelRequested: false,
      };
      setCurrentRun(run);
      setNativeError(null);
      try {
        await nativeClient.runtimePrompt(
          run.requestId,
          trimmed,
          createHostTurnContext(promptAttachments),
        );
        attachmentsRef.current = [];
        setAttachments([]);
        setCapturePaths({});
        setCaptureJson({});
        setCaptureStatus("idle");
        setCaptureHost(null);
        setPreviewAttachment(null);
      } catch (error) {
        const normalized = toNativeError(error, "conversation", true);
        failRun(run, normalized.message);
        setNativeError(normalized);
      }
    },
    [failRun, messages, setCurrentRun, updateAssistant],
  );

  const appendCaptureResult = useCallback(
    (result: HostCaptureResult, fallbackMessage?: string): void => {
      const attachment = result.attachment
        ? normalizeHostAttachment(result.attachment)
        : undefined;
      if (result.host) setCaptureHost(result.host);
      if (
        !attachment ||
        attachment.capturedAt <= captureDiscardBeforeRef.current ||
        activeRunRef.current !== null
      ) {
        if (!attachment && result.error) {
          setCaptureStatus("failed");
          setNativeError({
            operation: "host_capture",
            recoverable: result.error.recoverable,
            message: result.error.message,
          });
        } else if (
          !attachment &&
          fallbackMessage &&
          activeRunRef.current === null
        ) {
          setCaptureStatus("unavailable");
          setNativeError({
            operation: "host_capture",
            recoverable: true,
            message: fallbackMessage,
          });
        }
        return;
      }

      const current = attachmentsRef.current;
      if (!canAppendHostAttachment(current, attachment)) {
        setNativeError({
          operation: "host_capture",
          recoverable: true,
          message: "That context would exceed the prompt limit. Remove an attachment first.",
        });
        return;
      }

      const next = [...current, attachment];
      setCaptureStatus("captured");
      attachmentsRef.current = next;
      setAttachments(next);
      if (result.filePath) {
        setCapturePaths((paths) => ({
          ...paths,
          [attachment.id]: result.filePath!,
        }));
      } else {
        setNativeError({
          operation: "host_capture_save",
          recoverable: true,
          message: "Context was captured, but its JSON file could not be saved.",
        });
      }
      if (result.formattedJson) {
        setCaptureJson((json) => ({
          ...json,
          [attachment.id]: result.formattedJson!,
        }));
      }
      if (result.filePath) setNativeError(null);
    },
    [],
  );

  useEffect(() => {
    let stateUnlisten: (() => void) | undefined;
    let errorUnlisten: (() => void) | undefined;
    let runtimeUnlisten: (() => void) | undefined;
    let hostCaptureUnlisten: (() => void) | undefined;
    let disposed = false;

    void nativeClient.getAgentState().then((state) => {
      if (!disposed) setAgentState(state);
    });
    void nativeClient
      .onAgentState((state) => {
        setAgentState(state);
        if (state.visibility === "visible") {
          window.setTimeout(() => inputRef.current?.focus(), 45);
        }
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stateUnlisten = unlisten;
      });
    void nativeClient
      .onNativeError((error) => {
        setNativeError(error);
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else errorUnlisten = unlisten;
      });
    void nativeClient
      .onRuntimeEvent((event: RuntimeEvent) => {
        if (event.type === "history_restored") {
          if (historyHydratedRef.current) return;
          historyHydratedRef.current = true;
          hydrateHistory(event.messages);
          return;
        }
        if (event.type === "ready") {
          setRuntimeReady(true);
          return;
        }
        if (event.type === "session_warning") {
          setNativeError(runtimeError(event.message));
          return;
        }
        if (event.type === "runtime_unavailable") {
          historyHydratedRef.current = false;
          setRuntimeReady(false);
          const current = activeRunRef.current;
          if (current) failRun(current, event.message);
          setNativeError(runtimeError(event.message));
          return;
        }
        if (event.type === "workspace_resolved") {
          setRuntimeWorkspace(event.workspace);
          return;
        }
        if (event.type === "workspace_unresolved") {
          setRuntimeWorkspace(null);
          if (event.message) setNativeError(runtimeError(event.message));
          return;
        }
        if (event.type === "workspace_cleared") {
          setRuntimeWorkspace(null);
          return;
        }
        if (event.type === "skill_activated") {
          setActiveSkill(event.skill);
          return;
        }
        if (event.type === "skill_cleared") {
          setActiveSkill(null);
          return;
        }

        const current = activeRunRef.current;
        if (!current || event.request_id !== current.requestId) return;

        switch (event.type) {
          case "run_started":
            setRuntimeReady(true);
            if (event.workspace) setRuntimeWorkspace(event.workspace);
            if (event.active_skill) setActiveSkill(event.active_skill);
            updatePendingPermission(null);
            setToolActivity(null);
            setVerification(null);
            break;
          case "text_delta":
            updateAssistant(current.assistantId, (assistant) => ({
              ...assistant,
              text: assistant.text + event.delta,
              status: "streaming",
            }));
            break;
          case "tool_call_started":
            setToolActivity({
              tool: event.tool,
              status: "running",
              text: "",
              truncated: false,
            });
            break;
          case "tool_call_update":
            setToolActivity((activity) =>
              activity && activity.tool === event.tool
                ? { ...activity, text: activity.text + event.text, truncated: activity.truncated || event.truncated }
                : activity,
            );
            break;
          case "tool_result":
            setToolActivity({
              tool: event.tool,
              status: event.status,
              text: event.text.slice(0, 320),
              truncated: event.truncated,
            });
            if (
              pendingPermissionRef.current &&
              pendingPermissionRef.current.tool_call_id === event.tool_call_id
            ) {
              updatePendingPermission(null);
            }
            break;
          case "permission_requested":
            updatePendingPermission(event);
            break;
          case "verification_started":
            setVerification({ tool: event.tool, path: event.path, status: "in_progress" });
            break;
          case "verification_completed":
            setVerification({ tool: event.tool, path: event.path, status: event.status, format: event.format });
            break;
          case "completed":
            updateAssistant(current.assistantId, (assistant) => ({
              ...assistant,
              status: "complete",
            }));
            setCurrentRun(null);
            updatePendingPermission(null);
            setVerification(null);
            break;
          case "cancelled":
            updateAssistant(current.assistantId, (assistant) => ({
              ...assistant,
              status: "cancelled",
            }));
            setCurrentRun(null);
            updatePendingPermission(null);
            setVerification(null);
            break;
          case "failed":
            failRun(current, event.message);
            updatePendingPermission(null);
            setVerification(null);
            break;
          default:
            break;
        }
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else runtimeUnlisten = unlisten;
      });
    void nativeClient
      .onHostCapture(appendCaptureResult)
      .then((unlisten) => {
        if (disposed) unlisten();
        else hostCaptureUnlisten = unlisten;
      });

    return () => {
      disposed = true;
      stateUnlisten?.();
      errorUnlisten?.();
      runtimeUnlisten?.();
      hostCaptureUnlisten?.();
    };
  }, [
    appendCaptureResult,
    failRun,
    hydrateHistory,
    setCurrentRun,
    updateAssistant,
    updatePendingPermission,
  ]);

  useEffect(() => {
    if (agentState.visibility === "visible") {
      window.setTimeout(() => inputRef.current?.focus(), 45);
    }
  }, [agentState.visibility]);

  const execute = useCallback(
    async (operation: string, action: () => Promise<AgentState>): Promise<void> => {
      try {
        const next = await action();
        setAgentState(next);
        setNativeError(null);
      } catch (error) {
        setNativeError(toNativeError(error, operation, true));
      }
    },
    [],
  );

  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || agentState.visibility !== "visible") return;
      event.preventDefault();
      if (previewAttachment) {
        setPreviewAttachment(null);
        return;
      }
      void execute("hide_agent", nativeClient.hideAgent);
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [agentState.visibility, execute, previewAttachment]);

  const handleSubmit = useCallback(() => {
    void startRun(draft).then(() => setDraft(""));
  }, [draft, startRun]);

  const handleInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleCancel = useCallback(() => {
    const run = activeRunRef.current;
    if (!run) return;
    setCurrentRun({ ...run, cancelRequested: true });
    void nativeClient.runtimeCancel(run.requestId).catch((error) => {
      setNativeError(toNativeError(error, "conversation_cancel", true));
    });
  }, [setCurrentRun]);

  const decidePermission = useCallback(
    async (decision: "allow" | "deny" | "cancel") => {
      const permission = pendingPermission;
      if (!permission) return;
      updatePendingPermission(null);
      try {
        await nativeClient.runtimePermissionResponse(
          permission.permission_id,
          decision,
          {
            request_id: permission.request_id,
            task_id: permission.task_id,
            tool_call_id: permission.tool_call_id,
          },
        );
      } catch (error) {
        setNativeError(toNativeError(error, "conversation", true));
      }
    },
    [pendingPermission, updatePendingPermission],
  );

  const handleSetWorkspace = useCallback(() => {
    const path = workspaceDraft.trim();
    if (!path) return;
    void nativeClient
      .runtimeSetWorkspace(path)
      .then(() => setWorkspaceDraft(""))
      .catch((error) => {
        setNativeError(toNativeError(error, "workspace", true));
      });
  }, [workspaceDraft]);

  const handleClearWorkspace = useCallback(() => {
    void nativeClient.runtimeClearWorkspace().catch((error) => {
      setNativeError(toNativeError(error, "workspace", true));
    });
  }, []);

  const handleCapture = useCallback(async () => {
    if (activeRunRef.current) return;
    setCaptureStatus("capturing");
    try {
      const result = await nativeClient.captureActiveHostContext();
      appendCaptureResult(
        result,
        "The current application does not provide supported context.",
      );
    } catch (error) {
      setCaptureStatus("failed");
      setNativeError(toNativeError(error, "host_capture", true));
    }
  }, [appendCaptureResult]);

  const removeAttachment = useCallback((attachmentId: string) => {
    const next = attachmentsRef.current.filter(
      (attachment) => attachment.id !== attachmentId,
    );
    attachmentsRef.current = next;
    setAttachments(next);
    setCapturePaths((paths) => {
      const nextPaths = { ...paths };
      delete nextPaths[attachmentId];
      return nextPaths;
    });
    setCaptureJson((json) => {
      const nextJson = { ...json };
      delete nextJson[attachmentId];
      return nextJson;
    });
    setPreviewAttachment((current) =>
      current?.id === attachmentId ? null : current,
    );
  }, []);

  const revealCapturePath = useCallback(async (path: string) => {
    try {
      await nativeClient.revealPath(path);
      setNativeError(null);
    } catch (error) {
      setNativeError(toNativeError(error, "reveal_capture_file", true));
    }
  }, []);

  const modeLabel = agentState.surface === "workspace" ? "Workspace" : "Side";
  const shortcutLabel = isDesktopRuntime() ? "Ctrl + Alt + A" : "Desktop app shortcut";
  const captureStrategy = captureHost?.strategy;

  return (
    <main className={`app-shell ${agentState.surface}-surface`}>
      <header
        className="app-header"
        data-tauri-drag-region
        onPointerDown={(event) => {
          if (event.button === 0) void nativeClient.startDragging();
        }}
      >
        <div className="brand-lockup" data-tauri-drag-region>
          <div className="brand-mark" aria-hidden="true">
            <Sparkles size={15} strokeWidth={2.4} />
          </div>
          <div>
            <div className="brand-name">Aside</div>
            <div className="brand-context">Quietly nearby</div>
          </div>
        </div>

        <div className="header-actions">
          <span className={`mode-pill ${agentState.surface}`}>
            <span className="mode-dot" aria-hidden="true" />
            {modeLabel}
          </span>
          <button
            className={`icon-button ${agentState.pinned ? "active" : ""}`}
            type="button"
            aria-label={agentState.pinned ? "Unpin Aside" : "Pin Aside"}
            aria-pressed={agentState.pinned}
            title={agentState.pinned ? "Unpin Aside" : "Pin Aside"}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => void execute("pin", () => nativeClient.setPinned(!agentState.pinned))}
          >
            <Pin size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Hide Aside"
            title="Hide Aside"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => void execute("hide_agent", nativeClient.hideAgent)}
          >
            <X size={17} />
          </button>
        </div>
      </header>

      <section className="status-strip" aria-live="polite">
        <div className={`status-indicator ${runtimeReady ? "ready" : "idle"}`}>
          <span className="status-dot" aria-hidden="true" />
          {runtimeReady ? "Ready" : "Local session"}
        </div>
        <span className="status-divider" aria-hidden="true" />
        <span className="shortcut-hint">
          <Command size={12} />
          {shortcutLabel}
        </span>
        <button
          className="capture-button"
          type="button"
          aria-label="Capture current host context"
          title="Capture current host context"
          disabled={Boolean(activeRun) || captureStatus === "capturing"}
          aria-busy={captureStatus === "capturing"}
          onClick={() => void handleCapture()}
        >
          <ScanSearch size={15} />
          <span>Capture</span>
        </button>
        <span className={`capture-status ${captureStatus}`} aria-live="polite">
          <span className="capture-status-dot" aria-hidden="true" />
          {captureStatusLabel(captureStatus)}
          {captureHost && ` | ${hostKindLabel(captureHost.kind)}`}
          {captureStrategy && ` | ${captureStrategy}`}
        </span>
        {agentState.surface === "workspace" && (
          <button
            className="workspace-exit"
            type="button"
            onClick={() => void execute("exit_workspace", nativeClient.exitWorkspace)}
          >
            <PanelRightClose size={13} />
            Leave workspace
          </button>
        )}
      </section>

      <section className="runtime-surface" aria-label="Runtime state">
        {runtimeWorkspace ? (
          <div className="runtime-chip workspace-chip">
            <FolderOpen size={12} />
            <div className="runtime-chip-copy">
              <strong title={runtimeWorkspace.canonical_path}>
                {runtimeWorkspace.canonical_path}
              </strong>
              <span>Workspace · {workspaceSourceLabel(runtimeWorkspace.source)}</span>
            </div>
            <button
              className="runtime-chip-action"
              type="button"
              aria-label="Clear workspace"
              title="Clear workspace"
              onClick={handleClearWorkspace}
            >
              <X size={12} />
            </button>
          </div>
        ) : (
          <div className="workspace-set">
            <input
              value={workspaceDraft}
              onChange={(event) => setWorkspaceDraft(event.currentTarget.value)}
              placeholder="Workspace folder path"
              aria-label="Workspace folder path"
            />
            <button
              type="button"
              className="workspace-set-button"
              disabled={!workspaceDraft.trim() || Boolean(activeRun)}
              onClick={handleSetWorkspace}
            >
              Set
            </button>
          </div>
        )}

        {activeSkill && (
          <div className="runtime-chip skill-chip">
            <Sparkles size={12} />
            <div className="runtime-chip-copy">
              <strong>{activeSkill.name}</strong>
              <span>Skill · {activeSkill.source}</span>
            </div>
          </div>
        )}

        {verification && (
          <div className={`runtime-chip verification-chip ${verification.status}`}>
            <CheckCheck size={12} />
            <div className="runtime-chip-copy">
              <strong>
                {shortToolName(verification.tool)} · {toolStatusLabel(verification.status)}
              </strong>
              <span title={verification.path}>{verification.path}</span>
            </div>
          </div>
        )}
      </section>

      {toolActivity && (
        <div className={`tool-activity ${toolActivity.status}`} aria-live="polite">
          <Wrench size={12} />
          <span>
            {shortToolName(toolActivity.tool)} · {toolStatusLabel(toolActivity.status)}
          </span>
          {toolActivity.text && toolActivity.status !== "running" && (
            <span className="tool-activity-text" title={toolActivity.text}>
              {toolActivity.text}
            </span>
          )}
        </div>
      )}

      {pendingPermission && (
        <section
          className="permission-card"
          role="dialog"
          aria-modal="false"
          aria-label={`Permission for ${pendingPermission.operation}`}
        >
          <div className="permission-card-header">
            <Shield size={14} />
            <strong>{pendingPermission.operation}</strong>
            <span className="permission-effect">{pendingPermission.effect}</span>
          </div>
          <div className="permission-card-copy">
            <span>Aside is asking to perform this workspace write.</span>
            <span className="permission-note">
              The write starts only after an explicit decision.
            </span>
          </div>
          <div className="permission-actions">
            <button
              type="button"
              className="permission-allow"
              onClick={() => void decidePermission("allow")}
            >
              <ShieldCheck size={14} />
              Allow
            </button>
            <button
              type="button"
              className="permission-deny"
              onClick={() => void decidePermission("deny")}
            >
              Deny
            </button>
          </div>
        </section>
      )}

      <section className="conversation" aria-label="Conversation">
        <div className="conversation-intro">
          <div className="intro-icon" aria-hidden="true">
            <Bot size={19} />
          </div>
          <div>
            <p className="eyebrow">AGENT PANEL</p>
            <h1>What is on your mind?</h1>
          </div>
        </div>

        <div className="message-list" aria-live="polite">
          {messages.map((message) => (
            <article className={`message-row ${message.role}`} key={message.id}>
              {message.role === "assistant" && (
                <div className="message-avatar" aria-hidden="true">
                  <Sparkles size={13} />
                </div>
              )}
              <div className={`message-bubble ${message.status}`}>
                {message.text && <p>{message.text}</p>}
                {message.status === "streaming" && (
                  <span className="typing-caret" aria-label="Responding" />
                )}
                {message.status === "cancelled" && (
                  <span className="message-note">Stopped</span>
                )}
                {message.status === "error" && (
                  <div className="message-error">
                    <div className="message-error-label">
                      <CircleAlert size={13} />
                      {message.error ?? "The response could not be completed."}
                    </div>
                    <button
                      className="retry-button"
                      type="button"
                      onClick={() =>
                        void startRun(
                          message.prompt ?? "",
                          message.id,
                        )
                      }
                    >
                      <RotateCcw size={13} />
                      Retry
                    </button>
                  </div>
                )}
              </div>
            </article>
          ))}
          {activeRun && activeRun.cancelRequested && (
            <div className="cancel-state">
              <LoaderCircle size={13} className="spin" />
              Stopping response...
            </div>
          )}
        </div>
      </section>

      {nativeError && (
        <div className="error-banner" role="alert">
          <CircleAlert size={15} />
          <span>{nativeError.message}</span>
          <button
            type="button"
            className="dismiss-button"
            aria-label="Dismiss error"
            title="Dismiss error"
            onClick={() => setNativeError(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {attachments.length > 0 && (
        <section className="attachment-tray" aria-label="Captured context">
          <div className="attachment-heading">
            <span>
              <Paperclip size={13} />
              {attachments.length} captured source{attachments.length === 1 ? "" : "s"}
            </span>
            <span className="attachment-heading-note">Ready for this prompt</span>
          </div>
          <div className="attachment-list">
            {attachments.map((attachment) => {
              const filePath = capturePaths[attachment.id];
              const formattedJson = captureJson[attachment.id];
              return (
                <article className="attachment-item" key={attachment.id}>
                  <div className="attachment-copy">
                    <strong>{attachment.source}</strong>
                    <span>{attachment.summary}</span>
                    <small className="attachment-strategy">
                      {hostKindLabel(attachment.host)} · {attachment.strategy ?? attachment.host}
                    </small>
                    <small>{attachmentExpiry(attachment.expiresAt)}</small>
                  </div>
                  {filePath && (
                    <button
                      className="attachment-open"
                      type="button"
                      aria-label={`Show JSON location for ${attachment.source}`}
                      title="Show captured JSON in folder"
                      onClick={() => void revealCapturePath(filePath)}
                    >
                      <FolderOpen size={14} />
                    </button>
                  )}
                  <button
                    className="attachment-remove"
                    type="button"
                    aria-label={`Remove ${attachment.source}`}
                    title={`Remove ${attachment.source}`}
                    onClick={() => removeAttachment(attachment.id)}
                  >
                    <X size={13} />
                  </button>
                  {formattedJson && (
                    <button
                      className="attachment-file-row"
                      type="button"
                      title="Preview captured JSON"
                      aria-label={`Preview JSON for ${attachment.source}`}
                      onClick={() => setPreviewAttachment(attachment)}
                    >
                      <FileJson size={12} />
                      <span>{filePath ?? "Preview captured JSON"}</span>
                    </button>
                  )}
                  {(attachment.descriptors ?? []).length > 0 && (
                    <div className="attachment-descriptors" aria-label="Path references">
                      {(attachment.descriptors ?? []).map((descriptor) => (
                        <div className="attachment-descriptor" key={`${descriptor.role}:${descriptor.path}`}>
                          <span className="descriptor-role">{pathRoleLabel(descriptor)}</span>
                          <code title={descriptor.path}>{descriptor.path}</code>
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {previewAttachment && (
        <div
          className="capture-preview-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setPreviewAttachment(null);
          }}
        >
          <section
            className="capture-preview"
            role="dialog"
            aria-modal="true"
            aria-label={`Captured JSON for ${previewAttachment.source}`}
          >
            <div className="capture-preview-header">
              <div>
                <strong>{previewAttachment.source}</strong>
                <span>Captured JSON</span>
              </div>
              <button
                className="dismiss-button"
                type="button"
                aria-label="Close JSON preview"
                title="Close JSON preview"
                onClick={() => setPreviewAttachment(null)}
              >
                <X size={14} />
              </button>
            </div>
            <pre>
              {captureJson[previewAttachment.id] ??
                "The captured JSON preview is unavailable."}
            </pre>
          </section>
        </div>
      )}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          handleSubmit();
        }}
      >
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={handleInputKeyDown}
          placeholder="Ask anything..."
          rows={1}
          aria-label="Message Aside"
          disabled={Boolean(activeRun)}
        />
        {activeRun ? (
          <button
            className="send-button cancel"
            type="button"
            aria-label="Stop response"
            title="Stop response"
            onClick={handleCancel}
          >
            <Square size={15} fill="currentColor" />
          </button>
        ) : (
          <button
            className="send-button"
            type="submit"
            aria-label="Send message"
            title="Send message"
            disabled={!draft.trim()}
          >
            <Send size={16} />
          </button>
        )}
      </form>

      <footer className="app-footer">
        <span>
          <Check size={12} />
          Local-first session
        </span>
        <span className="footer-hint">Esc to close</span>
      </footer>
    </main>
  );
}

export default App;
