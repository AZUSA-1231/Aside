# Cycle 4 Contextual Sidecar Product Requirements

Status: active; P1 Chromium UIA capture implemented, visual and other host transports deferred
Platform: Windows desktop  
Predecessor: [Cycle 3 Pi Implementation](../cycle-3-pi-implementation/PRD.md)

This cycle defines Aside as a contextual sidecar for the applications where
the user already works. It extends the Cycle 3 Pi-backed conversation runtime
with a typed foreground-host handoff, explicit context capture, and a safe seam
for host actions. It does not turn Aside into an OS-wide monitoring product.

The long-lived ownership and privacy rules live in the
[Architecture](../ARCHITECTURE.md). This document defines the Cycle 4 product
behavior, scope, and acceptance criteria. Implementation order and execution
records are intentionally not part of this document.

## 1. Objective

Make Aside feel like a natural extension of the user's current application.
The user should be able to summon a compact Side rail from a browser, Windows
Explorer, VSCode, or a PDF reader, have Aside identify the current host, stage
the relevant bounded context, ask a question, and receive help without
copying, pasting, opening a second full-size application, or manually
explaining where they are.

When a supported host exposes a safe action capability, Aside should also be
able to turn the agent's suggestion into a typed preview and apply it to the
same host target after the user confirms it.

For Chromium browsers, Windows UI Automation (UIA) is the default capture
transport. A local browser visual-capture setting can opt in to one bounded
window image paired with the UIA result; it is disabled by default and never
creates a background capture lifecycle.

The central product loop is:

