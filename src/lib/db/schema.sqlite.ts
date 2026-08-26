import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * SQLite schema — the default store.
 *
 * A single developer running a local scan should not need to stand up Postgres,
 * so SQLite is the default and `schema.postgres.ts` mirrors it for the
 * multi-source org case. The two are kept identical by `tests/schema.test.ts`,
 * which compares declared table and column names rather than trusting review.
 *
 * Two structural commitments from the brief:
 *
 *  - **Raw token counts are the source of truth.** Estimates are a derived
 *    cache keyed by factor-set version, so upgrading factors re-derives history
 *    instead of stranding it.
 *  - **Nothing here stores a plaintext credential.** `sources.credential_cipher`
 *    holds an envelope-encrypted blob; the key never enters the database.
 */

/** An ingestion source: one admin key, one local machine, one CSV import. */
export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(), // anthropic_admin | claude_code_local | openai_admin | claude_enterprise | csv
    label: text("label").notNull(),
    /** Envelope-encrypted credential. Never logged, never returned by an API route. */
    credentialCipher: text("credential_cipher"),
    /** Key id the cipher was sealed under, so keys can be rotated. */
    credentialKeyId: text("credential_key_id"),
    /** Non-secret account identity, JSON. Email/org label only — never a token. */
    accountJson: text("account_json"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }),
    lastSyncError: text("last_sync_error"),
  },
  (t) => [index("sources_kind_idx").on(t.kind)],
);

/**
 * Normalised token counts, whatever the source.
 *
 * The Admin API reports pre-bucketed totals; a local scan reports individual
 * messages. Both land here with a bucket window, so the dashboard aggregates
 * one shape. `dedupeKey` is what makes a re-sync idempotent: the Admin API's
 * bucket identity, or the transcript's `messageId:requestId`.
 */
export const usageRecords = sqliteTable(
  "usage_records",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    dedupeKey: text("dedupe_key").notNull(),
    bucketStart: integer("bucket_start", { mode: "timestamp_ms" }).notNull(),
    bucketEnd: integer("bucket_end", { mode: "timestamp_ms" }).notNull(),
    /** `1m` | `1h` | `1d` | `message` — `message` means a single call, not a window. */
    granularity: text("granularity").notNull(),
    /** UTC `YYYY-MM-DD`, denormalised because every dashboard query groups by it. */
    dayKey: text("day_key").notNull(),
    model: text("model").notNull(),

    // The four counts must stay separate: cached tokens are charged at 1% of an
    // output token, so collapsing them into one "input" figure throws the
    // estimate off by an order of magnitude on agentic workloads.
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Already included in `outputTokens`. Recorded for disclosure, never re-added. */
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),

    /** Real geographic routing when the source reports it: `us` | `global` | `not_available`. */
    inferenceGeo: text("inference_geo"),
    serviceTier: text("service_tier"),
    workspaceId: text("workspace_id"),
    apiKeyId: text("api_key_id"),
    /** Provenance for the local scan: which transcript, which session. */
    sessionId: text("session_id"),
    sourceFile: text("source_file"),
    ingestedAt: integer("ingested_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    // Idempotent re-sync: the same logical record can only land once per source.
    uniqueIndex("usage_records_source_dedupe_idx").on(t.sourceId, t.dedupeKey),
    index("usage_records_day_idx").on(t.dayKey),
    index("usage_records_model_idx").on(t.model),
    index("usage_records_bucket_idx").on(t.bucketStart),
  ],
);

/**
 * Per-file scan cursors for the Claude Code local path.
 *
 * `size` and `mtimeMs` detect truncation or replacement: if a file is smaller
 * than the committed offset it was rotated, and the cursor must reset rather
 * than skip the new content.
 */
export const scanCursors = sqliteTable(
  "scan_cursors",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    /** Only ever advanced past a complete line. */
    committedOffset: integer("committed_offset").notNull().default(0),
    fileSize: integer("file_size").notNull().default(0),
    mtimeMs: integer("mtime_ms").notNull().default(0),
    lastScannedAt: integer("last_scanned_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [uniqueIndex("scan_cursors_source_file_idx").on(t.sourceId, t.filePath)],
);

/**
 * Every factor set an estimate was ever computed under.
 *
 * Storing the whole document, not just the version string, is what makes a
 * historical row reproducible after the upstream factors change.
 */
export const factorSets = sqliteTable("factor_sets", {
  version: text("version").primaryKey(),
  schemaVersion: text("schema_version").notNull(),
  soifVersion: text("soif_version").notNull(),
  document: text("document").notNull(),
  loadedAt: integer("loaded_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

/**
 * Derived water estimates. Safe to delete and recompute at any time.
 *
 * All six quantities are stored as their (low, mid, high) bounds. The UI needs
 * the band on every figure — a bare number without its range is the one thing
 * this project must never show — and it needs the onsite/offsite/embodied split
 * so embodied water can be excluded without a round trip.
 */
export const estimates = sqliteTable(
  "estimates",
  {
    id: text("id").primaryKey(),
    usageRecordId: text("usage_record_id")
      .notNull()
      .references(() => usageRecords.id, { onDelete: "cascade" }),
    factorsVersion: text("factors_version").notNull(),
    tier: text("tier").notNull(),
    provider: text("provider").notNull(),
    region: text("region").notNull(),
    /** Defaults the estimate leaned on, JSON array. Surfaced, never hidden. */
    assumptions: text("assumptions").notNull().default("[]"),

    energyItWhLow: real("energy_it_wh_low").notNull(),
    energyItWhMid: real("energy_it_wh_mid").notNull(),
    energyItWhHigh: real("energy_it_wh_high").notNull(),
    energyFacilityWhLow: real("energy_facility_wh_low").notNull(),
    energyFacilityWhMid: real("energy_facility_wh_mid").notNull(),
    energyFacilityWhHigh: real("energy_facility_wh_high").notNull(),
    onsiteMlLow: real("onsite_ml_low").notNull(),
    onsiteMlMid: real("onsite_ml_mid").notNull(),
    onsiteMlHigh: real("onsite_ml_high").notNull(),
    offsiteMlLow: real("offsite_ml_low").notNull(),
    offsiteMlMid: real("offsite_ml_mid").notNull(),
    offsiteMlHigh: real("offsite_ml_high").notNull(),
    embodiedMlLow: real("embodied_ml_low").notNull(),
    embodiedMlMid: real("embodied_ml_mid").notNull(),
    embodiedMlHigh: real("embodied_ml_high").notNull(),

    computedAt: integer("computed_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    // One estimate per record per factor set, so an upgrade adds rows rather
    // than overwriting the history it is supposed to preserve.
    uniqueIndex("estimates_record_factors_idx").on(t.usageRecordId, t.factorsVersion),
    index("estimates_factors_idx").on(t.factorsVersion),
  ],
);

/** Audit trail for sync runs, so a partial backfill is visible rather than inferred. */
export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    status: text("status").notNull(), // running | ok | error | partial
    recordsIngested: integer("records_ingested").notNull().default(0),
    bytesScanned: integer("bytes_scanned").notNull().default(0),
    /** Counts of anything skipped, JSON. Silent truncation reads as "covered everything". */
    warningsJson: text("warnings_json").notNull().default("{}"),
    error: text("error"),
  },
  (t) => [index("sync_runs_source_idx").on(t.sourceId, t.startedAt)],
);
