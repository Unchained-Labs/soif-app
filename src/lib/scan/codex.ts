import { homedir } from "node:os";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { scanJsonl, type ScanResult } from "./jsonl";
import { normalizeTokens, type NormalizedTokens } from "@/lib/sources/normalize";

/**
 * Codex CLI session rollouts — the OpenAI local path.
 *
 * Codex writes one JSONL rollout per session under `~/.codex/sessions/YYYY/MM/DD/`,
 * with archived sessions alongside. The record that matters is a `token_count`
 * event:
 *
 *   {"type":"event_msg","timestamp":"…","payload":{"type":"token_count","info":{
 *      "model":"openai/gpt-5.5",
 *      "last_token_usage":  {"input_tokens":10,"cached_input_tokens":0,"output_tokens":1},
 *      "total_token_usage": {"input_tokens":10,"cached_input_tokens":0,"output_tokens":1}}}}
 *
 * Two things about this format decide whether the numbers come out right:
 *
 *  - **`total_token_usage` is cumulative for the session; `last_token_usage` is
 *    the delta for one turn.** Summing the totals multiplies usage by roughly
 *    the number of turns. This reads the deltas and falls back to the final
 *    total only when no delta was ever reported.
 *  - **`input_tokens` is the whole prompt, with `cached_input_tokens` a subset
 *    of it** — the opposite of Anthropic. `normalizeTokens` handles the
 *    subtraction; nothing here should do it by hand.
 *
 * The model often appears on a preceding `turn_context` record rather than on
 * the usage event, so the most recent one seen is carried forward.
 */

/**
 * A rollout's usable information is spread across three record kinds: the model
 * arrives on `turn_context`, the cwd and session id on `session_meta`, and the
 * counts on `token_count`. Requiring all three on one line would match nothing.
 */
const PREFILTER_ANY = ['"token_count"', '"session_meta"', '"turn_context"'] as const;

export interface CodexUsageRow {
  dedupeKey: string;
  timestamp: string;
  dayKey: string;
  model: string;
  sessionId: string | null;
  /** Working directory the session ran in — the per-project grouping key. */
  project: string | null;
  tokens: NormalizedTokens;
  sourceFile: string;
  /** True when the row came from a cumulative total rather than a per-turn delta. */
  fromSessionTotal: boolean;
}

export interface CodexParseResult {
  rows: CodexUsageRow[];
  scan: ScanResult;
  malformedLines: number;
  /** Usage events with no resolvable model name. */
  unknownModelEvents: number;
}

export interface CodexRoot {
  /** Directory containing session rollouts. */
  path: string;
  /** The Codex home this belongs to (`~/.codex`). */
  codexHome: string;
  origin: "CODEX_HOME" | "default" | "explicit";
  /** Non-secret account label, when one can be read without touching a token. */
  account?: { accountId?: string; email?: string; plan?: string };
}

/**
 * Discover Codex session directories.
 *
 * `CODEX_HOME` may hold several entries separated by the platform delimiter,
 * which is how one machine drives more than one ChatGPT account.
 */
export async function discoverCodexRoots(
  options: { env?: Record<string, string | undefined>; home?: string; explicit?: readonly string[] } = {},
): Promise<CodexRoot[]> {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();

  const candidates: Array<{ codexHome: string; origin: CodexRoot["origin"] }> = [];

  if (options.explicit?.length) {
    for (const path of options.explicit) {
      const abs = resolve(expandTilde(path, home));
      // Accept either ~/.codex or ~/.codex/sessions.
      candidates.push({
        codexHome: abs.endsWith(`${sep}sessions`) ? abs.slice(0, -`${sep}sessions`.length) : abs,
        origin: "explicit",
      });
    }
  } else {
    const configured = env.CODEX_HOME?.trim();
    if (configured) {
      for (const part of configured.split(process.platform === "win32" ? ";" : ":")) {
        if (part.trim()) {
          candidates.push({ codexHome: resolve(expandTilde(part.trim(), home)), origin: "CODEX_HOME" });
        }
      }
    }
    candidates.push({ codexHome: join(home, ".codex"), origin: "default" });
  }

  const seen = new Set<string>();
  const roots: CodexRoot[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.codexHome)) continue;
    seen.add(candidate.codexHome);
    if (!(await isDirectory(candidate.codexHome))) continue;
    // Sessions may live directly under the home or under `sessions/`; both are
    // walked, so a layout change does not silently yield zero usage.
    if (!(await isDirectory(join(candidate.codexHome, "sessions")))
        && !(await isDirectory(join(candidate.codexHome, "archived_sessions")))) {
      continue;
    }
    roots.push({
      path: candidate.codexHome,
      codexHome: candidate.codexHome,
      origin: candidate.origin,
      account: await readCodexAccount(candidate.codexHome),
    });
  }
  return roots;
}

/**
 * Non-secret account label from `~/.codex/auth.json`.
 *
 * Only the identity fields are lifted. That file also holds OAuth tokens; they
 * are never read, never stored, and never logged.
 */
