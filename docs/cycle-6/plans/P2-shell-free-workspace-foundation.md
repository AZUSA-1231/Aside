# P2 - Shell-Free Workspace Foundation

Status: implemented 2026-09-17; R3 automated policy review and Windows synthetic benchmark completed 2026-10-31; manual evidence remains deferred
Depends on: P0 - Capability Contract and Policy Plane; P1 - Context-to-Workspace Automatic Handoff
Unblocks: P3, P4, and P7
Source requirements: PRD sections 3.1, 5, 6, 12 through 15, C6-09 through C6-14, and C6-42

**R3 follow-up (2026-10-31):** [integration evidence](../R3-INTEGRATION.md)
and [Windows measurements](../R3-BENCHMARK.json) now cover the previously
unreviewed UTF-8 / literal-query / no-ignore / case behavior and the synthetic
32 / 512 / 2048-file benchmark. `mode: both` now retains matching PDF/Word names
while reporting skipped content. No glob, ignore-file, or extra text-encoding
feature was added. Historical deferrals below describe the P2 implementation
date; desktop/manual acceptance remains unperformed.

## Outcome

Make Aside's structured file tools sufficiently complete and predictable that
routine workspace work does not need a shell. Preserve the Cycle 5 workspace
and exact-write guarantees while improving pagination, search, encoding,
errors, schemas, tool guidance, and verification for iterative model use.

This is not coding-agent CLI parity. The outcome is a fluent structured
workspace API under Aside's product boundary.

## Foundation Surface

| Tool | Cycle 6 expectation |
| --- | --- |
| `workspace.list` | Bounded entries, stable ordering, useful metadata, explicit continuation |
| `workspace.search` | Name/content modes, bounded traversal, reviewed ignore/glob behavior, result locators |
| `workspace.stat` | Product path, kind, size/version identity, adapter availability |
| `workspace.read` | Format routing, offsets/ranges, encoding policy, explicit truncation |
| `workspace.write` | Exact create/replace preview, atomic once-only write, verification |
| `workspace.edit` | Inspectable deterministic replacement, stale check, verification |

No tool accepts an arbitrary command, executable, script, interpreter, or
environment-variable expansion.

## Tasks

Review baseline (2026-09-16): list has no cursor; read loads the whole bounded
file before selecting lines. A 30,000-byte single-line fixture returns 24,064
content bytes, truncated=true, and no next_offset. Fix this reproduced gap
before adding new formats; never advance past bytes not actually returned.

1. Evaluate the current schemas/results against representative model traces:
   inspect a directory, locate a file, read a long file in segments, search a
   nested workspace, edit one occurrence, create an output, and recover from a
   stale or unsupported target.
2. Define compatible result envelopes with product-relative paths, resolved
   identity, counts, truncation, stable continuation cursor/offset, warnings,
   and typed failure codes. Cursors must not contain authority or raw handles.
3. Improve list semantics: deterministic ordering, entry-kind metadata,
   bounded pagination, cancellation, hidden-file policy, and explicit behavior
   for inaccessible or changing directories.
4. Improve read semantics: byte/line or document-locator ranges, stable next
   position, encoding detection limited to deliberately supported encodings,
   newline handling, binary routing, and changed-target detection between
   segments.
   Cover one oversized line, multibyte UTF-8 at the boundary, and truncation
   partway through a multi-line range. Iterating continuation must reconstruct
   the requested content without gaps/duplication; reject changed identities.
   List/search continuation must likewise be explicit and deterministic.
5. Review search implementation and dependencies for path globs, ignore rules,
   case behavior, supported text encodings, maximum files/depth/bytes/results,
   cancellation, and Windows performance. Use an in-process library or owned
   implementation; never spawn `grep`, `rg`, PowerShell, or another process.
6. Improve stat metadata only where it helps model decisions and stale
   validation. Do not expose native handles, ACL dumps, or unbounded extended
   attributes.
7. Reuse the existing permission broker for write/edit. Ensure previews are
   exact and bounded, target identity is revalidated, replacement is atomic,
   cancellation stops before effect where possible, and verification results
   do not overclaim content equivalence.
8. Audit tool descriptions for direct, correct model use. Make relative paths,
   continuation, supported formats, and failure recovery clear without adding
   hidden policy instructions to user content.
9. Ensure all known unsupported binary/document formats route to adapters or
   return `unsupported`; no format may fall through to text corruption or a
   process converter.
10. Add deterministic faux/temporary workspace tests for pagination, long
    reads, search limits, encodings, separators/case, reparse escape,
    replacement races, cancellation, atomic writes, verification, and every
    failure family.
11. Add an explicit registry assertion that no shell, process, code, terminal,
    generic fetch, or deferred domain tool is present.

## Deliverables

- Refined six-tool workspace schemas and normalized results.
- Stable pagination/continuation and target identity behavior.
- Reviewed in-process search and encoding policy.
- Preserved exact-operation permission, atomic mutation, and verification.
- Comprehensive no-fallback and boundary test coverage.

## Exit Criteria

- C6-09 and C6-10 prove a model can list, locate, read in segments, and search
  without redundant full reads or path ambiguity.
- C6-11 preserves lexical and canonical workspace containment on Windows.
- C6-12 proves each supported mutation is previewed, approved once,
  revalidated, executed atomically, and verifiable.
