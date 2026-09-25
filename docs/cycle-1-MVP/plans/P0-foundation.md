# P0 - Foundation and Native Boundary

Status: complete
Depends on: existing Tauri project setup
Unblocks: P1

## Outcome

Make the repository ready for native feature work. Establish the contracts that
keep the React UI, Tauri application layer, Windows adapter, and agent runtime
independent of one another.

This plan creates foundations only. It does not deliver the complete panel,
Workspace Mode, Pin behavior, or a working Pi conversation.

## Tasks

1. Confirm the development commands and Windows toolchain for frontend
   typechecking, frontend builds, Rust formatting, and Rust compilation.
2. Establish the first application-layer module boundaries for commands,
   window orchestration, workspace policy, and platform operations. Add a
   module when the first consumer needs it; do not add speculative empty
   abstractions.
3. Define typed command results and a shared native error shape that can carry
   an operation, a recoverability hint, and a user-facing message.
4. Add one frontend IPC client boundary in `src/lib`. React components must not
   call `invoke` or `listen` from arbitrary locations.
5. Define the initial frontend state model for visibility, surface, Pin,
   operation status, and user-facing errors.
6. Prepare Tauri capabilities and the native lifecycle integration needed by
   the official global-shortcut plugin. P1 owns the actual summon behavior.
7. Define the public `agent-runtime` types for sessions, messages, runs,
   streaming events, cancellation, completion, and failure without wiring Pi
   implementation details into React.
8. Add pure test seams for display-bound calculations and frontend/native state
   transitions.

## Deliverables

- Native command and event contract skeleton.
- Centralized frontend IPC client boundary.
- Initial shared UI state types.
- Runtime protocol placeholder.
- Pure tests for geometry and state transitions.
- Repeatable development and check commands documented for later plans.

## Exit Criteria

- `npm.cmd run typecheck` passes.
- `npm.cmd run build` passes.
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check` and
  `cargo check --manifest-path src-tauri/Cargo.toml` pass.
- React code imports neither Windows APIs nor Pi classes.
- The command, event, and runtime contracts compile on both sides of their
  boundaries.
- The test seams can exercise geometry and state transitions without a desktop
  session.

## Verification

Record command output and boundary review in
[VERIFICATION.md](../VERIFICATION.md). The record should identify the exact
toolchain used and any setup limitation that P1 must account for.
