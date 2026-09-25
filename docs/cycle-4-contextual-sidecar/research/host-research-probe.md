# Real Host Research Probe

The production capture path remains path-only for file-oriented hosts. This
probe is a separate, explicit experiment for learning what a real host exposes
before a future rich-extraction decision. It never sends its artifacts through
Aside IPC or the agent runtime.

## Invocation

Open the synthetic [host-research-fixture.html](../../../tools/fixtures/host-research-fixture.html)
or another document in the host first, then obtain its exact top-level
HWND and PID with a window-inspection tool. Both values are mandatory; the
probe does not enumerate windows or choose a foreground target.

Example for a Word fixture:

```powershell
pwsh -NoProfile -File .\tools\host-research-probe.ps1 `
  -WindowHandle 0x0000000000123456 `
  -ProcessId 12345 `
  -HostKind Word `
  -FullExtraction `
  -ExpandedUia `
  -IncludePaths `
  -RedactSensitive `
  -OutputDirectory "$env:TEMP\aside-host-research" `
  -RunName word-fixture-01
```

Use `-HostKind Excel` for a workbook, `-HostKind PDFReader` for a PDF reader,
or leave the kind as `Auto` when the process identity is sufficient. The PDF
reader path may also be supplied explicitly with `-DocumentPath`; an explicit
operator path is marked separately from a host-discovered locator.

`-FullExtraction` is the opt-in that reads document text through the selected
host's read-only API. Word and Excel use the already-running COM instance from
the ROT and verify `ActiveWindow.Hwnd` before and after extraction. PDF reader,
VSCode, Explorer, and generic targets use UIA TextPattern only when that
provider exposes it. No `New-Object -ComObject` launch, edit, save, navigate,
clipboard operation, script injection, or process-wide directory change is
performed.

By default paths and strings are represented by length and short SHA-256
metrics. `-IncludePaths` exposes validated local paths in the research output.
`-RedactSensitive` replaces password, secret, token, API-key, and fixture
sentinel values in full text. `-IncludeRawContent` adds the unredacted local
research value as a separately named field and should only be used with a
synthetic fixture.

## Artifacts

Each run creates a directory under the requested output directory containing:

| Artifact | Purpose |
| --- | --- |
| `probe-output.json` | sanitized target binding, options, timing, warnings, and artifact references |
| `host-data.json` | host-native metadata, path locator observations, and extraction mode/counts |
| `uia-control-view.json` | bounded or explicitly expanded UIA ControlView tree |
| `uia-content-view.json` | bounded or explicitly expanded UIA ContentView tree |
| `uia-text-and-paths.json` | TextPattern capability metrics and explicit UIA path signals |
| `document-extraction.json` | Word paragraphs/tables/links, Excel sheets/cells/links, or PDF/UIA text when requested |
| `capability-summary.json` | production boundary recommendation and missing/available observations |
| `comparison-summary.json` | field-level target binding, stability, sensitivity, and production/research decision |

The last two artifacts are local research data. Do not copy them into a
provider request, durable session, issue, or commit when they contain real
document content.

## Capability matrix

| Host | Identity binding | Metadata/path source | Research full extraction | Production decision before evidence |
| --- | --- | --- | --- | --- |
| Explorer | explicit HWND/PID | target-bound Shell folder/selection paths plus UIA address/location controls | no document read; selected-item evidence only | production uses Shell path discovery with UIA fallback |
| VSCode | explicit HWND/PID | explicit UIA workspace/resource/path signals | UIA TextPattern metrics or text where exposed | bridge and active-file integration deferred; no new capability promotion |
| Word | explicit HWND/PID plus COM `ActiveWindow.Hwnd` | COM `ActiveDocument.FullName`, metadata, UIA comparison | paragraphs, tables, hyperlinks, and metadata | path descriptor only; rich content remains research-only |
| Excel | explicit HWND/PID plus COM `ActiveWindow.Hwnd` | COM `ActiveWorkbook.FullName`, metadata, UIA comparison | sheets, used-range cells, hyperlinks, and metadata | path descriptor only; rich content remains research-only |
| PDF reader | explicit HWND/PID | explicit UIA path signal or operator-supplied `-DocumentPath` | UIA TextPattern document ranges where exposed | unavailable without a target-bound locator; never title-guess |
| Other UIA host | explicit HWND/PID | UIA ControlView/ContentView and TextPattern diagnostics | bounded UIA text experiment only | Generic UIA bounded fallback, with no path assumption |

Repeat the same command against the same HWND/PID and compare the JSON
metrics, `capability-summary.json`, `comparison-summary.json`, and elapsed timings. A replacement window,
closed target, PID mismatch, changed process start fingerprint, denied COM/UIA
provider, or ambiguous path must be recorded as unavailable/stale rather than
substituted with a newer foreground window.

## Decision rule

Only fields that are target-bound, reproducible across repeated captures,
understood for sensitivity, and within an acceptable size/latency budget may
be proposed for a future product contract. A successful full extraction does
not expand Cycle 4 production capture automatically.
