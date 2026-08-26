import { loadFactors } from "./factors";
import { resolveModel, tierFromParams } from "./registry";
import { ZERO, add, asTriple, mul, scale, shift } from "./triple";
import { SoifError, type EstimateInput, type FactorSet, type Triple, type WaterEstimate } from "./types";

/**
 * The estimator, ported from `soif.estimator.estimate`.
 *
 *   E_it       = (output + reasoning + 0.1·input + 0.01·cached) / 1000 × Wh_per_1k(tier)
 *   E_facility = E_it × PUE
 *   W_onsite   = E_it × WUE            (1 L/kWh ≡ 1 mL/Wh, so no unit conversion)
 *   W_offsite  = E_facility × EWIF
 *   W_embodied = (W_onsite + W_offsite) × (lifecycle − 1)
 *   W_total    = W_onsite + W_offsite + W_embodied
 *
 * Parity with the Python is not assumed — `tests/parity.test.ts` runs every
 * vector in `factors.json` through this function.
 */

function assertTier(tier: string, factors: FactorSet): void {
  if (!factors.tiers.wh_per_1k_output_tokens[tier]) {
    throw new SoifError(`unknown tier '${tier}'; expected one of ${factors.tiers.order.join(", ")}`);
  }
}

export function estimate(input: EstimateInput = {}, factorSet?: FactorSet): WaterEstimate {
  const factors = factorSet ?? loadFactors();
  const assumptions: string[] = [];

  const model = input.model ?? null;
  const spec = resolveModel(model, factors);

  // -- resolve the model tier and hosting profile ---------------------------
  let tier = input.tier ?? null;
  if (tier === null && input.active_params_b != null) {
    tier = tierFromParams(input.active_params_b, factors);
    assumptions.push(`tier '${tier}' derived from ${formatG(input.active_params_b)}B active params`);
  }
  if (tier === null) {
    if (spec !== null) {
      tier = spec.tier;
    } else {
      tier = factors.tiers.fallback_tier;
      const label = model ? `'${model}'` : "unspecified model";
      assumptions.push(
        `unknown model ${label}: assumed tier '${tier}' ` +
          "(pass tier= or active_params_b= to override)",
      );
    }
  }
  assertTier(tier, factors);

  const provider = input.provider ?? spec?.provider ?? factors.default_provider;
  if (!factors.providers[provider]) {
    throw new SoifError(
      `unknown provider '${provider}'; expected one of ${Object.keys(factors.providers).join(", ")}`,
    );
  }
  const region = input.region ?? spec?.region ?? factors.default_region;
  if (!factors.regions[region]) {
    throw new SoifError(
      `unknown region '${region}'; expected one of ${Object.keys(factors.regions).join(", ")}`,
    );
  }

  // -- resolve token counts -------------------------------------------------
  // No prompt-text path here: this dashboard only ever sees real token counts
  // from a usage report or a transcript, never a prompt to approximate.
  const inputTokens = input.input_tokens ?? 0;
  const cachedTokens = input.cached_tokens ?? 0;
  let reasoningTokens = input.reasoning_tokens ?? 0;

  let outputTokens = input.output_tokens ?? null;
  if (outputTokens === null) {
    outputTokens = factors.token_weights.default_output_tokens;
    assumptions.push(`assumed a typical ${outputTokens}-token response`);
  }

  if (input.reasoning_effort != null) {
    const perOutput = factors.token_weights.reasoning_effort_tokens_per_output[input.reasoning_effort];
    if (perOutput === undefined) {
      throw new SoifError(
        `unknown reasoning_effort '${input.reasoning_effort}'; expected one of ` +
          Object.keys(factors.token_weights.reasoning_effort_tokens_per_output).join(", "),
      );
    }
    // Python's round() is banker's rounding; the multipliers are whole numbers
    // so the two agree, but pin the intent rather than relying on that.
    const extra = pyRound(outputTokens * perOutput);
    if (extra) {
      reasoningTokens += extra;
      assumptions.push(`reasoning effort '${input.reasoning_effort}' modelled as ${extra} thinking tokens`);
    }
  }

  // -- energy ---------------------------------------------------------------
  const ePer1k = factors.tiers.wh_per_1k_output_tokens[tier]!;
  const weights = factors.token_weights;
  const effectiveOutput = outputTokens + reasoningTokens * weights.reasoning_token_factor;
  const effectiveInput =
    inputTokens * weights.input_token_factor + cachedTokens * weights.cached_token_factor;
  const energyItWh = scale(ePer1k, (effectiveOutput + effectiveInput) / 1000);

  const pue = input.pue != null ? asTriple(input.pue) : factors.providers[provider]!.pue;
  const energyFacilityWh = mul(energyItWh, pue);

  // -- water ----------------------------------------------------------------
  const wue = input.wue != null ? asTriple(input.wue) : factors.providers[provider]!.wue;
  const ewif = input.ewif != null ? asTriple(input.ewif) : factors.regions[region]!;

  const onsiteMl = mul(energyItWh, wue);
  const offsiteMl = mul(energyFacilityWh, ewif);
  const operationalMl = add(onsiteMl, offsiteMl);

  const includeEmbodied = input.include_embodied ?? true;
  let embodiedMl: Triple = ZERO;
  if (includeEmbodied) {
    embodiedMl = mul(operationalMl, shift(factors.lifecycle_multiplier, -1));
  } else {
    assumptions.push("embodied (manufacturing) water excluded");
  }
  const totalMl = add(operationalMl, embodiedMl);

  return {
    total_ml: totalMl,
    onsite_ml: onsiteMl,
    offsite_ml: offsiteMl,
    embodied_ml: embodiedMl,
    energy_it_wh: energyItWh,
    energy_facility_wh: energyFacilityWh,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens,
    cached_tokens: cachedTokens,
    model: model ?? "",
    tier,
    provider,
    region,
    calls: 1,
    assumptions,
    factors_version: factors.factors_version,
  };
}

/** Merge estimates, mirroring `WaterEstimate.__add__`. */
export function addEstimates(a: WaterEstimate, b: WaterEstimate): WaterEstimate {
  const merge = (x: string, y: string) =>
    x === y ? x : [x, y].filter(Boolean).join(", ");
  return {
    total_ml: add(a.total_ml, b.total_ml),
    onsite_ml: add(a.onsite_ml, b.onsite_ml),
    offsite_ml: add(a.offsite_ml, b.offsite_ml),
    embodied_ml: add(a.embodied_ml, b.embodied_ml),
    energy_it_wh: add(a.energy_it_wh, b.energy_it_wh),
    energy_facility_wh: add(a.energy_facility_wh, b.energy_facility_wh),
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    reasoning_tokens: a.reasoning_tokens + b.reasoning_tokens,
    cached_tokens: a.cached_tokens + b.cached_tokens,
    model: merge(a.model, b.model),
    tier: merge(a.tier, b.tier),
    provider: merge(a.provider, b.provider),
    region: merge(a.region, b.region),
    calls: a.calls + b.calls,
    assumptions: [...new Set([...a.assumptions, ...b.assumptions])],
    factors_version: merge(a.factors_version, b.factors_version),
  };
}

/** Python's `round()`: half away from zero is *not* what it does — it's half to even. */
function pyRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function formatG(value: number): string {
  // Python's %g: trim trailing zeros, up to 6 significant digits.
  return Number.parseFloat(value.toPrecision(6)).toString();
}
