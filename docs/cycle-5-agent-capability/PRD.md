# Cycle 5 Agent Capability Product Requirements

Status: proposed planning baseline
Platform: Windows desktop
Predecessor: [Cycle 4 Contextual Sidecar](../cycle-4-contextual-sidecar/PRD.md)

Cycle 5 turns Aside from a conversational runtime into a general-purpose
workspace task agent. It keeps Aside's contextual sidecar identity, but gives
the agent the execution capabilities needed to inspect, understand, and
modify user-owned documents and other workspace resources.

The long-lived ownership and privacy rules remain in
[Architecture](../ARCHITECTURE.md). This document defines the Cycle 5 product
role, behavior, capability boundaries, and acceptance criteria. The
implementation order and execution record are kept in the
[Execution Plan](./PLAN.md) and [Issues Log](./ISSUES.md).

## Document Set

| Document | Responsibility |
| --- | --- |
| This PRD | Product behavior, scope, capability policy, and acceptance criteria |
| [Execution plan](./PLAN.md) | Cross-plan order, shared invariants, traceability, and release boundary |
| [Issues log](./ISSUES.md) | Implementation surprises, decisions, exceptions, and follow-up |

The execution plan deliberately does not replace the detailed `plans/P*.md`
files. It coordinates them; each child plan owns its tasks, deliverables,
exit criteria, and checks. Evidence is recorded in those plans and the issues
log rather than in a separate verification file during implementation.

## 1. Objective

Enable Aside to complete useful document and workspace tasks through the same
kind of autonomous tool loop used by a coding agent:

~~~text
user intent
  -> resolve and bind workspace
  -> model turn
  -> tool call
  -> tool result
  -> model turn
  -> ...
  -> verified result
~~~

The model decides the next step from each tool result. Aside does not require
the model to produce a complete plan before execution. A plan may emerge in
the model's reasoning, but it is not a separate product phase or a
prerequisite for a task to start.

The first useful vertical slice is:

> Capture a file or workspace from the foreground host, switch the task to the
> file's containing workspace, let the agent read and understand it, and allow
> a concrete write only after an explained user permission decision.

Cycle 5 should make Aside useful for documents first while preserving a path
to coding, reminders, schedules, and other future skills. Coding is a
supported workflow pattern, not the definition of the product.

## 2. Agent Role and Responsibility

### 2.1 Product role

Aside is a contextual workspace task agent. It helps the user complete a
bounded task in the application or resource the user is currently working
with. It is responsible for understanding intent, selecting capabilities,
performing permitted work, and reporting a result that is grounded in the
work it actually performed.

Aside is not:

- a passive chat completion wrapper;
- a continuously observing desktop assistant;
- a coding-only agent;
- an unrestricted shell or computer-use agent;
- an autonomous actor that may write files without a current user decision.

### 2.2 Agent responsibilities

For every task, the agent must:

1. Understand the user's goal and ask a focused clarification question when
   the target, desired change, or required output is ambiguous.
2. Establish the task workspace before reading a referenced file or resource.
3. Treat captured host context as reference data, not as permission to access
   the referenced resource.
4. Use the smallest suitable set of registered tools and skills.
5. Make progress through an autonomous model/tool loop, using tool results to
   choose subsequent actions.
6. Keep all file and resource access inside the active workspace boundary.
7. Request permission before every write-capable operation that changes user
   workspace state.
8. Explain the proposed write in terms the user can inspect, including the
   target and intended effect.
9. Verify an approved change when a suitable read or validation operation is
   available.
10. Stop, recover, or ask for help when a tool fails, the target becomes stale,
    permission is denied, or the task exceeds its bounded execution limits.
11. Distinguish completed work from proposed work and never claim a change was
    made without a successful tool result.

### 2.3 Non-responsibilities

The agent must not infer broad authority from:

- the user's use of the summon shortcut;
- a foreground-window identity;
- a captured path descriptor;
- a skill being loaded;
- a previous permission decision for a different operation;
- the fact that a path is readable;
- the fact that a resource is inside a familiar repository or folder.

## 3. Core Concepts

Cycle 5 introduces four product concepts above the existing Pi agent loop.

### 3.1 Task run

A task run is one bounded unit of agent work associated with a user prompt.
It owns the transient execution context for that prompt and its continuing
tool loop.

~~~text
TaskRun
  id
  prompt
  active workspace
  target references
  captured host context
  available tools
  loaded skills
  permission decisions
  execution limits
  run status
