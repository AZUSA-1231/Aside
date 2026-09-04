# Cycle 4 Issues

This log records decisions that constrain the contextual sidecar implementation.
It is intentionally separate from the PRD and the executable plan files.

## C4-I001 - Keep Capture One-Shot

Status: accepted  
Discovered: 2026-08-31  
Affected: P0  
Requirements: FR-4.2, FR-4.5, FR-4.6

### Fact

The product needs a fast handoff from the current foreground application into
the prompt. It does not need a broker, a multi-window host state store, a
polling loop, or background context refresh.

### Impact

Retaining host state would expand the privacy boundary and make a later
foreground window look like the original capture target. It would also make
attachment replacement and expiry harder to reason about.

### Decision

P0 uses one target snapshot and one extractor call per summon/capture. The
snapshot is discarded when the call returns. The only collection retained by
the UI is the ordered attachment list for the current prompt; each successful
capture appends one attachment until the aggregate context budget is reached.

### Follow-up

Future host transports may use asynchronous IPC for one invocation, but they
must keep the same one-shot contract and must not introduce a host-state
manager. A capture initiated after Aside has focus must obtain a target before
focus or report no foreground host rather than inspecting Aside.

## C4-I003 - CDP Does Not Resolve the Active Browser Tab

Status: accepted
Discovered: 2026-08-31
Affected: future Chromium transport
Requirements: FR-4.3, FR-4.7

### Fact

Chromium CDP target discovery returns page ids, target types, titles, URLs, and
debugger attachment state, but it does not return a reliable active-tab or
last-focused-tab field. A browser endpoint also exposes extension and service
worker targets. Normal Chrome/Edge processes do not expose CDP unless they are
started with an explicit debugging configuration.

### Impact

Scanning target order or treating `attached` as active could capture a different
tab from the one where the user invoked Aside. Scanning arbitrary localhost
ports would also create a broad and unsafe control surface.

### Decision

CDP is a transport capability, not the active-tab authority. A real Chromium
adapter must receive active-tab identity from an approved browser companion or
another explicit bridge, or operate only in a separately opted-in CDP setup
with a user-approved target binding. It must filter to page targets and keep
the CDP control surface out of the attachment and provider boundaries.

### Follow-up

Any future Chromium transport plan must choose and test the active-tab bridge,
then add only one bounded capture capability behind the existing strategy
contract.

## C4-I002 - Defer Real Host Transports

Status: partially superseded by the 2026-09-03 closeout decision
Discovered: 2026-08-31  
Affected: P0  
Requirements: FR-4.3, FR-4.4

### Fact

Chromium CDP, VSCode extensions, Explorer integration, and PDF-reader APIs
each have separate permission, packaging, and lifecycle concerns.

### Impact

Adding one of those transports while defining the common boundary would turn a
small adapter slice into several host-specific implementations and would make
the contract difficult to review in isolation.

### Decision

P0 shipped the Aside-owned extractor trait, registry, target validation,
sanitization, attachment collection, and deterministic faux coverage for all
four host families. The production registry initially reported unsupported
honestly, and P1 installed the bounded Chromium UIA extractor. The later
closeout decision supersedes the remaining transport deferral only for the
smallest useful path-first slice: Explorer, VSCode, PDF, Word, and Excel may
implement validated path locators, and unmatched applications may use the
bounded Generic UIA fallback. Rich host content, host actions, and Pi
workspace wiring remain deferred.

### Follow-up

Each path locator or future rich transport must be added behind the existing
strategy contract with its own capability, permission, timeout, expiry, and
isolation tests. The closeout plan must preserve the original P0 boundary; it
must not turn path discovery into file reads or implicit agent-tool access.

## C4-I004 - UIA First with Opt-In Browser Visual Augmentation

Status: accepted for a future visual-capture slice; deferred from Cycle 4 closeout
Discovered: 2026-08-31
Affected: future Chromium transport
Requirements: FR-4.5, FR-4.6, FR-4.7, FR-4.15

### Fact

Windows UI Automation can expose Chromium browser controls and page semantics
without clipboard simulation or an installed browser extension. It may still
omit visual-only content such as canvas and image data. A per-window Windows
Graphics Capture path can provide pixels for the same invocation target, but
it has a broader privacy and provider-contract surface.

### Impact

Making visual capture implicit would acquire browser pixels for every capture,
even when semantic UIA context is sufficient. Making it monitor-wide would
also include unrelated windows and private desktop content. Sending both
representations requires an explicit bounded image block in the context
projection.

### Decision

Chromium capture uses UIA as its first transport. The local
`browser_visual_capture_enabled` setting and its image path are retained as a
future design, not as a Cycle 4 closeout requirement. The current Browser
strategy uses only its bounded UIA composition and browser metadata. Any later
visual path must remain one explicit, target-bound capture and must never start
polling, capture the monitor, invoke OCR, or enable generic browser automation.

