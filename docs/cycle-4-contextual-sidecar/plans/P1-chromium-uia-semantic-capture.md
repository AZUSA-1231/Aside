# P1 - Chromium UIA Semantic Capture

Status: planned; not executed  
Depends on: [P0 - One-Shot Host Context Capture](./P0-one-shot-context-capture.md),
[Chromium UIA and Screen Capture Study](../research/chromium-uia-screen-capture.md),
and [Chromium UIA Depth Study](../research/chromium-uia-depth-study.md)  
Unblocks: optional Chromium visual augmentation and later browser transports

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
  -> compact ContentView page tree with role, node name, parent, selected
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
  -> normalize names and selection flags
  -> attach metadata + semantic page JSON
  -> release UIA references and target snapshot
```

The extractor is stateless. It must not retain UIA elements, COM objects,
HWNDs, process handles, active-tab state, or previous tree results between
captures. A second click performs a new query and appends a new attachment in
the existing composer collection.

UIA traversal may take materially longer than the side rail's visibility
operation. The shortcut path should snapshot the target first, hand that
snapshot to one bounded capture worker, and open the rail without waiting for
the UIA walk. A capture button may consume that short-lived pre-focus
invocation snapshot, but must not call `GetForegroundWindow` after Aside owns
focus and then treat Aside as the host. If no valid pre-focus snapshot exists,
the command returns a recoverable `no_host_target` result. Capturing another
window requires another pre-focus invocation; the attachment collection may
remain open and append the new result, but the native layer does not retain a
host-state map. The worker may emit the existing `host://capture-completed`
result when it finishes, but this is one invocation result rather than a
native capture state machine.

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
    "fields": ["role", "name", "parent", "selected"],
    "nodes": [
      ["document", "GitHub", -1, null],
      ["link", "THU-MAIC/OpenMAIC", 0, null],
      ["listitem", "Open pull requests", 0, true]
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
   and intersect the chosen document region. Never serialize the bounds.
6. Keep `selected=true` only when `SelectionItemPattern` reports a meaningful
   selected state. A missing or false selection state is represented as `null`
   in the fixed tuple schema to keep the column mapping deterministic.
7. Remove empty layout containers. If a retained node's original parent was
   filtered, remap it to the nearest retained ancestor.
8. Preserve traversal order and repeated nodes. Do not globally deduplicate
   equal names because repeated links, rows, and controls carry page meaning.

The normalizer must not call `TextPattern.DocumentRange.GetText`,
`GetVisibleRanges`, or `GetSelection` on the default path. A highlighted text
selection is therefore not represented as text in P1; `selected` means a
selection-item state such as a selected tab or list item.

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

- `src-tauri/src/hosts/chromium_uia.rs` (or the repository's selected host
  module) owns COM/UIA initialization, browser matching, metadata extraction,
  bounded traversal, and semantic normalization.
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
The implementation should initialize COM on the capture worker, perform all
UIA calls on that worker, apply a wall-clock timeout, and release every
element/pattern reference before returning. The exact `windows` crate feature
set may be finalized during implementation, but it must cover Foundation,
System COM, and UI Accessibility only; no browser automation package is needed.

### Failure behavior

| Condition | Result |
| --- | --- |
| Missing pre-focus invocation target | Recoverable `no_host_target` error; never query Aside as the host |
| Non-Chromium process or unsupported browser surface | Honest unsupported result; no generic tree walk and no successful attachment |
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

## Tasks

1. Run the depth-matrix validation on the existing sanitized fixtures and live
   Edge/Chrome samples. Record the selected default depth and confirm whether
   the parser needs the current 800-node cap or a lower normalized-node cap.
2. Add the Windows UIA dependency and a stateless COM worker. Keep the native
   production build Windows-only and preserve non-Windows compilation through
   an unavailable extractor path.
3. Extend host capability reporting with a Chromium UIA semantic-capture
   capability and register Chrome/Edge matchers by executable identity, not
   title or pixel content.
4. Implement selected-tab discovery, page-root selection, safe URL extraction,
   title fallback, application mapping, and PID metadata.
5. Implement the ContentView normalizer and fixed column-oriented
   `role/name/parent/selected` JSON shape with visibility filtering, whitespace
   normalization, parent remapping, and atomic size validation.
6. Integrate the extractor into the one-shot shortcut and explicit capture
   paths through the pre-focus invocation snapshot. A post-focus command must
   consume that short-lived snapshot or return `no_host_target`; it must not
   rediscover the foreground window. Do not add a host-state manager, polling
   loop, or persistent UIA object.
7. Update TypeScript contracts and the attachment preview only as needed to
   display application, tab, title, quality, and a compact semantic-page
   summary. Keep PID as informational metadata and never expose it as an
   action target. Do not render raw diagnostic payloads.
8. Add deterministic unit tests for metadata fallbacks, URL sanitization,
   quality/depth derivation, page-root selection, name filtering, offscreen
   filtering, parent remapping, selected state, repeated node preservation,
   and JSON/aggregate budget rejection.
9. Add Windows/manual verification for real Edge and Chrome, including a
   normal GitHub page, Pinterest, a synthetic semantic page, a copy-disabled
   page, a canvas/image page, a minimized window, an occluded window, an
   elevated browser, and a browser that closes during capture.
10. Record any mismatch between the live UIA provider and this contract in the
    cycle `ISSUES.md` before broadening the parser or adding another transport.

## Deliverables

- A production Chromium UIA extractor for Chrome and Edge behind the P0
  `HostExtractor` boundary.
- A sanitized browser metadata JSON block containing application, PID, selected
  tab name, URL, title, quality, effective depth, and structural capture state.
- A compact ContentView semantic-page JSON block containing only
  `role/name/parent/selected` tuples.
- A bounded COM/UIA worker with one-shot target validation and no retained host
  state.
- A selected default depth backed by the live depth matrix and quality rules
  that honestly mark partial results.
- Unit, integration, and interactive Windows verification for Edge and Chrome.

## Exit Criteria

- An explicit capture from a visible Chrome or Edge window returns one valid
  attachment through the existing P0 event and appends without replacing prior
  attachments.
- The attachment contains the requested metadata: current application, PID,
  selected tab name, sanitized URL, title, quality, effective depth, and
  explicit depth/node truncation state. The success schema keeps these keys
  even when a safe value is `null`.
- The semantic block contains no raw document text, character lengths, hashes,
  bounds, automation IDs, pattern diagnostics, or browser chrome tree.
- The page tree is rooted at the selected page `Document`, uses `Name` as its
  only node-text source, filters invalid/offscreen/layout nodes, preserves
  parent relationships, and records meaningful selected states.
- Missing UIA features produce partial or metadata-only results rather than
  invented text or arbitrary tab selection.
- Depth/node caps, traversal errors, stale targets, malformed data, and budget
  overflow produce the specified bounded result or recoverable error.
- The UIA worker does not block the side rail's initial visibility path beyond
  the pre-focus target snapshot and classification; post-focus capture does
  not rediscover the foreground window, and no polling or multi-window host
  state is introduced.
- Existing typecheck, build, Rust tests, and runtime tests remain green.

## Checks

Run the depth study before choosing the final default:

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
  removal, parent remapping, and selected flags;
- preservation of repeated equal nodes;
- exclusion of TextPattern ranges and arbitrary Edit values;
- stale-target rejection and no replacement-window capture;
- atomic JSON/attachment budget rejection and repeated-click accumulation.

## Deferred

- Windows Graphics Capture or another per-window pixel transport;
- OCR or vision processing;
- CDP and browser extension active-tab bridges;
- browser automation or invoke/set-value/select actions;
- full page text, visible-range text, or explicit highlighted-text capture;
- Explorer, VSCode, and PDF-reader production transports;
- configurable user-facing quality profiles beyond the bounded native defaults.
