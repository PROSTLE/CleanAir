/**
 * Heuristic PM2.5 forecast engine.
 *
 * No external ML API. Pure math running in <5ms per cell.
 *
 * Pipeline:
 *   1. Weighted Moving Average (WMA) over recent history → base trend
 *   2. Diurnal pattern multipliers (fitted per city)
 *   3. Optional wind damping
 *   4. 24-hour hourly forecast array with confidence degradation
 *
 * Nothing about a city is typed in here: the diurnal profile comes from that
 * city's own station history in BigQuery (lib/server/bigqueryLive.ts
 * fitForecastProfile). A city without enough history forecasts without one.
 * A PM10 covariate was dropped: fitted per city and backtested out of sample
 * on Sep–Oct 2026 station data, it raised the error in almost every city.
 */


// Hour-of-day must be computed in the city's zone explicitly: Date#getHours()
// uses the *server's* timezone, which on Cloud Run / App Hosting is UTC and
// would shift every diurnal multiplier and hour label. IST is UTC+5:30, no DST.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function getIstHour(date: Date): number {
  return new Date(date.getTime() + IST_OFFSET_MS).getUTCHours();
}

/** Hour of day (0-23) in any IANA time zone, independent of the server's zone. */
export function getLocalHour(date: Date, timeZone: string): number {
  if (timeZone === "Asia/Kolkata") return getIstHour(date);
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(date),
  );
  return Number.isFinite(hour) ? hour % 24 : date.getUTCHours();
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SensorReading {
  sampledAt: string; // ISO-8601
  h3CellId: string;
  location_label: string;
  location_lat: number;
  location_lng: number;
  sensor_pm25: number | null;
  sensor_pm10: number | null;
  sensor_no2: number | null;
  sensor_so2: number | null;
  sensor_co: number | null;
  sensor_nh3: number | null;
  sensor_ozone: number | null;
  // Optional — wind data if enriched from Open-Meteo
  wind_speed_kmh?: number | null;
  wind_dir_deg?: number | null;
}

export interface ForecastCell {
  h3CellId: string;
  label: string;
  labelKey: string;
  lat: number;
  lng: number;
  bigQueryLabel?: string;
}

export interface HourlyForecastPoint {
  hour: string; // e.g. "14:00" (IST)
  time: string; // ISO-8601 instant this point forecasts
  predicted_pm25: number;
  confidence: "low" | "medium" | "high";
}

export interface ForecastResult {
  h3CellId: string;
  location_label: string;
  generatedAt: string;
  /** Timestamp of the newest reading the forecast was built from. */
  historyEnd: string | null;
  currentPm25: number;
  peakPm25: number;
  peakHour: string;
  trend: "rising" | "falling" | "stable";
  trendMagnitude: number; // µg/m³ per hour (positive = rising)
  windDamping: boolean;
  summary: string;
  forecast: HourlyForecastPoint[];
}

/** Per-city model input fitted from that city's station history, never typed in. */
export interface ForecastProfile {
  /** PM2.5 at each local hour (0–23) relative to the station's daily mean; null without enough history. */
  diurnal: number[] | null;
}

// ─── Wind damping ─────────────────────────────────────────────────────────────
const WIND_DAMPING_THRESHOLD_KMH = 20; // above this, apply damping
const WIND_DAMPING_FACTOR = 0.75; // multiply forecast by this factor when windy

// ─── Confidence schedule ─────────────────────────────────────────────────────
// The first 6 hours are "high", next 12 "medium", rest "low".
function hoursToConfidence(hoursAhead: number): "low" | "medium" | "high" {
  if (hoursAhead <= 6) return "high";
  if (hoursAhead <= 18) return "medium";
  return "low";
}

// ─── WMA helper ───────────────────────────────────────────────────────────────
/**
 * Weighted Moving Average — weight = position index (most recent = highest).
 * Returns the weighted mean of the values array (oldest first).
 */
function wma(values: number[]): number {
  if (values.length === 0) return 0;
  let weightedSum = 0;
  let totalWeight = 0;
  for (let i = 0; i < values.length; i++) {
    const weight = i + 1; // weight increases with recency
    weightedSum += values[i] * weight;
    totalWeight += weight;
  }
  return weightedSum / totalWeight;
}

// ─── Trend slope (µg/m³/hour) ─────────────────────────────────────────────────
/**
 * Linear regression slope over the provided hourly readings.
 * Returns µg/m³ per hour.
 */
