# Cycle 5 Agent Capability Issues

Status: active planning log
Scope: decisions, surprises, exceptions, and follow-up discovered while delivering Cycle 5

This log is intentionally separate from the PRD and executable plan files. Add
an entry when implementation reveals behavior that was not explicit in the PRD
or when a decision changes a contract, ownership boundary, or release scope.

## Issue Rules

- Use the next `C5-I###` identifier.
- Record the issue before silently changing a plan or contract.
- Keep facts, impact, decision, and follow-up separate.
- Link the affected plan and PRD requirement when known.
- Mark an issue `open` when implementation still needs a decision, `accepted`
  when the decision is part of this cycle's boundary, and `closed` when the
  implementation and follow-up are complete.
- Do not include credentials, private prompts, raw file contents, native
  handles, or sensitive local paths.

## Issue Index

| ID | Status | Area | Summary | Plan |
| --- | --- | --- | --- | --- |
| C5-I001 | accepted | Documentation | Keep one coordination `PLAN.md`; child `plans/P*.md` remain the executable work packages. | PLAN, P0-P6 |
| C5-I002 | accepted | Pi API | Use the usable Pi `Agent` and AgentTool hooks; do not make the unfinished AgentHarness the product runtime. | P0 |
| C5-I003 | accepted | Workspace | Bind a workspace per TaskRun through an explicit environment; do not call `process.chdir()` or move session storage. | P1, P5 |
| C5-I004 | accepted | Tool safety | Use sequential execution for initial writes and mixed batches; approval never covers another call. | P0, P3 |
| C5-I005 | accepted | Documents | Start with bounded UTF-8 text/Markdown and JSON; unsupported binary formats return typed results. | P2, P3 |
| C5-I006 | accepted | Permission | The runtime broker, not React or model instructions, owns exact-operation permission state. | P3, P5, P6 |
| C5-I007 | accepted | Evidence | Keep verification evidence in plan files and this log during delivery; create no duplicate verification file for the planning baseline. | PLAN, P6 |
| C5-I008 | accepted | Pi integration | Keep `vendor/pi` as the runtime and use `vendor/pi-full` selectively as reviewed source reference; do not import its unfinished harness or coding-agent authority model. | PLAN, P0-P5 |
| C5-I009 | accepted | Workspace | Follow existing symlink/junction targets only when their canonical target remains inside the active workspace; reject canonical escapes and resolve missing targets through an in-workspace canonical parent. | P1, P2, P3 |

## C5-I001 - Keep One Coordination Plan

Status: accepted
Discovered: planning review
Affected: PLAN and P0-P6
Requirements: PRD document set

### Fact

Cycles 1 through 3 used `PLANS.md` as an index and separate `plans/P*.md`
files. Cycle 4 uses `PLAN.md` for the cross-plan closeout order while still
linking detailed child plans. Cycle 5's PRD asks for a future plan and issues
log, without requiring both a singular and plural index.

### Impact

Creating both `PLAN.md` and `PLANS.md`, or copying every child task into a
summary file, would create two sources of truth for execution order and
status.

### Decision

Cycle 5 keeps one `PLAN.md`. It records cross-plan order, shared invariants,
traceability, quality gate, and release boundary. Each `plans/P*.md` file
records only its own outcome, tasks, deliverables, exit criteria, and checks.

### Follow-up

Do not add a `PLANS.md` unless a later cycle changes the documentation model
explicitly. Update the coordination file when dependencies or the release
boundary change; do not duplicate child task lists there.

## C5-I002 - Use Pi Agent Rather Than AgentHarness

Status: accepted
Discovered: planning review of vendored Pi 0.84.4
Affected: P0, P5
Requirements: PRD sections 4.1-4.3, C5-36, C5-37

### Fact

The repository already uses Pi's `Agent` and low-level loop through the
`@earendil-works/pi-agent-core/aside` export. The vendored harness types are
not the established Aside runtime path, and the PRD explicitly excludes the
full coding-agent application's assumptions.

### Impact

Making the harness or coding-agent CLI/TUI the product runtime would couple
Aside to fixed cwd, trust, shell, settings, and UI behavior before the
workspace and permission boundaries exist.

### Decision

P0 extends the current Agent adapter with Aside-owned task/tool contracts and
Pi's validated tool hooks. AgentHarness can be reconsidered only after its
required operations and context model fit Aside's boundary.

### Follow-up