~~~

A task run is not the durable conversation session. A session may contain
multiple task runs, and a task run may produce multiple model turns and tool
results.

### 3.2 Workspace

A workspace is the canonical directory boundary used to resolve relative paths
and construct the per-run execution environment. It is an execution scope,
not merely a label shown in the UI.

The active workspace must be established before a file or document tool reads
the resource. Aside must pass the workspace to tools through an explicit
per-run environment. It must not call process.chdir or use process-global
working-directory mutation.

The durable Aside session directory remains separate from the active user
workspace. Changing the active workspace must not move, fork, or rewrite the
conversation session.

### 3.3 Tool

A tool is a typed, bounded, model-callable operation. It has a stable name,
schema, effect classification, execution implementation, and user-visible
result contract.

Tools are the only route by which the agent can inspect or change workspace
resources. Prompt text, skills, and captured context do not directly execute
filesystem or host operations.

### 3.4 Skill

A skill is a reusable task method consisting of model-visible instructions,
usage guidance, and optionally a small set of task-specific resource
references. A skill explains how to approach a kind of work; it does not grant
access, bypass permission, or replace tool validation.

Skills may be selected by the model or explicitly invoked by the user. A skill
must use the same registered tools and permission path as an ordinary prompt.

## 4. Relationship to Pi

Aside should reuse Pi's mature agent foundations wherever the API fits the
product boundary.

### 4.1 Reuse from Pi

Cycle 5 should prefer the following Pi capabilities over duplicating them:

- Agent and the low-level agent loop;
- assistant tool-call sequencing and tool-result messages;
- AgentTool schemas and execution contracts;
- cancellation, abort signals, streaming, and queue semantics where useful;
- bounded file-tool primitives such as read, edit, write, search, listing, and
  truncation;
- typed filesystem and execution environment abstractions;
- skill data structures, SKILL.md loading, validation, and system-prompt
  formatting where suitable;
- compaction and other context-management primitives when they fit the
  transient-context policy;
- Pi's tests and faux provider patterns as reference for deterministic runtime
  coverage.

### 4.2 Aside-owned adaptations

Aside must own and adapt the parts that define its product behavior:

- task-run creation and workspace resolution;
- per-run execution environment construction;
- tool registry, effect metadata, allowlists, and capability policy;
- permission requests, pending decisions, denial results, and UI events;
- document-specific adapters and formats not provided by Pi;
- host-capture handoff from Cycle 4 descriptors;
- Aside runtime protocol and React-facing event projection;
- separation of durable conversation storage from user workspace state;
- recovery behavior for a tool call paused on permission or interrupted during
  execution.

### 4.3 Coding-agent package boundary

The full Pi coding-agent application must not become Aside's product runtime.
Its CLI, TUI, global settings, project trust UX, fixed-cwd assumptions, and
default shell behavior do not define Aside.

Aside may reuse source-level tool implementations or small adapters when
their contracts are compatible, but the resulting tool must execute against
Aside's per-run environment and permission broker. Aside must not import
coding-agent UI modules into React or make the coding-agent package a hidden
application dependency.

The current Pi AgentHarness API may be adopted only for the portions that
are implemented and compatible with this boundary. Unimplemented harness
operations must not be treated as shipped behavior. Cycle 5 may retain the
existing Agent adapter while incrementally introducing harness-compatible
interfaces.

## 5. Workspace-First Behavior

Workspace selection precedes file access.

### 5.1 Workspace resolution sources

The active workspace may be resolved from, in descending order of
specificity:

1. An explicit user-selected workspace for the current task.
2. A validated Cycle 4 workspace descriptor.
3. A validated file or document descriptor, using its containing directory.
4. A user-provided path that Aside validates and converts into a workspace.
5. A previously active task workspace only when the user is continuing the
   same task and the target remains valid.

If no valid workspace can be resolved, file tools must not be exposed as
usable capabilities. The agent may answer a non-file question or ask the user
to select a workspace.

### 5.2 File-to-workspace mapping

For a file-oriented target:

~~~text
C:\docs\report.docx
  -> active workspace: C:\docs
  -> target reference: report.docx
~~~

The agent should use a workspace-relative target in subsequent tool calls
where possible. Absolute paths may be accepted for compatibility, but the
tool must resolve and validate them against the active workspace before
execution.

For a captured workspace-root or directory descriptor, the descriptor path
itself becomes the active workspace. For a selected item or active document,
the containing directory becomes the default active workspace unless the user
chooses another valid scope.

