import type { HazardType, Incident, IncidentEvidence } from "@/lib/types";
import { determineTier, tierPromotionReason } from "@/lib/supportEvidence";

const fallbackH3ByHazard: Record<HazardType, string> = {
  dust: "883da118c3fffff",
  fire: "883da118d7fffff",
  industrial: "883da1198bfffff",
  particulate: "883da1189bfffff",
  smog: "883da1189bfffff",
};

// Fallback evidence generator: only runs when a doc has no stored `validation`
// (mock data, or a doc that predates the classify-report pipeline). This is
// display-only — it never affects real promotion, which lives in
// reportSubmissions.ts / lib/ambientScan.ts and uses live sensor/satellite reads.
export function buildIncidentEvidence(incident: Incident): IncidentEvidence {
  const reports = incident.corroboratingReports ?? (incident.source === "citizen" ? 1 : 0);
  const lowCoverage = incident.source === "citizen" && reports >= 2;
  const satelliteFresh = incident.source === "satellite" || incident.severity === "critical";
  const nearestSensorKm = lowCoverage ? 3.2 : incident.source === "sensor" ? 0.4 : 1.6;
  const coverageLevel = nearestSensorKm > 2.5 ? "low" : nearestSensorKm > 1 ? "limited" : "good";
  const citizenBoost = Math.min(12, reports * 3);
  const coverageBoost = coverageLevel === "low" ? 8 : coverageLevel === "limited" ? 4 : 0;
  const satelliteBoost = satelliteFresh ? 5 : 1;
  const finalConfidence = Math.min(
    98,
    incident.aiConfidence + citizenBoost + coverageBoost + satelliteBoost,
  );

  // Approximate sensor/satellite "support" from source/severity since this
  // fallback path has no live readings to check against.
  const sensorSupported = incident.source === "sensor" || (incident.source === "citizen" && coverageLevel !== "low");
  const satelliteSupported = incident.source === "satellite" || satelliteFresh;
  const statusImpliesPromoted =
    incident.status === "verified" || incident.status === "dispatched" || incident.status === "predicted";

  const tier =
    determineTier({ reportCount: reports, sensorSupported, satelliteSupported }) ??
    (statusImpliesPromoted ? "crowd_verified" : null);
  const alertTier = tier !== null;

  return {
    alertReason:
      coverageLevel === "low"
        ? `${reports} citizen reports in a low station coverage zone; citizen corroboration is driving the alert.`
        : `${incident.source} signal corroborated with nearby reports and satellite context.`,
    alertTier,
    tier,
    citizenSignal: {
      reportCount: reports,
      windowMinutes: reports >= 3 ? 14 : 28,
      averageConfidence: incident.aiConfidence,
    },
    coverage: {
      level: coverageLevel,
      nearestSensorKm,
      label:
        coverageLevel === "low"
          ? "Low station coverage"
          : coverageLevel === "limited"
            ? "Limited station coverage"
            : "Nearby sensor coverage",
    },
    fusion: {
      finalConfidence,
      coverageAdjusted: coverageLevel !== "good",
      h3CellId: fallbackH3ByHazard[incident.hazardType],
      visualWeight: incident.source === "citizen" ? 0.45 : 0,
      sensorWeight: coverageLevel === "low" ? 0.12 : 0.34,
      satelliteWeight: satelliteFresh ? 0.32 : 0.2,
    },
    promotionReason: tier ? tierPromotionReason(tier, reports) : "Waiting for corroboration before municipal alert.",
    satellite: {
      source: "Earth Engine",
      signal: satelliteFresh
        ? "NO2/aerosol anomaly overlaps cell"
        : "Last pass broad signal not decisive",
      lastPassTime: satelliteFresh ? "09:42" : "Yesterday 10:18",
      freshness: satelliteFresh ? "fresh" : "stale",
    },
    sensor: {
      pm25Delta: incident.source === "sensor" ? 42 : coverageLevel === "low" ? 8 : 18,
      source: "estimated",
      trend: incident.severity === "critical" ? "rising" : "flat",
    },
  };
}
