# Cycle 3 Pi Implementation Issues

Status: active development log  
Scope: problems, surprises, and decisions discovered while implementing Cycle 3

This document replaces a separate Cycle 3 verification record. It is a living
log, not a design wish list. Add an entry when implementation reveals behavior
that was not explicit in the PRD or when a decision changes the delivery
boundary.

## Issue Rules

- Use the next `C3-I###` identifier.
- Record the issue before silently changing a plan or contract.
- Keep facts, impact, decision, and follow-up separate.
- Link the affected plan and PRD requirement when known.
- Mark an issue `open` when implementation still needs a decision, `accepted`
  when the decision is part of this cycle's boundary, and `closed` when the
  implementation and follow-up are complete.
- Do not include credentials, raw provider payloads, prompts containing private
  data, native handles, or sensitive local paths.

## Issue Index

| ID | Status | Area | Summary | Plan |
| --- | --- | --- | --- | --- |
| C3-I001 | accepted | Pi API | The current `AgentHarness` is a scaffold with unfinished operation paths. | P0 |
| C3-I002 | accepted | Context | Pi's coding-agent session context is not the product context model Aside needs. | P1 |
| C3-I003 | accepted | Privacy | Temporary flow context must not become durable conversation memory by default. | P1, P2 |
| C3-I004 | accepted | Dependency | Aside must reuse Pi through its package boundary instead of copying the neighboring repository's loop source. | P0 |
| C3-I005 | accepted | Session | Default local session root and override policy chosen; P2 must verify it in packaged and test runs. | P2 |
| C3-I006 | accepted | Protocol | Cycle 3 keeps only prompt/cancel; retry is a fresh prompt after a failed run. | P0, P3 |
| C3-I007 | accepted | Context | Context limits and one canonical reference-message projection are explicit. | P1 |
| C3-I008 | accepted | Tooling | Node's Windows test runner does not discover a directory passed to `--test`; scripts list test files explicitly. | P2 |
| C3-I009 | accepted | Session | Pi session serialization rejects explicit `undefined` optional message fields; the Aside adapter normalizes them before append. | P2 |
| C3-I010 | accepted | Vendor | Pi's provider model catalog is generated during its package build and is absent from the source snapshot; the catalog is vendored with the source. | P0 |

## C3-I001 - AgentHarness Is Not the Cycle 3 Runtime

Status: accepted  
Discovered: planning review  
Affected: P0, P2  
Requirements: FR-3.1, FR-3.3

### Fact

The reviewed Pi version exposes a usable `Agent` and low-level agent-loop
implementation. Its current `AgentHarness` export is compile-complete in shape
but several operation paths reject with `HarnessNotImplemented`, including the
main prompt path.

### Impact

Using `AgentHarness` as the product runtime would create a runtime that appears
architecturally complete but cannot execute the required conversation flow.

### Decision

Cycle 3 uses Pi's `Agent` class and agent-loop semantics directly. Aside owns a
small session adapter around Pi's session storage interfaces. `AgentHarness` is
not a dependency of the running product in this cycle.

### Follow-up

Revisit only after the required Pi harness operations are implemented and its
context model can represent Aside flows without reintroducing coding-agent
assumptions.

## C3-I002 - Coding-Agent Context Does Not Fit Aside

Status: accepted  
Discovered: architecture review  
Affected: P1  
Requirements: FR-3.5, FR-3.6, FR-3.9

### Fact

Pi's harness context design is optimized for coding-agent sessions: branch
history, compaction, repository-oriented tools, skills, and execution context.
Aside needs short conversations and future domain flows whose inputs may be
typed text or JSON snapshots.

### Impact

Copying that context model would couple reminders, schedules, notes, and other
future flows to repository or working-directory concepts that do not belong in
Aside.

### Decision

Aside defines a flow identity and a bounded text/JSON turn envelope. The
runtime projects it ephemerally at Pi's context transformation boundary and
keeps the durable transcript limited to conversation messages.

### Follow-up

Every new domain flow must state its context shape and retention decision. It
must not add a special coding-agent branch to the kernel adapter.

## C3-I003 - Temporary Context Is Not Memory

Status: accepted  
Discovered: context design review  
Affected: P1, P2  
Requirements: FR-3.4, FR-3.6

### Fact

Flow context can describe changing state, a draft, or a one-time product
operation. Persisting it with the conversation would make the next run see
potentially stale information and would make retention unclear.

### Impact

The runtime cannot simply append every input to Pi's durable transcript or use
the same message list for both provider context and session storage.

### Decision

The prompt text is durable conversation input. The optional context envelope is
run-scoped provider reference data and is discarded after `agent_end`. A future
domain feature may explicitly persist a custom domain entry only after defining
its schema, privacy, retention, and display policy.

### Follow-up

Add a regression test whenever a new context block type is introduced. The
test must prove both provider visibility and session absence.

## C3-I004 - Reuse Pi Through the Package Boundary

Status: accepted  
Discovered: dependency review  
Affected: P0  
Requirements: FR-3.1, FR-3.2

### Fact

The neighboring `pi` repository is available in the workspace and is useful
for reading the implementation and testing against the reviewed version. The
Aside repository already treats Pi as an external runtime dependency.

### Impact

Copying `agent-loop` or session source into Aside would create a second core,
make fixes diverge, and move Pi internals across the ownership boundary.

### Decision

The neighboring repository is the source reference for API and design review.
`agent-runtime` consumes the Pi package API and absorbs version changes in its
adapter. A local workspace link is acceptable for development only if it still
publishes the same package boundary and is recorded with the exact version and
build constraint.

### Follow-up

If a Pi change is required, record the required upstream version or package
build in a new issue before changing Aside's dependency declaration.

## C3-I005 - Default Session Packaging Policy

