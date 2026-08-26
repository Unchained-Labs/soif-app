#!/usr/bin/env node
/**
 * `soif-scan` — read Claude Code transcripts and report the water they cost.
 *
 * This is the path that makes soif usable by an individual developer. Personal
 * Pro/Max subscriptions expose no usage API, so the local transcript is the
 * only honest source of real per-message token counts — and it works on any
 * plan, on any machine, without a credential.
 *
 * By default it prints locally and stores nothing outside the chosen database.
 * `--push` sends aggregates to a self-hosted instance; there is no soif-operated
 * endpoint to send them to, and no default URL.
 */

import { closeDatabase, getDatabase } from "@/lib/db/client";
import { Repository } from "@/lib/db/repository";
import { ingestLocalScan, type IngestWarnings } from "@/lib/scan/ingest";
import { discoverRoots } from "@/lib/scan/roots";
import { loadFactors } from "@/lib/soif/factors";
import {
  estimateAll,
  estimateGrouped,
  litresPerMillionOutputTokens,
  type AggregateTotals,
} from "@/lib/pipeline/estimate-records";
import {
  describeSpread,
  formatEnergy,
  formatTokens,
  formatTriple,
  formatVesselCount,
  formatWater,
  showersEquivalent,
  vesselState,
} from "@/lib/format";

interface Options {
  importCsvPath: string | null;
  csvConvention: "disjoint" | "inclusive";
  csvModel: string | null;
  full: boolean;
  json: boolean;
  quiet: boolean;
  includeEmbodied: boolean;
  roots: string[];
  since: string | null;
  until: string | null;
  push: string | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options | "help" {
  const options: Options = {
    importCsvPath: null,
    csvConvention: "disjoint",
    csvModel: null,
    full: false,
    json: false,
    quiet: false,
    includeEmbodied: true,
    roots: [],
    since: null,
    until: null,
    push: null,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        return "help";
      case "--full":
        options.full = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--quiet":
        options.quiet = true;
        break;
      case "--no-embodied":
        options.includeEmbodied = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--root":
        options.roots.push(requireValue(argv, ++i, arg));
        break;
      case "--import":
        options.importCsvPath = requireValue(argv, i + 1, arg);
        i++;
        break;
      case "--csv-inclusive-input":
        // OpenAI-style exports, where the input column already contains the
        // cached tokens. Getting this wrong is a 10x error, so it is explicit.
        options.csvConvention = "inclusive";
        break;
      case "--csv-model":
        options.csvModel = requireValue(argv, i + 1, arg);
        i++;
        break;
      case "--since":
        options.since = requireValue(argv, i + 1, arg);
        i++;
        break;
      case "--until":
        options.until = requireValue(argv, i + 1, arg);
        i++;
        break;
      case "--push":
        options.push = requireValue(argv, i + 1, arg);
        i++;
        break;
      default:
        throw new Error(`unknown option "${arg}" (try --help)`);
    }
  }
  return options;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new Error(`${flag} needs a value`);
  return value;
}

