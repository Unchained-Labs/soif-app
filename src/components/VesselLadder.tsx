"use client";

import { useId, useMemo } from "react";
import { VESSEL_TIERS, formatVesselCount, vesselState } from "@/lib/format";

/**
 * The hero: five vessels that get promoted up a ladder as consumption grows.
 *
 * Deliberately not a wall of hundreds of bottles. Five vessels plus a tier
 * promotion keeps a personal-scale number and an org-scale number legible in
 * the same component, and the ladder strip underneath keeps the scheme
 * readable even when your data never leaves one tier.
 *
 * Motion is meaningful here rather than decorative — the water *rises* into
 * position, and drips appear once the row is full enough that a promotion is
 * near — so all of it is removed under `prefers-reduced-motion`.
 */

interface Silhouette {
  /** Cavity to fill with water. */
  clip: string;
  /** Outline. */
  line: string;
  /** Interior detail lines (seams, handles, ribs). */
  detail: string;
}

/** Silhouettes on a shared 100×150 canvas. */
const ART: Record<string, Silhouette> = {
  can: {
    clip: "M35 34 h30 a3 3 0 0 1 3 3 v79 a7 7 0 0 1 -7 7 h-22 a7 7 0 0 1 -7 -7 v-79 a3 3 0 0 1 3 -3 z",
    line: "M32 30 h36 a4 4 0 0 1 4 4 v83 a9 9 0 0 1 -9 9 h-26 a9 9 0 0 1 -9 -9 v-83 a4 4 0 0 1 4 -4 z",
    detail: "M32 38 h36 M32 112 h36",
  },
  bottle: {
    clip: "M45 24 h10 v7 c0 6 11 10 11 24 v57 a8 8 0 0 1 -8 8 h-16 a8 8 0 0 1 -8 -8 v-57 c0 -14 11 -18 11 -24 z",
    line: "M43 18 h14 v10 c0 6 12 10 12 25 v58 a10 10 0 0 1 -10 10 h-18 a10 10 0 0 1 -10 -10 v-58 c0 -15 12 -19 12 -25 z",
    detail: "M41 18 h18 M38 96 h24",
  },
  jerrycan: {
    clip: "M25 50 h50 a4 4 0 0 1 4 4 v66 a4 4 0 0 1 -4 4 h-50 a4 4 0 0 1 -4 -4 v-66 a4 4 0 0 1 4 -4 z",
    line: "M22 46 h56 a6 6 0 0 1 6 6 v70 a6 6 0 0 1 -6 6 h-56 a6 6 0 0 1 -6 -6 v-70 a6 6 0 0 1 6 -6 z",
    detail: "M60 46 v-9 h13 v9 M28 60 h20 M28 70 h20",
  },
  drum: {
    clip: "M24 44 a26 6 0 0 1 52 0 v70 a26 6 0 0 1 -52 0 z",
    line: "M24 44 a26 7 0 0 1 52 0 v72 a26 7 0 0 1 -52 0 z M24 44 a26 7 0 0 0 52 0",
    detail: "M23 68 h54 M23 92 h54",
  },
  tank: {
    clip: "M23 42 h54 a4 4 0 0 1 4 4 v66 a4 4 0 0 1 -4 4 h-54 a4 4 0 0 1 -4 -4 v-66 a4 4 0 0 1 4 -4 z",
    line: "M20 38 h60 a5 5 0 0 1 5 5 v72 a5 5 0 0 1 -5 5 h-60 a5 5 0 0 1 -5 -5 v-72 a5 5 0 0 1 5 -5 z",
    detail: "M15 62 h70 M15 86 h70 M38 38 v82 M62 38 v82 M22 120 v8 M78 120 v8 M15 128 h70",
  },
  tower: {
    clip: "M22 58 h56 v50 a8 8 0 0 1 -8 8 h-40 a8 8 0 0 1 -8 -8 z",
    line: "M18 58 L50 32 L82 58 M19 58 h62 v50 a10 10 0 0 1 -10 10 h-42 a10 10 0 0 1 -10 -10 z",
    detail: "M30 118 l-6 16 M70 118 l6 16 M50 118 v16 M22 82 h56",
  },
};

/** Water surface travels between these y values inside the 150-unit canvas. */
const SURFACE_TOP = 26;
const SURFACE_BOTTOM = 132;

/** A repeating sine-ish path, wide enough to translate without showing an edge. */
const WAVE = (() => {
  let d = "M-100 6";
  for (let x = -100; x < 200; x += 25) {
    d += ` q 12.5 ${(x / 25) % 2 ? 5 : -5} 25 0`;
  }
  return `${d} L200 200 L-100 200 Z`;
})();

