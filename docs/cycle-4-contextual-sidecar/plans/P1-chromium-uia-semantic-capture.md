# P1 - Chromium UIA Semantic Capture

Status: completed
Completed: 2026-09-02
Depends on: [P0 - One-Shot Host Context Capture](./P0-one-shot-context-capture.md),
[Chromium UIA and Screen Capture Study](../research/chromium-uia-screen-capture.md),
and [Chromium UIA Depth Study](../research/chromium-uia-depth-study.md)  
Unblocks: optional Chromium visual augmentation and the shared strategy
closeout plan

Source requirements: [Cycle 4 PRD](../PRD.md), especially FR-4.5, FR-4.6,
FR-4.7, FR-4.14, FR-4.15, C4-01, C4-02, C4-09, C4-10, and C4-14.

## Outcome

Add the first real Chromium host extractor for Windows Chrome and Edge. One
explicit capture obtains the foreground browser target before Aside takes
focus, queries UI Automation, and appends one bounded attachment through the
P0 `HostExtractor` contract.

The default browser attachment has two JSON blocks:

```text
browser.metadata
  -> application, pid, selected tab name, sanitized URL, title,
     capture quality, effective depth and structural limits

browser.semantic_page
  -> compact ContentView page tree with role, node name, and screen bounds
```

The parser uses UIA `AutomationElement.Name` as its only page-text source. It
does not read `TextPattern.DocumentRange`, visible ranges, text-selection
ranges, clipboard data, DOM data, or browser values outside a narrowly
identified address-bar URL. Bounds, offscreen state, traversal errors, node
counts, and depth are used to normalize and validate the result; only the
declared metadata fields reach the agent.

This plan does not implement screen capture, OCR, CDP, a browser extension, or
browser actions. The existing visual setting remains unavailable until a later
plan adds a bounded image block and a Windows capture implementation.

The completed slice also makes each successful attachment inspectable without
changing its session semantics: Aside writes an Aside-owned JSON artifact to
its local `captures` directory, shows a compact in-panel preview, and can
reveal the artifact in the system file manager. The artifact is not restored
as an attachment after submission or restart.

## Design

### One-shot execution

The capture flow remains target-bound and stateless. The native pre-focus
boundary must obtain the invocation target before Aside takes focus:

```text
pre-focus invocation
  -> snapshot HWND/PID/application identity internally
  -> show/focus Aside and hand the snapshot to one worker
  -> classify as Chrome or Edge
  -> create UIA client on the capture worker
  -> find selected tab and page Document
  -> read narrow browser metadata
  -> walk bounded ContentView page descendants
  -> normalize names and screen bounds
  -> attach metadata + semantic page JSON
  -> release UIA references and target snapshot
```

The extractor is stateless. It must not retain UIA elements, COM objects,
HWNDs, process handles, active-tab state, or previous tree results between
captures. A second click performs a new query and appends a new attachment in
the existing composer collection.

The frontend also treats a capture completion as belonging to the prompt that
was active when it was staged. Results for that prompt that arrive while a
provider run is active, or after that run has ended, are discarded so an
asynchronous summon capture cannot become context for a later request.

UIA traversal may take materially longer than the side rail's visibility
operation. The shortcut path should snapshot the target first, hand that
snapshot to one bounded capture worker, and open the rail without waiting for
the UIA walk. When Workspace is already visible, the capture button reuses its
`WorkspaceSnapshot` target and runs another one-shot query without hiding or
reopening Aside. In ordinary Side mode, an explicit capture may briefly hide
Aside, query the newly revealed foreground host, and restore the rail. This is
still one synchronous invocation with no host map or polling lifecycle, and
Aside is never passed to the extractor as the host. The worker may emit the
existing `host://capture-completed` result when it finishes, but this is one
invocation result rather than a native capture state machine.

### Product-facing attachment shape

The extractor returns the existing `AsideHostAttachment`. Its browser-specific
payload is represented as two JSON blocks so metadata remains distinguishable
from page nodes:

```json
{
  "metadata": {
    "application": "Microsoft Edge",
    "pid": 29872,
    "tabName": "GitHub",
    "url": "https://github.com",
    "title": "GitHub",
    "quality": "partial",
    "view": "content",
    "depth": {
      "limit": 16,
      "observed": 5,
      "depthTruncated": true
    },
    "nodeLimit": 800,
    "nodeCount": 181,
    "nodeTruncated": false
  },
  "semantic_page": {
    "fields": ["role", "name", "bounds"],
    "nodes": [
      ["document", "GitHub", {"x": 1857, "y": 120, "width": 1920, "height": 900}],
      ["link", "THU-MAIC/OpenMAIC", {"x": 1857, "y": 260, "width": 210, "height": 24}],
      ["listitem", "Open pull requests", {"x": 1857, "y": 300, "width": 240, "height": 32}]
    ]
  }
}
```

The actual context projection keeps the two blocks separate and labels them
`browser.metadata` and `browser.semantic_page`. The surrounding attachment
continues to carry `source`, `capturedAt`, `expiresAt`, `sensitivity`, and
`summary` from P0. These common attachment fields must not be duplicated inside
the browser metadata block.

Every successful browser metadata block has the fixed keys
`application`, `pid`, `tabName`, `url`, `title`, `quality`, `view`, `depth`,
`nodeLimit`, `nodeCount`, and `nodeTruncated`. A value that cannot be obtained
or safely serialized is `null` where the schema permits it; the key is not
silently omitted, and missing core metadata lowers `quality`.

`quality` is a deterministic result classification, not an arbitrary model
score:

| Quality | Meaning |
| --- | --- |
| `complete` | Page `Document` found, required traversal completed without provider errors or caps, and the required browser metadata was resolved and sanitized |
| `partial` | A page tree was obtained, but depth/node caps, provider errors, or missing selected-tab/URL/title metadata limit confidence |
| `metadata_only` | Browser identity and some metadata were obtained, but no usable page `Document` tree was available |

`unavailable` is a capture failure state, not a value in a successful metadata
block. If UIA cannot be initialized or the browser target cannot be queried,
`HostCaptureResult.error` carries the sanitized recoverable failure and no
attachment is produced.

`depth.limit` records the effective max depth passed to the traversal;
`depth.observed` is relative to the normalized page root, not the raw window
depth; and `depth.depthTruncated` is true when the depth cap prevented a
complete walk. `nodeLimit` is the effective normalized-node cap,
`nodeCount` is the normalized semantic-node count, and `nodeTruncated` is true
when that cap prevented a complete walk. These are structural capture state,
not character measurements. No character length, byte count, hash, or raw
diagnostic counter is emitted.

The PID is informational capture metadata. It is not a reconnect key, is not
used to select a later window, and does not permit a future action by itself.

### Browser metadata extraction

The native adapter must produce the following values with narrow, deterministic
fallbacks:

- The successful metadata schema always includes the fields listed above;
  `tabName`, `url`, or `title` may be `null` only when the corresponding safe
  provider/fallback lookup is unavailable.
- `application`: map `msedge.exe` to `Microsoft Edge` and `chrome.exe` to
  `Google Chrome`; preserve the stable internal application id in the native
  target/classification path, not as an arbitrary process-path payload.
- `pid`: copy the captured target process id into the sanitized metadata block.
- `tabName`: read the `Name` of the selected `TabItem` whose
  `SelectionItemPattern.IsSelected` is true. Do not infer the selected tab from
  tree order. If no selected tab is exposed, emit `null` and lower quality.
- `title`: prefer the selected page `Document.Name`, then selected tab name,
  then a normalized target title with the browser suffix removed. Do not obtain
  a title through a document text range.
- `url`: inspect only a narrowly identified browser address-bar `Edit` through
  `ValuePattern`. Parse it with a URL parser, reject non-URL values, remove
  userinfo, query, and fragment components, and preserve the scheme, host,
  port, and path. Do not read arbitrary `Edit` values or address-bar selection
  text. If no safe URL is available, emit `null` and lower quality.
- `view`: set to `content` for the page tree. This tells the agent that the
  semantic nodes came from the ContentView path rather than the full control
  tree.

The metadata block is itself untrusted reference data. It must not contain raw
window titles when they include unbounded process or document data, raw process
paths, HWND values, COM errors, address-bar credentials, or native handles.

### UIA view and page-root selection

Use `ContentView` as the only source for the semantic page tree. Do not merge
the full `ControlView` tree into it. Use narrowly scoped ControlView queries
only for selected-tab and address-bar metadata when ContentView does not expose
those browser-chrome elements.

