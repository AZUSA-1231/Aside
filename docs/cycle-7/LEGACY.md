# Cycle 7 Legacy Ledger (Historical Snapshot)

> **Status: REFERENCE / PAUSED FOR REPLAN (2026-09-25).** This ledger records
> the pre-merge Cycle 6 carryover split. It remains useful for provenance, but
> it is not an active schedule and must not be used to start units directly.
> Use [`../PROJECT-BASELINE.md`](../PROJECT-BASELINE.md) for current status and
> [`UI-PROPOSAL.md`](./UI-PROPOSAL.md) for the current UI proposal. Installer
> delivery and manual acceptance are indefinitely deferred with no target
> cycle or date. The inherited checklist is still unperformed.

Status: open — the inherited work, tracked separately from new development
Companion: [Cycle 7 PLAN](./PLAN.md), which holds this cycle's **new**
development
Predecessor: [Cycle 6](../cycle-6/PLAN.md), whose acceptance is **blocked** by
[C6-I035](../cycle-6/ISSUES.md#c6-i035---passing-gates-do-not-establish-cycle-acceptance)

This document is one half of what used to be a single plan. Cycle 7 turned out
to contain two different kinds of work, and they are now tracked apart:

| | Document | What it holds |
| --- | --- | --- |
| **Inherited** | this file | Work Cycle 6 deferred by a named decision. Nothing here is new scope. |
| **New** | [PLAN.md](./PLAN.md) | Frontend interaction work and new component development, from a feature list that is not derived from Cycle 6. |

The split exists because the two have different failure modes. Inherited work
fails by being *silently dropped* — a deferral that nobody picks up reads as
"done" three documents later. New work fails by being *absorbed* — a cycle that
becomes a list of leftovers stops being a product cycle. Keeping them in one
document guaranteed both.

**This is not a Cycle 6 cleanup pass.** Cycle 6's acceptance stays blocked, and
nothing here closes it. What is here is work that a Cycle 6 decision explicitly
assigned to a later cycle, carried forward with its source attached.

## The rule this document enforces

Every item below was deferred by a named Cycle 6 decision. **If something
appears here without such a decision, that is a defect in this document.**
Conversely, an item in [PLAN.md](./PLAN.md) that traces back to a Cycle 6
deferral is misfiled, and belongs here.

## Manual acceptance: indefinitely deferred

Cycle 6's manual pass — 24 `automated + manual` criteria, 2 `manual only`
criteria (C6-40, C6-45), and 26 carried Cycle 5 criteria, 61 items in total in
[MANUAL-ACCEPTANCE.md](../cycle-6/MANUAL-ACCEPTANCE.md) — is **not performed**,
and Cycle 7 does not perform it either.

**Status: indefinitely deferred.** Not "pending", not "scheduled", not "blocked
on a VM". It has no target cycle and no completion date. This is a decision, not
an oversight, and it is recorded as one so that no later reader mistakes an
unperformed checklist for a passing one.

Two consequences, stated plainly because the alternative is a document that
reads as more verified than it is:

- **No criterion is closed by manual evidence, and none will be this cycle.**
  [ACCEPTANCE-MATRIX.md](../cycle-6/ACCEPTANCE-MATRIX.md)'s manual column stays
  empty. Cycle 6 stays blocked ([G02](../cycle-6/ISSUES.md#c6-i035---passing-gates-do-not-establish-cycle-acceptance)).
- **Every claim in this repository about the app's behaviour rests on automated
  evidence and code reading.** Where a criterion has a part that only a real
  desktop can establish — a real Explorer capture, a real PDF, a real document
  opened in Word, a real server process — that part is unproven, and the
  matrix's own "what this matrix does not claim" section already says so.

The deferred checklist is retained rather than deleted. It is the record of
what was never run, and deleting it would make the gap invisible.

### The one criterion this leaves with no evidence path

**C6-40 is now unverified by any route, and that is a consequence of this
decision rather than a plan for it.** It should be resolved deliberately, and
this note exists so it is not resolved by accident.

The collision is between two decisions, both made on 2026-09-23:

- C6-40 is **manual-only** in
  [ACCEPTANCE-MATRIX.md](../cycle-6/ACCEPTANCE-MATRIX.md) — "**None.** No
  frontend test infrastructure exists". It has no automated half to fall back
  on.
- [PLAN.md](./PLAN.md)'s verification is **tiered**, and its surface tier was
  written to cover "C6-40's legibility items … run against the final revision".

If the manual pass is indefinitely deferred, the second of those is the only
route C6-40 had left, and it is a manual pass by another name. Read one way,
C6-40 moves to the end of new development. Read the other way, it is deferred
with everything else. **The two documents should not be left to disagree about
which.**

Why it is worth this much text: C6-I034 drew its own line here on purpose.

> **C6-40 stays.** It is a PRD acceptance criterion, and §19 item 5 requires
> C6-01 through C6-45 to be satisfied. Deferring it would weaken a product
> requirement, which is a different act from correcting an implementation-scope
> addition.

So C6-I034 deferred frontend interaction quality *and deliberately did not
defer this*, distinguishing "does the surface say the right thing" (a product
criterion) from "does the surface behave well to use" (quality with its own
cycle). The deferral recorded above is broader than that distinction, and the
difference is the thing to decide:

- **Option A — C6-40 runs.** It is the surface tier in
  [PLAN.md](./PLAN.md), performed once new development is feature-complete.
  [LEGACY.md](./LEGACY.md) U2's audits ride along with it, since they need the
  same session at the same revision.
- **Option B — C6-40 is deferred too.** Then it is recorded as an unverified
  product criterion, stated as such in the matrix and the README, with the
  reason named. That is a weaker claim than Option A and an honest one.

Either is defensible. Silence is not, because the failure this whole split
exists to prevent is a gap that nobody wrote down.

### Resolved: Option A (2026-09-26)

**C6-40 runs.** It is the surface tier in the Cycle 7 plan, performed once new
development is feature-complete, at that revision, and U2's audits ride along
with it because they need the same session at the same revision.

The reasoning is C6-I034's own: C6-40 asks whether the surface *says the right
thing*, which is a product requirement, and the deferral that covers
interaction *quality* was written to exclude it deliberately. Deferring it
alongside the quality audits would have collapsed a distinction that was made
on purpose.

Two things this does not change, stated so the resolution is not read as
broader than it is:

- **The rest of the manual pass stays indefinitely deferred.** The 24
  `automated + manual` criteria, C6-45, and the 26 carried Cycle 5 criteria
  remain unperformed with no target cycle or date. Cycle 6 stays blocked.
- **C6-40 is not performed yet.** Selecting a route is not running it. Until
  the surface is feature-complete and the pass is recorded with its build
  identity, C6-40 has no evidence, and the acceptance matrix must keep saying
  so.

## Inherited units

| # | Unit | Demonstrable result | Source |
| --- | --- | --- | --- |
| U1 | Frontend test infrastructure | A change to a surface component can be verified without launching the app | [C6-I031](../cycle-6/ISSUES.md#c6-i031---the-react-surface-has-no-automated-verification) |
| U2 | Surface interaction quality | Keyboard-only use, focus order, resizing, and long names all behave, and the evidence is recorded | P7 task 9, deferred by [C6-I034](../cycle-6/ISSUES.md#c6-i034---p7-was-over-broad-packaging-and-surface-quality-move-to-cycle-7) |
| U6 | Installed application | The app installs and runs on a machine without the source checkout | [C6-I034](../cycle-6/ISSUES.md#c6-i034---p7-was-over-broad-packaging-and-surface-quality-move-to-cycle-7), [C6-I010](../cycle-6/ISSUES.md#c6-i010---installed-runtime-is-a-release-requirement) |
| U7 | Classification binding | A lowered tool classification is invalidated when the tool's schema changes | [C6-I030](../cycle-6/ISSUES.md#c6-i030---tool-classification-is-name-keyed-without-a-settings-store) |

Every unit states all five of these before it starts, not at the end:

1. **Deliverable** — what exists when it is done.
2. **Demonstration** — what a person does to watch it work.
3. **Edges** — the failure, empty, oversized, and concurrent cases it must
   handle. Cycle 6's P4 named its edges after the fact, which is why A02, A03,
   A07, and A08 were found by an external audit rather than by its author.
4. **Evidence** — the tests and the recorded observations.
5. **Documentation** — which documents change, updated in the same unit.

**A unit is not started until its edges are written down.** This is the specific
lesson of Cycle 6: the defects that survived were not in the features, they were
in the boundaries nobody had enumerated.

### Two units moved out

U3 (MCP configuration surface), U4 (settings reload), and U5 (conversation
management) were in the first draft of this plan. They are no longer here,
because they are not leftovers — they are new surface components, and they
belong with the other new surface work in [PLAN.md](./PLAN.md). Their Cycle 6
sources ([C6-I033](../cycle-6/ISSUES.md#c6-i033---mcp-configuration-is-file-based-and-the-surface-is-read-only),
[C6-I024](../cycle-6/ISSUES.md#c6-i024---no-conversation-management-and-no-configuration-reload))
still apply and are carried into that document.

The distinction: U1, U2, U6, and U7 are things Cycle 6 *owed and did not do*.
U3, U4, and U5 are things Cycle 6 *decided not to build*, whose building is new
development that happens to have a Cycle 6 paper trail.

## U1: Frontend test infrastructure

**Deliverable.** A test runner wired into the repository, a test script for
`src/`, and at least one surface component under test.

**Why it is not optional.** C6-40 asks whether the surface says the right thing.
Cycle 6 shipped that criterion with no automated evidence and no manual
evidence, and could only record it as manual-only. Every unit in
[PLAN.md](./PLAN.md) changes the surface.

**Sequencing.** This is the one ordering decision that carries over unchanged,
and it is now *stronger* than when it was written. The original argument was
"build the verification before the things needing verification". With the
surface work re-targeted onto new components, the argument improves: the harness
should be established **at the start of new development**, so the components
being built are verifiable from their first commit rather than retrofitted.

So U1 is inherited — it traces to C6-I031 and it is unpaid Cycle 6 debt — but it
is *sequenced* as the first step of [PLAN.md](./PLAN.md). Both documents say so,
deliberately, because a unit that is owned in one document and scheduled in
another is exactly the kind that goes missing.

**Demonstration.** Break a surface projection deliberately and watch a test
fail, then fix it.

**Edges.** Component tests must not require a Tauri process. `src/lib/ipc.ts`
already carries a real seam — `isDesktopRuntime()` returns false outside the
desktop shell, and the preview path emits synthetic runtime events — so much of
the surface is reachable without a fake. Decide and record how far that reaches
before writing many tests: **a harness that only covers pure helpers is worth
having, but must not be described as surface coverage.** That distinction is the
whole point of this unit, and blurring it would reproduce the defect it exists
to fix.

**Evidence.** The runner's own output in the root gate, and a documented
statement of what it does and does not cover.

**Documentation.** `README.md` (the gate), and a note in
`docs/ARCHITECTURE.md` on the testing boundary.

**Starting point, verified.** No test runner in `devDependencies`, no test
script for `src/`, no test files under `src/`. Ten presentational functions live
unexported in `src/App.tsx` (`hostKindLabel`, `captureStatusLabel`,
`pathRoleLabel`, `toolStatusLabel`, `shortToolName`, `provenanceFrom`, and
others); extracting them to `src/lib/` is mechanical. The registry is reachable
from this environment.

## U2: Surface interaction quality

**Deliverable.** Accessibility, keyboard, focus, resizing, and long-name
behavior that holds up, with recorded evidence.

**Re-targeted.** P7 task 9's eight audits — accessibility, keyboard/focus,
resizing, text containment, long paths and server names, streaming coexistence,
cancellation, and restored history — were written against Cycle 6's surface.
[PLAN.md](./PLAN.md) changes that surface. Auditing a surface that is about to
be rebuilt would produce evidence that expires before the cycle closes.

**So this unit's target is the surface as it stands when the new development is
feature-complete**, not the surface as it stands today. The audits are kept
intact; only the revision they run against moves.

**Demonstration.** Use the app without a mouse; resize to the narrowest
supported width with the longest path and longest server name loaded.

**Edges.** Empty states, a workspace path longer than the panel, a server name
longer than the chip, and a permission card appearing while streaming.

**Evidence.** The P7 task 9 checklist, now recordable against U1's harness where
it reaches and — per the deferral above — **recorded as unperformed where it
does not.**

**Documentation.** `MANUAL-ACCEPTANCE.md` in Cycle 6 remains the record of what
was deferred here.

## U6: Installed application

**Deliverable.** An installer that runs on a machine without the source
checkout, with no development dependencies and no source paths.

**Demonstration.** Install on a clean profile, have a conversation, edit a file,
restart.

**Edges.** Missing provider configuration; a missing or old bundled Node; an
incomplete resource tree.

**Evidence.** The clean-profile run, recorded with build identity. **If no clean
profile is available, this unit cannot be demonstrated and must be sequenced
last with that stated, rather than half-built.**

**Documentation.** [PACKAGING-CONTRACT.md](../cycle-6/PACKAGING-CONTRACT.md) is
the decision; this unit implements what it leaves open. Note the audit's
correction to that document: its dependency roots were incomplete, the staged
size was wrong, and its "only network is missing" claim was not supported.

**Starting point, verified.** `runtime.rs` no longer resolves through a
compile-time source path (7 unit tests), and `scripts/stage-runtime.mjs` stages
the payload with a self-check. `src-tauri/resources/` is staged at ~102 MB with
`node_version: null`. What is missing, precisely:

- the Node download (`--no-node` was used for the current staging);
- `bundle.resources` in `src-tauri/tauri.conf.json` — the `bundle` block
  currently declares icons only, and the two entries in PACKAGING-CONTRACT.md
  are documented rather than committed;
- the platform-suffixed `externalBin` copy (`src-tauri/binaries/` does not
  exist);
- the install itself.

## U7: Classification binding

**Deliverable.** A classification is bound to the schema it was approved
against, and invalidated when that schema changes.

**Demonstration.** Approve a lowered classification, change the tool's schema,
and watch the approval stop applying.

**Edges.** A server that changes a schema without changing the name; a tool
removed and re-added.

**Evidence.** Tests over the classification path.

**Documentation.** [C6-I030](../cycle-6/ISSUES.md#c6-i030---tool-classification-is-name-keyed-without-a-settings-store)
records the current partial state.

**Starting point, verified.** More of this exists than the Cycle 6 entry
implies. `classifyMcpTool` and `schemaDigest` are implemented: an override that
declares `schema_digest` is refused when the observed digest differs and falls
back to the conservative default; an override *without* a digest is applied and
a `mcp_classification_unbound` diagnostic is recorded. What is missing is the
part that needs storage — persisting approved digests, and surfacing
re-approval when one changes. That storage is the settings surface in
[PLAN.md](./PLAN.md), which makes this unit dependent on it rather than
independent, as the first draft assumed.

## Ordering

U1 first, into the start of new development — see its Sequencing note.

U7 follows the settings surface it depends on.

U6 last, because it is the only unit that needs an environment this repository
cannot assume (a clean profile or VM), and it should not block the others.

U2 last of all, because its target is the surface after new development lands.

## What this document does not include

- **Cycle 6's acceptance.** It is blocked by C6-I035 and its manual pass is
  indefinitely deferred above. This document does not absorb it, and U6 in
  particular must not be read as completing Cycle 6's installed-application
  evidence.
- **Web Search.** Removed from Cycle 6
  ([C6-I026](../cycle-6/ISSUES.md#c6-i026---web-search-leaves-cycle-6-entirely))
  and not reintroduced here.
- **New development.** See [PLAN.md](./PLAN.md).
- **Anything not traceable to a Cycle 6 deferral.** See the Source column.
