import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanJsonl } from "@/lib/scan/jsonl";
import { parseTranscript, reconcileRows, utcDayKey } from "@/lib/scan/claude";
import { discoverRoots, listTranscripts, readAccountIdentity } from "@/lib/scan/roots";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "soif-scan-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Build an assistant transcript line with the real Claude Code shape. */
function assistantLine(options: {
  id: string;
  requestId: string;
  model?: string;
  input?: number;
  cacheRead?: number;
  cacheCreation?: number;
  output?: number;
  thinking?: number;
  timestamp?: string;
  isSidechain?: boolean;
  geo?: string;
  iterations?: Array<Record<string, number>>;
}): string {
  const usage: Record<string, unknown> = {
    input_tokens: options.input ?? 0,
    cache_creation_input_tokens: options.cacheCreation ?? 0,
    cache_read_input_tokens: options.cacheRead ?? 0,
    output_tokens: options.output ?? 0,
    output_tokens_details: { thinking_tokens: options.thinking ?? 0 },
    service_tier: "standard",
    inference_geo: options.geo ?? "not_available",
  };
  if (options.iterations) usage.iterations = options.iterations;
  return (
    JSON.stringify({
      type: "assistant",
      timestamp: options.timestamp ?? "2026-08-20T14:29:22.753Z",
      requestId: options.requestId,
      sessionId: "session-1",
      isSidechain: options.isSidechain ?? false,
      message: { id: options.id, role: "assistant", model: options.model ?? "claude-opus-5", usage },
    }) + "\n"
  );
}

const userLine = JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n";

