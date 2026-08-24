import "server-only";
import dns from "node:dns";

dns.setDefaultResultOrder("ipv4first");

const CPCB_ENDPOINT =
  "https://api.data.gov.in/resource/3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69";
const PUBLIC_SAMPLE_KEY = "579b464db66ec23bdd000001";
const CACHE_TTL_MS = 15 * 60 * 1000;
const PAGE_LIMIT = 1000;
const REQUEST_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;
const NCR_STATES = ["Delhi", "Haryana", "Uttar Pradesh", "Rajasthan"];
// CPCB India national 24h ambient air quality standards (µg/m³).
// These are used for *event-detection* delta calculations — i.e. deciding
// whether a sensor reading is anomalously high enough to confirm a citizen
// report. WHO guidelines (PM2.5=15, PM10=45, NO2=25, SO2=40) are the right
// standard for health-risk display, but Delhi's ambient baseline already
// exceeds them every single day, so using WHO as the reference meant sensor
// support triggered on 100% of reports regardless of whether a real event
// occurred. CPCB values reflect what India's own pollution board considers
// the 24h limit — a reading must exceed THESE by ≥50% to count as a sensor
// confirmation of a citizen-reported incident.
// (WHO values are still used in the health-risk badge layer, not here.)
const CPCB_PM25_REFERENCE = 60;
const CPCB_PM10_REFERENCE = 100;
const CPCB_NO2_REFERENCE = 80;
const CPCB_SO2_REFERENCE = 80;

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

type StationWithDistance = GroupedStation & {
  distanceKm: number;
};

export type NearbyStationReading = {
  stationName: string;
  lat: number;
  lng: number;
  distanceKm: number;
  pm25: number | null;
  pm10: number | null;
  no2: number | null;
  so2: number | null;
  co: number | null;
  nh3: number | null;
  ozone: number | null;
  lastUpdated: string | null;
  source: "CPCB";
};

let cachedStations:
  | {
      expiresAt: number;
      stations: GroupedStation[];
    }
  | null = null;
let warnedAboutSampleKey = false;

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

function hasUsablePollutantData(station: NearbyStationReading | StationWithDistance) {
  return [
    station.pm25,
    station.pm10,
    station.no2,
    station.so2,
    station.co,
    station.nh3,
    station.ozone,
  ].some((value) => value !== null);
}

function haversineKm(
  originLat: number,
  originLng: number,
  destinationLat: number,
  destinationLng: number,
) {
  const earthRadiusKm = 6371;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latDelta = toRadians(destinationLat - originLat);
  const lngDelta = toRadians(destinationLng - originLng);
  const lat1 = toRadians(originLat);
  const lat2 = toRadians(destinationLat);
  const a =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(lngDelta / 2) ** 2;

  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchCpcbPage(url: URL) {
  for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url);
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

function toNearbyStationReading(station: StationWithDistance): NearbyStationReading {
  return {
    co: station.co,
    distanceKm: station.distanceKm,
    lat: station.lat,
    lng: station.lng,
    lastUpdated: station.lastUpdated,
    nh3: station.nh3,
    no2: station.no2,
    ozone: station.ozone,
    pm10: station.pm10,
    pm25: station.pm25,
    so2: station.so2,
    source: "CPCB",
    stationName: station.stationName,
  };
}

export async function fetchAllStationReadings(): Promise<NearbyStationReading[]> {
  try {
    const stations = await fetchAllStations();
    return stations
      .filter((station) => hasUsablePollutantData({ ...station, distanceKm: 0 }))
      .map((station) => toNearbyStationReading({ ...station, distanceKm: 0 }));
  } catch (error) {
    console.warn(
      "Could not fetch CPCB station readings",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

export async function fetchNearbyStations(
  lat: number,
  lng: number,
  radiusKm = 10,
): Promise<NearbyStationReading[]> {
  try {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];

    const stations = await fetchAllStations();
    return stations
      .map((station) => ({
        ...station,
        distanceKm: Number(haversineKm(lat, lng, station.lat, station.lng).toFixed(2)),
      }))
      .filter((station) => station.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .map(toNearbyStationReading);
  } catch (error) {
    console.warn(
      "Could not fetch CPCB nearby stations",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

export async function getNearestStationReading(lat: number, lng: number) {
  const stations = await fetchNearbyStations(lat, lng);
  // Was taking stations[0] (absolute nearest) and bailing to null if *that*
  // station had no usable pollutant data — discarding a perfectly good
  // reading from the next-nearest station even when it's well within the
  // 3km support radius. CPCB stations going offline/reporting all-null is
  // common, so this silently zeroed out sensor support more than it should
  // have. Now picks the nearest station that actually has data.
  const nearestStation = stations.find((station) => hasUsablePollutantData(station));
  return nearestStation ?? null;
}

export function getPm25DeltaFromReference(pm25: number | null) {
  if (pm25 === null) return 0;
  return Math.round(((pm25 - CPCB_PM25_REFERENCE) / CPCB_PM25_REFERENCE) * 100);
}

export function getPrimaryPollutant(
  classificationType: string | undefined, 
  station: Partial<NearbyStationReading> | null
) {
  if (!station) return { name: "PM2.5", value: null, delta: 0 };
  
  if (classificationType === "dust" && station.pm10 !== null && station.pm10 !== undefined) {
    return { name: "PM10", value: station.pm10, delta: Math.round(((station.pm10 - CPCB_PM10_REFERENCE) / CPCB_PM10_REFERENCE) * 100) };
  }

  // If PM2.5 is unavailable, PM10 can still establish a particulate event,
  // but it cannot honestly distinguish dust from general coarse particulate.
  if (
    classificationType === "particulate" &&
    station.pm25 == null &&
    station.pm10 != null
  ) {
    return {
      name: "PM10",
      value: station.pm10,
      delta: Math.round(((station.pm10 - CPCB_PM10_REFERENCE) / CPCB_PM10_REFERENCE) * 100),
    };
  }
  
  if (classificationType === "industrial") {
    const no2Delta = station.no2 != null ? Math.round(((station.no2 - CPCB_NO2_REFERENCE) / CPCB_NO2_REFERENCE) * 100) : 0;
    const so2Delta = station.so2 != null ? Math.round(((station.so2 - CPCB_SO2_REFERENCE) / CPCB_SO2_REFERENCE) * 100) : 0;
    if (no2Delta >= so2Delta && station.no2 != null) return { name: "NO2", value: station.no2, delta: no2Delta };
    if (station.so2 != null) return { name: "SO2", value: station.so2, delta: so2Delta };
  }
  
  // Default to PM2.5 for fire/smog, or if the preferred pollutant is missing
  return {
    name: "PM2.5",
    value: station.pm25 ?? null,
    delta: station.pm25 != null
      ? Math.round(((station.pm25 - CPCB_PM25_REFERENCE) / CPCB_PM25_REFERENCE) * 100)
      : 0,
  };
}
