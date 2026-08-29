import type { AgentState, Rect } from "./contracts";

export const DEFAULT_PANEL_WIDTH = 420;
export const DEFAULT_PANEL_HEIGHT = 680;
export const MIN_PANEL_WIDTH = 340;
export const MIN_PANEL_HEIGHT = 460;
export const MAX_PANEL_WIDTH = 520;
export const MAX_PANEL_HEIGHT = 900;
export const DISPLAY_MARGIN = 24;

export interface WorkspaceLayout {
  target: Rect;
  agent: Rect;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function calculateFloatingPlacement(
  workArea: Rect,
  panelWidth = DEFAULT_PANEL_WIDTH,
  panelHeight = DEFAULT_PANEL_HEIGHT,
  margin = DISPLAY_MARGIN,
): Rect {
  const width = clamp(panelWidth, 1, Math.max(1, workArea.width));
  const height = clamp(panelHeight, 1, Math.max(1, workArea.height));
  const x = clamp(
    workArea.x + workArea.width - width - margin,
    workArea.x,
    workArea.x + workArea.width - width,
  );
  const y = clamp(
    workArea.y + Math.round((workArea.height - height) / 2),
    workArea.y,
    workArea.y + workArea.height - height,
  );

  return { x, y, width, height };
}

export function calculateWorkspaceLayout(workArea: Rect): WorkspaceLayout {
  const preferredAgentWidth = Math.round(workArea.width * 0.2);
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
  | { type: "show"; surface: "floating" | "workspace" }
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
      return { ...state, visibility: "hidden" };
    case "set_pinned":
      return { ...state, pinned: action.pinned };
    case "exit_workspace":
      return { ...state, surface: "floating" };
    default:
      return state;
  }
}
