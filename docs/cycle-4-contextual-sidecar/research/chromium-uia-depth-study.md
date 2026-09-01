# Chromium UIA Depth Study

Status: instrumentation ready; live depth matrix pending

Date: 2026-09-01

## Purpose

The UIA tree is not useful merely because it is smaller than the DOM. The
adapter needs a bounded depth that still reaches the page's meaningful
controls, while avoiding a large amount of browser chrome and empty provider
containers. This study measures that tradeoff before a normalizer is written.

The probe walks `ControlView` and `ContentView` independently. `MaxDepth` is
inclusive: a node at depth `N` is recorded, but its children are not added.
The probe checks whether those nodes actually have children, so a result can
distinguish a naturally complete tree from a tree cut by the limit.

## Existing Real Samples

The current Edge samples are useful baselines, but they do not prove that
depth 16 is complete:

| Page | View | Nodes | Document depth | Max observed depth | Page types observed |
| --- | --- | ---: | ---: | ---: | --- |
| Pinterest | Control/Content | 114 | 11 | 16 | 18 ListItem, 5 Hyperlink, 1 Image |
| GitHub | Content | 168 | 11 | 16 | 22 ListItem, 28 Hyperlink, 2 Image |
| GitHub | Control | 188 | 11 | 16 | 22 ListItem, 28 Hyperlink, 2 Image |

In both samples, the page `Document` begins at depth 11. This makes depth 16
useful enough to reach the first page-level controls, but it also means that
all page descendants currently sit in only five levels. The old probe reported
`truncated=false` for both pages, but that only covered the 800-node limit; it
did not inspect children at depth 16.

The GitHub sample also contains a separate visual-capture finding. Its PNGs
were `237x39`, with a black `CopyFromScreen` result and a caption-only
`PrintWindow` result. Page UIA data was still present. The bounds around
`-32000` indicate a minimized target-window state, so this sample must not be
used as evidence of a GitHub UIA or screenshot protection mechanism.

## Instrumentation

Each probe result now includes:

- `limits.maxNodes` and `limits.maxDepth` used by that invocation;
- `truncated`, which means the node cap was reached;
- `depthTruncated`, which means at least one node at the depth cap still had a
  child in the selected UIA view;
- `depthLimitedNodeCount` and `depthProbeErrorCount`;
- `traversalErrorCount` for provider errors before the depth cap;
- `traversalDurationMs` and total per-view `durationMs`.

The live helper accepts the same `-MaxNodes` and `-MaxDepth` parameters. Use a
large node cap during this study so depth, rather than breadth, is the variable
being measured.

## Live Test Protocol

1. Open one stable page in Edge or Chrome and keep the browser window visible
   and unminimized. Avoid scrolling or switching tabs between runs.
2. Run `-ListOnly`, record the target HWND, and use that same handle for every
   depth. This prevents a later run from silently selecting another window.
3. Capture the UIA data at depths `12, 16, 20, 24, 32`, using
   `-MaxNodes 2000 -IncludeContent`. Do not use `-Capture` during this matrix.
4. Store all runs below one directory, then summarize them with the depth
   summarizer.

Example:

```powershell
$output = "docs/cycle-4-contextual-sidecar/research/real-test/depth-study"
$hwnd = "0x123456"
foreach ($depth in @(12, 16, 20, 24, 32)) {
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/capture-live-chromium-uia.ps1 `
    -Browser edge -WindowHandle $hwnd -MaxNodes 2000 -MaxDepth $depth `
    -IncludeContent -OutputDirectory $output -SampleName "edge-depth-$depth"
}

node tools/summarize-chromium-uia-depth.mjs $output
```

For a second page, use a different output directory or sample-name prefix.
The live helper writes content samples only when `-IncludeContent` is passed;
keep these outputs local and intentional.

## Sweet-Spot Rule

A depth is a candidate only when both UIA views meet all of these conditions:

```text
truncated = false
depthTruncated = false
depthProbeErrorCount = 0
traversalErrorCount = 0
```

Among candidates, choose the first depth where the next deeper run adds little
or no useful semantic content. Compare, at minimum, named nodes, `Image`,
`Hyperlink`, `Button`, and `ListItem` counts, the normalized node count, and
total per-view time. Document/visible text lengths may remain as local probe
diagnostics, but they are not product context fields. Empty `Pane`/`Group`
growth is a cost signal, not a reason by itself to discard a depth that is
needed to reach page controls.

If the page keeps exposing meaningful nodes after depth 32, the adapter should
not raise a universal limit indefinitely. It should normalize from a bounded
page `Document`, prioritize the selected tab and meaningful selected states, and
record a partial result when the chosen budget is reached.

## Interpretation Boundary

This study measures provider tree shape, not semantic quality. A deeper tree
can still omit canvas pixels, image descriptions, virtualized content, or
provider text. Conversely, a shallow tree can contain a complete `Document`
text range. The eventual strategy should therefore use depth as one signal,
not as a substitute for a normalizer and content-budget policy.
