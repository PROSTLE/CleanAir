import "server-only";

import type { CityConfig } from "@/lib/cities";
import { isInCity } from "@/lib/cities";
import type { StationReading } from "@/lib/stations";
import { SENSOR_READING_MAX_AGE_HOURS } from "@/lib/supportEvidence";
import { PM10_BREAKPOINTS, PM25_BREAKPOINTS, usAqiToConcentration } from "@/lib/usAqi";

// World Air Quality Index (WAQI): relays CPCB, state-board and other
// agency stations with the coordinates each agency publishes. Token from
// https://aqicn.org/data-platform/token/ ; free for non-commercial use, with
// attribution to WAQI and the originating agency.
//
// WAQI publishes per-pollutant *US EPA AQI sub-indices*, not concentrations.
// PM2.5 and PM10 are converted back to µg/m³ with the EPA breakpoints WAQI
// documents (the 2012 PM2.5 scale). Gas sub-indices are left out: their
// averaging periods and units vary by source, so no honest µg/m³ value can
// be recovered from them.
const ENDPOINT = "https://api.waqi.info";
const CACHE_TTL_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_STATIONS_PER_CITY = 60;
const MIN_OFFICIAL_STATIONS = 8;
const FEED_CONCURRENCY = 6;
const BOUNDS_PAD_DEG = 0.1;

type BoundsResponse = {
  status?: string;
  data?: Array<{ lat?: number; lon?: number; uid?: number; aqi?: string | number; station?: { name?: string } }> | string;
};

type FeedResponse = {
  status?: string;
  data?:
    | {
        aqi?: number | string;
        dominentpol?: string;
        attributions?: Array<{ name?: string }>;
        city?: { name?: string; geo?: [number, number] };
        iaqi?: Record<string, { v?: number }>;
        time?: { iso?: string };
      }
    | string;
};

const cache = new Map<string, { expiresAt: number; stations: StationReading[] }>();
const inFlight = new Map<string, Promise<StationReading[]>>();

function token() {
  return process.env.WAQI_API_TOKEN?.trim() || null;
}

export function isWaqiConfigured() {
  return token() !== null;
}

async function getJson<T>(path: string): Promise<T> {
  const key = token();
  if (!key) throw new Error("WAQI_API_TOKEN is not set.");
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetch(`${ENDPOINT}${path}${separator}token=${encodeURIComponent(key)}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`WAQI request failed (${response.status}).`);
  return (await response.json()) as T;
}

async function fetchStation(uid: number, fallbackName: string): Promise<StationReading | null> {
  const payload = await getJson<FeedResponse>(`/feed/@${uid}/`);
  if (payload.status !== "ok" || !payload.data || typeof payload.data === "string") return null;
  const data = payload.data;
  const [lat, lng] = data.city?.geo ?? [];
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  const updatedMs = data.time?.iso ? Date.parse(data.time.iso) : NaN;
  if (!Number.isFinite(updatedMs)) return null;
  // WAQI keeps listing stations that stopped reporting. Those keep their
  // position and last-reported time, but no values: never shown as live.
  const stale = Date.now() - updatedMs > SENSOR_READING_MAX_AGE_HOURS * 3_600_000;
  const pm25 = stale ? null : usAqiToConcentration(data.iaqi?.pm25?.v, PM25_BREAKPOINTS);
  const pm10 = stale ? null : usAqiToConcentration(data.iaqi?.pm10?.v, PM10_BREAKPOINTS);
  if (!stale && pm25 === null && pm10 === null) return null;
  const agency = data.attributions
    ?.map((item) => item.name?.trim())
    .find((name) => name && !/world air quality index/i.test(name));

  return {
    stationName: data.city?.name?.trim() || fallbackName,
    lat,
    lng,
    distanceKm: 0,
    pm25,
    pm10,
    no2: null,
    so2: null,
    co: null,
    nh3: null,
    ozone: null,
    lastUpdated: data.time?.iso ?? null,
    // WAQI's own overall AQI (US EPA, all pollutants it measures), kept as published.
    aqi: !stale && Number.isFinite(Number(data.aqi)) ? Number(data.aqi) : null,
    dominantPollutant: !stale ? (data.dominentpol?.trim() || null) : null,
    source: "WAQI",
    attribution: agency ?? null,
    stale,
  };
}

async function loadCityStations(city: CityConfig): Promise<StationReading[]> {
  const { minLat, maxLat, minLng, maxLng } = city.bounds;
  const latlng = [minLat - BOUNDS_PAD_DEG, minLng - BOUNDS_PAD_DEG, maxLat + BOUNDS_PAD_DEG, maxLng + BOUNDS_PAD_DEG]
    .map((value) => value.toFixed(4))
    .join(",");
  const list = async (networks: "official" | "all") => {
    const listing = await getJson<BoundsResponse>(`/v2/map/bounds?latlng=${latlng}&networks=${networks}`);
    if (listing.status !== "ok" || !Array.isArray(listing.data)) {
      throw new Error(`WAQI station list failed: ${typeof listing.data === "string" ? listing.data : "no data"}`);
    }
    // "-" marks a station with no current reading.
    return listing.data.filter((item) => typeof item.uid === "number" && Number.isFinite(Number(item.aqi)));
  };

  // Government stations first; citizen low-cost sensors only top up cities
  // where the official network is thin.
  const official = await list("official");
  const officialInside = official.filter((item) => isInCity(city, Number(item.lat), Number(item.lon))).length;
  const extra =
    officialInside < MIN_OFFICIAL_STATIONS
      ? (await list("all")).filter((item) => !official.some((station) => station.uid === item.uid))
      : [];

  // Stations just outside the boundary still count for nearby-station
  // lookups; the city filter is applied by callers that need it.
  const inside = (item: (typeof official)[number]) => isInCity(city, Number(item.lat), Number(item.lon));
  const candidates = [
    ...official.filter(inside),
    ...extra.filter(inside),
    ...official.filter((item) => !inside(item)),
    ...extra.filter((item) => !inside(item)),
  ].slice(0, MAX_STATIONS_PER_CITY);

  const stations: StationReading[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(FEED_CONCURRENCY, candidates.length) }, async () => {
      while (next < candidates.length) {
        const candidate = candidates[next];
        next += 1;
        try {
          const station = await fetchStation(candidate.uid as number, candidate.station?.name ?? `WAQI station ${candidate.uid}`);
          if (station) stations.push(station);
        } catch (error) {
          console.warn(`WAQI feed @${candidate.uid} failed`, error instanceof Error ? error.message : error);
        }
      }
    }),
  );
  return stations;
}

/** Every WAQI station in and just around the city, cached for 15 minutes. */
export async function fetchWaqiStations(city: CityConfig): Promise<StationReading[]> {
  const hit = cache.get(city.id);
  if (hit && hit.expiresAt > Date.now()) return hit.stations;
  if (!isWaqiConfigured()) return [];

  let pending = inFlight.get(city.id);
  if (!pending) {
    pending = loadCityStations(city).finally(() => inFlight.delete(city.id));
    inFlight.set(city.id, pending);
  }
  const stations = await pending;
  // An empty result is usually a transient failure; don't pin it for 15 minutes.
  if (stations.length > 0) cache.set(city.id, { expiresAt: Date.now() + CACHE_TTL_MS, stations });
  return stations;
}
