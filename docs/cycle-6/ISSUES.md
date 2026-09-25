# Cycle 6 Capability Runtime Issues

Status: active planning log
Source requirements: [Cycle 6 PRD](./PRD.md)
Execution index: [Cycle 6 PLAN](./PLAN.md)

This log records decisions and implementation discoveries that affect Cycle 6
scope, ownership, security, or acceptance. Child-plan progress and ordinary
task notes remain in the relevant `plans/P*.md` file.

## Independent Audit (2026-09-19)

### C6-I036 - Cancelling a PDF Read Was Dropped, Not Delayed

Status: **partially fixed; the remainder is a documented bound**
Discovered: 2026-09-22, producing the G01 responsiveness evidence
Affected: P3, P7; C6-05, C6-19, C6-44

#### Fact

G01 asked for evidence that the parse limits are enforceable rather than merely
declared. The audit warned that a `Promise.race` against a timer proves only
that the caller stopped waiting, and that no such evidence existed. Measuring
from outside the read — a heartbeat timer scheduled while the parse runs —
found something worse than "no evidence".

On a 300-page fixture:

| | Before |
| --- | --- |
| Event-loop turns during the parse | **0** |
| Parse duration | 256 ms |
| An abort issued 1 ms in | fired at **241 ms** |
| Read outcome | **succeeded**, 900 blocks |

The abort was not late. It was **dropped**. `setTimeout(abort, 1)` cannot run
until the loop is free, which is after the read has already returned; the
callback then fires with nothing left to cancel. `signal.aborted` is false for
the entire parse, so the `signal?.aborted` check inside the page loop — which
had been there since P3 — was unreachable. A user who cancelled a PDF read got
the document, and the terminal state said `completed`.

This is a live violation of C6-19 rather than a limitation of it. It was
invisible to the existing cancellation tests because those drive the injected
loader, which is a fake and yields normally.

#### Decision

The page loop yields to the event loop every `PDF_PAGES_PER_YIELD` (16) pages,
using `setImmediate` rather than `setTimeout(0)` — a timer phase on Windows is
coarse enough that waiting for it would cost more than the parse. The abort
check is repeated after each yield.

Measured after:

| | After |
| --- | --- |
| Event-loop turns during the parse | 5 |
| An abort issued during the page loop | delivered, read refuses with `aborted` |

**What this does not fix, stated plainly.** The document-loading phase before
the first page is not interruptible: measured at ~174 ms on the same fixture,
and no yield can happen inside `getDocument`. An abort issued in that window
still waits for it. The page loop was the unbounded part and is now bounded; the
loading phase is a fixed cost, not an unbounded one, and the honest claim is
"cancellation is delivered during page extraction, after at most one
document-load", not "cancellation is immediate".

A test asserts the current behavior of both halves, so the loading-phase bound
fails loudly if it is ever removed rather than silently persisting.

#### What this says about the evidence gap

G01 was recorded as "evidence missing" and treated as a documentation
obligation. Producing the evidence found a defect. That ordering is worth
noting: the item was on the list as something to *write up*, and it turned out
to be something to *fix*. An acceptance gap can be a bug that nobody has looked
at yet.

### C6-I035 - Passing Gates Do Not Establish Cycle Acceptance

Status: **open — acceptance blocked**
Audited revision: `e5e8a09eda581c4d202e843b9ca890c761890c81`
Affected: P0-P4, P6, P7; Cycle 5 manual carryover; Cycle 7 handoff
Report: [AUDIT-REPORT.md](./AUDIT-REPORT.md)
Reproduction: [AUDIT-REPRO.mjs](./AUDIT-REPRO.mjs)
Captured results: [AUDIT-EVIDENCE.json](./AUDIT-EVIDENCE.json)

The independent review reran the gate (328 runtime tests and 37 Rust tests
passed; the suite stands at **365** as of 2026-09-23, the increase being the
regression tests added by the P1 and P2 fixes below), then found failures in
retained requirements. The report distinguishes
executed reproductions from static analysis and unperformed manual evidence.
No production implementation was changed during this audit.

| Finding | Priority | Status | Required outcome |
| --- | --- | --- | --- |
| A01 PDF page-range nontermination | P1 | fix applied, unverified | Reject unsafe numeric pages before iteration; runtime remains cancellable. |
| A02 Word output creation race | P1 | fix applied, unverified | Commit a new file without ever replacing a concurrently created destination. |
| A03 Word table content lost | P1 | fix applied, unverified | Preserve supported table contents through the provider-visible tool result. |
| A04 MCP result absent from model input | P1 | fix applied, unverified | Send bounded, sanitized result data through provider-visible content. |
| A05 MCP adaptation breaks aggregate registry | P1 | fix applied, unverified | Reject duplicates and invalid final descriptors locally; built-ins remain usable. |
| A06 Cancel during discovery still prompts provider | P1 | fix applied, unverified | Cancellation covers setup/discovery and prevents subsequent prompt submission. |
| A07 Structured document continuation loses content | P2 | fix applied, unverified | Resume within pages/blocks without gaps, duplication, or non-progress. |
| A08 Silent extraction truncation | P2 | fix applied, unverified | Report every truncation and actual extraction progress truthfully. |
| A09 Word source version not revalidated | P2 | fix applied, unverified | Bind approval to the source version and reject changed sources before output. |
| A10 Workspace continuation contract incomplete | P2 | fix applied, unverified | Detect changed versions across segments and provide bounded search continuation. |
| A11 UI state contradicts runtime state | P2 | fix applied, unverified | Preserve workspace override notice and clear waiting state when permission resolves. |
| A12 Config loader bypasses server cap | P2 | fix applied, unverified | Enforce the aggregate cap on the actual file-loading path. |
| G01 Parsing responsiveness evidence missing | acceptance gap | evidence produced; defect found | `parse-responsiveness.test.mjs` measures event-loop turns during a parse. It found cancellation being dropped rather than delayed — see C6-I036. |
| G02 Manual acceptance unperformed | acceptance gap | **open — indefinitely deferred 2026-09-23** | Execute retained Cycle 6 checks and 26 carried Cycle 5 criteria with recorded evidence. **No longer scheduled.** See the G03 note below. |
| G03 Status/traceability and receiving plan gaps | documentation gap | **closed** | Claims reconciled (matrix, PLAN, README, C6-I013/I026, P2, staging script). Receiving plan written as [Cycle 7 LEGACY](../cycle-7/LEGACY.md) — every unit traceable to the deferral that created it. **Superseded 2026-09-23:** that plan was later split into [LEGACY.md](../cycle-7/LEGACY.md) (inherited work) and [PLAN.md](../cycle-7/PLAN.md) (new development), and the manual acceptance it left open is now **indefinitely deferred**. See the note below. |

Most recorded scope reductions are traceable and reasonable, but they do not
waive retained C6-10, C6-19, C6-24, C6-32, C6-40, or C6-44/C6-45 obligations.
P7 task 12's repeated-run record is historical evidence, not proof that the new
properties above pass. Existing completion statements must be read subject to
this audit. Fixes require focused regression evidence and a fresh gate, followed
by the manual checklist; the audit itself does not authorize marking items fixed.

This entry precedes the audit's updates to PLAN and the matrix status. Historical
decisions remain below so corrections do not erase their provenance.

#### P1 fixes (2026-09-19, after the audit)

Six fixes, each with a regression test that fails without it. **Recorded as
"fix applied, unverified" and left open**, per this entry's own rule — the
author of a fix is not the party who verifies it, and this entry is the audit's,
not mine.

| Finding | Fix | Regression test |
| --- | --- | --- |
| A01 | `parsePageRange` rejects a non-safe-integer page before any arithmetic. The span guards could not see it: `end - start + 1` reports 1 for a span of one enormous page, and `page += 1` is a no-op past 2^53, so the loop never advanced. | `pdf-adapter.test.mjs`, three tests including the exact `Number.MAX_SAFE_INTEGER` boundary. |
| A02 | `writeAtomic` commits an `expectMissing` write with `link`, which fails with `EEXIST` rather than replacing. Checking and then renaming has an irreducible window, because the window is wherever the last check is. | `workspace.test.mjs`: the destination is created *between* the final check and the commit. |
| A03 | `renderDocumentBlocks` renders every supported block type, and an unrecognized type produces a visible marker instead of an empty line. The old version took `block.text` for anything that was not a page break, which discarded table `rows` and flattened headings. | `workspace-tools.test.mjs`: a mixed document through the full `workspace.read` path, asserting every marker reaches the model. |
| A04 | `toolResultEnvelope` takes a `body` that goes into `content`. The MCP adapter passed its payload only in `details`, so the model saw "server completed tool" and nothing else. | `mcp-adapter.test.mjs`, five tests asserting on `content` specifically — asserting on `details` passed before the fix and is how this shipped. |
| A05 | Each candidate tool is validated against the registry before it is accepted, and the description is bounded to the registry's own limit. The adapter had bounded it to 1200 while the registry rejects at 800. | `mcp-adapter.test.mjs`: duplicate names, an over-limit description, and built-ins surviving a server that produces only bad tools. |
| A06 | Cancellation is re-checked on the far side of the discovery await, before `run_started` and before the provider call. | `mcp-runtime.test.mjs`: a Stop during a gated discovery, asserting the provider is never called — plus the converse, that an uncancelled run still reaches it. |

