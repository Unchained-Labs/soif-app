"use client";

import { useRef, useState } from "react";
import { formatWater } from "@/lib/format";

/**
 * Water over time, with the band exposed on hover.
 *
 * The line plots the mid scenario, because plotting three lines at a ~100x
 * spread would make the chart unreadable. The band is therefore not optional
 * decoration in the tooltip — it is the only place the range appears at this
 * granularity, and the caption states the spread so the shape of the mid line
 * is never mistaken for precision.
 */

export interface ChartPoint {
  label: string;
  /** ISO day or month key, used for the axis. */
  key: string;
  low: number;
  mid: number;
  high: number;
}

const W = 900;
const H = 260;
const PAD = { left: 46, right: 14, top: 16, bottom: 30 };

/** Round an axis maximum up to a readable step. */
function niceStep(value: number): number {
  if (value <= 0) return 1;
  const exponent = Math.pow(10, Math.floor(Math.log10(value)));
  const n = value / exponent;
  const factor = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 4 ? 4 : n <= 5 ? 5 : 10;
  return factor * exponent;
}

export function WaterChart({ points }: { points: ChartPoint[] }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  if (points.length === 0) {
    return <p className="cap">No usage in this range.</p>;
  }

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const step = niceStep((Math.max(...points.map((p) => p.mid)) * 1.1) / 4);
  const max = step * 4 || 1;

  const x = (i: number) =>
    PAD.left + (points.length === 1 ? innerW / 2 : (i * innerW) / (points.length - 1));
  const y = (value: number) => PAD.top + innerH - (value / max) * innerH;

  const line = points
    .map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.mid).toFixed(1)}`)
    .join(" ");
  const area = `${line} L ${x(points.length - 1)} ${PAD.top + innerH} L ${PAD.left} ${PAD.top + innerH} Z`;

  // First, middle and last only — a label per point is unreadable at 25+ days.
  const labelIndices = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];

  const handleMove = (event: React.MouseEvent<SVGRectElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * W;
    const spacing = innerW / Math.max(1, points.length - 1);
    const index = Math.round((px - PAD.left) / spacing);
    setHover(Math.max(0, Math.min(points.length - 1, index)));
  };

  const active = hover !== null ? points[hover] : null;

  return (
    <div className="chartbox">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Water consumption over time, mid scenario"
      >
        <defs>
          <linearGradient id="waterArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--water)" stopOpacity=".26" />
            <stop offset="100%" stopColor="var(--water)" stopOpacity=".02" />
          </linearGradient>
        </defs>

        {[0, 1, 2, 3, 4].map((tick) => {
          const value = step * tick;
          const yy = y(value);
          return (
            <g key={tick}>
              <line className="gridline" x1={PAD.left} y1={yy} x2={W - PAD.right} y2={yy} />
              <text className="axis-t" x={PAD.left - 9} y={yy + 3.5} textAnchor="end">
                {value === 0 ? "0" : `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} L`}
              </text>
            </g>
          );
        })}

        <path d={area} fill="url(#waterArea)" />
        <path
          d={line}
          fill="none"
          stroke="var(--water)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle
          cx={x(points.length - 1)}
          cy={y(points[points.length - 1]!.mid)}
          r="4.5"
          fill="var(--water)"
          stroke="var(--surface)"
          strokeWidth="2"
        />

        {labelIndices.map((i) => (
          <text
            key={i}
            className="axis-t"
            x={x(i)}
            y={H - 9}
            textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
          >
            {points[i]!.label}
          </text>
        ))}

        {hover !== null && (
          <>
            <line
              x1={x(hover)}
              y1={PAD.top}
              x2={x(hover)}
              y2={PAD.top + innerH}
              stroke="var(--line-strong)"
              strokeWidth="1"
            />
            <circle
              cx={x(hover)}
              cy={y(points[hover]!.mid)}
              r="5"
              fill="var(--water)"
              stroke="var(--surface)"
              strokeWidth="2"
            />
          </>
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

      {active && hover !== null && (
        <div
          className="tip on"
          style={{
            left: `clamp(0px, calc(${((x(hover) / W) * 100).toFixed(2)}% - 80px), calc(100% - 165px))`,
            top: `calc(${((y(active.mid) / H) * 100).toFixed(2)}% - 72px)`,
          }}
        >
          <div className="t-m">{active.label}</div>
          <div className="t-v">{formatWater(active.mid)}</div>
          <div className="t-r">
            range {formatWater(active.low)} – {formatWater(active.high)}
          </div>
        </div>
      )}
    </div>
  );
}
