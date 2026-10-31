# Cycle 7 Execution Record

**2026-10-31 priority update:** Current work is tracked in
[`../RECOVERY-PLAN.md`](../RECOVERY-PLAN.md): frontend simplification, inherited
issue resolution, and completion of the existing Pi-backed runtime. External
agent integration is deferred as a later feature. This file records previous
UI work; its E1–E4 delivery order is no longer the active plan.

Current source and new focused checks are documented in
[`../FRONTEND-REVIEW.md`](../FRONTEND-REVIEW.md). The resident capsule and automatic
host-window arrangement described below have been removed from the active path.
Removing automatic arrangement/restoration was a mistake: shortcut-driven
capture, 80/20 tiling, and restoration on the next press remain core behavior
and must be restored under FE-07. See the confirmed
[`full-height sidebar design`](../design/SUMMONED-SIDEBAR.md). This correction
does not reinstate the capsule, hover, or morph proposals below.

**Evidence qualification:** The proximity/morph modules, stylesheet names,
and frontend test counts described below do not match the current file set.
These observations have not been reconstructed against a matching revision.
Do not treat them, or their passing gate counts, as current capsule/plate or
future simplified-surface verification. Audit and acceptance items keep their
source issue status; this note closes none of them.

Status at 2026-09-26: active development. Product and host remain Aside. The
interaction model is in [`UI-PROPOSAL.md`](./UI-PROPOSAL.md); the **visual
direction is [`../design/mockup.html`](../design/mockup.html)** (see
[`../design/README.md`](../design/README.md)), which supersedes every earlier
description of the material including the solid-white island and the
acrylic/tinted-glass direction before it. The old `PLAN.md` and `LEGACY.md` are
historical inputs, not parallel schedules.

## Surface rebuild (2026-09-26)

The surface was rebuilt on the branch `cycle-7-surface-rebuild`. What changed,
and the evidence for each:

| Change | Why | Evidence |
| --- | --- | --- |
| Display-scale conversion in the native layer | The layer had no DPI conversion at all, so the capsule was drawn larger than the region clipping it and rendered as a rectangle at 150% scaling. | 6 new `proximity` tests across scales 1.0-2.0; the host-always-contains-the-region property. |
| Trigger corridor narrowed from 74px to 4px | The corridor fired while the cursor merely travelled past the right edge, and started 28px left of the capsule. It violated MERGE-DECISION invariant 3. | `trigger_corridor_is_narrow_and_spans_only_the_capsule_height`. |
| Proximity machine replaced with the reference `Island` machine | Separates the leave-grace countdown from the phase, distinguishes initialisation from a display change, and collapses an open preview when the monitor or scaling changes. | 20 `proximity` tests, up from 3. |
| Foreground snapshot moved before activation | It previously read the foreground after clearing the non-activating style, which worked only because `SWP_NOACTIVATE` happened to suppress activation. | Code ordering; not observable in a test. |
| Edge poll no longer dispatches for a cursor that cannot change the phase | An idle cursor cost a main-thread round-trip and a lock 31 times a second. | Rate limited to every 4th tick away from the edge; full rate near it. |
| Phase transition animates by morphing the window | The native layer owns the geometry, so a CSS-only transition teleports the frame while the contents ease. | 5 `morph` tests: endpoints exact, monotonic, clamped, anchor fixed, region always inside its window. |
| Stylesheet replaced: `tokens.css` + one `app.css` | 1703 lines in five override layers, 23 unreferenced classes, 5 rule blocks duplicated verbatim. | 19.9kB raw / 4.2kB gzipped; the one-layer rule is checkable. |
| Test runner moved to Vitest + Testing Library + jsdom | The previous runner rendered to a markup string, so it could not exercise focus, keyboard, or state transitions. | 15 frontend tests; A11 verified to have teeth by reverting each fix. |

**`windowEffects: acrylic` was tried and reverted.** DWM draws its backdrop for
the whole window rectangle and does not honour the `SetWindowRgn` clip, so it
showed as a grey rectangle behind the capsule and around the panel corners.
Tauri never sets a corner preference, so nothing clipped it. The frost is a
webview material instead — see "The frost is composed inside the webview" in
[`../ARCHITECTURE.md`](../ARCHITECTURE.md). The trade is deliberate: the shape
costs the desktop blur, and the saturation boost and lit top edge that make a
surface read as glass both survive it.

