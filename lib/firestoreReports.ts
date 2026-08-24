import type { Timestamp } from "firebase/firestore";
import type {
  HazardType,
  HealthRisk,
  Incident,
  IncidentEvidence,
  IncidentStatus,
  Severity,
} from "@/lib/types";

export interface FirestoreReport {
  anonymous?: boolean;
  aiConfidence?: number;
  createdAt?: Timestamp;
  classificationAttemptError?: string;
  classificationError?: string;
  updatedAt?: Timestamp;
  geminiClassification?: {
    confidence?: number;
    severity?: Severity | number;
    type?: HazardType | "clear" | "haze" | "smoke" | "unclear";
  };
  hazardLabel?: string;
  hazardId?: string;
  location?: {
    label?: string;
    lat?: string;
    lng?: string;
  };
  note?: string;
  citizenNotes?: string[];
  result?: string;
  status?: IncidentStatus | "submitted" | "classified" | "no_signal";
  source?: string;
  validation?: IncidentEvidence;
  photoUrl?: string;
  h3CellId?: string;
  linkedReportIds?: string[];
  dispatchStatus?: "dispatched";
  dispatchedAction?: string;
  dispatchedAt?: Timestamp;
  resolvedAt?: Timestamp;
  // Written by ambientScan.ts — carries the full signal picture for the
  // map popup without committing to a single hazard label.
  possibleSources?: string[];
  triggerPollutants?: Array<{
    deltaPct?: number;
    name?: string;
    value?: number | null;
  }>;
  elevatedPollutants?: {
    pm25?: number | null;
    pm10?: number | null;
    no2?: number | null;
    so2?: number | null;
  };
}

function normalizeStatus(status?: FirestoreReport["status"]): IncidentStatus {
  if (status === "submitted" || status === "classified") return "pending";
  return status ?? "pending";
}

function getHealthRisk(severity: Severity): HealthRisk {
  if (severity === "critical") return "high";
  if (severity === "medium") return "medium";
  return "low";
}

function normalizeSeverity(severity?: Severity | number): Severity {
  if (severity === "critical" || severity === "medium" || severity === "low") {
    return severity;
  }
  if (typeof severity === "number") {
    if (severity >= 4) return "critical";
    if (severity >= 2) return "medium";
  }
  return "low";
}

function normalizeConfidence(confidence?: number, fallback = 0) {
  if (typeof confidence !== "number") return fallback;
  return confidence <= 1 ? Math.round(confidence * 100) : Math.round(confidence);
}

export function hasPollutionSignal(report: FirestoreReport) {
  const classification = report.geminiClassification;
  return (
    classification?.severity !== 0 &&
    (classification?.type === "dust" ||
      classification?.type === "fire" ||
      classification?.type === "haze" ||
      classification?.type === "smoke")
  );
}

export function resolveIncidentHazardType(report: {
  hazardId?: string;
  geminiClassification?: { type?: string; severity?: string | number };
}): HazardType {
  const classification = report.geminiClassification;
  const type = classification?.type;
  const geminiHasResult = type && type !== "clear" && type !== "unclear" && Number(classification.severity) > 0;

  // Step 1: Fire is the only unambiguous, safety-critical detection where Gemini
  // overrides a mismatched citizen selection. Dust/haze/smoke are genuinely ambiguous
  // (construction dust vs industrial haze look similar), so for those we trust the
  // citizen's on-the-ground context — consistent with satellite channel selection.
  if (geminiHasResult) {
    const lowerId = (report.hazardId || "").toLowerCase();
    if (type === "fire" && !lowerId.includes("fire")) return "fire";
  }

  // Step 2: Resolve from the citizen's explicit button selection.
  // This works even before Gemini has classified (pending state), preventing
  // all pending reports from incorrectly collapsing to the same fallback type.
  if (report.hazardId === "garbage-fire") return "fire";
  if (report.hazardId === "traffic-smog") return "smog";
  if (report.hazardId === "construction-dust") return "dust";
  if (report.hazardId === "industrial-emission") return "industrial";
  const lowerId = (report.hazardId || "").toLowerCase();
  if (lowerId.includes("fire")) return "fire";
  if (lowerId.includes("dust")) return "dust";
  if (lowerId.includes("industrial")) return "industrial";
  if (lowerId.includes("smog") || lowerId.includes("traffic")) return "smog";

  // Step 3: Final fallback — use Gemini's generic visual type if no hazardId.
  // "particulate" only ever comes from ambientScan.ts (sensor/satellite-only
  // detections, no citizen report/hazardId at all) — without it in this list,
  // every ambient particulate doc would silently fall through to the "smog"
  // default below and lose the "we don't know the source yet" distinction.
  if (
    type === "dust" ||
    type === "fire" ||
    type === "industrial" ||
    type === "smog" ||
    type === "particulate"
  ) {
    return type as HazardType;
  }
  if (type === "smoke" || type === "haze") return "smog";
  return "smog";
}

export function reportToIncident(id: string, report: FirestoreReport): Incident {
  const severity = normalizeSeverity(report.geminiClassification?.severity);
  const hazardType = resolveIncidentHazardType(report);
  const aiConfidence = hasPollutionSignal(report)
    ? normalizeConfidence(report.geminiClassification?.confidence, report.aiConfidence ?? 0)
    : 0;
  const note = report.note?.trim();
  const citizenNotes = [
    ...(note ? [note] : []),
    ...(report.citizenNotes ?? []).map((item) => item.trim()).filter(Boolean),
  ].filter((item, index, notes) => notes.indexOf(item) === index);
  const incident: Incident = {
    id: `firestore-${id}`,
    aiConfidence,
    corroboratingReports: report.validation?.citizenSignal.reportCount ?? 1,
    evidence: report.validation,
    hazardType,
    healthRisk: getHealthRisk(severity),
    isAnonymous: report.anonymous ?? true,
    latitude: Number(report.location?.lat ?? 28.6264),
    longitude: Number(report.location?.lng ?? 77.3192),
    neighborhood: report.location?.label ?? "Citizen report",
    note,
    citizenNotes,
    photoUrl: report.photoUrl ?? "",
    severity,
    source: report.source === "sensor" ? "sensor" : report.source === "satellite" ? "satellite" : "citizen",
    status: normalizeStatus(report.status),
    timestamp:
      report.createdAt?.toDate().toISOString() ??
      report.updatedAt?.toDate().toISOString() ??
      new Date().toISOString(),
    h3CellId: report.h3CellId,
    linkedReportIds: report.linkedReportIds,
    dispatchStatus: report.dispatchStatus,
    dispatchedAction: report.dispatchedAction,
    dispatchedAt: report.dispatchedAt?.toDate().toISOString(),
    resolvedAt: report.resolvedAt?.toDate().toISOString(),
    possibleSources: report.possibleSources,
    triggerPollutants: report.triggerPollutants
      ?.filter((pollutant) => typeof pollutant.name === "string")
      .map((pollutant) => ({
        deltaPct: pollutant.deltaPct ?? 0,
        name: pollutant.name ?? "Pollutant",
        value: pollutant.value ?? null,
      })),
    elevatedPollutants: report.elevatedPollutants,
  };
  return incident;
}
