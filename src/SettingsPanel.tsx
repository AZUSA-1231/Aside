import { useEffect, useRef, useState } from "react";
import { ArrowLeft, LoaderCircle } from "lucide-react";
import { nativeClient, toNativeError } from "./lib/ipc";
import type { ConnectionTestResult, ProviderCatalog, ResolvedThinkingLevel, SettingsDocument, SettingsProvider, SettingsSnapshot, ThinkingLevel } from "./lib/settings";
import McpSettingsCard from "./McpSettingsCard";
import "./settings.css";

const providers: SettingsProvider[] = ["openai", "anthropic", "deepseek", "google"];
const isProvider = (value: string): value is SettingsProvider => providers.includes(value as SettingsProvider);
const providerName = (value: string) => ({ openai: "OpenAI", anthropic: "Anthropic", deepseek: "DeepSeek", google: "Google" })[value] ?? value;
const sourceName = (value: string) => ({ environment: "Process environment", settings: "User settings", legacy: "Legacy env file", default: "Default", credential_store: "Windows Credential Manager", none: "Not configured" })[value] ?? value;
const applicationName = (value: SettingsSnapshot["application"]["state"]) => ({
  not_started: "Runtime not started", starting: "Runtime starting", loaded: "Configuration loaded",
  pending: "Saved changes pending application", applying: "Applying configuration", unavailable: "Runtime unavailable",
})[value];

