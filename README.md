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

No infrastructure required — SQLite, and a scan that reads your own machine:

```bash
npm install
npm run db:migrate
npx soif-scan
```

That reads Claude Code transcripts on this machine and prints what they cost in water. It works
on **any plan including personal Pro/Max**, needs no credential, and nothing leaves the box.

Then bring up the dashboard:

```bash
npm run build && npm start   # http://localhost:3000
```

For an organization with an Anthropic admin key, or to run it somewhere shared:

```bash
cp .env.example .env         # set SOIF_ENCRYPTION_KEY
docker compose up
```

## Where the numbers come from

| # | Source | Auth | What you get | Status |
|---|---|---|---|---|
| 1 | **Anthropic Usage Admin API** | Admin key `sk-ant-admin01-…` | Real token counts per model, geo, workspace | Client + backfill planner |
| 2 | **Claude Code local scan** | none | Real per-message usage from local transcripts | **Shipped** |
| 3 | OpenAI org usage API | org admin key | Per-model token counts | Not yet |
| 4 | Claude Enterprise Analytics | Analytics key | For claude.ai orgs with no Console key | Not yet |
| 5 | CSV import | none | Escape hatch | Not yet |

**There is no OAuth "connect your Claude account" flow, because one does not exist.** Anthropic's
Usage & Cost API documentation states plainly that *the Admin API is unavailable for individual
accounts*. There is an undocumented `api/oauth/usage` endpoint that Claude Code uses internally;
this project deliberately does not build on it — it returns quota percentages rather than token
counts, it is not a public contract, and it will break. If your plan cannot be read, the UI says
so and points at the local scan rather than inventing a source.

## The local scan

The scanner is adapted from [steipete/CodexBar](https://github.com/steipete/CodexBar)'s
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

```bash
npx soif-scan --help
npx soif-scan --full            # ignore cursors, re-read everything
npx soif-scan --no-embodied     # operational water only
npx soif-scan --json            # machine-readable
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
- **Raw token counts are the source of truth.** Estimates are derived and keyed by
  `factors_version`, so a factor-set upgrade re-derives history instead of stranding it.

```
src/lib/soif/       estimator ported from Python, driven entirely by factors.json
src/lib/scan/       transcript discovery, incremental JSONL scanner, parser, ingest
src/lib/sources/    Anthropic Admin API client with paginated backfill
src/lib/pipeline/   raw token counts → water estimates → aggregates
src/lib/db/         dual-dialect schema, repository, migrations
src/lib/security/   envelope encryption for credentials
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

## Roadmap

1. ~~`factors.json` + parity CI in the `soif` repo~~ — [PR #3](https://github.com/Unchained-Labs/soif/pull/3)
2. ~~Schema, estimate pipeline, local-scan ingestion~~
3. ~~Dashboard UI~~
4. Admin API backfill worker wired to the scheduler (client and pagination planner are done)
5. OpenAI source, Claude Enterprise Analytics, CSV import

## License

Apache-2.0.