const HELP = `soif-scan — water footprint of your local Claude Code usage

Usage:
  soif-scan [options]

Options:
  --root <path>     Scan this config or projects dir (repeatable). Default: discover.
  --import <file>   Import a usage CSV instead of scanning (any provider).
  --csv-inclusive-input
                    The CSV's input column already includes cached tokens
                    (OpenAI-style). Omit for Anthropic-style disjoint columns.
  --csv-model <id>  Model to assume for CSV rows with no model column.
  --full            Ignore stored cursors and re-read every transcript.
  --since <date>    Only report days >= YYYY-MM-DD.
  --until <date>    Only report days <= YYYY-MM-DD.
  --no-embodied     Operational water only (the scope of Google's published figures).
  --json            Emit machine-readable JSON.
  --quiet           Suppress progress output.
  --dry-run         Scan and report without writing to the database.
  --push <url>      POST aggregates to a self-hosted soif-app instance.
  -h, --help        Show this help.

Environment:
  DATABASE_URL          file:./data/soif.db (default) or postgres://…
  CLAUDE_CONFIG_DIR     Colon-separated config dirs, one per account.
  SOIF_FACTORS_PATH     Pin a specific factors.json.

Estimates are estimates. Every figure carries a low/mid/high scenario band;
the spread is often ~100x. See https://github.com/Unchained-Labs/soif.
`;

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  const options = parsed;
  const log = (message: string) => {
    if (!options.quiet && !options.json) process.stderr.write(`${message}\n`);
  };

  if (options.importCsvPath) {
    return importCsvFile(options, log);
  }

  const roots = await discoverRoots(options.roots.length > 0 ? { explicit: options.roots } : {});
  if (roots.length === 0) {
    process.stderr.write(
      "No Claude Code transcripts found.\n" +
        "Looked for a projects/ directory under $CLAUDE_CONFIG_DIR, ~/.claude and ~/.config/claude.\n" +
        "Point at one explicitly with --root <path>.\n",
    );
    return 1;
  }

  const factors = loadFactors();
  // A dry run must not create a source row or move a cursor, so it gets its own
  // throwaway in-memory database rather than a flag threaded through the store.
  const handle = await getDatabase(options.dryRun ? "file::memory:" : undefined);
  const repository = new Repository(handle);
  await repository.recordFactorSet(factors);

  log(`scanning ${roots.length} root(s) with factor set ${factors.factors_version}`);
  const results = await ingestLocalScan(repository, {
    roots,
    full: options.full || options.dryRun,
    onProgress: ({ filesScanned, filesTotal }) => {
      if (filesScanned % 25 === 0) log(`  ${filesScanned}/${filesTotal} files`);
    },
  });

  const records = await repository.listUsageRecords({
    from: options.since ?? undefined,
    to: options.until ?? undefined,
  });

  const { totals } = estimateAll(records, factors, { includeEmbodied: options.includeEmbodied });
  const byModel = estimateGrouped(records, (r) => r.model, factors, {
    includeEmbodied: options.includeEmbodied,
  });
  const byDay = estimateGrouped(records, (r) => r.dayKey, factors, {
    includeEmbodied: options.includeEmbodied,
  });

  const payload: ScanPayload = {
    factorsVersion: factors.factors_version,
    includeEmbodied: options.includeEmbodied,
    scannedRoots: results.map((r) => ({
      path: r.rootPath,
      kind: r.kind,
      account: accountLabel(r.account),
      filesScanned: r.filesScanned,
      bytesScanned: r.bytesScanned,
      rowsParsed: r.rowsParsed,
      rowsCollapsed: r.rowsCollapsed,
      recordsInserted: r.recordsInserted,
      warnings: r.warnings,
    })),
    totals,
    byModel: Object.fromEntries(byModel),
    byDay: Object.fromEntries(byDay),
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    printReport(payload, records.length, options);
  }

  if (options.push) {
    await push(options.push, payload, log);
  }

  await closeDatabase();
  // A scan that might have missed a usage record should not report success.
  const degraded = results.some((r) => r.warnings.linesSkippedPossiblyRelevant > 0);
  if (degraded) {
    process.stderr.write(
      "\nwarning: some over-long lines may have carried usage and were skipped.\n" +
        "Re-run with a larger line cap, or report this — the default is sized for real transcripts.\n",
    );
    return 2;
  }
  return 0;
}

/** What `--json` prints and `--push` sends: aggregates only, never content. */
export interface ScanPayload {
  factorsVersion: string;
  includeEmbodied: boolean;
  scannedRoots: Array<{
    path: string;
    kind: string;
    account: string | null;
    filesScanned: number;
    bytesScanned: number;
    rowsParsed: number;
    rowsCollapsed: number;
    recordsInserted: number;
    warnings: IngestWarnings;
  }>;
  totals: AggregateTotals;
  byModel: Record<string, AggregateTotals>;
  byDay: Record<string, AggregateTotals>;
}

function printReport(payload: ScanPayload, recordCount: number, options: Options): void {
  const { totals } = payload;
  const out = (line = "") => process.stdout.write(`${line}\n`);

  out();
  out(`  soif — local Claude Code scan`);
  out(`  ${"─".repeat(58)}`);
  for (const root of payload.scannedRoots) {
    const who = root.account ? ` · ${root.account}` : "";
    const provider = root.kind === "codex_local" ? "Codex" : "Claude Code";
    out(`  [${provider}] ${root.path}${who}`);
    out(
      `    ${root.filesScanned} files, ${(root.bytesScanned / 1e6).toFixed(0)} MB new, ` +
        `${root.rowsParsed.toLocaleString()} rows (${root.rowsCollapsed} deduped)`,
    );
  }
  out();

  if (recordCount === 0) {
    out("  No usage records in range.");
    out();
    return;
  }

  const state = vesselState(totals.totalMl.mid);
  out(`  Water consumed   ${formatWater(totals.totalMl.mid)}`);
  out(`  Range            ${formatWater(totals.totalMl.low)} – ${formatWater(totals.totalMl.high)}`);
  const spread = describeSpread(totals.totalMl);
  if (spread) out(`                   (${spread}; scenario spread, not a confidence interval)`);
  out(`  Vessels          5 × ${state.tier.unit} — ${formatVesselCount(state.filled)}`);
  out(`  Energy           ${formatEnergy(totals.energyFacilityWh.mid)} at the meter, incl. PUE`);
  out(`  Equivalent to    ${showersEquivalent(totals.totalMl.mid).toFixed(1)} showers (45 L each, mid only)`);
  out();

  out(`  Where it goes`);
  const operational = totals.onsiteMl.mid + totals.offsiteMl.mid;
  const grand = operational + totals.embodiedMl.mid;
  for (const [label, value] of [
    ["On-site — cooling towers", totals.onsiteMl.mid],
    ["Off-site — power generation", totals.offsiteMl.mid],
    ["Embodied — chips & buildings", totals.embodiedMl.mid],
  ] as const) {
    if (value === 0 && label.startsWith("Embodied")) continue;
    const share = grand > 0 ? ((value / grand) * 100).toFixed(0) : "0";
    out(`    ${label.padEnd(30)} ${formatWater(value).padStart(12)}  ${share.padStart(3)}%`);
  }
  if (!options.includeEmbodied) out(`    (embodied water excluded)`);
  out();

  out(`  Which models drank it`);
  const models = Object.entries(payload.byModel).sort((a, b) => b[1].totalMl.mid - a[1].totalMl.mid);
  for (const [model, group] of models.slice(0, 8)) {
    out(
      `    ${model.padEnd(30)} ${formatWater(group.totalMl.mid).padStart(12)}  ` +
        `${formatTokens(group.outputTokens).padStart(7)} out / ${formatTokens(group.cachedTokens).padStart(7)} cached`,
    );
  }
  out();

  const intensity = litresPerMillionOutputTokens(totals);
  if (intensity) out(`  Intensity        ${intensity.mid.toFixed(2)} L per 1M output tokens (mid)`);
  const days = Object.keys(payload.byDay).sort();
  if (days.length > 0) out(`  Period           ${days[0]} … ${days.at(-1)} (${days.length} days)`);
  out(`  Factor set       ${payload.factorsVersion}`);
  out();
  out(`  Estimates, not measurements. Full method: METHODOLOGY.md in Unchained-Labs/soif`);
  out();
}

