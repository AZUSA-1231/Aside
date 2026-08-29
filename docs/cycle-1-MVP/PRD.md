# Cycle 1 MVP Product Requirements

Status: product baseline (draft)
Platform: Windows desktop

This document defines why Cycle 1 exists, what the product must do, what is out
of scope, and how the result is accepted. It does not define code structure,
implementation order, engineering commands, or commit policy. Those concerns
belong in [Architecture](../ARCHITECTURE.md) and the [implementation plan
index](./PLANS.md).

## Document Set

| Document | Responsibility |
| --- | --- |
| This PRD | Product goal, scope, behavior, quality expectations, and acceptance criteria |
| [Architecture](../ARCHITECTURE.md) | Long-lived technical boundaries, ownership, privacy, and platform rules |
| [Implementation plan index](./PLANS.md) | Delivery order, dependencies, work packages, and engineering exit checks |
| [Verification record](./VERIFICATION.md) | Actual scenario results, check results, limitations, and release decision |

## 1. Objective

Deliver the smallest useful version of Aside: a persistent desktop agent that
can be summoned from any normal Windows application, appears near the right
side of the active display, accepts a short conversation, and can optionally
share the work area with a maximized application.

The MVP should make the user feel that an assistant is nearby without opening a
large application or requiring Windows Shell integration.

## 2. User and Primary Scenario

The target user is working at a Windows desktop and wants quick help with a
question, reminder, or small everyday task without changing context.

Primary flow:

```text
User presses Ctrl + Space
  -> Aside checks the current foreground window
  -> Aside chooses Floating or Workspace Mode
  -> Aside appears on the active display
  -> input is focused
  -> user types and receives a streaming response
User presses Ctrl + Space again
  -> Aside hides
  -> Workspace Mode restores the original application when applicable
```

## 3. MVP Scope

### Included

- A resident desktop assistant that remains available after its panel is hidden.
- One frameless, rounded, resizable Agent Panel.
- A global `Ctrl + Space` shortcut that shows, hides, toggles, and focuses the
  panel.
- Right-side placement on the display associated with the current foreground
  window.
- Floating Mode for ordinary windows, without changing the other application.
- Workspace Mode for a maximized or work-area-sized application, with an
  approximately 80/20 left/right arrangement and restoration when it ends.
- A Pin control that keeps the visible panel above other windows.
- A minimal conversation surface with streaming output, cancellation, retry,
  and recoverable failure states.
- Clear feedback when a shortcut, window operation, workspace operation, or
  provider operation cannot be completed.

### Not required for Cycle 1

- Product accounts, user authentication, or cloud sync.
- Windows Widgets, Desktop Shell, Explorer, or desktop icon integration.
- Browser extensions, DOM access, OCR, screen understanding, or screenshots.
- Accessibility API integration or broad input monitoring.
- Game-exclusive fullscreen and browser F11 fullscreen handling.
- General computer-use automation or arbitrary shell commands.
- A large collection of office workflows.
- Companion pets, decorative desktop effects, and PowerToys-like utilities.

These items may be considered in later cycles only after a new scope and
privacy review.

## 4. Functional Requirements

### FR-01. Application lifecycle

Aside remains available as a background-capable desktop application after the
panel is hidden. Hiding the panel must not disable the global shortcut or end a
conversation that is still in progress.

Cycle 1 does not require a tray menu or launch-at-startup setting. Those are
later release decisions.

### FR-02. Agent window

The Agent Panel must:

- have no system title bar or visible border;
- provide a rounded, shadowed visual surface;
- open near the right edge of the active display with a safe margin;
- have stable minimum and maximum dimensions;
- support user movement and resizing;
- be shown, hidden, and focused without creating duplicate panels.

The panel is an independent desktop window, not a true Windows Widget. Taskbar
behavior must not expand the Cycle 1 scope into Shell integration.

### FR-03. Global shortcut

`Ctrl + Space` must:

- work while another normal application has focus;
- toggle the existing panel instead of creating a new one;
- focus the Agent Panel and its input after showing;
- remain available after the panel is hidden;
- show an actionable status when the shortcut cannot be registered or used.

### FR-04. Visibility and Pin states

The product must make these states distinguishable:

| State | User-visible meaning |
| --- | --- |
| `HIDDEN` | The panel is not visible. |
| `FLOATING` | The panel is visible without resizing the foreground application. |
| `WORKSPACE` | The panel occupies the right workspace segment beside the target application. |
| `PINNED` | The visible panel stays above other windows. |

Pin is independent of Floating and Workspace. The panel must show a compact,
clear indication when Pin is active. Hiding the panel must not silently change
the user's Pin preference unless a documented platform limitation requires it.

### FR-05. Foreground-window inspection

Before showing Aside, the product must inspect the current foreground window's
metadata when available so it can choose the correct behavior and display. The
metadata includes:

