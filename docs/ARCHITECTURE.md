# Aside Architecture

Status: living document  
Last reviewed: 2026-09-03
Platform: Windows  
Repository policy: Cycle 1 MVP development stays on `main`

This document contains project-level principles, ownership boundaries, and
technical rules. Cycle-specific behavior and acceptance criteria belong in the
relevant product requirements document.

## 1. Product Identity

Aside is a persistent contextual sidecar for the applications where the user
already works. It is a lightweight companion that can be summoned from the
current foreground application, capture an explicit and bounded view of that
work, and provide help or small actions without making the user switch to a
separate application.

Aside's primary unit of context is the user's current host task, not an
OS-wide activity profile. Foreground-window inspection is a routing and
targeting primitive: it lets Aside identify the host application and capture
the right context before the Aside window takes focus. It does not authorize
unbounded inspection of the desktop.

Aside is not:

- a separate full-size application that requires the user to leave their host;
- a coding-only agent, even though it may assist inside an editor;
- a Windows Widget, Desktop Shell replacement, or general computer-use layer;
- an OS-wide activity-monitoring or surveillance product.

The product should feel attached to the user's current work without taking
over that work. The visible surface is an independent right-hand Side rail,
with a temporary Workspace arrangement available for eligible maximized
windows. Host context capture and host actions must be fast, bounded, visible,
and explainable.

## 2. Architectural Principles

1. **Contextual presence**: Aside appears beside the user's current work and
   does not require a context switch to a separate application.
2. **One-gesture handoff**: the summon path captures the foreground target
   before Aside takes focus and stages eligible host context with minimal delay.
3. **Strategy-selected host context**: target classification selects exactly one
   capture strategy. A strategy may compose reusable transports internally, but
   the router never performs a generic capture and then assembles a specialized
   result afterward.
4. **Explicit and staged capture**: captured context is visible, removable,
   bounded, short-lived, and sent to a provider only as part of a user prompt.
5. **Reversible actions**: model-proposed changes are typed, target-bound,
   previewable, and confirmed before a host is modified.
6. **Thin native boundary**: use Tauri APIs first, mature plugins second, and
   the smallest necessary Rust/Windows adapter last.
7. **Stable application contracts**: React and product features depend on
   Aside-owned types and commands, not raw platform APIs or Pi internals.
8. **Reuse the agent core**: Pi supplies the agent foundation; Aside supplies
   the contextual sidecar experience, product protocol, and host capabilities.
9. **Local-first privacy**: host content is not inspected or retained unless
   an approved adapter and an explicit product action establish that need.
10. **Quiet background behavior**: optional usage insights are aggregated,
    local, cheap, easy to pause, and outside the prompt tool loop.

## 3. System Shape

```text
User's current host application
  | stable target identity and one-shot strategy selection
  v
Tauri application layer
  | typed focus, capture, future action, and window commands
  +--> Focus and host router
  +--> Host strategy registry
       +--> Browser strategy (bounded UIA + browser metadata)
       +--> File/document path strategies (path locator only in the current slice)
       +--> Generic UIA strategy (fallback when no specialized strategy matches)
  +--> Side/Workspace window orchestration
  +--> Optional local Insight subsystem
  v
Aside application protocol
  v
agent-runtime workspace
  | Aside context projection, Pi adapter, sessions, streaming, tools
  v
pi-agent-core + pi-ai

React UI
  | typed Tauri invoke/listen calls
  +--> current host and one-shot capture results
  +--> staged context and action previews
  +--> conversation surface
```

### Frontend

React and TypeScript own presentation and interaction:

- layout, visual states, animation, and input;
- chat rendering and runtime event presentation;
- current host identity, capture results, context chips, and action previews;
- explicit removal, confirmation, cancellation, and recovery interactions;
- local UI state and user feedback;
- calls to stable Tauri commands and event listeners.

The frontend must not identify windows itself or import Windows APIs, native
handles, host SDKs, or Pi agent classes. It renders the host and capability
state received from Tauri and remains testable with mocked command and event
interfaces.

### Tauri application layer

The Rust application layer owns desktop orchestration:

- window creation, visibility, focus, position, size, and decorations;
- global shortcut registration and lifecycle;
- always-on-top state;
- foreground-window and monitor queries;
- workspace snapshot capture, resizing, restoration, and errors;
- the pre-focus target snapshot and host application classification;
- routing capture and future action requests to the matching host strategy;
- permission, target identity, timeout, and stale-target checks at the native
  boundary;
- translation between native failures and typed application errors.

Tauri commands are orchestration entry points, not a place to put all native
logic. Keep host policy, capture policy, action policy, and platform operations
in their respective modules. Tauri does not construct Pi messages or provider
requests.

### Windows platform adapter

Windows-specific code is isolated behind a small adapter. It may provide only
the minimum data needed by the product:

- foreground window identity;
- bounds and maximized state;
- monitor identity and work area;
- safe position and size operations.

