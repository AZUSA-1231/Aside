# Aside Project Baseline

**Baseline date:** 2026-09-25  
**Purpose:** the single orientation document for the repository while Cycle 7 is
being re-planned.

This file resolves document status and sequencing. The Cycle 7 interaction
specification is in [`cycle-7/UI-PROPOSAL.md`](./cycle-7/UI-PROPOSAL.md), and
the active integrated development plan is [`cycle-7/EXECUTION.md`](./cycle-7/EXECUTION.md).

**Current scope instruction:** Cycle 7 is a UI/UX and product-style redesign;
existing agent capabilities do not grow by default. Any functionality change
needs an explicit item in the incoming requirements.

**2026-09-25 scope update:** Keep the product name Aside and bring WinIsland's
edge interaction logic and visual direction into the existing Aside app. Treat
`WinIsland/` as a reference, not a second product or a required host replacement.
The proposed execution is in [`cycle-7/UI-PROPOSAL.md`](./cycle-7/UI-PROPOSAL.md).

**Explicit indefinite deferral:** Installer delivery, clean-profile installation
verification, and all manual acceptance (inherited Cycle 5/6 and new UI) have
no target cycle or date. Retain the checklists as unperformed evidence gaps.
Automated development gates remain required; no release or acceptance claim
follows from their passing.

**Repository persistence:** `/docs` is ignored by `.gitignore`, and
`WinIsland/` is currently untracked. This baseline and the merge-decision
source are present in this workspace, but neither is available from a clean
clone until the repository's documentation/source tracking policy changes.

## 1. Current truth

### Product and code

| Area | Current truth | Status |
| --- | --- | --- |
| Aside runtime | The root project contains the Node agent runtime, capability policy, context capture, document adapters, MCP adapter, and the existing React/Tauri surface. | Implemented in code; evidence is incomplete in several areas. |
| WinIsland | A separate Tauri/React interaction-shell prototype exists under `WinIsland/`. It has a tested proximity state machine and native cursor polling, but its panel/window integration is still a scaffold. | Prototype, not merged into the root app. |
| WinIsland direction | `WinIsland/docs/MERGE-DECISION.md` records a full host replacement proposal and a four-state interaction model. The new requirement is to apply its interaction logic and visual language to Aside. | Reuse the interaction ideas in the existing Aside host; full host replacement is not required by this cycle. |
| Proposed interaction | `Collapsed`, `Preview`, `Engaged`, and `Pinned`; hover is non-activating, click/hotkey explicitly engage. | Detailed adaptation is proposed in `cycle-7/UI-PROPOSAL.md`; not yet implemented. |
| Context-capture ownership | Current capture is native Rust in the root app (`context.rs`, UIA modules, `file_hosts.rs`); Node receives the resulting turn context. | Preserve this boundary while adding the new interaction. |

The WinIsland prototype is not the Aside UI. Keep the two code trees separate
until the chosen interaction has been implemented and verified in Aside.

### Cycle state

| Cycle | State | What remains true |
| --- | --- | --- |
| Cycle 5 | Runtime work was implemented, but its manual Windows evidence and release decision were carried into Cycle 6. | Do not call Cycle 5 released. |
| Cycle 6 | The implementation and post-audit fixes exist, but the independent audit left twelve findings recorded as `fix applied, unverified`; manual acceptance was never performed. | Acceptance is blocked. The cycle is not a release. |
| Cycle 7 | Redesign Aside around WinIsland's four-state edge interaction and visual language while keeping capabilities stable. | Active development under `cycle-7/EXECUTION.md`; manual acceptance remains indefinitely deferred. |

The Cycle 7 visual direction is **frosted, tinted glass over a DWM acrylic
backdrop, with near-black primary controls**, specified in
[`design/mockup.html`](./design/mockup.html) and described in
[`design/README.md`](./design/README.md). `cycle-7/UI-PROPOSAL.md` §视觉语言
predates that decision and its acrylic/tinted-glass wording is superseded; the
mockup is authoritative where the two disagree. The interaction model in the
same proposal is not affected and remains current.

