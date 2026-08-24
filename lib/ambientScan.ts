import "server-only";

import { adminDb, adminServerTimestamp } from "@/lib/firebaseAdmin";
import type { NearbyStationReading } from "@/lib/cpcbSensor";
import { fetchAllStationReadings, getNearestStationReading, getPrimaryPollutant } from "@/lib/cpcbSensor";
import type { SatelliteDataResult } from "@/lib/earthEngineSatellite";
import { getSatelliteDataForPoint } from "@/lib/earthEngineSatellite";
import { computeFusionConfidence, satelliteWeightToScore, sensorDeltaToScore } from "@/lib/fusionConfidence";
import { isInOperationalRegion } from "@/lib/operationalRegion";
import { getH3CellId, getSeverity } from "@/lib/reportSubmissions";
import {
  SENSOR_PROXIMITY_KM,
  SENSOR_EXTREME_DELTA_PCT,
  SENSOR_LOCAL_BASELINE_DELTA_PCT,
  SENSOR_SUPPORT_DELTA_PCT,
  SATELLITE_SUPPORT_SCORE,
  determineTier,
  isDustDominant,
  isSensorReadingFresh,
  tierPromotionReason,
} from "@/lib/supportEvidence";
import type { HazardType } from "@/lib/types";

export type SensorSupportResult = {
  supported: boolean;
  immediate: boolean;
  pollutantName: string;
  pollutantValue: number | null;
  deltaPct: number;
  distanceKm: number | null;
  lastUpdated?: string | null;
  localBaselineValue?: number | null;
  localBaselineDeltaPct?: number | null;
  cityBaselineValue?: number | null;
  cityBaselineDeltaPct?: number | null;
  watchThreshold?: number;
  incidentThreshold?: number;
  baselineSource?: "station_history" | "delhi_median";
};

export type SatelliteSupportResult = {
  supported: boolean;
  hazardWeight: number;
};

/**
 * Which satellite band is relevant for which hazard.
 * - dust / particulate -> aerosol index (particulate-driven, "fireDustSmoke" weight)
 * - industrial / smog / fire -> NO2 or aerosol depending on channel (see below)
 *
 * "particulate" takes over the aerosol-index channel that used to be split
 * across separate "fire" and "smog" checks — see the HAZARD_TYPES comment
 * below for why those two were merged.
 */
export function getSatelliteHazardWeight(
  hazardType: HazardType,
  satellite: Pick<SatelliteDataResult, "aerosolIndex" | "no2"> | null | undefined,
): number {
  if (!satellite) return 0;
  if (hazardType === "dust" || hazardType === "fire" || hazardType === "particulate") {
    return satellite.aerosolIndex.anomalyScore;
  }
  return satellite.no2.anomalyScore;
}

export function checkSensorSupport(
  hazardType: HazardType,
  station: Partial<NearbyStationReading> | null | undefined,
  geminiType?: string,
): SensorSupportResult {
  if (!station) {
    return { supported: false, immediate: false, pollutantName: "PM2.5", pollutantValue: null, deltaPct: 0, distanceKm: null };
  }

  const distanceKm = station.distanceKm ?? null;
  if (distanceKm === null || distanceKm > SENSOR_PROXIMITY_KM) {
    return {
      supported: false,
      immediate: false,
      pollutantName: "PM2.5",
      pollutantValue: null,
      deltaPct: 0,
      distanceKm,
      lastUpdated: station.lastUpdated,
    };
  }

  if (!isSensorReadingFresh(station.lastUpdated)) {
    return {
      supported: false,
      immediate: false,
      pollutantName: "PM2.5",
      pollutantValue: null,
      deltaPct: 0,
      distanceKm,
      lastUpdated: station.lastUpdated,
    };
  }

  // getPrimaryPollutant already maps hazard -> the right pollutant:
  // dust -> PM10, industrial -> NO2/SO2, particulate/fire/smog -> PM2.5
  // (getPrimaryPollutant only special-cases "dust" and "industrial";
  // everything else — including our new "particulate" bucket — falls
  // through to its PM2.5 default, which is exactly what we want here).
  const primary = getPrimaryPollutant(geminiType ?? hazardType, station);
  let supported = primary.value !== null && primary.delta >= SENSOR_SUPPORT_DELTA_PCT;

  // PM10 alone can't tell dust apart from an ordinary bad-air day (PM10
  // rises on both) — require the PM10:PM2.5 ratio to actually look
  // dust-like, not just "PM10 crossed a number".
  if (supported && hazardType === "dust" && !isDustDominant(station.pm10, station.pm25)) {
    supported = false;
  }

  return {
    supported,
    immediate: false,
    pollutantName: primary.name,
    pollutantValue: primary.value,
    deltaPct: primary.delta,
    distanceKm,
    lastUpdated: station.lastUpdated,
  };
}