The adapter may also provide native primitives required by an approved host
integration, but those primitives remain behind a host-specific interface.
Raw `HWND` values, process handles, and Windows-specific structs must not cross
the Tauri IPC or runtime boundaries. Return sanitized, serializable
application data or an opaque target capability instead.

### Host application strategies

A host strategy translates one application family or fallback class into a stable
Aside-owned contract. It owns:

- matching a captured foreground target to the correct host instance;
- declaring capabilities such as identify, capture, or action;
- choosing and composing the transport used by its own capture method;
- obtaining bounded context through the host's supported integration;
- returning source, timestamp, expiry, sensitivity, and capability metadata;
- preparing and applying typed actions against the captured target.

Browser, messaging, media, and game surfaces generally use the generic bounded
UIA transport as their primary context source. The Browser strategy reuses that
transport inside its own `capture` method and adds only narrow browser metadata
such as URL, selected tab, and title. This is an internal composition detail of
the Browser strategy, not a second router pass.

File-oriented strategies (for example Explorer, PDF, Word, and Excel) prefer a
validated document, item, or directory path. Explorer uses target-bound Windows
Shell automation with bounded UIA fallback; document strategies use their
host-specific metadata locators. They do not capture UIA layout merely because
the application happens to expose UIA. In the current slice they return a path
descriptor that is ready for a future agent workspace handoff; they do not yet
connect that descriptor to Pi tools or change the runtime working directory.
VSCode extension, bridge, and active-editor integration are deferred and its
existing conservative UIA-only attempt remains unchanged.

The separate `tools/host-research-probe.ps1` experiment may read real document
content only after an operator supplies an exact HWND and PID and explicitly
opts into full extraction. It revalidates the same window/process fingerprint,
keeps UIA and Office COM objects inside the probe, and writes local artifacts
outside the provider/session path. Research evidence can inform a later rich
content decision, but it never widens the production attachment contract by
itself.

On Windows, a strategy may consume the shared `uia` transport for explicit,
bounded UI Automation snapshots. The transport owns COM lifecycle, tree
walking, node limits, normalization, and provider diagnostics, while each
strategy owns application-specific matching, composition, and field extraction.
A strategy that uses UIA receives a short-lived `UiaSession` only inside its
capture call; it must not retain UIA elements, COM objects, or window handles.
New application modules register a strategy in the native registry and do not
add application branches to `uia.rs`.

The registry selects one specialized strategy by deterministic priority. If no
specialized strategy matches, it invokes the separate generic UIA fallback. The
fallback is never included as a competing `matches = true` entry, and the
router never merges results from two strategies. A specialized strategy that
matches but fails reports its own bounded error; it does not silently downgrade
to generic output.

The transport is an implementation detail; all strategies expose the same
typed capture and future action boundary. A target with no selected strategy
or no usable UIA surface reports an honest unsupported/unavailable state. Aside never
uses screen scraping, OCR, or unbounded accessibility traversal as a fallback.

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

Cycle 3 formalizes the runtime boundary into three layers:

- a durable Aside session transcript containing conversation messages;
- an Aside-owned flow and turn-context envelope containing bounded, explicit
  text or JSON reference data;
- a provider projection that combines the durable transcript with the active
  envelope at Pi's context transformation boundary.

The turn-context envelope is run-scoped and is not persisted by default. This
is intentional: domain snapshots and desktop state can become stale and must
not silently become conversation memory. The runtime reuses Pi's `Agent` and
agent-loop semantics directly. Pi's current coding-agent-oriented
`AgentHarness` is not a product dependency until its required operation paths
and context assumptions fit this boundary. Aside does not copy Pi's loop,
provider, or session implementation.

Aside does not build a second general-purpose harness. If Pi's core changes,
the adapter absorbs the change where practical.

For host-assisted work, `agent-runtime` receives an Aside-owned captured
context envelope and projects it into Pi's provider context. It does not poll
Windows, inspect the foreground window, or call host SDKs directly. Host action
requests use Aside-defined typed tools or action messages; the Tauri/native
boundary remains authoritative for permissions, target identity, and
execution.

The current Cycle 4 closeout does not wire Pi's coding-agent tools to a host
workspace. A path descriptor may be captured and staged, but it must not mutate
the Aside session directory or the process-wide Node working directory. When
workspace support is enabled later, it must use a per-run/per-session execution
environment supplied to Pi's existing tools; the durable Aside conversation
store remains independent.

### Background insights

Application inventory, foreground duration, and similar signals are an
optional background Insight subsystem, separate from contextual assistance.
They are not Pi tools, are not placed in the default prompt context, and do
not run on the summon-to-response critical path. If enabled, the subsystem
stores only documented local aggregates with an explicit pause, deletion, and
retention policy. Raw window-switch or input-event streams must not be passed
to the agent as a shortcut for understanding the user.

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

