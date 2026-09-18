import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageBreak,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from "docx";
import { DocumentAdapterError } from "./document-contract.mjs";

/**
 * Strict, validated `.docx` generation.
 *
 * The model supplies a declarative document specification, never OOXML. Every
 * field is validated and bounded, unknown keys and unknown block types are
 * rejected rather than ignored, and the supported set is deliberately smaller
 * than what the reader understands. Nothing here can emit a part the writer
 * does not itself control.
 */

export const MAX_DOCUMENT_BLOCKS = 2_000;
export const MAX_BLOCK_TEXT_BYTES = 20_000;
export const MAX_LIST_ITEMS = 500;
export const MAX_TABLE_ROWS = 200;
export const MAX_TABLE_COLUMNS = 32;
export const MAX_CELL_BYTES = 2_000;
export const MAX_DOCUMENT_LINKS = 200;
export const MAX_DOCUMENT_TEXT_BYTES = 512 * 1024;
export const MAX_DOCUMENT_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_DOCUMENT_TITLE_BYTES = 512;

const SAFE_LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);
const BLOCK_TYPES = new Set([
  "heading",
  "paragraph",
  "list",
  "table",
  "page_break",
  "link",
]);

// A generated document uses one built-in ordered numbering definition.
const ORDERED_NUMBERING_REFERENCE = "aside-ordered";

function invalid(code, message, details) {
  return new DocumentAdapterError(code, message, undefined, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalid("invalid_document_spec", `The field "${field}.${key}" is not supported.`);
    }
  }
}