export function checkSatelliteSupport(
  hazardType: HazardType,
  satellite: SatelliteDataResult | null | undefined,
): SatelliteSupportResult {
  if (!satellite || satellite.error) return { supported: false, hazardWeight: 0 };
  const hazardWeight = getSatelliteHazardWeight(hazardType, satellite);
  return { supported: hazardWeight >= SATELLITE_SUPPORT_SCORE, hazardWeight };
}

// Extra known NCR pollution-prone zones. The primary ambient scan now walks
// every available CPCB station; this list only fills satellite-only gaps in
// places where there is no station cell.
export const MONITORED_CELLS: Array<{ label: string; lat: number; lng: number }> = [
  { label: "Anand Vihar", lat: 28.6469, lng: 77.3152 },
  { label: "Wazirpur Industrial Area", lat: 28.7041, lng: 77.1653 },
  { label: "ITO Crossing", lat: 28.6292, lng: 77.241 },
  { label: "Mundka", lat: 28.6822, lng: 77.031 },
  { label: "Okhla Industrial Area", lat: 28.5355, lng: 77.291 },
  { label: "RK Puram", lat: 28.5651, lng: 77.1815 },
  { label: "Rohini", lat: 28.7346, lng: 77.1177 },
  { label: "Naraina Industrial Area", lat: 28.6285, lng: 77.1409 },
  { label: "Ghazipur Landfill", lat: 28.6264, lng: 77.3192 },
  { label: "Bawana Industrial Area", lat: 28.8039, lng: 77.0469 },
];

// Ambient (sensor/satellite-only, zero citizen reports) detection can only
// test 3 real, independent hypotheses — not 4. "fire" and "smog" both
// resolved to the exact same underlying test (PM2.5 delta + aerosol index
// anomaly), so testing them separately meant a single elevated PM2.5/AI
// reading would cross both thresholds at once and stack two near-identical
// pins on the same spot. A CPCB PM2.5 sensor or a Sentinel-5P aerosol
// reading can't tell a fire apart from general haze/smog without a photo —
// only Gemini looking at an actual citizen-submitted image can make that
// call (see resolveIncidentHazardType in firestoreReports.ts). So ambient
// scan reports the honest, source-agnostic "particulate" bucket instead;
// once a citizen report comes in for the same cell, promoteCellIfThreshold
// Passed will resolve it to a specific fire/smog hazardType from the photo.
//
// We run all three checks per station/cell, collect whichever ones fired into
// possibleSources, then write ONE doc per cell — not one per hazard — so
// a single map pin shows the full picture rather than 2-3 overlapping pins.
const HAZARD_TYPES: HazardType[] = ["dust", "industrial", "particulate"];
const SINGLE_SOURCE_AMBIENT_CONFIDENCE_CAP = 78;
const AMBIENT_NO_SUPPORT_GRACE_HOURS = 24;
const MAX_AMBIENT_INCIDENTS = 20;

// Priority order for picking the single hazardType that drives the map icon
// color when multiple checks fire. industrial > dust > particulate keeps the
// most specific/actionable type on top.
const HAZARD_PRIORITY: HazardType[] = ["industrial", "dust", "particulate"];

export type AmbientScanResult = {
  cell: string;
  hazardType: HazardType;
  tier: "sensor_detected" | "satellite_detected" | "sensor_satellite_confirmed";
  h3CellId: string;
};

export type AmbientWatchResult = {
  cell: string;
  consecutiveObservations: number;
  hazardType: HazardType;
  h3CellId: string;
  requiredObservations: number;
};

type AmbientScanTarget = {
  label: string;
  lat: number;
  lng: number;
  station: NearbyStationReading | null;
};

type CandidateResult = {
  confidence: number;
  consecutiveObservations: number;
  dominant: {
    hazardType: HazardType;
    sensorResult: ReturnType<typeof checkSensorSupport>;
    satelliteResult: ReturnType<typeof checkSatelliteSupport>;
    tier: "sensor_detected" | "satellite_detected" | "sensor_satellite_confirmed";
  };
  h3CellId: string;
  passedChecks: Array<{
    hazardType: HazardType;
    sensorResult: ReturnType<typeof checkSensorSupport>;
    satelliteResult: ReturnType<typeof checkSatelliteSupport>;
    tier: "sensor_detected" | "satellite_detected" | "sensor_satellite_confirmed";
  }>;
  fusion: ReturnType<typeof computeFusionConfidence>;
  satellite: SatelliteDataResult | null;
  target: AmbientScanTarget;
};

type SensorBaseline = {
  pm25: number | null;
  pm10: number | null;
  no2: number | null;
  so2: number | null;
};

