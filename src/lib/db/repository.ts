import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "./client";

/**
 * The query surface the app uses, over either dialect.
 *
 * Drizzle's builder API is the same shape for SQLite and Postgres, but the
 * *types* are not, so `DatabaseHandle.db` is `unknown` and gets narrowed here.
 * That confines the casting to one file instead of scattering it through every
 * call site, and keeps `tests/schema.test.ts` as the thing that guarantees the
 * two schemas actually accept the same queries.
 *
 * The one genuine divergence is JSON columns: Postgres `jsonb` round-trips an
 * object, SQLite `text` needs a string. `encodeJson`/`decodeJson` absorb that.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface UsageRecordInput {
  sourceId: string;
  dedupeKey: string;
  bucketStart: Date;
  bucketEnd: Date;
  granularity: "1m" | "1h" | "1d" | "message";
  dayKey: string;
  model: string;
  inputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  inferenceGeo?: string | null;
  serviceTier?: string | null;
  workspaceId?: string | null;
  apiKeyId?: string | null;
  sessionId?: string | null;
  sourceFile?: string | null;
}

/**
 * A stored usage record as it comes back out.
 *
 * Declared explicitly rather than inferred from the Drizzle query, because the
 * dual-dialect `AnyDb` cast erases the row type — and an `any` leaking out of
 * the repository would silently disable type checking in every consumer.
 */
export interface UsageRecordRow {
  id: string;
  sourceId: string;
  dedupeKey: string;
  bucketStart: Date;
  bucketEnd: Date;
  granularity: string;
  dayKey: string;
  model: string;
  inputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  inferenceGeo: string | null;
  serviceTier: string | null;
  workspaceId: string | null;
  apiKeyId: string | null;
  sessionId: string | null;
  sourceFile: string | null;
}

/** A source as the dashboard sees it: never carrying the sealed credential. */
export interface SourceRow {
  id: string;
  kind: string;
  label: string;
  enabled: boolean;
  createdAt: Date | number;
  lastSyncedAt: Date | number | null;
  lastSyncError: string | null;
  /** Whether a credential is configured — not the credential itself. */
  hasCredential: boolean;
  account: Record<string, unknown> | null;
}

export interface SourceInput {
  id?: string;
  kind: "anthropic_admin" | "claude_code_local" | "openai_admin" | "claude_enterprise" | "csv";
  label: string;
  credentialCipher?: string | null;
  credentialKeyId?: string | null;
  account?: object | null;
}

export class Repository {
  constructor(private readonly handle: DatabaseHandle) {}

  private get db(): AnyDb {
    return this.handle.db;
  }

  private get schema() {
    return this.handle.schema;
  }

  private get isPostgres(): boolean {
    return this.handle.dialect === "postgres";
  }

  /** Postgres jsonb wants an object; SQLite text wants a string. */
  private encodeJson(value: unknown): unknown {
    return this.isPostgres ? value : JSON.stringify(value);
  }

