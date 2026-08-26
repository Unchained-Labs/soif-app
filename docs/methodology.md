# Methodology

The full method lives with the estimator, in
[`soif/METHODOLOGY.md`](https://github.com/Unchained-Labs/soif/blob/main/METHODOLOGY.md).
**Read it before quoting any number from this dashboard.** What follows is the short version and
the parts that matter for reading the UI.

## The model

Following the operational-water methodology of Ren et al.
([*Making AI Less "Thirsty"*](https://arxiv.org/abs/2304.03271)), with an optional embodied adder:

```
E_it       = (output + reasoning + 0.1·input + 0.01·cached) / 1000 × Wh_per_1k(tier)
E_facility = E_it × PUE
W_onsite   = E_it × WUE          # cooling-tower evaporation at the data centre
W_offsite  = E_facility × EWIF   # water consumed generating the electricity
W_embodied = (W_onsite + W_offsite) × (lifecycle − 1)
W_total    = W_onsite + W_offsite + W_embodied
```

1 L/kWh is exactly 1 mL/Wh, which keeps the arithmetic tidy.

## Why every number has a range

Every factor is a **(low, mid, high)** scenario triple, and the triples multiply through
bound-wise. The reported range is therefore a best/central/worst *scenario spread*, **not a
statistical confidence interval**.

This is deliberate. Public per-prompt figures disagree by roughly 100× — Google measured 0.26 mL
per median Gemini prompt; Mistral's lifecycle analysis reports 45 mL per 400-token response — and
pretending otherwise would be false precision. Most of that gap is *scope* (operational versus full
lifecycle) and *method* (measured medians versus LCA attribution), not disagreement about physics.

Which is why the dashboard shows the mid and always exposes the band, and why collapsing a triple
to its mid anywhere upstream of display would throw away the honest part of the answer.

## Where the uncertainty comes from

- **Energy per token** cannot be measured from outside a provider, so models are bucketed into five
  tiers by *active* parameter count, each with a wide Wh-per-1k-output-tokens band.
- **WUE and PUE** come from public provider disclosures, which are fleet averages, not the
  particular building that served your request.
- **EWIF** — the water consumed generating a kWh — varies strongly with grid mix and season, which
  is why the regional ranges are wide.
- **Embodied water** has thin public data, so the lifecycle multiplier is deliberately wide
  (1.1× / 1.5× / 3.0×) and is reported separately so it can be excluded.

## Location-based, not market-based

Buying renewable certificates does not remove the physical water use of the local grid. soif models
physical, location-based water. The `renewable` region is for genuinely co-located or matched
supply, not for an accounting instrument.

## What this is not

It is not a measurement, not an audit, and not a number to put in a regulatory filing. It is a
defensible estimate with its assumptions written down — which is more than a per-prompt figure
quoted without a range, and considerably less than a meter.
