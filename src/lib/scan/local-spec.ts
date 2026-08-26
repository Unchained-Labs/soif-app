import { homedir } from "node:os";
import { readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { scanJsonl, type ScanResult } from "./jsonl";
import { normalizeTokens, type Conventions, type NormalizedTokens } from "@/lib/sources/normalize";
import type { SourceKind, VendorId } from "@/lib/sources/providers";

/**
 * A declarative adapter for tools that log usage as JSONL.
 *
 * Claude Code and Codex get bespoke parsers because they have real structural
 * complexity — cross-file subagent reconciliation, cumulative-vs-delta totals.
 * Most other agent CLIs do not: they append one JSON object per message with
 * the token counts nested somewhere predictable. Writing a parser each time
 * would mean six near-identical files, six chances to get the prefilter wrong,
 * and six places to fix a shared bug.
 *
 * So the shape is data instead: where the files live, which records matter, and
 * where in each record the numbers are. Adding a provider is a spec and a
 * fixture, and the fixture is what stops the spec from being a guess.
 *
 * **Every spec must be verified against the tool's own source or real output
 * before it ships.** A plausible-looking spec that silently reads zeros is
 * worse than no adapter at all, because the dashboard would report a confident
 * total that is missing an entire provider. `verifiedFrom` records the
 * evidence, and the runner reports `recordsMatched: 0` loudly.
 */

/** A dotted path into a JSON object, e.g. `message.usage.input_tokens`. */
export type FieldPath = string;

export interface LocalScanSpec {
  kind: SourceKind;
  vendor: VendorId;
  label: string;
  /** Where the evidence for this spec came from. Required — no unverified specs. */
  verifiedFrom: string;

  /** Directories to look for, relative to home, in priority order. */
  homeDirs: readonly string[];
  /** Environment variable that overrides the home dir, if the tool has one. */
  envVar?: string;
  /** Sub-path under the tool's home where session files live. Searched recursively. */
  sessionsSubdir?: readonly string[];
  /** File extension to scan. */
  extension: string;

  /**
   * Byte prefilter. A line must contain **any** of these to be parsed.
   *
   * Any rather than all: the model frequently arrives on a different record
   * type than the token counts, and requiring all of them on one line matches
   * nothing. That exact mistake made every Codex row come out unattributed.
   */
  prefilter: readonly string[];

  /** A record is a usage record when this path holds a non-empty object. */
  usagePath: FieldPath;
  /** Optional guard: record must have this path equal to this value. */
  recordType?: { path: FieldPath; equals: string };

  /** Where the numbers are, relative to the record root (not to `usagePath`). */
  fields: {
    input?: FieldPath;
    cacheRead?: FieldPath;
    cacheCreation?: FieldPath;
    output?: FieldPath;
    reasoning?: FieldPath;
    /** Additional prompt-side tokens to fold into input, e.g. tool-use prompts. */
    extraInput?: readonly FieldPath[];
  };

  /** Model name. First path that resolves wins. */
  modelPaths: readonly FieldPath[];
  /** Timestamp. First path that resolves wins. */
  timestampPaths: readonly FieldPath[];
  /** Session id, optional. */
  sessionPaths?: readonly FieldPath[];
  /** Working directory / project, optional. */
  projectPaths?: readonly FieldPath[];

  conventions: Conventions;
  /** True when the tool reports real inference geography. Almost none do. */
  reportsGeo?: boolean;
}

export interface SpecRoot {
  spec: LocalScanSpec;
  /** The tool's home directory. */
  home: string;
  /** Directory containing session files. */
  sessionsDir: string;
}

export interface SpecUsageRow {
  dedupeKey: string;
  timestamp: string;
  dayKey: string;
  model: string;
  sessionId: string | null;
  project: string | null;
  tokens: NormalizedTokens;
  sourceFile: string;
}

export interface SpecParseResult {
  rows: SpecUsageRow[];
  scan: ScanResult;
  malformedLines: number;
  /** Records that matched the prefilter but had no usable usage block. */
  recordsWithoutUsage: number;
  /** Usage records dropped because no model could be resolved. */
  unknownModelRecords: number;
}

/** Read a dotted path out of a parsed record. */
export function readPath(record: unknown, path: FieldPath): unknown {
  let current: unknown = record;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function numberAt(record: unknown, path: FieldPath | undefined): number {
  if (!path) return 0;
  const value = readPath(record, path);
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function stringAt(record: unknown, paths: readonly FieldPath[] | undefined): string | null {
  for (const path of paths ?? []) {
    const value = readPath(record, path);
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** Discover every root on this machine matching a spec. */
export async function discoverSpecRoots(
  spec: LocalScanSpec,
  options: { env?: Record<string, string | undefined>; home?: string } = {},
): Promise<SpecRoot[]> {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();

  const candidates: string[] = [];
  const configured = spec.envVar ? env[spec.envVar]?.trim() : undefined;
  if (configured) {
    // Several entries means several accounts on one machine.
    for (const part of configured.split(process.platform === "win32" ? ";" : ":")) {
      if (part.trim()) candidates.push(resolve(expandTilde(part.trim(), home)));
    }
  }
  for (const dir of spec.homeDirs) candidates.push(join(home, dir));

  const seen = new Set<string>();
  const roots: SpecRoot[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (!(await isDirectory(candidate))) continue;

    // A spec may name several plausible session subdirectories, because tools
    // move them between versions. Every one that exists is scanned.
    const subdirs = spec.sessionsSubdir?.length ? spec.sessionsSubdir : [""];
    for (const sub of subdirs) {
      const sessionsDir = sub ? join(candidate, sub) : candidate;
      if (!(await isDirectory(sessionsDir))) continue;
      roots.push({ spec, home: candidate, sessionsDir });
    }
  }
  return roots;
}

/** Every session file under a root. */
export async function listSpecFiles(root: SpecRoot): Promise<string[]> {
  const out: string[] = [];
  await walk(root.sessionsDir, root.spec.extension, out);
  out.sort();
  return out;
}

/**
 * The byte prefilter a spec actually runs with.
 *
 * A spec's declared `prefilter` covers the usage records, but the model, the
 * session id and the project usually arrive on *earlier* records of a different
 * type — and a line the prefilter rejects is a line the parser never sees. That
 * has now caused the same bug twice: Codex rows came out with no model, and
 * Gemini rows came out with no session. Both times the spec looked right.
 *
 * So the needles are derived rather than hand-listed: declaring a path to a
 * field automatically admits the lines that carry it. The mistake stops being
 * possible instead of being caught in review.
 *
 * Timestamps are deliberately excluded — nearly every record has one, so
 * including them would admit the whole file and defeat the prefilter, whose
 * entire job is to keep a multi-hundred-megabyte scan off the JSON parser.
 */
export function effectivePrefilter(spec: LocalScanSpec): string[] {
  const needles = new Set<string>(spec.prefilter);
  for (const path of [...spec.modelPaths, ...(spec.sessionPaths ?? []), ...(spec.projectPaths ?? [])]) {
    const leaf = path.split(".").pop();
    if (leaf) needles.add(`"${leaf}"`);
  }
  return [...needles];
}

/** Parse one session file according to its spec. */
export async function parseWithSpec(
  spec: LocalScanSpec,
  path: string,
  options: { offset?: number; signal?: AbortSignal } = {},
): Promise<SpecParseResult> {
  const rows: SpecUsageRow[] = [];
  let malformedLines = 0;
  let recordsWithoutUsage = 0;
  let unknownModelRecords = 0;
  let index = 0;

  // Carried forward: some tools put the model or cwd on an earlier record.
  let lastModel: string | null = null;
  let lastSession: string | null = null;
  let lastProject: string | null = null;

  const scan = await scanJsonl(
    path,
    (line) => {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line.bytes.toString("utf8")) as Record<string, unknown>;
      } catch {
        malformedLines += 1;
        return;
      }

      lastModel = stringAt(record, spec.modelPaths) ?? lastModel;
      lastSession = stringAt(record, spec.sessionPaths) ?? lastSession;
      lastProject = stringAt(record, spec.projectPaths) ?? lastProject;

      if (spec.recordType) {
        const value = readPath(record, spec.recordType.path);
        if (value !== spec.recordType.equals) return;
      }

      const usage = readPath(record, spec.usagePath);
      if (typeof usage !== "object" || usage === null) {
        recordsWithoutUsage += 1;
        return;
      }

      const timestamp = stringAt(record, spec.timestampPaths);
      if (!timestamp) return;
      const dayKey = utcDayKey(timestamp);
      if (!dayKey) return;

      let input = numberAt(record, spec.fields.input);
      for (const extra of spec.fields.extraInput ?? []) input += numberAt(record, extra);

      const tokens = normalizeTokens(
        {
          input,
          cacheRead: numberAt(record, spec.fields.cacheRead),
          cacheCreation: numberAt(record, spec.fields.cacheCreation),
          output: numberAt(record, spec.fields.output),
          reasoning: numberAt(record, spec.fields.reasoning),
        },
        spec.conventions,
      );

      if (
        tokens.inputTokens + tokens.cachedTokens + tokens.cacheCreationTokens + tokens.outputTokens ===
        0
      ) {
        recordsWithoutUsage += 1;
        return;
      }

      if (!lastModel) {
        unknownModelRecords += 1;
        return;
      }

      rows.push({
        // No message id in these formats, so identity is the file plus the
        // record's position and timestamp. Stable across re-scans, which is
        // what keeps ingestion idempotent.
        dedupeKey: `${path}#${index}@${timestamp}`,
        timestamp,
        dayKey,
        model: lastModel,
        sessionId: lastSession,
        project: lastProject,
        tokens,
        sourceFile: path,
      });
      index += 1;
    },
    { offset: options.offset, requireAny: effectivePrefilter(spec), signal: options.signal },
  );

  return { rows, scan, malformedLines, recordsWithoutUsage, unknownModelRecords };
}

export function utcDayKey(timestamp: string): string | null {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

async function walk(dir: string, extension: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, extension, out);
    else if (entry.isFile() && entry.name.endsWith(extension)) out.push(full);
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function expandTilde(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith(`~${sep}`) || path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}
