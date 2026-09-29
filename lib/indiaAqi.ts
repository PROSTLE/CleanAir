// India's National Air Quality Index (CPCB, 2014). Each pollutant gets a
// sub-index by linear interpolation inside its concentration band; the AQI
// is the highest sub-index. The official daily AQI uses 24-hour averages
// (8-hour for CO and O3) of at least three pollutants including PM2.5 or
// PM10. Built from each station's latest readings, as here, it is an
// estimate of the current AQI, and the UI says which pollutants it used.
import { getAQIInfo, type AQIInfo } from "@/lib/forecastEngine";

type Band = readonly [cLow: number, cHigh: number, iLow: number, iHigh: number];

// Concentration → index. µg/m³, except CO in mg/m³. Upper edges are
// inclusive; the Severe band is open-ended in the CPCB table, so its upper
// edge here only sets where the index reaches its 500 ceiling.
const BANDS = {
  pm25: [[0, 30, 0, 50], [30, 60, 50, 100], [60, 90, 100, 200], [90, 120, 200, 300], [120, 250, 300, 400], [250, 380, 400, 500]],
  pm10: [[0, 50, 0, 50], [50, 100, 50, 100], [100, 250, 100, 200], [250, 350, 200, 300], [350, 430, 300, 400], [430, 510, 400, 500]],
  no2: [[0, 40, 0, 50], [40, 80, 50, 100], [80, 180, 100, 200], [180, 280, 200, 300], [280, 400, 300, 400], [400, 800, 400, 500]],
  so2: [[0, 40, 0, 50], [40, 80, 50, 100], [80, 380, 100, 200], [380, 800, 200, 300], [800, 1600, 300, 400], [1600, 2400, 400, 500]],
  co: [[0, 1, 0, 50], [1, 2, 50, 100], [2, 10, 100, 200], [10, 17, 200, 300], [17, 34, 300, 400], [34, 50, 400, 500]],
  ozone: [[0, 50, 0, 50], [50, 100, 50, 100], [100, 168, 100, 200], [168, 208, 200, 300], [208, 748, 300, 400], [748, 1000, 400, 500]],
  nh3: [[0, 200, 0, 50], [200, 400, 50, 100], [400, 800, 100, 200], [800, 1200, 200, 300], [1200, 1800, 300, 400], [1800, 2400, 400, 500]],
} satisfies Record<string, readonly Band[]>;

export type AqiPollutant = keyof typeof BANDS;

/** Display names, in the order the UI lists them. */
export const POLLUTANT_LABELS: Record<AqiPollutant, string> = {
  pm25: "PM2.5",
  pm10: "PM10",
  no2: "NO₂",
  so2: "SO₂",
  co: "CO",
  ozone: "O₃",
  nh3: "NH₃",
};

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

export type IndiaAqi = {
  aqi: number;
  /** Display name of the pollutant with the highest sub-index. */
  dominant: string;
  info: AQIInfo;
  /** Display names of every pollutant that contributed a sub-index. */
  pollutants: string[];
};

export type PollutantReadings = Partial<Record<AqiPollutant, number | null>>;

/** AQI estimate from every pollutant a station reports, or null when it reports none. */
export function indiaAqiFromReadings(readings: PollutantReadings): IndiaAqi | null {
  let best: { pollutant: AqiPollutant; value: number } | null = null;
  const used: string[] = [];
  for (const pollutant of Object.keys(BANDS) as AqiPollutant[]) {
    const value = subIndex(readings[pollutant], BANDS[pollutant]);
    if (value === null) continue;
    used.push(POLLUTANT_LABELS[pollutant]);
    if (!best || value > best.value) best = { pollutant, value };
  }
  if (!best) return null;
  return { aqi: best.value, dominant: POLLUTANT_LABELS[best.pollutant], info: aqiInfo(best.value), pollutants: used };
}

/** AQI estimate from PM2.5 and PM10 alone. */
export function indiaAqiFromPm(pm25: number | null | undefined, pm10: number | null | undefined): IndiaAqi | null {
  return indiaAqiFromReadings({ pm25, pm10 });
}
