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
runtime. P2 activates `workspace_root`; `thinking_level` remains reserved for
P3. `loaded` means the runtime has read that configuration
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

### Default directory and captured sources

P2 consumes `workspace_root` / `ASIDE_WORKSPACE_ROOT`. Tauri supplies the
system document directory through its native path resolver, with `Aside`
appended as the fallback output location. Blank settings restore this fallback;
the runtime never guesses a Documents path from the home directory. Standalone
Node callers without a configured or native default retain the earlier
explicit/captured workspace behavior.

With a default configured, an explicit task workspace wins for output, otherwise
the default is used. Captures form a separate read scope: one file opens only
that file; a directory capture opens that directory. Relative tool paths resolve
under output; external sources use their absolute paths. No common ancestor is
opened, no source is copied, and neither process cwd nor the history root changes.
Directory scopes can overlap output; their read authority does not grant write
authority outside output. An individually captured file remains read-only even
inside output. Every output write still needs the existing exact approval.

Resolution is fixed per task. A valid source can continue only within the same
conversation; configuration application re-resolves output, and selecting a new
task output retains that conversation's valid source. Restoring history after a
process restart grants no old source scope. The session wrapper preserves runtime
getters so application sees current continuation state.

Missing default roots are planned without filesystem mutation. First approved
write creates the root beneath the validated existing parent, then uses the
existing version checks, atomic commit and reopen verification. Refusing the
preview creates nothing. Existing output removal, replacement or redirection
during the task fails instead of selecting another location. An approved write
that later fails may leave an empty created directory; no automatic cleanup is
performed. Existing nested output directories are supported; no general directory
creation tool was added.

Defaults cannot overlap Aside's configuration/session locations. Canonical
paths and directory links are checked, including pending private paths. Results
retain the relative path and add `output_absolute_path`; the interface uses the
absolute path for display/reveal. `reveal_existing_path` validates an existing
local path before asking Explorer to reveal it, and never creates a missing root.
See [P2](../docs/cycle-8/plans/P2-default-workspace.md) for evidence and limits.
Development problems: [Cycle 8 issues](../docs/cycle-8/ISSUES.md).

The finite retained checklist and feature dispositions are RT-01–11 in
[the recovery ledger](../docs/RECOVERY-PLAN.md#7-当前范围下如何判定-runtime-齐备).
[R4 evidence](../docs/cycle-6/R4-RUNTIME.md) records the development checks;
manual/provider/native and release acceptance remain incomplete.

The current product restores one active local session and loads configuration
at runtime startup or explicit idle application. P2 adds separate source/output
scopes and a default output directory. Reasoning controls, session management
and MCP editing remain planned as Cycle 8 P3–P5;
arbitrary hot reload and a manual skill picker remain deferred.
PDF reading has no OCR or universal
hard parsing deadline. Word extraction preserves list text/items but not
ordered-versus-bulleted identity or original layout; creation of either list
kind does not make reading a fidelity-preserving round trip.
