import { DocumentAdapterError } from "./document-contract.mjs";
import {
  externalRelationshipCount,
  packageKind,
  parseXmlPart,
  readPackage,
  readRelationships,
} from "./docx-package.mjs";

/**
 * A local, in-process, read-only `.docx` adapter.
 *
 * The contract is useful structural fidelity, not Word round-trip parity.
 * Unsupported constructs are reported as bounded warnings, never silently
 * dropped, and nothing here opens Office, launches a converter, or fetches a
 * linked resource.
 */

export const DOCX_ADAPTER_ID = "docx";
export const MAX_DOCX_BLOCKS = 5_000;
export const MAX_DOCX_TABLE_ROWS = 500;
export const MAX_DOCX_TABLE_COLUMNS = 64;
export const MAX_DOCX_CELL_BYTES = 4_096;
export const MAX_DOCX_WARNINGS = 32;

export const MAX_DOCX_READ_BYTES = 64 * 1024 * 1024;
const MAX_DOCX_EXPANDED_BYTES = 8 * 1024 * 1024;

// Elements that mean content exists which this adapter does not represent.
// Detecting them is best-effort by design; the warning says so.
const FIDELITY_MARKERS = Object.freeze([
  { tag: "w:ins", code: "tracked_changes", message: "The document contains tracked insertions." },
  { tag: "w:del", code: "tracked_changes", message: "The document contains tracked deletions." },
  { tag: "w:drawing", code: "drawings", message: "The document contains drawings or images." },
  { tag: "w:pict", code: "drawings", message: "The document contains embedded pictures." },
  { tag: "w:object", code: "embedded_objects", message: "The document contains embedded objects." },
  { tag: "w:fldSimple", code: "fields", message: "The document contains field codes." },
  { tag: "w:instrText", code: "fields", message: "The document contains field instructions." },
  { tag: "w:sdt", code: "content_controls", message: "The document contains content controls." },
  { tag: "w:footnoteReference", code: "footnotes", message: "The document contains footnotes." },
  { tag: "w:endnoteReference", code: "endnotes", message: "The document contains endnotes." },
  { tag: "w:commentReference", code: "comments", message: "The document contains comments." },
]);

const HEADING_STYLE = /^heading([1-9])$/i;
const SAFE_LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

function localName(node) {
  return typeof node?.localName === "string" && node.localName.length > 0
    ? node.localName
    : node?.nodeName ?? "";
}

/**
 * Attribute lookup by local name. OOXML attributes are namespaced (`w:val`,
 * `r:id`) and the prefix is not guaranteed, so matching on the qualified name
 * alone silently reads nothing.
 */
function attribute(node, name) {
  const attributes = node?.attributes;
  if (!attributes) return undefined;
  for (let index = 0; index < attributes.length; index += 1) {
    const candidate = attributes[index];
    if (candidate.localName === name || candidate.nodeName === name) {
      return candidate.value;
    }
  }
  return undefined;
}

function elementChildren(node) {
  const children = [];
  for (let child = node?.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) children.push(child);
  }
  return children;
}

function childrenNamed(node, name) {
  return elementChildren(node).filter((child) => localName(child) === name);
}

function firstChildNamed(node, name) {
  return childrenNamed(node, name)[0];
}

/** Paragraph text, keeping tabs and breaks but ignoring field instructions. */
function paragraphText(paragraph) {
  let text = "";
  const walk = (node) => {
    for (const child of elementChildren(node)) {
      const name = localName(child);
      if (name === "t") {
        text += child.textContent ?? "";
      } else if (name === "tab") {
        text += "\t";
      } else if (name === "br") {
        // ST_BrType defaults to `textWrapping`, so a bare <w:br/> is a line
        // break and is preserved rather than flattened to a space. Only an
        // explicit page break becomes the page separator.
        const breakType = attribute(child, "type");
        if (breakType === "page") text += "\f";
        else if (breakType === "column") text += "\f";
        else text += "\n";
      } else if (name === "instrText") {
        // A field instruction is not document text.
      } else {
        walk(child);
      }
    }
  };
  walk(paragraph);
  return text.replace(/[ \t]+$/g, "");
}

function paragraphStyleId(paragraph) {
  const properties = firstChildNamed(paragraph, "pPr");
  const style = properties && firstChildNamed(properties, "pStyle");
  return attribute(style, "val") ?? undefined;
}

function isListItem(paragraph) {
  const properties = firstChildNamed(paragraph, "pPr");
  return Boolean(properties && firstChildNamed(properties, "numPr"));
}

function hasPageBreak(paragraph) {
  for (const run of childrenNamed(paragraph, "r")) {
    for (const br of childrenNamed(run, "br")) {
      if (attribute(br, "type") === "page") return true;
    }
  }
  return false;
}

