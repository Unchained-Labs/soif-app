# soif-app 💧

**A self-hostable dashboard for the freshwater your organization's LLM usage consumed** — the
water analogue of a cloud cost dashboard.

Third repo in the soif project:

- [`soif`](https://github.com/Unchained-Labs/soif) — the Python estimator. Converts token counts
  to millilitres via a versioned factor set, returning `(low, mid, high)` scenario triples.
- [`soif-mcp`](https://github.com/Unchained-Labs/soif-mcp) — the MCP server wrapping it.
- **`soif-app`** — this repo.

> **Estimates, not measurements.** Published per-prompt water figures disagree by ~100×. Every
> number here carries a low/mid/high band and the factor-set version that produced it. Read
> [`METHODOLOGY.md`](https://github.com/Unchained-Labs/soif/blob/main/METHODOLOGY.md) before
> quoting anything.

## Quick start

One line, from nothing to a running dashboard:

```bash
curl -fsSL https://raw.githubusercontent.com/Unchained-Labs/soif-app/main/scripts/install.sh | bash
```

Piping a remote script into a shell means trusting whatever that URL serves. If you would rather
not — and that is a reasonable position — the two-line form does the same thing and lets you read
it first:

```bash
curl -fsSLO https://raw.githubusercontent.com/Unchained-Labs/soif-app/main/scripts/install.sh
less install.sh && bash install.sh
```

Already cloned?

```bash
npm run setup     # install, set up, scan, build, serve
```

Either way the wizard detects which AI tools on this machine have readable usage, generates an
encryption key, creates the database, scans everything it found, tells you what it cost, and
leaves the dashboard running on <http://localhost:3000>:

```
[1/5] Looking for AI tools with readable usage
  ✓ Claude Code (local scan) (255 files)
  ✓ Codex CLI (local scan) (31 files)
[2/5] Configuration            ✓ Created .env with a new encryption key.
[3/5] Preparing the database   ✓ Schema is up to date.
[4/5] Scanning                 ✓ Scanned 536 MB, stored 21,624 new records.
[5/5] What that cost

  540 L of freshwater, across 21,624 calls.
  range 44.8 L – 6,232 L · mid scenario
```

No infrastructure, no credential, nothing leaves the machine. It works on **any plan, including
personal Pro/Max**, which have no usage API at all.

```bash
npm run setup:only            # set up and scan, but do not serve
npx soif-init --dry-run       # show the plan, change nothing
npx soif-init --serve --port 4000
npx soif-init --yes --no-open # scripted installs
```

To run it somewhere shared, with Postgres:

```bash
cp .env.example .env         # set SOIF_ENCRYPTION_KEY
docker compose up
```

## Where the numbers come from

| Source | Vendor | Auth | Verified against |
|---|---|---|---|
| **Claude Code local scan** | Anthropic | none | A real 527 MB / 255-file corpus |
| **Codex CLI local scan** | OpenAI | none | CodexBar's rollout fixtures and token accounting |
| **Gemini CLI local scan** | Google | none | `gemini-cli`'s own `chatRecordingService.ts` |
| **Qwen Code local scan** | Qwen | none | Fixtures; shares Gemini CLI's format, which it forked |
| **CSV import** | any | none | Round-tripped multi-vendor exports |
| **Anthropic Usage Admin API** | Anthropic | `sk-ant-admin01-…` | Recorded fixtures |
| **OpenAI organization usage** | OpenAI | org admin key | Recorded fixtures; endpoint checked against current docs |

Every adapter states what it was verified against, in the catalogue and on the dashboard. That
matters more than a support count: **an adapter that silently reads zeros is indistinguishable
from a provider you did not use.** Nothing here was written from memory of a format.

Sources that cannot be read at all say so rather than being omitted — personal Claude Pro/Max and
ChatGPT Plus/Pro expose no usage API, and the UI points at the matching local scan instead.

### Not built, and why

| Tool | Reason |
|---|---|
| goose | Stores sessions in SQLite (`sessions.db`), not JSONL — needs a different reader |
| opencode | Migrated to a versioned database with active migrations; a moving schema breaks silently |
| Cursor | `ai-code-tracking.db` records edits, not token usage |
| aider | Token counts live in analytics, not the chat history file |

All four are reachable today via CSV import. Adding a real adapter means writing a spec plus a
fixture — see `src/lib/scan/specs.ts`, where every spec must name the evidence it was built from.

The two local scans need no credential and work on personal plans. The CSV import covers
everything else — Google, Mistral, xAI, DeepSeek, a self-hosted model, anything with an export:

```bash
npx soif-scan --import usage.csv                          # Anthropic-style columns
npx soif-scan --import usage.csv --csv-inclusive-input     # OpenAI-style columns
```

### Providers disagree about what a token count means

Three disagreements, each worth a large error, each handled in one place rather than per adapter:

**1. Does `input` include cache reads?**

| | Convention |
|---|---|
| Anthropic, Claude Code | `input_tokens` **excludes** cache reads |
| OpenAI, Codex, Google | `input_tokens` **includes** them as a subset |

soif charges cache reads at 1% of an output token and uncached input at 10%. On an agentic
workload — cache reads outnumber output tokens ~300:1 on the reference corpus — passing an OpenAI
count through as Anthropic-shaped bills every cached token at ten times its weight *and* counts it
twice.

**2. Are thinking tokens inside the output count?**

| | Convention |
|---|---|
| Anthropic, OpenAI | `output_tokens` **already contains** thinking tokens |
| Google | `candidatesTokenCount` **excludes** `thoughtsTokenCount`; both sum into the total |

Reasoning is charged at the *full* output rate — the most expensive class there is. Adding
Anthropic's twice inflates it; not adding Google's discards most of the decode cost on a thinking
model, which is exactly what Gemini CLI runs.

**3. Where was it served?**

Water intensity is a property of the data centre, not the model. Anthropic on AWS (~0.18 L/kWh
WUE), OpenAI on Azure (~0.49), Google on its own fleet (~1.10) — a 6× spread on the on-site term
alone. In the synthetic Gemini corpus, on-site water is 26% of the total; on the Claude corpus it
is 6%. Same arithmetic, different fleet.

Every provider declares its conventions in `src/lib/sources/providers.ts`; `normalizeTokens` is
the single place raw counts become comparable; the database only ever stores disjoint counts.

**There is no OAuth "connect your Claude account" flow, because one does not exist.** Anthropic's
Usage & Cost API documentation states plainly that *the Admin API is unavailable for individual
accounts*. There is an undocumented `api/oauth/usage` endpoint that Claude Code uses internally;
this project deliberately does not build on it — it returns quota percentages rather than token
counts, it is not a public contract, and it will break. If your plan cannot be read, the UI says
so and points at the local scan rather than inventing a source.

## The local scans

### Claude Code

Adapted from [steipete/CodexBar](https://github.com/steipete/CodexBar)'s
`CostUsageJsonl`, which solves the same problem in Swift for the same transcript format. What
carried over, and why each part earns its keep:

- **Root discovery** across `$CLAUDE_CONFIG_DIR`, `~/.claude` and `~/.config/claude`. This is also
  the multi-account story: one config root per account, each its own source.
- **A byte prefilter before `JSON.parse`** — only lines containing both `"type":"assistant"` and
  `"usage"` are ever parsed.
- **Resumable byte-offset cursors** that never commit past an incomplete trailing line, so a
  transcript being written while it is read is not silently skipped.
- **Dedup on `messageId:requestId`, last write wins** — streaming chunks repeat the key with
  cumulative counts, so summing them multiplies real usage.
- **Cross-file reconciliation** preferring the subagent copy, so agentic fan-out is not counted
  twice.

Measured on a real 527 MB / 255-file corpus: **673 MB/s**, 21,626 rows collapsing to 21,263, and a
re-scan of every byte inserts nothing. Two deliberate divergences from CodexBar, both measured:

- Fall back to `usage.iterations[]` when top-level counts are all zero (~0.08% of lines).
- Report over-long skipped lines *separately* from over-long lines that might have carried usage,
  so the number is actionable rather than noise. On the reference corpus the second figure is zero.

What this project does **not** borrow from CodexBar: reading the macOS Keychain
(`"Claude Code-credentials"`), scraping browser cookies, or calling `api/oauth/usage`. The first
two are macOS-only and a poor fit for something already holding an org admin key — notably
CodexBar will not touch Claude's credential store for multi-account either, delegating to an
external `claude-swap` binary. Account attribution here comes from the non-secret `oauthAccount`
label in `.claude.json`; nothing reads a token.

### Codex CLI

Codex writes one JSONL rollout per session under `~/.codex/sessions/YYYY/MM/DD/`. Two properties
of that format decide whether the numbers come out right, and both are covered by tests:

- **`total_token_usage` is cumulative for the session; `last_token_usage` is the per-turn delta.**
  Summing the totals multiplies usage by roughly the number of turns. The parser reads deltas and
  falls back to the final total only when no delta was ever reported.
- **The model arrives on a `turn_context` record, not on the usage event.** An AND-style byte
  prefilter drops those records and every row comes out unattributed — which is exactly what
  happened until a test caught it, hence `requireAny` on the scanner.

Session `cwd` becomes the project label, so Codex usage groups alongside Claude usage in the
per-project view.

```bash
npx soif-init                   # the wizard: detect, configure, migrate, scan
npx soif-scan --help
npx soif-scan --full            # ignore cursors, re-read everything
npx soif-scan --no-embodied     # operational water only
npx soif-scan --json            # machine-readable
npx soif-scan --import x.csv    # import any provider's export
npx soif-scan --push https://soif.internal   # send aggregates to your own instance
```

## Architecture

**The repos must not drift on the science.** The factor tables are not hand-ported. `soif` emits a
versioned [`factors.json`](https://github.com/Unchained-Labs/soif/blob/main/factors.json) from its
Python module, with a CI check that fails on drift; this repo consumes that artifact and no factor
value is typed in here.

That file also carries **parity vectors** — estimates computed by the reference implementation —
and `tests/parity.test.ts` runs every one of them through the TypeScript estimator. Parity is
demonstrated, not claimed.

- **Next.js (App Router) + TypeScript**, deployable to Vercel and runnable via `docker compose up`.
- **SQLite by default, Postgres optional.** A developer running a local scan should not have to
  stand up a database server; a shared multi-source deployment should not be stuck on SQLite. This
  deviates from the original brief's "Postgres" and is the one place it does. Drizzle has no
  portable column builder, so the two schemas are written out separately and
  `tests/schema.test.ts` asserts they declare identical tables, columns and indexes.
- **Providers are a catalogue, not a special case.** Adding one means a spec in
  `src/lib/sources/providers.ts` and an adapter — the normalization, storage, estimation and
  dashboard grouping are already provider-agnostic.
- **Raw token counts are the source of truth.** Estimates are derived and keyed by
  `factors_version`, so a factor-set upgrade re-derives history instead of stranding it.

```
src/lib/soif/       estimator ported from Python, driven entirely by factors.json
src/lib/scan/       incremental JSONL scanner; Claude Code and Codex adapters;
                    declarative spec engine + verified specs; ingest
src/lib/sources/    provider catalogue, token normalization, Anthropic + OpenAI clients, CSV
src/lib/pipeline/   raw token counts → water estimates → aggregates
src/lib/db/         dual-dialect schema, repository, migrations
src/lib/security/   envelope encryption for credentials
cli/                soif-init (the wizard) and soif-scan
```

## Security

You are handling admin-scoped API keys. That is the primary risk in this codebase.

- **Encrypted at rest**, per-source AES-256-GCM data keys wrapped by a master key
  (`SOIF_ENCRYPTION_KEY`) that never enters the database. The sealed form carries a key id so
  rotation can be staged.
- **Never logged, never returned.** `listSources()` strips the sealed blob rather than merely not
  displaying it; a Postgres URL is redacted before it can reach an error message. There is no
  column a plaintext key could be written to, and a test enforces that.
- **Read-only scope.** Only the usage and cost report endpoints are ever called.
- **Self-hosted mode makes no outbound calls to any soif-operated service.** There is none.
- **No telemetry on usage content.** This ingests token *counts*. Prompts are never read, stored,
  or transmitted — the scanner does not even parse the `content` field.

## Honesty rules

These are enforced in code, not left to reviewers:

1. **Never a bare number without its range.** `formatTriple` exists so the honest form is the easy
   one, and the hero, the chart tooltip and the detail table all carry the band.
2. **Estimates are labelled as estimates**, with the factor-set version stamped on the page.
3. **No invented sources.** If a plan cannot be read, the UI says so.
4. **Operational and embodied water are distinguished**, and embodied can be excluded — Google's
   published figures are operational-only, so comparisons are otherwise meaningless.
5. **Location-based, not market-based.** Renewable certificates do not un-evaporate water from the
   local grid.

A sixth rule emerged from building the UI and is worth stating: **no quantity is ever carried by
animation state.** An entrance animation that starts from an empty vessel will, on a page with
enough animated elements, still be pending when the first frame is painted — which rendered five
empty tanks under a headline reading 531 L. The water level and the bar widths are plain styles;
only motion that cannot misstate a value is animated.

`prefers-reduced-motion` removes the waves, the drips and the transitions.

## Development

```bash
npm test              # 120 tests
npm run typecheck
npm run dev
npm run db:generate   # regenerate migrations after a schema change
```

Tests run against recorded fixtures and synthetic transcripts, never the live API.

## What the dashboard shows

Water over time, and breakdowns by **model**, **provider** and **project**. Projects come from the
working directory each call was made in, which the local scans record; API sources have no notion
of one and are grouped honestly as unattributed rather than dropped.

## Roadmap

1. ~~`factors.json` + parity CI in the `soif` repo~~ — [PR #3](https://github.com/Unchained-Labs/soif/pull/3)
2. ~~Schema, estimate pipeline, local-scan ingestion~~
3. ~~Dashboard UI~~
4. ~~Multi-provider: Codex local scan, OpenAI usage client, CSV import~~
5. ~~Install wizard~~
6. ~~Gemini CLI and Qwen Code adapters~~
7. Wire the Admin API clients to a scheduled worker (clients and pagination are done; nothing runs
   them on a timer yet)
8. goose and opencode, both of which need a SQLite reader; Claude Enterprise analytics

## License

Apache-2.0.