Host actions follow the same rule. A model may request a typed action proposal,
but only the host adapter can validate and apply it. The UI and the agent must
share the same preview, confirmation, cancellation, and failure semantics.

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
get_active_host()
capture_active_host_context()
prepare_host_action()
confirm_host_action()
cancel_host_action()
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
host://detected
host://context-staged
host://capture-failed
host://action-preview
host://action-completed
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

### Contextual sidecar rules

The foreground target is captured before Aside receives focus. The target
snapshot binds host capture and later actions to the window the user actually
invoked Aside from; a later foreground window must not silently replace it.

Host identity and capability status may be detected automatically. Host content
is staged only through an approved adapter and the summon/capture interaction.
The panel opens immediately around a one-shot adapter call. A captured block is
visible to the user, can be removed before submission, has a bounded lifetime,
and is not written to the durable conversation by default.

An action must carry an opaque target capability issued by the native layer.
The model cannot invent a path, handle, process id, or target identity. Before
execution, the adapter revalidates the target and returns a preview when the
operation changes host state. Closed, changed, or ambiguous targets fail safe
and leave the host untouched.

## 6. Windows Capability Boundary

Allowed for the core product:

- Tauri window and monitor APIs;
- the official Tauri global-shortcut plugin;
- native always-on-top, focus, position, and size operations;
- minimal foreground-window, process identity, and maximized-state inspection;
- explicitly invoked, bounded context capture through one selected host strategy
  or the generic UIA fallback;
- typed, target-bound host actions with preview and confirmation where needed;
- explicit, narrowly scoped local file access for an enabled domain or host
  adapter;
- optional local aggregate insights with a separate setting and retention
  policy.

Prohibited by default:

- invisible or continuous capture of another application's content;
- keyboard or mouse logging;
- generic screen capture, OCR, or screen understanding;
- unbounded Accessibility tree traversal as a content adapter;
- browser cookies, credentials, passwords, or form contents;
- arbitrary browser/editor injection or unreviewed code execution;
- Desktop Shell or Explorer replacement;
- arbitrary process control or shell command execution;
- raw foreground, input, or window-switch event streams in the agent context.

Any feature that expands this boundary requires a scope review, a privacy
review, an explicit architecture update, and a host-specific capability
decision. The React layer and the Pi runtime never gain direct access to the
expanded capability.

## 7. Security and Privacy Rules

- Product accounts and user authentication are not part of the current
  architecture.
- Provider credentials are separate from product identity and must not enter
  source control, frontend state, or logs.
- Tauri capabilities must be no broader than enabled features require.
- Host context and tool arguments are untrusted input and are validated at
  their respective adapter boundaries.
- A context attachment must identify its source, capture time, expiry, and
  sensitivity before it can be projected to a provider.
- Host changes require a clear preview and confirmation when they are
  destructive, ambiguous, or difficult to reverse.
- Captured host content is ephemeral by default and must not enter session
  history or background insights without a separate product decision.
- Diagnostics must redact prompts, provider output, secrets, and sensitive
  local paths.
- Background insight behavior needs an explicit settings surface, pause action,
  deletion path, and retention policy.
- New sync, telemetry, or remote-tool behavior requires a documented data-flow
  decision before implementation.

## 8. Dependency and Code Organization Rules

1. Prefer official Tauri 2 plugins and existing local helpers.
2. Add a dependency only for a concrete capability or meaningful reduction in
   complexity.
3. Keep Windows-only crates behind `src-tauri` platform modules.
4. Keep host adapters behind the Tauri/native or approved companion-integration
   boundary; do not call Windows APIs from React or `agent-runtime`.
5. Keep Pi dependencies inside `agent-runtime`.
6. Avoid introducing a global event bus or state-management abstraction until a
   real cross-feature need exists.
7. Use stable ownership boundaries instead of creating empty folders or
   speculative interfaces.
8. Keep comments short and explain only non-obvious decisions.

The intended shape is:

```text
aside/
  docs/
    ARCHITECTURE.md
    cycle-4-contextual-sidecar/
      PRD.md
      PLAN.md
      ISSUES.md
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
  shared/
    context-limits.json       # shared cross-layer context budgets
  src-tauri/
    src/
      commands.rs
      context.rs       # one-shot capture boundary
      uia.rs            # shared Windows UI Automation transport
      chromium_uia.rs  # Chromium host strategy
      platform.rs
      runtime.rs
      workspace.rs
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
2. Define whether it is host context, a host action, or a background insight.
3. Define the smallest required host and OS access, with a capability matrix.
4. Keep the feature behind a typed product boundary and target identity.
5. Define capture consent, action confirmation, expiry, retention, disable, and
   failure behavior.
6. Update the architecture and the cycle-specific PRD before implementation.

Features that require broad inspection, surveillance, broad Shell integration,
or arbitrary computer control are separate product decisions, not routine
extensions of this architecture. The read-only, target-bound Explorer locator
is a narrow metadata transport; Explorer actions remain out of scope. The Cycle
4 contextual sidecar boundary is specified in
[its PRD](./cycle-4-contextual-sidecar/PRD.md).
