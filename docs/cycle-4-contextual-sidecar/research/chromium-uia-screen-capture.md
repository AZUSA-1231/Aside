# Chromium UI Automation and Screen Capture Study

Status: research record; Chromium UIA transport implemented in P1
Date: 2026-08-31  
Scope: Windows Chromium-family browsers, including Chrome and Edge

This study evaluates Windows UI Automation (UIA) as the default Chromium
capture path and screen capture as a bounded secondary path. It does not add a
browser adapter, a background watcher, OCR, or a new attachment type.

## 1. Executive Conclusion

The recommended order is:

```text
one capture click
  -> snapshot the foreground browser window
  -> query the browser UIA tree
  -> extract page identity, selected tab, and a compact semantic tree of node
     roles, names, and screen bounds
  -> if semantic coverage is insufficient and visual fallback is enabled,
     capture that one browser window and use it as a visual/OCR input
  -> append one bounded attachment
```

UIA should be the first choice because it is already available on Windows, can
be queried from the exact foreground browser window, returns semantic controls
instead of the full DOM, and does not require the user to copy or select text.
It is a read-only accessibility protocol, not a mouse-and-keyboard simulator.

Screen capture should be a second, explicit capability. It can recover content
that is visibly rendered but absent from the accessibility tree, such as a
canvas or image. It cannot recover hidden DOM, protected content, or text that
is not actually rendered. Screen capture also requires an image-attachment
policy that the current text/JSON context contract does not yet provide.

This makes UIA the default zero-extension path. Browser extensions remain a
later enhancement for a more complete active-tab/content bridge, and CDP
remains an explicit connector for controlled browser launches.

## 2. Probe and Test Conditions

The reproducible probe is [chromium-uia-screen-probe.ps1](../../../tools/chromium-uia-screen-probe.ps1).
It uses the Windows UIA .NET client assemblies and native window APIs; it does
not require `pywinauto`, `uiautomation`, Selenium, or a Python runtime.

Default output contains only:

- target process identity and window class;
- UIA ControlView and ContentView node counts, capped by configurable defaults of
  800 nodes and depth 16;
- whether traversal reached the node cap, whether nodes at the depth cap still
  have children, provider traversal errors, and per-view timings;
- control type counts and supported pattern counts;
- lengths and short hashes for names, values, document samples, selections, and
  visible text;
- screenshot dimensions, byte count, and SHA-256 when `-Capture` is explicitly
  passed.

The diagnostic lengths and hashes above are useful for local probe comparison
and budget tests only. They are not part of the normalized attachment sent to
the agent.

The probe does not write a screenshot by default. `-IncludeContent` is an
explicit local diagnostic switch and must not be used in automated logs.

For a real already-open browser window, use
[capture-live-chromium-uia.ps1](../../../tools/capture-live-chromium-uia.ps1).
The helper enumerates visible Chromium top-level windows by process and window
class, so launching it from PowerShell does not accidentally capture the
PowerShell window. If more than one browser window is open, it shows the
handles, process ids, and titles and asks for a local selection. It also
supports `-WindowHandle` for a repeatable comparison and `-WaitForForeground`
when the user wants to switch to the target window after starting the script.

The default live capture is local UIA metadata and bounded diagnostics only;
it does not include page text or pixels. Add `-IncludeContent` only for an
intentional local content sample, and add `-Capture` only when comparing the
UIA tree with a window screenshot:

```powershell
# Show visible Edge windows without capturing anything
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/capture-live-chromium-uia.ps1 `
  -Browser edge -ListOnly

# Capture the selected Edge window's UIA tree; no page text or pixels
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/capture-live-chromium-uia.ps1 `
  -Browser edge

# Explicitly capture page text and a diagnostic window screenshot locally
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/capture-live-chromium-uia.ps1 `
  -Browser edge -IncludeContent -Capture

# Start the command from a terminal, then click the Edge window within 30 seconds
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/capture-live-chromium-uia.ps1 `
  -Browser edge -WaitForForeground -IncludeContent

# The same workflow for Chrome
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/capture-live-chromium-uia.ps1 `
  -Browser chrome -IncludeContent