function trendSlope(readings: number[]): number {
  const n = readings.length;
  if (n < 2) return 0;
  // Simple least-squares on [0, 1, 2, …] vs readings
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += readings[i];
    sumXY += i * readings[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

// ─── Main forecast function ───────────────────────────────────────────────────

export function forecastPM25(
  history: SensorReading[],
  options: {
    anchor?: Date;
    /** Time zone for hour labels and the diurnal profile (default IST). */
    timeZone?: string;
    /** The city's fitted profile; without one, no diurnal adjustment. */
    profile?: ForecastProfile | null;
  } = {},
): ForecastResult {
  const timeZone = options.timeZone ?? "Asia/Kolkata";
  const diurnal = options.profile?.diurnal ?? null;
  const diurnalAt = (time: string | Date) => (diurnal ? diurnal[getLocalHour(new Date(time), timeZone)] : 1);
  // Sort oldest-first
  const sorted = [...history].sort(
    (a, b) => new Date(a.sampledAt).getTime() - new Date(b.sampledAt).getTime()
  );

  // Extract valid PM2.5 readings, with the daily cycle divided out so the
  // trend below is fitted on the underlying level rather than the time of day.
  const pm25Readings = sorted.filter(
    (r): r is SensorReading & { sensor_pm25: number } => r.sensor_pm25 !== null && Number.isFinite(r.sensor_pm25),
  );

  // No invented baseline: callers must supply real PM2.5 history.
  if (pm25Readings.length === 0) {
    throw new Error("forecastPM25 needs at least one PM2.5 reading.");
  }
  const pm25Series = pm25Readings.map((r) => r.sensor_pm25 / diurnalAt(r.sampledAt));
  const currentPm25 = pm25Readings[pm25Readings.length - 1].sensor_pm25;
  const currentLevel = pm25Series[pm25Series.length - 1];
  const pm25Window = pm25Series.slice(-72); // last 72 values

  // ── 1. WMA baseline ────────────────────────────────────────────────────────
  const wmaBase = wma(pm25Window);

  // ── 2. Short-term trend slope ──────────────────────────────────────────────
  const recentWindow = pm25Series.slice(-24); // last 24 readings
  const slope = trendSlope(recentWindow); // µg/m³ per step

  // ── 3. Wind damping ───────────────────────────────────────────────────────
  const lastReading = sorted[sorted.length - 1];
  const windSpeed = lastReading?.wind_speed_kmh;
  const isWindy =
    windSpeed !== null &&
    windSpeed !== undefined &&
    Number.isFinite(windSpeed) &&
    windSpeed > WIND_DAMPING_THRESHOLD_KMH;

  // ── 4. Build 24-hour forecast ─────────────────────────────────────────────
  // Hours are projected from `anchor` (default: now). Backtests anchor at the
  // last training reading so predictions line up with held-out actuals.
  const now = options.anchor ?? new Date();
  const forecast: HourlyForecastPoint[] = [];
  let peakPm25 = 0;
  let peakHour = "";

  for (let h = 1; h <= 24; h++) {
    const forecastTime = new Date(now.getTime() + h * 60 * 60 * 1000);
    const hour = getLocalHour(forecastTime, timeZone);
    const hourLabel = `${String(hour).padStart(2, "0")}:00`;

    // Blend WMA with trend projection
    const trendProjection = wmaBase + slope * h;

    // Dampen trend extrapolation so it doesn't diverge wildly: ramp from the
    // current level to the projection over 24 hours.
    const blendFactor = Math.min(1, h / 24);
    const blendedBase = currentLevel * (1 - blendFactor) + trendProjection * blendFactor;

    // Put the daily cycle back for the hour being forecast.
    const diurnalAdjusted = blendedBase * diurnalAt(forecastTime);

    // Wind damping
    const predicted = Math.max(0, Math.round(isWindy ? diurnalAdjusted * WIND_DAMPING_FACTOR : diurnalAdjusted));

    if (predicted > peakPm25) {
      peakPm25 = predicted;
      peakHour = hourLabel;
    }

    forecast.push({
      hour: hourLabel,
      time: forecastTime.toISOString(),
      predicted_pm25: predicted,
      confidence: hoursToConfidence(h),
    });
  }

  // ── 5. Derive trend label ─────────────────────────────────────────────────
  const trendLabel: "rising" | "falling" | "stable" =
    slope > 1.5 ? "rising" : slope < -1.5 ? "falling" : "stable";

  // ── 6. Generate human-readable summary ───────────────────────────────────
  const peakValue = Math.round(peakPm25);
  const windNote = isWindy ? " Wind conditions may help disperse pollutants." : "";
  const trendNote =
    trendLabel === "rising"
      ? `trending upward at ~${Math.abs(slope).toFixed(1)} µg/m³/hr`
      : trendLabel === "falling"
      ? `trending downward at ~${Math.abs(slope).toFixed(1)} µg/m³/hr`
      : "currently stable";

  const summary = `PM2.5 expected to ${trendLabel === "rising" ? "rise to" : trendLabel === "falling" ? "fall to" : "remain near"} ${peakValue} µg/m³ by ${peakHour}. Currently ${trendNote}.${windNote}`;

  const h3CellId = lastReading?.h3CellId ?? "unknown";
  const location_label = lastReading?.location_label ?? "Unknown station";

  return {
    h3CellId,
    location_label,
    generatedAt: now.toISOString(),
    historyEnd: lastReading?.sampledAt ?? null,
    currentPm25: Math.round(currentPm25),
    peakPm25,
    peakHour,
    trend: trendLabel,
    trendMagnitude: parseFloat(slope.toFixed(2)),
    windDamping: isWindy,
    summary,
    forecast,
  };
}

// ─── AQI category helpers ─────────────────────────────────────────────────────

export type AQICategory = "aqi_category_good" | "aqi_category_satisfactory" | "aqi_category_moderate" | "aqi_category_poor" | "aqi_category_very_poor" | "aqi_category_severe";

export interface AQIInfo {
  category: AQICategory;
  color: string;
  bgColor: string;
  textColor: string;
  description: string;
}

/**
 * CPCB (India) PM2.5 AQI breakpoints (µg/m³, 24-hour average).
 */
// CPCB AQI band order (green → dark red), tuned to the VayuSetu palette.
export function getAQIInfo(pm25: number): AQIInfo {
  if (pm25 <= 30) {
    return {
      category: "aqi_category_good",
      color: "#3a9d5d",
      bgColor: "rgba(58,157,93,0.12)",
      textColor: "#236b3c",
      description: "aqi_desc_good",
    };
  } else if (pm25 <= 60) {
    return {
      category: "aqi_category_satisfactory",
      color: "#98b43a",
      bgColor: "rgba(152,180,58,0.14)",
      textColor: "#5c6f1f",
      description: "aqi_desc_satisfactory",
    };
  } else if (pm25 <= 90) {
    return {
      category: "aqi_category_moderate",
      color: "#d4a72c",
      bgColor: "rgba(212,167,44,0.14)",
      textColor: "#7d6116",
      description: "aqi_desc_moderate",
    };
  } else if (pm25 <= 120) {
    return {
      category: "aqi_category_poor",
      color: "#d9772b",
      bgColor: "rgba(217,119,43,0.13)",
      textColor: "#9a4d14",
      description: "aqi_desc_poor",
    };
  } else if (pm25 <= 250) {
    return {
      category: "aqi_category_very_poor",
      color: "#c0392b",
      bgColor: "rgba(192,57,43,0.12)",
      textColor: "#8f2a1f",
      description: "aqi_desc_very_poor",
    };
  } else {
    return {
      category: "aqi_category_severe",
      // CPCB's scale renders "Severe" in dark red (not purple).
      color: "#8b1a1a",
      bgColor: "rgba(139,26,26,0.12)",
      textColor: "#7a1616",
      description: "aqi_desc_severe",
    };
  }
}

// ─── Backtest ─────────────────────────────────────────────────────────────────

export interface BacktestResult {
  /** Mean absolute error of this engine on held-out readings (µg/m³). */
  maeHeuristic: number;
  /** Same error for naive persistence ("next hours = last value"). */
  maePersistence: number;
  evaluatedPoints: number;
  holdoutHours: number;
}

/**
 * Honest accuracy check on real data: forecast from all but the last
 * `holdoutHours` readings, compare against what was actually measured, and
 * report it next to a persistence baseline so the number means something.
 */
export function backtestHeuristic(
  history: SensorReading[],
  holdoutHours = 12,
  options: { timeZone?: string; profile?: ForecastProfile | null } = {},
): BacktestResult | null {
  const sorted = [...history]
    .filter((reading) => reading.sensor_pm25 !== null && Number.isFinite(reading.sensor_pm25))
    .sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt));
  if (sorted.length < holdoutHours + 24) return null;

  const train = sorted.slice(0, -holdoutHours);
  const test = sorted.slice(-holdoutHours);
  const anchorMs = Date.parse(train[train.length - 1].sampledAt);
  if (!Number.isFinite(anchorMs)) return null;

  const result = forecastPM25(train, { ...options, anchor: new Date(anchorMs) });
  const persistenceValue = train[train.length - 1].sensor_pm25 as number;
  const heuristicErrors: number[] = [];
  const persistenceErrors: number[] = [];

  for (const actual of test) {
    const actualMs = Date.parse(actual.sampledAt);
    const point = result.forecast.find((candidate) => Math.abs(Date.parse(candidate.time) - actualMs) <= 30 * 60 * 1000);
    if (!point || actual.sensor_pm25 === null) continue;
    heuristicErrors.push(Math.abs(point.predicted_pm25 - actual.sensor_pm25));
    persistenceErrors.push(Math.abs(persistenceValue - actual.sensor_pm25));
  }
  if (heuristicErrors.length === 0) return null;

  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    maeHeuristic: Number(mean(heuristicErrors).toFixed(1)),
    maePersistence: Number(mean(persistenceErrors).toFixed(1)),
    evaluatedPoints: heuristicErrors.length,
    holdoutHours,
  };
}
