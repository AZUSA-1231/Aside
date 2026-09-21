import { DocumentAdapterError } from "./document-contract.mjs";

/**
 * A local, in-process, read-only PDF adapter.
 *
 * PDF is read-only by decision (C6-I007): this module never writes, never
 * launches a process, never fetches a URL, and never renders. Only text and
 * page identity are extracted, and nothing here claims layout equivalence.
 */

export const PDF_ADAPTER_ID = "pdf";
/**
 * Pages parsed between event-loop yields.
 *
 * A bound rather than a time check, so the responsiveness cost is a fixed
 * property of the document size rather than something that varies with machine
 * load. Small enough that a cancellation is noticed promptly, large enough that
 * the yield itself is not the dominant cost. See C6-I036.
 */
export const PDF_PAGES_PER_YIELD = 16;

export const MAX_PDF_PAGES = 2_000;
export const MAX_PDF_PAGE_RANGE = 50;
export const MAX_PDF_BLOCKS = 2_000;
export const MAX_PDF_METADATA_BYTES = 512;

const MAX_PDF_READ_BYTES = 32 * 1024 * 1024;
const MAX_PDF_EXPANDED_BYTES = 4 * 1024 * 1024;

/**
 * pdfjs ships a browser build and a Node build. The default build calls
 * `Promise.try`, which does not exist on Node 22, so the legacy entry is
 * required — not a preference.
 */
async function loadPdfjs() {
  const module = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return module;
}

const defaultLoader = async (data) => {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({
    data,
    // No rendering, no eval, no system fonts: text extraction only.
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    verbosity: 0,
  });
};

/**
 * Parses a page-range expression such as "1-3,5" or "2". Returns a sorted,
 * de-duplicated, bounded list. An empty or absent expression selects from the
 * first page.
 */
export function parsePageRange(input, { maxPages = MAX_PDF_PAGE_RANGE } = {}) {
  if (input === undefined || input === null || input === "") {
    return { pages: undefined, requested: undefined };
  }
  if (typeof input !== "string") {
    throw new DocumentAdapterError("invalid_page_range", "The page range must be text.");
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) return { pages: undefined, requested: undefined };
  if (trimmed.length > 128) {
    throw new DocumentAdapterError("invalid_page_range", "The page range is too long.");
  }

  const selected = new Set();
  for (const part of trimmed.split(",")) {
    const token = part.trim();
    if (token.length === 0) continue;
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token);
    if (!match) {
      throw new DocumentAdapterError(
        "invalid_page_range",
        `The page range "${token}" is not a page or page span.`,
      );
    }
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    // Checked before any arithmetic, and before the span guards below.
    //
    // A digit string can exceed what a double represents exactly. Past 2^53 the
    // span arithmetic stops being meaningful — `end - start + 1` can report 1
    // for a span of one enormous page and pass the count guard — and worse, the
    // iteration below cannot advance, because `page += 1` is a no-op at that
    // magnitude. The loop then never terminates, and since this runs
    // synchronously it blocks the event loop, where no AbortSignal can reach it.
    //
    // This is reachable from a model-supplied argument, so it is a denial of
    // service on the runtime, not a malformed-input nicety.
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw new DocumentAdapterError(
        "invalid_page_range",
        `The page range "${token}" names a page outside the supported range.`,
      );
    }
    if (start < 1 || end < start) {
      throw new DocumentAdapterError(
        "invalid_page_range",
        `The page range "${token}" is not a valid ascending span.`,
      );
    }
    if (end - start + 1 > maxPages) {
      throw new DocumentAdapterError(
        "page_range_too_large",
        `A single request may select at most ${maxPages} pages.`,
        undefined,
        { max_pages: maxPages },
      );
    }
    for (let page = start; page <= end; page += 1) selected.add(page);
  }

  const pages = [...selected].sort((left, right) => left - right);
  if (pages.length === 0) return { pages: undefined, requested: trimmed };
  if (pages.length > maxPages) {
    throw new DocumentAdapterError(
      "page_range_too_large",
      `A single request may select at most ${maxPages} pages.`,
      undefined,
      { max_pages: maxPages },
    );
  }
  return { pages, requested: trimmed };
}

