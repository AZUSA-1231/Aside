import { Buffer } from "node:buffer";

/**
 * Synthetic PDF fixtures, generated rather than committed. Every byte here is
 * authored by this repository, so no third-party binary enters source control
 * and every fixture is reproducible from its inputs.
 */

function escapeText(value) {
  return String(value).replace(/[\\()]/g, (character) => `\\${character}`);
}

/**
 * Builds a minimal, structurally valid PDF. `pages` is an array of pages, each
 * an array of text lines drawn at a fixed leading.
 */
export function buildPdf(pages, { version = "1.4", catalogExtra = "" } = {}) {
  const chunks = [];
  const offsets = [];
  let position = 0;
  const push = (text) => {
    const buffer = Buffer.from(text, "latin1");
    chunks.push(buffer);
    position += buffer.length;
  };
  const object = (id, body) => {
    offsets[id] = position;
    push(`${id} 0 obj\n${body}\nendobj\n`);
  };

  push(`%PDF-${version}\n`);

  const pageIds = pages.map((_, index) => 3 + index * 2);
  const fontId = 3 + pages.length * 2;
  object(1, `<< /Type /Catalog /Pages 2 0 R ${catalogExtra}>>`);
  object(
    2,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  );

  pages.forEach((lines, index) => {
    const pageId = pageIds[index];
    const contentId = pageId + 1;
    object(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R `
        + `/Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
    );
    const stream = [
      "BT /F1 24 Tf 72 700 Td 18 TL",
      ...lines.map(
        (line, lineIndex) =>
          `${lineIndex === 0 ? "" : "T* "}(${escapeText(line)}) Tj`,
      ),
      "ET",
    ].join("\n");
    object(
      contentId,
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    );
  });

  object(fontId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  const count = fontId + 1;
  const xrefStart = position;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id += 1) {
    xref += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  push(xref);
  push(
    `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );
  return Buffer.concat(chunks);
}

/** A page with no text operators at all, like a scanned image page. */
export function buildTextlessPdf(pageCount = 2) {
  const chunks = [];
  const offsets = [];
  let position = 0;
  const push = (text) => {
    const buffer = Buffer.from(text, "latin1");
    chunks.push(buffer);
    position += buffer.length;
  };
  const object = (id, body) => {
    offsets[id] = position;
    push(`${id} 0 obj\n${body}\nendobj\n`);
  };

  push("%PDF-1.4\n");
  const pageIds = Array.from({ length: pageCount }, (_, index) => 3 + index * 2);
  const fontId = 3 + pageCount * 2;
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(
    2,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`,
  );
  pageIds.forEach((pageId) => {
    const contentId = pageId + 1;
    object(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R `
        + `/Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
    );
    // An empty content stream: the page exists but carries no extractable text.
    object(contentId, "<< /Length 0 >>\nstream\n\nendstream");
  });
  object(fontId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  const count = fontId + 1;
  const xrefStart = position;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id += 1) {
    xref += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

/** Well-formed enough to look like a PDF, structurally broken on parse. */
export function buildCorruptPdf() {
  const valid = buildPdf([["seed"]]);
  const corrupt = Buffer.from(valid);
  // Destroy the xref and the object bodies while keeping the header.
  corrupt.fill(0x20, 20, Math.min(corrupt.length, 400));
  return corrupt;
}

/** Bytes that are simply not a PDF at all. */
export function buildNonPdfBytes() {
  return Buffer.from("This is a plain text file, not a PDF.\n", "utf8");
}

/** A document far larger than any sane read budget, for limit tests. */
export function buildLargePdf(pageCount) {
  return buildPdf(
    Array.from({ length: pageCount }, (_, index) => [
      `Page ${index + 1} heading`,
      `Page ${index + 1} body line`,
    ]),
  );
}
