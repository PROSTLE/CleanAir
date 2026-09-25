import "server-only";

import * as ee from "@google/earthengine";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getH3CellId, haversineKm } from "@/lib/geo";

const EE_KEY_PATH = path.join(process.cwd(), "credentials", "earth-engine-key.json");
// Near-real-time products appear within hours of the overpass; the offline
// (OFFL) reprocessing lags by days. The *current* window reads NRTI so a
// report is compared against today's column, with OFFL as a fallback. The
// 90-day *baseline* keeps OFFL, which is the better-calibrated archive.
const NO2_CURRENT_COLLECTIONS = ["COPERNICUS/S5P/NRTI/L3_NO2", "COPERNICUS/S5P/OFFL/L3_NO2"];
const NO2_BASELINE_COLLECTION = "COPERNICUS/S5P/OFFL/L3_NO2";
const NO2_BAND = "tropospheric_NO2_column_number_density";
const AEROSOL_CURRENT_COLLECTIONS = ["COPERNICUS/S5P/NRTI/L3_AER_AI", "COPERNICUS/S5P/OFFL/L3_AER_AI"];
const AEROSOL_BASELINE_COLLECTION = "COPERNICUS/S5P/OFFL/L3_AER_AI";
const AEROSOL_BAND = "absorbing_aerosol_index";
// NASA FIRMS active-fire detections (MODIS), 1 km, published in Earth Engine.
const FIRMS_COLLECTION = "FIRMS";
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const FIRE_CACHE_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const FIRE_REQUEST_TIMEOUT_MS = 45_000;
const CURRENT_WINDOW_DAYS = 3;
const BASELINE_WINDOW_DAYS = 90;
const SAMPLE_BUFFER_METERS = 1500;
const FIRE_WINDOW_HOURS = 48;
const MAX_FIRE_POINTS = 800;

// Punjab + Haryana + Delhi NCR: the region whose crop-residue and waste fires
// drive Delhi's autumn smog episodes. [minLng, minLat, maxLng, maxLat]
export const FIRE_REGION_BOUNDS = [73.8, 27.8, 78.2, 32.6] as const;

// Scores compare the current 3-day median to the same point's previous
// 90-day median. A short current window reacts faster to acute events
// (e.g. a smog trap at a junction) while still smoothing over Sentinel-5P's
// cloud-cover/revisit gaps; the 90-day baseline stays long so slow-building
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
  /** Which collection produced the current-window value (NRTI or OFFL). */
  currentProduct: { no2: string | null; aerosolIndex: string | null };
  source: "Earth Engine / Sentinel-5P";
  computedAt: string;
  windowStart: string;
  windowEnd: string;
  timestamp: string;
  cached: boolean;
  cacheKey: string;
  error?: string;
};

export type FireHotspot = {
  lat: number;
  lng: number;
  /** MODIS band-21 brightness temperature (Kelvin). */
  brightnessK: number | null;
  /** FIRMS detection confidence, 0-100. */
  confidence: number | null;
};

export type FireHotspotResult = {
  fires: FireHotspot[];
  windowStart: string;
  windowEnd: string;
  bounds: typeof FIRE_REGION_BOUNDS;
  truncated: boolean;
  source: "NASA FIRMS via Earth Engine";
  computedAt: string;
  error?: string;
};

type CacheEntry = {
  expiresAt: number;
  value: SatelliteDataResult;
};

const cache = new Map<string, CacheEntry>();
let fireCache: { expiresAt: number; value: FireHotspotResult } | null = null;
let fireInFlight: Promise<FireHotspotResult> | null = null;
let initPromise: Promise<void> | null = null;

function getCacheKey(lat: number, lng: number, windowEndDate: string) {
  const cell =
    Number.isFinite(lat) && Number.isFinite(lng)
      ? getH3CellId({ lat, lng })
      : `invalid-${lat}-${lng}`;
  return `${cell}-${windowEndDate}`;
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
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`${label} timed out.`)), ms);
    }),
  ]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
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