type SensorHistorySample = SensorBaseline & {
  observedAt: string;
  sourceUpdatedAt: string | null;
};

const SENSOR_BASELINE_WINDOW_DAYS = 7;
const SENSOR_BASELINE_MIN_SAMPLES = 3;
const SENSOR_BASELINE_MAX_SAMPLES = 56;
const SATELLITE_SCAN_CONCURRENCY = 4;
const REQUIRED_CONSECUTIVE_OBSERVATIONS = 2;
const MAX_OBSERVATION_GAP_HOURS = 6;

// Indian AQI concentration breakpoints (µg/m³). A single reading in the
// "Poor" band can open an incident immediately. A "Moderate" reading must
// also be anomalous and persist across two independently timestamped source
// observations. This is more defensible than applying one arbitrary +50%
// multiplier to pollutants with very different health-response curves.
const AMBIENT_SENSOR_THRESHOLDS: Record<
  "PM2.5" | "PM10" | "NO2" | "SO2",
  { watch: number; incident: number }
> = {
  "PM2.5": { watch: 61, incident: 91 },
  PM10: { watch: 101, incident: 251 },
  NO2: { watch: 81, incident: 181 },
  SO2: { watch: 81, incident: 381 },
};

function median(values: Array<number | null | undefined>) {
  const usable = values
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (usable.length === 0) return null;
  const middle = Math.floor(usable.length / 2);
  return usable.length % 2 === 0
    ? (usable[middle - 1] + usable[middle]) / 2
    : usable[middle];
}

function buildDelhiMedianBaseline(targets: AmbientScanTarget[]): SensorBaseline {
  const stations = targets
    .map((target) => target.station)
    .filter((station): station is NearbyStationReading => station !== null);

  return {
    pm25: median(stations.map((station) => station.pm25)),
    pm10: median(stations.map((station) => station.pm10)),
    no2: median(stations.map((station) => station.no2)),
    so2: median(stations.map((station) => station.so2)),
  };
}

function parseSensorHistory(value: unknown): SensorHistorySample[] {
  if (!Array.isArray(value)) return [];
  const cutoffMs = Date.now() - SENSOR_BASELINE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  return value
    .filter((sample): sample is Record<string, unknown> => !!sample && typeof sample === "object")
    .map((sample) => ({
      observedAt: typeof sample.observedAt === "string" ? sample.observedAt : "",
      sourceUpdatedAt: typeof sample.sourceUpdatedAt === "string" ? sample.sourceUpdatedAt : null,
      pm25: typeof sample.pm25 === "number" ? sample.pm25 : null,
      pm10: typeof sample.pm10 === "number" ? sample.pm10 : null,
      no2: typeof sample.no2 === "number" ? sample.no2 : null,
      so2: typeof sample.so2 === "number" ? sample.so2 : null,
    }))
    .filter((sample) => Date.parse(sample.observedAt) >= cutoffMs);
}

function historyMedian(samples: SensorHistorySample[], key: keyof SensorBaseline) {
  const values = samples.map((sample) => sample[key]);
  return values.filter((value) => value !== null).length >= SENSOR_BASELINE_MIN_SAMPLES
    ? median(values)
    : null;
}

async function getSensorBaselineAndRecord(
  h3CellId: string,
  station: NearbyStationReading | null,
  delhiMedian: SensorBaseline,
): Promise<{ baseline: SensorBaseline; source: "station_history" | "delhi_median" }> {
  if (!station) return { baseline: delhiMedian, source: "delhi_median" };

  const baselineRef = adminDb.collection("ambientSensorBaselines").doc(h3CellId);
  const baselineSnap = await baselineRef.get();
  const samples = parseSensorHistory(baselineSnap.data()?.samples);
  const stationBaseline: SensorBaseline = {
    pm25: historyMedian(samples, "pm25"),
    pm10: historyMedian(samples, "pm10"),
    no2: historyMedian(samples, "no2"),
    so2: historyMedian(samples, "so2"),
  };
  const hasStationHistory = Object.values(stationBaseline).some((value) => value !== null);
  const baseline: SensorBaseline = {
    pm25: stationBaseline.pm25 ?? delhiMedian.pm25,
    pm10: stationBaseline.pm10 ?? delhiMedian.pm10,
    no2: stationBaseline.no2 ?? delhiMedian.no2,
    so2: stationBaseline.so2 ?? delhiMedian.so2,
  };

  const alreadyRecorded = samples.some(
    (sample) =>
      station.lastUpdated !== null && sample.sourceUpdatedAt === station.lastUpdated,
  );
  if (!alreadyRecorded) {
    const nextSample: SensorHistorySample = {
      observedAt: new Date().toISOString(),
      sourceUpdatedAt: station.lastUpdated,
      pm25: station.pm25,
      pm10: station.pm10,
      no2: station.no2,
      so2: station.so2,
    };
    await baselineRef.set(
      {
        samples: [...samples, nextSample].slice(-SENSOR_BASELINE_MAX_SAMPLES),
        stationName: station.stationName,
        updatedAt: adminServerTimestamp(),
      },
      { merge: true },
    );
  }

  return {
    baseline,
    source: hasStationHistory ? "station_history" : "delhi_median",
  };
}

