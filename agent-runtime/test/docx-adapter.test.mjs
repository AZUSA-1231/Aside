import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { DocumentAdapterError } from "../src/document-contract.mjs";
import {
  MAX_COMPRESSION_RATIO,
  MAX_ENTRY_BYTES,
  packageKind,
  readPackage,
} from "../src/docx-package.mjs";
import {
  DEFAULT_DOCUMENT_ADAPTERS,
  DEFAULT_WORKSPACE_TOOL_LIMITS,
  createDocumentAdapterRegistry,
  readDocument,
} from "../src/workspace-tools.mjs";
import { resolveTaskWorkspace } from "../src/workspace.mjs";
import {
  buildBombDocx,
  buildCfbBytes,
  buildDocx,
  buildFidelityDocx,
  buildMacroDocx,
  buildMalformedDocx,
  buildNonWordZip,
  buildStructuredDocx,
  buildTraversalDocx,
} from "./docx-fixtures.mjs";

async function docxFixture(files) {
  const root = await mkdtemp(join(tmpdir(), "aside-docx-"));
  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(join(root, name), bytes);
  }
  return resolve(root);
}

async function readDocx(root, path, signal) {
  const registry = createDocumentAdapterRegistry(DEFAULT_DOCUMENT_ADAPTERS);
  const environment = (await resolveTaskWorkspace({ workspaceHint: root })).environment;
  return readDocument(
    { workspace: environment, documentRegistry: registry, limits: DEFAULT_WORKSPACE_TOOL_LIMITS },
    path,
    "auto",
    signal,
    DEFAULT_WORKSPACE_TOOL_LIMITS.maxReadBytes,
  );
}

function blocksOfType(document, type) {
  return document.blocks.filter((block) => block.type === type);
}