/**
 * The service-account key comes from EARTH_ENGINE_SERVICE_ACCOUNT_KEY (raw
 * JSON or base64 — the form App Hosting / Secret Manager can inject), else
 * from the local, gitignored credentials/earth-engine-key.json used in dev.
 */
async function loadEarthEngineKey(): Promise<EarthEngineKey> {
  const fromEnv = process.env.EARTH_ENGINE_SERVICE_ACCOUNT_KEY?.trim();
  if (fromEnv) {
    const json = fromEnv.startsWith("{")
      ? fromEnv
      : Buffer.from(fromEnv, "base64").toString("utf8");
    return JSON.parse(json) as EarthEngineKey;
  }
  try {
    return JSON.parse(await readFile(EE_KEY_PATH, "utf8")) as EarthEngineKey;
  } catch {
    // Don't surface filesystem paths in API responses.
    throw new Error("Earth Engine is not configured (set EARTH_ENGINE_SERVICE_ACCOUNT_KEY).");
  }
}

export function isEarthEngineKeyConfigured(fileExists: boolean) {
  return Boolean(process.env.EARTH_ENGINE_SERVICE_ACCOUNT_KEY?.trim()) || fileExists;
}

async function ensureEarthEngineReady() {
  if (!initPromise) {
    initPromise = (async () => {
      const key = await loadEarthEngineKey();
      if (!key.client_email || !key.private_key) {
        throw new Error("Earth Engine service account key is missing required fields.");
      }

      await authenticateViaPrivateKey(key);
      await initializeEarthEngine(process.env.EARTH_ENGINE_PROJECT_ID ?? key.project_id);
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
    currentProduct: { no2: null, aerosolIndex: null },
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

/** First collection (NRTI, then OFFL) that has an unmasked value wins. */
async function reduceCurrentBand(
  collections: string[],
  band: string,
  region: unknown,
  startDate: string,
  endDate: string,
  label: string,
) {
  for (const collectionId of collections) {
    try {
      const value = await reduceMedianBand(collectionId, band, region, startDate, endDate, label);
      if (value !== null) return { value, product: collectionId };
    } catch (error) {
      console.warn(`${label} unavailable from ${collectionId}`, error instanceof Error ? error.message : error);
    }
  }
  return { value: null, product: null };
}

export async function getSatelliteDataForPoint(
  lat: number,
  lng: number,
  referenceTime: Date = new Date(),
): Promise<SatelliteDataResult> {
  const end = Number.isFinite(referenceTime.getTime()) ? referenceTime : new Date();
  // filterDate's end is exclusive; include the reference day itself.
  const endExclusive = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  const endDate = endExclusive.toISOString().slice(0, 10);
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
    const [no2Current, no2Baseline, aerosolCurrent, aerosolBaseline] = await Promise.all([
      reduceCurrentBand(NO2_CURRENT_COLLECTIONS, NO2_BAND, region, currentStartDate, endDate, "NO2 current"),
      reduceMedianBand(NO2_BASELINE_COLLECTION, NO2_BAND, region, baselineStartDate, currentStartDate, "NO2 baseline"),
      reduceCurrentBand(AEROSOL_CURRENT_COLLECTIONS, AEROSOL_BAND, region, currentStartDate, endDate, "Aerosol Index current"),
      reduceMedianBand(AEROSOL_BASELINE_COLLECTION, AEROSOL_BAND, region, baselineStartDate, currentStartDate, "Aerosol Index baseline"),
    ]);
    const no2Raw = no2Current.value;
    const aerosolRaw = aerosolCurrent.value;

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
      currentProduct: { no2: no2Current.product, aerosolIndex: aerosolCurrent.product },
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

type SampledFeatureCollection = {
  features?: Array<{
    geometry?: { coordinates?: [number, number] };
    properties?: { T21?: number; confidence?: number };
  }>;
};

async function fetchRegionalFireHotspots(): Promise<FireHotspotResult> {
  const end = new Date();
  const start = new Date(end.getTime() - FIRE_WINDOW_HOURS * 60 * 60 * 1000);
  const windowStart = start.toISOString();
  const windowEnd = end.toISOString();
  const computedAt = end.toISOString();

  try {
    await withTimeout(ensureEarthEngineReady(), REQUEST_TIMEOUT_MS, "Earth Engine auth");
    const [minLng, minLat, maxLng, maxLat] = FIRE_REGION_BOUNDS;
    const region = ee.Geometry.Rectangle([minLng, minLat, maxLng, maxLat]);
    // FIRMS images are masked everywhere except fire pixels, so sampling the
    // max composite returns one feature per detected fire pixel.
    const composite = ee
      .ImageCollection(FIRMS_COLLECTION)
      .filterDate(windowStart.slice(0, 10), new Date(end.getTime() + 86_400_000).toISOString().slice(0, 10))
      .filterBounds(region)
      .select(["T21", "confidence"])
      .max();
    const samples = composite
      .sample({ region, scale: 1000, geometries: true, dropNulls: true })
      .limit(MAX_FIRE_POINTS + 1);

    const collection = await withTimeout(
      getInfo<SampledFeatureCollection>(samples),
      FIRE_REQUEST_TIMEOUT_MS,
      "Earth Engine FIRMS sample",
    );
    const fires = (collection.features ?? [])
      .map((feature) => {
        const [lng, lat] = feature.geometry?.coordinates ?? [];
        return {
          lat: Number(lat),
          lng: Number(lng),
          brightnessK: typeof feature.properties?.T21 === "number" ? feature.properties.T21 : null,
          confidence:
            typeof feature.properties?.confidence === "number" ? feature.properties.confidence : null,
        };
      })
      .filter((fire) => Number.isFinite(fire.lat) && Number.isFinite(fire.lng));

    return {
      fires: fires.slice(0, MAX_FIRE_POINTS),
      windowStart,
      windowEnd,
      bounds: FIRE_REGION_BOUNDS,
      truncated: fires.length > MAX_FIRE_POINTS,
      source: "NASA FIRMS via Earth Engine",
      computedAt,
    };
  } catch (error) {
    return {
      fires: [],
      windowStart,
      windowEnd,
      bounds: FIRE_REGION_BOUNDS,
      truncated: false,
      source: "NASA FIRMS via Earth Engine",
      computedAt,
      error: error instanceof Error ? error.message : "Unknown Earth Engine error.",
    };
  }
}

/** Active fires across Punjab/Haryana/Delhi over the last 48 h, cached 1 h. */
export async function getRegionalFireHotspots(options: { refresh?: boolean } = {}) {
  if (!options.refresh && fireCache && fireCache.expiresAt > Date.now()) {
    return fireCache.value;
  }
  fireInFlight ??= fetchRegionalFireHotspots().finally(() => {
    fireInFlight = null;
  });
  const value = await fireInFlight;
  // Don't pin an error for an hour; retry on the next request instead.
  if (!value.error) {
    fireCache = { expiresAt: Date.now() + FIRE_CACHE_TTL_MS, value };
  }
  return value;
}

export type NearbyFireSummary = {
  count: number;
  nearestKm: number | null;
  maxBrightnessK: number | null;
  radiusKm: number;
  windowStart: string;
  windowEnd: string;
  error?: string;
};

export async function getFiresNear(lat: number, lng: number, radiusKm = 5): Promise<NearbyFireSummary> {
  const regional = await getRegionalFireHotspots();
  const nearby = regional.fires
    .map((fire) => ({ ...fire, distanceKm: haversineKm(lat, lng, fire.lat, fire.lng) }))
    .filter((fire) => fire.distanceKm <= radiusKm);
  return {
    count: nearby.length,
    nearestKm: nearby.length
      ? Number(Math.min(...nearby.map((fire) => fire.distanceKm)).toFixed(2))
      : null,
    maxBrightnessK: nearby.reduce<number | null>(
      (max, fire) =>
        fire.brightnessK !== null && (max === null || fire.brightnessK > max) ? fire.brightnessK : max,
      null,
    ),
    radiusKm,
    windowStart: regional.windowStart,
    windowEnd: regional.windowEnd,
    ...(regional.error ? { error: regional.error } : {}),
  };
}
