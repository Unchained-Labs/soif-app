import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeTokens, isEmpty, promptTotal } from "@/lib/sources/normalize";
import {
  PROVIDERS,
  localProviders,
  providerSpec,
  vendorFromModel,
} from "@/lib/sources/providers";
import {
  discoverCodexRoots,
  listCodexSessions,
  parseCodexSession,
  readCodexAccount,
} from "@/lib/scan/codex";
import {
  bucketDedupeKey,
  classifyCredential,
  parseUsageResponse,
} from "@/lib/sources/openai-admin";
import { importCsv, parseCsv, parseTimestamp, CsvImportError } from "@/lib/sources/csv";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "soif-prov-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * The single most consequential difference between providers.
 *
 * OpenAI reports `input_tokens` as the whole prompt with cached reads a subset;
 * Anthropic reports them disjoint. soif charges cached reads at 1% and uncached
 * input at 10%, so getting this backwards is a 10x error on the dominant token
 * class of any agentic workload.
 */
describe("token normalization", () => {
  it("leaves disjoint counts alone", () => {
    const tokens = normalizeTokens(
      { input: 100, cacheRead: 900_000, cacheCreation: 5_000, output: 700 },
      "disjoint",
    );
    expect(tokens).toEqual({
      inputTokens: 100,
      cachedTokens: 900_000,
      cacheCreationTokens: 5_000,
      outputTokens: 700,
      reasoningTokens: 0,
    });
  });

  it("subtracts the cached subset under the inclusive convention", () => {
    // OpenAI: input_tokens 1000 INCLUDES the 900 cached ones.
    const tokens = normalizeTokens({ input: 1_000, cacheRead: 900, output: 50 }, "inclusive");
    expect(tokens.inputTokens).toBe(100);
    expect(tokens.cachedTokens).toBe(900);
    // The prompt total is preserved: no token invented, none lost.
    expect(promptTotal(tokens)).toBe(1_000);
  });

  it("would otherwise inflate an agentic workload tenfold", () => {
    // The failure this guards: treating OpenAI's inclusive input as disjoint.
    const raw = { input: 1_000_000, cacheRead: 990_000, output: 1_000 };
    const correct = normalizeTokens(raw, "inclusive");
    const wrong = normalizeTokens(raw, "disjoint");
    expect(correct.inputTokens).toBe(10_000);
    expect(wrong.inputTokens).toBe(1_000_000);
    expect(promptTotal(wrong)).toBe(promptTotal(correct) + 990_000);
  });

  it("subtracts cache writes out of what remains after cache reads", () => {
    const tokens = normalizeTokens(
      { input: 1_000, cacheRead: 600, cacheCreation: 300, output: 10 },
      "inclusive",
    );
    expect(tokens).toMatchObject({
      inputTokens: 100,
      cachedTokens: 600,
      cacheCreationTokens: 300,
    });
    expect(promptTotal(tokens)).toBe(1_000);
  });

  it("clamps a cached count larger than the prompt rather than going negative", () => {
    const tokens = normalizeTokens({ input: 100, cacheRead: 500, output: 5 }, "inclusive");
    expect(tokens.inputTokens).toBe(0);
    expect(tokens.cachedTokens).toBe(100);
  });

  it("clamps reasoning tokens to the output they live inside", () => {
    const tokens = normalizeTokens({ output: 100, reasoning: 500 }, "disjoint");
    expect(tokens.reasoningTokens).toBe(100);
  });

  it("ignores negative, fractional and non-numeric junk", () => {
    const tokens = normalizeTokens(
      { input: -5, cacheRead: 10.7, output: Number.NaN } as never,
      "disjoint",
    );
    expect(tokens.inputTokens).toBe(0);
    expect(tokens.cachedTokens).toBe(10);
    expect(tokens.outputTokens).toBe(0);
    expect(isEmpty(normalizeTokens({}, "disjoint"))).toBe(true);
  });
});

