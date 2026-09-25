import { getAppCheckHeader } from "@/lib/firebase";
import { toCoordinate } from "@/lib/geo";

export interface ReportSubmissionInput {
  anonymous: boolean;
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
  photoMeta?: { takenAt: string | null; lat: number | null; lng: number | null } | null;
}

export interface ReportSubmissionResult {
  id: string;
  stored: true;
  inPilotArea: boolean;
  integrityFlags: string[];
}

/**
 * Reports are written server-side (/api/reports, Admin SDK): the Firestore
 * rules no longer let browsers write reports directly, the server validates
 * and rate-limits, and classification runs on the server rather than
 * depending on this tab staying open.
 */
export async function submitCitizenReport(
  report: ReportSubmissionInput,
): Promise<ReportSubmissionResult> {
  const lat = toCoordinate(report.location.lat);
  const lng = toCoordinate(report.location.lng);
  if (!report.location.lat || !report.location.lng || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("Pick the report location (detect, search, or drop a pin) before submitting.");
  }

  const response = await fetch("/api/reports", {
    body: JSON.stringify(report),
    headers: {
      "Content-Type": "application/json",
      ...(await getAppCheckHeader()),
    },
    method: "POST",
  });
  const payload = (await response.json().catch(() => null)) as
    | (Partial<ReportSubmissionResult> & { error?: string })
    | null;

  if (!response.ok || !payload?.id) {
    throw new Error(payload?.error ?? `Could not save the report (${response.status}).`);
  }

  return {
    id: payload.id,
    stored: true,
    inPilotArea: payload.inPilotArea ?? true,
    integrityFlags: payload.integrityFlags ?? [],
  };
}
