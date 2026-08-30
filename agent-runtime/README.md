# Aside Agent Runtime

This package is the process boundary for Aside's agent runtime.

It depends on Pi's general-purpose agent core and AI provider layer. The
runtime will expose a small, application-owned protocol to the Tauri process;
the React frontend must not import Pi packages directly.

## Responsibilities

- Create and manage the Pi `Agent` instance.
- Translate Pi events into stable Aside events.
- Register Aside's domain tools, such as schedule and reminder operations.
- Keep provider and model details out of the UI layer.

## Development runtime

The MVP runtime is a small JSONL process. Tauri starts `src/protocol.mjs` on
the first prompt, sends `prompt` and `cancel` requests on stdin, and forwards
typed events from stdout to the panel. Pi remains inside this package.

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