**Every fix was verified to be a fix, not a passing test.** Each regression test
was run against the unfixed implementation and observed to fail: A01 by external
kill (the failure is a hang, so it cannot fail a test normally), A02 by restoring
the replacing commit, A06 by removing the guard. A03 and A05 fail by assertion
against the old behavior. The practice is recorded because a test written after
a fix is exactly the kind that passes for the wrong reason.

**One finding surfaced a deeper defect than the one reported.** A04's fix
required `boundedToolResult` to say a result was truncated. It did append a
marker, but only when bytes remained — and after a content-filled truncation
`remaining` is 0 precisely when the marker is needed. The notice was therefore
absent in the one case it existed for. That is the same class as A07/A08
(truncation not reported truthfully), it was in P0's shared result envelope
rather than in the MCP adapter, and it had no test. Fixing it required a
two-sided constraint: reserve room for the marker, but never let the marker
displace the content — the first attempt got the second half wrong and a
pre-existing contract test caught it.

#### P2 fixes (2026-09-22, after the audit)

Six more, same rule: each has a regression test, each test was run against the
unfixed implementation and observed to fail, and all are recorded as **"fix
applied, unverified"** rather than closed.

| Finding | Fix | Regression test |
| --- | --- | --- |
| A07 | `renderDocumentBlocks` returns a **block index** as the resume point, not a page number. The old `next_page = lastPage + 1` skipped the remainder of any page the budget cut part-way through. | Four tests, including one that reads, resumes, and accounts for every block exactly once — the property the defect violated, rather than the shape of the fix. |
| A08 | `partial` is now true when the *renderer* cut the result, not only when the adapter did. A read that reported `partial: false` beside `truncated: true` read as "nothing lost, some just long". | A read cut by the output budget, and its converse: a read that fits reports itself complete. |
| A09 | The transform commit revalidates the source against the reading the user approved. The identity comparison and the recorded identity both already existed; nothing consulted them at commit time. | A source changed while the permission card is open, and its converse: an unchanged source still transforms. |
| A10 | Read cursors carry a `content_version` and are refused against a changed file. Search returns `next_scanned_offset` — a *file* offset, not a result offset, because results are a subset of files and "start at result N" has no meaning in the traversal order. | A cursor resumed against a changed file, a cursor resumed against an unchanged one, a continued search that returns no file twice, and an exhausted search that offers no cursor. |
| A11 | The override notice travels on `run_started` instead of preceding it, and `permission_resolved` clears the waiting state. The notice was emitted before the event whose handler resets per-run state, so it was cleared by the very event that began the run it described. | Event-order assertions in `mcp-runtime.test.mjs`, and the existing handoff test updated to assert the notice *reaches the surface* rather than that a particular event carries it. |
| A12 | The file loader enforces `maxServers` on the entries it read. `validateServerConfigs` enforced it, but the real loading path called the per-entry validator in a loop and never the batch one. | A file one over the cap loads none, and a file at the cap still loads. |

**Two of these needed the test rewritten before it tested anything.** A09's first
version used an `async` permission handler whose promise was never observed —
`onPermission` is called synchronously from the broker's emit — so the source was
never actually changed and the test would have passed against the unfixed code.
A10's first version asserted a rejected promise, but the tool layer converts
thrown errors into bounded failure *results* by design, so it asserted the
harness rather than the behavior.

**A07 also exposed a defect in the test I wrote for it.** The first three A07
tests checked that the new fields exist and hold the right values — which passes
whether or not the old behavior was wrong. They were written against the fix
rather than against the defect, and they did not fail when the defect was
restored. The fourth test exercises read-resume-read and asserts that no block is
skipped or delivered twice; that one does fail against the old behavior. It is
recorded because "the test passes" and "the test would have caught this" are
different claims, and only the second is worth anything.

#### G03 reconciliation, first pass (2026-09-19, after the audit)

Recorded as partial and **left open**, per this entry's own rule that a fix needs
focused evidence and a fresh gate before it is marked fixed. What was corrected:

| Finding | What changed |
| --- | --- |
| Summary disagreed with the matrix rows (C6-09, C6-13 marked automated-only while carrying a manual reference; C6-43 stale at 318) | Two row dispositions corrected. **The summary is now derived from the rows** rather than maintained beside them, which is what allowed the drift. Reconciling the numbers alone would have left the same failure available. |
| C6-I013 and C6-I026 claimed no shipped tool produces `permission_required` | Both corrected. The claim was false and had been since P0: `workspace.write` and `workspace.edit` carry `effect: "write"` and resolve to `permission_required`. Verified by evaluating the policy for every shipped descriptor. **C6-I026 needed a second correction** because its own first correction repeated the same wrong premise. |
| P2's "no process or network path exists" read as a current global claim | Scoped to the first-party execution path as of P2, with a note that P6's MCP transport spawns a process. The symbols still do not appear in `agent-runtime/src` — the spawn is inside the SDK — which is exactly why the line was misleading rather than visibly wrong. |
| P2's C6-42 regex assertion read as "no MCP server can execute a shell" | Scoped to Aside's own registry, naming what the assertion cannot cover. |
| README described Web Search as planned for Cycle 6 | Rewritten to match the current state, including that an audit has open findings and no installable build exists. |
| `stage-runtime.mjs` omitted `pdfjs-dist` and referenced a script that was never written | `pdfjs-dist` and `typebox` added; the dangling reference replaced with the actual remaining step. A `verifyStagedImports` check now walks the runtime's real imports and fails if the closure does not cover them — demonstrated by removing `pdfjs-dist` and watching it fail. **The staged size was restated from ~80 MB to 113.3 MB**, because the earlier figure measured the incomplete closure. |

**Closed 2026-09-22.** The deferred work now has a receiving plan. Every unit in
it is traceable to the decision that deferred it, and each is required to state
its deliverable, demonstration, edges, evidence, and documentation before it
starts.

**Revised 2026-09-23.** That plan was one document holding two kinds of work,
and it was split:

- [`docs/cycle-7/LEGACY.md`](../cycle-7/LEGACY.md) — the inherited units. U1
  (frontend test infrastructure), U2 (surface interaction quality), U6
  (installed application), U7 (classification binding).
- [`docs/cycle-7/PLAN.md`](../cycle-7/PLAN.md) — Cycle 7's own new development,
  which is frontend interaction work and new components, and is **not** derived
  from Cycle 6.

The reason for the split is the failure mode it removes. Inherited work fails by
being silently dropped; new work fails by being absorbed. One document holding
both guaranteed the second — a cycle whose subject is its predecessor's
remainder, which is the shape C6-I034 diagnosed in P7 in the first place. The
first draft's U3/U4/U5 moved to the new plan, because Cycle 6 *decided not to
build* them rather than *owing* them.

