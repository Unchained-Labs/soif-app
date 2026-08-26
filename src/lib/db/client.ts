import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as sqliteSchema from "./schema.sqlite";
import * as postgresSchema from "./schema.postgres";

/**
 * Database selection.
 *
 * SQLite is the default so a developer can run a local scan with no
 * infrastructure at all; Postgres is opt-in for the multi-source org case.
 * The driver is chosen from `DATABASE_URL`:
 *
 *   (unset)                       → ./data/soif.db
 *   file:./data/soif.db           → SQLite
 *   postgres://… / postgresql://… → Postgres
 *
 * Call sites import `schema` from here rather than either schema module
 * directly, so switching engines is a config change, not a code change.
 */

export type Dialect = "sqlite" | "postgres";

export interface DatabaseHandle {
  dialect: Dialect;
  // Drizzle's SQLite and Postgres clients have structurally different types.
  // The query surface used by this app is the shared subset; the repository
  // layer narrows it, so `unknown` here is deliberate rather than lazy.
  db: unknown;
  schema: typeof sqliteSchema | typeof postgresSchema;
  close: () => Promise<void>;
}

const DEFAULT_SQLITE_PATH = "./data/soif.db";

export function resolveDialect(url = process.env.DATABASE_URL): Dialect {
  if (!url || url.startsWith("file:") || url.endsWith(".db")) return "sqlite";
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) return "postgres";
  throw new Error(
    `Unrecognised DATABASE_URL "${redactUrl(url)}". Use file:./data/soif.db or postgres://…`,
  );
}

/** The schema module matching the configured dialect. */
export function activeSchema(url = process.env.DATABASE_URL) {
  return resolveDialect(url) === "postgres" ? postgresSchema : sqliteSchema;
}

/** SQLite file path from a `file:` URL, or the default. */
export function sqlitePath(url = process.env.DATABASE_URL): string {
  if (!url) return DEFAULT_SQLITE_PATH;
  return url.startsWith("file:") ? url.slice("file:".length) : url;
}

let handle: DatabaseHandle | null = null;

/** Open (or reuse) the configured database. */
export async function getDatabase(url = process.env.DATABASE_URL): Promise<DatabaseHandle> {
  if (handle) return handle;
  const dialect = resolveDialect(url);

  if (dialect === "postgres") {
    const [{ drizzle }, postgresModule] = await Promise.all([
      import("drizzle-orm/postgres-js"),
      import("postgres"),
    ]);
    const client = postgresModule.default(url!, { max: 4 });
    handle = {
      dialect,
      db: drizzle(client, { schema: postgresSchema }),
      schema: postgresSchema,
      close: async () => {
        await client.end();
        handle = null;
      },
    };
    return handle;
  }

  const [{ drizzle }, betterSqlite] = await Promise.all([
    import("drizzle-orm/better-sqlite3"),
    import("better-sqlite3"),
  ]);
  const path = sqlitePath(url);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const client = new betterSqlite.default(path);
  // WAL keeps the dashboard readable while a scan is writing; foreign keys are
  // off by default in SQLite and the cascade deletes depend on them.
  client.pragma("journal_mode = WAL");
  client.pragma("foreign_keys = ON");
  handle = {
    dialect,
    db: drizzle(client, { schema: sqliteSchema }),
    schema: sqliteSchema,
    close: async () => {
      client.close();
      handle = null;
    },
  };
  return handle;
}

/** Drop the cached handle. Tests and the CLI use this between runs. */
export async function closeDatabase(): Promise<void> {
  await handle?.close();
  handle = null;
}

/**
 * Strip credentials from a connection string before it reaches a log or an
 * error message. A Postgres URL carries a password inline, and an unhandled
 * connection error will happily print the whole thing.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    if (parsed.username) parsed.username = "***";
    return parsed.toString();
  } catch {
    return url.replace(/\/\/[^@/]+@/, "//***@");
  }
}

export { sqliteSchema, postgresSchema };
