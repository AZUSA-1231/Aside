# C2-P2 - Shortcut Replacement

Status: implementation complete; manual Windows verification pending
Depends on: Cycle 1 P1 - Floating Agent
Unblocks: C2-P3

## Outcome

Replace the input-method-conflicting `Ctrl + Space` registration with the
conflict-safer Cycle 2 default `Ctrl + Alt + A` while preserving the existing
native startup registration and toggle path.

`Ctrl + A` is not a candidate: it is the standard select-all command and must
remain available to the focused application.

## Tasks

1. Change the single native shortcut constant and its user-facing label to
   `Ctrl + Alt + A`.
2. Keep registration in the Tauri startup lifecycle so a hidden panel remains
   summonable and the frontend does not create duplicate registrations.
3. Preserve the existing short callback and application-layer toggle path.
4. Ensure registration errors remain recoverable and visible without making
   the panel unusable when opened by another path.
5. Verify that `Ctrl + A` is not registered and still selects text in a normal
   editor or browser text field.
6. Test the new shortcut with the user's input method, browser, VS Code, and a
   normal text editor.

## Deliverables

- New default shortcut registration.
- Updated shortcut label and documentation.
- Conflict and lifecycle verification notes.

## Exit Criteria

- `Ctrl + Alt + A` shows, hides, focuses, and toggles the existing panel.
- `Ctrl + A` remains native to the focused application.
- Hiding and restarting do not create duplicate registrations.
- C2-05, C2-06, and C2-10 are ready for manual verification.

## Verification

Test both shortcuts with the target input method enabled and disabled. Record
whether text selection, input-method switching, and Aside summon behavior are
unchanged in each context.
