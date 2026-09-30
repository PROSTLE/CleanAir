import "server-only";

import { CITIES, isInCity, resolveCityForPoint, type CityConfig, type StationSource } from "@/lib/cities";
import { fetchCpcbStations } from "@/lib/cpcbSensor";
import { haversineKm } from "@/lib/geo";
import { fetchOpenAqStations } from "@/lib/server/openaq";
import { fetchWaqiStations } from "@/lib/server/waqi";
import type { StationFeed } from "@/lib/stationFeeds";
import { adminDb, adminServerTimestamp } from "@/lib/firebaseAdmin";
import { hasUsablePollutantData, mergeStationFeeds } from "@/lib/stationMerge";
import { isSensorReadingFresh } from "@/lib/supportEvidence";

// One station interface over every public feed: OpenAQ, WAQI and CPCB via
// data.gov.in, merged per city (see lib/cities.ts). Names and coordinates
// always come from the feeds. Values are µg/m³ (CO in mg/m³); a pollutant
// the feed doesn't report is null, never estimated.
export type StationReading = {
  stationName: string;
  lat: number;
  lng: number;
  distanceKm: number;
  pm25: number | null;
  pm10: number | null;
  no2: number | null;
  so2: number | null;
  co: number | null;
  nh3: number | null;
  ozone: number | null;
  lastUpdated: string | null;
  /**
   * The feed's own overall AQI for the station (US EPA scale, every pollutant
   * it measures), when the feed publishes one (WAQI). Null otherwise.
   */
  aqi: number | null;
  /** The pollutant driving that AQI, as the feed names it (pm25, o3, ...). */
  dominantPollutant: string | null;
  source: StationFeed;
  /** Agency that operates the station, when the feed names it. */
  attribution: string | null;
  /**
   * The monitor exists but hasn't reported in the last day. Stale stations
   * carry their position and last-reported time only, and are left out of
   * every reading used for evidence, alerts, forecasts and BigQuery.
   */
  stale: boolean;
};

type Standards = CityConfig["standards"];


// One slow feed (data.gov.in hangs rather than failing) must not hold up the
// others. A feed that misses its budget keeps loading in the background and
// fills its cache, so the next request gets it.
const FEEDS: Record<
  StationSource,
  { label: StationFeed; timeoutMs: number; fetch: (city: CityConfig) => Promise<StationReading[]> }
> = {
  openaq: { label: "OpenAQ", timeoutMs: 30_000, fetch: fetchOpenAqStations },
  waqi: { label: "WAQI", timeoutMs: 20_000, fetch: fetchWaqiStations },
  cpcb: {
    label: "CPCB",
    timeoutMs: 10_000,
    fetch: async (city) => (await fetchCpcbStations()).filter((station) => nearCity(city, station)),
  },
};

// The CPCB feed is national; keep what's in or just around the city (the
// same margin the other feeds query with) before merging.
const NEAR_CITY_PAD_DEG = 0.1;
function nearCity(city: CityConfig, station: StationReading) {
  const { minLat, maxLat, minLng, maxLng } = city.bounds;
  return (
    station.lat >= minLat - NEAR_CITY_PAD_DEG &&
    station.lat <= maxLat + NEAR_CITY_PAD_DEG &&
    station.lng >= minLng - NEAR_CITY_PAD_DEG &&
    station.lng <= maxLng + NEAR_CITY_PAD_DEG
  );
}

