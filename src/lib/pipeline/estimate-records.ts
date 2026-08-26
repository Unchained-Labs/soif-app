import { estimate } from "@/lib/soif/estimate";
import { add, ZERO } from "@/lib/soif/triple";
import type { FactorSet, Triple, WaterEstimate } from "@/lib/soif/types";

/**
 * Turning stored token counts into water.
 *
 * Estimates are always derived from `usage_records`, never the other way round.
 * That is what lets a factor-set upgrade re-derive the entire history instead
 * of leaving old millilitres frozen against factors nobody can reconstruct.
 */

/** The normalised shape the pipeline consumes, from any source. */
export interface UsageLike {
  model: string;
  inputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  inferenceGeo?: string | null;
}

export interface EstimateOptions {
  /** Excluded by the UI toggle. Google's published figures are operational-only. */
  includeEmbodied?: boolean;
  /**
   * Region override. Leave unset to use `inference_geo` when the source
   * reported it, falling back to the registry's default for the model.
   */
  region?: string | null;
}

/**
 * Map the API's `inference_geo` onto a soif region key.
 *
 * This is the accuracy win the brief singles out: real geographic routing
 * instead of an assumed grid mix. `not_available` is the honest majority case —
 * it must fall through to the registry default rather than being guessed at,
 * because guessing `us` for a global request is a ~30% error on the EWIF term
 * in either direction.
 */
export function regionFromInferenceGeo(geo: string | null | undefined): string | null {
  switch (geo?.trim().toLowerCase()) {
    case "us":
      return "us";
    case "europe":
    case "eu":
      return "eu";
    case "global":
      // Routed anywhere in the fleet: the world mix is exactly what that means.
      return "world";
    default:
      // `not_available`, absent, or a value added after this was written.
      return null;
  }
}

/**
 * Estimate one usage record.
 *
 * Two mappings matter and are easy to get subtly wrong:
 *
 *  - **Cache-creation tokens are ordinary input.** Writing to the cache costs a
 *    full prefill; only *reads* are the 1%-weighted `cached_tokens`. Passing
 *    cache-creation as cached would under-count by ~10x on those tokens.
 *  - **Reasoning tokens are already inside `output_tokens`.** The provider
 *    counts them there, and soif charges reasoning at the full output rate, so
 *    passing them again as `reasoning_tokens` double-charges the most expensive
 *    token class there is. They are recorded for disclosure and not re-added.
 */
export function estimateRecord(
  record: UsageLike,
  factors: FactorSet,
  options: EstimateOptions = {},
): WaterEstimate {
  const region = options.region ?? regionFromInferenceGeo(record.inferenceGeo);

  return estimate(
    {
      model: record.model,
      input_tokens: record.inputTokens + record.cacheCreationTokens,
      cached_tokens: record.cachedTokens,
      output_tokens: record.outputTokens,
      reasoning_tokens: 0,
      region,
      include_embodied: options.includeEmbodied ?? true,
    },
    factors,
  );
}

export interface AggregateTotals {
  totalMl: Triple;
  onsiteMl: Triple;
  offsiteMl: Triple;
  embodiedMl: Triple;
  energyItWh: Triple;
  energyFacilityWh: Triple;
  inputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  calls: number;
}

export const EMPTY_TOTALS: AggregateTotals = {
  totalMl: ZERO,
  onsiteMl: ZERO,
  offsiteMl: ZERO,
  embodiedMl: ZERO,
  energyItWh: ZERO,
  energyFacilityWh: ZERO,
  inputTokens: 0,
  cachedTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  calls: 0,
};

/** Fold an estimate and its source record into a running total. */
export function accumulate(
  totals: AggregateTotals,
  estimateResult: WaterEstimate,
  record: UsageLike,
): AggregateTotals {
  return {
    totalMl: add(totals.totalMl, estimateResult.total_ml),
    onsiteMl: add(totals.onsiteMl, estimateResult.onsite_ml),
    offsiteMl: add(totals.offsiteMl, estimateResult.offsite_ml),
    embodiedMl: add(totals.embodiedMl, estimateResult.embodied_ml),
    energyItWh: add(totals.energyItWh, estimateResult.energy_it_wh),
    energyFacilityWh: add(totals.energyFacilityWh, estimateResult.energy_facility_wh),
    inputTokens: totals.inputTokens + record.inputTokens,
    cachedTokens: totals.cachedTokens + record.cachedTokens,
    cacheCreationTokens: totals.cacheCreationTokens + record.cacheCreationTokens,
    outputTokens: totals.outputTokens + record.outputTokens,
    reasoningTokens: totals.reasoningTokens + record.reasoningTokens,
    calls: totals.calls + 1,
  };
}

/** Estimate a batch and return per-record results alongside the total. */
export function estimateAll<T extends UsageLike>(
  records: readonly T[],
  factors: FactorSet,
  options: EstimateOptions = {},
): { estimates: WaterEstimate[]; totals: AggregateTotals } {
  const results: WaterEstimate[] = [];
  let totals = EMPTY_TOTALS;
  for (const record of records) {
    const result = estimateRecord(record, factors, options);
    results.push(result);
    totals = accumulate(totals, result, record);
  }
  return { estimates: results, totals };
}

/**
 * Group records by a key, estimating each group. Used for by-day and by-model views.
 *
 * Generic over the record type so callers can group by fields the estimator
 * itself does not need — `dayKey`, `sessionId`, a source label — without
 * widening `UsageLike` to carry presentation concerns.
 */
export function estimateGrouped<T extends UsageLike, K extends string>(
  records: readonly T[],
  keyOf: (record: T) => K,
  factors: FactorSet,
  options: EstimateOptions = {},
): Map<K, AggregateTotals> {
  const groups = new Map<K, AggregateTotals>();
  for (const record of records) {
    const key = keyOf(record);
    const result = estimateRecord(record, factors, options);
    groups.set(key, accumulate(groups.get(key) ?? EMPTY_TOTALS, result, record));
  }
  return groups;
}

/**
 * Blended water intensity, in litres per million output tokens.
 *
 * Returns null rather than 0 when there are no output tokens: a rate with an
 * empty denominator is undefined, and rendering it as "0.0 L" would read as a
 * measured efficiency rather than an absent one.
 */
export function litresPerMillionOutputTokens(totals: AggregateTotals): Triple | null {
  if (totals.outputTokens === 0) return null;
  const perToken = 1_000_000 / totals.outputTokens / 1000;
  return {
    low: totals.totalMl.low * perToken,
    mid: totals.totalMl.mid * perToken,
    high: totals.totalMl.high * perToken,
  };
}
