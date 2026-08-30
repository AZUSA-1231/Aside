# Aside Architecture

Status: living document  
Last reviewed: 2026-08-29  
Platform: Windows  
Repository policy: Cycle 1 MVP development stays on `main`

This document contains project-level principles, ownership boundaries, and
technical rules. Cycle-specific behavior and acceptance criteria belong in the
relevant product requirements document.

## 1. Product Identity

Aside is a persistent desktop agent for everyday tasks. It is a lightweight
companion that can be summoned at any time, help with short conversations and
small actions, and remain pleasant to keep nearby.

Aside is not:

- a Windows Widget or Desktop Shell integration;
- a coding-focused agent;
- a full office-assistant suite;
- an application-inspection or surveillance layer.

The product should feel present in the user's workspace without taking over
the workspace. The visible surface is an independent right-hand Side rail, with
a temporary Workspace arrangement available for eligible maximized windows.
More powerful desktop behavior must remain optional, explicit, and explainable.

## 2. Architectural Principles

1. **Presence without occupation**: the agent is easy to find and summon, but
   does not permanently cover the user's work.
2. **Small useful moments**: prioritize everyday tasks, suggestions, reminders,
   and short conversations over a large catalogue of workflows.
3. **Explicit control**: visibility, Pin mode, workspace resizing, file access,
   and future automation capabilities require clear user control.
4. **Local-first privacy**: do not inspect or retain other-application content
   unless a separately approved feature establishes that need.
5. **Thin native boundary**: use Tauri APIs first, mature plugins second, and
   the smallest necessary Rust/Windows adapter last.
6. **Stable application contracts**: React and product features depend on
   Aside-owned types and commands, not raw platform APIs or Pi internals.
7. **Reuse the agent core**: Pi supplies the agent foundation; Aside supplies
   the desktop experience, product protocol, and domain tools.
8. **Quiet by default**: background behavior must be predictable, cheap, and
   easy to disable.
9. **Purposeful playfulness**: companion and visual features may create warmth,
   but must not add focus stealing, surveillance, or unnecessary complexity.

## 3. System Shape

```text
React UI
  | typed Tauri invoke/listen calls
  v
Tauri application layer
  | window orchestration, commands, lifecycle
  +--> official global-shortcut plugin
  +--> Tauri window and monitor APIs
  +--> minimal Windows foreground-window adapter
  v
Aside application protocol
  v
agent-runtime workspace
  | Pi adapter, sessions, streaming, tools
  v
pi-agent-core + pi-ai
```

### Frontend

React and TypeScript own presentation and interaction:

- layout, visual states, animation, and input;
- chat rendering and runtime event presentation;
- local UI state and user feedback;
- calls to stable Tauri commands and event listeners.

The frontend must not import Windows APIs, native handles, or Pi agent
classes. It should remain testable with mocked command and event interfaces.

### Tauri application layer

The Rust application layer owns desktop orchestration:

- window creation, visibility, focus, position, size, and decorations;
- global shortcut registration and lifecycle;
- always-on-top state;
- foreground-window and monitor queries;
- workspace snapshot capture, resizing, restoration, and errors;
- translation between native failures and typed application errors.

Tauri commands are orchestration entry points, not a place to put all native
logic. Keep policy and platform operations in their respective modules.

### Windows platform adapter

Windows-specific code is isolated behind a small adapter. It may provide only
the minimum data needed by the product:

- foreground window identity;
- bounds and maximized state;
- monitor identity and work area;
- safe position and size operations.

Raw `HWND` values and Windows-specific structs must not cross the Tauri IPC
boundary. Return sanitized, serializable application data instead.

### Agent Runtime

`agent-runtime` is the only Aside-owned boundary around Pi. It owns:

- Pi agent construction and session lifecycle;
- provider/model configuration;
- streaming, cancellation, completion, and error events;
- tool registration and tool-call lifecycle;
- runtime-level validation and error mapping.

The runtime exposes an Aside-facing protocol. It may use
`@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` internally, but
features and React must not depend on those package details.

Aside does not build a second general-purpose harness. If Pi's core changes,
the adapter absorbs the change where practical.

### Domain tools and data

Domain modules own everyday-task capabilities such as reminders, schedules,
notes, and explicitly approved file actions. They are responsible for:

- typed schemas and strict input validation;
- local persistence and migrations;
- permission checks and confirmations;
- user-visible tool results;
- cancellation and failure behavior.

UI buttons and agent tools must call the same domain operations so they cannot
create divergent business rules or data models.

## 4. State and IPC Rules

Native state is authoritative for native behavior. The frontend renders state
received from Rust and must not infer window truth from animation timing or
local timers.

The core state has independent dimensions:

```text
visibility: hidden | visible
surface:    side | workspace
pinned:     boolean
```

This produces the user-facing modes `HIDDEN`, `SIDE`, and `WORKSPACE`. Pin is a
property of a visible surface, not a replacement for Side or Workspace.

### Command contract

Native commands should be:

- small and named after product intent;
- typed on both sides of the IPC boundary;
- idempotent where repeated calls are reasonable;
- explicit about failure and fallback behavior;
- independent of React component structure.

The initial command vocabulary is expected to include:

