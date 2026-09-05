# P6 - Side Surface and Release Verification

Status: planning
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