function Vessel({ art, fill, index }: { art: string; fill: number; index: number }) {
  const uid = useId().replace(/:/g, "");
  const clipId = `vc-${uid}-${index}`;
  const gradientId = `vg-${uid}-${index}`;
  const silhouette = ART[art] ?? ART.can!;

  // The true level is the element's resting style, so the water is correct in
  // the server-rendered HTML and stays correct if JavaScript never runs. The
  // rise is a CSS animation *into* that resting state — animating up from an
  // empty vessel held in React state would mean any hydration failure renders
  // a full tank as an empty one, which is the one lie this dashboard cannot
  // afford to tell.
  const y = SURFACE_BOTTOM - fill * (SURFACE_BOTTOM - SURFACE_TOP);

  return (
    <svg viewBox="0 0 100 150" aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <path d={silhouette.clip} />
        </clipPath>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--water)" />
          <stop offset="100%" stopColor="var(--water-deep)" />
        </linearGradient>
      </defs>
      <path className="v-void" d={silhouette.clip} />
      <g clipPath={`url(#${clipId})`}>
        {/*
          The level is a static transform with no entrance animation, and that
          is deliberate. Every animated variant tried here — a transition from
          an empty vessel, a keyframed rise, a rise on a wrapper element — has
          a `from` frame that shows an empty vessel, and on this page that frame
          is what gets painted: the animations are still pending when the first
          frame lands, so five empty tanks were rendered under a headline
          reading 531 L. A dashboard about honest measurement cannot show an
          empty vessel for a full one, however briefly, so the level never
          animates. The wave still drifts horizontally, which reads as liquid
          without ever encoding the quantity.
        */}
        <g className="water-g" style={{ transform: `translateY(${y.toFixed(1)}px)` }}>
          <path className="wave b" d={WAVE} fill={`url(#${gradientId})`} />
          <path className="wave" d={WAVE} fill={`url(#${gradientId})`} />
        </g>
      </g>
      <path className="v-line" d={silhouette.line} />
      <path className="v-detail" d={silhouette.detail} />
    </svg>
  );
}

export function VesselLadder({ totalMl }: { totalMl: number }) {
  const state = useMemo(() => vesselState(totalMl), [totalMl]);

  const drips = useMemo(() => {
    if (!state.overflowing) return [];
    const count = Math.round(3 + state.rowFraction * 9);
    return Array.from({ length: count }, (_, i) => ({
      left: 9 + (i / Math.max(count - 1, 1)) * 82,
      delay: ((i * 0.17) % 1.5).toFixed(2),
      duration: (1.25 + (i % 3) * 0.22).toFixed(2),
    }));
  }, [state.overflowing, state.rowFraction]);

  return (
    <div className="vessels-card">
      <div className="vessels-head">
        <h2>5 × {state.tier.unit}</h2>
        <div className="k mono">{formatVesselCount(state.filled)}</div>
      </div>

      <div className="vessel-row">
        {state.fills.map((fill, i) => (
          <div className="vessel" key={i}>
            <Vessel art={state.tier.art} fill={fill} index={i} />
          </div>
        ))}
      </div>

      <div className="floor">
        <div className="ground" />
        <div className="puddle" style={{ width: `${(state.rowFraction * 72).toFixed(0)}%` }} />
        {drips.map((drip, i) => (
          <span
            className="drip"
            key={i}
            style={{
              left: `${drip.left.toFixed(1)}%`,
              animationDelay: `${drip.delay}s`,
              animationDuration: `${drip.duration}s`,
            }}
          />
        ))}
      </div>

      <p className="vessel-note">
        {state.offTheScale && !state.nextTier ? (
          <>
            <b>Off the scale.</b> Past five reservoirs there is no bigger vessel to draw.
          </>
        ) : (
          <>
            One vessel = <b>{state.tier.unit}</b>.
            {state.nextTier ? ` Fill all five and they become ${state.nextTier.unit}s.` : ""}
          </>
        )}
      </p>

      <div className="ladder">
        {VESSEL_TIERS.map((tier, i) => (
          <div
            className={`rung ${i === state.tierIndex ? "on" : i < state.tierIndex ? "done" : ""}`}
            key={tier.name}
            title={tier.unit}
          >
            <svg viewBox="0 0 100 150" aria-hidden="true">
              <path className="rp" d={(ART[tier.art] ?? ART.can!).line} />
            </svg>
            <span className="rl">{tier.unit.replace(/ /g, " ")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
