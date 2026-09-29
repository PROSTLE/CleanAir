// The two AQI scales the gauge can show. Indian cities use India's National
// AQI (lib/indiaAqi.ts); BRICS capitals use the US EPA AQI, the index their
// WAQI stations publish. Both run 0–500 and are estimates from the latest PM
// readings, not official 24-hour indices.
import { AQI_SCALE as INDIA_BANDS, indiaAqiFromPm } from "@/lib/indiaAqi";
import { concentrationToUsAqi, PM10_BREAKPOINTS, PM25_BREAKPOINTS } from "@/lib/usAqi";

export type AqiBandInfo = { category: string; color: string; textColor: string };
export type AqiReading = { aqi: number; dominant: "PM2.5" | "PM10"; info: AqiBandInfo };
export type AqiScaleId = "india" | "us";

export type AqiScale = {
  id: AqiScaleId;
  /** Translation key for the scale's name. */
  labelKey: string;
  bands: ReadonlyArray<{ from: number; to: number; info: AqiBandInfo }>;
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

function usBand(aqi: number): AqiBandInfo {
  return (US_BANDS.find((band) => aqi <= band.to) ?? US_BANDS[US_BANDS.length - 1]).info;
}

function usAqiFromPm(pm25: number | null | undefined, pm10: number | null | undefined): AqiReading | null {
  const fromPm25 = concentrationToUsAqi(pm25, PM25_BREAKPOINTS);
  const fromPm10 = concentrationToUsAqi(pm10, PM10_BREAKPOINTS);
  if (fromPm25 === null && fromPm10 === null) return null;
  const dominant = fromPm10 !== null && (fromPm25 === null || fromPm10 > fromPm25) ? "PM10" : "PM2.5";
  const aqi = Math.max(fromPm25 ?? 0, fromPm10 ?? 0);
  return { aqi, dominant, info: usBand(aqi) };
}

export const AQI_SCALES: Record<AqiScaleId, AqiScale> = {
  india: { id: "india", labelKey: "aqi_gauge_scale_label", bands: INDIA_BANDS, fromPm: indiaAqiFromPm },
  us: { id: "us", labelKey: "aqi_gauge_scale_label_us", bands: US_BANDS, fromPm: usAqiFromPm },
};

/**
 * City-wide AQI as the median of its live stations' estimates: one very
 * polluted street shouldn't read as the whole city, nor one clean park.
 */
export function medianStationAqi(
  stations: ReadonlyArray<{ pm25: number | null; pm10: number | null; stale?: boolean }>,
  scale: AqiScale = AQI_SCALES.india,
): { aqi: AqiReading; stations: number } | null {
  const values = stations
    .filter((station) => !station.stale)
    .map((station) => scale.fromPm(station.pm25, station.pm10))
    .filter((value): value is AqiReading => value !== null)
    .sort((a, b) => a.aqi - b.aqi);
  if (values.length === 0) return null;
  const middle = Math.floor(values.length / 2);
  const aqi =
    values.length % 2 === 1 ? values[middle].aqi : Math.round((values[middle - 1].aqi + values[middle].aqi) / 2);
  // The dominant pollutant is the one most stations are led by.
  const pm10Led = values.filter((value) => value.dominant === "PM10").length;
  const info = scale.bands.find((entry) => aqi <= entry.to)?.info ?? scale.bands[scale.bands.length - 1].info;
  return { aqi: { aqi, dominant: pm10Led > values.length / 2 ? "PM10" : "PM2.5", info }, stations: values.length };
}