function getBaselineValue(pollutantName: string, baseline: SensorBaseline) {
  if (pollutantName === "PM10") return baseline.pm10;
  if (pollutantName === "NO2") return baseline.no2;
  if (pollutantName === "SO2") return baseline.so2;
  return baseline.pm25;
}

function getAmbientSensorThresholds(pollutantName: string) {
  return (
    AMBIENT_SENSOR_THRESHOLDS[pollutantName as keyof typeof AMBIENT_SENSOR_THRESHOLDS] ??
    AMBIENT_SENSOR_THRESHOLDS["PM2.5"]
  );
}

function applyAmbientSensorThreshold(
  hazardType: HazardType,
  sensorResult: SensorSupportResult,
  station: NearbyStationReading | null,
  baseline: SensorBaseline,
  baselineSource: "station_history" | "delhi_median",
  cityBaseline: SensorBaseline,
): SensorSupportResult {
  const localBaselineValue = getBaselineValue(sensorResult.pollutantName, baseline);
  const cityBaselineValue = getBaselineValue(sensorResult.pollutantName, cityBaseline);
  const localBaselineDeltaPct =
    sensorResult.pollutantValue !== null && localBaselineValue !== null && localBaselineValue > 0
      ? Math.round(
          ((sensorResult.pollutantValue - localBaselineValue) / localBaselineValue) * 100,
        )
      : null;
  const cityBaselineDeltaPct =
    sensorResult.pollutantValue !== null && cityBaselineValue !== null && cityBaselineValue > 0
      ? Math.round(
          ((sensorResult.pollutantValue - cityBaselineValue) / cityBaselineValue) * 100,
        )
      : null;
  const extreme = sensorResult.deltaPct >= SENSOR_EXTREME_DELTA_PCT;
  const locallyElevated =
    localBaselineDeltaPct !== null &&
    localBaselineDeltaPct >= SENSOR_LOCAL_BASELINE_DELTA_PCT;
  const citywideHotspot =
    cityBaselineDeltaPct !== null &&
    cityBaselineDeltaPct >= SENSOR_LOCAL_BASELINE_DELTA_PCT;
  const thresholds = getAmbientSensorThresholds(sensorResult.pollutantName);
  const meetsWatchThreshold =
    sensorResult.pollutantValue !== null &&
    sensorResult.pollutantValue >= thresholds.watch;
  const immediate =
    sensorResult.pollutantValue !== null &&
    sensorResult.pollutantValue >= thresholds.incident;
  const sourceSpecificEnough =
    hazardType !== "dust" || isDustDominant(station?.pm10, station?.pm25);

  return {
    ...sensorResult,
    // A persistent hotspot can become its own station-history baseline. It
    // still needs to surface when it is materially worse than Delhi overall;
    // otherwise severe but chronic readings are incorrectly normalized away.
    supported:
      sourceSpecificEnough &&
      meetsWatchThreshold &&
      (immediate || extreme || locallyElevated || citywideHotspot),
    immediate,
    baselineSource,
    cityBaselineDeltaPct,
    cityBaselineValue,
    localBaselineDeltaPct,
    localBaselineValue,
    incidentThreshold: thresholds.incident,
    watchThreshold: thresholds.watch,
  };
}

function timestampLikeToMs(value: unknown): number | null {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "object" && "toDate" in value) {
    const date = (value as { toDate?: () => Date }).toDate?.();
    return date && Number.isFinite(date.getTime()) ? date.getTime() : null;
  }
  return null;
}

function getAmbientEvidenceKey(
  target: AmbientScanTarget,
  satellite: SatelliteDataResult | null,
  passedChecks: CandidateResult["passedChecks"],
) {
  const hasSensorSupport = passedChecks.some((check) => check.sensorResult.supported);
  const hasSatelliteSupport = passedChecks.some((check) => check.satelliteResult.supported);
  const sensorVersion = hasSensorSupport
    ? (target.station?.lastUpdated ?? "sensor-unknown")
    : "no-sensor";
  const satelliteVersion = hasSatelliteSupport
    ? `${satellite?.windowEnd ?? "satellite-unknown"}:${satellite?.rawValue ?? "null"}:${
        satellite?.aerosolIndex.rawValue ?? "null"
      }`
    : "no-satellite";

  return `${sensorVersion}|${satelliteVersion}`;
}

