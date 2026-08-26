# Dashboard

## The vessel ladder

The hero is **exactly five vessels**, promoted up a ladder as consumption grows — deliberately not
a wall of hundreds of bottles, which stops being readable the moment your usage is real.

| Tier | Unit | Row holds up to |
|---|---|---|
| can | 330 mL | 1.65 L |
| bottle | 1.5 L | 7.5 L |
| jerrycan | 5 L | 25 L |
| drum | 50 L | 250 L |
| tank | 1,000 L | 5,000 L |
| reservoir | 10,000 L | 50,000 L |

The smallest tier where `total ≤ 5 × unit` wins, so low usage reads as one barely-filled can beside
four empty ones rather than a rounding error at the bottom of a reservoir. A ladder strip
underneath shows every tier with the current one highlighted, so the scheme is legible even when
your data never leaves one tier.

!!! warning "The water level never animates"
    Every animated variant of the fill was tried and removed. All of them have a `from` frame
    showing an empty vessel, and on a page with this many animated elements that frame is the one
    that gets painted — the animations are still pending when the first frame lands. The result was
    **five empty tanks under a headline reading 531 L.**

    The level is a plain style now. A page about honest measurement cannot render an empty vessel
    for a full one, however briefly, so no quantity here is carried by animation state.

## Water over time

Daily bars with a cumulative line over them, on separate axes.

The two answer different questions and both get asked: bars answer *"was yesterday heavy?"* — the
shape you act on, and the shape a line smooths away — while the cumulative answers *"how much
altogether?"*, which is what turns a per-prompt figure into something with weight.

Dual axes can mislead, so the right-hand axis is drawn in the line's own colour and the tooltip
separates the two quantities under a rule rather than running them together. Only the mid scenario
is plotted — three bands at a ~100× spread would be unreadable — so the tooltip is the only place
the range appears at this granularity, and it carries it for both series.

## Breakdowns

- **By model** — where the water actually went.
- **By provider** — derived from the model name rather than stored, so it cannot drift from soif's
  registry, which is what decides the data-centre preset and therefore the intensity.
- **By project** — from the working directory each call was made in. Local scans record it; API
  sources have no notion of one and are grouped honestly as *unattributed* rather than dropped.

## Total vs operational

The toggle excludes embodied water — chip fabrication, server manufacturing, data-centre
construction, amortised over the hardware's life.

This is not a cosmetic preference. Google's published per-prompt figures are **operational only**,
so a comparison against them is meaningless unless embodied is excluded. On the reference corpus
the toggle moves the total from 546 L to 368 L.

## Biggest lever

The one figure on the page derived from a counterfactual rather than measured, so it is
deliberately hard to satisfy:

- **Same vendor only.** Comparing `claude-opus` against `gemini-2.5-pro` conflates a model-tier
  difference with a data-centre one, and most of the apparent "saving" would be geography.
- **The lighter model needs real usage** — at least 1% of output tokens — before its intensity is
  treated as evidence. Without that guard it once claimed 67% of total water against a model with
  42 mL of usage.
- **It returns nothing when there is nothing to say.** A dashboard that always finds a lever is one
  that will eventually invent one.

## Reduced motion

`prefers-reduced-motion` removes the waves, the drips and the transitions. Every one of them has a
correct resting state, so removing the motion loses nothing but motion.
