# P2 - Pin and Workspace

Status: complete with accepted edge-case limitations
Depends on: [P1 - Floating Agent](./P1-floating-agent.md)
Unblocks: P4

## Outcome

Make Aside cooperate with a maximized application through a display-aware 80/20
arrangement, while protecting the user's original window state from unsafe
restoration.

## Tasks

### P2-A. Foreground-window adapter

1. Implement a Windows-only adapter for the foreground window and its monitor.
2. Return sanitized application data: opaque target identity, bounds,
   maximized state, monitor identity, and work area.
3. Exclude Aside itself, the desktop, unsupported windows, and invalid targets
   from Workspace Mode.
4. Keep target identity validation inside the native boundary; raw Windows
   handles must not cross the Tauri IPC boundary.
5. Add unit-test fixtures for maximized detection, target filtering, and target
   validation.

### P2-B. Workspace policy

1. Define a workspace snapshot containing the target identity, original bounds,
   maximized state, display, and the metadata needed for validation.
2. Enforce one active snapshot per session.
3. Calculate the 80/20 split from the target monitor's work area, including
   negative display coordinates and resize rounding.
4. Capture the target before Aside receives focus.
5. Resize the target to the left segment and position Aside in the right
   segment.
6. Implement explicit exit and shortcut-hide restoration.
7. Restore bounds and maximized state only after validating the captured target.
8. On an unsupported target or failed operation, keep Aside usable and fall
   back to Floating Mode or a recoverable error.

### P2-C. Pin and UI integration

1. Implement native always-on-top behavior.
2. Add a compact Pin control and clear active-state feedback.
3. Keep Pin independent from Floating and Workspace surface state.
4. Reflect native completion and failure in the frontend state.
5. Add visible transitions for entering, active, exiting, and failed workspace
   states without allowing stale native events to overwrite newer state.

### P2-D. Native verification

1. Test a maximized Chrome, Edge, VS Code, or equivalent application.
2. Test a normal window and confirm it is never resized.
3. Test a maximized target on a secondary monitor.
4. Test target closure, identity mismatch, display changes, and failed move or
   restore operations.

## Deliverables

- Windows foreground-window adapter.
- Workspace snapshot and restoration policy.
- 80/20 Workspace Mode.
- Pin mode.
- Native fallback and recovery states.
- Pure tests for geometry and restoration safety.

## Exit Criteria

- AC-03: a maximized application enters the split.
- AC-04: workspace exit restores the captured application when safe.
- AC-05: Pin changes native always-on-top state and the UI reflects the result.
- AC-06: the foreground monitor determines the split, including its coordinate
  origin.
- AC-07: invalid or closed targets cannot cause unrelated restoration.

## Verification

Record the native test matrix in [VERIFICATION.md](../VERIFICATION.md), including
the Windows version, monitor layout, target application, and any behavior that
remains a known limitation. Mixed DPI, elevated applications, sleep/resume,
and taskbar configurations are release-risk checks completed again in P4.
