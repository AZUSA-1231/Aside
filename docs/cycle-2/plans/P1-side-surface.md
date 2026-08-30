# C2-P1 - Shared Side Surface

Status: implementation complete; manual Windows verification pending
Depends on: C2-P0 - Native Geometry and Tiling
Unblocks: C2-P3

## Outcome

Give Aside one consistent full-height right rail in every visible non-Workspace
context and in Workspace Mode. Ordinary foreground windows remain unchanged;
Aside uses the same Side geometry beside them.

## Tasks

1. Keep the native/frontend surface contract limited to Side and Workspace;
   there is no legacy Floating surface.
2. Use the foreground target's display work area for an ordinary window, or the
   active cursor display work area for the desktop.
3. Reuse the C2-P0 rail layout for every Side path and Workspace Mode so all
   visible surfaces have the same width, full-height bounds, and physical origin
   handling.
4. Keep the target application at the left segment and ensure Side placement
   does not alter the target's saved restoration snapshot.
5. Keep one small visual inset token on all four edges, rely on the Windows
   native outer corner treatment, and do not add a second CSS outer radius.
6. Preserve Pin behavior, focus behavior, and hide/restore behavior.
7. Add focused UI state coverage for the new surface labels and transitions;
   do not add a general state-management abstraction.

## Deliverables

- Side mode for desktop and ordinary foreground contexts.
- Shared Side/Workspace geometry.
- Uniform visual boundary treatment.
- Updated typed state and focused UI regression coverage.

## Exit Criteria

- Desktop and ordinary-window summon show a full-height approximately 20% Side
  rail.
- Workspace summon uses the same rail dimensions and visual treatment.
- Ordinary foreground windows are not resized.
- No visible state or fallback uses the legacy Floating surface.
- Pin and hide/restore behavior remain independent and coherent.
- C2-01, C2-03, C2-04, C2-07, and C2-08 are ready for manual verification.

## Verification

Compare Side and Workspace on the same display. Record the rail width,
work-area height, native corner treatment, inset consistency, target boundary,
and behavior after hide/show. Repeat on a monitor with a non-zero or negative
origin if available.
