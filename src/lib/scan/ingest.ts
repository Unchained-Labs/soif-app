import { stat } from "node:fs/promises";
import type { Repository, UsageRecordInput } from "@/lib/db/repository";
import { parseTranscript, reconcileRows, type ClaudeUsageRow } from "./claude";
import { discoverRoots, listTranscripts, type ScanRoot } from "./roots";

/**
 * Turning a transcript scan into stored usage records.
 *
 * The scan is incremental in two independent ways, and both matter on a corpus
 * that reaches hundreds of megabytes:
 *
 *  - **Per-file byte cursors** mean an unchanged transcript is not reopened and
 *    a growing one is read only from where the last run stopped.
 *  - **A unique `(source_id, dedupe_key)`** means even a full re-scan inserts
 *    nothing new, so a cursor reset costs time rather than correctness.
 *
 * Reconciliation runs across the whole *scan*, not per file, because the same
 * logical message can appear in both a parent and a subagent transcript.
 */

export interface IngestProgress {
  filesTotal: number;
  filesScanned: number;
  currentFile: string;
}

export interface IngestOptions {
  /** Restrict to specific roots. Omit to discover them. */
  roots?: ScanRoot[];
  /** Ignore stored cursors and re-read every transcript from byte zero. */
  full?: boolean;
  onProgress?: (progress: IngestProgress) => void;
  signal?: AbortSignal;
}

export interface IngestWarnings {
  /** Oversized lines skipped. Almost always harmless tool output. */
  linesSkippedTooLong: number;
  /** Of those, ones whose opening bytes suggested they carried usage. */
  linesSkippedPossiblyRelevant: number;
  malformedLines: number;
  /** Lines with a usage block but no non-zero counts. */
  emptyUsageLines: number;
  /** Rows whose counts came from `usage.iterations[]` rather than top level. */
  rowsFromIterations: number;
  /** Files whose cursor was reset because the file had shrunk. */
  cursorsReset: number;
}

export interface IngestResult {
  sourceId: string;
  root: ScanRoot;
  filesScanned: number;
  bytesScanned: number;
  rowsParsed: number;
  /** Rows dropped as duplicates of a parent/subagent copy. */
  rowsCollapsed: number;
  recordsInserted: number;
  warnings: IngestWarnings;
}

const EMPTY_WARNINGS: IngestWarnings = {
  linesSkippedTooLong: 0,
  linesSkippedPossiblyRelevant: 0,
  malformedLines: 0,
  emptyUsageLines: 0,
  rowsFromIterations: 0,
  cursorsReset: 0,
};

/** Scan every discovered root and persist what it finds. */
export async function ingestLocalScan(
  repository: Repository,
  options: IngestOptions = {},
): Promise<IngestResult[]> {
  const roots = options.roots ?? (await discoverRoots());
  const results: IngestResult[] = [];
  for (const root of roots) {
    results.push(await ingestRoot(repository, root, options));
  }
  return results;
}

