import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFactorSet } from "@/lib/soif/factors";
import {
  EMPTY_TOTALS,
  estimateAll,
  estimateGrouped,
  estimateRecord,
  litresPerMillionOutputTokens,
  regionFromInferenceGeo,
  type UsageLike,
} from "@/lib/pipeline/estimate-records";
import {
  bucketDedupeKey,
  classifyCredential,
  isAdminKey,
  parseUsageResponse,
  planBackfillWindows,
  BUCKET_LIMITS,
  type UsageBucket,
} from "@/lib/sources/anthropic-admin";
import { fingerprint, keyId, open, rotate, seal, SecretError, sealedKeyId } from "@/lib/security/secrets";
import { randomBytes } from "node:crypto";

const factors = parseFactorSet(
  readFileSync(fileURLToPath(new URL("../factors.json", import.meta.url)), "utf8"),
);

function record(overrides: Partial<UsageLike> = {}): UsageLike {
  return {
    model: "claude-sonnet-4-5",
    inputTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    ...overrides,
  };
}

describe("token mapping", () => {
  it("charges cache-creation tokens as input, not as cached reads", () => {
    // Writing to the cache costs a full prefill; only reads are the 1% class.
    // Treating creation as cached under-counts those tokens tenfold.
    const asCreation = estimateRecord(record({ cacheCreationTokens: 100_000 }), factors);
    const asInput = estimateRecord(record({ inputTokens: 100_000 }), factors);
    const asCached = estimateRecord(record({ cachedTokens: 100_000 }), factors);

    expect(asCreation.energy_it_wh.mid).toBeCloseTo(asInput.energy_it_wh.mid, 12);
    expect(asCreation.energy_it_wh.mid).toBeCloseTo(asCached.energy_it_wh.mid * 10, 9);
  });

  it("does not re-charge reasoning tokens already counted in output", () => {
    // The provider reports thinking inside output_tokens. Passing them through
    // as reasoning_tokens as well would double the most expensive token class.
    const withThinking = estimateRecord(
      record({ outputTokens: 1000, reasoningTokens: 800 }),
      factors,
    );
    const withoutThinking = estimateRecord(record({ outputTokens: 1000 }), factors);
    expect(withThinking.total_ml.mid).toBeCloseTo(withoutThinking.total_ml.mid, 12);
  });

  it("keeps the low/mid/high band on every record", () => {
    const result = estimateRecord(record({ outputTokens: 500 }), factors);
    expect(result.total_ml.low).toBeLessThan(result.total_ml.mid);
    expect(result.total_ml.mid).toBeLessThan(result.total_ml.high);
  });
});

describe("inference geo", () => {
  it("maps reported routing onto a region", () => {
    expect(regionFromInferenceGeo("us")).toBe("us");
    expect(regionFromInferenceGeo("US")).toBe("us");
    expect(regionFromInferenceGeo("global")).toBe("world");
    expect(regionFromInferenceGeo("europe")).toBe("eu");
  });

  it("falls through rather than guessing when routing is unknown", () => {
    // Guessing `us` for an unrouted request is a large EWIF error in either
    // direction; the registry default is the honest answer.
    expect(regionFromInferenceGeo("not_available")).toBeNull();
    expect(regionFromInferenceGeo(null)).toBeNull();
    expect(regionFromInferenceGeo(undefined)).toBeNull();
    expect(regionFromInferenceGeo("mars-1")).toBeNull();
  });

  it("actually changes the estimate when routing is known", () => {
    const unknown = estimateRecord(record({ outputTokens: 1000, inferenceGeo: "not_available" }), factors);
    const us = estimateRecord(record({ outputTokens: 1000, inferenceGeo: "us" }), factors);
    expect(us.region).toBe("us");
    expect(unknown.region).toBe("world");
    expect(us.total_ml.mid).not.toBeCloseTo(unknown.total_ml.mid, 6);
  });

  it("lets an explicit region override reported routing", () => {
    const result = estimateRecord(
      record({ outputTokens: 1000, inferenceGeo: "us" }),
      factors,
      { region: "nordics" },
    );
    expect(result.region).toBe("nordics");
  });
});

