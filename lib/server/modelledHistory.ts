import "server-only";

import { latLngToCell } from "h3-js";
import { CITIES, type CityConfig } from "@/lib/cities";
import { DELHI_H3_CELLS, type SensorReading } from "@/lib/forecastEngine";
import { H3_RESOLUTION } from "@/lib/geo";
import {
  ensureGoogleHistoryTable,
  insertGoogleHistory,
  MODELLED_SOURCE,
  queryGoogleHistory,
} from "@/lib/server/bigqueryLive";
import { getAirQualityHistory, isAirQualityConfigured } from "@/lib/server/googleAirQuality";
import { fetchCityStationDirectory } from "@/lib/stations";

// Modelled PM history for forecast zones whose ground station has not yet
// built up enough hourly readings in BigQuery (or whose feed is down).
// Source: Google Air Quality API history (lib/server/googleAirQuality.ts),
// stored in its own BigQuery table (`google_aq_history`) and always labelled
// as modelled, never as station data.

const HISTORY_HOURS = 72;
/** Re-fetch from Google when the newest stored hour is older than this. */
const REFRESH_AFTER_HOURS = 1.5;
/** One week per zone on backfill: a single history:lookup page. */
const BACKFILL_HOURS = 168;
const BACKFILL_CONCURRENCY = 4;

export { MODELLED_SOURCE };

export function isModelledHistoryConfigured() {
  return isAirQualityConfigured();
}

function newestAgeHours(rows: SensorReading[]) {
  const end = Date.parse(rows[rows.length - 1]?.sampledAt ?? "");
  return Number.isFinite(end) ? (Date.now() - end) / 3_600_000 : Infinity;
}

type Point = { h3CellId: string; label: string; lat: number; lng: number };

async function fetchAndStore(point: Point, hours: number): Promise<SensorReading[]> {
  const modelled = await getAirQualityHistory(point.lat, point.lng, hours);
  // Storing is a cache; a failed insert must not lose the forecast.
  await insertGoogleHistory(point, modelled).catch((error) => {
    console.warn("[modelledHistory] BigQuery insert failed", error instanceof Error ? error.message : error);
  });
  return modelled
    .filter((hour) => hour.pm25 !== null)
    .map((hour) => ({
      sampledAt: hour.time,
      h3CellId: point.h3CellId,
      location_label: point.label,
      location_lat: point.lat,
      location_lng: point.lng,
      sensor_pm25: hour.pm25,
      sensor_pm10: hour.pm10,
      sensor_no2: null,
      sensor_so2: null,
      sensor_co: null,
      sensor_nh3: null,
      sensor_ozone: null,
    }));
}

const inFlight = new Map<string, Promise<SensorReading[]>>();

/**
 * The last 72 h of modelled history for a point: from BigQuery when it is
 * current, otherwise fetched from Google (and stored for the next request).
 */
export function getModelledHistory(point: Point): Promise<SensorReading[]> {
  let pending = inFlight.get(point.h3CellId);
  if (!pending) {
    pending = (async () => {
      const stored = await queryGoogleHistory(point.h3CellId, HISTORY_HOURS).catch(() => [] as SensorReading[]);
      if (stored.length > 0 && newestAgeHours(stored) <= REFRESH_AFTER_HOURS) {
        return stored.map((row) => ({ ...row, location_label: point.label }));
      }
      return (await fetchAndStore(point, HISTORY_HOURS)).slice(-HISTORY_HOURS);
    })().finally(() => inFlight.delete(point.h3CellId));
    inFlight.set(point.h3CellId, pending);
  }
  return pending;
}

/** The zones the forecast page offers for a city (same rules as app/forecast/page.tsx). */
async function forecastZones(city: CityConfig): Promise<Point[]> {
  if (city.id === "delhi") {
    return DELHI_H3_CELLS.map((cell) => ({ h3CellId: cell.h3CellId, label: cell.label, lat: cell.lat, lng: cell.lng }));
  }
  const stations = await fetchCityStationDirectory(city);
  return [...stations]
    .sort((a, b) => Number(a.stale) - Number(b.stale))
    .filter((station) => station.pm25 !== null || station.stale)
    .map((station) => ({
      h3CellId: latLngToCell(station.lat, station.lng, H3_RESOLUTION),
      label: station.stationName,
      lat: station.lat,
      lng: station.lng,
    }))
    .filter((zone, index, zones) => zones.findIndex((other) => other.h3CellId === zone.h3CellId) === index)
    .slice(0, 12);
}

export type BackfillResult = Record<string, { zones: number; rows: number; failed: number; error?: string }>;

/** Loads a week of modelled history into BigQuery for every city's forecast zones. */
export async function backfillModelledHistory(cityIds: string[] = CITIES.map((city) => city.id)): Promise<BackfillResult> {
  await ensureGoogleHistoryTable();
  const result: BackfillResult = {};
  for (const city of CITIES.filter((candidate) => cityIds.includes(candidate.id))) {
    try {
      const zones = await forecastZones(city);
      if (zones.length === 0) {
        result[city.id] = { zones: 0, rows: 0, failed: 0, error: `${city.stations.network}: no stations reporting right now.` };
        continue;
      }
      let rows = 0;
      let failed = 0;
      for (let i = 0; i < zones.length; i += BACKFILL_CONCURRENCY) {
        const batch = zones.slice(i, i + BACKFILL_CONCURRENCY);
        const settled = await Promise.allSettled(batch.map((zone) => fetchAndStore(zone, BACKFILL_HOURS)));
        for (const outcome of settled) {
          if (outcome.status === "fulfilled") rows += outcome.value.length;
          else failed += 1;
        }
      }
      result[city.id] = { zones: zones.length, rows, failed };
    } catch (error) {
      result[city.id] = { zones: 0, rows: 0, failed: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return result;
}
