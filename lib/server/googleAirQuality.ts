import "server-only";

// Google Maps Platform Air Quality API — an independent modelled estimate
// used to cross-check CPCB readings and our own forecast. Server-side key
// (never the browser Maps key, which is referrer-restricted).
const ENDPOINT = "https://airquality.googleapis.com/v1";
const CACHE_TTL_MS = 30 * 60 * 1000;

type AqIndex = {
  code?: string;
  displayName?: string;
  aqi?: number;
  category?: string;
  dominantPollutant?: string;
};
type AqPollutant = { code?: string; concentration?: { value?: number; units?: string } };
type AqResponse = {
  dateTime?: string;
  indexes?: AqIndex[];
  pollutants?: AqPollutant[];
  error?: { message?: string };
};
type AqForecastResponse = {
  hourlyForecasts?: AqResponse[];
  error?: { message?: string };
};

export type AirQualitySnapshot = {
  time: string | null;
  universalAqi: number | null;
  universalCategory: string | null;
  indiaAqi: number | null;
  indiaCategory: string | null;
  dominantPollutant: string | null;
  pm25: number | null;
  pm10: number | null;
  no2: number | null;
};

const cache = new Map<string, { expiresAt: number; value: unknown }>();

function apiKey() {
  return process.env.GOOGLE_AIR_QUALITY_API_KEY?.trim() || null;
}

export function isAirQualityConfigured() {
  return apiKey() !== null;
}

function toSnapshot(response: AqResponse): AirQualitySnapshot {
  const universal = response.indexes?.find((index) => index.code === "uaqi");
  // Local index for India is the CPCB National AQI.
  const india = response.indexes?.find((index) => index.code === "ind_cpcb");
  const pollutant = (code: string) => {
    const match = response.pollutants?.find((item) => item.code === code);
    const value = match?.concentration?.value;
    return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(1)) : null;
  };
  return {
    time: response.dateTime ?? null,
    universalAqi: universal?.aqi ?? null,
    universalCategory: universal?.category ?? null,
    indiaAqi: india?.aqi ?? null,
    indiaCategory: india?.category ?? null,
    dominantPollutant: india?.dominantPollutant ?? universal?.dominantPollutant ?? null,
    pm25: pollutant("pm25"),
    pm10: pollutant("pm10"),
    no2: pollutant("no2"),
  };
}

async function post<T extends { error?: { message?: string } }>(path: string, body: unknown): Promise<T> {
  const key = apiKey();
  if (!key) throw new Error("GOOGLE_AIR_QUALITY_API_KEY is not set.");
  const response = await fetch(`${ENDPOINT}/${path}?key=${encodeURIComponent(key)}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(12_000),
  });
  const json = (await response.json().catch(() => ({}))) as T;
  if (!response.ok) {
    throw new Error(`Air Quality API ${path} failed (${response.status}): ${json.error?.message ?? "no details"}`);
  }
  return json;
}

function cacheKey(kind: string, lat: number, lng: number) {
  return `${kind}:${lat.toFixed(3)},${lng.toFixed(3)}`;
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const value = await load();
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return value;
}

const EXTRA_COMPUTATIONS = ["LOCAL_AQI", "POLLUTANT_CONCENTRATION", "DOMINANT_POLLUTANT_CONCENTRATION"];

export function getCurrentAirQuality(lat: number, lng: number) {
  return cached(cacheKey("current", lat, lng), async () =>
    toSnapshot(
      await post<AqResponse>("currentConditions:lookup", {
        location: { latitude: lat, longitude: lng },
        extraComputations: EXTRA_COMPUTATIONS,
        languageCode: "en",
      }),
    ),
  );
}

/** Hourly forecast for the next `hours` hours (starts at the next full hour). */
export function getAirQualityForecast(lat: number, lng: number, hours = 24) {
  return cached(cacheKey(`forecast${hours}`, lat, lng), async () => {
    const start = new Date();
    start.setUTCMinutes(0, 0, 0);
    start.setUTCHours(start.getUTCHours() + 1);
    const end = new Date(start.getTime() + (hours - 1) * 3_600_000);
    const response = await post<AqForecastResponse>("forecast:lookup", {
      location: { latitude: lat, longitude: lng },
      period: { startTime: start.toISOString(), endTime: end.toISOString() },
      extraComputations: EXTRA_COMPUTATIONS,
      languageCode: "en",
      pageSize: hours,
    });
    return (response.hourlyForecasts ?? []).map(toSnapshot);
  });
}
