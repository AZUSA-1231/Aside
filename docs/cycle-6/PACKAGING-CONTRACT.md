# Installed-Runtime Packaging Contract

> **Current scheduling (2026-09-25): indefinitely deferred.** The historical
> Cycle 7 assignment below records the earlier deferral, not a live delivery
> commitment. There is no target cycle or date for an installer or clean-profile
> installation check. See [`../cycle-7/UI-PROPOSAL.md`](../cycle-7/UI-PROPOSAL.md).

Owner: P0 task 11 (recorded); **implementation reassigned to Cycle 7**
Closes: [C6-I017](./ISSUES.md#c6-i017---installed-runtime-packaging-contract-p0-task-11)
Related: [C6-I010](./ISSUES.md#c6-i010---installed-runtime-is-a-release-requirement)
Status: **deferred to Cycle 7 by
[C6-I034](./ISSUES.md#c6-i034---p7-was-over-broad-packaging-and-surface-quality-move-to-cycle-7);
decision recorded, partially implemented, not verified**

This document is kept because the decision in it was made deliberately and its
reasoning does not expire. The implementation it describes is **not** part of
Cycle 6, and nothing in this cycle's acceptance depends on it.

What exists: the resolution code in `runtime.rs` with 7 unit tests, and the
staging script. What does not: an installer, a bundle configuration, a
downloaded Node, or a clean-profile installation. Cycle 7 owns all four.

This is the record P0 task 11 requires and C6-I017 has carried since P0. It
states what a normal installation consists of, what it may not depend on, and
what is still unverified.

## The decision

**Node is bundled with the application.**

Measured before deciding, not assumed: the runtime's dependency closure is
**199 packages, ~113 MB staged** (198 after dropping `@types/node`, which is
declared but never imported at runtime). Node for Windows adds roughly 30 MB
compressed on top.

**Corrected 2026-09-19.** The size was first reported as ~80 MB, because the
dependency roots in the staging script were hand-written and omitted
`pdfjs-dist` — which the runtime imports dynamically, so it appears in no
`package.json` dependency list. The staged tree was therefore incomplete, and
the number described that incomplete tree. The script now verifies its own
output against the runtime's actual imports, and the figure above is measured
with the closure complete. The decision does not change: 113 MB against a 30 MB
saving is still the same argument.

Requiring the user to install Node 22.19+ would save that 30 MB against a
113 MB payload — a small fraction — while adding a prerequisite to a desktop
application whose premise is to be summoned on a selected file. A user who has
Node installed is a developer; that is not the audience this product is for.

## What an installation contains

```text
<install>/
  aside.exe
  resources/
    runtime/
      src/              the Aside runtime (~450 KB)
      skills/           bundled skills
      node_modules/     the closure above (~113 MB)
    node/
      node.exe          the bundled Node
```

`src/` is a sibling of `node_modules/` deliberately. Node resolves bare
specifiers by walking up from the importing file, so a runtime at
`runtime/src/protocol.mjs` finds `runtime/node_modules` with no resolution hook
and no `NODE_PATH`. That is one fewer mechanism that can differ between a
development machine and an installed one.

## What an installation may not depend on

- **A compile-time source path.** `runtime.rs` previously resolved the runtime
  through `env!("CARGO_MANIFEST_DIR")`, which bakes an absolute path from the
  build machine into the binary. That is now the *last* fallback, reached only
  when no bundle is present, which is the development case.
- **A user-installed Node.** The bundled binary is preferred; a `PATH` lookup is
  the fallback, and the runtime's own version check decides whether what it
  found is good enough.
- **`ASIDE_RUNTIME_PATH` / `ASIDE_NODE_PATH`.** Both remain as overrides and are
  recovery and development options. Neither is required for a normal
  installation.

## Resolution order

Implemented in `src-tauri/src/runtime.rs`, with unit tests for each branch:

| Target | Order |
| --- | --- |
| Runtime entry | `ASIDE_RUNTIME_PATH` → `<resources>/runtime/src/protocol.mjs` → source tree |
| Node | `ASIDE_NODE_PATH` → `<resources>/node/node.exe` → `node` from `PATH` |

The `PATH` fallback is deliberate and is not a packaging shortcut. A bundle
missing its Node should still start on a machine that has a usable one; the
version check, not the absence of a file, is what decides. What a missing Node
must not do is fail with a message that does not name the location it looked in.

## Staging

`node scripts/stage-runtime.mjs` builds `<repo>/src-tauri/resources`. It is
git-ignored: it is build output, and Tauri resolves these paths at build time,
so committing a 113 MB tree would break the build for anyone who has not run it.

Two `tauri.conf.json` entries cannot be added until the staged tree exists,
because Tauri fails on paths it cannot resolve:

```json
"resources": ["resources/runtime/**/*", "resources/node/**/*"],
"externalBin": ["binaries/node"]
```

They are documented in the script's output rather than committed, so that
`tauri build` keeps working in a fresh checkout.

**The staging script needs the network**, and only for the Node download. That
step is isolated so the local copying still runs and reports when the download
cannot. `--no-node` stages everything except Node.

## Configuration location

Unchanged from Cycle 5 and recorded here for completeness: a project-local
`.env.local`, or `%LOCALAPPDATA%\Aside\config.env` for an installed build. MCP
server definitions live in `mcp.json` beside whichever config file resolves
(C6-I033).

## Startup failure messages

Each of these must name the thing that is wrong, because the alternative is a
user with a working installation and no way to tell which part is missing:

| Condition | Message names |
| --- | --- |
| Runtime entry missing | The path it looked in, and that the installation is incomplete |
| Node missing or not executable | The resolved Node path, plus the underlying spawn error |
| Node too old | The version required, the version found, and that a packaged build ships its own |
| Provider not configured | The configuration file to edit (existing Cycle 5 behavior) |

The Node version check lives in `protocol.mjs` and reports over the protocol
channel rather than to stderr, which the launcher discards. A version problem
the user cannot see is a version problem they cannot fix.

## What is not verified

Stated plainly, because this document would otherwise read as though packaging
were done:

- **The staged payload has not been built into an installer.** The script ran and
  produced 113.3 MB; `tauri build` has not been run against it.
- **No clean-profile installation has been attempted.** That is P7 task 17, and
  it needs a VM or a clean Windows profile.
- **The bundled Node has not been downloaded.** This environment has no network.
  The download path is implemented and untested against the real endpoint.
- **`externalBin` is not wired.** Tauri expects a platform-suffixed name
  (`node-x86_64-pc-windows-msvc.exe`) and the staging script writes
  `resources/node/node.exe`, which `runtime.rs` resolves directly. Whether both
  are needed, or whether `resources/` alone suffices, is decided when the build
  is first run.

P7 task 17 and the audit must treat installed-application support as
**unproven** until then. Every automated test in this repository runs against a
development build.
