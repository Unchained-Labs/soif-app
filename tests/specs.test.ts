import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverSpecRoots,
  listSpecFiles,
  parseWithSpec,
  readPath,
} from "@/lib/scan/local-spec";
import { GEMINI_CLI_SPEC, LOCAL_SCAN_SPECS, QWEN_CODE_SPEC, specFor } from "@/lib/scan/specs";
import { normalizeTokens } from "@/lib/sources/normalize";
import { PROVIDERS, providerSpec } from "@/lib/sources/providers";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "soif-spec-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Fixture built from google-gemini/gemini-cli's own recorder.
 *
 * `recordMessageTokens` writes Google's raw `usageMetadata` straight through:
 *   input   = promptTokenCount        (includes cachedContentTokenCount)
 *   output  = candidatesTokenCount    (excludes thoughtsTokenCount)
 *   cached  = cachedContentTokenCount
 *   thoughts= thoughtsTokenCount
 *   tool    = toolUsePromptTokenCount
 */
function geminiMessage(options: {
  input: number;
  output: number;
  cached?: number;
  thoughts?: number;
  tool?: number;
  model?: string;
  timestamp?: string;
}): string {
  return (
    JSON.stringify({
      id: "msg-1",
      type: "gemini",
      timestamp: options.timestamp ?? "2026-08-01T10:00:00.000Z",
      model: options.model ?? "gemini-2.5-pro",
      content: "…",
      tokens: {
        input: options.input,
        output: options.output,
        cached: options.cached ?? 0,
        thoughts: options.thoughts ?? 0,
        tool: options.tool ?? 0,
        total:
          options.input + options.output + (options.thoughts ?? 0),
      },
    }) + "\n"
  );
}

const GEMINI_META =
  JSON.stringify({ sessionId: "sess-9", projectHash: "abc123", startTime: "2026-08-01T09:59:00Z" }) +
  "\n";

async function writeGeminiSession(root: string, lines: string): Promise<string> {
  const chats = join(root, ".gemini", "tmp", "abc123", "chats");
  await mkdir(chats, { recursive: true });
  const path = join(chats, "session.jsonl");
  await writeFile(path, lines);
  return path;
}

