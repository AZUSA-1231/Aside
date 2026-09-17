import { createHash } from "node:crypto";
import {
  AsideContractError,
  MAX_TOOL_DESCRIPTION_LENGTH,
  MAX_TOOL_LABEL_LENGTH,
  MAX_TOOL_NAME_LENGTH,
  invalid,
  isPlainObject,
  isToolSchema,
  normalizeBoundedString,
  sanitizeRuntimeText,
  truncateText,
} from "./agent-contracts.mjs";
import { normalizeAvailabilityPrerequisites } from "./capability-availability.mjs";

export const CAPABILITY_CONTRACT_VERSION = 1;

export const TOOL_EFFECTS = Object.freeze(["read", "write", "execute"]);
export const TOOL_SCOPES = Object.freeze([
  "workspace",
  "host",
  "application",
  "service",
  "none",
]);
export const TOOL_EGRESS_VALUES = Object.freeze([
  "none",
  "query",
  "selected_content",
  "file_content",
  "credentialed",
]);
export const TOOL_SOURCES = Object.freeze(["builtin", "user_mcp"]);
export const TOOL_REPLAY_POLICIES = Object.freeze(["safe", "non_replayable"]);

/**
 * Trust ranking, most trusted first. A descriptor may declare a tier equal to
 * or less trusted than its registry's, never a more trusted one — otherwise a
 * user-connected capability could label itself a built-in one.
 */
export const TOOL_SOURCE_TRUST = Object.freeze(["builtin", "user_mcp"]);

/**
 * `execute` is part of the policy vocabulary so an unknown tool can be
 * classified honestly. It does not authorize or implement a shell; no such
 * capability may be registered (Cycle 6 C6-I003).
 */
export const RESERVED_TOOL_NAMESPACES = Object.freeze([
  "workspace",
  "document",
  "web",
  "aside",
]);
export const EXTENSION_TOOL_NAMESPACE = "mcp";

export const MAX_TOOL_ORIGIN_ID_LENGTH = 96;
export const MAX_TOOL_ORIGIN_LABEL_LENGTH = 120;

export const MCP_SERVER_SLUG_BYTES = 24;
export const MCP_TOOL_SLUG_BYTES = 40;
export const MCP_NAME_DIGEST_LENGTH = 10;

export const CAPABILITY_ORIGIN_LABELS = Object.freeze({
  builtin: "Aside built-in capability",
  user_mcp: "User-connected MCP server",
});

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

// The complete set of accepted descriptor keys. Anything else is rejected so a
// descriptor cannot smuggle trusted policy metadata (C6-04).
const descriptorFields = new Set([
  "contract_version",
  "name",
  "description",
  "label",
  "effect",
  "scope",
  "egress",
  "source",
  "replay",
  "availability",
  "origin",
]);

function unknownField(field) {
  throw new AsideContractError(
    `The runtime field "${field}" is not part of the capability contract.`,
    "unknown_descriptor_field",
  );
}

function normalizeDisplayText(value, field, maxBytes, { required = true } = {}) {
  const raw = normalizeBoundedString(value, field, maxBytes, { required });
  if (raw === undefined) return undefined;
  // Redaction can lengthen the text (a token becomes "[redacted]"), so the
  // bound is re-applied here rather than inherited from the check above.
  return sanitizeRuntimeText(raw, maxBytes).text;
}

export function toolNamespace(name) {
  const text = String(name ?? "");
  const index = text.indexOf(".");
  return index === -1 ? text : text.slice(0, index);
}

export function isReservedToolName(name) {
  return RESERVED_TOOL_NAMESPACES.includes(toolNamespace(name));
}

/**
 * Reserved namespaces are reserved against extensions only. A built-in
 * capability owns them; a user-connected one may never claim them.
 */
function assertToolNamespace(name, source) {
  const root = toolNamespace(name);
  if (source === "user_mcp") {
    if (isReservedToolName(name) || root !== EXTENSION_TOOL_NAMESPACE) {
      throw new AsideContractError(
        `The runtime tool "${name}" must use the "${EXTENSION_TOOL_NAMESPACE}." namespace for a user-connected capability.`,
        "reserved_namespace",
      );
    }
    return;
  }
  if (isReservedToolName(name)) return;
  if (root === EXTENSION_TOOL_NAMESPACE) {
    throw new AsideContractError(
      `The runtime tool "${name}" must not use the reserved "${EXTENSION_TOOL_NAMESPACE}." namespace.`,
      "reserved_namespace",
    );
  }
}

function resolveSourceTrust(entrySource, registrySource) {
  if (entrySource === undefined) return registrySource;
  const entryRank = TOOL_SOURCE_TRUST.indexOf(entrySource);
  const registryRank = TOOL_SOURCE_TRUST.indexOf(registrySource);
  if (entryRank < registryRank) {
    throw new AsideContractError(
      'The runtime field "tool.source" must not claim a more trusted origin than its registry.',
      "conflicting_source",
    );
  }
  return entrySource;
}

/**
 * Resolves the identity a capability is displayed under. A registry may
 * declare its own identity (a connected MCP server), which the entry inherits
 * unless it declares a more specific one.
 */