Status: accepted  
Discovered: planning review  
Affected: P2  
Requirements: FR-3.3

### Question

The runtime needs a stable local session root that works in development,
packaged Windows builds, and deterministic tests.

### Current constraint

The session must be local, application-owned, configurable for tests, and
isolated from unrelated Pi/coding-agent sessions. It must not require a cloud
account or expose raw paths to React.

### Decision

Use `%LOCALAPPDATA%\Aside\sessions` by default on Windows. `ASIDE_SESSION_ROOT`
is an explicit override for development and deterministic tests; packaged
Tauri builds may pass the resolved application-data path through the same
variable. The runtime never exposes the path to React and no session picker is
needed for Cycle 3.

### Owner and follow-up

P2 implementation must verify the default, override, and invalid-root cases;
update this entry if packaging constraints require a change.

## C3-I006 - Keep the Product Protocol Small

Status: accepted  
Discovered: planning review  
Affected: P0, P3  
Requirements: FR-3.7, FR-3.8

### Fact

The current surface needs one active prompt and cancellation. Pi also supports
steering and follow-up queues, but Cycle 3 has no product interaction that
requires exposing them.

### Impact

Adding queue, continue, or retry-specific commands would expand the JSONL
contract and UI state without a current user scenario.

### Decision

Expose only `prompt(request_id, text, context?)` and
`cancel(request_id)`. A retry is a newly submitted prompt after the failed
assistant response has been excluded from durable history. Pi queue semantics
remain reusable internally and can be surfaced in a later cycle if needed.

### Follow-up

P0/P3 tests must cover a second prompt after failure and reject stale terminal
events; no additional command is required for retry.

## C3-I007 - Make Context Projection Deterministic

Status: accepted  
Discovered: planning review  
Affected: P1  
Requirements: FR-3.5, FR-3.6

### Fact

The original context contract required finite limits but left their values and
message placement to implementation.

### Impact

Different flows could choose incompatible budgets or produce duplicate context
on repeated provider turns, making isolation and provider tests ambiguous.

### Decision

Use shared defaults of 8 blocks, 8 KiB text, 16 KiB JSON, 24 KiB total, and JSON
depth 4. Project a non-empty envelope as exactly one synthetic user message
immediately before the active prompt, with a fixed reference-data marker and
deterministic block serialization. Limits are runtime constants and cannot be
raised per flow.

### Follow-up

P1 tests must assert the limits, insertion position, and absence of a duplicate
projection on repeated provider turns. Any limit increase requires a later
scope decision.

## C3-I008 - Explicit Runtime Test Files on Windows

Status: accepted  
Discovered: 2026-08-30  
Affected: P2, P3  
Requirements: FR-3.7, FR-3.8

### Fact

On Node 22.23.2 under Windows, `node --test agent-runtime/test` resolves the
directory as a module path and fails with `MODULE_NOT_FOUND` instead of
discovering the test files in that directory.

### Impact

The Cycle 3 runtime test command could report a test-runner failure or skip the
new session test depending on how the command was invoked.

### Decision

Keep the runtime scripts explicit: list each `*.test.mjs` file in the root and
`agent-runtime` package test commands. Adding a runtime test requires updating
both command lists.

### Follow-up

P3 keeps the explicit file list in the final quality gate. Revisit only if the
project standardizes on a cross-platform test discovery command.

## C3-I009 - Normalize Undefined Optional Message Fields

Status: accepted  
Discovered: 2026-08-30  
Affected: P2  
Requirements: FR-3.4

### Fact

Pi 0.84.4's `Session.appendMessage` validates the complete payload with
`assertJsonSerializable`. A provider message such as the faux provider's
assistant result can contain explicit `undefined` values for optional fields,
which Pi rejects even though ordinary JSON serialization would omit them.

### Impact

Appending an otherwise valid finalized assistant message could fail after its
user message had already been written, producing a partial session and a
misleading persistence failure if the adapter passed the message through.

### Decision

The Aside session adapter removes undefined object fields at the durable
message boundary, rejects undefined array items, and lets Pi perform its own
serializability validation afterward. Partial append progress remains tracked
so a later write can continue at the first missing message.

### Follow-up

Keep provider-message persistence tests using optional fields and verify that a
restart restores the normalized message without a duplicate user entry.

## C3-I010 - Vendor the Generated Provider Catalog

Status: accepted
Discovered: 2026-08-30
Affected: P0
Requirements: FR-3.1, FR-3.2

### Fact

The Pi 0.84.4 `pi-ai` source imports generated JSON files from
`src/providers/data`. Those files are produced by Pi's model-catalog build
step and are not present in the neighboring repository source snapshot, while
the installed package contains them only in its built output.

### Impact

Simply copying Pi's TypeScript source into Aside did not make the local
provider package independently buildable. Without the catalog, model lookup
and provider imports fail at compile time.

### Decision

Aside vendors the generated provider catalog alongside the pinned Pi source and
checks in the resulting JavaScript build output. The catalog is data used for
provider model selection, not coding-agent behavior. Future Pi updates must
refresh the source snapshot and catalog together.

### Follow-up

Run `npm.cmd run pi:build` when updating the vendored Pi snapshot and verify
that the runtime still resolves models without a registry-installed Pi package.

## Entry Template

Copy this template for a newly discovered issue:

```text
## C3-I### - Short Title

Status: open | accepted | closed
Discovered: YYYY-MM-DD
Affected: P0 | P1 | P2 | P3
Requirements: FR-...

### Fact

What was observed, with enough technical detail to reproduce it.

### Impact

What behavior, boundary, or delivery assumption it affects.

### Decision

The chosen response, or why the issue remains open.

### Follow-up

The test, documentation, implementation, or later-cycle work required.
```
