/**
 * Anthropic Usage & Cost Admin API client.
 *
 * The flagship ingestion path: real token counts per model, per bucket, with
 * geographic routing. Requires an admin key (`sk-ant-admin01-…`) from the
 * Console — org accounts only.
 *
 * Two facts shape the whole design:
 *
 *  - **Buckets are capped per request** (1d → 31, 1h → 168, 1m → 1440), so
 *    "lifetime" means paginated backfill into our own store. This client is
 *    built for resumable backfill, not for proxying a live request.
 *  - **The four token counts are reported separately** and must stay that way.
 *    Cached input is charged at 1% of an output token; folding it into `input`
 *    inflates an agentic workload's estimate by roughly an order of magnitude.
 *
 * What this deliberately does not do: touch `api/oauth/usage`. That undocumented
 * endpoint is what Claude Code uses internally; it returns quota percentages
 * rather than token counts, is not a public contract, and will break. Personal
 * Pro/Max accounts have no usage API — the honest answer there is the local
 * transcript scan, and the UI says so rather than inventing a source.
 */

export const USAGE_REPORT_URL = "https://api.anthropic.com/v1/organizations/usage_report/messages";
export const COST_REPORT_URL = "https://api.anthropic.com/v1/organizations/cost_report";
const ANTHROPIC_VERSION = "2023-06-01";

/** Maximum buckets the API returns per request, by width. */
export const BUCKET_LIMITS = { "1m": 1440, "1h": 168, "1d": 31 } as const;
export type BucketWidth = keyof typeof BUCKET_LIMITS;

/** Data lands within ~5 min and the documented guidance is at most one poll per minute. */
export const MIN_POLL_INTERVAL_MS = 60_000;

export class AnthropicAdminError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AnthropicAdminError";
  }
}

export interface UsageBucket {
  startsAt: string;
  endsAt: string;
  model: string;
  /** `us` | `global` | `not_available` when grouped by inference_geo. */
  inferenceGeo: string | null;
  serviceTier: string | null;
  workspaceId: string | null;
  apiKeyId: string | null;
  uncachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
}

export interface UsagePage {
  buckets: UsageBucket[];
  hasMore: boolean;
  nextPage: string | null;
}

