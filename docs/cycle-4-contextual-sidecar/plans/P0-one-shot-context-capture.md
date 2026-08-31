# P0 - One-Shot Host Context Capture

Status: implemented; real host transports deferred  
Depends on: Cycle 2 Side rail and Cycle 3 runtime contracts  
Unblocks: later real host extractor plans

Source requirements: [Cycle 4 PRD](../PRD.md) and [Project Architecture](../../ARCHITECTURE.md)

## Outcome

Implement one complete, one-shot host-context capture path. A summon or
explicit capture click performs one bounded operation:

```text
capture foreground target before Aside takes focus
  -> identify the host application
  -> select the matching host extractor
  -> capture the declared bounded context
  -> validate and package one attachment
  -> append it to the current prompt's attachment collection
```

There is no long-lived host-state manager, multi-window state store, polling
loop, or background capture runtime. The only retained data is the ordered
attachment collection in the current composer/request. A later click performs
a new capture and appends its result; it does not replace or implicitly dedupe
earlier attachments.

This collection is prompt composition state, not host state. It exists only so
the user can gather bounded context from several windows or applications before
asking one question. When the combined normalized context reaches the existing
Cycle 3 budget, a further capture is rejected without changing the collection.

This plan establishes the common extractor contract and deterministic faux
extractors. It does not implement Chromium CDP, a VSCode extension, Explorer
automation, or a PDF SDK.

## Design

### One-shot native entry point

The native summon path captures the foreground target before showing or
focusing Aside. The target snapshot is used for one extractor call and is then
discarded. The direct capture command is the same one-shot operation for a
caller that can invoke it before Aside receives focus; a call made after Aside
already owns focus reports that no host target is available. It must never
inspect Aside itself as the host.

The native operation should be one command/future with one result, rather than
a broker with durable invocation state:

```text
capture_active_host_context() -> HostCaptureResult
```

The result is either a sanitized attachment or a recoverable capture error.
Transport latency may require a temporary loading state in the UI, but there
is no native polling protocol or host-state lifecycle beyond that call.

### Attachment collection

The current composer owns an ordered list of successful attachments. Each
attachment keeps its own source, summary, capture time, expiry, sensitivity,
and correlation ID so the user can inspect or remove it independently. The
collection may contain captures from different targets and host families.

Before appending, Aside validates the complete normalized collection against
the existing Cycle 3 limits. A capture that would exceed the aggregate budget
fails atomically with a visible capacity error; it does not truncate the new
capture or evict an older one. Removing an attachment frees its contribution
to the budget for a later click.

### Extractor boundary

The common extractor answers only the questions needed for one capture:

- does this extractor match the sanitized target identity?
- which capture capabilities are available?
- can it return a bounded context for this request?

The extractor does not own Side window state, prompt history, Pi messages,
other extractors, or cross-click state. Real transports can later implement
this contract through CDP, an extension, a native API, or a reader-specific
integration without changing the product boundary.

### Ownership

- `src-tauri/src/context.rs` owns target snapshotting, host classification,
  extractor selection, one-shot capture, and native payload sanitization.
- `src/lib/contracts.ts` owns serializable UI views for host identity,
  capability state, capture status, and the staged attachment collection.
- `agent-runtime/src/context.mjs` owns existing context validation and Pi
  projection. It receives the ordered attachment collection with the prompt
  and does not call Windows or host integrations.
- React owns only the current composer attachment collection and its
  remove/append interaction. It must not identify hosts or construct provider
  messages.

No raw `HWND`, process handle, native struct, credential, or raw transport
payload crosses the Tauri or runtime boundary.

## Tasks

1. Define the minimal one-shot capture contracts.
   - Define host kind, stable application identity, capture capabilities,
     target snapshot, capture request, attachment, and sanitized error types.
   - Give each capture request and attachment opaque IDs only for IPC and UI
     correlation. Do not create a native target map or retain capabilities
     after the capture call returns.
   - Keep every attachment and the combined collection compatible with the
     Cycle 3 text/JSON context model and enforce 8 blocks, 8 KiB text, 16 KiB
     JSON, 24 KiB total, and JSON depth 4.
   - Include source, capture time, expiry, sensitivity, and a compact display
     summary in the product-facing attachment.

2. Implement host classification and extractor selection.
   - Define one `HostExtractor` interface for stable target matching,
     capability discovery, and bounded capture.
   - Register faux Browser, Explorer, VSCode, PDF reader, and unsupported
     extractors behind one simple registry or ordered selector. The registry
     is lookup data, not a state manager.
   - Match using stable application identity and declared capabilities. An
     unknown, ambiguous, or inaccessible target must use unsupported fallback.
   - Return an unavailable capability when a real transport is not installed;
     do not guess from window titles, pixels, OCR, or generic accessibility.

