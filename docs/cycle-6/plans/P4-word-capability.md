# P4 - Word Read, Create, and Transform

Status: implemented 2026-09-18; manual Word-open evidence and part of task 11 outstanding
Depends on: P3 - Document Representation and PDF Read
Unblocks: P7
Source requirements: PRD sections 7, 9, 12 through 16, and C6-20 through C6-25

## Outcome

Add a first-party `.docx` capability that reads common document structure and
creates or transforms documents through an inspectable, permissioned,
non-destructive workflow. Generated packages are reopened and validated before
Aside reports success.

The product contract is useful structural fidelity, not Microsoft Word
round-trip parity. Legacy `.doc`, `.docm`, Office UI automation, and hidden
conversion processes remain unsupported.

## Research Gate

Evaluate parsing and generation libraries separately if that yields a clearer
or safer implementation. Record for each candidate:

- current license and any edition split or changed licensing history;
- maintenance, security, transitive packages, and ZIP/XML hardening;
- Windows/Vite/Node runtime packaging compatibility;
- support for headings, paragraphs, lists, tables, styles, links, images,
  headers/footers, sections, comments, fields, and tracked changes;
- ZIP bombs, XML entity behavior, path traversal, memory bounds, and
  cancellation seams;
- deterministic generation and post-write validation;
- whether it launches Office, LibreOffice, a converter, or any subprocess.

Reject libraries that require unreviewed remote conversion or installed Office
automation. Record all licenses before implementation is considered complete.

## Supported Representation

The Word adapter maps supported `.docx` content to P3's common document blocks
and a bounded style/relationship subset. It must preserve reading order and
stable section/paragraph/table locators. Unknown XML is not blindly round-
tripped as trusted executable or relationship data.

Generation accepts a stricter validated representation than reading. At
minimum it should support title/headings, paragraphs, emphasis, ordered and
unordered lists, simple tables, links with safe schemes, and explicit page
breaks when the selected library represents them reliably. The final supported
set is recorded after the research spike and exposed in tool schemas.

## Tool Surface

Prefer a small, explicit surface integrated with workspace tools:

- `workspace.read` routes `.docx` to the Word adapter;
- a first-party document generation/transform tool prepares structured output
  and a destination path;
- all writes pass through the existing permission broker;
- same-path replacement and overwriting existing Word outputs are unavailable
  in Cycle 6 (C6-I009); creation and transformation require a new output path.

Do not overload `workspace.edit` with arbitrary OOXML patch instructions. The
model should change the validated document representation and request a
bounded regeneration operation.

## Tasks

1. Complete the dependency/license/security review and record the supported
   input/output feature matrix before locking the public tool schema.
2. Implement `.docx` signature/package validation with compressed/uncompressed
   size, entry-count, XML complexity, relationship, and path traversal limits.
3. Extract metadata, headings, paragraphs, lists, simple tables, links, page
   breaks, and supported style hints into the common P3 envelope with stable
   locators and shared chunking.
4. Detect encrypted/malformed input and relevant fidelity risks such as macros,
   tracked changes, comments, fields, embedded objects, drawings, external
   relationships, complex sections, and unsupported styles. Report bounded
   warnings without claiming perfect detection.
5. Define a strict generation schema, validate all model input, bound blocks,
   text, tables/cells, links, embedded content, output size, and active time,
   and reject unsupported constructs rather than emitting corrupt packages.
6. Implement creation at a new in-workspace `.docx` path. Prepare a bounded
   structural preview, require exact permission, revalidate parent/target,
   write atomically, reopen with an independent validation path where
   practical, and return the resulting identity.
7. Implement transformation from a validated source identity to a different
   output path. Bind permission to source version, output target, structural
   summary, known fidelity warnings, and overwrite state. Preserve the source.
8. Reject same-path replacement and existing-output overwrite without changing
   either file. Revalidate that the destination is still absent at commit;
   test an output appearing after approval. C6-24 verifies this boundary;
   replacement implementation is deferred beyond Cycle 6.
9. Ensure no read operation writes temporary artifacts into the workspace and
   no generator loads external relationships or fetches linked content.
10. Add synthetic/redistributable `.docx` fixtures for supported structures,
    unicode, large tables, images/objects, external links, tracked changes,
    comments, malformed ZIP/XML, path traversal, compression bombs, legacy and
    macro formats, cancellation, output collision, stale source, denial,
    atomic failure, and successful reopen.
11. Add faux-agent workflows to summarize a Word document, create a new report,
    transform while preserving the original, react to fidelity warnings, and
    verify the output.

## Deliverables

- In-process `.docx` read and generation adapters.
- Validated bounded Word generation/transform schema.
- Permission previews with fidelity and overwrite information.
- Atomic output and post-write package/semantic validation.
- Dependency/license record and supported-feature matrix.
- Deterministic security, fidelity, and agent-workflow fixtures.

## Exit Criteria

- C6-20 reads common `.docx` structure in document order through the shared
  document envelope.
- C6-21 rejects encrypted, malformed, legacy, and macro-enabled unsupported
  input without a converter or Office process.
