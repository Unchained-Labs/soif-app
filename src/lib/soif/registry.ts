import type { FactorSet, RegistryEntry } from "./types";

/**
 * Model-name resolution, ported from `soif.registry`.
 *
 * The matching rule matters as much as the table: longest matching substring
 * wins on a normalised name. That is what lets `us.anthropic.claude-sonnet-4-5-v1:0`
 * and `openai/gpt-4o-2024-11-20` resolve at all, and what keeps `gpt-4o-mini`
 * from matching the `gpt-4o` entry. Get the rule wrong and you get a plausible
 * tier that is one step off — a ~2.5× error in the energy term, silently.
 */

/** Normalise a model name per `registry.normalisation`. */
export function normalise(name: string, factors: FactorSet): string {
  const rules = factors.registry.normalisation;
  let out = name;
  if (rules.strip) out = out.trim();
  if (rules.lowercase) out = out.toLowerCase();
  for (const [from, to] of Object.entries(rules.replace)) {
    out = out.split(from).join(to);
  }
  return out;
}

/**
 * Best-matching registry entry for a model name, or `null`.
 *
 * Ties on match length keep the earlier entry, matching Python's strict `>`
 * comparison over `MODELS` in declaration order.
 */
export function resolveModel(name: string | null | undefined, factors: FactorSet): RegistryEntry | null {
  if (!name) return null;
  const normalised = normalise(name, factors);
  let best: RegistryEntry | null = null;
  for (const entry of factors.registry.models) {
    if (!normalised.includes(normalise(entry.match, factors))) continue;
    if (best === null || entry.match.length > best.match.length) best = entry;
  }
  return best;
}

/** Tier from active parameter count, per `factors.tier_from_params`. */
export function tierFromParams(activeParamsB: number, factors: FactorSet): string {
  for (const boundary of factors.tiers.boundaries_active_params_b) {
    if (boundary.max_active_params_b === null || activeParamsB < boundary.max_active_params_b) {
      return boundary.tier;
    }
  }
  // Unreachable given a well-formed table — the last entry is always unbounded,
  // and `loadFactors` would have rejected a set without one.
  return factors.tiers.fallback_tier;
}

/** Every model the registry knows, for the UI's coverage disclosure. */
export function knownModels(factors: FactorSet): readonly RegistryEntry[] {
  return factors.registry.models;
}
