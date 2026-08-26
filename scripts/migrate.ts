/**
 * Apply migrations to the configured database.
 *
 * Deliberately a script rather than something the app runs on boot: a
 * self-hosted deployment should be able to see the schema change as a discrete
 * step, and a dashboard process racing itself to migrate is a bad way to find
 * out your two replicas disagree.
 */
import { closeDatabase, getDatabase, redactUrl, resolveDialect, sqlitePath } from "@/lib/db/client";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const dialect = resolveDialect(url);
  const handle = await getDatabase(url);

  console.log(
    `migrating ${dialect} — ${dialect === "sqlite" ? sqlitePath(url) : redactUrl(url!)}`,
  );

  if (dialect === "postgres") {
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migrate(handle.db as any, { migrationsFolder: "./drizzle/postgres" });
  } else {
    const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    migrate(handle.db as any, { migrationsFolder: "./drizzle/sqlite" });
  }

  await closeDatabase();
  console.log("migrations applied");
}

main().catch(async (error) => {
  await closeDatabase().catch(() => {});
  // Never print the raw error object: a connection failure carries the URL,
  // and a Postgres URL carries a password.
  console.error(`migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
