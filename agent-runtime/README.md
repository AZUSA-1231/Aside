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
first prompt or explicit settings application. It sends a private `initialize`
envelope with stored credentials before any ordinary JSONL request, followed by
prompt/cancel, workspace, permission and `apply_settings` requests on stdin,
and forwards typed events from stdout to the panel. Pi remains inside this
package. Internal skill activation methods are not exposed by this protocol.

The configuration order is process environment, user `settings.json`, the
nearest legacy `.env.local` (or packaged `config.env`), then defaults. Configure
a provider through the Model & API settings panel or the existing `.env.local`
workflow. API keys use process environment, Windows Credential Manager, then
the legacy env file. A newly entered key is briefly held by its password input
and dedicated native write command; it is never read back to React. Native code
passes stored credentials over private stdin, excluding them from ordinary
settings, command-line arguments, session files and runtime events:

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

Optional server definitions use the effective `mcp_config_path`. Legacy files
beside the resolved env file, or an existing `mcp.json` in the working directory,
remain selected; new users default to `mcp.json` beside user settings. Only user-configured stdio servers are supported; Aside
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

Cycle 8 P0 adds a versioned settings service in `settings-schema.mjs`,
`settings-store.mjs`, and `settings-service.mjs`. The user file defaults to
`%LOCALAPPDATA%\Aside\settings.json` on Windows; `ASIDE_SETTINGS_PATH` accepts
an absolute override. The independent `settings-control.mjs` accepts one JSON
request on stdin, returns a redacted JSON response, and never constructs an
agent or opens a session. It loads provider code only for a local catalog or an
explicit connection test. Tauri exposes `get_settings`, `save_settings`, and
`import_legacy_settings`; writes require the revision read by the editor.

Ordinary settings use `schema_version: 1` with optional `provider`, `model`,
`api_url`, `thinking_level`, `workspace_root`, and `mcp_config_path` fields.
Credentials and unknown fields are rejected. Import copies ordinary legacy
values, pins the selected MCP path, and leaves the old file and its credentials
untouched. Writes validate, lock, check for conflicts, sync a temporary file,
and replace the destination; failed writes retain the previous file.

The `runtime_fields` projection lists the settings currently consumed by the
runtime. `thinking_level` and `workspace_root` are reserved for P3/P2 and do not
yet change execution. `loaded` means the runtime has read that configuration
snapshot; it does not mean a provider connection has been tested. Modified
settings remain pending for an existing runtime until **Apply when idle**.

P1 adds `set_api_key`, `get_provider_catalog`, `test_api_connection` and
`apply_settings` commands. Credentials are stored separately per provider in
Windows Credential Manager; the interface can replace or remove an unreadable
stored key. The provider catalog and model selection share backend logic with
the agent. Unsupported model IDs are not advertised as compatible.

Application waits for prompt completion, session persistence and workspace
operations. The replacement reuses the same session, messages and persistence
cursor, closes the previous MCP/permission state, then publishes ready. Old
emitters cannot publish into the replacement. Candidate initialization failure
retains the previous runtime; the settings snapshot records the actual loaded
revision and application error. Arbitrary task-time hot replacement is absent.

The explicit connection test uses the effective saved configuration, sends a
short text request with a small output cap and bounded timeout, and neither
opens history nor starts MCP/tools. It may incur provider usage. A valid URL or
HTTP reachability is insufficient for success: a model text response is
required. Tests against a local HTTP fixture are not vendor acceptance.

Plan and development evidence: [P0](../docs/cycle-8/plans/P0-settings-foundation.md)
and [P1](../docs/cycle-8/plans/P1-api-settings.md).
Development problems: [Cycle 8 issues](../docs/cycle-8/ISSUES.md).

The finite retained checklist and feature dispositions are RT-01–11 in
[the recovery ledger](../docs/RECOVERY-PLAN.md#7-当前范围下如何判定-runtime-齐备).
[R4 evidence](../docs/cycle-6/R4-RUNTIME.md) records the development checks;
manual/provider/native and release acceptance remain incomplete.

The current product restores one active local session and loads configuration
at runtime startup or explicit idle application. Default workspace, reasoning
controls, session management and MCP editing remain planned as Cycle 8 P2–P5;
arbitrary hot reload and a manual skill picker remain deferred.
PDF reading has no OCR or universal
hard parsing deadline. Word extraction preserves list text/items but not
ordered-versus-bulleted identity or original layout; creation of either list
kind does not make reading a fidelity-preserving round trip.
