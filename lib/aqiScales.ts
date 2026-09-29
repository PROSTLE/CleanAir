// The two AQI scales the gauge can show. Indian cities use India's National
// AQI (lib/indiaAqi.ts), computed from every pollutant a station reports.
// BRICS capitals use the US EPA AQI: the station's own overall AQI as WAQI
// publishes it (every pollutant it measures, ozone included), or, for a
// station without one, an estimate from PM.
import { AQI_SCALE as INDIA_BANDS, indiaAqiFromReadings, type PollutantReadings } from "@/lib/indiaAqi";
import { concentrationToUsAqi, PM10_BREAKPOINTS, PM25_BREAKPOINTS } from "@/lib/usAqi";

export type AqiBandInfo = { category: string; color: string; textColor: string };
export type AqiReading = {
  aqi: number;
  /** Display name of the pollutant driving the index. */
  dominant: string;
  info: AqiBandInfo;
  /** "published": the feed's own AQI; "computed": derived here from `pollutants`. */
  basis: "published" | "computed";
  /** Display names of the pollutants a computed AQI used. */
  pollutants: string[];
};
export type AqiScaleId = "india" | "us";

/** The station fields an AQI can be built from. */
export type AqiInput = PollutantReadings & {
  aqi?: number | null;
  dominantPollutant?: string | null;
  stale?: boolean;
};

export type AqiScale = {
  id: AqiScaleId;
  /** Translation key for the scale's name. */
  labelKey: string;
  bands: ReadonlyArray<{ from: number; to: number; info: AqiBandInfo }>;
  fromStation: (station: AqiInput) => AqiReading | null;
  /** PM-only estimate, kept for callers that only have PM. */
  fromPm: (pm25: number | null | undefined, pm10: number | null | undefined) => AqiReading | null;
};

// EPA band edges and categories, in colours tuned to the app's palette.
const US_BANDS: ReadonlyArray<{ from: number; to: number; info: AqiBandInfo }> = [
  { from: 0, to: 50, info: { category: "aqi_us_good", color: "#3a9d5d", textColor: "#236b3c" } },
  { from: 50, to: 100, info: { category: "aqi_us_moderate", color: "#d4b62c", textColor: "#7d6a16" } },
  { from: 100, to: 150, info: { category: "aqi_us_usg", color: "#e0862b", textColor: "#9a5214" } },
  { from: 150, to: 200, info: { category: "aqi_us_unhealthy", color: "#c0392b", textColor: "#8f2a1f" } },
  { from: 200, to: 300, info: { category: "aqi_us_very_unhealthy", color: "#7d3c98", textColor: "#5b2a70" } },
  { from: 300, to: 500, info: { category: "aqi_us_hazardous", color: "#7a1a2e", textColor: "#6a1526" } },
];

// WAQI's pollutant codes → display names.
const FEED_POLLUTANT_LABELS: Record<string, string> = {
  pm25: "PM2.5",
  pm10: "PM10",
  o3: "O₃",
  no2: "NO₂",
  so2: "SO₂",
  co: "CO",
};

function bandFor(bands: AqiScale["bands"], aqi: number): AqiBandInfo {
  return (bands.find((band) => aqi <= band.to) ?? bands[bands.length - 1]).info;
}

function usAqiFromPm(pm25: number | null | undefined, pm10: number | null | undefined): AqiReading | null {
  const fromPm25 = concentrationToUsAqi(pm25, PM25_BREAKPOINTS);
  const fromPm10 = concentrationToUsAqi(pm10, PM10_BREAKPOINTS);
  if (fromPm25 === null && fromPm10 === null) return null;
  const dominant = fromPm10 !== null && (fromPm25 === null || fromPm10 > fromPm25) ? "PM10" : "PM2.5";
  const aqi = Math.max(fromPm25 ?? 0, fromPm10 ?? 0);
  const pollutants = [fromPm25 !== null && "PM2.5", fromPm10 !== null && "PM10"].filter((value): value is string => !!value);
  return { aqi, dominant, info: bandFor(US_BANDS, aqi), basis: "computed", pollutants };
}

function usAqiFromStation(station: AqiInput): AqiReading | null {
  if (station.stale) return null;
  if (typeof station.aqi === "number" && Number.isFinite(station.aqi) && station.aqi >= 0) {
    const aqi = Math.round(station.aqi);
    const code = station.dominantPollutant?.toLowerCase() ?? "";
    return {
      aqi,
      dominant: FEED_POLLUTANT_LABELS[code] ?? (code.toUpperCase() || "—"),
      info: bandFor(US_BANDS, aqi),
      basis: "published",
      pollutants: [],
    };
  }
  return usAqiFromPm(station.pm25, station.pm10);
}

function indiaFromStation(station: AqiInput): AqiReading | null {
  if (station.stale) return null;
  const reading = indiaAqiFromReadings(station);
  return reading && { ...reading, basis: "computed" };
}

export const AQI_SCALES: Record<AqiScaleId, AqiScale> = {
  india: {
    id: "india",
    labelKey: "aqi_gauge_scale_label",
    bands: INDIA_BANDS,
    fromStation: indiaFromStation,
    fromPm: (pm25, pm10) => indiaFromStation({ pm25, pm10 }),
  },
  us: {
    id: "us",
    labelKey: "aqi_gauge_scale_label_us",
    bands: US_BANDS,
    fromStation: usAqiFromStation,
    fromPm: usAqiFromPm,
  },
};

/**
 * City-wide AQI as the median of its live stations' AQI: one very polluted
 * street shouldn't read as the whole city, nor one clean park.
 */
export function medianStationAqi(
  stations: ReadonlyArray<AqiInput>,
  scale: AqiScale = AQI_SCALES.india,
): { aqi: AqiReading; stations: number } | null {
  const values = stations
    .map((station) => scale.fromStation(station))
    .filter((value): value is AqiReading => value !== null)
    .sort((a, b) => a.aqi - b.aqi);
  if (values.length === 0) return null;
  const middle = Math.floor(values.length / 2);
  const aqi =
    values.length % 2 === 1 ? values[middle].aqi : Math.round((values[middle - 1].aqi + values[middle].aqi) / 2);
  // The dominant pollutant is the one most stations are led by.
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value.dominant, (counts.get(value.dominant) ?? 0) + 1);
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const basis = values.every((value) => value.basis === "published") ? "published" : "computed";
  const pollutants = [...new Set(values.flatMap((value) => value.pollutants))];
  return { aqi: { aqi, dominant, info: bandFor(scale.bands, aqi), basis, pollutants }, stations: values.length };
}
