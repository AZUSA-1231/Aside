# P4 - Real Host Extraction Research

Status: implemented as an opt-in local research slice

Source requirements: Cycle 4 PRD, closeout plan, especially FR-4.8 through
FR-4.10 and C4-03, C4-05, C4-06, and C4-15.

## Outcome

Build an explicit local probe to learn what real Word, Excel, PDF reader,
VSCode, and Explorer instances expose. The probe may collect a full local
document sample for research, but its output never enters the provider path or
production capture contract.

This is the decision point for future rich extraction. Cycle 4 production still
ships only validated path descriptors unless a later scope explicitly approves
content capture.

## Research boundary

- The user starts the probe explicitly and selects or confirms one target
  window/document. No background polling or application inventory is allowed.
- Bind collection to the selected HWND/PID and revalidate it throughout the
  run. Never silently switch to a newer foreground window.
- Keep artifacts local in a clearly named research directory. Do not upload,
  send to Pi, add to prompt context, or commit real user documents.
- Use read-only host APIs. The probe must not edit, save, navigate, inject,
  execute arbitrary document code, or change the host.
- Support a fixture document with known headings, paragraphs, tables, links,
  metadata, and a deliberately sensitive-looking value to test redaction and
  boundary handling.

## Capture layers

For each explicitly selected target, record separate artifacts:

1. sanitized target manifest: process/application identity, target binding
   fingerprint, host state, timing, and capability results;
2. bounded and, in research mode only, expanded UIA ControlView/ContentView
   trees with provider diagnostics kept outside product context;
3. host-native document metadata and path, where the host exposes a reliable
   locator;
4. full read-only document extraction for the fixture, including paragraphs,
   tables, sheets/cells, or PDF text as supported by that host;
5. a comparison summary showing which fields are stable, target-bound,
   reproducible, sensitive, or absent.

The expanded/full mode is an experiment tool with an explicit opt-in and local
artifact output. It must not be implemented by widening the production UIA
limits or by adding a rich block to the Cycle 4 attachment schema.

## Host probes

- Explorer: compare a target-scoped shell path signal with UIA address/navigation
  controls and selected-item signals.
- VSCode: test process identity, UIA document/editor metadata, workspace signals,
  and any explicitly approved local integration. Treat active-file discovery as
  unavailable unless the signal is target-bound and repeatable.
- Word and Excel: test read-only Office automation/COM metadata and document
  identity against the selected window, then compare it with UIA output. Do not
  infer paths from a title string alone.
- PDF readers: test each available reader independently. Record whether a
  current-document path is exposed reliably; reader-specific text extraction
  remains research output only.

## Decision record

For every candidate field, record:

- source and required permission;
- target binding and replacement-window behavior;
- stability across repeated captures;
- privacy classification and redaction rule;
- size and latency cost;
- whether it belongs in Cycle 4 path-only capture, a future rich-content slice,
  or nowhere in the product.

Update ISSUES.md before changing the release boundary. Do not let a successful
research extraction silently expand the production scope.

## Deliverables

- an opt-in local probe and documented invocation procedure;
- fixture artifacts and sanitized manifests for each available host;
- a capability matrix with positive, missing, ambiguous, stale, and denied
  cases;
- a short decision record for path-only versus future rich extraction;
- no production prompt or session changes.

The executable probe is [host-research-probe.ps1](../../../tools/host-research-probe.ps1)
and its invocation/artifact contract is documented in
[host-research-probe.md](../research/host-research-probe.md). It requires an
explicit HWND and PID, keeps UIA/COM objects inside the probe process, and
writes to a local run directory. `-FullExtraction` is the only switch that
enables document text/cell reads; production strategies remain path-only.

## Exit Criteria

The team can point to real evidence for each host's path locator and knows
which richer fields are technically available, sensitive, unstable, or too
expensive. A host without a reliable locator is explicitly marked unavailable.

## Deferred

Shipping full document extraction, selected-text capture, document parsing,
OCR, screenshots, content sync, and provider-side workspace activation.
