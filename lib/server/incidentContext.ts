import "server-only";

import type { DocumentData, DocumentReference } from "firebase-admin/firestore";
import { rankUpwindSources, type AttributionCandidate, type AttributionResult } from "@/lib/attribution";
import { getRegionalFireHotspots, getFiresNear, type NearbyFireSummary } from "@/lib/earthEngineSatellite";
import { adminDb, adminServerTimestamp } from "@/lib/firebaseAdmin";
import { toCoordinate } from "@/lib/geo";
import { KNOWN_SOURCES } from "@/lib/knownSources";
import { getWindData, type WindData } from "@/lib/openWeather";
import { getCurrentAirQuality, isAirQualityConfigured, type AirQualitySnapshot } from "@/lib/server/googleAirQuality";
import { HttpError } from "@/lib/server/http";
import { findSensitiveSites, isPlacesConfigured, type SensitiveSite } from "@/lib/server/places";

export type TargetCollection = "incidents" | "reports";

export type Piece<T> =
  | { status: "ok"; data: T }
  | { status: "not_configured"; reason: string }
  | { status: "error"; reason: string };

export type IncidentContext = {
  fetchedAt: string;
  wind: Piece<Pick<WindData, "windSpeedMs" | "windDegrees" | "fetchedAt">>;
  attribution: Piece<AttributionResult>;
  fires: Piece<NearbyFireSummary>;
  sensitiveSites: Piece<SensitiveSite[]>;
  googleAirQuality: Piece<AirQualitySnapshot>;
};

export type Target = {
  collection: TargetCollection;
  id: string;
  ref: DocumentReference;
  data: DocumentData;
  lat: number;
  lng: number;
  area: string;
};

export async function loadTarget(collection: unknown, id: unknown): Promise<Target> {
  if (collection !== "incidents" && collection !== "reports") {
    throw new HttpError(400, "collection must be 'incidents' or 'reports'.");
  }
  if (typeof id !== "string" || !id.trim() || id.includes("/")) {
    throw new HttpError(400, "A valid document id is required.");
  }
  const ref = adminDb.collection(collection).doc(id.trim());
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, "Incident not found.");
  const data = snap.data() ?? {};
  const lat = toCoordinate(data.location?.lat);
  const lng = toCoordinate(data.location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new HttpError(422, "This incident has no valid coordinates.");
  }
  return {
    collection,
    id: ref.id,
    ref,
    data,
    lat,
    lng,
    area: String(data.location?.label ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`),
  };
}

async function piece<T>(configured: boolean, reason: string, load: () => Promise<T>): Promise<Piece<T>> {
  if (!configured) return { status: "not_configured", reason };
  try {
    return { status: "ok", data: await load() };
  } catch (error) {
    return { status: "error", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Other open, pollution-producing incidents are attribution candidates too. */
async function getActiveIncidentCandidates(excludeId: string): Promise<AttributionCandidate[]> {
  const snapshot = await adminDb.collection("incidents").where("status", "!=", "resolved").limit(200).get();
  return snapshot.docs
    .filter((doc) => doc.id !== excludeId)
    .map((doc) => {
      const data = doc.data();
      const hazard = String(data.geminiClassification?.type ?? data.hazardLabel ?? "incident");
      return {
        name: `${data.location?.label ?? "Open incident"} (${hazard})`,
        kind: "reported_incident" as const,
        lat: toCoordinate(data.location?.lat),
        lng: toCoordinate(data.location?.lng),
      };
    })
    .filter((candidate) => Number.isFinite(candidate.lat) && Number.isFinite(candidate.lng));
}

export async function buildIncidentContext(target: Target): Promise<IncidentContext> {
  const { lat, lng } = target;
  const [windPiece, firesPiece, regional, incidentCandidates, sitesPiece, aqPiece] = await Promise.all([
    piece(Boolean(process.env.OPENWEATHER_API_KEY?.trim()), "OPENWEATHER_API_KEY is not set.", async () => {
      const wind = await getWindData(lat, lng);
      if (!wind) throw new Error("OpenWeatherMap returned no wind data.");
      return { windSpeedMs: wind.windSpeedMs, windDegrees: wind.windDegrees, fetchedAt: wind.fetchedAt };
    }),
    piece(true, "", async () => {
      const summary = await getFiresNear(lat, lng, 10);
      if (summary.error) throw new Error(summary.error);
      return summary;
    }),
    getRegionalFireHotspots().catch(() => null),
    getActiveIncidentCandidates(target.id).catch(() => [] as AttributionCandidate[]),
    piece(isPlacesConfigured(), "GOOGLE_PLACES_API_KEY is not set.", () => findSensitiveSites(lat, lng, 1000)),
    piece(isAirQualityConfigured(), "GOOGLE_AIR_QUALITY_API_KEY is not set.", () => getCurrentAirQuality(lat, lng)),
  ]);

  const attribution: Piece<AttributionResult> = {
    status: "ok",
    data: rankUpwindSources({
      lat,
      lng,
      wind:
        windPiece.status === "ok"
          ? { fromDeg: windPiece.data.windDegrees, speedMs: windPiece.data.windSpeedMs }
          : null,
      candidates: [...KNOWN_SOURCES, ...incidentCandidates],
      fires: regional && !regional.error ? regional.fires : [],
    }),
  };

  return {
    fetchedAt: new Date().toISOString(),
    wind: windPiece,
    attribution,
    fires: firesPiece,
    sensitiveSites: sitesPiece,
    googleAirQuality: aqPiece,
  };
}

/** Builds context and keeps a copy on the doc for the work order and audit. */
export async function getAndStoreIncidentContext(target: Target) {
  const context = await buildIncidentContext(target);
  await target.ref.update({ operatorContext: context, operatorContextAt: adminServerTimestamp() });
  return context;
}
