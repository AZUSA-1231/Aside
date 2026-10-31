# P6 - User-Connected MCP Tool Adapter

Status: **implemented 2026-09-18** against deterministic and adversarial fixtures
and a real child process; the manual `server-everything` smoke test on Windows
is the remaining evidence, and belongs with P7's Windows pass.

**R4 follow-up (2026-10-31):** classification overrides now require matching
schema and server launch pins persisted in user-managed `mcp.json`. Missing or
changed pins retain conservative defaults and emit discovery diagnostics via
the existing warning surface. This completes the finite file-based part of
task 6 without a settings UI; see [R4 evidence](../R4-RUNTIME.md) and
[C6-I030](../ISSUES.md#c6-i030---tool-classification-is-name-keyed-without-a-settings-store).
The in-app editor remains feature backlog and the manual smoke is still
unperformed.

Depends on: P0 - Capability Contract and Policy Plane; M2 local capability checkpoint
Unblocks: P7
Source requirements: PRD sections 3.3, 5, 11 through 16, and C6-31 through
C6-39

## Outcome

Allow a user to connect an MCP server and expose selected server tools through
the Aside capability registry. Aside owns namespacing, schema acceptance,
trusted policy classification, permission, cancellation, output bounds, and
failure isolation while remaining honest that server internals are external
trusted code.

Cycle 6 supports MCP tools only. Resources, prompts, sampling, elicitation, and
server-initiated model behavior are not model capabilities in this plan.

## Scope Note

Web Search is not part of this plan. It was removed from Cycle 6 on 2026-09-18
([C6-I026](../ISSUES.md#c6-i026---web-search-leaves-cycle-6-entirely)); C6-26
through C6-30 are retired and carry no owner here. This plan delivers the
adapter and bundles no server, ships no default configuration, and names no
server in the system prompt or tool descriptions.

Two consequences are recorded rather than smoothed over:

- **No egress-bearing capability ships this cycle.** Every Cycle 5 tool is
  `egress: "none"`, and with Web Search removed the adapter may land no
  `permission_required` tool either, so the grant-verification mechanism P0
  built and gated (C6-I013) and the `user_mcp` `missing_egress` rule (C6-I011)
  stay exercised by tests rather than by a shipped path.
- **Verification is fixture-based, not field-based.** See the section below.

## Verification Approach and Its Limit

A faux server built with the same SDK speaks exactly the protocol we expect, so
verifying only against it means verifying our own assumptions. That limit is
answered by deriving the adversarial fixtures from a **real third-party
server** rather than from our assumptions.

A representative third-party Web Search MCP server was read for this purpose
during planning. It contributed concrete, unanticipated shapes that the faux
suite is required to cover:

- JSON Schema `anyOf` unions of `number` and `string`, with `default` values,
  in tool parameter definitions;
- tool descriptions that contradict the tool's actual behavior — one described
  as a comprehensive search tool that also follows every result link and
  extracts full page content, versus a near-identically described sibling that
  does not;
- a tool accepting an arbitrary URL and fetching it;
- a server that itself spawns child processes (a browser driver);
- parameter handling that coerces string inputs to numbers with a custom
  validator rather than declaring a type.

That server is a **fixture source, not a runtime dependency** and is not
bundled, configured, or referenced by the product. The vendored tree is
git-ignored.

The limit that remains, and that P7 must state plainly: Cycle 6 ships an MCP
boundary exercised against adversarial protocol shapes but never against a
third-party server at runtime. One manually configured server smoke test on
Windows is retained as the only field evidence, and its scope must not be
overstated.

## SDK and Transport Gate

**Decided 2026-09-18.** The official `@modelcontextprotocol/sdk` is selected.
Measured on the installed package:

| Item | Value |
| --- | --- |
| Version | 1.30.0 |
| License | MIT |
| Engines | Node >= 18 |
| Native binaries | None; pure JS, no platform-specific install step |
| Declared dependency closure | 91 packages, ~23.1 MB on disk |
| Reachable from `client/index.js` + `client/stdio.js` | 6 packages, ~16 MB |

The reachable set is `@modelcontextprotocol/sdk`, `zod`, `zod-to-json-schema`,
`ajv`, `ajv-formats`, and `cross-spawn`. Not reachable from the client path:
`express`, `hono`, `@hono/node-server`, `jose`, `cors`, `express-rate-limit`,
`pkce-challenge`, `eventsource`, `raw-body`, `content-type` — these serve the
server side, the HTTP transports, and OAuth, none of which this plan uses.

Two entries in that reachable set are load-bearing:

- **`cross-spawn`** exists because the stdio transport spawns a process. This
  is the concrete form of the invariant question below.
- **`ajv` and `zod-to-json-schema`** exist because the SDK validates JSON Schema
  itself. Task 5 therefore adds Aside's acceptance policy on top of an existing
  validator rather than writing validation from scratch.

### Why the SDK and not a hand-written protocol subset

A subset implementing only `initialize`, `tools/list`, and `tools/call` was the
initial preference and was rejected:

- It is exactly what the plan forbids elsewhere — a minimal adapter rather than
  a real protocol client. It cannot send `notifications/cancelled`, cannot
  page `tools/list` past the first page, cannot observe `tools/list_changed`,
  cannot report progress, and cannot speak Streamable HTTP.
- MCP is a young, moving specification. Tracking it by hand is a permanent tax,
  and the HTTP transport, resources, and prompts that later cycles will want
  are the same code path in the SDK.
- The security argument for hand-writing was overstated. Task 12 requires
  proving that resources, prompts, sampling, and elicitation cannot enter model
  state; that is provable by test against the SDK too, because an unregistered
  client-side handler yields `-32601`. Hand-writing narrows the surface but
  does not remove the obligation to test it.

The SDK is a protocol library, not an application runtime. It does not replace
the registry, the policy plane, the permission broker, or the Pi loop, and
using it does not make those thinner. **The thin layer is the adaptation, not
the support.**

### Protocol revision and disabled capabilities

Pin the protocol revision the client advertises, and fail loudly on an
unexpected server revision rather than degrading. Record here, at
implementation time, exactly which capabilities the client declares and which
server-initiated requests it refuses.

### The subprocess invariant

The PLAN invariant forbids adding "shell, PowerShell, arbitrary process/code
execution". A stdio transport spawns a process, and `cross-spawn` is on the
client path, so this is not hypothetical. The reading this plan adopts, and
must enforce:

- the invariant bans a **model-triggered arbitrary** process;
- a server the user configured and enabled is the **user's** decision, not the
  model's, which is why P0 already provides `boundary: "external_process"` and
  `source: "user_mcp"`;
- the model may call an adapted tool, and may **never** add, change, enable,
  disable, or launch a server.

That last clause is a test obligation, not a convention: it needs a test
proving no model-reachable path mutates server configuration or spawns
anything.

The invariant was **weaker than it appeared**, and finding that out changed the
configuration contract. The SDK's stdio transport passes `shell: false`, but
`cross-spawn` overrides it on Windows for any command that is not a `.exe` or
`.com`, building a `cmd.exe` command line instead. Because Aside passes server
secrets through the environment and `cmd.exe` expands `%NAME%` inside
arguments, a configuration copied from an untrusted source could expand a real
secret into the server's command line. The config layer therefore refuses
non-directly-executable commands on Windows. Full reasoning, and the usability
cost, in [C6-I027](../ISSUES.md#c6-i027---windows-shell-routing-is-refused-in-mcp-server-configuration).

Implement stdio as the one initial transport. Remote transport is out of scope
for Cycle 6 unless its authentication can meet the same boundary within it.

## Configuration Contract

A server configuration contains a stable non-secret id, display name, enabled
state, selected transport data, bounded arguments or endpoint, environment/
secret references, and trust acknowledgment. Exact storage and UI placement
are selected during implementation, subject to:

- secrets never stored in ordinary JSON session/config when a native secret
  facility or environment indirection is required;
- model and server cannot mutate configurations;
- executable/endpoint changes invalidate discovered tools and prior trust
  classification;
- removal/disabling closes the connection and removes tools on the next safe
  registry boundary;
- restored conversations do not auto-authorize or silently invoke a server.

## Adaptation Contract

Names should follow a deterministic form such as
`mcp.<server-id>.<tool-id>` after collision-safe normalization. The original
server/tool display identity remains available to the UI.

For each discovered tool:

1. bound and sanitize name/description;
2. validate the supported JSON Schema subset and total schema complexity;
3. reject reserved/colliding names and unsupported schema constructs;
4. attach source `user_mcp` and an Aside-owned risk classification;
5. expose it only when enabled for the current task;
6. validate call arguments locally before sending them;
7. apply policy/permission from trusted metadata;
8. normalize and bound returned MCP content.

Server annotations are advisory. They cannot classify a call as safe or
contained without trusted user/built-in policy. Unknown classifications use
the highest applicable risk and exact per-call permission.

## Tasks

1. Complete SDK/transport/license/security review and document which MCP
   capabilities are requested, supported, disabled, and rejected.
2. Define strict bounded server configuration validation and secret
   indirection. Add, enable, disable, remove, and inspect flows without
   exposing raw credentials.

   **Implemented as file-based flows, because Cycle 6 has no settings surface**
   (C6-I024). Server definitions live in `mcp.json` beside the resolved Aside
   configuration; adding, enabling, disabling, and removing are edits to that
   file, and `enabled` / `trust_acknowledged` are separate fields so a
   definition that has been written but not acknowledged stays inert. Removing
   or disabling a server drops its tools on the next run, and the connection is
   closed by the controller. There is no in-app configuration UI this cycle,
   and the plan does not claim one: what is delivered is the validated contract
   and the lifecycle, which is what a UI would drive.
3. Implement connection lifecycle: initialize, negotiated capability check,
   tool-list pagination, refresh, health/failure state, timeout, cancellation,
   disconnect, and teardown on application/task/config transitions as chosen.
4. Build `createMcpTools()` (or equivalent) as a thin transport-to-registry
   adapter. It must not become a parallel agent loop, permission broker, or
   workspace authority.
5. Implement deterministic namespacing and supported JSON Schema conversion.
   Bound tool count, name/description/schema size, nesting, unions/enums, and
   total provider-context cost. Reject rather than loosely reinterpret unknown
   validation semantics.
6. Define user/trusted classification UX and storage for effect, scope, egress,
   replay, and enablement. Invalidate classification when material server/tool
   identity or schema changes.
7. Route each call through P0 policy and exact permission when required.
   Denial must occur before `tools/call` is sent. The preview identifies server,
   tool, boundary, and bounded arguments without secrets.
8. Explicitly handle local file-looking tools: unless an Aside-owned adapter
   can enforce workspace scope, describe them as external trusted-server calls
   and never claim containment.
9. Normalize MCP text and structured content. Define conservative treatment of
   images, audio, embedded resources, resource links, binary blobs, and
   annotations; unsupported/oversized content is omitted or rejected with a
   bounded reason.
10. Propagate cancellation and timeout, produce exactly one terminal Aside tool
    result, and forbid automatic replay of unknown/non-replayable effects.
11. Isolate startup, schema, call, malformed-frame, disconnect, crash, and
    teardown failures by server. Built-in registry construction and the Pi
    conversation must continue.
12. Reject or disable resources, prompts, sampling, elicitation, roots used as
    authority, and server-initiated model requests. Prove they cannot inject
    model context or initiate a tool call.
13. Create an in-repository faux MCP server/transport fixture supporting
    discovery, paginated tools, success, error, delay/cancel, malformed schema,
    oversized output, hostile descriptions, unsupported content, crash, and
    forbidden feature requests — **and specifically reproducing the adversarial
    shapes recorded in "Verification Approach and Its Limit"**: `anyOf` unions
    of `number` and `string` with defaults, descriptions that contradict the
    tool's behavior, a tool accepting an arbitrary URL, string-to-number
    coercion by custom validator, and a server that spawns child processes.
    Write these fixtures with the SDK, so the faux server speaks correct
    protocol even while misbehaving.
14. Add integration tests for multiple servers, collisions, configuration
    changes, classification invalidation, permission denial before send,
    cancellation, timeout, server isolation, secret redaction, result bounds,
    transcript persistence, and no shell exposure.
15. Add the enforcement test the subprocess invariant requires: prove that no
    model-reachable path can add, change, enable, disable, or launch a server,
    and that a server process is spawned only from user configuration.
16. Record, in the verification section below, exactly what the faux suite does
    **not** cover because no third-party server is exercised at runtime. Do not
    let fixture coverage be reported as field validation.

## Deliverables

- MCP SDK/transport and capability-scope decision record, with the measured
  dependency closure.
- Validated user server configuration and lifecycle manager.
- `createMcpTools()` registry adapter with namespacing/schema bounds.
- Trusted classification and exact permission integration.
- Bounded MCP content normalization and failure isolation.
- A faux server carrying adversarial fixtures derived from an observed
  third-party server, plus integration/privacy tests.
- A recorded statement of what the fixtures do not cover.

## Exit Criteria

- C6-31 connects a valid server and exposes only successfully adapted,
  namespaced, enabled tools.
- C6-32 rejects malformed/oversized/unsupported/colliding definitions without
  affecting built-ins or other servers.
- C6-33 validates arguments and enforces trusted multidimensional policy before
  transport invocation.
- C6-34 proves risky/unknown calls require exact permission and denial sends no
  call.
- C6-35 proves server annotations and local path arguments cannot claim or
  bypass workspace containment.
- C6-36 bounds/sanitizes all supported results and excludes raw frames/secrets.
- C6-37 proves timeout/disconnect/cancel produce one result and no unsafe
  replay.
- C6-38 proves unsupported MCP capabilities cannot enter model state or
  trigger model work.
- C6-39 proves one server failure leaves conversation, built-ins, and other
  servers usable.

C6-26 through C6-30 are **retired**, not owed here; see the Scope Note.

## Checks

Run the faux MCP suite with no external network, registry/policy/protocol/
session tests, repeated crash/cancel/teardown runs, and the full quality gate.
Then perform one manually configured server smoke test on Windows, inspect the
provider-visible tool schema and permission event, then remove or disable it
and verify the tools disappear.

**The smoke target is `@modelcontextprotocol/server-everything`**, the MCP
project's own reference server. It is pure JS, needs no credential, does not
scrape, installs from npm, and deliberately exercises the whole protocol
surface — including the server-initiated requests task 12 requires us to
refuse, which makes it a better probe of that requirement than a well-behaved
server would be.

It is a **manual development-time smoke target only**. It is not bundled, not
default-configured, and not named in the system prompt or in any tool
description. Aside ships no server.

Record the connection flow, the adapted tool schema, and the permission card.
Record no credential and no full raw payload in the evidence.

## Verification

Record after implementation:

- SDK version, license, protocol revision, chosen transport, and disabled
  protocol capabilities;
- the measured dependency closure and what it implies for C6-I017;
- configuration/secret boundary and risk-classification behavior;
- sample adapted schema and normalized results, including how an `anyOf` union,
  a `format` annotation, and a contradicting description were handled;
- faux/full test and repeated lifecycle results;
- **explicitly, what the fixture suite does not cover**, since no third-party
  server is exercised at runtime;
- redacted manual smoke evidence against `server-everything` and proof of tool
  removal.

For the P7 audit, keep the distinction between what was **proven by execution**
against the SDK and what was read and believed. C6-I029 records the behaviors
that were established by probing; anything not in that list, or not covered by
a test, should be treated as unverified during the audit rather than assumed.
C6-I027 and C6-I028 record the two decisions that came out of that probing and
changed the implementation.