describe("scanJsonl", () => {
  it("only commits offsets past complete lines", async () => {
    const path = join(dir, "t.jsonl");
    await writeFile(path, '{"a":1}\n{"b":2}\n{"c":3'); // trailing line has no newline

    const seen: string[] = [];
    const result = await scanJsonl(path, (line) => seen.push(line.bytes.toString()));

    expect(seen).toEqual(['{"a":1}', '{"b":2}']);
    // The partial `{"c":3` must not be committed, or appending its remainder
    // later would leave the record permanently unread.
    expect(result.committedOffset).toBe(16);
    expect(result.readOffset).toBe(22);
  });

  it("resumes from a committed offset and reads only the delta", async () => {
    const path = join(dir, "t.jsonl");
    await writeFile(path, '{"a":1}\n{"b":2}\n');

    const first = await scanJsonl(path, () => {});
    expect(first.linesRead).toBe(2);

    await appendFile(path, '{"c":3}\n');
    const seen: string[] = [];
    const second = await scanJsonl(path, (l) => seen.push(l.bytes.toString()), {
      offset: first.committedOffset,
    });

    expect(seen).toEqual(['{"c":3}']);
    expect(second.linesRead).toBe(1);
  });

  it("completes a line split across a chunk boundary", async () => {
    const path = join(dir, "t.jsonl");
    // Comfortably larger than the 1 MiB read chunk, so the line spans reads.
    const big = "x".repeat(1_500_000);
    await writeFile(path, `{"v":"${big}"}\n{"tail":1}\n`);

    const lengths: number[] = [];
    const result = await scanJsonl(path, (l) => lengths.push(l.bytes.length), {
      maxLineBytes: 4_000_000,
    });

    expect(lengths).toHaveLength(2);
    expect(lengths[0]).toBe(big.length + 8);
    expect(result.linesSkippedTooLong).toBe(0);
  });

  it("skips an oversized line and counts it rather than dropping it silently", async () => {
    const path = join(dir, "t.jsonl");
    await writeFile(path, `{"v":"${"x".repeat(5000)}"}\n{"small":1}\n`);

    const seen: string[] = [];
    const result = await scanJsonl(path, (l) => seen.push(l.bytes.toString()), {
      maxLineBytes: 1000,
    });

    expect(seen).toEqual(['{"small":1}']);
    expect(result.linesSkippedTooLong).toBe(1);
    // The skipped line must still advance the cursor, or every rescan re-skips it.
    expect(result.committedOffset).toBe(result.readOffset);
  });

  it("distinguishes a harmless oversized skip from a possible usage loss", async () => {
    const path = join(dir, "t.jsonl");
    const filler = "x".repeat(5000);
    // A giant tool result (no usage record) followed by a giant assistant line.
    const toolResult = JSON.stringify({ type: "user", content: filler });
    const giantAssistant = JSON.stringify({
      type: "assistant",
      message: { model: "m", usage: { output_tokens: 1 }, content: filler },
    });
    await writeFile(path, `${toolResult}\n${giantAssistant}\n`);

    const result = await scanJsonl(path, () => {}, {
      maxLineBytes: 1000,
      requireAll: ['"type":"assistant"', '"usage"'],
    });

    expect(result.linesSkippedTooLong).toBe(2);
    // Only the assistant line should raise the alarm; counting both would make
    // the metric useless, and counting neither would hide a real loss.
    expect(result.linesSkippedPossiblyRelevant).toBe(1);
  });

  it("applies the byte prefilter before the caller sees a line", async () => {
    const path = join(dir, "t.jsonl");
    await writeFile(path, `${userLine}${assistantLine({ id: "m1", requestId: "r1", output: 5 })}`);

    const seen: string[] = [];
    await scanJsonl(path, (l) => seen.push(l.bytes.toString()), {
      requireAll: ['"type":"assistant"', '"usage"'],
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('"assistant"');
  });

  it("returns cleanly when the cursor is already at EOF", async () => {
    const path = join(dir, "t.jsonl");
    await writeFile(path, '{"a":1}\n');
    const result = await scanJsonl(path, () => {}, { offset: 8 });
    expect(result.linesRead).toBe(0);
    expect(result.committedOffset).toBe(8);
  });

  it("clamps the cursor when a file shrank beneath it", async () => {
    const path = join(dir, "t.jsonl");
    await writeFile(path, '{"a":1}\n');
    const result = await scanJsonl(path, () => {}, { offset: 9_999 });
    expect(result.committedOffset).toBe(8);
  });
});

describe("parseTranscript", () => {
  it("keeps the last of several cumulative streaming chunks", async () => {
    const path = join(dir, "t.jsonl");
    // Same message.id + requestId three times, counts growing cumulatively.
    await writeFile(
      path,
      assistantLine({ id: "m1", requestId: "r1", output: 10 }) +
        assistantLine({ id: "m1", requestId: "r1", output: 120 }) +
        assistantLine({ id: "m1", requestId: "r1", output: 333, cacheRead: 994_232 }),
    );

    const { rows } = await parseTranscript(path);

    expect(rows).toHaveLength(1);
    // Summing would give 463 output tokens for a 333-token response.
    expect(rows[0]!.outputTokens).toBe(333);
    expect(rows[0]!.cachedTokens).toBe(994_232);
  });

  it("keeps id-less rows distinct instead of collapsing them", async () => {
    const path = join(dir, "t.jsonl");
    const legacy = JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-20T10:00:00.000Z",
      message: { model: "claude-sonnet-4-5", usage: { output_tokens: 50 } },
    });
    await writeFile(path, `${legacy}\n${legacy}\n`);

    const { rows } = await parseTranscript(path);

    // Dropping real usage is worse than a rare double-count.
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.dedupeKey === null)).toBe(true);
  });

  it("records thinking tokens without adding them to output", async () => {
    const path = join(dir, "t.jsonl");
    await writeFile(path, assistantLine({ id: "m1", requestId: "r1", output: 500, thinking: 300 }));

    const { rows } = await parseTranscript(path);

    // The API already counts thinking inside output_tokens. Adding them again
    // would inflate the frontier-tier energy term by 60% on this row.
    expect(rows[0]!.outputTokens).toBe(500);
    expect(rows[0]!.reasoningTokens).toBe(300);
  });

  it("falls back to iterations[] when top-level counts are all zero", async () => {
    const path = join(dir, "t.jsonl");
    await writeFile(
      path,
      assistantLine({
        id: "m1",
        requestId: "r1",
        iterations: [
          { input_tokens: 2, output_tokens: 333, cache_read_input_tokens: 994_232 },
          { input_tokens: 1, output_tokens: 17, cache_read_input_tokens: 0 },
        ],
      }),
    );

    const { rows } = await parseTranscript(path);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.outputTokens).toBe(350);
    expect(rows[0]!.cachedTokens).toBe(994_232);
    expect(rows[0]!.fromIterations).toBe(true);
  });

  it("prefers top-level counts over iterations when both are present", async () => {
    const path = join(dir, "t.jsonl");
    await writeFile(
      path,
      assistantLine({
        id: "m1",
        requestId: "r1",
        output: 350,
        iterations: [{ output_tokens: 333 }],
      }),
    );

    const { rows } = await parseTranscript(path);
    // Top level is cumulative and never under-reports; iterations are a subset.
    expect(rows[0]!.outputTokens).toBe(350);
    expect(rows[0]!.fromIterations).toBe(false);
  });

  it("skips lines with no usable counts at all", async () => {
    const path = join(dir, "t.jsonl");
    await writeFile(path, assistantLine({ id: "m1", requestId: "r1" }));

    const result = await parseTranscript(path);
    expect(result.rows).toHaveLength(0);
    expect(result.emptyUsageLines).toBe(1);
  });

  it("captures inference geo and service tier when the transcript reports them", async () => {
    const path = join(dir, "t.jsonl");
    await writeFile(path, assistantLine({ id: "m1", requestId: "r1", output: 5, geo: "us" }));

    const { rows } = await parseTranscript(path);
    expect(rows[0]!.inferenceGeo).toBe("us");
    expect(rows[0]!.serviceTier).toBe("standard");
  });

  it("survives a malformed line without abandoning the file", async () => {
    const path = join(dir, "t.jsonl");
    await writeFile(
      path,
      `{"type":"assistant","usage":BROKEN\n${assistantLine({ id: "m1", requestId: "r1", output: 7 })}`,
    );

    const result = await parseTranscript(path);
    expect(result.malformedLines).toBe(1);
    expect(result.rows).toHaveLength(1);
  });

  it("resumes mid-file without re-reporting earlier rows", async () => {
    const path = join(dir, "t.jsonl");
    await writeFile(path, assistantLine({ id: "m1", requestId: "r1", output: 10 }));

    const first = await parseTranscript(path);
    expect(first.rows).toHaveLength(1);

    await appendFile(path, assistantLine({ id: "m2", requestId: "r2", output: 20 }));
    const second = await parseTranscript(path, { offset: first.scan.committedOffset });

    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]!.messageId).toBe("m2");
  });

  it("labels transcripts under a subagents/ path", async () => {
    const nested = join(dir, "subagents");
    await mkdir(nested, { recursive: true });
    const path = join(nested, "t.jsonl");
    await writeFile(path, assistantLine({ id: "m1", requestId: "r1", output: 5 }));

    const { rows } = await parseTranscript(path);
    expect(rows[0]!.pathRole).toBe("subagent");
  });
});

