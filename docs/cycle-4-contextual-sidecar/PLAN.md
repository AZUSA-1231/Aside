# Cycle 4 Contextual Sidecar Closeout Plan

Status: completed 2026-09-04; Explorer locator verified; VSCode integration deferred
Scope decision: 2026-09-03

This is the single implementation plan for the remaining Cycle 4 scope. The
stages below are an execution order for one bounded delivery; they are not
separate feature plans and must not be used to expand the product scope one
stage at a time. The governing requirements are in the
[Cycle 4 PRD](./PRD.md), the long-lived ownership rules are in the
[Architecture](../ARCHITECTURE.md), and decisions are recorded in
[ISSUES.md](./ISSUES.md).

## Closeout invariant

```text
foreground target snapshot
  -> ordered specialized strategy selection
  -> execute exactly one selected strategy
       Browser: Generic UIA + browser metadata inside Browser.capture()
       Explorer/document: path discovery inside the path strategy
       VSCode: existing conservative UIA attempt; bridge work deferred
       no specialized match: bounded Generic UIA fallback
  -> validate one Aside-owned attachment
  -> expose path/workspace descriptor when available
```

The router chooses a composition; it does not run Generic UIA first, append a
specialized result later, or silently downgrade a matched strategy after it
fails. Shared UIA code is a transport, not a host policy module.

The initial specialized priority is Browser, VSCode, Explorer, then Document.
The values are stable registry data, not runtime state. A future strategy may
insert itself only with an explicit priority and matching tests; equal-priority
matches are an ambiguity error. Generic UIA has no priority because it is
selected only after the specialized registry returns no match.

The minimum path descriptor is:

```json
{
  "role": "workspace_root | active_file | directory | selected_item | document",
  "path": "C:/canonical/absolute/path",
  "kind": "file | directory"
}
```

## Current host status

- Explorer path capture is implemented with target-bound Shell automation as
  the primary locator and bounded UIA as a compatibility fallback.
- VSCode extension, IPC bridge, and active-editor integration are deferred.
  The existing conservative UIA-only strategy remains unchanged and is not a
  new delivery target for this scope.

The native locator owns canonicalization, existence/type validation, and path
limits. The descriptor carries no file bytes or native capability and does not
grant the agent permission to read or mutate the resource.

## Stages

Detailed execution plans for the remaining stages:

- [P2 - Strategy router and contracts](./plans/P2-strategy-router-and-contracts.md)
- [P3 - Generic bounded UIA fallback](./plans/P3-generic-uia-fallback.md)
- [P4 - Real host extraction research](./plans/P4-real-host-extraction-research.md)
- [P5 - Path strategies and workspace descriptors](./plans/P5-path-strategies-and-descriptors.md)
- [P6 - Projection, UI, and closeout verification](./plans/P6-projection-ui-and-verification.md)

### 1. Contracts and strategy registry

- Define the stable target snapshot, host view, strategy capability, capture
  request/result, error, attachment, and path/workspace descriptor contracts.
- Keep native handles, COM objects, provider secrets, and raw host payloads
  inside the native boundary.
- Replace implicit adapter ordering with an explicit ordered strategy registry.
  It selects one specialized match by stable application identity and
  deterministic priority; ambiguous ties are reported explicitly.
- Keep Generic UIA outside the normal matching list as the dedicated fallback.
- Add a one-result invariant and deterministic faux strategy tests.

### 2. Generic bounded UIA strategy

- Keep COM lifecycle, bounded traversal, normalization, node limits, and
  transport diagnostics in the shared UIA module.
- Add a Generic UIA strategy that performs one bounded semantic snapshot for
  any target with a usable UIA surface and returns an honest unavailable result
  otherwise.
- Do not use title guessing, OCR, screenshots, clipboard simulation, or
  unbounded accessibility traversal as a fallback.
- Verify that the strategy is useful for ordinary UIA-exposing applications
  such as messaging, media, and game interfaces.

### 3. Browser strategy composition