describe("aggregation", () => {
  const records = [
    record({ model: "claude-opus-4", outputTokens: 1000 }),
    record({ model: "claude-sonnet-4-5", outputTokens: 2000, cachedTokens: 500_000 }),
    record({ model: "claude-opus-4", outputTokens: 500 }),
  ];

  it("sums bound-wise across records", () => {
    const { estimates, totals } = estimateAll(records, factors);
    expect(totals.calls).toBe(3);
    for (const bound of ["low", "mid", "high"] as const) {
      const expected = estimates.reduce((a, e) => a + e.total_ml[bound], 0);
      expect(totals.totalMl[bound]).toBeCloseTo(expected, 9);
    }
    expect(totals.outputTokens).toBe(3500);
    expect(totals.cachedTokens).toBe(500_000);
  });

  it("groups without losing anything", () => {
    const byModel = estimateGrouped(records, (r) => r.model, factors);
    expect([...byModel.keys()].sort()).toEqual(["claude-opus-4", "claude-sonnet-4-5"]);
    expect(byModel.get("claude-opus-4")!.calls).toBe(2);

    const { totals } = estimateAll(records, factors);
    const regrouped = [...byModel.values()].reduce((a, t) => a + t.totalMl.mid, 0);
    expect(regrouped).toBeCloseTo(totals.totalMl.mid, 9);
  });

  it("starts from a zeroed total", () => {
    expect(estimateAll([], factors).totals).toEqual(EMPTY_TOTALS);
  });

  it("returns null intensity rather than a fake zero when there is no output", () => {
    // "0.0 L per 1M tokens" would read as measured efficiency, not absent data.
    const { totals } = estimateAll([record({ inputTokens: 500 })], factors);
    expect(litresPerMillionOutputTokens(totals)).toBeNull();
  });

  it("computes intensity as litres per million output tokens", () => {
    const { totals } = estimateAll([record({ outputTokens: 1_000_000 })], factors);
    const rate = litresPerMillionOutputTokens(totals)!;
    expect(rate.mid).toBeCloseTo(totals.totalMl.mid / 1000, 9);
  });
});

describe("anthropic admin api", () => {
  it("classifies credentials by prefix instead of trying them blindly", () => {
    expect(classifyCredential("sk-ant-admin01-abc")).toBe("admin");
    expect(classifyCredential("Bearer sk-ant-admin01-abc")).toBe("admin");
    expect(classifyCredential("sk-ant-oat01-abc")).toBe("oauth");
    expect(classifyCredential("sk-ant-api03-abc")).toBe("api");
    expect(classifyCredential("sessionKey=abc")).toBe("unknown");
    expect(isAdminKey("sk-ant-admin01-abc")).toBe(true);
    expect(isAdminKey("sk-ant-api03-abc")).toBe(false);
  });

  it("parses a usage report, keeping the four counts separate", () => {
    const page = parseUsageResponse({
      data: [
        {
          starting_at: "2026-08-01T00:00:00Z",
          ending_at: "2026-08-02T00:00:00Z",
          results: [
            {
              model: "claude-sonnet-4-5",
              inference_geo: "us",
              service_tier: "standard",
              uncached_input_tokens: 100,
              cache_read_input_tokens: 900_000,
              cache_creation_input_tokens: 5_000,
              output_tokens: 700,
            },
          ],
        },
      ],
      has_more: true,
      next_page: "page_2",
    });

    expect(page.buckets).toHaveLength(1);
    expect(page.buckets[0]).toMatchObject({
      model: "claude-sonnet-4-5",
      inferenceGeo: "us",
      uncachedInputTokens: 100,
      cacheReadInputTokens: 900_000,
      cacheCreationInputTokens: 5_000,
      outputTokens: 700,
    });
    expect(page.hasMore).toBe(true);
    expect(page.nextPage).toBe("page_2");
  });

  it("sums TTL-split cache creation into one total", () => {
    const page = parseUsageResponse({
      data: [
        {
          starting_at: "2026-08-01T00:00:00Z",
          ending_at: "2026-08-02T00:00:00Z",
          results: [
            {
              model: "claude-opus-4",
              cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 1_588 },
              output_tokens: 10,
            },
          ],
        },
      ],
    });
    expect(page.buckets[0]!.cacheCreationInputTokens).toBe(1_888);
  });

  it("drops all-zero rows and survives a malformed bucket", () => {
    const page = parseUsageResponse({
      data: [
        { starting_at: "2026-08-01T00:00:00Z", ending_at: "2026-08-02T00:00:00Z", results: [{ model: "m" }] },
        { results: [{ model: "no-window", output_tokens: 5 }] },
        null,
      ],
    });
    expect(page.buckets).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it("includes geo in the dedupe key so two routings do not collapse", () => {
    const base: UsageBucket = {
      startsAt: "2026-08-01T00:00:00Z",
      endsAt: "2026-08-02T00:00:00Z",
      model: "claude-opus-4",
      inferenceGeo: "us",
      serviceTier: "standard",
      workspaceId: null,
      apiKeyId: null,
      uncachedInputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 1,
    };
    // Without geo in the key, the unique index would keep one of these and the
    // reported usage would halve.
    expect(bucketDedupeKey(base)).not.toBe(bucketDedupeKey({ ...base, inferenceGeo: "global" }));
    expect(bucketDedupeKey(base)).toBe(bucketDedupeKey({ ...base, outputTokens: 999 }));
  });

  it("plans backfill windows within the per-request bucket cap", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const end = new Date("2026-08-01T00:00:00Z");

    const daily = planBackfillWindows(start, end, "1d");
    expect(daily.length).toBeGreaterThan(1);
    for (const window of daily) {
      const buckets = (window.endingAt.getTime() - window.startingAt.getTime()) / 86_400_000;
      expect(buckets).toBeLessThanOrEqual(BUCKET_LIMITS["1d"]);
    }
    // Contiguous and covering, so an interrupted backfill leaves no hole.
    expect(daily[0]!.startingAt).toEqual(start);
    expect(daily.at(-1)!.endingAt).toEqual(end);
    for (let i = 1; i < daily.length; i++) {
      expect(daily[i]!.startingAt).toEqual(daily[i - 1]!.endingAt);
    }
  });

  it("returns no windows for an inverted or empty range", () => {
    const now = new Date("2026-08-01T00:00:00Z");
    expect(planBackfillWindows(now, now)).toEqual([]);
    expect(planBackfillWindows(now, new Date("2026-01-01T00:00:00Z"))).toEqual([]);
  });
});

