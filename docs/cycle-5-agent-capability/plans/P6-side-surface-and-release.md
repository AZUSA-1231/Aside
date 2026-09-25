# P6 - Side Surface and Release Verification

Status: surface implemented (2026-09-07); M0 acceptance matrix complete (2026-09-16); manual Windows evidence and the release decision moved to Cycle 6 P7 by C6-I020 (2026-09-17)
Depends on: P5 - Session, IPC, and Protocol Integration
Unblocks: Cycle 5 release decision
Source requirements: Cycle 5 PRD sections 12 through 19 and all acceptance criteria

## Outcome

Make the existing Side rail a clear autonomous task surface and close Cycle 5
with deterministic, boundary, native, and manual evidence. The UI shows the
runtime's serialized workspace, active skill, tool, permission, verification,
and terminal states; it never becomes an execution authority.

## Surface States

The rail must distinguish at least:

- no workspace and a non-file conversation;
- workspace resolved from an explicit selection or Cycle 4 descriptor;
- reading, searching, and stat inspection;
- model continuation between tool steps;
- permission requested, approved/executing, denied, expired, or invalidated;
- verification in progress and its actual result;
- completed, cancelled, failed, unsupported, stale, and persistence-warning
  outcomes.

Permission controls must be interruptible. Cancel remains available while a
decision is pending, and a denial must return an explicit result to the same
agent loop instead of leaving the UI waiting forever.

## Tasks

1. Add React-facing state projection for task/workspace identity, target,
   active skill, tool activity, bounded tool result summaries, permission
   preview/decision, verification, and terminal status.
2. Add explicit allow, deny, cancel, set-workspace, and clear-workspace IPC
   actions. Keep the runtime's canonical path and policy result authoritative;
   React should display the canonical value supplied by the runtime.
3. Preserve Cycle 2/4 summon, focus, Side/Workspace, capture, attachment,
   streaming, cancellation, retry, and session behavior. Ensure restored
   history cannot be overwritten by the welcome state or stale run events.
4. Verify that tool activity and permission state do not expose raw arguments,
   file bytes beyond the bounded preview, provider secrets, native handles, or
   hidden skill source.
5. Build a deterministic acceptance matrix for all C5-01 through C5-40
   scenarios, linking each result to a test, serialized artifact, or concise
   manual note. Record exceptions in [ISSUES.md](../ISSUES.md).
6. Run the complete engineering gate and perform Windows checks with a real
   captured Explorer/document descriptor, a text/JSON workspace, target
   closure/replacement, repeated permission decisions, and cancellation.
7. Review the release boundary and update PRD/PLAN/README/ISSUES status only
   after the implementation evidence supports the claim. Keep unsupported
   binary formats and deferred capabilities explicit.

## Deliverables

- Task-aware Side rail projection and permission controls.
- Regression coverage for existing window, capture, runtime, and session flows.
- C5 acceptance matrix with deterministic and Windows manual evidence.
- Updated issues log and release decision with explicit limitations.

## Exit Criteria

- C5-38 existing Side/Workspace, capture, window, and restoration behavior is
  unchanged under the new runtime states.
- C5-20 and C5-33 are understandable in the rail and match runtime results;
  denied or unexecuted writes are never shown as complete.
- C5-40 covers loop continuation, workspace scope, permission races, skills,
  cancellation, persistence, and stale-target rejection with faux seams.
- The full quality gate in `PLAN.md` passes, and manual Windows evidence is
  recorded for the supported document workflow.
- The PRD release boundary is met or every exception is explicitly deferred
  outside Cycle 5 with no misleading parity claim.

## Checks

```text
npm.cmd run typecheck
npm.cmd run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm.cmd run runtime:test
```

Also inspect serialized runtime events and stored session entries directly;
the visible UI summary alone is not sufficient evidence for permission,
workspace, privacy, or persistence behavior.

## Verification

### Remaining Closeout Work (M0)

This checklist owns Cycle 5 closeout; Cycle 6 links here. Review baseline:
`5e25fee`, 2026-09-16. Typecheck/build, cargo fmt/check, runtime 80/80, Rust
30/30, and git diff --check passed. Manual acceptance was not performed.