- Match Chromium browser identities using stable process/application identity.
- In `Browser.capture()`, call the shared bounded UIA transport and add only
  browser-specific metadata: selected tab, title, sanitized URL, and semantic
  page fields already covered by the Browser contract.
- Keep browser metadata and semantic nodes in one Browser-owned attachment.
  The router must not merge a separate Generic UIA attachment.
- Preserve one-shot target validation, dedicated COM worker behavior, bounded
  depth/node limits, and artifact inspection rules.
- Keep CDP, extensions, screenshots, OCR, visual capture, and browser actions
  outside this closeout.

### 4. Path-first file-host strategies

- Keep the existing conservative VSCode strategy bounded and unchanged; defer
  extension and bridge integration.
- Implement the Windows Explorer strategy with target-bound Shell automation,
  using UIA address/selection signals only as a compatibility fallback.
- Keep document hosts (PDF, Word, and Excel when a reliable locator is
  available) path-first.
- Each strategy locates and canonicalizes only the relevant workspace root,
  active file, current directory, selected item, or current document path.
- Validate path type and boundary before staging a descriptor. A missing or
  ambiguous locator returns an explicit unavailable result; never infer from a
  window title.
- Do not capture editor/Explorer/document layout, read file contents, parse
  documents, collect diagnostics, or perform host actions.
- Add faux and host-boundary tests for path normalization, invalid paths,
  stale targets, permission errors, and locator absence.

### 5. Workspace descriptor boundary, without Pi wiring

- Define a serializable descriptor containing resource role, canonical path,
  target host, and workspace/file/directory kind as appropriate.
- Stage and display the descriptor as reference metadata that can be handed to
  a future agent workspace integration.
- Do not import `pi-coding-agent`, register coding-agent tools, change the
  Aside session storage root, or call `process.chdir()` in this closeout.
- Leave a narrow future execution-root interface: a later integration can
  supply the descriptor to Pi's existing coding-agent tools per run while
  keeping durable Aside session storage independent.

### 6. Projection, UI, tests, and documentation

- Preserve ordered attachment collection, aggregate limits, expiry, removal,
  and non-persistence in the existing Cycle 3 projection.
- Show host strategy, capture status, and path descriptor without exposing raw
  native objects or constructing provider messages in React.
- Test strategy priority, ambiguity, one-strategy execution, Browser internal
  composition, Generic UIA fallback, path-only captures, stale-target
  rejection, aggregate-budget atomicity, expiry, and session isolation.
- Verify the existing rail, summon/focus, Workspace, streaming, cancellation,
  and session behavior remains intact.
- Run focused tests and the repository quality gate, then perform manual
  checks with Chromium, Explorer, one document app, and one ordinary UIA-
  exposing application where available. VSCode bridge verification is deferred.
- Keep PRD, Architecture, README, and ISSUES aligned with this closeout.

## Exit criteria

Cycle 4 closes when all of the following are true:

1. The router selects one specialized strategy deterministically and never
   assembles generic and specialized results outside that strategy.
2. Browser strategy capture internally composes bounded Generic UIA with
   browser metadata.
3. An unmatched UIA-exposing window receives one bounded Generic UIA attempt;
   unavailable UIA is reported honestly.
4. Explorer and supported PDF/Word/Excel windows return validated path
   descriptors when reliable locators exist. VSCode bridge and active-editor
   integration remain deferred.
5. Descriptors are serializable, visible, and ready for future workspace
   replacement, while Pi workspace/tool wiring remains absent.
6. Path captures do not read or mutate files, and rich host actions/content,
   visual capture, OCR, CDP, and extensions remain deferred.
7. Existing Side/Workspace, runtime, projection, and session behavior passes
   its regression checks.

## Deferred follow-up

The next scope may add Pi workspace activation by supplying a per-run
execution root, browser visual capture, richer document/editor content, or
typed host actions. Each addition requires its own capability, privacy,
permission, expiry, target-validation, and acceptance review; none is implied
by this plan.
