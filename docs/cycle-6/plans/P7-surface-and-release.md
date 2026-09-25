# P7 - Surface and Acceptance Closeout

The filename keeps `surface-and-release` because it is referenced from several
documents and an identifier that changes is harder to trace than one that is
slightly out of date. The title is what this plan now covers.

**Scope corrected 2026-09-19 by
[C6-I034](../ISSUES.md#c6-i034---p7-was-over-broad-packaging-and-surface-quality-move-to-cycle-7).**
Packaging (tasks 16, 17), the packaged-application half of task 14, and the
surface-quality audits (task 9) moved to Cycle 7. This plan closes at the
capability surface and the acceptance record.

Status: **surface implemented and audited 2026-09-19**; the manual Windows pass
is the remaining evidence.
Depends on: P1 through P6
Unblocks: Cycle 6 acceptance closeout — **not a release decision.** See "What
this plan does not claim" below.
Source requirements: PRD sections 13 through 19 and C6-40 through C6-45

## Outcome

Integrate the Cycle 6 capability states into the existing Side rail, prove that
the complete system remains bounded and honest, and close the cycle with a
traceable C6-01 through C6-45 acceptance matrix plus representative Windows
evidence.

**Closing this plan is not a release claim.** The cycle is complete when its own
criteria have evidence; that is a different statement from "ready to ship", and
the difference is not rhetorical — packaging and installed-application support
are deferred (C6-I034), so no installable artifact is produced or verified by
this cycle at all.

React remains a projection and explicit user-decision surface. It does not
become a parser, MCP client, search client, path authority, or policy engine.
P0-P6 deliver their own minimum usable IPC/UI flow at each checkpoint. P7
consolidates those surfaces and evidence rather than postponing all wiring.

## Surface Requirements

The task surface must distinguish, compactly and without raw protocol detail:

- context available but workspace unresolved;
- workspace and target automatically resolved or explicitly overridden;
- foundation read/search/write activity and continuation;
- PDF page range, partial extraction, and source-quality warning;
- Word read, transform target, fidelity warning, permission, and verification;
- MCP server/tool identity, trust boundary, permission, timeout, disconnect,
  and unavailable state;
- denied, cancelled, partial, unsupported, stale, failed, verified, and
  completed outcomes.

Web Search was removed from Cycle 6
([C6-I026](../ISSUES.md#c6-i026---web-search-leaves-cycle-6-entirely)), so the
surface has no search activity, query boundary, or source-bearing result state
to present this cycle. The MCP entries carry the external-boundary presentation
that search would otherwise have exercised.

The ordinary successful path should remain quiet. Permission and fidelity
warnings must be prominent when a decision depends on them. Raw schemas,
credentials, captured contents, stack traces, and MCP frames never appear.

## Tasks

1. Inventory new/changed runtime requests, events, task snapshots, tool display
   descriptors, permission previews, document warnings, MCP connection
   diagnostics, and terminal outcomes from P0-P6.

   **Done 2026-09-19.** It found `runtime_warning`, `workspace_overridden`, and
   `run_waiting` emitted but unprojected, and `runtime_warning` missing from the
   event union entirely.
2. Update shared TypeScript contracts and React state projection. Preserve
   request/task/tool/permission correlation and ignore stale events from prior
   runs or replaced connections.
3. Integrate automatic workspace/target display. Keep manual set/clear as a
   recovery action while avoiding redundant prompts on the successful capture
   path.
4. Present tool source and true boundary where relevant: built-in Aside
   capability versus user-connected MCP program; local workspace write versus
   external server call. Do not label an MCP file-looking call as
   workspace-contained.
5. Add bounded document status for page/section scope, partial extraction,
   fidelity warnings, destination path, overwrite state, and reopen
   verification. Ensure PDF read-only limitations are represented truthfully.
6. Keep the surface free of any search affordance. With Web Search removed
   ([C6-I026](../ISSUES.md#c6-i026---web-search-leaves-cycle-6-entirely)) there
   is no provider attribution to honor and no source list to render. Do not add
   a browser, arbitrary link fetch, or page content preview.
7. Add the minimum deliberate MCP configuration/troubleshooting surface needed
   by P6: server identity, enable/disable/remove, connection status, adapted
   tool count/diagnostics, and trust/classification decisions. Credentials are
   entered/stored through the approved secret path and never redisplayed raw.
8. Ensure permission controls work for workspace writes and MCP risk/egress
   calls with exact correlation, bounded arguments, Allow/Deny/Cancel, expiry,
   revalidation, and one terminal outcome.
9. ~~Audit accessibility, keyboard/focus behavior, resizing, text containment,
   long paths/server names, streaming coexistence, cancellation, and restored
   history.~~ **Deferred to Cycle 7 by
   [C6-I034](../ISSUES.md#c6-i034---p7-was-over-broad-packaging-and-surface-quality-move-to-cycle-7).**
   Not performed, and not claimed. This was eight independent manual audits
   bundled into one line, and none of them is a product requirement of this
   cycle: they are frontend interaction quality, which has its own cycle. The
   Cycle 6 criteria in this area are C6-40, which asks whether the surface says
   the right thing and is **not** deferred.
10. Inspect provider requests, runtime events, React state, logs, and stored
    sessions to prove credentials, full documents, raw search/MCP responses,
    active permissions, and stale context are absent where prohibited.
11. Build a C6-01 through C6-45 matrix linking each criterion to deterministic
    tests, serialized evidence, and any required manual Windows check. Resolve
    or record every exception before the cycle's acceptance is recorded.

    **Assembled 2026-09-19** as [`ACCEPTANCE-MATRIX.md`](../ACCEPTANCE-MATRIX.md).
    Every criterion has a named evidence source or a recorded reason it has
    none; C6-40 and C6-45 are recorded as manual-only. The matrix is complete
    as a matrix — the manual column has not been performed and no row is closed.
    Building it surfaced a factual error in its own first draft (a stale test
    count and an over-broad "unedited" claim), which the matrix now corrects and
    explains rather than drops.
12. Run the complete engineering gate and focused suites repeatedly for
    cancellation, permission races, stale target, parser limits, MCP crashes,
    and restored sessions.
13. Perform representative Windows workflows:
    - summon on a text file, auto-bind, search/read/edit, approve, verify;
    - read selected pages of a PDF and observe a text-poor warning;
    - read and transform a `.docx` to a new file, inspect warnings, open output;
    - enable one user MCP server, call an adapted tool through its required
      policy, cancel or deny another, then disable/remove the server.

    The search workflow this list used to contain is gone with the capability.
    No Windows step exercises a first-party search, and P7 must not record one.
14. Audit the final provider-visible registry for all explicit non-goals.
    Shell/process/code, PDF mutation, arbitrary fetch, and deferred Tier 2 tools
    must be absent. **Done 2026-09-19** as `p7-audit.test.mjs`, against the
    serialized run registry and the provider context.

    ~~…and the packaged application.~~ **Deferred to Cycle 7 by
    [C6-I034](../ISSUES.md#c6-i034---p7-was-over-broad-packaging-and-surface-quality-move-to-cycle-7).**
    There is no packaged application to audit this cycle.
15. Update PRD/PLAN/child-plan/ISSUES status only after evidence supports the
    exact release claim. Any partial feature is removed from the registry or
    clearly deferred; it is not declared complete because its demo path works.
16. ~~Implement P0's packaging decision…~~ **Deferred to Cycle 7 by
    [C6-I034](../ISSUES.md#c6-i034---p7-was-over-broad-packaging-and-surface-quality-move-to-cycle-7).**

    Partially implemented before the deferral, and that work is kept rather than
    discarded: `runtime.rs` no longer resolves the runtime through a compile-time
    source path, `scripts/stage-runtime.mjs` stages the payload, and
    [`PACKAGING-CONTRACT.md`](../PACKAGING-CONTRACT.md) records the decision.
    Kept because it fixes a real defect; **not treated as verified**, because no
    installed build exists to verify it against.

17. ~~Build/install on a clean Windows profile or VM…~~ **Deferred to Cycle 7
    by [C6-I034](../ISSUES.md#c6-i034---p7-was-over-broad-packaging-and-surface-quality-move-to-cycle-7).**
    It needs a VM and a network, and it is the verification half of task 16.
18. Maintain [`MANUAL-ACCEPTANCE.md`](../MANUAL-ACCEPTANCE.md) as the runner for
    every item the automated gate cannot establish, and record its results in
    the matrix. It is the working copy; the matrix is the record. Neither
    replaces the other, and this plan owns keeping them consistent: an item
    appearing in one and not the other is a defect in this plan, not in the
    checklist.

## Cycle Closeout Readiness (2026-09-19)

Recorded so that the automated audit reads the actual state rather than the
task list's intent. **Development is not finished.** Four tasks are open, and
two of them are substantial.

| Task | State | What is actually true |
| --- | --- | --- |
| 1 | Done | Inventory taken; it found `runtime_warning`, `workspace_overridden`, and `run_waiting` emitted but unprojected. |
| 2 | Done | Contracts extended, projection wired, `mcp_servers` event added. |
| 3 | Done | Override is surfaced; auto-bind display was already present. |
| 4 | Done | Tool provenance from descriptors; external boundary badge on the permission card. |
| 5 | Done | Document read/write status, partial and truncation stated, fidelity codes shown. |
| 6 | Done | Nothing to remove; the surface has no search affordance. |
| 7 | **Partial, and the shortfall must be decided** | Read-only status is delivered (configured servers, and which ones contributed nothing). **Enable, disable, and remove are file edits, not a surface.** Cycle 6 has no settings UI (C6-I024). This needs an explicit recorded decision before release, not silence. |
| 8 | Done | Permission controls existed; the boundary badge was added. |
| 9 | **Deferred** | To Cycle 7 by C6-I034. Not performed and not claimed. |
| 10 | Done | `p7-audit.test.mjs` (7 tests) against captured artifacts. |
| 11 | Done | [`ACCEPTANCE-MATRIX.md`](../ACCEPTANCE-MATRIX.md) assembled; the Cycle 5 regression claim was audited and corrected. |
| 12 | **Done** | Repeated-gate evidence recorded above: 10 full runs (3280 executions), 5 Rust runs, 15 repetitions of the process-spawning MCP suites, all green. The six stress categories were mapped to the tests that cover them; no gap was found and no test was added. |
| 13 | Not performed | Windows workflows. The developer's own acceptance. |
| 14 | **Registry half done; packaged half deferred** | `p7-audit.test.mjs` audits the serialized run registry and the provider context. The packaged-application half moved to Cycle 7 (C6-I034). |
| 15 | In progress | Documentation is being kept current as work lands. |
| 16 | **Deferred, partially implemented** | To Cycle 7 by C6-I034. The work done before the deferral is kept: `runtime.rs` no longer uses a compile-time source path (7 unit tests), `scripts/stage-runtime.mjs` stages the payload, and [`PACKAGING-CONTRACT.md`](../PACKAGING-CONTRACT.md) records the decision. **Not verified** — no installed build exists. |
| 17 | **Deferred** | To Cycle 7 by C6-I034. Needs a VM and a network. |
| 18 | Done | [`MANUAL-ACCEPTANCE.md`](../MANUAL-ACCEPTANCE.md). |

### What this means for the audit node

The node moved, and it moved in the direction that makes it reachable. It was
previously blocked on task 16, which needed a network and a VM — neither of which
this environment has. With packaging deferred, what remains is work that can
actually finish:

```text
cycle work complete  =  task 12 (repeated gate) closed
        |
        +--> automated audit   (fresh process, the whole repository)
        |
        +--> developer manual acceptance (MANUAL-ACCEPTANCE.md, 61 items)
        |
        +--> Cycle 6 acceptance recorded
```

**This is not a release.** The last step records that the cycle's criteria have
evidence. Packaging, installed-application support, and frontend interaction
quality are Cycle 7's, and the audit should be told to expect their absence
rather than to look for them.

Task 7's shortfall is closed by decision rather than by delivery: C6-I033 records
that Cycle 6 ships file-based MCP configuration only. That is a decision, so the
matrix does not carry a task marked done that is not.

## Deliverables

- Complete Cycle 6 React/runtime projection and permission controls.
- Minimal user MCP configuration and diagnostics surface.
- Persistence/privacy and registry-absence audit.
- C6-01 through C6-45 acceptance matrix.
- Full automated gate and manual Windows workflow evidence.
- The consolidated manual acceptance list (`MANUAL-ACCEPTANCE.md`, task 18).
- Final release decision and explicit limitations.

## Exit Criteria

- C6-40 makes workspace, source/boundary, permission, warning, verification,
  and terminal state understandable without exposing protocol internals.
- C6-41 proves restored sessions carry no stale authority, active connection,
  pending permission, credential, or full extracted document.
- C6-42 proves the final model registry contains no shell, process, code,
  PDF-edit, arbitrary-fetch, or deferred Tier 2 tool.
- C6-43 links deterministic fixtures/fakes to success, limits, cancellation,
  policy denial, malformed input, and adapter/server isolation.
- C6-44 confirms Cycle 2-Cycle 5 summon, window, capture, streaming,
  permission, cancellation, session, and process-boundary regressions pass.
- C6-45 records successful representative Windows workflows for foundation,
  PDF, Word, and MCP.
- Every P0-P6 exit criterion is closed or an unmet capability is removed from
  shipped scope without weakening security/privacy claims.
- C6-24 records replacement refusal as the declared scope boundary, not a passed
  replacement implementation.
- ~~Installed-app evidence proves no dependency on compile-time source paths or
  development dependencies.~~ **Removed 2026-09-19 by
  [C6-I034](../ISSUES.md#c6-i034---p7-was-over-broad-packaging-and-surface-quality-move-to-cycle-7).**
  No installed build is produced this cycle, so this could not be met and was
  never a PRD requirement: [§19](../PRD.md#19-release-boundary) is six items and
  none mentions an installed application.

## What this plan does not claim

Stated here so the plan cannot be read as endorsing more than it did:

- **Not a release.** Closing this plan says the cycle's criteria have evidence.
  It says nothing about an installable artifact, and there is none.
- **Not installed-application support.** Deferred by C6-I034.
- **Not frontend interaction quality.** Accessibility, keyboard, resizing, and
  related auditing are deferred by C6-I034.
- **Not field validation of the MCP adapter.** Fixtures derived from an observed
  server plus one smoke target, on a development build.
- **Not Cycle 5's release.** Its manual criteria are carried in
  [`MANUAL-ACCEPTANCE.md`](../MANUAL-ACCEPTANCE.md) Part A and have not been
  performed.

## Checks

Run the root quality gate:

```text
npm.cmd run typecheck
npm.cmd run build
npm.cmd run runtime:test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

Also run every focused script introduced by P0-P6, inspect a production build,
and execute the manual Windows matrix. Automated fakes prove deterministic
behavior; manual network/server checks supplement but never replace them.

## Task 12: Repeated Gate Evidence (2026-09-19)

Task 12 asks for the gate to be run *repeatedly* and for six stress categories
to be covered. Both were done, and the numbers are recorded because a single
green run says nothing about flake — the MCP suites spawn real child processes
and are the ones that could pass once and fail the next time.

| What was repeated | Times | Result |
| --- | --- | --- |
| Full `runtime:test` suite (328 tests) | 10 | 3280 test executions, **0 failures** |
| `cargo test` (37 tests) | 5 | 185 test executions, **0 failures** |
| The three process-spawning MCP suites | 15 | **0 failures** |

The six categories, each mapped to the tests that actually cover it rather than
asserted:

| Category | Covered by |
| --- | --- |
| Cancellation | `capability-runtime`: *C6-05: cancelling a pending permission yields one terminal result*; `capability-permission`: *settles expiry and cancellation exactly once*, *a cancelled run leaves no grant behind*; `pdf-adapter`/`docx-adapter`: *cancellation stops the read before and after parsing*; `mcp-adapter`: *a cancelled call produces exactly one terminal result* |
| Permission races | `workspace-write-tools`: *permission expiry and target creation races fail closed*, *permission broker binds one exact operation and rejects duplicate or mismatched responses*; `capability-permission`: *records a single-use grant only for an approved operation*, *binds a grant to the run that earned it* |
| Stale target | `workspace-handoff`: *C6-08: rejects stale, missing, and mismatched captures without guessing*; `workspace-write-tools`: *deny, expiry, cancellation, invalid edits, and stale targets never mutate the workspace*; `docx-tools`: *C6-24: an output that appears after approval is refused, not overwritten* |
| Parser limits | `pdf-adapter`: *C6-19: excessive page counts and page ranges are bounded*, *C6-19: a block ceiling bounds extraction and warns*; `docx-adapter`: *hardening: a decompression bomb is refused before it is inflated*, *hardening: compression ratio, entry count, and traversal are bounded*; `mcp-schema` (22 bounds tests); `mcp-result` (15 bounding tests) |
| MCP crashes | `mcp-client`: *a server that crashes mid-call fails that call and the connection*, *close is idempotent and safe after a crash*; `mcp-adapter`: *a server that will not start leaves other servers and built-ins alone* |
| Restored sessions | `session`: *persists only bounded messages and restores no workspace, permission, or skill state*, *creates a fresh session when the active JSONL session is corrupt*, *restores the active Aside session* |

**No gap was found, and no test was added.** The categories were already covered
by the Cycle 6 suites; what task 12 supplied was the repetition and the mapping.
Stating that plainly matters: a claim that six categories are covered is worth
little without naming what covers them, and the alternative — writing new tests
to make the list look complete — would have added coverage that already existed.

## Verification

Record after implementation:

- root and focused test results with counts;
- acceptance matrix with links to tests/evidence;
- screenshots or bounded event traces for representative states;
- redacted Windows workflow notes;
- final registry and persistence/privacy audit;
- release decision, shipped limitations, and deferred follow-up.