async function fetchFeed(city: CityConfig, source: StationSource): Promise<StationReading[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      FEEDS[source].fetch(city),
      new Promise<StationReading[]>((_, reject) => {
        const { timeoutMs } = FEEDS[source];
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs / 1000} s`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    console.warn(`${FEEDS[source].label} stations for ${city.name} failed`, error instanceof Error ? error.message : error);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// A freshly started server has cold feed caches, and the feeds can take tens
// of seconds to answer; a report checked in that window used to find "no
// station". So every live fetch also stores the merged list in Firestore
// (`stationSnapshots/{cityId}`), and a cold server answers from that snapshot
// while it refreshes the feeds in the background. Readings keep their own
// timestamps, so a snapshot never makes an old reading look live.
const MERGED_TTL_MS = 10 * 60 * 1000;
const SNAPSHOT_MAX_AGE_MS = 90 * 60 * 1000;
const SNAPSHOT_SAVE_INTERVAL_MS = 10 * 60 * 1000;
const merged = new Map<string, { expiresAt: number; stations: StationReading[] }>();
const refreshing = new Map<string, Promise<StationReading[]>>();
const lastSnapshotSave = new Map<string, number>();

type FetchOptions = {
  /** Wait for the feeds themselves (scheduled ingest and scans), not a stored snapshot. */
  preferLive?: boolean;
};

function refreshStale(station: StationReading): StationReading {
  if (station.stale || isSensorReadingFresh(station.lastUpdated)) return station;
  return { ...station, stale: true, pm25: null, pm10: null, no2: null, so2: null, co: null, nh3: null, ozone: null, aqi: null, dominantPollutant: null };
}

async function saveSnapshot(city: CityConfig, stations: StationReading[]) {
  const now = Date.now();
  if (now - (lastSnapshotSave.get(city.id) ?? 0) < SNAPSHOT_SAVE_INTERVAL_MS) return;
  lastSnapshotSave.set(city.id, now);
  await adminDb
    .collection("stationSnapshots")
    .doc(city.id)
    .set({ savedAt: adminServerTimestamp(), stations })
    .catch((error) => console.warn(`Station snapshot for ${city.name} not saved`, error instanceof Error ? error.message : error));
}

async function readSnapshot(city: CityConfig): Promise<StationReading[] | null> {
  const doc = await adminDb.collection("stationSnapshots").doc(city.id).get();
  const data = doc.data();
  const savedAt = data?.savedAt?.toDate?.()?.getTime?.() ?? 0;
  if (!Array.isArray(data?.stations) || Date.now() - savedAt > SNAPSHOT_MAX_AGE_MS) return null;
  return (data.stations as StationReading[]).map(refreshStale);
}

function refreshLive(city: CityConfig): Promise<StationReading[]> {
  let pending = refreshing.get(city.id);
  if (!pending) {
    pending = (async () => {
      const feeds = await Promise.all(city.stations.sources.map((source) => fetchFeed(city, source)));
      const stations = mergeStationFeeds(feeds);
      if (stations.length > 0) {
        merged.set(city.id, { expiresAt: Date.now() + MERGED_TTL_MS, stations });
        await saveSnapshot(city, stations);
      }
      return stations;
    })().finally(() => refreshing.delete(city.id));
    refreshing.set(city.id, pending);
  }
  return pending;
}

async function fetchNetworkStations(city: CityConfig, options: FetchOptions = {}): Promise<StationReading[]> {
  const hit = merged.get(city.id);
  if (hit && hit.expiresAt > Date.now() && !options.preferLive) return hit.stations;
  const live = refreshLive(city);
  if (!options.preferLive) {
    const snapshot = await readSnapshot(city).catch(() => null);
    if (snapshot) {
      live.catch(() => undefined); // keeps refreshing the cache in the background
      return snapshot;
    }
  }
  const stations = await live;
  if (stations.length > 0 || !options.preferLive) return stations;
  // Every feed failed: a recent snapshot is still real data.
  return (await readSnapshot(city).catch(() => null)) ?? [];
}

/** Every known monitor inside the city, live or stale, for maps and zone pickers. */
export async function fetchCityStationDirectory(city: CityConfig, options: FetchOptions = {}): Promise<StationReading[]> {
  return (await fetchNetworkStations(city, options)).filter((station) => isInCity(city, station.lat, station.lng));
}

/** Stations inside the city boundary with a reading from the last day. */
export async function fetchCityStationReadings(city: CityConfig, options: FetchOptions = {}): Promise<StationReading[]> {
  return (await fetchCityStationDirectory(city, options)).filter((station) => !station.stale);
}

/** Every monitored city's live stations, tagged with the city they belong to. */
export async function fetchAllCityStationReadings(options: FetchOptions = {}) {
  const perCity = await Promise.all(
    CITIES.map(async (city) =>
      (await fetchCityStationReadings(city, options)).map((station) => ({ ...station, cityId: city.id })),
    ),
  );
  return perCity.flat();
}

export async function fetchNearbyStations(lat: number, lng: number, radiusKm = 10): Promise<StationReading[]> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
  const city = resolveCityForPoint(lat, lng);
  if (!city) return [];
  return (await fetchNetworkStations(city))
    .filter((station) => !station.stale)
    .map((station) => ({
      ...station,
      distanceKm: Number(haversineKm(lat, lng, station.lat, station.lng).toFixed(2)),
    }))
    .filter((station) => station.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

// Stations going offline or reporting all-null is common, so this picks the
// nearest station that actually has data, not merely the nearest station.
export async function getNearestStationReading(lat: number, lng: number) {
  const stations = await fetchNearbyStations(lat, lng);
  return stations.find(hasUsablePollutantData) ?? null;
}

/** National 24-hour standards for the city covering this point (India's by default). */
export function standardsForPoint(lat: number, lng: number): Standards {
  return (resolveCityForPoint(lat, lng) ?? CITIES[0]).standards;
}

function deltaPct(value: number, reference: number) {
  return Math.round(((value - reference) / reference) * 100);
}

export function getPm25DeltaFromReference(pm25: number | null, standards: Standards) {
  if (pm25 === null) return 0;
  return deltaPct(pm25, standards.pm25);
}

/**
 * Picks the pollutant that matters for a hazard and how far it sits above
 * the national 24-hour standard: dust → PM10, industrial → NO2/SO2 where the
 * network reports them, everything else → PM2.5.
 */
export function getPrimaryPollutant(
  classificationType: string | undefined,
  station: Partial<StationReading> | null,
  standards: Standards,
) {
  if (!station) return { name: "PM2.5", value: null, delta: 0 };

  if (classificationType === "dust" && station.pm10 != null) {
    return { name: "PM10", value: station.pm10, delta: deltaPct(station.pm10, standards.pm10) };
  }

  // If PM2.5 is unavailable, PM10 can still establish a particulate event,
  // but it cannot honestly distinguish dust from general coarse particulate.
  if (classificationType === "particulate" && station.pm25 == null && station.pm10 != null) {
    return { name: "PM10", value: station.pm10, delta: deltaPct(station.pm10, standards.pm10) };
  }

  if (classificationType === "industrial") {
    const no2Delta = station.no2 != null && standards.no2 ? deltaPct(station.no2, standards.no2) : null;
    const so2Delta = station.so2 != null && standards.so2 ? deltaPct(station.so2, standards.so2) : null;
    if (no2Delta !== null && (so2Delta === null || no2Delta >= so2Delta)) {
      return { name: "NO2", value: station.no2 ?? null, delta: no2Delta };
    }
    if (so2Delta !== null) return { name: "SO2", value: station.so2 ?? null, delta: so2Delta };
  }

  return {
    name: "PM2.5",
    value: station.pm25 ?? null,
    delta: station.pm25 != null ? deltaPct(station.pm25, standards.pm25) : 0,
  };
}