export interface FetchOptions {
  apiKey: string;
  startingAt: Date;
  endingAt: Date;
  bucketWidth?: BucketWidth;
  groupBy?: readonly string[];
  page?: string | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

const DEFAULT_GROUP_BY = ["model", "inference_geo", "service_tier"] as const;

/** Validate an admin key's shape before spending a request on it. */
export function isAdminKey(key: string): boolean {
  return key.trim().toLowerCase().startsWith("sk-ant-admin");
}

/**
 * Classify a credential by prefix, the way CodexBar routes Claude credentials.
 *
 * Worth being explicit rather than accepting anything: an operator who pastes
 * a *workspace* key (`sk-ant-api…`) gets a clear message instead of a 401, and
 * an OAuth token gets refused rather than quietly used against an endpoint it
 * was never scoped for.
 */
export function classifyCredential(raw: string): "admin" | "oauth" | "api" | "unknown" {
  const trimmed = raw.trim().toLowerCase().replace(/^bearer\s+/, "");
  if (trimmed.startsWith("sk-ant-admin")) return "admin";
  if (trimmed.startsWith("sk-ant-oat")) return "oauth";
  if (trimmed.startsWith("sk-ant-api")) return "api";
  return "unknown";
}

function buildUrl(options: FetchOptions): string {
  const url = new URL(USAGE_REPORT_URL);
  url.searchParams.set("starting_at", isoSeconds(options.startingAt));
  url.searchParams.set("ending_at", isoSeconds(options.endingAt));
  url.searchParams.set("bucket_width", options.bucketWidth ?? "1d");
  for (const field of options.groupBy ?? DEFAULT_GROUP_BY) {
    url.searchParams.append("group_by[]", field);
  }
  if (options.page) url.searchParams.set("page", options.page);
  return url.toString();
}

/** Fetch one page of usage buckets. */
export async function fetchUsagePage(options: FetchOptions): Promise<UsagePage> {
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(buildUrl(options), {
    method: "GET",
    headers: {
      "anthropic-version": ANTHROPIC_VERSION,
      "x-api-key": options.apiKey,
      accept: "application/json",
      "user-agent": options.userAgent ?? "soif-app/0.1.0 (https://github.com/Unchained-Labs/soif-app)",
    },
    signal: options.signal,
  });

  if (!response.ok) {
    // The body may echo request context; never include it in the error, and
    // never include the key. Status alone is enough to act on.
    throw new AnthropicAdminError(
      describeStatus(response.status),
      response.status,
      response.status === 429 || response.status >= 500,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AnthropicAdminError("usage report returned a non-JSON body", response.status);
  }

  return parseUsageResponse(body);
}

/** Parse a usage report response. Exported so fixtures can be tested without a network. */
export function parseUsageResponse(body: unknown): UsagePage {
  const root = asRecord(body);
  if (!root) throw new AnthropicAdminError("usage report response was not an object");

  const data = Array.isArray(root.data) ? root.data : [];
  const buckets: UsageBucket[] = [];

  for (const rawBucket of data) {
    const bucket = asRecord(rawBucket);
    if (!bucket) continue;
    const startsAt = asString(bucket.starting_at);
    const endsAt = asString(bucket.ending_at);
    if (!startsAt || !endsAt) continue;

    const results = Array.isArray(bucket.results) ? bucket.results : [];
    for (const rawResult of results) {
      const result = asRecord(rawResult);
      if (!result) continue;

      const uncached = count(result.uncached_input_tokens);
      const cacheRead = count(result.cache_read_input_tokens);
      const cacheCreation = cacheCreationTotal(result);
      const output = count(result.output_tokens);
      if (uncached + cacheRead + cacheCreation + output === 0) continue;

      buckets.push({
        startsAt,
        endsAt,
        model: asString(result.model) ?? "unknown",
        inferenceGeo: asString(result.inference_geo) ?? null,
        serviceTier: asString(result.service_tier) ?? null,
        workspaceId: asString(result.workspace_id) ?? null,
        apiKeyId: asString(result.api_key_id) ?? null,
        uncachedInputTokens: uncached,
        cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: cacheCreation,
        outputTokens: output,
      });
    }
  }

  return {
    buckets,
    hasMore: root.has_more === true,
    nextPage: asString(root.next_page) ?? null,
  };
}

/**
 * Cache-creation tokens are reported either flat or split by TTL depending on
 * the account. Both shapes must sum to the same total, because the estimator
 * charges all cache-creation tokens at the uncached input rate.
 */
function cacheCreationTotal(result: Record<string, unknown>): number {
  const flat = count(result.cache_creation_input_tokens);
  if (flat > 0) return flat;
  const split = asRecord(result.cache_creation);
  if (!split) return 0;
  return count(split.ephemeral_5m_input_tokens) + count(split.ephemeral_1h_input_tokens);
}

/**
 * Walk every page in a window, yielding buckets as they arrive.
 *
 * Async generator rather than an array so a backfill can persist and checkpoint
 * incrementally — a month of 1h buckets is 168 per page and an interrupted
 * backfill should not lose the pages it already paid for.
 */
export async function* streamUsage(
  options: FetchOptions & { maxPages?: number },
): AsyncGenerator<UsagePage, void, void> {
  let page = options.page ?? null;
  let pages = 0;
  const maxPages = options.maxPages ?? 1000;

  while (pages < maxPages) {
    const result = await fetchUsagePage({ ...options, page });
    yield result;
    pages += 1;
    if (!result.hasMore || !result.nextPage) return;
    // A server that reports has_more while repeating a cursor would spin here.
    if (result.nextPage === page) {
      throw new AnthropicAdminError("pagination cursor did not advance");
    }
    page = result.nextPage;
  }
  throw new AnthropicAdminError(`pagination exceeded ${maxPages} pages; refusing to continue`);
}

/**
 * Split a long window into request-sized chunks.
 *
 * The bucket cap is per request, so a lifetime backfill is a sequence of
 * windows. Returned oldest-first so an interrupted backfill resumes from a
 * contiguous prefix rather than a hole.
 */
export function planBackfillWindows(
  startingAt: Date,
  endingAt: Date,
  bucketWidth: BucketWidth = "1d",
): Array<{ startingAt: Date; endingAt: Date }> {
  if (endingAt <= startingAt) return [];
  const bucketMs = { "1m": 60_000, "1h": 3_600_000, "1d": 86_400_000 }[bucketWidth];
  const windowMs = bucketMs * BUCKET_LIMITS[bucketWidth];

  const windows: Array<{ startingAt: Date; endingAt: Date }> = [];
  let cursor = startingAt.getTime();
  while (cursor < endingAt.getTime()) {
    const next = Math.min(cursor + windowMs, endingAt.getTime());
    windows.push({ startingAt: new Date(cursor), endingAt: new Date(next) });
    cursor = next;
  }
  return windows;
}

/**
 * A stable identity for a bucket row, so re-syncing a window is idempotent.
 *
 * Everything that distinguishes one reported row from another within a bucket
 * has to be in the key — dropping `inference_geo` here would silently collapse
 * a US and a global row into one and halve the reported usage.
 */
export function bucketDedupeKey(bucket: UsageBucket): string {
  return [
    bucket.startsAt,
    bucket.endsAt,
    bucket.model,
    bucket.inferenceGeo ?? "-",
    bucket.serviceTier ?? "-",
    bucket.workspaceId ?? "-",
    bucket.apiKeyId ?? "-",
  ].join("|");
}

function describeStatus(status: number): string {
  switch (status) {
    case 401:
      return "admin key rejected (401). Check it is an sk-ant-admin key from the Console.";
    case 403:
      return "admin key lacks permission for the usage report (403).";
    case 404:
      return "usage report not found (404) — the Admin API is unavailable for individual accounts.";
    case 429:
      return "rate limited (429). Poll at most once per minute.";
    default:
      return `usage report request failed (HTTP ${status}).`;
  }
}

/** The API wants whole seconds; a millisecond suffix is rejected. */
function isoSeconds(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}
