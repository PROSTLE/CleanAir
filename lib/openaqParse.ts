// Pure parsing for OpenAQ v3 responses (lib/server/openaq.ts does the
// fetching), kept free of server-only imports so it can be unit-tested.
import type { StationReading } from "@/lib/stations";
import { SENSOR_READING_MAX_AGE_HOURS } from "@/lib/supportEvidence";

export type DatetimeObject = { utc?: string; local?: string } | null;
export type ParameterBase = { id?: number; name?: string; units?: string };
export type SensorBase = { id?: number; name?: string; parameter?: ParameterBase };
export type OpenAqLocation = {
  id?: number;
  name?: string | null;
  locality?: string | null;
  isMobile?: boolean;
  isMonitor?: boolean;
  owner?: { name?: string } | null;
  provider?: { name?: string } | null;
  sensors?: SensorBase[];
  coordinates?: { latitude?: number | null; longitude?: number | null } | null;
  datetimeLast?: DatetimeObject;
};
export type OpenAqLatest = { datetime?: DatetimeObject; value?: number; sensorsId?: number };

type PollutantKey = "pm25" | "pm10" | "no2" | "so2" | "co" | "nh3" | "ozone";

export function isRecent(ms: number | null, nowMs = Date.now()) {
  return ms !== null && nowMs - ms <= SENSOR_READING_MAX_AGE_HOURS * 3_600_000;
}

/** Maps an OpenAQ parameter to our field, or null when its unit can't be stated honestly in ours. */
export function openAqPollutant(parameter: ParameterBase | undefined): { key: PollutantKey; scale: number } | null {
  const name = parameter?.name?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
  // OpenAQ writes µ with either the micro sign or the Greek letter.
  const units = parameter?.units?.toLowerCase().replace("μ", "µ").replace(/\s/g, "") ?? "";
  const microgram = units === "µg/m³" || units === "µg/m3" || units === "ug/m3";
  const key: PollutantKey | null =
    name === "pm25" ? "pm25"
      : name === "pm10" ? "pm10"
        : name === "no2" ? "no2"
          : name === "so2" ? "so2"
            : name === "co" ? "co"
              : name === "nh3" ? "nh3"
                : name === "o3" || name === "ozone" ? "ozone"
                  : null;
  if (!key) return null;
  // CO is kept in mg/m³, as CPCB reports it; ppm/ppb gases are skipped
  // rather than converted with an assumed temperature.
  if (key === "co") {
    if (units === "mg/m³" || units === "mg/m3") return { key, scale: 1 };
    return microgram ? { key, scale: 0.001 } : null;
  }
  return microgram ? { key, scale: 1 } : null;
}

/** Fills a station's values from /locations/{id}/latest, keeping only values from the last day. */
export function applyLatest(station: StationReading, location: OpenAqLocation, latest: OpenAqLatest[], nowMs = Date.now()) {
  const sensors = new Map((location.sensors ?? []).map((sensor) => [sensor.id, sensor]));
  let newestMs: number | null = null;
  for (const item of latest) {
    const pollutant = openAqPollutant(sensors.get(item.sensorsId)?.parameter);
    const atMs = item.datetime?.utc ? Date.parse(item.datetime.utc) : NaN;
    if (!pollutant || typeof item.value !== "number" || !Number.isFinite(item.value) || item.value < 0) continue;
    if (!isRecent(Number.isFinite(atMs) ? atMs : null, nowMs)) continue;
    station[pollutant.key] = Number((item.value * pollutant.scale).toFixed(pollutant.key === "co" ? 2 : 1));
    if (newestMs === null || atMs > newestMs) newestMs = atMs;
  }
  if (newestMs !== null) station.lastUpdated = new Date(newestMs).toISOString();
  station.stale = newestMs === null;
  return station;
}
