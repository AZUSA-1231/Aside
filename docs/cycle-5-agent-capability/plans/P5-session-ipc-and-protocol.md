# P5 - Session, IPC, and Protocol Integration

Status: planning
Depends on: P0 through P4
Unblocks: P6 - Side Surface and Release Verification
Source requirements: Cycle 5 PRD sections 9, 10, 12, 13, 14, and 16.1/16.6/16.7

## Outcome

Carry the task-run lifecycle through the existing JSONL process and Tauri
boundary while keeping all authority in the agent runtime. Add the explicit
workspace and permission round trips, expose bounded tool/skill state, and
extend session persistence only for normalized messages needed for coherence
and recovery.

## Protocol Shape

Retain `prompt` and `cancel`, adding only the product-owned operations required
by the runtime:

```text
prompt(request_id, text, context?, workspace_hint?)
cancel(request_id)
permission_response(request_id, permission_id, decision)
set_workspace(task_id, workspace)
clear_workspace(task_id)
```

The final names may follow the existing Rust/JSON conventions, but every
request must be strictly validated, bounded, tied to a task/request identity,
and safely rejectable when repeated or stale. No raw Pi/native object crosses
this boundary.

Pi-full's protocol is useful as a reference for correlated request/response
identities, authoritative snapshots versus transient progress events, strict
payload validation, and frame-size limits. It is a CBOR client/server protocol,
so those principles must be expressed in the existing Aside JSONL contracts;
P5 must not add a Pi protocol/client/server dependency to implement them.

## Tasks

1. Extend runtime request/event types and JSONL parsing for workspace state,
   tool calls/results, skill activation, permission pending/resolution,
   waiting, verification, and terminal states. Preserve startup ordering,
   authoritative snapshots where used, transient progress semantics, and one
   terminal event per request.
2. Forward the serialized contracts through `src-tauri/src/runtime.rs` and
   `commands.rs`. Tauri owns process lifecycle and IPC forwarding, not path
   canonicalization, provider message construction, tool execution, or
   permission decisions.
3. Connect Cycle 4 attachment descriptors and explicit workspace hints to
   runtime prompt creation. Revalidate them in the runtime and keep host
   attachment expiry/reference semantics unchanged.
4. Update session persistence to retain only bounded, normalized user,
   assistant, tool-call, and tool-result messages needed for restoration.
   Exclude host handles, credentials, entire workspace snapshots, expired
   permission state, unbounded file content, and hidden skill source.
5. Restore the durable transcript without restoring an active workspace,
   pending permission, expired host context, or write authorization. Emit
   recoverable persistence warnings without claiming false durability.
6. Add idempotent handling for repeated permission responses, stale workspace
   messages, malformed requests, process restart, cancellation, provider
   failure, tool failure, and write interruption.
7. Keep React-facing contracts serializable and display-oriented. Do not add
   Pi imports, filesystem implementations, path authority, or provider message
   constructors to React or Tauri.
8. Add protocol/session tests for event order, history restoration, bounded
   tool messages, permission round trips, stale response rejection, and
   persistence privacy.

## Deliverables

- Versioned Aside request/event vocabulary for task execution.
- Tauri forwarding for workspace and permission lifecycle.
- Session adapter for bounded tool history and recovery warnings.
- Restore behavior that keeps workspace and authorization transient.
- Protocol, persistence, and boundary-isolation tests.

## Exit Criteria

- C5-02 and C5-11 workspace state is visible through serialized runtime events.
- C5-04, C5-34, and C5-35 restore truthful bounded history without restoring
  expired context or permission.
- C5-20 permission previews and decisions round-trip to the runtime with exact
  request/task identity.
- C5-36 and C5-37 pass import and ownership inspection.
- C5-39 has one recoverable sanitized terminal outcome for provider, tool,
  permission, and persistence failures.

## Checks

Run protocol, session, and runtime tests with a temporary session root and
faux provider/tools. Exercise a restart before a pending write and inspect the
stored JSONL to confirm there is no permission grant, credential, native value,
or unbounded workspace snapshot.
