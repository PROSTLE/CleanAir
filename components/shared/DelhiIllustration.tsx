import { useId } from "react";
import { DELHI_NCT_BOUNDARY } from "@/lib/operationalRegion";

// Real Delhi NCT outline (lib/operationalRegion.ts) filled with a hexagon
// lattice that echoes the H3 grid the whole pipeline runs on. Used for
// empty and "unavailable" states instead of a stock picture.

const WIDTH = 300;
const MID_LAT = 28.64;
const LNG_SCALE = Math.cos((MID_LAT * Math.PI) / 180);

const lngs = DELHI_NCT_BOUNDARY.map(([lng]) => lng);
const lats = DELHI_NCT_BOUNDARY.map(([, lat]) => lat);
const MIN_LNG = Math.min(...lngs);
const MAX_LNG = Math.max(...lngs);
const MIN_LAT = Math.min(...lats);
const MAX_LAT = Math.max(...lats);
const SCALE = WIDTH / ((MAX_LNG - MIN_LNG) * LNG_SCALE);
const HEIGHT = Math.round((MAX_LAT - MIN_LAT) * SCALE);

export function projectDelhi(lat: number, lng: number) {
  return {
    x: (lng - MIN_LNG) * LNG_SCALE * SCALE,
    y: (MAX_LAT - lat) * SCALE,
  };
}

const OUTLINE = `${DELHI_NCT_BOUNDARY.map(([lng, lat], index) => {
  const { x, y } = projectDelhi(lat, lng);
  return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
}).join("")}Z`;

// Flat-top hexagon lattice tile (side 7).
const SIDE = 7;
const HEX_H = Math.sqrt(3) * SIDE;
function hexPath(cx: number, cy: number) {
  const points = Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 3) * i;
    return `${(cx + SIDE * Math.cos(angle)).toFixed(2)} ${(cy + SIDE * Math.sin(angle)).toFixed(2)}`;
  });
  return `M${points.join("L")}Z`;
}
const TILE_W = SIDE * 3;
const TILE_PATHS = [hexPath(SIDE, HEX_H / 2), hexPath(SIDE * 2.5, 0), hexPath(SIDE * 2.5, HEX_H)];

export default function DelhiIllustration({
  points = [],
  className,
  title,
}: {
  /** Optional markers (e.g. hotspots) in lat/lng. */
  points?: Array<{ lat: number; lng: number; tone?: "hot" | "calm" }>;
  className?: string;
  title?: string;
}) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      className={`vs-delhi ${className ?? ""}`.trim()}
      viewBox={`-6 -6 ${WIDTH + 12} ${HEIGHT + 12}`}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <defs>
        <pattern id={`hex-${id}`} width={TILE_W} height={HEX_H} patternUnits="userSpaceOnUse">
          {TILE_PATHS.map((d) => (
            <path key={d} d={d} className="vs-delhi-hex" />
          ))}
        </pattern>
        <clipPath id={`clip-${id}`}>
          <path d={OUTLINE} />
        </clipPath>
      </defs>
      <path d={OUTLINE} className="vs-delhi-fill" />
      <rect
        x="0"
        y="0"
        width={WIDTH}
        height={HEIGHT}
        fill={`url(#hex-${id})`}
        clipPath={`url(#clip-${id})`}
      />
      <path d={OUTLINE} className="vs-delhi-outline" />
      {points.map((point, index) => {
        const { x, y } = projectDelhi(point.lat, point.lng);
        return (
          <g key={index} className={`vs-delhi-point is-${point.tone ?? "hot"}`}>
            <circle cx={x} cy={y} r="9" className="vs-delhi-halo" />
            <circle cx={x} cy={y} r="3.2" />
          </g>
        );
      })}
    </svg>
  );
}