describe("gemini cli spec", () => {
  it("adds thinking tokens to output rather than dropping them", async () => {
    // Google reports candidatesTokenCount WITHOUT thoughtsTokenCount, unlike
    // Anthropic. Not folding them in discards most of the decode cost on a
    // thinking model — which is exactly the model people use Gemini CLI with.
    const path = await writeGeminiSession(
      dir,
      GEMINI_META + geminiMessage({ input: 1000, output: 200, thoughts: 800 }),
    );

    const { rows } = await parseWithSpec(GEMINI_CLI_SPEC, path);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokens.outputTokens).toBe(1000);
    expect(rows[0]!.tokens.reasoningTokens).toBe(800);
  });

  it("treats promptTokenCount as inclusive of cached content", async () => {
    const path = await writeGeminiSession(
      dir,
      GEMINI_META + geminiMessage({ input: 1000, output: 50, cached: 900 }),
    );

    const { rows } = await parseWithSpec(GEMINI_CLI_SPEC, path);
    expect(rows[0]!.tokens.inputTokens).toBe(100);
    expect(rows[0]!.tokens.cachedTokens).toBe(900);
  });

  it("folds tool-use prompt tokens into input", async () => {
    const withTool = await writeGeminiSession(
      dir,
      GEMINI_META + geminiMessage({ input: 500, output: 10, tool: 300 }),
    );
    const { rows } = await parseWithSpec(GEMINI_CLI_SPEC, withTool);
    // toolUsePromptTokenCount is prompt-side work that still had to be prefilled.
    expect(rows[0]!.tokens.inputTokens).toBe(800);
  });

  it("carries session and project forward from the metadata record", async () => {
    const path = await writeGeminiSession(
      dir,
      GEMINI_META + geminiMessage({ input: 10, output: 5 }),
    );
    const { rows } = await parseWithSpec(GEMINI_CLI_SPEC, path);
    expect(rows[0]!.sessionId).toBe("sess-9");
    expect(rows[0]!.project).toBe("abc123");
    expect(rows[0]!.model).toBe("gemini-2.5-pro");
  });

  it("ignores user turns and records with no counts", async () => {
    const path = await writeGeminiSession(
      dir,
      GEMINI_META +
        JSON.stringify({ type: "user", timestamp: "2026-08-01T10:00:00Z", content: "hi" }) +
        "\n" +
        geminiMessage({ input: 0, output: 0 }) +
        geminiMessage({ input: 10, output: 5 }),
    );
    const result = await parseWithSpec(GEMINI_CLI_SPEC, path);
    expect(result.rows).toHaveLength(1);
    expect(result.recordsWithoutUsage).toBeGreaterThan(0);
  });

  it("produces stable dedupe keys so a re-scan inserts nothing", async () => {
    const path = await writeGeminiSession(
      dir,
      GEMINI_META + geminiMessage({ input: 10, output: 5 }) + geminiMessage({ input: 20, output: 6 }),
    );
    const first = await parseWithSpec(GEMINI_CLI_SPEC, path);
    const second = await parseWithSpec(GEMINI_CLI_SPEC, path);
    expect(first.rows.map((r) => r.dedupeKey)).toEqual(second.rows.map((r) => r.dedupeKey));
    expect(new Set(first.rows.map((r) => r.dedupeKey)).size).toBe(2);
  });

  it("resumes from a byte offset without re-reporting earlier rows", async () => {
    const path = await writeGeminiSession(
      dir,
      GEMINI_META + geminiMessage({ input: 10, output: 5 }),
    );
    const first = await parseWithSpec(GEMINI_CLI_SPEC, path);
    expect(first.rows).toHaveLength(1);

    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, geminiMessage({ input: 20, output: 6, timestamp: "2026-08-01T11:00:00Z" }));
    const second = await parseWithSpec(GEMINI_CLI_SPEC, path, {
      offset: first.scan.committedOffset,
    });
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]!.timestamp).toBe("2026-08-01T11:00:00.000Z".replace(".000", ""));
  });

  it("survives a malformed line without abandoning the file", async () => {
    const path = await writeGeminiSession(
      dir,
      GEMINI_META + '{"type":"gemini","tokens":BROKEN\n' + geminiMessage({ input: 10, output: 5 }),
    );
    const result = await parseWithSpec(GEMINI_CLI_SPEC, path);
    expect(result.malformedLines).toBe(1);
    expect(result.rows).toHaveLength(1);
  });

  it("discovers roots under the gemini home", async () => {
    await writeGeminiSession(dir, GEMINI_META + geminiMessage({ input: 10, output: 5 }));
    const roots = await discoverSpecRoots(GEMINI_CLI_SPEC, { home: dir, env: { HOME: dir } });
    expect(roots).toHaveLength(1);
    expect(await listSpecFiles(roots[0]!)).toHaveLength(1);
  });

  it("finds nothing when the tool is not installed", async () => {
    expect(await discoverSpecRoots(GEMINI_CLI_SPEC, { home: dir, env: { HOME: dir } })).toEqual([]);
  });
});

describe("qwen code spec", () => {
  it("reuses the gemini reader against its own home directory", async () => {
    const chats = join(dir, ".qwen", "tmp", "proj", "chats");
    await mkdir(chats, { recursive: true });
    await writeFile(join(chats, "s.jsonl"), GEMINI_META + geminiMessage({ input: 100, output: 20, model: "qwen3-coder" }));

    const roots = await discoverSpecRoots(QWEN_CODE_SPEC, { home: dir, env: { HOME: dir } });
    expect(roots).toHaveLength(1);

    const files = await listSpecFiles(roots[0]!);
    const { rows } = await parseWithSpec(QWEN_CODE_SPEC, files[0]!);
    expect(rows[0]!.model).toBe("qwen3-coder");
  });

  it("shares the gemini field mapping rather than copying it", () => {
    // A copied mapping is a mapping that will drift. These must stay identical.
    expect(QWEN_CODE_SPEC.fields).toEqual(GEMINI_CLI_SPEC.fields);
    expect(QWEN_CODE_SPEC.conventions).toEqual(GEMINI_CLI_SPEC.conventions);
    expect(QWEN_CODE_SPEC.homeDirs).not.toEqual(GEMINI_CLI_SPEC.homeDirs);
  });
});