/**
 * Import a usage CSV from any provider.
 *
 * The universal path: a billing export, a spreadsheet, a query result. It is
 * the only source that covers vendors with no local CLI and no admin API, so it
 * carries the multi-provider story wherever a bespoke adapter does not reach.
 */
async function importCsvFile(options: Options, log: (m: string) => void): Promise<number> {
  const { readFile } = await import("node:fs/promises");
  const { importCsv } = await import("@/lib/sources/csv");

  const text = await readFile(options.importCsvPath!, "utf8");
  const factors = loadFactors();
  const handle = await getDatabase(options.dryRun ? "file::memory:" : undefined);
  const repository = new Repository(handle);
  await repository.recordFactorSet(factors);

  const label = options.importCsvPath!;
  const existing = await repository.findSource("csv", label);
  const sourceId = await repository.upsertSource({ id: existing?.id, kind: "csv", label });

  const result = importCsv(text, {
    sourceId,
    inputConvention: options.csvConvention,
    defaultModel: options.csvModel ?? undefined,
  });

  const inserted = await repository.insertUsageRecords(result.records);
  const { totals } = estimateAll(result.records, factors, {
    includeEmbodied: options.includeEmbodied,
  });
  await closeDatabase();

  log(`columns: ${JSON.stringify(result.columnsUsed)}`);
  process.stdout.write(
    `\n  Imported ${result.records.length} rows (${inserted} new) from ${label}\n` +
      `  Vendors: ${result.vendors.join(", ") || "none"}\n` +
      `  Water:   ${formatTriple(totals.totalMl)}\n`,
  );
  if (result.skipped.length > 0) {
    // Every skipped row is named: a silent drop in an import is
    // indistinguishable from usage that never happened.
    process.stderr.write(`\n  ${result.skipped.length} row(s) skipped:\n`);
    for (const skip of result.skipped.slice(0, 10)) {
      process.stderr.write(`    line ${skip.line}: ${skip.reason}\n`);
    }
    if (result.skipped.length > 10) {
      process.stderr.write(`    … and ${result.skipped.length - 10} more\n`);
    }
  }
  process.stdout.write("\n");
  return 0;
}

/**
 * A display label for a source's account, from whatever identity it exposes.
 *
 * Providers name their account differently — Claude has an email and an org,
 * Codex has an email and a plan — so this reads the fields that exist rather
 * than assuming one shape. Never touches a token.
 */
function accountLabel(account: object | null): string | null {
  if (!account) return null;
  const fields = account as Record<string, unknown>;
  for (const key of ["emailAddress", "email", "organizationName", "accountId", "accountUuid"]) {
    const value = fields[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/** POST aggregates to a self-hosted instance. Token counts only — never content. */
async function push(target: string, payload: ScanPayload, log: (m: string) => void): Promise<void> {
  const url = new URL("/api/ingest/local-scan", target);
  if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
    throw new Error(
      `refusing to push over ${url.protocol} to a non-local host. Use https:// or a loopback address.`,
    );
  }
  log(`pushing aggregates to ${url.origin}`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.SOIF_PUSH_TOKEN ? { authorization: `Bearer ${process.env.SOIF_PUSH_TOKEN}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`push failed with HTTP ${response.status}`);
  log("pushed");
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

main()
  .then((code) => process.exit(code))
  .catch(async (error) => {
    await closeDatabase().catch(() => {});
    process.stderr.write(`soif-scan: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
