// Air-quality outlook along India's major economic corridors. Each corridor
// is a chain of waypoints (industrial nodes and the cities between them);
// for every waypoint the next 48 h combine:
//
//   1. CAMS PM2.5 / PM10 forecast (Open-Meteo Air Quality, ~40 km grid),
//      scaled to the live ground-station median where the waypoint is a
//      monitored city, so the curve starts from what is measured now;
//   2. the ventilation index (wind speed × boundary-layer height), the
//      measure IMD uses for its air-quality early warning. IMD takes the
//      day's maximum mixing height, so the best hour of the next 24 is
//      used: if even that is below 6000 m²/s, the air cannot disperse what
//      is emitted into it (every night is "stagnant" by this measure);
//   3. fire smoke arriving from NASA FIRMS clusters, traced on the forecast
//      wind with the same engine as the transboundary advisories.
//
// Pure functions only; lib/server/corridors.ts does the fetching.
import { indiaAqiFromPm } from "@/lib/indiaAqi";

export type Waypoint = {
  id: string;
  name: string;
  state: string;
  lat: number;
  lng: number;
  /** Set when the waypoint is a monitored city: its stations calibrate the forecast. */
  cityId?: string;
};

export type Corridor = {
  id: string;
  name: string;
  shortName: string;
  description: string;
  waypoints: Waypoint[];
};

