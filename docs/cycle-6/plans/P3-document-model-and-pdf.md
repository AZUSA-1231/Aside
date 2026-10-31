# P3 - Document Representation and PDF Read

Status: implemented 2026-09-17; R3 task 11 faux-agent flows completed 2026-10-31; synchronous parsing limits and manual evidence remain open

**2026-10-31 follow-up:** R2 measured C6-19/G01 and rechecked page-loop
cancellation; [C6-I036](../ISSUES.md#c6-i036---cancelling-a-pdf-read-was-dropped-not-delayed)
retains synchronous loading / per-page parsing limits. R3 now covers task 11
with four runtime/faux-provider flows: summary and page-cited Q&A, partial
warnings, public-cursor continuation, and edit refusal. The latter exposed a
real text-replacement exception, now fixed before parsing/approval. See
[R3-INTEGRATION.md](../R3-INTEGRATION.md). Historical measurements below are
not current performance guarantees; manual and release acceptance is unchanged.
Depends on: P0 - Capability Contract and Policy Plane; P2 - Shell-Free Workspace Foundation
Unblocks: P4 and P7
Source requirements: PRD sections 7, 8, 13, 15, 16, and C6-15 through C6-19

## Outcome

Define a common bounded structured-document envelope and implement local PDF
reading through the existing in-process document adapter seam. A model can
inspect selected pages and cite stable page locations while extraction limits
and poor source quality remain explicit.

PDF is read-only. This plan exposes no mutation, OCR, Office/browser
automation, arbitrary converter, or subprocess fallback.

## Research Gate

Before selecting a PDF dependency, compare viable maintained libraries for:

- license and redistribution terms;
- pure JavaScript/WASM/native packaging and Tauri sidecar impact;
- text and metadata extraction quality;
- page selection and stable page locators;
- encryption/password and malformed-file behavior;
- memory, complexity, cancellation, and worker/process behavior;
- deterministic fixtures and telemetry/network defaults.

Record the decision in this plan or `ISSUES.md`. If no candidate satisfies the
security/build boundary, stop at the common document representation and record
PDF as a release blocker rather than invoking an external command.

## Common Document Contract

The adapter registry must support a bounded envelope containing:

```text
format, media_type, path, resource_identity
metadata
ordered blocks: paragraph | heading | list_item | table | page_break | opaque
source locators: page/section/block where available
truncation and continuation
warnings and fidelity status
adapter id/version and validation status
```

Block and locator types are product contracts. They must not expose selected
library classes or raw PDF object graphs. Chunking occurs after extraction
through one shared policy so Word does not invent incompatible limits in P4.
Output chunking does not bound parsing. Enforce input, decompression/object,
memory/complexity, and duration budgets during extraction. A Promise timeout
alone cannot interrupt synchronous parsing on the runtime event loop. Select
a cancellable implementation or a reviewed worker isolation mechanism; record
its packaging and teardown behavior without introducing a subprocess fallback.

## Tasks

1. Specify and validate the common document envelope, block vocabulary,
   metadata, locators, warnings, partial status, and continuation model.
2. Extend `createDocumentAdapterRegistry` selection so declared formats are
   actually chosen before the unsupported-extension guard, while retaining
   honest rejection for unregistered binaries.
   Separate binary bytes, structured output, and optional raw text. Remove the
   unconditional decodeUtf8(bytes.bytes) at the end of readDocument for binary
   adapters; widen format schemas deliberately and retain text/JSON behavior.
3. Implement shared post-extraction bounding/chunking by bytes, blocks,
   tables/cells, pages/sections, and complexity. Preserve stable reading order
   and source locators across chunks.
4. Complete the PDF dependency/license/build review and pin the selected
   implementation deliberately.
5. Implement PDF detection and bounded parse for local in-workspace files.
   Revalidate target identity before and after parsing when practical.
   Pass AbortSignal and execution budgets into the adapter contract; prove
   cancellation stops parsing rather than merely stops awaiting its result.
6. Support metadata and explicit page-range reads. Return page-aware blocks,
   source locators, missing-text warnings, and partial status without claiming
   layout equivalence.
7. Classify encrypted/password-protected, malformed, unsupported-version,
   image-only/text-poor, excessive-page, excessive-object, and cancelled
   documents with typed bounded outcomes.
8. Ensure adapter internals do not access network, launch subprocesses, write
   files, or inspect neighboring resources. Temporary data, if unavoidable,
   must be bounded, task-local, cleaned up, and documented.
9. Keep PDF out of every write adapter and permission path. An attempted PDF
   edit must be unavailable rather than simulated by regeneration.
10. Add synthetic/redistributable fixtures covering ordinary multi-page text,
    headings, tables where supported, unicode, empty pages, image-only pages,
    encryption, corruption, excessive size/complexity, page ranges,
    continuation, cancellation, and replacement races.
11. Add faux-agent flows for summarize, question answering with page
    references, partial extraction, and explicit PDF-edit refusal.

## Deliverables

- Common product-owned document envelope and chunking policy.
- Extended adapter registry with explicit binary format routing.
- In-process bounded PDF reader with page selection and warnings.
- PDF dependency/license/security record.
- Deterministic PDF fixture and agent-flow coverage.

## Exit Criteria

- C6-15 proves common structured results, locators, warnings, and truncation.
- C6-16 proves requested PDF page ranges do not extract unrelated pages into
  model output and preserve page identity.
- C6-17 distinguishes scanned/text-poor, encrypted, malformed, and incomplete
  extraction without OCR or false success.
- C6-18 proves no PDF mutation tool or fallback is model-visible.
- C6-19 proves size/complexity/time/cancellation limits preserve runtime
  responsiveness.
- Dependency review has no unresolved license, native packaging, telemetry, or
  subprocess surprises.

## Checks

Run document-contract and PDF fixtures independently, the workspace boundary
suite, cancellation/limit stress cases, and the full quality gate. Inspect the
packaged application dependency output on Windows and verify parsing works
without network or an external installed application.

## Dependency Decision (2026-09-17)

**Selected: `pdfjs-dist@6.3.289`, Apache-2.0, pinned exactly (no caret).**

Candidates reviewed against the PLAN's dependency gate:

| Package | License | Unpacked | Verdict |
| --- | --- | --- | --- |
| `pdfjs-dist` | Apache-2.0 | 34.8 MB | **selected** |
| `unpdf` | MIT | 2.1 MB | viable fallback; a tree-shaken pdfjs build |
| `@hyzyla/pdfium` | MIT | 11.2 MB | PDFium WASM; not needed |
| `mupdf` | **AGPL-3.0-or-later** | — | **rejected on license** |
| `pdf-lib` | MIT | — | write/edit only, no extraction |

Gate answers:

1. **License / redistribution.** Apache-2.0, no obligations beyond notice.
   `mupdf` was rejected outright: AGPL source-disclosure terms are not
   acceptable for a distributed desktop application.
2. **Native binaries / subprocess.** `dependencies` is empty — pdfjs-dist has
   no runtime dependencies. It declares one *optional* dependency,
   `@napi-rs/canvas`, which installs **thirteen platform-specific native
   binaries**. That package is loaded lazily inside a `try/catch` and is used
   only to polyfill `DOMMatrix`/`Path2D` for **rendering**. Verified
   empirically with the package removed: module load emits "rendering may be
   broken" warnings and **text extraction is unaffected** (correct per-page
   text, correct item transforms, clean `destroy()`). No subprocess is launched
   at any point.

   **Correction — `--omit=optional` is not viable project-wide.** That was the
   first recommendation here and it is wrong: Vite depends on Rollup, whose
   platform binary (`@rollup/rollup-win32-x64-msvc`) is itself an optional
   dependency. Omitting optional packages breaks the frontend build —
   reproduced, and the build was restored. The canvas packages therefore stay
   installed, and the release packaging step (C6-I010) must exclude
   `@napi-rs/*` from the bundle instead. This is a packaging instruction, not
   an install-flag instruction.
