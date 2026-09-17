import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import {
  AsideContractError,
  MAX_TOOL_NAME_LENGTH,
} from "../src/agent-contracts.mjs";
import {
  CAPABILITY_CONTRACT_VERSION,
  EXTENSION_TOOL_NAMESPACE,
  RESERVED_TOOL_NAMESPACES,
  TOOL_EGRESS_VALUES,
  TOOL_EFFECTS,
  TOOL_REPLAY_POLICIES,
  TOOL_SCOPES,
  TOOL_SOURCES,
  createAsideToolRegistry,
  describeToolDescriptor,
  encodeMcpToolName,
  isReservedToolName,
  normalizeToolDescriptor,
  toolNamespace,
} from "../src/capability-contract.mjs";

// A Cycle 5 descriptor exactly as it is written in the shipped workspace tools.
function legacyDescriptor(overrides = {}) {
  return {
    name: "workspace.read",
    description: "Read bounded UTF-8 text from the active workspace.",
    label: "Read workspace file",
    effect: "read",
    scope: "workspace",
    replay: "safe",
    ...overrides,
  };
}

function tool(name, descriptor, extra = {}) {
  return {
    name,
    description: `Tool ${name}.`,
    label: name,
    parameters: Type.Object({ value: Type.String() }),
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: { status: "succeeded" } };
    },
    descriptor: { name, ...descriptor },
    ...extra,
  };
}

function contractError(code) {
  return (error) =>
    error instanceof AsideContractError && error.code === code;
}

test("C6-02: every descriptor carries every contract dimension", () => {
  const descriptor = normalizeToolDescriptor(legacyDescriptor());
  for (const dimension of [
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
  ]) {
    assert.ok(dimension in descriptor, `${dimension} is present`);
  }
  assert.equal(descriptor.contract_version, CAPABILITY_CONTRACT_VERSION);
  assert.ok(TOOL_EFFECTS.includes(descriptor.effect));
  assert.ok(TOOL_SCOPES.includes(descriptor.scope));
  assert.ok(TOOL_EGRESS_VALUES.includes(descriptor.egress));
  assert.ok(TOOL_SOURCES.includes(descriptor.source));
  assert.ok(TOOL_REPLAY_POLICIES.includes(descriptor.replay));
  assert.deepEqual(descriptor.availability.prerequisites, ["workspace"]);
  assert.equal(descriptor.origin.label, "Aside built-in capability");
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(Object.isFrozen(descriptor.availability), true);
  assert.equal(Object.isFrozen(descriptor.availability.prerequisites), true);
  assert.equal(Object.isFrozen(descriptor.origin), true);
});

test("migrates a Cycle 5 descriptor by deriving the new dimensions", () => {
  const derived = normalizeToolDescriptor(legacyDescriptor());
  assert.equal(derived.egress, "none");
  assert.equal(derived.source, "builtin");
  assert.deepEqual(derived.availability.prerequisites, ["workspace"]);

  // A non-workspace scope derives no prerequisite.
  const service = normalizeToolDescriptor(
    legacyDescriptor({ name: "aside.echo", scope: "service" }),
  );
  assert.deepEqual(service.availability.prerequisites, []);

  // An explicit value always wins over a derived one.
  const explicit = normalizeToolDescriptor(
    legacyDescriptor({ egress: "file_content" }),
  );
  assert.equal(explicit.egress, "file_content");
});

test("normalization is idempotent so registry.filter can re-validate", () => {
  const once = normalizeToolDescriptor(legacyDescriptor());
  const twice = normalizeToolDescriptor({
    contract_version: once.contract_version,
    name: once.name,
    description: once.description,
    label: once.label,
    effect: once.effect,
    scope: once.scope,
    egress: once.egress,
    source: once.source,
    replay: once.replay,
    availability: once.availability,
    origin: once.origin,
  });
  assert.deepEqual(twice, once);

  const registry = createAsideToolRegistry([
    tool("workspace.read", { effect: "read", scope: "workspace", replay: "safe" }),
    tool("aside.echo", { effect: "read", scope: "none", replay: "safe" }),
  ]);
  const filtered = registry.filter(({ descriptor }) => descriptor.name === "workspace.read");
  assert.deepEqual(filtered.describe(), [describeToolDescriptor(registry.descriptors[0])]);
  assert.deepEqual(filtered.descriptors[0], registry.descriptors[0]);
});

