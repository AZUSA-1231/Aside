# Aside Architecture

Status: living document  
Last reviewed: 2026-09-03
Platform: Windows  
Repository policy: Cycle 1 MVP development stays on `main`

This document contains project-level principles, ownership boundaries, and
technical rules. Cycle-specific behavior and acceptance criteria belong in the
relevant product requirements document.

**2026-10-31 priority note:**
[`RECOVERY-PLAN.md`](./RECOVERY-PLAN.md) is the current sequence: simplify the
frontend, resolve inherited issues, and complete the existing Pi-backed runtime.
External-agent adapters are deferred until at least functional completion of
that runtime, as a separate feature. The window, material and IPC sections below
now describe the shortcut/hidden lifecycle; the source audit and focused checks
are in [`FRONTEND-REVIEW.md`](./FRONTEND-REVIEW.md). The longer-term discussion
in [`PRODUCT-DIRECTION.md`](./PRODUCT-DIRECTION.md) does not require a runtime
rewrite or change current capture, retention, or permission guarantees.

**R1 implementation follow-up:** The current working copy restores automatic
capture, 80/20 tiling and original-window placement restoration through the
existing show/hide lifecycle. Native Acrylic configuration and opaque white
components are implemented. Development checks pass; native desktop observation
and full manual acceptance remain unperformed. Requirements are in
[`design/SUMMONED-SIDEBAR.md`](./design/SUMMONED-SIDEBAR.md), with evidence in
[`FRONTEND-REVIEW.md`](./FRONTEND-REVIEW.md).

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
over that work. The visible surface is a summoned full-height right-hand Side rail.
Summoning automatically arranges eligible maximized or work-area-filling windows
alongside it, without a separate split-mode step. Host context capture and host actions must be fast, bounded, visible,
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
- positioning Aside without rearranging other applications;
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
the application happens to expose UIA. They return a path descriptor that the
runtime resolves into task-local source/output scopes before the first file tool call.
The descriptor is a reference and a workspace hint, not permission: the runtime
canonicalizes and revalidates it, and workspace-scoped tools stay unpublished
until activation. Neither the process-wide working directory nor the durable
Aside session directory is changed by activation.
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

Cycle 8 P0 adds an independent settings control process alongside the
conversation process. Node owns the settings schema, precedence, revision
checking, atomic persistence and redacted snapshots; Tauri supplies separate
settings IPC without requiring provider initialization. Environment overrides
user settings, which override ordinary legacy env values. The conversation,
session store and MCP initialization share one loaded configuration snapshot.
Tauri tracks its revision from `ready`; saving does not change an active run.
P2 activates the default output directory in `runtime_fields`; thinking settings
remain reserved until P3. See
[`cycle-8/plans/P0-settings-foundation.md`](./cycle-8/plans/P0-settings-foundation.md).

P1 adds a Model & API panel that remains available without a ready conversation
runtime. Rust owns Windows Credential Manager access and dedicated key writes;
key readback is status only. Private stdin envelopes carry stored keys to Node,
below inherited environment and above legacy env credentials. Provider catalog
and connection-test logic live in the backend, sharing model selection with the
conversation runtime; React never imports Pi or receives saved key values.

`apply_settings` queues in the conversation protocol until prompt persistence
and workspace operations settle. The candidate keeps the existing session,
messages and persistence cursor. After successful construction, the old emitter
is disabled and MCP/permissions are disposed before new ready events are
forwarded. A failed candidate leaves the old runtime available. Tauri tracks
actual ready revisions and `configuration_status`; React retains conversation
and draft on `runtime_reconfigured`, clearing old permission/tool projections.
The connection test is explicit and sends a minimal model text request without
opening history or tools. See [P1](./cycle-8/plans/P1-api-settings.md).

P2 uses Tauri's system Documents directory resolver for the default `Aside`
output root and passes the same native fallback to both Node processes. The
ordinary configuration precedence still applies. Explicit task workspaces
select output; captures supply a separate read scope, limited to the captured
file or directory. Relative paths belong to output, absolute source paths stay
read-only outside it, and a single captured file cannot be overwritten through
the output scope. No common-ancestor workspace or implicit source copy is used.
The environment routes existing tools without adding an agent tool. It checks
private storage boundaries and plans missing default roots without mkdir until
the first approved write. Results include absolute output paths for native
reveal. The session facade keeps runtime getters live, so same-session rebuilds
preserve validated source/selection state while loading a new default root.
See [P2](./cycle-8/plans/P2-default-workspace.md).

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
Windows, inspect the foreground window, or call host SDKs directly. Capture
stays passive: a Context Plane snapshot can never register, select, or invoke a
tool.