The page-root algorithm is:

1. Create a UIA root from the captured browser HWND.
2. Traverse the bounded ContentView tree in stable parent-before-child order.
3. Collect visible `ControlType.Document` candidates.
4. Prefer the candidate associated with the selected tab; if association is
   unavailable, accept the single visible candidate; if multiple candidates
   remain ambiguous, return metadata with `quality=metadata_only` rather than
   choosing an arbitrary document.
5. Rebase the chosen document to depth zero and normalize only its descendants.
6. Discard browser chrome, controls outside the chosen document, and all
   ControlView-only layout nodes from the semantic page block.

Candidate association may use UIA ancestry and reliable bounds internally. It
must not expose those implementation details in the attachment. A minimized,
invalid, or stale window must fail target validation instead of producing a
page from `-32000` or otherwise invalid bounds.

### Semantic node normalization

For each node in the chosen page subtree:

1. Map `ControlType` to a compact lowercase role such as `document`, `text`,
   `button`, `link`, `listitem`, `image`, or `edit`.
2. Read only `AutomationElement.Current.Name` as the node label.
3. Normalize line breaks, tabs, and repeated whitespace, then reject empty
   names except for the chosen `Document` root when it has named descendants.
4. Reject control characters and names that exceed the per-node budget before
   constructing the JSON block.
5. Use `IsOffscreen` and valid bounds as internal visibility filters. Reject
   nodes marked offscreen; when bounds are available, require them to be valid
   and intersect the chosen document region. Serialize valid bounds as the
   compact `{x, y, width, height}` screen rectangle.
6. Remove empty layout containers.
7. Preserve traversal order and repeated nodes. Do not globally deduplicate
   equal names because repeated links, rows, and controls carry page meaning.

The normalizer must not call `TextPattern.DocumentRange.GetText`,
`GetVisibleRanges`, or `GetSelection` on the default path. A highlighted text
selection is therefore not represented as text in P1. Selection state remains
an internal UIA signal used only to identify the active browser tab.

### Bounds and limits

Use a bounded capture configuration with an initial default of `maxNodes=800`
and `maxDepth=16`, matching the probe defaults. Before shipping, run the
existing live depth matrix at `12, 16, 20, 24, 32` against stable Edge and
Chrome pages and choose the first depth that satisfies the research sweet-spot
rule. Keep the selected value configurable in the native adapter so the next
study does not require a contract rewrite.

The effective limits and result state must be visible in metadata as `depth`
and `quality`, but the parser must still enforce the existing P0 attachment and
JSON limits before the attachment is returned:

- at most 8 blocks across the attachment collection;
- at most 16 KiB for the metadata or semantic JSON block;
- at most 24 KiB for the serialized attachment projection;
- JSON depth no greater than 4;
- one node-name budget and a total normalized-node budget chosen with the
  depth matrix;
- atomic rejection when the attachment would exceed the current prompt
  collection budget.

If the page reaches the depth limit, keep the valid prefix and set
`depth.depthTruncated=true`. If it reaches the normalized-node limit, set
`nodeTruncated=true`. Classify the result as `partial` when a usable page tree
remains. If no usable page tree remains, retain safe metadata only. Never
silently replace an older attachment or send a partially validated JSON value.

### Native and IPC ownership

- `src-tauri/src/uia.rs` owns the reusable Windows UIA transport: COM
  initialization and teardown, Content/Control view walking, traversal limits,
  node snapshots, role mapping, pattern reads, normalization primitives, and
  provider/truncation diagnostics. A session is short-lived and is usable only
  inside one adapter capture call.
- `src-tauri/src/chromium_uia.rs` owns Chromium matching, browser metadata
  extraction, address-bar policy, page-root selection, and the Chromium
  semantic capture policy. It must not add generic UIA traversal or COM
  lifecycle code.
- `src-tauri/src/context.rs` registers the stateless Chromium extractor,
  carries the sanitized metadata block, and keeps P0 validation and expiry
  behavior authoritative.
- `src-tauri/src/platform.rs` exposes only an internal process-id accessor or
  target snapshot data needed by the native extractor. HWND and UIA objects
  remain native-only.
