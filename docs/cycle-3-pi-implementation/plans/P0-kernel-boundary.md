# P0 - Pi Kernel Boundary and Runtime Contracts

Status: planning  
Depends on: Cycle 2 runtime baseline  
Unblocks: P1 and P2

## Outcome

Replace the MVP's one-purpose conversation wrapper with an Aside adapter built
around Pi's `Agent` and agent-loop semantics. Establish the serialized Aside
runtime contracts before the context and session layers are implemented.

Pi remains responsible for execution behavior. This plan does not recreate an
agent loop or import coding-agent features as a shortcut.

## Tasks

1. Confirm the reviewed Pi package/version and its supported exports from the
   neighboring Pi repository and the runtime dependency.
2. Define Aside-owned runtime request, event, error, run, and display-history
   types without leaking Pi types across the process boundary.
3. Construct Pi `Agent` instances with an Aside system prompt, configured
   provider/model, and no coding-agent tools.
4. Reuse Pi's subscribe, prompt, and abort semantics for the Cycle 3
   `prompt`/`cancel` path. Treat retry as a new prompt request; do not add a
   separate queue or follow-up protocol in this cycle.
5. Translate Pi message and lifecycle events into stable Aside events while
   preserving request identity and terminal-event ordering.
6. Define the runtime's provider configuration and credential boundary. No
   credential may enter frontend state, session content, or diagnostic output.
7. Add a deterministic faux-provider seam and tests for stream, failure,
   cancellation, retry, and stale-event rejection.
8. Record any package-linking, export, or Pi-version surprise in
   [ISSUES.md](../ISSUES.md) before changing the dependency approach.

## Deliverables

- Aside-owned runtime request/event types.
- Pi `Agent` adapter with provider/model configuration.
- Stable mapping for stream, completion, cancellation, and failure.
- Request/run identity handling.
- Faux-provider test seam and kernel adapter tests.
- Explicit provider credential and package dependency boundary.

## Exit Criteria

- C3-01, C3-02, and the kernel portion of C3-03 are ready for integration.
- No custom Aside loop duplicates Pi's turn or cancellation behavior.
- Pi imports remain confined to `agent-runtime`.
- The adapter can reject or retry a request without corrupting the next run.
- A cancelled or failed run cannot emit useful output into a newer request.
- Provider failures are sanitized before they enter the Aside protocol.
- A second request after a failed run starts cleanly without a failed assistant
  message being treated as durable history.

## Checks

Run the runtime faux-provider tests and the TypeScript/build checks. Confirm by
search that React, Tauri, and the frontend contract modules do not import Pi
packages.
