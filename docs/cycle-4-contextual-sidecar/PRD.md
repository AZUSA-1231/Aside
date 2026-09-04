# Cycle 4 Contextual Sidecar Product Requirements

Status: complete (2026-09-04); Pi workspace wiring and rich host integrations
remain deferred
Platform: Windows desktop  
Predecessor: [Cycle 3 Pi Implementation](../cycle-3-pi-implementation/PRD.md)

This cycle defines Aside as a contextual sidecar for the applications where
the user already works. It extends the Cycle 3 Pi-backed conversation runtime
with a typed foreground-host handoff, explicit context capture, and a safe seam
for host actions. It does not turn Aside into an OS-wide monitoring product.

The long-lived ownership and privacy rules live in the
[Architecture](../ARCHITECTURE.md). This document defines the Cycle 4 product
behavior, scope, and acceptance criteria. Implementation order and execution
records are intentionally not part of this document; the single execution order
is recorded in the [Closeout Plan](./PLAN.md).

## 1. Objective

Make Aside feel like a natural extension of the user's current application.
The user should be able to summon a compact Side rail from a browser, Windows
Explorer, VSCode, or a PDF reader, have Aside identify the current host, stage
the relevant bounded context or validated path descriptor, and keep the
conversation usable without copying, pasting, opening a second full-size
application, or manually explaining where they are. Rich file assistance is
enabled only when a later workspace integration is available.

Host actions, browser visual capture, and Pi coding-agent workspace wiring are
future capabilities. This closeout only establishes the typed boundaries that
keep those capabilities possible without making them part of the current
capture path.

For Chromium browsers, Windows UI Automation (UIA) is the default capture
transport. The Browser strategy owns the composition of that shared transport
with browser-only metadata. A bounded visual capture setting may be added in a
later scope; it is not shipped or required for this closeout.

## Closeout decision (2026-09-03)

Cycle 4 closes on one coherent strategy-selection and path-discovery boundary.
The router first selects exactly one specialized strategy by stable application
identity and deterministic priority. Only that strategy is executed. A strategy
may reuse the shared UIA transport internally; the router never performs a
generic capture and then assembles a specialized result.

Browser is a specialized strategy whose own capture method composes the generic
bounded UIA snapshot with narrow browser metadata such as URL, selected tab, and
title. Applications without a specialized strategy use the generic UIA strategy
as a fallback, so ordinary UIA-exposing surfaces such as messaging, media, and
game interfaces remain useful.

File-oriented strategies (VSCode, Explorer, PDF, Word, and Excel where a safe
locator is available) prioritize locating a document, item, or workspace path.
They do not feed UI layout to the agent just because the host exposes UIA. This
closeout returns a validated path descriptor that is ready for a future Pi
workspace handoff. It does not yet connect Pi's coding-agent tools, change the
runtime working directory, or copy file contents into prompt context.

The existing Aside session directory and conversation transcript are separate
from a future host workspace. A later workspace integration must replace the
per-run execution root without using `process.chdir()` or moving durable session
storage.

The central product loop is:

```text
User works in a host application
  -> user invokes Aside's existing summon shortcut
  -> Aside snapshots the foreground target before taking focus
  -> Aside identifies the host and stages eligible context
  -> user asks a question in the Side rail
  -> Pi reasons over the staged context
  -> Aside shows an answer using the staged reference context
  -> future host actions, if enabled, use a separate typed preview/confirmation path
```

## 2. User Problem

The current Cycle 3 runtime can hold a conversation, but it does not know
which application the user is working in or what task is currently visible.
The user must break flow to copy a URL, describe a folder, paste a code
selection, or explain which PDF page is open.

Aside should remove that coordination cost while keeping the host application
in control of its own content. The summon gesture is the handoff point; it is
not a license for Aside to continuously inspect the desktop.

## 3. Primary Scenarios

### 3.1 Browser assistance

The user is reading a page, invokes Aside, and asks for a summary or an answer
about the current page. The Browser strategy identifies the browser instance,
performs the generic bounded UIA capture inside its own method, and adds the
selected tab, page title, and sanitized URL. The semantic view is built from
user-facing node roles, names, and screen bounds; it does not include a raw
document text range. Browser visual capture remains a future opt-in feature and
is not part of this closeout.

