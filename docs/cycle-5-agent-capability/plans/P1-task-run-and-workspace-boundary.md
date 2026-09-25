# P1 - Task Run and Workspace Boundary

Status: implemented (2026-09-05)
Depends on: P0 - Runtime Contracts and Pi Loop Boundary
Unblocks: P2 - Capability Registry and Bounded Read Tools
Source requirements: Cycle 5 PRD sections 3, 5, 10, 12, and 14

## Outcome

Turn a validated Cycle 4 path descriptor, explicit workspace hint, or user
path into one active workspace for one TaskRun. The workspace is an execution
scope and per-run environment, not a label and not a process-global current
directory. Every later tool call can resolve and revalidate paths through this
boundary.

## Workspace Policy

Use the PRD precedence order: explicit current-task selection, validated Cycle
4 workspace descriptor, validated file/document descriptor's containing
directory, user-provided path, and a previously active workspace only when the
same task and target remain valid. If no valid workspace exists, file tools are
not exposed as usable capabilities.

For a file descriptor such as `C:\docs\report.docx`, the run stores the
canonical workspace `C:\docs` and the relative target `report.docx`. A path
descriptor remains reference metadata; activation never grants read or write
authority by itself.

Pi-full's `packages/agent/src/harness/types.ts` provides a useful contract
shape: addressed paths are kept distinct from `canonicalPath`, `FileInfo`
reports object kind/size/mtime, and filesystem operations return a typed
`Result`/`FileError` rather than leaking backend exceptions. P1 may adapt these
ideas to Windows, but must not adopt the Node `ExecutionEnv` wholesale or its
shell capability.

## Tasks

1. Define the TaskRun workspace state, target reference, provenance, expiry,
   and lifecycle transitions. Keep the durable Aside session id separate.
2. Validate and canonicalize Windows directories and targets. Specify drive,
   UNC, separator, case, `..`, file/directory type, length, inaccessible, and
   missing-path behavior.
3. Define a per-run execution environment with explicit `resolvePath`,
   `assertWithinWorkspace`, expected-type checks, and target identity/version
   capture. Keep addressed and canonical paths explicit, use abort-aware
   typed filesystem results where useful, and never call `process.chdir()`.
4. Enforce the root boundary at execution time, including normalized absolute
   paths, symlinks/junctions/reparse points, and replacement between prepare
   and execute. A scope escape returns a typed error without an effect.
5. Connect Cycle 4 descriptors and optional workspace hints to TaskRun
   creation while preserving capture expiry and target provenance. Emit a
   bounded `workspace_resolved` or honest failure event.
6. Add deterministic path and filesystem seams for relative/absolute paths,
   neighboring files, escape attempts, wrong types, stale descriptors,
   inaccessible roots, target replacement, and explicit workspace switching.

## Deliverables

- Runtime-owned TaskRun workspace contract and resolution policy.
- Per-run filesystem environment with execution-time containment checks.
- Descriptor-to-workspace handoff with provenance and expiry validation.
- Structured workspace state/error events and test fixtures.
- Proof that session storage is unchanged when a task workspace changes.

## Exit Criteria

- C5-02 and C5-06 through C5-12 pass with no file read before workspace
  activation.
- C5-08 relative paths resolve only against the active TaskRun workspace, not
  the session directory or process cwd.
- C5-09 scope escapes and C5-10 invalid/stale roots fail closed and do not
  expose usable file capabilities.
- C5-11 workspace changes are explicit and task-local; C5-12 late results
  cannot switch the target or workspace.
- Canonicalization and revalidation behavior is covered by faux and Windows
  filesystem tests, including the chosen reparse-point policy.

## Checks

Run runtime workspace tests on Windows, plus typecheck and the Rust regression
tests that cover Cycle 4 descriptor serialization. Inspect the process for
any `process.chdir()` use before closing this plan.

## Verification

- `npm.cmd run runtime:test` passed: 38 tests.
- `npm.cmd run typecheck` passed.
- `node --check` passed for the workspace and runtime modules and tests.
- The runtime exposes no workspace-scoped tools until a valid workspace is
  resolved, and the resolved state is emitted before `run_started`.
- Relative and absolute target paths are checked lexically and again through
  canonical paths. Existing symlink/junction targets are followed only when
  their resolved target remains inside the canonical workspace; an escape is
  rejected. Missing targets resolve only through a canonical in-workspace
  parent for later write preparation.
- The active workspace is retained as TaskRun state and can be explicitly
  selected or cleared through the runtime API. Session storage and
  `process.cwd()` remain unchanged.
- `rg "process\\.chdir" agent-runtime src src-tauri` found no implementation
  use.
