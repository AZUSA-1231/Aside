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
  CircleAlert,
  Command,
  LoaderCircle,
  PanelRightClose,
  Paperclip,
  Pin,
  RotateCcw,
  ScanSearch,
  Send,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import type {
  AgentState,
  AsideHostAttachment,
  HostCaptureResult,
  NativeError,
  RuntimeEvent,
  RuntimeHistoryMessage,
} from "./lib/contracts";
import { canAppendHostAttachment, createHostTurnContext } from "./lib/context";
import { isDesktopRuntime, nativeClient, toNativeError } from "./lib/ipc";
import "./App.css";

type ChatMessageStatus = "complete" | "streaming" | "cancelled" | "error";

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

function toChatMessage(message: RuntimeHistoryMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    status: "complete",
  };
}

function App() {
  const [agentState, setAgentState] = useState<AgentState>(initialAgentState);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<AsideHostAttachment[]>([]);
  const [nativeError, setNativeError] = useState<NativeError | null>(null);
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const activeRunRef = useRef<ActiveRun | null>(null);
  const attachmentsRef = useRef<AsideHostAttachment[]>([]);
  const historyHydratedRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const setCurrentRun = useCallback((run: ActiveRun | null) => {
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
      } catch (error) {
        const normalized = toNativeError(error, "conversation", true);
        failRun(run, normalized.message);
        setNativeError(normalized);
      }
    },
    [failRun, messages, setCurrentRun, updateAssistant],
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

        const current = activeRunRef.current;
        if (!current || event.request_id !== current.requestId) return;

        switch (event.type) {
          case "run_started":
            setRuntimeReady(true);
            break;
          case "text_delta":
            updateAssistant(current.assistantId, (assistant) => ({
              ...assistant,
              text: assistant.text + event.delta,
              status: "streaming",
            }));
            break;
          case "completed":
            updateAssistant(current.assistantId, (assistant) => ({
              ...assistant,
              status: "complete",
            }));
            setCurrentRun(null);
            break;
          case "cancelled":
            updateAssistant(current.assistantId, (assistant) => ({
              ...assistant,
              status: "cancelled",
            }));
            setCurrentRun(null);
            break;
          case "failed":
            failRun(current, event.message);
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
      .onHostCapture((result: HostCaptureResult) => {
        if (!result.attachment) {
          if (result.error) {
            setNativeError({
              operation: "host_capture",
              recoverable: result.error.recoverable,
              message: result.error.message,
            });
          }
          return;
        }

        const current = attachmentsRef.current;
        if (!canAppendHostAttachment(current, result.attachment)) {
          setNativeError({
            operation: "host_capture",
            recoverable: true,
            message: "That context would exceed the prompt limit. Remove an attachment first.",
          });
          return;
        }
        const next = [...current, result.attachment];
        attachmentsRef.current = next;
        setAttachments(next);
        setNativeError(null);
      })
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
  }, [failRun, hydrateHistory, setCurrentRun, updateAssistant]);

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
      void execute("hide_agent", nativeClient.hideAgent);
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [agentState.visibility, execute]);

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

  const handleCapture = useCallback(async () => {
    try {
      const result = await nativeClient.captureActiveHostContext();
      if (!result.attachment) {
        setNativeError({
          operation: "host_capture",
          recoverable: result.error?.recoverable ?? true,
          message:
            result.error?.message ??
            "The current application does not provide supported context.",
        });
        return;
      }

      const current = attachmentsRef.current;
      if (!canAppendHostAttachment(current, result.attachment)) {
        setNativeError({
          operation: "host_capture",
          recoverable: true,
          message: "That context would exceed the prompt limit. Remove an attachment first.",
        });
        return;
      }
      const next = [...current, result.attachment];
      attachmentsRef.current = next;
      setAttachments(next);
      setNativeError(null);
    } catch (error) {
      setNativeError(toNativeError(error, "host_capture", true));
    }
  }, []);

  const removeAttachment = useCallback((attachmentId: string) => {
    const next = attachmentsRef.current.filter(
      (attachment) => attachment.id !== attachmentId,
    );
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);

  const modeLabel = agentState.surface === "workspace" ? "Workspace" : "Side";
  const shortcutLabel = isDesktopRuntime() ? "Ctrl + Alt + A" : "Desktop app shortcut";

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
          className="icon-button capture-button"
          type="button"
          aria-label="Capture current host context"
          title="Capture current host context"
          onClick={() => void handleCapture()}
        >
          <ScanSearch size={15} />
        </button>
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
            {attachments.map((attachment) => (
              <article className="attachment-item" key={attachment.id}>
                <div className="attachment-copy">
                  <strong>{attachment.source}</strong>
                  <span>{attachment.summary}</span>
                  <small>{attachmentExpiry(attachment.expiresAt)}</small>
                </div>
                <button
                  className="attachment-remove"
                  type="button"
                  aria-label={`Remove ${attachment.source}`}
                  title={`Remove ${attachment.source}`}
                  onClick={() => removeAttachment(attachment.id)}
                >
                  <X size={13} />
                </button>
              </article>
            ))}
          </div>
        </section>
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
