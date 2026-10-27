import "server-only";

import { getCity } from "@/lib/cities";
import {
  CORRIDORS,
  OUTLOOK_HOURS,
  buildCorridorOutlook,
  computeOutlook,
  corridorBounds,
  uniqueWaypoints,
  type CorridorOutlook,
  type Waypoint,
  type WaypointInputs,
  type WaypointOutlook,
} from "@/lib/corridors";
import { getFiresInBounds, type FireHotspot } from "@/lib/earthEngineSatellite";
import { adminDb, adminServerTimestamp } from "@/lib/firebaseAdmin";
import { fetchCityStationDirectory } from "@/lib/stations";
import { MAX_TRANSPORT_HOURS, clusterFiresAround, traceTrajectory, type WindStation } from "@/lib/transboundary";

// Wiring for lib/corridors.ts. Two Open-Meteo calls cover every waypoint
// (air quality, then weather); station medians calibrate the monitored
// cities; FIRMS fires around each corridor are traced to each waypoint.
// Stored in Firestore `corridors/latest` by the cron tick.

const AIR_QUALITY_ENDPOINT = "https://air-quality-api.open-meteo.com/v1/air-quality";
const WEATHER_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const FETCH_TIMEOUT_MS = 20_000;
const MEMORY_TTL_MS = 30 * 60 * 1000;
const STORED_MAX_AGE_MS = 90 * 60 * 1000;
/** Bump when the stored shape or the method changes, so older results are recomputed. */
const STORED_VERSION = 2;

export type CorridorsResult = {
  computedAt: string;
  corridors: CorridorOutlook[];
  sources: string[];
  fires: { considered: number; truncated: boolean; error: string | null };
  error?: string;
};

let memory: { expiresAt: number; value: CorridorsResult } | null = null;
let inFlight: Promise<CorridorsResult> | null = null;

type Hourly = Record<string, Array<number | null> | string[] | undefined> & { time?: string[] };

async function fetchHourly(endpoint: string, points: Waypoint[], variables: string[], extra: Record<string, string> = {}) {
  const url = new URL(endpoint);
  url.searchParams.set("latitude", points.map((point) => point.lat.toFixed(3)).join(","));
  url.searchParams.set("longitude", points.map((point) => point.lng.toFixed(3)).join(","));
  url.searchParams.set("hourly", variables.join(","));
  url.searchParams.set("timezone", "GMT");
  url.searchParams.set("forecast_days", "3");
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  // One retry: a single dropped connection shouldn't blank every corridor for an hour.
  const attempt = () => fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  let response: Response;
  try {
    response = await attempt().catch(attempt);
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause?.message;
    throw new Error(`${url.host}: ${error instanceof Error ? error.message : String(error)}${cause ? ` (${cause})` : ""}`);
  }
  if (!response.ok) throw new Error(`${url.host} responded ${response.status}`);
  const payload = (await response.json()) as unknown;
  const locations = (Array.isArray(payload) ? payload : [payload]) as Array<{ hourly?: Hourly }>;
  const currentHour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  // Slice every series to start at the current hour.
  return locations.map((location) => {
    const hourly = location.hourly ?? {};
    const times = hourly.time ?? [];
    const first = Math.max(0, times.findIndex((time) => Date.parse(`${time}Z`) >= currentHour));
    return Object.fromEntries(
      variables.map((name) => [
        name,
        ((hourly[name] as Array<number | null> | undefined) ?? []).slice(first, first + OUTLOOK_HOURS),
      ]),
    ) as Record<string, Array<number | null>>;
  });
}

/** Live-station PM2.5 median for each waypoint that is a monitored city. */
async function stationMedians(waypoints: Waypoint[]) {
  const medians = new Map<string, { pm25: number; count: number }>();
  await Promise.all(
    waypoints
      .filter((waypoint) => waypoint.cityId)
      .map(async (waypoint) => {
        try {
          const stations = await fetchCityStationDirectory(getCity(waypoint.cityId));
          const values = stations
            .filter((station) => !station.stale && typeof station.pm25 === "number")
            .map((station) => station.pm25 as number)
            .sort((a, b) => a - b);
          if (values.length === 0) return;
          const mid = Math.floor(values.length / 2);
          const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
          medians.set(waypoint.id, { pm25: median, count: values.length });
        } catch (error) {
          console.warn(`Corridor stations for ${waypoint.id} unavailable`, error instanceof Error ? error.message : error);
        }
      }),
  );
  return medians;
}

