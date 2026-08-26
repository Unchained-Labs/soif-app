import { stat } from "node:fs/promises";
import type { Repository, UsageRecordInput } from "@/lib/db/repository";
import { parseTranscript, reconcileRows, type ClaudeUsageRow } from "./claude";
import { discoverRoots, listTranscripts, type ScanRoot } from "./roots";
import {
  discoverCodexRoots,
  listCodexSessions,
  parseCodexSession,
  type CodexRoot,
} from "./codex";
import {
  discoverSpecRoots,
  listSpecFiles,
  parseWithSpec,
  type SpecRoot,
} from "./local-spec";
import { LOCAL_SCAN_SPECS } from "./specs";
import type { SourceKind } from "@/lib/sources/providers";

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
  /** Restrict to specific Claude Code roots. Omit to discover them. */
  roots?: ScanRoot[];
  /** Restrict to specific Codex homes. Omit to discover them. */
  codexRoots?: CodexRoot[];
  /** Set false to skip the Codex scan entirely. */
  includeCodex?: boolean;
  /** Spec-driven providers to scan. Defaults to every verified spec. */
  specs?: readonly (typeof LOCAL_SCAN_SPECS)[number][];
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
  /** Codex usage events with no resolvable model name. */
  unknownModelEvents: number;
  /** Codex sessions that reported only a cumulative total, not per-turn deltas. */
  rowsFromSessionTotal: number;
}

/** What every local provider reports back, whatever it scanned. */
export interface IngestResult {
  sourceId: string;
  kind: SourceKind;
  /** Directory scanned, for the CLI to name. */
  rootPath: string;
  /** Non-secret account label, when the provider exposes one. */
  account: object | null;
  filesScanned: number;
  bytesScanned: number;
  rowsParsed: number;
  /** Rows dropped as duplicates of a parent/subagent copy. */
  rowsCollapsed: number;
  recordsInserted: number;
  warnings: IngestWarnings;
  /**
   * Files were scanned but nothing was recognised as usage. Means the tool's
   * format moved out from under the spec — reported rather than swallowed,
   * because zero water for a provider you use looks identical to not using it.
   */
  formatUnrecognised?: boolean;
}

const EMPTY_WARNINGS: IngestWarnings = {
  linesSkippedTooLong: 0,
  linesSkippedPossiblyRelevant: 0,
  malformedLines: 0,
  emptyUsageLines: 0,
  rowsFromIterations: 0,
  cursorsReset: 0,
  unknownModelEvents: 0,
  rowsFromSessionTotal: 0,
};

/**
 * Scan every local provider on this machine and persist what they report.
 *
 * Providers are independent: a machine with Claude Code but no Codex simply
 * yields fewer results, and a failure in one does not abort the others. That
 * matters because the dashboard is only honest if it shows what it *could*
 * read, and a single broken source silently zeroing the whole scan would be
 * worse than a partial answer clearly labelled.
 */
