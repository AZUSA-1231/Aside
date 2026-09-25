# P1 - Context-to-Workspace Handoff Hardening

Status: implemented 2026-09-17; Windows manual trace is part of the M2 checkpoint
Depends on: P0 - Capability Contract and Policy Plane
Unblocks: P2 and P7
Source requirements: PRD sections 4.1, 6.1, 13, 14, and C6-06 through C6-08

## Outcome

Harden the existing Cycle 4-to-Cycle 5 loop: React already submits descriptor
attachments in prompt context and runtime resolves them before registering
workspace tools. Correct selection and continuity semantics, then prove the
real desktop workflow. Manual path entry remains recovery.

Review baseline (2026-09-16): descriptorCandidate selects the first item;
Explorer emits its directory before selected items, so the target can become
the directory instead of the selected file. Prior workspace reuse validates
paths/expiry but does not prove task continuity. These are the implementation
gaps; lack of a separate runtime_set_workspace call is not a missing handoff.

The Context Plane still does not read the file or grant authority. The runtime
revalidates the descriptor and owns the resulting task-local workspace state.

## Resolution Contract

Apply sources in this order for the current task:

1. explicit user-selected workspace/target;
2. fresh validated workspace-root or directory descriptor;
3. fresh validated active-file, selected-item, or document descriptor;
4. explicit manual path supplied as recovery;
5. prior task state only when existing Cycle 5 continuation rules prove it is
   the same task and target.

For a file descriptor, bind both its containing directory and workspace-
relative target. For a directory descriptor, bind the directory as workspace.
Do not silently choose one item from an ambiguous multi-selection.

## Tasks

1. Trace and test the existing native capture -> React attachments -> prompt
   context -> protocol -> resolveTaskWorkspace path. Reuse it rather than
   introducing a second set-workspace-before-prompt sequence.
2. Define a bounded handoff object containing descriptor role, canonicalizable
   path, source host/window identity, capture timestamp/expiry, confidence, and
   optional target relationship. Reuse Cycle 4 contracts rather than creating
   a second host-descriptor vocabulary.
3. Preserve prompt-scoped handoff and define root selection separately from
   target selection. An Explorer directory may establish the root while its
   single selected file establishes the target. Test directory plus file,
   reversed ordering, competing roots, and multi-selection without guessing.
4. Revalidate existence, resource kind, containing directory, canonical path,
   reparse containment, accessibility, freshness, and task correlation in the
   runtime before activating workspace tools.
5. Define deterministic behavior for directories, single files, selected
   files, deleted/renamed resources, multi-selection, unsupported schemes,
   virtual shell items, and conflicting explicit selection.
6. Preserve target provenance in the TaskRun snapshot and model context as
   bounded reference data. Do not persist it as blanket session authority.
7. Emit clear resolved, unresolved, stale, ambiguous, and overridden events.
   React displays the runtime's canonical decision and never resolves paths.
8. Ensure late capture results, window changes, repeated prompts, cancellation,
   and restored sessions cannot retarget an active task.
   Define explicit task-continuation identity and new-task behavior before
   reusing previousWorkspace; do not infer continuity merely from process
   lifetime or the generic current-task flow label.
9. Retain manual set/clear workspace controls as fallback and confirm explicit
   user choice has higher priority for the task.
10. Add Rust/TypeScript/runtime tests across the full handoff plus manual
    Windows scenarios for Explorer, a supported document host, and stale
    descriptors.

## Deliverables

- One native-to-runtime descriptor handoff contract.
- Automatic task-local workspace and target activation.
- Runtime resolution/provenance events and React projection.
- Race, stale, ambiguity, and precedence coverage.
- Manual recovery through existing explicit workspace controls.

## Exit Criteria

- C6-06 binds a captured file's containing directory and target before the
  first file tool call with no manual path entry.
- C6-07 binds a captured directory/workspace root after runtime revalidation.
- C6-08 rejects stale, inaccessible, virtual, or ambiguous targets without
  choosing a guessed workspace.
- Capture remains passive: no resource content is read until the model invokes
  an active workspace/document tool.
- Explicit task-local user selection wins over inferred context, and late
  results cannot change an active run.
- Session restoration does not restore a descriptor as current authority.

## Checks

Run focused native capture/path tests, protocol tests, runtime workspace tests,
React typecheck/build, and the complete quality gate. Perform a Windows manual
trace from summon through the first `workspace.read` event and record the
canonical workspace/target supplied at every boundary.

## Verification

### Result (2026-09-17)

Full gate: `typecheck` pass; `build` pass; `runtime:test` **155/155** (140 from
before P1, 15 new in `workspace-handoff.test.mjs`); `git diff --check` clean.

**Root and target are selected independently.** `selectDescriptorHandoff`
partitions captured descriptors by role: `workspace_root`/`directory` establish
the root, `active_file`/`selected_item`/`document` establish the target. Array
order is not significant, so the Explorer ordering that previously made the
directory the target — and the reverse — resolve identically (tested by deep
equality). A bare file descriptor keeps its containing directory as the root,
which is the Cycle 5 behaviour and what an explicit file path still does.

**Ambiguity refuses to guess.** Two distinct roots, or two distinct targets,
raise `ambiguous_descriptor`. The same resource reported under two roles is a
duplicate, not a conflict, and is collapsed by comparison path.

**Stale and unusable captures are honest.** `descriptor_expired`, `not_found`,
`wrong_type`, and `scope_escape` are rejected before activation, and a declared
kind that disagrees with the resource fails rather than being reinterpreted.

**A resolution failure is recoverable, not fatal.** `prompt()` catches a
`WorkspaceError` from resolution and reports `workspace_unresolved` with its
code, so the run continues without scoped tools and the model still answers
(C6-08). Previously any resolution error failed the run.

**Explicit selection outranks a capture** and reports
`workspace_overridden { replaced_by, captured_path }`. That event is emitted and
typed but not yet rendered: `workspace_resolved` already carries the
authoritative canonical path and source, which is what the surface displays, so
rendering the override is P7 polish rather than a P1 gap.

**Continuity is explicit** (C6-I021). `continuation_id` comes from the durable
session; a prior workspace is reused only for the same identity, and a changed
session reports `workspace_required` instead of inheriting.

### Still outstanding

- The full Windows manual trace — summon through the first `workspace.read`
  event, recording the canonical workspace and target at each boundary, plus a
  supported document host and a stale descriptor — is P7 work. The M2 happy
  path passed on 2026-09-17 (see [PLAN](../PLAN.md#m2-local-capability-foundation-p1-p2)):
  a captured text file was read and modified end to end. That run did not
  separately confirm the root/target split at the surface, which remains for
  P7.
- No pre-read or durable workspace grant was introduced: capture still supplies
  a descriptor only, the runtime revalidates it, and `continuation_id` lives on
  the transient resolution state, not in the durable session.
- Cycle 4 host-specific limitations are unchanged.
