import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  MAX_PDF_BLOCKS,
  MAX_PDF_PAGE_RANGE,
  createPdfAdapter,
  parsePageRange,
} from "../src/pdf-adapter.mjs";
import { DocumentAdapterError } from "../src/document-contract.mjs";
import {
  DEFAULT_DOCUMENT_ADAPTERS,
  DEFAULT_WORKSPACE_TOOL_LIMITS,
  createDocumentAdapterRegistry,
  readDocument,
} from "../src/workspace-tools.mjs";
import { resolveTaskWorkspace } from "../src/workspace.mjs";
import {
  buildCorruptPdf,
  buildLargePdf,
  buildNonPdfBytes,
  buildPdf,
  buildTextlessPdf,
} from "./pdf-fixtures.mjs";

async function pdfFixture(files) {
  const root = await mkdtemp(join(tmpdir(), "aside-pdf-"));
  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(join(root, name), bytes);
  }
  return resolve(root);
}

async function readPdf(root, path, selection, signal) {
  const registry = createDocumentAdapterRegistry(DEFAULT_DOCUMENT_ADAPTERS);
  const environment = (await resolveTaskWorkspace({ workspaceHint: root })).environment;
  return readDocument(
    { workspace: environment, documentRegistry: registry, limits: DEFAULT_WORKSPACE_TOOL_LIMITS },
    path,
    "auto",
    signal,
    DEFAULT_WORKSPACE_TOOL_LIMITS.maxReadBytes,
    selection,
  );
}

function pageTexts(document) {
  const pages = [];
  let current;
  for (const block of document.blocks) {
    if (block.type === "page_break") {
      current = { page: block.locator.page, lines: [] };
      pages.push(current);
      continue;
    }
    current?.lines.push(block.text);
  }
  return pages;
}

