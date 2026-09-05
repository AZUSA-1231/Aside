# P2 - Capability Registry and Bounded Read Tools

Status: planning
Depends on: P1 - Task Run and Workspace Boundary
Unblocks: P3 - Permission-Gated Writes and Verification
Source requirements: Cycle 5 PRD sections 4, 5, 6, 9, 11, and 16.3/16.6

## Outcome

Publish a per-TaskRun registry of typed, bounded workspace tools and implement
the read-only vertical slice. The first supported document representations are
bounded UTF-8 text, including Markdown, and JSON. Unsupported binary formats
return a typed result and never fall through to shell execution or generic
unsafe parsing.

The registry is the capability boundary. A tool hidden from the UI but still
present in the model context is not considered disabled.

## Registry Contract

Each entry must carry a unique name, model description, validated parameter
schema, effect (`read`, `write`, or `external`), scope, implementation,
replay policy, and display metadata. Registry construction rejects duplicate
names, malformed schemas, missing effect/scope data, and implementations with
no execution boundary.

The initial read tools are:

| Tool | Effect | Scope | Purpose |
| --- | --- | --- | --- |
| `workspace.list` | read | workspace | List bounded children of an explicitly requested directory |
| `workspace.search` | read | workspace | Search names or bounded text content after an explicit call |
| `workspace.stat` | read | workspace | Return bounded file/directory metadata |
| `workspace.read` | read | workspace | Read bounded UTF-8 text or supported JSON content |

`workspace.write` and `workspace.edit` are registered and gated in P3. No
shell, process, code, browser, host, or network tool is registered here.

Pi-full's harness and coding-agent read tools are references for bounded
line/byte output, offsets, image or unsupported-format handling, and truthful
truncation details. Their fixed-cwd tool definitions must not be copied as-is:
the implementation must call P1's environment and preserve the Aside-owned
`workspace.*` names and registry metadata.

## Tasks

1. Implement the Aside registry and tool descriptors from P0. Validate tool
   schemas before exposing the per-run list to Pi.
2. Build all read tools on P1's execution environment. Revalidate the root,
   target path, type, size, and task-run state at execution time.
3. Bound directory entries, search files/results, bytes read, JSON expansion,
   output text, and active duration. Use the reviewed head/line truncation
   behavior where it fits, and include an explicit truncation result. Do not
   pre-index or read neighboring files without a model tool call.
4. Add a document adapter seam that declares format, read/write support,
   version/size limits, extraction behavior, and validation errors. Implement
   plain UTF-8 text/Markdown and JSON first; report binary and unsupported
   structured formats honestly.
5. Return stable tool results with resolved product path, status, bounded
   content/metadata, truncation state, and typed errors. Redact credentials,
   native details, and unbounded diagnostics.
6. Ensure malformed tool arguments and unavailable capabilities become model
   tool results without filesystem effects. Keep UI display metadata separate
   from provider content.
7. Add faux filesystem tests for list, search, stat, read, unsupported format,
   limits and truncation, path escape, missing target, target replacement, and
   cancellation.

## Deliverables

- Validated per-run capability registry.
- Bounded `workspace.list`, `workspace.search`, `workspace.stat`, and
  `workspace.read` implementations.
- Text/Markdown and JSON adapter seam with explicit unsupported behavior.
- Structured read results and limit/error taxonomy.
- Deterministic registry, tool, boundary, and privacy tests.

## Exit Criteria

- C5-13 through C5-18 pass for the initial read registry.
- C5-14 read operations do not prompt for write permission and never mutate
  the workspace.
- C5-15 neighboring reads require explicit bounded tool calls; there is no
  hidden snapshot or automatic indexing.
- C5-16 unsupported formats return a typed result with no shell/process
  fallback.
- C5-17 invalid arguments and C5-18 limit violations have no effect and keep
  the run cancellable.
- C5-31 can read and summarize a supported text or JSON document from bounded
  tool output.

## Checks

Run runtime faux-provider/tool tests, typecheck, and the complete Rust test
suite. Inspect the active tool list in a test TaskRun and confirm every entry
has all required effect, scope, replay, and display fields.
