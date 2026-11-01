import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { SETTINGS_THINKING_LEVELS } from "./settings-schema.mjs";

/**
 * The thinking levels Aside offers for one model.
 *
 * The list comes from the model's own metadata rather than a shared menu: a
 * provider that cannot express `xhigh` must not show it. When the catalog has
 * no entry for the model (for example a model the runtime could not resolve),
 * only `off` is offered, because claiming a level the model cannot accept
 * would be a success the request never had.
 */
export function supportedThinkingLevels(model) {
  if (!model) return ["off"];
  const levels = getSupportedThinkingLevels(model);
  return levels.length > 0 ? levels : ["off"];
}

/**
 * Resolve the configured level against the model that will actually run.
 *
 * The saved value is a preference, not a promise: switching models can leave a
 * level the new model cannot express. `clampThinkingLevel` walks to the nearest
 * supported neighbour, which keeps the user's intent (ask for more reasoning)
 * instead of silently dropping to `off` or rejecting the configured model.
 *
 * `requested` stays what the user configured; `applied` is what runs.
 */
export function resolveThinkingLevel(model, requested) {
  const supported = supportedThinkingLevels(model);
  const configured = typeof requested === "string" && SETTINGS_THINKING_LEVELS.includes(requested.trim())
    ? requested.trim()
    : "off";
  const applied = supported.includes(configured) ? configured : clampThinkingLevel(model, configured);
  return Object.freeze({
    requested: configured,
    applied: supported.includes(applied) ? applied : "off",
    supported,
    // True when the saved preference could not be used as-is. The surface says
    // so instead of showing the configured value as if it took effect.
    adjusted: applied !== configured,
  });
}
