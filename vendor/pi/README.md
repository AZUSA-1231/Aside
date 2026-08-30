# Vendored Pi Components

Aside vendors the Pi 0.84.4 agent, AI, and telemetry packages used by its
runtime. The source snapshot comes from upstream commit
`853a80d26c90a14c1886f0ebb8ffaae133ca2185`.

The runtime imports these packages through local workspace links. `build/` is
the checked-in JavaScript output that lets the Tauri-launched Node process run
without a separate Pi installation. The source under each package is retained
for review and future controlled updates.

Aside uses the `./aside` agent entry point so its runtime imports only the
kernel and session APIs it needs. Pi coding-agent tools and harness operations
are not registered as Aside capabilities.

The vendored code is MIT licensed. See [LICENSE](./LICENSE) for the upstream
license and attribution.
