import { Buffer } from "node:buffer";
import { strToU8, zipSync } from "fflate";

/**
 * Synthetic `.docx` fixtures, generated rather than committed. Every part here
 * is authored by this repository, so no third-party binary enters source
 * control and each fixture is reproducible from its inputs.
 */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function runXml(text) {
  return `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function paragraphXml(text, { style, numbered } = {}) {
  const properties = [];
  if (style) properties.push(`<w:pStyle w:val="${escapeXml(style)}"/>`);
  if (numbered) properties.push('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');
  const pPr = properties.length > 0 ? `<w:pPr>${properties.join("")}</w:pPr>` : "";
  return `<w:p>${pPr}${runXml(text)}</w:p>`;
}

function tableXml(rows) {
  const body = rows
    .map((cells) => `<w:tr>${cells.map((cell) => `<w:tc>${paragraphXml(cell)}</w:tc>`).join("")}</w:tr>`)
    .join("");
  return `<w:tbl>${body}</w:tbl>`;
}

function hyperlinkXml(id, text) {
  return `<w:p><w:hyperlink r:id="${escapeXml(id)}">${runXml(text)}</w:hyperlink></w:p>`;
}

function pageBreakXml() {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

/**
 * `blocks` entries:
 *   { type: "heading", text, level }
 *   { type: "paragraph", text }
 *   { type: "list", text }
 *   { type: "table", rows: [[cell, ...], ...] }
 *   { type: "pageBreak" }
 *   { type: "link", id, text }
 *   { type: "raw", xml }
 */
export function buildDocumentXml(blocks) {
  const body = blocks
    .map((block) => {
      switch (block.type) {
        case "heading":
          return paragraphXml(block.text, { style: `Heading${block.level ?? 1}` });
        case "list":
          return paragraphXml(block.text, { numbered: true });
        case "table":
          return tableXml(block.rows);
        case "pageBreak":
          return pageBreakXml();
        case "link":
          return hyperlinkXml(block.id, block.text);
        case "raw":
          return block.xml;
        default:
          return paragraphXml(block.text);
      }
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${body}<w:sectPr/></w:body></w:document>`;
}

export function buildDocumentRels(relationships = []) {
  const body = relationships
    .map(
      (relationship) =>
        `<Relationship Id="${escapeXml(relationship.id)}" Type="${escapeXml(relationship.type)}" `
        + `Target="${escapeXml(relationship.target)}"`
        + `${relationship.external ? ' TargetMode="External"' : ""}/>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
}

/** Builds a `.docx` package. `extraParts` are added verbatim. */
export function buildDocx(blocks = [], { relationships = [], extraParts = {}, level = 6 } = {}) {
  const parts = {
    "[Content_Types].xml": strToU8(CONTENT_TYPES),
    "_rels/.rels": strToU8(ROOT_RELS),
    "word/document.xml": strToU8(buildDocumentXml(blocks)),
    "word/_rels/document.xml.rels": strToU8(buildDocumentRels(relationships)),
  };
  for (const [name, value] of Object.entries(extraParts)) {
    parts[name] = typeof value === "string" ? strToU8(value) : value;
  }
  return Buffer.from(zipSync(parts, { level }));
}

/** A macro-enabled package: the marker part is what makes it `.docm` content. */
export function buildMacroDocx() {
  return buildDocx([{ type: "paragraph", text: "macro body" }], {
    extraParts: { "word/vbaProject.bin": new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]) },
  });
}

/** An OLE/CFB container: a legacy `.doc`, or an encrypted OOXML package. */
export function buildCfbBytes() {
  const bytes = new Uint8Array(512);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  return Buffer.from(bytes);
}

/** A ZIP that is not a Word package. */
export function buildNonWordZip() {
  return Buffer.from(zipSync({ "readme.txt": strToU8("not a word document") }));
}

/** A package whose main part is not well-formed XML. */
export function buildMalformedDocx() {
  return buildDocx([], {
    extraParts: { "word/document.xml": strToU8("<w:document><w:body><w:p>") },
  });
}

/** An entry name that escapes the package tree. */
export function buildTraversalDocx() {
  return buildDocx([{ type: "paragraph", text: "ok" }], {
    extraParts: { "../escape.txt": strToU8("escaped") },
  });
}

/**
 * A decompression bomb: one small entry that inflates far past the entry
 * limit. Highly compressible, so the compressed size stays tiny.
 */
export function buildBombDocx(uncompressedBytes = 64 * 1024 * 1024) {
  const payload = new Uint8Array(uncompressedBytes);
  payload.fill(0x41);
  return buildDocx([{ type: "paragraph", text: "bomb" }], {
    extraParts: { "word/bomb.xml": payload },
  });
}

/** Tracked changes, comments, and drawings: fidelity warnings, not failures. */
export function buildFidelityDocx() {
  return buildDocx(
    [
      { type: "paragraph", text: "kept text" },
      { type: "raw", xml: '<w:p><w:ins w:id="1"><w:r><w:t>inserted</w:t></w:r></w:ins></w:p>' },
      { type: "raw", xml: '<w:p><w:del w:id="2"><w:r><w:delText>removed</w:delText></w:r></w:del></w:p>' },
      { type: "raw", xml: "<w:p><w:r><w:drawing/></w:r></w:p>" },
      { type: "raw", xml: '<w:p><w:r><w:fldSimple w:instr="PAGE"/></w:r></w:p>' },
    ],
    {
      relationships: [
        {
          id: "rId9",
          type: `${R_NS}/hyperlink`,
          target: "https://example.com/report",
          external: true,
        },
        {
          id: "rId10",
          type: `${R_NS}/hyperlink`,
          target: "file:///C:/Windows/win.ini",
          external: true,
        },
      ],
      extraParts: {
        // A real comment element, not an empty part: producers routinely emit
        // an empty `comments.xml`, so an adapter must key on content.
        "word/comments.xml": strToU8(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="${W_NS}"><w:comment w:id="1" w:author="Reviewer">`
            + '<w:p><w:r><w:t>a note</w:t></w:r></w:p></w:comment></w:comments>',
        ),
        "word/header1.xml": strToU8(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="${W_NS}"><w:p><w:r><w:t>Header text</w:t></w:r></w:p></w:hdr>`,
        ),
      },
    },
  );
}

/** A document using every supported block type, for the happy path. */
export function buildStructuredDocx() {
  return buildDocx(
    [
      { type: "heading", text: "Quarterly report", level: 1 },
      { type: "paragraph", text: "Revenue increased." },
      { type: "heading", text: "Details", level: 2 },
      { type: "list", text: "first point" },
      { type: "list", text: "second point" },
      { type: "table", rows: [["Region", "Revenue"], ["North", "120"]] },
      { type: "pageBreak" },
      { type: "heading", text: "Appendix", level: 1 },
      { type: "paragraph", text: "Unicode: café — naïve — 日本語" },
      { type: "link", id: "rId7", text: "source" },
    ],
    {
      relationships: [
        {
          id: "rId7",
          type: `${R_NS}/hyperlink`,
          target: "https://example.com/source",
          external: true,
        },
      ],
      extraParts: {
        "docProps/core.xml": strToU8(
          '<?xml version="1.0"?><cp:coreProperties '
            + 'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            + 'xmlns:dc="http://purl.org/dc/elements/1.1/">'
            + "<dc:title>Quarterly report</dc:title><dc:creator>Aside</dc:creator>"
            + "</cp:coreProperties>",
        ),
      },
    },
  );
}