```

Live output is written under the system temporary directory by default, not
the repository, because real browser trees can contain URLs, account UI, form
labels, and page content. Pass `-OutputDirectory` explicitly only when a local
sample is intended to be stored in the workspace. The capture is one-shot; the
script does not watch the browser after it returns.

For the depth matrix, keep the same browser window and page fixed, record one
run at each depth, and do not use `-Capture` unless the visual path is also
being tested. The probe now reports `depthTruncated` and
`depthLimitedNodeCount`; `truncated=false` alone only says that the node cap
was not reached. The helper
[summarize-chromium-uia-depth.mjs](../../../tools/summarize-chromium-uia-depth.mjs)
turns a directory of runs into a comparable table:

```powershell
node tools/summarize-chromium-uia-depth.mjs docs/cycle-4-contextual-sidecar/research/real-test/depth-study
```

The recommended first matrix is `12, 16, 20, 24, 32` with `-MaxNodes 2000`.
Use a fixed `-WindowHandle` after `-ListOnly` identifies the target. A depth is
complete for a view only when `truncated=false`, `depthTruncated=false`, and
the traversal error count is zero. The practical sweet spot is the first depth
that meets those conditions and is followed by only a small increase in named
semantic nodes, without an unstable timing increase. Any text lengths retained
by the probe are diagnostic measurements only.

Example commands from an interactive Windows desktop:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/chromium-uia-screen-probe.ps1

$hwnd = Get-Process msedge,chrome -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1 -ExpandProperty MainWindowHandle
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/chromium-uia-screen-probe.ps1 `
  -WindowHandle ("0x{0:X}" -f $hwnd) -Capture