- C6-22 creates one valid permissioned `.docx` and verifies it by reopening.
- C6-23 transforms to a new path, preserves the original, presents fidelity
  warnings, and validates the result.
- C6-24 proves same-path replacement and existing-output overwrite are
  unavailable and preserve source/output bytes, including creation races.
- C6-25 surfaces detected unsupported features before transformation and does
  not claim round-trip fidelity.
- No parser/generator can escape workspace, fetch external relationships,
  exceed bounds, or bypass write permission.

## Checks

Run focused package-hardening, read, generation, transform, permission,
atomicity, stale-target, and reopen suites plus the full quality gate. Open
representative generated documents in Microsoft Word on Windows as manual
compatibility evidence, but do not use Word automation as the test oracle.

## Dependency Decision (2026-09-18)

**Selected: `fflate@0.8.3` (MIT) and `@xmldom/xmldom@0.9.12` (MIT), both pinned
exactly and both with zero runtime dependencies.**

| Package | License | Deps | Verdict |
| --- | --- | --- | --- |
| `fflate` | MIT | **0** | **selected** — ZIP read/write, 797 KB |
| `@xmldom/xmldom` | MIT | **0** | **selected** — XML parse, 440 KB |
| `mammoth` | BSD-2-Clause | 10 | rejected — pulls unmaintained `bluebird`, `underscore`, and `@xmldom/xmldom@0.8` |
| `docx` | MIT | 6 | rejected for generation — 4.6 MB, `xml-js`/`xml`/`hash.js`, `@types/node` as a runtime dep |
| `jszip` | MIT or GPL | 4 | rejected — `readable-stream@2` and `lie` are old |
| `docxtemplater` | MIT core | — | rejected — its useful modules are a **paid edition**, the split the gate asks about |

Two zero-dependency packages beat a ten-dependency tree that carries an
abandoned promise library and an outdated XML parser. Owning the ZIP and XML
layers is also what makes the hardening below possible: fflate's filter sees
each entry's **declared uncompressed size before inflating**, which is the only
way to refuse a bomb rather than measure it afterwards.

### Security spike (measured, not assumed)

- **XXE is not reachable.** xmldom does not resolve external entities:
  `<!ENTITY xxe SYSTEM "file:///C:/Windows/win.ini">` produced
  `entity not found:&xxe;` and no file content. A document type declaration is
  refused outright before parsing regardless.
- **Entity expansion is not reachable.** A nested `lol1..lol3` definition
  expanded to 6 characters in 0 ms — definitions are not expanded at all.
- **A decompression bomb is refused before inflation.** A 32 MB payload that
  compresses into a few hundred bytes is rejected by declared size, and the
  legitimate parts of the same package still load.
- **Nothing spawns a process or fetches a URL.** No `child_process`, no Office,
  no converter; external relationships are counted for the fidelity warning and
  never followed.

### Generation uses a library: `docx@9.7.1` (MIT, pinned)

Reading stays in-process on `fflate` + `@xmldom/xmldom`. Generation does not.
The reason is risk, not capability: emitting OOXML correctly is where a subtle
mistake produces a document Word refuses to open, which is exactly what C6-22
must not do.

`docx` costs **15 packages** (its own 6 plus the `jszip` chain: `pako`,
`lie`, `setimmediate`, `readable-stream@2.3.8`, `sax`, `xml`, `xml-js`,
`hash.js`, `nanoid`, and `@types/node` as a runtime dependency). That is a real
supply-chain cost and it is accepted deliberately, not overlooked. It replaces
hand-written OOXML emission for a bounded subset — headings, paragraphs,
emphasis, bulleted and numbered lists, tables, external links, page breaks —
which its API covers directly.

### Two reader defects the round trip caught

Generating with `docx` and reading the result back with the adapter was worth
doing before writing the generator, because the hand-made fixtures encoded two
wrong assumptions that no fixture of mine would have exposed:

1. **`word/comments.xml` and `word/footnotes.xml` always exist.** The generator
   emits both for every document, and the footnote part always carries two
   boilerplate separator entries. Keying a fidelity warning on part *presence*
   therefore cried wolf on every document this product creates. Both now key on
   content: `w:comment` elements, and the `w:footnoteReference` /
   `w:endnoteReference` markers already in the document. Header and footer parts
   are checked for visible content rather than existence.
2. **A bare `<w:br/>` is a line break, not a space.** `ST_BrType` defaults to
   `textWrapping`, and the generator emits `<w:br/>` with no `type` attribute
   for a line break. The adapter flattened it to a space, silently losing a line
   boundary. It is now preserved, and `w:type="page"` and `"column"` remain the
   only separators.

Both are pinned by tests that generate with `docx` and read the bytes back, so
the suite no longer depends only on my idea of what OOXML looks like.

### Rejected approaches