### 3.2 Explorer assistance

The user is working in Windows Explorer and invokes Aside. The Explorer
strategy locates and validates the current directory and selected item paths.
The result is a path descriptor for a future agent workspace handoff; this
closeout does not read file contents or perform file actions.

### 3.3 VSCode assistance (deferred)

VSCode is a deferred host integration for this closeout. The existing
conservative UIA-only path attempt remains unchanged, but Aside does not add an
extension, named-pipe/localhost bridge, or active-editor integration here. A
future implementation must prove per-window binding before promoting workspace
or active-file descriptors.

### 3.4 PDF reader assistance

The user is reading a PDF, Word document, or spreadsheet and invokes Aside.
The document strategy identifies and validates the current document path when
the host exposes a reliable locator. The path is returned as a future
workspace/file target; document parsing, selected-text capture, and
reader-specific actions are deferred.

### 3.5 Unsupported host fallback

The user invokes Aside from an unsupported application. The Side rail appears
with ordinary conversation available. If the window exposes a usable bounded UIA
surface, the generic UIA strategy provides a one-shot reference snapshot. If UIA
is unavailable or yields no usable data, Aside reports an honest unavailable
state without guessing from a title or reading pixels.

## 4. Scope

### Included

- Preservation of the Cycle 2 Side rail, summon shortcut, focus behavior, and
  one-window lifecycle.
- A foreground target snapshot taken before Aside receives focus, containing a
  sanitized host identity and an opaque native target capability.
- Host strategy selection based on stable application identity and deterministic
  priority, rather than window title matching alone. Exactly one strategy is
  executed for each target.
- An Aside-owned host strategy contract for identification, capture, and future
  action capabilities.
- A reusable bounded UIA transport and a generic UIA strategy for applications
  without a specialized strategy.
- A Browser strategy that composes the generic UIA transport internally and adds
  browser identity, selected-tab metadata, active URL, and title.
- Path-only strategies for Explorer and document applications (PDF, Word, and
  Excel where a reliable locator is available), returning validated path
  descriptors without reading file contents. VSCode bridge work is deferred;
  its existing conservative UIA-only attempt is unchanged.
- A future-ready workspace target contract that can later be mapped to Pi's
  existing coding-agent tools, without wiring those tools in this closeout.
- A one-shot capture result that stages bounded context without introducing a
  long-lived host-state lifecycle or blocking the prompt surface.
- A compact, user-visible representation of the current host and staged
  context, including source and expiry information sufficient for removal or
  cancellation.
- Integration with the existing Cycle 3 Aside turn-context and Pi provider
  projection. Host context remains reference data, not a system instruction.
- Clear degradation when a strategy or transport is missing, permission is
  unavailable, the host changes, or the captured context expires.

### Host capability matrix

| Host | Cycle 4 context target | Action boundary |
| --- | --- | --- |
| Browser | Browser identity, selected-tab metadata, active URL/title, and a compact UIA semantic tree of node roles, names, and bounds | No browser mutation, credentials, cookies, or form data |
| Windows Explorer | Current directory and selected item paths as validated path descriptors | No file action or content read in this closeout |
| VSCode | Existing conservative UIA-only path attempt; bridge integration deferred | No editor action or content read in this closeout |
| PDF, Word, Excel | Current document path when a reliable locator is available | No document parsing or mutation in this closeout |
| Other application | Sanitized foreground identity plus a bounded generic UIA snapshot when available | No action capability |

### Explicitly not included

- Application inventory, usage duration, or other background behavior analysis
  as part of the prompt or Pi tool loop. Those belong to a separate optional
  Insight subsystem.
- Continuous polling of the foreground application or automatic capture of
  every application the user visits.
- Continuous or monitor-wide screen capture, OCR, or generic screen
  understanding.
- Browser visual capture, screenshots, and image attachments in the closeout
  slice. They remain a separate future capability.
- Generic UIA traversal that is unbounded, automatic, or performed outside the
  one-shot strategy selected for the invocation target. The bounded generic UIA
  strategy is explicitly included as the fallback for this cycle.
