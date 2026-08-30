# Cycle 3 Pi Implementation Plans

Status: reviewed planning baseline; implementation pending  
Source requirements: [Cycle 3 Pi Implementation PRD](./PRD.md)  
Technical constraints: [Project Architecture](../ARCHITECTURE.md)

Cycle 3 keeps the existing Cycle 2 desktop surface stable while replacing the
MVP conversation adapter with a Pi-backed runtime that has an Aside-specific
context and session boundary. Detailed tasks live in one file per plan.

## Delivery Map

```text
P0 Pi Kernel Boundary and Runtime Contracts
  -> P1 Aside Context Model and Provider Projection
       -> P2 Durable Session and Recovery
            -> P3 Runtime Protocol and Surface Integration
```

The delivery order is intentionally linear: P1 depends on the adapter shape
from P0, P2 depends on P0/P1, and P3 integrates the completed runtime with
Tauri and React. Contract notes may be drafted earlier, but each plan has one
implementation owner and one clear hand-off.

| ID | Plan | Purpose | Depends on |
| --- | --- | --- | --- |
| P0 | [Pi Kernel Boundary and Runtime Contracts](./plans/P0-kernel-boundary.md) | Replace the MVP wrapper with Pi Agent semantics and stable Aside runtime types. | Cycle 2 runtime baseline |
| P1 | [Aside Context Model and Provider Projection](./plans/P1-context-model.md) | Support different flow shapes and transient typed context without adopting coding-agent context. | P0 contract |
| P2 | [Durable Session and Recovery](./plans/P2-session-lifecycle.md) | Persist and restore Aside conversation state using Pi's append-only session design. | P0 and P1 |
| P3 | [Runtime Protocol and Surface Integration](./plans/P3-runtime-protocol.md) | Carry the new request/event shapes through Tauri and hydrate the existing chat surface. | P2 |

## Shared Rules

- Pi owns agent-loop mechanics; Aside does not create a second loop.
- Pi packages stay inside `agent-runtime`.
- React and Tauri use only Aside-owned serialized contracts.
- The durable transcript contains conversation messages, not temporary flow
  context or native desktop state.
- Context is explicit, bounded, untrusted data and is projected only at the
  provider boundary.
- Cycle 3 exposes only `prompt` and `cancel`; retry means submitting a new
  prompt after a failed run.
- Coding-agent tools, skills, repository context, and shell execution remain
  excluded.
- Unexpected behavior or a newly discovered tradeoff is recorded in
  [ISSUES.md](./ISSUES.md) before the plan is silently changed.
- Cycle 2 desktop behavior is a regression surface, not a reason to expand
  this cycle's scope.

## Engineering Checks

The implementation must keep the existing project checks runnable at plan
boundaries:

```text
npm.cmd run typecheck
npm.cmd run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm.cmd run runtime:test
```

Runtime-specific tests must also cover the in-memory/faux seams described by
P0 through P2. Results and exceptions belong in the issues log; no separate
Cycle 3 verification file is created.

## Traceability

| Product area | Implementation plan | Acceptance criteria |
| --- | --- | --- |
| Pi Agent, loop, provider, event, and cancellation reuse | P0 | C3-01, C3-02, C3-03 |
| Flow identity, text/JSON context, projection, and isolation | P1 | C3-05, C3-06, C3-07 |
| Session persistence, restoration, and persistence warnings | P2 | C3-03, C3-04, C3-08 |
| Tauri protocol, React history, and boundary isolation | P3 | C3-01, C3-04, C3-09, C3-11 |
| Capability and scope regression | P0, P1, P3 | C3-10 |

## Deferred

- Reminder, schedule, note, and other domain tools.
- Session browser, search, branching UI, and cloud sync.
- Pi `AgentHarness` adoption.
- Coding-agent filesystem, shell, skills, and repository context.
- Screen understanding, clipboard inspection, accessibility APIs, and broad
  desktop automation.
