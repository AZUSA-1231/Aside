import type { AgentState, Rect } from "./contracts";

export const MIN_PANEL_WIDTH = 340;
export const MIN_PANEL_HEIGHT = 460;
export const MAX_PANEL_WIDTH = 520;
export const MAX_PANEL_HEIGHT = 900;
export const SIDE_WIDTH_PERCENT = 0.2;

export interface WorkspaceLayout {
  target: Rect;
  agent: Rect;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function calculateSideLayout(workArea: Rect): WorkspaceLayout {
  const preferredAgentWidth = Math.round(workArea.width * SIDE_WIDTH_PERCENT);
  const agentWidth = clamp(
    preferredAgentWidth,
    Math.min(MIN_PANEL_WIDTH, Math.max(1, workArea.width - 1)),
    Math.min(MAX_PANEL_WIDTH, Math.max(1, workArea.width - 1)),
  );
  const targetWidth = Math.max(1, workArea.width - agentWidth);

  return {
    target: {
      x: workArea.x,
      y: workArea.y,
      width: targetWidth,
      height: workArea.height,
    },
    agent: {
      x: workArea.x + targetWidth,
      y: workArea.y,
      width: agentWidth,
      height: workArea.height,
    },
  };
}

export type AgentStateAction =
  | { type: "show"; surface: "side" | "workspace" }
  | { type: "hide" }
  | { type: "set_pinned"; pinned: boolean }
  | { type: "exit_workspace" };

export function applyAgentState(
  state: AgentState,
  action: AgentStateAction,
): AgentState {
  switch (action.type) {
    case "show":
      return { ...state, visibility: "visible", surface: action.surface };
    case "hide":
      return { ...state, visibility: "hidden", surface: "side" };
    case "set_pinned":
      return { ...state, pinned: action.pinned };
    case "exit_workspace":
      return { ...state, surface: "side" };
    default:
      return state;
  }
}
