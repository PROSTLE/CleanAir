// Single source of truth for "fusion confidence" across all three detection
// paths (citizen report, crowd-corroborated promotion, ambient scan).
//
// Previously each path computed finalConfidence differently — a Gemini
// score plus a small satellite nudge in one, a flat max() in another — while
// all three *displayed* fixed visualWeight/sensorWeight/satelliteWeight
// percentages next to the number as if it were a real weighted fusion. It
// wasn't: the weights were static constants that never entered the actual
// calculation, and ambient (sensor/satellite-only) incidents displayed a
// "Visual X%" figure despite having no photo at all.
//
// This module makes the weights real: every source that actually has data
// gets scored 0-100 on the same scale, missing sources are excluded (not
// zeroed), and the displayed weights are the *actual* normalized weights
// used to compute finalConfidence — not decoration.

export interface FusionSources {
  /** Gemini's own photo confidence x 100. null if no photo/classification exists. */
  visualScore: number | null;
  /** Derived from a real nearby-station pollutant reading. null if no usable station data. */
  sensorScore: number | null;
  /** Derived from a real Sentinel-5P read. null if the satellite fetch failed/unavailable. */
  satelliteScore: number | null;
  /** Derived from independent citizen report count. null outside the promotion path. */
  corroborationScore: number | null;
}

export interface FusionResult {
  finalConfidence: number;
  visualWeight: number;
  sensorWeight: number;
  satelliteWeight: number;
  corroborationWeight: number;
}

// Relative importance when a source is present. These only ever get
// *renormalized* across whichever sources actually have data — a report
// with no photo doesn't silently get a 0%-visual entry, it gets no visual
// entry at all, and sensor+satellite pick up its share of the weight.
const BASE_WEIGHT = {
  visual: 0.45,
  sensor: 0.2,
  satellite: 0.2,
  corroboration: 0.15,
} as const;

export function computeFusionConfidence(sources: FusionSources): FusionResult {
  const present: Array<{ key: keyof typeof BASE_WEIGHT; score: number }> = [];
  if (sources.visualScore !== null) present.push({ key: "visual", score: sources.visualScore });
  if (sources.sensorScore !== null) present.push({ key: "sensor", score: sources.sensorScore });
  if (sources.satelliteScore !== null) present.push({ key: "satellite", score: sources.satelliteScore });
  if (sources.corroborationScore !== null) {
    present.push({ key: "corroboration", score: sources.corroborationScore });
  }

  const weights = { visual: 0, sensor: 0, satellite: 0, corroboration: 0 };

  if (present.length === 0) {
    return { finalConfidence: 0, visualWeight: 0, sensorWeight: 0, satelliteWeight: 0, corroborationWeight: 0 };
  }

  const totalBaseWeight = present.reduce((sum, p) => sum + BASE_WEIGHT[p.key], 0);
  let weightedSum = 0;
  for (const p of present) {
    const normalized = BASE_WEIGHT[p.key] / totalBaseWeight;
    weights[p.key] = normalized;
    weightedSum += p.score * normalized;
  }

  return {
    finalConfidence: Math.round(Math.min(99, Math.max(0, weightedSum))),
    visualWeight: weights.visual,
    sensorWeight: weights.sensor,
    satelliteWeight: weights.satellite,
    corroborationWeight: weights.corroboration,
  };
}

/**
 * Converts a sensor's "% above CPCB 24h reference" delta into a 0-100 score on
 * the same scale as the other sources. 50% (the support threshold used
 * elsewhere in the app) maps to 75; scales up to a 95 ceiling; floors at 0
 * for a flat/negative delta rather than going negative.
 */
export function sensorDeltaToScore(deltaPct: number): number {
  return Math.max(0, Math.min(95, 50 + deltaPct / 2));
}

/** Converts a satellite hazard-channel weight (0-1) into a 0-100 score. */
export function satelliteWeightToScore(hazardWeight: number): number {
  return Math.max(0, Math.min(100, Math.round(hazardWeight * 100)));
}

/**
 * Converts independent citizen report count into a 0-100 score. Only
 * meaningful once the promotion threshold (3) has already been reached —
 * this isn't used for a single unclustered report.
 */
export function corroborationCountToScore(reportCount: number): number {
  return Math.max(0, Math.min(95, 40 + reportCount * 15));
}