## 2. Document authority

When documents disagree, use this order:

1. The latest user scope decision (2026-09-25): WinIsland interaction and
   visuals go into Aside; installer and manual acceptance are indefinitely
   deferred.
2. `WinIsland/docs/MERGE-DECISION.md` (2026-09-24) for proposed interaction and
   architecture, subject to the clarification above.
3. The code and tests at the current checkout, described without upgrading
   them into product evidence.
4. Cycle 6 audit and issue records, which define known defects, deferred
   obligations, and evidence limits.
5. The cycle plans and checklists, which are historical execution records until
   their status is explicitly rebaselined.

An implementation test is regression evidence. It is not product acceptance
unless the final integrated revision is the stated acceptance target and the
acceptance record says so.

## 3. Work ledger for the new UI

These entries are inventory only. They are not an approved Cycle 7 schedule.

### A. Cycle 6 evidence and inherited obligations

| Item | Source | Current disposition |
| --- | --- | --- |
| Audit findings A01-A12 | `docs/cycle-6/ISSUES.md`, `AUDIT-REPORT.md` | Fixes are recorded as applied but unverified. Re-run focused regressions and the root gate against the final integrated revision before any acceptance claim. |
| C6-40 surface legibility | `docs/cycle-6/ACCEPTANCE-MATRIX.md` | **Resolved to LEGACY Option A (2026-09-26): it runs.** It is a product criterion, and C6-I034 deliberately did not defer it. It is performed once new development is feature-complete, against that revision, together with the P7 task 9 audits — see [`cycle-7/LEGACY.md`](./cycle-7/LEGACY.md#the-one-criterion-this-leaves-with-no-evidence-path). It is not performed yet. The rest of the manual checklist stays indefinitely deferred, so Cycle 6 is still not retroactively accepted. |
| Manual Cycle 5/Cycle 6 checklist | `docs/cycle-6/MANUAL-ACCEPTANCE.md` | Retained historical record; unperformed and indefinitely deferred with no target cycle or date. New UI manual acceptance has the same status. |
| Packaging and installed application | `docs/cycle-6/PACKAGING-CONTRACT.md`, C6-I034 | Contract retained; installer delivery and clean-profile verification are indefinitely deferred. No installed artifact has been verified. |
| Frontend test infrastructure and interaction quality | C6-I031/C6-I034, `docs/cycle-7/LEGACY.md` U1/U2 | Add automated component/interaction evidence during development; human acceptance is indefinitely deferred. |
| Classification binding | C6-I030, `docs/cycle-7/LEGACY.md` U7 | Depends on a settings/storage decision. Re-plan with the settings requirements instead of implementing the old unit in isolation. |
| P2-P4 plan-local follow-ups | `docs/cycle-6/plans/P2*.md`, `P3*.md`, `P4*.md` | Encoding/search review, some provider-facing document flows, and manual Word/PDF evidence remain recorded as outstanding. Check them against retained acceptance requirements; do not silently call them complete or automatically expand Cycle 7. |

### B. WinIsland interaction in Aside

The current requirement is to adapt WinIsland interaction to the existing Aside
product, not to ship the WinIsland prototype. The implementation gates are:

1. Prove that a `focus: false` WebView2 window can receive keyboard focus after
   an explicit click.
2. Keep Aside's tiling/restoration and add a non-activating hover preview.
3. Adapt the WinIsland proximity states to the four product states.
4. Build the chatbox against the existing `RuntimeEvent` contract.
5. Preserve active runs when the UI collapses; do not make hover start a run or
   capture the foreground window.

Use Aside's native context modules. On click/hotkey, snapshot the foreground
target before activating the panel, then deliver the same bounded context
contract to the runtime.

The detailed UI treatment is in [`cycle-7/UI-PROPOSAL.md`](./cycle-7/UI-PROPOSAL.md);
the active delivery order and inherited work dispositions are in
[`cycle-7/EXECUTION.md`](./cycle-7/EXECUTION.md).

### C. Explicitly not scheduled

The following must not be pulled into the next plan merely because they appear
in an old document: Web Search, shell/process execution, arbitrary browsing,
unsupported document mutation, bundled MCP servers, system-toggle controls from
the original WinIsland concept, or any new capability not present in the
incoming requirement list.

In particular, the old Cycle 7 PLAN's U3/U4/U5 (MCP configuration controls,
provider settings reload, conversation management), C6-I022 (provider/model
configuration), and LEGACY's U7 (schema-bound classification storage) change
functionality. They are backlog candidates, not automatic work in a UI-only
redesign. U6 packaging is indefinitely deferred by the current decision.

