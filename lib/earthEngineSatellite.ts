import "server-only";

import * as ee from "@google/earthengine";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getH3CellId } from "@/lib/reportSubmissions";

const EE_KEY_PATH = path.join(process.cwd(), "credentials", "earth-engine-key.json");
const NO2_COLLECTION = "COPERNICUS/S5P/OFFL/L3_NO2";
const NO2_BAND = "tropospheric_NO2_column_number_density";
const AEROSOL_COLLECTION = "COPERNICUS/S5P/OFFL/L3_AER_AI";
const AEROSOL_BAND = "absorbing_aerosol_index";
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const CURRENT_WINDOW_DAYS = 3;
const BASELINE_WINDOW_DAYS = 90;
const SAMPLE_BUFFER_METERS = 1500;

// Scores compare the current 3-day median to the same point's previous
// 90-day median. A short current window reacts faster to acute events
// (e.g. a smog trap at a junction) while still smoothing over Sentinel-5P's
// cloud-cover/revisit gaps; the 120-day baseline stays long so slow-building
// hotspots (industrial clusters, recurring landfill fires) still register.
// NO2 reaches 1.0 at about +150% over local baseline; Aerosol
// Index reaches 1.0 at about +1.5 positive AI units over local baseline.
// Negative AI is intentionally treated as clean/no absorbing-aerosol signal.
// Chronic scores are retained as background context only. They must not count
// as independent satellite corroboration for a hyper-local event: otherwise a
// generally polluted week across Delhi upgrades nearly every sensor spike to
// "sensor + satellite" even when the local satellite anomaly is below threshold.
const NO2_FULL_ANOMALY_RATIO = 1.5;
const NO2_BASELINE_FLOOR = 0.00002;
const NO2_CHRONIC_HIGH = 0.00016;
const AEROSOL_FULL_ANOMALY_DELTA = 1.5;
const AEROSOL_CHRONIC_HIGH = 1.6;

type EarthEngineKey = {
  client_email?: string;
  private_key?: string;
  project_id?: string;
};

export type SatelliteDataResult = {
  rawValue: number | null;
  anomalyScore: number;
  no2: {
    baselineValue: number | null;
    rawValue: number | null;
    anomalyScore: number;
    chronicScore: number;
  };
  aerosolIndex: {
    baselineValue: number | null;
    rawValue: number | null;
    anomalyScore: number;
    chronicScore: number;
  };
  hazardWeights: {
    fireDustSmoke: number;
    industrialTraffic: number;
  };
  source: "Earth Engine / Sentinel-5P";
  computedAt: string;
  windowStart: string;
  windowEnd: string;
  timestamp: string;
  cached: boolean;
  cacheKey: string;
  error?: string;
};

type CacheEntry = {
  expiresAt: number;
  value: SatelliteDataResult;
};

const cache = new Map<string, CacheEntry>();
let initPromise: Promise<void> | null = null;

function getBaseCacheKey(lat: number, lng: number) {
  return getH3CellId({
    label: "Satellite sample",
    lat: String(lat),
    lng: String(lng),
  });
}

function getCacheKey(lat: number, lng: number, windowEndDate: string) {
  return `${getBaseCacheKey(lat, lng)}-${windowEndDate}`;
}

