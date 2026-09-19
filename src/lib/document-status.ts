import type {
  RuntimeDocumentReadStatus,
  RuntimeDocumentWarning,
  RuntimeDocumentWriteStatus,
  RuntimeToolResultDetails,
} from "./contracts";

/**
 * Narrowing and projection for document tool results.
 *
 * A tool result's `details` arrive as an open record — the runtime bounds and
 * redacts them but cannot know each tool's shape. Everything here treats them
 * as untrusted input and narrows defensively: a field is used only if it is the
 * type it claims to be, and an unrecognized shape produces `null` rather than a
 * half-filled projection.
 *
 * These are pure functions on purpose. The repository has no frontend test
 * runner (C6-I031), so the honest thing is to keep the projection logic in a
 * module that can be tested mechanically once one exists, rather than buried in
 * a component where it cannot be reached.
 */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Document warnings, each one requiring a usable `code` and `message`.
 *
 * A warning without both is dropped rather than rendered as an empty row: a
 * warning the user cannot read is worse than no row, because it implies there
 * was nothing to say.
 */
export function narrowWarnings(value: unknown): RuntimeDocumentWarning[] {
  if (!Array.isArray(value)) return [];
  const warnings: RuntimeDocumentWarning[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const code = asString(record.code);
    const message = asString(record.message);
    if (!code || !message) continue;
    const page = asNumber(record.page);
    warnings.push(page === undefined ? { code, message } : { code, message, page });
  }
  return warnings;
}

/**
 * Fidelity warning codes reported by the write tools.
 *
 * These arrive as bare codes, not as `{code, message}` objects — the reader
 * produced the messages during its own pass and the write tool does not repeat
 * them. Narrowing them as objects would silently drop every one, which is the
 * failure mode this function exists to avoid.
 */
export function narrowWarningCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/**
 * Projects a structured read of a PDF or Word document.
 *
 * Returns `null` when the result is not a structured document read, which is
 * the ordinary case for text and JSON files. The surface then renders the
 * generic tool result instead of an empty document panel.
 */
export function readDocumentStatus(
  details: RuntimeToolResultDetails | undefined,
): RuntimeDocumentReadStatus | null {
  const record = asRecord(details);
  if (!record) return null;
  const format = asString(record.format);
  // `block_count` is what a structured adapter reports and a plain text read
  // does not, so it is the discriminator between "document" and "text".
  const blockCount = asNumber(record.block_count);
  if (!format || blockCount === undefined) return null;

  const pageCount = asNumber(record.page_count);
  const pagesRead = asNumber(record.pages_read);
  const nextPage = asNumber(record.next_page);

  return {
    format,
    blockCount,
    pageCount,
    pagesRead,
    nextPage,
    partial: record.partial === true,
    truncated: record.truncated === true,
    warnings: narrowWarnings(record.warnings),
    scope: describeReadScope({ pageCount, pagesRead, blockCount, nextPage }),
  };
}

/**
 * The human-readable extent of a read.
 *
 * Built from what the adapter actually reported. A document with no page count
 * says "N blocks" rather than inventing a page range, and a read that continues
 * says where it continues from — an incomplete extraction must never read as a
 * complete one.
 */
export function describeReadScope({
  pageCount,
  pagesRead,
  blockCount,
  nextPage,
}: {
  pageCount?: number;
  pagesRead?: number;
  blockCount: number;
  nextPage?: number;
}): string {
  if (pageCount !== undefined && pagesRead !== undefined) {
    const base = `${pagesRead} of ${pageCount} page${pageCount === 1 ? "" : "s"}`;
    return nextPage === undefined ? base : `${base}, continues at page ${nextPage}`;
  }
  if (pageCount !== undefined) {
    return `${blockCount} block${blockCount === 1 ? "" : "s"} across ${pageCount} page${pageCount === 1 ? "" : "s"}`;
  }
  return `${blockCount} block${blockCount === 1 ? "" : "s"}`;
}

/**
 * Projects a generated or transformed document.
 *
 * `verification` is the runtime's reopen check, not ours. When it is absent the
 * surface says nothing about verification rather than implying it passed: a
 * write that was not reopened is not a verified one.
 */
export function writeDocumentStatus(
  details: RuntimeToolResultDetails | undefined,
): RuntimeDocumentWriteStatus | null {
  const record = asRecord(details);
  if (!record) return null;
  const outputPath = asString(record.output_path);
  if (!outputPath) return null;
  const operation = asString(record.operation);

  const verificationRecord = asRecord(record.verification);
  const verificationStatus = verificationRecord ? asString(verificationRecord.status) : undefined;

  return {
    operation: operation === "transform" ? "transform" : "create",
    outputPath,
    bytes: asNumber(record.bytes),
    structure: narrowStructure(record.structure),
    sourcePath: asString(record.source_path),
    sourceWarnings: narrowWarningCodes(record.source_fidelity_warnings),
    verification: verificationStatus ? verificationStatus : undefined,
  };
}

function narrowStructure(value: unknown): Record<string, number> {
  const record = asRecord(value);
  if (!record) return {};
  const structure: Record<string, number> = {};
  for (const [key, entry] of Object.entries(record)) {
    const count = asNumber(entry);
    if (count !== undefined) structure[key] = count;
  }
  return structure;
}

/**
 * The structure summary as one line, omitting categories that are zero.
 *
 * A generated document usually contains none of several categories, and listing
 * "0 tables, 0 page breaks" tells the user nothing while making the real shape
 * harder to see.
 */
export function describeStructure(structure: Record<string, number>): string {
  const parts = Object.entries(structure)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${count} ${key.replace(/_/g, " ")}`);
  return parts.length === 0 ? "empty document" : parts.join(", ");
}