### Follow-up

The Chromium plan must validate selected-tab and page-semantic coverage in
Edge and Chrome. A future visual plan must choose the Windows capture API and
document-region crop rule, define image serialization and budget limits, and
test permission, protected-surface, stale-target, and partial-UIA failure
behavior. Extensions and CDP remain optional enhancements rather than
prerequisites for the current path.

## C4-I005 - Initialize UIA on a Dedicated COM Worker

Status: resolved
Discovered: 2026-09-02
Affected: P1 Chromium UIA capture
Requirements: FR-4.5, FR-4.7, FR-4.14

### Fact

The Tauri command thread can already belong to a COM apartment that is
incompatible with the UIA initialization requested by the Chromium extractor.
Calling `CoInitializeEx` and creating `IUIAutomation` directly on that thread
can therefore return an unavailable result even when Edge is open and its UIA
surface is readable.

### Decision

The native Chromium capture call clones only the bounded target snapshot,
starts a short-lived named worker, initializes COM and performs the complete
UIA query on that worker, then joins and releases the worker-owned UIA
references. The extractor remains stateless; no COM object, HWND, or host map
survives the one-shot call.

## C4-I006 - Keep Capture Artifacts Inspectable Without Making Them Session State

Status: accepted
Discovered: 2026-09-02
Affected: P1 capture UI and local inspection
Requirements: FR-4.5, FR-4.6

### Fact

The attachment is intentionally temporary prompt state, but development and
user verification need a concrete JSON artifact. Opening the file directly
through the default application adds an unnecessary opener permission and does
not improve the capture workflow.

### Decision

Each successful capture is written to Aside's local `captures` directory as a
valid JSON artifact. The attachment remains temporary and is cleared after a
successful prompt; the file is not automatically reattached or copied into
session history. Aside provides an in-panel preview and a button to reveal the
file in its folder. The artifact uses readable outer objects while keeping
`fields` and each `nodes` tuple compact, with one node tuple per line.

## C4-I007 - Use Bounds Instead of Unhelpful Node State Columns

Status: accepted
Discovered: 2026-09-02
Affected: P1 semantic page projection
Requirements: FR-4.7

### Fact

Parent indexes in a filtered tree are difficult for the agent to interpret,
and UIA selection state is usually absent or unrelated to the user's pointer
or highlighted text. The page's approximate screen position is more useful for
understanding layout and control placement.

### Decision

The product-facing semantic table is fixed to `role`, `name`, and `bounds`.
Parent indexes and page-node selection flags are removed from the attachment.
Selection remains an internal signal only when needed to identify the active
browser tab. UIA `Name` remains the sole semantic label source; text ranges,
lengths, and diagnostic fields are not promoted into context.

## C4-I008 - Select One Strategy, Then Execute It

Status: accepted
Discovered: 2026-09-03
Affected: Cycle 4 closeout
Requirements: FR-4.3, FR-4.4, FR-4.5, C4-04

### Fact

Generic UIA is useful for many applications, while browser and file-oriented
hosts need different fields. Running Generic UIA first and then appending a
specialized result makes ownership ambiguous, can duplicate data, and allows a
specialized failure to be hidden by an unrelated fallback.

### Decision

The native registry orders specialized strategies by deterministic priority and
selects exactly one match. The Browser strategy composes the shared bounded UIA
transport with browser metadata inside its own `capture()` method. VSCode,
Explorer, and document strategies own their path discovery. If no specialized
strategy matches, the router invokes a separate Generic UIA fallback. Generic
UIA is not registered as a normal matching strategy and never competes with or
merges into a specialized result. A matched strategy that fails reports its
own bounded error and is not silently retried through Generic UIA.

### Follow-up

Add deterministic priority and ambiguity tests, plus an invariant that one
capture request produces at most one strategy result. Keep transport reuse
inside strategy modules so adding another host does not add branches to the
router or shared `uia` transport.

## C4-I009 - Path-First File Hosts, Workspace Wiring Deferred

Status: accepted
Discovered: 2026-09-03
Affected: Cycle 4 closeout
Requirements: FR-4.4, FR-4.6, FR-4.8, FR-4.9, FR-4.10, C4-05, C4-06, C4-15

### Fact

For VSCode, Explorer, PDF, Word, and Excel, the useful handoff for a coding
agent is usually a workspace or document path. Feeding UI layout or copying
file content into the prompt adds coupling and duplicates capabilities that a
coding agent can provide through its own filesystem tools.

### Decision