- Browser passwords, cookies, credentials, form contents, or unrestricted DOM
  extraction.
- Raw UIA `TextPattern` document ranges, visible ranges, text-selection ranges,
  character counts, name/value lengths, or diagnostic hashes in agent context.
- Universal content extraction from arbitrary PDF readers, Word, or Excel
  documents.
- Pi coding-agent workspace activation and registration of coding-agent tools.
- File content reads, arbitrary shell commands, process control, code execution,
  or computer-use automation.
- Silent host changes, background file changes, or an action that is not bound
  to the target from which the user invoked Aside.
- A session browser, cloud sync, multi-user host state, or automatic promotion
  of captured host context into long-term memory.

## 5. Interaction Model

### 5.1 Summon and capture

The existing summon shortcut remains the primary entry point. Aside records
the foreground target before showing or focusing its own window. For a host
with an enabled strategy and an already-approved low-risk capture capability,
the summon gesture both opens the rail and stages the default context.

If a host requires a first-time permission or an explicit deeper capture, the
rail still opens immediately and presents one clear capture action. Aside must
not wait for a slow extension response before becoming usable and must not
silently broaden permissions to preserve the appearance of speed.

The native router resolves the specialized strategy before any capture work. A
Browser match invokes only the Browser strategy, whose method may call the
shared UIA transport and then add browser metadata. A VSCode, Explorer, or
document match invokes only its path strategy. When no specialized strategy
matches, the router invokes the bounded Generic UIA strategy. A specialized
capture failure is reported as that strategy's failure; it is not silently
replaced by a second generic result.

When Aside is already visible in Workspace mode, its `Capture` button reuses
the split host window and performs another one-shot UIA query without leaving
or reopening Workspace. Each successful click appends another attachment
until the aggregate prompt limit is reached. In ordinary Side mode, an
explicit capture may briefly hide Aside so the current foreground host can be
queried, then restores the rail; neither path creates a host-state manager.

### 5.2 Staged context

Captured host context is an ordered collection of attachments for the current
task. Each successful summon or capture click adds one bounded attachment, so
the user can combine context from several windows or applications without
dragging files or copying information between them. The UI shows each source
host and a compact summary before the prompt is submitted. The user can remove
an individual attachment, cancel a capture, or continue with no context.

When a path descriptor is present, the attachment preview shows the host,
resource role, and validated path. The descriptor is reference metadata for a
future workspace handoff; it is not a file copy and does not cause the runtime
to read or modify the path in this closeout.

The combined staged context must remain within the Cycle 3 prompt/context
limits. If another capture would exceed the limit, Aside rejects that new
attachment with a recoverable capacity message and keeps the existing
attachments unchanged; it does not silently replace, truncate, or discard
earlier context. Each capture has a bounded size and expiry, and the
collection is discarded when the current task ends unless a future product
feature explicitly chooses another retention policy.

For inspection and manual verification, P1 also writes each successful
capture as an Aside-owned JSON artifact below the application's local data
directory. This artifact is separate from conversation history and is not
automatically reattached after submission or restart. The attachment UI offers
a compact in-panel JSON preview and a resource-manager reveal action; it does
not launch an external JSON editor by default. The stored representation keeps
the outer structure readable while placing each semantic `nodes` tuple on one
line.

### 5.3 Answer and deferred action

The agent may answer using the staged reference context. Host actions and Pi
coding-agent file mutations are outside this closeout. A future action path must
remain typed, target-bound, previewed, confirmed, and revalidated immediately
before execution.

### 5.4 Focus and target races

Aside must retain the invocation target even after its own rail is focused. A
later foreground-window change must not redirect an in-flight capture or action
to another application. If the original target closes, changes identity, or
cannot be validated, Aside fails safe and leaves the new target untouched.

## 6. Functional Requirements

### FR-4.1 Sidecar invocation

The existing summon shortcut must continue to show, focus, hide, and toggle
the single Side rail. Invoking it from a supported or unsupported host must not
create a second Aside window or force the user into a separate full-size
application.

### FR-4.2 Pre-focus target snapshot

Before Aside receives focus, the native layer must capture a sanitized target
snapshot containing, when available:

