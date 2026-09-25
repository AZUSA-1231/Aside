# P1 - Floating Agent

Status: complete
Depends on: [P0 - Foundation and Native Boundary](./P0-foundation.md)
Unblocks: P2 and P3

## Outcome

Deliver the basic summonable Agent Panel independently of Workspace Mode and
conversation runtime. A user can show, hide, focus, move, and resize one panel
from the desktop.

Workspace inspection, target resizing, restoration, Pin, and provider-backed
conversation are outside this plan.

## Tasks

1. Configure the main Tauri window as frameless and suitable for a custom
   rounded frontend surface.
2. Define stable default, minimum, and maximum dimensions.
3. Implement right-edge placement from the selected display work area and safe
   margin, preserving the work area's actual coordinate origin.
4. Implement product commands for show, hide, toggle, focus, move, and resize.
   Repeated calls should not create duplicate windows or leave contradictory
   state.
5. Register `Ctrl + Space` once during application startup and unregister it
   during shutdown through the official Tauri plugin.
6. Keep the native shortcut callback short and dispatch window work through the
   application layer.
7. Handle repeated shortcut presses while the panel is visible, hidden, or
   transitioning.
8. Build the first panel UI with a header, conversation placeholder, input, and
   compact status feedback.
9. Focus the input after the panel becomes visible, including after a shortcut
   toggle.
10. Show actionable feedback for shortcut conflicts and native window-operation
    failures.
11. Verify that hiding the panel leaves the process and shortcut available.

## Deliverables

- Working frameless Floating Agent.
- Global shortcut show/hide flow.
- Right-side positioning on the active display.
- Input focus behavior.
- Move and resize behavior with stable dimensions.
- Basic visible error and loading states.

## Exit Criteria

- AC-01: desktop summon works.
- AC-02: a normal foreground window remains unchanged and Aside opens in
  Floating Mode.
- AC-04: hiding the panel works without ending the application lifecycle.
- AC-08: moving and resizing the panel work without layout jumps.
- AC-11: restart does not create duplicate shortcut registration or windows.

## Verification

On a real Windows desktop, record:

- summon from the desktop and from an ordinary application;
- repeated show/hide presses and input focus after each show;
- movement and resizing at minimum and maximum dimensions;
- restart after hiding the panel;
- shortcut conflict and native-operation failure behavior where testable.

Add the result to [VERIFICATION.md](../VERIFICATION.md).
