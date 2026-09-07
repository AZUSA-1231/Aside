# Cycle 5 Agent Capability Execution Plan

Status: P0 through P6 implemented on 2026-09-07; release decision pending the quality gate and manual Windows evidence
Scope decision: 2026-09-05; `vendor/pi-full` reference review included
Source requirements: [Cycle 5 PRD](./PRD.md)
Long-lived constraints: [Project Architecture](../ARCHITECTURE.md)
Predecessor boundary: [Cycle 4 closeout plan](../cycle-4-contextual-sidecar/PLAN.md)
Issues: [Cycle 5 issues log](./ISSUES.md)

This is the Cycle 5 execution index and cross-plan contract. It owns the
delivery order, shared invariants, acceptance traceability, quality gate, and
current checkpoint. The detailed work stays in one file per plan so each unit
can be implemented and closed without copying its task list into this file.

## Document Responsibilities

| Document | Responsibility |
| --- | --- |
| [PRD](./PRD.md) | Product role, behavior, capability policy, scope, and acceptance criteria |
| This `PLAN.md` | Cross-plan order, shared contracts, release boundary, and execution status |
| [`plans/P*.md`](./plans/) | Plan-local tasks, deliverables, exit criteria, and checks |
| [ISSUES.md](./ISSUES.md) | Facts, surprises, decisions, exceptions, and follow-up discovered during delivery |

`PLAN.md` is retained because it has a distinct coordination role. It is not a
second implementation checklist: it does not repeat the tasks from the child
plans. Cycle 5 intentionally uses this singular execution index, matching the
Cycle 4 structure, and does not add a duplicate `PLANS.md`. There is no separate
`VERIFICATION.md` at the planning stage; plan evidence and implementation
exceptions belong beside the work and in the issues log until the release
decision is made.

## Pi-full Integration Strategy

`vendor/pi-full/` is a complete Pi source snapshot supplied for design
reference. It is not a second Aside runtime or a root workspace dependency.
Its package manifests publish from `dist`, while this snapshot contains the
source tree without built package output and its own installed dependency tree.
Aside therefore continues to run the existing minimal `vendor/pi` package and
its `Agent` adapter. A source-level port from `pi-full` is allowed only when the
selected behavior has passed an Aside API, build, security, and deterministic
test review.

The selection map is:

| Pi-full area | Cycle 5 decision | Aside ownership or adaptation |
| --- | --- | --- |
| `packages/agent` low-level `Agent`, `AgentTool`, tool hooks, sequential execution, and faux-provider patterns | Reuse the existing compatible Agent path; use the full source as confirmation and reference | `agent-runtime` owns TaskRun identity, limits, event sanitization, and policy |
| `harness/types.ts` `FileSystem`, `FileInfo`, `Result`, and typed file errors | Adopt the contracts and failure-shape ideas selectively | P1 defines the explicit per-run environment, addressed/canonical path policy, and Windows containment |
| Harness and coding-agent read, edit, diff, write, truncation, and mutation-queue code | Port algorithms or behavior only where compatible | P2/P3 retain Aside tool names, bounds, document adapters, and permission broker |
| Harness and coding-agent `skills.ts` loaders | Adopt bounded SKILL.md parsing, validation, ignore handling, source metadata, and diagnostics as references | P4 keeps trust and activation policy in Aside and never lets skill content grant authority |
| Pi protocol/client/server snapshots, correlation, framing limits, and event separation | Use event/correlation and bound-checking principles as references | P5 keeps the existing Aside-owned JSONL/Tauri boundary; no CBOR client/server dependency |
| `AgentHarness` operation layer | Do not adopt as the product runtime | Its scaffold still rejects `create.restore`, `prompt`, `skill`, `resume`, `abort`, queue, compaction, and navigation paths as unimplemented |
| coding-agent `createCodingTools`, bash/PowerShell, fixed-cwd session/settings, extensions, and project trust | Do not adopt as a capability or authority layer | Aside's workspace, permission, session, and host boundaries remain authoritative |

Every port must satisfy four gates before it changes a child plan's contract:

1. The code must work through the existing Aside package/API boundary and build
   without importing the nested `pi-full` workspace.
2. The behavior must preserve explicit TaskRun workspace scope, runtime-owned
   permission, bounded output, and no process-global `cwd` mutation.
3. Shell, process, network, extension, project-trust, and hidden-resource
   behavior must be absent or separately reviewed rather than arriving through
   a copied helper.
4. A faux provider/filesystem test must prove the adapted behavior and its
   failure cases. Pi-full's own tests are useful evidence, but do not replace
   Aside boundary tests.

## Execution Invariant

Every file task must follow one runtime-owned path:

```text
prompt and optional Cycle 4 descriptor
  -> create bounded TaskRun
  -> resolve and validate one active workspace
  -> construct a per-run execution environment
  -> publish only the registered capabilities
  -> Pi model turn
  -> validate one tool call
  -> execute a bounded read, or prepare a write
  -> request permission for the exact write
  -> revalidate and execute once after approval
  -> return a bounded tool result to the same Pi loop
  -> verify when a suitable read or adapter check exists
  -> report the actual result and persist only allowed messages
```

The model is allowed to choose the next tool from each result. A mandatory
upfront plan-generation phase is not part of this flow. `process.chdir()` and
the durable Aside session directory are never used to implement workspace
activation.

## Delivery Map

```text
P0 Runtime contracts and Pi loop boundary
  -> P1 Task run and workspace boundary
       -> P2 Capability registry and bounded read tools
            -> P3 Permission-gated writes and verification

P2 + P3 -> P4 Skills and resource loading
P0 through P4 -> P5 Session, IPC, and protocol integration
P5 -> P6 Side surface, regression, and release verification
```

| ID | Plan | Purpose | Depends on |
| --- | --- | --- | --- |
| P0 | [Runtime contracts and Pi loop boundary](./plans/P0-runtime-contracts-and-loop.md) | Establish Aside-owned task, tool, event, limit, and loop contracts while reusing Pi Agent semantics. | Cycle 4 runtime baseline |
| P1 | [Task run and workspace boundary](./plans/P1-task-run-and-workspace-boundary.md) | Resolve Cycle 4 descriptors into one validated per-run workspace without changing process-global state. | P0 |
| P2 | [Capability registry and bounded read tools](./plans/P2-tool-registry-and-read-capabilities.md) | Register bounded workspace capabilities and deliver read-only text/JSON document assistance. | P1 |
| P3 | [Permission-gated writes and verification](./plans/P3-permission-gated-writes.md) | Prepare, preview, authorize, revalidate, and execute bounded workspace writes exactly once. | P2 |
| P4 | [Skills and resource loading](./plans/P4-skills-and-resource-loading.md) | Add bounded SKILL.md-compatible workflow instructions without expanding capabilities or trust. | P2 and P3 |
| P5 | [Session, IPC, and protocol integration](./plans/P5-session-ipc-and-protocol.md) | Carry task, workspace, tool, permission, and bounded persistence state through the runtime boundary. | P0 through P4 |
| P6 | [Side surface and release verification](./plans/P6-side-surface-and-release.md) | Make autonomous activity legible in the existing rail and close the cycle with deterministic and manual evidence. | P5 |

## Shared Rules

- The runtime is the authority for path resolution, workspace scope, tool
  availability, permission, and result status. React only renders serialized
  state and sends explicit user decisions.
- One task run has one active workspace. A Cycle 4 descriptor is a reference
  and a workspace hint; it is not permission and must be revalidated before
  use.
- The session root remains independent from the active workspace. No plan may
  call `process.chdir()` or silently create a second workspace root.
- Every active tool has a unique name, validated schema, effect, scope,
  bounded implementation, replay policy, and display metadata.
- Read tools are bounded and may run without a write prompt only after the
  workspace check. Every workspace mutation requires a fresh exact decision.
- The initial tool execution mode is sequential for writes and mixed batches.
  Parallel reads require an explicit bounded safety decision and test coverage.
- Shell, PowerShell, arbitrary process/code execution, browser actions,
  external network operations, and broad host mutation remain outside the
  default registry.