## 4. Cycle execution rule

Cycle 7 will use one integrated development target:

```text
review UI proposal and scope
  -> technical spikes and vertical implementation slices
  -> continuous regression checks during development
  -> integrate the chosen UI with the existing runtime and native host
  -> automated gate and documented development status
  -> manual acceptance and installer remain indefinitely deferred
```

The following rules are binding for the replan:

- Do not perform or claim a full acceptance of the old Aside surface before
  rebuilding the new surface.
- Run focused tests, type checks, builds, and contract checks while developing;
  label them as regression/development evidence, not as cycle acceptance.
- A unit cannot enter implementation without a deliverable, demonstration,
  edges, evidence, and documentation update.
- Automated development evidence targets the integrated revision and covers
  runtime contracts, window states, and retained capability guarantees.
- Keep the old manual checklist and the new UI manual acceptance marked
  unperformed and indefinitely deferred. Do not invent a substitute pass or
  claim that automated checks close them.
- A requirement that is removed or deferred must have one named disposition;
  it must not remain simultaneously in an active plan and a legacy ledger.
- Any later acceptance record must point to its exact build/commit and must not
  reuse observations captured from a superseded UI revision.

## 5. Document map

| Location | Role now |
| --- | --- |
| `docs/PROJECT-BASELINE.md` | Current status, authority, work ledger, and sequencing rule. |
| `docs/cycle-6/PRD.md` | Cycle 6 product requirements and acceptance boundary. Historical source for retained capability contracts. |
| `docs/cycle-6/PLAN.md` and `plans/P*.md` | Cycle 6 execution records; use for implementation detail and evidence provenance. |
| `docs/cycle-6/ISSUES.md` | Decision and defect ledger; authoritative for C6 audit findings and deferrals. |
| `docs/cycle-6/ACCEPTANCE-MATRIX.md` and `MANUAL-ACCEPTANCE.md` | Historical acceptance record/checklist. They do not close Cycle 6. |
| `docs/cycle-6/AUDIT-*.md/json` | Independent audit report, reproductions, and captured evidence. |
| `docs/cycle-7/PLAN.md` | Superseded planning snapshot; no longer an active schedule. |
| `docs/cycle-7/LEGACY.md` | Inherited-work ledger and evidence of the old split; no new unit should be scheduled from it without replan. |
| `docs/cycle-7/UI-PROPOSAL.md` | Current reviewable interaction and visual proposal, including the explicit indefinite deferrals. |
| `docs/cycle-7/EXECUTION.md` | Active integrated development plan and disposition of inherited work. |
| `WinIsland/docs/MERGE-DECISION.md` | Prior full merge proposal and interaction source; this cycle adapts the interaction inside Aside. |
| `WinIsland/README.md` and `WinIsland/vision/` | Prototype status and visual references, not acceptance evidence. |

## 6. Execution

`docs/cycle-7/EXECUTION.md` is now the active plan. `PLAN.md` and `LEGACY.md`
remain reference material and must not be used as parallel schedules.
