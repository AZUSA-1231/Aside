import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Pencil, Plus, Trash2 } from "lucide-react";
import { nativeClient, toNativeError } from "./lib/ipc";
import type { RuntimeSessionSummary } from "./lib/contracts";
import "./settings.css";

function newRequestId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function when(timestamp: number) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  return new Date(timestamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function label(session: RuntimeSessionSummary, index: number) {
  return session.name?.trim() || `Conversation ${index + 1}`;
}

export default function SessionPanel({ onClose, taskRunning }: { onClose: () => void; taskRunning: boolean }) {
  const [sessions, setSessions] = useState<RuntimeSessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<Array<{ id: string; message: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<string | null>("Loading conversations");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const mounted = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const busy = operation !== null;

  useEffect(() => {
    mounted.current = true;
    heading.current?.focus();
    void refresh();
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void nativeClient.onRuntimeEvent((event) => {
      if (disposed) return;
      if (event.type === "sessions_listed") {
        setSessions(event.sessions);
        setActiveId(event.active_session_id);
        setWarnings(event.warnings);
        return;
      }
      if (event.type === "session_switched") {
        setActiveId(event.session_id);
        void refresh();
        return;
      }
      if (event.type === "session_renamed" || event.type === "session_deleted") {
        void refresh();
        return;
      }
      if (event.type === "session_failed") {
        setError(event.message);
        setOperation(null);
        return;
      }
      if (event.type === "runtime_unavailable") {
        setError(event.message);
        return;
      }
    }).then((stop) => { if (!disposed) unlisten = stop; else stop(); });
    return () => { disposed = true; mounted.current = false; unlisten?.(); };
    // refresh is stable for the lifetime of the panel; rerunning this effect on
    // every render would re-subscribe and re-list on each keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function perform(label: string, action: () => Promise<void>) {
    if (!mounted.current) return;
    setOperation(label);
    setError(null);
    try {
      await action();
    } catch (failure) {
      if (mounted.current) setError(toNativeError(failure, "conversation_session").message);
    } finally {
      if (mounted.current) setOperation(null);
    }
  }

  async function refresh() {
    try {
      await nativeClient.runtimeListSessions(newRequestId("sessions"));
    } catch (failure) {
      if (mounted.current) {
        setError(toNativeError(failure, "conversation_session").message);
        setOperation(null);
      }
      return;
    }
    if (mounted.current) setOperation(null);
  }

  return <section className="settings-panel" aria-label="Conversations" aria-busy={busy}>
    <div className="settings-title">
      <button type="button" className="icon-button" aria-label="Back to conversation" onClick={onClose}><ArrowLeft size={16} /></button>
      <h1 ref={heading} tabIndex={-1}>Conversations</h1>
    </div>
    {error && <p className="settings-error" role="alert">{error}</p>}
    {warnings.map((warning) => <p className="settings-note" key={warning.id} role="status">{warning.message}</p>)}

    <section className="settings-card" aria-label="New conversation">
      <h2>Start a new conversation</h2>
      <p className="settings-note">The current conversation is kept and stays in this list. Nothing is deleted, and your files are never touched.</p>
      <div className="settings-actions">
        <button type="button" disabled={busy || taskRunning} onClick={() => void perform("Opening a new conversation", async () => {
          await nativeClient.runtimeSwitchSession(newRequestId("switch"), { create: true });
        })}><Plus size={14} /> New conversation</button>
      </div>
      {taskRunning && <p className="settings-note">Wait for the current task to finish before switching conversations.</p>}
    </section>

    <section className="settings-card" aria-label="Conversation history">
      <h2>History</h2>
      {sessions.length === 0 && !busy && <p className="settings-note">No saved conversations yet.</p>}
      <ul className="session-list">
        {sessions.map((session, index) => {
          const current = session.id === activeId;
          const renaming = renamingId === session.id;
          const confirming = confirmDeleteId === session.id;
          return <li key={session.id} className={`session-row ${current ? "session-row-current" : ""}`}>
            {renaming
              ? <form className="session-rename" onSubmit={(event) => {
                  event.preventDefault();
                  void perform("Renaming conversation", async () => {
                    await nativeClient.runtimeRenameSession(newRequestId("rename"), session.id, draftName.trim() || null);
                    setRenamingId(null);
                  });
                }}>
                  <input aria-label="Conversation name" value={draftName} maxLength={120} autoFocus disabled={busy}
                    onChange={(event) => setDraftName(event.currentTarget.value)} />
                  <button type="submit" disabled={busy} aria-label="Save name"><Check size={14} /></button>
                  <button type="button" disabled={busy} aria-label="Cancel rename" onClick={() => setRenamingId(null)}>Cancel</button>
                </form>
              : <div className="session-line">
                  <div className="session-text">
                    <span className="session-name">{label(session, index)}{current && <span className="session-current"> · current</span>}</span>
                    <span className="session-when">{when(session.modified_at)}</span>
                  </div>
                  <div className="settings-actions">
                    <button type="button" className="icon-button" aria-label={`Rename ${label(session, index)}`} disabled={busy}
                      onClick={() => { setRenamingId(session.id); setDraftName(session.name ?? ""); setConfirmDeleteId(null); }}><Pencil size={14} /></button>
                    <button type="button" className="icon-button" aria-label={`Delete ${label(session, index)}`} disabled={busy || taskRunning}
                      onClick={() => setConfirmDeleteId(confirming ? null : session.id)}><Trash2 size={14} /></button>
                  </div>
                </div>}
            {confirming && !renaming && <div className="session-confirm">
              <p className="settings-error" role="alert">Delete “{label(session, index)}”? The conversation is removed from this computer. Your files and outputs are not deleted.</p>
              <div className="settings-actions">
                <button type="button" disabled={busy} onClick={() => void perform("Deleting conversation", async () => {
                  await nativeClient.runtimeDeleteSession(newRequestId("delete"), session.id);
                  setConfirmDeleteId(null);
                })}>Delete conversation</button>
                <button type="button" disabled={busy} onClick={() => setConfirmDeleteId(null)}>Keep it</button>
              </div>
            </div>}
            {!renaming && !confirming && !current && <div className="settings-actions">
              <button type="button" disabled={busy || taskRunning} onClick={() => void perform("Opening conversation", async () => {
                await nativeClient.runtimeSwitchSession(newRequestId("switch"), { sessionId: session.id });
              })}>Open</button>
            </div>}
          </li>;
        })}
      </ul>
    </section>

    {busy && <p className="settings-operation" role="status">{operation}</p>}
  </section>;
}
