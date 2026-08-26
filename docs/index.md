# soif-app

**How much freshwater your AI actually drank.**

A self-hostable dashboard that shows an organization — or one developer — how much freshwater its
LLM usage consumed. The water analogue of a cloud cost dashboard.

<span class="water">546 L</span> across 21,836 calls, on the machine this was built on. Range
45.4 L – 6,308 L.

!!! warning "Estimates, not measurements"
    Published per-prompt water figures disagree by roughly **100×**. Google measured 0.26 mL per
    median Gemini prompt; Mistral's lifecycle analysis reports 45 mL per 400-token response. Every
    number here carries a low/mid/high band and the factor-set version that produced it. Read the
    [methodology](methodology.md) before quoting anything.

## One line

```bash
curl -fsSL https://raw.githubusercontent.com/Unchained-Labs/soif-app/main/scripts/install.sh | bash
```

From nothing to a running dashboard: clone, install, detect every AI tool on the machine, scan
what it used, and serve. No credential, no infrastructure, nothing leaves the box. See
[Install](install.md) for the variants, including the form that lets you read the script first.

## What it reads

Seven sources across five vendors. Four need no credential at all, which is what makes this usable
on a personal Pro/Max or ChatGPT plan — those have no usage API whatsoever.

| Source | Vendor | Auth |
|---|---|---|
| Claude Code local scan | Anthropic | none |
| Codex CLI local scan | OpenAI | none |
| Gemini CLI local scan | Google | none |
| Qwen Code local scan | Qwen | none |
| CSV import | any | none |
| Anthropic Usage Admin API | Anthropic | admin key |
| OpenAI organization usage | OpenAI | org admin key |

Each adapter states what it was verified against — see [Sources](sources.md). That matters more
than a count: **an adapter that silently reads zeros is indistinguishable from a provider you never
used.**

## Why the number is hard

Water intensity is not a property of "an LLM call". It depends on whose data centres served it,
what the local grid burns, and how the provider counts tokens. Three provider disagreements each
cost roughly an order of magnitude if you get them backwards — that is what
[Sources](sources.md) is mostly about.

## The rules this project lives by

1. **Never a bare number without its range.**
2. **Estimates are labelled as estimates**, with the factor-set version on the page.
3. **No invented sources.** If a plan cannot be read, the UI says so and points at the local scan.
4. **Operational and embodied water are distinguished**, and embodied can be excluded — Google's
   published figures are operational-only, so comparisons are otherwise meaningless.
5. **Location-based, not market-based.** Renewable certificates do not un-evaporate water from the
   local grid.
6. **No quantity is ever carried by animation state.** An entrance animation still pending at first
   paint once rendered five empty vessels under a headline reading 531 L.

## The project

- [`soif`](https://github.com/Unchained-Labs/soif) — the Python estimator and the versioned factor set
- [`soif-mcp`](https://github.com/Unchained-Labs/soif-mcp) — the MCP server wrapping it
- **`soif-app`** — this dashboard
