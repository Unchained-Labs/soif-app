import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFactorSet } from "@/lib/soif/factors";
import { estimate } from "@/lib/soif/estimate";
import { normalise, resolveModel, tierFromParams } from "@/lib/soif/registry";
import type { EstimateInput, Triple } from "@/lib/soif/types";

/**
 * Proof that the TypeScript estimator agrees with the Python reference.
 *
 * `factors.json` ships `parity_vectors`: estimates computed by `soif` itself.
 * If this suite passes, the two implementations produce the same millilitres
 * for the same tokens. If it fails, this repo is wrong — the Python is the
 * reference — and the dashboard must not ship until it agrees.
 */

const FACTORS_PATH = fileURLToPath(new URL("../factors.json", import.meta.url));
const factors = parseFactorSet(readFileSync(FACTORS_PATH, "utf8"), FACTORS_PATH);

/**
 * Float ops are associative-order sensitive, and the two languages do not
 * evaluate in identical order. 1e-12 relative is ~9 orders of magnitude tighter
 * than the factor spread itself, so it catches a real porting bug while
 * tolerating last-bit noise.
 */
const REL_TOLERANCE = 1e-12;

function expectTripleClose(actual: Triple, expected: Triple, label: string) {
  for (const bound of ["low", "mid", "high"] as const) {
    const a = actual[bound];
    const e = expected[bound];
    const tolerance = Math.max(Math.abs(e) * REL_TOLERANCE, Number.EPSILON);
    expect(Math.abs(a - e), `${label}.${bound}: got ${a}, expected ${e}`).toBeLessThanOrEqual(
      tolerance,
    );
  }
}

describe("parity with the soif reference implementation", () => {
  it("ships vectors to check against", () => {
    expect(factors.parity_vectors.length).toBeGreaterThan(0);
  });

  for (const vector of factors.parity_vectors) {
    it(`reproduces ${vector.id}`, () => {
      const result = estimate(vector.input as EstimateInput, factors);

      expect(result.tier, "tier").toBe(vector.expected.tier);
      expect(result.provider, "provider").toBe(vector.expected.provider);
      expect(result.region, "region").toBe(vector.expected.region);

      expectTripleClose(result.energy_it_wh, vector.expected.energy_it_wh, "energy_it_wh");
      expectTripleClose(
        result.energy_facility_wh,
        vector.expected.energy_facility_wh,
        "energy_facility_wh",
      );
      expectTripleClose(result.onsite_ml, vector.expected.onsite_ml, "onsite_ml");
      expectTripleClose(result.offsite_ml, vector.expected.offsite_ml, "offsite_ml");
      expectTripleClose(result.embodied_ml, vector.expected.embodied_ml, "embodied_ml");
      expectTripleClose(result.total_ml, vector.expected.total_ml, "total_ml");
    });
  }

  it("stamps the factor set version on every estimate", () => {
    const result = estimate({ model: "gpt-4o", output_tokens: 500 }, factors);
    expect(result.factors_version).toBe(factors.factors_version);
  });
});

describe("registry matching rule", () => {
  it("prefers the longest match, not the first", () => {
    // The classic failure: `gpt-4o-mini` contains `gpt-4o`, so a first-match
    // resolver puts a small-tier model on the large tier — a ~4x energy error.
    expect(resolveModel("gpt-4o-mini", factors)?.match).toBe("gpt-4o-mini");
    expect(resolveModel("gpt-4o", factors)?.match).toBe("gpt-4o");
    expect(resolveModel("gemini-2.5-flash-lite", factors)?.match).toBe("gemini-2.5-flash-lite");
    expect(resolveModel("gemini-2.5-flash", factors)?.match).toBe("gemini-2.5-flash");
  });

  it("tolerates provider prefixes, date suffixes and separator variants", () => {
    const cases: Array<[string, string]> = [
      ["openai/gpt-4o-2024-11-20", "gpt-4o"],
      ["us.anthropic.claude-sonnet-4-5-v1:0", "claude-sonnet"],
      ["anthropic/claude-opus-4-20250514", "claude-opus"],
      ["  GPT-4O  ", "gpt-4o"],
      ["claude_haiku_4_5", "claude-haiku"],
      ["gemini-1.5-pro-002", "gemini-1.5-pro"],
    ];
    for (const [name, expected] of cases) {
      expect(resolveModel(name, factors)?.match, name).toBe(expected);
    }
  });

  it("returns null rather than guessing for an unknown model", () => {
    expect(resolveModel("totally-made-up-model", factors)).toBeNull();
    expect(resolveModel("", factors)).toBeNull();
    expect(resolveModel(null, factors)).toBeNull();
  });

  it("normalises the way the factor set declares", () => {
    expect(normalise("  GPT_4.O Turbo ", factors)).toBe("gpt-4-o-turbo");
  });

  it("maps active params onto tiers at every declared boundary", () => {
    // Boundaries are exclusive upper bounds, so a value exactly on the edge
    // belongs to the tier above.
    expect(tierFromParams(0, factors)).toBe("nano");
    expect(tierFromParams(2.99, factors)).toBe("nano");
    expect(tierFromParams(3, factors)).toBe("small");
    expect(tierFromParams(14.99, factors)).toBe("small");
    expect(tierFromParams(15, factors)).toBe("medium");
    expect(tierFromParams(69.99, factors)).toBe("medium");
    expect(tierFromParams(70, factors)).toBe("large");
    expect(tierFromParams(249.99, factors)).toBe("large");
    expect(tierFromParams(250, factors)).toBe("frontier");
    expect(tierFromParams(1_000, factors)).toBe("frontier");
  });
});

