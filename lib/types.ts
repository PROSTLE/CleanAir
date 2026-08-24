// "particulate" is reserved for sensor/satellite-only (ambient) detections
// where a PM2.5/aerosol spike is elevated but there's no citizen photo yet
// to tell a fire apart from general smog/haze — see lib/ambientScan.ts.
// Citizen reports always resolve to a specific "fire" or "smog" once Gemini
// has actually looked at a photo (lib/firestoreReports.ts).
export type HazardType = "fire" | "smog" | "dust" | "industrial" | "particulate";

export type Severity = "low" | "medium" | "critical";

export type IncidentStatus =
  | "pending"
  | "under_review"
  | "classified"
  | "classification_failed"
  | "no_signal"
  | "verified"
  | "dispatched"
  | "resolved"
  | "predicted";

export type Source = "citizen" | "sensor" | "satellite";

export type HealthRisk = "low" | "medium" | "high";

// Ranked highest-confidence first. Two independent physical sources agreeing
// (sensor + satellite) outranks crowd corroboration, which outranks a single
// citizen report backed by only one instrument channel.
export type PromotionTier =
  | "sensor_satellite_confirmed"
  | "crowd_verified"
  | "citizen_sensor_confirmed"
  | "citizen_satellite_confirmed"
  | "sensor_detected"
  | "satellite_detected";

export interface IncidentEvidence {
  alertReason: string;
  alertTier: boolean;
  // Set only once an incident has actually cleared a promotion path (see
  // lib/supportEvidence.ts). Undefined/null means "not yet promoted."
  tier?: PromotionTier | null;
  citizenSignal: {
    reportCount: number;
    windowMinutes: number;
    averageConfidence: number;
  };
  coverage: {
    level: "good" | "limited" | "low";
    nearestSensorKm: number;
    label: string;
  };
  fusion: {
    finalConfidence: number;
    coverageAdjusted: boolean;
    h3CellId: string;
    visualWeight: number;
    sensorWeight: number;
    satelliteWeight: number;
    // Only present on crowd-corroborated (>= 3 report) promotions — the
    // weight independent citizen agreement contributed to finalConfidence.
    corroborationWeight?: number;
  };
  promotionReason: string;
  satellite: {
    source: "Earth Engine" | "Earth Engine / Sentinel-5P";
    signal: string;
    computedAt?: string;
    lastPassTime: string;
    windowStart?: string;
    windowEnd?: string;
    freshness: "fresh" | "stale";
    // 0-1 anomaly score for the hazard-relevant Sentinel-5P band
    // (aerosol index for dust/particulate, NO2 for industrial/smog). Used to
    // decide whether satellite data actually *supports* a hazard, not just
    // context.
    anomalyScore?: number;
    hazardWeight?: number;
    aerosolIndexAnomaly?: number;
    aerosolIndexRaw?: number | null;
    fireDustSmokeWeight?: number;
    industrialTrafficWeight?: number;
    no2Anomaly?: number;
    rawNo2?: number | null;
    selectedChannel?: "balanced" | "fireDustSmoke" | "industrialTraffic";
  };
  sensor: {
    pm25Delta: number;
    primaryDelta?: number;
    primaryName?: string;
    primaryValue?: number | null;
    localBaselineDeltaPct?: number | null;
    localBaselineValue?: number | null;
    cityBaselineDeltaPct?: number | null;
    cityBaselineValue?: number | null;
    consecutiveObservations?: number;
    immediate?: boolean;
    incidentThreshold?: number;
    watchThreshold?: number;
    baselineSource?: "station_history" | "delhi_median";
    trend: "rising" | "flat" | "falling" | "insufficient_data";
    source?: "CPCB" | "estimated";
    stationName?: string;
    distanceKm?: number;
    lastUpdated?: string;
    pm25?: number | null;
    pm10?: number | null;
    no2?: number | null;
    so2?: number | null;
  };
}

export interface Incident {
  id: string;
  photoUrl: string;
  hazardType: HazardType;
  latitude: number;
  longitude: number;
  severity: Severity;
  status: IncidentStatus;
  aiConfidence: number; // 0-100
  healthRisk: HealthRisk;
  source: Source;
  timestamp: string; // ISO string
  isAnonymous: boolean;
  neighborhood: string;
  note?: string;
  citizenNotes?: string[];
  corroboratingReports?: number;
  evidence?: IncidentEvidence;
  h3CellId?: string;
  linkedReportIds?: string[];
  dispatchStatus?: "dispatched";
  dispatchedAction?: string;
  dispatchedAt?: string;
  resolvedAt?: string;
  // Ambient-scan-only fields — set when source is sensor/satellite and no
  // citizen report exists. Lists every hazard category whose sensor/satellite
  // threshold was crossed (e.g. ["dust","industrial"]) so the map can show
  // "Possible sources" rather than picking one label. triggerPollutants lists
  // the sensor pollutant(s) that actually crossed the event threshold; elevatedPollutants
  // is retained as raw observed sensor context and legacy popup fallback.
  possibleSources?: string[];
  triggerPollutants?: Array<{
    deltaPct: number;
    name: string;
    value: number | null;
  }>;
  elevatedPollutants?: {
    pm25?: number | null;
    pm10?: number | null;
    no2?: number | null;
    so2?: number | null;
  };
}

export interface ForecastPoint {
  time: string; // e.g. "14:00"
  pm25: number;
}

export interface NeighborhoodForecast {
  id: string;
  neighborhood: string;
  currentPm25: number;
  peakPm25: number;
  peakTime: string;
  windDirection: string; // e.g. "NE"
  windSpeed: number; // km/h
  humidity: number; // %
  riskLevel: Severity;
  points: ForecastPoint[];
}

export interface LiveStats {
  activeHotspots: number;
  resolvedToday: number;
  avgResponseTimeMinutes: number;
}