3. **Extraction quality and page locators.** The reference implementation.
   `getPage(n)` extracts one page, and `getTextContent()` returns items with a
   `transform`, which is what P3's page/block locators require.
4. **Page selection.** Per-page extraction, so a page-range read never pulls
   unrelated pages into model output (C6-16).
5. **Node compatibility — verified, with a required import path.** The default
   build (`pdfjs-dist/build/pdf.mjs`) **fails on Node 22** with
   `TypeError: Promise.try is not a function`; pdfjs warns to use the legacy
   build. `pdfjs-dist/legacy/build/pdf.mjs` loads and extracts correctly. The
   adapter must import the legacy path.
6. **Cancellation.** `PDFDocumentLoadingTask.destroy()` is real cancellation —
   it tears down the worker/transport rather than merely abandoning the await.
   The adapter must call it on abort.
7. **Telemetry / network.** None. Loading is from a byte array already bounded
   by the workspace read path; no URL fetching is used.

Residual risk accepted: 34.8 MB unpacked, and the expected stderr warnings when
optional canvas is absent. Both are packaging facts for C6-I010, not blockers.

## Verification

### Result (2026-09-17)

Full gate: `typecheck` pass; `build` pass; `runtime:test` **182/182** (170
before P3, 9 in `pdf-adapter.test.mjs`, plus the document-envelope, description,
and search-routing sections of `workspace-tools.test.mjs`); `cargo fmt --check` pass; `cargo test`
30/30; `git diff --check` clean.

