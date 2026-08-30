# Cycle 2 Side Surface Verification Record

Status: implementation complete; manual Windows acceptance pending
Requirements: [PRD](./PRD.md)
Plans: [implementation plan index](./PLANS.md)

This record separates implementation evidence from the Cycle 2 requirements.
The remaining checks require the user to run the app on Windows and observe
the actual panel and target-window edges. No automated screenshot or desktop
interaction is used by the implementation process.

## Implementation Evidence

| Area | Result | Evidence |
| --- | --- | --- |
| Shared Side geometry | Ready for manual check | `side_layout` uses one 20% rail policy, preserves work-area origin, clamps existing width limits, and partitions the work area exactly. |
| Target frame correction | Ready for manual check | Windows placement reads `DWMWA_EXTENDED_FRAME_BOUNDS` and converts the requested visible target rectangle to a native outer rectangle. |
| Coordinated placement | Ready for manual check | Target and Aside are submitted through `BeginDeferWindowPos`/`DeferWindowPos` with `SWP_NOACTIVATE` and `SWP_NOZORDER`, with a short fallback sequence. |
| Non-workspace Side | Ready for manual check | Desktop and ordinary foreground detection select the relevant display work area and use the shared full-height Side rail; ordinary targets are not resized. |
| Legacy Floating removal | Ready for manual check | The native and frontend surface contracts contain only `side` and `workspace`; no old small-window layout path remains. |
| Shortcut | Ready for manual check | The single startup registration is `CommandOrControl+Alt+A`; no `Ctrl+A` registration exists. |

## Pure Checks

- Rust geometry tests cover negative origins, exact partition, 20% rounding,
  narrow displays, and the shared Side/Workspace policy.
- TypeScript typechecking and production frontend build pass.

## Manual Acceptance Pending

1. Summon from the desktop and beside an ordinary window. Confirm the Side rail
   is full-height, about 20% wide, uses the relevant display work area, and
   leaves the ordinary window unchanged.
2. Summon beside a maximized application and confirm the visible target and
   Aside edges meet without left, top, bottom, or right leaks.
3. Compare Side and Workspace, including native outer corners and the shared
   four-edge inset. Confirm no path shows the old small popup.
4. Test `Ctrl + Alt + A`, `Ctrl + A` text selection, input-method switching,
   restart after hiding, Pin, and Workspace restoration.
5. Repeat the geometry checks on a secondary or mixed-DPI display when
   available.

## Engineering Quality Gate

| Check | Result |
| --- | --- |
| `npm.cmd run typecheck` | Pass |
| `npm.cmd run build` | Pass |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | Pass |
| `cargo check --manifest-path src-tauri/Cargo.toml` | Pass |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Pass, 5 tests |
| `npm.cmd run runtime:test` | Pass, 3 tests |

Cycle 2 must not be marked released until the user supplies the Windows
observations above. Real-provider conversation acceptance remains outside this
cycle.
