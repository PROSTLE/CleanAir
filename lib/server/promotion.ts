import "server-only";

import type { DocumentReference, Timestamp } from "firebase-admin/firestore";
import { cellToLatLng } from "h3-js";
import { adminDb, adminServerTimestamp } from "@/lib/firebaseAdmin";
import { resolveIncidentHazardType } from "@/lib/firestoreReports";
import {
  computeFusionConfidence,
  corroborationCountToScore,
  satelliteWeightToScore,
  sensorDeltaToScore,
} from "@/lib/fusionConfidence";
import { getSeverity } from "@/lib/geo";
import type { HazardType, IncidentEvidence, ReportIntegrity } from "@/lib/types";
import {
  checkStoredSensorSupport,
  checkStoredSatelliteSupport,
  determineTier,
  getStoredSatelliteAnomaly,
  tierPromotionReason,
} from "@/lib/supportEvidence";

interface StoredReport {
  aiConfidence?: number;
  createdAt?: Timestamp;
  status?: string;
  geminiClassification?: {
    confidence?: number;
    severity?: number | string;
    type?: string;
  };
  h3CellId?: string;
  hazardId?: string;
  hazardLabel?: string;
  integrity?: ReportIntegrity;
  location?: {
    label?: string;
    lat?: string;
    lng?: string;
  };
  note?: string;
  photoUrl?: string;
  validation?: IncidentEvidence;
}

const POLLUTION_TYPES = new Set(["dust", "fire", "haze", "smoke"]);
const HAZARD_PROMOTION_WINDOW_HOURS: Record<HazardType, number> = {
  dust: 7 * 24,
  fire: 7 * 24,
  industrial: 7 * 24,
  particulate: 3 * 24,
  smog: 3 * 24,
};

function getPollutionSignalConfidence(report: StoredReport) {
  const classification = report.geminiClassification;
  if (!classification?.type || !POLLUTION_TYPES.has(classification.type)) return 0;

  const severity =
    typeof classification.severity === "number"
      ? classification.severity
      : Number(classification.severity ?? 0);
  if (!Number.isFinite(severity) || severity <= 0) return 0;

  const confidence = classification.confidence ?? 0;
  return confidence <= 1 ? Math.round(confidence * 100) : Math.round(confidence);
}

function isWithinPromotionWindow(report: StoredReport, nowMs: number, windowHours: number) {
  const createdAtMs = report.createdAt?.toDate().getTime();
  if (typeof createdAtMs !== "number" || !Number.isFinite(createdAtMs)) return false;
  return nowMs - createdAtMs <= windowHours * 60 * 60 * 1000;
}

/**
 * Promotes a cell's citizen reports to a municipal incident once a
 * promotion path is satisfied (see determineTier). Runs in an Admin SDK
 * transaction so concurrent classifications for the same cell see a
 * consistent view — the Admin SDK can read the whole query transactionally.
 */