**Common document contract.** `DocumentAdapterError` and the block vocabulary
moved to `document-contract.mjs` so the registry and each adapter share one
definition without a circular import. An adapter may return either `text` or
`blocks`; the registry no longer forces a text field, and the unconditional
`decodeUtf8(bytes.bytes)` that C6-I008 flagged is gone — `raw_text` is produced
only for text adapters, which is the only place the write path consumes it.
`AbortSignal` now reaches `adapter.read`.

**Registry selection.** A registered adapter that declares `extensions` wins
over the built-in unsupported-extension guard. Previously the guard ran first,
so declaring `.pdf` would have had no effect at all. Unregistered binaries
(`.docx`, `.xlsx`) remain honestly `unsupported_format`.

**PDF read.** `pdf-adapter.mjs` — read-only (`write: false`), in-process, no
rendering, no network, no subprocess. Page-aware blocks with `{page, block}`
locators, bounded metadata, explicit warnings, and a page-based continuation
for the tool layer. Scanned/image-only documents raise `no_extractable_text`
rather than reporting an empty success; partially text-bearing documents report
`partial` with per-page `page_without_text` warnings. Encrypted, malformed, and
non-PDF inputs produce distinct typed codes. Cancellation destroys the loading
task *and* races the task promise, so a `destroy()` that does not settle the
task cannot hang the read — a defect this work introduced and then fixed.

**Fixtures are generated, not committed.** `test/pdf-fixtures.mjs` authors every
byte (valid multi-page, textless, corrupt, non-PDF, large), so no third-party
binary enters the repository and every fixture is reproducible from its inputs.

**No write, network, or process capability.** The PDF adapter declares
`write: false`; the write registry contains only `workspace.write` and
`workspace.edit` and no PDF mutation; `validateDocumentText` refuses a `pdf`
format. `child_process`/`spawn`/`fetch` appear nowhere in `agent-runtime/src`.

### Outstanding — stated plainly

- **C6-19's event-loop claim is not yet proven.** pdfjs runs its parser on the
  main thread in Node (no worker thread was observed). Page count, page range,
  block count, and input size are all bounded, and `destroy()` genuinely aborts,
  but a single pathologically complex page could still occupy the event loop
  for a measurable interval. The plan's own requirement — "a Promise timeout
  alone cannot interrupt synchronous parsing" — is met by the abort path, not by
  worker isolation. Measuring responsiveness and, if needed, moving parsing to a
  worker thread is open.
- **Task 11 (faux-agent flows)** was not implemented in the original P3 result.
  R3 now exercises summary / page references, partial warnings, public-cursor
  continuation and edit refusal through actual provider-visible tool content,
  with captured root/target binding and final output checks. This closes the
  automated workflow gap, not real-model quality or desktop acceptance.
- **Task 8 (description audit)** was initially skipped and had to be fixed
  after manual testing showed the model refusing to read PDFs it could read.
  See C6-I023, which also records the search defect the same change introduced.
  Descriptions and search routing are now covered by tests; the lesson carries
  to P4 and P6.
- **No desktop or packaged-app PDF verification** has been performed. Reading a
  real-world PDF in the running application is part of the P7 matrix.
