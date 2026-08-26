import { describe, expect, it } from "vitest";
import { getTableConfig as sqliteConfig } from "drizzle-orm/sqlite-core";
import { getTableConfig as pgConfig } from "drizzle-orm/pg-core";
import * as sqliteSchema from "@/lib/db/schema.sqlite";
import * as pgSchema from "@/lib/db/schema.postgres";

/**
 * The two schemas must stay structurally identical.
 *
 * Drizzle has no portable column builder, so SQLite and Postgres are written
 * out twice. That is exactly the situation where a column gets added to one and
 * forgotten in the other, and the failure surfaces months later as a query that
 * works on a developer's laptop and 500s on the self-hosted deployment. Same
 * reasoning as the factors.json parity check upstream: if a thing is duplicated
 * by necessity, a test has to hold the copies together.
 */

const TABLE_NAMES = [
  "sources",
  "usageRecords",
  "scanCursors",
  "factorSets",
  "estimates",
  "syncRuns",
] as const;

type TableName = (typeof TABLE_NAMES)[number];

function sqliteShape(name: TableName) {
  const config = sqliteConfig(sqliteSchema[name]);
  return {
    table: config.name,
    columns: config.columns.map((c) => c.name).sort(),
    primaryKeys: config.columns.filter((c) => c.primary).map((c) => c.name).sort(),
    notNull: config.columns.filter((c) => c.notNull).map((c) => c.name).sort(),
    indexes: config.indexes.map((i) => i.config.name).sort(),
    uniqueIndexes: config.indexes.filter((i) => i.config.unique).map((i) => i.config.name).sort(),
  };
}

function postgresShape(name: TableName) {
  const config = pgConfig(pgSchema[name]);
  return {
    table: config.name,
    columns: config.columns.map((c) => c.name).sort(),
    primaryKeys: config.columns.filter((c) => c.primary).map((c) => c.name).sort(),
    notNull: config.columns.filter((c) => c.notNull).map((c) => c.name).sort(),
    indexes: config.indexes.map((i) => i.config.name).sort(),
    uniqueIndexes: config.indexes.filter((i) => i.config.unique).map((i) => i.config.name).sort(),
  };
}

describe("sqlite and postgres schemas agree", () => {
  it("declare the same set of tables", () => {
    const sqliteTables = TABLE_NAMES.filter((n) => n in sqliteSchema);
    const pgTables = TABLE_NAMES.filter((n) => n in pgSchema);
    expect(sqliteTables).toEqual([...TABLE_NAMES]);
    expect(pgTables).toEqual([...TABLE_NAMES]);
  });

  for (const name of TABLE_NAMES) {
    it(`${name}: identical columns, keys and indexes`, () => {
      expect(postgresShape(name)).toEqual(sqliteShape(name));
    });
  }
});

describe("schema invariants the dashboard depends on", () => {
  it("keeps the four token counts separate", () => {
    // Collapsing cached into input is an order-of-magnitude error on agentic
    // workloads, so the columns must exist independently in both engines.
    const required = [
      "input_tokens",
      "cached_tokens",
      "cache_creation_tokens",
      "output_tokens",
      "reasoning_tokens",
    ];
    for (const shape of [sqliteShape("usageRecords"), postgresShape("usageRecords")]) {
      for (const column of required) expect(shape.columns).toContain(column);
    }
  });

  it("stores every water quantity as a low/mid/high triple", () => {
    // A bare number without its range is the one thing this project must not
    // show, so the storage layer should make a bare number impossible.
    const quantities = ["energy_it_wh", "energy_facility_wh", "onsite_ml", "offsite_ml", "embodied_ml"];
    for (const shape of [sqliteShape("estimates"), postgresShape("estimates")]) {
      for (const q of quantities) {
        for (const bound of ["low", "mid", "high"]) {
          expect(shape.columns, `${q}_${bound}`).toContain(`${q}_${bound}`);
        }
      }
    }
  });

  it("makes re-sync idempotent via a unique dedupe key per source", () => {
    for (const shape of [sqliteShape("usageRecords"), postgresShape("usageRecords")]) {
      expect(shape.uniqueIndexes).toContain("usage_records_source_dedupe_idx");
    }
  });

  it("keys estimates by factor set so an upgrade adds rows rather than overwriting", () => {
    for (const shape of [sqliteShape("estimates"), postgresShape("estimates")]) {
      expect(shape.uniqueIndexes).toContain("estimates_record_factors_idx");
      expect(shape.columns).toContain("factors_version");
    }
  });

  it("has nowhere to put a plaintext credential", () => {
    // Only the sealed blob and its key id. A column named for a raw token would
    // be an invitation to write one.
    for (const shape of [sqliteShape("sources"), postgresShape("sources")]) {
      expect(shape.columns).toContain("credential_cipher");
      expect(shape.columns).toContain("credential_key_id");
      for (const forbidden of ["api_key", "access_token", "admin_key", "secret", "password", "cookie"]) {
        expect(shape.columns, `sources.${forbidden} must not exist`).not.toContain(forbidden);
      }
    }
  });
});