describe("reconcileRows", () => {
  it("collapses the same message appearing in two files", async () => {
    const parent = join(dir, "parent.jsonl");
    const subdir = join(dir, "subagents");
    await mkdir(subdir, { recursive: true });
    const child = join(subdir, "child.jsonl");

    const line = assistantLine({ id: "m1", requestId: "r1", output: 333, cacheRead: 500_000 });
    await writeFile(parent, line);
    await writeFile(child, line);

    const a = await parseTranscript(parent);
    const b = await parseTranscript(child);
    const reconciled = reconcileRows([...a.rows, ...b.rows]);

    // Without this, every subagent message is counted twice — the error grows
    // with exactly the fan-out that makes agentic usage expensive.
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]!.pathRole).toBe("subagent");
    expect(reconciled[0]!.outputTokens).toBe(333);
  });

  it("is order-independent", async () => {
    const parent = join(dir, "parent.jsonl");
    const subdir = join(dir, "subagents");
    await mkdir(subdir, { recursive: true });
    const child = join(subdir, "child.jsonl");
    const line = assistantLine({ id: "m1", requestId: "r1", output: 42 });
    await writeFile(parent, line);
    await writeFile(child, line);

    const a = (await parseTranscript(parent)).rows;
    const b = (await parseTranscript(child)).rows;

    expect(reconcileRows([...a, ...b])).toEqual(reconcileRows([...b, ...a]));
  });

  it("never merges unkeyed rows", async () => {
    const path = join(dir, "t.jsonl");
    const legacy =
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-20T10:00:00.000Z",
        message: { model: "claude-sonnet-4-5", usage: { output_tokens: 50 } },
      }) + "\n";
    await writeFile(path, legacy.repeat(3));

    const { rows } = await parseTranscript(path);
    expect(reconcileRows(rows)).toHaveLength(3);
  });
});

