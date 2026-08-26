/**
 * Shape of `factors.json`, the artifact published by the `soif` Python package.
 *
 * Nothing in this directory hard-codes a factor value. Every number comes from
 * the JSON, so a factor-set upgrade is a file swap rather than a code change,
 * and the two implementations cannot silently disagree.
 */

/** A (low, mid, high) scenario triple. Never collapse one to a single number. */
export interface Triple {
  low: number;
  mid: number;
  high: number;
}

export interface TierBoundary {
  tier: string;
  /** Exclusive upper bound in billions of active params; `null` for the top tier. */
  max_active_params_b: number | null;
}

export interface RegistryEntry {
  match: string;
  tier: string;
  provider: string;
  region: string;
  notes?: string;
  aliases?: string[];
}

export interface ParityVector {
  id: string;
  input: Record<string, unknown>;
  expected: {
    tier: string;
    provider: string;
    region: string;
    energy_it_wh: Triple;
    energy_facility_wh: Triple;
    onsite_ml: Triple;
    offsite_ml: Triple;
    embodied_ml: Triple;
    total_ml: Triple;
  };
}

export interface FactorSet {
  schema_version: string;
  factors_version: string;
  soif_version: string;
  source: string;
  notice: string;
  model: {
    description: string;
    units: Record<string, string>;
  };
  tiers: {
    order: string[];
    wh_per_1k_output_tokens: Record<string, Triple>;
    boundaries_active_params_b: TierBoundary[];
    fallback_tier: string;
  };
  token_weights: {
    input_token_factor: number;
    cached_token_factor: number;
    reasoning_token_factor: number;
    default_output_tokens: number;
    reasoning_effort_tokens_per_output: Record<string, number>;
  };
  providers: Record<string, { wue: Triple; pue: Triple }>;
  default_provider: string;
  regions: Record<string, Triple>;
  default_region: string;
  lifecycle_multiplier: Triple;
  registry: {
    normalisation: {
      lowercase: boolean;
      strip: boolean;
      replace: Record<string, string>;
    };
    match_rule: string;
    models: RegistryEntry[];
  };
  parity_vectors: ParityVector[];
}

/** Inputs to a single estimate. Mirrors `soif.estimate(...)`. */
export interface EstimateInput {
  model?: string | null;
  input_tokens?: number;
  output_tokens?: number | null;
  reasoning_tokens?: number;
  cached_tokens?: number;
  reasoning_effort?: string | null;
  tier?: string | null;
  active_params_b?: number | null;
  provider?: string | null;
  region?: string | null;
  wue?: number | Triple | null;
  pue?: number | Triple | null;
  ewif?: number | Triple | null;
  include_embodied?: boolean;
}

/** Result of an estimate. All water in millilitres, all energy in watt-hours. */
export interface WaterEstimate {
  total_ml: Triple;
  onsite_ml: Triple;
  offsite_ml: Triple;
  embodied_ml: Triple;
  energy_it_wh: Triple;
  energy_facility_wh: Triple;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  model: string;
  tier: string;
  provider: string;
  region: string;
  calls: number;
  /** Every default the estimate leaned on, spelled out for the UI to surface. */
  assumptions: string[];
  factors_version: string;
}

export class SoifError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SoifError";
  }
}
