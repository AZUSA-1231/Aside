# Cycle 6 Acceptance Matrix

**2026-10-31 follow-up:** [R2 automated recheck](./R2-RECHECK.md) and [current evidence](./R2-EVIDENCE.json) record A01-A12 checks and the additional A07/A08/A10 fixes. Historical counts and findings below retain their dated scope. Manual acceptance and release remain deferred; no criterion is closed solely by this follow-up.

**R3 automated integration (2026-10-31):** [R3-INTEGRATION.md](./R3-INTEGRATION.md)
adds 9 runtime flows/reviews and 4 native focus-state regressions; gates are
388 runtime / 45 Rust / 23 frontend plus build. P2/P3/P4 evidence below is
supplemented without changing the manual column or declaring acceptance.

**R4 follow-up (2026-10-31):** [runtime evidence](./R4-RUNTIME.md) supplements
C6-33/34 with persisted double bindings, conservative fallback, launch/schema
change invalidation, and warning projection. Final automated gates are 394
runtime and 24 frontend tests plus build. The original manual column remains
unperformed; RT-01–11 development completion does not close cycle acceptance.

Owner: P7 ([task 11](./plans/P7-surface-and-release.md))
Status: **matrix assembled; acceptance blocked by independent audit and unperformed manual evidence** (2026-09-19)
Runner for the manual column: [`MANUAL-ACCEPTANCE.md`](./MANUAL-ACCEPTANCE.md)

