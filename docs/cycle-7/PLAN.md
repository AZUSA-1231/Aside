# Cycle 7 Development Plan (Historical Snapshot)

> **Status: SUPERSEDED / PAUSED FOR REPLAN (2026-09-25).** This file records
> the pre-merge planning state. It is not an active implementation schedule.
> Use [`../PROJECT-BASELINE.md`](../PROJECT-BASELINE.md) as the current entry
> point. The next requirement list will produce one replacement active plan.

Status: planning. **Feature list not yet supplied** — see
[Open input](#open-input-the-feature-list).
Companion: [LEGACY.md](./LEGACY.md), which holds the work inherited from Cycle 6
Predecessor: [Cycle 6](../cycle-6/PLAN.md), whose acceptance is **blocked** by
[C6-I035](../cycle-6/ISSUES.md#c6-i035---passing-gates-do-not-establish-cycle-acceptance)

This is Cycle 7's new development: frontend interaction work and new component
development. It is deliberately **not** the home of Cycle 6's leftovers — those
are in [LEGACY.md](./LEGACY.md), and the reason for the split is recorded there.

## What this plan learned from Cycle 6

Cycle 6 was split by technical layer — a contract plan, a workspace plan, a PDF
plan, a Word plan, an MCP plan — and each grew into something approaching a
cycle. The audit's diagnosis:

> 工作量失衡的根源是按技术层 P0–P7 切分，而不是按用户结果拆分 … P7 又承接跨层遗漏、
> 基础设施和未做验收，导致"写完代码"与"完成要求"分离。

*(The imbalance comes from splitting by technical layer rather than by user
outcome. P7 then absorbed cross-layer gaps, infrastructure, and unperformed
acceptance, which separated "the code is written" from "the requirement is
met".)*

Two consequences are carried into this plan.

**One: split by what a person can watch work, not by layer.** Each unit promises
one demonstrable result. "Demonstrable" means a person at the machine can watch
it happen, not that a test exists.

**Two: the leftovers get their own document.** Cycle 6's P7 failed by becoming
"everything not yet done". A cycle that absorbs its predecessor's remainder
stops having a subject. [LEGACY.md](./LEGACY.md) exists so this plan can have
one.

## Per-unit requirements

Every unit states all five before it starts, not at the end:

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

## Open input: the feature list

The units in this plan come from a feature list supplied by the product owner.
**That list has not been supplied yet, and this plan does not invent one.**

What is recorded below is what the list has to satisfy to become a unit table,
and the two items that are already known to belong here. Filling the table is
the first task of this cycle, and it is blocked on the list, not on analysis.

### What a unit table entry must carry

| Column | Meaning | Why it is required |
| --- | --- | --- |
| Unit | A short name | — |
| Demonstrable result | One thing a person can watch happen | The Cycle 6 correction: layer-shaped units hide their own completion criteria |
| Surface area | Which files under `src/` it touches | Determines what U1's harness must reach before it starts |
| Edges | Named before the unit starts | See the per-unit rule above |
| Source | The product requirement, not a predecessor's deferral | An entry whose Source is a Cycle 6 issue belongs in [LEGACY.md](./LEGACY.md) |

### The two entries that are already known

**U3: MCP configuration surface.** Add, enable, disable, and remove a server
through the UI, with credentials never displayed.

- *Why it is here and not in the ledger.* Cycle 6 decided not to build it
  ([C6-I033](../cycle-6/ISSUES.md#c6-i033---mcp-configuration-is-file-based-and-the-surface-is-read-only)).
  A decision not to build something is not the same as owing it, so the work of
  building it is new development with a Cycle 6 paper trail — which is exactly
  the distinction the two documents are drawn along.
- *Demonstration.* Add a server, see its tools appear, disable it, see them go.
- *Edges.* Invalid command, missing credential reference, duplicate id, more
  servers than the cap, and a server that starts but lists nothing.
- *Evidence.* Tests over the configuration model, plus one manual server run.
- *Documentation.* The contract already exists in
  [PACKAGING-CONTRACT.md](../cycle-6/PACKAGING-CONTRACT.md) and the Cycle 6 P6
  plan; this unit drives it.
- *Dependency.* [LEGACY.md](./LEGACY.md) U7 (classification binding) needs the
  settings storage this unit establishes. Whichever is built first determines
  the storage model for the other, and they must not be designed separately.

**U4/U5: Settings reload and conversation management.** Provider/model changes
without restart; conversations that can be started, listed, and switched.

- *Why it is here and not in the ledger.* Same reason as U3 — Cycle 6 recorded
  the gap ([C6-I024](../cycle-6/ISSUES.md#c6-i024---no-conversation-management-and-no-configuration-reload))
  rather than owing it.
- *Demonstration.* Change the model in settings, send a message, and get a reply
  from the new model. Start a second conversation and return to the first.
- *Edges.* A change while a run is in flight; an invalid model id; a corrupt
  session file; switching conversations mid-run.
- *Evidence.* Tests over the configuration and session layers, plus recorded
  observations.
- *Documentation.* `README.md` (configuration), and the session behaviour in
  `docs/ARCHITECTURE.md`.
- *Starting point, verified.* The session layer already has a complete
  repository abstraction — `createInMemoryAsideSessionRepository` and
  `JsonlSessionRepo` satisfy the same interface, including `list` and `delete` —
  and `openAsideSession` already lists sessions and selects the most recent. The
  multi-session backend largely exists; what is missing is protocol verbs and
  UI entry points. On the configuration side, `loadAsideConfig` runs once when
  the runtime is constructed, so reload needs a rebuildable entry point on the
  assembly path in `runtime.mjs`.

### Open questions

1. **Do U3, U4, and U5 share one settings surface?** Doing them together is
   cheaper and more coherent; doing them separately is easier to finish. The
   audit's warning about wide units applies to combining them carelessly. This
   also decides U7's storage model, so it should be settled early.
2. **Does U1's harness reach the components the new work touches, or only
   helpers?** The answer determines whether the new surface's evidence is
   automated or unperformed, and should be settled before the first component
   unit starts rather than after. See [LEGACY.md](./LEGACY.md) U1.

## Sequencing

Two constraints are fixed, and both come from the split itself.

**U1 first.** The harness is established at the start of new development so that
components are verifiable from their first commit. This is
[LEGACY.md](./LEGACY.md) U1 — owned there, scheduled here — because a unit owned
in one document and scheduled in another is the kind that goes missing.

**The feature list before everything else.** No unit is designed against a list
that does not exist yet.

Beyond those, the ordering is a product decision and is left open until the list
arrives. The one thing this plan will not do is fill the gap with inherited
work; that is what [LEGACY.md](./LEGACY.md) is for.

## Verification, and what it cannot claim

Cycle 7's verification is **tiered**, decided deliberately:

| Tier | Applies to | Runs |
| --- | --- | --- |
| Automated gate | Everything | `typecheck`, `build`, `runtime:test`, `cargo test`, plus the new frontend runner from U1 |
| Surface acceptance | The surface, once new development is feature-complete | C6-40's legibility items and the P7 task 9 audits, run against the final revision |
| Installed build | [LEGACY.md](./LEGACY.md) U6 only | The clean-profile run, if an environment exists for it |
| Manual acceptance | Cycle 6's 61-item checklist and Cycle 5's 26 carried criteria | **Not run. Indefinitely deferred.** |

The last row is a decision, recorded in full in [LEGACY.md](./LEGACY.md). The
reason it is stated here as well is that this plan's own acceptance must not be
read as implying it: **the automated gate establishes that the code works, not
that the product was used.** Cycle 6's audit exists precisely because those were
treated as the same claim.

Surface acceptance is sequenced last because auditing a surface that is about to
change produces evidence that expires. That is the same reasoning that moved
[LEGACY.md](./LEGACY.md) U2, and it is stated in both places because it is the
one sequencing rule that binds the two documents together.
