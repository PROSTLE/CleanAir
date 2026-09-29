import "server-only";

import type { CityConfig } from "@/lib/cities";
import { isInCity } from "@/lib/cities";
import type { StationReading } from "@/lib/stations";
import { applyLatest, isRecent, openAqPollutant, type OpenAqLatest, type OpenAqLocation } from "@/lib/openaqParse";

// OpenAQ v3: an open archive of government and low-cost monitors worldwide,
// including CPCB and the state pollution control boards. Station names and
// coordinates come straight from its /locations listing, so nothing about a
// monitor's position is typed into this repo. Free key from
// https://explore.openaq.org (Account → API key); data is CC BY 4.0 unless a
// location's licence says otherwise, credited to the owning agency.
const ENDPOINT = "https://api.openaq.org/v3";
const CACHE_TTL_MS = 20 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12_000;
const BOUNDS_PAD_DEG = 0.1;
// Latest values are one request per location, so cap how many a city costs.
const MAX_LIVE_LOCATIONS_PER_CITY = 40;
const MAX_STALE_LOCATIONS_PER_CITY = 40;
// Low-cost sensors only top up cities with fewer reference monitors than this.
const MIN_REFERENCE_MONITORS = 8;
// Free keys allow 60 requests a minute; stay under it across every city.
const REQUESTS_PER_MINUTE = 50;
const LATEST_CONCURRENCY = 4;

type ListResponse<T> = { results?: T[] };

const cache = new Map<string, { expiresAt: number; stations: StationReading[] }>();
const inFlight = new Map<string, Promise<StationReading[]>>();
const requestTimes: number[] = [];

function apiKey() {
  return process.env.OPENAQ_API_KEY?.trim() || null;
}