export async function ingestLocalScan(
  repository: Repository,
  options: IngestOptions = {},
): Promise<IngestResult[]> {
  const results: IngestResult[] = [];

  const claudeRoots = options.roots ?? (await discoverRoots());
  for (const root of claudeRoots) {
    results.push(await ingestRoot(repository, root, options));
  }

  if (options.includeCodex !== false) {
    for (const root of options.codexRoots ?? (await discoverCodexRoots())) {
      results.push(await ingestCodexRoot(repository, root, options));
    }
  }

  for (const spec of options.specs ?? LOCAL_SCAN_SPECS) {
    for (const root of await discoverSpecRoots(spec)) {
      results.push(await ingestSpecRoot(repository, root, options));
    }
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
      kind: "claude_code_local",
      rootPath: root.path,
      account: root.account ?? null,
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
    project: row.project,
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

/**
 * Scan one Codex home.
 *
 * Structurally the same contract as the Claude path — one source per home, byte
 * cursors per rollout, idempotent inserts — but the rows need no cross-file
 * reconciliation: Codex rollouts do not duplicate each other's turns the way a
 * Claude subagent transcript duplicates its parent's messages.
 */
export async function ingestCodexRoot(
  repository: Repository,
  root: CodexRoot,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const label = root.codexHome;
  const existing = await repository.findSource("codex_local", label);
  const sourceId = await repository.upsertSource({
    id: existing?.id,
    kind: "codex_local",
    label,
    account: root.account ?? null,
  });

  const runId = await repository.startSyncRun(sourceId);
  const warnings: IngestWarnings = { ...EMPTY_WARNINGS };
  let bytesScanned = 0;
  let filesScanned = 0;
  const records: UsageRecordInput[] = [];

  try {
    const files = await listCodexSessions(root.codexHome);

    for (const file of files) {
      if (options.signal?.aborted) throw new DOMException("Ingest aborted", "AbortError");
      options.onProgress?.({ filesTotal: files.length, filesScanned, currentFile: file });

      const info = await stat(file).catch(() => null);
      if (!info) continue;

      const cursor = options.full ? null : await repository.getCursor(sourceId, file);
      let offset = cursor?.committedOffset ?? 0;
      if (offset > info.size) {
        offset = 0;
        warnings.cursorsReset += 1;
      }
      if (
        cursor &&
        offset === info.size &&
        cursor.fileSize === info.size &&
        cursor.mtimeMs === Math.trunc(info.mtimeMs)
      ) {
        filesScanned += 1;
        continue;
      }

      const parsed = await parseCodexSession(file, { offset, signal: options.signal });
      bytesScanned += parsed.scan.readOffset - offset;
      filesScanned += 1;

      warnings.linesSkippedTooLong += parsed.scan.linesSkippedTooLong;
      warnings.linesSkippedPossiblyRelevant += parsed.scan.linesSkippedPossiblyRelevant;
      warnings.malformedLines += parsed.malformedLines;
      warnings.unknownModelEvents += parsed.unknownModelEvents;
      warnings.rowsFromSessionTotal += parsed.rows.filter((r) => r.fromSessionTotal).length;

      for (const row of parsed.rows) {
        const at = new Date(row.timestamp);
        records.push({
          sourceId,
          dedupeKey: row.dedupeKey,
          bucketStart: at,
          bucketEnd: at,
          granularity: "message",
          dayKey: row.dayKey,
          model: row.model,
          inputTokens: row.tokens.inputTokens,
          cachedTokens: row.tokens.cachedTokens,
          cacheCreationTokens: row.tokens.cacheCreationTokens,
          outputTokens: row.tokens.outputTokens,
          reasoningTokens: row.tokens.reasoningTokens,
          // Codex reports no inference geography, so the region falls back to
          // the model's registry default rather than being guessed.
          inferenceGeo: null,
          sessionId: row.sessionId,
          sourceFile: row.sourceFile,
          project: row.project,
        });
      }

      await repository.saveCursor({
        sourceId,
        filePath: file,
        committedOffset: parsed.scan.committedOffset,
        fileSize: info.size,
        mtimeMs: Math.trunc(info.mtimeMs),
      });
    }

    const recordsInserted = await repository.insertUsageRecords(records);

    await repository.finishSyncRun(runId, {
      status: warnings.linesSkippedPossiblyRelevant > 0 ? "partial" : "ok",
      recordsIngested: recordsInserted,
      bytesScanned,
      warnings: warnings as unknown as Record<string, number>,
    });
    await repository.markSourceSynced(sourceId, null);

    return {
      sourceId,
      kind: "codex_local",
      rootPath: root.codexHome,
      account: root.account ?? null,
      filesScanned,
      bytesScanned,
      rowsParsed: records.length,
      rowsCollapsed: 0,
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
 * Scan one spec-driven root (Gemini CLI, Qwen Code, and whatever comes next).
 *
 * The bespoke Claude and Codex paths exist because those formats have real
 * structural complexity. Everything else is the same shape — append-only JSONL,
 * counts nested at a known path — so it runs through one engine and a spec.
 */
export async function ingestSpecRoot(
  repository: Repository,
  root: SpecRoot,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const spec = root.spec;
  const label = root.sessionsDir;
  const existing = await repository.findSource(spec.kind, label);
  const sourceId = await repository.upsertSource({ id: existing?.id, kind: spec.kind, label });

  const runId = await repository.startSyncRun(sourceId);
  const warnings: IngestWarnings = { ...EMPTY_WARNINGS };
  let bytesScanned = 0;
  let filesScanned = 0;
  const records: UsageRecordInput[] = [];

  try {
    const files = await listSpecFiles(root);

    for (const file of files) {
      if (options.signal?.aborted) throw new DOMException("Ingest aborted", "AbortError");
      options.onProgress?.({ filesTotal: files.length, filesScanned, currentFile: file });

      const info = await stat(file).catch(() => null);
      if (!info) continue;

      const cursor = options.full ? null : await repository.getCursor(sourceId, file);
      let offset = cursor?.committedOffset ?? 0;
      if (offset > info.size) {
        offset = 0;
        warnings.cursorsReset += 1;
      }
      if (
        cursor &&
        offset === info.size &&
        cursor.fileSize === info.size &&
        cursor.mtimeMs === Math.trunc(info.mtimeMs)
      ) {
        filesScanned += 1;
        continue;
      }

      const parsed = await parseWithSpec(spec, file, { offset, signal: options.signal });
      bytesScanned += parsed.scan.readOffset - offset;
      filesScanned += 1;

      warnings.linesSkippedTooLong += parsed.scan.linesSkippedTooLong;
      warnings.linesSkippedPossiblyRelevant += parsed.scan.linesSkippedPossiblyRelevant;
      warnings.malformedLines += parsed.malformedLines;
      warnings.emptyUsageLines += parsed.recordsWithoutUsage;
      warnings.unknownModelEvents += parsed.unknownModelRecords;

      for (const row of parsed.rows) {
        const at = new Date(row.timestamp);
        records.push({
          sourceId,
          dedupeKey: row.dedupeKey,
          bucketStart: at,
          bucketEnd: at,
          granularity: "message",
          dayKey: row.dayKey,
          model: row.model,
          inputTokens: row.tokens.inputTokens,
          cachedTokens: row.tokens.cachedTokens,
          cacheCreationTokens: row.tokens.cacheCreationTokens,
          outputTokens: row.tokens.outputTokens,
          reasoningTokens: row.tokens.reasoningTokens,
          inferenceGeo: null,
          sessionId: row.sessionId,
          sourceFile: row.sourceFile,
          project: row.project,
        });
      }

      await repository.saveCursor({
        sourceId,
        filePath: file,
        committedOffset: parsed.scan.committedOffset,
        fileSize: info.size,
        mtimeMs: Math.trunc(info.mtimeMs),
      });
    }

    const recordsInserted = await repository.insertUsageRecords(records);

    // A root with files but no rows means the spec no longer matches the tool's
    // format. That has to surface: silently reporting zero water for a provider
    // you actively use is the worst failure this dashboard has.
    const formatUnrecognised = filesScanned > 0 && records.length === 0 && bytesScanned > 0;

    await repository.finishSyncRun(runId, {
      status: formatUnrecognised || warnings.linesSkippedPossiblyRelevant > 0 ? "partial" : "ok",
      recordsIngested: recordsInserted,
      bytesScanned,
      warnings: warnings as unknown as Record<string, number>,
      error: formatUnrecognised
        ? `scanned ${filesScanned} ${spec.label} files but recognised no usage records — the format may have changed`
        : undefined,
    });
    await repository.markSourceSynced(sourceId, null);

    return {
      sourceId,
      kind: spec.kind,
      rootPath: root.sessionsDir,
      account: null,
      filesScanned,
      bytesScanned,
      rowsParsed: records.length,
      rowsCollapsed: 0,
      recordsInserted,
      warnings,
      formatUnrecognised,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await repository.finishSyncRun(runId, { status: "error", error: message, bytesScanned });
    await repository.markSourceSynced(sourceId, message);
    throw error;
  }
}