describe("provider catalogue", () => {
  it("declares the input convention for every provider", () => {
    for (const spec of PROVIDERS) {
      expect(["disjoint", "inclusive"]).toContain(spec.inputConvention);
    }
  });

  it("gets the two conventions the right way round", () => {
    // These four are the ones a mistake would actually cost.
    expect(providerSpec("claude_code_local").inputConvention).toBe("disjoint");
    expect(providerSpec("anthropic_admin").inputConvention).toBe("disjoint");
    expect(providerSpec("codex_local").inputConvention).toBe("inclusive");
    expect(providerSpec("openai_admin").inputConvention).toBe("inclusive");
  });

  it("covers more than one vendor, which is the point", () => {
    const vendors = new Set(PROVIDERS.filter((p) => p.status === "available").map((p) => p.vendor));
    expect(vendors.has("anthropic")).toBe(true);
    expect(vendors.has("openai")).toBe(true);
    expect(vendors.size).toBeGreaterThanOrEqual(3);
  });

  it("lists exactly the credential-free sources as local", () => {
    const kinds = localProviders().map((p) => p.kind).sort();
    expect(kinds).toEqual(["claude_code_local", "codex_local"]);
  });

  it("maps model names to vendors, and refuses to guess", () => {
    expect(vendorFromModel("claude-opus-5")).toBe("anthropic");
    expect(vendorFromModel("gpt-5.5")).toBe("openai");
    expect(vendorFromModel("openai/gpt-5.5")).toBe("openai");
    expect(vendorFromModel("o3-mini")).toBe("openai");
    expect(vendorFromModel("gemini-2.5-pro")).toBe("google");
    expect(vendorFromModel("grok-4")).toBe("xai");
    expect(vendorFromModel("mistral-large")).toBe("mistral");
    expect(vendorFromModel("deepseek-v3")).toBe("deepseek");
    expect(vendorFromModel("some-local-finetune")).toBe("other");
  });

  it("throws on an unknown source kind rather than returning a default", () => {
    expect(() => providerSpec("nope" as never)).toThrow(/unknown source kind/);
  });
});

/** Rollout shape taken from a real Codex fixture, not from memory. */
function codexSession(lines: string[]): string {
  return lines.map((l) => `${l}\n`).join("");
}

const META = JSON.stringify({
  type: "session_meta",
  timestamp: "2026-07-11T12:00:00Z",
  payload: { id: "sess-1", cwd: "/home/dev/project-a" },
});
const CONTEXT = JSON.stringify({
  type: "turn_context",
  timestamp: "2026-07-11T12:00:00Z",
  payload: { model: "openai/gpt-5.5" },
});

function tokenCount(last: object | null, total: object | null, timestamp: string): string {
  const info: Record<string, unknown> = { model: "openai/gpt-5.5" };
  if (last) info.last_token_usage = last;
  if (total) info.total_token_usage = total;
  return JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: { type: "token_count", info },
  });
}