Record any concrete Pi API incompatibility discovered during P0 before
changing the dependency or adapter strategy.

## C5-I003 - Workspace Is Per-Task State

Status: accepted
Discovered: product boundary review
Affected: P1, P5
Requirements: C5-06 through C5-12, C5-34, C5-35

### Fact

Cycle 4 already produces validated path descriptors, while the current runtime
session is intentionally rooted in a separate Aside session directory.

### Impact

Using the process cwd or session root for file tools would make a captured
descriptor advisory instead of authoritative and could expose unrelated files.

### Decision

P1 creates one explicit execution environment per TaskRun. The session root is
unchanged, and descriptor activation is followed by runtime canonicalization,
containment, and target revalidation.

### Follow-up

The chosen Windows reparse-point and target-replacement policy must be covered
by deterministic and Windows-specific tests before P1 closes.

## C5-I004 - Sequential Initial Tool Execution

Status: accepted
Discovered: Pi API review
Affected: P0, P3
Requirements: PRD sections 6.4, 7.2, 9.4, C5-21, C5-26

### Fact

Pi Agent supports parallel tool execution by default, while Cycle 5 requires
sequential writes and sequential mixed read/write batches.

### Impact

Allowing parallel default behavior would make permission ordering, previews,
target races, and one-operation approval harder to reason about.

### Decision

Cycle 5 configures sequential execution for the initial tool registry. A
future read-only parallel mode requires an explicit bounded-safety decision and
tests; one approval never authorizes a sibling call.

### Follow-up

P3 must verify batch ordering and no second write after an allow, including
model responses containing multiple tool calls.

## C5-I005 - Initial Document Representations

Status: accepted
Discovered: scope review
Affected: P2, P3, P6
Requirements: PRD sections 11 and 19, C5-16, C5-31 through C5-33

### Fact

Cycle 4 path descriptors identify files but do not read them. Cycle 5 requires
at least one supported document workflow and explicitly rejects universal
binary parsing.

### Impact

Choosing a binary format before a bounded adapter and save/validation contract
exists would expand the first vertical slice and create unsafe fallback
pressure.

### Decision

The first production adapter slice supports bounded UTF-8 text/Markdown and
JSON read, transform/edit, write, and verification. PDF, Word, Excel, and
other binary/structured formats return typed unsupported results until a
separate adapter contract is reviewed.

### Follow-up

P2 and P3 must record actual size, encoding, atomicity, and parse-validation
limits in their implementation evidence.

## C5-I006 - Runtime-Owned Permission Broker

Status: accepted
Discovered: permission boundary review
Affected: P3, P5, P6
Requirements: PRD sections 7, 12, 13, and 14

### Fact

Pi exposes a validated pre-tool hook and Aside already has a Tauri/React event
boundary. Neither layer alone can bind a user decision to an exact prepared
filesystem operation.

### Impact

A UI-only confirmation or model instruction could be bypassed by another tool
call, stale target, or replayed request.

### Decision

The runtime owns pending operation preparation, permission identity, expiry,
decision matching, cancellation, revalidation, and write execution. React
receives only a bounded serialized preview and sends an explicit decision.

### Follow-up

P3 must prove that deny, expiry, stale target, cancellation, duplicate
responses, and restart cannot mutate the workspace.

## C5-I007 - Evidence Lives With the Work

Status: accepted
Discovered: documentation review
Affected: PLAN and P6
Requirements: PRD document set and C5-40

### Fact

Cycle 3 explicitly placed evidence in plan exit criteria and its issues log;
Cycle 4 used a closeout plan rather than a separate verification record.

### Impact

A separate Cycle 5 verification file would duplicate status and make it easy
for plan completion and release evidence to diverge.

### Decision

The planning baseline has no `VERIFICATION.md`. Child plans hold their checks
and evidence, while `ISSUES.md` records exceptions and P6 carries the final
acceptance matrix and release decision.

### Follow-up

If a later release process needs a standalone artifact, add it deliberately as
part of P6 closeout rather than as a second live execution index.

## C5-I008 - Use Pi-full Selectively as Source Reference

Status: accepted
Discovered: 2026-09-05 `vendor/pi-full` review
Affected: PLAN, P0-P5
Requirements: PRD sections 4 through 10, 13, 14, C5-27, C5-36, and C5-37

### Fact

