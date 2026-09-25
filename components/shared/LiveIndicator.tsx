"use client";

import { useId } from "react";

export type LiveState = "live" | "connecting" | "archive" | "offline";

// One period of the trace: a quiet baseline with the irregular bumps of a
// sensor feed. Two copies scroll left so the signal reads as arriving now.
const TRACE =
  "M0 9H5C6.5 9 7 4.5 8.5 4.5S10.5 12.5 12 12.5 13.6 7.5 15 7.5 16.6 9 18 9H26C27.2 9 27.6 6.5 29 6.5S30.8 9 32 9H40";
const PERIOD = 40;

/**
 * Status of a data feed, drawn as a small live signal trace.
 * Only "live" animates: a trace that scrolls into a pulsing head point.
 * Every other state is static, so motion always means real, current data.
 */
export default function LiveIndicator({
  state,
  label,
  className,
}: {
  state: LiveState;
  label?: string;
  className?: string;
}) {
  const id = useId().replace(/:/g, "");
  const flat = state === "offline";

  return (
    <span className={`vs-live is-${state} ${className ?? ""}`.trim()} role="status">
      <svg width="44" height="18" viewBox="0 0 44 18" aria-hidden="true">
        <defs>
          <linearGradient id={`fade-${id}`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.45" stopColor="#fff" stopOpacity="1" />
          </linearGradient>
          <mask id={`mask-${id}`}>
            <rect x="0" y="0" width="36" height="18" fill={`url(#fade-${id})`} />
          </mask>
        </defs>
        <g mask={`url(#mask-${id})`}>
          {flat ? (
            <path className="vs-live-trace" d="M0 9H36" />
          ) : (
            <g className="vs-live-track">
              <path className="vs-live-trace" d={TRACE} />
              <path className="vs-live-trace" d={TRACE} transform={`translate(${PERIOD} 0)`} />
            </g>
          )}
        </g>
        {state === "live" && <circle className="vs-live-ring" cx="38.5" cy="9" r="2.4" />}
        <circle className="vs-live-head" cx="38.5" cy="9" r="2.4" />
      </svg>
      {label && <span className="vs-live-label">{label}</span>}
    </span>
  );
}