export default function SettingsPanel({ onClose, taskRunning }: { onClose: () => void; taskRunning: boolean }) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [baseDocument, setBaseDocument] = useState<SettingsDocument>({ schema_version: 1 });
  const [revision, setRevision] = useState("missing");
  const [provider, setProvider] = useState<SettingsProvider>("openai");
  const [model, setModel] = useState("");
  const [apiUrl, setApiUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [workspaceDirty, setWorkspaceDirty] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState("");
  const [thinkingDirty, setThinkingDirty] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [catalogs, setCatalogs] = useState<Partial<Record<SettingsProvider, ProviderCatalog>>>({});
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [operation, setOperation] = useState<string | null>("Loading settings");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);
  const requestSequence = useRef(0);

  function accept(next: SettingsSnapshot, hydrate = false, clearKey = hydrate) {
    if (!mounted.current) return;
    setSnapshot(next);
    if (hydrate) {
      setBaseDocument(next.document);
      setRevision(next.revision);
      const selected = next.document.provider ?? next.effective.provider;
      setProvider(isProvider(selected) ? selected : "openai");
      setModel(Object.prototype.hasOwnProperty.call(next.document, "model") ? next.document.model ?? "" : next.effective.model ?? "");
      setApiUrl(Object.prototype.hasOwnProperty.call(next.document, "api_url") ? next.document.api_url ?? "" : next.effective.api_url ?? "");
      setWorkspaceRoot(Object.prototype.hasOwnProperty.call(next.document, "workspace_root") ? next.document.workspace_root ?? "" : next.sources.workspace_root.kind === "default" ? "" : next.effective.workspace_root ?? "");
      setWorkspaceDirty(false);
      setThinkingLevel(Object.prototype.hasOwnProperty.call(next.document, "thinking_level") ? next.document.thinking_level ?? "" : "");
      setThinkingDirty(false);
      setDirty(false);
      if (clearKey) setApiKey("");
      setTestResult(null);
    }
  }

  async function perform(label: string, action: () => Promise<void>) {
    setOperation(label);
    setError(null);
    setNotice(null);
    try { await action(); }
    catch (failure) { if (mounted.current) setError(toNativeError(failure, "settings").message); }
    finally { if (mounted.current) setOperation(null); }
  }

  useEffect(() => {
    let disposed = false;
    mounted.current = true;
    heading.current?.focus();
    void nativeClient.getSettings().then((next) => { if (!disposed) accept(next, true); })
      .catch((failure) => { if (!disposed) setError(toNativeError(failure, "settings").message); })
      .finally(() => { if (!disposed) setOperation(null); });
    let unlisten: (() => void) | undefined;
    void nativeClient.onRuntimeEvent((event) => {
      if (disposed) return;
      if (!["ready", "configuration_status", "runtime_unavailable"].includes(event.type)) return;
      const sequence = ++requestSequence.current;
      void nativeClient.getSettings().then((next) => {
        if (!disposed && sequence === requestSequence.current) accept(next);
      }).catch(() => undefined);
    }).then((stop) => { if (!disposed) unlisten = stop; else stop(); });
    return () => { disposed = true; mounted.current = false; unlisten?.(); };
  }, []);

  const effectiveProvider = snapshot?.effective.provider;
  // The thinking card writes to the saved document, so its level list must come
  // from the saved model. Listing the draft model's levels let a user save a
  // level for the model still on screen while the file kept the previous one.
  const savedProvider = isProvider(baseDocument.provider ?? "") ? baseDocument.provider : effectiveProvider;
  useEffect(() => {
    let cancelled = false;
    setCatalogError(null);
    const requested = [...new Set([provider, effectiveProvider, savedProvider].filter((value): value is SettingsProvider => Boolean(value && isProvider(value))))];
    void Promise.all(requested.map((selected) => nativeClient.getProviderCatalog(selected))).then((results) => {
      if (!cancelled) setCatalogs((current) => ({ ...current, ...Object.fromEntries(results.map((catalog) => [catalog.provider, catalog])) }));
    }).catch((failure) => { if (!cancelled) setCatalogError(toNativeError(failure, "settings").message); });
    return () => { cancelled = true; };
  }, [provider, effectiveProvider, savedProvider]);

  const catalog = catalogs[provider];
  const selectedModel = catalog?.models.find((entry) => entry.id === (model || catalog.default_model));
  const effectiveCatalog = effectiveProvider && isProvider(effectiveProvider) ? catalogs[effectiveProvider] : undefined;
  const effectiveModel = effectiveCatalog?.models.find((entry) => entry.id === (snapshot?.effective.model || effectiveCatalog.default_model));
  const savedCatalog = savedProvider && isProvider(savedProvider) ? catalogs[savedProvider] : undefined;
  const savedModel = savedCatalog?.models.find((entry) => entry.id === (baseDocument.model || savedCatalog.default_model));
  const endpoint = snapshot?.effective.api_url || effectiveModel?.base_url;
  const credential = snapshot?.credentials[provider];
  // The offered levels belong to the selected model, so switching to a model
  // with fewer levels removes the others rather than showing a choice that
  // cannot be sent. `snapshot.thinking` is the backend's own resolution against
  // the effective model and is shown as "will use", never as if it were saved.
  const offeredLevels = savedModel?.thinking_levels ?? effectiveModel?.thinking_levels ?? ["off"];
  const resolvedThinking: ResolvedThinkingLevel | undefined = snapshot?.thinking ?? undefined;
  const previewLevel = thinkingLevel && offeredLevels.includes(thinkingLevel as ThinkingLevel) ? thinkingLevel : "";
  // When the saved level is not one this model offers, the select still shows
  // the saved value, marked as unavailable. Showing `offeredLevels[0]` instead
  // displayed "off" beside a note promising "the nearest supported level" —
  // a level the runtime would not use, since the backend clamps upward.
  const savedLevelUnavailable = Boolean(thinkingLevel) && !previewLevel;
  const busy = operation !== null;
  const unsaved = dirty || workspaceDirty || thinkingDirty || apiKey.length > 0;
  const changed = () => { setDirty(true); setNotice(null); setTestResult(null); };

  return <section className="settings-panel" aria-label="Model and API settings" aria-busy={busy}>
    <div className="settings-title">
      <button type="button" className="icon-button" aria-label="Back to conversation" onClick={onClose}><ArrowLeft size={16} /></button>
      <h1 ref={heading} tabIndex={-1}>Settings</h1>
    </div>
    {error && <p className="settings-error" role="alert">{error} Reload saved settings if another editor changed the file.</p>}
    {notice && <p className="settings-note" role="status">{notice}</p>}
    <form className="settings-card" onSubmit={(event) => {
      event.preventDefault();
      if (!snapshot || busy || !selectedModel) return;
      void perform("Saving settings", async () => {
        const next = await nativeClient.saveSettings({ ...baseDocument, provider, model: model || null, api_url: apiUrl.trim() || null }, revision);
        accept(next);
        setBaseDocument(next.document); setRevision(next.revision); setDirty(false); setTestResult(null);
        setNotice(apiKey ? "Settings saved. Save the API key separately before applying." : "Settings saved. Apply when idle to update the runtime.");
      });
    }}>
      <h2>Provider and model</h2>
      <label htmlFor="settings-provider">Provider</label>
      <select id="settings-provider" value={provider} disabled={busy} onChange={(event) => {
        setProvider(event.currentTarget.value as SettingsProvider); setModel(""); setApiUrl(""); setApiKey(""); changed();
      }}>{providers.map((value) => <option key={value} value={value}>{providerName(value)}</option>)}</select>
      <label htmlFor="settings-model">Model</label>
      <select id="settings-model" value={model} disabled={busy || !catalog} onChange={(event) => { setModel(event.currentTarget.value); changed(); }}>
        <option value="">Provider default{catalog?.default_model ? ` · ${catalog.default_model}` : ""}</option>
        {model && !catalog?.models.some((entry) => entry.id === model) && <option value={model}>{model} · unsupported</option>}
        {catalog?.models.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.id}</option>)}
      </select>
      {catalogError && <p className="settings-error" role="alert">{catalogError}</p>}
      {catalog && !selectedModel && <p className="settings-error">Choose a model from the supported catalog.</p>}
      {selectedModel && <p className="settings-note">{selectedModel.context_window.toLocaleString()} context · {selectedModel.max_tokens.toLocaleString()} output · {selectedModel.reasoning ? "Reasoning capable" : "Standard model"} · {selectedModel.api}</p>}
      <label htmlFor="settings-url">Base URL <span>(optional)</span></label>
      <input id="settings-url" type="url" value={apiUrl} maxLength={4096} placeholder={selectedModel?.base_url ?? "Provider default endpoint"} disabled={busy}
        onChange={(event) => { setApiUrl(event.currentTarget.value); changed(); }} />
      <p className="settings-note">Use an endpoint compatible with the selected model protocol. Blank uses the provider default.</p>
      {snapshot && <div className="settings-effective">
        <strong>Effective configuration</strong>
        <span>{providerName(snapshot.effective.provider)} · {snapshot.effective.model || effectiveCatalog?.default_model || "Provider default"}</span>
        <span className="settings-path">{endpoint || "Default endpoint unavailable"}</span>
        {(["provider", "model", "api_url"] as const).map((field) => <span key={field}>{field === "api_url" ? "Base URL" : field}: {sourceName(snapshot.sources[field].kind)}{snapshot.sources[field].kind === "environment" ? " · overrides saved settings" : ""}</span>)}
      </div>}
      <div className="settings-actions">
        <button type="submit" disabled={busy || !snapshot || !selectedModel || !dirty}>Save settings</button>
        <button type="button" disabled={busy} onClick={() => void perform("Reloading settings", async () => accept(await nativeClient.getSettings(), true))}>Reload saved settings</button>
      </div>
    </form>

    <form className="settings-card" aria-label="Thinking level settings" onSubmit={(event) => {
      event.preventDefault();
      if (busy || !snapshot) return;
      void perform("Saving thinking level", async () => {
        const next = await nativeClient.saveSettings({ ...baseDocument, thinking_level: (thinkingLevel || null) as ThinkingLevel | null }, revision);
        accept(next); setBaseDocument(next.document); setRevision(next.revision); setThinkingDirty(false); setTestResult(null);
        setNotice("Thinking level saved. Apply when idle to use it; the task already running keeps its current level.");
      });
    }}>
      <h2>Thinking level</h2>
      {offeredLevels.length <= 1
        ? <p className="settings-note">{providerName(savedProvider ?? provider)} · {baseDocument.model || savedCatalog?.default_model || "Provider default"} does not support reasoning, so only “off” is available.</p>
        : <>
          <label htmlFor="settings-thinking">Level for {savedModel?.name ?? (baseDocument.model || "this model")}</label>
          <select id="settings-thinking" value={previewLevel} disabled={busy} onChange={(event) => {
            setThinkingLevel(event.currentTarget.value); setThinkingDirty(true); setNotice(null); setTestResult(null);
          }}>
            {!thinkingLevel && <option value="">Provider default · {offeredLevels[0]}</option>}
            {/* The saved level stays visible so the user can see what is on disk,
                but it is not selectable: choosing it again would ask for a value
                this model cannot express. */}
            {savedLevelUnavailable && <option value="" disabled>Saved: {thinkingLevel} · not available on this model</option>}
            {offeredLevels.map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
          {savedLevelUnavailable && <p className="settings-note">Saved level “{thinkingLevel}” is not available on this model. {resolvedThinking ? `This model will use “${resolvedThinking.applied}” instead.` : "The nearest supported level is used instead."}</p>}
        </>}
      {resolvedThinking && <div className="settings-effective">
        <strong>Effective thinking level</strong>
        <span>{resolvedThinking.applied}{resolvedThinking.adjusted ? ` · saved “${resolvedThinking.requested}” is not supported by this model` : ""}</span>
        <span>Supported by this model: {resolvedThinking.supported.join(", ")}</span>
      </div>}
      <p className="settings-note">Higher levels ask the model to reason for longer where the provider supports it. A change never alters the task that is already running.</p>
      <div className="settings-actions">
        <button type="submit" disabled={busy || !snapshot || !thinkingDirty}>Save thinking level</button>
      </div>
    </form>

    <form className="settings-card" aria-label="Default directory settings" onSubmit={(event) => {
      event.preventDefault();
      if (busy || !snapshot) return;
      void perform("Saving default directory", async () => {
        const next = await nativeClient.saveSettings({ ...baseDocument, workspace_root: workspaceRoot.trim() || null }, revision);
        accept(next); setBaseDocument(next.document); setRevision(next.revision); setWorkspaceDirty(false); setTestResult(null);
        setNotice("Default directory saved. Apply when idle to use it for the next task. Existing files stay in their current locations.");
      });
    }}>
      <h2>Default directory</h2>
      <label htmlFor="settings-workspace">Directory path <span>(optional)</span></label>
      <input id="settings-workspace" type="text" value={workspaceRoot} maxLength={4096} disabled={busy} placeholder={snapshot?.default_workspace_root || "Absolute directory path"}
        onChange={(event) => { setWorkspaceRoot(event.currentTarget.value); setWorkspaceDirty(true); setNotice(null); }} />
      <p className="settings-note">Blank uses the system Documents/Aside directory. Without a selected task workspace, new outputs go here. Captured files stay in place and are read-only sources.</p>
      {snapshot && <div className="settings-effective">
        <strong>Effective default directory</strong>
        <span className="settings-path">{snapshot.effective.workspace_root || "System document directory unavailable. Set an absolute path."}</span>
        <span>{sourceName(snapshot.sources.workspace_root.kind)}{snapshot.sources.workspace_root.kind === "environment" ? " · overrides saved settings" : ""}</span>
      </div>}
      <p className="settings-note">The directory is created on the first approved write. Outputs are kept until you remove them. Session history and API keys are stored separately.</p>
      <div className="settings-actions">
        <button type="submit" disabled={busy || !snapshot || !workspaceDirty}>Save directory</button>
        <button type="button" disabled={busy || !snapshot?.effective.workspace_root || workspaceDirty} onClick={() => void perform("Locating default directory", async () => {
          await nativeClient.revealPath(snapshot!.effective.workspace_root!);
        })}>Show saved directory</button>
      </div>
    </form>

    <section className="settings-card" aria-label="API credential">
      <h2>{providerName(provider)} API key</h2>
      <p className="settings-note">{credential?.configured ? `Configured · ${sourceName(credential.source)}` : "No effective key configured"}{credential?.source === "environment" ? ". Process environment overrides a saved key." : ""}</p>
      <label htmlFor="settings-key">New API key</label>
      <input id="settings-key" type="password" autoComplete="new-password" spellCheck={false} value={apiKey} maxLength={2048} disabled={busy}
        onChange={(event) => { setApiKey(event.currentTarget.value); setTestResult(null); }} placeholder="Write only · never read back" />
      <p className="settings-note">Stored for your Windows user in Credential Manager. Keys are saved separately from ordinary settings. Removing a stored key may reveal a legacy env key.</p>
      <div className="settings-actions">
        <button type="button" disabled={busy || !apiKey.trim()} onClick={() => void perform("Saving API key", async () => {
          accept(await nativeClient.setApiKey(provider, apiKey.trim())); setApiKey(""); setTestResult(null); setNotice("API key saved. Apply when idle to update the runtime.");
        })}>Save API key</button>
        <button type="button" disabled={busy || !credential?.stored} onClick={() => void perform("Removing API key", async () => {
          accept(await nativeClient.setApiKey(provider, null)); setApiKey(""); setTestResult(null); setNotice("Stored API key removed. Check the effective credential source before applying.");
        })}>Remove stored key</button>
      </div>
    </section>

    <McpSettingsCard disabled={busy} onSaved={() => {
      // Saving MCP changes the effective configuration revision, so the
      // application status shown here is stale until this re-reads it.
      const sequence = ++requestSequence.current;
      void nativeClient.getSettings().then((next) => {
        if (mounted.current && sequence === requestSequence.current) accept(next);
      }).catch(() => undefined);
    }} />

    <section className="settings-card" aria-label="Configuration status">
      <h2>Apply and test</h2>
      <p role="status">{snapshot ? applicationName(snapshot.application.state) : "Settings unavailable"}</p>
      <p className="settings-note">Loaded means the runtime has read this configuration. Connection is tested separately. {taskRunning ? "The active task keeps its current settings; application waits until the task and local save finish." : "Application preserves this conversation and draft."}</p>
      {snapshot?.application.last_apply_error && <p className="settings-error" role="alert">{snapshot.application.last_apply_error}</p>}
      {snapshot?.diagnostics.map((diagnostic) => <p className="settings-error" key={diagnostic.code}>{diagnostic.message}</p>)}
      <div className="settings-actions">
        <button type="button" disabled={busy || !snapshot || unsaved || snapshot.application.state === "applying" || Boolean(snapshot.diagnostics.length)} onClick={() => void perform("Requesting application", async () => accept(await nativeClient.applySettings()))}>Apply when idle</button>
      </div>
      <p className="settings-note">Test saved connection sends “Reply OK” to <span className="settings-path">{endpoint || "the configured endpoint"}</span> using the effective saved key and may incur a small API charge. No files or conversation history are sent.</p>
      {unsaved && <p className="settings-note">Save or reload your changes before applying or testing.</p>}
      <button type="button" disabled={busy || !snapshot || unsaved || !endpoint || !effectiveModel || Boolean(snapshot.diagnostics.length)} onClick={() => void perform("Testing connection", async () => {
        const result = await nativeClient.testApiConnection();
        if (mounted.current) setTestResult(result);
      })}>Test saved connection</button>
      {testResult && testResult.effective_revision === snapshot?.effective_revision && <p className={testResult.ok ? "settings-note" : "settings-error"} role="status">{testResult.message}</p>}
    </section>
    {busy && <p className="settings-operation" role="status"><LoaderCircle className="spinning" size={14} />{operation}</p>}
    {snapshot && <p className="settings-note settings-path">Settings: {snapshot.path}{snapshot.legacy_source && <> · Legacy source: {snapshot.legacy_source}</>}</p>}
  </section>;
}
