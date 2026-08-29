# Cycle 1 MVP Verification Record

Status: accepted with limitations
Requirements: [PRD](./PRD.md)
Plans: [implementation plan index](./PLANS.md)

This document records evidence from implementation and validation. It is not a
place to add requirements or implementation tasks. Update it during P4 and
whenever a plan completes a native or runtime verification step.

## Environment

| Field | Value |
| --- | --- |
| Verification date | 2026-08-29 |
| Aside commit | New local repository initial snapshot; no remote configured |
| Windows version | Windows 10.0.26200.9168 |
| Node and npm versions | Node `v22.23.2`; npm `10.9.8` |
| Rust toolchain | `rustc 1.98.0`; Cargo `1.98.0`; MSVC target |
| Monitor layout and DPI | Core interaction verified by user; detailed monitor matrix deferred |
| Provider/test mode | Fake provider tests; no-key JSONL smoke check; configured provider acceptance deferred |

## Acceptance Scenarios

Use `Pass`, `Fail`, or `Accepted limitation`. Link to a test or include concise
manual reproduction notes in the evidence column.

| ID | Result | Evidence / notes | Owner |
| --- | --- | --- | --- |
| AC-01 | Pass | User manually confirmed on Windows that `Ctrl + Space` summons the panel after the startup registration fix. | User |
| AC-02 | Pass | User confirmed that a normal foreground application remains unchanged and Aside uses Floating Mode. | User |
| AC-03 | Pass | User confirmed the maximized-application Workspace interaction and 80/20 arrangement. | User |
| AC-04 | Pass | User confirmed shortcut toggle hide/show and the associated window lifecycle behavior. | User |
| AC-05 | Pass | User confirmed Pin interaction and its visible state change. | User |
| AC-06 | Accepted limitation | A dedicated secondary-monitor run was not recorded; coordinate-aware geometry and workspace calculations are covered by Rust tests. | User |
| AC-07 | Accepted limitation | A dedicated target-closure run was not recorded; identity validation and safe restoration remain implemented as the fallback boundary. | User |
| AC-08 | Pass | User confirmed window movement and resizing behavior has no interaction issue. | User |
| AC-09 | Accepted limitation | Fake-provider streaming passes; configured real-provider acceptance is intentionally deferred to the final conversation check. | User |
| AC-10 | Accepted limitation | Fake-provider cancellation, failure, and retry pass; configured real-provider recovery remains deferred with AC-09. | User |
| AC-11 | Accepted limitation | No separate restart-after-hide evidence was recorded; the user confirmed the current window and shortcut lifecycle is working. | User |

## Engineering Quality Gate

| Check | Result | Evidence / notes |
| --- | --- | --- |
| `npm.cmd run typecheck` | Pass | Completed on 2026-08-29. | Codex |
| `npm.cmd run build` | Pass | Vite production build completed on 2026-08-29. | Codex |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | Pass | Completed on 2026-08-29. | Codex |
| `cargo check --manifest-path src-tauri/Cargo.toml` | Pass | Completed on 2026-08-29. | Codex |

Additional checks:

- `cargo test --manifest-path src-tauri/Cargo.toml`: Pass, 2 Rust geometry
  tests.
- `npm.cmd run runtime:test`: Pass, 3 fake-provider streaming, cancellation,
  failure, and retry tests.
- The linker emits an informational Windows `linker_messages` warning; it does
  not fail the build or tests.

## Manual Risk Checks

These checks are required to be recorded as resolved limitations or accepted
release risks before the MVP release decision.

| Scenario | Result | Evidence / limitation | Owner |
| --- | --- | --- | --- |
| Elevated target application | Accepted limitation | Not exercised in this checkpoint; retain as a follow-up risk. | User |
| Sleep and resume | Accepted limitation | Not exercised in this checkpoint; retain as a follow-up risk. | User |
| Mixed-DPI monitors | Accepted limitation | Not exercised in this checkpoint; retain as a follow-up risk. | User |
| Display changes during Workspace Mode | Accepted limitation | Not exercised in this checkpoint; retain as a follow-up risk. | User |
| Taskbar and work-area configuration | Accepted limitation | Not exercised in this checkpoint; retain as a follow-up risk. | User |
| Target application closure | Accepted limitation | Dedicated manual run not recorded; safe identity validation remains the expected protection. | User |

## Release Decision

- Decision: Cycle 1 MVP accepted with limitations
- Decision date: 2026-08-29
- Decision owner: User
- Accepted limitations:
  - Core window interaction is accepted; visual and detail polish is deferred.
  - Real configured-provider conversation acceptance is deferred to the final
    conversation check; deterministic runtime tests pass.
  - Secondary-monitor, lifecycle-edge, and target-closure scenarios remain
    explicit follow-up risks rather than hidden requirements.