test("rejects descriptors that smuggle trusted policy metadata", () => {
  // C6-04: an unknown key must fail construction, not ride along on a frozen object.
  for (const injected of [
    { trusted: true },
    { policy: "allow" },
    { shell: true },
    { allowed: true },
  ]) {
    assert.throws(
      () => normalizeToolDescriptor(legacyDescriptor(injected)),
      contractError("unknown_descriptor_field"),
      JSON.stringify(injected),
    );
  }
  assert.throws(
    () => normalizeToolDescriptor(legacyDescriptor({ availability: { prerequisites: [], extra: 1 } })),
    contractError("unknown_descriptor_field"),
  );
  assert.throws(
    () => normalizeToolDescriptor(legacyDescriptor({ origin: { id: "x", label: "y", trust: "high" } })),
    contractError("unknown_descriptor_field"),
  );

  // A tool object carrying those keys must not leak them through the registry.
  const registry = createAsideToolRegistry([
    tool("workspace.read", { effect: "read", scope: "workspace", replay: "safe" }, {
      policy: "allow",
      trusted: true,
    }),
  ]);
  const published = registry.describe()[0];
  assert.equal("policy" in published, false);
  assert.equal("trusted" in published, false);
  assert.equal("execute" in published, false);
  assert.equal("parameters" in published, false);
});

test("rejects unknown dimension values and unsupported contract versions", () => {
  assert.throws(
    () => normalizeToolDescriptor(legacyDescriptor({ contract_version: 2 })),
    contractError("unsupported_contract_version"),
  );
  assert.throws(
    () => normalizeToolDescriptor(legacyDescriptor({ effect: "shell" })),
    AsideContractError,
  );
  assert.throws(
    () => normalizeToolDescriptor(legacyDescriptor({ scope: "device" })),
    AsideContractError,
  );
  assert.throws(
    () => normalizeToolDescriptor(legacyDescriptor({ egress: "any" })),
    AsideContractError,
  );
  assert.throws(
    () => normalizeToolDescriptor(legacyDescriptor({ source: "third_party" })),
    AsideContractError,
  );
  assert.throws(
    () => normalizeToolDescriptor(legacyDescriptor({ replay: "maybe" })),
    AsideContractError,
  );
  assert.throws(
    () => normalizeToolDescriptor(legacyDescriptor({ name: "bad name" })),
    AsideContractError,
  );
});

test("names the removal of the legacy external effect", () => {
  // Cycle 5 accepted `external`; Cycle 6 replaces it with `execute` plus egress.
  assert.throws(
    () => normalizeToolDescriptor(legacyDescriptor({ effect: "external" })),
    contractError("legacy_effect_external"),
  );
});

test("fails closed on a source that claims a more trusted tier", () => {
  // An entry inside a user-connectable registry may not call itself built-in.
  assert.throws(
    () =>
      createAsideToolRegistry(
        [tool("mcp.srv.tool.0123456789", {
          effect: "read",
          scope: "service",
          egress: "query",
          source: "builtin",
          replay: "safe",
        })],
        { source: "user_mcp" },
      ),
    contractError("conflicting_source"),
  );

  // Equal or less trusted is accepted.
  const registry = createAsideToolRegistry(
    [tool("mcp.srv.tool.0123456789", {
      effect: "read",
      scope: "service",
      egress: "query",
      source: "user_mcp",
      replay: "safe",
    })],
    { source: "builtin" },
  );
  assert.equal(registry.descriptors[0].source, "user_mcp");
  assert.equal(registry.descriptors[0].origin.label, "User-connected MCP server");
});