function typedParseError(error, path) {
  const name = error?.name ?? "";
  if (name === "PasswordException") {
    return new DocumentAdapterError(
      "encrypted_document",
      "The PDF is password-protected and cannot be read.",
      path,
    );
  }
  if (name === "InvalidPDFException") {
    return new DocumentAdapterError(
      "invalid_document",
      "The file is not a readable PDF.",
      path,
    );
  }
  if (name === "ResponseException" || /fetch|network|xhr/i.test(String(error?.message))) {
    return new DocumentAdapterError(
      "invalid_document",
      "The PDF could not be read without external access.",
      path,
    );
  }
  return new DocumentAdapterError(
    "invalid_document",
    "The PDF could not be parsed.",
    path,
  );
}

/** Groups positioned text items into lines by their vertical position. */
function itemsToLines(items) {
  const lines = [];
  let current = null;
  for (const item of items) {
    const text = typeof item?.str === "string" ? item.str : "";
    if (text.length === 0) continue;
    const y = Array.isArray(item.transform) ? Math.round(item.transform[5]) : 0;
    if (!current || current.y !== y) {
      current = { y, parts: [] };
      lines.push(current);
    }
    current.parts.push(text);
  }
  return lines
    .map((line) => line.parts.join(" ").replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
}

function boundedMetadata(value, maxBytes = MAX_PDF_METADATA_BYTES) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > maxBytes ? `${trimmed.slice(0, maxBytes)}…` : trimmed;
}

/**
 * Creates the adapter. `load` is injectable so every failure branch — encrypted,
 * malformed, oversized, cancelled — is deterministic in tests without needing
 * a real malicious fixture.
 */
