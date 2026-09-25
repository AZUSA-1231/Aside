# Cycle 6 Capability Runtime Execution Plan

Status: implementation phase delivered; **independent audit complete, acceptance blocked** (2026-09-19). The current gate passes **365** runtime and 37 Rust tests (verified 2026-09-23; it was 328 at the audit). Manual acceptance is **indefinitely deferred** as of 2026-09-23 — see [Cycle 7 LEGACY](../cycle-7/LEGACY.md#manual-acceptance-indefinitely-deferred). P7 task 12 has recorded repeated-gate evidence; the independent audit found 6 P1 and 6 P2 defects plus evidence/traceability gaps. See [C6-I035](./ISSUES.md#c6-i035---passing-gates-do-not-establish-cycle-acceptance) and [AUDIT-REPORT.md](./AUDIT-REPORT.md). M2's recorded 2026-09-17 Windows trace remains limited evidence; Cycle 5 carryover and Cycle 6 manual acceptance are still pending.

Scope was corrected on 2026-09-19 by [C6-I034](./ISSUES.md#c6-i034---p7-was-over-broad-packaging-and-surface-quality-move-to-cycle-7): packaging and installed-application support, and frontend interaction quality, moved to Cycle 7. **Cycle 6 produces no installable artifact**, and its closeout is not a release decision.
Scope decision: 2026-09-10
Execution rebaseline: 2026-09-16 (repository review at `5e25fee`)
Source requirements: [Cycle 6 PRD](./PRD.md)
Direction notes: [Cycle 6 ideas](./ideas.md)
Predecessor: [Cycle 5 execution plan](../cycle-5-agent-capability/PLAN.md)
Long-lived constraints: [Project Architecture](../ARCHITECTURE.md)
Issues: [Cycle 6 issues log](./ISSUES.md)

This file is the Cycle 6 execution index. It owns delivery order, shared
invariants, acceptance traceability, the engineering gate, and the cycle
acceptance boundary. Each child plan owns its implementation checklist and evidence.

## Current Closeout Queue — Independent Audit, 2026-09-19

This queue supersedes older blanket implementation/verification statements where
the independent audit supplies a counterexample. It does not reopen retired Web
Search work or bring installation work back into Cycle 6. Finding definitions,
reproductions, and closure conditions live in C6-I035 and the audit report.

| Order | Work | Owner | Exit evidence |
| --- | --- | --- | --- |
| 1 | A01 parsing nontermination; A02 exclusive new-file commit; A05 MCP registry isolation; A06 cancellation during setup | P3, P4/P2, P6/P0 | Each reproduced failure becomes a passing regression; concurrent output survives; Stop prevents provider submission; unrelated tools stay usable. |
| 2 | A03/A04 model-visible document/MCP content; A07/A08 continuation and truncation; A09/A10 version-bound reads/transforms and search continuation | P2-P4, P6 | Complete tool-to-provider workflows preserve content/locators, detect stale versions, and make bounded progress. |
| 3 | A11 truthful UI state; A12 aggregate MCP limits; G01 parsing responsiveness | P7, P6, P3/P4 | Event-sequence tests and desktop state evidence; actual loader enforces limits; measured cancellation/response bounds for retained parser scope. |
| 4 | G03 reconcile matrix, child statuses, historical claims and receiving tasks; run the full gate after fixes | P7 and affected child-plan owners | Every active criterion has accurate named evidence; no old passing test substitutes for an unresolved audit finding. |
| 5 | G02 perform retained Windows workflows, including all 26 Cycle 5 manual criteria carried by C6-I020 | P7 plus Cycle 5 P6 | MANUAL-ACCEPTANCE has actual observations/build/context; failures remain open; Cycle 5 carryover disposition is recorded separately. |
| 6 | Record Cycle 6 acceptance decision; register Cycle 7 receiving tasks before scheduling that cycle | P7 / next-cycle planning | Audit findings closed or explicitly dispositioned without weakening retained guarantees; no implicit waiver, no installer/release claim. |

Cycle 7 receiving work must identify a deliverable and acceptance evidence for
packaging/installed support, settings and configuration reload, conversation
management, schema-digest binding, and frontend testing/interaction quality.
Current references to “Cycle 7 owns it” are not yet an executable receiving plan.
Keep C6-40 truthful state and C6-44 streaming/cancellation/session regression
obligations in this cycle even where broader interaction audits are deferred.

## Document Responsibilities

| Document | Responsibility |
| --- | --- |
| [PRD](./PRD.md) | Product behavior, capability tiers, policy, scope, and acceptance |
| This `PLAN.md` | Order, cross-plan contracts, traceability, quality gate, and status |
| [`plans/P*.md`](./plans/) | Tasks, deliverables, exit criteria, checks, and implementation evidence |
| [ISSUES.md](./ISSUES.md) | Decisions, discoveries, exceptions, and follow-up |
| [AUDIT-REPORT.md](./AUDIT-REPORT.md) | Independent review snapshot, reproduced failures, design/scope assessment, and evidence limits. Execution ownership stays in this plan. |
| [AUDIT-BRIEF.md](./AUDIT-BRIEF.md) | Entry point for an audit pass: orientation, reading order, the gate to run, and the places this cycle is least confident. |
| [ACCEPTANCE-MATRIX.md](./ACCEPTANCE-MATRIX.md) | The C6-01 through C6-45 matrix: each criterion linked to named tests, a manual checklist item, or a recorded reason it has none. The record. |
| [MANUAL-ACCEPTANCE.md](./MANUAL-ACCEPTANCE.md) | The P7 runner for everything deterministic tests cannot establish, including the 26 Cycle 5 criteria carried over by C6-I020. Working copy. |

Do not create a second live plan index or copy child-plan checklists here.
Verification evidence stays with each child plan until P7 assembles the final
acceptance matrix and the cycle acceptance record.

## Restart Checkpoint

Cycle 5 P0-P6 code is implemented; its Windows manual evidence and release
decision are unfinished. The C5-01 through C5-40 acceptance matrix is complete
and evidence-linked; 26 criteria still require desktop evidence. Review checks
passed: typecheck/build, cargo fmt/check, 80 runtime tests, 30 Rust tests, and
git diff --check. No real-provider, Windows UI, or installed-application
acceptance was performed during review.

Automatic descriptor handoff already exists through prompt attachments and
runtime workspace resolution. P1 hardens selection, target association,
ambiguity, and task continuity; it must not add a second handoff path. P2 fixes
continuation gaps, including long-line byte truncation without a next offset.
P3 separates binary input from text representation and adds parse-time limits
and cancellation. Decisions are recorded as C6-I008 through C6-I010.

P0 is implemented (2026-09-16): the registry, the policy evaluator, the
availability prerequisite mechanism, and the grant-verified permission path are
in place, with 60 new deterministic tests alongside the 80 unchanged Cycle 5
tests. P0's decisions and discoveries are C6-I011 through C6-I019. Two of them
are open by design: C6-I017 (the task 11 packaging contract, recorded in
[PACKAGING-CONTRACT.md](./PACKAGING-CONTRACT.md), its implementation reassigned
to Cycle 7 by C6-I034) and C6-I019 (no policy rule keys on `scope`, so P6 must
classify or add one).

Web Search was removed from Cycle 6 entirely on 2026-09-18
([C6-I026](./ISSUES.md#c6-i026---web-search-leaves-cycle-6-entirely)) and is
recorded as actively considered. Cycle 6 ships two first-party capabilities
(PDF, Word) and an MCP adapter, and bundles no MCP server. C6-26 through C6-30
are retired rather than left ownerless.

## Execution Invariant

All three capability tiers use one path:

```text
user-triggered host capture
  -> bounded Context Plane snapshot
  -> task-local workspace/target resolution
  -> per-run Aside capability registry
  -> Pi model turn and validated tool call
  -> Policy Plane decision from trusted metadata
  -> built-in adapter or user-connected MCP adapter
  -> bounded normalized tool result
  -> same Pi loop continues
  -> permissioned writes are verified where supported
  -> truthful terminal result and bounded persistence
```

No plan may add shell, PowerShell, arbitrary process/code execution,
process-global `cwd`, hidden browsing, or an unsupported-format fallback.

## Delivery Map

```text
M0 Cycle 5 acceptance closeout (owned by Cycle 5 P6)
  -> P0 Capability contract, Policy Plane, and packaging decision
  -> P1 Existing context-to-workspace handoff hardening
  -> P2 Shell-free workspace foundation

P0 + P2 -> P3 Document representation and PDF read
P3       -> P4 Word read, create, and transform
P0 + M2  -> P6 User-connected MCP tool adapter
              verified against faux + adversarial fixtures; no bundled server
              (P5 retired and Web Search removed - see C6-I026)

P1 through P4 + P6 -> P7 Surface and cycle acceptance closeout
                        packaging deferred to Cycle 7 (C6-I034)
```

Execute M0 first, then P0/P1/P2 as the first delivery slice. P3/P4 deliver the
document slice; P6 proceeds after M2 with one initial transport, verified
against deterministic and adversarial fixtures rather than a live server. No
adapter may redefine the registry or permission contract locally.

Each capability includes its minimum IPC/UI projection and decision controls
in its own delivery. P7 consolidates acceptance and regression evidence; it
is not the first integration point for usable desktop workflows.

| ID | Plan | Purpose | Depends on |
| --- | --- | --- | --- |
| M0 | [Cycle 5 closeout](../cycle-5-agent-capability/plans/P6-side-surface-and-release.md#remaining-closeout-work-m0) | Complete predecessor acceptance evidence and record its acceptance. | Implemented Cycle 5 |
| P0 | [Capability contract and Policy Plane](./plans/P0-capability-contract-and-policy-plane.md) | Establish the common registry/policy contract and runtime packaging decision. **Implemented 2026-09-16**; task 11 open under C6-I017. | M0 |
| P1 | [Context-to-workspace handoff hardening](./plans/P1-context-workspace-handoff.md) | Correct existing candidate selection, target association, ambiguity, and task continuity; prove the desktop path. **Implemented 2026-09-17**; Windows trace is the M2 checkpoint. | P0 |
| P2 | [Shell-free workspace foundation](./plans/P2-shell-free-workspace-foundation.md) | Make list/read/search/stat/write/edit fluent, bounded, and recoverable without process execution. **Implemented 2026-09-17** for the reproduced continuation gap and pagination; encoding/search-review tasks deferred with owners. | P0 and P1 |
| P3 | [Document representation and PDF read](./plans/P3-document-model-and-pdf.md) | Establish common structured document results and add honest bounded PDF reading. **Implemented 2026-09-17**; `pdfjs-dist@6.3.289` (Apache-2.0). C6-19 event-loop measurement and task 11 faux-agent flows open. | P0 and P2 |
| P4 | [Word read, create, and transform](./plans/P4-word-capability.md) | Add `.docx` structured reads and permissioned generation/transformation with validation. **Implemented 2026-09-18**; manual Word-open evidence and part of task 11 outstanding. | P3 |
| P5 | ~~[First-party Web Search](./plans/P5-web-search.md)~~ | **Removed from Cycle 6 on 2026-09-18** ([C6-I026](./ISSUES.md#c6-i026---web-search-leaves-cycle-6-entirely)). Delivers nothing; C6-26 through C6-30 retired. | — |
| P6 | [User-connected MCP tool adapter](./plans/P6-mcp-tool-adapter.md) | Discover and adapt user server tools without surrendering Aside policy or runtime control. **Implemented and wired 2026-09-18**, verified against a real child process and adversarial fixtures; the manual smoke test and the surface remain. No server bundled and no search workload. | P0 and M2 |
| P7 | [Surface, regression, and release](./plans/P7-surface-and-release.md) | Project capability activity honestly and close C6 acceptance with deterministic and Windows evidence. | P1 through P6 |

## Shared Contracts

### Context, runtime, and policy

- Context capture is passive, user-triggered, native-owned, bounded, and
  non-authorizing.
- Runtime owns tool registration, invocation, limits, cancellation,
  normalization, and Pi loop continuation.
- Policy is evaluated from trusted Aside metadata at execution time. Tool
  descriptions, document contents, search results, and MCP annotations are
  untrusted inputs.
- React is a serialized projection and decision surface, never an execution or
  path-authority layer.

### Registry and adapters

- Built-in and MCP tools enter one per-task registry with stable names,
  schemas, results, policy metadata, availability, and cancellation behavior.
- Reserved Aside namespaces cannot be shadowed by extensions.
- One adapter's failure cannot prevent unrelated tools from registering.
- Public product contracts do not expose parser-library, search-provider, or
  MCP-SDK object types.
- Any contract change from Cycle 5 requires compatibility coverage or an issue
  recording why the incompatibility is necessary.

### Security and privacy

- Workspace containment and exact-operation write permission remain runtime
  enforced.
- Network egress is independently declared from read/write effect.
- Secrets never enter provider prompts, React events, ordinary logs, or
  durable transcript entries.
- A user-run MCP server is not described as sandboxed unless a future verified
  sandbox actually enforces that property.
- Unknown or conflicting risk metadata fails closed.
- No implementation may invoke a command-line converter, browser, shell, or
  process as an implicit fallback.

### Results and persistence

- All tool outcomes, including unsupported, partial, denied, cancelled,
  expired, stale, timed out, disconnected, malformed, and failed, have one
  bounded normalized result.
- Truncation and continuation are explicit; absence of output is not treated
  as completeness.
- Durable state retains only bounded conversation records necessary for
  coherence. Active workspace authority, permissions, credentials, MCP
  connections, and full extracted documents are transient.

## Dependency and License Gate

Before adding a runtime dependency, the owning plan records:

1. candidate libraries/SDKs and the selected version;
2. license and redistribution obligations;
3. maintenance/security evidence and known advisories;
4. native binary, subprocess, telemetry, and network behavior;
5. Windows packaging and build implications;
6. cancellation, limit, and deterministic-test seams;
7. why direct library/SDK use fits the Aside boundary better than alternatives.

Do not select PDF, Word, or MCP dependencies by popularity alone. A license or
packaging blocker is resolved in the owning plan before feature implementation
proceeds. P3 (PDF, Apache-2.0), P4 (Word), and P6 (MCP SDK, MIT) have each
recorded their selection; Web Search contributed none because it was removed
from the cycle.

## Milestone Checkpoints

### M0: close Cycle 5 (Cycle 5 P6)

The [remaining closeout checklist](../cycle-5-agent-capability/plans/P6-side-surface-and-release.md#remaining-closeout-work-m0)
owns C5-01 through C5-40 dispositions and their acceptance record. Its
acceptance matrix is complete; its manual column is not.

By [C6-I020](./ISSUES.md#c6-i020---cycle-5-manual-acceptance-moves-to-the-p7-release-gate),
the manual pass and the Cycle 5 release decision move to M5 (P7), which runs one
combined acceptance over both cycles. Cycle 5 is **not** recorded as released,
and the unperformed Windows evidence is not relabeled as passed. M0's gate is
satisfied for implementation purposes by the completed matrix, the recorded
automated gate, and that decision.

### M1: policy foundation (P0)

The registry can express the Cycle 6 multidimensional policy without changing
Pi or exposing new capabilities. Existing Cycle 5 tools pass compatibility
tests under the new contract.
The Node/runtime/dependency/skill packaging contract and clean-install test
environment are recorded before new dependencies are selected.

### M2: local capability foundation (P1-P2)

A real captured file reaches a bound workspace and target automatically. The
model can inspect and change supported text files through bounded tools without
manual path mechanics or shell fallback.

This is the mid-cycle desktop checkpoint ([C6-I020](./ISSUES.md#c6-i020---cycle-5-manual-acceptance-moves-to-the-p7-release-gate)).
The check is one happy path on Windows — summon, capture a file in Explorer,
observe automatic workspace and target binding, read, edit, approve, verify —
and not the acceptance matrix. It must pass before P3-P6 build on it; a broken
handoff there invalidates every later capability.

**Passed 2026-09-17.** Provider `deepseek` against an OpenAI-compatible relay,
model `deepseek-v4-flash`. Observed: conversation completed; a captured `.txt`
file was read and modified through the workspace tools; the permission card
appeared and the operation completed after Allow. The local file loop P3-P6
will build on is therefore real and working, not assumed.

Recorded honestly, the specific sub-claims this run did **not** separately
confirm — whether the surface showed the containing directory as the workspace
with the captured file as target, that Explorer emitted both a directory and a
selected-item descriptor, and the ambiguity/stale refusals — remain for the P7
matrix. A successful read of a relative path does not by itself distinguish the
root/target split from the pre-P1 behaviour, because both would resolve that
path. P1's evidence for those is its deterministic suite.

### M3: first-party core tools (P3-P4)

PDF read and Word read/create/transform work through stable Aside contracts
with representative fixtures, honest limits, permission, and verification
evidence. Web Search was in this milestone and was removed from the cycle on
2026-09-18 ([C6-I026](./ISSUES.md#c6-i026---web-search-leaves-cycle-6-entirely));
its acceptance intent survives only as a PRD requirement for any future search
capability, not as work owed this cycle.

### M4: extension boundary (P6)

A user-configured MCP server exposes only adapted namespaced tools. Unknown
risk, malformed schema, cancellation, timeout, oversized results, and server
failure all fail within the declared boundary.

This milestone is verified against deterministic and adversarial fixtures
rather than a live server, and that is recorded rather than glossed. A faux
server written with the same SDK speaks exactly the protocol we expect, so its
fixtures are derived from a real third-party server that was read for the
purpose: JSON Schema `anyOf` unions of `number` and `string` with defaults, tool
descriptions that contradict the tool's actual behavior, a tool accepting an
arbitrary URL, and a server that itself spawns child processes. Those shapes
must be covered by the suite.

Cycle 6 therefore ships an MCP boundary exercised against adversarial protocol
shapes but not against a third-party server at runtime. One manually configured
server smoke test on Windows is retained; P7 states the extent of that evidence
plainly instead of implying field validation.

### M5: cycle closeout (P7)

The complete quality gate, C6 matrix, and representative Windows flows pass;
the visible model registry contains no shell or deferred capability.

**Amended 2026-09-19 by
[C6-I034](./ISSUES.md#c6-i034---p7-was-over-broad-packaging-and-surface-quality-move-to-cycle-7).**
This milestone previously also required an installed app to complete
conversation and permissioned file work without the source checkout. That
requirement came from [C6-I010](./ISSUES.md#c6-i010---installed-runtime-is-a-release-requirement),
not from the [PRD](./PRD.md#19-release-boundary), whose six-item release
boundary never mentions an installed application. Packaging, installed-resource
support, and clean-profile verification moved to Cycle 7, together with the
frontend interaction work.

M5 is therefore **cycle acceptance closeout, not a release**. The two are
different claims and were previously conflated.

At every checkpoint, update child-plan status only after its exit criteria and
checks pass. Record contract or scope changes in `ISSUES.md` before treating
them as the new baseline.

## Engineering Quality Gate

Run the existing repository gate at shared-contract checkpoints and in P7:

```text
npm.cmd run typecheck
npm.cmd run build
npm.cmd run runtime:test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

Plans adding focused suites must add them to `runtime:test` or another root
script before closure. Document/parser tests use committed synthetic fixtures
or reproducible fixture generators with no personal content. MCP release tests
use faux backends derived from observed third-party server shapes; the one
manual server smoke test is manual evidence and must not expose credentials.

If the Pi vendor slice changes, run `npm.cmd run pi:build` and its focused
tests. Cycle 6 does not anticipate a Pi core change; such a change requires an
issue and explicit justification.

## Acceptance Traceability

| Product area | Plan | Acceptance criteria |
| --- | --- | --- |
| Plane separation, registry, policy, trust, cancellation | P0 | C6-01 through C6-05 |
| Descriptor resolution and task-local workspace binding | P1 | C6-06 through C6-08 |
| Fluent bounded workspace operations and no fallback | P2 | C6-09 through C6-14, C6-42 |
| Common document model and PDF read | P3 | C6-15 through C6-19 |
| Word read, create, transform, replacement refusal, fidelity | P4 | C6-20 through C6-25 |
| ~~Web Search egress, results, failure, and privacy~~ | ~~P5~~ | **C6-26 through C6-30 retired** ([C6-I026](./ISSUES.md#c6-i026---web-search-leaves-cycle-6-entirely)); no capability exists this cycle to accept against |
| MCP discovery, adaptation, permission, isolation | P6 | C6-31 through C6-39 |
| Surface, persistence, full matrix, regressions, Windows | P7 | C6-40 through C6-45 and all cross-plan release evidence |

## Cycle Acceptance Boundary

**This section defines when Cycle 6 is complete — not when a release ships.**
The two were conflated until 2026-09-19
([C6-I034](./ISSUES.md#c6-i034---p7-was-over-broad-packaging-and-surface-quality-move-to-cycle-7)).
Nothing in Cycle 6 produces an installable artifact.

P7 may mark Cycle 6 complete only when the [PRD release boundary](./PRD.md#19-release-boundary)
is met and every child plan has recorded evidence. Specifically, the cycle
must demonstrate automatic workspace handoff, a fluent shell-free file loop,
the two first-party core capabilities (PDF, Word), the MCP tool path against
deterministic and adversarial fixtures with one manual server smoke test, and
the absence of all deferred execution surfaces from the model registry.

These are the retained obligations, not a claim that the boundary has been met.
C6-I034 superseded the accepted installation scheduling decision C6-I010;
installation is now Cycle 7 work. C6-I035 records retained failures and missing
manual evidence that must be resolved before this cycle's acceptance.

The following remain deferred for this cycle: shell and process execution, Excel,
PowerPoint, GitHub, VSCode actions, Notion, general browsing, **Web Search in any
form — not restated at the end of the cycle as "deferred" in the sense of "not
yet shipped"** — PDF mutation/OCR, full Word round-trip fidelity, Word same-path
replacement/existing-output overwrite, bundled or default MCP servers, advanced
MCP features, marketplace/install flows, permanent trust, multi-workspace
execution, background agents, **the MCP configuration surface**
([C6-I033](./ISSUES.md#c6-i033---mcp-configuration-is-file-based-and-the-surface-is-read-only)),
and — added by
[C6-I034](./ISSUES.md#c6-i034---p7-was-over-broad-packaging-and-surface-quality-move-to-cycle-7) —
**packaging and installed-application support** and **frontend interaction
quality** (accessibility, keyboard, resizing), both of which are Cycle 7 work.

An auditor must be able to tell a deferral from a failure. Every entry above
names the entry that deferred it.

Web Search was removed from Cycle 6 on 2026-09-18
([C6-I026](./ISSUES.md#c6-i026---web-search-leaves-cycle-6-entirely)) and is
recorded as actively considered. P7 must not describe it as a near-miss or a
partial delivery.
