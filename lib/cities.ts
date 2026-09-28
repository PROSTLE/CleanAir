// The capitals VayuSetu monitors. One config per city drives the map view,
// station network, exceedance thresholds, fire region, suggested authorities
// and languages, so every page and pipeline switches city from one place.
//
// A capital is listed only if a public, real-time ground-station feed covers
// it (checked Sep 2026). Cairo and Addis Ababa are left out: their only live
// monitor was the US Embassy one, and that network went offline in March 2025.
// Tehran is left out too: its public feed has not updated since December 2025.
import { CITY_BOUNDARIES, type Ring } from "@/lib/cityBoundaries";
import { haversineKm } from "@/lib/geo";
import type { HazardType } from "@/lib/types";
import { MONITORED_CELLS } from "@/lib/mapConstants";

export type StationProvider = "cpcb" | "waqi";

export interface CityConfig {
  id: string;
  name: string;
  country: string;
  /** ISO 3166-1 alpha-2, lower case (Places autocomplete restriction). */
  countryCode: string;
  center: { lat: number; lng: number };
  zoom: number;
  timeZone: string;
  boundary: Ring[];
  bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  stations: {
    provider: StationProvider;
    network: string;
    coverage: "dense" | "moderate" | "sparse";
  };
  /**
   * National 24-hour limits (µg/m³): a reading must exceed these to count as
   * sensor support. Gas limits are null where the station feed carries no
   * gas concentrations.
   */
  standards: { source: string; pm25: number; pm10: number; no2: number | null; so2: number | null };
  fireRegion: { bounds: readonly [number, number, number, number]; label: string };
  /** Suggested first-responder agency per hazard; the operator confirms routing. */
  authorities: Record<HazardType, string>;
  /** Second language for work orders, besides English. */
  localLanguage: { code: string; name: string } | null;
  /** Google Speech-to-Text language for voice notes (Delhi follows the UI language). */
  speechLanguage: string;
  /** Delhi has a measured diurnal PM2.5 profile; other cities forecast without one. */
  forecastProfile: "delhi" | "generic";
  /** Known pollution-prone areas watched even without a station (Delhi only today). */
  monitoredAreas: Array<{ label: string; lat: number; lng: number }>;
}

type CitySeed = Omit<CityConfig, "boundary" | "bounds">;

