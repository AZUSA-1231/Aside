import { strFromU8, unzipSync } from "fflate";
import { DOMParser } from "@xmldom/xmldom";
import { DocumentAdapterError } from "./document-contract.mjs";

/**
 * Hardened access to an OOXML package. A `.docx` is a ZIP of XML parts, so
 * every hazard a ZIP can carry is reachable from a document the user merely
 * asked Aside to read: decompression bombs, path traversal in entry names, and
 * hostile XML. This module is the only place those are handled.
 */

export const MAX_PACKAGE_ENTRIES = 512;
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const MAX_COMPRESSION_RATIO = 200;
export const MAX_XML_BYTES = 16 * 1024 * 1024;

// An OLE/CFB container: a legacy `.doc`, or an encrypted OOXML package, which
// is a CFB wrapper rather than a ZIP.
const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_SIGNATURE = [0x50, 0x4b];

function startsWith(bytes, signature) {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

export function packageKind(bytes) {
  if (startsWith(bytes, ZIP_SIGNATURE)) return "zip";
  if (startsWith(bytes, CFB_SIGNATURE)) return "cfb";
  return "unknown";
}

/**
 * Entry names are used as lookup keys only, never as filesystem paths, but a
 * traversing or absolute name is still refused rather than carried around.
 */
function assertSafeEntryName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 512) {
    throw new DocumentAdapterError("invalid_document", "The package has an invalid entry name.");
  }
  if (name.includes("\0")) {
    throw new DocumentAdapterError("invalid_document", "The package has an invalid entry name.");
  }
  const normalized = name.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new DocumentAdapterError(
      "invalid_document",
      "The package contains an entry outside its own tree.",
    );
  }
}

/**
 * Reads the package with every bound enforced *before* an entry is inflated:
 * fflate's filter sees the declared uncompressed size, so a bomb is refused
 * rather than decompressed and then measured.
 */
export function readPackage(bytes, { limits = {} } = {}) {
  const maxEntries = limits.maxPackageEntries ?? MAX_PACKAGE_ENTRIES;
  const maxEntryBytes = limits.maxEntryBytes ?? MAX_ENTRY_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const maxRatio = limits.maxCompressionRatio ?? MAX_COMPRESSION_RATIO;

  const rejected = [];
  let acceptedEntries = 0;
  let acceptedBytes = 0;

  let entries;
  try {
    entries = unzipSync(bytes, {
      filter(info) {
        try {
          assertSafeEntryName(info.name);
        } catch {
          rejected.push({ name: info.name, code: "unsafe_entry_name" });
          return false;
        }
        // Directory markers carry no content and are not needed.
        if (info.name.endsWith("/")) return false;
        if (info.originalSize > maxEntryBytes) {
          rejected.push({ name: info.name, code: "entry_too_large" });
          return false;
        }
        if (info.size > 0 && info.originalSize / info.size > maxRatio) {
          rejected.push({ name: info.name, code: "compression_ratio" });
          return false;
        }
        acceptedEntries += 1;
        acceptedBytes += info.originalSize;
        if (acceptedEntries > maxEntries) {
          rejected.push({ name: info.name, code: "too_many_entries" });
          return false;
        }
        if (acceptedBytes > maxTotalBytes) {
          rejected.push({ name: info.name, code: "package_too_large" });
          return false;
        }
        return true;
      },
    });
  } catch (error) {
    throw new DocumentAdapterError(
      "invalid_document",
      "The document package could not be opened.",
      undefined,
      { cause: String(error?.message ?? error).slice(0, 120) },
    );
  }

  return {
    entries,
    rejected,
    has(name) {
      return Object.hasOwn(entries, name);
    },
    text(name) {
      const entry = entries[name];
      return entry === undefined ? undefined : strFromU8(entry);
    },
  };
}

/**
 * Parses one XML part. External entities and DTD entity definitions are not
 * resolved by the parser, but a document type declaration is refused outright
 * so nothing downstream has to reason about one.
 */
export function parseXmlPart(text, name, { maxBytes = MAX_XML_BYTES } = {}) {
  if (typeof text !== "string" || text.length === 0) {
    throw new DocumentAdapterError("invalid_document", `The package part "${name}" is empty.`);
  }
  if (text.length > maxBytes) {
    throw new DocumentAdapterError(
      "document_too_complex",
      `The package part "${name}" exceeds the XML limit.`,
      undefined,
      { bytes: text.length, max_bytes: maxBytes },
    );
  }
  if (/<!DOCTYPE/i.test(text)) {
    throw new DocumentAdapterError(
      "invalid_document",
      `The package part "${name}" declares a document type, which is not accepted.`,
    );
  }
  let document;
  try {
    document = new DOMParser({
      // Keep the parser quiet: malformed markup is reported through the return
      // value below rather than by writing to the process streams.
      onError: () => undefined,
      onWarning: () => undefined,
    }).parseFromString(text, "text/xml");
  } catch (error) {
    throw new DocumentAdapterError(
      "invalid_document",
      `The package part "${name}" is not valid XML.`,
    );
  }
  const root = document?.documentElement;
  if (!root || root.nodeName === "parsererror") {
    throw new DocumentAdapterError(
      "invalid_document",
      `The package part "${name}" is not valid XML.`,
    );
  }
  return document;
}

/** Relationship targets, resolved without ever fetching anything. */
export function readRelationships(pkg, partName) {
  const text = pkg.text(partName);
  if (text === undefined) return new Map();
  const document = parseXmlPart(text, partName);
  const relationships = new Map();
  const nodes = document.getElementsByTagName("Relationship");
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const id = node.getAttribute("Id");
    if (!id) continue;
    relationships.set(id, {
      id,
      type: node.getAttribute("Type") ?? "",
      target: node.getAttribute("Target") ?? "",
      external: (node.getAttribute("TargetMode") ?? "").toLowerCase() === "external",
    });
  }
  return relationships;
}

/** The subset of relationship types that matters for fidelity reporting. */
export function externalRelationshipCount(relationships) {
  let count = 0;
  for (const relationship of relationships.values()) {
    if (relationship.external) count += 1;
  }
  return count;
}