- `src/lib/contracts.ts` adds typed browser metadata and semantic-page shapes
  if the UI needs to render them; the public contract must remain serializable
  and must not expose raw UIA objects.
- `src/lib/ipc.ts` and the existing capture event continue to carry one
  `HostCaptureResult`. If the worker path changes command timing, preserve
  capture IDs and append-only frontend behavior from P0.
- `src/lib/context.ts` needs no new provider abstraction. It must continue to
  count and serialize the two JSON blocks deterministically.

Use a native Windows UIA/COM binding with no stored apartment-bound objects.
The implementation initializes COM on the capture worker, performs all UIA
calls on that worker, applies the UIA connection timeout, and releases every
element/pattern reference before returning. The `windows` crate feature set is
limited to Foundation, System COM, and UI Accessibility; no browser automation
package is needed.

Future Explorer, VSCode, document, and other host strategies should implement
their own modules and call the shared `uia` transport where appropriate; they
should not add application branches to `uia.rs` or expose raw UIA objects
through the context, IPC, or runtime contracts. The unified Cycle 4 closeout
plan defines the path-first strategies and the separate Generic UIA fallback.

### Failure behavior

| Condition | Result |
| --- | --- |
| Missing pre-focus invocation target | Recoverable `no_host_target` error; never query Aside as the host |
| Non-Chromium process or unsupported browser surface | This Browser strategy does not match; the router may select a path strategy or the separate bounded Generic UIA fallback |
| UIA initialization failure | Unavailable host result with a sanitized recoverable error and no successful attachment; do not emit `quality=unavailable` inside metadata |
| Selected tab unavailable | Continue with page/metadata fallback, set `tabName=null`, lower quality |
| URL value unavailable or unsafe | Set `url=null`, preserve other metadata and semantic nodes, and lower quality |
| No page `Document` | Metadata-only attachment when browser identity is valid |
| Multiple ambiguous page Documents | Metadata-only result; never choose by arbitrary order |
| Provider traversal error | Keep valid normalized prefix, set `quality=partial`, record no error text |
| Depth limit reached | Keep valid prefix, set `depth.depthTruncated=true`, classify partial |
| Node limit reached | Keep valid prefix, set `nodeTruncated=true`, classify partial |
| Target closes, minimizes, or changes identity | Stale-target error and no captured page content |
| JSON or aggregate budget exceeded | Atomic oversize error; existing attachments unchanged |

## Completed Tasks

- [x] Recorded the live Edge baseline and retained bounded defaults of
  `maxDepth=16` and `maxNodes=800`; the depth-matrix instrumentation remains
  available for a later cross-browser study.
- [x] Added the Windows UIA dependency and a short-lived COM worker while
  preserving the unavailable path on non-Windows builds.
- [x] Added executable-identity matching and Chromium UIA/browser metadata
  capabilities for Chrome and Edge.
- [x] Implemented selected-tab discovery, page-root selection, safe URL
  extraction, title fallback, application mapping, and PID metadata.
- [x] Implemented the ContentView normalizer with the fixed
  `role/name/bounds` tuple shape, visibility filtering, whitespace
  normalization, screen-bound conversion, and budget validation.
- [x] Integrated shortcut capture, Workspace capture without leaving the
  split view, ordinary Side capture, append-only attachments, and prompt-limit
  rejection without a host-state manager or polling loop.
- [x] Added the attachment JSON artifact, compact `nodes` serialization,
  in-panel preview, and system file-manager reveal action. Direct external
  file opening is intentionally outside this slice.
- [x] Added deterministic tests for metadata, URL and quality behavior,
  semantic filtering, bounds, repeated nodes, target isolation, and JSON or
  aggregate budget rejection.
- [x] Completed live Edge verification with GitHub and Pinterest samples and
  recorded the UIA/provider mismatches in `ISSUES.md`.

## Deliverables

- A production Chromium UIA extractor for Chrome and Edge behind the P0
  `HostExtractor` boundary.
- A sanitized browser metadata JSON block containing application, PID, selected
  tab name, URL, title, quality, effective depth, and structural capture state.
- A compact ContentView semantic-page JSON block containing only
  `role/name/bounds` tuples.
- A bounded COM/UIA worker with one-shot target validation and no retained host
  state.