function normalizeOrigin(input, source, registryOrigin) {
  if (registryOrigin !== undefined) {
    if (!isPlainObject(registryOrigin)) invalid("options.origin");
    for (const key of Object.keys(registryOrigin)) {
      if (key !== "id" && key !== "label") unknownField(`tool.origin.${key}`);
    }
  }
  const fallback = {
    id: normalizeBoundedString(
      registryOrigin?.id ?? source,
      "tool.origin.id",
      MAX_TOOL_ORIGIN_ID_LENGTH,
    ),
    label: normalizeDisplayText(
      registryOrigin?.label ?? CAPABILITY_ORIGIN_LABELS[source],
      "tool.origin.label",
      MAX_TOOL_ORIGIN_LABEL_LENGTH,
    ),
  };
  if (input === undefined) return Object.freeze(fallback);
  if (!isPlainObject(input)) invalid("tool.origin");
  for (const key of Object.keys(input)) {
    if (key !== "id" && key !== "label") unknownField(`tool.origin.${key}`);
  }
  return Object.freeze({
    id: normalizeBoundedString(
      input.id ?? fallback.id,
      "tool.origin.id",
      MAX_TOOL_ORIGIN_ID_LENGTH,
    ),
    label: normalizeDisplayText(
      input.label ?? fallback.label,
      "tool.origin.label",
      MAX_TOOL_ORIGIN_LABEL_LENGTH,
    ),
  });
}

function normalizePrerequisites(input, scope) {
  const derived = scope === "workspace" ? ["workspace"] : [];
  let explicit;
  if (input !== undefined) {
    if (!isPlainObject(input)) invalid("tool.availability");
    for (const key of Object.keys(input)) {
      if (key !== "prerequisites") unknownField(`tool.availability.${key}`);
    }
    explicit = input.prerequisites;
  }
  const prerequisites = normalizeAvailabilityPrerequisites(
    explicit === undefined ? derived : explicit,
  );
  if (scope === "workspace" && !prerequisites.includes("workspace")) {
    throw new AsideContractError(
      'The runtime field "tool.availability" must declare the "workspace" prerequisite for a workspace-scoped capability.',
      "invalid_contract",
    );
  }
  return prerequisites;
}

/**
 * The only producer of a capability descriptor. Cycle 5 descriptors omit the
 * Cycle 6 dimensions; each one is derived here, once, at registry construction.
 */
export function normalizeToolDescriptor(
  input = {},
  { source: registrySource, origin: registryOrigin } = {},
) {
  if (!isPlainObject(input)) invalid("tool");
  for (const key of Object.keys(input)) {
    if (!descriptorFields.has(key)) unknownField(`tool.${key}`);
  }

  const contractVersion = input.contract_version ?? CAPABILITY_CONTRACT_VERSION;
  if (contractVersion !== CAPABILITY_CONTRACT_VERSION) {
    throw new AsideContractError(
      `The runtime capability contract version "${contractVersion}" is not supported.`,
      "unsupported_contract_version",
    );
  }

  const name = normalizeBoundedString(input.name, "tool.name", MAX_TOOL_NAME_LENGTH);
  if (!identifierPattern.test(name)) invalid("tool.name");

  const effect = input.effect;
  if (!TOOL_EFFECTS.includes(effect)) {
    if (effect === "external") {
      throw new AsideContractError(
        'The runtime field "tool.effect" no longer accepts "external"; declare an "egress" value instead.',
        "legacy_effect_external",
      );
    }
    invalid("tool.effect");
  }

  const scope = input.scope;
  if (!TOOL_SCOPES.includes(scope)) invalid("tool.scope");

  const replay = input.replay;
  if (!TOOL_REPLAY_POLICIES.includes(replay)) invalid("tool.replay");

  if (input.source !== undefined && !TOOL_SOURCES.includes(input.source)) {
    invalid("tool.source");
  }
  const declaredRegistrySource = registrySource ?? "builtin";
  if (!TOOL_SOURCES.includes(declaredRegistrySource)) invalid("tool.source");
  const source = resolveSourceTrust(input.source, declaredRegistrySource);

  let egress = input.egress;
  if (egress === undefined) {
    if (source === "user_mcp") {
      throw new AsideContractError(
        'The runtime field "tool.egress" is required for a user-connected capability.',
        "missing_egress",
      );
    }
    egress = "none";
  } else if (!TOOL_EGRESS_VALUES.includes(egress)) {
    invalid("tool.egress");
  }

  const prerequisites = normalizePrerequisites(input.availability, scope);
  assertToolNamespace(name, source);

  return Object.freeze({
    contract_version: CAPABILITY_CONTRACT_VERSION,
    name,
    description: normalizeDisplayText(
      input.description,
      "tool.description",
      MAX_TOOL_DESCRIPTION_LENGTH,
    ),
    label: normalizeDisplayText(
      input.label ?? name,
      "tool.label",
      MAX_TOOL_LABEL_LENGTH,
    ),
    effect,
    scope,
    egress,
    source,
    replay,
    availability: Object.freeze({ prerequisites }),
    origin: normalizeOrigin(input.origin, source, registryOrigin),
  });
}

