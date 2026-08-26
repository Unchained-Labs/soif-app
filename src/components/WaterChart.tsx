"use client";

import { useMemo, useRef, useState } from "react";
import { formatWater } from "@/lib/format";

/**
 * Water over time: daily bars with a cumulative line over them.
 *
 * The two answer different questions and both get asked. Bars answer "was
 * yesterday heavy?" — the shape people actually act on, and a shape a line
 * chart smooths away. The cumulative line answers "how much have we spent
 * altogether?", which is the number that turns an abstract per-prompt figure
 * into something with weight.
 *
 * Dual axes can mislead, so both are labelled with their own units and the
 * cumulative axis is drawn in the line's own colour rather than the default
 * ink. The bars carry the primary scale; the line is explicitly secondary.
 *
 * Only the mid scenario is plotted — three bands at a ~100x spread would be
 * unreadable — so the tooltip is the only place the range appears at this
 * granularity, and it shows it for both series.
 */

export interface ChartPoint {
  label: string;
  /** ISO day or month key. */
  key: string;
  low: number;
  mid: number;
  high: number;
}

const W = 900;
const H = 280;
const PAD = { left: 52, right: 58, top: 18, bottom: 34 };

/** Round an axis maximum up to a readable step. */
function niceStep(value: number): number {
  if (value <= 0) return 1;
  const exponent = Math.pow(10, Math.floor(Math.log10(value)));
  const n = value / exponent;
  const factor = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 4 ? 4 : n <= 5 ? 5 : 10;
  return factor * exponent;
}

/** Axis tick label: litres above a litre, millilitres below. */
function axisLabel(ml: number): string {
  if (ml === 0) return "0";
  const litres = ml / 1000;
  if (litres >= 100) return `${Math.round(litres)} L`;
  if (litres >= 1) return `${litres.toFixed(litres < 10 ? 1 : 0)} L`;
  return `${Math.round(ml)} mL`;
}

export function WaterChart({ points }: { points: ChartPoint[] }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  // Cumulative is derived here rather than passed in, so the two series can
  // never disagree about the same underlying data.
  const cumulative = useMemo(() => {
    let low = 0;
    let mid = 0;
    let high = 0;
    return points.map((p) => {
      low += p.low;
      mid += p.mid;
      high += p.high;
      return { low, mid, high };
    });
  }, [points]);

  if (points.length === 0) {
    return <p className="cap">No usage in this range.</p>;
  }

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const dailyStep = niceStep((Math.max(...points.map((p) => p.mid)) * 1.15) / 4);
  const dailyMax = dailyStep * 4 || 1;
  const totalMax = cumulative[cumulative.length - 1]?.mid || 1;

  const slot = innerW / points.length;
  // Bars keep a small gutter and a floor width so a year of daily data still
  // reads as bars rather than a solid block.
  const barWidth = Math.max(Math.min(slot * 0.68, 42), 1.5);
  const barX = (i: number) => PAD.left + slot * i + (slot - barWidth) / 2;
  const centreX = (i: number) => PAD.left + slot * i + slot / 2;
  const dailyY = (value: number) => PAD.top + innerH - (value / dailyMax) * innerH;
  const totalY = (value: number) => PAD.top + innerH - (value / totalMax) * innerH;

  const linePath = cumulative
    .map((c, i) => `${i ? "L" : "M"}${centreX(i).toFixed(1)} ${totalY(c.mid).toFixed(1)}`)
    .join(" ");

  const labelIndices = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];

  const handleMove = (event: React.MouseEvent<SVGRectElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * W;
    const index = Math.floor((px - PAD.left) / slot);
    setHover(Math.max(0, Math.min(points.length - 1, index)));
  };

  const active = hover !== null ? points[hover] : null;
  const activeTotal = hover !== null ? cumulative[hover] : null;

  return (
    <div className="chartbox">
      <div className="chart-legend">
        <span className="cl">
          <i className="sw bar" /> Daily
        </span>
        <span className="cl">
          <i className="sw line" /> Cumulative
        </span>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Daily water consumption with cumulative total, mid scenario"
      >
        <defs>
          <linearGradient id="barFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--water)" stopOpacity=".95" />
            <stop offset="100%" stopColor="var(--water)" stopOpacity=".45" />
          </linearGradient>
        </defs>

        {/* Gridlines and the left (daily) axis. */}
        {[0, 1, 2, 3, 4].map((tick) => {
          const value = dailyStep * tick;
          const y = dailyY(value);
          return (
            <g key={tick}>
              <line className="gridline" x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} />
              <text className="axis-t" x={PAD.left - 9} y={y + 3.5} textAnchor="end">
                {axisLabel(value)}
              </text>
            </g>
          );
        })}

        {/* Right axis, in the cumulative line's own colour so the two scales
            cannot be confused for one. */}
        {[0, 0.5, 1].map((fraction) => {
          const value = totalMax * fraction;
          return (
            <text
              key={fraction}
              className="axis-t axis-cum"
              x={W - PAD.right + 9}
              y={totalY(value) + 3.5}
              textAnchor="start"
            >
              {axisLabel(value)}
            </text>
          );
        })}

        {points.map((point, i) => (
          <rect
            key={point.key}
            x={barX(i)}
            y={dailyY(point.mid)}
            width={barWidth}
            height={Math.max(PAD.top + innerH - dailyY(point.mid), 0)}
            rx={Math.min(2, barWidth / 3)}
            fill="url(#barFill)"
            opacity={hover === null || hover === i ? 1 : 0.45}
          />
        ))}

        <path
          d={linePath}
          fill="none"
          stroke="var(--s4)"
          strokeWidth="2.25"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle
          cx={centreX(points.length - 1)}
          cy={totalY(cumulative[cumulative.length - 1]!.mid)}
          r="4.5"
          fill="var(--s4)"
          stroke="var(--surface)"
          strokeWidth="2"
        />

        {labelIndices.map((i) => (
          <text
            key={i}
            className="axis-t"
            x={centreX(i)}
            y={H - 11}
            textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
          >
            {points[i]!.label}
          </text>
        ))}

        {hover !== null && activeTotal && (
          <circle
            cx={centreX(hover)}
            cy={totalY(activeTotal.mid)}
            r="5"
            fill="var(--s4)"
            stroke="var(--surface)"
            strokeWidth="2"
          />
        )}

        <rect
          x={PAD.left}
          y={PAD.top}
          width={innerW}
          height={innerH}
          fill="transparent"
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
        />
      </svg>

      {active && activeTotal && hover !== null && (
        <div
          className="tip on"
          style={{
            left: `clamp(0px, calc(${((centreX(hover) / W) * 100).toFixed(2)}% - 92px), calc(100% - 190px))`,
            top: `calc(${((Math.min(dailyY(active.mid), totalY(activeTotal.mid)) / H) * 100).toFixed(2)}% - 96px)`,
          }}
        >
          <div className="t-m">{active.label}</div>
          <div className="t-v">{formatWater(active.mid)}</div>
          <div className="t-r">
            range {formatWater(active.low)} – {formatWater(active.high)}
          </div>
          <div className="t-cum">
            <span>cumulative</span>
            <b>{formatWater(activeTotal.mid)}</b>
            <span className="t-r">
              {formatWater(activeTotal.low)} – {formatWater(activeTotal.high)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