### 5.3 Workspace activation

Workspace activation must:

- canonicalize and validate the directory;
- reject missing, non-directory, inaccessible, or unsupported resources;
- resolve symlink/reparse behavior according to the filesystem policy;
- create a per-run execution environment rooted at that directory;
- expose the active workspace and target reference to the model;
- emit a user-visible workspace state event;
- leave durable Aside session storage unchanged.

Workspace activation is not itself a write operation and does not require a
write permission prompt. It is an access-scope decision and must still be
visible and explainable.

### 5.4 Workspace boundary

Every workspace tool must enforce the active workspace boundary at execution
time, not only when arguments are parsed. The boundary check must account for:

- relative and absolute paths;
- path normalization and case behavior on Windows;
- symlinks, junctions, and reparse points;
- replacement of a target between validation and execution;
- file-versus-directory expectations;
- attempts to escape through .. or alternate path syntax.

A path outside the active workspace is rejected with a structured tool error.
The agent may ask the user to activate a broader or different workspace, but
must not silently expand the current one.

### 5.5 Multiple workspaces

Cycle 5 supports one active workspace per task run. If a task requires
resources from multiple unrelated directories, the agent must ask the user to
select a broader workspace or explicitly switch the task workspace. A tool
call must never implicitly introduce a second root.

## 6. Tool Capability Model

### 6.1 Tool registry

Aside owns a registry that publishes only tools enabled for the current task
run. Each entry must include:

~~~text
name
description
parameters schema
effect: read | write | external
scope: workspace | host | application | none
execution implementation
replay policy
display metadata
~~~

The registry must reject duplicate names, invalid schemas, missing effect
metadata, and tools that have no execution boundary.

Tool availability is a capability decision. A tool that is not registered or
not active must be unavailable to the model, not merely hidden in the UI.

### 6.2 Initial tool families

The first workspace tool set should be:

| Tool family | Effect | Purpose |
| --- | --- | --- |
| workspace.list | read | List bounded children of a directory |
| workspace.search | read | Search names or bounded text content within the workspace |
| workspace.stat | read | Inspect validated file or directory metadata |
| workspace.read | read | Read bounded text or supported document content |
| workspace.write | write | Create or replace a file after permission |
| workspace.edit | write | Apply a bounded, inspectable change after permission |

The exact public names may follow the adopted Pi tool names if the Aside
protocol can preserve their workspace and permission semantics. The product
contract must not depend on a tool being named read, write, or edit if a more
explicit Aside name is needed.

Shell, PowerShell, arbitrary process execution, code execution, browser
automation, host mutation, and external network actions are outside the
initial default registry. They require a separate capability decision and
permission design.

### 6.3 Read tools

Read tools may execute without an interactive permission prompt when all of
the following are true:

- the active workspace is valid;
- the target is inside the active workspace;
- the tool's declared scope and input are valid;
- the requested operation stays within its size, time, and output limits;
- the tool does not mutate the host or workspace.

Reading a file is not permission to write it. A read result must be bounded,
tagged with the resolved target, and returned to the model as a tool result.

### 6.4 Write tools

Write tools include any operation that can change user workspace state,
including creation, overwrite, edit, rename, move, delete, append, metadata
mutation, or document save. These operations require a permission decision
before the effect starts.

The tool must provide enough structured information for the permission UI to
show:

- active workspace;
- target path or paths;
- operation type;
- a human-readable explanation;
- a bounded diff, replacement summary, or content preview when available;
- whether the target is new, modified, moved, or deleted;
- any relevant limitation or uncertainty.

A write tool must not hide a second write inside a read or validation helper.
Any multi-file or multi-effect operation must enumerate its full scope before
permission is requested.

### 6.5 External and host tools

Tools that send data outside the local workspace, mutate another application,
open a URL, create a calendar event, or invoke an external service are
classified as external even if they do not write a local file. They are not
part of the initial default workspace registry. Future domain and host tools
must use the same permission broker with an operation-specific explanation.

### 6.6 Tool results

Every tool call must produce a stable result, including blocked, denied,
cancelled, timed out, stale-target, and failed outcomes. A denied operation
must return an explicit error tool result to the model so the agent can stop,
adjust, or ask a different question.

Tool results must not expose raw native handles, provider credentials, or
unbounded diagnostics. Results should include the resolved product path,
operation status, bounded output, and a structured error code when relevant.

