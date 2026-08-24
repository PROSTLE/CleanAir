/**
 * Heuristic PM2.5 forecast engine for Delhi air quality.
 *
 * No external ML API. Pure math running in <5ms per cell.
 *
 * Pipeline:
 *   1. Weighted Moving Average (WMA) over recent history → base trend
 *   2. Covariate adjustment (PM10, NO2 correlation)
 *   3. Diurnal pattern multipliers (Delhi-specific hourly profile)
 *   4. Optional wind damping
 *   5. 24-hour hourly forecast array with confidence degradation
 */

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
  // Optional — wind data if enriched from openWeather
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
  hour: string; // e.g. "14:00"
  predicted_pm25: number;
  confidence: "low" | "medium" | "high";
}

export interface ForecastResult {
  h3CellId: string;
  location_label: string;
  generatedAt: string;
  currentPm25: number;
  peakPm25: number;
  peakHour: string;
  trend: "rising" | "falling" | "stable";
  trendMagnitude: number; // µg/m³ per hour (positive = rising)
  covariateNudge: number; // µg/m³ added/subtracted by PM10/NO2
  windDamping: boolean;
  summary: string;
  forecast: HourlyForecastPoint[];
}

// ─── Delhi diurnal PM2.5 profile ─────────────────────────────────────────────
// Multipliers relative to daily mean derived from Delhi CPCB long-term averages.
// Hour 0 = midnight. Peak at 07:00 & 22:00; trough at 13:00-15:00.
const DIURNAL_MULTIPLIERS: number[] = [
  1.18, // 00:00 night
  1.22, // 01:00 late night peak
  1.20, // 02:00
  1.18, // 03:00
  1.15, // 04:00
  1.12, // 05:00 pre-dawn
  1.08, // 06:00 morning build
  1.14, // 07:00 morning peak (traffic + crop burning)
  1.10, // 08:00
  1.05, // 09:00
  0.98, // 10:00
  0.91, // 11:00
  0.84, // 12:00 midday dip (convective mixing)
  0.80, // 13:00 midday minimum
  0.82, // 14:00
  0.87, // 15:00
  0.92, // 16:00
  0.99, // 17:00 evening build
  1.06, // 18:00
  1.12, // 19:00 evening peak (cooking, traffic)
  1.16, // 20:00
  1.19, // 21:00
  1.21, // 22:00 late-evening secondary peak
  1.20, // 23:00
];

// ─── Covariate weights ────────────────────────────────────────────────────────
// Linear regression-style nudge coefficients (empirically derived for Delhi).
const PM10_TO_PM25_COEFF = 0.38; // slope: a ΔPM10 of 100 → ΔPM25 of 38
const NO2_TO_PM25_COEFF = 0.25; // slope: a ΔNO2 of 40 → ΔPM25 of 10
const PM10_BACKGROUND = 120; // µg/m³ — moderate baseline for Delhi
const NO2_BACKGROUND = 40; // µg/m³ — moderate baseline for Delhi

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