describe("utcDayKey", () => {
  it("buckets by UTC, not local time", () => {
    expect(utcDayKey("2026-08-20T14:29:22.753Z")).toBe("2026-08-20");
    // 23:30 UTC-5 is the next UTC day; local bucketing would file it a day early.
    expect(utcDayKey("2026-08-20T23:30:00-05:00")).toBe("2026-08-21");
  });

  it("returns null for an unparseable timestamp", () => {
    expect(utcDayKey("not a date")).toBeNull();
  });
});

describe("root discovery", () => {
  it("finds every configured root and dedupes overlapping ones", async () => {
    const home = join(dir, "home");
    const alt = join(dir, "alt-account");
    await mkdir(join(home, ".claude", "projects"), { recursive: true });
    await mkdir(join(alt, "projects"), { recursive: true });

    const roots = await discoverRoots({
      home,
      // The same path listed twice, plus the default that resolves to one of them.
      env: { HOME: home, CLAUDE_CONFIG_DIR: `${alt}:${alt}:${join(home, ".claude")}` },
    });

    expect(roots.map((r) => r.path)).toEqual([
      join(alt, "projects"),
      join(home, ".claude", "projects"),
    ]);
    expect(roots[0]!.origin).toBe("CLAUDE_CONFIG_DIR");
  });

  it("still probes the default root when CLAUDE_CONFIG_DIR is set", async () => {
    // An operator who added a second account still has history under the first.
    const home = join(dir, "home");
    const alt = join(dir, "alt");
    await mkdir(join(home, ".claude", "projects"), { recursive: true });
    await mkdir(join(alt, "projects"), { recursive: true });

    const roots = await discoverRoots({ home, env: { HOME: home, CLAUDE_CONFIG_DIR: alt } });
    expect(roots).toHaveLength(2);
  });

  it("ignores roots that do not exist", async () => {
    const home = join(dir, "empty-home");
    await mkdir(home, { recursive: true });
    expect(await discoverRoots({ home, env: { HOME: home } })).toEqual([]);
  });

  it("accepts an explicit root pointing at either the config or projects dir", async () => {
    const config = join(dir, "acct");
    await mkdir(join(config, "projects"), { recursive: true });

    const viaConfig = await discoverRoots({ explicit: [config], home: dir, env: {} });
    const viaProjects = await discoverRoots({ explicit: [join(config, "projects")], home: dir, env: {} });

    expect(viaConfig.map((r) => r.path)).toEqual([join(config, "projects")]);
    expect(viaProjects.map((r) => r.path)).toEqual([join(config, "projects")]);
  });

  it("reads the non-secret account label and no credentials", async () => {
    const config = join(dir, "acct");
    await mkdir(join(config, "projects"), { recursive: true });
    await writeFile(
      join(config, ".claude.json"),
      JSON.stringify({
        oauthAccount: {
          accountUuid: "acct-uuid",
          emailAddress: "dev@example.com",
          organizationName: "Acme Labs",
        },
        // Anything token-shaped in this file must never be lifted.
        accessToken: "sk-ant-oat-SHOULD-NEVER-BE-READ",
      }),
    );

    const identity = await readAccountIdentity(config);
    expect(identity).toEqual({
      accountUuid: "acct-uuid",
      emailAddress: "dev@example.com",
      organizationUuid: undefined,
      organizationName: "Acme Labs",
    });
    expect(JSON.stringify(identity)).not.toContain("sk-ant");
  });

  it("treats an unreadable .claude.json as simply unattributed", async () => {
    const config = join(dir, "acct");
    await mkdir(config, { recursive: true });
    await writeFile(join(config, ".claude.json"), "{ not json");
    expect(await readAccountIdentity(config)).toBeUndefined();
  });

  it("lists transcripts recursively in a stable order", async () => {
    const root = join(dir, "projects");
    await mkdir(join(root, "proj-a", "subagents"), { recursive: true });
    await mkdir(join(root, "proj-b"), { recursive: true });
    await writeFile(join(root, "proj-a", "one.jsonl"), "");
    await writeFile(join(root, "proj-a", "subagents", "two.jsonl"), "");
    await writeFile(join(root, "proj-b", "three.jsonl"), "");
    await writeFile(join(root, "proj-b", "notes.md"), "ignore me");

    const found = await listTranscripts(root);
    expect(found).toEqual([
      join(root, "proj-a", "one.jsonl"),
      join(root, "proj-a", "subagents", "two.jsonl"),
      join(root, "proj-b", "three.jsonl"),
    ]);
  });
});