- an opaque target identity and process/application identity;
- the target monitor and window state;
- the host classification result and strategy capability state;
- a native-held opaque capability used to revalidate later operations.

Raw window handles, process handles, native structs, and credentials must not
cross the Tauri or runtime boundary.

### FR-4.3 Host classification

Aside must classify the invocation target using a stable application identity
and an ordered strategy registry. The registry selects one specialized strategy
by deterministic priority; ties are an explicit ambiguity. If no specialized
strategy matches, it selects the Generic UIA strategy as a separate fallback.
The fallback is not a competing `matches = true` entry. Classification must
distinguish browser, Explorer, VSCode, document, generic, and unavailable host
states without guessing from a title or reading pixels as a substitute for a
validated path.

### FR-4.4 Host strategy contract

Each strategy must declare and enforce its own capabilities. The common contract
must cover:

- target matching and capability discovery;
- deterministic priority and one-strategy selection;
- explicit context capture with bounded output;
- source, capture time, expiry, and sensitivity metadata;
- optional validated path/workspace descriptors;
- cancellation, timeout, stale-target, permission, and failure results.

A path/workspace descriptor is a small reference object, not a file payload:

```json
{
  "role": "workspace_root | active_file | directory | selected_item | document",
  "path": "C:/a/canonical/absolute/path",
  "kind": "file | directory"
}
```

The locator must return an absolute, canonical path, validate its type and
existence at capture time, and enforce the shared length and character limits.
The descriptor contains no file bytes, native handles, credentials, or implicit
permission to access the resource. A later workspace integration may use the
same descriptor as its execution-root input.

The strategy transport may be the shared UIA module, a native shell/document
API, or a future companion integration. A strategy may compose transports only
inside its own capture method. The transport must not change the
Aside-owned product contract.

### FR-4.5 Capture semantics

Capture must be user-initiated through the summon/capture interaction. The
strategy may stage low-risk default context when permission has already been
granted, but restricted content requires an explicit capability decision.
Capture is one-shot and must not create a background host-state lifecycle. The
initial Side rail remains usable while a strategy call is being completed.

Each successful capture appends an attachment to the current task. The runtime
must validate the combined attachment projection and reject oversized,
malformed, expired, or unsupported blocks before a provider call. Appending is
atomic: when the new attachment would exceed the aggregate Cycle 3 context
limits, the new attachment is rejected and existing attachments remain
unchanged. Cycle 4 inherits the Cycle 3 context limits unless a later
architecture decision changes them.

For a target selected by the Browser strategy, the strategy performs the
bounded UIA capture and browser metadata composition itself. For a target
selected by a path strategy, the strategy performs path discovery and validation
itself. For an unrecognized target, the Generic UIA strategy performs one
bounded snapshot. The router never runs two strategies for one capture and never
assembles their outputs after the fact.

### FR-4.6 Provider projection and isolation

The host attachment collection must be projected through the existing Aside
context boundary as one ordered set of untrusted reference data. It must not
become a system prompt, tool instruction, or coding-agent repository context.
The same collection may be used by provider turns caused by one request, but
it must not be duplicated or leak into a later request.

Captured host content, native target capabilities, transport credentials, and raw
host payloads must not be persisted in the durable conversation by default.
Session history may retain the user's prompt and the assistant's finalized
response according to Cycle 3 policy, but not an implicit copy of the host
attachment.

Path descriptors are reference metadata and must be validated before staging.
They may be shown to the user and carried across the native boundary for a
future workspace handoff, but they are not file contents, native handles, or
implicit permission to read or mutate the path. React and Pi must not receive
raw native target objects.

### FR-4.7 Browser strategy

The Browser strategy must expose only the declared browser capability. Its
default transport is a one-shot Windows UIA query against the invocation
window. At minimum it must identify the browser, selected tab, active URL and
title when the user invokes contextual assistance. It must also normalize the
selected page `Document` into a compact semantic tree when the browser exposes
that UIA surface. The default tree keeps only the node role, non-empty node
`Name`, and a valid screen bounding rectangle. It must not use clipboard
simulation or a raw `TextPattern.DocumentRange` to obtain page text.