describe("codex rollout parsing", () => {
  it("reads per-turn deltas rather than summing cumulative totals", async () => {
    const path = join(dir, "s.jsonl");
    // Three turns; totals are cumulative, deltas are not.
    await writeFile(
      path,
      codexSession([
        META,
        CONTEXT,
        tokenCount(
          { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 },
          { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 },
          "2026-07-11T12:00:01Z",
        ),
        tokenCount(
          { input_tokens: 200, cached_input_tokens: 100, output_tokens: 20 },
          { input_tokens: 300, cached_input_tokens: 100, output_tokens: 30 },
          "2026-07-11T12:00:02Z",
        ),
      ]),
    );

    const { rows } = await parseCodexSession(path);
    expect(rows).toHaveLength(2);
    // Summing the cumulative totals would give 400 input; the truth is 300.
    const totalPrompt = rows.reduce(
      (a, r) => a + r.tokens.inputTokens + r.tokens.cachedTokens,
      0,
    );
    expect(totalPrompt).toBe(300);
    expect(rows.reduce((a, r) => a + r.tokens.outputTokens, 0)).toBe(30);
  });

  it("applies the inclusive convention to codex counts", async () => {
    const path = join(dir, "s.jsonl");
    await writeFile(
      path,
      codexSession([
        META,
        CONTEXT,
        tokenCount(
          { input_tokens: 1_000, cached_input_tokens: 900, output_tokens: 50 },
          null,
          "2026-07-11T12:00:01Z",
        ),
      ]),
    );

    const { rows } = await parseCodexSession(path);
    expect(rows[0]!.tokens.inputTokens).toBe(100);
    expect(rows[0]!.tokens.cachedTokens).toBe(900);
  });

  it("falls back to the final cumulative total when no delta was reported", async () => {
    const path = join(dir, "s.jsonl");
    await writeFile(
      path,
      codexSession([
        META,
        CONTEXT,
        tokenCount(null, { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 }, "2026-07-11T12:00:01Z"),
        tokenCount(null, { input_tokens: 300, cached_input_tokens: 0, output_tokens: 30 }, "2026-07-11T12:00:02Z"),
      ]),
    );

    const { rows } = await parseCodexSession(path);
    // One row carrying the last total, not two rows summing to 400.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fromSessionTotal).toBe(true);
    expect(rows[0]!.tokens.inputTokens).toBe(300);
  });

  it("carries the model forward from turn_context", async () => {
    const path = join(dir, "s.jsonl");
    await writeFile(
      path,
      codexSession([
        META,
        CONTEXT,
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-07-11T12:00:01Z",
          payload: {
            type: "token_count",
            info: { last_token_usage: { input_tokens: 10, output_tokens: 1 } },
          },
        }),
      ]),
    );

    const { rows, unknownModelEvents } = await parseCodexSession(path);
    expect(unknownModelEvents).toBe(0);
    expect(rows[0]!.model).toBe("openai/gpt-5.5");
  });

  it("counts usage events it cannot attribute to a model instead of dropping them silently", async () => {
    const path = join(dir, "s.jsonl");
    await writeFile(
      path,
      codexSession([
        META,
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-07-11T12:00:01Z",
          payload: {
            type: "token_count",
            info: { last_token_usage: { input_tokens: 10, output_tokens: 1 } },
          },
        }),
      ]),
    );

    const { rows, unknownModelEvents } = await parseCodexSession(path);
    expect(rows).toHaveLength(0);
    expect(unknownModelEvents).toBe(1);
  });

  it("captures the session cwd as the project", async () => {
    const path = join(dir, "s.jsonl");
    await writeFile(
      path,
      codexSession([
        META,
        CONTEXT,
        tokenCount({ input_tokens: 10, output_tokens: 1 }, null, "2026-07-11T12:00:01Z"),
      ]),
    );
    const { rows } = await parseCodexSession(path);
    expect(rows[0]!.project).toBe("/home/dev/project-a");
    expect(rows[0]!.sessionId).toBe("sess-1");
  });

  it("produces stable dedupe keys so a re-scan inserts nothing", async () => {
    const path = join(dir, "s.jsonl");
    await writeFile(
      path,
      codexSession([
        META,
        CONTEXT,
        tokenCount({ input_tokens: 10, output_tokens: 1 }, null, "2026-07-11T12:00:01Z"),
        tokenCount({ input_tokens: 20, output_tokens: 2 }, null, "2026-07-11T12:00:02Z"),
      ]),
    );
    const first = await parseCodexSession(path);
    const second = await parseCodexSession(path);
    expect(first.rows.map((r) => r.dedupeKey)).toEqual(second.rows.map((r) => r.dedupeKey));
    expect(new Set(first.rows.map((r) => r.dedupeKey)).size).toBe(2);
  });

  it("discovers codex homes and reads only the non-secret account fields", async () => {
    const codexHome = join(dir, ".codex");
    await mkdir(join(codexHome, "sessions", "2026", "07", "11"), { recursive: true });
    await writeFile(
      join(codexHome, "auth.json"),
      JSON.stringify({
        account_id: "acct-123",
        tokens: {
          id_token: { email: "dev@example.com", chatgpt_plan_type: "pro" },
          access_token: "SHOULD-NEVER-BE-READ",
          refresh_token: "ALSO-NEVER",
        },
      }),
    );
    await writeFile(join(codexHome, "sessions", "2026", "07", "11", "s.jsonl"), "");

    const roots = await discoverCodexRoots({ home: dir, env: { HOME: dir } });
    expect(roots).toHaveLength(1);
    expect(roots[0]!.account).toEqual({
      accountId: "acct-123",
      email: "dev@example.com",
      plan: "pro",
    });
    expect(JSON.stringify(roots[0]!.account)).not.toContain("NEVER");

    const identity = await readCodexAccount(codexHome);
    expect(JSON.stringify(identity)).not.toMatch(/token/i);
  });

  it("finds both live and archived sessions", async () => {
    const codexHome = join(dir, ".codex");
    await mkdir(join(codexHome, "sessions", "2026", "07", "11"), { recursive: true });
    await mkdir(join(codexHome, "archived_sessions"), { recursive: true });
    await writeFile(join(codexHome, "sessions", "2026", "07", "11", "live.jsonl"), "");
    await writeFile(join(codexHome, "archived_sessions", "old.jsonl"), "");

    const files = await listCodexSessions(codexHome);
    expect(files).toHaveLength(2);
  });

  it("ignores a codex home with no session directories", async () => {
    await mkdir(join(dir, ".codex"), { recursive: true });
    expect(await discoverCodexRoots({ home: dir, env: { HOME: dir } })).toEqual([]);
  });
});