test("requires an explicit egress for a user-connected capability", () => {
  assert.throws(
    () =>
      createAsideToolRegistry(
        [tool("mcp.srv.tool.0123456789", {
          effect: "read",
          scope: "service",
          replay: "safe",
        })],
        { source: "user_mcp" },
      ),
    contractError("missing_egress"),
  );
});

test("refuses a workspace-scoped descriptor without the workspace prerequisite", () => {
  assert.throws(
    () =>
      normalizeToolDescriptor(
        legacyDescriptor({ availability: { prerequisites: [] } }),
      ),
    contractError("invalid_contract"),
  );
  assert.throws(
    () =>
      normalizeToolDescriptor(
        legacyDescriptor({ availability: { prerequisites: ["network"] } }),
      ),
    contractError("unknown_prerequisite"),
  );
});

test("reserves built-in namespaces against extensions only", () => {
  for (const namespace of RESERVED_TOOL_NAMESPACES) {
    assert.equal(isReservedToolName(`${namespace}.tool`), true);
    assert.equal(toolNamespace(`${namespace}.tool`), namespace);
  }
  assert.equal(isReservedToolName("aside"), true);
  assert.equal(isReservedToolName("mcp.srv.tool"), false);

  // A built-in keeps its own namespace...
  assert.doesNotThrow(() =>
    normalizeToolDescriptor(legacyDescriptor({ name: "web.search", scope: "service" })),
  );
  assert.doesNotThrow(() =>
    normalizeToolDescriptor(legacyDescriptor({ name: "aside.echo", scope: "none" })),
  );
  // ...and may not claim the extension namespace.
  assert.throws(
    () => normalizeToolDescriptor(legacyDescriptor({ name: "mcp.srv.tool.0123456789" })),
    contractError("reserved_namespace"),
  );

  // An extension may only live in the extension namespace.
  for (const name of ["workspace.read", "web.search", "aside.echo", "custom.tool"]) {
    assert.throws(
      () =>
        createAsideToolRegistry(
          [tool(name, {
            effect: "read",
            scope: "service",
            egress: "query",
            replay: "safe",
          })],
          { source: "user_mcp" },
        ),
      contractError("reserved_namespace"),
      name,
    );
  }
});

test("encodes an MCP tool name deterministically and within bounds", () => {
  const encoded = encodeMcpToolName({
    serverId: "files-server",
    toolName: "read_file",
  });
  assert.equal(
    encoded,
    encodeMcpToolName({ serverId: "files-server", toolName: "read_file" }),
  );
  assert.match(encoded, /^mcp\.files_server\.read_file\.[0-9a-f]{10}$/);
  assert.ok(encoded.length <= MAX_TOOL_NAME_LENGTH);
  assert.equal(toolNamespace(encoded), EXTENSION_TOOL_NAMESPACE);
  assert.equal(isReservedToolName(encoded), false);
});

test("keeps MCP names distinct when sanitization would collide them", () => {
  // `a-b` and `a_b` slug to the same text; only the digest separates them.
  const dashed = encodeMcpToolName({ serverId: "a-b", toolName: "x" });
  const underscored = encodeMcpToolName({ serverId: "a_b", toolName: "x" });
  assert.notEqual(dashed, underscored);
  assert.equal(dashed.split(".")[1], underscored.split(".")[1]);
  assert.notEqual(dashed.split(".")[3], underscored.split(".")[3]);
});

