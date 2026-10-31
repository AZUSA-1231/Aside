# Aside Agent Runtime

This package is the process boundary for Aside's agent runtime.

It depends on Pi's general-purpose agent core and AI provider layer. The
runtime exposes a small, application-owned protocol to the Tauri process;
the React frontend must not import Pi packages directly.

## Responsibilities

- Create and manage the Pi `Agent` instance.
- Translate Pi events into stable Aside events.
- Register bounded workspace/document tools and user-configured MCP tools.
- Keep provider and model details out of the UI layer.

## Development runtime

The runtime is a small JSONL process. Tauri starts `src/protocol.mjs` on the
first prompt, sends prompt/cancel, workspace, and permission requests on stdin,
and forwards typed events from stdout to the panel. Pi remains inside this
package. Internal skill activation methods are not exposed by this protocol.

Configure a provider in `.env.local` at the project root. The runtime finds
the nearest project file from its working directory, and existing process
environment values override file defaults. No provider secret is sent to
React, Tauri, session files, or runtime events:

```text
ASIDE_PROVIDER=openai
ASIDE_MODEL=gpt-4o-mini
ASIDE_API_URL=https://api.openai.com/v1
OPENAI_API_KEY=your-key
```

`ASIDE_PROVIDER` also accepts `anthropic`, `deepseek`, and `google`; the
corresponding Pi environment variable supplies credentials. `ASIDE_API_URL` is
optional and overrides the selected model's HTTP base URL. It accepts only an
HTTP(S) URL without credentials, query strings, or fragments. For a packaged
build, the fallback file is `%LOCALAPPDATA%\Aside\config.env`.

Provider failures are returned as recoverable events and secrets are redacted
from messages. `.env.example` at the repository root lists the supported
fields without containing a real credential.

Run deterministic runtime checks with `npm test` from this directory.

## MCP classification bindings

Optional server definitions live in `mcp.json` beside the resolved Aside
configuration file. Only user-configured stdio servers are supported; Aside
bundles no server. Enablement and `trust_acknowledged` are separate. Credentials
are referenced by configuration name with `env: { "NAME": { "from_config": "NAME" } }`,
not stored as literal values in this JSON.

A `tool_classifications` entry may override effect, scope, egress, and replay.
For an override to apply, it must also contain both `schema_digest` (16 hex
characters) and `server_fingerprint` (32 hex characters). For example, this is
a fragment inside a server definition; replace both placeholders after review:

```json
{
  "tool_classifications": {
    "search": {
      "effect": "read",
      "schema_digest": "<reviewed schema digest>",
      "server_fingerprint": "<reviewed server launch fingerprint>"
    }
  }
}
```

Missing pins keep the conservative `execute / host / selected_content /
non_replayable` defaults and emit `mcp_classification_unbound`. A different
schema or launch identity emits `mcp_classification_changed` and also keeps the
defaults. The existing runtime warning includes the currently observed pins.
Review the advertised tool schema and the executable, arguments, working
directory, and environment references before approving an override. Persist
the reviewed values in this file and restart the runtime to load them.

Discovery and Allow once never update this file or approve a classification.
Even a correctly pinned read-only classification still requires a new exact
decision for each external call. These pins detect accepted schema and launch
configuration changes; they do not verify binary contents or server behavior,
and do not sandbox the external process. The schema digest is computed from
Aside's accepted/forwarded parameters, not the raw server JSON serialization.

Compatibility: old overrides with no pins or only a schema pin now keep the
conservative defaults. Present pins must have the exact lengths above; hex is
normalized to lowercase. Malformed entries follow the existing per-server
configuration error path. No classification editor or automatic reapproval
dialog is provided.

## Current development boundary

The finite retained checklist and feature dispositions are RT-01–11 in
[the recovery ledger](../docs/RECOVERY-PLAN.md#7-当前范围下如何判定-runtime-齐备).
[R4 evidence](../docs/cycle-6/R4-RUNTIME.md) records the development checks;
manual/provider/native and release acceptance remain incomplete.

The current product restores one active local session and loads configuration
at runtime startup. Session management, settings editors, hot reload and a
manual skill picker remain feature backlog. PDF reading has no OCR or universal
hard parsing deadline. Word extraction preserves list text/items but not
ordered-versus-bulleted identity or original layout; creation of either list
kind does not make reading a fidelity-preserving round trip.