function shouldResolveUnsupportedAmbientIncident(data: Record<string, unknown>) {
  const unsupportedSinceMs = timestampLikeToMs(data.ambientUnsupportedSince);
  if (unsupportedSinceMs === null) return false;
  return Date.now() - unsupportedSinceMs >= AMBIENT_NO_SUPPORT_GRACE_HOURS * 60 * 60 * 1000;
}

function meetsAmbientSensorThreshold(
  _hazardType: HazardType,
  sensorResult: ReturnType<typeof checkSensorSupport>,
) {
  return sensorResult.supported;
}

function ambientCandidateRank(candidate: CandidateResult) {
  if (candidate.dominant.tier === "sensor_satellite_confirmed") return 0;
  if (candidate.dominant.tier === "satellite_detected") return 1;
  return 2;
}

async function resolveInactiveAmbientDocs(activeH3CellIds: Set<string>) {
  const snapshot = await adminDb.collection("incidents").get();
  await Promise.all(
    snapshot.docs.map(async (incidentDoc) => {
      if (!incidentDoc.id.startsWith("ambient-")) return;
      const h3CellId = incidentDoc.id.replace(/^ambient-/, "");
      const data = incidentDoc.data();
      if (activeH3CellIds.has(h3CellId) || data.status === "resolved") return;

      await incidentDoc.ref.update({
        status: "resolved",
        "validation.alertReason":
          "Automatically hidden because stronger Delhi station hotspots are currently higher priority.",
        "validation.alertTier": false,
        "validation.promotionReason": "Below current ambient top-hotspot cutoff.",
      });
    }),
  );
}

async function getAmbientScanTargets(): Promise<AmbientScanTarget[]> {
  const stationTargets = (await fetchAllStationReadings())
    .filter((station) => isInOperationalRegion(station.lat, station.lng))
    .map((station) => ({
      label: station.stationName,
      lat: station.lat,
      lng: station.lng,
      station,
    }));

  const targetsByCell = new Map<string, AmbientScanTarget>();
  for (const target of stationTargets) {
    const h3CellId = getH3CellId({
      label: target.label,
      lat: String(target.lat),
      lng: String(target.lng),
    });
    const existing = targetsByCell.get(h3CellId);
    if (!existing || (target.station.lastUpdated ?? "") > (existing.station?.lastUpdated ?? "")) {
      targetsByCell.set(h3CellId, target);
    }
  }

  for (const cell of MONITORED_CELLS) {
    if (!isInOperationalRegion(cell.lat, cell.lng)) continue;
    const h3CellId = getH3CellId({
      label: cell.label,
      lat: String(cell.lat),
      lng: String(cell.lng),
    });
    if (!targetsByCell.has(h3CellId)) {
      targetsByCell.set(h3CellId, {
        label: cell.label,
        lat: cell.lat,
        lng: cell.lng,
        station: await getNearestStationReading(cell.lat, cell.lng).catch(() => null),
      });
    }
  }

  return [...targetsByCell.values()];
}

function getTargetH3CellId(target: AmbientScanTarget) {
  return getH3CellId({
    label: target.label,
    lat: String(target.lat),
    lng: String(target.lng),
  });
}

async function fetchSatelliteForTargets(targets: AmbientScanTarget[]) {
  const results = new Map<string, SatelliteDataResult | null>();
  let nextIndex = 0;
  const workerCount = Math.min(SATELLITE_SCAN_CONCURRENCY, targets.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < targets.length) {
        const targetIndex = nextIndex;
        nextIndex += 1;
        const target = targets[targetIndex];
        const satellite = await getSatelliteDataForPoint(target.lat, target.lng).catch(
          () => null,
        );
        results.set(getTargetH3CellId(target), satellite);
      }
    }),
  );

  return results;
}

