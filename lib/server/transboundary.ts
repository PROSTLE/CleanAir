import "server-only";

import { CITIES, getCity, type CityConfig } from "@/lib/cities";
import { getFiresInBounds } from "@/lib/earthEngineSatellite";
import { adminDb, adminServerTimestamp } from "@/lib/firebaseAdmin";
import {
  MAX_TRANSPORT_HOURS,
  buildAdvisories,
  clusterFires,
  sourceBounds,
  type FireCluster,
  type SourcePlace,
  type TransboundaryAdvisory,
  type WindStation,
} from "@/lib/transboundary";

// Wiring for lib/transboundary.ts: FIRMS fires (Earth Engine), hourly
// forecast wind (Open-Meteo) and place names (OpenStreetMap Nominatim).
// The latest result per city is stored in Firestore `transboundary/<cityId>`
// by the cron tick, so every instance serves the same advisories.

const OPEN_METEO_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = "VayuSetu/1.0 (air-quality hotspot research)";
/** City centre plus this many of the largest clusters sample the wind field. */
const MAX_WIND_POINTS = 24;
/** Only the top advisories are named; the rest keep their coordinates. */
const MAX_NAMED_SOURCES = 8;
const MEMORY_TTL_MS = 30 * 60 * 1000;
const STORED_MAX_AGE_MS = 90 * 60 * 1000;
const NOMINATIM_SPACING_MS = 1100;
const FETCH_TIMEOUT_MS = 15_000;

export type TransboundaryResult = {
  cityId: string;
  cityName: string;
  computedAt: string;
  advisories: TransboundaryAdvisory[];
  clustersConsidered: number;
  firesConsidered: number;
  firesTruncated: boolean;
  fireWindow: { start: string; end: string } | null;
  /** Which forecast wind level drove the trajectories. */
  windLevel: "120m" | "10m" | "mixed" | null;
  sources: string[];
  error?: string;
};

const memory = new Map<string, { expiresAt: number; value: TransboundaryResult }>();
const inFlight = new Map<string, Promise<TransboundaryResult>>();
const placeCache = new Map<string, SourcePlace>();
let nominatimQueue: Promise<unknown> = Promise.resolve();

async function fetchJson(url: URL, init?: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url.host} responded ${response.status}`);
  return response.json() as Promise<unknown>;
}

type OpenMeteoHourly = {
  hourly?: {
    time?: string[];
    wind_speed_10m?: Array<number | null>;
    wind_direction_10m?: Array<number | null>;
    wind_speed_120m?: Array<number | null>;
    wind_direction_120m?: Array<number | null>;
  };
};

/**
 * Hourly wind for the next 48 h at each point, in one Open-Meteo call.
 * 120 m wind is used where the model provides it (closer to the layer smoke
 * travels in than surface wind); otherwise 10 m.
 */
async function fetchWindField(points: Array<{ lat: number; lng: number }>) {
  const url = new URL(OPEN_METEO_ENDPOINT);
  url.searchParams.set("latitude", points.map((point) => point.lat.toFixed(3)).join(","));
  url.searchParams.set("longitude", points.map((point) => point.lng.toFixed(3)).join(","));
  url.searchParams.set("hourly", "wind_speed_10m,wind_direction_10m,wind_speed_120m,wind_direction_120m");
  url.searchParams.set("wind_speed_unit", "ms");
  url.searchParams.set("timezone", "GMT");
  url.searchParams.set("forecast_days", "3");
  const payload = await fetchJson(url);
  const locations = (Array.isArray(payload) ? payload : [payload]) as OpenMeteoHourly[];
  const currentHour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  let used120 = 0;
  let used10 = 0;

  const field: WindStation[] = locations.map((location, index) => {
    const hourly = location.hourly ?? {};
    const times = hourly.time ?? [];
    const first = Math.max(0, times.findIndex((time) => Date.parse(`${time}Z`) >= currentHour));
    const hours = [];
    for (let i = first; i < Math.min(times.length, first + MAX_TRANSPORT_HOURS); i += 1) {
      const speed120 = hourly.wind_speed_120m?.[i];
      const dir120 = hourly.wind_direction_120m?.[i];
      const speed10 = hourly.wind_speed_10m?.[i];
      const dir10 = hourly.wind_direction_10m?.[i];
      if (typeof speed120 === "number" && typeof dir120 === "number") {
        hours.push({ speedMs: speed120, fromDeg: dir120 });
        used120 += 1;
      } else if (typeof speed10 === "number" && typeof dir10 === "number") {
        hours.push({ speedMs: speed10, fromDeg: dir10 });
        used10 += 1;
      }
    }
    return { lat: points[index].lat, lng: points[index].lng, hours };
  });

  const level: TransboundaryResult["windLevel"] =
    used120 && used10 ? "mixed" : used120 ? "120m" : used10 ? "10m" : null;
  return { field: field.filter((station) => station.hours.length > 0), level };
}

type NominatimReverse = {
  address?: {
    state_district?: string;
    county?: string;
    city?: string;
    town?: string;
    state?: string;
    region?: string;
    country?: string;
  };
};

/** Reverse-geocodes one point, at most one request a second (Nominatim usage policy). */
function lookupPlace(cluster: FireCluster): Promise<SourcePlace> {
  const cached = placeCache.get(cluster.key);
  if (cached) return Promise.resolve(cached);

  const task = nominatimQueue.then(async () => {
    const again = placeCache.get(cluster.key);
    if (again) return again;
    const url = new URL(NOMINATIM_ENDPOINT);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", String(cluster.lat));
    url.searchParams.set("lon", String(cluster.lng));
    url.searchParams.set("zoom", "8");
    url.searchParams.set("accept-language", "en");
    try {
      const payload = (await fetchJson(url, { headers: { "User-Agent": USER_AGENT } })) as NominatimReverse;
      const address = payload.address ?? {};
      const place: SourcePlace = {
        district: address.state_district ?? address.county ?? address.city ?? address.town ?? null,
        state: address.state ?? address.region ?? null,
        country: address.country ?? null,
      };
      placeCache.set(cluster.key, place);
      return place;
    } catch (error) {
      console.warn("Nominatim lookup failed", error instanceof Error ? error.message : error);
      return { district: null, state: null, country: null };
    } finally {
      await new Promise((resolve) => setTimeout(resolve, NOMINATIM_SPACING_MS));
    }
  });
  nominatimQueue = task.catch(() => undefined);
  return task;
}

/** Fires across a border keep their country in the state name, e.g. "Punjab (Pakistan)". */
function withCountry(place: SourcePlace, city: CityConfig): SourcePlace {
  if (!place.state || !place.country || place.country === city.country) return place;
  return { ...place, state: `${place.state} (${place.country})` };
}

async function compute(city: CityConfig): Promise<TransboundaryResult> {
  const now = new Date();
  const base = {
    cityId: city.id,
    cityName: city.name,
    computedAt: now.toISOString(),
    sources: ["NASA FIRMS via Earth Engine", "Open-Meteo forecast wind", "OpenStreetMap Nominatim"],
  };

  const fires = await getFiresInBounds(sourceBounds(city));
  if (fires.error) {
    return {
      ...base,
      advisories: [],
      clustersConsidered: 0,
      firesConsidered: 0,
      firesTruncated: false,
      fireWindow: null,
      windLevel: null,
      error: `Fire data unavailable: ${fires.error}`,
    };
  }

  const clusters = clusterFires(fires.fires, city);
  const fireWindow = { start: fires.windowStart, end: fires.windowEnd };
  if (clusters.length === 0) {
    return {
      ...base,
      advisories: [],
      clustersConsidered: 0,
      firesConsidered: fires.fires.length,
      firesTruncated: fires.truncated,
      fireWindow,
      windLevel: null,
    };
  }

  let wind;
  try {
    wind = await fetchWindField([city.center, ...clusters.slice(0, MAX_WIND_POINTS)]);
  } catch (error) {
    return {
      ...base,
      advisories: [],
      clustersConsidered: clusters.length,
      firesConsidered: fires.fires.length,
      firesTruncated: fires.truncated,
      fireWindow,
      windLevel: null,
      error: `Forecast wind unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Trace first with no names, then name only the sources that matter.
  const unnamed = buildAdvisories({ city, clusters, field: wind.field, places: new Map(), cityState: city.region, now });
  const places = new Map<string, SourcePlace>();
  for (const advisory of unnamed.slice(0, MAX_NAMED_SOURCES)) {
    places.set(advisory.source.key, withCountry(await lookupPlace(advisory.source), city));
  }
  const advisories = buildAdvisories({ city, clusters, field: wind.field, places, cityState: city.region, now });

  return {
    ...base,
    advisories,
    clustersConsidered: clusters.length,
    firesConsidered: fires.fires.length,
    firesTruncated: fires.truncated,
    fireWindow,
    windLevel: wind.level,
  };
}