- **Converting `.docx` to HTML and re-parsing it** (mammoth's model) adds a
  lossy hop and an opinionated mapping, and yields no stable OOXML locators.
- **Hand-rolling ZIP** was unnecessary: fflate is zero-dependency and exposes
  the pre-inflation metadata the bounds need.
- **`mammoth` / `docx4js` for reading.** Neither is viable: mammoth is lossy and
  carries `bluebird`; `docx4js` was last published 2024-09 and depends on
  `cheerio@0.22` and `jszip@2.6`.

## Verification

### Result — read side (2026-09-18)

Full gate: `typecheck` pass; `build` pass; `runtime:test` **197/197** (183
before P4, 14 in `docx-adapter.test.mjs`); `cargo fmt --check` pass;
`cargo test` 30/30; `git diff --check` clean.

**C6-20 — structure in document order.** `docx-adapter.mjs` maps `.docx` to the
P3 envelope: headings with levels, paragraphs, list items, tables, page breaks,
and separately-reported links, each with a stable `{paragraph}` / `{table}` /
`{heading}` / `{list_item}` locator. Core properties supply title and author.
Unicode survives the package round trip.

**C6-21 — refused without a converter.** Classification is by **signature, not
extension**: a ZIP container is a package, an OLE/CFB container is a legacy
`.doc` or an encrypted OOXML package, and anything else is not a document.
Macro-enabled content (`word/vbaProject.bin`) is refused rather than read with
a warning. A ZIP that is not a Word package and truncated XML are
`invalid_document`.

**C6-25 — fidelity warnings, no round-trip claim.** Tracked changes, drawings,
embedded objects, field codes, content controls, footnotes, comments, headers
and footers, external relationships, and refused package entries are each
reported once, bounded, and `partial` is set. Detection is best-effort and says
so. An unsafe link scheme (`file:`) is never surfaced as a link.

**Hardening.** Entry names are refused for traversal, absolute paths, and drive
prefixes. Per-entry size, compression ratio, entry count, and total size are all
enforced **in fflate's filter, before inflation**. Document type declarations
are refused. External relationships are counted, never followed.

**Two defects found and fixed while building this.** OOXML attributes are
namespaced (`w:val`, `w:type`), so `getAttribute("val")` silently returned
`null` and every heading was read as a plain paragraph; attribute lookup is now
by local name. And registering `.docx` changed the routing that three existing
tests depended on — the tests were corrected rather than the routing.

**C6-I023 applied.** The adapter, the `workspace.read` description, and the
system prompt changed in the same step. The capability summary is derived from
`describeDocumentFormats()`, so `docx` appeared in the prompt with no edit to
that text.

### Result — generation and transformation (2026-09-18)

Full gate: `typecheck` pass; `build` pass; `runtime:test` **208/208**;
`cargo fmt --check` pass; `cargo test` 30/30; `git diff --check` clean.

**C6-22 — create is verified by reopening.** `docx-writer.mjs` validates a
strict declarative specification and renders it with the `docx` library; the
model never emits OOXML. Unknown keys and unknown block types are rejected
rather than ignored, links are restricted to `http`, `https`, and `mailto`, and
every dimension is bounded. `document.create` writes through the shared atomic
path and then **reopens the written package** and compares the structure it
finds against the structure that was requested. A digest match would prove only
that bytes were copied; the reopen is what proves the file is a readable
document.

**C6-23 — transform preserves the source.** `document.transform` reads and
summarises the source (including its fidelity warnings, which reach the
permission preview), then writes a different path. The source is byte-identical
afterwards, and `source_preserved` is reported.

**C6-24 — refusal, including the race.** Same-path replacement is refused as
`same_path_replacement` and an existing output as `target_exists`, both before
any permission is requested, with the file left untouched. The destination is
re-checked at the rename itself, so an output that appears while the decision is
pending fails closed rather than being overwritten.

**The one atomic write path.** `writeTextAtomic` was split so `writeAtomic`
owns the containment, revalidation, temp-then-rename, and cleanup guarantees,
with `writeTextAtomic` and `writeBytesAtomic` as thin wrappers. A second
implementation of that machinery would have been the place a containment check
gets forgotten.

### The grant mechanism caught a real defect

The first runtime-level run of `document.create` returned `denied` with no
obvious cause. The tool had requested permission under an invented
`tool_call_id` instead of the real call id, so the single-use grant was recorded
against an identity no call would ever consume — and the P0 verification
refused to accept a success whose approval did not belong to it. That is exactly
what C6-I013 was built for, and it is the first shipped tool to exercise it.

### Outstanding

- **Task 11 is partly done.** Creating and transforming through the runtime are
  covered, including the denied path. Summarising an existing Word document as
  an agent workflow, and reacting to a source's fidelity warnings, are not
  separately exercised.
- **Manual Word-open evidence** has not been gathered. The Checks section asks
  for representative generated documents opened in Microsoft Word on Windows.
  This is the strongest available evidence that the output is a real Word file
  and it is P7's to perform.
- **The reader does not distinguish ordered from bulleted lists.** Both map to
  `list_item`, because the envelope's block vocabulary has no ordering flag even
  though `numbering.xml` carries it. Generation and reading therefore round-trip
  text correctly but not list kind.