export async function scanAmbientHotspots(): Promise<{
  scanned: number;
  promoted: AmbientScanResult[];
  watching: AmbientWatchResult[];
}> {
  const candidates: CandidateResult[] = [];
  const watching: AmbientWatchResult[] = [];
  const targets = await getAmbientScanTargets();
  const delhiMedianBaseline = buildDelhiMedianBaseline(targets);
  const satelliteByCell = await fetchSatelliteForTargets(targets);

  for (const target of targets) {
    const h3CellId = getTargetH3CellId(target);
    const station = target.station;
    const sensorBaseline = await getSensorBaselineAndRecord(
      h3CellId,
      station,
      delhiMedianBaseline,
    );

    // Run all three checks and collect results — we write ONE doc per cell,
    // not one per hazard, to avoid stacking 2-3 markers on the same spot.
    const incidentRef = adminDb.collection("incidents").doc(`ambient-${h3CellId}`);
    type CheckResult = {
      hazardType: HazardType;
      sensorResult: ReturnType<typeof checkSensorSupport>;
      satelliteResult: ReturnType<typeof checkSatelliteSupport>;
      tier: "sensor_detected" | "satellite_detected" | "sensor_satellite_confirmed";
    };
    const passedChecks: CheckResult[] = [];
    const sensorResultsByHazard = new Map<HazardType, ReturnType<typeof checkSensorSupport>>();

    for (const hazardType of HAZARD_TYPES) {
      const sensorResult = applyAmbientSensorThreshold(
        hazardType,
        checkSensorSupport(hazardType, station),
        station,
        sensorBaseline.baseline,
        sensorBaseline.source,
        delhiMedianBaseline,
      );
      sensorResultsByHazard.set(hazardType, sensorResult);
    }

    // Satellite is an independent detection path, not merely a sensor
    // corroborator. Evaluate every Delhi target so a valid Sentinel-5P
    // anomaly can surface even when the nearby CPCB reading is below its
    // promotion threshold. Earth Engine responses remain cached per H3 cell.
    const satellite = satelliteByCell.get(h3CellId) ?? null;

    for (const hazardType of HAZARD_TYPES) {
      const sensorResult = sensorResultsByHazard.get(hazardType) ??
        checkSensorSupport(hazardType, station);
      const satelliteResult = checkSatelliteSupport(hazardType, satellite);
      const sensorSupported = meetsAmbientSensorThreshold(hazardType, sensorResult);
      const tier = determineTier({
        reportCount: 0,
        sensorSupported,
        satelliteSupported: satelliteResult.supported,
      });

      if (
        tier === "sensor_detected" ||
        tier === "satellite_detected" ||
        tier === "sensor_satellite_confirmed"
      ) {
        passedChecks.push({ hazardType, sensorResult, satelliteResult, tier });
      }
    }

    const detectionStateRef = adminDb.collection("ambientDetectionState").doc(h3CellId);
    const [existingSnap, detectionStateSnap] = await Promise.all([
      incidentRef.get(),
      detectionStateRef.get(),
    ]);
    const detectionState = detectionStateSnap.data();

    // Nothing triggered for this cell anymore. Do not resolve immediately:
    // public CPCB feeds can lag or temporarily omit pollutants, so one weak
    // scan should not make the Delhi auto-detection layer collapse.
    if (passedChecks.length === 0) {
      if ((detectionState?.consecutiveObservations ?? 0) > 0) {
        await detectionStateRef.set(
          {
            consecutiveObservations: 0,
            status: "clear",
            updatedAt: adminServerTimestamp(),
          },
          { merge: true },
        );
      }
      const existingData = existingSnap.data();
      if (!existingSnap.exists || !existingData || existingData.status === "resolved") {
        continue;
      }

      if (shouldResolveUnsupportedAmbientIncident(existingData)) {
        await incidentRef.update({
          status: "resolved",
          "validation.alertReason":
            "Automatically resolved because sensor/satellite evidence stayed below detection thresholds across the grace window.",
          "validation.alertTier": false,
          "validation.promotionReason": "Ambient evidence no longer supports this hotspot.",
        });
      } else if (!existingData?.ambientUnsupportedSince) {
        await incidentRef.update({
          ambientUnsupportedSince: adminServerTimestamp(),
          updatedAt: adminServerTimestamp(),
          "validation.alertReason":
            "Current scan is below threshold; keeping the auto-detection visible until the next scan confirms it cleared.",
          "validation.promotionReason": "Awaiting one more ambient scan before resolving.",
        });
      }
      continue;
    }

    // Pick the single dominant hazardType for icon color (industrial > dust > particulate).
    const dominant =
      passedChecks.find((c) => c.hazardType === HAZARD_PRIORITY[0]) ??
      passedChecks.find((c) => c.hazardType === HAZARD_PRIORITY[1]) ??
      passedChecks[0];

    const evidenceKey = getAmbientEvidenceKey(target, satellite, passedChecks);
    const previousEvidenceKey =
      typeof detectionState?.lastEvidenceKey === "string"
        ? detectionState.lastEvidenceKey
        : null;
    const isNewObservation = evidenceKey !== previousEvidenceKey;
    const lastObservationMs = timestampLikeToMs(detectionState?.lastObservationAt);
    const observationGapIsValid =
      lastObservationMs !== null &&
      Date.now() - lastObservationMs <= MAX_OBSERVATION_GAP_HOURS * 60 * 60 * 1000;
    const previousConsecutive = Number(detectionState?.consecutiveObservations ?? 0);
    const consecutiveObservations = isNewObservation
      ? observationGapIsValid
        ? previousConsecutive + 1
        : 1
      : Math.max(1, previousConsecutive);
    const hasImmediateSensorEvidence = passedChecks.some(
      (check) => check.sensorResult.supported && check.sensorResult.immediate,
    );
    const hasIndependentPhysicalAgreement = passedChecks.some(
      (check) => check.tier === "sensor_satellite_confirmed",
    );
    const existingIncidentIsActive =
      existingSnap.exists && existingSnap.data()?.status !== "resolved";
    const confirmed =
      hasImmediateSensorEvidence ||
      hasIndependentPhysicalAgreement ||
      consecutiveObservations >= REQUIRED_CONSECUTIVE_OBSERVATIONS ||
      existingIncidentIsActive;

    if (isNewObservation || detectionState?.status !== (confirmed ? "confirmed" : "watch")) {
      await detectionStateRef.set(
        {
          consecutiveObservations,
          hazardType: dominant.hazardType,
          lastEvidenceKey: evidenceKey,
          ...(isNewObservation ? { lastObservationAt: adminServerTimestamp() } : {}),
          location: { label: target.label, lat: target.lat, lng: target.lng },
          status: confirmed ? "confirmed" : "watch",
          updatedAt: adminServerTimestamp(),
        },
        { merge: true },
      );
    }

    if (!confirmed) {
      watching.push({
        cell: target.label,
        consecutiveObservations,
        hazardType: dominant.hazardType,
        h3CellId,
        requiredObservations: REQUIRED_CONSECUTIVE_OBSERVATIONS,
      });
      continue;
    }

    const { sensorResult, satelliteResult, tier } = dominant;
    const hazardType = dominant.hazardType;

    // Real weighted fusion, not max(). Ambient detections genuinely have no
    // visual or corroboration evidence — those sources are omitted (null),
    // not zeroed, so the displayed weights honestly reflect only sensor and
    // satellite. This also fixes the "Visual 95%" mislabeling bug: with no
    // visualScore, fusion.visualWeight comes out to a real 0, and the UI
    // (CommandCenter.tsx) only renders a Visual line when that weight > 0.
    const fusion = computeFusionConfidence({
      corroborationScore: null,
      satelliteScore: satelliteResult.supported
        ? satelliteWeightToScore(satelliteResult.hazardWeight)
        : null,
      sensorScore: meetsAmbientSensorThreshold(hazardType, sensorResult)
        ? sensorDeltaToScore(sensorResult.deltaPct)
        : null,
      visualScore: null,
    });
    const singleSourceDetection =
      tier === "sensor_detected" || tier === "satellite_detected";
    const confidence = singleSourceDetection
      ? Math.min(fusion.finalConfidence, SINGLE_SOURCE_AMBIENT_CONFIDENCE_CAP)
      : fusion.finalConfidence;

    candidates.push({
      confidence,
      consecutiveObservations,
      dominant,
      fusion,
      h3CellId,
      passedChecks,
      satellite,
      target,
    });
  }

  const promoted: AmbientScanResult[] = [];
  const rankedCandidates = candidates.sort((a, b) => {
    const rankDelta = ambientCandidateRank(a) - ambientCandidateRank(b);
    if (rankDelta !== 0) return rankDelta;
    return b.confidence - a.confidence;
  });
  const topCandidates = rankedCandidates.slice(0, MAX_AMBIENT_INCIDENTS);
  const topCandidateIds = new Set(topCandidates.map((candidate) => candidate.h3CellId));
  await resolveInactiveAmbientDocs(topCandidateIds);

  for (const candidate of candidates) {
    if (topCandidateIds.has(candidate.h3CellId)) continue;
    const incidentRef = adminDb.collection("incidents").doc(`ambient-${candidate.h3CellId}`);
    const existingSnap = await incidentRef.get();
    const existingData = existingSnap.data();
    if (existingSnap.exists && existingData?.status !== "resolved") {
      await incidentRef.update({
        status: "resolved",
        "validation.alertReason":
          "Automatically hidden because stronger station hotspots are currently higher priority.",
        "validation.alertTier": false,
        "validation.promotionReason": "Below current ambient top-hotspot cutoff.",
      });
    }
  }

  for (const candidate of topCandidates) {
    const {
      confidence,
      consecutiveObservations,
      dominant,
      fusion,
      h3CellId,
      passedChecks,
      satellite,
      target,
    } = candidate;
    const { sensorResult, satelliteResult, tier } = dominant;
    const hazardType = dominant.hazardType;
    const incidentRef = adminDb.collection("incidents").doc(`ambient-${h3CellId}`);
    const existingSnap = await incidentRef.get();
    const possibleSources = passedChecks.map((c) => c.hazardType);
    const source: "sensor" | "satellite" =
      tier === "satellite_detected" ? "satellite" : "sensor";

    const triggerPollutants = passedChecks
      .filter((check) => meetsAmbientSensorThreshold(check.hazardType, check.sensorResult))
      .map((check) => ({
        deltaPct: check.sensorResult.deltaPct,
        name: check.sensorResult.pollutantName,
        value: check.sensorResult.pollutantValue,
      }))
      .filter(
        (pollutant, index, pollutants) =>
          pollutants.findIndex((candidate) => candidate.name === pollutant.name) === index,
      );
    const triggerLabel = triggerPollutants.length > 0
      ? `Trigger: ${triggerPollutants.map((pollutant) => pollutant.name).join(" · ")}`
      : satelliteResult.supported
        ? "Satellite anomaly detected"
        : "Sensor anomaly detected";

    const sharedPayload = {
      aiConfidence: Math.round(confidence),
      geminiClassification: {
        confidence: Math.round(confidence),
        description: `${triggerLabel} — ${tierPromotionReason(tier, 0)}`,
        severity: getSeverity(confidence),
        type: hazardType,
      },
      h3CellId,
      hazardLabel: triggerLabel,
      possibleSources,
      triggerPollutants,
      elevatedPollutants: {
        pm25: target.station?.pm25 ?? null,
        pm10: target.station?.pm10 ?? null,
        no2: target.station?.no2 ?? null,
        so2: target.station?.so2 ?? null,
      },
      location: { label: target.label, lat: String(target.lat), lng: String(target.lng) },
      photoUrl: "",
      source,
      status: "under_review",
      ambientUnsupportedSince: null,
      updatedAt: adminServerTimestamp(),
      validation: {
        alertReason: tierPromotionReason(tier, 0),
        alertTier: true,
        tier,
        citizenSignal: { averageConfidence: 0, reportCount: 0, windowMinutes: 0 },
        coverage: {
          label: sensorResult.distanceKm !== null ? `${sensorResult.distanceKm.toFixed(1)} km to nearest station` : "No nearby station",
          level: sensorResult.distanceKm !== null && sensorResult.distanceKm <= 1 ? "good" : "limited",
          nearestSensorKm: sensorResult.distanceKm ?? 5,
        },
        fusion: {
          coverageAdjusted: false,
          finalConfidence: Math.round(confidence),
          h3CellId,
          satelliteWeight: fusion.satelliteWeight,
          sensorWeight: fusion.sensorWeight,
          visualWeight: fusion.visualWeight,
        },
        promotionReason: tierPromotionReason(tier, 0),
        satellite: {
          freshness: satellite && !satellite.error ? "fresh" : "stale",
          computedAt: satellite?.computedAt,
          lastPassTime: satellite
            ? `window ${satellite.windowStart} to ${satellite.windowEnd}`
            : "unavailable",
          windowEnd: satellite?.windowEnd,
          windowStart: satellite?.windowStart,
          signal: satelliteResult.supported
            ? "Anomaly crosses hazard threshold"
            : "No decisive anomaly",
          source: "Earth Engine",
          anomalyScore: satelliteResult.hazardWeight,
          hazardWeight: satelliteResult.hazardWeight,
        },
        sensor: {
          pm25Delta: sensorResult.pollutantName === "PM2.5" ? sensorResult.deltaPct : 0,
          primaryDelta: sensorResult.deltaPct,
          primaryName: sensorResult.pollutantName,
          primaryValue: sensorResult.pollutantValue,
          localBaselineDeltaPct: sensorResult.localBaselineDeltaPct,
          localBaselineValue: sensorResult.localBaselineValue,
          cityBaselineDeltaPct: sensorResult.cityBaselineDeltaPct,
          cityBaselineValue: sensorResult.cityBaselineValue,
          consecutiveObservations,
          immediate: sensorResult.immediate,
          incidentThreshold: sensorResult.incidentThreshold,
          watchThreshold: sensorResult.watchThreshold,
          baselineSource: sensorResult.baselineSource,
          distanceKm: sensorResult.distanceKm ?? undefined,
          lastUpdated: sensorResult.lastUpdated ?? undefined,
          source: "CPCB",
          trend: sensorResult.supported ? "rising" : "flat",
        },
      },
    };

    if (existingSnap.exists) {
      // Doc already exists — update in place, preserving the original createdAt
      // so the "Age" displayed in the Command Center reflects when pollution
      // was FIRST detected, not when this scan last ran.
      await incidentRef.update(sharedPayload);
    } else {
      // Brand new detection — set createdAt for the first and only time.
      await incidentRef.set({ ...sharedPayload, createdAt: adminServerTimestamp() });
    }

    promoted.push({ cell: target.label, hazardType, tier, h3CellId });
  }

  return { scanned: targets.length, promoted, watching };
}
