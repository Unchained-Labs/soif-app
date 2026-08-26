# Architecture

## The repos must not drift on the science

The factor tables are **not hand-ported**. [`soif`](https://github.com/Unchained-Labs/soif) emits a
versioned `factors.json` from its Python module, with a CI check that fails on drift; this repo
consumes that artifact and **no factor value is typed in here**.

That file also carries **parity vectors** — estimates computed by the reference implementation —
and `tests/parity.test.ts` runs every one of them through the TypeScript port. Parity is
demonstrated, not claimed. The vectors deliberately cover the paths a naive port gets wrong: cached
tokens at 1% rather than 10%, thinking tokens at the full output rate, raw `wue`/`pue`/`ewif`
overrides, operational-only mode, and the longest-match registry rule that keeps `gpt-4o-mini` off
the `gpt-4o` tier.

```bash
npm run sync:factors   # refresh factors.json from upstream, then run the tests
```

## Layout

```
src/lib/soif/       estimator ported from Python, driven entirely by factors.json
src/lib/scan/       incremental JSONL scanner; Claude Code and Codex adapters;
                    declarative spec engine + verified specs; ingest
src/lib/sources/    provider catalogue, token normalization, Anthropic + OpenAI
                    clients, CSV import
src/lib/pipeline/   raw token counts → water estimates → aggregates
src/lib/db/         dual-dialect schema, repository, migrations
src/lib/security/   envelope encryption for credentials
cli/                soif-init (the wizard) and soif-scan
```

## Storage

**Raw token counts are the source of truth.** Estimates are derived and keyed by `factors_version`,
so a factor-set upgrade re-derives history instead of stranding it. Every stored estimate keeps its
`(low, mid, high)` bounds and the onsite/offsite/embodied split, so the UI can show the band and
toggle embodied without a round trip.

**SQLite by default, Postgres optional.** A developer running a local scan should not have to stand
up a database server; a shared multi-source deployment should not be stuck on SQLite. Drizzle has
no portable column builder, so the two schemas are written out separately and `tests/schema.test.ts`
asserts they declare identical tables, columns and indexes — if a thing is duplicated by necessity,
a test has to hold the copies together.

## Incremental scanning

Two independent mechanisms, both of which matter on a corpus that reaches hundreds of megabytes:

- **Per-file byte cursors** — an unchanged transcript is not reopened, and a growing one is read
  only from where the last run stopped. The cursor never advances past an incomplete trailing line,
  so a transcript being written while it is read is not silently skipped.
- **A unique `(source_id, dedupe_key)`** — even a full re-scan inserts nothing new, so a cursor
  reset costs time rather than correctness.

Measured on a real corpus: **673 MB/s**; an incremental re-run reads 6 KB instead of 527 MB; a full
re-read of all 21,659 rows inserted exactly the one row that was genuinely new.

Two rules stop double-counting:

- **Streaming chunks repeat** `messageId:requestId` with *cumulative* counts. Last write wins;
  summing them multiplies real usage.
- **Subagent transcripts duplicate parent rows.** Cross-file reconciliation prefers the subagent
  copy, so agentic fan-out is not counted twice — the error would otherwise grow with exactly the
  fan-out that makes agentic usage expensive.

## Adding a provider

Most agent CLIs append one JSON object per message with the counts nested somewhere predictable, so
the shape is data rather than a new parser:

```ts
export const SOME_TOOL_SPEC: LocalScanSpec = {
  kind: "some_tool_local",
  vendor: "…",
  verifiedFrom: "…",   // required — no unverified specs
  homeDirs: [".some-tool"],
  prefilter: ['"usage"'],
  usagePath: "usage",
  fields: { input: "usage.input_tokens", output: "usage.output_tokens" },
  modelPaths: ["model"],
  timestampPaths: ["timestamp"],
  conventions: { input: "inclusive", reasoning: "separate" },
};
```

Claude Code and Codex keep bespoke parsers because they have real structural complexity —
cross-file reconciliation, cumulative-versus-delta totals. Everything else runs through one engine.

!!! note "The prefilter is derived, not declared"
    A byte prefilter runs before `JSON.parse` — on a 500 MB corpus it is the difference between a
    scan and a stall. But the model and session usually arrive on *earlier* records of a different
    type, and a line the prefilter rejects is a line the parser never sees.

    That caused the same bug twice: Codex rows came out with no model, Gemini rows with no session.
    Both times the spec looked right. The needles are now derived from the declared field paths, so
    declaring a path automatically admits the lines carrying it — the mistake is no longer possible
    rather than caught in review.

## Testing

```bash
npm test         # 179 tests
npm run typecheck
npm run lint
```

Tests run against recorded fixtures and synthetic transcripts, never the live API.
