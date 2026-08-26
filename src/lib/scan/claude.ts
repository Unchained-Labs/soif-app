import { scanJsonl, type ScanResult } from "./jsonl";

/**
 * Parsing Claude Code transcripts into usage rows.
 *
 * The record we care about is an `assistant` line whose `message.usage` carries
 * the four token counts. Everything else in a transcript — user turns, tool
 * results, thinking blocks — is skipped by a byte prefilter before the JSON
 * parser ever runs.
 *
 * Three rules earn their keep, all learned from steipete/CodexBar's scanner:
 *
 *  1. **Streaming chunks repeat.** A single response emits several lines that
 *     share `message.id` + `requestId`, each carrying *cumulative* counts. Last
 *     write wins; summing them multiplies the real usage.
 *  2. **Subagent transcripts duplicate parent rows.** The same logical message
 *     can appear in both a parent transcript and a subagent one. Deduping
 *     across files on the same key is what stops agentic fan-out being counted
 *     twice.
 *  3. **Older logs omit the ids.** Those rows are kept as distinct rather than
 *     collapsed under a shared null key, because dropping real usage is a worse
 *     error than a rare double-count.
 *
 * One divergence from CodexBar, measured against a real corpus: on a small
 * fraction of lines (~0.08%) the top-level `usage` counts are all zero while a
 * nested `usage.iterations[]` array carries the real numbers. Top-level stays
 * authoritative — it is cumulative and never *under*-reports — but we fall back
 * to the iteration sum rather than discarding the row.
 */

/** Only lines containing all of these are parsed. Order is irrelevant; both must appear. */
const PREFILTER = ['"type":"assistant"', '"usage"'] as const;

export interface ClaudeUsageRow {
  /** `${messageId}:${requestId}` when both exist, else null (row is unkeyed). */
  dedupeKey: string | null;
  timestamp: string;
  /** UTC day, `YYYY-MM-DD`. */
  dayKey: string;
  model: string;
  sessionId: string | null;
  messageId: string | null;
  requestId: string | null;
  inputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  /** Thinking tokens, already *included* in `outputTokens` — recorded, never added. */
  reasoningTokens: number;
  /** `us` | `global` | `not_available` when the transcript reports it. */
  inferenceGeo: string | null;
  serviceTier: string | null;
  isSidechain: boolean;
  /** Transcripts under a `subagents/` path win ties against parent transcripts. */
  pathRole: "parent" | "subagent";
  sourceFile: string;
  /** True when the counts came from `usage.iterations[]` rather than top level. */
  fromIterations: boolean;
}

export interface ParseFileResult {
  rows: ClaudeUsageRow[];
  scan: ScanResult;
  /** Lines that looked like usage but had no usable counts. */
  emptyUsageLines: number;
  /** Lines that failed JSON.parse despite passing the prefilter. */
  malformedLines: number;
}

/**
 * Parse one transcript from `offset` onward.
 *
 * Returns rows already deduped *within* this file. Cross-file reconciliation is
 * `reconcileRows`, because it needs every file's rows at once.
 */
