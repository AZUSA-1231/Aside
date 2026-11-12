import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { nativeClient, toNativeError } from "./lib/ipc";
import type { McpServerEntry, McpServerView, McpSettingsSnapshot, McpTestResult } from "./lib/mcp";
import "./settings.css";

const emptyServer = (): McpServerEntry => ({
  id: "",
  display_name: "",
  transport: "stdio",
  command: "",
  args: [],
  env: {},
  enabled: false,
  trust_acknowledged: false,
});

/** `env` is edited as `NAME = from_config` rows; the file format has no other form. */
type EnvRow = { name: string; from_config: string };

function envRows(entry: McpServerEntry): EnvRow[] {
  return Object.entries(entry.env ?? {}).map(([name, reference]) => ({ name, from_config: reference.from_config }));
}

function toEnvMap(rows: EnvRow[]): Record<string, { from_config: string }> {
  const map: Record<string, { from_config: string }> = {};
  for (const row of rows) {
    if (row.name.trim().length === 0) continue;
    map[row.name.trim()] = { from_config: row.from_config.trim() };
  }
  return map;
}

function argsText(entry: McpServerEntry) {
  return (entry.args ?? []).join("\n");
}

function toArgs(text: string) {
  return text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

export default function McpSettingsCard({
  onSaved,
  disabled,
}: {
  onSaved: (snapshot: McpSettingsSnapshot) => void;
  disabled: boolean;
}) {
  const [snapshot, setSnapshot] = useState<McpSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<McpServerEntry | null>(null);
  // The id the draft was opened from. `null` means this is a new server. It is
  // what distinguishes "edit in place", "rename" and "add", which the id alone
  // cannot: renaming used to look identical to adding a second server.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [overwriteAcknowledged, setOverwriteAcknowledged] = useState(false);
  const [env, setEnv] = useState<EnvRow[]>([]);
  const [args, setArgs] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const [test, setTest] = useState<{ id: string; result: McpTestResult } | null>(null);
  const busy = operation !== null;

  useEffect(() => {
    let disposed = false;
    void nativeClient.getMcpSettings()
      .then((next) => { if (!disposed) setSnapshot(next); })
      .catch((failure) => { if (!disposed) setError(toNativeError(failure, "settings").message); });
    return () => { disposed = true; };
  }, []);

  function accept(next: McpSettingsSnapshot) {
    setSnapshot(next);
    onSaved(next);
  }

  async function perform(label: string, action: () => Promise<void>) {
    setOperation(label);
    setError(null);
    setNotice(null);
    try { await action(); }
    catch (failure) { setError(toNativeError(failure, "settings").message); }
    finally { setOperation(null); }
  }

  function beginAdd() {
    setDraft(emptyServer());
    setEditingId(null);
    setOverwriteAcknowledged(false);
    setEnv([]);
    setArgs("");
    setExpanded(null);
    setTest(null);
    setNotice(null);
  }

  function beginEdit(view: McpServerView) {
    setDraft({ ...view.raw, env: view.raw.env ?? {}, args: view.raw.args ?? [] });
    setEditingId(view.id);
    setOverwriteAcknowledged(false);
    setEnv(envRows(view.raw));
    setArgs(argsText(view.raw));
    setExpanded(view.id);
    setTest(null);
    setNotice(null);
  }

  function draftEntry(): McpServerEntry {
    const base = draft ?? emptyServer();
    return {
      ...base,
      display_name: (base.display_name ?? "").trim() || base.id.trim(),
      args: toArgs(args),
      env: toEnvMap(env),
      transport: "stdio",
    };
  }

  /**
   * Saves the draft as the new server list, leaving every other entry untouched.
   *
   * Three paths, and the id alone cannot tell them apart: editing a server and
   * changing its id looks exactly like adding a server with that id. Treating
   * both as "append or replace by id" left the old entry — with its enabled
   * and trust flags — in the file under the id it no longer claimed.
   */
  async function saveDraft() {
    if (!snapshot) return;
    const entry = draftEntry();
    const existing = snapshot.servers.map((view) => view.raw);
    const unreadable = (snapshot.unreadable_servers ?? []).map(({ index }) => ({ index }));
    let servers;
    if (editingId !== null) {
      const position = snapshot.servers.findIndex((view) => view.id === editingId);
      if (position < 0) {
        // The entry being edited disappeared from the snapshot underneath us;
        // appending would silently resurrect it under a new id.
        setError("The server being edited is no longer in the list. Reload before saving.");
        return;
      }
      servers = existing.map((server, index) => (index === position ? entry : server));
    } else if (existing.some((server) => server.id === entry.id)) {
      // Overwriting an existing id is never implicit.
      if (!overwriteAcknowledged) {
        setError("This id already exists. Confirm the replacement before saving.");
        return;
      }
      servers = existing.map((server) => (server.id === entry.id ? entry : server));
    } else {
      servers = [...existing, entry];
    }
    const next = await nativeClient.saveMcpSettings(servers, snapshot.revision, unreadable);
    accept(next);
    const renamed = editingId !== null && editingId !== entry.id;
    setDraft(null);
    setEditingId(null);
    setOverwriteAcknowledged(false);
    setExpanded(null);
    setNotice(renamed
      ? `Renamed to “${entry.id}”. The previous entry and its enabled / trusted state were replaced; turn both on again for the new id.`
      : "Server saved. Apply when idle to use it; a running task keeps its current connections.");
  }

  /** The conservative default: a new server is configured but neither enabled nor trusted. */
  async function toggle(view: McpServerView, field: "enabled" | "trust_acknowledged") {
    if (!snapshot) return;
    const servers = snapshot.servers.map((server) => (server.id === view.id
      ? { ...server.raw, [field]: !server.raw[field] }
      : server.raw));
    accept(await nativeClient.saveMcpSettings(servers, snapshot.revision, (snapshot.unreadable_servers ?? []).map(({ index }) => ({ index }))));
    setNotice(field === "enabled"
      ? "Enabled state saved. A server starts only when it is both enabled and trusted."
      : "Trust state saved. Trusting a server means you accept that it runs external code on this computer.");
  }

  async function remove(view: McpServerView) {
    if (!snapshot) return;
    const servers = snapshot.servers.filter((server) => server.id !== view.id).map((server) => server.raw);
    accept(await nativeClient.saveMcpSettings(servers, snapshot.revision, (snapshot.unreadable_servers ?? []).map(({ index }) => ({ index }))));
    setNotice(`Removed “${view.display_name}”. The program on disk is not touched.`);
  }

  async function runTest(entry: McpServerEntry, id: string) {
    setTest({ id, result: { outcome: "invalid", code: "pending", message: "Testing…", tools: [], diagnostics: [] } });
    const result = await nativeClient.testMcpServer(entry);
    setTest({ id, result });
  }

  function testSummary(result: McpTestResult) {
    if (result.outcome === "ok") return `${result.display_name} started and offers ${result.tools.length} tool${result.tools.length === 1 ? "" : "s"}: ${result.tools.map((tool) => tool.name).join(", ")}`;
    if (result.outcome === "tools_rejected") return `${result.display_name} started, but none of its tools could be accepted.`;
    if (result.outcome === "unreachable") return `${result.display_name} did not start: ${result.message}`;
    if (result.outcome === "missing_environment") return result.message;
    return result.message;
  }

  return <section className="settings-card" aria-label="MCP servers">
    <h2>MCP servers</h2>
    <p className="settings-note">
      Servers are separate stdio programs. Enabling one does not trust it: a server starts only when
      it is both enabled and trusted, and every tool call is still approved individually.
    </p>
    {snapshot && <p className="settings-note settings-path">{snapshot.path}</p>}
    {error && <p className="settings-error" role="alert">{error}</p>}
    {notice && <p className="settings-note" role="status">{notice}</p>}

    {snapshot?.diagnostics.map((diagnostic) => <p className="settings-error" role="alert" key={`${diagnostic.index}-${diagnostic.code}`}>
      Server {diagnostic.index + 1}{diagnostic.id ? ` (${diagnostic.id})` : ""}: {diagnostic.message}
    </p>)}

    {snapshot && (snapshot.unreadable_servers ?? []).length > 0 && <p className="settings-note" role="status">
      {(snapshot.unreadable_servers ?? []).length === 1 ? "One entry" : `${(snapshot.unreadable_servers ?? []).length} entries`} in this file
      could not be read and {(snapshot.unreadable_servers ?? []).length === 1 ? "is" : "are"} kept exactly as written. They are not
      shown or edited here, and saving anything else leaves them untouched. Correct them in the file directly.
    </p>}

    {snapshot && snapshot.servers.length === 0 && !draft && <p className="settings-note">No MCP servers configured.</p>}

    {snapshot?.servers.map((view) => {
      const open = expanded === view.id;
      const result = test?.id === view.id ? test.result : null;
      const active = view.enabled && view.trust_acknowledged;
      return <div className="mcp-server" key={view.id}>
        <div className="mcp-server-head">
          <button type="button" className="icon-button" aria-label={open ? `Collapse ${view.display_name}` : `Expand ${view.display_name}`}
            onClick={() => { setExpanded(open ? null : view.id); setTest(null); }}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <div className="mcp-server-title">
            <span className="mcp-server-name">{view.display_name}</span>
            <span className="mcp-server-state">{mcpState(view, active)}</span>
          </div>
        </div>
        {open && <div className="mcp-server-body">
          <p className="settings-path">{view.command} {view.args.join(" ")}</p>
          {view.cwd && <p className="settings-note">Working directory: <span className="settings-path">{view.cwd}</span></p>}
          {view.environment.length > 0 && <>
            <p className="settings-note">Environment is read from Aside's configuration by name:</p>
            <ul className="mcp-env-list">
              {view.environment.map((entry) => <li key={entry.name}><span className="settings-path">{entry.name}</span> ← {entry.from_config}</li>)}
            </ul>
          </>}
          {view.classifications.length > 0 && <>
            <p className="settings-note">Tool classifications:</p>
            <ul className="mcp-env-list">
              {view.classifications.map((entry) => <li key={entry.tool}>
                <span className="settings-path">{entry.tool}</span> · {[entry.effect, entry.scope, entry.egress, entry.replay].filter(Boolean).join(" / ") || "default"}
                {entry.stale && <span className="mcp-stale"> · configuration changed, re-approve</span>}
              </li>)}
            </ul>
          </>}
          <div className="settings-actions">
            <label className="mcp-check"><input type="checkbox" checked={view.enabled} disabled={busy || disabled}
              onChange={() => void perform("Saving enabled state", () => toggle(view, "enabled"))} /> Enabled</label>
            <label className="mcp-check"><input type="checkbox" checked={view.trust_acknowledged} disabled={busy || disabled}
              onChange={() => void perform("Saving trust state", () => toggle(view, "trust_acknowledged"))} /> Trusted</label>
          </div>
          {view.trust_acknowledged && !view.enabled && <p className="settings-note">Trusted but disabled: it will not start.</p>}
          {view.enabled && !view.trust_acknowledged && <p className="settings-note">Enabled but not trusted: it will not start.</p>}
          <div className="settings-actions">
            <button type="button" disabled={busy} onClick={() => void perform("Testing server", () => runTest(view.raw, view.id))}>Test connection</button>
            <button type="button" disabled={busy || disabled} onClick={() => beginEdit(view)}>Edit</button>
            <button type="button" className="icon-button" aria-label={`Delete ${view.display_name}`} disabled={busy || disabled}
              onClick={() => void perform("Removing server", () => remove(view))}><Trash2 size={14} /></button>
          </div>
          {result && result.outcome === "invalid" && result.code === "pending" && <p className="settings-note" role="status"><LoaderCircle className="spinning" size={13} /> Testing…</p>}
          {result && !(result.outcome === "invalid" && result.code === "pending") && <>
            <p className={result.outcome === "ok" ? "settings-note" : "settings-error"} role="status">{testSummary(result)}</p>
            {result.outcome !== "ok" && result.diagnostics.length > 0 && <ul className="mcp-env-list">
              {result.diagnostics.map((entry, index) => <li key={`${entry.code}-${index}`}>{entry.code}: {entry.message}</li>)}
            </ul>}
          </>}
        </div>}
      </div>;
    })}

    {draft ? <form className="mcp-form" onSubmit={(event) => { event.preventDefault(); void perform("Saving server", saveDraft); }}>
      <h3>{editingId !== null ? `Edit ${editingId}` : "New server"}</h3>
      <label htmlFor="mcp-id">Id <span>(lowercase letters, digits, - and _)</span></label>
      <input id="mcp-id" value={draft.id} maxLength={64} disabled={busy}
        onChange={(event) => setDraft({ ...draft, id: event.currentTarget.value })} />
      <label htmlFor="mcp-name">Display name</label>
      <input id="mcp-name" value={draft.display_name ?? ""} maxLength={120} disabled={busy}
        onChange={(event) => setDraft({ ...draft, display_name: event.currentTarget.value })} />
      <label htmlFor="mcp-command">Command <span>(must be a directly executable file, such as node.exe)</span></label>
      <input id="mcp-command" value={draft.command} maxLength={512} disabled={busy}
        onChange={(event) => setDraft({ ...draft, command: event.currentTarget.value })} />
      <label htmlFor="mcp-args">Arguments <span>(one per line)</span></label>
      <textarea id="mcp-args" rows={3} value={args} disabled={busy} onChange={(event) => setArgs(event.currentTarget.value)} />
      <label htmlFor="mcp-cwd">Working directory <span>(optional)</span></label>
      <input id="mcp-cwd" value={draft.cwd ?? ""} maxLength={512} disabled={busy}
        onChange={(event) => setDraft({ ...draft, cwd: event.currentTarget.value || undefined })} />

      <p className="settings-note">Environment names are looked up in Aside's own configuration. A literal secret cannot be stored here.</p>
      {env.map((row, index) => <div className="mcp-env-row" key={index}>
        <input aria-label={`Environment name ${index + 1}`} value={row.name} disabled={busy} placeholder="NAME"
          onChange={(event) => setEnv(env.map((entry, position) => position === index ? { ...entry, name: event.currentTarget.value } : entry))} />
        <span>=</span>
        <input aria-label={`Configuration name ${index + 1}`} value={row.from_config} disabled={busy} placeholder="FROM_CONFIG"
          onChange={(event) => setEnv(env.map((entry, position) => position === index ? { ...entry, from_config: event.currentTarget.value } : entry))} />
        <button type="button" className="icon-button" aria-label={`Remove environment row ${index + 1}`} disabled={busy}
          onClick={() => setEnv(env.filter((_, position) => position !== index))}><Trash2 size={13} /></button>
      </div>)}
      <div className="settings-actions">
        <button type="button" disabled={busy} onClick={() => setEnv([...env, { name: "", from_config: "" }])}><Plus size={13} /> Add environment name</button>
      </div>

      {editingId === null && snapshot?.servers.some((view) => view.id === draft.id.trim()) && <>
        {/* Overwriting is never implicit: the user is told which server loses
            its configuration and has to confirm it in the form. */}
        <p className="settings-error" role="alert">This id already exists. Saving replaces that server, including its enabled and trusted state.</p>
        <label className="mcp-check"><input type="checkbox" checked={overwriteAcknowledged} disabled={busy}
          onChange={(event) => { setOverwriteAcknowledged(event.currentTarget.checked); setError(null); }} /> Replace the existing server</label>
      </>}
      {editingId !== null && editingId !== draft.id.trim() && <p className="settings-note">
        Changing the id moves this server: the entry under “{editingId}” is replaced, and it is not enabled or trusted under the new id until you turn both on again.
      </p>}
      <p className="settings-note">New servers are saved disabled and untrusted. Turn both on when you are ready for it to run.</p>
      {test && <p className="settings-note" role="status">{testSummary(test.result)}</p>}
      <div className="settings-actions">
        <button type="submit" disabled={busy || !draft.id.trim() || !draft.command.trim()
          || (editingId === null && Boolean(snapshot?.servers.some((view) => view.id === draft.id.trim())) && !overwriteAcknowledged)}>Save server</button>
        <button type="button" disabled={busy} onClick={() => void perform("Testing server", () => runTest(draftEntry(), draft.id))}>Test connection</button>
        <button type="button" disabled={busy} onClick={() => { setDraft(null); setEditingId(null); setOverwriteAcknowledged(false); setEnv([]); setArgs(""); setTest(null); }}>Cancel</button>
      </div>
    </form> : <div className="settings-actions">
      <button type="button" disabled={busy || disabled} onClick={beginAdd}><Plus size={14} /> Add server</button>
    </div>}

    {busy && <p className="settings-operation" role="status"><LoaderCircle className="spinning" size={14} />{operation}</p>}
  </section>;
}

/** States are named by what will actually happen, not by which flag is set. */
function mcpState(view: McpServerView, active: boolean) {
  if (active) return "Active · starts with new tasks";
  if (view.enabled) return "Enabled, not trusted · will not start";
  if (view.trust_acknowledged) return "Trusted, not enabled · will not start";
  return "Configured · will not start";
}