  private decodeJson<T>(value: unknown, fallback: T): T {
    if (value === null || value === undefined) return fallback;
    if (typeof value !== "string") return value as T;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  // -- sources --------------------------------------------------------------

  async upsertSource(input: SourceInput): Promise<string> {
    const { sources } = this.schema;
    const id = input.id ?? randomUUID();
    const row = {
      id,
      kind: input.kind,
      label: input.label,
      credentialCipher: input.credentialCipher ?? null,
      credentialKeyId: input.credentialKeyId ?? null,
      accountJson: input.account ? this.encodeJson(input.account) : null,
    };

    await this.db
      .insert(sources)
      .values(row)
      .onConflictDoUpdate({
        target: sources.id,
        set: {
          label: row.label,
          credentialCipher: row.credentialCipher,
          credentialKeyId: row.credentialKeyId,
          accountJson: row.accountJson,
        },
      });
    return id;
  }

  /**
   * Find a source by kind and label.
   *
   * The local scanner uses this to keep one stable source per config root
   * across runs, so cursors and records stay attached rather than accumulating
   * a new source per invocation.
   */
  async findSource(kind: string, label: string) {
    const { sources } = this.schema;
    const rows = await this.db
      .select()
      .from(sources)
      .where(and(eq(sources.kind, kind), eq(sources.label, label)))
      .limit(1);
    return rows[0] ?? null;
  }

  async listSources(): Promise<SourceRow[]> {
    const { sources } = this.schema;
    const rows = await this.db.select().from(sources).orderBy(asc(sources.createdAt));
    // The sealed credential is stripped rather than merely not displayed: the
    // only consumer that needs it asks for it explicitly via `sourceCredential`,
    // so it should never be sitting in an object a route might serialise.
    return rows.map((row: Record<string, unknown>) => {
      const { credentialCipher, credentialKeyId, accountJson, ...rest } = row;
      void credentialKeyId;
      return {
        ...rest,
        hasCredential: Boolean(credentialCipher),
        account: this.decodeJson<Record<string, unknown> | null>(accountJson, null),
      };
    }) as SourceRow[];
  }

  /** The sealed credential for one source. Callers must not log the result. */
  async sourceCredential(sourceId: string): Promise<string | null> {
    const { sources } = this.schema;
    const rows = await this.db
      .select({ cipher: sources.credentialCipher })
      .from(sources)
      .where(eq(sources.id, sourceId))
      .limit(1);
    return rows[0]?.cipher ?? null;
  }

  async markSourceSynced(sourceId: string, error?: string | null): Promise<void> {
    const { sources } = this.schema;
    await this.db
      .update(sources)
      .set({ lastSyncedAt: new Date(), lastSyncError: error ?? null })
      .where(eq(sources.id, sourceId));
  }

  // -- usage records --------------------------------------------------------

  /**
   * Insert usage records, ignoring any already present.
   *
   * `onConflictDoNothing` on `(source_id, dedupe_key)` is what makes a re-sync
   * idempotent: re-scanning a window or replaying a transcript adds nothing.
   * Returns the count actually inserted so a sync run can report real progress
   * rather than the size of its input.
   */
  async insertUsageRecords(records: readonly UsageRecordInput[]): Promise<number> {
    if (records.length === 0) return 0;
    const { usageRecords } = this.schema;

    let inserted = 0;
    // Chunked to stay under SQLite's variable limit (999 by default) and to
    // keep a failed batch small enough to diagnose.
    const CHUNK = 250;
    for (let i = 0; i < records.length; i += CHUNK) {
      const chunk = records.slice(i, i + CHUNK).map((r) => ({
        id: randomUUID(),
        sourceId: r.sourceId,
        dedupeKey: r.dedupeKey,
        bucketStart: r.bucketStart,
        bucketEnd: r.bucketEnd,
        granularity: r.granularity,
        dayKey: r.dayKey,
        model: r.model,
        inputTokens: r.inputTokens,
        cachedTokens: r.cachedTokens,
        cacheCreationTokens: r.cacheCreationTokens,
        outputTokens: r.outputTokens,
        reasoningTokens: r.reasoningTokens,
        inferenceGeo: r.inferenceGeo ?? null,
        serviceTier: r.serviceTier ?? null,
        workspaceId: r.workspaceId ?? null,
        apiKeyId: r.apiKeyId ?? null,
        sessionId: r.sessionId ?? null,
        sourceFile: r.sourceFile ?? null,
      }));

      const result = await this.db
        .insert(usageRecords)
        .values(chunk)
        .onConflictDoNothing({ target: [usageRecords.sourceId, usageRecords.dedupeKey] })
        .returning({ id: usageRecords.id });
      inserted += result.length;
    }
    return inserted;
  }

  async listUsageRecords(
    options: { from?: string; to?: string; sourceIds?: string[] } = {},
  ): Promise<UsageRecordRow[]> {
    const { usageRecords } = this.schema;
    const filters = [];
    if (options.from) filters.push(gte(usageRecords.dayKey, options.from));
    if (options.to) filters.push(lte(usageRecords.dayKey, options.to));
    if (options.sourceIds?.length) filters.push(inArray(usageRecords.sourceId, options.sourceIds));

    const query = this.db.select().from(usageRecords);
    const filtered = filters.length > 0 ? query.where(and(...filters)) : query;
    const rows = await filtered.orderBy(asc(usageRecords.bucketStart));
    // Postgres returns bigint columns as strings; SQLite returns numbers.
    // Normalising here means no consumer has to remember which engine it is on.
    return rows.map((row: Record<string, unknown>) => ({
      ...row,
      inputTokens: Number(row.inputTokens ?? 0),
      cachedTokens: Number(row.cachedTokens ?? 0),
      cacheCreationTokens: Number(row.cacheCreationTokens ?? 0),
      outputTokens: Number(row.outputTokens ?? 0),
      reasoningTokens: Number(row.reasoningTokens ?? 0),
    })) as UsageRecordRow[];
  }

  /**
   * Token totals per day and model.
   *
   * Aggregated in SQL rather than in JS because the dashboard's default view is
   * a lifetime range, and pulling every record across the wire to sum it is the
   * kind of thing that works until someone's first real backfill.
   */
  async aggregateByDayModel(options: { from?: string; to?: string } = {}) {
    const { usageRecords } = this.schema;
    const filters = [];
    if (options.from) filters.push(gte(usageRecords.dayKey, options.from));
    if (options.to) filters.push(lte(usageRecords.dayKey, options.to));

    const query = this.db
      .select({
        dayKey: usageRecords.dayKey,
        model: usageRecords.model,
        inferenceGeo: usageRecords.inferenceGeo,
        inputTokens: sql<number>`sum(${usageRecords.inputTokens})`,
        cachedTokens: sql<number>`sum(${usageRecords.cachedTokens})`,
        cacheCreationTokens: sql<number>`sum(${usageRecords.cacheCreationTokens})`,
        outputTokens: sql<number>`sum(${usageRecords.outputTokens})`,
        reasoningTokens: sql<number>`sum(${usageRecords.reasoningTokens})`,
        calls: sql<number>`count(*)`,
      })
      .from(usageRecords)
      .groupBy(usageRecords.dayKey, usageRecords.model, usageRecords.inferenceGeo)
      .orderBy(asc(usageRecords.dayKey));

    const rows = filters.length > 0 ? await query.where(and(...filters)) : await query;
    // SQLite returns sums as numbers; Postgres bigint sums arrive as strings.
    return rows.map((row: Record<string, unknown>) => ({
      ...row,
      inputTokens: Number(row.inputTokens ?? 0),
      cachedTokens: Number(row.cachedTokens ?? 0),
      cacheCreationTokens: Number(row.cacheCreationTokens ?? 0),
      outputTokens: Number(row.outputTokens ?? 0),
      reasoningTokens: Number(row.reasoningTokens ?? 0),
      calls: Number(row.calls ?? 0),
    })) as Array<{
      dayKey: string;
      model: string;
      inferenceGeo: string | null;
      inputTokens: number;
      cachedTokens: number;
      cacheCreationTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      calls: number;
    }>;
  }

  async usageDayRange(): Promise<{ first: string; last: string } | null> {
    const { usageRecords } = this.schema;
    const rows = await this.db
      .select({
        first: sql<string>`min(${usageRecords.dayKey})`,
        last: sql<string>`max(${usageRecords.dayKey})`,
      })
      .from(usageRecords);
    const row = rows[0];
    return row?.first && row?.last ? { first: row.first, last: row.last } : null;
  }

  // -- scan cursors ---------------------------------------------------------

  async getCursor(sourceId: string, filePath: string) {
    const { scanCursors } = this.schema;
    const rows = await this.db
      .select()
      .from(scanCursors)
      .where(and(eq(scanCursors.sourceId, sourceId), eq(scanCursors.filePath, filePath)))
      .limit(1);
    return rows[0] ?? null;
  }

  async listCursors(sourceId: string) {
    const { scanCursors } = this.schema;
    return this.db.select().from(scanCursors).where(eq(scanCursors.sourceId, sourceId));
  }

  async saveCursor(input: {
    sourceId: string;
    filePath: string;
    committedOffset: number;
    fileSize: number;
    mtimeMs: number;
  }): Promise<void> {
    const { scanCursors } = this.schema;
    await this.db
      .insert(scanCursors)
      .values({ id: randomUUID(), ...input, lastScannedAt: new Date() })
      .onConflictDoUpdate({
        target: [scanCursors.sourceId, scanCursors.filePath],
        set: {
          committedOffset: input.committedOffset,
          fileSize: input.fileSize,
          mtimeMs: input.mtimeMs,
          lastScannedAt: new Date(),
        },
      });
  }

  // -- factor sets ----------------------------------------------------------

  /** Record a factor set so historical estimates stay reproducible. */
  async recordFactorSet(document: {
    factors_version: string;
    schema_version: string;
    soif_version: string;
  }): Promise<void> {
    const { factorSets } = this.schema;
    await this.db
      .insert(factorSets)
      .values({
        version: document.factors_version,
        schemaVersion: document.schema_version,
        soifVersion: document.soif_version,
        document: this.encodeJson(document),
      })
      .onConflictDoNothing({ target: factorSets.version });
  }

  // -- sync runs ------------------------------------------------------------

  async startSyncRun(sourceId: string): Promise<string> {
    const { syncRuns } = this.schema;
    const id = randomUUID();
    await this.db
      .insert(syncRuns)
      .values({ id, sourceId, startedAt: new Date(), status: "running" });
    return id;
  }

  async finishSyncRun(
    id: string,
    result: {
      status: "ok" | "error" | "partial";
      recordsIngested?: number;
      bytesScanned?: number;
      warnings?: Record<string, number>;
      error?: string;
    },
  ): Promise<void> {
    const { syncRuns } = this.schema;
    await this.db
      .update(syncRuns)
      .set({
        finishedAt: new Date(),
        status: result.status,
        recordsIngested: result.recordsIngested ?? 0,
        bytesScanned: result.bytesScanned ?? 0,
        warningsJson: this.encodeJson(result.warnings ?? {}),
        error: result.error ?? null,
      })
      .where(eq(syncRuns.id, id));
  }

  async recentSyncRuns(limit = 20) {
    const { syncRuns } = this.schema;
    const rows = await this.db
      .select()
      .from(syncRuns)
      .orderBy(desc(syncRuns.startedAt))
      .limit(limit);
    return rows.map((row: Record<string, unknown>) => ({
      ...row,
      warnings: this.decodeJson<Record<string, number>>(row.warningsJson, {}),
    }));
  }
}