- A bounded default of `maxDepth=16` and `maxNodes=800`, backed by the current
  live Edge baseline, instrumentation, and quality rules that honestly mark
  partial results.
- Unit/runtime verification, the shared Chrome path, and interactive Edge
  verification; the full Chrome and depth-matrix sweep remains deferred.

## Exit Criteria

- An explicit capture from a visible Chrome or Edge window returns one valid
  attachment through the existing P0 event and appends without replacing prior
  attachments.
- The attachment contains the requested metadata: current application, PID,
  selected tab name, sanitized URL, title, quality, effective depth, and
  explicit depth/node truncation state. The success schema keeps these keys
  even when a safe value is `null`.
- The semantic block contains no raw document text, character lengths, hashes,
  automation IDs, pattern diagnostics, parent indexes, or selection flags; it
  contains only the declared role, name, and screen bounds columns.
- The page tree is rooted at the selected page `Document`, uses `Name` as its
  only node-text source, filters invalid/offscreen/layout nodes, preserves
  traversal order, and records valid screen bounds when available.
- Missing UIA features produce partial or metadata-only results rather than
  invented text or arbitrary tab selection.
- Depth/node caps, traversal errors, stale targets, malformed data, and budget
  overflow produce the specified bounded result or recoverable error.
- The UIA worker does not block the side rail's initial visibility path beyond
  the pre-focus target snapshot and classification. Workspace capture reuses
  its target without hiding Aside; ordinary Side capture temporarily hides the
  rail before querying the foreground host. No polling or multi-window host
  state is introduced.
- Existing typecheck, build, Rust tests, and runtime tests remain green.

## Completion Record

P1 is closed for the initial Chromium UIA capture slice. The production path is
Windows-only, supports Chrome and Edge through the shared executable matcher,
and returns bounded metadata plus a compact ContentView semantic page. The
semantic contract intentionally contains only `role`, `name`, and `bounds`;
parent indexes, page-node selection flags, text ranges, lengths, and hashes do
not reach the agent.

Verification completed on 2026-09-02:

- 17 Rust tests passed.
- 28 runtime tests passed.
- TypeScript typecheck, frontend build, Rust formatting, and diff checks passed.
- Live Edge GitHub and Pinterest captures succeeded after moving UIA/COM work
  to a dedicated worker.
- Capture artifacts were inspected through the in-panel preview and the
  system file-manager reveal path.
- Chrome uses the same production matcher and extractor path; cross-browser
  manual coverage remains in `Deferred`.

## Checks

The current P1 default is `maxDepth=16` and `maxNodes=800`, selected from the
available live Edge baseline. Run the broader depth study before changing that
default or claiming cross-browser completeness:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/capture-live-chromium-uia.ps1 -Browser edge -ListOnly
node tools/summarize-chromium-uia-depth.mjs docs/cycle-4-contextual-sidecar/research/real-test/depth-study
```

Run the implementation checks after the code is added:

```text
npm.cmd run typecheck
npm.cmd run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm.cmd run runtime:test
```

The focused tests must cover:

- Chrome/Edge classification and unsupported browser surfaces;
- selected-tab and title fallback behavior;
- URL parsing and removal of userinfo/query/fragment;
- complete, partial, and metadata-only successful qualities, plus unavailable
  capture errors without an attachment;
- depth-limit and node-limit truncation with independent flags;
- ContentView root selection and ControlView metadata fallback;
- name normalization, offscreen/invalid-bounds filtering, empty-container
  removal, screen-bound conversion;
- preservation of repeated equal nodes;
- exclusion of TextPattern ranges and arbitrary Edit values;
- stale-target rejection and no replacement-window capture;
- atomic JSON/attachment budget rejection and repeated-click accumulation.

## Deferred

- Full live depth-matrix comparison across Chrome and Edge, plus the remaining
  elevated, minimized, occluded, protected-surface, and close-during-capture
  cases;
- Windows Graphics Capture or another per-window pixel transport;
- OCR or vision processing;
- CDP and browser extension active-tab bridges;
- browser automation or invoke/set-value/select actions;
- full page text, visible-range text, or explicit highlighted-text capture;
- Explorer, VSCode, and PDF-reader rich/content transports; path-only
  strategies are covered by the unified Cycle 4 closeout plan;
- configurable user-facing quality profiles beyond the bounded native defaults.
