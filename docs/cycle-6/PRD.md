# Cycle 6 Capability Runtime Product Requirements

Status: planning baseline
Scope decision: 2026-09-10
Execution scope clarification: 2026-09-16 (C6-I009: Word replacement deferred)
Platform: Windows desktop
Predecessor: [Cycle 5 Agent Capability](../cycle-5-agent-capability/PRD.md)
Direction notes: [Cycle 6 ideas](./ideas.md)

Cycle 6 makes Aside's model-facing tools broad enough and reliable enough for
real document and information work. It preserves the contextual-sidecar
identity established in earlier cycles while separating passive context
observation from active capability execution.

The cycle has three capability tiers:

1. a frictionless, shell-free workspace tool foundation;
2. first-party PDF and Word capabilities;
3. an MCP adapter through which users may attach additional tools.

These are delivery tiers, not independent runtimes. All active tools enter the
same Aside-owned capability registry and pass through the same runtime and
policy enforcement.

The implementation order and execution record are kept in the
[Execution Plan](./PLAN.md), its [`plans/P*.md`](./plans/) children, and the
[Issues Log](./ISSUES.md).

## Document Set

| Document | Responsibility |
| --- | --- |
| This PRD | Product behavior, scope, policy, and acceptance criteria |
| [Execution plan](./PLAN.md) | Cross-plan sequence, shared contracts, traceability, and release boundary |
| [`plans/P*.md`](./plans/) | Plan-local tasks, deliverables, exit criteria, and checks |
| [Issues log](./ISSUES.md) | Decisions, implementation discoveries, exceptions, and follow-up |
| [Ideas](./ideas.md) | Historical discussion notes; not an implementation contract |

## 1. Objective

Enable Aside to move from captured context to verified work without requiring
the user or model to manage paths, translate common document formats manually,
or fall back to a shell.

The target interaction is:

```text
user summons Aside on a file or application
  -> Context Plane emits a bounded, attributable snapshot
  -> runtime resolves the target and workspace automatically
  -> model sees only capabilities active for this task
  -> model calls first-party or user-connected tools
  -> Policy Plane validates scope, effect, egress, and trust
  -> Runtime Plane executes, cancels, bounds, and reports the operation
  -> model verifies the useful result and answers truthfully
```

Cycle 6 is successful when this path feels routine for workspace files, PDF
reading, and Word reading/transformation, while user-connected MCP tools cannot
bypass Aside's declared policy boundary.

## 2. Product Principles

### 2.1 Context is not capability

A captured path, selection, document title, browser page, or application
identity is evidence supplied to the model. It does not grant read, write,
network, host, or external-service authority.

### 2.2 Tools are the only active execution surface

Every model-driven action must be represented by an active registered tool.
Prompts, captured context, skills, document contents, and MCP descriptions
cannot execute work or expand authority by themselves.

### 2.3 First-party means stable product behavior

PDF and Word are built-in Aside capabilities. Their public tool contracts,
permission semantics, bounds, result shapes, and user experience are
Aside-owned even when their implementation uses an upstream library, service
SDK, or domain logic learned from an MCP project.

### 2.4 MCP is an extension protocol, not the core runtime

MCP tools are adapted into the Aside registry. The protocol does not replace
workspace resolution, permission, cancellation, result sanitization, or the
Pi agent loop. Cycle 6 does not require first-party capabilities to run through
MCP.

### 2.5 No shell fallback

No shell, PowerShell, arbitrary process execution, or code execution tool is
implemented or exposed in Cycle 6. Unsupported operations fail honestly. A
future restricted execution capability may fill gaps only after a separate
sandbox, network, filesystem, permission, and audit design.

## 3. Capability Tiers

### 3.1 Tier 1: workspace foundation

Tier 1 brings the existing workspace primitives to coding-agent-level fluency
without importing a coding-agent product model. It includes:

- automatic descriptor-to-workspace handoff;
- bounded listing, reading, searching, metadata inspection, writing, and
  editing;
