# Cycle 2 Side Surface Product Requirements

Status: implementation in progress; manual Windows acceptance pending
Platform: Windows desktop
Predecessor: [Cycle 1 MVP](../cycle-1-MVP/PRD.md)

This document defines the small Cycle 2 product change for Aside's desktop
surface. It does not redefine the Cycle 1 MVP, add agent capabilities, or
specify implementation order. Delivery order and technical tasks belong in
[PLANS.md](./PLANS.md).

## Document Set

| Document | Responsibility |
| --- | --- |
| This PRD | Cycle 2 product behavior, scope, and acceptance criteria |
| [Implementation plans](./PLANS.md) | Work packages, dependencies, and exit checks |
| Cycle 2 verification record | Actual implementation and Windows validation evidence; create when execution starts |

## 1. Objective

Make Aside feel like a consistent right-hand surface instead of a differently
sized popup in different contexts. On the desktop, beside an ordinary
application, and beside a maximized application, Aside should use the same
full-height rail geometry, approximately 20% of the active work area, with a
tight and visually even boundary.

Cycle 2 also replaces the current shortcut because `Ctrl + Space` conflicts
with input-method switching on the target user's machine.

## 2. User Problem

The current Workspace layout is calculated from the work area, but the visible
target window can leave a small strip at the left or bottom edge. The result
does not feel like Windows' built-in split layout. Some non-Workspace paths can
also leave Aside at the old short popup size, so Aside changes size and visual
weight depending on context.

The user needs one predictable Side surface:

```text
Desktop foreground
  -> Aside occupies the right full-height rail

Maximized foreground application
  -> application occupies the left segment
  -> Aside occupies the same right full-height rail

Ordinary foreground application
  -> Aside occupies the same right full-height rail
  -> the ordinary application remains unchanged
```

## 3. Scope

### Included

- A canonical Side rail width of approximately 20% of the active monitor work
  area, using the existing usable-width limits on unusually narrow or wide
  displays.
- A full work-area-height Side rail when Aside is summoned from the desktop.
- The same Side rail width and height policy in Workspace Mode beside a
  maximized or work-area-sized application.
- The same Side rail width and height policy beside an ordinary foreground
  application, without resizing that application.
- Native Windows coordinate handling that makes the target and Aside host
  rectangles meet at one shared boundary without accidental left, top, bottom,
  or right leaks.
- A uniform visual inset and Windows-native outer corner treatment for the
  Aside surface. Any intentional visual gap must use one shared value on all
  four edges.
- A Windows-native, Snap-equivalent placement approach using window geometry;
  the target application remains a normal independent window.
- Replacement of the default summon shortcut with `Ctrl + Alt + A`, subject to
  the manual conflict check in the acceptance scenarios.
- Preservation of Cycle 1 restoration, Pin, visibility, and focus behavior.

### Explicitly not included

- Registering Aside as a member of the Windows Snap group or taking ownership
  of Snap Assist. Windows does not expose a stable public API for that product
  behavior.
- Simulating `Win + Left` or `Win + Right`, sending keyboard input to the
  system, or taking control of the user's shell.
- A new shortcut settings screen or arbitrary user-defined shortcut storage.
- Changes to the Pi runtime, provider configuration, domain tools, or the
  deferred real-provider acceptance from Cycle 1.
- Tray behavior, launch-at-startup, Shell integration, screen capture, OCR, or
  accessibility inspection.

## 4. Functional Requirements

### FR-2.1 Canonical Side geometry

Aside must calculate one Side rail policy from the selected monitor work area:

- rail width is approximately `round(workArea.width * 0.20)`;
- existing minimum and maximum usable panel widths remain safety bounds;
- rail height equals the complete work-area height;
- rail position is the work area's right edge, preserving the work area's real
  `x` and `y` origin, including negative monitor coordinates;
- Side and Workspace use the same width, height, native corner treatment, and
  visual-inset policy.

The native layout is defined in physical screen coordinates. CSS visual
styling must not change the native partition or introduce a second, conflicting
geometry calculation.

### FR-2.2 Windows-native split equivalent

When a maximized or work-area-sized target is eligible for Workspace Mode:

- the target's native visible bounds and Aside's native host bounds must be
  aligned to the same work area;
- the target occupies the left segment and Aside occupies the right Side rail;
- the shared boundary is exact within the chosen Windows/DPI measurement
  tolerance;
- the operation must not leave an accidental strip at the work area's left,
  top, bottom, or right edge;
- Aside must remain a separate window and must not alter the target's content.

