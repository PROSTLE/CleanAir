import type { HazardType, IncidentEvidence, PromotionTier } from "@/lib/types";

/**
 * Thresholds for treating sensor/satellite readings as genuine *support* for
 * a specific hazard type, not just background context.
 *
 * These are intentionally conservative for a hackathon demo: they should
 * catch clearly elevated readings without requiring hand-tuned per-station
 * calibration.
 */
export const SENSOR_PROXIMITY_KM = 1.5; // stations beyond this aren't hyper-local to the reported incident
export const SENSOR_SUPPORT_DELTA_PCT = 50; // % above CPCB 24h reference for the hazard-relevant pollutant
export const SENSOR_EXTREME_DELTA_PCT = 100; // extreme readings bypass local-baseline confirmation
export const SENSOR_LOCAL_BASELINE_DELTA_PCT = 25;
export const SATELLITE_SUPPORT_SCORE = 0.4; // 0-1 anomaly score (see earthEngineSatellite.ts)
export const CITIZEN_PROMOTION_THRESHOLD = 3;
export const SENSOR_READING_MAX_AGE_HOURS = 24;

// Dust/construction events skew heavily toward coarse particulate (PM10 well
// above PM2.5), while combustion/traffic/general haze skews toward fine
// particulate (PM10 and PM2.5 stay close together, since most of PM10's
// mass *is* PM2.5). A bare "PM10 crossed the CPCB threshold" check alone
// can't tell dust apart from an ordinary bad-air day — PM10 rises on both.
// This ratio check adds that missing specificity for the "dust" hazard type.
export const DUST_PM_RATIO_THRESHOLD = 1.8; // PM10:PM2.5 — below this, treat as non-dust particulate

/**
 * True if the PM10:PM2.5 ratio indicates coarse (dust-like) particulate
 * rather than fine (combustion/haze) particulate. Missing PM2.5 is
 * deliberately inconclusive: the ambient scanner may still raise a generic
 * particulate incident from PM10, but it must not claim the source is dust.
 */
export function isDustDominant(
  pm10: number | null | undefined,
  pm25: number | null | undefined,
): boolean {
  if (pm10 == null || pm25 == null || pm25 <= 0) return false;
  return pm10 / pm25 >= DUST_PM_RATIO_THRESHOLD;
}