For this purpose, UIA `Name` is treated as the accessible display label of a
node, not as an arbitrary text source. The normalizer must start from the page
`Document`, discard browser chrome and empty layout containers, discard nodes
marked `offscreen` when that property is available, and normalize whitespace.
An accessible name is not guaranteed to be literal rendered glyphs (for
example, an icon button may expose an `aria-label`), so the result is described
as semantic node names rather than a transcription of every visible character.
Screen bounds are included as `x`, `y`, `width`, and `height` so the agent can
reason about approximate control placement; a page text range is not
serialized as a second text source.

The product-facing shape is column-oriented and intentionally small:

```json
{
  "fields": ["role", "name", "bounds"],
  "nodes": [
    ["document", "GitHub", {"x": 1857, "y": 120, "width": 1920, "height": 900}],
    ["link", "THU-MAIC/OpenMAIC", {"x": 1857, "y": 260, "width": 210, "height": 24}],
    ["listitem", "Open pull requests", {"x": 1857, "y": 300, "width": 240, "height": 32}]
  ]
}
```

Browser identity, page title, and sanitized URL remain attachment metadata;
they are not repeated as arbitrary node properties. Character counts,
`TextPattern` samples, visible-range text, automation IDs, pattern
diagnostics, and hashes are internal diagnostics or native extraction data and
must be removed before provider projection. The implementation still measures
serialized byte size internally to enforce context limits; the measurement is
not emitted as context.

The browser strategy may later gain an explicitly approved visual capability,
but visual capture, OCR, DOM extraction, CDP control, browser automation, and
background capture are outside this closeout.

The strategy must not expose passwords, cookies, auth tokens, form contents, or
unbounded browsing history. Failure to connect to an extension or CDP endpoint
must not disable the UIA path; those transports remain optional enhancements
for browser surfaces that UIA cannot represent.

### FR-4.8 Explorer path strategy

The Explorer strategy must identify the current directory and selected items
without requiring the user to paste a path. It must canonicalize and validate
each returned path, identify whether it is a file or directory, and stage only
the bounded path descriptor in this closeout. File contents and file actions are
deferred.

### FR-4.9 VSCode path strategy (deferred)

The VSCode workspace/active-editor locator is deferred from this closeout. If
the feature is resumed, an approved extension or bridge must identify and
validate the target window before staging workspace-root, active-file, or
resource descriptors. Editor layout, selection, diagnostics, file content, and
edits remain out of scope.

### FR-4.10 Document path strategy

The document strategy covers PDF, Word, and Excel applications when a reliable
current-document locator is available. It must validate the document path and
stage it as a file resource descriptor. Parsing, selected-text capture, OCR,
screenshots, and mutation are deferred. If no reliable locator exists, the
strategy reports unavailable rather than inferring a path from an arbitrary
window title.

### FR-4.11 Future host action boundary

Host actions are outside this closeout. When enabled in a later scope, Pi tool
execution may request a typed host action, but the model cannot execute native
operations directly. The action path remains:

```text
Pi action request
  -> Aside validates schema and capability
  -> native adapter revalidates target
  -> UI shows preview and requests confirmation
  -> native adapter applies the operation
  -> runtime receives a sanitized result
  -> Pi continues or reports the result
```

No host action is required for the Cycle 4 closeout. A later action slice must
complete one low-risk, reversible operation end to end before exposing broader
mutations.

### FR-4.12 Runtime and protocol integration

The Tauri/runtime boundary must carry Aside-owned host identity, one-shot
capture results, path/workspace descriptors, context attachments, and typed
future-capability status. React must not construct provider messages, native
handles, or Pi tool calls. Existing Cycle 3 streaming, cancellation, session,
and error behavior must remain intact. Browser visual blocks, host-action
previews, and Pi coding-agent tools are deferred payloads and are not required
on this boundary in the closeout slice.

### FR-4.13 Background insight separation

Application lists, usage duration, and similar signals must not be registered
as contextual-assistance tools in this cycle. If a local background collector
exists in a later cycle, its aggregate output must use a separate store and
explicit settings. It must not run as a hidden prerequisite for summon or
prompt completion.

### FR-4.14 Failure and fallback behavior