### Two defects introduced and fixed during this work

Recorded because both reached a desktop session before being caught:

1. **The surface would not open on hover.** The polling optimisation skipped the
   main thread when the cursor had not moved, but the machine is *time*-based —
   the dwell and the grace are counted in milliseconds, so it must be ticked
   while the cursor stands still. A cursor parked in the corridor accumulated no
   dwell and the surface never opened.
2. **The surface thrashed.** `poll_edge` resized and re-regioned the window on
   every sample, so a cursor moving along the edge produced a resize thirty
   times a second. It now touches the window only on a real phase change.

### The intermittent runtime failure is closed

The failure recorded in E3 below — one of 365, passing on rerun, never captured
— was found and fixed. It was the page-ceiling test, with two independent
defects: its oversized fixture was `Buffer.concat([pdf, pdf])`, which does not
double a PDF's page count, so the expected refusal never happened and the
assertion fell through to a wall-clock threshold; and the shared `measure()`
helper only stopped its heartbeat on success, so a read that threw left a
`setTimeout` chain rescheduling itself forever and hung the runner. The test now
asserts where the refusal happens rather than how long it took. 365/365, and no
longer dependent on machine speed.

### Still outstanding

- **The desktop observations below are not yet re-run against the rebuilt
  surface.** E1's focus gate passed on the previous revision; the geometry,
  material, and transition have all changed since.
