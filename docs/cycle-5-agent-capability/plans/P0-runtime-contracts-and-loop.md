# P0 - Runtime Contracts and Pi Loop Boundary

Status: implemented (2026-09-05)
Depends on: Cycle 4 runtime baseline
Unblocks: P1, P2, and the runtime portions of P3
Source requirements: Cycle 5 PRD sections 3, 4, 6, 7, 9, and 12

## Outcome

Extend the existing Pi `Agent` adapter into an Aside-owned task-run boundary.
The Pi loop remains responsible for assistant turns and tool-call sequencing;
Aside owns the capability registry input, effect policy, bounded events, task
identity, and terminal-state rules. This plan establishes the seams that later
workspace and permission plans will use without importing Pi types into Tauri
or React.

The current runtime creates an agent with `tools: []` and only projects text
and terminal events. P0 turns that known gap into an explicit contract without
adding filesystem effects yet.

## Boundaries

- Keep Pi imports inside `agent-runtime` and use the reviewed `Agent` and
  `AgentTool` APIs. `vendor/pi-full` may clarify low-level behavior and
  per-turn context patterns, but do not make its unfinished AgentHarness
  operation layer or the full coding-agent application the product runtime.
- Define serializable Aside shapes for TaskRun identity, tool metadata, tool
  calls and results, execution limits, and the event vocabulary needed by
  later plans.
- Keep provider credentials, native handles, raw Pi messages, and unbounded
  tool payloads inside the runtime boundary.
- Configure sequential execution for Cycle 5's initial mixed/write path. P2
  may add narrowly bounded read parallelism only with an explicit decision.

## Tasks

1. Confirm the vendored Pi version and the usable `Agent` hooks, tool schema,
   tool execution, abort, and subscription semantics against the
   `vendor/pi-full/packages/agent` reference. Record any mismatch in
   [ISSUES.md](../ISSUES.md).
2. Define and validate Aside-owned TaskRun, tool descriptor, effect/scope,
   replay policy, tool status, limit, and lifecycle event contracts. Bound all
   identifiers, display text, arguments, previews, updates, and results.
3. Change agent construction to receive an explicit per-run tool list and an
   Aside system-policy section. Preserve the existing provider/auth boundary
   and transient context projection. If per-run context is needed, pass it
   through an Aside wrapper or closure; do not introduce the unimplemented
   `AgentHarnessTool` runtime contract.
4. Map Pi message and tool lifecycle events to stable Aside events, including
   tool start/update/end/result and a single terminal event for each request.
   Sanitize errors and omit provider/native details.
5. Add counters and abort-aware limit hooks for model/tool steps, active tool
   time, output size, and concurrent calls. The concrete defaults are part of
   the contract and must be testable without a real provider.
6. Add faux-provider and faux-tool seams. Exercise a model response that
   calls a tool, receives its result, calls another tool, and then completes.
   Also cover unknown tools, invalid arguments, tool failures, cancellation,
   duplicate terminal signals, and stale request events.

## Deliverables

- Aside-owned runtime/task/tool/event contract definitions.
- Agent factory support for per-run tools and safe execution mode.
- Pi-to-Aside lifecycle mapping for text, tool calls, results, cancellation,
  failure, and completion.
- Bounded execution-limit policy with deterministic counters.
- Faux provider/tool test seam covering loop continuation and terminal order.

## Exit Criteria

- C5-01, C5-03, C5-04, and the runtime portion of C5-05 pass through the
  Aside adapter.
- A tool result can return to the same Pi loop and cause a subsequent model
  turn without a separately generated upfront plan.
- Every tool call is either executed by a registered implementation or
  receives a structured validation/unavailable result with no effect.
- Cancellation prevents a later tool from starting and yields one terminal
  cancellation event.
- Limits are enforced before an unbounded operation proceeds, and all emitted
  payloads are bounded and sanitized.
- React, Tauri, and frontend contracts have no Pi imports or provider-message
  constructors.

## Checks

Run the runtime tests and TypeScript typecheck. Inspect imports to confirm Pi
remains inside `agent-runtime`. If package sources or generated output are
changed, run `npm.cmd run pi:build` before the runtime tests.

## Verification

- `npm.cmd run runtime:test` passed: 32 tests.
- `npm.cmd run typecheck` passed.
- `node --check` passed for the runtime contract, runtime, and P0 test modules.
- `git diff --check` passed.
- The faux provider covered two sequential tool results, terminal limit
  handling, bounded previews, and contract validation. Existing runtime tests
  covered cancellation, provider failure, duplicate terminal protection, and
  context isolation.
- `vendor/pi-full/` remains ignored and was not staged. No Pi package source
  or generated output changed, so `npm.cmd run pi:build` was not required.
