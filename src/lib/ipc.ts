import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AgentState, NativeError, RuntimeEvent } from "./contracts";

const initialPreviewState: AgentState = {
  visibility: "visible",
  surface: "side",
  pinned: false,
};

let previewState = initialPreviewState;
let previewRuntimeRequest: string | null = null;
const previewRuntimeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const previewRuntimeListeners = new Set<(event: RuntimeEvent) => void>();

export function isDesktopRuntime(): boolean {
  return Boolean(
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "The native operation could not be completed.";
}

export function toNativeError(
  error: unknown,
  operation: string,
  recoverable = true,
): NativeError {
  if (
    typeof error === "object" &&
    error !== null &&
    "operation" in error &&
    "message" in error
  ) {
    const candidate = error as Partial<NativeError>;
    return {
      operation: candidate.operation ?? operation,
      recoverable: candidate.recoverable ?? recoverable,
      message: candidate.message ?? errorMessage(error),
    };
  }

  return { operation, recoverable, message: errorMessage(error) };
}

function emitPreviewRuntime(event: RuntimeEvent): void {
  for (const listener of previewRuntimeListeners) listener(event);
}

function updatePreviewState(next: AgentState): AgentState {
  previewState = { ...next };
  return { ...previewState };
}

async function command<T>(name: string, payload?: Record<string, unknown>): Promise<T> {
  if (!isDesktopRuntime()) {
    throw new Error(`The ${name} command is only available in the desktop app.`);
  }
  return tauriInvoke<T>(name, payload);
}

async function previewCommand(action: (state: AgentState) => AgentState): Promise<AgentState> {
  return updatePreviewState(action(previewState));
}

export const nativeClient = {
  getAgentState: async (): Promise<AgentState> => {
    if (!isDesktopRuntime()) return { ...previewState };
    return command<AgentState>("get_agent_state");
  },

  showAgent: async (): Promise<AgentState> => {
    if (!isDesktopRuntime()) {
      return previewCommand((state) => ({ ...state, visibility: "visible" }));
    }
    return command<AgentState>("show_agent");
  },

  hideAgent: async (): Promise<AgentState> => {
    if (!isDesktopRuntime()) {
      return previewCommand((state) => ({ ...state, visibility: "hidden" }));
    }
    return command<AgentState>("hide_agent");
  },

  toggleAgent: async (): Promise<AgentState> => {
    if (!isDesktopRuntime()) {
      return previewCommand((state) => ({
        ...state,
        visibility: state.visibility === "visible" ? "hidden" : "visible",
      }));
    }
    return command<AgentState>("toggle_agent");
  },

  setPinned: async (pinned: boolean): Promise<AgentState> => {
    if (!isDesktopRuntime()) {
      return previewCommand((state) => ({ ...state, pinned }));
    }
    return command<AgentState>("set_pinned", { pinned });
  },

  exitWorkspace: async (): Promise<AgentState> => {
    if (!isDesktopRuntime()) {
      return previewCommand((state) => ({ ...state, surface: "side" }));
    }
    return command<AgentState>("exit_workspace");
  },

  moveAgent: async (x: number, y: number): Promise<AgentState> => {
    if (!isDesktopRuntime()) return { ...previewState };
    return command<AgentState>("move_agent", { x, y });
  },

  resizeAgent: async (width: number, height: number): Promise<AgentState> => {
    if (!isDesktopRuntime()) return { ...previewState };
    return command<AgentState>("resize_agent", { width, height });
  },

  startDragging: async (): Promise<void> => {
    if (isDesktopRuntime()) await getCurrentWindow().startDragging();
  },

  runtimePrompt: async (requestId: string, text: string): Promise<void> => {
    if (isDesktopRuntime()) {
      await command<void>("runtime_prompt", { requestId, text });
      return;
    }

    previewRuntimeRequest = requestId;
    emitPreviewRuntime({ type: "run_started", request_id: requestId });
    const response =
      "Preview mode is ready. Start the desktop app with a configured provider to use a live Pi conversation.";
    let offset = 0;
    const emitNext = (): void => {
      if (previewRuntimeRequest !== requestId) return;
      if (offset >= response.length) {
        previewRuntimeRequest = null;
        emitPreviewRuntime({ type: "completed", request_id: requestId });
        previewRuntimeTimers.delete(requestId);
        return;
      }
      const delta = response.slice(offset, offset + 4);
      offset += delta.length;
      emitPreviewRuntime({ type: "text_delta", request_id: requestId, delta });
      const timer = setTimeout(emitNext, 24);
      previewRuntimeTimers.set(requestId, timer);
    };
    emitNext();
  },

  runtimeCancel: async (requestId: string): Promise<void> => {
    if (isDesktopRuntime()) {
      await command<void>("runtime_cancel", { requestId });
      return;
    }
    const timer = previewRuntimeTimers.get(requestId);
    if (timer) clearTimeout(timer);
    previewRuntimeTimers.delete(requestId);
    if (previewRuntimeRequest === requestId) {
      previewRuntimeRequest = null;
      emitPreviewRuntime({ type: "cancelled", request_id: requestId });
    }
  },

  onAgentState: async (handler: (state: AgentState) => void): Promise<() => void> => {
    if (!isDesktopRuntime()) return () => undefined;
    return tauriListen<AgentState>("agent://state-changed", ({ payload }) =>
      handler(payload),
    );
  },

  onNativeError: async (handler: (error: NativeError) => void): Promise<() => void> => {
    if (!isDesktopRuntime()) return () => undefined;
    return tauriListen<NativeError>("agent://error", ({ payload }) =>
      handler(payload),
    );
  },

  onRuntimeEvent: async (handler: (event: RuntimeEvent) => void): Promise<() => void> => {
    if (!isDesktopRuntime()) {
      previewRuntimeListeners.add(handler);
      return () => previewRuntimeListeners.delete(handler);
    }
    return tauriListen<RuntimeEvent>("runtime://event", ({ payload }) =>
      handler(payload),
    );
  },
};