| Operation | Required response |
| --- | --- |
| Foreground lookup | Open Aside with ordinary conversation or a clear unavailable state; never act on an unknown target |
| Host classification | Show the selected specialized strategy and capabilities, or invoke the bounded Generic UIA fallback when no specialized strategy matches |
| Specialized strategy capture | Keep the Side rail usable, show the strategy result or a recoverable strategy-specific error, and do not run a second strategy after a match fails |
| Generic UIA capture | Return one bounded semantic snapshot when UIA is usable; otherwise report unavailable without guessing from a title or reading pixels |
| Path discovery | Show a validated path descriptor when a reliable locator exists; report locator-unavailable when it does not and never infer a path from an arbitrary title |
| Context capture | Keep the Side rail usable, show the result or a recoverable error, and preserve any valid partial capability without inventing content |
| Permission denied | Explain the missing capability and continue without the restricted context |
| Provider request | Preserve the user prompt and keep the staged context from leaking into later requests |
| Host target closes or changes | Cancel or reject the capture and leave the new target untouched |
| Future host action fails | Show a sanitized result, do not claim success, and keep the preview/history state coherent; host actions are not shipped in this closeout |
| Strategy or transport is unavailable | Degrade to the next valid product state (Generic UIA only when no specialized strategy matched, otherwise an honest unavailable/error state) and keep the runtime alive |

### FR-4.15 Deferred browser visual-capture setting

The previously considered local setting `browser_visual_capture_enabled` is a
future capability, not a Cycle 4 closeout requirement. No setting, image
capture API, or visual attachment is enabled by the current implementation.
If this capability is resumed later, its contract remains:

- `false` means a browser capture acquires no pixels and sends only the UIA
  attachment blocks permitted by the Browser strategy.
- `true` means each explicit browser capture acquires one bounded image from
  the invocation browser window and packages it with the UIA blocks as one
  ordered attachment before provider projection.
- The setting applies only to Chromium browser capture and has no effect on
  Explorer, VSCode, PDF-reader, unsupported-host, or background behavior.
- Turning it on does not grant permission to capture the monitor, another
  browser window, a different tab, clipboard data, or browser storage.
- The setting must be visible to the user, locally persisted, and applied only
  on a later capture click. It must not itself initiate capture.
- If image capture is unsupported, denied, protected, stale, or over budget,
  Aside keeps valid UIA context and presents a recoverable visual status.

## 7. Non-Functional Requirements

- The existing shortcut-to-visible-panel path remains immediate. Foreground
  snapshot and host classification should complete within 100 ms at the 95th
  percentile on a normal supported Windows machine.
- The panel must become visible without creating a host-state manager or
  polling loop. A capture is a bounded one-shot operation whose result is
  staged in the current prompt.
- A previously approved low-risk capture should feel like one continuous user
  action: summon, context staged, prompt entry. No copy/paste should be
  required.
- Context size, content type, lifetime, and provider projection remain bounded
  and deterministic. A path descriptor is metadata only; this slice never
  expands it into file content or an implicit tool request.
- Every capture is associated with one invocation target. A late capture result
  may add its own validated attachment to the still-active composer, but it
  cannot overwrite or remove another attachment or redirect to a newer target.
- Strategy or transport failure, timeout, or crash must not terminate the
  Tauri shell or Pi runtime.
- Host capabilities, strategy selection, path descriptors, and staged data must
  be testable with deterministic faux strategies. Tests must cover capture
  isolation, stale-target rejection, deterministic priority, no cross-strategy
  merging, path validation, and Generic UIA fallback behavior.
- Existing Cycle 2 window, shortcut, Pin, Side, and Workspace behavior remains
  unchanged.

## 8. Acceptance Criteria