- C6-13 proves unsupported formats/encodings never reach shell, process, or a
  guessed parser.
- C6-14 proves all tools stop within their configured bounds and remain
  cancellable.
- C6-42 proves the provider-visible registry has no shell or deferred tool.
- Representative faux-model traces complete routine file tasks without asking
  for manual path mechanics or proposing terminal commands.

## Checks

Run the focused workspace read/write/environment suites repeatedly to expose
ordering and timestamp races, then the full quality gate. Benchmark a small,
medium, and deliberately over-limit synthetic workspace on Windows and record
observed duration/output bounds without turning benchmarks into brittle unit
thresholds.

## Verification

### Result (2026-09-17)

Full gate: `typecheck` pass; `build` pass; `runtime:test` **164/164** (155 after
P1, 9 new); `cargo fmt --check` pass; `cargo test` 30/30; `git diff --check`
clean.

**The reproduced continuation gap is closed.** `workspace.read` now reports
`next_byte_offset` whenever it truncates, defined as *the byte immediately after
the last byte actually returned*. A caller looping on it reconstructs a 30,000
byte single-line file byte-exactly, with no gap and no duplication — the case
that previously returned 24,064 content bytes, `truncated: true`, and no way to
continue. `offset_bytes`, `total_bytes`, and `content_bytes` are reported so the
position is unambiguous.

**Byte continuation cannot split a character.** The offset is resolved by
advancing past any character straddling the boundary rather than retreating, so
a continuation never re-delivers bytes the caller already has. A multibyte
fixture reconstructs with no replacement characters and an exact byte count.

**Line and byte continuations agree.** `selectLines` now slices the original
text and keeps the terminating newline when more lines follow, instead of
re-joining. The returned text is then exactly the file's bytes for those lines,
so `next_offset` and `next_byte_offset` describe the same position. Previously
the line path dropped the newline, which made byte-exact reconstruction
impossible across segments.

**Directory listing is deterministic and pageable.** Entries are ordered by
name before slicing, because readdir order is filesystem-dependent and a cursor
over an unstable order is meaningless. `workspace.list` takes `offset` and
returns `next_offset`, `total_entries`, and `offset`; paging a six-entry
directory at `limit: 2` yields every entry exactly once in the same order as an
unpaged read. An offset past the end is an empty page rather than an error; a
negative offset is `invalid_offset`.

**C6-42 is asserted on the provider-visible list, over Aside's own registry.**
The check reads `agent.state.tools` while the run is live, not the registry
description, and requires no name matching
`shell|powershell|terminal|cmd|bash|process|exec|spawn|fetch` and no placeholder
for a deferred capability.

**What that assertion does and does not cover — added 2026-09-19.** It is a
statement about the capabilities **Aside registers**. It is not, and cannot be,
a statement that no registry a user could assemble is free of execution paths:
after P6 a connected MCP server contributes tools whose names and behaviour come
from that server, and a server may name a tool anything, including `shell.exec`.

Aside's actual promise is narrower and defensible: it registers no such
capability itself, and it describes adapted tools honestly as external code it
does not sandbox ([C6-I006](../ISSUES.md)). Reading the regex assertion as
"no user MCP server can execute a shell" would claim a property Aside cannot
enforce and never claimed. The independent audit flagged this over-reading.

**No process or network path exists — on the first-party execution path, as of
P2.** `child_process`, `spawn`, `execFile`, `fork`, and `fetch` do not appear
under `agent-runtime/src/` or its skills; search is owned in-process.

**Scope corrected 2026-09-19** by the independent audit. That statement was
true when written (2026-09-17) and is **no longer a statement about the runtime
as a whole**. P6 added a user-configured MCP transport, which spawns a process:
the symbols still do not appear in `agent-runtime/src`, because the spawn happens
inside `@modelcontextprotocol/sdk` via `cross-spawn`, but a process is started
all the same.

The distinction that makes the claim still worth keeping: **Aside's own
capability implementations** still execute no process and open no socket. What
changed is that the runtime can now start a program the *user* configured, which
is a different trust boundary that [C6-I006](../ISSUES.md) already records and
[C6-I027](../ISSUES.md#c6-i027---windows-shell-routing-is-refused-in-mcp-server-configuration)
tightened. Reading this line as "the runtime spawns nothing" would be wrong.

### Deferred at P2 implementation (historical)

At the P2 implementation date these tasks were **not** done. The dated R3
follow-up above supersedes the review and benchmark gaps; it does not close
the separately deferred manual evidence:

- **Task 4 (encoding policy)** — reading is UTF-8 with a fatal decoder, so an
  unsupported encoding already returns `unsupported_encoding` rather than
  guessing. "Deliberately supported encodings" beyond UTF-8 is P4's concern,
  which introduces a real document format.
- **Task 5 (search review)** — no dependency was added and no process is
  spawned, so the dependency gate is satisfied by *not* taking a dependency.
  Globs, ignore rules, and case behaviour are unchanged from Cycle 5 and were
  not re-reviewed.
- **Tasks 6, 7, 8, 9** — stat metadata, write/edit permission, descriptions,
  and unsupported-format routing are unchanged from Cycle 5, which already
  satisfies them; P3 and P4 are where new formats make them live again.
- **The Windows benchmark** in Checks has not been run. It is M2 evidence and
  belongs with the manual trace.
