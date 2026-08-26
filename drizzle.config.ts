import { defineConfig } from "drizzle-kit";

// Migrations are generated per dialect. SQLite is the default; set
// DATABASE_URL to a postgres:// URL to generate the Postgres set.
const isPostgres = (process.env.DATABASE_URL ?? "").startsWith("postgres");

export default defineConfig({
  dialect: isPostgres ? "postgresql" : "sqlite",
  schema: isPostgres ? "./src/lib/db/schema.postgres.ts" : "./src/lib/db/schema.sqlite.ts",
  out: isPostgres ? "./drizzle/postgres" : "./drizzle/sqlite",
  dbCredentials: { url: process.env.DATABASE_URL ?? "file:./data/soif.db" },
});