describe("openai usage api", () => {
  it("parses a usage response and subtracts the cached subset", () => {
    const page = parseUsageResponse({
      data: [
        {
          start_time: 1_767_225_600,
          end_time: 1_767_312_000,
          results: [
            {
              model: "gpt-5.5",
              input_tokens: 1_000,
              input_cached_tokens: 900,
              output_tokens: 50,
              num_model_requests: 3,
              project_id: "proj_a",
            },
          ],
        },
      ],
      has_more: true,
      next_page: "page_2",
    });

    expect(page.buckets).toHaveLength(1);
    expect(page.buckets[0]!.tokens.inputTokens).toBe(100);
    expect(page.buckets[0]!.tokens.cachedTokens).toBe(900);
    expect(page.buckets[0]!.requests).toBe(3);
    expect(page.hasMore).toBe(true);
  });

  it("keys buckets on every field the API can split on", () => {
    const base = {
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-01-02T00:00:00.000Z",
      model: "gpt-5.5",
      projectId: "proj_a",
      apiKeyId: null,
      batch: false,
      serviceTier: "default",
      tokens: normalizeTokens({ input: 10, output: 1 }, "inclusive"),
      requests: 1,
    };
    // Two projects must not collapse into one row.
    expect(bucketDedupeKey(base)).not.toBe(bucketDedupeKey({ ...base, projectId: "proj_b" }));
    expect(bucketDedupeKey(base)).not.toBe(bucketDedupeKey({ ...base, serviceTier: "flex" }));
    expect(bucketDedupeKey(base)).toBe(bucketDedupeKey({ ...base, requests: 99 }));
  });

  it("drops all-zero rows and survives malformed buckets", () => {
    const page = parseUsageResponse({
      data: [{ start_time: 1, results: [{ model: "gpt-5.5" }] }, null, { results: [] }],
    });
    expect(page.buckets).toEqual([]);
  });

  it("classifies credentials without pretending to be certain", () => {
    expect(classifyCredential("sk-admin-abc")).toBe("admin");
    expect(classifyCredential("sk-proj-abc")).toBe("project");
    expect(classifyCredential("nonsense")).toBe("unknown");
  });
});