## 7. Permission Model

### 7.1 Permission principle

The default policy is:

~~~text
any valid active workspace: read allowed
any user workspace mutation: permission required
external or host mutation: permission required and separately enabled
~~~

Permission is enforced by the orchestration/runtime boundary, not by model
instructions alone. A malicious or mistaken model cannot bypass the gate by
choosing another tool or embedding a command in an argument.

### 7.2 Permission lifecycle

For a write-capable tool call:

~~~text
tool call received
  -> validate schema and workspace scope
  -> prepare bounded operation description
  -> emit permission_requested
  -> wait for allow / deny / cancel
  -> if allowed, execute exactly that prepared operation
  -> emit tool result
  -> resume the agent loop
~~~

The permission request must bind to the exact tool call, target set, and
prepared operation. It must expire when the task run is cancelled, the target
changes, the workspace changes, or the prepared operation is no longer valid.

### 7.3 Permission decisions

Cycle 5 supports three user outcomes:

- allow: execute the exact described operation once;
- deny: do not execute it and return a denial tool result;
- cancel: abort the active task run and do not execute it.

Cycle 5 does not grant permanent write access to a workspace. A future
session-level trust setting would require a separate product and privacy
decision.

### 7.4 Permission UI

The Side rail must present a clear, interruptible permission state. The user
must be able to see what will change before choosing. The UI must not imply
that a denied operation succeeded.

The permission event and response are Aside-owned protocol objects. React does
not execute the tool and does not receive a raw function or native object.

### 7.5 Race and stale-target handling

Before executing an approved write, the runtime must revalidate:

- the task run is still active;
- the active workspace is unchanged;
- every target still resolves to the prepared identity or expected version;
- the operation has not expired or been cancelled;
- the user decision matches the exact pending operation.

If validation fails, the write is not executed. The model receives a
structured stale or invalidated result and the UI explains why a new decision
may be needed.

### 7.6 Recovery and replay

Permission waiting and write execution are distinct states. The runtime must
not automatically repeat a write after process restart unless the tool's replay
policy explicitly declares that behavior safe. In the initial slice, user
workspace writes use a never replay policy. An interrupted write must be
reported as uncertain or failed according to the underlying atomicity
guarantee, never silently retried.

## 8. Skills and Resource Loading

### 8.1 Skill purpose

Skills make the agent better at repeatable workflows without hard-coding every
workflow into the orchestration layer. A skill may define:

- when it applies;
- a recommended method;
- document or output conventions;
- validation and verification guidance;
- which registered tools it expects to use.

Skills must not define their own filesystem executor, permission bypass,
workspace root, or hidden network access.

### 8.2 Initial skill model

Cycle 5 should support SKILL.md-compatible resources with:

- bounded name and description validation;
- an explicit source and trust classification;
- model-visible summaries;
- full instructions available only through the intended skill invocation
  path;
- diagnostics for malformed, duplicated, inaccessible, or untrusted skills;
- explicit user invocation as well as model selection when enabled.

The initial built-in skills should be small and representative, for example:

- inspect and summarize a workspace resource;
- revise a document while preserving its requested structure;
- produce a document transformation or report.

Their exact names and content are implementation decisions, but none may
assume coding-only behavior.

### 8.3 Skill trust and scope

Skill source trust is separate from workspace write permission. A project
skill may contain instructions that are useful but untrusted. Skill content is
data/instructions for the model, not an authorization token.

Cycle 5 should have a conservative source policy:

- Aside-bundled skills may be enabled by default;
- user skills may be enabled through an explicit resource setting;
- workspace/project skills must be bounded, diagnosable, and never silently
  grant extension or process execution capability;
- untrusted or malformed skills are ignored or surfaced as diagnostics;
- skill instructions are never treated as higher priority than Aside's system
  and permission policy.

### 8.4 Skill invocation

Whether a skill was selected automatically or explicitly, the resulting
execution uses the same task run, active workspace, tool registry, and
permission broker. A skill cannot create a hidden second agent loop or invoke
an unregistered tool.

## 9. Autonomous Agent Loop and Orchestration

### 9.1 Loop ownership

Pi owns the mechanics of assistant turns and tool-call sequencing. Aside
orchestration owns the capability decisions around each turn.

~~~text
Aside accepts prompt
  -> Aside resolves task workspace and resources
  -> Pi produces assistant text or tool calls
  -> Aside validates each tool call
  -> Aside executes read or gates write
  -> result enters Pi transcript
  -> Pi decides whether to call another tool or answer