function boundedString(value, field, maxBytes, { required = true } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") {
    throw invalid("invalid_document_spec", `The field "${field}" must be text.`);
  }
  if (required && value.trim().length === 0) {
    throw invalid("invalid_document_spec", `The field "${field}" must not be empty.`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw invalid("invalid_document_spec", `The field "${field}" exceeds ${maxBytes} bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw invalid("invalid_document_spec", `The field "${field}" contains control characters.`);
  }
  return value;
}

/** Inline runs: the supported emphasis subset, validated and bounded. */
function normalizeRuns(input, field, budget) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 64) {
    throw invalid("invalid_document_spec", `The field "${field}" must be a non-empty run list.`);
  }
  let bytes = 0;
  const runs = input.map((run, index) => {
    if (!isPlainObject(run)) {
      throw invalid("invalid_document_spec", `The field "${field}[${index}]" is invalid.`);
    }
    assertKeys(run, new Set(["text", "bold", "italic"]), `${field}[${index}]`);
    const text = boundedString(run.text, `${field}[${index}].text`, MAX_BLOCK_TEXT_BYTES, {
      required: false,
    }) ?? "";
    for (const flag of ["bold", "italic"]) {
      if (run[flag] !== undefined && typeof run[flag] !== "boolean") {
        throw invalid("invalid_document_spec", `The field "${field}[${index}].${flag}" must be a boolean.`);
      }
    }
    bytes += Buffer.byteLength(text, "utf8");
    budget.bytes += Buffer.byteLength(text, "utf8");
    return { text, bold: run.bold === true, italic: run.italic === true };
  });
  if (bytes === 0) {
    throw invalid("invalid_document_spec", `The field "${field}" contains no text.`);
  }
  return runs;
}

/** A prose value may be plain text or an emphasis run list. */
function normalizeContent(input, field, budget) {
  if (typeof input === "string") {
    const text = boundedString(input, field, MAX_BLOCK_TEXT_BYTES);
    budget.bytes += Buffer.byteLength(text, "utf8");
    return { text, runs: undefined };
  }
  if (isPlainObject(input)) {
    assertKeys(input, new Set(["runs"]), field);
    return { text: undefined, runs: normalizeRuns(input.runs, `${field}.runs`, budget) };
  }
  throw invalid("invalid_document_spec", `The field "${field}" must be text or a run list.`);
}

function normalizeLinkHref(value, field) {
  const href = boundedString(value, field, 2_048);
  let url;
  try {
    url = new URL(href);
  } catch {
    throw invalid("invalid_document_spec", `The field "${field}" must be an absolute URL.`);
  }
  if (!SAFE_LINK_SCHEMES.has(url.protocol)) {
    throw invalid("invalid_document_spec", `The field "${field}" uses an unsupported URL scheme.`);
  }
  return href;
}

/**
 * Validates a document specification. Returns a normalized, frozen value whose
 * shape is exactly what `renderDocumentBytes` consumes.
 */
export function validateDocumentSpec(input, { budget = { bytes: 0 } } = {}) {
  if (!isPlainObject(input)) {
    throw invalid("invalid_document_spec", "The document specification is invalid.");
  }
  assertKeys(input, new Set(["title", "blocks"]), "document");

  const title = input.title === undefined
    ? undefined
    : boundedString(input.title, "document.title", MAX_DOCUMENT_TITLE_BYTES);

  if (!Array.isArray(input.blocks) || input.blocks.length === 0) {
    throw invalid("invalid_document_spec", "The document must contain at least one block.");
  }
  if (input.blocks.length > MAX_DOCUMENT_BLOCKS) {
    throw invalid("invalid_document_spec", `The document exceeds ${MAX_DOCUMENT_BLOCKS} blocks.`);
  }

  let linkCount = 0;
  const blocks = input.blocks.map((block, index) => {
    const field = `document.blocks[${index}]`;
    if (!isPlainObject(block)) throw invalid("invalid_document_spec", `The field "${field}" is invalid.`);
    if (!BLOCK_TYPES.has(block.type)) {
      throw invalid("invalid_document_spec", `The block type "${block.type}" is not supported.`);
    }

    switch (block.type) {
      case "heading": {
        assertKeys(block, new Set(["type", "level", "text"]), field);
        if (!Number.isSafeInteger(block.level) || block.level < 1 || block.level > 6) {
          throw invalid("invalid_document_spec", `The field "${field}.level" must be 1 through 6.`);
        }
        return { type: "heading", level: block.level, text: boundedString(block.text, `${field}.text`, MAX_BLOCK_TEXT_BYTES) };
      }
      case "paragraph": {
        assertKeys(block, new Set(["type", "text", "runs"]), field);
        if (block.runs !== undefined && block.text !== undefined) {
          throw invalid("invalid_document_spec", `The field "${field}" cannot set both text and runs.`);
        }
        const content = normalizeContent(
          block.runs === undefined ? block.text : { runs: block.runs },
          field,
          budget,
        );
        return { type: "paragraph", ...content };
      }
      case "list": {
        assertKeys(block, new Set(["type", "ordered", "items"]), field);
        if (block.ordered !== undefined && typeof block.ordered !== "boolean") {
          throw invalid("invalid_document_spec", `The field "${field}.ordered" must be a boolean.`);
        }
        if (!Array.isArray(block.items) || block.items.length === 0 || block.items.length > MAX_LIST_ITEMS) {
          throw invalid("invalid_document_spec", `The field "${field}.items" must hold 1 to ${MAX_LIST_ITEMS} items.`);
        }
        const items = block.items.map((item, itemIndex) =>
          normalizeContent(item, `${field}.items[${itemIndex}]`, budget),
        );
        return { type: "list", ordered: block.ordered === true, items };
      }
      case "table": {
        assertKeys(block, new Set(["type", "rows"]), field);
        if (!Array.isArray(block.rows) || block.rows.length === 0 || block.rows.length > MAX_TABLE_ROWS) {
          throw invalid("invalid_document_spec", `The field "${field}.rows" must hold 1 to ${MAX_TABLE_ROWS} rows.`);
        }
        const rows = block.rows.map((row, rowIndex) => {
          if (!Array.isArray(row) || row.length === 0 || row.length > MAX_TABLE_COLUMNS) {
            throw invalid("invalid_document_spec", `The field "${field}.rows[${rowIndex}]" must hold 1 to ${MAX_TABLE_COLUMNS} cells.`);
          }
          return row.map((cell, cellIndex) => {
            const value = boundedString(
              typeof cell === "string" ? cell : undefined,
              `${field}.rows[${rowIndex}][${cellIndex}]`,
              MAX_CELL_BYTES,
              { required: false },
            ) ?? "";
            budget.bytes += Buffer.byteLength(value, "utf8");
            return value;
          });
        });
        const width = rows[0].length;
        if (rows.some((row) => row.length !== width)) {
          throw invalid("invalid_document_spec", `The field "${field}.rows" must have a consistent column count.`);
        }
        return { type: "table", rows };
      }
      case "page_break":
        assertKeys(block, new Set(["type"]), field);
        return { type: "page_break" };
      default: {
        assertKeys(block, new Set(["type", "text", "href"]), field);
        linkCount += 1;
        if (linkCount > MAX_DOCUMENT_LINKS) {
          throw invalid("invalid_document_spec", `The document exceeds ${MAX_DOCUMENT_LINKS} links.`);
        }
        const text = boundedString(block.text, `${field}.text`, MAX_BLOCK_TEXT_BYTES);
        budget.bytes += Buffer.byteLength(text, "utf8");
        return { type: "link", text, href: normalizeLinkHref(block.href, `${field}.href`) };
      }
    }
  });

  if (budget.bytes > MAX_DOCUMENT_TEXT_BYTES) {
    throw invalid(
      "invalid_document_spec",
      `The document exceeds ${MAX_DOCUMENT_TEXT_BYTES} bytes of text.`,
      { bytes: budget.bytes, max_bytes: MAX_DOCUMENT_TEXT_BYTES },
    );
  }

  return Object.freeze({ title, blocks: Object.freeze(blocks) });
}

function textRuns(content) {
  if (content.runs) {
    return content.runs.map((run) => new TextRun({ text: run.text, bold: run.bold, italic: run.italic }));
  }
  return [new TextRun({ text: content.text })];
}

function blockToParagraphs(block) {
  switch (block.type) {
    case "heading":
      return [new Paragraph({
        text: block.text,
        heading: HeadingLevel[`HEADING_${block.level}`],
      })];
    case "paragraph":
      return [new Paragraph({ children: textRuns(block) })];
    case "list":
      return block.items.map((item) => new Paragraph({
        children: textRuns(item),
        ...(block.ordered
          ? { numbering: { reference: ORDERED_NUMBERING_REFERENCE, level: 0 } }
          : { bullet: { level: 0 } }),
      }));
    case "page_break":
      return [new Paragraph({ children: [new PageBreak()] })];
    default:
      return [new Paragraph({
        children: [new ExternalHyperlink({ link: block.href, children: [new TextRun(block.text)] })],
      })];
  }
}

function blockToTable(block) {
  return new Table({
    rows: block.rows.map((row) => new TableRow({
      children: row.map((cell) => new TableCell({
        children: [new Paragraph({ text: cell, alignment: AlignmentType.LEFT })],
      })),
    })),
  });
}

/** Renders a validated specification to `.docx` bytes. */
export async function renderDocumentBytes(specification) {
  const children = [];
  for (const block of specification.blocks) {
    if (block.type === "table") {
      children.push(blockToTable(block));
      continue;
    }
    children.push(...blockToParagraphs(block));
  }

  const document = new Document({
    ...(specification.title === undefined ? {} : { title: specification.title }),
    numbering: {
      config: [{
        reference: ORDERED_NUMBERING_REFERENCE,
        levels: [{
          level: 0,
          format: LevelFormat.DECIMAL,
          text: "%1.",
          alignment: AlignmentType.LEFT,
        }],
      }],
    },
    sections: [{ children }],
  });

  const buffer = await Packer.toBuffer(document);
  const bytes = Buffer.from(buffer);
  if (bytes.byteLength > MAX_DOCUMENT_OUTPUT_BYTES) {
    throw invalid(
      "document_too_large",
      `The generated document exceeds ${MAX_DOCUMENT_OUTPUT_BYTES} bytes.`,
      { bytes: bytes.byteLength, max_bytes: MAX_DOCUMENT_OUTPUT_BYTES },
    );
  }
  return bytes;
}

/** A bounded, human-readable structural summary for the permission preview. */
export function summarizeSpec(specification) {
  const counts = { heading: 0, paragraph: 0, list: 0, table: 0, page_break: 0, link: 0 };
  let listItems = 0;
  let tableRows = 0;
  for (const block of specification.blocks) {
    counts[block.type] += 1;
    if (block.type === "list") listItems += block.items.length;
    if (block.type === "table") tableRows += block.rows.length;
  }
  return Object.freeze({
    blocks: specification.blocks.length,
    headings: counts.heading,
    paragraphs: counts.paragraph,
    lists: counts.list,
    list_items: listItems,
    tables: counts.table,
    table_rows: tableRows,
    page_breaks: counts.page_break,
    links: counts.link,
    ...(specification.title === undefined ? {} : { title: specification.title }),
  });
}