describe("spec discipline", () => {
  it("requires every spec to name the evidence it was built from", () => {
    // A spec that reads zeros looks exactly like a provider you did not use.
    // Requiring stated evidence is what keeps a plausible guess out of the set.
    for (const spec of LOCAL_SCAN_SPECS) {
      expect(spec.verifiedFrom, `${spec.kind} must declare verifiedFrom`).toBeTruthy();
      expect(spec.verifiedFrom.length).toBeGreaterThan(20);
    }
  });

  it("gives every spec a prefilter and a usage path", () => {
    for (const spec of LOCAL_SCAN_SPECS) {
      expect(spec.prefilter.length, `${spec.kind}`).toBeGreaterThan(0);
      expect(spec.usagePath, `${spec.kind}`).toBeTruthy();
      expect(spec.modelPaths.length, `${spec.kind}`).toBeGreaterThan(0);
      expect(spec.timestampPaths.length, `${spec.kind}`).toBeGreaterThan(0);
    }
  });

  it("registers every spec in the provider catalogue with a verification level", () => {
    for (const spec of LOCAL_SCAN_SPECS) {
      const provider = providerSpec(spec.kind);
      expect(provider.transport).toBe("local");
      expect(provider.status).toBe("available");
      expect(provider.verification, `${spec.kind}`).toBeTruthy();
      // The catalogue and the spec must agree about token semantics, or the
      // dashboard would document one convention while the parser used another.
      expect(provider.inputConvention).toBe(spec.conventions.input);
    }
  });

  it("resolves specs by kind", () => {
    expect(specFor("gemini_cli_local")).toBe(GEMINI_CLI_SPEC);
    expect(specFor("nope")).toBeUndefined();
  });

  it("states a verification level for every available provider", () => {
    for (const provider of PROVIDERS.filter((p) => p.status === "available")) {
      expect(provider.verification, `${provider.kind}`).toBeTruthy();
    }
  });
});

describe("path reading", () => {
  it("walks dotted paths and returns undefined rather than throwing", () => {
    const record = { a: { b: { c: 42 } }, n: null };
    expect(readPath(record, "a.b.c")).toBe(42);
    expect(readPath(record, "a.b.missing")).toBeUndefined();
    expect(readPath(record, "n.deep")).toBeUndefined();
    expect(readPath(record, "nope.nope.nope")).toBeUndefined();
  });
});

describe("reasoning conventions", () => {
  it("keeps thinking inside output for providers that report it that way", () => {
    const tokens = normalizeTokens(
      { output: 1000, reasoning: 800 },
      { input: "disjoint", reasoning: "inside-output" },
    );
    expect(tokens.outputTokens).toBe(1000);
    expect(tokens.reasoningTokens).toBe(800);
  });

  it("adds thinking to output for providers that report it separately", () => {
    const tokens = normalizeTokens(
      { output: 1000, reasoning: 800 },
      { input: "disjoint", reasoning: "separate" },
    );
    expect(tokens.outputTokens).toBe(1800);
    expect(tokens.reasoningTokens).toBe(800);
  });

  it("defaults to inside-output, which is what most providers do", () => {
    expect(normalizeTokens({ output: 100, reasoning: 40 }, "disjoint").outputTokens).toBe(100);
    expect(normalizeTokens({ output: 100, reasoning: 40 }, { input: "disjoint" }).outputTokens).toBe(
      100,
    );
  });
});
