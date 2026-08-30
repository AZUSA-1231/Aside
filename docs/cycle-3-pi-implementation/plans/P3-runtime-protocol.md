# P3 - Runtime Protocol and Surface Integration

Status: planning  
Depends on: P2 - Durable Session and Recovery  
Unblocks: Cycle 3 completion

## Outcome

Carry the Pi-backed runtime through the existing Tauri process boundary and
React surface. Restore display history, forward typed flow context, preserve
streaming/cancellation behavior, and keep the frontend independent of Pi.

## Tasks

1. Extend the JSONL request contract to carry an optional Aside turn-context
   envelope alongside the prompt text. Keep the request vocabulary to
   `prompt` and `cancel`; a retry is a newly submitted `prompt`.
2. Extend the event contract with runtime readiness, restored display history,
   persistence warnings, and the existing run lifecycle events.
3. Ensure runtime startup loads the active session before the next provider run
   and emits a display-safe history projection.
4. Keep Tauri responsible for process lifecycle and IPC forwarding, not for
   constructing Pi messages or provider contexts.
5. Hydrate the existing chat UI from restored history without exposing raw Pi
   session entries or temporary context blocks.
6. Preserve request-id filtering, one active UI run, cancel behavior, retry
   behavior, and the existing Cycle 2 Side/Workspace surface behavior.
7. Map validation, provider, runtime, and persistence failures to recoverable
   Aside errors with actionable display text and sanitized details.
8. Add focused protocol tests for restored history, optional context, warning
   events, terminal-event uniqueness, malformed requests, and stale-event
   rejection.
9. Run the existing frontend, Rust, and runtime checks. Record failures or
   unexpected protocol decisions in [ISSUES.md](../ISSUES.md).

## Deliverables

- Updated Aside JSONL runtime protocol.
- Tauri request/event forwarding for context and history.
- Restored-history chat behavior.
- Persistence-warning and runtime-failure UI states.
- Protocol and frontend boundary tests.

## Exit Criteria

- C3-01 through C3-04 and C3-08 through C3-11 are ready for cycle close.
- React imports only Aside contracts and IPC helpers.
- The first restored history event cannot be overwritten by the welcome state
  or by a stale runtime event.
- A prompt context is never echoed into durable history by the UI or Tauri.
- Existing window lifecycle, shortcut, Pin, Side, and Workspace behavior is
  unchanged.

## Checks

Exercise the runtime through the Aside protocol with a faux provider and a
temporary session root. Confirm the emitted event order, then run the complete
project quality gate listed in [PLANS.md](../PLANS.md).
