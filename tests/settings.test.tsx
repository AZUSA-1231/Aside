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
    credentials: { openai: { configured: true, stored: true, source: "credential_store" }, anthropic: { configured: false, stored: false, source: "none" }, deepseek: { configured: false, source: "none" }, google: { configured: false, source: "none" }, custom: { configured: false, source: "none" } },
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

it("saves the default directory independently while preserving API and key drafts", async () => {
  await render();
  await input("settings-url", "https://unsaved.example/v1");
  await input("settings-key", "draft-private-key");
  await input("settings-workspace", "D:/new-output");
  await act(async () => container.querySelector<HTMLFormElement>('[aria-label="Default directory settings"]')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(nativeClient.saveSettings).toHaveBeenCalledWith({ ...snapshot.document, workspace_root: "D:/new-output" }, "saved-revision");
  expect(container.querySelector<HTMLInputElement>("#settings-url")!.value).toBe("https://unsaved.example/v1");
  expect(container.querySelector<HTMLInputElement>("#settings-key")!.value).toBe("draft-private-key");
  expect(button("Apply when idle").disabled).toBe(true);
  expect(nativeClient.setApiKey).not.toHaveBeenCalled();
});

it("blank default directory restores the OS suggestion and shows saved directory errors without applying", async () => {
  snapshot = { ...snapshot, document: { ...snapshot.document, workspace_root: null }, effective: { ...snapshot.effective, workspace_root: "D:/Documents/Aside" }, default_workspace_root: "D:/Documents/Aside" };
  vi.spyOn(nativeClient, "revealPath").mockRejectedValue(new Error("The directory has not been created yet."));
  await render();
  expect(container.querySelector<HTMLInputElement>("#settings-workspace")!.value).toBe("");
  expect(container.textContent).toContain("D:/Documents/Aside");
  await click("Show saved directory");
  expect(nativeClient.revealPath).toHaveBeenCalledWith("D:/Documents/Aside");
  expect(container.querySelector('[role="alert"]')!.textContent).toContain("not been created");
  await input("settings-workspace", "D:/other-output");
  await input("settings-workspace", "");
  await act(async () => container.querySelector<HTMLFormElement>('[aria-label="Default directory settings"]')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(nativeClient.saveSettings).toHaveBeenCalledWith({ ...snapshot.document, workspace_root: null }, "saved-revision");
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

const selectOption = async (id: string, value: string) => {
  await act(async () => {
    const element = container.querySelector<HTMLSelectElement>(`#${id}`)!;
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

/** A catalog whose single model advertises the given reasoning levels. */
const reasoningCatalog = (levels: string[], reasoning = true, provider: ProviderCatalog["provider"] = "openai"): ProviderCatalog => ({
  provider, default_model: "reasoner",
  models: [{ id: "reasoner", name: "Reasoner", api: "fixture-api", base_url: "https://fixture.example/v1", reasoning, input: ["text"], context_window: 10000, max_tokens: 1024, thinking_levels: levels as ProviderCatalog["models"][number]["thinking_levels"] }],
});

it("offers only the levels the selected model supports", async () => {
  vi.mocked(nativeClient.getProviderCatalog).mockImplementation(async () => reasoningCatalog(["off", "low", "high"]));
  await render();
  await selectOption("settings-model", "reasoner");
  const options = [...container.querySelectorAll<HTMLOptionElement>("#settings-thinking option")].map((option) => option.value);
  // "medium" and "max" are absent because this model cannot express them.
  expect(options).toEqual(["off", "low", "high"]);
});

it("shows no level selector at all for a model without reasoning", async () => {
  vi.mocked(nativeClient.getProviderCatalog).mockImplementation(async () => reasoningCatalog(["off"], false));
  await render();
  await selectOption("settings-model", "reasoner");
  expect(container.querySelector("#settings-thinking")).toBeNull();
  expect(container.textContent).toContain("does not support reasoning");
});

it("saves a chosen thinking level independently and marks it unsaved until applied", async () => {
  vi.mocked(nativeClient.getProviderCatalog).mockImplementation(async () => reasoningCatalog(["off", "low", "high"]));
  await render();
  await selectOption("settings-model", "reasoner");
  await selectOption("settings-thinking", "high");
  // An unsaved level blocks "Apply when idle" exactly like other unsaved edits.
  expect(button("Apply when idle").disabled).toBe(true);
  await act(async () => container.querySelector<HTMLFormElement>('[aria-label="Thinking level settings"]')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(nativeClient.saveSettings).toHaveBeenCalledWith({ ...snapshot.document, thinking_level: "high" }, "saved-revision");
  expect(nativeClient.applySettings).not.toHaveBeenCalled();
});

it("reports a saved level the current model cannot use instead of showing it as applied", async () => {
  snapshot = {
    ...snapshot,
    document: { ...snapshot.document, thinking_level: "medium" },
    effective: { ...snapshot.effective, thinking_level: "medium" },
    thinking: { requested: "medium", applied: "high", supported: ["off", "high", "max"], adjusted: true },
  };
  vi.mocked(nativeClient.getProviderCatalog).mockImplementation(async () => reasoningCatalog(["off", "high", "max"]));
  await render();
  expect(container.textContent).toContain("Effective thinking level");
  // The saved value is named as unsupported; the applied one is what runs.
  expect(container.textContent).toContain("saved \u201Cmedium\u201D is not supported by this model");
  expect(container.textContent).toContain("Supported by this model: off, high, max");
});

it("keeps the saved model's level list while a different provider is only a draft", async () => {
  vi.mocked(nativeClient.getProviderCatalog).mockImplementation(async (requested) => reasoningCatalog(
    requested === "deepseek" ? ["off", "high"] : ["off", "low", "medium", "high"],
    true,
    requested,
  ));
  await render();
  // Switching the draft provider must not rewrite the level list stored under
  // the saved document: the card writes to that document, so offering the
  // draft model's levels would save a level for a model that is not in the file.
  await act(async () => {
    const element = container.querySelector<HTMLSelectElement>("#settings-provider")!;
    element.value = "deepseek";
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const options = [...container.querySelectorAll<HTMLOptionElement>("#settings-thinking option")].map((option) => option.value);
  expect(options).toEqual(["off", "low", "medium", "high"]);
});

it("names the level the runtime will use when the saved one is unavailable", async () => {
  snapshot = {
    ...snapshot,
    document: { ...snapshot.document, model: "reasoner", thinking_level: "medium" },
    effective: { ...snapshot.effective, model: "reasoner", thinking_level: "medium" },
    thinking: { requested: "medium", applied: "high", supported: ["off", "high", "max"], adjusted: true },
  };
  vi.mocked(nativeClient.getProviderCatalog).mockImplementation(async () => reasoningCatalog(["off", "high", "max"]));
  await render();
  // The select shows the saved value as unavailable, and the note names the
  // level that actually runs rather than the lowest supported one.
  const select = container.querySelector<HTMLSelectElement>("#settings-thinking")!;
  expect(select.value).toBe("");
  expect(container.textContent).toContain("Saved: medium · not available on this model");
  expect(container.textContent).toContain("This model will use “high” instead");
});

it("edits the custom route's protocol, capacity and declared capabilities", async () => {
  snapshot = {
    ...snapshot,
    document: { ...snapshot.document, provider: "custom", model: "route-model", api_url: "https://route.example/v1", custom_protocol: "openai-completions", custom_context_window: "32000", custom_max_output: "4096", custom_reasoning: "true", custom_tools: "false" },
    effective: { ...snapshot.effective, provider: "custom", model: "route-model", api_url: "https://route.example/v1" },
    sources: { ...snapshot.sources, provider: { kind: "settings" }, model: { kind: "settings" }, api_url: { kind: "settings" } },
    credentials: { ...snapshot.credentials, custom: { configured: true, stored: true, source: "credential_store" } },
    custom_route: { ok: true, route: { provider: "custom", default_model: "route-model", custom: true, protocol: "openai-completions", tools: false, models: [{ id: "route-model", name: "route-model", api: "openai-completions", base_url: "https://route.example/v1", reasoning: true, input: ["text"], context_window: 32000, max_tokens: 4096, thinking_levels: ["off", "low", "medium", "high"] }] } },
  };
  await render();
  // The free-text model field replaces the catalog select for a custom route.
  expect(container.querySelector<HTMLInputElement>("#settings-model")!.value).toBe("route-model");
  expect(container.querySelector<HTMLSelectElement>("#settings-protocol")!.value).toBe("openai-completions");
  expect(container.querySelector<HTMLInputElement>("#settings-context")!.value).toBe("32000");
  // The declared "no tools" choice is reflected rather than assumed on.
  const checkboxes = [...container.querySelectorAll<HTMLInputElement>(".settings-capabilities input")];
  expect(checkboxes.map((entry) => entry.checked)).toEqual([false, true, false]);
  expect(container.textContent).toContain("Custom API");
});

it("saves only the custom route fields it changed and keeps the declared flags as strings", async () => {
  snapshot = {
    ...snapshot,
    document: { ...snapshot.document, provider: "custom", model: "route-model", api_url: "https://route.example/v1", custom_protocol: "openai-completions", custom_context_window: "32000", custom_max_output: "4096" },
    effective: { ...snapshot.effective, provider: "custom", model: "route-model", api_url: "https://route.example/v1" },
    custom_route: { ok: true, route: { provider: "custom", default_model: "route-model", custom: true, protocol: "openai-completions", tools: true, models: [{ id: "route-model", name: "route-model", api: "openai-completions", base_url: "https://route.example/v1", reasoning: false, input: ["text"], context_window: 32000, max_tokens: 4096, thinking_levels: ["off"] }] } },
  };
  await render();
  await act(async () => {
    const element = container.querySelector<HTMLSelectElement>("#settings-protocol")!;
    element.value = "openai-responses";
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("Save settings");
  expect(nativeClient.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
    provider: "custom", model: "route-model", api_url: "https://route.example/v1",
    custom_protocol: "openai-responses", custom_context_window: "32000", custom_max_output: "4096",
    custom_tools: "true", custom_reasoning: "false", custom_images: "false",
  }), "saved-revision");
});

it("shows the route error instead of a locked save when the declaration is unusable", async () => {
  snapshot = {
    ...snapshot,
    document: { ...snapshot.document, provider: "custom" },
    effective: { ...snapshot.effective, provider: "custom" },
    custom_route: { ok: false, code: "custom_route_invalid_context_window", message: "The context window must be a whole number of tokens." },
  };
  await render();
  expect(container.textContent).toContain("The context window must be a whole number of tokens.");
  expect(container.querySelector<HTMLInputElement>("#settings-model")!.value).toBe("");
});
