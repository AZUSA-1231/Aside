import { AsideContractError, invalid } from "./agent-contracts.mjs";

/**
 * Run-scoped prerequisites a capability declares before it may be registered
 * for a task. The vocabulary is closed; a prerequisite is added here together
 * with its rule in the same change, or `assertPrerequisiteCoverage` fails.
 */
export const AVAILABILITY_PREREQUISITES = Object.freeze(["workspace"]);

/**
 * A prerequisite owns its own failure code and message. Keeping them per
 * prerequisite rather than per gate is what lets a later capability report
 * "no connected server" without reusing the workspace wording.
 */
export const PREREQUISITE_RULES = Object.freeze({
  workspace: Object.freeze({
    code: "workspace_required",
    message: "Select a workspace before using file capabilities.",
    satisfiedBy: (facts) => facts?.workspace === true,
  }),
});

/**
 * The facts of a run before it has resolved anything. Used to build the
 * registry that is published before a prompt starts.
 */
export const NO_RUN_FACTS = Object.freeze({ workspace: false });

const prerequisiteIdentifierPattern = /^[a-z][a-z0-9_]*$/;

export function assertPrerequisiteCoverage(
  prerequisites = AVAILABILITY_PREREQUISITES,
) {
  if (!Array.isArray(prerequisites)) invalid("prerequisites");
  for (const id of prerequisites) {
    const rule = PREREQUISITE_RULES[id];
    if (
      !rule ||
      typeof rule.code !== "string" ||
      rule.code.length === 0 ||
      typeof rule.message !== "string" ||
      rule.message.length === 0 ||
      typeof rule.satisfiedBy !== "function"
    ) {
      throw new AsideContractError(
        `The runtime prerequisite "${id}" has no availability rule.`,
        "unknown_prerequisite",
      );
    }
  }
  return true;
}

export function normalizeAvailabilityPrerequisites(input) {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input)) invalid("tool.availability.prerequisites");
  const seen = new Set();
  for (const id of input) {
    if (typeof id !== "string" || !prerequisiteIdentifierPattern.test(id)) {
      invalid("tool.availability.prerequisites");
    }
    if (!Object.prototype.hasOwnProperty.call(PREREQUISITE_RULES, id)) {
      throw new AsideContractError(
        `The runtime prerequisite "${id}" is not supported.`,
        "unknown_prerequisite",
      );
    }
    seen.add(id);
  }
  return Object.freeze([...seen].sort());
}

/**
 * The single run-scoped fact bag. Availability and policy both read it, so a
 * later prerequisite is visible to policy without a second plumbing path.
 */
export function createRunFacts(run) {
  return Object.freeze({ workspace: Boolean(run?.environment) });
}

export function resolveAvailability(prerequisites, facts) {
  const list = Array.isArray(prerequisites) ? prerequisites : [];
  const missing = list.filter((id) => {
    const rule = PREREQUISITE_RULES[id];
    return !rule || rule.satisfiedBy(facts) !== true;
  });
  if (missing.length === 0) {
    return Object.freeze({ satisfied: true, missing: Object.freeze([]) });
  }
  const first = PREREQUISITE_RULES[missing[0]];
  return Object.freeze({
    satisfied: false,
    missing: Object.freeze(missing.slice()),
    code: first ? first.code : "unavailable",
    message: first
      ? first.message
      : "This capability is not available for the current task.",
  });
}

export function filterAvailableTools(registry, facts) {
  return registry.filter(({ descriptor }) =>
    resolveAvailability(descriptor.availability?.prerequisites, facts).satisfied,
  );
}

assertPrerequisiteCoverage();