describe("token weighting", () => {
  it("charges cached tokens at 1% of an output token", () => {
    // This is the single most consequential weight for agentic workloads: a
    // Claude Code session reads ~1M cached tokens per message. Weighting them
    // like input tokens (0.1) inflates the estimate roughly tenfold.
    // output_tokens must be pinned to 0: omitting it silently injects the
    // 500-token default response and the comparison stops meaning anything.
    const cached = estimate({ tier: "large", cached_tokens: 1_000_000, output_tokens: 0 }, factors);
    const output = estimate({ tier: "large", output_tokens: 10_000 }, factors);
    expect(cached.energy_it_wh.mid).toBeCloseTo(output.energy_it_wh.mid, 9);
  });

  it("charges input tokens at 10% of an output token", () => {
    const input = estimate({ tier: "large", input_tokens: 10_000, output_tokens: 0 }, factors);
    const output = estimate({ tier: "large", output_tokens: 1_000 }, factors);
    expect(input.energy_it_wh.mid).toBeCloseTo(output.energy_it_wh.mid, 9);
  });

  it("charges reasoning tokens at the full output rate", () => {
    const reasoning = estimate({ tier: "large", output_tokens: 0, reasoning_tokens: 1_000 }, factors);
    const output = estimate({ tier: "large", output_tokens: 1_000 }, factors);
    expect(reasoning.energy_it_wh.mid).toBeCloseTo(output.energy_it_wh.mid, 9);
  });
});

describe("honesty guarantees", () => {
  it("records an assumption whenever it fell back to a default", () => {
    const unknown = estimate({ model: "who-knows", output_tokens: 500 }, factors);
    expect(unknown.assumptions.join(" ")).toMatch(/unknown model/);

    const noOutput = estimate({ model: "gpt-4o" }, factors);
    expect(noOutput.assumptions.join(" ")).toMatch(/assumed a typical/);

    // A fully-specified estimate should claim nothing it did not use.
    const specified = estimate({ model: "gpt-4o", input_tokens: 10, output_tokens: 20 }, factors);
    expect(specified.assumptions).toEqual([]);
  });

  it("keeps low <= mid <= high through every path", () => {
    const cases: EstimateInput[] = [
      { model: "gpt-4o", output_tokens: 500 },
      { model: "claude-opus-4", input_tokens: 5_000, cached_tokens: 900_000, output_tokens: 800 },
      { model: "gpt-5", output_tokens: 500, reasoning_effort: "high" },
      { tier: "nano", output_tokens: 1, region: "renewable" },
      { model: "gpt-4o", output_tokens: 500, include_embodied: false },
    ];
    for (const input of cases) {
      const r = estimate(input, factors);
      for (const field of ["total_ml", "onsite_ml", "offsite_ml", "embodied_ml", "energy_it_wh"] as const) {
        const t = r[field];
        expect(t.low, `${JSON.stringify(input)} ${field}`).toBeLessThanOrEqual(t.mid);
        expect(t.mid, `${JSON.stringify(input)} ${field}`).toBeLessThanOrEqual(t.high);
      }
    }
  });

  it("zeroes the embodied term when it is excluded, rather than folding it in", () => {
    const withEmbodied = estimate({ model: "gpt-4o", output_tokens: 500 }, factors);
    const without = estimate({ model: "gpt-4o", output_tokens: 500, include_embodied: false }, factors);
    expect(without.embodied_ml).toEqual({ low: 0, mid: 0, high: 0 });
    expect(without.total_ml.mid).toBeCloseTo(
      without.onsite_ml.mid + without.offsite_ml.mid,
      12,
    );
    expect(without.total_ml.mid).toBeLessThan(withEmbodied.total_ml.mid);
  });

  it("rejects unknown tiers, providers and regions instead of defaulting", () => {
    expect(() => estimate({ tier: "gigantic" }, factors)).toThrow(/unknown tier/);
    expect(() => estimate({ provider: "hetzner" }, factors)).toThrow(/unknown provider/);
    expect(() => estimate({ region: "atlantis" }, factors)).toThrow(/unknown region/);
    expect(() => estimate({ reasoning_effort: "extreme" }, factors)).toThrow(/unknown reasoning_effort/);
  });
});