~~~

There is no mandatory pre-planning phase. The model may describe intent in
text, but only a registered tool call performs an operation.

### 9.2 Orchestration responsibilities

The orchestration layer must:

- create and close task runs;
- bind the initial workspace before the first file read;
- construct a per-run execution environment;
- activate tools and skills appropriate to the task;
- route Pi tool calls through schema, scope, effect, and permission checks;
- serialize or parallelize tool calls according to declared tool safety;
- expose pending permission state to the Side rail;
- resume the same agent loop after a permission response;
- propagate cancellation to the model and active tools;
- enforce per-run time, output, tool-call, and recursion/turn limits;
- handle provider errors and tool failures without corrupting the transcript;
- verify approved writes where possible;
- emit stable Aside events for every meaningful lifecycle state.

### 9.3 Bounded execution

Cycle 5 must prevent an agent run from becoming an unbounded background job.
The runtime must enforce configurable bounded limits for at least:

- maximum model/tool steps per prompt;
- maximum active tool duration;
- maximum tool output size;
- maximum file read size and document expansion size;
- maximum number of files in one search or write operation;
- maximum pending permission age;
- maximum concurrent tool calls.

When a limit is reached, the model receives a structured limit result or the
run ends with a recoverable status. The user must be able to cancel the run.

### 9.4 Multi-tool responses

If the model returns multiple tool calls, Aside must use the declared tool
execution mode and permission policy for each call. The initial default should
be sequential execution for writes and for mixed read/write batches. Parallel
execution may be enabled only for independent read operations with explicit
bounded results.

No write in a batch may execute merely because another call in the same batch
was approved.

### 9.5 Verification

Verification is an agent behavior, not a forced pre-planned phase. After a
successful write, the model may use a read or stat tool to verify the result.
For supported document adapters, the tool may provide an intrinsic save or
parse validation result. If verification is unavailable, the final answer
must state that the operation completed without claiming stronger validation.

## 10. Context and Session Policy

### 10.1 Host context handoff

Cycle 4 capture results may initialize a task run:

- a workspace-root descriptor activates that directory;
- a file/document descriptor activates its containing directory and records the
  target resource;
- browser or generic UIA reference context remains transient reference data;
- a path descriptor alone does not grant read or write permission.

The handoff must preserve target provenance and expiry. A stale descriptor
cannot activate a workspace without revalidation.

### 10.2 Durable transcript

The durable session continues to store the conversation needed to resume the
Aside session. Cycle 5 may persist normalized tool-call and tool-result
messages when required for conversation coherence and recovery.

The session must not silently persist:

- raw native handles or host objects;
- provider credentials;
- an entire workspace snapshot;
- temporary permission UI state after it expires;
- unbounded file contents solely because they were read by a tool;
- hidden skill source content when it is not part of the conversation record.

Tool results that are persisted must follow the same bounded and
Aside-owned serialization policy as other messages. Workspace state is not
conversation memory by default.

### 10.3 Context projection

Workspace identity, target references, active skills, and relevant tool
guidance may be projected into the provider request through the runtime
boundary. They must be labeled according to their role and must not become
untrusted user content that can override system policy.

Captured host context remains reference data. It must not be promoted into a
skill, permission grant, or durable workspace authorization.

## 11. Document Assistance Scope

### 11.1 Initial document behavior

Cycle 5 prioritizes document workflows that can be represented through the
workspace tool boundary:

- read and summarize text documents;
- inspect and revise text or structured document representations;
- create bounded reports or transformed outputs;
- preserve file paths and document identity in user-visible results;
- validate writes and report limitations when a format is only partially
  supported.

### 11.2 Binary and structured formats

PDF, Word, Excel, and other binary or structured formats require explicit
adapters. A path descriptor from Cycle 4 is not itself a content reader.

An adapter must declare:

- supported read and write operations;
- format and version limits;
- whether the operation is read, write, or external;
- bounded extraction and output behavior;
- save and atomicity guarantees;
- validation and failure semantics;
- permission preview behavior.

Cycle 5 does not require universal support for every document format. It does
require honest unsupported behavior and a stable adapter seam so unsupported
formats do not fall through to unsafe generic parsing or arbitrary process
execution.

### 11.3 File content privacy

Only the content needed for the active task and requested tool operation should
be read. Aside must not pre-index the workspace, upload the workspace, or
silently read neighboring files without a tool call justified by the task.