```text
User works in a host application
  -> user invokes Aside's existing summon shortcut
  -> Aside snapshots the foreground target before taking focus
  -> Aside identifies the host and stages eligible context
  -> user asks a question in the Side rail
  -> Pi reasons over the staged context
  -> Aside shows an answer or a typed action preview
  -> user confirms an allowed action when required
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
about the current page. Aside identifies the browser instance and stages the
selected tab, page title, and a compact semantic view of the page through the
browser's UIA surface. The semantic view is built from user-facing node names
and selected state; it does not include a raw document text range. With browser
visual capture enabled in settings, the same one-shot capture also stages a
bounded image of that browser window. The user can remove the attachment before
submitting the prompt.

### 3.2 Explorer assistance

The user is working in Windows Explorer, invokes Aside, and asks to understand
or organize the current folder. Aside identifies the current directory and
selected items through the Explorer adapter. File metadata can be staged by
default; file contents are read only through an explicit, bounded capture or
action flow. A proposed rename, move, or other supported change is previewed
before execution.

### 3.3 VSCode assistance

The user is editing a project, invokes Aside, and asks about the current file,
selection, workspace, or diagnostics. A VSCode integration supplies only the
declared bounded context. A proposed edit is represented as a target-bound
workspace change, displayed as a preview, and applied through the host's own
edit mechanism after confirmation.

### 3.4 PDF reader assistance

The user is reading a PDF, invokes Aside, and asks about the current document
or selected text. Aside identifies the reader and document when the adapter
can do so. Reader-specific integrations may provide selected text or bounded
document context. A generic screen, OCR, or accessibility fallback is not
used when no reader adapter is available.

### 3.5 Unsupported host fallback

The user invokes Aside from an unsupported application. The Side rail appears
with ordinary conversation available. Aside reports that no contextual host
adapter is available without blocking the conversation or trying to inspect
the application generically.

## 4. Scope

### Included

- Preservation of the Cycle 2 Side rail, summon shortcut, focus behavior, and
  one-window lifecycle.
- A foreground target snapshot taken before Aside receives focus, containing a
  sanitized host identity and an opaque native target capability.
- Host classification based on stable application identity and declared
  adapter capabilities, rather than window title matching alone.
- An Aside-owned host adapter contract for identification, capture, and typed
  actions.
- A Chromium UIA capture path for browser identity, selected-tab metadata, and
  a compact semantic page tree containing user-facing node names and selected
  state when the browser exposes those semantics.
- A user-controlled Chromium visual-capture setting that can pair one bounded
  per-window image with the UIA attachment for the same capture invocation.
- A one-shot capture result that stages bounded context without introducing a
  long-lived host-state lifecycle or blocking the prompt surface.
- A compact, user-visible representation of the current host and staged
  context, including source and expiry information sufficient for removal or
  cancellation.
- Browser, Explorer, VSCode, and PDF-reader adapter paths at the capability
  level described by the matrix below. Support is per adapter and does not
  imply universal support for every browser or PDF reader.
- Integration with the existing Cycle 3 Aside turn-context and Pi provider
  projection. Host context remains reference data, not a system instruction.
- A typed host-action seam with target validation, preview, confirmation,
  cancellation, timeout, and failure reporting.
- At least one end-to-end low-risk host modification path in the first
  supported adapter, with all other host actions allowed to remain read-only
  until their contracts are reviewed.
- Clear degradation when an adapter is missing, permission is unavailable,
  the host changes, or the captured context expires.

### Host capability matrix

| Host | Cycle 4 context target | Action boundary |
| --- | --- | --- |
| Browser | Browser identity, selected-tab metadata, active URL/title, and a compact UIA semantic tree of node roles, names, parent links, and selected state; optional bounded image of the same browser window when visual capture is enabled | No arbitrary injection, credentials, cookies, or form data; browser mutation is outside the first action slice unless separately approved |
| Windows Explorer | Current directory, selected item identity, and bounded file metadata; explicit file reads only when requested | Typed file operations such as a reversible rename or move may be proposed and must be previewed and confirmed |
| VSCode | Workspace root, active file, explicit selection, and bounded diagnostics or file content through an approved extension | Typed workspace edit preview and confirmation through the host edit mechanism |
| PDF reader | Reader/document identity and selected text or bounded document context when a reader-specific adapter provides it | No generic screen-based editing; actions require a separate reader capability |
| Other application | Sanitized foreground identity and declared unsupported state | No action capability |

### Explicitly not included

- Application inventory, usage duration, or other background behavior analysis
  as part of the prompt or Pi tool loop. Those belong to a separate optional
  Insight subsystem.
- Continuous polling of the foreground application or automatic capture of
  every application the user visits.
- Continuous or monitor-wide screen capture, OCR, generic screen understanding,
  or generic accessibility traversal. The target-bound Chromium UIA and
  opt-in per-window visual capture described in this PRD are narrow,
  user-initiated exceptions.
- Visual capture for Explorer, VSCode, PDF readers, or unsupported hosts through
  a generic screen fallback.
- Browser passwords, cookies, credentials, form contents, or unrestricted DOM
  extraction.
- Raw UIA `TextPattern` document ranges, visible ranges, text-selection ranges,
  character counts, name/value lengths, or diagnostic hashes in agent context.
- Universal content extraction from arbitrary PDF readers.
- Arbitrary shell commands, process control, code execution, or computer-use
  automation.
- Silent host changes, background file changes, or an action that is not bound
  to the target from which the user invoked Aside.
- A session browser, cloud sync, multi-user host state, or automatic promotion
  of captured host context into long-term memory.

## 5. Interaction Model

### 5.1 Summon and capture

The existing summon shortcut remains the primary entry point. Aside records
the foreground target before showing or focusing its own window. For a host
with an enabled adapter and an already-approved low-risk capture capability,
the summon gesture both opens the rail and stages the default context.

If a host requires a first-time permission or an explicit deeper capture, the
rail still opens immediately and presents one clear capture action. Aside must
not wait for a slow extension response before becoming usable and must not
silently broaden permissions to preserve the appearance of speed.

For Chromium, the local `browser_visual_capture_enabled` setting controls only
the visual augmentation of a user-initiated browser capture:

- When disabled (the default), the attachment contains UIA-derived metadata and
  the normalized semantic node tree, but no image is taken.
- When enabled, the same one-shot invocation captures the original browser
  window and packages its bounded visual block together with the UIA blocks in
  one attachment. It never captures the monitor or another window.
- Changing the setting does not capture anything by itself. It takes effect on
  the next explicit browser capture click and does not start polling.
- If the visual capability is unavailable or denied, valid UIA context remains
  usable and Aside shows a recoverable visual-capture status; it does not
  silently widen the target to a monitor screenshot.

### 5.2 Staged context

Captured host context is an ordered collection of attachments for the current
task. Each successful summon or capture click adds one bounded attachment, so
the user can combine context from several windows or applications without
dragging files or copying information between them. The UI shows each source
host and a compact summary before the prompt is submitted. The user can remove
an individual attachment, cancel a capture, or continue with no context.

When a browser visual block is present, the attachment preview identifies both
the UIA and visual sources and shows a bounded image preview or equivalent
visual indicator. Removing the attachment removes both parts together; the
visual block is not retained independently from the UIA capture.

The combined staged context must remain within the Cycle 3 prompt/context
limits. If another capture would exceed the limit, Aside rejects that new
attachment with a recoverable capacity message and keeps the existing
attachments unchanged; it does not silently replace, truncate, or discard
earlier context. Each capture has a bounded size and expiry, and the
collection is discarded when the current task ends unless a future product
feature explicitly chooses another retention policy.

### 5.3 Answer and action

The agent may answer using the staged reference context. If it proposes a host
change, the runtime and adapter produce a typed action preview. The preview
identifies the target and the intended change in product terms. Confirmation is
required for changes that are destructive, ambiguous, external, or difficult
to reverse. The adapter revalidates the target immediately before applying the
change.

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
- the host classification result and adapter capability state;
- a native-held opaque capability used to revalidate later operations.

Raw window handles, process handles, native structs, and credentials must not
cross the Tauri or runtime boundary.

### FR-4.3 Host classification

Aside must classify the invocation target using a stable application identity
and an adapter registry. Classification must distinguish at least browser,
Explorer, VSCode, PDF reader, and unsupported host states. Unknown, ambiguous,
or inaccessible targets must use the unsupported fallback rather than guessing
from a title or reading pixels.

### FR-4.4 Host adapter contract

Each adapter must declare and enforce its own capabilities. The common contract
must cover:

- target matching and capability discovery;
- explicit context capture with bounded output;
- source, capture time, expiry, and sensitivity metadata;
- typed action proposal and preview, when supported;
- cancellation, timeout, stale-target, permission, and failure results.

The adapter transport may be native, a browser extension, a VSCode extension,
or a reader-specific integration. The transport must not change the
Aside-owned product contract.

### FR-4.5 Capture semantics

Capture must be user-initiated through the summon/capture interaction. The
adapter may stage low-risk default context when permission has already been
granted, but restricted content requires an explicit capability decision.
Capture is one-shot and must not create a background host-state lifecycle. The
initial Side rail remains usable while an adapter call is being completed.

Each successful capture appends an attachment to the current task. The runtime
must validate the combined attachment projection and reject oversized,
malformed, expired, or unsupported blocks before a provider call. Appending is
atomic: when the new attachment would exceed the aggregate Cycle 3 context
limits, the new attachment is rejected and existing attachments remain
unchanged. Cycle 4 inherits the Cycle 3 context limits unless a later
architecture decision changes them.

For a Chromium target, the capture method is determined by the local visual
capture setting. The disabled path performs UIA queries only. The enabled path
performs one target-bound window capture and combines the bounded image with
the UIA result before attachment validation. A visual capture failure may
produce a valid UIA-only attachment plus a recoverable status, but it must not
capture a wider screen area or replace an existing attachment.

### FR-4.6 Provider projection and isolation

The host attachment collection must be projected through the existing Aside
context boundary as one ordered set of untrusted reference data. It must not
become a system prompt, tool instruction, or coding-agent repository context.
The same collection may be used by provider turns caused by one request, but
it must not be duplicated or leak into a later request.

Captured host content, native target capabilities, adapter credentials, and raw
host payloads must not be persisted in the durable conversation by default.
Session history may retain the user's prompt and the assistant's finalized
response according to Cycle 3 policy, but not an implicit copy of the host
attachment.

The Aside-owned context contract must represent a visual block separately from
text and JSON blocks. A visual block is bounded image data or an equivalent
provider image reference, is labelled as untrusted local content, and follows
the same attachment expiry, removal, aggregate-budget, and non-persistence
rules. React and Pi must not receive a native capture handle or an unbounded
pixel buffer.

### FR-4.7 Browser adapter

The browser adapter must expose only the declared browser capability. Its
default transport is a one-shot Windows UIA query against the invocation
window. At minimum it must identify the browser, selected tab, active URL and
title when the user invokes contextual assistance. It must also normalize the
selected page `Document` into a compact semantic tree when the browser exposes
that UIA surface. The default tree keeps only the node role, non-empty node
`Name`, parent relationship, and selected state. It must not use clipboard
simulation or a raw `TextPattern.DocumentRange` to obtain page text.

For this purpose, UIA `Name` is treated as the accessible display label of a
node, not as an arbitrary text source. The normalizer must start from the page
`Document`, discard browser chrome and empty layout containers, discard nodes
marked `offscreen` when that property is available, and normalize whitespace.
An accessible name is not guaranteed to be literal rendered glyphs (for
example, an icon button may expose an `aria-label`), so the result is described
as semantic node names rather than a transcription of every visible character.
The `selected` field represents UIA selection-item state and is included only
when meaningful; a page text range is not serialized as a second text source.

The product-facing shape is column-oriented and intentionally small:

```json
{
  "fields": ["role", "name", "parent", "selected"],
  "nodes": [
    ["document", "GitHub", -1, null],
    ["link", "THU-MAIC/OpenMAIC", 0, null],
    ["listitem", "Open pull requests", 0, true]
  ]
}
```

Browser identity, page title, and sanitized URL remain attachment metadata;
they are not repeated as arbitrary node properties. Character counts,
`TextPattern` samples, visible-range text, bounds, automation IDs, pattern
diagnostics, and hashes are internal diagnostics or native extraction data and
must be removed before provider projection. The implementation still measures
serialized byte size internally to enforce context limits; the measurement is
not emitted as context.

The local `browser_visual_capture_enabled` setting is disabled by default. If
it is disabled, the browser attachment contains UIA blocks only. If it is
enabled, the adapter captures the same invocation browser window once through
an approved per-window Windows capture API and packages the bounded visual
block with the UIA blocks in the same attachment. It must prefer the browser
document region when a reliable UIA bounding rectangle is available and must
never widen the capture to the monitor or another window.

The visual setting does not enable OCR, DOM extraction, CDP control, browser
automation, or background capture. An unavailable visual API, protected
surface, stale target, or denied permission produces a recoverable visual
capability result while preserving valid UIA context.

The adapter must not expose passwords, cookies, auth tokens, form contents, or
unbounded browsing history. Failure to connect to an extension or CDP endpoint
must not disable the UIA path; those transports remain optional enhancements
for browser surfaces that UIA cannot represent.

### FR-4.8 Explorer adapter

The Explorer adapter must identify the current directory and selected items
without requiring the user to paste a path. File metadata and paths are
sensitive context and must be visibly staged and bounded. File contents require
an explicit read operation with a size limit.

Any file modification must be represented as a typed operation against the
captured target and must provide a preview, confirmation, and recoverable
failure path. The agent must not receive arbitrary shell access as a shortcut
for Explorer actions.

### FR-4.9 VSCode adapter

The VSCode adapter must identify the workspace and active editor context
through an approved host integration. It may provide the explicit selection,
bounded current-file content, and diagnostics declared by the adapter.

Edits must use a typed workspace operation or the host's native edit mechanism.
The agent must not write arbitrary files without a target-bound preview and
user confirmation.

### FR-4.10 PDF-reader adapter

The PDF path must distinguish reader identification from document-content
capture. A known reader adapter may provide document metadata, current page,
selected text, or another bounded source it explicitly supports. An unknown
reader must not trigger OCR, screenshots, or generic accessibility reads.

### FR-4.11 Host action boundary

Pi tool execution may request a typed host action, but the model cannot execute
native operations directly. The action path is:

```text
Pi action request
  -> Aside validates schema and capability
  -> native adapter revalidates target
  -> UI shows preview and requests confirmation
  -> native adapter applies the operation
  -> runtime receives a sanitized result
  -> Pi continues or reports the result
