import "server-only";

import { cellToLatLng, isValidCell } from "h3-js";
import { getCity, resolveCityForPoint } from "@/lib/cities";
import {
  backtestHeuristic,
  DELHI_H3_CELLS,
  forecastPM25,
  type BacktestResult,
  type ForecastResult,
  type SensorReading,
} from "@/lib/forecastEngine";
import { fetchNearbyStations } from "@/lib/stations";
import { getWindData } from "@/lib/weather";
import {
  arimaForecast,
  isBigQueryConfigured,
  queryArchiveHistory,
  queryLiveHistory,
  type ArimaPoint,
} from "@/lib/server/bigqueryLive";
import { getModelledHistory, isModelledHistoryConfigured, MODELLED_SOURCE } from "@/lib/server/modelledHistory";

// History whose newest reading is older than this is an archive, not the
// current state of the air.
const LIVE_HISTORY_MAX_AGE_HOURS = 3;
const ARCHIVE_IS_RECENT_HOURS = 48;
const MIN_LIVE_ROWS = 12;
const MIN_HISTORY_ROWS = 3;

export type ForecastServiceResult =
  | {
      ok: true;
      forecast: ForecastResult;
      history: SensorReading[];
      source: "bigquery";
      cityId: string;
      /** "modelled" = Google Air Quality history, used only when no station history is usable. */
      dataSource: "live" | "archive" | "modelled";
      station: string;
      isLiveHistory: boolean;
      historyAgeHours: number | null;
      windApplied: boolean;
      backtest: BacktestResult | null;
      arima: { points: ArimaPoint[] } | { points: null; reason: string };
    }
  | { ok: false; status: number; error: string; h3CellId: string };

export function resolveForecastCell(h3CellId: string) {
  const known = DELHI_H3_CELLS.find((cell) => cell.h3CellId === h3CellId);
  const [centerLat, centerLng] = cellToLatLng(h3CellId);
  const city = resolveCityForPoint(known?.lat ?? centerLat, known?.lng ?? centerLng) ?? getCity("delhi");
  return {
    city,
    label: known?.label ?? `Cell ${h3CellId}`,
    bigQueryLabel: known?.bigQueryLabel ?? known?.label ?? `Cell ${h3CellId}`,
    lat: known?.lat ?? centerLat,
    lng: known?.lng ?? centerLng,
  };
}

function ageHours(history: SensorReading[]) {
  const endMs = Date.parse(history[history.length - 1]?.sampledAt ?? "");
  return Number.isFinite(endMs) ? (Date.now() - endMs) / 3_600_000 : null;
}

/**
 * Forecast for one H3 cell. Prefers the live station table fed by
 * /api/cron/tick (nearest station within 5 km); for Delhi it falls back to
 * the historical CPCB archive and says so. Never synthesises data.
 */
