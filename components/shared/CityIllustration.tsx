"use client";

import { useId, useMemo } from "react";
import type { CityConfig } from "@/lib/cities";
import { useCity } from "@/lib/cityContext";

// The selected city's real outline (lib/cityBoundaries.ts, its largest ring)
// filled with a hexagon lattice that echoes the H3 grid the whole pipeline
// runs on. Used for empty and "unavailable" states instead of a stock picture.

const WIDTH = 300;

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

function ringArea(ring: CityConfig["boundary"][number]) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(area / 2);
}

function buildProjection(city: CityConfig) {
  const ring = [...city.boundary].sort((a, b) => ringArea(b) - ringArea(a))[0];
  const lngs = ring.map(([lng]) => lng);
  const lats = ring.map(([, lat]) => lat);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const lngScale = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const scale = WIDTH / ((maxLng - minLng) * lngScale);
  const project = (lat: number, lng: number) => ({
    x: (lng - minLng) * lngScale * scale,
    y: (maxLat - lat) * scale,
  });
  const outline = `${ring
    .map(([lng, lat], index) => {
      const { x, y } = project(lat, lng);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join("")}Z`;
  return { project, outline, height: Math.round((maxLat - minLat) * scale) };
}

export default function CityIllustration({
  points = [],
  className,
  title,
  city: cityOverride,
}: {
  /** Optional markers (e.g. hotspots) in lat/lng. */
  points?: Array<{ lat: number; lng: number; tone?: "hot" | "calm" }>;
  className?: string;
  title?: string;
  /** Defaults to the city selected in the navbar. */
  city?: CityConfig;
}) {
  const { city: selectedCity } = useCity();
  const city = cityOverride ?? selectedCity;
  const { project, outline, height } = useMemo(() => buildProjection(city), [city]);
  const id = useId().replace(/:/g, "");
  return (
    <svg
      className={`vs-city ${className ?? ""}`.trim()}
      viewBox={`-6 -6 ${WIDTH + 12} ${height + 12}`}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <defs>
        <pattern id={`hex-${id}`} width={TILE_W} height={HEX_H} patternUnits="userSpaceOnUse">
          {TILE_PATHS.map((d) => (
            <path key={d} d={d} className="vs-city-hex" />
          ))}
        </pattern>
        <clipPath id={`clip-${id}`}>
          <path d={outline} />
        </clipPath>
      </defs>
      <path d={outline} className="vs-city-fill" />
      <rect x="0" y="0" width={WIDTH} height={height} fill={`url(#hex-${id})`} clipPath={`url(#clip-${id})`} />
      <path d={outline} className="vs-city-outline" />
      {points.map((point, index) => {
        const { x, y } = project(point.lat, point.lng);
        return (
          <g key={index} className={`vs-city-point is-${point.tone ?? "hot"}`}>
            <circle cx={x} cy={y} r="9" className="vs-city-halo" />
            <circle cx={x} cy={y} r="3.2" />
          </g>
        );
      })}
    </svg>
  );
}
