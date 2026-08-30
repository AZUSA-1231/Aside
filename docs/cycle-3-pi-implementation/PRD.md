# Cycle 3 Pi Implementation Product Requirements

Status: reviewed planning baseline; implementation pending  
Platform: Windows desktop  
Predecessor: [Cycle 2 Side Surface](../cycle-2/PRD.md)

This cycle integrates Aside with Pi's reusable agent kernel. It keeps Pi's
agent loop and execution semantics for the prompt/cancel path, while replacing
the coding-agent-shaped context assumptions with an Aside-owned model for
everyday flows and typed turn context.

## Document Set

| Document | Responsibility |
| --- | --- |
| This PRD | Product behavior, scope, context boundary, and acceptance criteria |
| [Implementation plan index](./PLANS.md) | Delivery order, work packages, and exit criteria |
| [Issues log](./ISSUES.md) | Problems, surprises, and decisions discovered during implementation |

There is intentionally no separate verification record for Cycle 3. Evidence,
exceptions, and decisions that would normally be recorded there belong in the
issues log and in the exit criteria of each implementation plan.

## 1. Objective

Replace the Cycle 1 conversation wrapper with a durable Aside runtime built on
Pi's agent kernel. The runtime must retain Pi's proven streaming,
cancellation, turn-boundary, and provider behavior without importing Pi
implementation details into React or Tauri. Cycle 3 exposes only the
`prompt`/`cancel` product path; Pi's queue and follow-up semantics remain an
internal reuse detail until a later protocol need is demonstrated.

Aside must be able to receive different product flows and context shapes. A
reminder flow, a schedule flow, a note flow, and an ordinary conversation may
all enter the same kernel while retaining their own typed context. The kernel
must not assume that every context is a repository, a working directory, or a
coding task.

## 2. User and Primary Scenarios

The target user still summons Aside for a short everyday interaction. Cycle 3
changes the runtime behind that interaction:

```text
User opens Aside
  -> runtime restores the local Aside session
  -> user submits a prompt and an optional flow context
  -> Pi runs the agent loop and streams the response
  -> Aside renders the response and persists the conversation
  -> the temporary flow context expires with the run
```

The runtime must also support these product shapes:

1. A normal conversation with no external context.
2. A domain flow with typed text references, such as a reminder description.
3. A domain flow with typed JSON references, such as a schedule draft or
   note metadata.
4. A multi-step flow whose `flow.id` remains stable while individual requests
   receive different `request_id` values.
5. A restarted runtime that resumes the latest durable conversation without
   resurrecting an old temporary context block.

## 3. Scope

### Included

- Pi `Agent` and agent-loop behavior behind the `agent-runtime` boundary.
- Pi provider/model configuration behind the runtime boundary.
- A durable local Aside session using Pi's append-only session design.
- Restoration of the persisted Aside conversation when the runtime starts.
- Aside-owned flow and turn-context contracts.
- Bounded text and JSON context blocks for current-turn provider requests.
- A provider projection that combines durable conversation messages with the
  active Aside context without persisting the temporary context.
- Runtime events for readiness, restored history, streaming, cancellation,
  completion, failure, and recoverable persistence warnings.
- Deterministic tests for stream, cancellation, retry, context projection,
  context isolation, persistence, and restoration.

### Explicitly not included

- Pi's coding-agent harness as an Aside product dependency. The current Pi
  `AgentHarness` operation paths are not complete enough to be the runtime
  contract for this cycle.
- Coding-agent system prompts, repository discovery, working-directory
  context, skills, shell execution, file tools, or editor tools.
- Reminder, schedule, note, or other domain tools. This cycle defines the
  context boundary that those features will use later.
- Automatic inspection of another application's content, clipboard, screen,
  accessibility tree, DOM, or input events.
- Product accounts, cloud sync, multi-user sessions, or remote context stores.
- A session browser or conversation search UI.
- A separate retry/steering/follow-up protocol. A retry in this cycle is a new
  `prompt` request after the failed run has been excluded from durable history.
- A new agent loop, provider abstraction, or generic context bus written by
  Aside.

## 4. Kernel Ownership Boundary

Pi is reused directly for execution semantics:

- `Agent` owns the in-memory transcript, active run state, abort signal,
  steering queue, and follow-up queue.
- Pi's low-level agent loop owns assistant turns, tool-call sequencing, and
  event ordering.
- `pi-ai` owns provider/model types and provider stream behavior.
- Pi's message and usage shapes remain internal to `agent-runtime`.

Aside owns the product adapter:

- the Aside-facing request and event protocol;
- flow identity and context validation;
- the projection from durable session entries to provider messages;
- persistence timing and recovery policy;
- domain-tool registration and permission policy in later cycles;
- the display-oriented history projection consumed by React.

