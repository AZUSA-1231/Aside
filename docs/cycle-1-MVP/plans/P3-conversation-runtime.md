# P3 - Pi Conversation Runtime

Status: implementation complete; configured-provider acceptance deferred
Depends on: [P0 - Foundation and Native Boundary](./P0-foundation.md) and
[P1 - Floating Agent](./P1-floating-agent.md)
Unblocks: P4

## Outcome

Connect a minimal streaming conversation while keeping Pi implementation
details inside `agent-runtime`. The panel can submit one run at a time, render
incremental assistant output, cancel a run, and recover from provider failure.

Domain tools such as reminders, schedules, notes, and file actions are outside
this plan.

## Tasks

1. Finalize runtime types for sessions, messages, run state, usage, tool-event
   placeholders, cancellation, completion, and failure.
2. Implement the Pi adapter around `pi-agent-core` and `pi-ai` inside
   `agent-runtime`.
3. Define provider and model configuration for local development without
   credentials in source control, frontend state, or logs.
4. Expose session start, message submit, stream event, cancel, complete, and
   error operations through the Aside-owned runtime protocol.
5. Add request and run identifiers so late events cannot update a newer
   request.
6. Add deterministic fake-provider tests for streaming, cancellation, provider
   failure, retry, and stale-event rejection.
7. Implement the chat UI for user messages, assistant messages, incremental
   output, loading, cancellation, retry, and failure.
8. Keep submit and cancel behavior coherent when the panel is hidden or
   reopened.
9. Verify that React imports only Aside runtime client types and never Pi
   implementation classes.

## Deliverables

- Pi-backed runtime adapter.
- Typed runtime event protocol.
- Minimal conversation UI.
- Cancellation and retry behavior.
- Deterministic runtime test seam.
- Secret-safe local provider configuration boundary.

## Exit Criteria

- AC-09: configured provider output streams into the panel.
- AC-10: cancellation and provider failure states are recoverable.
- A cancelled run cannot append stale output to a later run.
- Provider credentials and sensitive content are absent from logs.
- React depends only on the Aside runtime client boundary.

## Verification

Run the fake-provider tests for successful streaming, cancellation, retry, and
failure. Then record a real configured-provider check, with secrets and prompt
content redacted, in [VERIFICATION.md](../VERIFICATION.md).
