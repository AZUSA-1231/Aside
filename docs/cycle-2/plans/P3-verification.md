# C2-P3 - Integrated Verification

Status: pending C2-P1 and C2-P2 manual acceptance
Depends on: C2-P1 - Shared Side Surface and C2-P2 - Shortcut Replacement
Unblocks: Cycle 2 release decision

## Outcome

Verify the Side surface as a focused Cycle 2 change and close the cycle with
explicit evidence. This plan does not reopen the deferred Cycle 1 provider
acceptance or add new product scope.

## Tasks

1. Run the complete geometry matrix on the primary display: desktop, ordinary
   window, maximized window, hide/show, Pin, and Workspace restore.
2. Verify no accidental target leak at the left, top, bottom, or right work-area
   edges, and distinguish intentional visual inset from native placement error.
3. Repeat the relevant matrix on a secondary monitor and mixed-DPI layout.
4. Exercise target closure or identity invalidation and confirm safe restoration
   behavior remains unchanged.
5. Test `Ctrl + Alt + A`, input-method switching, `Ctrl + A` selection, and
   restart after hiding Aside.
6. Run the existing frontend, Rust, and runtime quality checks.
7. Record results, accepted Windows-frame/DPI limitations, and the release
   decision in a new Cycle 2 verification record.

## Deliverables

- Cycle 2 verification record.
- Regression evidence for Cycle 1 behavior.
- Explicit release decision and known limitations.

## Exit Criteria

- C2-01 through C2-10 pass, or every exception is an explicit accepted
  limitation with an owner.
- The complete engineering quality gate passes.
- No keyboard injection, content inspection, or unrelated Windows capability
  was added.
- The Cycle 2 implementation remains within the PRD and architecture
  boundaries.

## Verification

Record monitor layout, DPI, Windows version, target applications, shortcut
state, and exact observed seam behavior. Do not mark real-provider conversation
acceptance as part of this cycle.