```text
show_agent()
hide_agent()
toggle_agent()
set_pinned(pinned)
get_active_window_state()
enter_workspace_mode()
exit_workspace_mode()
get_workspace_state()
```

Names may change as implementation begins, but each command needs a documented
input, result, and failure shape.

### Event contract

Events should communicate durable state changes or runtime events:

```text
agent://visibility-changed
agent://pin-changed
workspace://entered
workspace://exited
workspace://restore-failed
runtime://event
```

Avoid event names that describe visual animation steps. Animation belongs to
the frontend and must be able to handle skipped or repeated events.

## 5. Window and Workspace Rules

The agent window is a normal Tauri window with product-oriented behavior:

- frameless and using the Windows-native corner treatment;
- positionable near the right edge of the active display;
- full-height when visible in Side or Workspace mode;
- focusable on summon;
- optionally always-on-top;
- hidden without terminating the background application.

Workspace Mode is a temporary arrangement of the user's existing windows. It
must follow these rules:

1. Inspect the foreground window before Aside receives focus.
2. Enter Workspace Mode only for a maximized or work-area-sized target.
3. Capture the target identity, original bounds, maximized state, display, and
   enough metadata to validate restoration.
4. Use the target window's monitor work area for the 80/20 arrangement.
5. Place the target on the left and Aside on the right.
6. Restore only the captured target, never whichever window happens to be
   foreground later.
7. Fall back to Side when the target is unsupported or cannot be safely
   changed.

Side is the full-height right rail used whenever Aside is visible without an
active Workspace snapshot. It uses the foreground target's monitor work area
when a target is available, or the cursor display work area for the desktop.
An ordinary foreground window is left unchanged; Aside does not resize or
replace it. Side and Workspace use the same rail geometry.

There is one active workspace snapshot per session. Clear it only after a
successful restore or an explicit unrecoverable failure decision. Recovery
behavior must be considered for normal hide, application exit, target closure,
display changes, and interrupted process shutdown.

## 6. Windows Capability Boundary

Allowed for the core product:

- Tauri window and monitor APIs;
- the official Tauri global-shortcut plugin;
- native always-on-top, focus, position, and size operations;
- minimal foreground-window and maximized-state inspection;
- explicit, narrowly scoped local file access for an enabled domain tool.

Prohibited by default:

- reading the contents of another application;
- keyboard or mouse logging;
- screen capture, OCR, or screen understanding;
- Accessibility tree traversal;
- browser/editor injection;
- Desktop Shell or Explorer replacement;
- arbitrary process control or shell command execution.

Any feature that expands this boundary requires a scope review, a privacy
review, and an explicit architecture update. The React layer never gains
direct access to the expanded capability.

## 7. Security and Privacy Rules

- Product accounts and user authentication are not part of the current
  architecture.
- Provider credentials are separate from product identity and must not enter
  source control, frontend state, or logs.
- Tauri capabilities must be no broader than enabled features require.
- Tool arguments are untrusted input and are validated at the tool boundary.
- File, schedule, window, or external actions require clear confirmation when
  they are destructive, ambiguous, or difficult to reverse.
- Diagnostics must redact prompts, provider output, secrets, and sensitive
  local paths.
- Background behavior needs an explicit settings surface and exit path.
- New sync, telemetry, or remote-tool behavior requires a documented data-flow
  decision before implementation.

## 8. Dependency and Code Organization Rules

1. Prefer official Tauri 2 plugins and existing local helpers.
2. Add a dependency only for a concrete capability or meaningful reduction in
   complexity.
3. Keep Windows-only crates behind `src-tauri` platform modules.
4. Keep Pi dependencies inside `agent-runtime`.
5. Avoid introducing a global event bus or state-management abstraction until a
   real cross-feature need exists.
6. Use stable ownership boundaries instead of creating empty folders or
   speculative interfaces.
7. Keep comments short and explain only non-obvious decisions.

The intended shape is:

```text
aside/
  docs/
    ARCHITECTURE.md
    cycle-1-MVP/
      PRD.md
      PLANS.md
      VERIFICATION.md
      plans/
        P0-foundation.md
        P1-floating-agent.md
        P2-pin-and-workspace.md
        P3-conversation-runtime.md
        P4-stabilization.md
  src/
    components/
    features/
    agent/
    workspace/
    stores/
    lib/
  agent-runtime/
  src-tauri/
    src/
      commands/
      window/
      workspace/
      platform/
```

## 9. Repository Workflow

- The `aside` directory is its own Git repository.
- The neighboring `pi` project is independent and is not tracked by Aside.
- Cycle 1 MVP work is performed on `main`.
- Changes should be small enough to review and should leave the documented
  checks passing at milestone boundaries.
- Architecture changes must update this document before the dependent feature
  is treated as complete.

## 10. Evolution Rule

Aside may grow into a richer companion or a focused desktop utility, but every
new capability must preserve the product identity:

1. State the recurring user problem.
2. Define the smallest required OS and data access.
3. Keep the feature behind a typed product boundary.
4. Define permission, confirmation, disable, and failure behavior.
5. Update the architecture and the cycle-specific PRD before implementation.

Features that require broad inspection, surveillance, Shell integration, or
arbitrary computer control are separate product decisions, not routine
extensions of this architecture.
