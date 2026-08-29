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

Configure a provider outside source control before running the desktop app:

```text
ASIDE_PROVIDER=openai
ASIDE_MODEL=gpt-4o-mini
OPENAI_API_KEY=your-key
```

`ASIDE_PROVIDER` also accepts `anthropic`, `deepseek`, and `google`; the
corresponding Pi environment variable supplies credentials. Provider failures
are returned as recoverable events and secrets are redacted from messages.

Run deterministic runtime checks with `npm test` from this directory.
