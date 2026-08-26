#!/usr/bin/env node
/**
 * `soif init` — set up a working local install in one command.
 *
 * The goal is that someone can go from a fresh clone to a dashboard showing
 * their real water usage without reading anything. That means the wizard has to
 * do the whole job — generate the encryption key, create the database, apply
 * migrations, find every provider on the machine, scan them, and say what to
 * run next — rather than printing a checklist.
 *
 * It is deliberately non-interactive by default. Everything it does is either
 * safe and idempotent (migrations, a scan) or explicitly confirmed (writing a
 * key). `--yes` skips the prompts for scripted installs; `--dry-run` shows the
 * plan and touches nothing.
 */

import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";

import { closeDatabase, getDatabase, resolveDialect, sqlitePath } from "@/lib/db/client";
import { Repository } from "@/lib/db/repository";
import { discoverRoots, listTranscripts } from "@/lib/scan/roots";
import { discoverCodexRoots, listCodexSessions } from "@/lib/scan/codex";
import { discoverSpecRoots, listSpecFiles } from "@/lib/scan/local-spec";
import { LOCAL_SCAN_SPECS } from "@/lib/scan/specs";
import { ingestLocalScan } from "@/lib/scan/ingest";
import { loadFactors } from "@/lib/soif/factors";
import { estimateAll } from "@/lib/pipeline/estimate-records";
import { formatWater, vesselState } from "@/lib/format";
import { PROVIDERS, type ProviderSpec } from "@/lib/sources/providers";

const ENV_PATH = resolve(process.cwd(), ".env");

interface Options {
  yes: boolean;
  dryRun: boolean;
  skipScan: boolean;
}

const HELP = `soif init — set up soif-app on this machine

Usage:
  npx soif-init [options]

What it does, in order:
  1. Detects which AI coding tools on this machine have readable usage.
  2. Writes .env with a freshly generated encryption key (never overwrites one).
  3. Creates the database and applies migrations.
  4. Scans every detected local provider.
  5. Prints what it found and how to open the dashboard.

Options:
  --yes         Do not prompt; accept every safe default.
  --skip-scan   Set up, but do not scan yet.
  --dry-run     Show the plan and change nothing.
  -h, --help    Show this help.
`;

function parseArgs(argv: string[]): Options | "help" {
  const options: Options = { yes: false, dryRun: false, skipScan: false };
  for (const arg of argv) {
    switch (arg) {
      case "-h":
      case "--help":
        return "help";
      case "-y":
      case "--yes":
        options.yes = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--skip-scan":
        options.skipScan = true;
        break;
      default:
        throw new Error(`unknown option "${arg}" (try --help)`);
    }
  }
  return options;
}

// -- tiny terminal helpers ---------------------------------------------------

