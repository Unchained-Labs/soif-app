---
hide:
  - navigation
---

# soif-app

<div class="hero" markdown>

<p class="lede">How much freshwater your AI actually drank.</p>

A self-hostable dashboard showing an organization — or one developer — how much freshwater its LLM
usage consumed. The water analogue of a cloud cost dashboard.

</div>

<span class="water">546 L</span> across 21,836 calls, on the machine this was built on.
Range 45.4 L – 6,308 L.

!!! warning "Estimates, not measurements"
    Published per-prompt water figures disagree by roughly **100×**. Google measured 0.26 mL per
    median Gemini prompt; Mistral's lifecycle analysis reports 45 mL per 400-token response. Every
    number here carries a low/mid/high band and the factor-set version that produced it. Read the
    [methodology](methodology.md) before quoting anything.

## One line

```bash
curl -fsSL https://raw.githubusercontent.com/Unchained-Labs/soif-app/main/scripts/install.sh | bash
```

From nothing to a running dashboard: clone, install, detect every AI tool on the machine, scan what
it used, and serve. No credential, no infrastructure, nothing leaves the box.
[Install](install.md) covers the variants, including the form that lets you read the script first.

<div class="grid cards" markdown>

-   :material-magnify:{ .lg .middle } **Reads what you actually run**

    ---

    Seven sources across five vendors. Four need no credential at all, which is what makes this
    work on a personal Pro/Max or ChatGPT plan — those have no usage API whatsoever.

    [:octicons-arrow-right-24: Sources](sources.md)

-   :material-chart-box:{ .lg .middle } **Shows where it went**

    ---

    Daily bars with a cumulative overlay, plus breakdowns by model, provider and project. Every
    figure carries its band.

    [:octicons-arrow-right-24: Dashboard](dashboard.md)

-   :material-scale-balance:{ .lg .middle } **Says what it does not know**

    ---

    A scenario spread, not a confidence interval. Every adapter states what it was verified
    against, and sources that cannot be read say so.

    [:octicons-arrow-right-24: Methodology](methodology.md)

-   :material-lock:{ .lg .middle } **Holds admin keys carefully**

    ---

    Envelope encryption with per-source data keys, nothing logged, no outbound calls, and no
    telemetry on usage content.

    [:octicons-arrow-right-24: Security](security.md)

</div>

## Why the number is hard

Water intensity is not a property of "an LLM call". It depends on whose data centres served it,
what the local grid burns, and how the provider counts tokens. Three provider disagreements each
cost roughly an order of magnitude if you get them backwards — which is most of what
[Sources](sources.md) is about.

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
