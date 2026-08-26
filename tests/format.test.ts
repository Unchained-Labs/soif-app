import { describe, expect, it } from "vitest";
import {
  VESSEL_TIERS,
  describeSpread,
  formatEnergy,
  formatTokens,
  formatTriple,
  formatVesselCount,
  formatWater,
  showersEquivalent,
  vesselState,
} from "@/lib/format";

/**
 * The vessel ladder is the page's headline claim about scale, so its tier
 * selection is worth pinning: promoting a tier too early makes a personal
 * account look industrial, and too late buries an org's usage in a rounding
 * error at the bottom of a reservoir.
 */

describe("vessel ladder", () => {
  it("picks the smallest tier that holds the total in five vessels", () => {
    expect(vesselState(100).tier.name).toBe("can"); // 0.1 L
    expect(vesselState(1_650).tier.name).toBe("can"); // exactly 5 cans
    expect(vesselState(1_651).tier.name).toBe("bottle"); // one drop over
    expect(vesselState(7_500).tier.name).toBe("bottle"); // exactly 5 bottles
    expect(vesselState(7_501).tier.name).toBe("jerrycan");
    expect(vesselState(25_000).tier.name).toBe("jerrycan");
    expect(vesselState(25_001).tier.name).toBe("drum");
    expect(vesselState(250_000).tier.name).toBe("drum");
    expect(vesselState(250_001).tier.name).toBe("tank");
    expect(vesselState(5_000_000).tier.name).toBe("tank");
    expect(vesselState(5_000_001).tier.name).toBe("reservoir");
  });

  it("fills vessels left to right, clamping each to 0..1", () => {
    // 2.4 cans: two full, one 40% full, two empty.
    const state = vesselState(330 * 2.4);
    expect(state.fills[0]).toBeCloseTo(1, 9);
    expect(state.fills[1]).toBeCloseTo(1, 9);
    expect(state.fills[2]).toBeCloseTo(0.4, 9);
    expect(state.fills[3]).toBe(0);
    expect(state.fills[4]).toBe(0);
  });

  it("shows low usage as one barely-filled vessel, not an empty big one", () => {
    const state = vesselState(30); // 30 mL
    expect(state.tier.name).toBe("can");
    expect(state.fills[0]).toBeCloseTo(30 / 330, 9);
    expect(state.rowFraction).toBeLessThan(0.02);
    expect(state.overflowing).toBe(false);
  });

  it("starts dripping only once the row is near promotion", () => {
    expect(vesselState(330 * 2.2).overflowing).toBe(false); // 44% of the row
    expect(vesselState(330 * 2.3).overflowing).toBe(true); // 46%
  });

  it("stays on the top tier when even five reservoirs are not enough", () => {
    const state = vesselState(10_000_000 * 5 * 3);
    expect(state.tier.name).toBe("reservoir");
    expect(state.nextTier).toBeNull();
    expect(state.offTheScale).toBe(true);
    // Every vessel is full rather than overflowing into a sixth.
    expect(state.fills.every((f) => f === 1)).toBe(true);
  });

  it("handles zero and negative totals without breaking", () => {
    const zero = vesselState(0);
    expect(zero.tier.name).toBe("can");
    expect(zero.fills).toEqual([0, 0, 0, 0, 0]);
    expect(vesselState(-100).fills).toEqual([0, 0, 0, 0, 0]);
  });

  it("declares tiers in ascending capacity order", () => {
    for (let i = 1; i < VESSEL_TIERS.length; i++) {
      expect(VESSEL_TIERS[i]!.unitMl).toBeGreaterThan(VESSEL_TIERS[i - 1]!.unitMl);
    }
  });

  it("counts vessels with one decimal below ten and none above", () => {
    expect(formatVesselCount(2.38)).toBe("2.4 of 5 filled");
    expect(formatVesselCount(12.4)).toBe("12 of 5 filled");
  });
});

describe("water formatting", () => {
  it("scales the unit rather than dropping precision", () => {
    expect(formatWater(0.5)).toBe("0.50 mL");
    expect(formatWater(3.27)).toBe("3.27 mL");
    expect(formatWater(120)).toBe("120.0 mL");
    expect(formatWater(5_530)).toBe("5.53 L");
    expect(formatWater(85_900)).toBe("85.9 L");
    expect(formatWater(531_000)).toBe("531 L");
    expect(formatWater(2_500_000_000)).toBe("2500.0 kL");
  });

  it("never renders a non-finite value as a number", () => {
    expect(formatWater(Number.NaN)).toBe("—");
    expect(formatWater(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("always includes the band when formatting a triple", () => {
    // The single most important honesty rule: no bare number without a range.
    const text = formatTriple({ low: 44_100, mid: 531_000, high: 6_129_000 });
    expect(text).toContain("531 L");
    expect(text).toContain("44.1 L");
    expect(text).toContain("6,129 L");
    expect(text).toMatch(/range/);
  });

  it("describes the spread in multiples", () => {
    expect(describeSpread({ low: 100, mid: 1_000, high: 10_000 })).toBe("10× below to 10× above");
    expect(describeSpread({ low: 500, mid: 1_000, high: 2_000 })).toBe("2.0× below to 2.0× above");
  });

  it("returns no spread for an empty total rather than dividing by zero", () => {
    expect(describeSpread({ low: 0, mid: 0, high: 0 })).toBeNull();
  });
});

describe("other units", () => {
  it("formats energy across the Wh/kWh boundary", () => {
    expect(formatEnergy(4.2)).toBe("4.20 Wh");
    expect(formatEnergy(240)).toBe("240.0 Wh");
    expect(formatEnergy(214_000)).toBe("214 kWh");
  });

  it("formats token counts compactly", () => {
    expect(formatTokens(117)).toBe("117");
    expect(formatTokens(13_409_554)).toBe("13.4M");
    expect(formatTokens(6_216_799_707)).toBe("6.22B");
  });

  it("converts to showers at the documented rate", () => {
    expect(showersEquivalent(45_000)).toBeCloseTo(1, 9);
    expect(showersEquivalent(531_000)).toBeCloseTo(11.8, 1);
  });
});