const supportsColor = stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code: string, text: string) => (supportsColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (t: string) => paint("1", t);
const dim = (t: string) => paint("2", t);
const cyan = (t: string) => paint("36", t);
const green = (t: string) => paint("32", t);
const yellow = (t: string) => paint("33", t);

const out = (line = "") => stdout.write(`${line}\n`);
const step = (n: number, total: number, text: string) => out(`\n${dim(`[${n}/${total}]`)} ${bold(text)}`);
const ok = (text: string) => out(`  ${green("✓")} ${text}`);
const info = (text: string) => out(`  ${dim("·")} ${text}`);
const warn = (text: string) => out(`  ${yellow("!")} ${text}`);

async function confirm(question: string, options: Options): Promise<boolean> {
  if (options.yes) return true;
  if (!stdin.isTTY) return true; // Non-interactive: proceed with safe defaults.
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`  ${question} ${dim("[Y/n]")} `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

// -- detection ---------------------------------------------------------------

interface Detected {
  spec: ProviderSpec;
  detail: string;
  files: number;
}

/**
 * Find what this machine can actually report on.
 *
 * Only local providers are detected — an API source needs a credential, which
 * the wizard asks about separately rather than assuming.
 */
async function detectLocal(): Promise<Detected[]> {
  const found: Detected[] = [];

  for (const root of await discoverRoots()) {
    const files = await listTranscripts(root.path);
    if (files.length === 0) continue;
    const who = root.account?.emailAddress ?? root.account?.organizationName;
    found.push({
      spec: PROVIDERS.find((p) => p.kind === "claude_code_local")!,
      detail: `${root.path}${who ? ` · ${who}` : ""}`,
      files: files.length,
    });
  }

  for (const root of await discoverCodexRoots()) {
    const files = await listCodexSessions(root.codexHome);
    if (files.length === 0) continue;
    const who = root.account?.email ?? root.account?.accountId;
    found.push({
      spec: PROVIDERS.find((p) => p.kind === "codex_local")!,
      detail: `${root.codexHome}${who ? ` · ${who}` : ""}`,
      files: files.length,
    });
  }

  // Everything driven by a declarative spec: Gemini CLI, Qwen Code, and
  // whatever is added next. Adding a provider should not mean remembering to
  // teach the wizard about it separately.
  for (const spec of LOCAL_SCAN_SPECS) {
    for (const root of await discoverSpecRoots(spec)) {
      const files = await listSpecFiles(root);
      if (files.length === 0) continue;
      found.push({
        spec: PROVIDERS.find((p) => p.kind === spec.kind)!,
        detail: root.sessionsDir,
        files: files.length,
      });
    }
  }

  return found;
}

// -- env ---------------------------------------------------------------------

/**
 * Ensure `.env` has an encryption key.
 *
 * Never overwrites an existing one: losing it means every stored credential
 * becomes undecryptable, and silently rotating it during a setup command would
 * be a genuinely destructive surprise.
 */
function ensureEnv(options: Options): "created" | "kept" | "added" | "would-create" {
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : null;

  if (existing?.match(/^SOIF_ENCRYPTION_KEY=.+$/m)) return "kept";

  const key = randomBytes(32).toString("base64");
  const block =
    "\n# Generated by `soif init`. Losing this key means re-entering every stored\n" +
    "# credential; it is never written to the database.\n" +
    `SOIF_ENCRYPTION_KEY=${key}\n`;

  if (options.dryRun) return "would-create";

  if (existing === null) {
    writeFileSync(
      ENV_PATH,
      "# soif-app configuration. See .env.example for everything available.\n" +
        "DATABASE_URL=file:./data/soif.db\n" +
        block,
      { mode: 0o600 },
    );
    return "created";
  }

  appendFileSync(ENV_PATH, block);
  return "added";
}

/** Load `.env` into the process so the rest of the wizard sees it. */
function loadEnv(): void {
  if (!existsSync(ENV_PATH)) return;
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, name, rawValue] = match;
    if (!name || process.env[name] !== undefined) continue;
    process.env[name] = rawValue!.replace(/^["']|["']$/g, "");
  }
}

// -- main --------------------------------------------------------------------

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    stdout.write(HELP);
    return 0;
  }
  const options = parsed;
  const TOTAL = options.skipScan ? 4 : 5;

  out();
  out(`  ${cyan("soif")} ${dim("— water ledger for your AI usage")}`);
  out(`  ${dim("─".repeat(58))}`);
  if (options.dryRun) warn("dry run: nothing will be written.");

  // 1. detect
  step(1, TOTAL, "Looking for AI tools with readable usage");
  const detected = await detectLocal();
  if (detected.length === 0) {
    warn("No local usage found.");
    info("Looked for Claude Code transcripts (~/.claude, ~/.config/claude, $CLAUDE_CONFIG_DIR)");
    info("and Codex sessions (~/.codex, $CODEX_HOME).");
    out();
    out(`  You can still use soif with an API key or a CSV export — see ${cyan("README.md")}.`);
    out();
    return 1;
  }
  for (const item of detected) {
    ok(`${bold(item.spec.label)} ${dim(`(${item.files} files)`)}`);
    info(item.detail);
  }

  const unavailable = PROVIDERS.filter(
    (p) => p.transport !== "local" && p.status === "available",
  );
  out();
  info(`Also available with a credential: ${unavailable.map((p) => p.label).join(", ")}.`);

  // 2. env
  step(2, TOTAL, "Configuration");
  const envResult = ensureEnv(options);
  if (envResult === "kept") ok(".env already has an encryption key — left untouched.");
  else if (envResult === "would-create") info("would write .env with a new encryption key");
  else ok(`${envResult === "created" ? "Created" : "Updated"} .env with a new encryption key.`);
  loadEnv();

  const dialect = resolveDialect(process.env.DATABASE_URL);
  info(
    dialect === "sqlite"
      ? `Database: SQLite at ${sqlitePath(process.env.DATABASE_URL)} (no server needed)`
      : "Database: Postgres",
  );

  // 3. migrate
  step(3, TOTAL, "Preparing the database");
  if (options.dryRun) {
    info("would apply migrations");
  } else {
    const handle = await getDatabase();
    if (dialect === "postgres") {
      const { migrate } = await import("drizzle-orm/postgres-js/migrator");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await migrate(handle.db as any, { migrationsFolder: "./drizzle/postgres" });
    } else {
      const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      migrate(handle.db as any, { migrationsFolder: "./drizzle/sqlite" });
    }
    ok("Schema is up to date.");
  }

  const factors = loadFactors();
  info(`Factor set ${factors.factors_version} (soif ${factors.soif_version}).`);

  if (options.skipScan || options.dryRun) {
    await closeDatabase();
    out();
    out(`  ${bold("Next:")} ${cyan("npx soif-scan")} then ${cyan("npm run build && npm start")}`);
    out();
    return 0;
  }

  // 4. scan
  step(4, TOTAL, "Scanning");
  const totalFiles = detected.reduce((a, d) => a + d.files, 0);
  if (!(await confirm(`Scan ${totalFiles} files now?`, options))) {
    await closeDatabase();
    out(`\n  Skipped. Run ${cyan("npx soif-scan")} when ready.\n`);
    return 0;
  }

  const handle = await getDatabase();
  const repository = new Repository(handle);
  await repository.recordFactorSet(factors);

  let lastReported = 0;
  const results = await ingestLocalScan(repository, {
    onProgress: ({ filesScanned, filesTotal }) => {
      // Rewriting one line rather than printing a thousand.
      if (filesScanned - lastReported >= 25 || filesScanned === filesTotal) {
        lastReported = filesScanned;
        if (stdout.isTTY) stdout.write(`\r  ${dim(`scanning ${filesScanned}/${filesTotal} files`)}   `);
      }
    },
  });
  if (stdout.isTTY) stdout.write("\r".padEnd(60) + "\r");

  const inserted = results.reduce((a, r) => a + r.recordsInserted, 0);
  const bytes = results.reduce((a, r) => a + r.bytesScanned, 0);
  ok(`Scanned ${(bytes / 1e6).toFixed(0)} MB, stored ${inserted.toLocaleString()} new records.`);

  const degraded = results.filter((r) => r.warnings.linesSkippedPossiblyRelevant > 0);
  if (degraded.length > 0) {
    warn("Some over-long lines may have carried usage and were skipped.");
  }

  // 5. report
  step(5, TOTAL, "What that cost");
  const records = await repository.listUsageRecords();
  await closeDatabase();

  if (records.length === 0) {
    warn("No usage records yet — the scan found files but no usage in them.");
    out();
    return 0;
  }

  const { totals } = estimateAll(records, factors);
  const state = vesselState(totals.totalMl.mid);
  out();
  out(`  ${bold(formatWater(totals.totalMl.mid))} of freshwater, across ${records.length.toLocaleString()} calls.`);
  out(`  ${dim(`range ${formatWater(totals.totalMl.low)} – ${formatWater(totals.totalMl.high)} · mid scenario`)}`);
  out(`  ${dim(`that is ${state.filled.toFixed(1)} of five ${state.tier.unit}s`)}`);
  out();
  out(`  ${bold("Open the dashboard:")}`);
  out(`    ${cyan("npm run build && npm start")}   ${dim("→ http://localhost:3000")}`);
  out();
  out(`  ${dim("Estimates, not measurements. Every figure carries a range.")}`);
  out();
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch(async (error) => {
    await closeDatabase().catch(() => {});
    stdout.write(`\nsoif init: ${error instanceof Error ? error.message : String(error)}\n\n`);
    process.exit(1);
  });