```

The agent execution environment may have no accessible interactive desktop:
`GetForegroundWindow()` can return `0x0`, and Edge processes may expose no
non-zero main window handle there. The probe correctly reports that condition,
but it cannot substitute for a live desktop test. The checked-in Edge samples
were generated in a separate interactive user session; the live helper above
is the reproducible way to capture the user's already-open browser window.

The fixture sampler is [sample-chromium-uia-fixtures.ps1](../../../tools/sample-chromium-uia-fixtures.ps1).
It launches each synthetic page in a disposable Edge profile, accepts only
Chromium main-window classes (`Chrome_WidgetWin_1` or `Chrome_WidgetWin_0`),
and asks the probe to save both UIA views. It can also request diagnostic GDI
captures with `-Capture`.

The earlier CDP study remains useful for comparison: CDP was measured against
Edge's explicitly launched headless endpoint, while UIA requires the visible
browser window and its platform accessibility provider. The fixture sampler
accepts only visible Chromium main windows. Any `no_interactive_window` result
means that the specific execution session could not see a browser desktop; it
must not be interpreted as a property of UIA. A window such as
`UAC_InputIndicatorOverlayWnd` is not a Chromium main window and must be
discarded rather than treated as a browser sample.

The GitHub real sample also demonstrates an important diagnostic distinction.
Both UIA views contained a `Document` at depth 11 and useful page descendants,
but the two diagnostic PNGs were only `237x39` pixels: the copy image was
black and the PrintWindow image contained only the caption controls. The tree
also reported child bounds around `-32000`, which is the characteristic
minimized-window coordinate range. This is a target-window-state/capture
validity problem, not evidence that GitHub blocks UIA or screenshots. New probe
results record `target.windowState`, `target.windowRect`, PNG dimensions, and a
dimension validity flag so this case is not reported as a successful visual
capture.

## 3. What UI Automation Is

UIA is a Windows client/provider protocol implemented over COM. An application
provider exposes a semantic tree of elements and control patterns. A client
queries that tree and reads properties or invokes a specific pattern.

The operation is not equivalent to:

- moving the mouse to a control;
- sending `Ctrl+C`;
- pressing keys and observing the result;
- scraping pixels from the desktop.

For a Chromium window, the provider may expose browser chrome such as the tab
strip and address bar, plus an accessibility representation of the web page.
The renderer's accessibility mode, page semantics, browser version, and
control implementation affect how complete that representation is.

Useful UIA concepts for the adapter are:

| UIA surface | Likely Chromium use | Capture policy |
| --- | --- | --- |
| `AutomationElement` properties | Window identity, control type, name, bounds, enabled/offscreen state | Keep only sanitized metadata |
| `TabItem` plus `SelectionItemPattern` | Find the selected browser tab | Use selected tab name as a low-cost page label; do not trust tree order |
| `Document` plus `AutomationElement.Name` | Find the page root and read semantic node labels | Keep only normalized non-empty names from the visible page subtree |
| `SelectionItemPattern` | Identify the selected browser tab | Use the state internally for tab discovery; do not serialize it on page nodes |
| `Edit` plus `ValuePattern` | Inspect address bar or other text controls | Do not forward values by default; form values are sensitive |
| `Button`, `Link`, `InvokePattern`, and similar | Describe controls or later typed actions | Read-only for the first capture slice; no generic invocation |
| `BoundingRectangle` | Locate the document region for a per-window visual crop | Use only for a bounded capture geometry |

The probe uses `ControlView` and `ContentView` with a depth/node cap. It does
not walk `RawView`, because RawView is a broader implementation tree and would
make a generic capture path expensive and difficult to redact. A smaller UIA
tree is expected in normal pages, but it is not a guarantee: complex web apps
can expose a large semantic tree.

### Default semantic normalizer

The product parser uses `ContentView` as its primary input and anchors the
result at the selected page `Document`. `ControlView` may provide fallback
metadata such as the selected tab, but its full tree is never merged into the
page tree because that duplicates browser chrome and layout nodes.

For each page node, the normalizer:

1. keeps the UIA control type as a compact role;
2. reads `AutomationElement.Current.Name` as the node's accessible display
   label;
3. drops empty names, browser chrome, empty layout containers, and nodes whose
   `IsOffscreen` value is `true` when that value is available;
4. trims and collapses whitespace without adding a second text source; and
5. converts valid `BoundingRectangle` values into compact `x`, `y`, `width`,
   and `height` screen bounds.

The output is therefore a semantic description, not a character-perfect page
transcript. In particular, `TextPattern.DocumentRange`, `GetSelection`, and
`GetVisibleRanges` are not read for the default context path. A future explicit
selection capability would need a separate product decision rather than being
implicitly added by the parser.

The normalized page block has this shape:

```json
{
  "fields": ["role", "name", "bounds"],
  "nodes": [
    ["document", "GitHub", {"x": 1857, "y": 120, "width": 1920, "height": 900}],
    ["link", "THU-MAIC/OpenMAIC", {"x": 1857, "y": 260, "width": 210, "height": 24}],
    ["button", "Open Copilot...", {"x": 1857, "y": 300, "width": 160, "height": 32}]
  ]
}
```

The parser may use serialized byte size, node count, depth, and truncation
state internally for bounded capture. Parent indexes, selection flags, and
automation IDs are not forwarded as semantic context. Bounds are the one
diagnostic-adjacent field intentionally retained because they help the agent
reason about approximate control placement. Pattern flags, values, and hashes
remain internal.

## 4. Does UIA Depend on Copy or Selection Being Allowed?

Usually, no. The default parser reads UIA node names and selection-item state;
it does not simulate the clipboard or keyboard. Therefore these page behaviors
do not inherently prevent the default semantic read:

- CSS `user-select: none`;
- disabled context menus;
- JavaScript copy handlers;
- applications that intercept `Ctrl+C`.

`TextPattern` remains available for diagnostic experiments and a future
explicit selection capability, but its document range, visible ranges, and text
selection ranges are outside the default context policy. UIA can read only what
the browser and page expose to the accessibility provider. Likely loss cases
include:

| Page or host condition | UIA result | Screen result |
| --- | --- | --- |
| Ordinary semantic HTML | Usually useful document and control nodes | Pixel copy of the visible window |
| CSS or JavaScript copy restriction | Named semantic nodes are often still readable | Still visible if rendered |
| Canvas, chart, image, or video | Little or no textual semantic content | Visual pixels may be useful; OCR/vision is separate |
| `aria-hidden` or incorrectly implemented custom controls | Missing or incomplete nodes | Visible pixels remain available |
| Virtualized or lazy content outside the viewport | May be absent or represented only partially | Only currently rendered pixels are available |
| Password, token, or form controls | Metadata may exist; values must be denied by policy | Pixels may visibly reveal the value, so capture needs redaction policy |
| DRM/protected or capture-excluded surface | UIA may expose metadata but not protected content | Capture may be blank or denied |
| Elevated or protected desktop | Cross-integrity access may fail | Capture may be denied or unavailable |
| `chrome://`, extension, PDF, or browser-internal page | Provider behavior varies by browser surface | Pixels may be available, but interpretation is weaker |

The important distinction is that “not copyable” is not the same as “not
accessible.” Conversely, “visible in the browser” is not the same as “available
through UIA.” The adapter must report partial capability rather than treating a
missing node as an empty page.

## 5. Candidate UIA Extraction Strategy

The strategy remains one-shot and target-bound:

1. Capture the foreground `TargetWindow` before Aside receives focus.
2. Confirm that its process identity is a supported Chromium browser.
3. Create an `AutomationElement` from that window handle.
4. Locate the selected `TabItem`; do not infer the active tab from element order.
5. Locate the top-level web `Document` associated with that selected tab.
6. Read title/identity metadata and normalize the page `Document` names and
   screen bounds.