export function isOpenAqConfigured() {
  return apiKey() !== null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until one more request fits in the per-minute budget. */
async function takeRequestSlot() {
  for (;;) {
    const now = Date.now();
    while (requestTimes.length && now - requestTimes[0] >= 60_000) requestTimes.shift();
    if (requestTimes.length < REQUESTS_PER_MINUTE) {
      requestTimes.push(now);
      return;
    }
    await sleep(60_000 - (now - requestTimes[0]) + 50);
  }
}

async function getJson<T>(path: string): Promise<T> {
  const key = apiKey();
  if (!key) throw new Error("OPENAQ_API_KEY is not set.");
  await takeRequestSlot();
  const response = await fetch(`${ENDPOINT}${path}`, {
    headers: { "X-API-Key": key, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`OpenAQ request failed (${response.status}).`);
  return (await response.json()) as T;
}

function measuresPm(location: OpenAqLocation) {
  return (location.sensors ?? []).some((sensor) => {
    const pollutant = openAqPollutant(sensor.parameter);
    return pollutant?.key === "pm25" || pollutant?.key === "pm10";
  });
}

function lastSeenMs(location: OpenAqLocation) {
  const value = location.datetimeLast?.utc ? Date.parse(location.datetimeLast.utc) : NaN;
  return Number.isFinite(value) ? value : null;
}

function attributionOf(location: OpenAqLocation) {
  const owner = location.owner?.name?.trim();
  const provider = location.provider?.name?.trim();
  if (owner && provider && owner !== provider) return `${owner} (${provider})`;
  return owner || provider || null;
}

function baseStation(location: OpenAqLocation): StationReading {
  return {
    stationName: location.name?.trim() || location.locality?.trim() || `OpenAQ location ${location.id}`,
    lat: location.coordinates?.latitude as number,
    lng: location.coordinates?.longitude as number,
    distanceKm: 0,
    pm25: null,
    pm10: null,
    no2: null,
    so2: null,
    co: null,
    nh3: null,
    ozone: null,
    lastUpdated: location.datetimeLast?.utc ?? null,
    source: "OpenAQ",
    attribution: attributionOf(location),
    stale: !isRecent(lastSeenMs(location)),
  };
}

async function loadCityStations(city: CityConfig): Promise<StationReading[]> {
  const { minLat, maxLat, minLng, maxLng } = city.bounds;
  const bbox = [minLng - BOUNDS_PAD_DEG, minLat - BOUNDS_PAD_DEG, maxLng + BOUNDS_PAD_DEG, maxLat + BOUNDS_PAD_DEG]
    .map((value) => value.toFixed(4))
    .join(",");
  const listing = await getJson<ListResponse<OpenAqLocation>>(`/locations?bbox=${bbox}&limit=1000`);
  if (!Array.isArray(listing.results)) throw new Error("OpenAQ location list failed.");

  const usable = listing.results.filter(
    (location) =>
      typeof location.id === "number" &&
      !location.isMobile &&
      typeof location.coordinates?.latitude === "number" &&
      typeof location.coordinates?.longitude === "number" &&
      measuresPm(location),
  );
  const inside = (location: OpenAqLocation) =>
    isInCity(city, location.coordinates?.latitude as number, location.coordinates?.longitude as number);
  const newestFirst = (a: OpenAqLocation, b: OpenAqLocation) => (lastSeenMs(b) ?? 0) - (lastSeenMs(a) ?? 0);

  // Reference monitors (CPCB and state boards) first; low-cost sensors only
  // top up cities where fewer than MIN_REFERENCE_MONITORS monitors report.
  const live = usable.filter((location) => isRecent(lastSeenMs(location))).sort(newestFirst);
  const liveMonitors = live.filter((location) => location.isMonitor);
  const liveSensors = liveMonitors.filter(inside).length < MIN_REFERENCE_MONITORS ? live.filter((location) => !location.isMonitor) : [];
  const liveCandidates = [
    ...liveMonitors.filter(inside),
    ...liveSensors.filter(inside),
    ...liveMonitors.filter((location) => !inside(location)),
    ...liveSensors.filter((location) => !inside(location)),
  ].slice(0, MAX_LIVE_LOCATIONS_PER_CITY);

  // Monitors that stopped reporting are still listed, with the date of their
  // last reading and no values, so the map shows where coverage has gone dark.
  const staleMonitors = usable
    .filter((location) => location.isMonitor && !isRecent(lastSeenMs(location)) && inside(location))
    .sort(newestFirst)
    .slice(0, MAX_STALE_LOCATIONS_PER_CITY)
    .map(baseStation);

  const stations: StationReading[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(LATEST_CONCURRENCY, liveCandidates.length) }, async () => {
      while (next < liveCandidates.length) {
        const location = liveCandidates[next];
        next += 1;
        try {
          const latest = await getJson<ListResponse<OpenAqLatest>>(`/locations/${location.id}/latest?limit=100`);
          stations.push(applyLatest(baseStation(location), location, latest.results ?? []));
        } catch (error) {
          console.warn(`OpenAQ latest for location ${location.id} failed`, error instanceof Error ? error.message : error);
        }
      }
    }),
  );
  return [...stations, ...staleMonitors];
}

/**
 * OpenAQ stations in and just around the city, cached for 20 minutes. Live
 * stations carry values from the last day; `stale` ones carry only the date
 * they last reported.
 */
export async function fetchOpenAqStations(city: CityConfig): Promise<StationReading[]> {
  const hit = cache.get(city.id);
  if (hit && hit.expiresAt > Date.now()) return hit.stations;
  if (!isOpenAqConfigured()) return [];

  let pending = inFlight.get(city.id);
  if (!pending) {
    pending = loadCityStations(city).finally(() => inFlight.delete(city.id));
    inFlight.set(city.id, pending);
  }
  const stations = await pending;
  // An empty result is usually a transient failure; don't pin it for 20 minutes.
  if (stations.length > 0) cache.set(city.id, { expiresAt: Date.now() + CACHE_TTL_MS, stations });
  return stations;
}