## 12. Runtime and IPC Contract

### 12.1 Request vocabulary

The existing prompt and cancel requests remain. Cycle 5 adds product-owned
requests as needed for the permission round trip and workspace lifecycle:

~~~text
prompt(request_id, text, context?, workspace_hint?)
cancel(request_id)
permission_response(request_id, permission_id, decision)
set_workspace(task_id, workspace)
clear_workspace(task_id)
~~~

The final request set may differ in naming, but it must preserve the following
properties:

- strict validation and bounded input;
- request identity and task-run identity;
- no raw Pi or native objects across the boundary;
- one explicit permission response for one exact pending operation;
- idempotent or safely rejectable repeated responses.

### 12.2 Event vocabulary

The runtime must expose enough events for the Side rail to render autonomous
execution and permission state:

~~~text
ready
history_restored
run_started
workspace_resolved
skill_activated
text_delta
tool_call_started
tool_call_update
permission_requested
permission_resolved
tool_result
run_waiting
completed
cancelled
failed
session_warning
~~~

Event payloads are stable Aside-owned serialized contracts. Tool arguments,
previews, and results must be bounded and sanitized before emission.

### 12.3 Frontend boundary

React may display:

- active workspace and target resource;
- active skill and tool activity;
- read progress and bounded results;
- permission request and preview;
- cancellation, failure, and verification status.

React must not:

- resolve or canonicalize filesystem paths as an authority;
- execute tools or write files;
- import Pi classes;
- construct provider messages;
- decide whether a path is inside the active workspace.

## 13. User Experience Requirements

The Side rail should feel like a live agent execution surface rather than a
static chat transcript.

It must make the following states understandable without requiring the user
to inspect logs:

- no workspace selected;
- workspace resolved from a captured target;
- reading or searching;
- agent reasoning between tool steps;
- waiting for write permission;
- write approved and executing;
- write denied or invalidated;
- verifying a result;
- completed, cancelled, or failed.

Workspace changes must be visible in the current task. The UI should show the
workspace path and target resource in a compact form, while the runtime remains
the authority for the complete canonical value.

Permission prompts must be interruptible and must not prevent the user from
cancelling the run. A permission denial must return control to the agent loop,
not leave the run permanently waiting.

## 14. Security and Privacy Requirements

Cycle 5 expands local file access and therefore tightens the capability
boundary.

- File tools operate only within an explicitly resolved active workspace.
- Read permission is limited by path, size, format, and task-run lifetime.
- Writes require a fresh operation-specific user decision.
- No permanent workspace write trust is introduced in this cycle.
- No process-global cwd change is allowed.
- No arbitrary shell, PowerShell, process, or code execution is enabled by
  default.
- Skills cannot register tools, grant permissions, or change policy.
- Captured path descriptors cannot bypass workspace validation.
- Target replacement, symlink/reparse escape, and stale workspace state fail
  closed.
- Provider requests receive only the content and metadata needed for the
  active task, within configured limits.
- Provider credentials, native handles, and raw host payloads never cross the
  React or Aside protocol boundary.
- Tool arguments, skill content, workspace files, and host context are
  untrusted inputs and must not override system or permission policy.
- Aside must not perform background workspace scanning or automatic indexing in
  the task loop.

Any shell, external service, browser action, host mutation, or cross-workspace
capability requires a separate scope, privacy, permission, and acceptance
review.

## 15. Explicit Non-Goals

The following are outside Cycle 5:

- a mandatory upfront plan-generation mode;
- copying the full Pi coding-agent CLI/TUI into Aside;
- permanent or session-level workspace trust or blanket write authorization;
- unrestricted shell, PowerShell, process, or code execution;
- arbitrary browser automation, cookies, credentials, or form submission;
- continuous foreground capture or workspace monitoring;
- automatic workspace indexing, embedding, or cloud synchronization;
- universal PDF, Word, Excel, or rich document parsing;
- a multi-workspace graph with implicit cross-root access;
- sub-agent orchestration or autonomous background tasks;
- a session browser or collaborative multi-user execution;
- silent writes to the user's workspace;
- treating skills as executable plugins or permission policies;
- moving durable Aside session storage into the active workspace;
- using process.chdir to implement workspace switching.

## 16. Acceptance Criteria

### 16.1 Agent role and loop