File-oriented strategies return only validated path descriptors in this
closeout: resource role, canonical path, and whether the target is a file,
directory, or workspace root. They do not read content, parse documents,
capture editor layout, or perform host actions. The descriptor is serializable
and ready for a future workspace handoff, but Aside does not connect Pi's
coding-agent tools, alter the Aside session directory, or call
`process.chdir()` now. When the Pi integration is available later, it should
consume the descriptor through a per-run execution-root interface while
keeping durable Aside session storage separate.

### Follow-up

Explorer's production locator uses target-bound Shell automation first and the
existing bounded UIA address/selection signals as a compatibility fallback.
Implement and test reliable locators independently for each remaining host
family. A missing or ambiguous locator is an honest unavailable result, never a
title guess. Keep the future workspace handoff as an explicit interface so
wiring Pi tools later does not change strategy selection or capture contracts.

## C4-I010 - Isolate Real Host Extraction Research

Status: accepted
Discovered: 2026-09-03
Affected: P4 research and future rich-content scope
Requirements: FR-4.8, FR-4.9, FR-4.10, C4-06, C4-15

### Fact

The path-only production contract cannot answer which Word, Excel, PDF reader,
VSCode, or Explorer fields are actually exposed on a real machine. A full local
experiment is useful, but copying that output into the provider path would
silently turn a research result into a privacy and context-scope change.

### Decision

`tools/host-research-probe.ps1` is the only Cycle 4 full-extraction entry point.
It requires an operator-selected HWND and PID, records a binding fingerprint,
and revalidates the same target before and after each layer. Word and Excel use
the already-running COM object from the ROT and verify `ActiveWindow.Hwnd`;
PDF readers and other hosts use target-bound UIA diagnostics/TextPattern. The
probe never enumerates windows, guesses a path from a title, starts an Office
instance, edits/saves/navigates, uses the clipboard, injects code, changes
`cwd`, or sends artifacts to Pi.

### Locator capability matrix

| Host | Candidate source | Production status | Research status |
| --- | --- | --- | --- |
| Explorer | target-bound Shell automation (`IShellWindows`/`IWebBrowserApp`) plus UIA fallback | directory and selected-item descriptors when explicit and validated | compare Shell folder/selection paths with ControlView, ContentView, and selection evidence |
| VSCode | explicit UIA workspace/resource/path values | existing conservative UIA-only path attempt; extension/bridge integration deferred | repeat UIA path and TextPattern observations only if VSCode work is resumed |
| Word | COM `ActiveDocument.FullName` bound to `ActiveWindow.Hwnd` | document descriptor when COM binding and path validation succeed | metadata, paragraphs, tables, hyperlinks, and redaction comparison |
| Excel | COM `ActiveWorkbook.FullName` bound to `ActiveWindow.Hwnd` | document descriptor when COM binding and path validation succeed | metadata, sheets/cells, hyperlinks, and redaction comparison |
| PDF reader | explicit UIA path signal or operator-supplied path | document descriptor only with a reliable locator | UIA TextPattern full text where the reader exposes it |
| Other UIA host | bounded UIA ControlView/ContentView | Generic UIA semantic fallback | bounded/expanded diagnostic and text experiment only |

The matrix is evidence-driven. A field is not promoted until repeated captures
show that it is target-bound, reproducible, appropriately classified for
sensitivity, and acceptable for size and latency. Missing, ambiguous, denied,
closed, or replacement targets remain explicit unavailable/stale results.

## C4-I011 - Explorer Shell Locator; VSCode Follow-up Deferred

Status: accepted
Discovered: 2026-09-04
Affected: Explorer path capture and future VSCode integration
Requirements: FR-4.8, FR-4.9, C4-03, C4-05

### Fact

Explorer's address bar and selected-item UIA providers are not equally
available across Windows versions, view modes, and navigation states. Windows
Shell exposes a target-addressable automation model that can return the folder
and selected item paths without reading their contents. VSCode also has a rich
extension ecosystem and an existing agent-plugin role, so a new Aside bridge
would add packaging, window binding, and lifecycle work beyond this slice.

### Decision

The Explorer strategy now queries `IShellWindows` on a dedicated STA COM worker,
matches the returned `IWebBrowserApp.HWND` to the captured target exactly, and
reads only `Folder2.Self.Path` and `SelectedItems().Item(i).Path`. Every value
still passes the shared canonicalization, existence, type, symlink/reparse, and
size checks. If Shell automation cannot provide a usable folder, the strategy
falls back to its bounded UIA signals; it never guesses from a title.

VSCode extension, named-pipe/localhost bridge, active-editor integration, and
any richer VSCode locator are deferred. The existing conservative UIA-only
attempt remains unchanged and may report `locator_unavailable`; no new VSCode
capability is promoted by this decision.

### Follow-up

If VSCode is resumed, use an explicitly installed extension or another approved
bridge with per-window instance binding. Keep remote, untitled, virtual, and
replacement-window cases unavailable unless the bridge proves a target-bound
local path.
