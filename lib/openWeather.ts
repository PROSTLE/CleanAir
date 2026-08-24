import "server-only";

const OPENWEATHER_ENDPOINT = "https://api.openweathermap.org/data/2.5/weather";
const CACHE_TTL_MS = 10 * 60 * 1000;

export type WindData = {
  windSpeedMs: number;
  windDegrees: number;
  windGustMs: number | null;
  temperatureC: number;
  humidityPct: number;
  source: "OpenWeatherMap";
  fetchedAt: string;
};

type OpenWeatherResponse = {
  wind?: {
    speed?: number;
    deg?: number;
    gust?: number;
  };
  main?: {
    temp?: number;
    humidity?: number;
  };
  message?: string;
};

type CacheEntry = {
  expiresAt: number;
  value: WindData;
};

const cache = new Map<string, CacheEntry>();
let warnedAboutMissingKey = false;

function getCacheKey(lat: number, lng: number) {
  return `${lat.toFixed(2)},${lng.toFixed(2)}`;
}

function getApiKey() {
  const apiKey = process.env.OPENWEATHER_API_KEY?.trim();
  if (apiKey) return apiKey;

  if (!warnedAboutMissingKey) {
    console.warn("OPENWEATHER_API_KEY is not set; wind data is unavailable.");
    warnedAboutMissingKey = true;
  }

  return null;
}

function getFiniteNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`OpenWeatherMap response is missing ${label}.`);
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

export async function getWindData(lat: number, lng: number): Promise<WindData | null> {
  try {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error("lat and lng must be valid numbers.");
    }

    const apiKey = getApiKey();
    if (!apiKey) return null;

    const cacheKey = getCacheKey(lat, lng);
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const url = new URL(OPENWEATHER_ENDPOINT);
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lng));
    url.searchParams.set("appid", apiKey);
    url.searchParams.set("units", "metric");

    const response = await fetch(url);
    const payload = (await response.json()) as OpenWeatherResponse;

    if (!response.ok) {
      throw new Error(
        payload.message
          ? `OpenWeatherMap request failed (${response.status}): ${payload.message}`
          : `OpenWeatherMap request failed (${response.status}).`,
      );
    }

    const value: WindData = {
      fetchedAt: new Date().toISOString(),
      humidityPct: getFiniteNumber(payload.main?.humidity, "main.humidity"),
      source: "OpenWeatherMap",
      temperatureC: getFiniteNumber(payload.main?.temp, "main.temp"),
      windDegrees: getFiniteNumber(payload.wind?.deg, "wind.deg"),
      windGustMs:
        typeof payload.wind?.gust === "number" && Number.isFinite(payload.wind.gust)
          ? payload.wind.gust
          : null,
      windSpeedMs: getFiniteNumber(payload.wind?.speed, "wind.speed"),
    };

    cache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      value,
    });

    return value;
  } catch (error) {
    console.warn(
      "Could not fetch OpenWeatherMap wind data",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