- an opaque target identity;
- position and size;
- maximized state;
- monitor identity;
- monitor work area.

Aside must not read the target application's content. The target identity must
be retained only as needed to prevent an unsafe restoration.

### FR-06. Workspace Mode

Workspace Mode applies when the foreground application is maximized or occupies
the display work area:

- the application temporarily uses the left part of the work area;
- Aside uses the right part, with an approximately 80/20 split;
- both parts use the same display work area;
- leaving Workspace Mode restores the target application's original position,
  size, and maximized state when that same target is still available.

For ordinary windows, the target application must not be resized and Aside must
use Floating Mode.

If the target closes, changes identity, or cannot be restored safely, Aside must
remain usable, must not restore a snapshot onto another foreground window, and
must explain the result to the user.

The first release does not need to handle exclusive fullscreen, browser F11
fullscreen, or complex window managers.

### FR-07. Multi-monitor behavior

The foreground window determines the display used by Workspace Mode. Aside must
use that display's work area, including when the foreground window is on a
secondary monitor.

Position and size behavior must account for the display work area's actual
origin, including negative coordinates. Cycle 1 does not require complex
cross-monitor drag behavior.

### FR-08. Agent conversation

The panel must provide a minimal conversation surface that can:

- compose and submit a user message;
- display user and assistant messages;
- render assistant output incrementally;
- prevent duplicate submissions while a run is active, or offer explicit
  cancellation;
- preserve the user message when a provider fails;
- allow a cancelled or failed run to recover without stale output appearing in
  a later run.

Cycle 1 requires a configured assistant provider but does not require domain
tools such as reminders or schedules to be production-ready.

### FR-09. Failure and fallback behavior

Unsupported or failed operations must have a deliberate product response:

| Operation | Required response |
| --- | --- |
| Shortcut registration | Show an actionable status and keep the rest of the panel usable where possible. |
| Foreground lookup | Use Floating Mode or show an error; never resize an unknown window. |
| Workspace entry or resize | Keep Aside usable and attempt a safe recovery of the captured target. |
| Target closure or identity mismatch | Abandon unsafe restoration and explain what happened. |
| Provider request | Preserve the user message and offer retry or cancellation. |

## 5. Non-Functional Requirements

- Shortcut-to-visible-panel latency should feel immediate on a normal machine.
- Hidden Aside should have a low idle CPU and memory footprint.
- User-visible state must remain coherent when operations complete out of order.
- Keyboard navigation and reduced-motion behavior should be supported in the
  initial release.
- Provider credentials and sensitive content must not appear in logs.

Technical ownership and capability rules are defined in
[Architecture](../ARCHITECTURE.md), rather than repeated here.

## 6. Acceptance Criteria

Cycle 1 is accepted when the following scenarios pass on a real Windows
desktop. Results belong in the [verification record](./VERIFICATION.md), not in
this requirements document.

| ID | Scenario | Expected result |
| --- | --- | --- |
| AC-01 | Press `Ctrl + Space` on the desktop | Aside appears near the active display's right edge and focuses input |
| AC-02 | Press `Ctrl + Space` in a normal application window | The application is unchanged; Aside opens in Floating Mode |
| AC-03 | Press `Ctrl + Space` in a maximized application | The application occupies the left segment and Aside occupies the right segment |
| AC-04 | Press the shortcut while Aside is visible | Aside hides; any active workspace is restored |
| AC-05 | Toggle Pin | Always-on-top changes and the UI clearly reflects the result |
| AC-06 | Use a maximized application on monitor two | The split uses monitor two's work area and coordinate origin |
| AC-07 | Close or invalidate the workspace target | Aside does not resize or restore an unrelated window |
| AC-08 | Move and resize the panel | The panel remains usable and the layout does not jump |
| AC-09 | Submit a prompt with a configured provider | Assistant output streams into the panel |
| AC-10 | Cancel or fail a prompt | The UI shows a recoverable state and does not append stale output to a later run |
| AC-11 | Restart the application after hiding the panel | The shortcut and window lifecycle still work without duplicate registration |

## 7. Open Product Decisions

These questions do not expand the Cycle 1 scope. A temporary implementation
choice may be recorded in the relevant plan until the product decision is made.

| Decision | Why it matters |
| --- | --- |
| Preserve Pin preference across application restarts | Determines whether Pin is a session preference or a persistent preference. |
| Use an in-panel warning or a system notification for shortcut conflicts | Determines how prominently a registration failure is surfaced. |
| Choose the local-development provider configuration flow | Determines how a developer supplies provider settings without source control or log exposure. |
| Keep a separate recovery record for workspace restoration | Determines how recovery is handled after an interrupted process or restart. |
| Set the minimum supported Windows version and distribution method | Defines the public release boundary, but does not change the core MVP behavior. |