| ID | Scenario | Expected result |
| --- | --- | --- |
| C4-01 | Invoke Aside from a supported browser | The target is captured before Aside takes focus; the rail appears immediately and shows the browser capability state |
| C4-02 | Capture browser identity, selected-tab metadata, title, and the normalized UIA semantic tree repeatedly | Each bounded capture is visible as an ordered staged attachment, all retained attachments reach the current provider request within the aggregate limit, and they are absent from a later request unless captured again |
| C4-03 | Invoke Aside from Windows Explorer | The current directory and selected item paths are identified and validated without manual path entry; file contents and actions remain uncaptured |
| C4-04 | Invoke Aside from a target matching more than one specialized strategy | Deterministic priority selects exactly one strategy; no generic result or second specialized result is merged into the attachment |
| C4-05 | Invoke Aside from VSCode (deferred) | No new VSCode extension, bridge, or active-editor integration is delivered in this closeout; the existing conservative UIA-only attempt remains unchanged |
| C4-06 | Invoke Aside from PDF, Word, or Excel | A reliable current-document path is identified and staged as a document descriptor; if no locator is available, the strategy reports unavailable without title guessing |
| C4-07 | Invoke Aside from an unsupported application that exposes UIA | Aside opens as an ordinary conversation surface and the bounded Generic UIA strategy stages one semantic snapshot without guessing, scraping pixels, or blocking |
| C4-08 | Remove or let one capture expire | The provider does not receive the removed or expired attachment but may receive the remaining attachments, and the durable session contains no implicit host-context copy |
| C4-09 | Change or close the original host after summon | Late capture results are rejected or cancelled; no new foreground application is read or modified |
| C4-10 | Deny a strategy capability or make its transport unavailable | Aside reports a recoverable strategy-specific capability error and keeps prompt, streaming, cancellation, and retry available; it does not silently run another strategy after a match |
| C4-11 | Inspect the runtime and Tauri boundaries | React and Pi receive only Aside-owned serialized contracts; no `HWND`, provider secret, raw adapter payload, or direct Windows API crosses the boundary |
| C4-12 | Inspect background behavior | Application inventory and usage analysis are absent from the Pi tool registry, prompt context, and summon critical path |
| C4-13 | Repeat summon/hide/capture quickly | The single Side rail remains coherent, valid captures accumulate without mixing target data, late results cannot overwrite existing attachments, and no stale context appears in the next request |
| C4-14 | Measure normal summon latency | Foreground snapshot, identity classification, and strategy selection meet the 100 ms p95 target, and each capture remains a bounded one-shot operation without polling |
| C4-15 | Inspect a successful Explorer or document capture | The attachment contains a validated path descriptor only; it is ready for a future workspace handoff but does not connect Pi tools, change `cwd`, or read file contents |

## 9. Decision Ledger

The following decisions are closed for this cycle:

- The router selects exactly one specialized strategy by stable identity and
  deterministic priority. Generic UIA is a separate fallback, used only when
  no specialized strategy matches.
- Browser capture is owned by the Browser strategy, which may compose bounded
  Generic UIA with browser metadata inside its own `capture()` method.
- Explorer, PDF, Word, and Excel strategies are path-first. They return
  validated file or directory descriptors and do not read content, capture
  layout, or mutate the host. VSCode bridge and active-editor work are deferred.
- A workspace descriptor is an explicit future handoff contract. This closeout
  does not connect Pi coding-agent tools, alter the Aside session directory, or
  call `process.chdir()`.
- Browser visual capture, host actions, file reads, document parsing, and
  provider-side workspace activation are deferred rather than acceptance
  requirements.

The following are intentionally deferred product decisions for a later scope:

- Which browser visual-capture API, consent flow, crop rule, and image budget
  should be shipped.
- Which host action or file mutation, if any, should be implemented first.
- How a validated workspace descriptor should be mapped to Pi's existing
  coding-agent tools without coupling durable Aside sessions to execution
  roots.

## 10. Release Boundary

Cycle 4 is complete when the common focus/capture/projection path selects one
strategy deterministically, Browser internally composes bounded UIA with its
metadata, unmatched hosts receive a bounded Generic UIA attempt, and Explorer,
PDF, Word, and Excel targets can return validated path descriptors when reliable
locators exist. The descriptor must be visible and serializable for a future
workspace handoff, but Pi workspace wiring is explicitly outside this closeout.

Cycle 4 also requires clean degradation for unavailable UIA, missing path
locators, stale targets, and strategy failures, while preserving the existing
Cycle 2/3 rail, runtime, and session behavior. Universal support for every
browser, editor, Explorer state, or document reader is not required; each
strategy declares its real capabilities and never substitutes title guessing,
screen scraping, OCR, or unbounded traversal.