/**
 * Bounded display projection only. `origin.id` may embed a path or URL and is
 * deliberately not published; trusted policy metadata stays runtime
 * authoritative and is never read back from this shape.
 */
export function describeToolDescriptor(descriptor) {
  return Object.freeze({
    contract_version: descriptor.contract_version,
    name: descriptor.name,
    description: descriptor.description,
    label: descriptor.label,
    effect: descriptor.effect,
    scope: descriptor.scope,
    egress: descriptor.egress,
    source: descriptor.source,
    replay: descriptor.replay,
    availability: Object.freeze({
      prerequisites: Object.freeze([
        ...(descriptor.availability?.prerequisites ?? []),
      ]),
    }),
    origin_label: descriptor.origin.label,
  });
}

export function createAsideToolRegistry(tools = [], options = {}) {
  if (!Array.isArray(tools)) invalid("tools");
  if (!isPlainObject(options)) invalid("options");

  const entries = [];
  const byName = new Map();
  for (const entry of tools) {
    if (!entry || typeof entry !== "object") invalid("tools[]");
    const tool = entry.tool ?? entry;
    // An explicit descriptor declaration must be exact: an unknown key here is
    // a developer error or an attempt to smuggle policy metadata (C6-04).
    if (entry.descriptor !== undefined) {
      if (!isPlainObject(entry.descriptor)) invalid("tools[].descriptor");
      for (const key of Object.keys(entry.descriptor)) {
        if (!descriptorFields.has(key)) unknownField(`tool.${key}`);
      }
    }
    const source = entry.descriptor ?? entry;
    // Pick explicitly rather than spreading: in the flat form the source is the
    // whole tool object, whose execution fields are not descriptor fields.
    const descriptor = normalizeToolDescriptor(
      {
        contract_version: source.contract_version,
        name: source.name ?? tool.name,
        description: source.description ?? tool.description,
        label: source.label ?? tool.label ?? tool.name,
        effect: source.effect,
        scope: source.scope,
        egress: source.egress,
        source: source.source,
        replay: source.replay,
        availability: source.availability,
        origin: source.origin,
      },
      { source: options.source, origin: options.origin },
    );
    if (
      typeof tool.name !== "string" ||
      tool.name !== descriptor.name ||
      (typeof tool.execute !== "function" &&
        typeof tool.createForRun !== "function") ||
      !isToolSchema(tool.parameters)
    ) {
      invalid(
        `tools.${descriptor.name}`,
        "must include a valid execution boundary and parameter schema",
      );
    }
    if (byName.has(descriptor.name)) {
      throw new AsideContractError(
        `The runtime tool "${descriptor.name}" is registered more than once.`,
        "duplicate_tool",
      );
    }
    byName.set(descriptor.name, { tool, descriptor });
    entries.push({ tool, descriptor });
  }

  return Object.freeze({
    entries: Object.freeze(entries.slice()),
    tools: Object.freeze(entries.map(({ tool }) => tool)),
    descriptors: Object.freeze(entries.map(({ descriptor }) => descriptor)),
    get(name) {
      return byName.get(name);
    },
    has(name) {
      return byName.has(name);
    },
    describe() {
      return entries.map(({ descriptor }) => describeToolDescriptor(descriptor));
    },
    filter(predicate) {
      return createAsideToolRegistry(entries.filter(predicate), options);
    },
  });
}

function mcpSlug(value, maxBytes) {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const bounded = truncateText(slug, maxBytes).text.replace(/^_+|_+$/g, "");
  return bounded.length > 0 ? bounded : "unnamed";
}

function mcpNameDigest(serverId, toolName) {
  return createHash("sha256")
    .update(`${serverId}\u0000${toolName}`, "utf8")
    .digest("hex")
    .slice(0, MCP_NAME_DIGEST_LENGTH);
}

/**
 * Deterministic, bounded extension name.
 *
 * `slug` maps every byte outside `[a-z0-9]` to `_`, so no `.` survives and the
 * dot stays an unambiguous separator. The digest is taken over the unsanitized
 * pair, so two servers whose ids slug to the same text still produce different
 * names.
 *
 * This is bounded injectivity up to a 40-bit digest agreement, not a proof:
 * a bounded encoding of an unbounded input space cannot be injective. The
 * registry's duplicate-name rejection is what turns the residual probability
 * into a loud failure instead of one tool shadowing another.
 */
export function encodeMcpToolName({ serverId, toolName } = {}) {
  const server = normalizeBoundedString(
    serverId,
    "server_id",
    MAX_TOOL_ORIGIN_ID_LENGTH,
  );
  const tool = normalizeBoundedString(toolName, "tool_name", MAX_TOOL_NAME_LENGTH);
  return [
    EXTENSION_TOOL_NAMESPACE,
    mcpSlug(server, MCP_SERVER_SLUG_BYTES),
    mcpSlug(tool, MCP_TOOL_SLUG_BYTES),
    mcpNameDigest(server, tool),
  ].join(".");
}