describe("credential sealing", () => {
  const master = { id: "", key: randomBytes(32) };
  master.id = keyId(master.key);

  it("round-trips a credential", () => {
    const secret = "sk-ant-admin01-not-a-real-key";
    const sealed = seal(secret, master);
    expect(open(sealed, master)).toBe(secret);
  });

  it("never leaves the plaintext visible in the sealed form", () => {
    const secret = "sk-ant-admin01-not-a-real-key";
    const sealed = seal(secret, master);
    expect(sealed).not.toContain(secret);
    expect(sealed).not.toContain("sk-ant");
    expect(Buffer.from(sealed).toString("utf8")).not.toContain("admin01");
  });

  it("produces a different ciphertext every time", () => {
    // A deterministic ciphertext would leak that two sources share a key.
    expect(seal("same", master)).not.toBe(seal("same", master));
  });

  it("refuses a wrong master key by id rather than returning garbage", () => {
    const other = { key: randomBytes(32), id: "" };
    other.id = keyId(other.key);
    const sealed = seal("secret", master);
    expect(() => open(sealed, other)).toThrow(SecretError);
    expect(() => open(sealed, other)).toThrow(/SOIF_ENCRYPTION_KEY/);
  });

  it("detects tampering", () => {
    const sealed = seal("secret", master);
    const parts = sealed.split(".");
    const payload = Buffer.from(parts[3]!, "base64url");
    const last = payload.length - 1;
    payload[last] = (payload[last] ?? 0) ^ 0xff;
    parts[3] = payload.toString("base64url");
    expect(() => open(parts.join("."), master)).toThrow(SecretError);
  });

  it("rejects a malformed or truncated blob", () => {
    expect(() => open("not-sealed", master)).toThrow(/malformed/);
    expect(() => open(`v1.${master.id}.aaa.bbb`, master)).toThrow(SecretError);
  });

  it("supports staged rotation via the embedded key id", () => {
    const next = { key: randomBytes(32), id: "" };
    next.id = keyId(next.key);
    const sealed = seal("secret", master);

    expect(sealedKeyId(sealed)).toBe(master.id);
    const rotated = rotate(sealed, master, next);
    expect(sealedKeyId(rotated)).toBe(next.id);
    expect(open(rotated, next)).toBe("secret");
  });

  it("refuses to seal an empty credential", () => {
    expect(() => seal("", master)).toThrow(SecretError);
  });

  it("fingerprints for display without revealing the key", () => {
    expect(fingerprint("sk-ant-admin01-abcdef1234")).toBe("…1234");
    expect(fingerprint("abc")).toBe("…");
  });
});
