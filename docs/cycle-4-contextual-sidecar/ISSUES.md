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