The implementation may use `SetWindowPos`, DWM extended-frame measurements,
and a native multi-window placement sequence. It must account for non-client
frames and DPI scaling instead of assuming a client rectangle is the full
visible window.

### FR-2.3 Visual boundary

The Side surface must use the Windows-native outer corner treatment and retain
its shadow, but its visual edge must be predictable:

- one visual inset token applies to all four outer edges;
- the frontend does not apply a second outer `border-radius`;
- the internal target/Aside boundary has no accidental native gap;
- the native corner treatment and shadow must not be mistaken for a window
  placement error;
- the visual treatment is the same in Side and Workspace.

The exact inset value is a visual implementation parameter, not a separate
per-edge exception. It should remain small enough that the Side feels attached
to the work area.

### FR-2.4 Non-workspace Side

When the foreground context is the desktop or an ordinary non-maximized
application, summoning Aside must show Side on that context's display. It must
use the canonical Side width and the complete work-area height. An ordinary
foreground application must remain unchanged.

The foreground target's monitor, or the cursor display for the desktop, plus
the taskbar work area determine placement. Aside must not cover the taskbar
work area or jump to the primary monitor when the active display is elsewhere.

### FR-2.5 Shortcut

The Cycle 2 default shortcut is `Ctrl + Alt + A`.

`Ctrl + A` is explicitly rejected because it has an obvious and universal
select-all meaning in text fields, editors, browsers, and many desktop
applications. The implementation must not register `Ctrl + A` globally.

The new shortcut must retain Cycle 1 behavior: show, hide, toggle, focus the
existing panel, and remain available after the panel is hidden. Registration
failure must remain visible and recoverable.

### FR-2.6 Regression behavior

- Every visible context uses either Side or Workspace; the old Floating surface
  is not a valid state or fallback.
- Ordinary foreground windows remain unchanged while Aside uses the full-height
  Side rail on the same display.
- Workspace exit and shortcut hide restore only the captured target when it is
  still safe to restore.
- Pin remains independent of Side and Workspace.
- Repeated summon/hide operations do not create a second window or stale
  geometry state.
- Cycle 1's conversation implementation is unchanged by this cycle.

## 5. Non-Functional Requirements

- Side geometry must be deterministic for the same work area and DPI.
- Placement should feel as immediate as the Cycle 1 summon path.
- Native placement must not activate or resize an unrelated window.
- No keyboard input injection, screen reading, or other expanded Windows
  capability is introduced.
- The new layout must remain usable at the existing minimum panel width.

## 6. Acceptance Criteria

| ID | Scenario | Expected result |
| --- | --- | --- |
| C2-01 | Summon from the desktop | Aside appears on the active display as a full-height right rail with the canonical approximately 20% width. |
| C2-02 | Summon beside a maximized application | The target and Aside occupy one work area with an exact native boundary and no accidental left/top/bottom/right leak. |
| C2-03 | Compare Side and Workspace | Both use the same rail width, full-height policy, native corner treatment, shadow, and edge inset. |
| C2-04 | Summon beside an ordinary window | The ordinary window is unchanged and Aside uses the same full-height Side rail. |
| C2-05 | Press `Ctrl + Alt + A` repeatedly | The existing panel toggles and focuses correctly without duplicate windows or stale state. |
| C2-06 | Try `Ctrl + A` in a text editor | Text selection behavior remains intact; Aside does not claim the shortcut. |
| C2-07 | Toggle Pin in Side and Workspace | Always-on-top and visible state feedback remain correct. |
| C2-08 | Exit Workspace | The captured target returns to its original bounds and maximized state when safe. |
| C2-09 | Use a secondary monitor or mixed-DPI setup | The rail and target align to the selected monitor's physical work area and origin. |
| C2-10 | Restart after hiding Aside | The new shortcut and one-window lifecycle work without duplicate registration. |

## 7. Open Decisions

| Decision | Temporary Cycle 2 choice |
| --- | --- |
| Actual Windows Snap-group integration | Do not pursue; use native window geometry with explicit limitations. |
| Shortcut | Use `Ctrl + Alt + A`; verify against the user's IME and common applications. |
| Visual inset | Start with one small shared token and tune it during manual visual verification. |
| Ordinary-window layout | Use the canonical full-height Side rail; leave the ordinary target window unchanged. |
| Outer corners | Use the Windows-native window corner treatment; do not add a second CSS outer radius. |

## 8. Release Boundary

Cycle 2 is complete when the Side surface and shortcut acceptance criteria pass,
Cycle 1 regressions remain intact, and any DPI or Windows-frame limitation is
recorded explicitly. Real-provider conversation quality remains outside this
cycle's release decision.