7. Do not read a `DocumentRange`, visible range, or text-selection range for the
   default semantic attachment; use screen capture only as the separately
   enabled visual augmentation.
8. Discard the UIA element references after the capture returns.

The first generic browser attachment should be able to contain:

```text
host: browser
source: Chrome page / Edge page
sensitivity: local_metadata or local_content
blocks:
  page_identity: browser brand, title metadata, sanitized origin/path
  semantic_page: role/name/bounds node table
```

The current Rust contract supports text and JSON blocks but not images. This
research does not add the image block; the later Chromium implementation plan
must define its serialization, provider support, byte/dimension limits, and
non-persistence behavior.

### UIA confidence signals

The adapter should retain internal diagnostics, without forwarding them to the
provider:

- selected browser tab found;
- page `Document` found;
- named visible semantic nodes found;
- valid screen bounds found;
- tree traversal hit a cap or raised a provider error;
- document bounds available for a visual crop.

These signals can decide whether the visual fallback is useful. They must not
be used to silently broaden capture scope or to scan other browser windows.

## 6. Screen Capture as the Secondary Path

Screen capture has a different contract: it returns pixels, not meaning. The
preferred Windows API for a production per-window capture is
`Windows.Graphics.Capture` (WGC), using a `GraphicsCaptureItem` for the
captured browser window. It is available on supported Windows 10 1903+ systems,
subject to API support, capture consent, compositor behavior, and protected
content rules.

The relevant alternatives are:

| Mechanism | Strength | Failure or policy concern |
| --- | --- | --- |
| `Windows.Graphics.Capture` | Modern per-window/display capture with compositor integration | Requires a separate image pipeline; minimized, protected, and unusual surfaces need testing; user consent may be required |
| `PrintWindow` | Simple legacy per-window probe | Applications choose how to render; Chromium GPU content can be blank, stale, or incomplete |
| `BitBlt` / `CopyFromScreen` | Easy visible desktop pixels | Captures only what is currently visible, including overlays; occlusion and monitor geometry are problems |
| DXGI Desktop Duplication | Efficient monitor capture | Monitor-wide pixels, not a target-bound window; too broad for the default adapter |
| Snipping-tool style picker | Clear user-selected target | Adds a visible interaction and does not provide semantic text by itself |

The probe's `-Capture` mode exercises `CopyFromScreen` and `PrintWindow` only
as diagnostic comparisons. It is not a recommendation to use either as the
production fallback. WGC should be tested in an interactive Windows session
before implementation.

### What the visual fallback can do

- recover visible chart, canvas, image, or video information that UIA does not
  represent;
- provide a visual reference to a vision-capable provider if the attachment
  contract supports images;
- provide pixels to a local OCR stage if the product explicitly enables OCR.

### What it cannot do

- recover DOM nodes or hidden text;
- recover text outside the captured rendered area;
- guarantee content from a minimized, protected, or capture-excluded window;
- determine which pixels are trusted or safe without redaction;
- replace a browser active-tab authority by itself.

The visual fallback should target the captured browser window only. A full
monitor screenshot would include notifications, unrelated applications, and
other private content and is not acceptable as a generic browser adapter
fallback.

## 7. UIA and Visual Capture Together

The two paths should complement one another instead of duplicating the entire
page into the prompt:

```text
UIA identity and selected tab
       |
       +--> UIA semantic nodes available
       |       -> append semantic node attachment
       |
       +--> semantic coverage low and visual fallback explicitly enabled
               -> capture one browser window
               -> bounded image attachment; local OCR remains deferred
```

The recommended fallback rules are:

- Prefer normalized UIA node names whenever they are present and within budget.
- Use screen capture only after the same target has been validated again.
- Crop to the browser document region when that geometry is reliable; keep the
  browser chrome out of the content image where possible.
- Make visual capture a visible, removable attachment with local-content
  sensitivity and a short expiry.
- Apply a separate pixel-size and byte-size limit before OCR, image encoding,
  or provider projection.
- Do not silently capture the monitor, other windows, clipboard, or browser
  storage to improve the result.

If the provider receives an image, the existing `AsideContextBlock` contract
will need an explicit image variant and provider projection rules. If the image
is processed locally by OCR, the result should remain labelled as
`screen_ocr`, carry an accuracy/partial-result indication, and never be
presented as exact DOM text.

## 8. Python, Selenium, and Native Adaptation

Python is useful for a first probe but is not required for production:

| Tool | What it wraps | Fit for Aside |
| --- | --- | --- |
| `pywinauto` with the `uia` backend | Windows UIA controls and patterns | Good exploratory tool; adds Python packaging and a sidecar if shipped |
| `uiautomation` | Windows UIA COM APIs | Good exploratory tool; same runtime/lifecycle cost if shipped |
| Selenium Python client | WebDriver protocol through a browser driver | DOM/browser automation, not native UIA; usually needs an automation browser/session |
| Rust Windows UIA bindings | Native COM UIA client in the Tauri process | Best production shape; keeps one-shot lifecycle and native target binding local |

The production adapter should remain in Rust. The current native module already
owns the foreground HWND and process identity. A future implementation can use
the `windows` crate's UIA/COM bindings or a carefully isolated raw COM layer;
the exact dependency should be selected during the Chromium implementation
plan. UIA calls should run in a suitable COM apartment, stay within a bounded
wall-clock budget, and return a sanitized `ExtractedHostContext` through the
existing `HostExtractor` trait.

Selenium is not the second fallback for this product. It can read DOM content
without copy restrictions, but it cannot reliably attach to the user's already
open ordinary Chrome/Edge session without an explicit driver/debugging setup.
It would also expand the system into browser automation, which is outside the
one-click capture boundary.

## 9. Security and Privacy Boundaries

UIA is narrower than generic DOM or CDP access, but it is not automatically
safe. It may expose address-bar values, form metadata, semantic node names, and
application names. The adapter must:

- read only from the invocation `HWND` and its selected browser tab;
- avoid `RawView` and unbounded descendant traversal;
- never read or forward password values, cookies, storage, tokens, or form
  contents;
- avoid UIA actions such as invoke, set value, select, or input in the first
  capture slice;
- bound node names, node count, depth, image dimensions, and attachment bytes;
- keep element references, HWNDs, process handles, and native provider objects
  inside the native call;
- discard target bindings when the one-shot call completes;
- revalidate the target before a visual fallback and reject stale targets;
- show every image/OCR result as a removable local-content attachment;
- fail to a partial or unsupported result when the provider is unavailable.

Screen capture has a wider privacy surface even when it is per-window: browser
chrome can show account names, URLs, notifications, or form values. A visual
fallback therefore needs explicit product consent, redaction rules, and a
separate prompt-budget decision. It must not be enabled merely because UIA
returned fewer nodes than expected.

## 10. Test Matrix for the Next Chromium Plan

Run the following in both Edge and Chrome where available, using a disposable
profile and synthetic pages. Record semantic-node counts, capability flags,
lengths/hashes only as local diagnostics, and pass/fail outcomes. Do not use
the diagnostic fields as product context:

| Case | UIA observation | Visual observation |
| --- | --- | --- |
| Semantic HTML page | Selected tab, Document, named visible nodes, and screen bounds | Per-window capture dimensions and non-blank hash |
| User-selected paragraph | Confirm the default tree remains node-name based; text ranges are not serialized | Same target remains aligned |
| `user-select: none` and copy prevention | Compare named-node availability without sending Ctrl+C | Pixels remain visible |
| Canvas and image content | Missing or partial semantic text is expected | Capture plus optional OCR/vision test |
| Virtualized/lazy web app | Note viewport and node truncation | Capture only current rendered region |
| Password and form controls | Verify policy excludes values | Verify visual path has an explicit redaction decision |
| PDF viewer | Measure browser UIA versus reader surface separately | Capture result is not a reader adapter |
| `chrome://` and extension pages | Record unsupported/partial behavior | Record protected or private UI risk |
| Occluded, minimized, and maximized browser | UIA target validity and stale behavior | Compare WGC, PrintWindow, and screen capture |
| Browser window closes during capture | Stale-target rejection | No capture from a replacement window |
| Elevated browser | Integrity-level failure and degradation | Permission/capture failure and safe fallback |

## 11. Open Decisions

This study recommends the following, pending review before a Chromium plan:

1. UIA is the default Chromium transport for zero-extension capture.
2. Screen capture is a per-window, explicit secondary capability, not a monitor
   capture or continuous fallback.
3. The visual setting sends one bounded image block together with the same
   capture's UIA blocks. OCR is deferred and is not part of the setting.
4. The first UIA slice should implement identity plus the normalized semantic
   node table. Raw document text, visible ranges, and text-selection ranges are
   outside the default context policy.
5. The current PRD explicitly excludes generic accessibility traversal and
   screen capture. If this recommendation is accepted, the PRD and a later
   Chromium plan must narrow that exclusion to forbid generic/background
   surveillance while allowing this target-bound, one-shot capability.

No production transport is implemented by this research.