Cycle 5 wires Aside-owned bounded tools, not Pi's coding-agent tools, to a host
workspace. The runtime constructs one per-task execution environment and
publishes only the tools registered for that run. Reads execute directly inside
the resolved workspace; every mutation is prepared, previewed, and revalidated
after a fresh exact-operation decision. The runtime's permission broker, not
the model and not React, is authoritative for that decision. A path descriptor
must not mutate the Aside session directory or the process-wide Node working
directory, and the durable Aside conversation store remains independent of the
active workspace.

Cycle 6 evolves this registry into a common capability boundary: built-in and
user-connected MCP tools enter the same per-task registry and pass through the
same runtime and policy path, with effect, scope, egress, source trust, and
replay policy expressible independently. See the
[Cycle 6 plan](./cycle-6/PLAN.md) for the delivery order.

R4 defines the retained finite development contract as RT-01–11 in
[RECOVERY-PLAN.md](./RECOVERY-PLAN.md). Its automated completion does not imply
product/manual acceptance. MCP classification overrides must match both the
accepted schema digest and server launch fingerprint stored in user-managed
`mcp.json`; missing or changed bindings retain conservative defaults, emit an
existing `runtime_warning`, and still require a fresh decision on every call.
Discovery never approves or persists a binding. The fingerprints do not prove
external behavior or provide a process sandbox. Settings editors, hot reload,
conversation management and manual skill selection remain separate features.

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
surface:    side
pinned:     boolean
material:   acrylic | solid
```

Hidden means the native window is hidden and no resident control is rendered.
Visible uses the current Side presentation. Pin only changes the visible
window's always-on-top state. Native state also owns the pending capture request,
bound host and original WINDOWPLACEMENT. Those stay in Rust; only presentation
state crosses IPC. The runtime's file workspace remains an independent concept.

### Command contract

Native commands should be:

- small and named after product intent;
- typed on both sides of the IPC boundary;
- idempotent where repeated calls are reasonable;
- explicit about failure and fallback behavior;
- independent of React component structure.

The current native command vocabulary is:

```text
get_agent_state()
show_agent()
hide_agent()
toggle_agent()
set_pinned(pinned)
get_active_window_state()
get_active_host()
capture_active_host_context()
move_agent(x, y)
resize_agent(width, height)
runtime_prompt(...)
runtime_cancel(...)
runtime_permission_response(...)
runtime_set_workspace(...)
runtime_clear_workspace(...)
```

Input and result types live in `commands.rs`, `runtime.rs` and the frontend
contracts. `move_agent` and `resize_agent` are retained low-level entry points;
the current surface does not expose manual movement or resize controls. Current
command/event projections and unimplemented controls are listed in the frontend
review, rather than inferred from a historical command proposal.

### Event contract

Events should communicate durable state changes or runtime events:

```text
agent://state-changed
agent://error
host://capture-completed
runtime://event
```

Avoid event names that describe visual animation steps. Animation belongs to
the frontend and must be able to handle skipped or repeated events.

## 5. Window and Workspace Rules

The frameless Tauri window starts hidden. Ctrl + Alt + A binds the original
foreground host and work area and saves a complete WINDOWPLACEMENT for eligible
maximized, work-area-filling or fullscreen windows. Background capture completes
before tiling, show or focus. A generation identifier prevents a cancelled or
superseded capture from opening the panel. Repeating the shortcut during capture
cancels that summon; repeated show calls are idempotent while it is pending.

Eligible hosts use the left 80% and Aside the right 20% of one physical work area,
both full-height. Normal windows keep their existing layout. The next shortcut,
Escape, Hide or close request shares cleanup: hide Aside, restore the original
placement and maximized state, and attempt to return focus. Escape first closes
an open JSON preview. Normal process exit also performs cleanup. Windows foreground
events now retain the latest external window for explicit Capture without hiding
or retiling. Aside's own foreground events do not overwrite it. The invocation
copies and revalidates that target; an unsupported or stale target does not fall
back to the old host. This target is separate from both the immutable restoration
snapshot and the summon-time focus-return target, including for ordinary windows
that were never tiled. The listener retains only latest-window metadata in memory,
and sends no focus event stream or background host content to the runtime.

Window identity is checked before native mutations. A rejected layout or partial
show failure triggers restoration; failed restoration retains its snapshot for
retry and prevents a new layout from replacing it. A closed or stale target is
not replaced by the later foreground window. Layout refusal may fall back to
showing the sidebar with an explicit error after rollback. These are implemented
paths, not evidence that all Windows hosts accept tiling. Forced termination and
OS failure are outside this cleanup guarantee.

Pin only changes always-on-top. Hidden means the actual window is hidden, with
no capsule, hover preview or resident strip. React stays mounted and subscribed;
drafts, staged attachments, permissions and results survive hiding. Completion
and permission events do not show or retile the window. Successfully submitted
attachments are consumed from the staging tray as before. The runtime file
workspace, its root, captured target, authority and lifetime remain independent.

### Logical and physical pixels

Work-area and Win32 geometry use physical pixels; CSS uses logical pixels.
`workspace::side_layout` rounds one 20% physical segment and assigns its exact
complement to the host, without the old logical width clamps. Win32 positioning
accounts for DWM visible-frame insets and recalculates after moving the panel to
the destination monitor. Tests cover complementary segments, negative origins,
large and narrow displays, frame correction and fullscreen candidacy. CSS is
checked down to 256 logical pixels; actual mixed-DPI transitions remain unobserved.

### Current material and corner boundaries

Configuration uses `transparent: true`, `decorations: false`, `shadow: true`,
a transparent WebView background, a Light theme and
`windowEffects.effects: ["acrylic"]`. `App.tsx` loads `plate.css` after
`App.css`; that file now defines a continuous full-window base with opaque
white message bubbles, permission, attachment, input and control surfaces. The
conversation container itself stays transparent, with a shared 12px component
radius and aligned surface widths. Further native rendering experiments are
being handled by the user in a separate project.
There is no oversized desktop-transparent margin or island-gap contract.

After show, `window_corner.rs` requests `DWMWCP_ROUND` and suppresses the DWM
border using `DWMWA_COLOR_NONE`. These are native requests, not a configurable
8px radius or proof of final shadow/corner rendering. Acrylic availability is
checked against the window's DWM backdrop type and system transparency /
high-contrast settings. The `material` presentation state selects one continuous
solid fallback when native Acrylic cannot be confirmed; older systems without
the checked DWM property conservatively get that fallback. CSS also honors
reduced-transparency and forced-colors preferences.

The old proximity module, region silhouettes, acrylic-v1 archive and transparent
plate experiments remain historical references. Browser screenshots of the
current solid fallback establish CSS layout and opacity only, not native Acrylic,
tiling, corners, shadows or mixed-DPI behavior. See
[`FRONTEND-REVIEW.md`](./FRONTEND-REVIEW.md) for development evidence.

### Contextual sidecar rules

The summon target is captured before Aside receives focus and stays bound to
that summon, its initial capture, and layout restoration. A later explicit
Capture instead snapshots the most recently focused external window. Each
captured attachment remains bound to its own source; later focus changes cannot
redirect an in-progress capture or change the original layout restoration target.

Host identity and capability status may be detected automatically. Host content
is staged only through an approved adapter and the summon/capture interaction.
The summon capture completes before layout or focus changes, then opens the
panel; cancelling a pending summon prevents a late result from reopening it.
A captured block is visible to the user, can be removed before submission,
has a bounded lifetime,
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
- bounded workspace read tools once a task workspace is resolved, and
  workspace writes that execute only once after a fresh exact-operation
  permission decision;
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
- Tool arguments, document contents, search results, skill instructions, and
  MCP server annotations are untrusted input. They cannot lower policy, grant a
  capability, or alter trusted runtime metadata.
- Permission is evaluated at execution time from trusted Aside metadata. An
  approved operation is revalidated against the current workspace and target
  before it runs, and no user workspace mutation is replayed across a restart.
- Workspace containment and exact-operation write permission are enforced by
  the runtime, never by the model, the React layer, or a tool description.
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