export const CORRIDORS: Corridor[] = [
  {
    id: "dmic",
    name: "Delhi–Mumbai Industrial Corridor",
    shortName: "Delhi–Mumbai",
    description: "DMIC, along the Western Dedicated Freight Corridor through Rajasthan and Gujarat.",
    waypoints: [
      { id: "delhi", name: "New Delhi", state: "Delhi", lat: 28.6139, lng: 77.209, cityId: "delhi" },
      { id: "neemrana", name: "Neemrana", state: "Rajasthan", lat: 27.9881, lng: 76.388 },
      { id: "jaipur", name: "Jaipur", state: "Rajasthan", lat: 26.9124, lng: 75.7873 },
      { id: "ajmer", name: "Ajmer", state: "Rajasthan", lat: 26.4499, lng: 74.6399 },
      { id: "udaipur", name: "Udaipur", state: "Rajasthan", lat: 24.5854, lng: 73.7125 },
      { id: "ahmedabad", name: "Ahmedabad", state: "Gujarat", lat: 23.0225, lng: 72.5714 },
      { id: "vadodara", name: "Vadodara", state: "Gujarat", lat: 22.3072, lng: 73.1812 },
      { id: "surat", name: "Surat", state: "Gujarat", lat: 21.1702, lng: 72.8311 },
      { id: "mumbai", name: "Mumbai", state: "Maharashtra", lat: 19.076, lng: 72.8777, cityId: "mumbai" },
    ],
  },
  {
    id: "akic",
    name: "Amritsar–Kolkata Industrial Corridor",
    shortName: "Amritsar–Kolkata",
    description: "AKIC, along the Eastern Dedicated Freight Corridor across the Indo-Gangetic Plain, the path stubble smoke takes each winter.",
    waypoints: [
      { id: "amritsar", name: "Amritsar", state: "Punjab", lat: 31.634, lng: 74.8723 },
      { id: "ludhiana", name: "Ludhiana", state: "Punjab", lat: 30.901, lng: 75.8573 },
      { id: "ambala", name: "Ambala", state: "Haryana", lat: 30.3782, lng: 76.7767 },
      { id: "delhi", name: "New Delhi", state: "Delhi", lat: 28.6139, lng: 77.209, cityId: "delhi" },
      { id: "agra", name: "Agra", state: "Uttar Pradesh", lat: 27.1767, lng: 78.0081 },
      { id: "kanpur", name: "Kanpur", state: "Uttar Pradesh", lat: 26.4499, lng: 80.3319 },
      { id: "prayagraj", name: "Prayagraj", state: "Uttar Pradesh", lat: 25.4358, lng: 81.8463 },
      { id: "varanasi", name: "Varanasi", state: "Uttar Pradesh", lat: 25.3176, lng: 82.9739 },
      { id: "patna", name: "Patna", state: "Bihar", lat: 25.5941, lng: 85.1376 },
      { id: "dhanbad", name: "Dhanbad", state: "Jharkhand", lat: 23.7957, lng: 86.4304 },
      { id: "asansol", name: "Asansol", state: "West Bengal", lat: 23.6739, lng: 86.9524 },
      { id: "kolkata", name: "Kolkata", state: "West Bengal", lat: 22.5726, lng: 88.3639, cityId: "kolkata" },
    ],
  },
  {
    id: "cbic",
    name: "Chennai–Bengaluru Industrial Corridor",
    shortName: "Chennai–Bengaluru",
    description: "CBIC, through the Sriperumbudur, Vellore and Hosur manufacturing belts.",
    waypoints: [
      { id: "chennai", name: "Chennai", state: "Tamil Nadu", lat: 13.0827, lng: 80.2707, cityId: "chennai" },
      { id: "sriperumbudur", name: "Sriperumbudur", state: "Tamil Nadu", lat: 12.9675, lng: 79.9419 },
      { id: "vellore", name: "Vellore", state: "Tamil Nadu", lat: 12.9165, lng: 79.1325 },
      { id: "krishnagiri", name: "Krishnagiri", state: "Tamil Nadu", lat: 12.5186, lng: 78.2137 },
      { id: "hosur", name: "Hosur", state: "Tamil Nadu", lat: 12.7409, lng: 77.8253 },
      { id: "bengaluru", name: "Bengaluru", state: "Karnataka", lat: 12.9716, lng: 77.5946, cityId: "bengaluru" },
    ],
  },
  {
    id: "hbic",
    name: "Hyderabad–Bengaluru Industrial Corridor",
    shortName: "Hyderabad–Bengaluru",
    description: "HBIC, along NH-44 through Telangana and Andhra Pradesh.",
    waypoints: [
      { id: "hyderabad", name: "Hyderabad", state: "Telangana", lat: 17.385, lng: 78.4867, cityId: "hyderabad" },
      { id: "mahabubnagar", name: "Mahabubnagar", state: "Telangana", lat: 16.7488, lng: 77.9853 },
      { id: "kurnool", name: "Kurnool", state: "Andhra Pradesh", lat: 15.8281, lng: 78.0373 },
      { id: "anantapur", name: "Anantapur", state: "Andhra Pradesh", lat: 14.6819, lng: 77.6006 },
      { id: "bengaluru", name: "Bengaluru", state: "Karnataka", lat: 12.9716, lng: 77.5946, cityId: "bengaluru" },
    ],
  },
];

/** Every distinct waypoint (Delhi and Bengaluru sit on two corridors). */
export function uniqueWaypoints(corridors = CORRIDORS): Waypoint[] {
  const seen = new Map<string, Waypoint>();
  for (const corridor of corridors) for (const waypoint of corridor.waypoints) seen.set(waypoint.id, waypoint);
  return [...seen.values()];
}

export const OUTLOOK_HOURS = 48;
/** IMD: a ventilation index below this is unfavourable for dispersion. */
export const POOR_VENTILATION_M2S = 6000;
/** Station / model ratio is clamped so one odd station can't distort the curve. */
export const CALIBRATION_MIN = 0.5;
export const CALIBRATION_MAX = 2.5;
/** A rise of this much in the 24-h mean counts as a spike. */
export const SPIKE_RISE_RATIO = 1.25;

