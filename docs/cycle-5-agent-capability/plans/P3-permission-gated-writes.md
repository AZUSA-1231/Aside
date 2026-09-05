# P3 - Permission-Gated Writes and Verification

Status: implemented (2026-09-05)
Depends on: P2 - Capability Registry and Bounded Read Tools
Unblocks: P4 - Skills and Resource Loading
Source requirements: Cycle 5 PRD sections 6, 7, 9, 11, 12, 14, and 16.4

## Outcome

Add the first write-capable document path with a runtime-owned permission
broker. `workspace.write` creates or replaces a bounded UTF-8 text/JSON file;
`workspace.edit` applies a bounded, inspectable replacement. Both prepare an
exact operation, show its scope to the user, wait for one decision, revalidate
the target, and execute at most once after approval.

The React permission view is only a projection and decision input. It never
opens a file, computes a diff, or executes a write.

## Permission State Machine

```text
validated tool call
  -> prepared operation and target identity
  -> permission_requested
  -> allow | deny | cancel | expiry
  -> revalidate exact pending operation
  -> execute once or return typed result
  -> permission_resolved and tool_result
```

The pending record is keyed to the task run, request, tool call, permission id,
workspace identity, target set, prepared content/diff, and expiry. A response
for another operation, a duplicate response, or a response after cancellation
is safely ignored or rejected. There is no permanent trust grant.

Pi-full's edit/diff helpers are useful references for exact replacement,
bounded patch previews, and preserving text details such as BOM/line endings.
Its file-mutation queue is useful for serializing operations by canonical target
path. Neither helper is an authorization boundary: the adapted operation must
still be prepared by Aside, pass the permission broker, and be revalidated
against the active workspace before execution.

## Tasks

1. Define the permission request/decision/result contracts and broker state.
   Support allow, deny, cancel, expiry, stale, and invalidated outcomes with
   bounded display text.
2. Prepare writes before the permission event: resolve the target, capture its
   expected identity/version, compute a bounded diff or replacement summary
   using the reviewed exact-edit behavior where compatible, enumerate every
   target, and state the operation's effect and limitation.
3. Route all write calls through the broker at the runtime boundary. Use Pi's
   validated tool-call hook or an equivalent Aside wrapper as the gate; do not
   rely on system-prompt instructions or UI behavior for authorization.
4. On allow, revalidate active task, workspace, target identity/version,
   operation expiry, cancellation, and decision identity before executing the
   prepared operation. Any mismatch must produce no write.
5. Implement atomicity and truthful result behavior for text/JSON create,
   replace, edit, and post-write parse/read verification. Do not silently
   replay a non-replayable write after restart.
6. Force sequential behavior for writes and mixed tool batches. Use a
   canonical-target mutation queue when needed, but keep it subordinate to the
   permission state machine. Approval for one call must never approve a second
   call from the same assistant message.
7. Emit tool activity, permission requested/resolved, waiting, verification,
   and final result events without raw content beyond configured preview
   limits. Ensure denial returns control to the same Pi loop.
8. Add faux filesystem and broker tests for allow, deny, cancel, expiry,
   duplicate response, stale target, changed workspace, replacement race,
   cancellation during wait, failure after approval, and no-replay restart.

## Deliverables

- Aside-owned permission broker and exact-operation pending state.
- Bounded preview/diff and write preparation contract.
- Permission-gated `workspace.write` and `workspace.edit` tools.
- Stale-target, cancellation, atomicity, and verification behavior.
- Sequential mixed-batch and replay-safety tests.

## Exit Criteria

- C5-19 writes never start before a matching permission decision.
- C5-20 previews identify the exact workspace, target, effect, and bounded
  change summary.
- C5-21 allow executes only the prepared operation once and returns its result
  to the current Pi loop.
- C5-22 through C5-25 deny, cancel, expiry, restart, and stale cases produce
  no unauthorized mutation.
- C5-26 requires a fresh decision for the next write.
- C5-32 can revise a supported document and return a truthful save result.
- C5-33 can verify the saved text/JSON content or explicitly report when the
  available adapter cannot provide stronger validation.

## Checks

Run the permission and write tests with a temporary or in-memory workspace,
then run runtime tests, typecheck, and Rust tests. Inspect the filesystem after
every negative case to prove that denial, expiry, stale identity, and cancel
performed no mutation.

## Verification

- `node --test agent-runtime/test/workspace-write-tools.test.mjs` passed: 10
  tests.
- `npm.cmd run runtime:test` passed: 53 tests.
- `npm.cmd run typecheck` passed.
- `npm.cmd run build` passed.
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check` passed.
- `cargo check --manifest-path src-tauri/Cargo.toml` passed.
- `cargo test --manifest-path src-tauri/Cargo.toml` passed: 30 tests.
- `node --check` passed for the permission, write, workspace, runtime, and
  affected test modules; `git diff --check` passed.
- Faux temporary-workspace coverage proves exact permission correlation,
  bounded previews, allow/deny/cancel/expiry behavior, duplicate and
  mismatched responses, stale existing and newly-created targets, sequential
  independent approvals, atomic rename cleanup, JSON parse validation, and
  post-write verification.
- An approved filesystem `rename` failure is reported as
  `filesystem_permission_denied`/`failed`; it is kept distinct from the
  user's `permission_denied` decision and never claims a successful write.
- The default activated registry now exposes the four P2 read tools plus
  `workspace.write` and `workspace.edit`; no shell, process, network, or host
  capability was added. `vendor/pi-full/` remains ignored and untracked.
