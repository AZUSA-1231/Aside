import { AsideContractError, sanitizeRuntimeText } from "./agent-contracts.mjs";
import { resolveAvailability } from "./capability-availability.mjs";

/**
 * `permission_required` is a requirement, not a block: the call proceeds and
 * the adapter must obtain a decision from the permission broker. The runtime
 * verifies afterwards that it did.
 */
export const POLICY_DECISIONS = Object.freeze([
  "allow",
  "permission_required",
  "unavailable",
]);

export const MAX_POLICY_REASON_BYTES = 280;

/**
 * A closed set of honest trust statements. The boundary is chosen by the
 * runtime from the trusted `source`, never from anything an adapter writes, so
 * a user-run server cannot be described as sandboxed (C6-I006).
 */
export const CAPABILITY_BOUNDARIES = Object.freeze({
  aside_enforced:
    "Aside enforces this capability's limits inside its own runtime.",
  external_process:
    "This tool runs in a separate program that Aside does not sandbox.",
});

/**
 * First match wins, in this order. A rule may only add a requirement the
 * default table does not already impose; the runtime never lets an adapter
 * supply its own table. `evaluateToolPolicy`'s `rules` parameter exists so the
 * runtime can extend this list per run (P6 per-server grants), not so a
 * capability can relax its own policy.
 */
export const POLICY_RULES = Object.freeze([
  Object.freeze({
    code: "source_user_mcp",
    decision: "permission_required",
    test: (descriptor) => descriptor.source === "user_mcp",
  }),
  Object.freeze({
    code: "egress_credentialed",
    decision: "permission_required",
    test: (descriptor) => descriptor.egress === "credentialed",
  }),
  Object.freeze({
    code: "egress_file_content",
    decision: "permission_required",
    test: (descriptor) => descriptor.egress === "file_content",
  }),
  Object.freeze({
    code: "egress_selected_content",
    decision: "permission_required",
    test: (descriptor) => descriptor.egress === "selected_content",
  }),
  Object.freeze({
    code: "egress_query",
    decision: "permission_required",
    test: (descriptor) => descriptor.egress === "query",
  }),
  Object.freeze({
    code: "effect_execute",
    decision: "permission_required",
    test: (descriptor) => descriptor.effect === "execute",
  }),
  Object.freeze({
    code: "effect_write",
    decision: "permission_required",
    test: (descriptor) => descriptor.effect === "write",
  }),
]);

const REASON_TEXT = Object.freeze({
  allowed: "This capability may run for the current task.",
  source_user_mcp:
    "This tool is provided by a user-connected program that Aside does not sandbox.",
  egress_credentialed:
    "This capability uses a connected credential and requires your approval.",
  egress_file_content:
    "This capability sends file content outside Aside and requires your approval.",
  egress_selected_content:
    "This capability sends selected content outside Aside and requires your approval.",
  egress_query:
    "This capability sends a query outside Aside and requires your approval.",
  effect_execute:
    "This capability may run code and requires your approval.",
  effect_write: "This capability changes files and requires your approval.",
});

export function assertPolicyRuleTable(rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new AsideContractError(
      'The runtime field "policy_rules" must be a non-empty array.',
      "invalid_policy_rules",
    );
  }
  for (const rule of rules) {
    if (
      !rule ||
      typeof rule.code !== "string" ||
      rule.code.length === 0 ||
      !POLICY_DECISIONS.includes(rule.decision) ||
      rule.decision === "unavailable" ||
      typeof rule.test !== "function"
    ) {
      throw new AsideContractError(
        'The runtime field "policy_rules" must contain rules with a code, a decision, and a predicate.',
        "invalid_policy_rules",
      );
    }
  }
  return true;
}

/**
 * Bounded, closed-enum description of what a capability actually does. Built
 * only from validated descriptor scalars, so it can never be talked into a
 * softer claim by a description, a document, or a server annotation.
 */
export function describeCapabilityRiskValues({
  effect,
  egress,
  source,
  origin_label,
}) {
  const boundary = source === "user_mcp" ? "external_process" : "aside_enforced";
  return Object.freeze({
    effect,
    egress,
    source,
    origin_label,
    boundary,
    note: CAPABILITY_BOUNDARIES[boundary],
  });
}

export function describeCapabilityRisk(descriptor) {
  return describeCapabilityRiskValues({
    effect: descriptor.effect,
    egress: descriptor.egress,
    source: descriptor.source,
    origin_label: descriptor.origin.label,
  });
}

function decision(decisionName, reasonCode, reason) {
  return Object.freeze({
    decision: decisionName,
    reason_code: reasonCode,
    reason: sanitizeRuntimeText(reason, MAX_POLICY_REASON_BYTES).text,
  });
}

/**
 * Derives policy from trusted registry metadata only. It never reads a
 * description, a label, tool arguments, or tool output, and it performs no I/O,
 * so it is deterministic and safe to call inside the tool-call hook.
 */
export function evaluateToolPolicy({
  registry,
  toolName,
  facts,
  rules = POLICY_RULES,
} = {}) {
  assertPolicyRuleTable(rules);
  const name = sanitizeRuntimeText(String(toolName ?? ""), 96).text;
  const registered = registry?.get
    ? registry.get(toolName)
    : undefined;

  if (!registered) {
    return Object.freeze({
      ...decision(
        "unavailable",
        "unregistered_tool",
        `The tool "${name}" is not available.`,
      ),
      descriptor: undefined,
      risk: undefined,
    });
  }

  const descriptor = registered.descriptor;
  const availability = resolveAvailability(
    descriptor.availability?.prerequisites,
    facts,
  );
  if (!availability.satisfied) {
    return Object.freeze({
      ...decision("unavailable", availability.code, availability.message),
      descriptor,
      risk: describeCapabilityRisk(descriptor),
    });
  }

  const rule = rules.find((candidate) => candidate.test(descriptor));
  if (!rule) {
    return Object.freeze({
      ...decision("allow", "allowed", REASON_TEXT.allowed),
      descriptor,
      risk: describeCapabilityRisk(descriptor),
    });
  }

  return Object.freeze({
    ...decision(
      rule.decision,
      rule.code,
      REASON_TEXT[rule.code] ?? "This capability requires your approval.",
    ),
    descriptor,
    risk: describeCapabilityRisk(descriptor),
  });
}

assertPolicyRuleTable(POLICY_RULES);
