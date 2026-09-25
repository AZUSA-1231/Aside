# P6 - Projection, UI, and Closeout Verification

Status: completed 2026-09-04; VSCode integration deferred

Source requirements: Cycle 4 PRD, closeout plan, especially FR-4.1, FR-4.5,
FR-4.6, FR-4.12, FR-4.14, and C4-01 through C4-15.

## Outcome

Expose the selected strategy, capture state, semantic or path result, expiry,
and removal controls through the existing Side/Workspace experience. Complete
the provider projection and regression verification without changing Pi's
workspace wiring or durable session policy.

## UI and IPC

- Keep host classification and capability state in native-owned serialized
  contracts.
- Show the current host/strategy and recoverable capture errors without
  exposing native handles or raw provider data.
- Show path descriptors as reference metadata with clear source and expiry.
- Preserve ordered attachment accumulation, atomic budget rejection, removal,
  expiry, late-result protection, and current-prompt-only lifetime.
- Keep React out of provider-message construction and Pi tool registration.
- Preserve shortcut, focus, Side, Workspace, streaming, cancellation, retry,
  and session behavior.

## Projection and isolation

1. Project sanitized attachments once as untrusted reference data.
2. Remove expired or deleted attachments before provider submission.
3. Keep attachments out of durable session entries and later prompts.
4. Verify that path descriptors are metadata and do not become file reads or
   execution-root changes.
5. Keep capture artifacts locally inspectable without treating them as session
   state.

## Verification matrix

- Chrome and Edge browser capture regression;
- unsupported UIA-exposing application and unavailable UIA;
- Explorer directory/selection path capture through Shell automation with UIA
  fallback;
- VSCode workspace/active-file bridge integration deferred;
- one available PDF reader and one Office host;
- missing, ambiguous, denied, stale, closed, and replacement targets;
- repeated summon/capture, late results, attachment removal, expiry, and
  aggregate budget rejection;
- no second strategy execution or cross-strategy attachment merge.

## Quality gate

Run:

~~~
npm.cmd run typecheck
npm.cmd run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm.cmd run runtime:test
~~~

Run the P4 research probe separately and keep its real-document output local.
Inspect the serialized attachment and provider projection rather than relying
only on the UI summary.

## Documentation closeout

Align the PRD, Architecture, README, and ISSUES.md with the implemented
locator matrix and explicit unavailable cases. Record any host whose locator
could not be proven as a supported capability boundary, not as a silent
failure.

## Exit Criteria

All Cycle 4 closeout criteria pass: deterministic single-strategy routing,
Browser-owned UIA composition, Generic UIA fallback, validated path
descriptors, bounded projection, clean degradation, and unchanged Cycle 2/3
runtime behavior.

## Deferred

Full document extraction in production, browser visual capture, OCR, CDP,
extensions, host actions, file mutation, and Pi workspace/tool wiring.
