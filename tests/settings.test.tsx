import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SettingsPanel from "../src/SettingsPanel";
import { nativeClient } from "../src/lib/ipc";
import type { RuntimeEvent } from "../src/lib/contracts";
import type { ProviderCatalog, SettingsSnapshot } from "../src/lib/settings";

let root: Root;
let container: HTMLDivElement;
let emit: (event: RuntimeEvent) => void;
let snapshot: SettingsSnapshot;
const button = (name: string) => [...container.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === name)!;
const catalog = (provider: ProviderCatalog["provider"]): ProviderCatalog => ({ provider, default_model: `${provider}-default`, models: [{ id: `${provider}-default`, name: "Fixture model", api: "fixture-api", base_url: "https://fixture.example/v1", reasoning: false, input: ["text"], context_window: 10000, max_tokens: 1024, thinking_levels: ["off"] }] });

async function click(name: string) { await act(async () => button(name).click()); }
async function input(id: string, value: string) {
  await act(async () => {
    const element = container.querySelector<HTMLInputElement>(`#${id}`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function render(taskRunning = false) { await act(async () => root.render(<SettingsPanel onClose={() => {}} taskRunning={taskRunning} />)); }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  snapshot = {
    schema_version: 1, path: "D:/Aside/settings.json", revision: "saved-revision", effective_revision: "effective-revision",
    document: { schema_version: 1, provider: "openai", model: null, api_url: null, workspace_root: "D:/retained", thinking_level: "off", mcp_config_path: "D:/retained/mcp.json" },
    effective: { provider: "openai", model: null, api_url: null, thinking_level: "off", workspace_root: "D:/retained", mcp_config_path: "D:/retained/mcp.json" },
    sources: { provider: { kind: "settings" }, model: { kind: "settings" }, api_url: { kind: "settings" }, thinking_level: { kind: "default" }, workspace_root: { kind: "settings" }, mcp_config_path: { kind: "settings" } },
    credentials: { openai: { configured: true, stored: true, source: "credential_store" }, anthropic: { configured: false, stored: false, source: "none" }, deepseek: { configured: false, source: "none" }, google: { configured: false, source: "none" } },
    legacy_source: null, diagnostics: [], runtime_fields: ["provider", "model", "api_url", "mcp_config_path"],
    application: { state: "loaded", loaded_revision: "effective-revision", mode: "idle_rebuild" },
  };
  vi.spyOn(nativeClient, "getSettings").mockImplementation(async () => snapshot);
  vi.spyOn(nativeClient, "getProviderCatalog").mockImplementation(async (provider) => catalog(provider));
  vi.spyOn(nativeClient, "onRuntimeEvent").mockImplementation(async (handler) => { emit = handler; return () => {}; });
  vi.spyOn(nativeClient, "saveSettings").mockImplementation(async (document) => ({ ...snapshot, document }));
  vi.spyOn(nativeClient, "setApiKey").mockImplementation(async () => snapshot);
  vi.spyOn(nativeClient, "applySettings").mockImplementation(async () => ({ ...snapshot, application: { ...snapshot.application, state: "pending" } }));
  vi.spyOn(nativeClient, "testApiConnection").mockResolvedValue({ ok: true, code: "connection_ok", message: "The model returned a text response.", effective_revision: "effective-revision" });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});

afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

it("reads settings and local models without applying or testing a connection", async () => {
  await render();
  expect(container.textContent).toContain("Configuration loaded");
  expect(container.textContent).toContain("Windows Credential Manager");
  expect(container.querySelector<HTMLInputElement>("#settings-key")!.value).toBe("");
  expect(container.querySelector<HTMLInputElement>("#settings-key")!.type).toBe("password");
  expect(nativeClient.testApiConnection).not.toHaveBeenCalled();
  expect(nativeClient.applySettings).not.toHaveBeenCalled();
});

it("saves ordinary settings with their original revision and preserves other P0 fields", async () => {
  await render();
  await input("settings-url", "https://changed.example/v1");
  expect(button("Test saved connection").disabled).toBe(true);
  await click("Save settings");
  expect(nativeClient.saveSettings).toHaveBeenCalledWith({ ...snapshot.document, api_url: "https://changed.example/v1" }, "saved-revision");
  expect(nativeClient.applySettings).not.toHaveBeenCalled();
  expect(nativeClient.testApiConnection).not.toHaveBeenCalled();
});

it("submits a key only to the dedicated credential command then clears the input", async () => {
  await render();
  await input("settings-key", "private-test-key");
  await click("Save API key");
  expect(nativeClient.setApiKey).toHaveBeenCalledWith("openai", "private-test-key");
  expect(nativeClient.saveSettings).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLInputElement>("#settings-key")!.value).toBe("");
  expect(container.textContent).not.toContain("private-test-key");
  await click("Remove stored key");
  expect(nativeClient.setApiKey).toHaveBeenLastCalledWith("openai", null);
});

it("preserves an unsaved key when ordinary settings are saved first", async () => {
  await render();
  await input("settings-url", "https://changed.example/v1");
  await input("settings-key", "private-pending-key");
  await click("Save settings");
  expect(container.querySelector<HTMLInputElement>("#settings-key")!.value).toBe("private-pending-key");
  expect(nativeClient.setApiKey).not.toHaveBeenCalled();
  expect(button("Apply when idle").disabled).toBe(true);
  expect(container.textContent).toContain("Save the API key separately before applying");
  expect(JSON.stringify(vi.mocked(nativeClient.saveSettings).mock.calls)).not.toContain("private-pending-key");
});

it("changing provider resets the previous endpoint, model and unsaved secret", async () => {
  await render();
  await input("settings-url", "https://old.example");
  await input("settings-key", "private-key");
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>("#settings-provider")!;
    select.value = "anthropic"; select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.querySelector<HTMLInputElement>("#settings-url")!.value).toBe("");
  expect(container.querySelector<HTMLInputElement>("#settings-key")!.value).toBe("");
  await click("Save settings");
  expect(nativeClient.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ provider: "anthropic", model: null, api_url: null }), "saved-revision");
});