export type WaypointInputs = {
  /** Hourly, starting at the current hour. */
  pm25: Array<number | null>;
  pm10: Array<number | null>;
  windSpeedMs: Array<number | null>;
  boundaryLayerM: Array<number | null>;
  /** Median PM2.5 of live stations right now, when the waypoint is a monitored city. */
  stationPm25: number | null;
  stationCount: number;
  smoke: { firePixels: number; etaHours: number; sources: number } | null;
};

export type RiskLevel = "good" | "satisfactory" | "moderate" | "poor" | "very_poor" | "severe";

export type WaypointOutlook = {
  /** Calibrated hourly PM2.5 (µg/m³), rounded. */
  pm25: number[];
  calibration: { factor: number; stations: number } | null;
  now24hMean: number;
  peak24hMean: number;
  /** Hours from now to the start of the worst 24-h window. */
  peakWindowStartHours: number;
  /** Hour of the single highest hourly value. */
  peakHour: number;
  peakHourValue: number;
  aqi: number | null;
  category: string;
  color: string;
  level: RiskLevel;
  spike: boolean;
  ventilation: { peak24hM2s: number | null; poorHours24h: number; poor: boolean };
  smoke: WaypointInputs["smoke"];
  drivers: Array<"rising" | "stagnation" | "smoke">;
};

const LEVELS: RiskLevel[] = ["good", "satisfactory", "moderate", "poor", "very_poor", "severe"];

export function levelForPm25(pm25: number): RiskLevel {
  if (pm25 <= 30) return "good";
  if (pm25 <= 60) return "satisfactory";
  if (pm25 <= 90) return "moderate";
  if (pm25 <= 120) return "poor";
  if (pm25 <= 250) return "very_poor";
  return "severe";
}

export function levelRank(level: RiskLevel) {
  return LEVELS.indexOf(level);
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

/** Last known value carried forward over gaps; null only if there is none at all. */
function fillGaps(series: Array<number | null>, length: number) {
  const out: number[] = [];
  let last: number | null = series.find((value): value is number => typeof value === "number") ?? null;
  if (last === null) return null;
  for (let i = 0; i < length; i += 1) {
    const value = series[i];
    if (typeof value === "number" && Number.isFinite(value)) last = value;
    out.push(last);
  }
  return out;
}

export function computeOutlook(inputs: WaypointInputs): WaypointOutlook | null {
  const model = fillGaps(inputs.pm25, OUTLOOK_HOURS);
  if (!model) return null;

  let calibration: WaypointOutlook["calibration"] = null;
  let factor = 1;
  if (inputs.stationPm25 !== null && inputs.stationCount > 0 && model[0] >= 5) {
    factor = Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, inputs.stationPm25 / model[0]));
    calibration = { factor: Number(factor.toFixed(2)), stations: inputs.stationCount };
  }
  const pm25 = model.map((value) => Math.round(value * factor));

  const windows = Array.from({ length: OUTLOOK_HOURS - 24 + 1 }, (_, start) => mean(pm25.slice(start, start + 24)));
  const now24hMean = windows[0];
  const peakWindowStartHours = windows.indexOf(Math.max(...windows));
  const peak24hMean = windows[peakWindowStartHours];
  const peakHourValue = Math.max(...pm25);
  const peakHour = pm25.indexOf(peakHourValue);

  const pm10 = fillGaps(inputs.pm10, OUTLOOK_HOURS);
  const pm10Peak = pm10 ? mean(pm10.slice(peakWindowStartHours, peakWindowStartHours + 24)) * factor : null;
  const aqi = indiaAqiFromPm(peak24hMean, pm10Peak);

  const ventilationHours = Array.from({ length: 24 }, (_, i) => {
    const wind = inputs.windSpeedMs[i];
    const blh = inputs.boundaryLayerM[i];
    return typeof wind === "number" && typeof blh === "number" ? wind * blh : null;
  }).filter((value): value is number => value !== null);
  const peakVentilation = ventilationHours.length ? Math.round(Math.max(...ventilationHours)) : null;
  const poorHours = ventilationHours.filter((value) => value < POOR_VENTILATION_M2S).length;
  const poorVentilation = peakVentilation !== null && peakVentilation < POOR_VENTILATION_M2S;

  const spike = peak24hMean >= now24hMean * SPIKE_RISE_RATIO && levelForPm25(peak24hMean) !== "good";
  const drivers: WaypointOutlook["drivers"] = [];
  if (spike) drivers.push("rising");
  if (poorVentilation) drivers.push("stagnation");
  if (inputs.smoke) drivers.push("smoke");

  return {
    pm25,
    calibration,
    now24hMean: Math.round(now24hMean),
    peak24hMean: Math.round(peak24hMean),
    peakWindowStartHours,
    peakHour,
    peakHourValue,
    aqi: aqi?.aqi ?? null,
    category: aqi?.info.category ?? "Unknown",
    color: aqi?.info.color ?? "#6d7b73",
    level: levelForPm25(peak24hMean),
    spike,
    ventilation: { peak24hM2s: peakVentilation, poorHours24h: poorHours, poor: poorVentilation },
    smoke: inputs.smoke,
    drivers,
  };
}