export async function getForecastForCell(h3CellId: string): Promise<ForecastServiceResult> {
  if (!isValidCell(h3CellId)) {
    return { ok: false, status: 400, error: "Invalid h3CellId.", h3CellId };
  }
  if (!isBigQueryConfigured()) {
    return { ok: false, status: 503, error: "BIGQUERY_PROJECT_ID is not set.", h3CellId };
  }

  const cell = resolveForecastCell(h3CellId);
  let history: SensorReading[] = [];
  let dataSource: "live" | "archive" | "modelled" = "archive";
  let station = cell.bigQueryLabel;
  let nearestStationName: string | null = null;
  const errors: string[] = [];

  // 1. Live: the nearest reporting station's recent hourly history.
  try {
    const nearest = (await fetchNearbyStations(cell.lat, cell.lng, 5)).find((candidate) => candidate.pm25 !== null);
    if (nearest) {
      nearestStationName = nearest.stationName;
      const live = await queryLiveHistory(nearest.stationName, 72);
      const liveAge = ageHours(live);
      if (live.length >= MIN_LIVE_ROWS && liveAge !== null && liveAge <= LIVE_HISTORY_MAX_AGE_HOURS) {
        history = live;
        dataSource = "live";
        station = nearest.stationName;
      }
    }
  } catch (error) {
    errors.push(`live: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 2. Archive fallback (the archive table only holds Delhi's CPCB history).
  if (dataSource !== "live" && cell.city.id === "delhi") {
    try {
      history = await queryArchiveHistory(h3CellId, cell.bigQueryLabel);
    } catch (error) {
      errors.push(`archive: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 3. Modelled fallback: Google Air Quality hourly history for this spot,
  //    kept in its own BigQuery table and labelled as modelled end to end.
  //    Only when no station history is usable; real readings always win.
  if (dataSource !== "live" && history.length < MIN_HISTORY_ROWS && isModelledHistoryConfigured()) {
    try {
      const label = `${MODELLED_SOURCE} · ${nearestStationName ? `near ${nearestStationName}` : cell.label}`;
      const modelled = await getModelledHistory({ h3CellId, label, lat: cell.lat, lng: cell.lng });
      const modelledAge = ageHours(modelled);
      if (modelled.length >= MIN_LIVE_ROWS && modelledAge !== null && modelledAge <= LIVE_HISTORY_MAX_AGE_HOURS) {
        history = modelled;
        dataSource = "modelled";
      } else {
        errors.push(`modelled: only ${modelled.length} recent hours from the Google Air Quality API`);
      }
    } catch (error) {
      errors.push(`modelled: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (history.length < MIN_HISTORY_ROWS) {
    return {
      ok: false,
      status: 503,
      error:
        errors.length > 0
          ? `BigQuery query failed (${errors.join("; ")})`
          : cell.city.id === "delhi"
            ? `Only ${history.length} PM2.5 readings found for ${cell.bigQueryLabel}; at least ${MIN_HISTORY_ROWS} are needed.`
            : `No live PM2.5 history for ${nearestStationName ?? cell.label} yet. The scheduler stores ${cell.city.name} station readings in BigQuery every run; a forecast needs ${MIN_LIVE_ROWS} recent hourly readings from a station within 5 km.`,
      h3CellId,
    };
  }

  const historyAge = ageHours(history);
  const isLiveHistory = historyAge !== null && historyAge <= ARCHIVE_IS_RECENT_HOURS;
  station = history[history.length - 1].location_label ?? station;

  // Today's wind only means something for current history.
  let windApplied = false;
  if (isLiveHistory) {
    const wind = await getWindData(cell.lat, cell.lng);
    if (wind) {
      history[history.length - 1] = {
        ...history[history.length - 1],
        wind_dir_deg: wind.windDegrees,
        wind_speed_kmh: Number((wind.windSpeedMs * 3.6).toFixed(1)),
      };
      windApplied = true;
    }
  }

  const engineOptions = { timeZone: cell.city.timeZone, profile: cell.city.forecastProfile };
  const forecast = forecastPM25(history, engineOptions);

  // BigQuery ML only has a model for stations in the live table.
  let arima: { points: ArimaPoint[] } | { points: null; reason: string } = {
    points: null,
    reason:
      dataSource === "modelled"
        ? "ARIMA_PLUS runs on live station readings; this cell is using Google's modelled history."
        : "ARIMA_PLUS runs on live readings; this cell is using archived data.",
  };
  if (dataSource === "live") {
    try {
      const points = await arimaForecast(station, 24);
      arima = points.length
        ? { points }
        : { points: null, reason: `The ARIMA_PLUS model has no series for ${station} yet.` };
    } catch (error) {
      arima = {
        points: null,
        reason: `ARIMA_PLUS model not available yet (${error instanceof Error ? error.message : String(error)}).`,
      };
    }
  }

  return {
    ok: true,
    forecast,
    history,
    source: "bigquery",
    dataSource,
    station,
    isLiveHistory,
    historyAgeHours: historyAge === null ? null : Math.round(historyAge),
    windApplied,
    backtest: backtestHeuristic(history, 12, engineOptions),
    cityId: cell.city.id,
    arima,
  };
}