it("explains environment overrides and uses the effective saved endpoint for testing", async () => {
  snapshot = { ...snapshot, effective: { ...snapshot.effective, api_url: "https://environment.example/v1" }, sources: { ...snapshot.sources, api_url: { kind: "environment" } }, credentials: { ...snapshot.credentials, openai: { configured: true, stored: true, source: "environment" } } };
  await render();
  expect(container.textContent).toContain("overrides saved settings");
  expect(container.textContent).toContain("Process environment overrides a saved key");
  expect(container.textContent).toContain("may incur a small API charge");
  expect(container.textContent).toContain("https://environment.example/v1");
  await click("Test saved connection");
  expect(nativeClient.testApiConnection).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("The model returned a text response.");
});

it("queues application during a task and refreshes the actual status from runtime events", async () => {
  await render(true);
  expect(container.textContent).toContain("task and local save finish");
  await click("Apply when idle");
  expect(container.textContent).toContain("Saved changes pending application");
  snapshot = { ...snapshot, application: { ...snapshot.application, state: "loaded" } };
  await act(async () => emit({ type: "configuration_status", state: "applied" }));
  expect(container.textContent).toContain("Configuration loaded");
});

it("retains local edits and the old revision when background status refreshes", async () => {
  await render();
  await input("settings-url", "https://my-draft.example/v1");
  snapshot = { ...snapshot, revision: "external-new-revision" };
  await act(async () => emit({ type: "configuration_status", state: "pending" }));
  await click("Save settings");
  expect(nativeClient.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ api_url: "https://my-draft.example/v1" }), "saved-revision");
});

it("reports persistence failures and leaves the edited value available for retry", async () => {
  await render();
  await input("settings-url", "https://retained.example/v1");
  vi.mocked(nativeClient.saveSettings).mockRejectedValueOnce({ operation: "settings", message: "Settings changed externally. Reload before saving.", recoverable: true });
  await click("Save settings");
  expect(container.textContent).toContain("Settings changed externally");
  expect(container.querySelector<HTMLInputElement>("#settings-url")!.value).toBe("https://retained.example/v1");
  expect(button("Save settings").disabled).toBe(false);
});

it("keeps a reload action available when settings or credentials cannot be read", async () => {
  vi.mocked(nativeClient.getSettings).mockRejectedValueOnce(new Error("Settings file is invalid"));
  await render();
  expect(container.textContent).toContain("Settings file is invalid");
  expect(button("Reload saved settings").disabled).toBe(false);
  await click("Reload saved settings");
  expect(container.textContent).toContain("Configuration loaded");
});

it("allows removing an unreadable stored credential while apply and test stay blocked", async () => {
  snapshot = { ...snapshot, credentials: { ...snapshot.credentials, openai: { configured: false, stored: true, storage_error: true, source: "none" } }, diagnostics: [{ code: "credential_store_openai", field: "credential", message: "Windows could not read the openai credential. Replace or remove its stored key." }] };
  await render();
  expect(container.textContent).toContain("Replace or remove its stored key");
  expect(button("Remove stored key").disabled).toBe(false);
  expect(button("Test saved connection").disabled).toBe(true);
  expect(button("Apply when idle").disabled).toBe(true);
  await click("Remove stored key");
  expect(nativeClient.setApiKey).toHaveBeenCalledWith("openai", null);
});

it("cleans late subscriptions from both StrictMode effect lifetimes", async () => {
  const stops = [vi.fn(), vi.fn()];
  const registrations: Array<() => void> = [];
  vi.mocked(nativeClient.onRuntimeEvent).mockImplementation(() => new Promise((resolve) => {
    const index = registrations.length;
    registrations.push(() => resolve(stops[index]));
  }));
  await act(async () => root.render(<React.StrictMode><SettingsPanel onClose={() => {}} taskRunning={false} /></React.StrictMode>));
  expect(registrations).toHaveLength(2);
  await act(async () => { registrations.forEach((resolve) => resolve()); });
  expect(stops[0]).toHaveBeenCalledOnce();
  expect(stops[1]).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  expect(stops[1]).toHaveBeenCalledOnce();
});
