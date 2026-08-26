import type { Triple } from "@/lib/soif/types";

/**
 * Presentation helpers shared by the CLI and the dashboard.
 *
 * The honesty rules live here rather than in each renderer, because "show mid,
 * always expose the band" is only true if it is true everywhere. `formatTriple`
 * exists so no caller has to remember to print the range, and the vessel ladder
 * is computed once so the CLI and the UI cannot disagree about which tier you
 * are on.
 */

/** Millilitres → a human string, scaling the unit rather than the precision. */
export function formatWater(ml: number): string {
  if (!Number.isFinite(ml)) return "—";
  if (ml < 1) return `${ml.toFixed(2)} mL`;
  if (ml < 1_000) return `${ml.toFixed(ml < 10 ? 2 : 1)} mL`;
  const litres = ml / 1000;
  if (litres < 10) return `${litres.toFixed(2)} L`;
  if (litres < 100) return `${litres.toFixed(1)} L`;
  if (litres < 1_000_000) return `${Math.round(litres).toLocaleString("en-US")} L`;
  return `${(litres / 1000).toFixed(1)} kL`;
}

/**
 * The mid figure with its band, never the mid alone.
 *
 * soif's spread is often ~100x. A dashboard that renders `est.total_ml.mid` and
 * stops is the failure mode this project exists to avoid, so the shared
 * formatter makes the honest form the easy one.
 */
export function formatTriple(triple: Triple): string {
  return `${formatWater(triple.mid)} (range ${formatWater(triple.low)} – ${formatWater(triple.high)})`;
}

/** How wide the band is, as a "Nx below to Mx above" description. */
export function describeSpread(triple: Triple): string | null {
  if (triple.mid <= 0) return null;
  const below = triple.mid / Math.max(triple.low, Number.MIN_VALUE);
  const above = triple.high / triple.mid;
  return `${below < 10 ? below.toFixed(1) : Math.round(below)}× below to ${
    above < 10 ? above.toFixed(1) : Math.round(above)
  }× above`;
}

export function formatEnergy(wh: number): string {
  if (!Number.isFinite(wh)) return "—";
  if (wh < 1_000) return `${wh.toFixed(wh < 10 ? 2 : 1)} Wh`;
  const kwh = wh / 1000;
  return kwh < 100 ? `${kwh.toFixed(1)} kWh` : `${Math.round(kwh).toLocaleString("en-US")} kWh`;
}

export function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}K`;
  if (count < 1_000_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${(count / 1_000_000_000).toFixed(2)}B`;
}

// -- the vessel ladder ------------------------------------------------------

export interface VesselTier {
  /** Capacity of one vessel, in millilitres. */
  unitMl: number;
  /** Label for a single vessel, e.g. "50 L drum". */
  unit: string;
  name: string;
  /** Key into the SVG silhouette set. */
  art: "can" | "bottle" | "jerrycan" | "drum" | "tank" | "tower";
}

/**
 * Six tiers, five vessels each. A row holds `5 × unit`; passing that promotes
 * to the next tier.
 *
 * The hero is deliberately not a wall of hundreds of bottles — five vessels
 * that get promoted keeps a personal-scale number and an org-scale number
 * legible in the same component.
 */
export const VESSEL_TIERS: readonly VesselTier[] = [
  { unitMl: 330, unit: "330 mL can", name: "can", art: "can" },
  { unitMl: 1_500, unit: "1.5 L bottle", name: "bottle", art: "bottle" },
  { unitMl: 5_000, unit: "5 L jerrycan", name: "jerrycan", art: "jerrycan" },
  { unitMl: 50_000, unit: "50 L drum", name: "drum", art: "drum" },
  { unitMl: 1_000_000, unit: "1,000 L tank", name: "tank", art: "tank" },
  { unitMl: 10_000_000, unit: "10,000 L reservoir", name: "reservoir", art: "tower" },
];

export interface VesselState {
  tierIndex: number;
  tier: VesselTier;
  /** How many vessels the total fills, e.g. 2.38. */
  filled: number;
  /** Fill fraction of each of the five vessels, clamped to 0..1. */
  fills: number[];
  /** How full the row is overall, 0..1. Drives the puddle and the drips. */
  rowFraction: number;
  /** True once the row is past the point where drips should appear. */
  overflowing: boolean;
  /** The tier a full row would promote to, if there is one. */
  nextTier: VesselTier | null;
  /** True when even five reservoirs are not enough. */
  offTheScale: boolean;
}

/** Fraction of the row at which drips start — the cue that a promotion is near. */
const DRIP_THRESHOLD = 0.45;

/**
 * Pick the smallest tier where the total fits in five vessels.
 *
 * Low usage should read as one barely-filled can beside four empty ones, not
 * as a rounding error against a reservoir.
 */
export function vesselState(totalMl: number): VesselState {
  const total = Math.max(0, totalMl);
  let tierIndex = VESSEL_TIERS.findIndex((tier) => total <= tier.unitMl * 5);
  if (tierIndex < 0) tierIndex = VESSEL_TIERS.length - 1;

  const tier = VESSEL_TIERS[tierIndex]!;
  const filled = total / tier.unitMl;
  const rowFraction = Math.min(filled / 5, 1);

  return {
    tierIndex,
    tier,
    filled,
    fills: Array.from({ length: 5 }, (_, i) => clamp(filled - i, 0, 1)),
    rowFraction,
    overflowing: rowFraction >= DRIP_THRESHOLD,
    nextTier: VESSEL_TIERS[tierIndex + 1] ?? null,
    offTheScale: filled > 5,
  };
}

/** "2.4 of 5 filled" — one decimal below ten vessels, none above. */
export function formatVesselCount(filled: number): string {
  return `${filled < 10 ? filled.toFixed(1) : Math.round(filled)} of 5 filled`;
}

// -- comparisons ------------------------------------------------------------

/** 8-minute shower at a typical flow rate. */
export const SHOWER_LITRES = 45;

/**
 * Everyday equivalents, for scale.
 *
 * Only ever applied to the mid figure and always labelled as such — an
 * equivalence quoted off the high bound would be alarmism, and off the low
 * bound, reassurance. Neither is the estimate.
 */
export function showersEquivalent(totalMl: number): number {
  return totalMl / 1000 / SHOWER_LITRES;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
