import "server-only";

// Open-Meteo: free, keyless weather API (non-commercial use).
// https://open-meteo.com/en/docs
const OPEN_METEO_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const CACHE_TTL_MS = 10 * 60 * 1000;

export type WindData = {
  windSpeedMs: number;
  windDegrees: number;
  windGustMs: number | null;
  temperatureC: number;
  humidityPct: number;
  source: "Open-Meteo";
  fetchedAt: string;
};

type OpenMeteoResponse = {
  current?: {
    temperature_2m?: number;
    relative_humidity_2m?: number;
    wind_speed_10m?: number;
    wind_direction_10m?: number;
    wind_gusts_10m?: number;
  };
  reason?: string;
};

type CacheEntry = {
  expiresAt: number;
  value: WindData;
};

const cache = new Map<string, CacheEntry>();

function getCacheKey(lat: number, lng: number) {
  return `${lat.toFixed(2)},${lng.toFixed(2)}`;
}

function getFiniteNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Open-Meteo response is missing ${label}.`);
  }

  return value;
}

export function degreesToCompass(deg: number) {
  if (!Number.isFinite(deg)) return "N";

  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
  const normalized = ((deg % 360) + 360) % 360;
  const index = Math.round(normalized / 45) % directions.length;
  return directions[index];
}

/** Current wind (direction it blows FROM, meteorological degrees), temperature and humidity at a point. */
export async function getWindData(lat: number, lng: number): Promise<WindData | null> {
  try {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error("lat and lng must be valid numbers.");
    }

    const cacheKey = getCacheKey(lat, lng);
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const url = new URL(OPEN_METEO_ENDPOINT);
    url.searchParams.set("latitude", String(lat));
    url.searchParams.set("longitude", String(lng));
    url.searchParams.set(
      "current",
      "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
    );
    url.searchParams.set("wind_speed_unit", "ms");

    const response = await fetch(url);
    const payload = (await response.json()) as OpenMeteoResponse;

    if (!response.ok) {
      throw new Error(
        payload.reason
          ? `Open-Meteo request failed (${response.status}): ${payload.reason}`
          : `Open-Meteo request failed (${response.status}).`,
      );
    }

    const current = payload.current;
    const value: WindData = {
      fetchedAt: new Date().toISOString(),
      humidityPct: getFiniteNumber(current?.relative_humidity_2m, "relative_humidity_2m"),
      source: "Open-Meteo",
      temperatureC: getFiniteNumber(current?.temperature_2m, "temperature_2m"),
      windDegrees: getFiniteNumber(current?.wind_direction_10m, "wind_direction_10m"),
      windGustMs:
        typeof current?.wind_gusts_10m === "number" && Number.isFinite(current.wind_gusts_10m)
          ? current.wind_gusts_10m
          : null,
      windSpeedMs: getFiniteNumber(current?.wind_speed_10m, "wind_speed_10m"),
    };

    cache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      value,
    });

    return value;
  } catch (error) {
    console.warn(
      "Could not fetch Open-Meteo wind data",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