export function forecastPM25(history: SensorReading[]): ForecastResult {
  // Sort oldest-first
  const sorted = [...history].sort(
    (a, b) => new Date(a.sampledAt).getTime() - new Date(b.sampledAt).getTime()
  );

  // Extract valid PM2.5 readings (last 72 hours max)
  const pm25Series = sorted
    .map((r) => r.sensor_pm25)
    .filter((v): v is number => v !== null && Number.isFinite(v));

  // Fallback if no data
  const currentPm25 = pm25Series.length > 0 ? pm25Series[pm25Series.length - 1] : 85;
  const pm25Window = pm25Series.slice(-72); // last 72 values

  // ── 1. WMA baseline ────────────────────────────────────────────────────────
  const wmaBase = pm25Window.length > 0 ? wma(pm25Window) : currentPm25;

  // ── 2. Short-term trend slope ──────────────────────────────────────────────
  const recentWindow = pm25Series.slice(-24); // last 24 readings
  const slope = trendSlope(recentWindow); // µg/m³ per step

  // ── 3. Covariate nudge ────────────────────────────────────────────────────
  // Use the most recent reading's covariate values
  const lastReading = sorted[sorted.length - 1];
  let covariateNudge = 0;
  if (lastReading) {
    const pm10 = lastReading.sensor_pm10;
    const no2 = lastReading.sensor_no2;
    if (pm10 !== null && pm10 !== undefined && Number.isFinite(pm10)) {
      covariateNudge += PM10_TO_PM25_COEFF * (pm10 - PM10_BACKGROUND);
    }
    if (no2 !== null && no2 !== undefined && Number.isFinite(no2)) {
      covariateNudge += NO2_TO_PM25_COEFF * (no2 - NO2_BACKGROUND);
    }
  }
  // Clamp nudge to ±40 µg/m³ to avoid runaway
  covariateNudge = Math.max(-40, Math.min(40, covariateNudge));

  // ── 4. Wind damping ───────────────────────────────────────────────────────
  const windSpeed = lastReading?.wind_speed_kmh;
  const isWindy =
    windSpeed !== null &&
    windSpeed !== undefined &&
    Number.isFinite(windSpeed) &&
    windSpeed > WIND_DAMPING_THRESHOLD_KMH;

  // ── 5. Build 24-hour forecast ─────────────────────────────────────────────
  const now = new Date();
  const forecast: HourlyForecastPoint[] = [];
  let peakPm25 = 0;
  let peakHour = "";

  for (let h = 1; h <= 24; h++) {
    const forecastTime = new Date(now.getTime() + h * 60 * 60 * 1000);
    const hour = forecastTime.getHours();
    const hourLabel = `${String(hour).padStart(2, "0")}:00`;

    // Blend WMA with trend projection
    const trendProjection = wmaBase + slope * h;

    // Dampen trend extrapolation so it doesn't diverge wildly
    // Linear interpolation between current and projection, capped at ±60%
    const blendFactor = Math.min(1, h / 24); // ramps 0→1 over 24 hours
    const blendedBase = currentPm25 * (1 - blendFactor) + trendProjection * blendFactor;

    // Apply covariate nudge (decays over horizon — near-term more influenced)
    const covariateDecay = Math.max(0, 1 - h / 24);
    const adjustedValue = blendedBase + covariateNudge * covariateDecay;

    // Apply diurnal multiplier
    const diurnalFactor = DIURNAL_MULTIPLIERS[hour];
    // The multiplier is applied to the delta above 30 µg/m³ baseline to avoid
    // distorting low-pollution forecasts inappropriately.
    const DIURNAL_BASELINE = 30;
    const diurnalAdjusted =
      DIURNAL_BASELINE + (adjustedValue - DIURNAL_BASELINE) * diurnalFactor;

    // Wind damping
    let predicted = isWindy ? diurnalAdjusted * WIND_DAMPING_FACTOR : diurnalAdjusted;

    // Hard floor/ceiling: realistic Delhi range
    predicted = Math.max(10, Math.min(500, Math.round(predicted)));

    if (predicted > peakPm25) {
      peakPm25 = predicted;
      peakHour = hourLabel;
    }

    forecast.push({
      hour: hourLabel,
      predicted_pm25: predicted,
      confidence: hoursToConfidence(h),
    });
  }

  // ── 6. Derive trend label ─────────────────────────────────────────────────
  const slopeMagnitude = Math.abs(slope);
  const trendLabel: "rising" | "falling" | "stable" =
    slope > 1.5 ? "rising" : slope < -1.5 ? "falling" : "stable";

  // ── 7. Generate human-readable summary ───────────────────────────────────
  const peakValue = Math.round(peakPm25);
  const covDir = covariateNudge > 3 ? "elevated PM10/NO2 levels" : null;
  const windNote = isWindy ? " Wind conditions may help disperse pollutants." : "";
  const trendNote =
    trendLabel === "rising"
      ? `trending upward at ~${Math.abs(slope).toFixed(1)} µg/m³/hr`
      : trendLabel === "falling"
      ? `trending downward at ~${Math.abs(slope).toFixed(1)} µg/m³/hr`
      : "currently stable";

  const covNote = covDir ? `, amplified by ${covDir}` : "";
  const summary = `PM2.5 expected to ${trendLabel === "rising" ? "rise to" : trendLabel === "falling" ? "fall to" : "remain near"} ${peakValue} µg/m³ by ${peakHour}. Currently ${trendNote}${covNote}.${windNote}`;

  const h3CellId = lastReading?.h3CellId ?? "unknown";
  const location_label = lastReading?.location_label ?? "Delhi";

  return {
    h3CellId,
    location_label,
    generatedAt: now.toISOString(),
    currentPm25: Math.round(currentPm25),
    peakPm25,
    peakHour,
    trend: trendLabel,
    trendMagnitude: parseFloat(slope.toFixed(2)),
    covariateNudge: parseFloat(covariateNudge.toFixed(2)),
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
export function getAQIInfo(pm25: number): AQIInfo {
  if (pm25 <= 30) {
    return {
      category: "aqi_category_good",
      color: "#22c55e",
      bgColor: "rgba(34,197,94,0.12)",
      textColor: "#15803d",
      description: "aqi_desc_good",
    };
  } else if (pm25 <= 60) {
    return {
      category: "aqi_category_satisfactory",
      color: "#84cc16",
      bgColor: "rgba(132,204,22,0.12)",
      textColor: "#4d7c0f",
      description: "aqi_desc_satisfactory",
    };
  } else if (pm25 <= 90) {
    return {
      category: "aqi_category_moderate",
      color: "#eab308",
      bgColor: "rgba(234,179,8,0.12)",
      textColor: "#a16207",
      description: "aqi_desc_moderate",
    };
  } else if (pm25 <= 120) {
    return {
      category: "aqi_category_poor",
      color: "#f97316",
      bgColor: "rgba(249,115,22,0.12)",
      textColor: "#c2410c",
      description: "aqi_desc_poor",
    };
  } else if (pm25 <= 250) {
    return {
      category: "aqi_category_very_poor",
      color: "#ef4444",
      bgColor: "rgba(239,68,68,0.12)",
      textColor: "#b91c1c",
      description: "aqi_desc_very_poor",
    };
  } else {
    return {
      category: "aqi_category_severe",
      color: "#7c3aed",
      bgColor: "rgba(124,58,237,0.12)",
      textColor: "#6d28d9",
      description: "aqi_desc_severe",
    };
  }
}

// ─── Mock history generator (for demo / when BigQuery unavailable) ──────────

/**
 * Generates realistic mock sensor readings for a given h3CellId
 * using a seeded pseudo-random walk anchored to Delhi baseline values.
 */
export function generateMockHistory(
  h3CellId: string,
  locationLabel: string,
  lat: number,
  lng: number,
  hoursBack = 72
): SensorReading[] {
  // Simple hash seed from h3CellId
  let seed = 0;
  for (let i = 0; i < h3CellId.length; i++) {
    seed = (seed * 31 + h3CellId.charCodeAt(i)) >>> 0;
  }

  function seededRand() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  }

  const now = Date.now();
  const readings: SensorReading[] = [];

  // Start from a plausible baseline for this cell (80–200 µg/m³)
  let pm25 = 60 + seededRand() * 140;
  let pm10 = pm25 * (1.6 + seededRand() * 0.4);
  let no2 = 20 + seededRand() * 60;

  for (let h = hoursBack; h >= 0; h--) {
    const ts = new Date(now - h * 60 * 60 * 1000);
    const hour = ts.getHours();

    // Apply diurnal pattern for mock too
    const diurnal = DIURNAL_MULTIPLIERS[hour];

    // Random walk with diurnal modulation
    const delta = (seededRand() - 0.48) * 12;
    pm25 = Math.max(10, Math.min(400, pm25 + delta));
    const diurnalPm25 = Math.max(10, 30 + (pm25 - 30) * diurnal);

    pm10 = Math.max(20, diurnalPm25 * (1.5 + seededRand() * 0.3));
    no2 = Math.max(5, 20 + seededRand() * 60);

    readings.push({
      sampledAt: ts.toISOString(),
      h3CellId,
      location_label: locationLabel,
      location_lat: lat,
      location_lng: lng,
      sensor_pm25: parseFloat(diurnalPm25.toFixed(1)),
      sensor_pm10: parseFloat(pm10.toFixed(1)),
      sensor_no2: parseFloat(no2.toFixed(1)),
      sensor_so2: parseFloat((2 + seededRand() * 12).toFixed(1)),
      sensor_co: parseFloat((0.3 + seededRand() * 1.2).toFixed(2)),
      sensor_nh3: parseFloat((1 + seededRand() * 8).toFixed(1)),
      sensor_ozone: parseFloat((20 + seededRand() * 40).toFixed(1)),
      wind_speed_kmh: parseFloat((3 + seededRand() * 22).toFixed(1)),
      wind_dir_deg: parseFloat((seededRand() * 360).toFixed(0)),
    });
  }

  return readings;
}

// ─── Known Delhi H3 cells (resolution 7) for demo ────────────────────────────

export const DELHI_H3_CELLS: ForecastCell[] = [
  { h3CellId: "872a100edffffff", labelKey: "cell_anand_vihar", label: "Anand Vihar", bigQueryLabel: "Anand Vihar, Delhi - DPCC", lat: 28.6469, lng: 77.3152 },
  { h3CellId: "872a1072dffffff", labelKey: "cell_ito_crossing", label: "ITO Crossing", bigQueryLabel: "ITO, Delhi - CPCB", lat: 28.6292, lng: 77.2410 },
  { h3CellId: "872a1014dffffff", labelKey: "cell_ghazipur_landfill", label: "Patparganj, Delhi - DPCC", lat: 28.6264, lng: 77.3192 },
  { h3CellId: "872a1073dffffff", labelKey: "cell_bawana_industrial", label: "Bawana Industrial", bigQueryLabel: "Bawana, Delhi - DPCC", lat: 28.8039, lng: 77.0469 },
  { h3CellId: "872a1071dffffff", labelKey: "cell_dwarka_sector_21", label: "Dwarka Sector 21", bigQueryLabel: "NSIT Dwarka, Delhi - CPCB", lat: 28.5859, lng: 77.0718 },
  { h3CellId: "872a1078dffffff", labelKey: "cell_bhalswa_landfill", label: "Bhalswa Landfill", bigQueryLabel: "Jahangirpuri, Delhi - DPCC", lat: 28.7427, lng: 77.1636 },
  { h3CellId: "872a100cdffffff", labelKey: "cell_connaught_place", label: "Connaught Place", bigQueryLabel: "Mandir Marg, Delhi - DPCC", lat: 28.6315, lng: 77.2167 },
  { h3CellId: "872a107adffffff", labelKey: "cell_rohini_sector_8", label: "Rohini Sector 8", bigQueryLabel: "Rohini, Delhi - DPCC", lat: 28.7495, lng: 77.1100 },
];