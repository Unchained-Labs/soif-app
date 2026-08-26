/**
 * The one place raw provider token counts become comparable.
 *
 * Providers disagree about what "input tokens" means, and the disagreement is
 * not cosmetic — it is worth an order of magnitude in the estimate:
 *
 *   Anthropic  `input_tokens` EXCLUDES cache reads. They are reported
 *              separately as `cache_read_input_tokens`.
 *   OpenAI     `input_tokens` INCLUDES cache reads. `input_cached_tokens` is a
 *              SUBSET of it. (Confirmed against OpenAI's usage API docs and
 *              against the Codex CLI's own accounting, which clamps the same
 *              way.)
 *
 * soif charges cache reads at 1% of an output token and uncached input at 10%.
 * So passing OpenAI's `input_tokens` through unchanged, alongside its cached
 * count, bills every cached token at 10x its correct weight *and* counts it
 * twice. On an agentic workload — where cache reads outnumber output tokens by
 * ~300:1 on the reference corpus — that is the difference between a right
 * answer and a meaningless one.
 *
 * Everything downstream of this module assumes **disjoint** counts, and the
 * database stores them that way.
 */

/** Disjoint token counts. `inputTokens` never includes cached or cache-creation. */
export interface NormalizedTokens {
  /** Prompt tokens that were neither a cache read nor a cache write. */
  inputTokens: number;
  /** Cache *read* tokens — charged at 1% of an output token. */
  cachedTokens: number;
  /** Cache *write* tokens — a full prefill, charged as ordinary input. */
  cacheCreationTokens: number;
  outputTokens: number;
  /** Thinking tokens, already inside `outputTokens`. Recorded, never re-added. */
  reasoningTokens: number;
}

/** How a provider reports its prompt-token total. */
export type InputConvention =
  /** `input` excludes cache reads and writes (Anthropic, Claude Code). */
  | "disjoint"
  /** `input` is the whole prompt, with cache reads a subset (OpenAI, Codex). */
  | "inclusive";

/**
 * How a provider reports thinking tokens relative to its output count.
 *
 * A third disagreement, and it matters because soif charges reasoning at the
 * *full* output rate — the most expensive token class there is:
 *
 *   Anthropic  `output_tokens` already contains the thinking tokens.
 *              Adding them again double-charges the priciest tokens.
 *   Google     `candidatesTokenCount` excludes `thoughtsTokenCount`; the two
 *              sum into `totalTokenCount`. Not adding them silently drops all
 *              reasoning work, which on a thinking model is most of the cost.
 *
 * Verified from google-gemini/gemini-cli's own recorder, which writes the raw
 * `usageMetadata` fields straight through.
 */
export type ReasoningConvention =
  /** Thinking tokens are already counted inside `output` (Anthropic, OpenAI). */
  | "inside-output"
  /** Thinking tokens are reported alongside `output` and must be added (Google). */
  | "separate";

export interface RawTokens {
  input?: number;
  cacheRead?: number;
  cacheCreation?: number;
  output?: number;
  reasoning?: number;
}

export interface Conventions {
  input: InputConvention;
  /** Defaults to `inside-output`, which is what most providers do. */
  reasoning?: ReasoningConvention;
}

/**
 * Normalise raw counts to disjoint ones.
 *
 * Clamps rather than trusts: a cached count larger than the total prompt would
 * otherwise produce negative uncached input and a nonsensical estimate. Under
 * the inclusive convention the subsets are subtracted in order — cache reads
 * first, then cache writes out of what remains — so no token is counted twice
 * and none is invented.
 */
export function normalizeTokens(
  raw: RawTokens,
  convention: InputConvention | Conventions,
): NormalizedTokens {
  const conventions: Conventions =
    typeof convention === "string" ? { input: convention } : convention;

  const input = nonNegative(raw.input);
  const rawReasoning = nonNegative(raw.reasoning);

  // Under `separate`, thinking tokens sit outside the reported output, so they
  // are folded in — the stored `outputTokens` is always the full decode cost,
  // and `reasoningTokens` is always the portion of it that was thinking.
  const output =
    conventions.reasoning === "separate"
      ? nonNegative(raw.output) + rawReasoning
      : nonNegative(raw.output);
  const reasoning = Math.min(rawReasoning, output);

  if (conventions.input === "disjoint") {
    return {
      inputTokens: input,
      cachedTokens: nonNegative(raw.cacheRead),
      cacheCreationTokens: nonNegative(raw.cacheCreation),
      outputTokens: output,
      reasoningTokens: reasoning,
    };
  }

  const cachedTokens = Math.min(nonNegative(raw.cacheRead), input);
  const afterCache = input - cachedTokens;
  const cacheCreationTokens = Math.min(nonNegative(raw.cacheCreation), afterCache);

  return {
    inputTokens: afterCache - cacheCreationTokens,
    cachedTokens,
    cacheCreationTokens,
    outputTokens: output,
    reasoningTokens: reasoning,
  };
}

/** True when a normalised record carries no usage at all. */
export function isEmpty(tokens: NormalizedTokens): boolean {
  return (
    tokens.inputTokens === 0 &&
    tokens.cachedTokens === 0 &&
    tokens.cacheCreationTokens === 0 &&
    tokens.outputTokens === 0
  );
}

/** Total prompt tokens, however they were split. Useful for sanity checks. */
export function promptTotal(tokens: NormalizedTokens): number {
  return tokens.inputTokens + tokens.cachedTokens + tokens.cacheCreationTokens;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}
