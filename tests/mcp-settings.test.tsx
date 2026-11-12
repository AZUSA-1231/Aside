import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import McpSettingsCard from "../src/McpSettingsCard";
import { nativeClient } from "../src/lib/ipc";
import type { McpServerEntry, McpServerView, McpSettingsSnapshot } from "../src/lib/mcp";

let root: Root;
let container: HTMLDivElement;
let snapshot: McpSettingsSnapshot;

const button = (name: string) => [...container.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === name)!;
const ariaButton = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
async function click(name: string) { await act(async () => button(name).click()); }
async function clickAria(label: string) { await act(async () => ariaButton(label).click()); }
async function render() {
  await act(async () => root.render(<McpSettingsCard onSaved={() => {}} disabled={false} />));
  await act(async () => { await Promise.resolve(); });
}
async function setValue(id: string, value: string) {
  await act(async () => {
    const element = container.querySelector<HTMLInputElement>(`#${id}`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const raw = (overrides: Partial<McpServerEntry> = {}): McpServerEntry => ({
  id: "notes",
  display_name: "Notes",
  transport: "stdio",
  command: "node.exe",
  args: ["server.js"],
  env: { API_KEY: { from_config: "NOTES_API_KEY" } },
  enabled: false,
  trust_acknowledged: false,
  ...overrides,
});

const view = (overrides: Partial<McpServerView> = {}): McpServerView => ({
  raw: raw(),
  id: "notes",
  display_name: "Notes",
  enabled: false,
  trust_acknowledged: false,
  fingerprint: "f".repeat(32),
  command: "node.exe",
  args: ["server.js"],
  cwd: null,
  environment: [{ name: "API_KEY", from_config: "NOTES_API_KEY" }],
  classifications: [],
  ...overrides,
});

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  snapshot = { path: "D:/Aside/mcp.json", revision: "rev-1", exists: true, servers: [view()], unreadable_servers: [], diagnostics: [], effective_revision: "e1" };
  vi.spyOn(nativeClient, "getMcpSettings").mockImplementation(async () => snapshot);
  vi.spyOn(nativeClient, "saveMcpSettings").mockImplementation(async (servers) => ({
    ...snapshot,
    revision: "rev-2",
    servers: servers.map((entry) => view({
      raw: entry,
      id: entry.id,
      display_name: entry.display_name ?? entry.id,
      enabled: entry.enabled === true,
      trust_acknowledged: entry.trust_acknowledged === true,
    })),
  }));
  vi.spyOn(nativeClient, "testMcpServer").mockResolvedValue({
    outcome: "ok", server_id: "notes", display_name: "Notes", elapsed_ms: 12,
    tools: [{ name: "search" }], diagnostics: [],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

it("names the state by what will actually happen", async () => {
  await render();
  expect(container.textContent).toContain("Configured · will not start");
});

it("enables and trusts independently", async () => {
  await render();
  await clickAria("Expand Notes");
  const boxes = [...container.querySelectorAll<HTMLInputElement>(".mcp-check input")];
  await act(async () => boxes[0].click());
  // Only `enabled` flips; trust is a separate acknowledgement.
  expect(nativeClient.saveMcpSettings).toHaveBeenLastCalledWith(
    [expect.objectContaining({ id: "notes", enabled: true, trust_acknowledged: false })],
    "rev-1",
    [],
  );
  expect(container.textContent).toContain("Enabled but not trusted");
});

it("a new server is saved disabled and untrusted", async () => {
  snapshot = { ...snapshot, servers: [] };
  await render();
  await click("Add server");
  await setValue("mcp-id", "search");
  await setValue("mcp-name", "Search");
  await setValue("mcp-command", "node.exe");
  await click("Save server");
  expect(nativeClient.saveMcpSettings).toHaveBeenCalledWith(
    [expect.objectContaining({ id: "search", enabled: false, trust_acknowledged: false })],
    "rev-1",
    [],
  );
});

it("reports a missing configuration name without showing a value", async () => {
  vi.mocked(nativeClient.testMcpServer).mockResolvedValue({
    outcome: "missing_environment", server_id: "notes", display_name: "Notes",
    missing: [{ name: "API_KEY", from_config: "NOTES_API_KEY" }],
    message: "The server needs NOTES_API_KEY from Aside's configuration; that name is not set.",
    tools: [], diagnostics: [],
  });
  await render();
  await clickAria("Expand Notes");
  await click("Test connection");
  expect(container.textContent).toContain("NOTES_API_KEY");
  expect(container.textContent).not.toContain("sk-");
});

it("says a server started when its tools were refused, rather than calling it unreachable", async () => {
  vi.mocked(nativeClient.testMcpServer).mockResolvedValue({
    outcome: "tools_rejected", server_id: "notes", display_name: "Notes", elapsed_ms: 8,
    message: "The server responded, but none of its tools could be accepted.",
    tools: [], diagnostics: [{ code: "mcp_schema_unsupported_keyword", message: "unsupported keyword" }],
  });
  await render();
  await clickAria("Expand Notes");
  await click("Test connection");
  expect(container.textContent).toContain("started, but none of its tools could be accepted");
});

it("marks a classification whose server configuration changed", async () => {
  snapshot = { ...snapshot, servers: [view({
    classifications: [{ tool: "search", effect: "read", scope: "host", stale: true }],
  })] };
  await render();
  await clickAria("Expand Notes");
  expect(container.textContent).toContain("configuration changed, re-approve");
});

it("removes a server without claiming the program was deleted", async () => {
  await render();
  await clickAria("Expand Notes");
  await clickAria("Delete Notes");
  expect(nativeClient.saveMcpSettings).toHaveBeenCalledWith([], "rev-1", []);
  expect(container.textContent).toContain("The program on disk is not touched");
});

it("shows file diagnostics for entries that failed to load", async () => {
  snapshot = { ...snapshot, diagnostics: [{ index: 1, id: "broken", code: "mcp_config_invalid", message: "The command is not a directly executable file." }] };
  await render();
  expect(container.textContent).toContain("Server 2 (broken)");
  expect(container.textContent).toContain("not a directly executable file");
});

it("R1-07a / C8-I039: a new server with an existing id requires explicit confirmation", async () => {
  await render();
  await click("Add server");
  await setValue("mcp-id", "notes");
  await setValue("mcp-command", "node.exe");
  // The id collides, so saving is blocked and the form says what would be lost.
  expect(container.textContent).toContain("This id already exists. Saving replaces that server");
  const save = button("Save server").disabled;
  expect(save).toBe(true);
  await click("Save server");
  expect(nativeClient.saveMcpSettings).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLInputElement>(".mcp-check input")!.click());
  await click("Save server");
  expect(nativeClient.saveMcpSettings).toHaveBeenCalledWith(
    [expect.objectContaining({ id: "notes", command: "node.exe" })],
    "rev-1",
    [],
  );
});

it("R1-07a / C8-I039: changing a server's id replaces its entry instead of appending a copy", async () => {
  await render();
  await clickAria("Expand Notes");
  await click("Edit");
  await setValue("mcp-id", "notes-v2");
  expect(container.textContent).toContain("Changing the id moves this server");
  await click("Save server");
  const [[servers]] = vi.mocked(nativeClient.saveMcpSettings).mock.calls;
  // One entry, under the new id: the old id must not survive with its
  // enabled / trusted flags intact.
  expect(servers.map((entry) => entry.id)).toEqual(["notes-v2"]);
  expect(servers[0]).toMatchObject({ enabled: false, trust_acknowledged: false });
});

it("R1-07a / C8-I035: saving carries the unreadable entry positions back", async () => {
  snapshot = {
    ...snapshot,
    servers: [view()],
    unreadable_servers: [{ index: 1, code: "mcp_config_invalid", message: "The command is invalid." }],
  };
  await render();
  // The surface states that the entries exist without showing their content.
  expect(container.textContent).toContain("could not be read");
  await clickAria("Expand Notes");
  await act(async () => [...container.querySelectorAll<HTMLInputElement>(".mcp-check input")][0].click());
  expect(nativeClient.saveMcpSettings).toHaveBeenLastCalledWith(
    expect.any(Array),
    "rev-1",
    [{ index: 1 }],
  );
});
