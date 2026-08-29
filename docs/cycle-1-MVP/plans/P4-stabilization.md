# P4 - Stabilization and MVP Release

Status: complete with accepted limitations
Depends on: [P2 - Pin and Workspace](./P2-pin-and-workspace.md) and
[P3 - Pi Conversation Runtime](./P3-conversation-runtime.md)
Unblocks: Cycle 1 MVP release decision

## Outcome

Turn the feature-complete prototype into a coherent Cycle 1 MVP candidate.
Resolve cross-feature races and platform edge cases, run the complete quality
gate, and leave an evidence-based release decision.

## Tasks

1. Exercise shortcut, focus, visibility, Pin, workspace, and conversation
   transitions under repeated and out-of-order operations.
2. Test target closure, identity mismatch, display changes, and failed native
   operations across the full hide and exit flows.
3. Fix DPI scaling, work-area origin, monitor selection, and resize-rounding
   issues.
4. Verify clean startup, hide, reopen, restart, and shutdown behavior while a
   conversation or workspace operation is active where applicable.
5. Complete pure Rust tests for geometry, target validation, snapshot policy,
   and restoration safety.
6. Complete frontend interaction tests around mocked Tauri commands and events.
7. Run manual checks for elevated applications, sleep/resume, mixed DPI,
   multi-monitor layouts, taskbar configurations, and target application
   closure.
8. Review Tauri capabilities, provider-secret handling, and diagnostic
   redaction.
9. Confirm keyboard navigation, focus visibility, and reduced-motion behavior.
10. Record every acceptance scenario, unresolved limitation, owner, and release
    decision in [VERIFICATION.md](../VERIFICATION.md).
11. Record packaging and distribution as a later release task if they remain
    outside the current development checkpoint.

## Deliverables

- Completed MVP verification record.
- Regression tests for native state and runtime races.
- Known-limitations list with explicit ownership.
- Release-candidate decision for Cycle 1.

## Exit Criteria

- AC-01 through AC-11 pass, or each exception has an explicitly accepted
  limitation.
- The complete engineering quality gate passes:
  `npm.cmd run typecheck`, `npm.cmd run build`,
  `cargo fmt --manifest-path src-tauri/Cargo.toml --check`, and
  `cargo check --manifest-path src-tauri/Cargo.toml`.
- Any unresolved manual scenario has an owner and a release decision.
- The MVP remains within [ARCHITECTURE.md](../../ARCHITECTURE.md) boundaries.
- [VERIFICATION.md](../VERIFICATION.md) is complete enough for another person
  to reproduce the decision.

## Verification

Use the scenario matrix in [VERIFICATION.md](../VERIFICATION.md). Attach test
results and concise manual notes; do not place pass/fail status or environment
details back into the PRD.
