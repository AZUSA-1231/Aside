# P5 - Path Strategies and Workspace Descriptors

Status: completed 2026-09-04; VSCode bridge deferred

Source requirements: Cycle 4 PRD, closeout plan, especially FR-4.4, FR-4.6,
FR-4.8 through FR-4.10, and C4-03, C4-05, C4-06, and C4-15.

## Outcome

Implement path-only strategies using the reliable signals established by P4.
Successful captures return serializable validated descriptors ready for a
future workspace handoff. They do not read file content or grant Pi access.
Explorer is implemented with target-bound Shell automation plus bounded UIA
fallback. VSCode extension/bridge work is deferred.

## Descriptor

Use one bounded shape:

~~~
{
  "role": "workspace_root | active_file | directory | selected_item | document",
  "path": "C:/canonical/absolute/path",
  "kind": "file | directory"
}
~~~

The native path boundary owns absolute-path validation, canonicalization,
existence and type checks, character/length limits, and target revalidation.
The descriptor contains no native handle, file bytes, credentials, or implicit
permission to read or mutate the resource.

## Strategies

Implement separate modules behind the P2 registry:

- VSCode: existing conservative UIA-only attempt; bridge integration deferred;
- Explorer: current directory and selected items through Shell automation,
  with UIA fallback;
- Document family: PDF, Word, and Excel current-document path where P4 proved
  a reliable locator.

Each module may use its own read-only locator transport. It must return an
explicit locator-unavailable or ambiguous result when the signal is missing.
No module may infer a path from an arbitrary window title.

## Tasks

1. Add the common descriptor type to Rust, TypeScript, attachment projection,
   and artifact serialization.
2. Implement and unit-test canonicalization and validation independently from
   host adapters.
3. Implement host-specific locators from P4 evidence, with faux locators for
   deterministic tests.
4. Stage descriptors as reference metadata in one attachment per selected
   strategy.
5. Revalidate the target and path before committing the attachment.
6. Keep the existing Aside session directory independent from any future
   execution root; do not call process.chdir() or import Pi coding-agent tools.

## Tests

- file, directory, workspace-root, active-file, selected-item, and document
  roles serialize as expected;
- relative, nonexistent, wrong-type, overlong, malformed, and inaccessible
  paths are rejected;
- symlink/reparse-point and canonicalization behavior is explicit;
- missing or ambiguous locators return unavailable without title guessing;
- stale target or replacement window returns no descriptor;
- successful captures contain descriptors only and never file content;
- descriptor attachments obey individual and aggregate budgets.

## Exit Criteria

Explorer and supported document hosts return validated path descriptors when
reliable signals exist. VSCode bridge work is deferred, hosts without reliable
signals degrade honestly, and all rich extraction remains outside the
production boundary.

## Deferred

Pi workspace activation, execution-root switching, file reads, editor/document
content, document parsing, host actions, and content-based permissions.
