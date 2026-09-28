import "server-only";

import { CITIES, isInCity, resolveCityForPoint, type CityConfig } from "@/lib/cities";
import { fetchCpcbStations } from "@/lib/cpcbSensor";
import { haversineKm } from "@/lib/geo";
import { fetchWaqiStations } from "@/lib/server/waqi";

// One station interface over every city's ground network: CPCB for Delhi,
// WAQI for the other capitals (see lib/cities.ts). Values are µg/m³; a
// pollutant the network doesn't report is null, never estimated.
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
  source: "CPCB" | "WAQI";
  /** Agency that operates the station, when the feed names it. */
  attribution: string | null;
};

type Standards = CityConfig["standards"];

function hasUsablePollutantData(station: StationReading) {
  return [station.pm25, station.pm10, station.no2, station.so2, station.co, station.nh3, station.ozone].some(
    (value) => value !== null,
  );
}

async function fetchNetworkStations(city: CityConfig): Promise<StationReading[]> {
  try {
    return city.stations.provider === "cpcb" ? await fetchCpcbStations() : await fetchWaqiStations(city);
  } catch (error) {
    console.warn(`Station feed for ${city.name} failed`, error instanceof Error ? error.message : error);
    return [];
  }
}

/** Stations inside the city boundary that report at least one pollutant. */
export async function fetchCityStationReadings(city: CityConfig): Promise<StationReading[]> {
  return (await fetchNetworkStations(city)).filter(
    (station) => hasUsablePollutantData(station) && isInCity(city, station.lat, station.lng),
  );
}

/** Every monitored city's stations, tagged with the city they belong to. */
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