**Manual items below are now performed at the Cycle 6 P7 release gate.** By
[C6-I020](../../cycle-6/ISSUES.md#c6-i020---cycle-5-manual-acceptance-moves-to-the-p7-release-gate),
the manual pass and the Cycle 5 release decision are absorbed into P7's combined
acceptance, because P1 and P2 change the same descriptor-selection and
continuation paths these criteria exercise. The matrix below is complete and
stays the authority for what must be run; Cycle 5 is not recorded as released
until P7 runs it.

- [x] Add the C5-01 through C5-40 matrix: criterion, deterministic evidence,
  required manual evidence, result, and issue link. See
  [Acceptance Matrix](#acceptance-matrix-c5-01-through-c5-40) below. Unit tests
  do not substitute for desktop acceptance, so every criterion that requires a
  real window, capture, or interactive decision stays `pending manual`.
- [ ] Exercise Explorer single-file and supported document-host capture on
  Windows: summon, inspect staged descriptors, submit, observe automatic
  workspace/target binding, read text/JSON, and continue the same tool loop.
  Record directory versus selected-file behavior. Test manual workspace entry
  separately as recovery, not as proof of automatic handoff.
- [ ] Exercise read -> transform -> preview -> Allow -> write -> verification.
  Also test Deny, cancel while permission is pending, duplicate/stale approval,
  and target deletion/replacement before approval. Confirm unsuccessful writes
  leave files unchanged and the UI settles once.
- [ ] Check shortcut/focus, Side/Workspace restore, attachment removal/expiry,
  streaming/Stop/retry, target-window closure, and restart/history restoration.
  Confirm pending permission, workspace authority, and skill instructions do
  not become restored authority.
- [ ] Record date, build/commit, host/OS, synthetic fixture, steps,
  expected/actual result, and bounded evidence for each manual check. Exclude
  secrets and personal contents.
- [ ] Fix failures against C5 acceptance or document a reduced release claim
  in ISSUES/PLAN. Link new selection/task-continuity scope to Cycle 6 P1 and
  continuation scope to P2; do not silently defer existing obligations.
- [ ] State limitations: no desktop skill activation, text-input workspace
  recovery, no PDF/DOCX content adapter. Distinguish development-build
  acceptance from distributable installation support (Cycle 6 P0/P7).
- [ ] Rerun the engineering gate after fixes and record final counts.
- [ ] Record the release decision; reconcile PRD/PLAN/P6/ISSUES, stale earlier
  cycle status headers, architecture workspace descriptions, and README claims
  against evidence. Preserve the current local-only docs policy.

M0 exit requires an evidence-backed disposition for every C5 criterion,
actual results for required Windows workflows, owners for limitations, and
an explicit release decision. Keep pending status until then.

### Acceptance Matrix (C5-01 through C5-40)

Baseline: `5e25fee`, 2026-09-16. Gate re-run at matrix construction:
`typecheck` pass; `build` pass; `runtime:test` 80/80; `cargo fmt --check`
pass; `cargo check` pass; `cargo test` 30/30; `git diff --check` clean.

Result vocabulary: `test` (deterministic evidence exists), `manual` (desktop
evidence required and not yet performed), `deferred` (explicitly outside
Cycle 5, with an owner). No row is `passed` on unit-test evidence alone when
the criterion names UI, capture, or an interactive decision.

| ID | Deterministic evidence | Manual evidence required | Result |
| --- | --- | --- | --- |
| C5-01 | `streams a successful response`; `rejects an overlapping request without disturbing the active run` | Non-file question with no workspace bound | test + manual |
| C5-02 | `resolves a file descriptor to its containing workspace`; `projects text and JSON context for one run only` | Real Explorer capture binds workspace before first read | test + manual |
| C5-03 | `continues the same Pi loop across two registered tool results` | — | test |
| C5-04 | `validates task, limit, registry, and bounded result contracts`; `an approved write reports an underlying atomic failure without claiming success` | Rail never shows an unexecuted write as complete | test + manual |
| C5-05 | `cancels a streaming response`; `ignores late cancellation after the request has settled`; `tool limits fail closed with one terminal event` | Stop during model turn and during pending permission | test + manual |
| C5-06 | `resolves a file descriptor to its containing workspace` | Explorer single-file capture on `report.docx` | test + manual |
| C5-07 | `resolves a file descriptor to its containing workspace` | Workspace-root descriptor capture | test + manual |
| C5-08 | `keeps task workspace resolution separate from process cwd` | Relative read resolves in the rail-displayed workspace | test + manual |
| C5-09 | `rejects lexical escapes and symlink targets outside the workspace` | — | test |
| C5-10 | `does not expose an environment when no workspace candidate exists` | Missing/stale workspace prompts for a new one | test + manual |
| C5-11 | `forwards permission responses, workspace changes, and the full event vocabulary`; `reports a set-workspace failure as a recoverable session warning` | Switch workspace mid-task; session storage unchanged | test + manual |
| C5-12 | `revalidates a prepared target and detects replacement` | Target replaced while run is active | test + manual |
| C5-13 | `validates task, limit, registry, and bounded result contracts`; `publishes a validated registry with bounded workspace read tools` | Registry inspection shows no shell tool | test |
| C5-14 | `lists, stats, reads text and JSON, and searches only by explicit call` | Read/list/search/stat with no write prompt | test + manual |
| C5-15 | `lists, stats, reads text and JSON, and searches only by explicit call` | — | test |
| C5-16 | `returns typed unsupported, scope, missing, limit, and cancellation results` | Unsupported format in the rail, no shell fallback | test + manual |
| C5-17 | `validates task, limit, registry, and bounded result contracts` | — | test |
| C5-18 | `tool limits fail closed with one terminal event` | — | test |
| C5-19 | `write and edit prepare exact previews and execute only after allow` | Write does not start before the decision in the rail | test + manual |
| C5-20 | `write and edit prepare exact previews and execute only after allow` | Rail shows exact workspace, target, effect, bounded summary | manual |
| C5-21 | `a runtime write resumes the same Pi loop only after the exact permission response`; `permission broker binds one exact operation and rejects duplicate or mismatched responses` | Allow executes once and returns to the loop | test + manual |
| C5-22 | `permission broker returns bounded denial, cancellation, and expiry outcomes`; `deny, expiry, cancellation, invalid edits, and stale targets never mutate the workspace` | Deny leaves the file unchanged and settles the UI once | test + manual |
| C5-23 | `permission expiry and target creation races fail closed` | Cancel/expire while permission is pending | test + manual |
| C5-24 | `revalidates a prepared target and detects replacement`; `permission expiry and target creation races fail closed` | Stale approval rejected after target replacement | test + manual |
| C5-25 | `write registry keeps non-replayable descriptors and accepts the shared adapter seam` | Restart before a write does not replay it | test + manual |
| C5-26 | `two writes in one assistant response require two independent approvals` | Second write prompts again | test + manual |
| C5-27 | `loads a valid builtin layout with bounded metadata and expectations`; `publishes loaded skills in the ready event and exposes the active skill`; `builds a bounded manifest that lists only model-invocable skills` | — | test |
| C5-28 | `diagnoses and skips malformed frontmatter`; `diagnoses and skips invalid names and missing descriptions`; `diagnoses non-UTF-8 skill files as unsupported encoding`; `diagnoses oversized files and instructions without loading them`; `rejects a non-array skills option at the runtime boundary` | — | test |
| C5-29 | `a skill-invoked write still requires the runtime permission broker`; `projects bounded instructions for the active skill and leaves the transcript clean` | Skill runs against the active workspace | test + manual |
| C5-30 | `a skill cannot invoke an unregistered capability`; `a skill cannot use workspace tools when no workspace is resolved`; `activation never changes the model-visible tool registry` | — | test |
| C5-31 | `lists, stats, reads text and JSON, and searches only by explicit call`; `validates a custom document adapter seam` | Read and summarize without a write | test + manual |
| C5-32 | `JSON writes require parse validation and report verified content`; `an approved write reports an underlying atomic failure without claiming success` | Revise a document through preview → Allow | test + manual |
| C5-33 | `JSON writes require parse validation and report verified content`; `revalidates a prepared target and detects replacement` | Follow-up read/stat verification shown in the rail | test + manual |
| C5-34 | `persists only bounded messages and restores no workspace, permission, or skill state`; `persists finalized messages and restores the active Aside session` | Restart after a completed task; no restored authority | test + manual |
| C5-35 | `persists only bounded messages and restores no workspace, permission, or skill state`; `sanitizes provider credentials in failure events`; `injects file credentials into Pi auth without mutating process.env` | Inspect the JSONL store for secrets/handles | test + manual |
| C5-36 | Direct inspection 2026-09-16: no `pi-`/`@earendil` import, `node:fs`, or `process.chdir` in `src/` or `shared/`; no Pi, `node:fs`, or `Command` reference in `src-tauri/src/` | — | test |
| C5-37 | `forwards permission responses, workspace changes, and the full event vocabulary`; `parses only the Aside prompt and cancel request vocabulary`; `parses the permission, set-workspace, and clear-workspace vocabulary` | — | test |
| C5-38 | Rust suite: 30/30 covering window geometry, UIA capture, context routing, and path contracts | Summon/focus, Side/Workspace restore, attachment removal, streaming/Stop/retry, target closure, restart restoration | test + manual |
| C5-39 | `reports a provider failure and can retry`; `sanitizes provider credentials in failure events`; `emits one terminal event when a runtime rejects after settling`; `emits a recoverable warning when persistence fails` | — | test |
| C5-40 | Whole `runtime:test` suite, 80/80: loop continuation, workspace scope, permission races, skill loading, cancellation, persistence, stale-target rejection, all on faux seams | — | test |

Criteria requiring desktop evidence: C5-01, C5-02, C5-04, C5-05, C5-06,
C5-07, C5-08, C5-10, C5-11, C5-12, C5-14, C5-16, C5-19, C5-21, C5-22, C5-23,
C5-24, C5-25, C5-26, C5-29, C5-31, C5-32, C5-33, C5-34, C5-35, C5-38. The
matrix is complete and evidence-linked; the manual column is the outstanding
M0 work. No criterion is recorded as passed on automated evidence alone.

Known limitations to state in the release decision (from C6-I008 and the
Cycle 5 scope): no desktop skill activation, text-input workspace recovery
only, and no PDF/DOCX content adapter in Cycle 5. Cycle 5 acceptance is a
development-build acceptance; distributable installation support is
Cycle 6 P0/P7 work (C6-I010).

### Prior Implementation Evidence (2026-09-07)

- The React contracts carry the full runtime event vocabulary (workspace,
  tool, skill, permission, verification, and terminal states). The Side rail
  renders a workspace chip with canonical path/source and clear control, a
  set-workspace path input, an active-skill chip, tool activity, verification
  status, and a permission card with Allow/Deny actions. The runtime's
  canonical values are displayed as supplied; React never resolves paths or
  executes writes.
- Permission controls round-trip through new IPC actions
  (`runtime_permission_response`, `runtime_set_workspace`,
  `runtime_clear_workspace`) to the runtime broker with exact request/task/tool
  identity. Denying or canceling returns an explicit typed result to the same
  agent loop; the composer Stop remains available while a decision is pending.
- `npm.cmd run typecheck` and `npm.cmd run build` passed; the new UI adds no
  Pi imports, filesystem implementation, or provider message constructor.
- The full engineering gate passes: 80 runtime tests, 30 Rust tests, typecheck,
  build, cargo fmt/check. The deterministic suite covers loop continuation,
  workspace scope, permission round trips, skills, cancellation, persistence,
  and stale-target rejection with faux seams (C5-40).
- Manual Windows checks remain the release-gate responsibility in
  `PLAN.md`; the serialized events and stored session entries are verified by
  the protocol and session tests rather than by the visible UI alone.
