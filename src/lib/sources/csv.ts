import { normalizeTokens, type InputConvention } from "./normalize";
import type { UsageRecordInput } from "@/lib/db/repository";
import { vendorFromModel } from "./providers";

/**
 * CSV import — the universal path.
 *
 * Every provider that is not worth a bespoke adapter is worth this one: a
 * billing export, a spreadsheet, a query result from someone's own logging.
 * It is the only source that genuinely covers *any* vendor, which makes it
 * load-bearing for the multi-provider story rather than a leftover.
 *
 * The one thing an importer must not do is guess. A CSV that does not say
 * whether its input column includes cached tokens is ambiguous by an order of
 * magnitude, so the convention is declared explicitly and defaults to the
 * conservative reading rather than being inferred from the numbers.
 */

export class CsvImportError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = "CsvImportError";
  }
}

/** Column aliases accepted for each field, lowercased and punctuation-stripped. */
const ALIASES: Record<string, readonly string[]> = {
  timestamp: ["timestamp", "time", "date", "day", "bucket", "startsat", "starttime", "createdat"],
  model: ["model", "modelname", "modelid", "engine", "deployment"],
  input: ["inputtokens", "input", "prompttokens", "prompt", "uncachedinputtokens", "uncachedinput"],
  cached: ["cachedtokens", "cached", "cachereadinputtokens", "cacheread", "inputcachedtokens", "cachedinputtokens"],
  cacheCreation: ["cachecreationtokens", "cachecreation", "cachecreationinputtokens", "cachewrite", "cachewritetokens"],
  output: ["outputtokens", "output", "completiontokens", "completion"],
  reasoning: ["reasoningtokens", "reasoning", "thinkingtokens", "thinking", "reasoningoutputtokens"],
  region: ["region", "geo", "inferencegeo", "location"],
  project: ["project", "projectid", "workspace", "workspaceid"],
};

export interface CsvImportOptions {
  sourceId: string;
  /**
   * Whether the input column already includes cached tokens. OpenAI-style
   * exports are `inclusive`; Anthropic-style are `disjoint`.
   */
  inputConvention?: InputConvention;
  /** Rows with no model column fall back to this, if given. */
  defaultModel?: string;
}

export interface CsvImportResult {
  records: UsageRecordInput[];
  /** Rows skipped, with the reason, so an import never silently loses data. */
  skipped: Array<{ line: number; reason: string }>;
  /** Distinct vendors detected across the file. */
  vendors: string[];
  columnsUsed: Record<string, string>;
}

/**
 * Parse a usage CSV into records.
 *
 * Deliberately strict about the two columns that carry meaning — a timestamp
 * and a token count — and forgiving about everything else, because exports in
 * the wild carry arbitrary extra columns.
 */
export function importCsv(text: string, options: CsvImportOptions): CsvImportResult {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new CsvImportError("file is empty");

  const header = rows[0]!;
  const columns = mapColumns(header);
  if (columns.timestamp === undefined) {
    throw new CsvImportError(
      `no timestamp column found. Accepted names: ${ALIASES.timestamp!.join(", ")}`,
    );
  }
  if (columns.output === undefined && columns.input === undefined) {
    throw new CsvImportError("no token columns found; need at least an input or output column");
  }

  const convention = options.inputConvention ?? "disjoint";
  const records: UsageRecordInput[] = [];
  const skipped: CsvImportResult["skipped"] = [];
  const vendors = new Set<string>();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    const lineNumber = i + 1;
    if (row.length === 1 && row[0]!.trim() === "") continue;

    const rawTime = cell(row, columns.timestamp);
    const at = parseTimestamp(rawTime);
    if (!at) {
      skipped.push({ line: lineNumber, reason: `unparseable timestamp "${rawTime}"` });
      continue;
    }

    const model = cell(row, columns.model) || options.defaultModel || "";
    if (!model) {
      skipped.push({ line: lineNumber, reason: "no model, and no --model default given" });
      continue;
    }

    const tokens = normalizeTokens(
      {
        input: numberCell(row, columns.input),
        cacheRead: numberCell(row, columns.cached),
        cacheCreation: numberCell(row, columns.cacheCreation),
        output: numberCell(row, columns.output),
        reasoning: numberCell(row, columns.reasoning),
      },
      convention,
    );

    if (tokens.inputTokens + tokens.cachedTokens + tokens.cacheCreationTokens + tokens.outputTokens === 0) {
      skipped.push({ line: lineNumber, reason: "all token counts are zero" });
      continue;
    }

    vendors.add(vendorFromModel(model));
    records.push({
      sourceId: options.sourceId,
      // Identity is the row's own content, so re-importing the same file adds
      // nothing while a corrected file genuinely updates.
      dedupeKey: `csv:${at.toISOString()}|${model}|${tokens.inputTokens}|${tokens.cachedTokens}|${tokens.cacheCreationTokens}|${tokens.outputTokens}|${cell(row, columns.project)}`,
      bucketStart: at,
      bucketEnd: at,
      granularity: "1d",
      dayKey: at.toISOString().slice(0, 10),
      model,
      inputTokens: tokens.inputTokens,
      cachedTokens: tokens.cachedTokens,
      cacheCreationTokens: tokens.cacheCreationTokens,
      outputTokens: tokens.outputTokens,
      reasoningTokens: tokens.reasoningTokens,
      inferenceGeo: cell(row, columns.region) || null,
      workspaceId: cell(row, columns.project) || null,
    });
  }

  const columnsUsed: Record<string, string> = {};
  for (const [field, index] of Object.entries(columns)) {
    if (index !== undefined) columnsUsed[field] = header[index] ?? "";
  }

  return { records, skipped, vendors: [...vendors].sort(), columnsUsed };
}

/** Match header cells to known fields, tolerating case, spaces and punctuation. */
function mapColumns(header: readonly string[]): Record<string, number | undefined> {
  const normalised = header.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const columns: Record<string, number | undefined> = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    // Longest alias first, so `uncachedinputtokens` wins over `input`.
    const ordered = [...aliases].sort((a, b) => b.length - a.length);
    for (const alias of ordered) {
      const index = normalised.indexOf(alias);
      if (index !== -1) {
        columns[field] = index;
        break;
      }
    }
  }
  return columns;
}

/**
 * Minimal RFC 4180 reader.
 *
 * Handles quoted fields, escaped quotes and embedded newlines — the three
 * things that break a naive `split(",")` on a real billing export.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  // Strip a UTF-8 BOM, which spreadsheet exports include and which would
  // otherwise corrupt the first header name.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Parse a timestamp from a CSV cell.
 *
 * Accepts ISO 8601, a bare date, and unix seconds or milliseconds. A bare date
 * is read as UTC midnight rather than local, so an import does not shift by a
 * day depending on where it was run.
 */
export function parseTimestamp(raw: string): Date | null {
  const value = raw.trim();
  if (!value) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = Date.parse(`${value}T00:00:00Z`);
    return Number.isNaN(parsed) ? null : new Date(parsed);
  }

  if (/^\d+$/.test(value)) {
    const digits = Number(value);
    // Ten digits is seconds, thirteen is milliseconds; anything else is not a
    // unix timestamp and should fail rather than land in 1970 or the year 55000.
    if (value.length === 10) return new Date(digits * 1000);
    if (value.length === 13) return new Date(digits);
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function cell(row: readonly string[], index: number | undefined): string {
  return index === undefined ? "" : (row[index] ?? "").trim();
}

function numberCell(row: readonly string[], index: number | undefined): number {
  const raw = cell(row, index).replace(/[,_\s]/g, "");
  if (!raw) return 0;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}
