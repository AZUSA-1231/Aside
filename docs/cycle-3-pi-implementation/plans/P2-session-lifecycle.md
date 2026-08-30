# P2 - Durable Session and Recovery

Status: planning  
Depends on: P0 - Pi Kernel Boundary and Runtime Contracts and P1 - Aside Context Model and Provider Projection  
Unblocks: P3

## Outcome

Persist the Aside conversation using Pi's append-only session design while
keeping session selection, restoration, and failure policy inside the Aside
runtime adapter. The runtime must restart with the latest valid conversation,
not with stale temporary flow context.

## Tasks

1. Use the Windows application-data root `%LOCALAPPDATA%\Aside\sessions` by
   default, with `ASIDE_SESSION_ROOT` as a development/test override. Keep the
   session metadata explicitly owned by Aside and versioned; Tauri may pass an
   already-resolved root when packaging.
2. Use Pi's session repository/storage interfaces for JSONL persistence and an
   in-memory implementation for deterministic tests. Do not adopt the current
   unfinished `AgentHarness` operation layer.
3. Open or create the one active Aside session and project its current branch
   into restorable standard messages and display history.
4. Seed Pi `Agent` state from the restored message projection before accepting
   a prompt.
5. Persist finalized user, assistant, and future tool-result messages in event
   order. Do not persist text deltas or ephemeral context blocks.
6. Define handling for interrupted streams, aborted responses, provider
   failures, duplicate writes, and a session with an invalid or incompatible
   metadata header. A retry is a new prompt request; omit the prior failed
   assistant entry rather than adding a retry-specific record.
7. Serialize session writes and surface recoverable write failures without
   hiding a response that is already available in memory.
8. Add focused tests for create/open, ordering, restart restoration, failed
   assistant and temporary-context omission, invalid-session handling, and
   persistence warning behavior.
9. Record any mismatch between Pi session storage behavior and Aside's
   lifecycle requirements in [ISSUES.md](../ISSUES.md).

## Deliverables

- Aside session adapter around Pi session storage.
- Session metadata and active-session selection policy.
- Windows default root and `ASIDE_SESSION_ROOT` override policy.
- Restore-to-Agent and restore-to-display-history projection.
- Ordered persistence and recoverable warning behavior.
- Session and recovery test seam.

## Exit Criteria

- C3-03, C3-04, and C3-08 pass through the runtime adapter.
- A valid restart restores the latest successful conversation in order.
- A failed, aborted, or partial assistant response does not masquerade as a
  successful history item.
- Temporary context and provider secrets are absent from persisted entries.
- Session write failures are observable and do not claim false durability.
- Session data is not confused with a coding-agent or unrelated Pi session.

## Checks

Run the same prompt against a new in-memory session, close the runtime, reopen
the session, and continue. Inspect the stored entries to confirm that only
durable conversation messages were written.
