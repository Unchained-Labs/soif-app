import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Postgres schema — the multi-source / multi-tenant option.
 *
 * A structural mirror of `schema.sqlite.ts`. Drizzle has no portable column
 * builder, so the two are written out separately and `tests/schema.test.ts`
 * asserts they declare the same tables and columns. Types differ where the
 * engines differ (real vs double precision, integer millis vs timestamptz,
 * text vs jsonb); names never do.
 *
 * Token counts are `bigint`: a year of agentic usage clears 2^31 cached tokens
 * comfortably — the corpus this was built against reached 6.2 billion in a
 * single month.
 */

export const sources = pgTable(
  "sources",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    /** Envelope-encrypted credential. Never logged, never returned by an API route. */
    credentialCipher: text("credential_cipher"),
    credentialKeyId: text("credential_key_id"),
    accountJson: jsonb("account_json"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastSyncError: text("last_sync_error"),
  },
  (t) => [index("sources_kind_idx").on(t.kind)],
);

export const usageRecords = pgTable(
  "usage_records",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    dedupeKey: text("dedupe_key").notNull(),
    bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
    bucketEnd: timestamp("bucket_end", { withTimezone: true }).notNull(),
    granularity: text("granularity").notNull(),
    dayKey: text("day_key").notNull(),
    model: text("model").notNull(),

    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    cachedTokens: bigint("cached_tokens", { mode: "number" }).notNull().default(0),
    cacheCreationTokens: bigint("cache_creation_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    reasoningTokens: bigint("reasoning_tokens", { mode: "number" }).notNull().default(0),

    inferenceGeo: text("inference_geo"),
    serviceTier: text("service_tier"),
    workspaceId: text("workspace_id"),
    apiKeyId: text("api_key_id"),
    sessionId: text("session_id"),
    sourceFile: text("source_file"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("usage_records_source_dedupe_idx").on(t.sourceId, t.dedupeKey),
    index("usage_records_day_idx").on(t.dayKey),
    index("usage_records_model_idx").on(t.model),
    index("usage_records_bucket_idx").on(t.bucketStart),
  ],
);

export const scanCursors = pgTable(
  "scan_cursors",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    committedOffset: bigint("committed_offset", { mode: "number" }).notNull().default(0),
    fileSize: bigint("file_size", { mode: "number" }).notNull().default(0),
    mtimeMs: bigint("mtime_ms", { mode: "number" }).notNull().default(0),
    lastScannedAt: timestamp("last_scanned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("scan_cursors_source_file_idx").on(t.sourceId, t.filePath)],
);

export const factorSets = pgTable("factor_sets", {
  version: text("version").primaryKey(),
  schemaVersion: text("schema_version").notNull(),
  soifVersion: text("soif_version").notNull(),
  document: jsonb("document").notNull(),
  loadedAt: timestamp("loaded_at", { withTimezone: true }).notNull().defaultNow(),
});

export const estimates = pgTable(
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
    assumptions: jsonb("assumptions").notNull().default(sql`'[]'::jsonb`),

    energyItWhLow: doublePrecision("energy_it_wh_low").notNull(),
    energyItWhMid: doublePrecision("energy_it_wh_mid").notNull(),
    energyItWhHigh: doublePrecision("energy_it_wh_high").notNull(),
    energyFacilityWhLow: doublePrecision("energy_facility_wh_low").notNull(),
    energyFacilityWhMid: doublePrecision("energy_facility_wh_mid").notNull(),
    energyFacilityWhHigh: doublePrecision("energy_facility_wh_high").notNull(),
    onsiteMlLow: doublePrecision("onsite_ml_low").notNull(),
    onsiteMlMid: doublePrecision("onsite_ml_mid").notNull(),
    onsiteMlHigh: doublePrecision("onsite_ml_high").notNull(),
    offsiteMlLow: doublePrecision("offsite_ml_low").notNull(),
    offsiteMlMid: doublePrecision("offsite_ml_mid").notNull(),
    offsiteMlHigh: doublePrecision("offsite_ml_high").notNull(),
    embodiedMlLow: doublePrecision("embodied_ml_low").notNull(),
    embodiedMlMid: doublePrecision("embodied_ml_mid").notNull(),
    embodiedMlHigh: doublePrecision("embodied_ml_high").notNull(),

    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("estimates_record_factors_idx").on(t.usageRecordId, t.factorsVersion),
    index("estimates_factors_idx").on(t.factorsVersion),
  ],
);

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: text("status").notNull(),
    recordsIngested: bigint("records_ingested", { mode: "number" }).notNull().default(0),
    bytesScanned: bigint("bytes_scanned", { mode: "number" }).notNull().default(0),
    warningsJson: jsonb("warnings_json").notNull().default(sql`'{}'::jsonb`),
    error: text("error"),
  },
  (t) => [index("sync_runs_source_idx").on(t.sourceId, t.startedAt)],
);