async function readStored(cityId: string): Promise<TransboundaryResult | null> {
  try {
    const snap = await adminDb.collection("transboundary").doc(cityId).get();
    const data = snap.data() as (TransboundaryResult & { advisoriesJson?: string }) | undefined;
    if (!data?.computedAt || Date.now() - Date.parse(data.computedAt) > STORED_MAX_AGE_MS) return null;
    const { advisoriesJson, ...rest } = data;
    // Paths are nested arrays, which Firestore can't store, so advisories are kept as JSON.
    return { ...rest, advisories: advisoriesJson ? (JSON.parse(advisoriesJson) as TransboundaryAdvisory[]) : [] };
  } catch {
    return null;
  }
}

async function store(result: TransboundaryResult) {
  if (result.error) return;
  const { advisories, ...rest } = result;
  await adminDb
    .collection("transboundary")
    .doc(result.cityId)
    .set({ ...rest, advisoriesJson: JSON.stringify(advisories), advisoryCount: advisories.length, at: adminServerTimestamp() })
    .catch((error) => console.warn("Could not store transboundary result", error instanceof Error ? error.message : error));
}

/** Current transboundary smoke advisories for one city. */
export async function getTransboundaryAdvisories(
  cityId: string,
  options: { refresh?: boolean } = {},
): Promise<TransboundaryResult> {
  const city = getCity(cityId);
  const hit = memory.get(city.id);
  if (!options.refresh && hit && hit.expiresAt > Date.now()) return hit.value;

  let pending = inFlight.get(city.id);
  if (!pending) {
    pending = (async () => {
      const stored = options.refresh ? null : await readStored(city.id);
      if (stored) return stored;
      const fresh = await compute(city);
      await store(fresh);
      return fresh;
    })().finally(() => inFlight.delete(city.id));
    inFlight.set(city.id, pending);
  }
  const value = await pending;
  if (!value.error) memory.set(city.id, { expiresAt: Date.now() + MEMORY_TTL_MS, value });
  return value;
}

export async function getAllTransboundaryAdvisories(options: { group?: CityConfig["group"]; refresh?: boolean } = {}) {
  const cities = options.group ? CITIES.filter((city) => city.group === options.group) : CITIES;
  return Promise.all(cities.map((city) => getTransboundaryAdvisories(city.id, { refresh: options.refresh })));
}
