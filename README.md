# Aside

<p align="center">
  <img src="static/github.png" alt="Aside demo 1" width="420" />
  <img src="static/pinterest.png" alt="Aside demo 2" width="420" />
</p>

> **Status: work in progress** — a semi-finished MVP. The desktop shell, window
> behavior, agent runtime, and bounded host-context capture are in place;
> richer host integrations are still planned.

Aside is a persistent desktop companion for Windows. It's a small frameless
side panel you can summon from anywhere with `Ctrl + Alt + A` — always within
reach, never taking over the screen.

Built with **Tauri 2**, **React**, **TypeScript**, and **Pi's agent core**.

## Features

- **Frameless side rail** — a consistent full-height panel near the right edge
  of the active display.
- **Summon from anywhere** — a global `Ctrl + Alt + A` shortcut shows, hides,
  and focuses the panel.
- **Pin mode** — keep Aside above other windows.
- **Workspace Mode** — temporarily gives ~80% of the work area to the active
  maximized application and 20% to Aside, restoring the original window state
  when you leave.
- **Bounded host context** — the agent reads limited context from the current
  window (browser pages, Explorer, PDF, Word, Excel paths) via Windows UI
  Automation, without reading file contents or unbounded screen data.
- **Small everyday tools** — schedules, reminders, and lightweight utilities.

## Getting started

**Prerequisites:** Node.js 22.19+, Rust with the MSVC toolchain, and the
standard Tauri Windows prerequisites (WebView2, Visual Studio Build Tools).

```powershell
npm.cmd install
npm.cmd run tauri dev
```

The window starts hidden — press `Ctrl + Alt + A` to show or hide it.

## Provider configuration

Copy [.env.example](.env.example) to `.env.local` and fill in your provider
credential. Aside loads it automatically at startup:

```text
ASIDE_PROVIDER=openai
ASIDE_MODEL=gpt-4o-mini
ASIDE_API_URL=https://api.openai.com/v1
OPENAI_API_KEY=your-key
```

`ASIDE_API_URL` is optional and useful for an OpenAI-compatible gateway or a
local server. `.env.local` is git-ignored; packaged builds also read
`%LOCALAPPDATA%\Aside\config.env`.

## Roadmap

The current MVP covers the desktop and window experience, the agent runtime,
and bounded UIA-based host-context capture. Deferred for now:

- VSCode bridge and active-editor integration
- Rich production host extraction
- Windows Widget / Shell integration, browser extensions, DOM access, and OCR