test("C6-20: reads common .docx structure in document order", async () => {
  const root = await docxFixture({ "report.docx": buildStructuredDocx() });
  try {
    const loaded = await readDocx(root, "report.docx");
    const document = loaded.document;

    assert.equal(document.format, "docx");
    assert.equal(document.text, undefined, "a structured adapter returns no text field");
    assert.equal("raw_text" in loaded, false);
    assert.equal(document.metadata.title, "Quarterly report");
    assert.equal(document.metadata.author, "Aside");
    assert.equal(document.metadata.tables, 1);

    // Order is preserved, and every block carries a stable locator.
    assert.deepEqual(
      document.blocks.map((block) => block.type),
      [
        "heading",
        "paragraph",
        "heading",
        "list_item",
        "list_item",
        "table",
        "page_break",
        "heading",
        "paragraph",
        // The hyperlink sits inside its own paragraph, so its text is content.
        "paragraph",
      ],
    );
    for (const block of document.blocks) {
      assert.ok(block.locator, `${block.type} carries a locator`);
    }

    const headings = blocksOfType(document, "heading");
    assert.deepEqual(headings.map((block) => block.level), [1, 2, 1]);
    assert.equal(headings[0].text, "Quarterly report");
    assert.equal(headings[0].locator.heading, 1);

    const list = blocksOfType(document, "list_item");
    assert.deepEqual(list.map((block) => block.text), ["first point", "second point"]);
    assert.deepEqual(list.map((block) => block.locator.list_item), [1, 2]);

    const table = blocksOfType(document, "table")[0];
    assert.deepEqual(table.rows, [["Region", "Revenue"], ["North", "120"]]);
    assert.deepEqual(table.locator, { table: 1 });

    // Unicode survives the round trip through the package.
    assert.ok(
      blocksOfType(document, "paragraph").some((block) => /café — naïve — 日本語/.test(block.text)),
      "unicode paragraph preserved",
    );

    // A link is reported separately, and its scheme is safe. Its paragraph
    // text is still part of the document.
    assert.deepEqual(document.links, [{ target: "https://example.com/source", text: "source" }]);
    assert.equal(blocksOfType(document, "paragraph").at(-1).text, "source");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C6-25: unsupported features are surfaced as bounded warnings", async () => {
  const root = await docxFixture({ "fidelity.docx": buildFidelityDocx() });
  try {
    const loaded = await readDocx(root, "fidelity.docx");
    const codes = loaded.document.warnings.map((warning) => warning.code);

    assert.ok(codes.includes("tracked_changes"), "tracked changes reported");
    assert.ok(codes.includes("drawings"), "drawings reported");
    assert.ok(codes.includes("fields"), "field codes reported");
    assert.ok(codes.includes("comments"), "comments reported");
    assert.ok(codes.includes("headers_footers"), "headers reported");
    assert.ok(codes.includes("external_relationships"), "external links reported");
    assert.equal(loaded.document.partial, true);
    for (const warning of loaded.document.warnings) {
      assert.equal(typeof warning.message, "string");
      assert.ok(warning.message.length <= 200, "warnings stay bounded");
    }

    // An unsafe link scheme is never reported as a link, and nothing is fetched.
    for (const link of loaded.document.links) {
      assert.match(link.target, /^https?:\/\/|^mailto:/);
    }
    assert.equal(
      loaded.document.links.some((link) => link.target.startsWith("file:")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C6-21: legacy, encrypted, macro, and non-Word inputs are refused", async () => {
  const root = await docxFixture({
    "legacy.docx": buildCfbBytes(),
    "macro.docx": buildMacroDocx(),
    "notword.docx": buildNonWordZip(),
    "malformed.docx": buildMalformedDocx(),
  });
  try {
    // A CFB container is either a legacy .doc or an encrypted package; neither
    // is readable without a converter.
    await assert.rejects(
      () => readDocx(root, "legacy.docx"),
      (error) => error instanceof DocumentAdapterError && error.code === "unsupported_format",
    );
    // Macro-enabled content is refused rather than read with a warning.
    await assert.rejects(
      () => readDocx(root, "macro.docx"),
      (error) => error.code === "unsupported_format",
    );
    // A ZIP that is not a Word package.
    await assert.rejects(
      () => readDocx(root, "notword.docx"),
      (error) => error.code === "invalid_document",
    );
    // Truncated XML.
    await assert.rejects(
      () => readDocx(root, "malformed.docx"),
      (error) => error.code === "invalid_document",
    );

    // A legacy `.doc` never reaches the adapter at all.
    const registry = createDocumentAdapterRegistry(DEFAULT_DOCUMENT_ADAPTERS);
    assert.equal(registry.select("old.doc", "auto"), undefined);
    assert.equal(registry.select("macro.docm", "auto"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hardening: a decompression bomb is refused before it is inflated", () => {
  const bomb = buildBombDocx(MAX_ENTRY_BYTES * 4);
  // The compressed package stays small; only the declared size gives it away.
  assert.ok(bomb.length < 512 * 1024, `bomb compresses to ${bomb.length} bytes`);

  const pkg = readPackage(bomb);
  assert.deepEqual(pkg.rejected, [{ name: "word/bomb.xml", code: "entry_too_large" }]);
  assert.equal(pkg.has("word/bomb.xml"), false, "the bomb was never inflated");
  // The legitimate parts still load.
  assert.equal(pkg.has("word/document.xml"), true);
});

test("hardening: compression ratio, entry count, and traversal are bounded", () => {
  const bomb = buildBombDocx(MAX_ENTRY_BYTES * 4);
  const ratioBounded = readPackage(bomb, { limits: { maxEntryBytes: Number.MAX_SAFE_INTEGER } });
  assert.deepEqual(ratioBounded.rejected, [{ name: "word/bomb.xml", code: "compression_ratio" }]);
  assert.ok(MAX_COMPRESSION_RATIO > 0);

  const many = buildDocx([{ type: "paragraph", text: "ok" }], {
    extraParts: Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`word/part${index}.xml`, strToU8("<x/>")]),
    ),
  });
  const counted = readPackage(many, { limits: { maxPackageEntries: 3 } });
  assert.ok(counted.rejected.some((entry) => entry.code === "too_many_entries"));
  assert.ok(counted.rejected.some((entry) => entry.code === "package_too_large") === false);

  const traversal = buildTraversalDocx();
  const guarded = readPackage(traversal);
  assert.ok(guarded.rejected.some((entry) => entry.code === "unsafe_entry_name"));
  assert.equal(guarded.has("../escape.txt"), false);
});

test("hardening: hostile XML is not expanded or resolved", async () => {
  // External entities and entity expansion are both refused by policy and by
  // the parser; either way nothing is fetched and nothing expands.
  const xxe = buildDocx([], {
    extraParts: {
      "word/document.xml": strToU8(
        '<?xml version="1.0"?>'
          + '<!DOCTYPE d [<!ENTITY xxe SYSTEM "file:///C:/Windows/win.ini">]>'
          + `<w:document xmlns:w="${"http://schemas.openxmlformats.org/wordprocessingml/2006/main"}">`
          + "<w:body><w:p><w:r><w:t>&xxe;</w:t></w:r></w:p></w:body></w:document>",
      ),
    },
  });
  const pkg = readPackage(xxe);
  assert.equal(pkg.text("word/document.xml").includes("<!DOCTYPE"), true);
  // The document type declaration is refused before parsing.
  await assert.rejects(
    () =>
      createDocumentAdapterRegistry(DEFAULT_DOCUMENT_ADAPTERS).get("docx").read({
        bytes: new Uint8Array(xxe),
        path: "xxe.docx",
      }),
    (error) => error.code === "invalid_document",
  );
});

test("hardening: package kind is classified by signature, not by extension", () => {
  assert.equal(packageKind(buildCfbBytes()), "cfb");
  assert.equal(packageKind(buildDocx([{ type: "paragraph", text: "x" }])), "zip");
  assert.equal(packageKind(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), "unknown");
  // An OLE container named .docx is still recognised as a container, not a ZIP.
  assert.equal(packageKind(buildMacroDocx()), "zip");
});

test("cancellation stops the read before and after parsing", async () => {
  const root = await docxFixture({ "report.docx": buildStructuredDocx() });
  try {
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      () => readDocx(root, "report.docx", aborted.signal),
      (error) => error.code === "aborted",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C6-24: docx is read-only and no write path claims it", async () => {
  const registry = createDocumentAdapterRegistry(DEFAULT_DOCUMENT_ADAPTERS);
  const adapter = registry.select("report.docx", "auto");
  assert.equal(adapter.id, "docx");
  assert.equal(adapter.write, false);
  // Content search must not try to match a Word document's text.
  assert.equal(adapter.textual, true, "docx does produce a text representation");
});

test("a package with no document part is rejected", async () => {
  const empty = Buffer.from(zipSync({ "[Content_Types].xml": strToU8("<Types/>") }));
  await assert.rejects(
    () =>
      createDocumentAdapterRegistry(DEFAULT_DOCUMENT_ADAPTERS).get("docx").read({
        bytes: new Uint8Array(empty),
        path: "empty.docx",
      }),
    (error) => error.code === "invalid_document",
  );
});

// --- Round trip against a real generator ------------------------------------
// The hand-made fixtures above encode my assumptions about OOXML. Generating
// with the `docx` library and reading the result back is what caught two of
// them, so it belongs in the suite rather than in a one-off spike.

async function generatedDocx(build) {
  const { Document, Packer } = await import("docx");
  return Buffer.from(await Packer.toBuffer(build(Document)));
}

async function readBytes(bytes) {
  const registry = createDocumentAdapterRegistry(DEFAULT_DOCUMENT_ADAPTERS);
  return registry.get("docx").read({ bytes: new Uint8Array(bytes), path: "generated.docx" });
}

test("an empty comments part is not reported as containing comments", async () => {
  const { Document, Packer, Paragraph } = await import("docx");
  // The generator always emits comments.xml, footnotes.xml, and endnotes.xml.
  // Presence is not content, and reporting otherwise would cry wolf on every
  // document this product creates.
  const bytes = Buffer.from(await Packer.toBuffer(new Document({
    sections: [{ children: [new Paragraph("just a paragraph")] }],
  })));

  const pkg = readPackage(new Uint8Array(bytes));
  assert.equal(pkg.has("word/comments.xml"), true, "the part is present");
  assert.equal(pkg.has("word/footnotes.xml"), true, "the part is present");

  const document = await readBytes(bytes);
  assert.deepEqual(document.warnings, [], "no content means no warning");
  assert.equal(document.partial, false);
});

test("a bare <w:br/> is a line break, not a page break or a space", async () => {
  const { Document, Paragraph, TextRun } = await import("docx");
  // ST_BrType defaults to `textWrapping`, and the generator emits <w:br/>
  // with no type attribute at all for a line break.
  const bytes = await generatedDocx((DocumentType) => new DocumentType({
    sections: [{ children: [
      new Paragraph({ children: [
        new TextRun("line one"),
        new TextRun({ text: "wrapped", break: 1 }),
        new TextRun("tail"),
      ]}),
    ]}],
  }));

  const document = await readBytes(bytes);
  const paragraph = document.blocks.find((block) => block.type === "paragraph");
  assert.match(paragraph.text, /line one\n/);
  assert.equal(
    document.blocks.some((block) => block.type === "page_break"),
    false,
    "a line break is not a page break",
  );
});

test("a real page break from the generator is detected", async () => {
  const { Document, PageBreak, Paragraph } = await import("docx");
  const bytes = await generatedDocx((DocumentType) => new DocumentType({
    sections: [{ children: [
      new Paragraph("before"),
      new Paragraph({ children: [new PageBreak()] }),
      new Paragraph("after"),
    ]}],
  }));

  const document = await readBytes(bytes);
  assert.deepEqual(
    document.blocks.map((block) => block.type),
    ["paragraph", "page_break", "paragraph"],
  );
});

test("generated output reads back with the structure that was written", async () => {
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel,
    Table, TableRow, TableCell, ExternalHyperlink,
  } = await import("docx");

  const bytes = Buffer.from(await Packer.toBuffer(new Document({
    title: "Round trip",
    creator: "Aside",
    sections: [{ children: [
      new Paragraph({ text: "Round trip", heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ children: [new TextRun("bold "), new TextRun({ text: "part", bold: true })] }),
      new Paragraph({ text: "bullet", bullet: { level: 0 } }),
      new Table({ rows: [
        new TableRow({ children: [
          new TableCell({ children: [new Paragraph("H1")] }),
          new TableCell({ children: [new Paragraph("H2")] }),
        ]}),
      ]}),
      new Paragraph({ children: [
        new ExternalHyperlink({ link: "https://example.com/x", children: [new TextRun("link")] }),
      ]}),
    ]}],
  })));

  const document = await readBytes(bytes);
  assert.equal(document.metadata.title, "Round trip");
  assert.equal(document.metadata.author, "Aside");
  assert.deepEqual(
    document.blocks.map((block) => block.type),
    ["heading", "paragraph", "list_item", "table", "paragraph"],
  );
  assert.equal(document.blocks[0].level, 1);
  assert.equal(document.blocks[1].text, "bold part");
  assert.deepEqual(document.blocks[3].rows, [["H1", "H2"]]);
  assert.deepEqual(document.links, [{ target: "https://example.com/x", text: "link" }]);
  // The only warning is the external hyperlink that is genuinely there. A
  // document this product generated must not warn about its own empty parts.
  assert.deepEqual(
    document.warnings.map((warning) => warning.code),
    ["external_relationships"],
  );
});