3. Implement the one-shot native capture function.
   - Snapshot the foreground target before Aside receives focus.
   - Select exactly one extractor and invoke one bounded capture operation.
   - Validate the returned payload, reject malformed/oversized/expired data,
     and strip all fields that are not part of the Aside-owned attachment.
   - Return useful partial capability information such as host identity and
     URL/title when a deeper extractor capability is unavailable.
   - Ensure the target is still valid for the duration of the call. If it
     closes or changes identity, return a stale-target error and no content.
   - Make the target snapshot and any opaque native capability short-lived and
     release them when the operation finishes.

4. Connect the attachment to the current prompt.
   - Add the minimal Tauri command/event payloads for capture started,
     capture completed, and capture failed, or use the command result when a
     single response is sufficient.
   - Keep the ordered attachment collection in the current composer/request
     only. Removing one attachment must remove only that attachment from the
     next provider request.
   - A successful capture appends one attachment. A failed or over-budget
     capture must not erase or replace valid existing attachments.
   - Validate the aggregate budget before committing an append, so the
     collection never contains a partially accepted attachment.
   - Use lightweight frontend request tokens so late results cannot overwrite
     or remove attachments created by another click. A valid late result may
     append its own attachment if the same composer/request is still active;
     this is click-result protection, not a multi-invocation native state
     manager.

5. Extend the existing runtime context projection.
   - Accept the ordered sanitized host attachment collection as reference data
     on the current prompt and reuse the Cycle 3 validation/projection rules.
   - Do not project native target capabilities, correlation tokens, adapter
     credentials, or raw payload fields.
   - Reject removed, expired, invalid, unsupported, or aggregate-over-limit
     attachments before provider submission, while preserving valid remaining
     attachments.
   - Project the collection once in deterministic capture order for a single
     request; do not duplicate it across provider turns.
   - Prove that host attachments are absent from durable session entries and
     from a later prompt unless the user captures them again.

6. Add deterministic faux extractors and contract tests.
   - Provide bounded fixture responses for Browser URL/title, Explorer
     directory/item metadata, VSCode workspace/editor data, PDF reader/document
     data, and unsupported fallback.
   - Test stable classification, capability reporting, successful capture,
     unavailable transport, permission denial, timeout, cancellation, stale
     target, malformed payload, oversized payload, expiry, and unsupported
     fallback.
   - Test repeated clicks across different faux hosts: successful captures
     accumulate in commit order, a late valid result appends without
     overwriting existing attachments, and a failed or over-budget capture
     preserves the prior collection.
   - Test aggregate budget rejection, individual removal freeing capacity,
     provider projection, expiry, and session non-persistence.
   - Keep all faux data and extractor implementations out of the production
     host integration path unless explicitly enabled by a test harness.

7. Record any scope or contract surprise in the cycle's single `ISSUES.md`
   before expanding this plan.

## Deliverables

- A minimal Aside-owned one-shot host capture contract.
- One native capture entry point with target snapshot, extractor selection,
  bounded validation, and sanitized result/error handling.
- Faux extractors for Browser, Explorer, VSCode, PDF reader, and unsupported
  host behavior.
- Current-prompt attachment collection handling and runtime projection tests.
- Lightweight repeated-click protection without a multi-window or background
  state manager.
- Focused contract and isolation tests.

## Exit Criteria

- One capture operation can classify a target, select an extractor, and return
  one bounded attachment or a recoverable error.
- The Side surface remains usable while a one-shot capture is pending.
- Unknown or ambiguous hosts fall back without generic inspection.
- A changed or closed target produces no captured content.
- Repeated user captures accumulate bounded attachments from multiple targets
  without mixing their data or allowing a late result to overwrite another
  attachment.
- An over-budget capture is rejected atomically, and removing an attachment
  allows a later capture to use the freed budget.
- Removed or expired context does not reach the provider and is not persisted.
- Host content is projected as untrusted reference data, not instructions or
  coding-agent context.
- No native handle, credential, or raw extractor payload crosses into React or
  `agent-runtime`.
- Existing Cycle 2/3 summon, Side, Workspace, streaming, cancellation, and
  session behavior remains unchanged except for the explicitly added capture
  entry point.

This plan prepares the capture portions of C4-01 through C4-03 and C4-05
through C4-10 using faux transports. It does not claim real host support,
host actions, or the C4-14 native latency target.

## Checks

Run the focused extractor and projection tests, then the existing quality gate:

```text
npm.cmd run typecheck
npm.cmd run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm.cmd run runtime:test
```

Add focused checks for:

- stable host classification and capability selection;
- one-shot capture result/error sanitization;
- target invalidation during a capture;
- repeated-click accumulation and commit ordering;
- aggregate context bounds, atomic capacity rejection, individual removal,
  expiry, provider projection, and session absence.

## Deferred

- Chromium CDP or browser extension implementation;
- VSCode extension implementation;
- Explorer native/COM integration and real file reads;
- PDF reader-specific integration;
- typed host actions, previews, confirmation, and file/editor mutation;
- multi-window host state, background polling, application inventory, and
  usage insights;
- final per-host default capture fields and production expiry duration.
