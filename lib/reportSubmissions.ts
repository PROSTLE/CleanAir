import {
  addDoc,
  collection,
  doc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import type { DocumentReference, Timestamp } from "firebase/firestore";
import { latLngToCell } from "h3-js";
import { db, isFirebaseConfigured } from "@/lib/firebase";
import { resolveIncidentHazardType } from "@/lib/firestoreReports";
import {
  computeFusionConfidence,
  corroborationCountToScore,
  satelliteWeightToScore,
  sensorDeltaToScore,
} from "@/lib/fusionConfidence";
import type { HazardType, IncidentEvidence } from "@/lib/types";
import {
  checkStoredSensorSupport,
  checkStoredSatelliteSupport,
  determineTier,
  getStoredSatelliteAnomaly,
  tierPromotionReason,
} from "@/lib/supportEvidence";

export interface ReportSubmissionInput {
  anonymous: boolean;
  aiConfidence: number;
  hazardId: string;
  hazardLabel: string;
  photoUrl?: string;
  location: {
    label: string;
    lat: string;
    lng: string;
  };
  note: string;
  result: string;
}

interface StoredReport {
  aiConfidence?: number;
  createdAt?: Timestamp;
  geminiClassification?: {
    confidence?: number;
    severity?: number | string;
    type?: string;
  };
  h3CellId?: string;
  hazardId?: string;
  hazardLabel?: string;
  location?: {
    label?: string;
    lat?: string;
    lng?: string;
  };
  note?: string;
  photoUrl?: string;
  validation?: IncidentEvidence;
}

const H3_RESOLUTION = 8;
export const DEFAULT_H3_CELL_ID = "883da114bbfffff";
const POLLUTION_TYPES = new Set(["dust", "fire", "haze", "smoke"]);
const HAZARD_PROMOTION_WINDOW_HOURS: Record<HazardType, number> = {
  dust: 7 * 24,
  fire: 7 * 24,
  industrial: 7 * 24,
  particulate: 3 * 24,
  smog: 3 * 24,
};

export function getHazardType(hazardId: string) {
  if (hazardId.includes("dust")) return "dust";
  if (hazardId.includes("industrial")) return "industrial";
  if (hazardId.includes("smog")) return "smog";
  return "fire";
}

export function getSeverity(confidence: number) {
  if (confidence >= 80) return "critical";
  if (confidence >= 70) return "medium";
  return "low";
}

export function getH3CellId(location: ReportSubmissionInput["location"]) {
  const lat = Number(location.lat);
  const lng = Number(location.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return DEFAULT_H3_CELL_ID;

  return latLngToCell(lat, lng, H3_RESOLUTION);
}

function getPollutionSignalConfidence(report: StoredReport) {
  const classification = report.geminiClassification;
  if (!classification?.type || !POLLUTION_TYPES.has(classification.type)) return 0;

  const severity =
    typeof classification.severity === "number"
      ? classification.severity
      : Number(classification.severity ?? 0);
  if (!Number.isFinite(severity) || severity <= 0) return 0;

  const confidence = classification.confidence ?? report.aiConfidence ?? 0;
  return confidence <= 1 ? Math.round(confidence * 100) : Math.round(confidence);
}

function getPromotionWindowHours(hazardType: HazardType) {
  return HAZARD_PROMOTION_WINDOW_HOURS[hazardType];
}

function isWithinPromotionWindow(report: StoredReport, nowMs: number, windowHours: number) {
  const createdAtMs = report.createdAt?.toDate().getTime();
  if (typeof createdAtMs !== "number" || !Number.isFinite(createdAtMs)) return false;
  return nowMs - createdAtMs <= windowHours * 60 * 60 * 1000;
}

export async function promoteCellIfThresholdPassed(h3CellId: string) {
  if (!db) return;

  // This used to be a plain getDocs() read followed by separate
  // updateDoc/setDoc writes. Every citizen report fires its own
  // classify-report call (fire-and-forget), so when 2-3 reports land close
  // together, multiple calls to this function for the same h3CellId run
  // concurrently. With a non-transactional read, call B could read
  // Firestore *before* call A's write for report A had committed, see only
  // 2 qualifying reports instead of 3, decide "not enough evidence yet",
  // and bail — and nothing ever re-triggers promotion for that cell after
  // that. Wrapping the read + write in a transaction means Firestore
  // automatically retries a call if another transaction committed
  // conflicting writes in the meantime, so every call sees a consistent,
  // up-to-date view before deciding.
  await runTransaction(db, async (transaction) => {
    const reportsQuery = query(
      collection(db!, "reports"),
      where("h3CellId", "==", h3CellId),
    );
    const snapshot = await getDocs(reportsQuery);

    // Firestore transactions require all reads to happen before any write,
    // and reads inside the transaction must go through transaction.get on
    // each individual doc ref (query-based reads aren't transactional) —
    // so we re-fetch each candidate doc's current data transactionally
    // here, on the exact set of doc refs returned by the query above.
    const allReports = (
      await Promise.all(
        snapshot.docs.map(async (reportDoc) => {
          const freshSnap = await transaction.get(reportDoc.ref);
          return {
            id: reportDoc.id,
            ref: reportDoc.ref,
            data: freshSnap.data() as StoredReport,
          };
        }),
      )
    ).filter((report) => getPollutionSignalConfidence(report.data) > 0);

    const reportsByHazard: Record<string, typeof allReports> = {};
    for (const r of allReports) {
      const hazard = resolveIncidentHazardType(r.data);
      if (!reportsByHazard[hazard]) reportsByHazard[hazard] = [];
      reportsByHazard[hazard].push(r);
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
      const windowHours = getPromotionWindowHours(hazardType);
      const windowMinutes = windowHours * 60;
      const hazardReports = unfilteredHazardReports.filter((report) =>
        isWithinPromotionWindow(report.data, nowMs, windowHours),
      );
      if (hazardReports.length === 0) continue;

      // Sort to make the highest confidence report primary.
      hazardReports.sort(
        (a, b) => getPollutionSignalConfidence(b.data) - getPollutionSignalConfidence(a.data),
      );
      const primaryReport = hazardReports[0].data;

      // Support can come from ANY report in the cluster, not just the primary one —
      // one citizen's report might not have a nearby station, but another's might.
      const sensorSupported = hazardReports.some((r) =>
        checkStoredSensorSupport(hazardType, r.data.validation?.sensor),
      );
      const satelliteSupported = hazardReports.some((r) =>
        checkStoredSatelliteSupport(r.data.validation?.satellite),
      );

      const tier = determineTier({
        reportCount: hazardReports.length,
        sensorSupported,
        satelliteSupported,
      });

      // Not enough evidence yet on any promotion path — leave as citizen-only signal.
      if (!tier) continue;

      const avgConfidence = Math.round(
        hazardReports.reduce(
          (sum, report) => sum + getPollutionSignalConfidence(report.data),
          0,
        ) / hazardReports.length,
      );
      const reportWithPhoto = hazardReports.find((r) => !!r.data.photoUrl);
      const bestPhotoUrl = reportWithPhoto ? reportWithPhoto.data.photoUrl : (primaryReport.photoUrl ?? "");
      const promotionReason = tierPromotionReason(tier, hazardReports.length);
      const citizenNotes = hazardReports
        .map((report) => report.data.note?.trim())
        .filter((note): note is string => !!note)
        .filter((note, index, notes) => notes.indexOf(note) === index);

      // Pull the strongest *real* sensor/satellite reading from anywhere in
      // the cluster — same "any report, not just primary" reasoning as the
      // support checks above — so the fusion score isn't blind to evidence
      // that happened to land on a non-primary report.
      const bestSensorDelta = hazardReports.reduce((max, r) => {
        const sensor = r.data.validation?.sensor;
        if (!checkStoredSensorSupport(hazardType, sensor)) return max;
        if (!sensor || sensor.distanceKm == null) return max;
        const delta = sensor.primaryDelta ?? sensor.pm25Delta ?? 0;
        return delta > max ? delta : max;
      }, -Infinity);
      const bestSatelliteWeight = hazardReports.reduce((max, r) => {
        const satellite = r.data.validation?.satellite;
        if (!checkStoredSatelliteSupport(satellite)) return max;
        if (!satellite) return max;
        const weight = getStoredSatelliteAnomaly(satellite);
        return weight > max ? weight : max;
      }, -Infinity);

      const fusion = computeFusionConfidence({
        corroborationScore: corroborationCountToScore(hazardReports.length),
        satelliteScore: bestSatelliteWeight === -Infinity ? null : satelliteWeightToScore(bestSatelliteWeight),
        sensorScore: bestSensorDelta === -Infinity ? null : sensorDeltaToScore(bestSensorDelta),
        visualScore: avgConfidence,
      });

      const baseValidation = primaryReport.validation;
      const promotedValidation: IncidentEvidence = baseValidation ? {
        ...baseValidation,
        alertReason: "Citizen-corroborated hotspot promoted from public signals to municipal review.",
        alertTier: true,
        tier,
        citizenSignal: {
          ...baseValidation.citizenSignal,
          averageConfidence: avgConfidence,
          reportCount: hazardReports.length,
          windowMinutes,
        },
        fusion: {
          ...baseValidation.fusion,
          finalConfidence: fusion.finalConfidence,
          satelliteWeight: fusion.satelliteWeight,
          sensorWeight: fusion.sensorWeight,
          visualWeight: fusion.visualWeight,
          corroborationWeight: fusion.corroborationWeight,
        },
        promotionReason,
      } : {
        alertReason:
          "Citizen-corroborated hotspot promoted from public signals to municipal review.",
        alertTier: true,
        tier,
        citizenSignal: {
          averageConfidence: avgConfidence,
          reportCount: hazardReports.length,
          windowMinutes,
        },
        coverage: {
          label: "Low station coverage",
          level: "low",
          nearestSensorKm: 3.2,
        },
        fusion: {
          coverageAdjusted: true,
          finalConfidence: fusion.finalConfidence,
          h3CellId,
          satelliteWeight: fusion.satelliteWeight,
          sensorWeight: fusion.sensorWeight,
          visualWeight: fusion.visualWeight,
          corroborationWeight: fusion.corroborationWeight,
        },
        promotionReason,
        satellite: {
          freshness: "stale" as const,
          lastPassTime: "Satellite window unavailable",
          signal: "Last Sentinel-5P pass not decisive; alert driven by citizen cluster.",
          source: "Earth Engine" as const,
        },
        sensor: {
          pm25Delta: 8,
          source: "estimated" as const,
          trend: "rising" as const,
        },
      };

      const incidentRef = doc(db!, "incidents", `${h3CellId}-${hazardType}`);
      const incidentPayload: Record<string, unknown> = {
        aiConfidence: avgConfidence,
        geminiClassification: {
          confidence: avgConfidence,
          description: `${hazardType} hotspot — ${tierPromotionReason(tier, hazardReports.length)}`,
          severity: getSeverity(avgConfidence),
          type: primaryReport.geminiClassification?.type ?? hazardType,
        },
        h3CellId,
        hazardLabel: primaryReport.hazardLabel ?? `Citizen ${hazardType} cluster`,
        linkedReportIds: hazardReports.map((report) => report.id),
        note: primaryReport.note?.trim() || citizenNotes[0] || "",
        citizenNotes,
        location: primaryReport.location ?? {
          label: "Citizen report cluster",
          lat: "28.6264",
          lng: "77.3192",
        },
        photoUrl: bestPhotoUrl,
        source: "citizen_cluster",
        status: "under_review",
        updatedAt: serverTimestamp(),
        validation: promotedValidation,
      };

      promotionCandidates.push({
        hazardReports,
        incidentPayload,
        incidentRef,
        promotedValidation,
      });
    }

    // Firestore requires every transaction read to happen before any write.
    // Hoist incident reads out of the per-hazard write loop so multi-hazard
    // promotions in the same cell do not read after the first hazard writes.
    const existingIncidentSnaps = await Promise.all(
      promotionCandidates.map((candidate) => transaction.get(candidate.incidentRef)),
    );

    promotionCandidates.forEach((candidate, index) => {
      for (const report of candidate.hazardReports) {
        transaction.update(report.ref, {
          status: "under_review",
          validation: candidate.promotedValidation,
        });
      }

      const incidentPayload = { ...candidate.incidentPayload };
      const existingIncidentSnap = existingIncidentSnaps[index];
      if (!existingIncidentSnap.exists()) {
        // First time this cell+hazard is being promoted — stamp the creation time.
        incidentPayload.createdAt = serverTimestamp();
      }
      transaction.set(candidate.incidentRef, incidentPayload, { merge: true });
    });
  });
}

export async function submitCitizenReport(report: ReportSubmissionInput) {
  if (!isFirebaseConfigured || !db) {
    return {
      id: `local-${Date.now()}`,
      stored: false,
    };
  }

  const lowCoverage = Number(report.location.lat) > 28.6;
  const h3CellId = getH3CellId(report.location);

  const docRef = await addDoc(collection(db, "reports"), {
    ...report,
    createdAt: serverTimestamp(),
    h3CellId,
    photoUrl: report.photoUrl ?? "",
    validation: {
      alertReason: lowCoverage
        ? "Single citizen report in low station coverage zone; waiting for Gemini classification and corroboration."
        : "Single citizen report captured; waiting for Gemini classification and corroborating signals.",
      alertTier: false,
      citizenSignal: {
        averageConfidence: 0,
        reportCount: 1,
        windowMinutes: 1,
      },
      coverage: {
        label: lowCoverage ? "Low station coverage" : "Nearby sensor coverage",
        level: lowCoverage ? "low" : "good",
        nearestSensorKm: lowCoverage ? 3.2 : 0.9,
      },
      fusion: {
        coverageAdjusted: lowCoverage,
        finalConfidence: 0,
        h3CellId,
        satelliteWeight: 0.2,
        sensorWeight: lowCoverage ? 0.12 : 0.32,
        visualWeight: lowCoverage ? 0.5 : 0.38,
      },
      promotionReason: "Waiting for Gemini classification before corroboration checks.",
      satellite: {
        freshness: "stale",
        lastPassTime: "Satellite context pending.",
        signal: "Satellite context pending.",
        source: "Earth Engine",
      },
      sensor: {
        pm25Delta: lowCoverage ? 8 : 24,
        source: "estimated",
        trend: report.aiConfidence >= 80 ? "rising" : "flat",
      },
    },
    source: "citizen",
    status: "pending",
  });

  // Stays non-blocking (we don't await this before returning) so the UI
  // doesn't hang on Gemini classification — but a report that fails to
  // classify never gets a geminiClassification, hasPollutionSignal() then
  // filters it out client-side forever, and it silently never counts
  // toward the 3-report promotion threshold. Retrying a couple of times
  // fixes transient failures (cold starts, network blips) instead of
  // permanently stranding the report on a single failed attempt.
  void classifyReportWithRetry(docRef.id);

  return {
    id: docRef.id,
    stored: true,
  };
}

async function classifyReportWithRetry(reportId: string, attempt = 1): Promise<void> {
  const MAX_ATTEMPTS = 3;
  try {
    const res = await fetch("/api/classify-report", {
      body: JSON.stringify({ finalAttempt: attempt >= MAX_ATTEMPTS, reportId }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      // A browser fetch without a deadline never reaches the retry path if a
      // deployment or upstream provider stops responding.
      signal: AbortSignal.timeout(70_000),
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(payload?.error ?? `classify-report responded ${res.status}`);
    }
  } catch (err) {
    if (attempt >= MAX_ATTEMPTS) {
      console.error(
        `classify-report failed after ${MAX_ATTEMPTS} attempts for report ${reportId}; ` +
          `this report will never count toward the promotion threshold until retried manually.`,
        err,
      );
      if (db) {
        await updateDoc(doc(db, "reports", reportId), {
          classificationAttemptError: err instanceof Error ? err.message : String(err),
          classificationAttemptFailedAt: serverTimestamp(),
          status: "classification_failed",
        }).catch((updateError) => {
          console.error("Could not mark report classification_failed", updateError);
        });
      }
      return;
    }
    const backoffMs = 1000 * attempt;
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    return classifyReportWithRetry(reportId, attempt + 1);
  }
}
