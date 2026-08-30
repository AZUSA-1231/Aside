# C2-P0 - Native Geometry and Tiling

Status: implementation complete; manual Windows verification pending
Depends on: Cycle 1 P2 - Pin and Workspace
Unblocks: C2-P1

## Outcome

Make the native target and Aside rectangles line up with the selected monitor's
work area. Resolve the current visible left/bottom seam issue without changing
the Cycle 1 restoration safety model.

This plan establishes geometry and placement primitives only. Side UI and
shortcut replacement belong to later plans.

## Tasks

1. Reproduce the current seam on a maximized target and record the work-area,
   `GetWindowRect`, and visible-frame measurements without reading application
   content.
2. Distinguish physical work-area rectangles, target outer rectangles, target
   visible extended-frame rectangles, and Aside host rectangles.
3. Use Windows DWM/non-client frame information and DPI-aware conversion where
   needed so a requested visible target rectangle maps to the correct native
   window rectangle.
4. Define one shared physical-coordinate Side layout function that returns the
   target rectangle and Aside host rectangle from a work area.
5. Preserve negative monitor origins, taskbar work areas, minimum/maximum rail
   bounds, and resize rounding.
6. Apply target and Aside placement in a coordinated native sequence with no
   activation or z-order changes. Use a batched native operation where the
   available window handles allow it; otherwise keep the sequence short and
   deterministic.
7. Keep the captured target identity, maximized state, and restore path
   unchanged unless a geometry fix is required to preserve them.
8. Add pure tests for rail width, exact partition, negative origins, narrow
   displays, and rounding. Add a native measurement note for the Windows
   frame/DPI case.

## Deliverables

- Physical-coordinate Side layout primitive.
- Native frame/DPI correction at the platform boundary.
- Coordinated target/Aside placement path.
- Geometry and restoration regression tests.

## Exit Criteria

- The target and Aside host rectangles partition the selected work area without
  an accidental gap or overshoot.
- The visible target edges align within an explicit Windows/DPI tolerance.
- The target is never activated or replaced by an unrelated foreground window.
- Existing workspace restoration tests and Cycle 1 behavior remain intact.
- C2-02 and the geometry portion of C2-09 are ready for manual verification.

## Verification

Use a maximized Chrome, Edge, VS Code, or equivalent window on the primary
display and record the actual work area, DPI, target, and Aside alignment. Do
not use simulated keyboard input or screen-content inspection.
