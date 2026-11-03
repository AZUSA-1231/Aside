import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SessionPanel from "../src/SessionPanel";
import { nativeClient } from "../src/lib/ipc";
import type { RuntimeSessionSummary } from "../src/lib/contracts";

let root: Root;
let container: HTMLDivElement;
let emit: (event: any) => void;
let sessions: RuntimeSessionSummary[];

const button = (name: string) => [...container.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === name)!;
const ariaButton = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

async function click(name: string) { await act(async () => button(name).click()); }
async function clickAria(label: string) { await act(async () => ariaButton(label).click()); }
async function render(taskRunning = false) {
  await act(async () => root.render(<SessionPanel onClose={() => {}} taskRunning={taskRunning} />));
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sessions = [
    { id: "aside-current", name: "Current work", created_at: 1_700_000_000_000, modified_at: 1_700_000_200_000 },
    { id: "aside-older", name: null, created_at: 1_700_000_000_000, modified_at: 1_700_000_100_000 },
  ];
  vi.spyOn(nativeClient, "runtimeListSessions").mockImplementation(async () => {
    queueMicrotask(() => emit({ type: "sessions_listed", request_id: "list", active_session_id: "aside-current", sessions, warnings: [] }));
  });
  vi.spyOn(nativeClient, "runtimeSwitchSession").mockResolvedValue();
  vi.spyOn(nativeClient, "runtimeRenameSession").mockResolvedValue();
  vi.spyOn(nativeClient, "runtimeDeleteSession").mockResolvedValue();
  vi.spyOn(nativeClient, "onRuntimeEvent").mockImplementation(async (handler) => { emit = handler; return () => {}; });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

it("lists saved conversations and marks the active one", async () => {
  await render();
  await act(async () => { await Promise.resolve(); });
  expect(container.textContent).toContain("Current work");
  expect(container.textContent).toContain("Conversation 2");
  expect(container.textContent).toContain("current");
  // The active conversation is not offered an "Open" action against itself.
  expect(container.querySelectorAll("button").length).toBeGreaterThan(0);
});

it("switches to the selected conversation by id", async () => {
  await render();
  await act(async () => { await Promise.resolve(); });
  const openButtons = [...container.querySelectorAll("button")].filter((entry) => entry.textContent?.trim() === "Open");
  await act(async () => openButtons[0].click());
  expect(nativeClient.runtimeSwitchSession).toHaveBeenCalledWith(
    expect.any(String),
    { sessionId: "aside-older" },
  );
});

it("creates a new conversation without touching the others", async () => {
  await render();
  await act(async () => { await Promise.resolve(); });
  await click("New conversation");
  expect(nativeClient.runtimeSwitchSession).toHaveBeenCalledWith(expect.any(String), { create: true });
  expect(nativeClient.runtimeDeleteSession).not.toHaveBeenCalled();
});

it("renames a conversation and clears an emptied name", async () => {
  await render();
  await act(async () => { await Promise.resolve(); });
  await clickAria("Rename Current work");
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Conversation name"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "   ");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLFormElement>(".session-rename")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  // An empty name is cleared rather than saved as blank text.
  expect(nativeClient.runtimeRenameSession).toHaveBeenCalledWith(expect.any(String), "aside-current", null);
});

it("requires an explicit confirmation before deleting a conversation", async () => {
  await render();
  await act(async () => { await Promise.resolve(); });
  await clickAria("Delete Conversation 2");
  expect(nativeClient.runtimeDeleteSession).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Your files and outputs are not deleted");
  await click("Delete conversation");
  expect(nativeClient.runtimeDeleteSession).toHaveBeenCalledWith(expect.any(String), "aside-older");
});

it("blocks switching and deleting while a task is running", async () => {
  await render(true);
  await act(async () => { await Promise.resolve(); });
  expect(button("New conversation").disabled).toBe(true);
  expect(ariaButton("Delete Conversation 2").disabled).toBe(true);
  expect(container.textContent).toContain("Wait for the current task to finish");
});

it("shows the failure the backend reported for a session request", async () => {
  await render();
  await act(async () => { await Promise.resolve(); });
  await act(async () => { emit({ type: "session_failed", request_id: "rename-1", message: "The selected session no longer exists." }); });
  expect(container.textContent).toContain("The selected session no longer exists.");
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