**One thing this closure does not carry.** The receiving plan was written to
pick up G02's unperformed manual pass. **It will not.** As of 2026-09-23 the
manual acceptance — this cycle's 24 `automated + manual` criteria, C6-40 and
C6-45, and the 26 carried Cycle 5 criteria — is **indefinitely deferred**: no
target cycle, no date. G02 therefore stays open, and it is now open by decision
rather than by omission. The record is in
[LEGACY.md](../cycle-7/LEGACY.md#manual-acceptance-indefinitely-deferred).

The audit's closing recommendation was that Cycle 7 not inherit a package as
wide as Cycle 6's. The plan answers it structurally rather than by trimming: it
is split by **what a person can watch work** instead of by technical layer, and
the rule that a unit may not start until its edges are written down is taken
directly from Cycle 6's failure mode — the defects that survived audit were in
boundaries nobody had enumerated, not in the features.

One ordering decision is worth surfacing: U1 (frontend test infrastructure) is
first, before the surface work that needs it. Cycle 6 built the surface first
and reached release review with no way to verify it, which is the specific
sequence this plan inverts.

## Restart Review Decisions (2026-09-16)

### C6-I008 - Rebaseline and Close the Predecessor

Status: accepted
Affected: PLAN, P0-P3, P7; Cycle 5 P6

Fact: Cycle 5's 80 runtime and 30 Rust tests pass, but the acceptance matrix,
manual Windows evidence, and release decision remain unfinished. Automatic
descriptor handoff already exists. The resolver takes the first descriptor;
prior-workspace reuse does not prove task continuity. A 30,000-byte single-line
read was reproduced with 24,064 content bytes and no continuation offset.
Binary adapters still reach raw UTF-8 decode and receive no AbortSignal.

Decision: add M0, owned by Cycle 5 P6, before Cycle 6 P0 implementation. P1
hardens the existing handoff; P2 fixes continuation; P3 separates binary input
and enforces parse-time limits/cancellation. Each capability brings its minimum
IPC/UI flow; P7 consolidates acceptance. Automated success is not manual proof.

### C6-I009 - Word Transformation Requires a New File

Status: accepted
Affected: PRD section 9 and C6-24, PLAN, P4, P7

Fact: P4 described replacement as optional but also made its absence block
closure. Read/create/transform-to-new-file is the initial useful slice.

Decision: defer Word same-path replacement and existing-output overwrite.
C6-24 verifies refusal and unchanged files, including output creation races.
Text/JSON write/edit capability remains unchanged. A later replacement feature
requires its own exact-operation approval, stale checks, atomicity, and proof.

### C6-I010 - Installed Runtime Is a Release Requirement

Status: **superseded 2026-09-19** by
[C6-I034](#c6-i034---p7-was-over-broad-packaging-and-surface-quality-move-to-cycle-7);
the requirement moves to Cycle 7, the fact below stands
Affected: PLAN, P0, P3-P7; Cycle 7

Superseded in scheduling, not in substance. The fact below is correct and the
fix it prompted was real — the compile-time source path was a genuine defect.
What changed is the assignment: packaging and installed-application verification
are Cycle 7 work, not this cycle's. See C6-I034 for why, and for what it means
that this requirement never appeared in the PRD's release boundary.

Fact: the native launcher defaults to a compile-time source path and system
Node, while bundle configuration includes no runtime resources. Frontend build
and native unit tests do not establish distributable runtime support.

Decision: P0 specifies Node prerequisites/bundling, runtime/dependency/skill
resources, installed lookup, configuration, and license obligations. P7
implements and verifies on a clean Windows profile/VM without the checkout or
development node_modules. Runtime path overrides are recovery/development
options, not a normal installation requirement. Preserve the distinction
between Cycle 5 development-build acceptance and Cycle 6 installed acceptance.

## P0 Implementation Decisions (2026-09-16)

### C6-I011 - Egress Is Defined at the Process Boundary

Status: accepted
Affected: PRD section 4, PLAN, P0, P5, P6

Fact: the target contract adds an `egress` dimension but does not define what
counts as egress. Two readings were possible: what the tool implementation
transmits outside the Aside process, or anything derived from user data that
leaves the device, including the provider request itself.

Decision: `egress` describes what the **tool implementation** transmits to a
destination outside the Aside process during this call. It does not describe
the provider request; file content reaching the model travels through the
Context Plane and agent loop, which is a separate, already-governed channel.
Under this definition all six Cycle 5 workspace tools are `egress: "none"`.

The alternative reading would make every file read `permission_required`,
which contradicts C5-14 ("reads succeed without a write permission prompt") and
the P0 exit criterion that Cycle 5 tools keep their behavior. P6 must classify
each new capability under this definition before registering it (P5 retired
under C6-I026).

### C6-I012 - The `external` Effect Is Removed

Status: accepted
Affected: PRD section 4, PLAN, P0, P5, P6

Fact: the Cycle 5 baseline validator accepted `effect: read | write | external`
and the Cycle 5 PRD documents it. The Cycle 6 target table lists only
`read | write | execute`, and `external` cannot express what it was meant to:
it conflated a network read with local execution and carried no egress detail.

Decision: `external` is removed from the capability and permission
vocabularies. `execute` plus the new `egress` dimension replaces it. A legacy
descriptor declaring `external` fails with the named code
`legacy_effect_external` rather than a generic invalid error, so a future
adapter knows the intended migration. The existing Cycle 5 assertion that the
permission broker rejects a non-write effect still passes unchanged.

### C6-I013 - The Runtime Enforces `permission_required`

Status: accepted
Affected: PRD section 5, PLAN, P0, P5, P6, P7

Fact: the P0 requirement says the policy evaluator returns an explicit allow,
permission-required, or unavailable decision, but no requirement says who
enforces the middle value. Declared without a consumer, it would be a label.

Decision: the permission broker records a single-use grant, keyed by tool call
id, only when a decision resolves to `allow`. The runtime then verifies, before
accepting a non-failure result from a tool whose policy was
`permission_required`, that a grant was consumable. An adapter that returns a
success without asking is refused with `permission_not_obtained`; an adapter
that already reports a failure status passes through unmasked. Grants are
capped, cleared on dispose, and absent after deny, cancel, or expiry.

The check is gated on `permission_required`.

**Corrected 2026-09-19** (found by the independent audit). This entry
originally claimed "which no shipped tool produces, so this changes no Cycle 5
outcome". The first half is false, and has been since P0. `workspace.write` and
`workspace.edit` carry `effect: "write"`, which matches `effect_write` in
`POLICY_RULES` and resolves to `permission_required`. Verified by evaluating the
policy for every shipped descriptor rather than by re-reading the table:

```text
workspace.list    read  -> allow
workspace.read    read  -> allow
workspace.write   write -> permission_required (effect_write)
workspace.edit    write -> permission_required (effect_write)
```

So the verification has been on a live path for every workspace write since the
migration, not test-only. The correction matters because the claim was load-
bearing: it was the stated reason the change was believed to be inert.

What survives is the narrower behavioural claim. It changes no Cycle 5 outcome,
because the write adapters request a decision and the broker records the grant
before the result is accepted. **The reasoning was wrong; the conclusion
happened to hold.** That distinction is the useful part — a plausible-sounding
premise that nobody evaluated kept a wrong statement in the record across two
cycles, and it took an independent pass to check it.

### C6-I014 - Workspace Scope Implies the Workspace Prerequisite

Status: accepted
Affected: PRD section 5, PLAN, P0, P2-P6

Fact: P0 treats `scope` and `availability` as independent dimensions, but the
Cycle 5 behavior they must reproduce is the literal predicate
`scope === "workspace"`. A workspace-scoped descriptor with no resolved root
would be a capability that claims containment it does not have.

Decision: descriptor normalization derives `availability.prerequisites` from
`scope` (`workspace` → `["workspace"]`, otherwise `[]`) when the descriptor does
not state them, and the validator rejects a workspace-scoped descriptor that
omits the prerequisite. Every other combination stays independent. This makes
the new mechanism provably equivalent to the three registry filters and one
gate it replaces, captured by a test over both scope values and both
environment states.

### C6-I015 - Cancellation During a Tool Call Was Reported as a Failure

Status: accepted
Affected: P0, P2, P7; Cycle 5 C5-05, C5-23

Fact: discovered while wiring C6-05. Cancelling a run while a tool call was in
flight settled the run as `failed` with the message "This operation was
aborted", while cancelling during streaming settled it as `cancelled`. The
`agent_end` handler keyed only on the assistant message's `stopReason`; an
abort mid-tool-call produces an error message with a non-aborted stop reason,
so it took the failure branch. The `prompt()` catch path already applied the
correct rule (`run.cancel_requested` first), so the two paths disagreed.

Decision: the `agent_end` handler now treats `run.cancel_requested` as
authoritative, matching `prompt()`. A run the user stopped reports `cancelled`
regardless of which turn it was in, which is what C5-05 ("one terminal
cancellation state") requires. No existing test changed; the full Cycle 5
suite passes unmodified.

### C6-I016 - Result Failure Classification Is Status-Driven

Status: accepted
Affected: P0, P3-P6; PLAN results and persistence

Fact: `afterToolCall` read the Pi loop's `isError` flag, which the loop sets to
false for any tool that returns rather than throws, and recognised only
`failed`, `unsupported`, and `cancelled` as failures. A capability reporting
`denied`, `expired`, `invalidated`, `stale`, `timed_out`, `disconnected`, or
`malformed` through `details.status` alone was counted as a success.

Decision: classification now reads the tool's own merged result and uses the
shared `TOOL_RESULT_FAILURE_STATUSES` vocabulary. Verified behavior-preserving
for Cycle 5: the shipped write adapter already sets `isError: true` on failure,
so no shipped outcome changes. This hardens the path for the P3-P6 adapters,
which will not all set that flag.

### C6-I025 - Cycle 6 Scope Is Materially Larger Than One Cycle

Status: open; owned by P7
Affected: PLAN, P4-P7

Fact: observed while delivering P4. P4 alone — a `.docx` read adapter with
package hardening, a strict generation schema, a permission-bound create and
transform path, atomic output, post-write reopen validation, and generated
fixtures — is comparable in size to an entire earlier cycle, and is plausibly
extractable as its own repository. P6 (MCP adapter) is of similar shape, and P7
carries the combined acceptance matrix for two cycles.

Partial relief arrived on 2026-09-18 under C6-I026, which removed P5 (Web
Search) from the cycle entirely rather than trimming P4. The cycle loses a
first-party capability and takes on no replacement obligation: no search ships,
no MCP server is bundled, and the adapter is verified against faux and
adversarial fixtures rather than a live server. That reduces the total. It does
not make the remaining work small, and P7's reporting obligation above is
unchanged.

The Cycle 6 PRD's tiering is still the right product decomposition; what was
underestimated is the cost of a first-party document capability with this
project's dependency, hardening, and acceptance standards.

Decision: no rebaselining now. P4 is finished as scoped rather than trimmed,
because a half-delivered document capability is worse than a late one — the
read side already established the envelope and the hardening, and generation
is what makes it usable.

P7 owns the consequence: when assembling the acceptance record, state plainly
what Cycle 6 delivered against its PRD and what rolled over, and do not compress
P5, P6, or the acceptance matrix to fit a notional cycle length. If the cycle
must ship incomplete, name the deferred plans explicitly rather than weakening
their exit criteria.

### C6-I023 - Adding an Adapter Requires Updating What the Model Is Told

Status: accepted; fixed
Affected: P3, P4, P6, P7

Fact: P3 registered a working PDF adapter and the model still reported that it
had no PDF capability. The adapter was correct; the **tool description** was
not. `workspace.read` was published as "Read bounded UTF-8 text, Markdown, or
JSON from the active workspace", and the `format` parameter listed only
`text` and `json`. The model was accurately reporting what it had been told.
This was P3 task 8 ("audit tool descriptions for direct, correct model use"),
which was skipped.

The same change introduced a second, worse defect: `workspace.search` content
mode called `readDocument` and then dereferenced `document.text`. With PDF in
the default registry, searching a workspace containing a PDF would parse it
(main thread, expensive) and then throw a `TypeError` that the typed-error
handling did not catch — failing the entire search, not just that file.

Decision: both are fixed and pinned by tests.

- Descriptions now state what `workspace.read` actually accepts, including that
  PDF is read-only with page numbers and no OCR, and that `workspace.search`
  lists binary documents by name without searching their content.
- Adapters declare `textual: true` when they produce a text representation.
  Content search skips non-textual adapters **before** reading them, so a PDF is
  never parsed for a content search, and a diagnostic is recorded per file.
  A second guard rejects a non-string `document.text` so a future adapter
  cannot reintroduce the crash.

The lesson for P4 and P6: registering an adapter is two changes, not one — the
capability and the model-visible description. A description that understates
capability is a functional defect, not a documentation nit.

### C6-I024 - No Conversation Management and No Configuration Reload

Status: open; owned by P7 (surface) and C6-I010 (configuration)
Affected: P7, C6-I010

Fact: two usability gaps observed while manually testing.

1. **No conversation management.** The runtime persists a durable JSONL session
   and restores it, but the surface exposes no way to start a new conversation
   or switch between them. Testing therefore always continues the previous
   conversation, and a restored transcript cannot be reset from the UI. The
   continuation rule in C6-I021 is implemented and tested, but its
   user-visible half — a new conversation actually starting fresh — has no
   affordance to exercise it.
2. **No configuration reload.** `loadAsideConfig` runs once when the runtime is
   constructed, so changing `.env.local` (for example to switch model) requires
   restarting the application. There is no watcher and no reload action.

Decision: neither is Cycle 6 scope. (1) belongs to P7's surface work and should
be decided there — at minimum the rail should offer an explicit "new
conversation" action, which also gives C6-I021's session-change rule a real
path. (2) belongs to C6-I010 alongside the installed-runtime configuration
story: the reload affordance and the config lookup are the same concern.

Recorded rather than implemented, so both are named obligations instead of
assumptions. Neither blocks P4.

### C6-I022 - Provider and Model Configuration Is Not User-Configurable

Status: open; deferred to Cycle 7
Affected: Cycle 7 (new plan, not owned by P0-P7)

Fact: Aside's provider support is four hardcoded factories — `anthropic`,
`deepseek`, `google`, `openai` — in `runtime.mjs`. Each bundles a base URL, an
auth environment variable, a wire protocol, and a **static** model catalog.
`models.getModel(providerId, id)` is an exact string match against that catalog
(`vendor/pi/.../providers/data/*.json`, auto-generated).

Three consequences for a user on an OpenAI-compatible relay:

1. A model the endpoint serves but Pi's snapshot lacks is unusable. There is no
   escape hatch: the lookup is exact and the failure is a hard throw.
2. Only four providers can be selected, although the vendor slice ships many
   more (`openrouter`, `groq`, `moonshotai`, `qwen`, `together`, ...). Aside's
   `providerFactories` map, not Pi, is the limit.
3. There is no discovery. Pi already models this — `Provider.refreshModels?`
   with "dynamic providers return the list as of the last `refreshModels()`" —
   but none of the four wired providers is dynamic, and `radius.ts` is the only
   one in the slice that implements it.

The limit is not cosmetic. `Model<TApi>` is a capability profile, not a name: it
carries `api` (which protocol), `contextWindow`, `maxTokens`, `reasoning`,
`thinkingLevelMap`, `input`, `samplingParams`, and protocol `compat`. A model
id alone cannot build a correct request, and Aside's own bounds
(`maxOutputBytes`, tool-result caps, the Context Plane budget) read
`contextWindow`/`maxTokens`. So the right shape is **discovery plus a declared
or defaulted capability profile**, not discovery alone.

**Protocol trap.** `openai` uses the Responses API (`client.responses.create()`
against `/responses`), which most relays do not implement. `deepseek` uses
chat-completions (`/chat/completions`). So today the only relay configuration
that works is `ASIDE_PROVIDER=deepseek` with `ASIDE_API_URL` pointed at the
relay — using `deepseek` as a protocol selector rather than a vendor.

**Diagnostics defect.** Model validation is eager (construction time, a direct
throw) while auth resolution is lazy (request time, `models.ts:650`). A wrong
credential variable therefore surfaces only after the model matches, and reads
as "Provider is not configured" with no indication of which variable is
expected. Observed directly: a key set on `OPENAI_API_KEY` while
`ASIDE_PROVIDER=deepseek` produced the model error first for an unknown model
and the provider error second for a known one, sending the user to inspect the
model catalog for an authentication problem.

Evidence (2026-09-17, manual): `deepseek-v4.1-flash` (served by the relay, not
in Pi's catalog) → `Model "deepseek-v4.1-flash" is not available for deepseek`;
`deepseek-v4-flash` with the key on the wrong variable → `Provider is not
configured: deepseek`. Working configuration: `ASIDE_PROVIDER=deepseek`,
`ASIDE_MODEL=deepseek-v4-flash`, `ASIDE_API_URL` at the relay,
`DEEPSEEK_API_KEY` carrying the relay credential.

Decision: defer to Cycle 7 as its own plan. Two layers, to be sequenced there:

- **L1 (small):** keep `ASIDE_MODEL` as the capability template and add a
  separate setting for the id sent on the wire. The precedent already exists at
  `runtime.mjs` where `ASIDE_API_URL` overrides `baseUrl` on a catalog entry;
  overriding `id` the same way changes only the model name on the wire.
- **L2 (the real fix):** a first-class OpenAI-compatible endpoint provider with
  user-supplied base URL, credential, and model, optional `/v1/models`
  discovery, and a capability profile that is declared or falls back to a
  named template.

Cycle 6 does not absorb this. P0-P7 are unchanged; adding a provider system
mid-cycle is exactly the scope creep the delivery map exists to prevent.

### C6-I021 - Continuity Is the Conversation, Not the Process

Status: accepted
Affected: P1, P2, P7; Cycle 5 P1

Fact: P1 requires explicit task-continuation identity before `previousWorkspace`
is reused, and forbids inferring continuity from process lifetime. The Cycle 5
runtime carries one `previousWorkspace` per runtime instance and never clears
it, so any later prompt — including one about something unrelated — inherited
the last captured workspace. There is no session-identity check, and the
production runtime is constructed once per process.

Decision: the resolution result carries `continuation_id`, taken from the
durable session (`agent.sessionId`), with the task id or the runtime instance as
the fallback for an agent with no session identity. `resolveTaskWorkspace`
reuses a prior workspace only when `previous.continuation_id` matches the
current identity, and otherwise reports `workspace_required`. An explicit
selection and a fresh capture always outrank the prior state.

Consequences:

- Within one conversation the workspace continues across prompts, which is what
  makes "read it" → "now edit it" work. This is unchanged from Cycle 5.
- A changed session id drops the workspace instead of inheriting it. There is
  no new-conversation UI today, so this path is currently exercised only by
  tests — it exists so that adding one cannot silently leak a workspace.
- The process-lifetime fallback remains for agents constructed without a
  session, as in the runtime tests. It is a named, tested fallback rather than
  an inference.

### C6-I020 - Cycle 5 Manual Acceptance Moves to the P7 Release Gate

Status: accepted
Discovered: delivery decision on 2026-09-17
Affected: PLAN (M0, M2, P7), Cycle 5 PLAN and P6

Fact: M0 made Cycle 5's manual Windows acceptance the gate before Cycle 6 P0
implementation. P0 was then implemented under an explicit narrowing recorded at
the time. The remaining M0 work is 26 desktop criteria in the C5-01 through
C5-40 matrix, and it has not been performed. Meanwhile P1 changes descriptor
selection and task continuity, and P2 changes continuation and read bounds —
both on the exact paths those criteria exercise. Manual acceptance performed now
would be invalidated by the next two plans.

Decision: Cycle 5's manual acceptance is absorbed into the P7 release gate,
which owns one combined pass over the Cycle 5 matrix and the Cycle 6 matrix
rather than two partial passes. M0's gate is treated as satisfied for
implementation purposes by its completed acceptance matrix, its recorded
automated gate, and this explicit decision — not by relabeling unperformed
manual evidence as passed.

The Cycle 5 acceptance record is deferred with it. Cycle 5 is not recorded as
released: the C5 matrix keeps its `manual` column empty until P7 runs it, and
P7 must state a combined acceptance record for both cycles.

The mid-cycle checkpoint moves to M2 (P1 + P2), where the local file loop first
becomes usable end to end. The check at that point is one desktop happy path —
summon, capture a file in Explorer, observe automatic workspace/target binding,
read, edit, approve, verify — not the full matrix. If that path is broken, P3
through P6 are built on an unproven assumption, so it must be exercised before
them, not after.

### C6-I018 - The Two Enforcement Surfaces Are Stamped and Bound

Status: accepted
Affected: P0, P5, P6, P7; PRD sections 12 and 13

Fact: an independent review of the P0 diff found two weaknesses in the
mechanisms P0 establishes for P6 (then scoped as P5/P6), neither exploitable by
a shipped tool.

1. `consumeGrant` keyed only on `tool_call_id`, which is model-supplied and
   not guaranteed unique by the Pi loop, and the ledger was cleared only on
   dispose. An approval that was granted and then went unspent (the adapter
   failed after the decision) could be spent by a later call reusing that id.
   PRD section 12: "A prior tool-call approval does not authorize another
   call."
2. The permission record took `effect`, `egress`, `source`, and `origin_label`
   from the adapter's own request, so an adapter could omit or understate
   `source` and receive `risk.boundary: "aside_enforced"` — a claim C6-I006
   forbids.

Decision: both surfaces are now stamped from the trusted descriptor.

- `consumeGrant(toolCallId, identity)` re-checks `request_id` and `task_id`,
  and the runtime passes the active run's identity. A grant earned by one run
  cannot be spent by another.
- `clearGrantsForRun` drops a settled run's unspent grants, called from
  `settle()`; dispose remains the backstop.
- The runtime hands each adapter a *scoped* broker whose `waitForDecision`
  overrides `effect`, `egress`, `source`, and `origin_label` from
  `run.policy.descriptor`. Registry metadata wins over anything the adapter
  writes. An adapter cannot describe its own trust boundary.

Verified by `capability-permission.test.mjs` (grant binding and run-scoped
clearing) and `capability-runtime.test.mjs` (an adapter declaring
`egress: "none"` for a `file_content` descriptor produces a
`file_content`/`external_process` permission record).

### C6-I019 - Scope Alone Does Not Require a Decision (P6 constraint)

Status: open; owned by P6 (P5 retired under C6-I026)
Affected: P6, P7; PRD section 12

Fact: `POLICY_RULES` keys on `source`, `egress`, `effect`, and availability —
not on `scope`. PRD section 12's "host, service, or egress call: exact per-call
permission" is stated for MCP tools, and every MCP tool is already
`permission_required` via `source === "user_mcp"`, so the shipped policy table
matches the PRD's default policy. But a future *built-in* capability declaring
`scope: "service"` or `"host"` with `egress: "none"` would evaluate to `allow`.

Decision: P0 does not add a speculative `scope` rule that would fire on no
existing tool. P6 must classify every new capability's `scope` and `egress`
explicitly when it registers one, and add a `scope`-keyed rule to `POLICY_RULES`
if it introduces a built-in host or service capability that is not otherwise
covered. This is recorded rather than implemented so the gap is a named
obligation instead of an unstated assumption.

Under C6-I026 the constraint narrowed rather than grew. P6 registers adapted
tools with `source: "user_mcp"`, which is already `permission_required` by
`POLICY_RULES`, so the gap P0 declined to paper over still fires on nothing.
The obligation stays open until P6 either registers a built-in capability with
`scope: "host"` or `"service"` and `egress: "none"`, or records that no such
capability exists in Cycle 6.

### C6-I017 - Installed-Runtime Packaging Contract (P0 task 11)

Status: **document half closed 2026-09-19**; implementation half **reassigned to
Cycle 7** by
[C6-I034](#c6-i034---p7-was-over-broad-packaging-and-surface-quality-move-to-cycle-7)

The contract is recorded as [`PACKAGING-CONTRACT.md`](./PACKAGING-CONTRACT.md):
Node is bundled rather than required, the staged layout is specified, the
resolution order is implemented with unit tests, and the failure messages are
enumerated. The document also states what remains unverified — the payload has
not been built into an installer, no clean-profile installation has been
attempted, and the Node download path has not been exercised against the real
endpoint because this environment has no network.

That last point is the honest state of the implementation half: the code and the
staging script exist and run, and the one step that produces a real installer is
blocked on network access, not on further work.
Affected: P0, P3-P7, PLAN dependency gate

Fact: P0 task 11 requires a recorded Node/runtime/dependency/skill packaging
contract before new dependencies are selected. It is a document deliverable
with no code artifact and no test, so P0 does not look complete against its own
task list without an explicit record.

Decision: this stays open until the P3/P4/P6 dependency selections are made,
because each one must record its license, native-binary, packaging, and
clean-install implications against it. P0 records the requirement and the
acceptance environment; the selections belong to their owning plans. P7 owns
the clean Windows profile/VM verification and the installed-app evidence.

C6-I026 removed the P5 selection from this set. The remaining selection is
P6's, and it is now made: `@modelcontextprotocol/sdk` **1.30.0**, **MIT**, pure
JS with no native binaries and no platform-specific install step. Its declared
closure is 91 packages / 23.1 MB on disk, but the path reachable from
`client/index.js` and `client/stdio.js` touches only 6 packages / roughly
16 MB. `cross-spawn` is on that path because the stdio transport spawns a
process; `ajv` and `zod-to-json-schema` are there because the SDK validates
JSON Schema itself. The full measurement and the reasoning that chose the SDK
over a hand-written protocol subset are recorded in the P6 plan. P7 still owns
the clean-profile verification that turns this into installed-app evidence.

## P5 Scope Decision (2026-09-18)

### C6-I026 - Web Search Leaves Cycle 6 Entirely

Status: accepted; supersedes P5
Discovered: scope review on 2026-09-18
Affected: PRD sections 3.2, 3.3, 10, 18.5, 19 and C6-26 through C6-30 and
C6-45; PLAN delivery map, M3, M4, acceptance traceability, release boundary;
P5 (retired); P6; P7; C6-I004, C6-I011, C6-I012, C6-I013, C6-I017, C6-I019,
C6-I025

Fact: P5 required Aside to select one search provider, review that provider's
terms, display, attribution, and caching obligations, and then ship that
provider's contract behind a schema described as provider-neutral. Cycle 6 has
no budget for a provider relationship, no user-facing settings surface to
enable or credential a capability (C6-I024), and no settings storage to hold a
search key.

The requirement was also the opposite of the product intent. The motivating
goal was a low-cost, self-hostable, swappable search — any engine would do.
Committing Aside to one provider's contract and terms is what removed that
freedom.

A first revision of this entry moved Web Search to the MCP boundary instead,
delivered through the P6 adapter rather than as a first-party tool. That was
reviewed and withdrawn in the same session, because it does not actually solve
the problem it appears to. Every keyless search server available for a user to
connect is a scraper: it drives a real browser against a public search engine
and parses the result HTML. Delivering search that way still makes Aside's
search — the thing the product offers, documents, and points the model at — a
third-party scraper, and still makes its availability depend on a third party
continuing to tolerate automation. It relocates the dependency instead of
removing it. It also contradicts the decision recorded here: Aside would be
shipping no server but still choosing one.

Decision: **Web Search is deferred out of Cycle 6 entirely and recorded as
actively considered**, not attempted. Cycle 6 ships no search capability of any
kind, bundled or connected, and bundles no MCP server at all. The MCP adapter
is delivered and verified without a search workload.

Consequences, recorded rather than absorbed:

1. C6-26 through C6-30 are **retired**, not deferred with owners. They were
   written against a capability that will not exist this cycle, and leaving
   them live would hand P7 acceptance criteria with no subject. Their intent is
   preserved in the PRD as the requirements that any future search capability,
   first-party or connected, must satisfy.
2. The first-party Web Search deferral in the PLAN is superseded by a full
   removal. It is not "not yet shipped"; it is not in this cycle's scope.
3. C6-45's Windows workflow list drops Web Search. It covers workspace file
   work, PDF reading, and Word transformation.
4. Aside bundles no MCP server, ships no default server configuration, and
   names no server in the system prompt or tool descriptions. With no server
   connected, search is unavailable rather than silently absent, which the P0
   availability mechanism can express without new machinery.
5. The first-party capability count stays at two (PDF, Word) — the same count
   as the withdrawn revision — but the release boundary no longer claims a
   search path through MCP either.
6. C6-I011, C6-I012, and C6-I013 keep their P6 half: P6 remains the only
   capability that registers a non-`workspace` scope, and adapted tools are
   `permission_required` from the first policy rule (`source_user_mcp`).

   **Corrected twice, and the second correction is the instructive one.** This
   entry first said P6 "may land no egress-bearing capability at all this cycle,
   so the grant verification stays exercised by tests rather than by a shipped
   path". A first correction replaced that with the claim that Cycle 6 ships no
   capability producing `permission_required` without the user first connecting
   a server. **That correction was also wrong.** Built-in `workspace.write` and
   `workspace.edit` produce it, and always have — see the corrected C6-I013.

   The first correction was found by building the P7 audit, whose first version
   used a stub broker that answered "allow" without producing a grant; the
   runtime refused the result with `permission_not_obtained`. That is C6-I013
   working on the shipped path, and it caught a mistake made by someone who had
   just read the code.

   The second was found by the independent audit, which noticed that the entry
   had been corrected toward a claim that was still false while the entry it
   cited was being corrected in the same pass — the same wrong premise, carried
   forward by the act of fixing it. Neither error was reachable by reasoning
   about the code from the documents; both required evaluating the policy.

   What is true: `permission_required` has been on a live shipped path since the
   migration, for every built-in write and for every adapted MCP tool. The
   mechanism is not test-only, and never was.
7. C6-I017's SDK question is answered in the P6 plan: `@modelcontextprotocol/sdk`
   1.30.0, MIT, with the measured dependency closure recorded there.

**Why a faux-only MCP adapter is still worth shipping.** The objection to
verifying against our own faux server is real — a faux server built with the
same SDK will speak exactly the protocol we expect. It is answered by
deriving the faux server's adversarial fixtures from a real server rather than
from our assumptions. A representative third-party server was read for this
purpose during the review; it contributed concrete, unanticipated shapes now
required of the faux suite: JSON Schema `anyOf` unions of `number` and
`string` with defaults, tool descriptions that contradict the tool's actual
behavior, a tool accepting an arbitrary URL, and a server that itself spawns
child processes. Those shapes become fixtures. The vendored tree is a fixture
source, never a runtime dependency.

Cycle 6 therefore ships an MCP boundary that has been exercised against
adversarial protocol shapes but not against a third-party server at runtime.
P7 must state that plainly rather than implying field validation.

## P6 Implementation Decisions (2026-09-18)

### C6-I027 - Windows Shell Routing Is Refused in MCP Server Configuration

Status: accepted
Affected: P6, P7; PLAN security invariants; C6-I017

Fact: the PLAN invariant forbids adding "shell, PowerShell, arbitrary
process/code execution". The MCP SDK's stdio transport passes `shell: false`,
which reads as compliance. It is not sufficient. `cross-spawn`, which the
transport uses, overrides that on Windows (`lib/parse.js`):

```js
const needsShell = !isExecutableRegExp.test(commandFile);   // .exe|.com only
if (parsed.options.forceShell || needsShell) { /* builds a cmd.exe command line */ }
```

Any command that is not `.exe`/`.com` — including every `node_modules/.bin`
`.cmd` shim, any `.bat`, and any extensionless name — is therefore launched
through `cmd.exe` despite `shell: false`.

This is not only a purity problem. Aside passes server secrets through the
environment, and `cmd.exe` expands `%NAME%` inside arguments. A server
configuration copied from an untrusted source that contains `%SOME_KEY%` in an
argument would expand a real secret into that server's own command line.
`cross-spawn` does escape metacharacters, so naive injection is mitigated, but
the boundary would then rest on the quality of that escaping.

Decision: `validateServerConfig` refuses any command that is not a directly
executable `.exe`/`.com` **on Windows only**, with the code
`mcp_command_shell_required` and an error message that states the fix. The
restriction does not apply on other platforms, where the transport never
introduces a shell. Node-based servers are configured as `node.exe <script>`
rather than through a package-manager shim.

Consequence, recorded rather than hidden: this makes the common
`npx`/`.cmd`-shim configuration style invalid on Windows. That is a real
usability cost, accepted because it makes "no shell" a structural property
rather than one that depends on argument escaping being correct in every case.
C6-I017's packaging record must note the restriction when it describes how a
user configures a server.

### C6-I028 - The SDK Reports Cancellation as a Timeout

Status: accepted
Affected: P6, P7; C6-37; P0 C6-I013

Fact: found while testing the client against the faux server, not by reading
documentation. The SDK's abort path is:

```js
options?.signal?.addEventListener('abort', () => cancel(options?.signal?.reason));
const error = reason instanceof McpError ? reason : new McpError(ErrorCode.RequestTimeout, String(reason));
```

`AbortController.abort()` with no explicit reason leaves `signal.reason`
undefined, so the SDK raises `McpError(RequestTimeout, "undefined")` — the same
error code a genuine request timeout produces. Cancellation and timeout are
therefore indistinguishable by error shape, which C6-37 is required to tell
apart.

Decision: the client drives both the timeout and the cancellation itself and
records which one fired, rather than inferring the cause from the resulting
error. It passes its own signal to the SDK, keeps the SDK's
`notifications/cancelled` behavior toward the server, and maps the outcome to
`mcp_call_cancelled` or `mcp_call_timeout` from the cause it knows.

A second defect surfaced from the same test: cancellation was marking the
connection `failed`. Cancelling one call says nothing about the server's health,
so the connection stays `ready`. Only transport-level failures mark it failed.

### C6-I029 - SDK Fail-Closed Behavior Established by Probing

Status: accepted
Affected: P6, P7; C6-36, C6-38; P6 tasks 9 and 12

Fact: several SDK behaviors that P6's acceptance depends on were established by
running the client against the faux server rather than assumed from the
specification, because the difference between "the protocol says clients may
refuse" and "this client refuses" is the whole of C6-38.

Confirmed behavior, each now covered by a test:

1. **Server-initiated requests are refused by default.** With the client
   declaring no capabilities, `sampling/createMessage`, `roots/list`, and
   `elicitation/create` all receive `-32601`. The fail-closed default P6
   requires is real; the obligation is to keep it, which is why the client
   declares no capabilities and a test asserts all three refusals.
2. **Response payloads are validated.** A response violating the expected shape
   raises `-32602`, so a malformed result becomes an error rather than a silent
   pass-through.
3. **Non-protocol stdout is tolerated.** A real third-party server was observed
   writing a startup banner with `console.log` before starting its transport,
   which puts a non-JSON-RPC line on stdout. The parser skips it. This is a
   defect in that server, but assuming stdout carries only frames would have
   broken on it, so the faux server reproduces it deliberately.
4. **The default child environment is a safe allow-list.** The SDK passes only
   a small platform-specific set (`APPDATA`, `PATH`, `TEMP`, and similar) and no
   credentials. Caller-supplied values are merged on top, so the exposure risk
   is entirely in what the caller passes.
5. **`tools/list` pagination is caller-driven.** The SDK returns one page and a
   cursor; the client loops, and bounds both the page count and the tool count.

Decision: none of these is changed. They are recorded because P6's verification
section and the P7 audit both need to distinguish what was proven by execution
from what was read and believed. The environment finding in particular is why
the client passes only values resolved from Aside's own configuration and never
the runtime's `process.env` — a claim with a test behind it.

### C6-I030 - Tool Classification Is Name-Keyed Without a Settings Store

Status: open; owned by Cycle 7 (settings surface), recorded by P6
Affected: P6, P7; P6 task 6; C6-I024

Fact: P6 task 6 requires that a tool's classification be invalidated when
material server or tool identity or schema changes, and requires UX and storage
for classification. Cycle 6 has no settings surface or storage for it
(C6-I024), so the mechanism is split:

- **Server identity** is covered. `serverFingerprint` hashes command, arguments,
  cwd, and environment *names*; a change to any of them drops the cached
  connection and the tools built against it.
- **Schema change** is covered only when the user opts in. A classification
  override may carry `schema_digest`; if it does not match the schema the server
  is currently advertising, the override is refused and the conservative
  default applies. An override *without* a digest is applied as written and a
  `mcp_classification_unbound` diagnostic is recorded, because there is nowhere
  to remember which schema the user approved.

Decision: ship the enforceable half and record the other half rather than
implying full coverage. The diagnostic exists so the gap is visible in the
runtime record instead of being an unstated assumption — a name-keyed approval
is exactly the shape a server could exploit by earning a lowered classification
for a benign schema and then changing what the tool does.

Cycle 7, when a settings surface exists, owns persisting approved schema
digests so every classification is bound, and surfacing re-approval when a
digest changes. Until then the conservative default is what an unclassified or
mismatched tool receives, which is the safe direction to fail.

### C6-I032 - Document Warnings Are Objects on Read and Codes on Write

Status: accepted; recorded for future adapters
Affected: P3, P4, P7; PRD section 7; any future document consumer

Fact: found while typing the P7 document projection, and it nearly caused a
silent data loss. The two halves of the document contract report warnings in
different shapes:

- `workspace.read` returns `warnings` as **objects**: `{ code, message, page? }`,
  produced by the adapter so the reader's own pass can explain itself.
- `document.create` / `document.transform` return `source_fidelity_warnings` as
  **bare codes**: `string[]`, because `inspectSource` maps the reader's warnings
  down to `warning.code`. The messages were already produced during the read and
  are not repeated.

Both are defensible on their own — the write tool avoids duplicating bounded
output for a message the user already saw. Together they are a trap: a consumer
that narrows both as `{ code, message }` drops every source warning and reports
a transformation as clean.

Caught by checking the emitting code rather than the assumed shape, and the
projection now narrows them separately
(`narrowWarnings` / `narrowWarningCodes` in `src/lib/document-status.ts`), with
the reason stated at both call sites.

Decision: keep both shapes, and record the asymmetry rather than paper over it
with a normalizing layer that would hide which side produced what. A write
warning is a **code referencing a warning the read already explained**; treating
it as a message in its own right would misrepresent where the explanation lives.
Any future adapter or surface that consumes warnings must handle both, and the
matrix should treat "source fidelity warnings survive transformation" as a
verified property rather than an assumed one.

### C6-I033 - MCP Configuration Is File-Based, and the Surface Is Read-Only

Status: accepted; recorded so the gap is a decision rather than an absence
Affected: P6, P7; P6 task 2; P7 task 7; C6-I024, C6-I031

Fact: P7 task 7 asks for "the minimum deliberate MCP configuration and
troubleshooting surface needed by P6: server identity, enable/disable/remove,
connection status, adapted tool count/diagnostics, and trust/classification
decisions". What Cycle 6 delivers is the **read-only half**: the surface names
configured servers, marks adapted tool calls as external with the server's
label, states the boundary on the permission card, and reports a configured
server that contributed no tools. It does not offer enable, disable, or remove.

That is not an oversight discovered late. Cycle 6 has no settings surface at all
(C6-I024), and server definitions live in `mcp.json` beside the resolved Aside
configuration, which is the same file the provider credentials already live in.
Everything a settings screen would drive — validation, enablement, trust
acknowledgement, fingerprinting, teardown — was built in P6 and is exercised by
its tests. What is missing is only the screen.

Decision: **Cycle 6 ships file-based MCP configuration only.** Enabling,
disabling, and removing a server are edits to `mcp.json` and a restart.

Recorded rather than left silent for two reasons. First, without this entry the
P7 matrix would carry task 7 as done while three of its six clauses are not
delivered, and an auditor reading the matrix would be misled by omission.
Second, the read-only half is genuinely load-bearing on its own: a user who
edits `mcp.json` and gets nothing needs to know whether the server failed to
start or was never configured, and that distinction is exactly what the surface
now draws.

Cycle 7 owns the configuration surface, alongside the settings work C6-I024
already assigns it. The contract it drives is already built and tested; the
remaining work is presentation, not behaviour.

### C6-I031 - The React Surface Has No Automated Verification

Status: open; owned by P7 (recording) and Cycle 7 (remediation)
Affected: P7; C6-40, C6-44; every Cycle 2-5 surface criterion

Fact: found while implementing P7 task 2. The repository has no frontend test
infrastructure of any kind: no test runner in `devDependencies`, no test script
for `src/` in `package.json`, and no test files under `src/`. The surface is
verified by `tsc --noEmit` and `vite build`, which establish that it compiles
and bundles. Neither establishes that it says the right thing.

This is a pre-existing condition, not something Cycle 6 introduced. It becomes
material now because Cycle 6 is the first cycle to add surface state whose
*correctness* is the requirement rather than its existence: C6-40 asks whether
workspace, source, boundary, permission, warning, verification, and terminal
state are understandable, and C6-44 asks whether Cycle 2-5 surface behaviour
still holds. Neither question is answerable by a build.

Decision: do not add a test framework in P7. Adding a runner, a test script, and
a rendering harness is its own piece of work, and doing it at release time would
mean shipping a new, untested testing setup alongside the release it is meant to
justify. Instead:

- C6-40 is recorded as **manual-only** in
  [`MANUAL-ACCEPTANCE.md`](./MANUAL-ACCEPTANCE.md) Part C1, with the reason
  stated on the criterion itself so it cannot be mistaken for a tested one. It
  carries the most items of any section there, which is the honest size of the
  gap rather than a sign of thoroughness.
- P7 must not describe C6-40 or C6-44 as covered by tests, and the acceptance
  matrix must mark their evidence source as manual.

Cycle 7 owns remediation. The pure projections added in P7 — tool provenance
from descriptors, and the label helpers — are written as module-level functions
specifically so that extracting them into testable units later is mechanical
rather than a rewrite.

## P7 Scope Correction (2026-09-19)

### C6-I034 - P7 Was Over-Broad; Packaging and Surface Quality Move to Cycle 7

Status: accepted; supersedes part of C6-I010
Discovered: while assessing release readiness on 2026-09-19
Affected: PLAN (M5, delivery map, release boundary), P7 (tasks 9, 14, 16, 17 and
one exit criterion), C6-I010, C6-I017, ACCEPTANCE-MATRIX, MANUAL-ACCEPTANCE;
Cycle 7 (receives the deferred work)

#### Fact

P7 was written as "everything not yet done", and that framing let it absorb
three things that are not one plan's work:

1. **A separate workflow.** Tasks 16 and 17 are packaging: bundled-versus-required
   Node, a staged resource tree, installed-resource resolution, license notices,
   and a clean-profile install. That has its own contract, build step, network
   dependency, and VM environment. It is not "surface and release".
2. **Two unbounded audits.** Task 9 is eight independent audits — accessibility,
   keyboard and focus, resizing, text containment, long paths, long server names,
   streaming coexistence, restored history — every one of which is manual,
   because the repository has no frontend test runner (C6-I031). Task 12 is six
   stress categories, most of which the 328-test suite already covers; what
   remains is repeated-run flake detection, which is a CI concern rather than a
   task.
3. **A duplicate.** Task 13's Windows workflows restate what task 18's checklist
   already is.

#### How it was found, and why that matters

Not by reviewing P7 at the end, but by being asked to name the node at which an
automated audit could run. Answering that question required stating what "done"
meant, and the answer exposed the shape: P7 could not be closed because most of
its remaining bulk was not P7.

**The signal was already in the repository and had been read past several
times.** P7's exit criteria contained:

> Installed-app evidence proves no dependency on compile-time source paths or
> development dependencies.

The PRD's release boundary — [§19](./PRD.md#19-release-boundary) — is six items
and **not one of them mentions an installed application**. The requirement
entered through [C6-I010](./ISSUES.md#c6-i010---installed-runtime-is-a-release-requirement),
recorded during the restart review as an accepted decision, and the PLAN's M5
restated it as a milestone. From there it propagated into P7's exit criteria,
its tasks, and the manual checklist, without ever being traced back to a product
requirement. A cycle-wide scope addition had been treated as an implementation
detail of one plan.

#### Decision

**P7 closes at surface and acceptance.** The following move to Cycle 7:

| Deferred | Was |
| --- | --- |
| Packaging: staged resources, bundled Node, installed-resource lookup, license notices | P7 tasks 16, 17 |
| The packaged-application half of the registry/boundary audit | P7 task 14 (the model-visible-registry half is done and stays) |
| Accessibility, keyboard, resizing, containment, long-name and restored-history auditing | P7 task 9 |
| Clean-profile installation evidence | MANUAL-ACCEPTANCE Part C4 |

They go to Cycle 7 rather than to a new plan inside Cycle 6, because they are the
same kind of work as C6-I024 already assigned there: taking a development build
that works and making it a product. Bundling them together is what gives the
next cycle a coherent subject instead of a list.

**C6-I010 is superseded, not deleted.** Its fact was correct and its fix — the
compile-time source path — was real; only its assignment to this cycle changes.

#### What is deliberately not deferred

**C6-40 stays.** It is a PRD acceptance criterion, and §19 item 5 requires
C6-01 through C6-45 to be satisfied. Deferring it would weaken a product
requirement, which is a different act from correcting an implementation-scope
addition.

Task 9 and C6-40 are not the same thing and were conflated in P7's own writing.
C6-40 asks whether the surface *says the right thing* — legibility of state. Task
9 asks whether the surface *behaves well to use* — accessibility, keyboard,
resizing. The first is a product requirement; the second is frontend quality with
its own cycle.

#### Also corrected: the language

P7's title, the PLAN's M5 heading, and several status lines described the cycle's
end as "release". That framing assumed a formal version was imminent, which is
not the case and was never decided. The wording becomes **cycle acceptance
closeout**: this cycle is complete when its own criteria have evidence, which is
not the same claim as "ready to ship".

#### Traceability

This entry records the change; it is not itself the change. The edits it
authorises, each of which names it:

- `PLAN.md`: M5 rewritten and retitled; delivery map and release boundary amended.
- `plans/P7-surface-and-release.md`: tasks 9, 16, 17 deferred and task 14 halved;
  the installed-app exit criterion removed; title and status reworded. The plan
  is retitled to match what it now covers.
- `ACCEPTANCE-MATRIX.md`: the installed-application section marked deferred rather
  than pending; the "not released" statement reworded to the cycle claim.
- `MANUAL-ACCEPTANCE.md`: Part C4 removed with a pointer to Cycle 7; the run
  record no longer implies a release decision.
- `PACKAGING-CONTRACT.md`: retained as a record of a decision that was made and
  implemented in part, marked deferred and unverified.
- `ISSUES.md`: C6-I010 marked superseded; C6-I017's implementation half reassigned
  to Cycle 7.

One change went **beyond** the scope this entry was written to authorise, and is
recorded rather than folded in. Cycle 5's "release decision" — assigned to P7 by
[C6-I020](#c6-i020---cycle-5-manual-acceptance-moves-to-the-p7-release-gate) —
is reframed as its **acceptance record**. The reasoning is the same one that
produced this entry: neither cycle produces an installable artifact, so a
"release decision" for either is a claim neither can support. Leaving them
inconsistent, with one cycle accepted and the other released, would have been
worse than the extra change. The affected lines are in `PLAN.md`'s document
responsibilities, its delivery map, and M0, and in C6-I020 and C6-I025.

Nothing in this list is silent. An auditor reading the repository should be able
to reconstruct not only what changed but that it changed deliberately, and why.

## C6-I001 - Capability Tiers Are Delivery Tiers

Status: accepted
Discovered: direction alignment on 2026-09-10
Affected: PRD, PLAN, P0-P7

### Fact

Workspace tools, first-party domain tools, and MCP extensions have different
product maturity and trust expectations, but the model must not interact with
three unrelated execution systems.

### Decision

Use Tier 1, Tier 2, and Tier 3 as scope and delivery ordering. Adapt every tool
into one Aside-owned per-task registry and one runtime/policy path.

## C6-I002 - Separate Context, Runtime, and Policy

Status: accepted
Discovered: direction alignment on 2026-09-10
Affected: P0, P1, P7

### Fact

The Cycle 4 Context Plane observes host state; Cycle 5 tools perform active
work. Network and MCP additions make effect, boundary, egress, and trust
impossible to express as a single `read | write | external` value.

### Decision

Keep Context passive and native-owned, Runtime responsible for execution, and
define Policy as an explicit conceptual plane within the runtime. P0 will
separate effect, scope, egress, source, and replay metadata while retaining
compatibility where possible.

## C6-I003 - Shell Is an Empty Future Slot

Status: accepted
Discovered: scope decision on 2026-09-10
Affected: all plans

### Fact

An arbitrary shell can bypass structured workspace-write permission and can
reach filesystem, network, registry, and process state beyond a fixed `cwd`.
Cycle 6's requested workflows can be implemented with structured tools.

### Decision

Implement and register no shell, PowerShell, terminal, process, or code tool in
Cycle 6. Do not add a disabled placeholder to the model schema. A future
restricted fallback requires a separate sandbox and policy design.

## C6-I004 - Tier 2 Stops at PDF, Word, and Web Search

Status: accepted
Discovered: scope decision on 2026-09-10
Affected: P3-P5, P7

### Fact

Implementing PDF, Word, Excel, PowerPoint, GitHub, VSCode, Notion, and search in
one cycle would make dependency review, domain contracts, UX, and acceptance
too broad to finish rigorously.

### Decision

Cycle 6 first-party capabilities are PDF read, Word read/create/transform, and
Web Search. All other proposed Tier 2 capabilities are deferred.

Superseded in part on 2026-09-18 by C6-I026: Web Search was removed from Cycle
6 entirely rather than deferred within it, and is recorded as actively
considered. Cycle 6 first-party capabilities are PDF read and Word
read/create/transform. The reasoning above still holds — search was removed
from this set rather than added to it.

## C6-I005 - MCP Scope Is Tools Only

Status: accepted
Discovered: planning boundary on 2026-09-10
Affected: P0, P6, P7

### Fact

MCP tools solve the requested user-extension path. Resources, prompts,
sampling, elicitation, and server-initiated behavior introduce separate
context-authority and privacy questions.

### Decision

Cycle 6 adapts MCP tools only. Unsupported protocol capabilities are disabled
or explicitly rejected. The chosen SDK/transport handshake may implement
required negotiation without exposing those features to the model.

## C6-I006 - MCP Servers Are Trusted External Code, Not Sandboxed Tools

Status: accepted
Discovered: planning boundary on 2026-09-10
Affected: P0, P6, P7

### Fact

Aside can validate an MCP call and sanitize its result, but an external server
may perform undeclared filesystem, process, or network work internally. A
workspace-looking path argument does not prove containment.

### Decision

Show server identity and true trust boundary in configuration and permission
flows. Server annotations cannot lower Aside policy. Unknown-risk calls fail
closed or require the highest applicable per-call permission. Do not claim
sandboxing that Aside does not enforce.

## C6-I007 - PDF Is Read-Only and Word Transformation Is Non-Destructive

Status: accepted
Discovered: format scope review
Affected: P3, P4, P7

### Fact

Reliable PDF in-place editing is not a realistic general capability. Word
package regeneration can lose unsupported layout or embedded features.

### Decision

Expose no PDF mutation. Word transformations use a new output path, surface
fidelity warnings before permission, and validate the generated package.
As clarified by C6-I009, same-path replacement and existing-output overwrite
are deferred; any future replacement requires its own exact-operation path.
