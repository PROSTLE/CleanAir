// India's National Air Quality Index (CPCB, 2014). Each pollutant gets a
// sub-index by linear interpolation inside its concentration band; the AQI
// is the highest sub-index. The official daily AQI uses 24-hour averages of
// at least three pollutants including PM2.5 or PM10. Built from the latest
// PM readings, as here, it is an estimate of the current AQI, and the UI
// labels it that way.
import { getAQIInfo, type AQIInfo } from "@/lib/forecastEngine";

type Band = readonly [cLow: number, cHigh: number, iLow: number, iHigh: number];

// µg/m³ → index. Upper edges are inclusive; the Severe band is open-ended in
// the CPCB table, so it is capped at the index's 500 ceiling.
const PM25_BANDS: readonly Band[] = [
  [0, 30, 0, 50],
  [30, 60, 50, 100],
  [60, 90, 100, 200],
  [90, 120, 200, 300],
  [120, 250, 300, 400],
  [250, 380, 400, 500],
];

const PM10_BANDS: readonly Band[] = [
  [0, 50, 0, 50],
  [50, 100, 50, 100],
  [100, 250, 100, 200],
  [250, 350, 200, 300],
  [350, 430, 300, 400],
  [430, 510, 400, 500],
];

export const AQI_MAX = 500;

/** Index band edges (0–500) with their category, for drawing the scale. */
export const AQI_SCALE: ReadonlyArray<{ from: number; to: number; info: AQIInfo }> = [
  [0, 50],
  [50, 100],
  [100, 200],
  [200, 300],
  [300, 400],
  [400, 500],
].map(([from, to]) => ({ from, to, info: aqiInfo(to) }));

function subIndex(concentration: number | null | undefined, bands: readonly Band[]): number | null {
  if (concentration == null || !Number.isFinite(concentration) || concentration < 0) return null;
  for (const [cLow, cHigh, iLow, iHigh] of bands) {
    if (concentration <= cHigh) {
      return Math.round(iLow + ((concentration - cLow) * (iHigh - iLow)) / (cHigh - cLow));
    }
  }
  return AQI_MAX;
}

/** Category and colours for an index value (0–500). */
export function aqiInfo(aqi: number): AQIInfo {
  // The index bands end where the PM2.5 bands in getAQIInfo end
  // (50↔30, 100↔60, 200↔90, 300↔120, 400↔250 µg/m³), so reuse its colours.
  const pm25Edge = aqi <= 50 ? 30 : aqi <= 100 ? 60 : aqi <= 200 ? 90 : aqi <= 300 ? 120 : aqi <= 400 ? 250 : 251;
  return getAQIInfo(pm25Edge);
}

export type IndiaAqi = { aqi: number; dominant: "PM2.5" | "PM10"; info: AQIInfo };

/** AQI estimate from the latest PM2.5 and PM10, or null when neither is known. */
export function indiaAqiFromPm(pm25: number | null | undefined, pm10: number | null | undefined): IndiaAqi | null {
  const fromPm25 = subIndex(pm25, PM25_BANDS);
  const fromPm10 = subIndex(pm10, PM10_BANDS);
  if (fromPm25 === null && fromPm10 === null) return null;
  const dominant = fromPm10 !== null && (fromPm25 === null || fromPm10 > fromPm25) ? "PM10" : "PM2.5";
  const aqi = Math.max(fromPm25 ?? 0, fromPm10 ?? 0);
  return { aqi, dominant, info: aqiInfo(aqi) };
}
