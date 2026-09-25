import { after, NextResponse } from "next/server";
import { adminDb, adminServerTimestamp } from "@/lib/firebaseAdmin";
import { getH3CellId, haversineKm, toCoordinate } from "@/lib/geo";
import { isInOperationalRegion } from "@/lib/operationalRegion";
import { classifyReport, isAllowedPhotoUrl } from "@/lib/server/classifyReport";
import {
  enforceRateLimit,
  getClientIp,
  handleRoute,
  HttpError,
  readJson,
  verifyAppCheckIfEnforced,
} from "@/lib/server/http";
import type { IntegrityFlag, ReportIntegrity } from "@/lib/types";

export const runtime = "nodejs";

const HAZARD_IDS = new Set(["garbage-fire", "traffic-smog", "construction-dust", "industrial-emission"]);
const MAX_NOTE_CHARS = 1000;
const MAX_LABEL_CHARS = 200;
const PHOTO_MAX_AGE_HOURS = 24;
const PHOTO_GPS_MAX_DISTANCE_KM = 3;

type ReportBody = {
  anonymous?: boolean;
  hazardId?: string;
  hazardLabel?: string;
  location?: { label?: string; lat?: string; lng?: string };
  note?: string;
  photoUrl?: string;
  result?: string;
  // Read client-side from the original file's EXIF before compression
  // strips it. Advisory only (a client can omit it), so it can flag a
  // report but never make one more credible.
  photoMeta?: { takenAt?: string | null; lat?: number | null; lng?: number | null };
};

function buildIntegrity(body: ReportBody, lat: number, lng: number): ReportIntegrity {
  const flags: IntegrityFlag[] = [];
  const takenAtMs = body.photoMeta?.takenAt ? Date.parse(body.photoMeta.takenAt) : NaN;
  if (Number.isFinite(takenAtMs) && Date.now() - takenAtMs > PHOTO_MAX_AGE_HOURS * 60 * 60 * 1000) {
    flags.push("photo_older_than_24h");
  }

  const gpsLat = Number(body.photoMeta?.lat);
  const gpsLng = Number(body.photoMeta?.lng);
  const hasGps =
    body.photoMeta?.lat != null && body.photoMeta?.lng != null && Number.isFinite(gpsLat) && Number.isFinite(gpsLng);
  const gpsDistanceKm = hasGps ? Number(haversineKm(lat, lng, gpsLat, gpsLng).toFixed(2)) : null;
  if (gpsDistanceKm !== null && gpsDistanceKm > PHOTO_GPS_MAX_DISTANCE_KM) {
    flags.push("photo_gps_far_from_location");
  }

  return {
    flags,
    excludeFromPromotion: flags.length > 0,
    duplicateOf: null,
    photoTakenAt: Number.isFinite(takenAtMs) ? new Date(takenAtMs).toISOString() : null,
    photoGpsDistanceKm: gpsDistanceKm,
  };
}

export async function POST(request: Request) {
  return handleRoute(async () => {
    await verifyAppCheckIfEnforced(request);
    const body = await readJson<ReportBody>(request);
    // Count every well-formed attempt, valid or not, against the device.
    const ip = getClientIp(request);
    await enforceRateLimit("report-hour", ip, 8, 60 * 60 * 1000);
    await enforceRateLimit("report-day", ip, 30, 24 * 60 * 60 * 1000);

    const hazardId = body.hazardId?.trim() ?? "";
    if (!HAZARD_IDS.has(hazardId)) throw new HttpError(400, "Choose what you are seeing.");

    const photoUrl = body.photoUrl?.trim() ?? "";
    if (!photoUrl || !isAllowedPhotoUrl(photoUrl)) {
      throw new HttpError(400, "Attach a photo uploaded through VayuSetu before submitting.");
    }

    const lat = toCoordinate(body.location?.lat);
    const lng = toCoordinate(body.location?.lng);
    if (
      !body.location?.lat ||
      !body.location?.lng ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      throw new HttpError(400, "Pick the report location (detect, search, or drop a pin) before submitting.");
    }

    const note = (body.note ?? "").trim().slice(0, MAX_NOTE_CHARS);
    const label = (body.location.label ?? "").trim().slice(0, MAX_LABEL_CHARS) || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    const h3CellId = getH3CellId({ lat, lng });
    const integrity = buildIntegrity(body, lat, lng);

    const docRef = await adminDb.collection("reports").add({
      anonymous: body.anonymous !== false,
      channel: "web",
      createdAt: adminServerTimestamp(),
      h3CellId,
      hazardId,
      hazardLabel: (body.hazardLabel ?? "").slice(0, 120),
      integrity,
      location: { label, lat: lat.toFixed(6), lng: lng.toFixed(6) },
      note,
      photoUrl,
      result: (body.result ?? "").slice(0, 120),
      source: "citizen",
      status: "pending",
      classificationAttempts: 0,
      // Pending placeholders; classifyReport replaces them with real
      // Gemini, CPCB, Sentinel-5P and FIRMS evidence. No guessed numbers.
      validation: {
        alertReason:
          "Single citizen report captured; waiting for Gemini classification and corroborating signals.",
        alertTier: false,
        citizenSignal: { averageConfidence: 0, reportCount: 1, windowMinutes: 1 },
        coverage: { label: "Station lookup pending", level: "low", nearestSensorKm: null },
        fusion: {
          coverageAdjusted: false,
          finalConfidence: 0,
          h3CellId,
          satelliteWeight: 0,
          sensorWeight: 0,
          visualWeight: 0,
        },
        promotionReason: "Waiting for Gemini classification before corroboration checks.",
        satellite: {
          freshness: "stale",
          lastPassTime: "Satellite context pending.",
          signal: "Satellite context pending.",
          source: "Earth Engine",
        },
        sensor: { pm25Delta: null, source: "unavailable", trend: "insufficient_data" },
      },
    });

    // Classify after the response is sent. The browser no longer has to stay
    // open for its report to be analysed; /api/cron/tick sweeps anything
    // this misses (e.g. an instance recycled mid-classification).
    const origin = new URL(request.url).origin;
    after(async () => {
      try {
        await classifyReport(docRef.id, { origin });
      } catch (error) {
        console.error(`Background classification failed for ${docRef.id}`, error);
      }
    });

    return NextResponse.json(
      {
        id: docRef.id,
        inPilotArea: isInOperationalRegion(lat, lng),
        integrityFlags: integrity.flags,
      },
      { status: 201 },
    );
  });
}