export function createPdfAdapter({ load = defaultLoader, id = PDF_ADAPTER_ID } = {}) {
  return {
    id,
    formats: Object.freeze([PDF_ADAPTER_ID]),
    extensions: Object.freeze([".pdf"]),
    // Read-only: no write path may ever claim a PDF (C6-18).
    write: false,
    maxReadBytes: MAX_PDF_READ_BYTES,
    maxExpandedBytes: MAX_PDF_EXPANDED_BYTES,
    async read({ bytes, path, signal, selection }) {
      if (signal?.aborted) {
        throw new DocumentAdapterError("aborted", "The PDF read was cancelled.", path);
      }
      const requested = parsePageRange(selection?.pages);
      let task;
      try {
        task = await load(new Uint8Array(bytes));
      } catch (error) {
        if (error instanceof DocumentAdapterError) throw error;
        throw typedParseError(error, path);
      }
      if (!task || typeof task.promise?.then !== "function") {
        throw new DocumentAdapterError(
          "invalid_document",
          "The PDF loader did not return a document task.",
          path,
        );
      }

      // Cancellation must stop parsing, not merely stop awaiting it: destroying
      // the loading task is what interrupts pdfjs. The abort promise is raced
      // against the task so a destroy that does not settle the task's promise
      // cannot leave the read hanging forever.
      let destroyed = false;
      let rejectOnAbort;
      const aborted = new Promise((_, reject) => {
        rejectOnAbort = reject;
      });
      const destroy = () => {
        destroyed = true;
        try {
          task.destroy?.();
        } catch {
          // Destroying is best-effort; the abort already failed the read.
        }
        rejectOnAbort(
          new DocumentAdapterError("aborted", "The PDF read was cancelled.", path),
        );
      };
      if (signal?.aborted) destroy();
      else signal?.addEventListener("abort", destroy, { once: true });

      let document;
      try {
        document = await Promise.race([task.promise, aborted]);
      } catch (error) {
        if (destroyed || signal?.aborted) {
          throw new DocumentAdapterError("aborted", "The PDF read was cancelled.", path);
        }
        throw typedParseError(error, path);
      }

      try {
        if (destroyed || signal?.aborted) {
          throw new DocumentAdapterError("aborted", "The PDF read was cancelled.", path);
        }
        const pageCount = Number.isSafeInteger(document.numPages) ? document.numPages : 0;
        if (pageCount <= 0) {
          throw new DocumentAdapterError("invalid_document", "The PDF has no pages.", path);
        }
        if (pageCount > MAX_PDF_PAGES) {
          throw new DocumentAdapterError(
            "document_too_complex",
            `The PDF has more than ${MAX_PDF_PAGES} pages.`,
            path,
            { pages: pageCount, max_pages: MAX_PDF_PAGES },
          );
        }

        const pages = requested.pages
          ? requested.pages.filter((page) => page <= pageCount)
          : Array.from({ length: pageCount }, (_, index) => index + 1);
        if (requested.pages && pages.length === 0) {
          throw new DocumentAdapterError(
            "invalid_page_range",
            `The requested pages are beyond this document (${pageCount} pages).`,
            path,
            { pages: pageCount },
          );
        }

        const blocks = [];
        const warnings = [];
        let pagesWithText = 0;
        let pagesWithoutText = 0;
        let pagesSinceYield = 0;
        for (const pageNumber of pages) {
          if (signal?.aborted) {
            throw new DocumentAdapterError("aborted", "The PDF read was cancelled.", path);
          }
          // Yield to the event loop periodically so a cancellation can actually
          // arrive. See C6-I036.
          //
          // pdfjs parses on this thread, so without yielding the loop is
          // occupied from the first page to the last: the `signal.aborted`
          // check above is unreachable, because the abort callback that would
          // set it is queued behind work that never ends. Measured: a 300-page
          // read blocked for 256ms with zero event-loop turns, and an abort
          // issued 1ms in fired 241ms later — after the read had already
          // succeeded. The user cancelled and got the document.
          //
          // `setImmediate` rather than `setTimeout(0)`: it yields without
          // waiting for a timer phase, and timer granularity on Windows is
          // coarse enough to make the yielding cost more than the parse.
          pagesSinceYield += 1;
          if (pagesSinceYield >= PDF_PAGES_PER_YIELD) {
            pagesSinceYield = 0;
            await new Promise((resolve) => setImmediate(resolve));
            if (signal?.aborted) {
              throw new DocumentAdapterError("aborted", "The PDF read was cancelled.", path);
            }
          }
          if (blocks.length >= MAX_PDF_BLOCKS) {
            warnings.push({
              code: "block_limit",
              message: `Extraction stopped at ${MAX_PDF_BLOCKS} blocks.`,
            });
            break;
          }
          const page = await document.getPage(pageNumber);
          const content = await page.getTextContent();
          const lines = itemsToLines(content?.items ?? []);
          if (lines.length === 0) {
            pagesWithoutText += 1;
            warnings.push({
              code: "page_without_text",
              message: `Page ${pageNumber} has no extractable text.`,
              page: pageNumber,
            });
            continue;
          }
          pagesWithText += 1;
          blocks.push({ type: "page_break", locator: { page: pageNumber } });
          lines.forEach((line, lineIndex) => {
            if (blocks.length >= MAX_PDF_BLOCKS) return;
            blocks.push({
              type: "paragraph",
              text: line,
              locator: { page: pageNumber, block: lineIndex + 1 },
            });
          });
        }

        if (pagesWithText === 0) {
          // A scanned or image-only document. Reporting success with no
          // content would be a false claim (C6-17); no OCR is attempted.
          throw new DocumentAdapterError(
            "no_extractable_text",
            "The PDF contains no extractable text; it may be a scanned document.",
            path,
            { pages: pages.length },
          );
        }

        let info = {};
        try {
          info = (await document.getMetadata())?.info ?? {};
        } catch {
          info = {};
        }

        return {
          format: PDF_ADAPTER_ID,
          media_type: "application/pdf",
          blocks,
          warnings,
          partial: pagesWithoutText > 0,
          metadata: {
            pages: pageCount,
            pages_read: pages.length,
            pages_without_text: pagesWithoutText,
            ...(boundedMetadata(info.Title) ? { title: boundedMetadata(info.Title) } : {}),
            ...(boundedMetadata(info.Author) ? { author: boundedMetadata(info.Author) } : {}),
          },
          adapter: { id, version: 1 },
        };
      } finally {
        signal?.removeEventListener("abort", destroy);
        try {
          await document.destroy?.();
        } catch {
          // Teardown is best-effort.
        }
      }
    },
  };
}

export const DEFAULT_PDF_ADAPTER = createPdfAdapter();
