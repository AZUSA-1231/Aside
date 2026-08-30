# P1 - Aside Context Model and Provider Projection

Status: implemented
Depends on: P0 - Pi Kernel Boundary and Runtime Contracts  
Unblocks: P2 and P3

## Outcome

Define a context system for Aside's everyday product flows. The system accepts
different flow identities and typed reference data while keeping transient
context separate from the durable conversation and from Pi's coding-agent
context assumptions.

## Tasks

1. Define the Aside flow contract with an opaque stable id, bounded kind, and
   optional display label.
2. Define the turn envelope and the text/JSON block union, using the shared
   Cycle 3 limits (8 blocks, 8 KiB text, 16 KiB JSON, 24 KiB total, depth 4).
3. Validate plain JSON values, identifiers, labels, and total context size at
   the runtime boundary before a provider call.
4. Implement the provider projection through Pi's context transformation
   hooks as one synthetic user message immediately before the active prompt.
   Mark it as untrusted reference data; it must not become a system prompt.
5. Make the projection stable across multiple provider turns in one Pi run;
   reuse that one synthetic message and do not duplicate it.
6. Keep the envelope out of the durable session and out of the normal display
   history unless a future domain feature explicitly chooses otherwise.
7. Define the small filtering rule before `convertToLlm`: retain standard
   conversation/tool-result messages and strip only runtime-internal markers.
   Do not add speculative domain-message types in this cycle.
8. Add focused tests for no context, text/JSON context, malformed and
   over-limit data, flow kinds, isolation, and repeated provider turns.
9. Record any conflict between Pi's context assumptions and an Aside flow in
   [ISSUES.md](../ISSUES.md).

10. Load provider defaults from `.env.local` without mutating `process.env`,
    inject credentials through Pi's `AuthContext`, and apply an optional
    `ASIDE_API_URL` to the selected model at the provider boundary.

## Deliverables

- Aside flow and turn-context contract.
- Bounded context validator.
- Ephemeral provider projection.
- One canonical reference-message serialization and insertion rule.
- Standard-message conversion/filtering policy.
- Context isolation and projection tests.
- Automatic project and packaged provider configuration loading.

## Exit Criteria

- C3-05, C3-06, and C3-07 pass at the runtime boundary.
- Context supplied for one request cannot appear in a later request without a
  new explicit envelope.
- The durable transcript remains free of temporary context.
- JSON data is treated as data and cannot bypass the instruction boundary by
  changing its block type.
- The projection works for conversation-shaped and future domain-shaped flows
  without a coding-agent-specific branch.
- A local provider configuration can be loaded without a per-command shell
  setup, while Pi remains the owner of provider authentication and requests.

## Checks

Inspect the faux provider's received context and compare two consecutive runs:
one with context and one without it. Confirm that only the first projection
contains the temporary blocks and that the session writer receives no context
entry.
