"use client";

import { formatWater } from "@/lib/format";

/**
 * The smaller dashboard panels.
 *
 * Client components for the interactive controls; the display panels render
 * their real values server-side and let CSS supply the entrance animation, so
 * a hydration failure costs motion rather than accuracy.
 */

export interface ModelDatum {
  name: string;
  ml: number;
  outputTokens: number;
  cachedTokens: number;
  color: string;
}

/** Categorical series colours, in assignment order. */
export const SERIES_COLORS = ["var(--s1)", "var(--s3)", "var(--s2)", "var(--s4)"] as const;

export function ModelBars({ models }: { models: ModelDatum[] }) {
  // Widths are the resting style, not an animated-to state: the bars must be
  // right in the server-rendered HTML, with the grow animation layered on top.
  if (models.length === 0) return <p className="cap">No model usage in this range.</p>;
  const max = Math.max(...models.map((m) => m.ml)) || 1;

  return (
    <div className="mbar">
      {models.map((model) => (
        <div className="mrow" key={model.name}>
          <div className="mtop">
            <div className="mname">
              <span className="swatch" style={{ background: model.color }} />
              {model.name}
            </div>
            <div className="mval">{formatWater(model.ml)}</div>
          </div>
          <div className="track">
            <div
              className="fillbar"
              style={{
                width: `${((model.ml / max) * 100).toFixed(1)}%`,
                background: model.color,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export interface SplitDatum {
  name: string;
  ml: number;
  color: string;
}

/**
 * On-site / off-site / embodied split.
 *
 * Kept as a distinct panel because the distinction is load-bearing: Google's
 * published per-prompt figures are operational only, so any comparison against
 * them has to be able to drop the embodied share.
 */
export function SplitStack({ parts }: { parts: SplitDatum[] }) {
  const total = parts.reduce((sum, part) => sum + part.ml, 0);
  if (total <= 0) return <p className="cap">Nothing to split yet.</p>;

  return (
    <>
      <div className="stack">
        {parts.map((part) => (
          <div key={part.name} style={{ flex: Math.max(part.ml, total * 0.005), background: part.color }} />
        ))}
      </div>
      <div className="legend">
        {parts.map((part) => (
          <div className="li" key={part.name}>
            <span className="swatch" style={{ background: part.color }} />
            {part.name}
            <b>
              {formatWater(part.ml)} · {((part.ml / total) * 100).toFixed(0)}%
            </b>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * Range selector.
 *
 * Pushes to the URL rather than holding state, so a filtered view is a
 * shareable link and the server re-aggregates instead of the client slicing a
 * payload it had to download in full.
 */
export function RangeToggle({ current }: { current: string }) {
  const ranges = [
    { value: "30d", label: "30D" },
    { value: "3m", label: "3M" },
    { value: "12m", label: "12M" },
    { value: "all", label: "All" },
  ];

  return (
    <div className="seg" role="group" aria-label="Time range">
      {ranges.map((range) => (
        <button
          key={range.value}
          type="button"
          aria-pressed={current === range.value}
          onClick={() => {
            const url = new URL(window.location.href);
            url.searchParams.set("range", range.value);
            window.location.href = url.toString();
          }}
        >
          {range.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Embodied-water toggle.
 *
 * Not a cosmetic preference: comparing a soif figure against Google's published
 * numbers is only meaningful with embodied excluded, so the control carries
 * that explanation in its title rather than leaving the user to guess.
 */
export function EmbodiedToggle({ included }: { included: boolean }) {
  return (
    <div className="seg" role="group" aria-label="Water scope">
      {[
        { value: "1", label: "Total", on: included },
        { value: "0", label: "Operational", on: !included },
      ].map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.on}
          title={
            option.value === "0"
              ? "Operational water only — the scope of Google's published figures"
              : "Includes embodied water from chip fabrication and construction"
          }
          onClick={() => {
            const url = new URL(window.location.href);
            url.searchParams.set("embodied", option.value);
            window.location.href = url.toString();
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