/** FIRMS fires around every corridor, deduplicated by position. */
async function corridorFires() {
  const results = await Promise.all(CORRIDORS.map((corridor) => getFiresInBounds(corridorBounds(corridor))));
  const seen = new Set<string>();
  const fires: FireHotspot[] = [];
  for (const result of results) {
    for (const fire of result.fires) {
      const key = `${fire.lat.toFixed(3)},${fire.lng.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fires.push(fire);
    }
  }
  const errors = results.map((result) => result.error).filter(Boolean);
  return {
    fires,
    truncated: results.some((result) => result.truncated),
    error: errors.length === results.length && errors.length > 0 ? String(errors[0]) : null,
  };
}

async function compute(): Promise<CorridorsResult> {
  const waypoints = uniqueWaypoints();
  const computedAt = new Date().toISOString();
  const sources = [
    "CAMS forecast via Open-Meteo Air Quality",
    "Open-Meteo wind and boundary-layer height",
    "Live CPCB / state-board stations (monitored cities)",
    "NASA FIRMS via Earth Engine",
  ];

  let airQuality: Array<Record<string, Array<number | null>>>;
  let weather: Array<Record<string, Array<number | null>>>;
  try {
    [airQuality, weather] = await Promise.all([
      fetchHourly(AIR_QUALITY_ENDPOINT, waypoints, ["pm2_5", "pm10"]),
      fetchHourly(
        WEATHER_ENDPOINT,
        waypoints,
        ["wind_speed_10m", "boundary_layer_height", "wind_speed_120m", "wind_direction_120m", "wind_direction_10m"],
        { wind_speed_unit: "ms" },
      ),
    ]);
  } catch (error) {
    return {
      computedAt,
      corridors: [],
      sources,
      fires: { considered: 0, truncated: false, error: null },
      error: `Forecast unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const [stations, fireData] = await Promise.all([stationMedians(waypoints), corridorFires()]);

  // Every waypoint samples the wind field, so trajectories along a
  // corridor are interpolated between its own nodes.
  const field: WindStation[] = waypoints.map((waypoint, index) => {
    const series = weather[index];
    return {
      lat: waypoint.lat,
      lng: waypoint.lng,
      hours: Array.from({ length: MAX_TRANSPORT_HOURS }, (_, hour) => ({
        speedMs: series.wind_speed_120m?.[hour] ?? series.wind_speed_10m?.[hour] ?? NaN,
        fromDeg: series.wind_direction_120m?.[hour] ?? series.wind_direction_10m?.[hour] ?? NaN,
      })),
    };
  });

  const outlooks = new Map<string, WaypointOutlook | null>();
  waypoints.forEach((waypoint, index) => {
    const target = { center: { lat: waypoint.lat, lng: waypoint.lng } };
    let firePixels = 0;
    let sources = 0;
    let etaHours = Infinity;
    for (const cluster of clusterFiresAround(fireData.fires, target)) {
      const trajectory = traceTrajectory(cluster, target, field, 36);
      if (trajectory.arrivalHours === null) continue;
      firePixels += cluster.fireCount;
      sources += 1;
      etaHours = Math.min(etaHours, trajectory.arrivalHours);
    }
    const smoke: WaypointInputs["smoke"] = sources > 0 ? { firePixels, etaHours, sources } : null;
    const station = stations.get(waypoint.id);
    outlooks.set(
      waypoint.id,
      computeOutlook({
        pm25: airQuality[index].pm2_5 ?? [],
        pm10: airQuality[index].pm10 ?? [],
        windSpeedMs: weather[index].wind_speed_10m ?? [],
        boundaryLayerM: weather[index].boundary_layer_height ?? [],
        stationPm25: station?.pm25 ?? null,
        stationCount: station?.count ?? 0,
        smoke,
      }),
    );
  });

  return {
    computedAt,
    corridors: CORRIDORS.map((corridor) => buildCorridorOutlook(corridor, outlooks)),
    sources,
    fires: { considered: fireData.fires.length, truncated: fireData.truncated, error: fireData.error },
  };
}

async function readStored(): Promise<CorridorsResult | null> {
  try {
    const data = (await adminDb.collection("corridors").doc("latest").get()).data() as
      | { computedAt?: string; json?: string; version?: number }
      | undefined;
    if (data?.version !== STORED_VERSION || !data.computedAt || !data.json) return null;
    if (Date.now() - Date.parse(data.computedAt) > STORED_MAX_AGE_MS) return null;
    return JSON.parse(data.json) as CorridorsResult;
  } catch {
    return null;
  }
}

async function store(result: CorridorsResult) {
  if (result.error) return;
  // Hourly series are nested arrays, which Firestore can't store directly.
  await adminDb
    .collection("corridors")
    .doc("latest")
    .set({ version: STORED_VERSION, computedAt: result.computedAt, json: JSON.stringify(result), at: adminServerTimestamp() })
    .catch((error) => console.warn("Could not store corridor outlook", error instanceof Error ? error.message : error));
}

/** 48-h air-quality outlook for every corridor. */
export async function getCorridorOutlook(options: { refresh?: boolean } = {}): Promise<CorridorsResult> {
  if (!options.refresh && memory && memory.expiresAt > Date.now()) return memory.value;
  inFlight ??= (async () => {
    const stored = options.refresh ? null : await readStored();
    if (stored) return stored;
    const fresh = await compute();
    await store(fresh);
    return fresh;
  })().finally(() => {
    inFlight = null;
  });
  const value = await inFlight;
  if (!value.error) memory = { expiresAt: Date.now() + MEMORY_TTL_MS, value };
  return value;
}