- The component decomposition (E2's stated work) has not been done. `App.tsx`
  is still one component, though the stylesheet it renders into has been
  replaced. This is sequencing, not omission: the visual layer was moved first
  because it was the part that could not be verified while the old stylesheet
  dominated.
- The whole-surface click-to-engage gesture is designed but not implemented.

## Development record (2026-09-25)

- E1 is implemented in the existing Tauri host: a 46 x 132 px clipped capsule inside a 340 px WebView host, 120 ms hover dwell, 320 ms leave grace, non-activating preview, explicit click engagement, shortcut pinning, and restoration when collapsed. The pure state machine has three tests. WebView2 click-to-focus, foreground ordering, and display placement have **not** been observed in a native desktop session; E1 is not accepted.
- E2 has distinct capsule/preview projections and retained conversation/source/workspace/tool/document components, with fuller permission context and Deny-first keyboard focus. Four server-rendered frontend tests cover projection and bounded permission information. The initial green surface was rejected; the current white island removes the page header and uses compact icon controls. Native visual review is still pending.
- E3 development gates: TypeScript typecheck, Vite production build, 40 Rust tests, and 365 runtime tests passed at their respective checks. The first parallel runtime invocation had one failure; a standalone rerun passed all 365. The failing case from the first run was not captured, so intermittent failure remains a risk. A01-A12 have regression coverage but remain independently unverified; no manual acceptance is inferred.
- **The intermittent runtime failure is identified and fixed (2026-09-26).** It was `G01: the page ceiling is refused before the document is parsed` in `agent-runtime/test/parse-responsiveness.test.mjs`, and it had two independent defects:
  1. The oversized fixture was built as `Buffer.concat([pdf, pdf])`. That does not double a PDF's page count — a reader finds the trailing `%%EOF` and the original cross-reference table and reports the same 300 pages. The read therefore succeeded, the expected refusal never happened, and the assertion fell through to `elapsedMs < 200`: a wall-clock threshold against a parse that takes 50–380 ms on this machine. It passed alone and failed under load.
  2. The shared `measure()` helper only stopped its heartbeat after a successful `await`. A read that *threw* — the case the test exists for — left a `setTimeout` chain rescheduling itself forever, keeping the event loop alive and hanging the runner.
  The test now builds a genuinely oversized document (`MAX_PDF_PAGES + 1`) and asserts *where* the refusal happens (code, `details.pages`, `details.max_pages`, and the absence of block data) rather than how long it took. The heartbeat stops in a `finally`. The suite is 365/365 and no longer depends on machine speed.
- The same investigation confirmed `MAX_PDF_PAGES` is 2000 and the ceiling is checked against the parsed page count before the page loop runs, so a refusal costs ~250 ms for a 2001-page document and walks no content.
- E4 receives automated content checks from the new frontend tests. C6-40 manual legibility observation remains unperformed and indefinitely deferred.
- The local UI preview is available at `http://127.0.0.1:1420/`. The initial implementation had no screenshot evidence; the follow-up used Edge DevTools screenshots at 340 and 430 CSS px plus a 340 x 160 capsule capture.
- Startup correction after a native crash report: a 14 px WebView produced a negative client width inside Tauri/Windows. The collapsed WebView now keeps a 340 px host while a native window region exposes only the 14 px edge capsule. A native smoke run without a display no longer panics, but it cannot validate monitor placement or clicking.
- The normal `src-tauri/target/debug` Cargo artifact lock denied writes in this tool session. The corrected development binary is in `.cargo-review/debug/aside.exe`; the old binary at the normal target path was not replaced.
- Follow-up visual repair: `WinIsland/index.html` now resolves its own `./src/main.tsx` entry. Aside uses a white, 28 px rounded floating panel with a central grip and compact icon controls; the collapsed surface is a 46 x 132 px white capsule with a vertical grip. Browser screenshots at 340 and 430 CSS px show no horizontal overflow, and the 340 x 160 capsule measures exactly inside the native clipping rectangle with `backdrop-filter: none`.
- Follow-up shortcut repair: collapsing now resolves the work area before hiding the Tauri window. The previous `unwrap_or(work_area_from_tauri(&window)?)` eagerly queried the display after `hide()` and could leave the app invisible on failure. After resizing and clipping, Tauri `show()` reopens the capsule in its own window state, followed by non-activating Win32 display and always-on-top placement.
- Follow-up gates: TypeScript, four focused frontend tests, Vite production build, and 40 Rust tests passed. The Vite build used `--configLoader runner --outDir .cache/dist-review --emptyOutDir false` because the normal output and temporary config files were locked. The updated native executable is `.build-review/native-verify/debug/aside.exe`; `tauri dev` also rebuilt and restarted `src-tauri/target/debug/aside.exe` after the final Rust edit. Native shortcut toggling, foreground order, and monitor-specific clipping remain unobserved from this tool session.

## Delivery order

| Unit | Origin | User-visible result | Technical gate and evidence |
| --- | --- | --- | --- |
| E1 Native edge interaction | New | A narrow right-edge capsule opens a non-activating preview on deliberate hover. Click or shortcut engages; collapse does not stop a task. | Test dwell/grace/state transitions, focus ordering, foreground snapshot, tiling/restoration. Verify Windows behavior manually only when manual acceptance resumes. |
| E2 Aside surface | New + U2 | Engaged and pinned views carry existing chat, source, workspace, attachments, tools, document outcomes, and permission decisions in a solid-white rounded island. | Typecheck, build, focused component tests for keyboard, long content, run/permission/attachment states. |
| E3 Prior-cycle regression | Inherited U1 + A01-A12 | Existing capabilities remain usable through the new surface; audit fixes are rechecked. | Run focused audit tests and full runtime/Rust/TypeScript/build gates against the integrated revision. Record failures and gaps. |
| E4 Development record | Inherited C6-40 | State and boundary labels are legible in the final redesigned surface. | C6-40 is **LEGACY Option A** (decided 2026-09-26): it runs against the feature-complete revision, together with the P7 task 9 audits. Automated UI assertions are development evidence and do not substitute for it. It has not been performed yet. |

Each unit is complete only after its deliverable, boundary cases, automated evidence, and status are recorded. A passing development gate is not product acceptance.

## Explicit dispositions

- U1 frontend test infrastructure is absorbed into E2/E3; U2 interaction quality into E1/E2.
- A01-A12 remain `fix applied, independently unverified` until focused rechecks; a recheck does not close manual acceptance.
- C6-40 surface legibility receives automated development coverage in E2/E4, and its own pass is **LEGACY Option A** — performed against the final revision, not deferred. It remains unperformed until then.
- U6 installer delivery, clean-profile installation, Cycle 5/6 manual checks, and new UI manual acceptance are **indefinitely deferred**, without cycle or date. No release claim follows.
- U7 classification binding and the old Cycle 7 settings/MCP/conversation features remain functional backlog, outside this UI-only cycle.
- Historical P2-P4 provider and document follow-ups remain in the legacy ledger. They are regression targets where automated, not implied new features.

## Native feasibility condition

The first release blocker is WebView2 activation order. Preview must not activate or capture; its explicit engage action must snapshot the foreground target before focus and only tile when appropriate. If native behavior cannot be established through automated checks alone, report it as an unverified Windows integration risk while manual acceptance remains deferred.
