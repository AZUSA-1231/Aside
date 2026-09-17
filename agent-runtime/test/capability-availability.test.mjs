import assert from "node:assert/strict";
import test from "node:test";
import { AsideContractError } from "../src/agent-contracts.mjs";
import {
  AVAILABILITY_PREREQUISITES,
  NO_RUN_FACTS,
  PREREQUISITE_RULES,
  assertPrerequisiteCoverage,
  createRunFacts,
  filterAvailableTools,
  normalizeAvailabilityPrerequisites,
  resolveAvailability,
} from "../src/capability-availability.mjs";

function entry(name, prerequisites) {
  return {
    tool: { name },
    descriptor: { name, availability: { prerequisites } },
  };
}

function fakeRegistry(entries) {
  return {
    entries,
    filter(predicate) {
      return fakeRegistry(entries.filter(predicate));
    },
  };
}

test("every declared prerequisite has a complete availability rule", () => {
  assert.equal(assertPrerequisiteCoverage(), true);
  assert.deepEqual(AVAILABILITY_PREREQUISITES, ["workspace"]);
  for (const id of AVAILABILITY_PREREQUISITES) {
    const rule = PREREQUISITE_RULES[id];
    assert.equal(typeof rule.code, "string", `${id} declares a code`);
    assert.equal(typeof rule.message, "string", `${id} declares a message`);
    assert.equal(typeof rule.satisfiedBy, "function", `${id} declares a predicate`);
  }
  // A half-extension must fail loudly rather than silently disabling a family.
  assert.throws(
    () => assertPrerequisiteCoverage(["workspace", "network"]),
    (error) =>
      error instanceof AsideContractError &&
      error.code === "unknown_prerequisite" &&
      /network/.test(error.message),
  );
});

test("normalizes and validates declared prerequisites", () => {
  assert.deepEqual(normalizeAvailabilityPrerequisites(undefined), []);
  assert.deepEqual(normalizeAvailabilityPrerequisites([]), []);
  assert.deepEqual(normalizeAvailabilityPrerequisites(["workspace", "workspace"]), [
    "workspace",
  ]);
  assert.throws(
    () => normalizeAvailabilityPrerequisites("workspace"),
    AsideContractError,
  );
  assert.throws(
    () => normalizeAvailabilityPrerequisites([""]),
    AsideContractError,
  );
  assert.throws(
    () => normalizeAvailabilityPrerequisites([42]),
    AsideContractError,
  );
  assert.throws(
    () => normalizeAvailabilityPrerequisites(["Workspace"]),
    AsideContractError,
  );
  assert.throws(
    () => normalizeAvailabilityPrerequisites(["network"]),
    (error) =>
      error instanceof AsideContractError &&
      error.code === "unknown_prerequisite",
  );
});

test("resolves an unsatisfied prerequisite with its own bounded reason", () => {
  const unresolved = resolveAvailability(["workspace"], NO_RUN_FACTS);
  assert.equal(unresolved.satisfied, false);
  assert.deepEqual(unresolved.missing, ["workspace"]);
  // Byte-identical to the Cycle 5 failure reason so existing events do not move.
  assert.equal(unresolved.code, "workspace_required");
  assert.equal(
    unresolved.message,
    "Select a workspace before using file capabilities.",
  );

  const resolved = resolveAvailability(["workspace"], { workspace: true });
  assert.equal(resolved.satisfied, true);
  assert.deepEqual(resolved.missing, []);

  const unconstrained = resolveAvailability([], NO_RUN_FACTS);
  assert.equal(unconstrained.satisfied, true);
});

test("derives run facts from the resolved execution environment", () => {
  assert.deepEqual(createRunFacts({ environment: { root: "/tmp" } }), {
    workspace: true,
  });
  assert.deepEqual(createRunFacts({ environment: undefined }), {
    workspace: false,
  });
  assert.deepEqual(createRunFacts(undefined), { workspace: false });
});

test("filters a registry by satisfied prerequisites only", () => {
  const registry = fakeRegistry([
    entry("workspace.read", ["workspace"]),
    entry("aside.echo", []),
  ]);

  assert.deepEqual(
    filterAvailableTools(registry, NO_RUN_FACTS).entries.map((e) => e.descriptor.name),
    ["aside.echo"],
  );
  assert.deepEqual(
    filterAvailableTools(registry, { workspace: true }).entries.map(
      (e) => e.descriptor.name,
    ),
    ["workspace.read", "aside.echo"],
  );
});

test("reproduces the Cycle 5 scope predicate for every combination", () => {
  // The mechanism that replaces `descriptor.scope !== "workspace"` must agree
  // with it exactly, for both an existing scope and a newly introduced one.
  for (const scope of ["workspace", "service"]) {
    for (const environment of [undefined, { root: "/tmp" }]) {
      const prerequisites = scope === "workspace" ? ["workspace"] : [];
      const facts = createRunFacts({ environment });
      const legacy = scope !== "workspace" || Boolean(environment);
      assert.equal(
        resolveAvailability(prerequisites, facts).satisfied,
        legacy,
        `scope=${scope} environment=${Boolean(environment)}`,
      );
    }
  }
});