- Tool arguments, file content, host descriptors, and skill instructions are
  untrusted inputs. They cannot override system policy or grant capabilities.
- Every denied, cancelled, expired, stale, timed-out, unsupported, and failed
  operation returns a typed bounded result and cannot be reported as success.

## Current Checkpoint

P0 through P6 are implemented. The runtime publishes Aside-owned task/tool
contracts, bounded lifecycle events, sequential tool execution, and
deterministic faux coverage while retaining the low-level Pi Agent boundary.
P1 resolves one explicit per-task workspace, keeps addressed and canonical
paths distinct, rejects containment escapes, and withholds workspace-scoped
tools until activation. P2 adds the bounded read-only workspace registry,
text/Markdown and JSON adapters, explicit recursive search, and typed failure
results. P3 adds exact-operation permission state, bounded text/JSON writes
and edits, atomic replacement, stale-target revalidation, cancellation/expiry
handling, and intrinsic verification. P4 adds the bounded `SKILL.md` loader
with source/trust classification, diagnostics, collision handling, and three
bundled skills; skill activation projects instructions as untrusted reference
data without ever changing the tool registry, permission broker, or agent
loop. P5 carries permission, workspace, skill, tool, and verification state
across the JSONL/Tauri boundary with strict request validation and
non-durable session state. P6 turns the Side rail into the autonomous-task
surface with workspace, skill, tool-activity, verification, and permission
controls that remain display projections only. The release decision now rests
on the PLAN quality gate and manual Windows evidence. The `pi-full` review
expands the implementation references but does not change the runtime
boundary.

At each checkpoint, update the affected child plan from `planning` to
`implemented` only after its exit criteria and checks have passed. Record a
new issue before changing a contract, scope, or ownership rule. Keep the
runtime tests deterministic with faux providers and in-memory or temporary
tool environments.

## Engineering Quality Gate

Run the existing project gate at P6 and at any boundary that changes a shared
contract:

```text
npm.cmd run typecheck
npm.cmd run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm.cmd run runtime:test
```

If Pi source or generated package output changes, also run the repository's
`npm.cmd run pi:build` before the runtime tests. Do not treat a successful
provider request as a substitute for deterministic faux coverage. If a
selected `pi-full` algorithm is ported, run the relevant root checks and Aside
faux tests; do not treat the source snapshot's own package check as a substitute
for the Aside boundary checks.

## Acceptance Traceability

| Product area | Plan | Acceptance criteria |
| --- | --- | --- |
| Task run, Pi continuation, bounded execution, cancellation, and truthful results | P0 | C5-01 through C5-05, C5-17, C5-18, C5-39, C5-40 |
| Descriptor handoff, workspace resolution, scope, stale targets, and isolation | P1 | C5-02, C5-06 through C5-12, C5-15, C5-37 |
| Registry, read tools, limits, unsupported formats, and document reads | P2 | C5-13 through C5-18, C5-31, C5-40 |
| Exact write preparation, permission, denial, cancellation, replay, and stale revalidation | P3 | C5-19 through C5-26, C5-32, C5-33, C5-39 |
| Skills, trust classification, invocation, and capability isolation | P4 | C5-27 through C5-30 |
| Bounded session messages, request/event contracts, and boundary ownership | P5 | C5-02, C5-04, C5-11, C5-34 through C5-37, C5-39 |
| Side rail states, regression, manual evidence, and release decision | P6 | C5-20, C5-33, C5-38 through C5-40 and the release boundary |

## Release Boundary

Cycle 5 closes only when the [PRD release boundary](./PRD.md#19-release-boundary)
is met: one valid descriptor can establish a workspace before reads; the same
Pi loop can continue across bounded tools; writes are previewed and gated by a
fresh exact decision; skills cannot expand authority; one supported document
workflow can read, transform, write, and verify; and existing Side/Workspace,
capture, session, and process-boundary behavior remains intact.

The following remain explicitly deferred: permanent workspace trust, arbitrary
shell or process execution, external services and host actions, implicit
multi-workspace access, sub-agents/background jobs, universal binary document
support, automatic indexing, and full coding-agent CLI/TUI parity.