test("encodes adversarial MCP identities into valid, bounded names", () => {
  const pairs = [
    ["My Server", "do.thing"],
    ["a.b.c", "d"],
    ["mcp.example.com", "workspace.read"],
    ["ÜNICODE", "日本語"],
    ["!!!", "???"],
    ["-".repeat(60), "y"],
    ["x".repeat(96), "y".repeat(96)],
    ["SERVER", "Tool"],
    ["a", "b".repeat(95)],
    [".", "."],
  ];
  const names = new Set();
  for (const [serverId, toolName] of pairs) {
    const encoded = encodeMcpToolName({ serverId, toolName });
    assert.match(
      encoded,
      /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
      `${serverId} / ${toolName} produces a valid identifier`,
    );
    assert.ok(
      Buffer.byteLength(encoded, "utf8") <= MAX_TOOL_NAME_LENGTH,
      `${serverId} / ${toolName} stays inside the name budget`,
    );
    assert.equal(toolNamespace(encoded), EXTENSION_TOOL_NAMESPACE);
    assert.equal(encoded.split(".").length, 4, "slugging leaves the dot unambiguous");
    names.add(encoded);
  }
  assert.equal(names.size, pairs.length, "every distinct pair produces a distinct name");

  // The registry, not the encoding, is what turns a duplicate into a failure.
  const duplicate = encodeMcpToolName({ serverId: "srv", toolName: "dup" });
  assert.throws(
    () =>
      createAsideToolRegistry(
        [
          tool(duplicate, { effect: "read", scope: "service", egress: "query", replay: "safe" }),
          tool(duplicate, { effect: "read", scope: "service", egress: "query", replay: "safe" }),
        ],
        { source: "user_mcp" },
      ),
    contractError("duplicate_tool"),
  );

  assert.throws(() => encodeMcpToolName({ serverId: "x".repeat(200), toolName: "y" }));
  assert.throws(() => encodeMcpToolName({ toolName: "y" }));
});

test("lets a registry declare the identity its capabilities are shown under", () => {
  const descriptor = {
    effect: "read",
    scope: "service",
    egress: "query",
    replay: "safe",
  };
  const registry = createAsideToolRegistry(
    [tool("mcp.local.files.0123456789", descriptor)],
    {
      source: "user_mcp",
      origin: { id: "local-files", label: "Local files server" },
    },
  );
  assert.deepEqual(registry.descriptors[0].origin, {
    id: "local-files",
    label: "Local files server",
  });
  assert.equal(registry.describe()[0].origin_label, "Local files server");

  // An entry may still declare a more specific identity of its own.
  const specific = createAsideToolRegistry(
    [tool("mcp.local.files.0123456789", {
      ...descriptor,
      origin: { id: "files-read", label: "Local files: read" },
    })],
    { source: "user_mcp", origin: { id: "local-files", label: "Local files server" } },
  );
  assert.equal(specific.describe()[0].origin_label, "Local files: read");

  // Without one, the source tier supplies the honest default.
  const plain = createAsideToolRegistry([tool("aside.echo", { effect: "read", scope: "none", replay: "safe" })]);
  assert.equal(plain.descriptors[0].origin.label, "Aside built-in capability");

  assert.throws(
    () => createAsideToolRegistry([tool("aside.echo", { effect: "read", scope: "none", replay: "safe" })], {
      origin: { id: "x", label: "y", trust: "high" },
    }),
    contractError("unknown_descriptor_field"),
  );
  assert.throws(
    () => createAsideToolRegistry([tool("aside.echo", { effect: "read", scope: "none", replay: "safe" })], {
      origin: "local-files",
    }),
    AsideContractError,
  );
});

test("describes only bounded display metadata", () => {
  const registry = createAsideToolRegistry([
    tool("workspace.read", { effect: "read", scope: "workspace", replay: "safe" }),
  ]);
  const published = registry.describe()[0];
  assert.deepEqual(Object.keys(published).sort(), [
    "availability",
    "contract_version",
    "description",
    "effect",
    "egress",
    "label",
    "name",
    "origin_label",
    "replay",
    "scope",
    "source",
  ]);
  // origin.id may embed a path or URL and is not published.
  assert.equal("origin" in published, false);
  assert.equal(Object.isFrozen(published), true);
  assert.equal(Object.isFrozen(published.availability.prerequisites), true);
  // The published array must not alias the registry's own descriptor state.
  assert.notEqual(
    published.availability.prerequisites,
    registry.descriptors[0].availability.prerequisites,
  );
  assert.equal(
    Reflect.set(published.availability.prerequisites, "0", "tampered"),
    false,
  );
  assert.deepEqual(registry.descriptors[0].availability.prerequisites, ["workspace"]);
});
