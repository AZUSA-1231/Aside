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

The next Chromium plan must choose and test the active-tab bridge, then add
only one bounded capture capability behind the existing `HostExtractor` trait.

## C4-I002 - Defer Real Host Transports

Status: accepted  
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

P0 ships the Aside-owned extractor trait, registry, target validation,
sanitization, attachment collection, and deterministic faux coverage for all
four host families. The production registry remains empty and reports
unsupported honestly until a later host-specific plan installs a real
transport.

### Follow-up

Each real transport must be added behind the existing extractor contract with
its own capability, permission, timeout, expiry, and isolation tests.

## C4-I004 - UIA First with Opt-In Browser Visual Augmentation

Status: accepted
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
`browser_visual_capture_enabled` setting defaults to `false`; the disabled path
acquires and sends UIA blocks only. When the setting is `true`, one explicit
capture click obtains one bounded image from the invocation browser window and
packages it with that capture's UIA blocks as one attachment. The path never
starts polling, captures the monitor, invokes OCR, or enables generic browser
automation.

### Follow-up

The Chromium plan must validate selected-tab and page-semantic coverage in
Edge and Chrome, choose the Windows capture API and document-region crop rule,
define image serialization and budget limits, and test permission, protected
surface, stale-target, and partial-UIA failure behavior. Extensions and CDP
remain optional enhancements rather than prerequisites for the default path.