Audit override: [C6-I035](./ISSUES.md#c6-i035---passing-gates-do-not-establish-cycle-acceptance)
and [AUDIT-REPORT.md](./AUDIT-REPORT.md) record retained failures despite the
passing gate. The rows below are the pre-audit evidence map, not blanket pass
decisions. A named passing test does not close a criterion contradicted by an
open audit finding.

**G03 reconciled 2026-09-19.** The audit found the summary disagreeing with the
rows below it. Two rows (C6-09, C6-13) carried a manual reference while being
marked automated-only, and the suite size in C6-43 was stale. The summary is now
**derived from the rows** rather than maintained alongside them, which is what
let it drift. Reconciling the numbers alone would have left the same failure
available next time.

This links every C6-01 through C6-45 criterion to the evidence that would close
it. It is the record; the manual checklist is the working copy.

**Read the status line literally.** The matrix is assembled — every criterion
has a named evidence source or a recorded reason it has none. The automated
column is real: those tests exist and pass today (**365** runtime tests, 37 Rust
tests, verified 2026-09-23). The **manual column has not been performed**, and
no row may be marked closed on the strength of this document alone.

**Count corrected 2026-09-23.** The figure was 328, which was right when P7's
task 12 recorded its repeated-gate evidence and stale thereafter. The six P1
fixes and six P2 fixes each added regression tests and nothing recomputed the
total — the same class of drift G03 already corrected once, in this same
document, which is why it is noted rather than quietly overwritten.

**Cycle 6 is not released, and this matrix does not decide that.** It records
whether the cycle's own criteria have evidence. The [PRD release boundary](./PRD.md#19-release-boundary)
is not yet met: the independent audit has open findings and required manual
evidence is missing. Packaging and installed-application support are deferred
([C6-I034](./ISSUES.md#c6-i034---p7-was-over-broad-packaging-and-surface-quality-move-to-cycle-7)).

## Summary

Derived from the rows below, not maintained by hand. An earlier version was
written separately and had drifted out of agreement with them, which the
independent audit caught as G03. Recompute it rather than editing it.

| Disposition | Count | Criteria |
| --- | --- | --- |
| Automated evidence, no manual step | 14 | C6-01, C6-02, C6-03, C6-04, C6-05, C6-10, C6-11, C6-14, C6-15, C6-19, C6-32, C6-35, C6-36, C6-43 |
| Automated **and** manual | 24 | C6-06, C6-07, C6-08, C6-09, C6-12, C6-13, C6-16, C6-17, C6-18, C6-20, C6-21, C6-22, C6-23, C6-24, C6-25, C6-31, C6-33, C6-34, C6-37, C6-38, C6-39, C6-41, C6-42, C6-44 |
| **Manual only** | 2 | C6-40, C6-45 |
| **Retired** | 5 | C6-26 through C6-30 |
| Cycle 5 criteria carried in | 26 | see `MANUAL-ACCEPTANCE.md` Part A |

A criterion appears in the manual column when the checklist has an item for it.
That is a statement about the shape of the evidence, not about whether the item
has been performed — nothing in the manual column has been performed.

## Evidence rules

- A criterion is **closed** when its automated evidence passes **and**, where the
  manual column is populated, the observation is recorded in the checklist.
- A criterion with a named test is closed by that test. A criterion naming a
  whole suite is closed by the suite passing, and says so rather than borrowing
  a specific test's name.
- **No criterion may be closed by inspection of this document.** Reading that a
  test exists is not the same as the test having been run against the build
  being released; the run record in the checklist carries the counts.
- Where an item did not behave as the criterion describes, that is a finding for
  [`ISSUES.md`](./ISSUES.md) and the criterion stays open.

---

## P0 — Planes, registry, policy, trust, cancellation

| ID | Scenario | Evidence | Manual | Status |
| --- | --- | --- | --- | --- |
| C6-01 | Capture context without invoking a tool | `capability-runtime.test.mjs`: *C6-01: a context snapshot cannot register or invoke a capability* | — | automated |
| C6-02 | Inspect an active task registry | `capability-contract.test.mjs`: *C6-02: every descriptor carries every contract dimension*; `capability-runtime.test.mjs`: *publishes the full contract on the run registry without trusted ids* | — | automated |
| C6-03 | Disable a capability | `capability-runtime.test.mjs`: *C6-03: an unavailable capability is absent and cannot run*, *C6-03: the same capability becomes available once a workspace resolves*; `capability-policy.test.mjs`: *C6-03: an unresolved prerequisite is unavailable with its own reason*, *C6-03: an unregistered tool is unavailable and never allowed* | — | automated |
| C6-04 | Tool content attempts to change policy | `capability-policy.test.mjs`: *C6-04: a hostile description cannot change the decision*, *C6-04: conflicting metadata fails before it can reach the evaluator*; `mcp-adapter.test.mjs`: *hostile tool descriptions stay data and do not change policy* | — | automated |
| C6-05 | Cancel an active operation | `capability-runtime.test.mjs`: *C6-05: cancelling a pending permission yields one terminal result*; `permission-broker` coverage in `capability-permission.test.mjs`: *settles expiry and cancellation exactly once* | — | automated |

## P1 — Descriptor resolution and workspace binding

| ID | Scenario | Evidence | Manual | Status |
| --- | --- | --- | --- | --- |
| C6-06 | Summon on a validated file descriptor | `workspace-handoff.test.mjs`: *C6-06: binds a captured directory and its selected file together*, *binds identically whichever order the host reports the descriptors* | B1-a, B1-b | automated + manual |
| C6-07 | Summon on a validated directory/workspace descriptor | `workspace-handoff.test.mjs`: *C6-07: a directory descriptor alone becomes the workspace root*, *a bare file descriptor keeps its containing directory as the root* | C5-07 | automated + manual |
| C6-08 | Descriptor is stale, inaccessible, or ambiguous | `workspace-handoff.test.mjs`: *C6-08: refuses to guess between competing roots or targets*, *C6-08: rejects stale, missing, and mismatched captures without guessing*, *rejects a target captured outside its own root*, *C6-08: an ambiguous capture is recoverable, not a failed run* | B1-c, B1-d | automated + manual |

## P2 — Workspace foundation

| ID | Scenario | Evidence | Manual | Status |
| --- | --- | --- | --- | --- |
| C6-09 | List/read/search/stat an in-workspace resource | `workspace-tools.test.mjs`: *C6-09: lists entries in a stable order with an explicit cursor*, *C6-09: paging a directory yields every entry exactly once*, *C6-09: line ranges and byte ranges agree about where content resumes*; `recovery-integration.test.mjs`: INT-01 literal/case/encoding review and binary-name matches; [Windows synthetic benchmark](./R3-BENCHMARK.json) | C5-14 | automated + manual |
| C6-10 | Read or search requires continuation | `workspace-tools.test.mjs`: *C6-10: a truncated long line can be continued without losing bytes*, *C6-10: byte continuation never splits a multibyte character* | — | automated |
| C6-11 | Path escapes through syntax, symlink, or reparse point | `workspace.test.mjs`: *rejects lexical escapes and symlink targets outside the workspace* | — | automated |
| C6-12 | Write or edit a supported text resource | `workspace-write-tools.test.mjs`: *write and edit prepare exact previews and execute only after allow*, *JSON writes require parse validation and report verified content* | C5-19, C5-21, C5-32 | automated + manual |
| C6-13 | Unsupported file or encoding is encountered | `workspace-tools.test.mjs`: *returns typed unsupported, scope, missing, limit, and cancellation results*; `recovery-integration.test.mjs`: INT-01 UTF-8 refusal and INT-02 PDF edit refusal before approval | C5-16 | automated + manual |
| C6-14 | Foundation tool hits input, output, time, or traversal limit | `capability-runtime.test.mjs` limit coverage (*tool limits fail closed with one terminal event*), `workspace-write-tools.test.mjs`: *an approved write reports an underlying atomic failure without claiming success* | — | automated |

## P3 — Document representation and PDF

| ID | Scenario | Evidence | Manual | Status |
| --- | --- | --- | --- | --- |
| C6-15 | Read a supported document | `workspace-tools.test.mjs`: *C6-15: a declared adapter takes precedence over the unsupported guard*, *C6-15: a structured adapter returns blocks without a text field*; `pdf-adapter.test.mjs`: *C6-15: extracts ordered, located blocks from a real PDF* | — | automated |
| C6-16 | Read selected PDF pages | `pdf-adapter.test.mjs`: *C6-16: a page range reads only the requested pages*; `workspace-tools.test.mjs`: *C6-16: the read tool renders PDF pages with a page continuation*; `recovery-integration.test.mjs`: INT-02 provider-visible summary/page references and public-cursor continuation | C6-16 | automated + manual |
| C6-17 | Read a scanned, encrypted, malformed, or text-poor PDF | `pdf-adapter.test.mjs`: *C6-17: a scanned, text-poor PDF is refused rather than reported as empty success*, *C6-17: partial extraction reports the missing pages instead of hiding them*, *C6-17: encrypted, malformed, and non-PDF inputs fail with typed codes*; `recovery-integration.test.mjs`: INT-02 missing-text warnings precede final output | C6-17 | automated + manual |
| C6-18 | Ask to edit a PDF | `workspace-tools.test.mjs`: *C6-18: PDF is read-only and no write path can claim it*; `recovery-integration.test.mjs`: INT-02 runtime refusal, no approval, source unchanged (C6-I037) | C6-18 | automated + manual |
| C6-19 | Oversized/complex PDF exceeds policy | `pdf-adapter.test.mjs`: *C6-19: excessive page counts and page ranges are bounded*, *C6-19: cancellation stops parsing rather than only the await*, *C6-19: a block ceiling bounds extraction and warns* | — | automated |

## P4 — Word

| ID | Scenario | Evidence | Manual | Status |
| --- | --- | --- | --- | --- |
| C6-20 | Read an ordinary `.docx` | `docx-adapter.test.mjs`: *C6-20: reads common .docx structure in document order*; `recovery-integration.test.mjs`: INT-03 existing-Word summary receives headings and table cells | C6-20 | automated + manual |
| C6-21 | Read encrypted, malformed, legacy, or macro-enabled Word input | `docx-adapter.test.mjs`: *C6-21: legacy, encrypted, macro, and non-Word inputs are refused* | C6-21 | automated + manual |
| C6-22 | Create a new Word document | `docx-tools.test.mjs`: *C6-22: creates a valid .docx and verifies it by reopening*; `capability-runtime.test.mjs`: *C6-22: a document capability runs through the policy and permission path*, *C6-22: a denied document decision writes nothing* | C6-22 | automated + manual |
| C6-23 | Transform an existing Word document | `docx-tools.test.mjs`: *C6-23: transforms to a new path and leaves the source untouched*; `recovery-integration.test.mjs`: INT-03 fidelity-warning workflows, allow/deny preview, source bytes, output reopen and verification | C6-23 | automated + manual |
| C6-24 | Request same-path replacement or existing Word output overwrite | `docx-tools.test.mjs`: *C6-24: refuses same-path replacement without touching the file*, *C6-24: refuses existing-output overwrite and preserves both files*, *C6-24: an output that appears after approval is refused, not overwritten* | C6-24 | automated + manual |
| C6-25 | Unsupported Word features are present | `docx-adapter.test.mjs`: *C6-25: unsupported features are surfaced as bounded warnings*; `docx-tools.test.mjs`: *C6-25: an invalid specification is refused before any permission*; `recovery-integration.test.mjs`: INT-03 warnings in actual provider content and permission preview | C6-25 | automated + manual |

## P5 — Web Search: retired

C6-26 through C6-30 were written against a `web.search` capability. Web Search
was removed from Cycle 6 on 2026-09-18
([C6-I026](./ISSUES.md#c6-i026---web-search-leaves-cycle-6-entirely)) and these
criteria are **retired**, not deferred. No row here is owed, and P7 must not
list them as unmet. Their intent survives as
[PRD section 10.2](./PRD.md) requirements for any future search capability; the
live MCP equivalents are named in [PRD section 18.5](./PRD.md).

## P6 — MCP adapter

| ID | Scenario | Evidence | Manual | Status |
| --- | --- | --- | --- | --- |
| C6-31 | Add and enable a valid MCP server | `mcp-runtime.test.mjs`: *loads and validates a server definition*, *a run's registry contains both built-in and connected tools*; `mcp-adapter.test.mjs`: *adapts a server's tools into namespaced descriptors Aside owns* | C6-31, B4-a, B4-b, B4-c | automated + manual |
| C6-32 | MCP schema is oversized, malformed, unsupported, duplicated, or reserved | `mcp-schema.test.mjs` (22 tests covering `$ref`, conditional and structural keywords, depth, property, enum, variant, and byte bounds); `mcp-adapter.test.mjs`: *a schema Aside cannot accept costs that tool and nothing else*; `capability-contract.test.mjs`: *reserves built-in namespaces against extensions only* | — | automated |
| C6-33 | Invoke a classified MCP tool | `mcp-adapter.test.mjs`: *call arguments are validated before anything is sent*, *an allowed call is sent, and only after the decision* | C6-33 | automated + manual |
| C6-34 | Invoke an unknown-risk, write, execute, host, service, or egress MCP tool | `mcp-adapter.test.mjs`: *an unclassified external tool gets the most cautious classification*, *a denied call sends nothing to the server* | C6-34, C6-34b | automated + manual |
| C6-35 | MCP claims a local file operation is safe | `mcp-adapter.test.mjs`: *a server cannot talk its way out of permission* | — | automated |
| C6-36 | MCP returns oversized, malformed, binary, or sensitive content | `mcp-result.test.mjs` (15 tests: block bounding, image/audio/binary omission, annotation dropping, structured bounds, malformed refusal); `mcp-adapter.test.mjs`: *server results are bounded and carry their omissions*, *a result carrying a secret is bounded and never reaches details raw* | — | automated |
| C6-37 | MCP call times out, disconnects, or is cancelled | `mcp-client.test.mjs`: *a call that exceeds its timeout fails rather than hanging*, *cancellation reports as cancelled, not as a server failure*, *a server that crashes mid-call fails that call and the connection*; `mcp-adapter.test.mjs`: *a cancelled call produces exactly one terminal result* | C6-37 | automated + manual |
| C6-38 | MCP requests resources, prompts, sampling, or server-initiated model behavior | `mcp-client.test.mjs`: *refuses every server-initiated request the client does not declare* (asserts `-32601` for sampling, roots, and elicitation) | C6-38 | automated + manual |
| C6-39 | MCP server fails during startup or runtime | `mcp-client.test.mjs`: *a server that cannot be started fails at connect with a typed error*; `mcp-adapter.test.mjs`: *a server that will not start leaves other servers and built-ins alone*, *a server that will not list contributes a diagnostic and no tools* | C6-39 | automated + manual |

## P7 — Surface, regression, release

| ID | Scenario | Evidence | Manual | Status |
| --- | --- | --- | --- | --- |
| C6-40 | Observe a representative task in the Side rail | **None.** At Cycle 6 the surface was verified only by `tsc` and `vite build`, which prove it compiles and not that it is legible; see [C6-I031](./ISSUES.md#c6-i031---the-react-surface-has-no-automated-verification). Cycle 7 adds a frontend runner, which will give this criterion an automated half for the first time — but a component assertion is not the observation this criterion asks for. | C1 (7 items) | **manual only. Route resolved 2026-09-26 to [C7-LEGACY Option A](../cycle-7/LEGACY.md#resolved-option-a-2026-09-26): it runs against the feature-complete Cycle 7 revision, together with the P7 task 9 audits. Not yet performed, so this criterion still has no evidence and Cycle 6 remains blocked.** |
| C6-41 | Restore a durable session | `session.test.mjs`: *persists only bounded messages and restores no workspace, permission, or skill state*, *persists finalized messages and restores the active Aside session* | C6-41 | automated + manual |
| C6-42 | Inspect the complete model tool list | `capability-runtime.test.mjs`: *C6-42: the provider-visible registry exposes no shell or deferred tool*; `capability-policy.test.mjs`: *C6-I003: no shipped capability exposes shell, process, or execute*; **serialized evidence**: `p7-audit.test.mjs` audits the run registry *and the provider context* against the prohibited-name set with a server connected | C6-42, C6-42b | automated + manual |
| C6-43 | Run deterministic acceptance coverage | The full `runtime:test` suite (365 tests) exercised as a whole; the faux MCP server carries adversarial fixtures derived from an observed third-party server | — | automated |
| C6-44 | Exercise existing summon, capture, streaming, permission, session, and window flows | The ten Cycle 5 suites (97 tests), plus the 30 Rust tests. See "The Cycle 5 regression evidence" below for exactly which were touched and how. | Part A (26 items) | automated + manual |
| C6-45 | Complete representative Windows workflows | **None.** C6-45 is a statement about manual evidence, satisfied only by the checklist itself. | Part B | **manual only** |

## The Cycle 5 regression evidence, examined

The claim "Cycle 6 did not weaken Cycle 5" was checked against the history
rather than asserted, because it is the kind of claim that is easy to make and
hard to defend. Ten suites make up the Cycle 5 surface, totalling **97 tests**:

| Suites | Files | Cycle 6 commits |
| --- | --- | --- |
| Untouched | `runtime`, `session`, `config`, `workspace`, `skill-loader`, `skill-runtime` | 0 each |
| Touched | `protocol`, `agent-contracts`, `workspace-write-tools` | 1 each |
| Touched | `workspace-tools` | 2 |

Every change was inspected. **None weakens an assertion.** The four touched
files changed in three ways:

1. **Import moves.** `protocol`, `agent-contracts`, and `workspace-write-tools`
   had registry and result imports repointed at `capability-contract.mjs` and
   `capability-result.mjs` when P0 split those modules out. The assertions
   themselves are unchanged.
2. **Added assertions.** `protocol` gained a descriptor round-trip fixture
   proving the new capability dimensions survive the Tauri process boundary
   verbatim; `workspace-tools` gained assertions that the read description
   mentions `docx` and that the registry exposes the document tools.
3. **Fixture renames forced by new capability, and one tightening.**
   `workspace-tools` used `.docx` as its "unsupported binary" fixture, which
   stopped being unsupported when P4 landed; it now uses `.xlsx` and `.pptx`.
   The same file's description assertion was **strengthened**, not relaxed:
   `/read-only/i` became `/no images, no OCR/i` plus new `/docx/i` checks.

An earlier version of this matrix recorded "80 tests unedited". That was wrong
on both counts — the count was stale and four of the ten files had been
modified. It is corrected here rather than quietly dropped, because the
distinction between "unchanged" and "changed in ways that only add or tighten"
is exactly what the audit needs to see, and the weaker-sounding accurate claim
is the one that survives scrutiny.

## Serialized-evidence audits (P7 tasks 10 and 14)

`p7-audit.test.mjs` asserts the release properties against captured artifacts
rather than against reasoning, because P0 established that "UI appearance alone
does not prove registry absence or policy authority". What it inspects:

| Artifact | How it is obtained | What it proves |
| --- | --- | --- |
| Run registry | The serialized `run_started` payload | No prohibited capability, with a server connected; adapted tools are `user_mcp` and claim no containment or replay safety |
| Provider context | A faux response factory receives Pi's real `Context` | The tools handed to the provider layer equal the run's reported tools, and the system prompt describes connected tools as external and un-approved-by-default |
| Event stream | Captured from `emit` | A credential returned by a server is absent verbatim |
| Persisted messages | Captured from `onRunSettled` | No permission id, tool call id, canonical path, or descriptor |

**The limit of this evidence, stated plainly.** The provider *context* is
captured; the provider *HTTP request* is not, because that needs a network.
Pi's wire serialization was read instead: both the Anthropic and OpenAI paths
build each tool from `name`, `description`, and the parameter schema by explicit
field selection, with no spread that could carry the internal `descriptor`
along. That is a code-level finding, not a captured payload, and it is recorded
as such rather than presented as an interception.

The audit also produced a finding about the system rather than about the code:
its first version used a stub permission broker that answered "allow" without
producing a grant, and the runtime refused the result with
`permission_not_obtained`. See the correction under C6-I026 consequence 6 — the
grant-verification mechanism is live on the shipped MCP path, and it caught a
mistake made by someone who had just read the code.

## Criteria with no automated evidence

Stated here rather than buried, because a matrix that does not say this reads as
though everything is covered:

- **C6-40** — the surface has no test runner at all (C6-I031).
- **C6-45** — by construction; it *is* the manual pass.
- **C6-06 through C6-08, C6-16 through C6-25, C6-31, C6-33, C6-34, C6-37
  through C6-39, C6-41, C6-42** each have a specific part that only a real
  desktop can establish — a real Explorer capture, a real PDF, a real document
  opened in Word, a real server process. The automated half proves the contract;
  the manual half proves the contract meets the world.

## What this matrix does not claim

- **Field validation of the MCP adapter.** It is verified against a real child
  process, adversarial fixtures derived from an observed third-party server, and
  one manual smoke target. That is not the same as having been used against a
  range of third-party servers, and no row above claims it.
- **Installed-application evidence.** Not deferred-but-pending: **out of scope**
  as of 2026-09-19
  ([C6-I034](./ISSUES.md#c6-i034---p7-was-over-broad-packaging-and-surface-quality-move-to-cycle-7)).
  No packaged application is built this cycle and none was ever required by the
  [PRD's release boundary](./PRD.md#19-release-boundary), which is six items and
  mentions no installed application. Every criterion above was established on a
  development build, and that is the only kind of build this cycle produces.
- **Frontend interaction quality.** Accessibility, keyboard and focus, resizing,
  and text containment were assigned to P7 task 9 and are deferred by C6-I034.
  C6-40, which is a product criterion about legibility, is **not** deferred and
  remains in Part C1 of the checklist.
- **That Cycle 5 is released.** Its 26 manual criteria are carried in Part A and
  none has been performed.