| ID | Scenario | Acceptance |
| --- | --- | --- |
| C5-01 | Submit a non-file question | Aside answers through the existing Pi-backed runtime without requiring a workspace. |
| C5-02 | Submit a file task with a valid descriptor | Aside resolves the workspace before the first file tool call and exposes the workspace to the model and UI. |
| C5-03 | Agent needs multiple steps | Each tool result is returned to the same Pi agent loop, and the model can choose another tool without a pre-generated full plan. |
| C5-04 | Agent reaches a conclusion | Aside distinguishes model text, tool success, tool failure, and verified result; it never reports an unexecuted write as complete. |
| C5-05 | Cancel during model or tool execution | Cancellation reaches the active run and tool, no later write starts, and the UI receives one terminal cancellation state. |

### 16.2 Workspace-first behavior

| ID | Scenario | Acceptance |
| --- | --- | --- |
| C5-06 | Capture C:\docs\report.docx | The active workspace becomes C:\docs before any read of report.docx; Aside does not stay in the default session directory. |
| C5-07 | Capture a workspace-root descriptor | The descriptor path becomes the active workspace after canonicalization and validation. |
| C5-08 | Read a relative path | The tool resolves it against the active task workspace, not process-global cwd or the Aside session directory. |
| C5-09 | Request .. or an outside absolute path | The tool rejects the call with a structured scope error and does not read or mutate the outside path. |
| C5-10 | Workspace is missing, inaccessible, or stale | File tools are unavailable or return an honest failure; Aside asks for a new workspace rather than guessing. |
| C5-11 | Switch workspace during a task | The change is explicit, visible, and applies only to the task run; durable Aside session storage remains unchanged. |
| C5-12 | Target changes while a run is active | Late results cannot redirect the run to a different workspace or target without an explicit new resolution. |

### 16.3 Tools

| ID | Scenario | Acceptance |
| --- | --- | --- |
| C5-13 | Inspect the tool registry | Every active tool has a unique name, validated schema, effect classification, scope, and bounded execution implementation. |
| C5-14 | Read, list, search, or stat inside workspace | The operation succeeds without a write permission prompt and returns bounded, sanitized tool results. |
| C5-15 | Read a neighboring file not requested by the task | The agent can do so only through an explicit bounded tool call in the active workspace; there is no pre-indexed hidden context. |
| C5-16 | Use an unsupported document format | Aside returns a typed unsupported result and does not fall through to shell execution or unsafe parsing. |
| C5-17 | Tool schema or argument is invalid | No effect occurs and the model receives a structured validation result. |
| C5-18 | Tool exceeds size, time, or step limits | The operation stops or returns a bounded limit error and the task remains cancellable. |

### 16.4 Permission

| ID | Scenario | Acceptance |
| --- | --- | --- |
| C5-19 | Agent requests a write | The write does not start before permission_requested is resolved. |
| C5-20 | Inspect a write permission | The UI shows the exact workspace, target, effect, and bounded diff/content summary before the decision. |
| C5-21 | Allow a write | Only the prepared operation executes once, then its result returns to the agent loop. |
| C5-22 | Deny a write | No workspace mutation occurs; the model receives an explicit denial result and can stop or adapt. |
| C5-23 | Cancel or let permission expire | The pending operation is not executed and the run exits or continues with a typed cancellation/expiry result. |
| C5-24 | Workspace or file changes after approval | Revalidation rejects the stale operation without executing it. |
| C5-25 | Restart during or before a write | Aside does not automatically replay a user workspace mutation declared non-replayable. |
| C5-26 | Approve one write, then request another | The second operation requires its own permission decision. |

### 16.5 Skills

| ID | Scenario | Acceptance |
| --- | --- | --- |
| C5-27 | Load a valid built-in or approved skill | Its bounded description and instructions are available to the model through the runtime boundary. |
| C5-28 | Load malformed or untrusted skill content | Aside reports a diagnostic or ignores it according to policy; it does not activate hidden tools or permissions. |
| C5-29 | Invoke a skill | The skill uses the current task workspace, tool registry, agent loop, and permission broker. |
| C5-30 | Skill asks for an unregistered capability | The call is unavailable or denied; skill instructions cannot expand capability scope. |

### 16.6 Documents and persistence