test("C6-15: extracts ordered, located blocks from a real PDF", async () => {
  const root = await pdfFixture({
    "report.pdf": buildPdf([
      ["Quarterly report", "revenue increased"],
      ["Second page heading", "closing notes"],
    ]),
  });
  try {
    const loaded = await readPdf(root, "report.pdf");

    assert.equal(loaded.document.format, "pdf");
    assert.equal(loaded.document.media_type, "application/pdf");
    assert.equal(loaded.document.text, undefined, "a binary adapter returns no text field");
    assert.equal("raw_text" in loaded, false);
    assert.equal(loaded.document.metadata.pages, 2);
    assert.deepEqual(loaded.document.warnings, []);

    const pages = pageTexts(loaded.document);
    assert.deepEqual(pages, [
      { page: 1, lines: ["Quarterly report", "revenue increased"] },
      { page: 2, lines: ["Second page heading", "closing notes"] },
    ]);
    // Every block carries a locator, and page identity is preserved.
    for (const block of loaded.document.blocks) {
      assert.ok(block.locator && Number.isSafeInteger(block.locator.page));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C6-16: a page range reads only the requested pages", async () => {
  const root = await pdfFixture({
    "many.pdf": buildLargePdf(12),
  });
  try {
    const whole = await readPdf(root, "many.pdf");
    assert.equal(whole.document.metadata.pages, 12);
    assert.equal(whole.document.blocks.length, 12 * 3, "one page marker plus two lines per page");

    const selected = await readPdf(root, "many.pdf", { pages: "4-6" });
    const pages = pageTexts(selected.document);
    assert.deepEqual(pages.map((page) => page.page), [4, 5, 6]);
    assert.equal(selected.document.metadata.pages, 12, "the document size is still reported");
    assert.equal(selected.document.metadata.pages_read, 3);
    assert.equal(selected.document.metadata.pages_without_text, 0);
    // No unrelated page content reaches the output.
    for (const page of pages) {
      assert.deepEqual(
        page.lines,
        [`Page ${page.page} heading`, `Page ${page.page} body line`],
      );
    }

    const single = await readPdf(root, "many.pdf", { pages: "9" });
    assert.deepEqual(pageTexts(single.document).map((page) => page.page), [9]);

    const disjoint = await readPdf(root, "many.pdf", { pages: "2,7-8" });
    assert.deepEqual(pageTexts(disjoint.document).map((page) => page.page), [2, 7, 8]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C6-17: a scanned, text-poor PDF is refused rather than reported as empty success", async () => {
  const root = await pdfFixture({
    "scanned.pdf": buildTextlessPdf(3),
  });
  try {
    await assert.rejects(
      () => readPdf(root, "scanned.pdf"),
      (error) =>
        error instanceof DocumentAdapterError &&
        error.code === "no_extractable_text",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C6-17: partial extraction reports the missing pages instead of hiding them", async () => {
  // One page with text, followed by pages that carry none.
  const root = await pdfFixture({
    "mixed.pdf": buildPdf([["first page has text"], [], []]),
  });
  try {
    const loaded = await readPdf(root, "mixed.pdf");
    assert.equal(loaded.document.partial, true);
    assert.equal(loaded.document.metadata.pages_without_text, 2);
    const codes = loaded.document.warnings.map((warning) => warning.code);
    assert.deepEqual(codes, ["page_without_text", "page_without_text"]);
    assert.deepEqual(
      loaded.document.warnings.map((warning) => warning.page),
      [2, 3],
    );
    assert.equal(pageTexts(loaded.document).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C6-17: encrypted, malformed, and non-PDF inputs fail with typed codes", async () => {
  const root = await pdfFixture({
    "broken.pdf": buildCorruptPdf(),
    "notapdf.pdf": buildNonPdfBytes(),
  });
  try {
    for (const path of ["broken.pdf", "notapdf.pdf"]) {
      await assert.rejects(
        () => readPdf(root, path),
        (error) =>
          error instanceof DocumentAdapterError &&
          ["invalid_document", "no_extractable_text"].includes(error.code),
        path,
      );
    }

    // Password protection is classified distinctly. Driven through the
    // injectable loader so the branch is deterministic without a real
    // encrypted fixture.
    const encrypted = createPdfAdapter({
      load: async () => {
        const error = new Error("Password required");
        error.name = "PasswordException";
        return { promise: Promise.reject(error), destroy() {} };
      },
    });
    await assert.rejects(
      () => encrypted.read({ bytes: new Uint8Array(), path: "secret.pdf" }),
      (error) => error.code === "encrypted_document",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C6-19: excessive page counts and page ranges are bounded", async () => {
  const root = await pdfFixture({ "big.pdf": buildLargePdf(4) });
  try {
    // A range wider than the per-request budget is refused.
    assert.throws(
      () => parsePageRange(`1-${MAX_PDF_PAGE_RANGE + 1}`),
      (error) => error.code === "page_range_too_large",
    );
    assert.equal(parsePageRange("1-3").pages.length, 3);
    assert.deepEqual(parsePageRange("3,1,2,2").pages, [1, 2, 3]);
    assert.equal(parsePageRange(undefined).pages, undefined);
    for (const bad of ["0", "3-1", "abc", "1-", "-2", "1,,x"]) {
      assert.throws(
        () => parsePageRange(bad),
        (error) => error.code === "invalid_page_range",
        bad,
      );
    }

    // A page beyond the document is reported, not silently empty.
    await assert.rejects(
      () => readPdf(root, "big.pdf", { pages: "99" }),
      (error) => error.code === "invalid_page_range",
    );

    // A document over the page ceiling is refused before extraction.
    const bounded = createPdfAdapter({
      load: async () => ({
        promise: Promise.resolve({
          numPages: 5000,
          async getPage() {
            throw new Error("must not extract");
          },
          async destroy() {},
        }),
        destroy() {},
      }),
    });
    await assert.rejects(
      () => bounded.read({ bytes: new Uint8Array(), path: "huge.pdf" }),
      (error) => error.code === "document_too_complex",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C6-19: cancellation stops parsing rather than only the await", async () => {
  const root = await pdfFixture({ "report.pdf": buildPdf([["content"]]) });
  try {
    // An already-aborted signal never starts the load.
    let loads = 0;
    const guarded = createPdfAdapter({
      load: async () => {
        loads += 1;
        return { promise: Promise.resolve({ numPages: 1 }), destroy() {} };
      },
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => guarded.read({ bytes: new Uint8Array(), path: "x.pdf", signal: controller.signal }),
      (error) => error.code === "aborted",
    );
    assert.equal(loads, 0, "no parse was started");

    // Aborting mid-parse destroys the loading task, which is what actually
    // interrupts pdfjs rather than merely abandoning the promise.
    let destroyed = false;
    const slow = createPdfAdapter({
      load: async () => ({
        promise: new Promise(() => {}),
        destroy() {
          destroyed = true;
        },
      }),
    });
    const mid = new AbortController();
    const pending = slow.read({ bytes: new Uint8Array(), path: "slow.pdf", signal: mid.signal });
    mid.abort();
    await assert.rejects(pending, (error) => error.code === "aborted");
    assert.equal(destroyed, true, "the loading task was destroyed");

    // The real adapter honours an aborted signal too.
    const live = new AbortController();
    live.abort();
    await assert.rejects(
      () => readPdf(root, "report.pdf", undefined, live.signal),
      (error) => error.code === "aborted",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C6-19: a block ceiling bounds extraction and warns", async () => {
  // Two blocks per page, so this exceeds MAX_PDF_BLOCKS while staying under
  // the page ceiling.
  const pageCount = Math.ceil(MAX_PDF_BLOCKS / 2) + 100;
  // A real 2000-page file exceeds the read budget, so the ceiling is driven
  // through the injectable loader: same code path, deterministic, fast.
  const bounded = createPdfAdapter({
    load: async () => ({
      promise: Promise.resolve({
        numPages: pageCount,
        async getPage(pageNumber) {
          return {
            async getTextContent() {
              return {
                items: [{ str: `page ${pageNumber}`, transform: [1, 0, 0, 1, 0, 700] }],
              };
            },
          };
        },
        async getMetadata() {
          return { info: {} };
        },
        async destroy() {},
      }),
      destroy() {},
    }),
  });

  const document = await bounded.read({ bytes: new Uint8Array(), path: "many.pdf" });
  assert.ok(
    document.blocks.length <= MAX_PDF_BLOCKS,
    `extraction stopped at the ceiling (${document.blocks.length})`,
  );
  assert.ok(document.warnings.some((warning) => warning.code === "block_limit"));
  assert.equal(document.metadata.pages, pageCount, "the document size is still reported");
});

test("the read tool renders blocks with page markers and a page continuation", async () => {
  const root = await pdfFixture({ "long.pdf": buildLargePdf(40) });
  try {
    const registry = createDocumentAdapterRegistry(DEFAULT_DOCUMENT_ADAPTERS);
    const environment = (await resolveTaskWorkspace({ workspaceHint: root })).environment;
    const limits = { ...DEFAULT_WORKSPACE_TOOL_LIMITS, maxOutputBytes: 1_024 };
    const loaded = await readDocument(
      { workspace: environment, documentRegistry: registry, limits },
      "long.pdf",
      "auto",
      undefined,
      limits.maxReadBytes,
      undefined,
    );
    // Rendering through the tool is exercised in workspace-tools tests; here we
    // only assert the adapter reports enough for a correct continuation.
    assert.equal(loaded.document.metadata.pages, 40);
    assert.ok(loaded.document.blocks.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A01 — a page-range argument must not be able to stop the runtime
//
// Found by the independent audit. A digit string longer than a double can
// represent exactly passed every guard: the span arithmetic reported a length
// of 1, and the iteration could not advance because `page += 1` is a no-op past
// 2^53. The loop never terminated, and because it runs synchronously it blocked
// the event loop, where no AbortSignal can reach it.
//
// These tests assert the refusal. They cannot assert the hang itself: a test
// that ran the unfixed code would never return, taking the whole suite with it.
// The hang was demonstrated separately, in a child process under an external
// kill, before the fix.
// ---------------------------------------------------------------------------

test("A01: refuses a page number a double cannot represent exactly", () => {
  for (const input of ["9007199254740992", "9007199254740993", "1-9007199254740992"]) {
    assert.throws(
      () => parsePageRange(input),
      (error) => {
        assert.equal(error.code, "invalid_page_range", `${input} should be refused`);
        return true;
      },
      `${input} must be refused rather than iterated`,
    );
  }
});

test("A01: the safe-integer boundary is exact in both directions", () => {
  const largest = String(Number.MAX_SAFE_INTEGER);
  // At the boundary the value is still representable, so it is accepted here and
  // then rejected downstream for being beyond the document. Refusing it at parse
  // time would be a different, wrong claim.
  assert.deepEqual(parsePageRange(largest).pages, [Number.MAX_SAFE_INTEGER]);
  // One past it is not representable, and must not reach the iteration.
  assert.throws(
    () => parsePageRange(String(Number.MAX_SAFE_INTEGER + 1)),
    (error) => error.code === "invalid_page_range",
  );
});

test("A01: ordinary page numbers still work", () => {
  assert.deepEqual(parsePageRange("1,3,5-7").pages, [1, 3, 5, 6, 7]);
  assert.deepEqual(parsePageRange("2000").pages, [2_000]);
  assert.deepEqual(parsePageRange(" 1 , 2 ").pages, [1, 2]);
});
