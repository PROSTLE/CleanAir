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
  /** The country's own index (CPCB in India, MEP in China, ...), as Google reports it. */
  localAqi: number | null;
  localCategory: string | null;
  localIndexName: string | null;
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
  // LOCAL_AQI adds the country's default index (ind_cpcb, chn_mep, ...).
  const local = response.indexes?.find((index) => index.code !== "uaqi");
  const pollutant = (code: string) => {
    const match = response.pollutants?.find((item) => item.code === code);
    const value = match?.concentration?.value;
    return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(1)) : null;
  };
  return {
    time: response.dateTime ?? null,
    universalAqi: universal?.aqi ?? null,
    universalCategory: universal?.category ?? null,
    localAqi: local?.aqi ?? null,
    localCategory: local?.category ?? null,
    localIndexName: local?.displayName ?? null,
    dominantPollutant: local?.dominantPollutant ?? universal?.dominantPollutant ?? null,
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

// ─── Health recommendations ──────────────────────────────────────────────────
// The Air Quality API's HEALTH_RECOMMENDATIONS extra computation returns
// Google's own advice for the current conditions, for the general population
// and six at-risk groups, in the requested language. Shown to residents as
// Google wrote it, so no health advice is authored or generated here.
export const HEALTH_GROUPS = [
  "generalPopulation",
  "children",
  "elderly",
  "lungDiseasePopulation",
  "heartDiseasePopulation",
  "pregnantWomen",
  "athletes",
] as const;

export type HealthGroup = (typeof HEALTH_GROUPS)[number];

export type HealthAdvice = {
  time: string | null;
  localAqi: number | null;
  localCategory: string | null;
  localIndexName: string | null;
  universalAqi: number | null;
  universalCategory: string | null;
  languageCode: string;
  recommendations: Partial<Record<HealthGroup, string>>;
};

type AqHealthResponse = AqResponse & { healthRecommendations?: Record<string, unknown> };

export function getHealthAdvice(lat: number, lng: number, languageCode = "en") {
  return cached(cacheKey(`health:${languageCode}`, lat, lng), async (): Promise<HealthAdvice> => {
    const response = await post<AqHealthResponse>("currentConditions:lookup", {
      location: { latitude: lat, longitude: lng },
      extraComputations: ["LOCAL_AQI", "HEALTH_RECOMMENDATIONS"],
      languageCode,
    });
    const snapshot = toSnapshot(response);
    const recommendations: Partial<Record<HealthGroup, string>> = {};
    for (const group of HEALTH_GROUPS) {
      const text = response.healthRecommendations?.[group];
      if (typeof text === "string" && text.trim()) recommendations[group] = text.trim();
    }
    return {
      time: snapshot.time,
      localAqi: snapshot.localAqi,
      localCategory: snapshot.localCategory,
      localIndexName: snapshot.localIndexName,
      universalAqi: snapshot.universalAqi,
      universalCategory: snapshot.universalCategory,
      languageCode,
      recommendations,
    };
  });
}

// ─── Hourly history ─────────────────────────────────────────────────────────
// history:lookup returns up to 720 past hours (30 days), 168 per page, for
// any point at Google's 500 m resolution. It is Google's modelled estimate,
// not a station measurement; callers label it that way. Only PM values that
// come back in µg/m³ are kept (gases are reported in ppb, so they're dropped
// rather than converted with an assumed temperature and pressure).
export type ModelledHour = { time: string; pm25: number | null; pm10: number | null };

type AqHistoryResponse = {
  hoursInfo?: Array<{ dateTime?: string; pollutants?: AqPollutant[] }>;
  nextPageToken?: string;
  error?: { message?: string };
};

const HISTORY_PAGE_SIZE = 168;
const MAX_HISTORY_HOURS = 720;

function microgramValue(pollutants: AqPollutant[] | undefined, code: string) {
  const match = pollutants?.find((item) => item.code === code);
  const value = match?.concentration?.value;
  return match?.concentration?.units === "MICROGRAMS_PER_CUBIC_METER" && typeof value === "number" && Number.isFinite(value)
    ? Number(value.toFixed(1))
    : null;
}

export async function getAirQualityHistory(lat: number, lng: number, hours = 72): Promise<ModelledHour[]> {
  const span = Math.max(1, Math.min(MAX_HISTORY_HOURS, Math.round(hours)));
  const out: ModelledHour[] = [];
  let pageToken: string | undefined;
  do {
    const response = await post<AqHistoryResponse>("history:lookup", {
      location: { latitude: lat, longitude: lng },
      hours: span,
      pageSize: Math.min(HISTORY_PAGE_SIZE, span),
      extraComputations: ["POLLUTANT_CONCENTRATION"],
      universalAqi: false,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const hour of response.hoursInfo ?? []) {
      if (!hour.dateTime) continue;
      out.push({
        time: hour.dateTime,
        pm25: microgramValue(hour.pollutants, "pm25"),
        pm10: microgramValue(hour.pollutants, "pm10"),
      });
    }
    pageToken = response.nextPageToken || undefined;
  } while (pageToken);
  return out.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}