export async function promoteCellIfThresholdPassed(h3CellId: string) {
  await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(
      adminDb.collection("reports").where("h3CellId", "==", h3CellId),
    );

    const allReports = snapshot.docs
      .map((reportDoc) => ({
        id: reportDoc.id,
        ref: reportDoc.ref,
        data: reportDoc.data() as StoredReport,
      }))
      // Resolved reports were handled by an operator; flagged ones (duplicate
      // photo, screenshot, stale/far EXIF) must not manufacture consensus.
      .filter((report) => report.data.status !== "resolved")
      .filter((report) => !report.data.integrity?.excludeFromPromotion)
      .filter((report) => getPollutionSignalConfidence(report.data) > 0);

    const reportsByHazard: Record<string, typeof allReports> = {};
    for (const report of allReports) {
      const hazard = resolveIncidentHazardType(report.data);
      (reportsByHazard[hazard] ??= []).push(report);
    }

    const nowMs = Date.now();
    const promotionCandidates: Array<{
      hazardReports: typeof allReports;
      incidentPayload: Record<string, unknown>;
      incidentRef: DocumentReference;
      promotedValidation: IncidentEvidence;
    }> = [];

    for (const [hazardTypeKey, unfilteredHazardReports] of Object.entries(reportsByHazard)) {
      const hazardType = hazardTypeKey as HazardType;
      const windowHours = HAZARD_PROMOTION_WINDOW_HOURS[hazardType];
      const windowMinutes = windowHours * 60;
      const hazardReports = unfilteredHazardReports.filter((report) =>
        isWithinPromotionWindow(report.data, nowMs, windowHours),
      );
      if (hazardReports.length === 0) continue;

      hazardReports.sort(
        (a, b) => getPollutionSignalConfidence(b.data) - getPollutionSignalConfidence(a.data),
      );
      const primaryReport = hazardReports[0].data;

      // Support can come from ANY report in the cluster — one citizen's report
      // might not have a nearby station, but another's might.
      const sensorSupported = hazardReports.some((r) =>
        checkStoredSensorSupport(hazardType, r.data.validation?.sensor),
      );
      const satelliteSupported = hazardReports.some((r) =>
        checkStoredSatelliteSupport(r.data.validation?.satellite, hazardType),
      );

      const tier = determineTier({
        reportCount: hazardReports.length,
        sensorSupported,
        satelliteSupported,
      });
      if (!tier) continue;

      const avgConfidence = Math.round(
        hazardReports.reduce((sum, report) => sum + getPollutionSignalConfidence(report.data), 0) /
          hazardReports.length,
      );
      const reportWithPhoto = hazardReports.find((r) => !!r.data.photoUrl);
      const bestPhotoUrl = reportWithPhoto?.data.photoUrl ?? "";
      const promotionReason = tierPromotionReason(tier, hazardReports.length);
      const citizenNotes = hazardReports
        .map((report) => report.data.note?.trim())
        .filter((note): note is string => !!note)
        .filter((note, index, notes) => notes.indexOf(note) === index);

      const bestSensorDelta = hazardReports.reduce((max, r) => {
        const sensor = r.data.validation?.sensor;
        if (!checkStoredSensorSupport(hazardType, sensor)) return max;
        if (!sensor || sensor.distanceKm == null) return max;
        const delta = sensor.primaryDelta ?? sensor.pm25Delta ?? 0;
        return delta > max ? delta : max;
      }, -Infinity);
      const bestSatelliteWeight = hazardReports.reduce((max, r) => {
        const satellite = r.data.validation?.satellite;
        if (!checkStoredSatelliteSupport(satellite, hazardType) || !satellite) return max;
        // A FIRMS-only confirmation has no column anomaly; score the
        // detection itself as full satellite support.
        const weight =
          hazardType === "fire" && (satellite.firmsFireCount ?? 0) > 0
            ? Math.max(getStoredSatelliteAnomaly(satellite), 1)
            : getStoredSatelliteAnomaly(satellite);
        return weight > max ? weight : max;
      }, -Infinity);

      const fusion = computeFusionConfidence({
        corroborationScore: corroborationCountToScore(hazardReports.length),
        satelliteScore:
          bestSatelliteWeight === -Infinity ? null : satelliteWeightToScore(bestSatelliteWeight),
        sensorScore: bestSensorDelta === -Infinity ? null : sensorDeltaToScore(bestSensorDelta),
        visualScore: avgConfidence,
      });

      const [cellLat, cellLng] = cellToLatLng(h3CellId);
      const baseValidation = primaryReport.validation;
      const promotedValidation: IncidentEvidence = {
        ...(baseValidation ?? {
          coverage: { label: "Station coverage unknown", level: "low", nearestSensorKm: null },
          satellite: {
            freshness: "stale",
            lastPassTime: "Satellite window unavailable",
            signal: "Satellite context not collected.",
            source: "Earth Engine",
          },
          sensor: { pm25Delta: null, source: "unavailable", trend: "insufficient_data" },
        }),
        alertReason: "Citizen-corroborated hotspot promoted from public signals to municipal review.",
        alertTier: true,
        tier,
        citizenSignal: {
          averageConfidence: avgConfidence,
          reportCount: hazardReports.length,
          windowMinutes,
        },
        fusion: {
          coverageAdjusted: baseValidation?.fusion.coverageAdjusted ?? false,
          h3CellId,
          finalConfidence: fusion.finalConfidence,
          satelliteWeight: fusion.satelliteWeight,
          sensorWeight: fusion.sensorWeight,
          visualWeight: fusion.visualWeight,
          corroborationWeight: fusion.corroborationWeight,
        },
        promotionReason,
      };

      const incidentRef = adminDb.collection("incidents").doc(`${h3CellId}-${hazardType}`);
      const incidentPayload: Record<string, unknown> = {
        aiConfidence: avgConfidence,
        geminiClassification: {
          confidence: avgConfidence,
          description: `${hazardType} hotspot — ${promotionReason}`,
          severity: getSeverity(avgConfidence),
          type: primaryReport.geminiClassification?.type ?? hazardType,
        },
        h3CellId,
        hazardId: primaryReport.hazardId ?? null,
        hazardLabel: primaryReport.hazardLabel ?? `Citizen ${hazardType} cluster`,
        linkedReportIds: hazardReports.map((report) => report.id),
        note: primaryReport.note?.trim() || citizenNotes[0] || "",
        citizenNotes,
        location: primaryReport.location ?? {
          label: "Citizen report cluster",
          lat: cellLat.toFixed(6),
          lng: cellLng.toFixed(6),
        },
        photoUrl: bestPhotoUrl,
        source: "citizen_cluster",
        status: "under_review",
        updatedAt: adminServerTimestamp(),
        validation: promotedValidation,
      };

      promotionCandidates.push({ hazardReports, incidentPayload, incidentRef, promotedValidation });
    }

    // All transaction reads must precede writes.
    const existingIncidentSnaps = await Promise.all(
      promotionCandidates.map((candidate) => transaction.get(candidate.incidentRef)),
    );

    promotionCandidates.forEach((candidate, index) => {
      const existing = existingIncidentSnaps[index];
      const existingData = existing.exists ? existing.data() : undefined;
      // A resolved incident reopens only because of *new* (unresolved)
      // reports — which are the only ones left in hazardReports — and it
      // restarts its lifecycle cleanly.
      const incidentPayload: Record<string, unknown> = { ...candidate.incidentPayload };
      if (!existing.exists) {
        incidentPayload.createdAt = adminServerTimestamp();
      } else if (existingData?.status === "resolved") {
        incidentPayload.createdAt = adminServerTimestamp();
        incidentPayload.dispatchStatus = null;
        incidentPayload.dispatchedAt = null;
        incidentPayload.dispatchedAction = null;
        incidentPayload.resolvedAt = null;
        incidentPayload.outcome = null;
        incidentPayload.workOrder = null;
      }
      const reportStatus =
        existingData?.dispatchStatus === "dispatched" && existingData?.status !== "resolved"
          ? { dispatchStatus: "dispatched", dispatchedAt: existingData.dispatchedAt ?? null }
          : {};

      for (const report of candidate.hazardReports) {
        transaction.update(report.ref, {
          status: "under_review",
          incidentId: candidate.incidentRef.id,
          validation: candidate.promotedValidation,
          ...reportStatus,
        });
      }
      transaction.set(candidate.incidentRef, incidentPayload, { merge: true });
    });
  });
}