function linkTarget(relationship) {
  if (!relationship || relationship.external !== true) return undefined;
  try {
    const url = new URL(relationship.target);
    return SAFE_LINK_SCHEMES.has(url.protocol) ? relationship.target : undefined;
  } catch {
    return undefined;
  }
}

function tableBlock(table, locator) {
  const rows = childrenNamed(table, "tr");
  const bounded = rows.slice(0, MAX_DOCX_TABLE_ROWS);
  const values = bounded.map((row) => {
    const cells = childrenNamed(row, "tc").slice(0, MAX_DOCX_TABLE_COLUMNS);
    return cells.map((cell) => {
      const text = childrenNamed(cell, "p").map(paragraphText).join("\n").trim();
      return text.length > MAX_DOCX_CELL_BYTES ? text.slice(0, MAX_DOCX_CELL_BYTES) : text;
    });
  });
  return {
    block: {
      type: "table",
      rows: values,
      locator,
      ...(rows.length > bounded.length ? { truncated: true } : {}),
    },
    truncated: rows.length > bounded.length,
  };
}

/** Counts matching elements in a package part, tolerating a missing part. */
function countElements(pkg, partName, elementName) {
  const text = pkg.text(partName);
  if (text === undefined) return 0;
  try {
    return parseXmlPart(text, partName).getElementsByTagName(elementName).length;
  } catch {
    return 0;
  }
}

/** True when a part holds something a reader would notice was dropped. */
function partHasVisibleContent(pkg, partName) {
  const text = pkg.text(partName);
  if (text === undefined) return false;
  const withoutTags = text.replace(/<[^>]*>/g, "").replace(/&[a-z]+;/gi, " ").trim();
  return withoutTags.length > 0;
}

function collectWarnings(document, pkg, relationships) {
  const warnings = [];
  const push = (code, message) => {
    if (warnings.length >= MAX_DOCX_WARNINGS) return;
    if (warnings.some((warning) => warning.code === code)) return;
    warnings.push({ code, message });
  };

  for (const marker of FIDELITY_MARKERS) {
    if (document.getElementsByTagName(marker.tag).length > 0) {
      push(marker.code, marker.message);
    }
  }
  const external = externalRelationshipCount(relationships);
  if (external > 0) {
    push(
      "external_relationships",
      `The document declares ${external} external relationship(s); none were followed.`,
    );
  }
  // Part *presence* is not content. Word and the generator both emit empty
  // `comments.xml` and `footnotes.xml`, and the footnote part always carries
  // two boilerplate separator entries, so each part is checked for content.
  if (countElements(pkg, "word/comments.xml", "w:comment") > 0) {
    push("comments", "The document contains comments.");
  }
  for (const [name, code, message] of [
    ["word/header1.xml", "headers_footers", "The document has headers, which are not extracted."],
    ["word/footer1.xml", "headers_footers", "The document has footers, which are not extracted."],
    ["word/vbaProject.bin", "macros", "The document contains macros."],
  ]) {
    if (name.endsWith(".bin")) {
      if (pkg.has(name)) push(code, message);
    } else if (partHasVisibleContent(pkg, name)) {
      push(code, message);
    }
  }
  for (const rejected of pkg.rejected) {
    push(`entry_rejected:${rejected.code}`, `A package entry was refused (${rejected.code}).`);
  }
  return warnings;
}

function buildBlocks(document, relationships, warnings) {
  const body = document.getElementsByTagName("w:body")[0]
    ?? document.documentElement;
  const blocks = [];
  let paragraphIndex = 0;
  let tableIndex = 0;
  let headingIndex = 0;
  let listIndex = 0;
  let truncated = false;

  const visit = (node) => {
    for (const child of elementChildren(node)) {
      if (blocks.length >= MAX_DOCX_BLOCKS) {
        truncated = true;
        return;
      }
      const name = localName(child);
      if (name === "p") {
        if (hasPageBreak(child)) {
          blocks.push({ type: "page_break", locator: { paragraph: paragraphIndex } });
        }
        const text = paragraphText(child);
        const styleId = paragraphStyleId(child);
        const heading = styleId && HEADING_STYLE.exec(styleId);
        if (heading) {
          headingIndex += 1;
          blocks.push({
            type: "heading",
            level: Number(heading[1]),
            text,
            locator: { paragraph: paragraphIndex, heading: headingIndex },
          });
        } else if (isListItem(child)) {
          listIndex += 1;
          blocks.push({
            type: "list_item",
            text,
            locator: { paragraph: paragraphIndex, list_item: listIndex },
          });
        } else if (text.trim().length > 0) {
          blocks.push({ type: "paragraph", text, locator: { paragraph: paragraphIndex } });
        }
        paragraphIndex += 1;
        continue;
      }
      if (name === "tbl") {
        tableIndex += 1;
        const { block, truncated: tableTruncated } = tableBlock(child, { table: tableIndex });
        blocks.push(block);
        if (tableTruncated) truncated = true;
        continue;
      }
      if (name === "sectPr") continue;
      if (elementChildren(child).length > 0) visit(child);
    }
  };
  visit(body);

  // Links are reported separately rather than injected into paragraph text, so
  // a paragraph's text stays exactly what the document says.
  const links = [];
  const hyperlinks = document.getElementsByTagName("w:hyperlink");
  for (let index = 0; index < hyperlinks.length; index += 1) {
    const node = hyperlinks[index];
    const id = attribute(node, "id");
    const target = linkTarget(id ? relationships.get(id) : undefined);
    if (target) links.push({ target, text: paragraphText(node).trim() });
  }

  return { blocks, links, truncated, tableCount: tableIndex };
}

