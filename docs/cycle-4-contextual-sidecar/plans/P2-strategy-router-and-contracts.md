# P2 - Strategy Router and Contracts

Status: completed 2026-09-04

Source requirements: Cycle 4 PRD, closeout plan, especially FR-4.2 through
FR-4.6 and C4-04.

## Outcome

Create one deterministic native routing boundary. Every capture starts with a
short-lived foreground target snapshot, selects at most one specialized
strategy, and returns one sanitized result. Generic UIA is a separate fallback
and is not a normal competing registry entry.

## Design

### Target snapshot

- Keep stable application identity, opaque target identity, process identity,
  and the native-held target binding inside the native layer.
- Expose only serializable host identity, availability, capabilities, and
  strategy status to Tauri IPC.
- Revalidate the original window before and after a strategy call. A closed,
  replaced, or identity-changed target returns stale_target with no context.
- Do not retain a target map, COM object, process handle, or host payload after
  the one-shot operation.

### Strategy contract

Extend the existing HostExtractor boundary with stable strategy metadata:

- strategy identity and host kind;
- deterministic priority for specialized strategies;
- target matching and capability discovery;
- bounded capture returning an Aside-owned result;
- optional path/workspace descriptors;
- explicit unavailable, permission, timeout, cancellation, malformed, and
  stale-target outcomes.

The contract must not expose raw native handles, provider credentials, file
bytes, or implicit permissions.

### Registry selection

Use the initial specialized priority order from the closeout decision:

~~~
Browser > VSCode > Explorer > Document
~~~

The registry filters specialized matches, chooses the highest priority, and
reports an ambiguity when multiple matches have the same winning priority.
Generic UIA is called only when there are no specialized matches. A matched
strategy failure is returned directly and is never retried through Generic UIA.

## Tasks

1. Define serialized host, strategy, path descriptor, capture request, result,
   and error contracts while preserving current attachment limits.
2. Add strategy priority and an explicit selection result to the native router.
3. Register the existing Browser strategy through the new selection path.
4. Add deterministic faux strategies with invocation counters so tests can
   prove that only the selected strategy executes.
5. Preserve current Side/Workspace focus behavior and the existing attachment
   validation boundary.

## Tests

- priority wins regardless of registration order;
- equal winning priority is an explicit ambiguity;
- no specialized match produces a Generic UIA decision;
- specialized failure does not invoke a second strategy;
- one request produces at most one result;
- stale target rejection occurs before and after extraction;
- no native object or raw adapter payload appears in serialized output.

## Exit Criteria

The Browser path still works through the new registry, all selection behavior
is deterministic, and the router has no host-specific capture branches beyond
strategy registration.

## Deferred

Generic UIA implementation, real path locators, rich document extraction, host
actions, CDP, screenshots, OCR, and Pi workspace/tool wiring.