const SEEDS: CitySeed[] = [
  {
    id: "delhi",
    name: "New Delhi",
    country: "India",
    countryCode: "in",
    center: { lat: 28.6139, lng: 77.209 },
    zoom: 10,
    timeZone: "Asia/Kolkata",
    stations: { provider: "cpcb", network: "CPCB / DPCC continuous stations", coverage: "dense" },
    standards: { source: "India NAAQS 2009 (24 h)", pm25: 60, pm10: 100, no2: 80, so2: 80 },
    fireRegion: { bounds: [73.8, 27.8, 78.2, 32.6], label: "Punjab, Haryana and Delhi NCR" },
    authorities: {
      fire: "Municipal Corporation of Delhi (MCD) — Sanitation / waste-burning enforcement",
      dust: "Municipal Corporation of Delhi (MCD) — construction & demolition dust enforcement",
      industrial: "Delhi Pollution Control Committee (DPCC)",
      smog: "Delhi Traffic Police — traffic management",
      particulate: "Delhi Pollution Control Committee (DPCC) — field inspection",
    },
    localLanguage: { code: "hi", name: "हिन्दी" },
    speechLanguage: "hi-IN",
    forecastProfile: "delhi",
    monitoredAreas: MONITORED_CELLS,
  },
  {
    id: "beijing",
    name: "Beijing",
    country: "China",
    countryCode: "cn",
    center: { lat: 39.9042, lng: 116.4074 },
    zoom: 9.5,
    timeZone: "Asia/Shanghai",
    stations: { provider: "waqi", network: "China national monitoring network via WAQI", coverage: "dense" },
    standards: { source: "China GB 3095-2012 Grade II (24 h)", pm25: 75, pm10: 150, no2: null, so2: null },
    fireRegion: { bounds: [114.0, 37.5, 119.5, 41.6], label: "Beijing, Tianjin and Hebei" },
    authorities: {
      fire: "Beijing Municipal Urban Management Law Enforcement Bureau — open burning",
      dust: "Beijing Municipal Commission of Housing and Urban-Rural Development — construction dust",
      industrial: "Beijing Municipal Ecology and Environment Bureau",
      smog: "Beijing Traffic Management Bureau",
      particulate: "Beijing Municipal Ecology and Environment Bureau — field inspection",
    },
    localLanguage: { code: "zh", name: "中文" },
    speechLanguage: "cmn-Hans-CN",
    forecastProfile: "generic",
    monitoredAreas: [],
  },
  {
    id: "moscow",
    name: "Moscow",
    country: "Russia",
    countryCode: "ru",
    center: { lat: 55.7558, lng: 37.6173 },
    zoom: 10,
    timeZone: "Europe/Moscow",
    stations: { provider: "waqi", network: "Mosecomonitoring via WAQI", coverage: "dense" },
    standards: { source: "Russia SanPiN 1.2.3685-21 (24 h)", pm25: 35, pm10: 60, no2: null, so2: null },
    fireRegion: { bounds: [35.0, 54.3, 40.5, 57.0], label: "Moscow and neighbouring oblasts" },
    authorities: {
      fire: "Moscow Department of Nature Management and Environmental Protection — open burning",
      dust: "Moscow State Construction Supervision Committee (Mosgosstroynadzor)",
      industrial: "Moscow Department of Nature Management and Environmental Protection",
      smog: "Moscow Department of Transport and Road Infrastructure Development",
      particulate: "Moscow Department of Nature Management and Environmental Protection — field inspection",
    },
    localLanguage: { code: "ru", name: "Русский" },
    speechLanguage: "ru-RU",
    forecastProfile: "generic",
    monitoredAreas: [],
  },
  {
    id: "pretoria",
    name: "Pretoria",
    country: "South Africa",
    countryCode: "za",
    center: { lat: -25.7479, lng: 28.2293 },
    zoom: 10,
    timeZone: "Africa/Johannesburg",
    stations: { provider: "waqi", network: "SAAQIS and local stations via WAQI", coverage: "moderate" },
    standards: { source: "South Africa NAAQS (24 h)", pm25: 40, pm10: 75, no2: null, so2: null },
    fireRegion: { bounds: [26.5, -27.5, 30.5, -24.0], label: "Gauteng and the surrounding Highveld" },
    authorities: {
      fire: "City of Tshwane Emergency Services",
      dust: "City of Tshwane Environment and Agriculture Management — dust control",
      industrial: "City of Tshwane Environment and Agriculture Management — air quality",
      smog: "Tshwane Metro Police Department — traffic",
      particulate: "City of Tshwane Environment and Agriculture Management — field inspection",
    },
    localLanguage: null,
    speechLanguage: "en-ZA",
    forecastProfile: "generic",
    monitoredAreas: [],
  },
  {
    id: "abu-dhabi",
    name: "Abu Dhabi",
    country: "United Arab Emirates",
    countryCode: "ae",
    center: { lat: 24.4539, lng: 54.3773 },
    zoom: 10.5,
    timeZone: "Asia/Dubai",
    stations: { provider: "waqi", network: "Environment Agency Abu Dhabi stations via WAQI", coverage: "moderate" },
    standards: { source: "UAE Cabinet Decree 12/2006; PM2.5 per EAQI 2023 (24 h)", pm25: 60, pm10: 150, no2: null, so2: null },
    fireRegion: { bounds: [52.5, 23.3, 56.0, 25.8], label: "Abu Dhabi and Dubai emirates" },
    authorities: {
      fire: "Abu Dhabi Civil Defence Authority",
      dust: "Abu Dhabi City Municipality — construction dust",
      industrial: "Environment Agency – Abu Dhabi (EAD)",
      smog: "Abu Dhabi Integrated Transport Centre",
      particulate: "Environment Agency – Abu Dhabi (EAD) — field inspection",
    },
    localLanguage: { code: "ar", name: "العربية" },
    speechLanguage: "ar-AE",
    forecastProfile: "generic",
    monitoredAreas: [],
  },
  {
    id: "jakarta",
    name: "Jakarta",
    country: "Indonesia",
    countryCode: "id",
    center: { lat: -6.2088, lng: 106.8456 },
    zoom: 10.5,
    timeZone: "Asia/Jakarta",
    stations: { provider: "waqi", network: "Jakarta stations and sensors via WAQI", coverage: "moderate" },
    standards: { source: "Indonesia PP 22/2021 (24 h)", pm25: 55, pm10: 75, no2: null, so2: null },
    fireRegion: { bounds: [105.5, -7.3, 108.0, -5.5], label: "Jakarta, Banten and West Java" },
    authorities: {
      fire: "Jakarta Environment Agency (Dinas Lingkungan Hidup DKI) — waste burning",
      dust: "Jakarta Environment Agency (Dinas Lingkungan Hidup DKI) — construction dust",
      industrial: "Jakarta Environment Agency (Dinas Lingkungan Hidup DKI)",
      smog: "Jakarta Transportation Agency (Dinas Perhubungan DKI)",
      particulate: "Jakarta Environment Agency (Dinas Lingkungan Hidup DKI) — field inspection",
    },
    localLanguage: { code: "id", name: "Bahasa Indonesia" },
    speechLanguage: "id-ID",
    forecastProfile: "generic",
    monitoredAreas: [],
  },
  {
    id: "brasilia",
    name: "Brasília",
    country: "Brazil",
    countryCode: "br",
    center: { lat: -15.7939, lng: -47.8828 },
    zoom: 10,
    timeZone: "America/Sao_Paulo",
    stations: { provider: "waqi", network: "Distrito Federal sensors via WAQI", coverage: "sparse" },
    standards: { source: "Brazil CONAMA 491/2018 PI-2 (24 h)", pm25: 50, pm10: 100, no2: null, so2: null },
    fireRegion: { bounds: [-50.0, -17.5, -45.5, -14.0], label: "Distrito Federal and the surrounding Cerrado" },
    authorities: {
      fire: "Federal District Military Fire Brigade (CBMDF)",
      dust: "Brasília Ambiental (IBRAM-DF) — construction dust",
      industrial: "Brasília Ambiental (IBRAM-DF)",
      smog: "DETRAN-DF — traffic",
      particulate: "Brasília Ambiental (IBRAM-DF) — field inspection",
    },
    localLanguage: { code: "pt", name: "Português" },
    speechLanguage: "pt-BR",
    forecastProfile: "generic",
    monitoredAreas: [],
  },
];

