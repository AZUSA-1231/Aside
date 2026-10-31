# Cycle 6 Audit Brief

For a fresh process auditing Cycle 6. It assumes no context from the sessions
that produced the work, and it is written to be read **before** the other
documents rather than instead of them.

**Current navigation (2026-10-31):** this is the original Cycle 6 audit brief,
not the project's active execution plan. Read [`../README.md`](../README.md)
for document roles and [`../RECOVERY-PLAN.md`](../RECOVERY-PLAN.md) for current
defect follow-up. The former blanket claim that `/docs` is git-ignored is
outdated: core documents are tracked, while newer working-tree drafts may still
be uncommitted. Audit the actual working tree and identify its revision/diff.

---

## 1. What you are auditing

Cycle 6 added a capability runtime to Aside, a Windows desktop sidecar: a
capability registry with a policy plane, PDF and Word document handling, and an
adapter for user-connected MCP servers. Web Search was in the original plan and
was removed mid-cycle.

**Your job is to check whether the cycle's claims match the evidence, not to
admire the work.** The documents you are about to read were written by the same
process that wrote the code, so they are testimony, not proof. Where a document
asserts something, the question is whether the repository supports it.

## 2. What Cycle 6 explicitly does not claim

Stated first, so you do not spend effort hunting for things that were never
promised, and so that a missing thing is not mistaken for a broken one:

- **No installable artifact.** Packaging and installed-application support are
  deferred to Cycle 7 ([C6-I034](./ISSUES.md#c6-i034---p7-was-over-broad-packaging-and-surface-quality-move-to-cycle-7)).
  There is no installer, no bundle configuration, no downloaded Node.
- **No frontend interaction quality.** Accessibility, keyboard, resizing, and
  text containment were assigned to P7 task 9 and deferred by the same entry.
- **No field validation of the MCP adapter.** It is verified against a faux
  server, fixtures derived from one observed third-party server, and one manual
  smoke target on a development build.
- **No first-party Web Search.** Removed, not deferred-within-cycle
  ([C6-I026](./ISSUES.md#c6-i026---web-search-leaves-cycle-6-entirely)).
- **No release.** Closing this cycle means its criteria have evidence. It does
  not mean anything is ready to ship, and there is nothing to ship.
- **No Cycle 5 release.** Its 26 manual criteria have never been performed.

## 3. Reading order

| # | Document | What it is |
| --- | --- | --- |
| 1 | This file | Orientation and where to be suspicious. |
| 2 | [`ACCEPTANCE-MATRIX.md`](./ACCEPTANCE-MATRIX.md) | Every C6-01…C6-45 criterion with named evidence or a recorded reason it has none, plus an audited account of the Cycle 5 regression claim. **Start here for substance.** |
| 3 | [`PLAN.md`](./PLAN.md) | Order, contracts, the gate, and the Cycle Acceptance Boundary listing every deferral with the entry that made it. |
| 4 | [`ISSUES.md`](./ISSUES.md) | 34 decisions and discoveries, C6-I001 through C6-I034. Long; read C6-I027 through C6-I034 at minimum, and anything the matrix cites. |
| 5 | [`PRD.md`](./PRD.md) | The product requirements. §19 is the release boundary — six items, and note that it never mentions an installed application. |
| 6 | [`MANUAL-ACCEPTANCE.md`](./MANUAL-ACCEPTANCE.md) | The runner for manual evidence. **Not started** — every item is unperformed. |

Plan files live in [`plans/`](./plans/). Each owns its own tasks and evidence.

## 4. Running the gate

```text
npm.cmd run typecheck
npm.cmd run build
npm.cmd run runtime:test          # 328 tests across 27 files
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test  --manifest-path src-tauri/Cargo.toml    # 37 tests
git diff --check
```

Recorded state at handover: all green, plus 10 consecutive full runtime runs
(3280 executions), 5 Rust runs, and 15 repetitions of the process-spawning MCP
suites with zero failures. **Verify these rather than accepting them** — a claim
about repetition is exactly the kind that is easy to assert and rare to check.

## 5. Where this cycle is least confident

Named deliberately. An audit that only confirms known claims is not worth
running, and these are the places most likely to fail scrutiny. If you find
something here, it is not a surprise; if you find something *not* here, that is
the valuable outcome.

1. **The React surface has no automated verification at all.** No test runner,
   no test script for `src/`, no test files. The surface is verified by `tsc`
   and `vite build`, which prove it compiles. **C6-40 asks whether the surface
   says the right thing, and it has no automated evidence and no manual evidence
   yet.** See [C6-I031](./ISSUES.md#c6-i031---the-react-surface-has-no-automated-verification).
2. **Everything was established on a development build.** No criterion has been
   checked against an installed application, because none exists.
3. **The MCP adapter has never met a third-party server at runtime.** Its
   adversarial fixtures come from reading one. Whether reading produced the right
   fixtures is itself unverified.
4. **The document-status projection is new and untested.**
   `src/lib/document-status.ts` narrows tool results defensively, but nothing
   exercises it — the same missing frontend runner as (1).
5. **Classification is name-keyed by default.** A classification binds to a
   tool's schema only when the user supplies a `schema_digest`
   ([C6-I030](./ISSUES.md#c6-i030---tool-classification-is-name-keyed-without-a-settings-store)).
6. **The MCP configuration surface is read-only.** Enable, disable, and remove
   are file edits ([C6-I033](./ISSUES.md#c6-i033---mcp-configuration-is-file-based-and-the-surface-is-read-only)).
7. **Cycle 5's manual column has never been performed.** 26 criteria, carried
   into this cycle's checklist, all unrun.
8. **Two cross-plan tasks were closed by decision rather than delivery** —
   P7 tasks 7 and 15. Check that the decisions are recorded rather than assumed
   ([C6-I033](./ISSUES.md#c6-i033---mcp-configuration-is-file-based-and-the-surface-is-read-only)).

## 6. Rules for this audit

- **The documents are testimony.** Where one asserts a property, check whether a
  test, a captured artifact, or a commit supports it. Several corrections are
  already recorded in `ISSUES.md` because this was not done carefully enough the
  first time — see C6-I034, the correction to C6-I026's consequence 6, and the
  correction to the matrix's own "80 tests unedited" claim.
- **Distinguish "deferred" from "failed".** Every deferral names the entry that
  made it. A deferral without a named entry is a defect.
- **Distinguish "verified by execution" from "read and believed".** C6-I029
  lists what was established by probing the SDK. Anything not on that list is
  read-and-believed.
- **Do not fix silently.** If you find a discrepancy, record it in
  [`ISSUES.md`](./ISSUES.md) before changing anything. A silent correction
  destroys the trace the next audit depends on.
- **Do not score the cycle by the volume of its documentation.** There is a lot
  of it, and volume is not evidence.

## 7. What a useful outcome looks like

Either:

- a list of claims that the repository does not support, each with the artifact
  or its absence that shows it; or
- a short statement that the claims survived, naming which ones you checked and
  which you could not.

Both are useful. What is not useful is a restatement of the documents.