describe("csv import", () => {
  const sourceId = "src-1";

  it("imports an Anthropic-shaped export", () => {
    const csv = [
      "date,model,input_tokens,cache_read_input_tokens,cache_creation_input_tokens,output_tokens",
      "2026-08-01,claude-sonnet-4-5,100,900000,5000,700",
      "2026-08-02,claude-opus-4,50,10000,0,300",
    ].join("\n");

    const result = importCsv(csv, { sourceId });
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      model: "claude-sonnet-4-5",
      inputTokens: 100,
      cachedTokens: 900_000,
      cacheCreationTokens: 5_000,
      outputTokens: 700,
      dayKey: "2026-08-01",
    });
    expect(result.vendors).toEqual(["anthropic"]);
  });

  it("imports an OpenAI-shaped export under the inclusive convention", () => {
    const csv = ["date,model,input_tokens,input_cached_tokens,output_tokens", "2026-08-01,gpt-5.5,1000,900,50"].join(
      "\n",
    );
    const result = importCsv(csv, { sourceId, inputConvention: "inclusive" });
    expect(result.records[0]).toMatchObject({ inputTokens: 100, cachedTokens: 900 });
    expect(result.vendors).toEqual(["openai"]);
  });

  it("covers several vendors in one file, which is the whole point", () => {
    const csv = [
      "date,model,input_tokens,output_tokens",
      "2026-08-01,claude-opus-5,10,5",
      "2026-08-01,gpt-5.5,10,5",
      "2026-08-01,gemini-2.5-pro,10,5",
      "2026-08-01,mistral-large,10,5",
    ].join("\n");
    const result = importCsv(csv, { sourceId });
    expect(result.records).toHaveLength(4);
    expect(result.vendors).toEqual(["anthropic", "google", "mistral", "openai"]);
  });

  it("tolerates header naming variations", () => {
    const csv = ['Timestamp,"Model Name",Prompt Tokens,Completion Tokens', "2026-08-01,gpt-4o,10,5"].join("\n");
    const result = importCsv(csv, { sourceId });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.inputTokens).toBe(10);
    expect(result.records[0]!.outputTokens).toBe(5);
  });

  it("prefers the more specific column when both could match", () => {
    const csv = ["date,model,input_tokens,uncached_input_tokens,output_tokens", "2026-08-01,gpt-4o,999,10,5"].join(
      "\n",
    );
    const result = importCsv(csv, { sourceId });
    // `uncached_input_tokens` is unambiguous; `input_tokens` is not.
    expect(result.records[0]!.inputTokens).toBe(10);
  });

  it("reports skipped rows rather than losing them silently", () => {
    const csv = [
      "date,model,input_tokens,output_tokens",
      "2026-08-01,gpt-4o,10,5",
      "not-a-date,gpt-4o,10,5",
      "2026-08-02,gpt-4o,0,0",
    ].join("\n");
    const result = importCsv(csv, { sourceId });
    expect(result.records).toHaveLength(1);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0]!.reason).toMatch(/timestamp/);
    expect(result.skipped[1]!.reason).toMatch(/zero/);
  });

  it("refuses a file with no timestamp column instead of inventing one", () => {
    expect(() => importCsv("model,tokens\ngpt-4o,10", { sourceId })).toThrow(CsvImportError);
    expect(() => importCsv("model,tokens\ngpt-4o,10", { sourceId })).toThrow(/timestamp/);
  });

  it("produces stable dedupe keys so re-importing the same file adds nothing", () => {
    const csv = ["date,model,input_tokens,output_tokens", "2026-08-01,gpt-4o,10,5"].join("\n");
    const a = importCsv(csv, { sourceId });
    const b = importCsv(csv, { sourceId });
    expect(a.records[0]!.dedupeKey).toBe(b.records[0]!.dedupeKey);
  });

  it("handles quoted fields, escaped quotes and embedded newlines", () => {
    const rows = parseCsv('a,"b,c","d""e"\n1,"multi\nline",3\n');
    expect(rows[0]).toEqual(["a", "b,c", 'd"e']);
    expect(rows[1]).toEqual(["1", "multi\nline", "3"]);
  });

  it("strips a spreadsheet BOM so the first header still matches", () => {
    const result = importCsv("﻿date,model,output_tokens\n2026-08-01,gpt-4o,5", { sourceId });
    expect(result.records).toHaveLength(1);
  });

  it("reads bare dates as UTC so an import does not shift by a day", () => {
    expect(parseTimestamp("2026-08-01")!.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(parseTimestamp("1767225600")!.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(parseTimestamp("1767225600000")!.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    // Ambiguous digit counts are refused rather than landing in 1970.
    expect(parseTimestamp("12345")).toBeNull();
    expect(parseTimestamp("")).toBeNull();
  });
});
