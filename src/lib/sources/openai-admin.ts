import { normalizeTokens, type NormalizedTokens } from "./normalize";

/**
 * OpenAI organization usage API.
 *
 * Endpoint and field names verified against OpenAI's current documentation
 * rather than recalled:
 *
 *   GET https://api.openai.com/v1/organization/usage/completions
 *     ?start_time=<unix seconds>&end_time=<unix seconds>
 *     &bucket_width=1d            # 1m | 1h | 1d
 *     &group_by[]=model
 *     &limit=…&page=…
 *   Authorization: Bearer $OPENAI_ADMIN_KEY
 *
 * Response buckets carry `input_tokens`, `output_tokens`, `input_cached_tokens`
 * and `num_model_requests`.
 *
 * The critical difference from Anthropic: **`input_tokens` is the whole prompt
 * and `input_cached_tokens` is a subset of it.** `normalizeTokens` in the
 * inclusive mode does the subtraction; nothing here re-derives it.
 *
 * OpenAI reports no inference geography, so records from this source fall back
 * to the model's registry default region rather than a guess.
 */

export const USAGE_COMPLETIONS_URL = "https://api.openai.com/v1/organization/usage/completions";

/** Buckets returned per page. The API paginates rather than capping the window. */
export const DEFAULT_PAGE_LIMIT = 31;

export type BucketWidth = "1m" | "1h" | "1d";

export class OpenAIAdminError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "OpenAIAdminError";
  }
}

export interface OpenAIUsageBucket {
  /** Bucket start, ISO 8601. */
  startsAt: string;
  endsAt: string;
  model: string;
  projectId: string | null;
  apiKeyId: string | null;
  batch: boolean | null;
  serviceTier: string | null;
  tokens: NormalizedTokens;
  requests: number;
}

export interface OpenAIUsagePage {
  buckets: OpenAIUsageBucket[];
  hasMore: boolean;
  nextPage: string | null;
}

export interface FetchOptions {
  apiKey: string;
  startTime: Date;
  endTime?: Date;
  bucketWidth?: BucketWidth;
  groupBy?: readonly string[];
  limit?: number;
  page?: string | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

const DEFAULT_GROUP_BY = ["model", "project_id", "service_tier"] as const;

/**
 * Classify an OpenAI credential.
 *
 * OpenAI admin keys are not distinguishable from project keys by prefix alone
 * (`sk-admin-…` exists but is not universal), so this reports what it can and
 * lets the first request settle the rest — with a clear 401 message rather than
 * a silent empty dashboard.
 */
export function classifyCredential(raw: string): "admin" | "project" | "unknown" {
  const trimmed = raw.trim().toLowerCase().replace(/^bearer\s+/, "");
  if (trimmed.startsWith("sk-admin-")) return "admin";
  if (trimmed.startsWith("sk-proj-") || trimmed.startsWith("sk-")) return "project";
  return "unknown";
}

function buildUrl(options: FetchOptions): string {
  const url = new URL(USAGE_COMPLETIONS_URL);
  // The OpenAI usage API takes unix seconds, unlike Anthropic's ISO timestamps.
  url.searchParams.set("start_time", String(Math.floor(options.startTime.getTime() / 1000)));
  if (options.endTime) {
    url.searchParams.set("end_time", String(Math.floor(options.endTime.getTime() / 1000)));
  }
  url.searchParams.set("bucket_width", options.bucketWidth ?? "1d");
  for (const field of options.groupBy ?? DEFAULT_GROUP_BY) {
    url.searchParams.append("group_by[]", field);
  }
  url.searchParams.set("limit", String(options.limit ?? DEFAULT_PAGE_LIMIT));
  if (options.page) url.searchParams.set("page", options.page);
  return url.toString();
}

export async function fetchUsagePage(options: FetchOptions): Promise<OpenAIUsagePage> {
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(buildUrl(options), {
    method: "GET",
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      accept: "application/json",
      "user-agent": "soif-app/0.1.0 (https://github.com/Unchained-Labs/soif-app)",
    },
    signal: options.signal,
  });

