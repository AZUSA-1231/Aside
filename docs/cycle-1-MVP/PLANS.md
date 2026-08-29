# Cycle 1 MVP Implementation Plans

Status: execution index
Source requirements: [Cycle 1 MVP PRD](./PRD.md)
Technical constraints: [Project Architecture](../ARCHITECTURE.md)
Verification results: [Cycle 1 verification record](./VERIFICATION.md)

Current checkpoint: Cycle 1 MVP closed with accepted limitations. The core
window experience is accepted. Configured-provider conversation verification
and visual/detail polish are intentionally deferred to a later checkpoint.

The PRD defines the product behavior. This document only organizes the work
needed to deliver it. Detailed tasks live in one file per plan so each unit can
be reviewed, executed, and closed independently.

## Delivery Map

```text
P0 Foundation and Native Boundary
  -> P1 Floating Agent
       -> P2 Pin and Workspace
       -> P3 Pi Conversation Runtime
            P2 + P3 -> P4 Stabilization and MVP Release
```

P2 and P3 may proceed in parallel after P1. P4 starts only after both are
complete.

| ID | Plan | Purpose | Depends on |
| --- | --- | --- | --- |
| P0 | [Foundation and Native Boundary](./plans/P0-foundation.md) | Establish project contracts, ownership boundaries, and test seams. | Existing project setup |
| P1 | [Floating Agent](./plans/P1-floating-agent.md) | Deliver the summonable panel and its basic window lifecycle. | P0 |
| P2 | [Pin and Workspace](./plans/P2-pin-and-workspace.md) | Add Pin, foreground-window context, 80/20 layout, and safe restoration. | P1 |
| P3 | [Pi Conversation Runtime](./plans/P3-conversation-runtime.md) | Add the isolated streaming conversation runtime and chat behavior. | P1 |
| P4 | [Stabilization and MVP Release](./plans/P4-stabilization.md) | Verify the integrated MVP, resolve races and platform gaps, and make the release decision. | P2 and P3 |

## How to Use These Plans

Each plan contains only its own outcome, tasks, deliverables, dependencies,
exit criteria, and verification steps. A plan is complete when its exit
criteria pass and the evidence is added to the [verification record](./VERIFICATION.md).

The shared rules are:

- A product behavior change is first reflected in the PRD.
- A lasting technical-boundary change is first reflected in Architecture.
- Native work includes a short manual verification record.
- Engineering checks are run at the plan boundaries and recorded with the
  result, not added to the PRD.
- Cycle 1 work stays on `main`, and each completed plan should be reviewable as
  a focused change.

## Engineering Quality Gate

The final MVP gate is:

```text
npm.cmd run typecheck
npm.cmd run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml
```

P0 verifies that these commands are repeatable in the development environment.
P4 runs the complete gate after all feature plans are integrated.

## PRD Traceability

| Product area | Implementation plan | Acceptance criteria |
| --- | --- | --- |
| Lifecycle, panel, shortcut, placement, focus, move, and resize | P0, P1, P4 | AC-01, AC-02, AC-04, AC-08, AC-11 |
| Pin, foreground context, multi-monitor placement, workspace, and restoration | P0, P1, P2, P4 | AC-03, AC-05, AC-06, AC-07 |
| Conversation, streaming, cancellation, retry, and provider failure | P0, P1, P3, P4 | AC-09, AC-10 |
| Cross-feature races, accessibility, privacy, and release evidence | P4 | All applicable criteria |

## Deferred from Every Cycle 1 Plan

- Domain tools for reminders, schedules, notes, or file actions.
- Tray menu and launch-at-startup behavior.
- Companion pets, idle animation systems, and desktop decoration.
- PowerToys-like utilities.
- Browser extensions, OCR, screen understanding, and Accessibility APIs.
- Windows Shell integration and broad input monitoring.
- Authentication, cloud sync, telemetry, and multi-user behavior.
