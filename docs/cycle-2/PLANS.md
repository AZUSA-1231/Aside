# Cycle 2 Side Surface Implementation Plans

Status: implementation in progress; C2-P3 manual acceptance pending
Source requirements: [Cycle 2 PRD](./PRD.md)
Technical constraints: [Project Architecture](../ARCHITECTURE.md)
Predecessor verification: [Cycle 1 MVP verification](../cycle-1-MVP/VERIFICATION.md)

Cycle 2 is intentionally narrow. It improves the desktop surface and shortcut
without expanding Aside into a new automation product or reopening the Cycle 1
agent-runtime scope.

## Delivery Map

```text
C2-P0 Native Geometry and Tiling
  -> C2-P1 Shared Side Surface
  -> C2-P2 Shortcut Replacement
       -> C2-P3 Integrated Verification
```

C2-P1 and C2-P2 can proceed after the geometry contract in C2-P0 is agreed.
C2-P3 starts after both behavior changes are integrated.

| ID | Plan | Purpose | Depends on |
| --- | --- | --- | --- |
| C2-P0 | [Native Geometry and Tiling](./plans/P0-native-geometry.md) | Remove native frame/DPI gaps and establish one physical-coordinate layout policy. | Cycle 1 P2 |
| C2-P1 | [Shared Side Surface](./plans/P1-side-surface.md) | Use one full-height Side rail in desktop, ordinary-window, and Workspace contexts. | C2-P0 |
| C2-P2 | [Shortcut Replacement](./plans/P2-shortcut.md) | Move the summon shortcut to `Ctrl + Alt + A` and verify the explicit rejection of `Ctrl + A`. | Cycle 1 P1 |
| C2-P3 | [Integrated Verification](./plans/P3-verification.md) | Run focused visual, native, and regression checks and close Cycle 2 with evidence. | C2-P1 and C2-P2 |

## Shared Rules

- Product behavior changes are recorded in the Cycle 2 PRD first.
- Native geometry is authoritative; React does not calculate screen bounds.
- Keep the existing restoration snapshot and identity checks intact.
- Do not simulate Windows Snap with injected keyboard input.
- Do not add a settings system for one shortcut unless the acceptance work
  proves a real need.
- Do not change Pi runtime behavior in this cycle.
- Every visual adjustment must preserve the single shared Side geometry token.

## Engineering Checks

Run the existing quality gate at C2-P3:

```text
npm.cmd run typecheck
npm.cmd run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm.cmd run runtime:test
```

## Traceability

| Product area | Plan | Acceptance criteria |
| --- | --- | --- |
| Native work-area, frame, DPI, and seam alignment | C2-P0 | C2-02, C2-09 |
| Shared full-height Side rail | C2-P1 | C2-01, C2-03, C2-04, C2-07, C2-08 |
| Shortcut replacement and conflict behavior | C2-P2 | C2-05, C2-06, C2-10 |
| Regression and release evidence | C2-P3 | All applicable criteria |

## Deferred

- Real-provider conversation acceptance and runtime feature expansion.
- Shortcut customization UI.
- Windows Shell or actual Snap-group integration.
- Tray, startup, domain tools, screen understanding, and accessibility APIs.
