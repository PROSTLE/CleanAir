import "server-only";

import { CITIES, isInCity, resolveCityForPoint, type CityConfig, type StationSource } from "@/lib/cities";
import { fetchCpcbStations } from "@/lib/cpcbSensor";
import { haversineKm } from "@/lib/geo";
import { fetchOpenAqStations } from "@/lib/server/openaq";
import { fetchWaqiStations } from "@/lib/server/waqi";
import type { StationFeed } from "@/lib/stationFeeds";
import { hasUsablePollutantData, mergeStationFeeds } from "@/lib/stationMerge";

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

async function fetchNetworkStations(city: CityConfig): Promise<StationReading[]> {
  const feeds = await Promise.all(city.stations.sources.map((source) => fetchFeed(city, source)));
  return mergeStationFeeds(feeds);
}

/** Every known monitor inside the city, live or stale, for maps and zone pickers. */
export async function fetchCityStationDirectory(city: CityConfig): Promise<StationReading[]> {
  return (await fetchNetworkStations(city)).filter((station) => isInCity(city, station.lat, station.lng));
}

/** Stations inside the city boundary with a reading from the last day. */
export async function fetchCityStationReadings(city: CityConfig): Promise<StationReading[]> {
  return (await fetchCityStationDirectory(city)).filter((station) => !station.stale);
}

/** Every monitored city's live stations, tagged with the city they belong to. */
export async function fetchAllCityStationReadings() {
  const perCity = await Promise.all(
    CITIES.map(async (city) => (await fetchCityStationReadings(city)).map((station) => ({ ...station, cityId: city.id }))),
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