| ID | Scenario | Acceptance |
| --- | --- | --- |
| C5-31 | Read and summarize a supported document | Only the requested bounded content is read, the result is grounded in the tool output, and the task can complete without a write. |
| C5-32 | Revise a supported document | The write preview identifies the document and proposed change, requires permission, and returns a truthful save result. |
| C5-33 | Verify an approved change | The agent can perform a follow-up read, stat, or format validation and reports the verification outcome. |
| C5-34 | Restart after a completed task | Durable conversation and necessary bounded tool messages restore without silently restoring expired host context or write permission. |
| C5-35 | Inspect the session store | It contains no provider secret, native handle, hidden permission grant, or implicit copy of the entire workspace. |

### 16.7 Boundary and regression

| ID | Scenario | Acceptance |
| --- | --- | --- |
| C5-36 | Inspect React/Tauri imports | Neither layer imports Pi agent classes, provider message constructors, or filesystem execution implementations. |
| C5-37 | Inspect runtime behavior | Tools, workspace, skills, and permission state cross only through Aside-owned serialized contracts. |
| C5-38 | Use existing Side/Workspace window behavior | Cycle 2 and Cycle 4 summon, focus, capture, window, and restoration behavior remains intact. |
| C5-39 | Exercise provider/tool failures | Failures are recoverable and sanitized; no duplicate terminal events or phantom writes occur. |
| C5-40 | Run deterministic test suite | Faux providers and tool environments cover loop continuation, workspace scope, permission races, skill loading, cancellation, persistence, and stale-target rejection. |

## 17. Non-Functional Requirements

- Safety: no write effect without an exact current permission decision.
- Scope integrity: every resource operation is validated against the active
  workspace at execution time.
- Transparency: tool activity, workspace state, pending permission, and final
  operation status are visible in the Side rail.
- Cancellation: model, permission wait, and tool execution are abortable.
- Boundedness: model turns, tool outputs, reads, searches, writes, and pending
  decisions have explicit limits.
- Recoverability: interrupted and failed operations produce typed results;
  non-replayable writes are never silently repeated.
- Privacy: only task-relevant content is read and projected to the provider;
  no background workspace collection is introduced.
- Isolation: durable Aside sessions remain independent of user workspace roots.
- Compatibility: Pi upgrades should be absorbed behind agent-runtime without
  exposing Pi types to React or Tauri.
- Testability: registry, workspace environment, permission broker, skills, and
  document adapters must have deterministic in-memory or faux seams.

## 18. Scope Decisions

The following decisions are closed for Cycle 5:

- Aside uses a coding-agent-like autonomous loop; a mandatory upfront plan is
  not required.
- Workspace activation precedes file reads.
- A file descriptor defaults the active workspace to its containing directory.
- Read operations are allowed in a valid active workspace within bounds.
- Every user workspace mutation requires a fresh operation-specific permission
  decision.
- A permission decision is not permanent workspace trust.
- Workspace is per-task execution context, not process-global cwd.
- Skills provide instructions and workflow structure; tools provide effects;
  orchestration enforces policy.
- Pi's generic agent and tool foundations are reused, while Aside owns
  workspace, permission, protocol, and UI adaptations.
- The full coding-agent CLI/TUI and its default trust/shell assumptions are not
  imported as Aside's product runtime.
- Document support is adapter-based and honest about unsupported formats.

The following remain future decisions rather than implicit Cycle 5 scope:

- permanent or session-level workspace trust;
- arbitrary shell or PowerShell capability;
- external service and host mutation tools;
- multi-workspace task graphs;
- sub-agents and background execution;
- rich binary document format coverage beyond the first supported adapters;
- automatic skill installation and third-party package execution;
- collaborative or remote workspaces.

## 19. Release Boundary

Cycle 5 is complete when Aside can run a bounded, coding-agent-like
workspace task loop in which:

1. A valid file or workspace descriptor establishes the active workspace before
   any file read.
2. The Pi agent loop continues across model turns and tool results without a
   separately generated full plan.
3. Read tools operate within the active workspace without interactive write
   permission.
4. Write tools are registered, previewable, and blocked until the user grants
   permission for the exact operation.
5. Denial, cancellation, stale targets, scope escapes, and interrupted writes
   fail safely and return typed results to the loop.
6. Skills can shape document/workspace workflows without granting capabilities
   or bypassing the permission broker.
7. At least one supported document workflow can read, transform, write after
   permission, and verify a result through the same runtime.
8. Conversation persistence, host capture isolation, Side/Workspace behavior,
   and the React/Tauri/Pi ownership boundary remain intact.

Cycle 5 does not claim universal document support or unrestricted coding-agent
parity. It establishes the reusable agent capability layer that later skills,
document adapters, domain tools, and carefully reviewed external capabilities
can build on.
