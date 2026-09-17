/**
 * The shared document contract. Lives in its own module so the adapter
 * registry and each format adapter can depend on the error type without
 * importing one another.
 */
export class DocumentAdapterError extends Error {
  constructor(code, message, path, details) {
    super(message);
    this.name = "DocumentAdapterError";
    this.code = code;
    this.path = path;
    this.details = details;
  }
}

/**
 * Block vocabulary shared by every adapter. These are product contracts, so a
 * format adapter must not leak its library's own node types through them.
 */
export const DOCUMENT_BLOCK_TYPES = Object.freeze([
  "paragraph",
  "heading",
  "list_item",
  "table",
  "page_break",
  "opaque",
]);

export function isDocumentBlock(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    DOCUMENT_BLOCK_TYPES.includes(value.type)
  );
}