export function createDocxAdapter({ id = DOCX_ADAPTER_ID } = {}) {
  return {
    id,
    formats: Object.freeze([DOCX_ADAPTER_ID]),
    extensions: Object.freeze([".docx"]),
    textual: true,
    // Read-only. Cycle 6 defers same-path replacement and overwrite, and
    // generation is a separate first-party tool (C6-I009). `generatable` says
    // the product can *produce* this format, which is not the same claim as
    // this adapter being able to write it.
    write: false,
    generatable: true,
    maxReadBytes: MAX_DOCX_READ_BYTES,
    maxExpandedBytes: MAX_DOCX_EXPANDED_BYTES,
    async read({ bytes, path, signal }) {
      if (signal?.aborted) {
        throw new DocumentAdapterError("aborted", "The document read was cancelled.", path);
      }
      const kind = packageKind(bytes);
      if (kind === "cfb") {
        // A legacy `.doc`, or an encrypted OOXML package, which is a CFB
        // wrapper rather than a ZIP. Neither is readable without a converter.
        throw new DocumentAdapterError(
          "unsupported_format",
          "The file is a legacy or encrypted Word document, which is not supported.",
          path,
          { container: "cfb" },
        );
      }
      if (kind !== "zip") {
        throw new DocumentAdapterError(
          "invalid_document",
          "The file is not a Word document package.",
          path,
        );
      }

      const pkg = readPackage(bytes);
      const contentTypes = pkg.text("[Content_Types].xml");
      if (contentTypes === undefined) {
        throw new DocumentAdapterError(
          "invalid_document",
          "The package is missing its content types part.",
          path,
        );
      }
      if (pkg.has("word/vbaProject.bin")) {
        // Macro-enabled content is refused rather than read with a warning.
        throw new DocumentAdapterError(
          "unsupported_format",
          "The document is macro-enabled, which is not supported.",
          path,
        );
      }
      const mainPart = pkg.text("word/document.xml");
      if (mainPart === undefined) {
        throw new DocumentAdapterError(
          "invalid_document",
          "The package has no main document part.",
          path,
        );
      }

      const document = parseXmlPart(mainPart, "word/document.xml");
      const relationships = readRelationships(pkg, "word/_rels/document.xml.rels");
      const warnings = collectWarnings(document, pkg, relationships);
      const { blocks, links, truncated, tableCount } = buildBlocks(
        document,
        relationships,
        warnings,
      );
      if (signal?.aborted) {
        throw new DocumentAdapterError("aborted", "The document read was cancelled.", path);
      }

      const properties = pkg.text("docProps/core.xml");
      let title;
      let author;
      if (properties !== undefined) {
        try {
          const core = parseXmlPart(properties, "docProps/core.xml");
          title = core.getElementsByTagName("dc:title")[0]?.textContent?.trim() || undefined;
          author = core.getElementsByTagName("dc:creator")[0]?.textContent?.trim() || undefined;
        } catch {
          warnings.push({
            code: "metadata_unreadable",
            message: "The document properties could not be read.",
          });
        }
      }

      return {
        format: DOCX_ADAPTER_ID,
        media_type:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        blocks,
        links: links.slice(0, 64),
        warnings,
        partial: truncated || warnings.length > 0,
        metadata: {
          ...(title ? { title: title.slice(0, 512) } : {}),
          ...(author ? { author: author.slice(0, 512) } : {}),
          paragraphs: blocks.filter((block) => block.type !== "table").length,
          tables: tableCount,
          links: links.length,
        },
        adapter: { id, version: 1 },
      };
    },
  };
}

export const DEFAULT_DOCX_ADAPTER = createDocxAdapter();