The neighboring `pi` repository is the source reference for the reviewed Pi
version and its design. Aside must consume the Pi package API through the
runtime package boundary; it must not fork or copy the agent loop into Aside.
If local development requires a workspace link or a newer Pi build, that
dependency decision belongs in [ISSUES.md](./ISSUES.md) and must preserve the
same package boundary.

## 5. Context Model

Aside has three separate context layers:

### 5.1 Durable conversation transcript

The session stores the user and assistant conversation needed to continue a
conversation. Future domain tools may add standard tool-result messages. The
session does not store the temporary context envelope described below.

The durable transcript must not contain:

- current desktop state that can become stale;
- hidden provider instructions;
- raw Windows handles or native structures;
- provider credentials;
- unapproved content from another application.

### 5.2 Flow identity

A flow represents the product operation around one or more prompts. It is not a
session and it is not a provider request.

```json
{
  "id": "flow-opaque-id",
  "kind": "conversation",
  "label": "optional display label"
}
```

`id` is opaque and stable for the lifetime of the flow. `kind` is a bounded
lowercase application identifier. The initial built-in kind is
`conversation`; later cycles may register kinds such as `reminder`, `schedule`,
or `note` without changing the kernel contract. `label` is optional display
metadata and is not an instruction to the model.

### 5.3 Turn context envelope

The optional context supplied with one prompt is an explicit reference envelope
for that run:

```json
{
  "flow": {
    "id": "flow-opaque-id",
    "kind": "schedule"
  },
  "blocks": [
    { "type": "text", "label": "User goal", "text": "..." },
    { "type": "json", "label": "Draft event", "data": { "...": "..." } }
  ]
}
```

The Cycle 3 contract permits only two block types:

- `text`: human-readable reference text supplied by an explicit Aside flow;
- `json`: finite JSON data supplied by an explicit Aside flow.

All fields are untrusted data. The provider projection labels the envelope as
reference context and instructs the model to treat it as data rather than as a
new system instruction. The runtime validates size, nesting, identifiers, and
JSON serializability before projection.

The envelope is scoped to the current `Agent.prompt()` run. It is available to
all provider turns caused by that run and is discarded after `agent_end`. It is
never appended to the durable session by default. Cycle 3 does not expose
Pi-managed steering or follow-up queues through the product protocol.

The initial limits are deliberately small and implementation-independent:

| Limit | Default |
| --- | ---: |
| Blocks per envelope | 8 |
| Text block size (UTF-8 bytes) | 8 KiB |
| JSON block size (UTF-8 bytes) | 16 KiB |
| Total projected context (UTF-8 bytes) | 24 KiB |
| Maximum JSON nesting depth | 4 |

These values are runtime constants so tests and future domain flows share one
budget. Raising a limit is a later scope decision, not a per-flow override.

### 5.4 Provider projection

Before each provider request, the adapter applies this order:

```text
durable session messages
  -> Aside turn-context projection (ephemeral)
  -> Aside custom-message filtering
  -> Pi convertToLlm boundary
  -> pi-ai provider request
```

The projection belongs in the runtime's Pi `transformContext`/`convertToLlm`
boundary. React and Tauri never build provider messages. For a non-empty
envelope, the adapter inserts exactly one synthetic user message immediately
before the active user prompt, with a fixed reference-context marker and a
deterministic serialization of the blocks. The marker states that all fields
are untrusted reference data, not instructions. Repeated provider turns reuse
that one projection and must not append another copy.

## 6. Functional Requirements

### FR-3.1 Pi kernel reuse

All model runs use Pi's `Agent` and its agent-loop implementation. Aside must
not implement a second loop for retries, tool turns, cancellation, or queued
messages. The adapter may translate events and provide callbacks required by
the Aside boundary.

### FR-3.2 Aside runtime isolation

The runtime is the only Aside-owned module allowed to import Pi packages. The
frontend and Tauri layer use Aside-owned serialized contracts only. Provider
credentials, raw Pi messages, tool schemas, and model instances do not cross
the runtime process boundary.

### FR-3.3 Session lifecycle

The runtime must open or create one local active Aside session, load its
durable branch, project restorable messages, and seed the Pi `Agent` before it
accepts a new prompt. Cycle 3 does not require a session picker.

The default session is local and application-owned. Session metadata must
identify the application and schema version so Aside does not accidentally
open an unrelated coding-agent session. The storage location and any package
or workspace dependency choice must be explicit and configurable for tests and
packaging.

### FR-3.4 Durable message policy

Finalized user, assistant, and future tool-result messages may be persisted in
Pi session entries. Partial streaming deltas are UI events, not session
records. Assistant messages ending in `error`, `aborted`, or `deferred` must
not be treated as successful conversation history for the next provider
request.

Session writes are serialized. A persistence failure must not discard a
response already received by the user; it must emit a recoverable warning and
must prevent the runtime from silently claiming that the failed write was
durable.

### FR-3.5 Flow and context validation