function clampScore(value: number) {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

function normalizeNo2Anomaly(rawValue: number | null, baselineValue: number | null) {
  if (rawValue === null || baselineValue === null) return 0;
  const denominator = Math.max(Math.abs(baselineValue), NO2_BASELINE_FLOOR);
  return clampScore((rawValue - baselineValue) / denominator / NO2_FULL_ANOMALY_RATIO);
}

function normalizeAerosolIndexAnomaly(
  rawValue: number | null,
  baselineValue: number | null,
) {
  if (rawValue === null || baselineValue === null) return 0;
  const positiveCurrent = Math.max(0, rawValue);
  const positiveBaseline = Math.max(0, baselineValue);
  return clampScore(
    (positiveCurrent - positiveBaseline) / AEROSOL_FULL_ANOMALY_DELTA,
  );
}

function normalizeNo2ChronicScore(rawValue: number | null) {
  if (rawValue === null) return 0;
  return clampScore(rawValue / NO2_CHRONIC_HIGH);
}

function normalizeAerosolChronicScore(rawValue: number | null) {
  if (rawValue === null) return 0;
  return clampScore(Math.max(0, rawValue) / AEROSOL_CHRONIC_HIGH);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string) {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out.`)), ms);
    }),
  ]);
}

function authenticateViaPrivateKey(key: EarthEngineKey) {
  return new Promise<void>((resolve, reject) => {
    ee.data.authenticateViaPrivateKey(
      key,
      () => resolve(),
      (error: unknown) =>
        reject(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

function initializeEarthEngine(projectId?: string) {
  return new Promise<void>((resolve, reject) => {
    ee.initialize(
      null,
      null,
      () => resolve(),
      (error: unknown) =>
        reject(error instanceof Error ? error : new Error(String(error))),
      null,
      projectId,
    );
  });
}

async function ensureEarthEngineReady() {
  if (!initPromise) {
    initPromise = (async () => {
      const key = JSON.parse(await readFile(EE_KEY_PATH, "utf8")) as EarthEngineKey;
      if (!key.client_email || !key.private_key) {
        throw new Error("Earth Engine service account key is missing required fields.");
      }

      await authenticateViaPrivateKey(key);
      await initializeEarthEngine(key.project_id);
    })().catch((error) => {
      initPromise = null;
      throw error;
    });
  }

  return initPromise;
}

function getInfo<T>(eeObject: {
  getInfo: (success: (value: T) => void, error: (error: unknown) => void) => void;
}) {
  return new Promise<T>((resolve, reject) => {
    eeObject.getInfo(
      (value: T) => resolve(value),
      (error: unknown) =>
        reject(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

function buildFallback(
  cacheKey: string,
  error: string,
  windowStart: string,
  windowEnd: string,
): SatelliteDataResult {
  const computedAt = new Date().toISOString();
  return {
    rawValue: null,
    anomalyScore: 0,
    no2: {
      baselineValue: null,
      rawValue: null,
      anomalyScore: 0,
      chronicScore: 0,
    },
    aerosolIndex: {
      baselineValue: null,
      rawValue: null,
      anomalyScore: 0,
      chronicScore: 0,
    },
    hazardWeights: {
      fireDustSmoke: 0,
      industrialTraffic: 0,
    },
    source: "Earth Engine / Sentinel-5P",
    computedAt,
    windowStart,
    windowEnd,
    timestamp: computedAt,
    cached: false,
    cacheKey,
    error,
  };
}

async function reduceMedianBand(
  collectionId: string,
  band: string,
  region: unknown,
  startDate: string,
  endDate: string,
  label: string,
) {
  const composite = ee
    .ImageCollection(collectionId)
    .select(band)
    .filterDate(startDate, endDate)
    .filterBounds(region)
    .median();

  const reduction = composite.reduceRegion({
    reducer: ee.ApiFunction._call("Reducer.mean"),
    geometry: region,
    scale: 1113,
    maxPixels: 1e9,
  });

  const raw = await withTimeout(
    getInfo<number | null>(reduction.get(band)),
    REQUEST_TIMEOUT_MS,
    `Earth Engine ${label} reduction`,
  );

  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

export async function getSatelliteDataForPoint(
  lat: number,
  lng: number,
  referenceTime: Date = new Date(),
): Promise<SatelliteDataResult> {
  const end = Number.isFinite(referenceTime.getTime()) ? referenceTime : new Date();
  const endDate = end.toISOString().slice(0, 10);
  const currentStart = new Date(
    end.getTime() - CURRENT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const currentStartDate = currentStart.toISOString().slice(0, 10);
  const cacheKey = getCacheKey(lat, lng, endDate);
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.value, cached: true };
  }

  try {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error("lat and lng must be valid numbers.");
    }

    await withTimeout(ensureEarthEngineReady(), REQUEST_TIMEOUT_MS, "Earth Engine auth");

    const baselineStart = new Date(
      currentStart.getTime() - BASELINE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const baselineStartDate = baselineStart.toISOString().slice(0, 10);

    const region = ee.Geometry.Point([lng, lat]).buffer(SAMPLE_BUFFER_METERS);
    const [no2Raw, no2Baseline, aerosolRaw, aerosolBaseline] = await Promise.all([
      reduceMedianBand(
        NO2_COLLECTION,
        NO2_BAND,
        region,
        currentStartDate,
        endDate,
        "NO2 current",
      ),
      reduceMedianBand(
        NO2_COLLECTION,
        NO2_BAND,
        region,
        baselineStartDate,
        currentStartDate,
        "NO2 baseline",
      ),
      reduceMedianBand(
        AEROSOL_COLLECTION,
        AEROSOL_BAND,
        region,
        currentStartDate,
        endDate,
        "Aerosol Index current",
      ),
      reduceMedianBand(
        AEROSOL_COLLECTION,
        AEROSOL_BAND,
        region,
        baselineStartDate,
        currentStartDate,
        "Aerosol Index baseline",
      ),
    ]);

    if (no2Raw === null && aerosolRaw === null) {
      throw new Error(
        "Earth Engine returned no unmasked NO2 or Aerosol Index value for this area.",
      );
    }

    const no2Anomaly = normalizeNo2Anomaly(no2Raw, no2Baseline);
    const aerosolAnomaly = normalizeAerosolIndexAnomaly(
      aerosolRaw,
      aerosolBaseline,
    );
    const no2Chronic = normalizeNo2ChronicScore(no2Raw);
    const aerosolChronic = normalizeAerosolChronicScore(aerosolRaw);
    const industrialTrafficWeight = no2Anomaly;
    const fireDustSmokeWeight = aerosolAnomaly;
    const anomalyScore = Math.max(industrialTrafficWeight, fireDustSmokeWeight);
    const computedAt = new Date().toISOString();
    const value: SatelliteDataResult = {
      rawValue: no2Raw,
      anomalyScore,
      no2: {
        baselineValue: no2Baseline,
        rawValue: no2Raw,
        anomalyScore: no2Anomaly,
        chronicScore: no2Chronic,
      },
      aerosolIndex: {
        baselineValue: aerosolBaseline,
        rawValue: aerosolRaw,
        anomalyScore: aerosolAnomaly,
        chronicScore: aerosolChronic,
      },
      hazardWeights: {
        fireDustSmoke: fireDustSmokeWeight,
        industrialTraffic: industrialTrafficWeight,
      },
      source: "Earth Engine / Sentinel-5P",
      computedAt,
      windowStart: currentStartDate,
      windowEnd: endDate,
      timestamp: computedAt,
      cached: false,
      cacheKey,
    };

    cache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      value,
    });

    return value;
  } catch (error) {
    return buildFallback(
      cacheKey,
      error instanceof Error ? error.message : "Unknown Earth Engine error.",
      currentStartDate,
      endDate,
    );
  }
}