  if (!response.ok) {
    // The body can echo request context; never include it, and never the key.
    throw new OpenAIAdminError(
      describeStatus(response.status),
      response.status,
      response.status === 429 || response.status >= 500,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OpenAIAdminError("usage endpoint returned a non-JSON body", response.status);
  }
  return parseUsageResponse(body);
}

/** Parse a usage response. Exported so fixtures can be tested without a network. */
export function parseUsageResponse(body: unknown): OpenAIUsagePage {
  const root = asRecord(body);
  if (!root) throw new OpenAIAdminError("usage response was not an object");

  const data = Array.isArray(root.data) ? root.data : [];
  const buckets: OpenAIUsageBucket[] = [];

  for (const rawBucket of data) {
    const bucket = asRecord(rawBucket);
    if (!bucket) continue;
    const startSeconds = numberOf(bucket.start_time);
    const endSeconds = numberOf(bucket.end_time);
    if (!startSeconds) continue;

    const results = Array.isArray(bucket.results) ? bucket.results : [];
    for (const rawResult of results) {
      const result = asRecord(rawResult);
      if (!result) continue;

      const tokens = normalizeTokens(
        {
          input: numberOf(result.input_tokens),
          cacheRead: numberOf(result.input_cached_tokens),
          output: numberOf(result.output_tokens),
        },
        "inclusive",
      );
      if (tokens.inputTokens + tokens.cachedTokens + tokens.outputTokens === 0) continue;

      buckets.push({
        startsAt: new Date(startSeconds * 1000).toISOString(),
        endsAt: new Date((endSeconds || startSeconds) * 1000).toISOString(),
        model: asString(result.model) ?? "unknown",
        projectId: asString(result.project_id) ?? null,
        apiKeyId: asString(result.api_key_id) ?? null,
        batch: typeof result.batch === "boolean" ? result.batch : null,
        serviceTier: asString(result.service_tier) ?? null,
        tokens,
        requests: numberOf(result.num_model_requests),
      });
    }
  }

  return {
    buckets,
    hasMore: root.has_more === true,
    nextPage: asString(root.next_page) ?? null,
  };
}

/** Walk every page from `startTime`, yielding as they arrive so a backfill can checkpoint. */
export async function* streamUsage(
  options: FetchOptions & { maxPages?: number },
): AsyncGenerator<OpenAIUsagePage, void, void> {
  let page = options.page ?? null;
  let pages = 0;
  const maxPages = options.maxPages ?? 1000;

  while (pages < maxPages) {
    const result = await fetchUsagePage({ ...options, page });
    yield result;
    pages += 1;
    if (!result.hasMore || !result.nextPage) return;
    if (result.nextPage === page) {
      throw new OpenAIAdminError("pagination cursor did not advance");
    }
    page = result.nextPage;
  }
  throw new OpenAIAdminError(`pagination exceeded ${maxPages} pages; refusing to continue`);
}

/**
 * Stable identity for a bucket row.
 *
 * Every field the API can split a bucket on has to be in the key, or two rows
 * that differ only by project or tier collapse into one and the reported usage
 * silently halves.
 */
export function bucketDedupeKey(bucket: OpenAIUsageBucket): string {
  return [
    bucket.startsAt,
    bucket.endsAt,
    bucket.model,
    bucket.projectId ?? "-",
    bucket.apiKeyId ?? "-",
    bucket.serviceTier ?? "-",
    bucket.batch === null ? "-" : String(bucket.batch),
  ].join("|");
}

function describeStatus(status: number): string {
  switch (status) {
    case 401:
      return "OpenAI key rejected (401). The usage API needs an organization admin key.";
    case 403:
      return "OpenAI key lacks permission for organization usage (403). A project key will not work.";
    case 429:
      return "rate limited by OpenAI (429).";
    default:
      return `OpenAI usage request failed (HTTP ${status}).`;
  }
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
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}