/** Scan one root. Each root is its own source, which is how accounts stay apart. */
export async function ingestRoot(
  repository: Repository,
  root: ScanRoot,
  options: IngestOptions = {},
): Promise<IngestResult> {
  // The label is the config dir, so re-running attaches to the same source and
  // its cursors rather than creating a new one each time.
  const label = root.configDir;
  const existing = await repository.findSource("claude_code_local", label);
  const sourceId = await repository.upsertSource({
    id: existing?.id,
    kind: "claude_code_local",
    label,
    account: root.account ?? null,
  });

  const runId = await repository.startSyncRun(sourceId);
  const warnings: IngestWarnings = { ...EMPTY_WARNINGS };
  let bytesScanned = 0;
  let filesScanned = 0;
  const rows: ClaudeUsageRow[] = [];

  try {
    const files = await listTranscripts(root.path);

    for (const file of files) {
      if (options.signal?.aborted) throw new DOMException("Ingest aborted", "AbortError");
      options.onProgress?.({ filesTotal: files.length, filesScanned, currentFile: file });

      const info = await stat(file).catch(() => null);
      if (!info) continue; // Deleted mid-scan.

      const cursor = options.full ? null : await repository.getCursor(sourceId, file);
      let offset = cursor?.committedOffset ?? 0;

      // A file smaller than its cursor was truncated or replaced. Re-reading
      // from zero is safe — the unique dedupe key absorbs the repeats — while
      // trusting the stale offset would skip everything the new file contains.
      if (offset > info.size) {
        offset = 0;
        warnings.cursorsReset += 1;
      }

      // Unchanged since the last run: same size, same mtime, cursor at EOF.
      if (
        cursor &&
        offset === info.size &&
        cursor.fileSize === info.size &&
        cursor.mtimeMs === Math.trunc(info.mtimeMs)
      ) {
        filesScanned += 1;
        continue;
      }

      const parsed = await parseTranscript(file, { offset, signal: options.signal });
      rows.push(...parsed.rows);
      bytesScanned += parsed.scan.readOffset - offset;
      filesScanned += 1;

      warnings.linesSkippedTooLong += parsed.scan.linesSkippedTooLong;
      warnings.linesSkippedPossiblyRelevant += parsed.scan.linesSkippedPossiblyRelevant;
      warnings.malformedLines += parsed.malformedLines;
      warnings.emptyUsageLines += parsed.emptyUsageLines;
      warnings.rowsFromIterations += parsed.rows.filter((r) => r.fromIterations).length;

      await repository.saveCursor({
        sourceId,
        filePath: file,
        committedOffset: parsed.scan.committedOffset,
        fileSize: info.size,
        mtimeMs: Math.trunc(info.mtimeMs),
      });
    }

    const reconciled = reconcileRows(rows);
    const recordsInserted = await repository.insertUsageRecords(
      reconciled.map((row) => toUsageRecord(row, sourceId)),
    );

    await repository.finishSyncRun(runId, {
      status: warnings.linesSkippedPossiblyRelevant > 0 ? "partial" : "ok",
      recordsIngested: recordsInserted,
      bytesScanned,
      warnings: warnings as unknown as Record<string, number>,
    });
    await repository.markSourceSynced(sourceId, null);

    return {
      sourceId,
      root,
      filesScanned,
      bytesScanned,
      rowsParsed: rows.length,
      rowsCollapsed: rows.length - reconciled.length,
      recordsInserted,
      warnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await repository.finishSyncRun(runId, { status: "error", error: message, bytesScanned });
    await repository.markSourceSynced(sourceId, message);
    throw error;
  }
}

/**
 * A transcript row is a single call, not a time window.
 *
 * `granularity: "message"` records that: the dashboard must not present a
 * message-level record as if it covered a day, and a mixed-source install has
 * both shapes in the same table.
 */
export function toUsageRecord(row: ClaudeUsageRow, sourceId: string): UsageRecordInput {
  const at = new Date(row.timestamp);
  return {
    sourceId,
    // Falls back to a content-addressed key for pre-id transcripts, so those
    // rows still dedupe on a re-scan instead of multiplying.
    dedupeKey: row.dedupeKey ?? syntheticKey(row),
    bucketStart: at,
    bucketEnd: at,
    granularity: "message",
    dayKey: row.dayKey,
    model: row.model,
    inputTokens: row.inputTokens,
    cachedTokens: row.cachedTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
    inferenceGeo: row.inferenceGeo,
    serviceTier: row.serviceTier,
    sessionId: row.sessionId,
    sourceFile: row.sourceFile,
  };
}

/**
 * Identity for a row whose transcript predates message/request ids.
 *
 * Built from the fields that make a call distinct rather than from a random
 * uuid, so re-scanning the same file does not duplicate it. Two genuinely
 * identical calls in the same session at the same millisecond would collapse —
 * accepted, because the alternative multiplies every legacy row on every scan.
 */
function syntheticKey(row: ClaudeUsageRow): string {
  return [
    "synthetic",
    row.sessionId ?? row.sourceFile,
    row.timestamp,
    row.model,
    row.inputTokens,
    row.cachedTokens,
    row.cacheCreationTokens,
    row.outputTokens,
  ].join("|");
}
