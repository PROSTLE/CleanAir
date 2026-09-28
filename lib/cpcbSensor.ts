import "server-only";
import dns from "node:dns";
import type { StationReading } from "@/lib/stations";

dns.setDefaultResultOrder("ipv4first");

const CPCB_ENDPOINT =
  "https://api.data.gov.in/resource/3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69";
const PUBLIC_SAMPLE_KEY = "579b464db66ec23bdd000001";
const CACHE_TTL_MS = 15 * 60 * 1000;
const PAGE_LIMIT = 1000;
const REQUEST_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 12_000;
const RETRY_DELAY_MS = 500;
const NCR_STATES = ["Delhi", "Haryana", "Uttar Pradesh", "Rajasthan"];

type CpcbApiResponse = {
  records?: CpcbRecord[];
  total?: string | number;
};

type CpcbRecord = {
  avg_value?: string | number;
  city?: string;
  last_update?: string;
  latitude?: string | number;
  longitude?: string | number;
  pollutant_avg?: string | number;
  pollutant_id?: string;
  state?: string;
  station?: string;
  station_name?: string;
};

type PollutantKey = "co" | "nh3" | "no2" | "ozone" | "pm10" | "pm25" | "so2";

type GroupedStation = {
  city: string | null;
  state: string | null;
  stationName: string;
  lat: number;
  lng: number;
  pm25: number | null;
  pm10: number | null;
  no2: number | null;
  so2: number | null;
  co: number | null;
  nh3: number | null;
  ozone: number | null;
  lastUpdated: string | null;
};

let cachedStations:
  | {
      expiresAt: number;
      stations: GroupedStation[];
    }
  | null = null;
let warnedAboutSampleKey = false;
// While data.gov.in is down, answer "no stations" fast instead of retrying
// the whole ~40 s fetch on every request.
const FAILURE_BACKOFF_MS = 2 * 60 * 1000;
let failedUntil = 0;

function getApiKey() {
  const configuredKey = process.env.CPCB_API_KEY?.trim();
  if (configuredKey) return configuredKey;

  if (process.env.NODE_ENV !== "production") {
    if (!warnedAboutSampleKey) {
      console.warn(
        "CPCB_API_KEY is not set; using the data.gov.in public sample key for development.",
      );
      warnedAboutSampleKey = true;
    }
    return PUBLIC_SAMPLE_KEY;
  }

  return null;
}

function toNumber(value: string | number | undefined | null) {
  if (value === undefined || value === null || value === "NA") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePollutantId(value?: string): PollutantKey | null {
  const normalized = value?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
  if (normalized === "pm25") return "pm25";
  if (normalized === "pm10") return "pm10";
  if (normalized === "no2") return "no2";
  if (normalized === "so2") return "so2";
  if (normalized === "co") return "co";
  if (normalized === "nh3") return "nh3";
  if (normalized === "ozone" || normalized === "o3") return "ozone";
  return null;
}

function getPollutantValue(record: CpcbRecord) {
  return toNumber(record.avg_value ?? record.pollutant_avg);
}

function getStationName(record: CpcbRecord) {
  return record.station ?? record.station_name ?? "Unknown CPCB station";
}

function getStationKey(record: CpcbRecord, lat: number, lng: number) {
  return `${getStationName(record)}|${lat.toFixed(6)}|${lng.toFixed(6)}`;
}

function createStation(record: CpcbRecord, lat: number, lng: number): GroupedStation {
  return {
    city: record.city ?? null,
    state: record.state ?? null,
    stationName: getStationName(record),
    lat,
    lng,
    pm25: null,
    pm10: null,
    no2: null,
    so2: null,
    co: null,
    nh3: null,
    ozone: null,
    lastUpdated: record.last_update ?? null,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchCpcbPage(url: URL) {
  for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt += 1) {
    try {
      // data.gov.in sometimes hangs rather than failing; without a timeout
      // one stuck request stalls every Delhi lookup, scan and cron run.
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) {
        throw new Error(`CPCB request failed (${response.status}).`);
      }

      const payload = (await response.json()) as CpcbApiResponse & { error?: string };
      if (payload.error) throw new Error(payload.error);
      return payload;
    } catch (error) {
      if (attempt === REQUEST_ATTEMPTS) throw error;
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  throw new Error("CPCB request failed.");
}

async function fetchStateRecords(apiKey: string, state: string) {
  const records: CpcbRecord[] = [];
  let offset = 0;

  while (true) {
    const url = new URL(CPCB_ENDPOINT);
    url.searchParams.set("api-key", apiKey);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", String(PAGE_LIMIT));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("filters[state]", state);

    const payload = await fetchCpcbPage(url);
    const page = Array.isArray(payload.records) ? payload.records : [];
    records.push(...page);

    const total = Number(payload.total);
    offset += page.length;

    if (page.length === 0) break;
    if (Number.isFinite(total) && offset >= total) break;
    if (page.length < PAGE_LIMIT) break;
  }

  return records;
}

async function fetchAllStations() {
  if (cachedStations && cachedStations.expiresAt > Date.now()) {
    return cachedStations.stations;
  }

  const apiKey = getApiKey();
  if (!apiKey) return [];
  if (Date.now() < failedUntil) throw new Error("CPCB feed unavailable (retrying shortly).");

  const stateResults = await Promise.allSettled(
    NCR_STATES.map((state) => fetchStateRecords(apiKey, state)),
  );
  const records = stateResults.flatMap((result, index) => {
    if (result.status === "fulfilled") return result.value;

    console.warn(
      `Could not fetch CPCB records for ${NCR_STATES[index]}`,
      result.reason instanceof Error ? result.reason.message : result.reason,
    );
    return [];
  });
  if (stateResults.every((result) => result.status === "rejected")) {
    // Back off briefly, but never cache the empty result for the full TTL.
    failedUntil = Date.now() + FAILURE_BACKOFF_MS;
    return [];
  }
  const stations = new Map<string, GroupedStation>();

  for (const record of records) {
    const lat = toNumber(record.latitude);
    const lng = toNumber(record.longitude);
    if (lat === null || lng === null) continue;

    const key = getStationKey(record, lat, lng);
    const station = stations.get(key) ?? createStation(record, lat, lng);
    const pollutant = normalizePollutantId(record.pollutant_id);

    if (pollutant) {
      station[pollutant] = getPollutantValue(record);
    }

    if (record.last_update) station.lastUpdated = record.last_update;
    stations.set(key, station);
  }

  const stationList = [...stations.values()];
  cachedStations = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    stations: stationList,
  };

  return stationList;
}

function hasUsablePollutantData(station: GroupedStation) {
  return [station.pm25, station.pm10, station.no2, station.so2, station.co, station.nh3, station.ozone].some(
    (value) => value !== null,
  );
}

/** Every NCR station with at least one pollutant reading, cached for 15 minutes. */
export async function fetchCpcbStations(): Promise<StationReading[]> {
  try {
    const stations = await fetchAllStations();
    return stations.filter(hasUsablePollutantData).map((station) => ({
      co: station.co,
      distanceKm: 0,
      lat: station.lat,
      lng: station.lng,
      lastUpdated: station.lastUpdated,
      nh3: station.nh3,
      no2: station.no2,
      ozone: station.ozone,
      pm10: station.pm10,
      pm25: station.pm25,
      so2: station.so2,
      source: "CPCB" as const,
      attribution: "CPCB via data.gov.in",
      stationName: station.stationName,
    }));
  } catch (error) {
    console.warn("Could not fetch CPCB station readings", error instanceof Error ? error.message : error);
    return [];
  }
}
