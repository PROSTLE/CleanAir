// US EPA AQI sub-index -> concentration (µg/m³), the inverse of the EPA
// formula. WAQI publishes sub-indices on the 2012 EPA scale, so these are the
// 2012 PM2.5 breakpoints (not the May 2024 revision) and the unchanged PM10 ones.
// [aqiLow, aqiHigh, concentrationLow, concentrationHigh]
export type Breakpoint = readonly [number, number, number, number];
export const PM25_BREAKPOINTS: Breakpoint[] = [
  [0, 50, 0, 12.0],
  [51, 100, 12.1, 35.4],
  [101, 150, 35.5, 55.4],
  [151, 200, 55.5, 150.4],
  [201, 300, 150.5, 250.4],
  [301, 400, 250.5, 350.4],
  [401, 500, 350.5, 500.4],
];
export const PM10_BREAKPOINTS: Breakpoint[] = [
  [0, 50, 0, 54],
  [51, 100, 55, 154],
  [101, 150, 155, 254],
  [151, 200, 255, 354],
  [201, 300, 355, 424],
  [301, 400, 425, 504],
  [401, 500, 505, 604],
];

/** Inverse of the EPA AQI formula: sub-index → concentration. */
export function usAqiToConcentration(aqi: number | undefined, table: Breakpoint[]): number | null {
  if (typeof aqi !== "number" || !Number.isFinite(aqi) || aqi < 0) return null;
  let row = table.find(([, aqiHigh]) => aqi <= aqiHigh);
  // WAQI keeps scaling past 500; extend the last segment linearly.
  row ??= table[table.length - 1];
  const [aqiLow, aqiHigh, cLow, cHigh] = row;
  const value = aqi <= aqiLow ? cLow : ((aqi - aqiLow) / (aqiHigh - aqiLow)) * (cHigh - cLow) + cLow;
  return Number(value.toFixed(1));
}