export async function parseTranscript(
  path: string,
  options: { offset?: number; signal?: AbortSignal } = {},
): Promise<ParseFileResult> {
  const pathRole: ClaudeUsageRow["pathRole"] = /[/\\]subagents[/\\]/.test(path)
    ? "subagent"
    : "parent";

  const keyed = new Map<string, ClaudeUsageRow>();
  const unkeyed: ClaudeUsageRow[] = [];
  let emptyUsageLines = 0;
  let malformedLines = 0;

  const scan = await scanJsonl(
    path,
    (line) => {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line.bytes.toString("utf8")) as Record<string, unknown>;
      } catch {
        malformedLines += 1;
        return;
      }

      if (record.type !== "assistant") return;
      const message = asRecord(record.message);
      const usage = asRecord(message?.usage);
      if (!message || !usage) return;

      const model = asString(message.model);
      const timestamp = asString(record.timestamp);
      if (!model || !timestamp) return;

      const dayKey = utcDayKey(timestamp);
      if (!dayKey) return;

      const counts = readCounts(usage);
      if (counts === null) {
        emptyUsageLines += 1;
        return;
      }

      const messageId = asString(message.id) ?? null;
      const requestId = asString(record.requestId) ?? null;

      const row: ClaudeUsageRow = {
        dedupeKey: messageId && requestId ? `${messageId}:${requestId}` : null,
        timestamp,
        dayKey,
        model,
        sessionId: asString(record.sessionId) ?? asString(record.session_id) ?? null,
        messageId,
        requestId,
        inputTokens: counts.input,
        cachedTokens: counts.cacheRead,
        cacheCreationTokens: counts.cacheCreation,
        outputTokens: counts.output,
        reasoningTokens: counts.reasoning,
        inferenceGeo: asString(usage.inference_geo) ?? null,
        serviceTier: asString(usage.service_tier) ?? null,
        isSidechain: record.isSidechain === true,
        pathRole,
        sourceFile: path,
        fromIterations: counts.fromIterations,
      };

      if (row.dedupeKey) {
        // Cumulative streaming chunks: the last one seen is the complete one.
        keyed.set(row.dedupeKey, row);
      } else {
        unkeyed.push(row);
      }
    },
    { offset: options.offset, requireAll: PREFILTER, signal: options.signal },
  );

  const rows = [...[...keyed.keys()].sort().map((k) => keyed.get(k)!), ...unkeyed];
  return { rows, scan, emptyUsageLines, malformedLines };
}

interface Counts {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
  reasoning: number;
  fromIterations: boolean;
}

/** Read token counts, falling back to `iterations[]` when top level is all zero. */
function readCounts(usage: Record<string, unknown>): Counts | null {
  const top = {
    input: nonNegative(usage.input_tokens),
    cacheRead: nonNegative(usage.cache_read_input_tokens),
    cacheCreation: nonNegative(usage.cache_creation_input_tokens),
    output: nonNegative(usage.output_tokens),
  };
  const reasoning = nonNegative(asRecord(usage.output_tokens_details)?.thinking_tokens);

  if (top.input + top.cacheRead + top.cacheCreation + top.output > 0) {
    return { ...top, reasoning, fromIterations: false };
  }

  const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
  if (iterations.length === 0) return null;

  const summed = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
  for (const raw of iterations) {
    const iteration = asRecord(raw);
    if (!iteration) continue;
    summed.input += nonNegative(iteration.input_tokens);
    summed.cacheRead += nonNegative(iteration.cache_read_input_tokens);
    summed.cacheCreation += nonNegative(iteration.cache_creation_input_tokens);
    summed.output += nonNegative(iteration.output_tokens);
  }
  if (summed.input + summed.cacheRead + summed.cacheCreation + summed.output === 0) return null;
  return { ...summed, reasoning, fromIterations: true };
}

/**
 * Collapse rows from every scanned file onto one row per logical message.
 *
 * Ties on the same key are broken toward the subagent/sidechain copy: it is the
 * more specific record of where the work actually happened, and picking
 * deterministically is what makes a re-scan idempotent.
 */
export function reconcileRows(rows: readonly ClaudeUsageRow[]): ClaudeUsageRow[] {
  const winners = new Map<string, ClaudeUsageRow>();
  const unkeyed: ClaudeUsageRow[] = [];

  for (const row of rows) {
    if (!row.dedupeKey) {
      unkeyed.push(row);
      continue;
    }
    const existing = winners.get(row.dedupeKey);
    if (!existing || beats(row, existing)) winners.set(row.dedupeKey, row);
  }

  return [...[...winners.keys()].sort().map((k) => winners.get(k)!), ...unkeyed];
}

function beats(candidate: ClaudeUsageRow, incumbent: ClaudeUsageRow): boolean {
  if (candidate.isSidechain !== incumbent.isSidechain) return candidate.isSidechain;
  if (candidate.pathRole !== incumbent.pathRole) return candidate.pathRole === "subagent";
  // Fully tied: order by path so the outcome does not depend on scan order.
  return candidate.sourceFile < incumbent.sourceFile;
}

/** `YYYY-MM-DD` in UTC, or null if the timestamp is unparseable. */
export function utcDayKey(timestamp: string): string | null {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}