export type CorridorSegment = { from: string; to: string; level: RiskLevel; color: string };

export type CorridorOutlook = {
  id: string;
  name: string;
  shortName: string;
  description: string;
  waypoints: Array<Waypoint & { outlook: WaypointOutlook | null }>;
  segments: CorridorSegment[];
  worst: { waypointId: string; name: string; level: RiskLevel; peak24hMean: number } | null;
  /** Waypoints forecast at Poor or worse. */
  hotspots: number;
  spikes: number;
};

export function buildCorridorOutlook(corridor: Corridor, outlooks: Map<string, WaypointOutlook | null>): CorridorOutlook {
  const waypoints = corridor.waypoints.map((waypoint) => ({ ...waypoint, outlook: outlooks.get(waypoint.id) ?? null }));
  const segments: CorridorSegment[] = [];
  for (let i = 0; i < waypoints.length - 1; i += 1) {
    const a = waypoints[i].outlook;
    const b = waypoints[i + 1].outlook;
    const worse = !a ? b : !b ? a : levelRank(a.level) >= levelRank(b.level) ? a : b;
    segments.push({
      from: waypoints[i].id,
      to: waypoints[i + 1].id,
      level: worse?.level ?? "good",
      color: worse?.color ?? "#c8cfc4",
    });
  }
  const ranked = waypoints
    .filter((waypoint) => waypoint.outlook)
    .sort((a, b) => b.outlook!.peak24hMean - a.outlook!.peak24hMean);
  const worst = ranked[0]
    ? { waypointId: ranked[0].id, name: ranked[0].name, level: ranked[0].outlook!.level, peak24hMean: ranked[0].outlook!.peak24hMean }
    : null;
  return {
    id: corridor.id,
    name: corridor.name,
    shortName: corridor.shortName,
    description: corridor.description,
    waypoints,
    segments,
    worst,
    hotspots: waypoints.filter((waypoint) => waypoint.outlook && levelRank(waypoint.outlook.level) >= levelRank("poor")).length,
    spikes: waypoints.filter((waypoint) => waypoint.outlook?.spike).length,
  };
}

/** Bounding box [minLng, minLat, maxLng, maxLat] around a corridor plus a margin for upwind fires. */
export function corridorBounds(corridor: Corridor, marginDeg = 2): [number, number, number, number] {
  const lats = corridor.waypoints.map((waypoint) => waypoint.lat);
  const lngs = corridor.waypoints.map((waypoint) => waypoint.lng);
  const round = (value: number) => Number(value.toFixed(1));
  return [
    round(Math.min(...lngs) - marginDeg),
    round(Math.min(...lats) - marginDeg),
    round(Math.max(...lngs) + marginDeg),
    round(Math.max(...lats) + marginDeg),
  ];
}