export function parseSensorTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;

  const localDateTimeMatch = value.match(
    /^(\d{1,4})[-/](\d{1,2})[-/](\d{1,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (localDateTimeMatch) {
    const [, first, second, third, hour = "0", minute = "0", secondPart = "0"] =
      localDateTimeMatch;
    const firstNumber = Number(first);
    const thirdNumber = Number(third);
    const day = first.length === 4 ? thirdNumber : firstNumber;
    const month = Number(second);
    const year = first.length === 4 ? firstNumber : thirdNumber;
    const utcMs =
      Date.UTC(
        year,
        month - 1,
        day,
        Number(hour),
        Number(minute),
        Number(secondPart),
      ) -
      5.5 * 60 * 60 * 1000;

    return Number.isFinite(utcMs) ? utcMs : null;
  }

  const direct = Date.parse(value);
  if (Number.isFinite(direct)) return direct;
  return null;
}

export function isSensorReadingFresh(
  lastUpdated: string | null | undefined,
  nowMs = Date.now(),
) {
  const updatedAtMs = parseSensorTimestamp(lastUpdated);
  if (updatedAtMs === null) return false;
  if (updatedAtMs > nowMs + 5 * 60 * 1000) return false;
  return nowMs - updatedAtMs <= SENSOR_READING_MAX_AGE_HOURS * 60 * 60 * 1000;
}



/**
 * Reads support directly off *already-stored* evidence (validation.sensor /
 * validation.satellite) rather than re-fetching — used for citizen reports,
 * where /api/classify-report already captured this at submission time.
 */
export function checkStoredSensorSupport(
  hazardType: HazardType,
  sensor: IncidentEvidence["sensor"] | null | undefined,
): boolean {
  if (!sensor) return false;
  if (sensor.source === "CPCB" && !isSensorReadingFresh(sensor.lastUpdated)) return false;
  const distanceKm = sensor.distanceKm ?? null;
  if (distanceKm === null || distanceKm > SENSOR_PROXIMITY_KM) return false;
  const delta = sensor.primaryDelta ?? sensor.pm25Delta ?? 0;
  if (delta < SENSOR_SUPPORT_DELTA_PCT) return false;
  if (hazardType === "dust" && !isDustDominant(sensor.pm10, sensor.pm25)) return false;
  return true;
}

export function getStoredSatelliteAnomaly(
  satellite: IncidentEvidence["satellite"] | null | undefined,
): number {
  if (!satellite) return 0;

  // New records retain the raw per-band anomaly components. Prefer them over
  // the legacy aggregate weights, which may include a chronic background score.
  if (satellite.selectedChannel === "industrialTraffic" && satellite.no2Anomaly != null) {
    return satellite.no2Anomaly;
  }
  if (satellite.selectedChannel === "fireDustSmoke" && satellite.aerosolIndexAnomaly != null) {
    return satellite.aerosolIndexAnomaly;
  }
  if (
    satellite.selectedChannel === "balanced" &&
    (satellite.no2Anomaly != null || satellite.aerosolIndexAnomaly != null)
  ) {
    return Math.max(satellite.no2Anomaly ?? 0, satellite.aerosolIndexAnomaly ?? 0);
  }

  return (
    satellite.anomalyScore ??
    satellite.hazardWeight ??
    Math.max(
      satellite.fireDustSmokeWeight ?? 0,
      satellite.industrialTrafficWeight ?? 0,
    )
  );
}

export function checkStoredSatelliteSupport(
  satellite: IncidentEvidence["satellite"] | null | undefined,
): boolean {
  return getStoredSatelliteAnomaly(satellite) >= SATELLITE_SUPPORT_SCORE;
}

/**
 * Decides which promotion tier (if any) a hotspot qualifies for.
 * Returns null if none of the promotion paths are satisfied yet.
 */
export function determineTier(input: {
  reportCount: number;
  sensorSupported: boolean;
  satelliteSupported: boolean;
}): PromotionTier | null {
  const { reportCount, sensorSupported, satelliteSupported } = input;

  if (sensorSupported && satelliteSupported) return "sensor_satellite_confirmed";
  if (reportCount >= CITIZEN_PROMOTION_THRESHOLD) return "crowd_verified";
  if (reportCount > 0 && sensorSupported) return "citizen_sensor_confirmed";
  if (reportCount > 0 && satelliteSupported) return "citizen_satellite_confirmed";
  if (reportCount === 0 && sensorSupported) return "sensor_detected";
  if (reportCount === 0 && satelliteSupported) return "satellite_detected";
  return null;
}

// Lower number = shown first in the Priority tab.
// Kept for anywhere that just needs a tier's general rank (e.g. labels/badges).
// The Priority tab itself uses `priorityRank` below, which also factors in
// citizen report count for crowd_verified incidents.
export const TIER_RANK: Record<PromotionTier, number> = {
  sensor_satellite_confirmed: 0,
  crowd_verified: 1,
  citizen_sensor_confirmed: 2,
  citizen_satellite_confirmed: 3,
  satellite_detected: 4,
  sensor_detected: 5,
};

// Report count at/above which a crowd_verified incident is treated as
// "overwhelming citizen consensus" and jumps ahead of sensor/satellite-only
// corroboration tiers in the Priority tab.
export const CROWD_OVERWHELMING_THRESHOLD = 5;

/**
 * Priority-tab specific ranking. Unlike TIER_RANK, this splits
 * crowd_verified into two bands based on report count:
 *
 *   1. sensor_satellite_confirmed
 *   2. crowd_verified, reportCount >= CROWD_OVERWHELMING_THRESHOLD ("overwhelming" citizen consensus)
 *   3. citizen_sensor_confirmed
 *   4. citizen_satellite_confirmed
 *   5. crowd_verified, reportCount < CROWD_OVERWHELMING_THRESHOLD (baseline 3-4 reports)
 *   6. satellite_detected
 *   7. sensor_detected
 *
 * Lower number = shown first. Incidents without a tier (shouldn't normally
 * reach the Priority tab, since it only shows promoted incidents) sort last.
 */
export function priorityRank(tier: PromotionTier | null | undefined, reportCount: number): number {
  if (!tier) return 99;

  if (tier === "crowd_verified") {
    return reportCount >= CROWD_OVERWHELMING_THRESHOLD ? 1 : 4;
  }

  switch (tier) {
    case "sensor_satellite_confirmed":
      return 0;
    case "citizen_sensor_confirmed":
      return 2;
    case "citizen_satellite_confirmed":
      return 3;
    case "satellite_detected":
      return 5;
    case "sensor_detected":
      return 6;
    default:
      return 99;
  }
}

export const TIER_LABELS: Record<PromotionTier, string> = {
  sensor_satellite_confirmed: "Sensor + Satellite confirmed",
  crowd_verified: "Crowd-verified",
  citizen_sensor_confirmed: "Citizen + Sensor confirmed",
  citizen_satellite_confirmed: "Citizen + Satellite confirmed",
  sensor_detected: "Sensor-detected",
  satellite_detected: "Satellite-detected",
};

export function tierPromotionReason(tier: PromotionTier, reportCount: number): string {
  switch (tier) {
    case "sensor_satellite_confirmed":
      return "Sensor and satellite readings independently confirmed this hazard in the same zone.";
    case "crowd_verified":
      return `${reportCount} citizen reports of the same hazard corroborated in the same H3 cell.`;
    case "citizen_sensor_confirmed":
      return "Citizen report corroborated by a nearby sensor crossing the pollution threshold.";
    case "citizen_satellite_confirmed":
      return "Citizen report corroborated by a satellite anomaly over the same area.";
    case "sensor_detected":
      return "Sensor reading crossed the pollution threshold; no citizen report yet.";
    case "satellite_detected":
      return "Satellite anomaly detected over this zone; no citizen report yet.";
    default:
      return "Waiting for corroboration before municipal alert.";
  }
}