`vendor/pi-full` contains the broader Pi source tree, including the low-level
Agent package, the experimental AgentHarness layer, coding-agent tools and
resource loaders, and separate protocol/client/server packages. The low-level
Agent documentation and source confirm the existing Aside path: validated
tool arguments, `beforeToolCall`/`afterToolCall`, sequential tool execution,
tool lifecycle events, cancellation, and faux-provider seams are available.

The AgentHarness surface is not a drop-in implementation. Its `create` path
rejects an existing session with `HarnessNotImplemented("create.restore")`, and
its `prompt`, `skill`, `resume`, `abort`, queue, compaction, navigation, and
watch paths still reject as unimplemented. The source does contain useful
contracts and supporting modules, such as `Result`, `FileError`, `FileInfo`,
`FileSystem`, bounded read/edit helpers, skill diagnostics, and mutation
serialization.

The coding-agent package assumes its own application model: fixed-cwd Node
filesystem/process tools, shell and PowerShell capabilities, settings and
resource loading, extensions, and project trust. The Pi protocol packages use
CBOR framing with a separate client/server lifecycle. Neither model is the
existing Aside JSONL/Tauri boundary or its permission policy.

The package manifests point at built `dist` output, while the supplied source
snapshot has no built output or installed dependency tree. Directly importing
the nested workspace would therefore add an unreviewed build and dependency
boundary even before product-policy differences are considered.

### Impact

Replacing the current Agent adapter with AgentHarness would make P0 depend on
unfinished operations. Importing `createCodingTools` or its session/resource
runtime could silently add shell, global-cwd, project-trust, extension, or
unbounded filesystem behavior. Replacing Aside JSONL with Pi protocol would
also expand a local process boundary that already has working contracts.

Ignoring the source entirely would unnecessarily duplicate mature bounded file,
skill, error, diff, and event-handling ideas and make P1-P5 less precise.

### Decision

1. Keep the existing minimal `vendor/pi` package and low-level `Agent` as the
   Cycle 5 runtime dependency.
2. Treat `vendor/pi-full` as a source reference, not as a runtime import,
   nested workspace, or automatic dependency update.
3. Selectively adapt the filesystem/result/error contracts, read and edit
   algorithms, truncation rules, canonical-path mutation queue, skill loading
   and diagnostics, and protocol correlation/event principles when they pass
   the gates in the Cycle 5 `PLAN.md`.
4. Do not adopt AgentHarness, coding-agent tools as a whole, shell or
   PowerShell execution, extensions, project trust, or Pi client/server/CBOR as
   Aside authority or default capability.
5. Keep workspace resolution, permission decisions, session persistence, and
   JSONL/Tauri IPC owned by Aside even when an algorithm is adapted.

### Follow-up

- P0 may use AgentHarness's per-turn context idea through an Aside wrapper or
  closure, but must not introduce `AgentHarnessTool` or its runtime.
- P1 should define an Aside filesystem facade with explicit addressed versus
  canonical paths, `FileInfo`-style metadata, abort-aware operations, and
  typed failures.
- P2 should reference Pi's line/byte truncation and bounded read behavior while
  retaining the `workspace.*` registry and explicit-call/no-indexing policy.
- P3 should reference exact replacement/diff behavior and canonical-path
  mutation serialization, while routing every effect through the permission
  broker and revalidation path.
- P4 should reference SKILL.md frontmatter, name/description validation,
  ignore files, source classification, collision handling, and diagnostics;
  project trust and executable extensions remain excluded.
- P5 may reuse request correlation, authoritative snapshots, transient
  progress, and framing-limit principles, but continues to implement them in
  Aside JSONL rather than importing Pi protocol/client/server.

## C5-I009 - Canonical Reparse-Point Policy

Status: accepted
Discovered: P1 workspace boundary implementation
Affected: P1, P2, P3
Requirements: PRD sections 5.3-5.4, 7.5, and C5-09/C5-10

### Fact

Windows junctions/reparse points and POSIX symlinks can make a lexically
contained path resolve outside the selected workspace. A missing write target
does not have a canonical target yet, so its parent must be resolved before
the target is admitted.

### Decision

Aside follows an existing resource to its canonical target and requires that
target to remain inside the canonical workspace. A canonical escape returns a
typed `scope_escape` result with no filesystem effect. A missing target is
represented only by an in-workspace canonical parent plus its final basename;
P3 must revalidate that parent and exact target before any write.

### Follow-up

P2 read tools and P3 write tools must use the same environment methods and
retain this policy in their negative-case tests.