The runtime validates every flow and context envelope at the Aside boundary.
Invalid context is rejected before a provider call. Validation failures are
recoverable request errors and do not mutate the durable session.

Cycle 3 uses the bounded limits listed in the context model. They are runtime
constants, documented in the runtime types, and covered by deterministic
tests. A domain flow cannot bypass those limits by encoding an oversized object
as a different block type.

### FR-3.6 Context isolation

Context supplied for request A must be visible to provider calls for request A
and absent from request B unless supplied again. Restarting the runtime must
restore conversation messages but must not restore request A's temporary
context. Flow identity may be reported to runtime observers but is not durable
conversation content by default.

### FR-3.7 Streaming and cancellation

The runtime continues to expose incremental assistant text, one active request
per current UI surface, cancellation, terminal completion, and recoverable
failure. Pi's abort behavior is the source of truth for cancellation. Every
accepted request produces at most one terminal event for its request id.

A retry is a fresh `prompt` request after a provider failure. The adapter does
not persist the failed assistant response as successful conversation history.

Late events from an older request must not update a newer request in the UI.

### FR-3.8 Runtime protocol

The protocol remains JSONL between Tauri and the runtime process. The protocol
must use Aside-owned shapes:

```text
prompt(request_id, text, context?)
cancel(request_id)
```

The runtime emits an Aside-owned readiness event, restored display history,
run lifecycle events, text deltas, terminal events, and recoverable session
warnings. No event exposes a Pi `Agent`, Pi session entry, provider response,
credential, or raw context object.

### FR-3.9 Future domain-tool seam

Cycle 3 does not ship domain tools. The runtime must nevertheless retain a
typed registration seam where a later domain feature can provide tools with an
Aside-defined context and permission policy. Coding-agent tools must not be
registered as a shortcut for proving this seam.

### FR-3.10 Privacy and capability boundary

The kernel integration does not add screen capture, OCR, accessibility, DOM
access, clipboard reads, keyboard logging, arbitrary process control, or shell
execution. A future tool must pass the architecture and privacy review before
it can access any such capability.

## 7. Non-Functional Requirements

- The same prompt and context produce the same projected message shape.
- Session restoration is deterministic for a valid session file.
- Temporary context is bounded in count, size, and nesting depth.
- Provider and persistence errors are sanitized before leaving the runtime.
- Runtime tests can inject a faux Pi provider and an in-memory session.
- The runtime can be upgraded when Pi changes without changing React
  contracts.
- Existing Cycle 2 window, shortcut, Pin, and Side/Workspace behavior remains
  outside the runtime change surface.

## 8. Acceptance Criteria

| ID | Scenario | Expected result |
| --- | --- | --- |
| C3-01 | Send a normal prompt | Pi streams the response through the Aside runtime protocol. |
| C3-02 | Cancel a streaming prompt | Pi aborts the active run and the protocol emits one cancelled terminal event. |
| C3-03 | Re-submit after a provider failure | A new `prompt` request can run after failure, and the failed assistant response is not restored or persisted as successful history. |
| C3-04 | Restart the runtime | The latest valid Aside conversation is restored before the next provider run. |
| C3-05 | Send text context | The text block is present in the current provider projection and is not present in a later run unless supplied again. |
| C3-06 | Send JSON context | JSON is validated, bounded, projected as reference data, and never interpreted as coding-agent context. |
| C3-07 | Use different flow kinds | Conversation and future domain-shaped flow identifiers pass through one stable runtime contract. |
| C3-08 | Fail session persistence | The response remains available, a recoverable persistence warning is emitted, and durability is not misreported. |
| C3-09 | Inspect the frontend boundary | React imports only Aside contracts and IPC helpers; no Pi package or Pi class crosses the boundary. |
| C3-10 | Inspect capability scope | No coding-agent tools, shell execution, repository discovery, screen inspection, or expanded Windows capability is added. |
| C3-11 | Run existing checks | Frontend, Rust, and runtime quality checks remain green. |

## 9. Boundary Decisions

| Decision | Cycle 3 choice |
| --- | --- |
| Agent loop | Reuse Pi `Agent` and agent-loop behavior directly. |
| AgentHarness | Do not depend on the current scaffold; revisit only when its required operation paths are complete. |
| Context ownership | Aside owns validation and projection; Pi only receives the final provider-compatible context. |
| Temporary context | Run-scoped and non-durable by default. |
| Durable session | Use Pi's append-only session design behind an Aside session adapter. |
| Product protocol | Keep JSONL and expose only Aside-owned events. |
| Coding-agent behavior | Excluded, including files, shell, skills, repository context, and coding prompts. |
| Domain tools | Deferred; define the typed seam now and add capabilities in later cycles. |

## 10. Release Boundary

Cycle 3 is complete when the kernel adapter, context isolation, durable session
restore, runtime protocol, and acceptance criteria above are implemented. A
real provider's response quality, domain-tool behavior, and manual Windows
surface acceptance remain separate release concerns.
