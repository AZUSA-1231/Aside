# Aside

<p align="center">
  <img src="static/github.png" alt="Aside demo 1" width="420" />
  <img src="static/pinterest.png" alt="Aside demo 2" width="420" />
</p>

A desktop sidecar for Windows that works on the file you are already looking at.
Summon it with `Ctrl + Alt + A`, and it reads the window in front of you —
a file in Explorer, a page in your browser, a PDF, a Word document — as
context for the conversation, without you typing a path.

It is not a chatbot with a file picker. It is a panel that already knows where
you are.

## What it does differently

**It stays out of the way.** A frameless rail near the screen edge. No window to
manage, no tab to find. `Ctrl + Alt + A` shows, hides, and focuses it.

**Context is a reference, not permission.** Capturing a file tells Aside where
you are. It does not grant read access, write access, or anything else — the
runtime canonicalizes the path, resolves the containing directory as the task
workspace, and every tool call after that is still subject to its own policy.
Reading a file and writing one are different capabilities with different rules.

**Every write is approved for that operation.** Aside does not ask you to trust
a tool once and then run it freely. A write is prepared, previewed with its
exact target and content shape, and executed once after you approve that
specific operation. If the file changes while the card is open, the write is
refused and you review it again. There is no "always allow".

**There is no shell.** No PowerShell, no arbitrary process execution, no
code-runner escape hatch — not even as a disabled placeholder in the tool
schema. What the model can do is a bounded, inspectable list, and the list is
enforced in the runtime rather than described in a prompt.

## Features

- **Frameless side rail** — a consistent full-height panel near the right edge
  of the active display.
- **Summon from anywhere** — a global `Ctrl + Alt + A` shortcut shows, hides,
  and focuses the panel.
- **Pin mode** — keep Aside above other windows.
- **Workspace Mode** — temporarily gives ~80% of the work area to the active
  maximized application and 20% to Aside, restoring the original window state
  when you leave.
- **Bounded host context** — reads limited context from the current window
  (browser pages, Explorer, PDF, Word, Excel paths) via Windows UI Automation,
  without reading file contents or unbounded screen data.
- **Bounded workspace tools** — list, stat, read, and search text and JSON files
  inside the resolved workspace, with pagination, byte-accurate continuation,
  and no shell.
- **Documents** — read PDFs (text and page identity, with honest reporting of
  scanned or partial documents) and read, create, and transform `.docx` files.
  Generated documents are reopened and checked before the result is reported.
- **Permission-gated writes** — text, JSON, and document writes are prepared,
  previewed, and executed once after an exact-operation decision, then
  revalidated against the current target.
- **MCP tool adapter** — connect your own MCP server and its tools appear
  alongside the built-in ones, namespaced, classified, and permission-gated.
  Aside bundles no server and ships no default configuration.
- **Skills** — three bundled bounded `SKILL.md` workflows. Skill content is
  untrusted reference data: it can never register a tool or expand authority.
- **Task-aware rail** — workspace, active skill, tool activity, verification,
  and permission controls, all display projections over the runtime's
  serialized state.

## Getting started

> **There is no installer yet.** Packaging is planned work, so today Aside runs
> from a source checkout. The prerequisites below are for that, not for an
> installed app.

**Prerequisites:** Node.js 22.19+, Rust with the MSVC toolchain, and the
standard Tauri Windows prerequisites (WebView2, Visual Studio Build Tools).

```powershell
npm.cmd install
npm.cmd run tauri dev
```

The window starts hidden — press `Ctrl + Alt + A` to show or hide it.

Aside needs a model provider before it can hold a conversation. See the next
section.

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
local server. `.env.local` is git-ignored, and the credential never enters a
prompt, an event, or the session log.

## Connecting an MCP server

Aside ships no MCP server. To connect one, create `mcp.json` next to your
`.env.local`:

```json
{
  "servers": [
    {
      "id": "my-server",
      "display_name": "My server",
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\servers\\my-server.mjs"],
      "enabled": true,
      "trust_acknowledged": true
    }
  ]
}
```

`command` must be a directly executable file. On Windows a `.cmd` or `.bat`
would be launched through `cmd.exe`, which expands `%NAME%` inside arguments —
so a credential passed through the environment could end up on a command line.
Node-based servers are configured as `node.exe <script>`.

An MCP server is a program you chose to run. Aside applies its own policy,
permission, bounds, and result normalization to whatever the server exposes, and
describes its tools as external code it does not sandbox. It cannot make claims
about what a server does internally.

## What Aside does not do

Stated plainly, because a capability list is only useful next to its limits:

- no shell, PowerShell, terminal, or arbitrary process or code execution
- no general web browsing, arbitrary URL fetch, or page automation
- no web search — considered and removed; a built-in would mean adopting one
  provider's contract and terms, and every keyless option reachable over MCP is
  a scraper
- no Excel, PowerPoint, GitHub, VSCode actions, Notion, or cloud document
  editing
- no PDF editing, annotation, OCR, or form filling
- no legacy `.doc`, macro-enabled Word mutation, or exact Word round-trip
  fidelity — Word transformation writes a new file and never replaces the
  source
- no background agents, continuous observation, or multi-workspace execution
- no permanent workspace trust: writes are approved per operation

## Development

```powershell
npm.cmd run typecheck       # TypeScript
npm.cmd run build           # frontend bundle
npm.cmd run runtime:test    # agent runtime test suite
cargo test --manifest-path src-tauri/Cargo.toml
```

The runtime is a Node process that Tauri launches and speaks to over JSONL. Its
tool registry, policy evaluation, and every adapter live in `agent-runtime/`.
The Rust side owns window and host-capture behavior and forwards runtime events
to React without interpreting them.

`vendor/pi` is a vendored slice of the Pi agent core and is the runtime's only
contact point with the agent loop.

## Status

A development build, under active work. The desktop shell, window behavior,
agent runtime, host-context capture, workspace tools, PDF and Word handling, and
the MCP adapter are implemented and covered by an automated test suite.

Two things a reader should know before relying on it:

- **There is no released version and no installer.** Packaging is planned work.
- **Manual Windows acceptance has not been completed** for the current feature
  set. The automated suite is thorough, and it is not a substitute for a person
  using the app.

## License

[MIT](LICENSE).