function boundsOf(rings: Ring[]) {
  const points = rings.flat();
  return {
    minLat: Math.min(...points.map(([, lat]) => lat)),
    maxLat: Math.max(...points.map(([, lat]) => lat)),
    minLng: Math.min(...points.map(([lng]) => lng)),
    maxLng: Math.max(...points.map(([lng]) => lng)),
  };
}

// GeoJSON rings must end where they start; trimmed rings (Jakarta) may not.
function closeRing(ring: Ring): Ring {
  const [firstLng, firstLat] = ring[0];
  const [lastLng, lastLat] = ring[ring.length - 1];
  return firstLng === lastLng && firstLat === lastLat ? ring : [...ring, ring[0]];
}

export const CITIES: CityConfig[] = SEEDS.map((seed) => {
  const boundary = CITY_BOUNDARIES[seed.id].rings.map(closeRing);
  return { ...seed, boundary, bounds: boundsOf(boundary) };
});

export const DEFAULT_CITY_ID = "delhi";

export function getCity(id: string | null | undefined): CityConfig {
  return CITIES.find((city) => city.id === id) ?? CITIES[0];
}

export function findCity(id: string | null | undefined): CityConfig | null {
  return CITIES.find((city) => city.id === id) ?? null;
}

function isInsideRing(ring: Ring, lat: number, lng: number) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [lngI, latI] = ring[i];
    const [lngJ, latJ] = ring[j];
    const crossesLatitude = latI > lat !== latJ > lat;
    const boundaryLng = ((lngJ - lngI) * (lat - latI)) / (latJ - latI) + lngI;
    if (crossesLatitude && lng < boundaryLng) inside = !inside;
  }
  return inside;
}

export function isInCity(city: CityConfig, lat: number, lng: number) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const { minLat, maxLat, minLng, maxLng } = city.bounds;
  if (lat < minLat || lat > maxLat || lng < minLng || lng > maxLng) return false;
  return city.boundary.some((ring) => isInsideRing(ring, lat, lng));
}

/** The monitored city containing this point, or null outside every city. */
export function cityForPoint(lat: number, lng: number): CityConfig | null {
  return CITIES.find((city) => isInCity(city, lat, lng)) ?? null;
}

export function isInOperationalRegion(lat: number, lng: number) {
  return cityForPoint(lat, lng) !== null;
}

// Points just outside a boundary (e.g. a report from Noida) still use the
// nearest city's network, standards and fire region, up to this distance.
const NEAREST_CITY_MAX_KM = 150;

/** The city whose data applies at a point: the one containing it, else the nearest within 150 km. */
export function resolveCityForPoint(lat: number, lng: number): CityConfig | null {
  const inside = cityForPoint(lat, lng);
  if (inside || !Number.isFinite(lat) || !Number.isFinite(lng)) return inside;
  let best: { city: CityConfig; km: number } | null = null;
  for (const city of CITIES) {
    const km = haversineKm(lat, lng, city.center.lat, city.center.lng);
    if (km <= NEAREST_CITY_MAX_KM && (!best || km < best.km)) best = { city, km };
  }
  return best?.city ?? null;
}

/** Formats a timestamp in the city's own time zone. */
export function formatCityTime(
  city: CityConfig,
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
) {
  return new Date(value).toLocaleString("en-GB", { timeZone: city.timeZone, ...options });
}

/** Short zone label for the city's time zone, e.g. "IST", "MSK", "GMT+8". */
export function cityTimeZoneLabel(city: CityConfig) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: city.timeZone, timeZoneName: "short" })
    .formatToParts(new Date())
    .find((item) => item.type === "timeZoneName");
  return city.id === "delhi" ? "IST" : (part?.value ?? city.timeZone);
}