- predictable path resolution and structured errors;
- pagination, offsets, truncation, and cancellation suitable for iterative
  model use;
- exact write previews, permission, revalidation, atomic execution, and
  verification;
- tool descriptions and results that let the model recover without asking the
  user to perform routine filesystem mechanics.

Tier 1 does not include shell commands, arbitrary processes, git commands,
package managers, language runtimes, or network access.

### 3.2 Tier 2: first-party core capabilities

Cycle 6 limits Tier 2 to:

- PDF read and structured extraction;
- Word `.docx` read, create, and transform-to-new-document workflows.

Web Search was in this list in the original Cycle 6 scope and was removed from
the cycle entirely on 2026-09-18
([C6-I026](./ISSUES.md#c6-i026---web-search-leaves-cycle-6-entirely)). It is
recorded as actively considered, not as deferred-within-this-cycle: no search
capability ships in any form, and no MCP server is bundled or defaulted.

PDF editing is not promised. Legacy `.doc`, encrypted documents, macro-enabled
Word mutation, OCR, exact layout preservation, collaborative cloud editing,
Excel, PowerPoint, GitHub, VSCode actions, and Notion are outside this cycle.

### 3.3 Tier 3: user-connected MCP

Cycle 6 supports MCP tool discovery and invocation through user-configured
servers. The first MCP scope is tools only. MCP resources, prompts, sampling,
roots negotiation as an authority source, elicitation, and server-initiated
model behavior remain deferred unless required by the selected transport's
minimum compliant handshake.

Aside bundles no MCP server, ships no default server configuration, and names no
server in the system prompt or in tool descriptions. With no server connected,
this tier's tools are absent rather than silently unavailable. The adapter is
verified against deterministic and adversarial fixtures; section 10 records what
a future search capability would have to satisfy, and no part of it is work owed
by this cycle.

An MCP server is code selected and trusted by the user. Aside can control what
it exposes to the model, validate and gate each call, bound the result, and
terminate the connection. Aside cannot truthfully guarantee what an external
server does internally. This limitation must be visible at configuration and
permission time.

## 4. Three-Plane Architecture

### 4.1 Context Plane

The Context Plane passively observes the host only in response to the existing
user-triggered capture flow. It is native-owned and produces bounded snapshots
with provenance, freshness, confidence, and optional resource descriptors.

It must:

- remain separate from MCP;
- avoid background monitoring or indexing;
- preserve the foreground-window binding established in Cycle 4;
- emit references rather than silently reading referenced resources;
- distinguish absent, stale, ambiguous, and validated descriptors;
- never mutate host, workspace, model registry, or permission state.

### 4.2 Runtime Plane

The Runtime Plane owns active execution:

- per-task capability registry construction;
- tool schema validation and invocation;
- model/tool continuation through Pi;
- time, call-count, input, and output limits;
- cancellation and connection teardown;
- typed result normalization and verification state;
- transport adapters for built-in tools and MCP.

The Runtime Plane does not decide trust merely because a tool exists. It calls
the Policy Plane before an effect begins.

### 4.3 Policy Plane

The Policy Plane is a conceptual boundary implemented within the Aside-owned
runtime and permission broker. It evaluates independently:

```text
effect:       read | write | execute
scope:        workspace | host | application | service | none
egress:       none | query | selected_content | file_content | credentialed
source:       builtin | user_mcp
replay:       safe | non_replayable
```

Cycle 6 may refine exact identifiers during P0, but must not collapse effect
and boundary into one value. For example, an MCP search call is a read-like
operation with query egress; an MCP calendar creation is an external-service
write; a local Word save is a workspace write.

Policy decisions must be based on trusted adapter metadata plus validated
arguments. A remote MCP server's self-description is untrusted input and may
not assign itself lower-risk semantics.

## 5. Capability Registry

Every tool visible to the model must have:

```text
stable Aside name and namespace
bounded model description
validated input schema
normalized output contract
effect, scope, egress, source, and replay metadata
availability requirements
execution and cancellation implementation
permission-preview builder where required
result sanitization and display metadata
```

The registry is assembled per task run. A tool that is disabled or unavailable
must be absent from the provider request, not merely hidden in React.

Built-in and MCP tools share the registry contract, but keep distinguishable
namespaces and source metadata. Name collisions fail closed; MCP tools cannot
shadow `workspace.*`, `document.*`, `web.*`, or other reserved Aside names.

## 6. Workspace Foundation

### 6.1 Automatic workspace handoff

When the current capture contains a validated directory, workspace-root,
selected-item, active-file, or document descriptor, the next relevant task run
should resolve it without requiring manual path entry:

- a directory or workspace-root becomes the workspace;
- a file or document uses its containing directory as workspace and the file
  as target;
- an ambiguous multi-selection is presented honestly and never silently
  broadened;
- a stale, missing, or inaccessible descriptor fails without exposing file
  tools against a guessed root;
- an explicit user-selected workspace remains higher priority than inferred
  context for that task.

The handoff is task-local and revalidated. It does not persist blanket access
or call `process.chdir()`.

### 6.2 Foundation tool family

The minimum active family remains:

| Tool | Purpose |
| --- | --- |
| `workspace.list` | Enumerate bounded directory entries |
| `workspace.search` | Search bounded names or supported textual content |
| `workspace.stat` | Inspect validated resource metadata |
| `workspace.read` | Read supported content with offsets and truncation |
| `workspace.write` | Create or replace a supported file after permission |
| `workspace.edit` | Apply an inspectable bounded edit after permission |

Cycle 6 may improve schemas or results while retaining compatibility where it
does not preserve a known usability defect. Search must prefer a mature
library or reviewed implementation for glob/ignore/encoding behavior rather
than invoking a shell command.

### 6.3 Frictionless model behavior

The foundation should support ordinary iterative use without path churn:

- product paths are workspace-relative in model-facing results;
- Windows separators and case behavior are normalized consistently;
- reads expose stable continuation offsets when truncated;
- lists and searches expose counts and continuation information;
- common text encodings are either supported deliberately or rejected with a
  specific recovery message;
- binary files route to a declared adapter rather than accidental UTF-8
  decoding;
- errors distinguish invalid input, missing target, unsupported format,
  boundary escape, stale resource, limit, cancellation, permission denial,
  backend failure, and unavailable capability;
- tool descriptions encourage direct operation and verification without
  teaching the model to use a shell.

### 6.4 Write behavior

Every workspace mutation keeps the Cycle 5 exact-operation permission model.
An approved operation is revalidated and executed once. Word generation and
transformation use the same broker and must never hide a binary write inside a
read tool.

Delete, rename, move, bulk patch, and arbitrary archive manipulation are not
required by Cycle 6 unless a child plan explicitly proves they are necessary
for the stated vertical slices and adds acceptance coverage.

## 7. Unified Document Representation

PDF and Word adapters must return a common bounded envelope rather than an
unstructured text blob:

```text
DocumentResult
  format and detected media type
  product path and resource identity
  metadata
  ordered blocks
  optional tables and references
  page or section locators where available
  truncation and continuation data
  warnings and fidelity limitations
  extraction/validation status
```

The common block vocabulary should cover paragraphs, headings, lists, tables,
page breaks, and opaque/unsupported content. Format-specific fields belong in
bounded extension metadata rather than forcing false equivalence between PDF
pages and Word sections.

Chunking is adapter-independent policy applied after extraction. It must use
stable locators, preserve reading order, remain within configured byte/token
budgets, and make truncation explicit. Adapters may stream internally, but the
model and protocol receive only bounded normalized results.

## 8. PDF Capability

### 8.1 Supported behavior

Cycle 6 supports local, non-encrypted PDFs for:

- metadata inspection;
- bounded text extraction in reading order where the source permits;
- page-range selection;
- page-aware locators and extraction warnings;
- table or structural hints only when the chosen library produces reliable,
  bounded data;
- summarization and question answering through the ordinary model/tool loop.

### 8.2 Honest limits

The PDF tool must report image-only/scanned pages, missing text layers,
password protection, malformed input, unsupported encryption, extraction
limits, and uncertain reading order. OCR and PDF mutation are not implicit
fallbacks. No temporary conversion process may be launched outside the
reviewed adapter implementation.

PDF remains read-only in Cycle 6. The registry must not advertise PDF edit,
annotation, form filling, page rearrangement, or overwrite behavior.

## 9. Word Capability

### 9.1 Supported behavior

Cycle 6 supports ordinary non-encrypted `.docx` files for:

- bounded structured reading;
- metadata, paragraphs, headings, lists, and tables;
- creation of a new `.docx` from the supported document representation;
- transformation into a new output file with a preview and permission;
- reopening and validating the generated package after write.

Cycle 6 transformation is non-destructive and requires a new output path.
Same-path replacement and overwriting existing Word outputs are deferred.
An output created concurrently must not be overwritten, even after approval.

### 9.2 Fidelity contract

Aside must not promise Microsoft Word round-trip fidelity. Unsupported or
partially preserved elements such as tracked changes, comments, fields,
embedded objects, complex drawings, section layout, macros, external links,
and advanced styles must be detected where practical and summarized before a
transform. The original input is not modified merely to normalize it.

Legacy `.doc` and macro-enabled `.docm` remain unsupported. Word UI automation
and Office process control remain outside the cycle.

## 10. Web Search Capability

**Deferred — actively considered.** Removed from Cycle 6 on 2026-09-18
([C6-I026](./ISSUES.md#c6-i026---web-search-leaves-cycle-6-entirely)). Nothing
in this section is implemented, verified, or accepted this cycle, and no MCP
server is bundled to reach it.

This section is kept because the requirements below are what any future search
capability would have to satisfy, whether first-party or connected. It is not a
plan and not a backlog item with an owner.

### 10.1 Why it was removed

Two delivery routes were evaluated and both were rejected.

**First-party** requires Aside to choose one provider and ship that provider's
contract, terms, attribution, caching, and quota obligations behind a schema
described as provider-neutral. Aside has no budget for a provider relationship,
no settings surface to enable or credential it (C6-I024), and no settings
storage for a key. It also contradicts the product goal: the intent was a
low-cost, self-hostable, swappable search, and committing to one provider's
contract is precisely what removes that freedom.

**Through the MCP adapter** requires no provider selection and no Aside-held
credential, which is why it was the first replacement considered. It was
withdrawn because every keyless search server a user could realistically
connect is a scraper: it drives a real browser against a public search engine
and parses the result HTML. Bundling no server would still make Aside's
*documented* search path a third-party scraper whose availability depends on
that third party continuing to tolerate automation — relocating the dependency
rather than removing it. It also contradicts the "Aside bundles no server"
decision that accompanies it: the product would ship no server while still
pointing the model at one.

A keyed hosted search API avoids the scraper problem and was priced outside the
intended budget for a core method. The disposition is therefore removal from
the cycle rather than substitution.

### 10.2 Requirements for any future search capability

These are stated as product requirements so that a future cycle starts from a
decided contract instead of re-deriving one. They are not acceptance criteria
for Cycle 6: C6-26 through C6-30 were written against a capability that no
longer exists this cycle and are retired.

A search capability, first-party or connected, must:

- accept a bounded query and only the filters its backend actually supports,
  and reject an unsupported filter rather than dropping it silently;
- return bounded results carrying title, URL, snippet, source or domain, date
  with explicit uncertainty, rank, any attribution the backend requires, and
  truncation and warning metadata;
- treat all results as untrusted external content — evidence, never
  instruction — and never let result text change policy, registry, permission,
  or tool arguments by authority;
- preserve enough source identity for the user to inspect what was cited;
- never attach captured context, workspace contents, session history, or local
  files to the outbound request;
- keep credentials out of model messages, React events, logs, and durable
  transcript entries;
- make external egress legible to the user, and never run a silent background
  search;
- produce typed outcomes for absent, misconfigured, rate-limited, offline, and
  refusing backends, and never fabricate a success; and
- never retry after cancellation, and never turn a backend error into invented
  results.

A search capability stays within search results. General browsing, arbitrary
URL fetch, page automation, login, form submission, downloads, and cookie
access remain out of scope for it regardless of what its backend can do.

## 11. MCP Adapter

### 11.1 Configuration and lifecycle

Users may add, disable, and remove MCP server configurations. A configuration
has a stable local identity, display name, transport-specific launch or
endpoint data, bounded environment/credential references, enabled state, and
an explicit trust notice.

Secrets must use an appropriate native secret or environment indirection and
must not be serialized into model-visible tool definitions or ordinary logs.
Configuration parsing fails closed on unknown or unsafe fields.

The runtime owns connection startup, initialization, tool discovery, refresh,
timeouts, cancellation, disconnect, and failure reporting. A broken server
must not prevent built-in tools or ordinary conversation from working.

### 11.2 Initial transport and protocol scope

P6 must choose and document at least one supported transport based on the MCP
SDK available during implementation. Supporting local stdio first is
acceptable, but it must not imply filesystem sandboxing. Remote authenticated
transport may be deferred if its credential and lifecycle design would weaken
the release boundary.

Cycle 6 exposes MCP tools only. Server resources and prompts are not injected
into the model context. Sampling and other server-initiated model operations
are rejected or disabled.

### 11.3 Tool adaptation

Discovered MCP tools are namespaced by server identity and converted into
Aside registry entries. Aside must validate supported JSON Schema features,
bound descriptions and schemas, reject duplicate or reserved names, and make
unsupported definitions unavailable with a diagnostic.

Before enablement, a user or trusted built-in policy mapping must classify the
tool's effect, scope, egress, and replay behavior. Server annotations may
inform the UI but cannot lower the required policy. Unknown tools default to
the highest applicable risk and require explicit enablement and per-call
permission.

MCP calls receive only their validated arguments. A local file path argument
is not proof that the server will obey Aside's workspace boundary. Unless a
reviewed adapter can enforce file scope, the permission UI must treat the call
as user-trusted external execution rather than claim workspace containment.

### 11.4 Results and failure isolation

Text, structured content, images, embedded resources, and errors are converted
into an Aside-owned bounded result. Oversized, malformed, unsupported, or
sensitive content is truncated, omitted, or rejected with an explicit reason.
Raw protocol frames and server diagnostics do not enter the transcript.

Cancellation must stop waiting for the call and request protocol cancellation
when supported. A timeout or disconnect produces one terminal tool result and
must not automatically replay a non-replayable call.

## 12. Permission and Trust

The default policy is:

```text
builtin bounded workspace reads: allowed inside active workspace
builtin workspace writes: exact per-operation permission
MCP server connection: explicit user configuration and enablement
MCP read-only/no-egress call: only when trusted classification proves it
MCP write, execute, host, service, or egress call: exact per-call permission
unknown or conflicting metadata: fail closed / highest applicable risk
```

Permission previews must identify the actual boundary: local workspace,
network provider, application/service, or user-trusted MCP server. They must
show bounded arguments relevant to the decision without exposing credentials.

A connection-level trust decision does not become blanket permission for all
server tools. A prior tool-call approval does not authorize another call.

## 13. Context, Session, and Privacy

Context snapshots, workspace state, provider credentials, MCP connection
state, and pending permissions are transient runtime state. Durable sessions
may retain only bounded user-visible messages and normalized tool records
needed for conversational coherence.

The cycle must not silently persist:

- entire PDF or Word contents solely because an adapter read them;
- raw MCP responses or tracking parameters not shown to the user;
- MCP environment variables, tokens, authorization headers, or raw frames;
- full MCP schemas on every conversation turn;
- expired context descriptors or permission decisions;
- background workspace indexes.

Provider requests receive only the selected tool schemas and content required
for the active task. Context and external tool output remain labeled as
untrusted reference data.

## 14. User Experience

The Side rail must keep ordinary use quiet while making meaningful boundaries
visible. It should show:

- automatically resolved workspace and target;
- current built-in or MCP tool activity;
- PDF/Word progress, page/section scope, and fidelity warnings;
- MCP server identity for an external tool call, and the source identity of
  any external result the model cites;
- permission preview, denial, cancellation, timeout, and terminal status;
- verification of a generated Word document or workspace write.

The UI does not expose raw schemas, protocol logs, internal context-plane
terminology, or instructional copy about how tools work. Detailed diagnostics
belong in a deliberate troubleshooting surface, not the task transcript.

Manual workspace entry may remain as recovery, but successful descriptor
capture should not require it.

## 15. Reliability and Performance

- Tool registration is deterministic for the same task and configuration.
- One broken adapter or MCP server cannot remove unrelated capabilities.
- All parsing and external calls have byte, complexity, duration, and output
  limits plus cancellation.
- Document adapters use fixture-based deterministic tests; MCP uses a faux
  server for the release gate, with its adversarial fixtures derived from
  observed third-party server shapes rather than from our own assumptions.
- Real network credentials are not required for automated tests.
- Unsupported input fails without shell/process fallback.
- Registry and protocol errors never corrupt the durable transcript.
- Exact performance budgets are set during P0/P2 based on representative
  fixtures and recorded in plan evidence rather than guessed in this PRD.

## 16. Dependencies and Licensing

Each new parser, generator, search SDK, or MCP SDK must be reviewed for:

- current license and redistribution obligations;
- maintenance and security posture;
- supported runtime and Windows packaging behavior;
- transitive native binaries or process launches;
- data handling and telemetry defaults;
- deterministic/offline test seams;
- output fidelity and documented limits.

MCP source may be studied for domain schemas and representation choices, but
code is copied only when its license and maintenance cost are acceptable.
Transport and permission glue from an MCP project is not imported into a
first-party adapter merely for convenience.

## 17. Explicit Non-Goals

- shell, PowerShell, terminal, arbitrary process, or code execution;
- a placeholder shell tool exposed to the model;
- Excel, PowerPoint, GitHub, VSCode actions, Notion, calendars, or Drive;
- PDF editing, annotation, OCR, form filling, or page mutation;
- legacy `.doc`, `.docm` mutation, or exact Word round-trip fidelity;
- Word UI automation or Office interop automation;
- general browsing, arbitrary URL fetch, downloads, login, or form actions;
- MCP resources, prompts, sampling, elicitation, or autonomous server actions;
- an MCP marketplace or automatic installation of third-party servers;
- claiming that a user-run MCP server is filesystem- or network-sandboxed;
- permanent blanket permission for workspace writes or MCP calls;
- continuous observation, background indexing, or background agent jobs;
- multiple implicit workspace roots;
- changing the Pi core or adopting a full coding-agent application runtime.

## 18. Acceptance Criteria

### 18.1 Planes and registry

| ID | Scenario | Acceptance |
| --- | --- | --- |
| C6-01 | Capture context without invoking a tool | The Context Plane emits bounded attributed reference data and causes no file, network, host, or registry effect. |
| C6-02 | Inspect an active task registry | Every tool has validated schema, normalized result, effect, scope, egress, source, replay, availability, and cancellation metadata. |
| C6-03 | Disable a capability | It is absent from the model-visible registry and cannot be invoked by name. |
| C6-04 | Tool content attempts to change policy | Runtime treats descriptions, document content, search results, and MCP output as untrusted data; authority is unchanged. |
| C6-05 | Cancel an active operation | Cancellation reaches the adapter, produces one bounded terminal result, and no later write or replay starts. |

### 18.2 Workspace foundation

| ID | Scenario | Acceptance |
| --- | --- | --- |
| C6-06 | Summon on a validated file descriptor | Its containing directory and target bind to the task before the first file call without manual path entry. |
| C6-07 | Summon on a validated directory/workspace descriptor | The directory becomes the one task-local workspace after revalidation. |
| C6-08 | Descriptor is stale, inaccessible, or ambiguous | Aside does not guess or expose scoped tools against an unvalidated root; the UI reports a recoverable state. |
| C6-09 | List/read/search/stat an in-workspace resource | The operation uses normalized product paths, bounded output, typed continuation/truncation data, and no write prompt. |
| C6-10 | Read or search requires continuation | The model can request the next bounded segment without re-reading or losing target identity. |
| C6-11 | Path escapes through syntax, symlink, or reparse point | Runtime rejects it at execution with no outside read or mutation. |
| C6-12 | Write or edit a supported text resource | Aside previews the exact operation, requires one permission, revalidates, executes atomically once, and can verify it. |
| C6-13 | Unsupported file or encoding is encountered | Aside returns a specific typed result and never invokes a shell, process, or guessed parser. |
| C6-14 | Foundation tool hits input, output, time, or traversal limit | It returns a bounded limit result and the task remains responsive and cancellable. |

### 18.3 Document representation and PDF

| ID | Scenario | Acceptance |
| --- | --- | --- |
| C6-15 | Read a supported document | The adapter returns the common document envelope with stable locators, warnings, and explicit truncation. |
| C6-16 | Read selected PDF pages | Aside extracts only the requested bounded page range and preserves page-aware source locations. |
| C6-17 | Read a scanned, encrypted, malformed, or text-poor PDF | Aside reports the applicable limitation and does not claim complete extraction or start OCR. |
| C6-18 | Ask to edit a PDF | No mutation tool is exposed; Aside explains that PDF mutation is unsupported in this cycle. |
| C6-19 | Oversized/complex PDF exceeds policy | Parsing stops within configured limits and returns a typed partial or limit result without destabilizing the runtime. |

### 18.4 Word

| ID | Scenario | Acceptance |
| --- | --- | --- |
| C6-20 | Read an ordinary `.docx` | Aside extracts bounded headings, paragraphs, lists, tables, metadata, and relevant fidelity warnings in document order. |
| C6-21 | Read encrypted, malformed, legacy, or macro-enabled Word input | Aside returns a typed unsupported/invalid result and performs no conversion process fallback. |
| C6-22 | Create a new Word document | The permission preview identifies the output and structure; approval writes one valid `.docx` and post-write reopening succeeds. |
| C6-23 | Transform an existing Word document | The default output is a new file, the preview states known fidelity loss, the original remains unchanged, and the output is validated. |
| C6-24 | Request same-path replacement or existing Word output overwrite | The operation is unavailable; source and existing output stay unchanged, including a destination created after approval. Replacement implementation is deferred (C6-I009). |
| C6-25 | Unsupported Word features are present | The adapter preserves what its contract supports and reports detected loss/uncertainty before transformation; it does not promise round-trip fidelity. |

### 18.5 Web Search — RETIRED

C6-26 through C6-30 were written against a `web.search` capability. Web Search
was removed from Cycle 6 on 2026-09-18
([C6-I026](./ISSUES.md#c6-i026---web-search-leaves-cycle-6-entirely)), so these
criteria have no subject. They are **retired**, not deferred and not awaiting
an owner. P7 must list them as retired, not as unmet.

Their intent is preserved in
[section 10.2](#102-requirements-for-any-future-search-capability) as
requirements for any future search capability. The IDs are retained here so
they are not silently reused for something else.

| ID | Original scenario | Disposition |
| --- | --- | --- |
| C6-26 | Bounded query and declared filters leave the device | Retired — no search capability ships. Bounded-outbound-payload reasoning survives as a requirement in 10.2. |
| C6-27 | Search result contains hostile instructions | Retired as a search criterion. **The general form is still live**: C6-36 bounds and sanitizes all adapted MCP results, and C6-35 forbids server annotations from claiming authority. |
| C6-28 | Provider absent, misconfigured, limited, or offline | Retired as a search criterion. The MCP equivalents are C6-37 (timeout, disconnect, cancellation) and C6-39 (server failure isolation). |
| C6-29 | Credentials and raw responses absent from session and logs | Retired as a search criterion. The MCP equivalent is C6-36, which excludes raw frames and secrets. |
| C6-30 | Model requests arbitrary browsing or URL action | Retired as a search criterion. The live form is C6-42, which asserts the model-visible tool list contains no arbitrary-fetch capability. |

### 18.6 MCP

| ID | Scenario | Acceptance |
| --- | --- | --- |
| C6-31 | Add and enable a valid MCP server | Runtime initializes it, discovers bounded tool definitions, and exposes only successfully adapted namespaced tools. |
| C6-32 | MCP schema is oversized, malformed, unsupported, duplicated, or reserved | The affected tool is unavailable with a diagnostic; built-in tools and other servers remain usable. |
| C6-33 | Invoke a classified MCP tool | Runtime validates arguments and applies trusted effect/scope/egress/replay policy before sending the call. |
| C6-34 | Invoke an unknown-risk, write, execute, host, service, or egress MCP tool | Aside shows server identity and bounded arguments and requires an exact per-call permission; denial sends no call. |
| C6-35 | MCP claims a local file operation is safe | Server annotations cannot bypass policy or create a false workspace-containment claim. |
| C6-36 | MCP returns oversized, malformed, binary, or sensitive content | Aside bounds, sanitizes, rejects, or omits it with an explicit normalized result; raw frames do not enter the transcript. |
| C6-37 | MCP call times out, disconnects, or is cancelled | It produces one terminal result, tears down or recovers the connection as specified, and never auto-replays a non-replayable action. |
| C6-38 | MCP requests resources, prompts, sampling, or server-initiated model behavior | The unsupported capability is not exposed or is explicitly rejected without changing model state. |
| C6-39 | MCP server fails during startup or runtime | Aside conversation and built-in capabilities continue; failure is isolated to that server. |

### 18.7 UX, regression, and release

| ID | Scenario | Acceptance |
| --- | --- | --- |
| C6-40 | Observe a representative task in the Side rail | Workspace, tool source, external boundary, permission, document warning, verification, and terminal state are understandable without raw protocol details. |
| C6-41 | Restore a durable session | Pending permissions, active MCP connections, credentials, full document contents, and stale context are not restored as authority. |
| C6-42 | Inspect the complete model tool list | It contains no shell, PowerShell, process, code-execution, PDF-edit, arbitrary-fetch, or out-of-scope Tier 2 capability. |
| C6-43 | Run deterministic acceptance coverage | Faux filesystem, PDF/Word fixtures, and a faux MCP server whose adversarial fixtures are derived from observed third-party server shapes provide success, limits, cancellation, policy denial, malformed input, and isolation coverage. |
| C6-44 | Exercise existing summon, capture, streaming, permission, session, and window flows | Cycle 2 through Cycle 5 behavior remains intact except for explicitly documented contract improvements. |
| C6-45 | Complete representative Windows workflows | Automatic workspace file work, PDF reading, Word transform-to-new-file, and one manually configured MCP server smoke test produce recorded manual evidence. |

## 19. Release Boundary

Cycle 6 closes only when:

1. a validated captured target automatically binds the task workspace and the
   foundation file loop is demonstrably fluent without shell fallback;
2. the capability registry and Policy Plane express effect, boundary, egress,
   source, replay, availability, limits, and cancellation for every tool;
3. PDF read and Word read/create/transform satisfy their honest format,
   privacy, permission, and verification contracts;
4. user-configured MCP tools pass through namespacing, trusted classification,
   permission, cancellation, and result normalization, with external-server
   limitations stated truthfully — verified against deterministic and
   adversarial fixtures plus one manual server smoke test, and not claiming
   field validation it does not have;
5. deterministic tests and representative Windows manual checks satisfy
   C6-01 through C6-45; and
6. the model-visible registry contains no shell or other explicitly deferred
   execution path.

Partial protocol connectivity, parser demos, or a UI that only appears to
support these behaviors does not close the cycle. Any unmet item must be
recorded as a scoped deferral without weakening the security claims of the
capabilities that do ship.