export async function readCodexAccount(codexHome: string): Promise<CodexRoot["account"] | undefined> {
  try {
    const raw = await readFile(join(codexHome, "auth.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const tokens = asRecord(parsed.tokens);
    const claims = asRecord(tokens?.id_token) ?? asRecord(parsed.id_token);
    const account = {
      accountId: asString(parsed.account_id) ?? asString(claims?.["chatgpt_account_id"]),
      email: asString(claims?.email),
      plan: asString(claims?.["chatgpt_plan_type"]),
    };
    return Object.values(account).some(Boolean) ? account : undefined;
  } catch {
    return undefined;
  }
}

/** Every rollout file under a Codex home, live and archived. */
export async function listCodexSessions(codexHome: string): Promise<string[]> {
  const out: string[] = [];
  for (const dir of ["sessions", "archived_sessions"]) {
    await walk(join(codexHome, dir), out);
  }
  out.sort();
  return out;
}

/** Parse one rollout from `offset` onward. */
export async function parseCodexSession(
  path: string,
  options: { offset?: number; signal?: AbortSignal } = {},
): Promise<CodexParseResult> {
  const rows: CodexUsageRow[] = [];
  let malformedLines = 0;
  let unknownModelEvents = 0;

  // Carried forward across records within the file.
  let currentModel: string | null = null;
  let sessionId: string | null = null;
  let project: string | null = null;
  let sawDelta = false;
  let lastTotal: { tokens: NormalizedTokens; timestamp: string; model: string } | null = null;
  let eventIndex = 0;

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

      const payload = asRecord(record.payload);

      // `session_meta` and `turn_context` carry the identity and the model that
      // subsequent usage events refer to.
      if (record.type === "session_meta" && payload) {
        sessionId = asString(payload.session_id) ?? asString(payload.id) ?? sessionId;
        project = asString(payload.cwd) ?? project;
        return;
      }
      if (record.type === "turn_context" && payload) {
        currentModel = asString(payload.model) ?? currentModel;
        project = asString(payload.cwd) ?? project;
        return;
      }
      if (!payload || payload.type !== "token_count") return;

      const info = asRecord(payload.info);
      if (!info) return;

      const model = asString(info.model) ?? currentModel;
      const timestamp = asString(record.timestamp) ?? asString(payload.timestamp);
      if (!timestamp) return;
      const dayKey = utcDayKey(timestamp);
      if (!dayKey) return;
      if (!model) {
        unknownModelEvents += 1;
        return;
      }

      const last = asRecord(info.last_token_usage);
      const total = asRecord(info.total_token_usage);

      if (last) {
        const tokens = readCodexTokens(last);
        // Codex emits a token_count event per turn; a zero delta is a no-op
        // rather than a record worth storing.
        if (tokens.inputTokens + tokens.cachedTokens + tokens.outputTokens > 0) {
          sawDelta = true;
          rows.push({
            // Rollout files have no per-turn id, so identity is the file plus
            // the event's position and timestamp. Stable across re-scans, which
            // is what keeps ingestion idempotent.
            dedupeKey: `${path}#${eventIndex}@${timestamp}`,
            timestamp,
            dayKey,
            model,
            sessionId,
            project,
            tokens,
            sourceFile: path,
            fromSessionTotal: false,
          });
        }
        eventIndex += 1;
      }

      if (total) {
        lastTotal = { tokens: readCodexTokens(total), timestamp, model };
      }
    },
    { offset: options.offset, requireAny: PREFILTER_ANY, signal: options.signal },
  );

  // Older rollouts report only cumulative totals. Using the final total is
  // correct there; using it *as well as* the deltas would double the session.
  if (!sawDelta && lastTotal !== null) {
    const total = lastTotal as { tokens: NormalizedTokens; timestamp: string; model: string };
    const dayKey = utcDayKey(total.timestamp);
    if (dayKey && total.tokens.inputTokens + total.tokens.cachedTokens + total.tokens.outputTokens > 0) {
      rows.push({
        dedupeKey: `${path}#session-total`,
        timestamp: total.timestamp,
        dayKey,
        model: total.model,
        sessionId,
        project,
        tokens: total.tokens,
        sourceFile: path,
        fromSessionTotal: true,
      });
    }
  }

  return { rows, scan, malformedLines, unknownModelEvents };
}

/**
 * Read one Codex usage block.
 *
 * `input_tokens` is the whole prompt with `cached_input_tokens` a subset, so
 * the inclusive convention applies. `reasoning_output_tokens` is part of
 * `output_tokens`, matching how the estimator treats thinking tokens.
 */
function readCodexTokens(block: Record<string, unknown>): NormalizedTokens {
  return normalizeTokens(
    {
      input: numberOf(block.input_tokens),
      cacheRead: numberOf(block.cached_input_tokens),
      output: numberOf(block.output_tokens),
      reasoning: numberOf(block.reasoning_output_tokens),
    },
    "inclusive",
  );
}

export function utcDayKey(timestamp: string): string | null {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
