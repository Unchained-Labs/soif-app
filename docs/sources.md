# Sources

Seven, across five vendors. Four need no credential at all.

| Source | Vendor | Auth | Verified against |
|---|---|---|---|
| Claude Code local scan | Anthropic | none | A real 527 MB / 255-file corpus |
| Codex CLI local scan | OpenAI | none | CodexBar's rollout fixtures and token accounting |
| Gemini CLI local scan | Google | none | `gemini-cli`'s own `chatRecordingService.ts` |
| Qwen Code local scan | Qwen | none | Fixtures; shares Gemini CLI's format, which it forked |
| CSV import | any | none | Round-tripped multi-vendor exports |
| Anthropic Usage Admin API | Anthropic | `sk-ant-admin01-…` | Recorded fixtures |
| OpenAI organization usage | OpenAI | org admin key | Recorded fixtures; endpoint checked against current docs |

!!! note "Why the last column exists"
    **An adapter that silently reads zeros is indistinguishable from a provider you never used.**
    It does not error and it does not warn — the dashboard simply reports a confident total that
    is missing a whole vendor. So every adapter states what it was built from, in the catalogue
    and on the dashboard's sources card, and nothing here was written from memory of a format.

## Providers disagree about what a token count means

Three disagreements. Each is worth roughly an order of magnitude if you get it backwards, and each
is handled in exactly one place rather than per adapter.

### 1. Does `input` include cache reads?

| | Convention |
|---|---|
| Anthropic, Claude Code | `input_tokens` **excludes** cache reads |
| OpenAI, Codex, Google | `input_tokens` **includes** them as a subset |

soif charges cache reads at 1% of an output token and uncached input at 10%. On an agentic
workload — cache reads outnumber output tokens roughly 300:1 on the reference corpus — passing an
OpenAI count through as if it were Anthropic-shaped bills every cached token at ten times its
weight *and* counts it twice.

### 2. Are thinking tokens inside the output count?

| | Convention |
|---|---|
| Anthropic, OpenAI | `output_tokens` **already contains** thinking tokens |
| Google | `candidatesTokenCount` **excludes** `thoughtsTokenCount`; both sum into the total |

Reasoning is charged at the *full* output rate — the most expensive class there is. Adding
Anthropic's twice inflates it; not adding Google's discards most of the decode cost on a thinking
model, which is exactly what Gemini CLI runs.

### 3. Where was it served?

Water intensity belongs to the data centre, not the model.

| Provider preset | WUE (L/kWh, mid) |
|---|---|
| AWS — Anthropic | 0.18 |
| Azure — OpenAI | 0.49 |
| Google fleet | 1.10 |

A ~6× spread on the on-site term alone. On the Claude corpus, on-site water is 6% of the total; on
a Gemini corpus it is 26%. Same arithmetic, different fleet.

All three live in `src/lib/sources/providers.ts`, and `normalizeTokens` is the single place raw
counts become comparable. The database only ever stores **disjoint** counts.

## Sources that cannot be read

Stated rather than omitted, because never inventing a data source is a load-bearing rule here and
a silently absent card is a quiet way to break it.

- **Claude Pro / Max personal** — no documented usage API. Anthropic's own docs state the Admin API
  is unavailable for individual accounts. Use the Claude Code local scan; it reports the same real
  token counts.
- **ChatGPT Plus / Pro personal** — no usage API. Use the Codex CLI local scan.

There is an undocumented `api/oauth/usage` endpoint that Claude Code uses internally. This project
deliberately does not build on it: it returns quota percentages rather than token counts, it is not
a public contract, and it will break.

## Not built, and why

| Tool | Reason |
|---|---|
| goose | Sessions live in SQLite (`sessions.db`), not JSONL — needs a different reader |
| opencode | Migrated to a versioned database with active migrations; a moving schema breaks silently |
| Cursor | `ai-code-tracking.db` records edits, not token usage |
| aider | Token counts live in analytics, not the chat history file |

All four work today through CSV import. Adding a real adapter means writing a spec plus a fixture —
see `src/lib/scan/specs.ts`, where every spec must name the evidence it was built from.

## CSV import

The universal path: any provider, any export, as long as it has a timestamp, a model and token
counts.

```bash
npx soif-scan --import usage.csv                        # Anthropic-style columns
npx soif-scan --import usage.csv --csv-inclusive-input  # OpenAI-style columns
```

The convention is declared explicitly rather than guessed from the numbers, because a file that
does not say whether its input column includes cached tokens is ambiguous by an order of magnitude.
Skipped rows are reported individually — a silent drop in an import is indistinguishable from usage
that never happened.
