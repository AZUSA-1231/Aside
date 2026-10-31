# Aside design references

**Status:** `SUMMONED-SIDEBAR.md` is the current design, implemented in the R1
working copy with development checks. Native desktop observation remains
unperformed. `mockup.html` and the material notes below are historical.

## Current sidebar direction

[`SUMMONED-SIDEBAR.md`](./SUMMONED-SIDEBAR.md) records the agreed next design:
a full-height sidebar with one continuous Acrylic base and opaque white
components. The shortcut must capture the original window and automatically
arrange it beside Aside at 80/20; pressing it again must restore that window.
The R1 working copy now implements this restoration and the material change.
See [`FRONTEND-REVIEW.md`](../FRONTEND-REVIEW.md) for automated evidence and
remaining native observation limits.

**2026-10-31 disposition:** The material and edge-shell specification below is
historical and no longer authoritative for the next UI. Follow
[`RECOVERY-PLAN.md`](../RECOVERY-PLAN.md) for frontend simplification and legacy
issue tracking. The mockup is retained as a reference, not a task to finish.

## `mockup.html`

The historical visual direction for Cycle 7's surface. Open it in a browser; it is
self-contained and needs no build.

It is a copy of `WinIsland/vision/mockup.html`, taken on 2026-09-26. WinIsland is
a separate git repository used as a design and interaction reference, and it is
not tracked in this one — this copy exists so the direction survives
independently of that tree.

The file is a specification, not a component library. It defines:

- **One material at three strengths.** A single blur (`34px`) with three white
  opacities, chosen by surface size — large surfaces need less white to stay
  legible over a busy wallpaper, small floating things need more to hold their
  own. The blur is a DWM acrylic effect requested through
  `windowEffects` in `src-tauri/tauri.conf.json`; CSS `backdrop-filter` cannot
  blur the desktop from inside a Tauri window and must not be used to fake it.
- **The lit top edge** (`inset 0 1px 0 rgb(255 255 255 / 0.75)`). Its absence is
  the most common reason a glass surface reads as a flat grey box.
- **Colour as state, never decoration.** Blue is focus, green is running, amber
  is waiting on the user, red is failure.
- **The capsule as a floating object** — a vertical lozenge, clear of the screen
  edge, with the same container growing into the panel rather than a tab that
  turns into a sidebar.

Its "one thing to confirm" note at the end is resolved: Preview overlays without
reflowing the desktop, and only Engaged pushes the foreground window aside. That
refines the per-foreground-app tiling table in `WinIsland/docs/MERGE-DECISION.md`
§5, which did not distinguish the two states.

## Reference images (not committed)

Three third-party reference images informed the direction. They are not
committed here because they carry a stock-image watermark and are not ours to
redistribute. They were used for these specific decisions:

| Reference | What it settled |
| --- | --- |
| A settings/dashboard UI with near-black pill buttons and white cards on large soft shadows | The **primary control is near-black, not blue**, and controls read as floating objects on soft elevation rather than bordered rectangles. |
| A task app with a light and a dark variant of the same screen | Dark mode is a **separate palette, not a tint** of light. Same material, different light. |
| A five-step button state ladder (default / hover / focus / pressed / loading) | Focus is a **blue ring** distinct from the primary fill; loading is green. This is why `--focus-ring` and `--primary` are separate tokens. |

## Related

- [`../cycle-7/UI-PROPOSAL.md`](../cycle-7/UI-PROPOSAL.md) — the interaction and
  information architecture this visual direction serves.
- [`../../WinIsland/docs/MERGE-DECISION.md`](../../WinIsland/docs/MERGE-DECISION.md)
  — the four-state interaction model and its invariants. Not tracked in this
  repository; available in the WinIsland tree.
