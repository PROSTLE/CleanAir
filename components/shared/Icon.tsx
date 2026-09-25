import type { SVGProps } from "react";

// VayuSetu line icons. One grid (24), one stroke weight (1.5, round caps and
// joins), drawn for this product: air, sensors, satellites, fire, the H3 grid.
// Colour comes from `currentColor`, so icons inherit the surrounding text.

export type IconName =
  | "satellite"
  | "station"
  | "wind"
  | "flame"
  | "dust"
  | "haze"
  | "factory"
  | "particulate"
  | "camera"
  | "pin"
  | "chart"
  | "clock"
  | "shield"
  | "document"
  | "hexagon"
  | "database"
  | "refresh"
  | "trend-up"
  | "trend-down"
  | "trend-flat"
  | "school"
  | "hospital"
  | "citizens"
  | "layers"
  | "compass"
  | "message"
  | "alert"
  | "gauge"
  | "list"
  | "arrow-right"
  | "code"
  | "close";

const PATHS: Record<IconName, React.ReactNode> = {
  satellite: (
    <>
      <path d="M12 9l3 3-3 3-3-3z" />
      <path d="M6.5 3.5l3 3-3 3-3-3z" />
      <path d="M17.5 14.5l3 3-3 3-3-3z" />
      <path d="M9.5 9.5l1 1M13.5 13.5l1 1" />
      <path d="M16.5 4.2a4.5 4.5 0 0 1 3.3 3.3" />
    </>
  ),
  station: (
    <>
      <path d="M12 21v-9" />
      <path d="M8.5 21h7" />
      <circle cx="12" cy="9" r="2" />
      <path d="M8.2 5.7a5.2 5.2 0 0 0 0 6.6M15.8 5.7a5.2 5.2 0 0 1 0 6.6" />
    </>
  ),
  wind: (
    <>
      <path d="M3 8.5h10.5a2.75 2.75 0 1 0-2.75-2.75" />
      <path d="M3 12.5h15a3 3 0 1 1-3 3" />
      <path d="M3 16.5h6.5" />
    </>
  ),
  flame: (
    <>
      <path d="M12 21c-3.9 0-7-2.8-7-6.6 0-3.1 2.3-5 3.6-7.4.6 1.6 1.6 2.6 2.8 3 .2-2.7 1.4-5.3 3.6-7 .2 3.4 4 5.5 4 10.6C19 17.6 15.9 21 12 21z" />
      <path d="M12 21c-1.7 0-3-1.3-3-2.9 0-1.8 1.5-2.7 2-4.4 1.1.8 4 2.3 4 4.4 0 1.6-1.3 2.9-3 2.9z" />
    </>
  ),
  dust: (
    <>
      <path d="M3 13.5c3 0 3-3.5 6-3.5s3 3.5 6 3.5 3-3.5 6-3.5" />
      <circle cx="6.5" cy="18" r="0.9" />
      <circle cx="11.5" cy="19" r="0.9" />
      <circle cx="16.5" cy="17.5" r="0.9" />
      <circle cx="8" cy="5.5" r="0.9" />
      <circle cx="15" cy="5" r="0.9" />
    </>
  ),
  haze: (
    <>
      <path d="M3 7.5c2-1.4 4-1.4 6 0s4 1.4 6 0 4-1.4 6 0" />
      <path d="M3 12c2-1.4 4-1.4 6 0s4 1.4 6 0 4-1.4 6 0" />
      <path d="M3 16.5c2-1.4 4-1.4 6 0s4 1.4 6 0 4-1.4 6 0" />
    </>
  ),
  factory: (
    <>
      <path d="M3 21V12l5 3v-3l5 3V8h2.5l.8-4.5h1.4L18.5 8V21z" />
      <path d="M3 21h18" />
      <path d="M7 18h2M11.5 18h2" />
    </>
  ),
  particulate: (
    <>
      <circle cx="8" cy="8.5" r="2.5" />
      <circle cx="16" cy="6.5" r="1.4" />
      <circle cx="15.5" cy="15" r="3" />
      <circle cx="7.5" cy="16" r="1.2" />
      <circle cx="11" cy="20" r="0.8" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8.5h3.2l1.8-3h6l1.8 3H20V19H4z" />
      <circle cx="12" cy="13.5" r="3.3" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21z" />
      <circle cx="12" cy="10" r="2.4" />
    </>
  ),
  chart: (
    <>
      <path d="M3.5 20h17" />
      <path d="M4.5 15.5l4-4.5 3.5 3 4-5.5 3.5 3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7 3v5.5c0 4.3-2.9 8.1-7 9.5-4.1-1.4-7-5.2-7-9.5V6z" />
      <path d="M9 12l2 2 4-4.2" />
    </>
  ),
  document: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
      <path d="M9 12h6M9 16h6" />
    </>
  ),
  hexagon: <path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" />,
  database: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
      <path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
    </>
  ),
  refresh: (
    <>
      <path d="M19.5 10.5A7.8 7.8 0 0 0 6 6.2L4 8.5" />
      <path d="M4 4v4.5h4.5" />
      <path d="M4.5 13.5A7.8 7.8 0 0 0 18 17.8l2-2.3" />
      <path d="M20 20v-4.5h-4.5" />
    </>
  ),
  "trend-up": (
    <>
      <path d="M4 17l5.5-5.5 4 4L20 9" />
      <path d="M15 9h5v5" />
    </>
  ),
  "trend-down": (
    <>
      <path d="M4 7l5.5 5.5 4-4L20 15" />
      <path d="M15 15h5v-5" />
    </>
  ),
  "trend-flat": (
    <>
      <path d="M4 12h15" />
      <path d="M15.5 8.5L19 12l-3.5 3.5" />
    </>
  ),
  school: (
    <>
      <path d="M3 9.5l9-5 9 5-9 5z" />
      <path d="M7 11.8v4.4c0 1.3 2.2 2.8 5 2.8s5-1.5 5-2.8v-4.4" />
      <path d="M21 9.5v5" />
    </>
  ),
  hospital: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <path d="M12 8.5v7M8.5 12h7" />
    </>
  ),
  citizens: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 20c.5-3.3 2.8-5 5.5-5s5 1.7 5.5 5" />
      <path d="M16 5.3a3 3 0 0 1 0 5.4" />
      <path d="M17.8 15c1.7.6 2.7 2.2 3 5" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3.5l9 5-9 5-9-5z" />
      <path d="M3 13l9 5 9-5" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M15.5 8.5l-2 5-5 2 2-5z" />
    </>
  ),
  message: (
    <>
      <path d="M4.5 5h15v10.5H10L5.5 19v-3.5h-1z" />
      <path d="M8.5 9.5h7M8.5 12h4.5" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4l8.7 15H3.3z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="16.6" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  gauge: (
    <>
      <path d="M4 17a8 8 0 1 1 16 0" />
      <path d="M12 17l3.5-5" />
      <circle cx="12" cy="17" r="1" />
    </>
  ),
  list: (
    <>
      <path d="M9 6.5h11M9 12h11M9 17.5h11" />
      <circle cx="5" cy="6.5" r="0.9" />
      <circle cx="5" cy="12" r="0.9" />
      <circle cx="5" cy="17.5" r="0.9" />
    </>
  ),
  "arrow-right": (
    <>
      <path d="M5 12h14" />
      <path d="M13.5 6.5L19 12l-5.5 5.5" />
    </>
  ),
  code: (
    <>
      <path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5" />
    </>
  ),
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
};

export default function Icon({
  name,
  size = 16,
  title,
  className,
  ...rest
}: { name: IconName; size?: number; title?: string } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      className={`vs-icon ${className ?? ""}`.trim()}
      {...rest}
    >
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  );
}

/** Icon for each hazard type, so hazards read the same everywhere. */
export const HAZARD_ICON: Record<string, IconName> = {
  fire: "flame",
  smog: "haze",
  dust: "dust",
  industrial: "factory",
  particulate: "particulate",
};
