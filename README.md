# Aside

Aside is a persistent desktop agent for Windows, built with Tauri 2, React,
TypeScript, and Pi's agent core.

It is not a Windows Widget and it does not integrate with the Windows desktop
Shell. Instead, Aside behaves like a small companion window that is always
easy to summon and feels present in the user's workspace without taking over
the workspace. When visible, it uses a consistent full-height right-hand Side
rail; eligible maximized windows can temporarily share the work area in
Workspace Mode.

## Product direction

Aside combines a lightweight conversational agent with small, carefully
designed desktop utilities and playful touches. It should feel closer to a
companion that can help with everyday tasks than to a large office assistant.

The agent can be summoned from any application, appear near the right edge of
the active display, and optionally become a real two-pane workspace alongside a
maximized application.

## Core experience

- A frameless Agent Panel that uses the Windows-native outer corners and a
  consistent full-height Side rail near the right side of the active display.
- A global `Ctrl + Alt + A` shortcut for showing, hiding, and focusing the panel.
- A Pin mode that keeps Aside above other windows.
- A Workspace Mode that temporarily gives roughly 80% of the work area to the
  active maximized application and 20% to Aside.
- Reliable restoration of the active application's original position, size,
  and maximized state.
- A small set of domain tools that let the agent work with everyday tasks,
  such as schedules and reminders.
- A desktop presence with room for playful companion behavior and lightweight
  enhancements over time.

## MVP scope

The first implementation focuses on the desktop and window experience:

1. Tauri 2 application shell with a React and TypeScript frontend.
2. Frameless Aside window with show, hide, focus, move, resize, and Pin
   behavior.
3. Global shortcut handling through the official Tauri global-shortcut plugin.
4. Detection of the current foreground window and its maximized state.
5. Workspace Mode on the active display, including state capture and restore.
6. A thin Agent Runtime package built on Pi's `pi-agent-core` and `pi-ai`.
7. Explicit, bounded host-context capture through the shared Windows UI
   Automation (UIA) layer and registered application strategies. Browser
   capture owns its UIA-plus-metadata composition; applications without a
   specialized strategy use the bounded Generic UIA fallback. File-oriented
   strategies can locate Explorer, PDF, Word, and Excel paths without reading
   file contents. VSCode bridge and active-editor integration are deferred.

The current repository contains the MVP shell, window behavior, workspace
behavior, agent runtime, and the Cycle 4 host-capture closeout. The production
boundary is bounded UIA for browsers and unmatched UIA hosts, plus validated
path descriptors for Explorer and supported document hosts. An opt-in local
research probe can measure real Word, Excel, PDF-reader, VSCode, and Explorer
capabilities without entering the provider path. Pi workspace wiring, VSCode
bridge integration, and rich production extraction are deliberately deferred.

## Provider configuration

The runtime provider is configured through a local `.env.local` file in the
project root. Copy [.env.example](.env.example) to `.env.local` and fill in the
provider credential. Aside loads this file automatically when the runtime
starts; there is no need to set variables in each terminal command.

```text
ASIDE_PROVIDER=openai
ASIDE_MODEL=gpt-4o-mini
ASIDE_API_URL=https://api.openai.com/v1
OPENAI_API_KEY=your-key
```

The API URL is optional and is useful for an OpenAI-compatible gateway or local
server. `.env.local` is ignored by Git. Packaged builds also look for
`%LOCALAPPDATA%\Aside\config.env`.

## Explicit non-goals for the first version

- Broad Windows Desktop Shell integration or Explorer actions. Cycle 4 includes
  a read-only, target-bound Explorer path locator; file contents, file actions,
  VSCode bridge integration, and Pi workspace wiring remain deferred.
- A true Windows Widget implementation.
- Browser extensions or application injection.
- DOM access, OCR, screen understanding, or unbounded/generic accessibility
  scraping. Approved strategies may use the shared UIA transport for explicit,
  bounded context capture, including the Generic UIA fallback when no
  specialized strategy matches.
- Game-exclusive fullscreen and browser F11 fullscreen support.
- Broad keyboard or mouse surveillance.
- A large office-suite assistant with many unrelated workflows.

## Documentation

- [Project architecture](docs/ARCHITECTURE.md) defines the long-lived
  principles, ownership boundaries, platform limits, and repository rules.
- [Cycle 1 MVP PRD](docs/cycle-1-MVP/PRD.md) defines the current product
  requirements, acceptance criteria, and deferred features.
- [Cycle 1 implementation plan index](docs/cycle-1-MVP/PLANS.md) maps the work
  into five independent execution plans.
- [Cycle 1 verification record](docs/cycle-1-MVP/VERIFICATION.md) records
  scenario results, engineering checks, limitations, and the release decision.
- [Cycle 2 Side Surface PRD](docs/cycle-2/PRD.md) defines the
  full-height rail, native seam correction, and shortcut change.
- [Cycle 2 implementation plans](docs/cycle-2/PLANS.md) decomposes that scope
  into focused work packages.
- [Cycle 2 verification record](docs/cycle-2/VERIFICATION.md) separates
  implementation evidence from the remaining Windows manual checks.
- [Cycle 3 Pi implementation PRD](docs/cycle-3-pi-implementation/PRD.md)
  defines the Pi kernel boundary, Aside context model, and session policy.
- [Cycle 3 implementation plans](docs/cycle-3-pi-implementation/PLANS.md)
  and [issues log](docs/cycle-3-pi-implementation/ISSUES.md) track delivery
  and unexpected implementation decisions.
- [Cycle 4 contextual sidecar PRD](docs/cycle-4-contextual-sidecar/PRD.md)
  defines deterministic host-strategy selection, Generic UIA fallback, browser
  composition, and path-first file-host capture.
- [Cycle 4 closeout plan](docs/cycle-4-contextual-sidecar/PLAN.md) is the
  single execution order for the closeout; Pi workspace wiring and rich host
  integrations are explicitly deferred.
- [Real host research probe](docs/cycle-4-contextual-sidecar/research/host-research-probe.md)
  documents the explicit HWND/PID-bound full-extraction experiment. Its local
  artifacts are research data, not prompt or session state.

## Development prerequisites

- Node.js 22.19 or newer for the Pi runtime dependency.
- Rust with the MSVC toolchain.
- Windows WebView2 and the other Tauri Windows prerequisites.

The current development environment has been verified with Node.js 22.23.2,
npm 10.9.8, Rust 1.98.0, the `stable-x86_64-pc-windows-msvc` toolchain,
Windows WebView2, and Visual Studio Build Tools. On this machine, PowerShell
may block the `npm.ps1` shim; use `npm.cmd` when running npm scripts if needed.

## Run the app

From the project directory, start the Tauri development process:

```powershell
cd D:\Projects\Aside\aside
npm.cmd run tauri dev
```

Keep that terminal open while using the app. The window starts hidden; press
`Ctrl + Alt + A` to show or hide it. Press `Ctrl + C` in the same terminal to
stop the development process cleanly.

If the command reports that port `1420` is already in use, identify the
listener first:

```powershell
netstat -ano | Select-String ':1420'
Get-Process -Id <PID> | Select-Object Id,Path
```

Only after confirming that the process belongs to this project, stop that
specific PID with `Stop-Process -Id <PID>`. Do not stop all `node.exe`
processes, because other applications may be using them.