```

The first Cycle 4 implementation must complete one low-risk, reversible action
end to end. Other adapters may expose capture-only capabilities until their
action semantics are reviewed.

### FR-4.12 Runtime and protocol integration

The Tauri/runtime boundary must carry Aside-owned host identity, one-shot
capture results including bounded visual blocks, context attachments, action
previews, and sanitized results. React must not construct provider messages,
native handles, or Pi tool calls. Existing Cycle 3 streaming, cancellation,
session, and error behavior must remain intact.

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
| Host classification | Show the supported host and capabilities, or use the unsupported fallback |
| Context capture | Keep the Side rail usable, show the result or a recoverable error, and preserve any valid partial capability without inventing content |
| Permission denied | Explain the missing capability and continue without the restricted context |
| Provider request | Preserve the user prompt and keep the staged context from leaking into later requests |
| Host target closes or changes | Cancel or reject the capture/action and leave the new target untouched |
| Action fails | Show a sanitized result, do not claim success, and keep the preview/history state coherent |
| Adapter process is unavailable | Degrade to ordinary conversation and keep the runtime alive |

### FR-4.15 Browser visual-capture setting

Aside must expose a local setting named `browser_visual_capture_enabled` with a
default value of `false`.

- `false` means a browser capture acquires no pixels and sends only the UIA
  attachment blocks permitted by the browser adapter.
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
  and deterministic. A large host document must be summarized, truncated by an
  explicit policy, or rejected; it must not expand the prompt silently.
- When browser visual capture is disabled, no browser pixels are acquired. When
  enabled, image dimensions, encoded bytes, crop region, and provider image
  capability are bounded before the visual block is staged.
- Every capture and action is associated with one invocation target. A late
  capture result may add its own validated attachment to the still-active
  composer, but it cannot overwrite or remove another attachment, redirect to
  a newer target, or modify another host.
- Adapter failure, timeout, or crash must not terminate the Tauri shell or Pi
  runtime.
- Host capabilities and staged data must be testable with deterministic faux
  adapters. Tests must cover capture isolation, stale-target rejection,
  action confirmation, and fallback behavior.
- Existing Cycle 2 window, shortcut, Pin, Side, and Workspace behavior remains
  unchanged.

## 8. Acceptance Criteria

| ID | Scenario | Expected result |
| --- | --- | --- |
| C4-01 | Invoke Aside from a supported browser | The target is captured before Aside takes focus; the rail appears immediately and shows the browser capability state |
| C4-02 | Capture browser identity, selected-tab metadata, title, and the normalized UIA semantic tree repeatedly | Each bounded capture is visible as an ordered staged attachment, all retained attachments reach the current provider request within the aggregate limit, and they are absent from a later request unless captured again |
| C4-03 | Invoke Aside from Windows Explorer | The current directory and selected item metadata are identified without manual path entry; unsupported content remains uncaptured |
| C4-04 | Propose an Explorer or VSCode low-risk change | A typed target-bound preview is shown and the change occurs only after confirmation |
| C4-05 | Invoke Aside from VSCode | Workspace, active file, selection, or diagnostics appear only when the approved adapter declares and supplies them; the conversation remains usable when it does not |
| C4-06 | Invoke Aside from a supported PDF reader | Reader/document identity and supported selected or bounded context are handled through the adapter; no generic OCR or screenshot fallback runs |
| C4-07 | Invoke Aside from an unsupported or ambiguous application | Aside opens as an ordinary conversation surface without guessing, scraping, or blocking |
| C4-08 | Remove or let one capture expire | The provider does not receive the removed or expired attachment but may receive the remaining attachments, and the durable session contains no implicit host-context copy |
| C4-09 | Change or close the original host after summon | Late capture or action results are rejected or cancelled; no new foreground application is read or modified |
| C4-10 | Deny an adapter permission or stop its companion integration | Aside reports a recoverable capability error and keeps prompt, streaming, cancellation, and retry available |
| C4-11 | Inspect the runtime and Tauri boundaries | React and Pi receive only Aside-owned serialized contracts; no `HWND`, provider secret, raw adapter payload, or direct Windows API crosses the boundary |
| C4-12 | Inspect background behavior | Application inventory and usage analysis are absent from the Pi tool registry, prompt context, and summon critical path |
| C4-13 | Repeat summon/hide/capture quickly | The single Side rail remains coherent, valid captures accumulate without mixing target data, late results cannot overwrite existing attachments, and no stale context appears in the next request |
| C4-14 | Measure normal summon latency | Foreground snapshot and host classification meet the 100 ms p95 target, and each capture remains a bounded one-shot operation without polling |
| C4-15 | Capture from Chromium with `browser_visual_capture_enabled = false` | UIA context is staged and no browser pixels are acquired, persisted, or sent to the provider |
| C4-16 | Capture from Chromium with `browser_visual_capture_enabled = true` | One bounded image from the invocation browser window is packaged with the UIA blocks in the same attachment; monitor pixels, other windows, and later browser state are absent |

## 9. Open Product Decisions

These decisions must be resolved by the implementation plans or recorded as
explicit temporary choices before the related host capability is shipped:

The browser visual-capture default is resolved for this PRD: the setting is
local, named `browser_visual_capture_enabled`, and defaults to `false`. The
enabled path sends a bounded image together with the same capture's UIA blocks;
OCR is not part of that setting.

The default Chromium UIA payload is also resolved: use the page `Document`
content tree as the source, represent user-facing semantic nodes with
`role/name/parent/selected`, and omit raw document text ranges and diagnostic
length/hash fields. The `Name` value is a visibility-filtered accessibility
label, not a guarantee that every character was rendered literally.

| Decision | Why it matters |
| --- | --- |
| Which low-risk context fields each host may stage on the existing summon shortcut | Determines the default capability set while preserving the one-gesture handoff |
| Which browser and PDF integrations are officially supported first | Host APIs, packaging, permissions, and maintenance cost vary by application family |
| Which Windows Graphics Capture consent and document-region crop behavior to ship | Determines whether the visual block can remain target-bound without exposing browser chrome or unrelated pixels |
| Maximum visual dimensions, encoded bytes, and provider image constraints | Keeps the optional visual block within the aggregate context budget and predictable provider costs |
| Whether the first write slice targets Explorer or VSCode | Determines the first action schema, preview UI, and native/extension implementation |
| Which context sources are shown in full versus represented by a compact summary | Balances inspection speed, provider cost, and sensitive-content exposure |
| Whether provider submission needs a per-attachment confirmation or only visible staged state | Determines how seamless capture remains while making remote data flow clear |
| Default expiry and retry behavior for slow adapter captures | Determines how stale host context is prevented during a long conversation |

## 10. Release Boundary

Cycle 4 is complete when the contextual sidecar path works through the common
focus, capture, projection, and action contracts; at least one supported host
can provide useful bounded context without copy/paste; at least one low-risk
host modification is previewed and confirmed end to end; unsupported hosts
degrade cleanly; and the Cycle 2/3 surface, runtime, and session behavior
remain intact.

Universal support for every browser, editor, Explorer state, or PDF reader is
not a Cycle 4 requirement. Each host adapter must declare its actual
capabilities. Chromium visual capture is limited to the explicit local setting
and the invocation window; unsupported capabilities must remain unavailable
rather than being approximated through generic surveillance, monitor capture,
or screen automation.
