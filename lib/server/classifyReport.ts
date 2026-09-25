import "server-only";

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import {
  getNearestStationReading,
  getPm25DeltaFromReference,
  getPrimaryPollutant,
} from "@/lib/cpcbSensor";
import { getFiresNear, getSatelliteDataForPoint } from "@/lib/earthEngineSatellite";
import { adminDb, adminServerTimestamp } from "@/lib/firebaseAdmin";
import {
  CLASSIFICATION_MODELS,
  buildClassificationPayload,
  isPollutionClassification,
  parseClassification,
  type Classification,
} from "@/lib/geminiClassifier";
import { getH3CellId, toCoordinate } from "@/lib/geo";
import { getWindData } from "@/lib/openWeather";
import { recordPollutionSnapshot } from "@/lib/pollutionSnapshots";
import {
  computeFusionConfidence,
  satelliteWeightToScore,
  sensorDeltaToScore,
} from "@/lib/fusionConfidence";
import { generateContent, getText } from "@/lib/server/gemini";
import { promoteCellIfThresholdPassed } from "@/lib/server/promotion";
import { FIRMS_SUPPORT_RADIUS_KM, isSensorReadingFresh } from "@/lib/supportEvidence";
import type { IntegrityFlag, ReportIntegrity } from "@/lib/types";

const IMAGE_FETCH_TIMEOUT_MS = 10_000;
const GEMINI_REQUEST_TIMEOUT_MS = 20_000;
const CONTEXT_LOOKUP_TIMEOUT_MS = 12_000;
const PROMOTION_TIMEOUT_MS = 10_000;
const FIRE_CONTEXT_RADIUS_KM = 5;
export const MAX_CLASSIFICATION_ATTEMPTS = 3;

type SensorTrend = "rising" | "flat" | "falling" | "insufficient_data";

interface ReportDoc {
  createdAt?: { toDate?: () => Date };
  hazardId?: string;
  hazardLabel?: string;
  h3CellId?: string;
  integrity?: ReportIntegrity;
  location?: { label?: string; lat?: string; lng?: string };
  photoUrl?: string;
  status?: string;
  classificationAttempts?: number;
  geminiClassification?: Classification;
  validation?: Record<string, unknown>;
}

export type ClassifyOutcome =
  | { ok: true; skipped: true; status: string; classification: Classification | null }
  | { ok: true; skipped: false; status: string; classification: Classification; warning?: string };

// photoUrl comes from a stored report; only fetch from the hosts our own
// upload paths produce (ImgBB, or same-origin paths). Anything else would let
// a crafted report make this server fetch arbitrary internal URLs.
const ALLOWED_PHOTO_HOSTS = ["ibb.co", "imgbb.com"];

export function isAllowedPhotoUrl(photoUrl: string) {
  if (photoUrl.startsWith("/") && !photoUrl.startsWith("//")) return true;
  try {
    const url = new URL(photoUrl);
    return (
      url.protocol === "https:" &&
      ALLOWED_PHOTO_HOSTS.some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    );
  } catch {
    return false;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function getOptionalContext<T>(promise: Promise<T>, label: string) {
  try {
    return await withTimeout(promise, CONTEXT_LOOKUP_TIMEOUT_MS, label);
  } catch (error) {
    console.warn(`${label} unavailable during report classification`, error);
    return null;
  }
}

async function fetchImage(photoUrl: string, origin: string | undefined) {
  if (!isAllowedPhotoUrl(photoUrl)) {
    throw new Error("photoUrl host is not an allowed image source.");
  }
  if (photoUrl.startsWith("/") && !origin) {
    throw new Error("Relative photoUrl needs a request origin.");
  }
  const imageUrl = photoUrl.startsWith("/") ? new URL(photoUrl, origin).toString() : photoUrl;
  const response = await fetch(imageUrl, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Could not fetch photoUrl (${response.status}).`);

  const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    data: bytes.toString("base64"),
    mimeType,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function classifyImage(inlineData: { data: string; mimeType: string }) {
  const { content, model } = await generateContent(buildClassificationPayload(inlineData), {
    models: CLASSIFICATION_MODELS,
    timeoutMs: GEMINI_REQUEST_TIMEOUT_MS,
  });
  const text = getText(content);
  if (!text) throw new Error("Gemini response did not include text.");
  return { classification: parseClassification(text), model };
}

/** An identical photo already attached to a different report. */
async function findDuplicateReport(reportId: string, sha256: string) {
  const snapshot = await adminDb
    .collection("reports")
    .where("photoSha256", "==", sha256)
    .limit(3)
    .get();
  return snapshot.docs.find((doc) => doc.id !== reportId)?.id ?? null;
}

function mergeIntegrity(
  existing: ReportIntegrity | undefined,
  extraFlags: IntegrityFlag[],
  duplicateOf: string | null,
): ReportIntegrity {
  const flags = [...new Set([...(existing?.flags ?? []), ...extraFlags])];
  return {
    ...(existing ?? {}),
    flags,
    duplicateOf: duplicateOf ?? existing?.duplicateOf ?? null,
    excludeFromPromotion: flags.length > 0,
  };
}

function getSatelliteHazardChannel(classification: Classification, report: ReportDoc) {
  const hazardText = `${report.hazardId ?? ""} ${report.hazardLabel ?? ""}`.toLowerCase();
  if (hazardText.includes("industrial") || hazardText.includes("traffic")) return "industrialTraffic";
  if (
    hazardText.includes("dust") ||
    hazardText.includes("fire") ||
    hazardText.includes("smog") ||
    POLLUTION_CHANNEL_TYPES.has(classification.type)
  ) {
    return "fireDustSmoke";
  }
  return "balanced";
}
const POLLUTION_CHANNEL_TYPES = new Set(["dust", "fire", "haze", "smoke"]);

function getPostClassificationReason(classification: Classification, excluded: boolean) {
  if (!isPollutionClassification(classification)) {
    return "Gemini did not find a clear pollution signal; keeping this as a public report only.";
  }
  if (excluded) {
    return "Pollution signal found, but integrity checks flagged this photo; operators can review it, but it does not count toward promotion.";
  }
  return "Gemini classified a pollution signal; waiting for citizen, sensor, or satellite corroboration.";
}

/**
 * Classifies one report end-to-end: Gemini vision → integrity checks →
 * CPCB / Sentinel-5P / FIRMS / wind context → fusion → promotion. Idempotent:
 * a report already past `pending`/`classification_failed` is returned as-is,
 * so replays (WhatsApp retries, the cron sweeper) never double-bill Gemini.
 */
export async function classifyReport(
  reportId: string,
  options: { origin?: string; finalAttempt?: boolean } = {},
): Promise<ClassifyOutcome> {
  const reportRef = adminDb.collection("reports").doc(reportId);
  const reportSnapshot = await reportRef.get();
  if (!reportSnapshot.exists) throw new Error("Report not found.");

  const report = reportSnapshot.data() as ReportDoc;
  const status = report.status ?? "pending";
  if (status !== "pending" && status !== "classification_failed") {
    return { ok: true, skipped: true, status, classification: report.geminiClassification ?? null };
  }

  const attempts = (report.classificationAttempts ?? 0) + 1;
  const finalAttempt = options.finalAttempt ?? attempts >= MAX_CLASSIFICATION_ATTEMPTS;
  let classificationSaved = false;
  let savedClassification: Classification | null = null;

  try {
    await reportRef.update({ classificationAttempts: FieldValue.increment(1) });
    if (!report.photoUrl) throw new Error("Report is missing photoUrl; cannot classify image.");

    const lat = toCoordinate(report.location?.lat);
    const lng = toCoordinate(report.location?.lng);
    const image = await fetchImage(report.photoUrl, options.origin);
    const [{ classification, model: aiModel }, duplicateOf] = await Promise.all([
      classifyImage(image),
      findDuplicateReport(reportId, image.sha256),
    ]);
    savedClassification = classification;

    const extraFlags: IntegrityFlag[] = [];
    if (duplicateOf) extraFlags.push("duplicate_photo");
    if (classification.authenticity === "screen_or_screenshot") extraFlags.push("screen_or_screenshot");
    if (classification.authenticity === "edited_or_stock") extraFlags.push("edited_or_stock");
    const integrity = mergeIntegrity(report.integrity, extraFlags, duplicateOf);

    const h3CellId =
      report.h3CellId ??
      (Number.isFinite(lat) && Number.isFinite(lng) ? getH3CellId({ lat, lng }) : null);
    const pollutionSignalConfidence = isPollutionClassification(classification)
      ? Math.round(classification.confidence * 100)
      : 0;
    const baseUpdate = {
      aiModel,
      classifiedAt: adminServerTimestamp(),
      classificationAttemptError: FieldValue.delete(),
      classificationAttemptFailedAt: FieldValue.delete(),
      classificationError: FieldValue.delete(),
      classificationFailedAt: FieldValue.delete(),
      geminiClassification: classification,
      integrity,
      photoSha256: image.sha256,
    };

    if (!isPollutionClassification(classification)) {
      await reportRef.update({
        ...baseUpdate,
        status: "no_signal",
        validation: {
          ...(report.validation ?? {}),
          alertReason: getPostClassificationReason(classification, false),
          citizenSignal: { averageConfidence: 0, reportCount: 1, windowMinutes: 1 },
          fusion: {
            coverageAdjusted: false,
            finalConfidence: 0,
            h3CellId,
            satelliteWeight: 0,
            sensorWeight: 0,
            visualWeight: 1,
          },
          promotionReason: "Not promotion eligible because Gemini did not find a pollution signal.",
        },
      });
      return { ok: true, skipped: false, status: "no_signal", classification };
    }

    // Persist the visual result before optional sensor/satellite/weather
    // enrichment, so a slow provider never leaves an analysed photo pending.
    const visualOnlyFusion = computeFusionConfidence({
      corroborationScore: null,
      satelliteScore: null,
      sensorScore: null,
      visualScore: pollutionSignalConfidence,
    });
    await reportRef.update({
      ...baseUpdate,
      status: "classified",
      validation: {
        ...(report.validation ?? {}),
        alertReason: getPostClassificationReason(classification, integrity.excludeFromPromotion),
        citizenSignal: {
          averageConfidence: pollutionSignalConfidence,
          reportCount: 1,
          windowMinutes: 1,
        },
        fusion: {
          coverageAdjusted: false,
          finalConfidence: visualOnlyFusion.finalConfidence,
          h3CellId,
          satelliteWeight: visualOnlyFusion.satelliteWeight,
          sensorWeight: visualOnlyFusion.sensorWeight,
          visualWeight: visualOnlyFusion.visualWeight,
        },
        promotionReason: "Gemini classified report; gathering context before corroboration checks.",
      },
    });
    classificationSaved = true;

    const reportCreatedAt = report.createdAt?.toDate?.() ?? new Date();
    const hasCoordinates = Number.isFinite(lat) && Number.isFinite(lng);
    const [satelliteData, nearestStation, windData, fireContext] = hasCoordinates
      ? await Promise.all([
          getOptionalContext(getSatelliteDataForPoint(lat, lng, reportCreatedAt), "Satellite lookup"),
          getOptionalContext(getNearestStationReading(lat, lng), "Sensor lookup"),
          getOptionalContext(getWindData(lat, lng), "Wind lookup"),
          getOptionalContext(getFiresNear(lat, lng, FIRE_CONTEXT_RADIUS_KM), "FIRMS lookup"),
        ])
      : [null, null, null, null];

    const primaryPollutant = getPrimaryPollutant(classification.type, nearestStation);
    const sensorFresh = nearestStation ? isSensorReadingFresh(nearestStation.lastUpdated) : false;
    const sensorValidation = nearestStation
      ? {
          distanceKm: nearestStation.distanceKm,
          lastUpdated: nearestStation.lastUpdated,
          no2: nearestStation.no2,
          pm10: nearestStation.pm10,
          pm25: nearestStation.pm25,
          pm25Delta: getPm25DeltaFromReference(nearestStation.pm25),
          primaryDelta: primaryPollutant.delta,
          primaryName: primaryPollutant.name,
          primaryValue: primaryPollutant.value,
          so2: nearestStation.so2,
          source: nearestStation.source,
          stationName: nearestStation.stationName,
          // A single reading can't show a trend; only freshness is known.
          trend: "insufficient_data" as SensorTrend,
          fresh: sensorFresh,
        }
      : {
          pm25Delta: null,
          primaryDelta: null,
          primaryName: "PM2.5",
          primaryValue: null,
          source: "unavailable" as const,
          trend: "insufficient_data" as SensorTrend,
        };

    const satelliteChannel = satelliteData ? getSatelliteHazardChannel(classification, report) : "balanced";
    const satelliteAnomaly =
      satelliteChannel === "industrialTraffic"
        ? (satelliteData?.hazardWeights.industrialTraffic ?? 0)
        : satelliteChannel === "fireDustSmoke"
          ? (satelliteData?.hazardWeights.fireDustSmoke ?? 0)
          : (satelliteData?.anomalyScore ?? 0);
    const firmsSupportsFire =
      classification.type === "fire" &&
      !!fireContext &&
      !fireContext.error &&
      fireContext.nearestKm !== null &&
      fireContext.nearestKm <= FIRMS_SUPPORT_RADIUS_KM;
    const satelliteUsable = !!satelliteData && !satelliteData.error;

    // A source only pulls weight when it's real: no station → no sensor
    // score; failed Earth Engine read → no satellite score.
    const fusion = computeFusionConfidence({
      corroborationScore: null,
      satelliteScore: firmsSupportsFire
        ? satelliteWeightToScore(1)
        : satelliteUsable
          ? satelliteWeightToScore(satelliteAnomaly)
          : null,
      sensorScore: nearestStation && sensorFresh ? sensorDeltaToScore(primaryPollutant.delta) : null,
      visualScore: pollutionSignalConfidence,
    });

    const snapshot = hasCoordinates
      ? await recordPollutionSnapshot({
          lat,
          lng,
          locationLabel: report.location?.label ?? null,
          reportId,
          satellite: satelliteData,
          sensor: nearestStation,
          sourceContext: "report_classification",
          wind: windData,
        })
      : { stored: false };

    await reportRef.update({
      status: "classified",
      validation: {
        ...(report.validation ?? {}),
        alertReason: getPostClassificationReason(classification, integrity.excludeFromPromotion),
        citizenSignal: {
          averageConfidence: pollutionSignalConfidence,
          reportCount: 1,
          windowMinutes: 1,
        },
        coverage: {
          label: nearestStation ? "Nearby sensor coverage" : "No station with data within 10 km",
          level: nearestStation ? (nearestStation.distanceKm <= 1.5 ? "good" : "limited") : "low",
          nearestSensorKm: nearestStation?.distanceKm ?? null,
        },
        fusion: {
          coverageAdjusted: true,
          finalConfidence: fusion.finalConfidence,
          h3CellId,
          satelliteWeight: fusion.satelliteWeight,
          sensorWeight: fusion.sensorWeight,
          visualWeight: fusion.visualWeight,
        },
        promotionReason: integrity.excludeFromPromotion
          ? "Excluded from promotion by integrity checks; visible to operators for review."
          : "Gemini classified report; waiting for corroboration threshold.",
        satellite: {
          anomalyScore: satelliteAnomaly,
          aerosolIndexAnomaly: satelliteData?.aerosolIndex.anomalyScore ?? 0,
          aerosolIndexRaw: satelliteData?.aerosolIndex.rawValue ?? null,
          fireDustSmokeWeight: satelliteData?.hazardWeights.fireDustSmoke ?? 0,
          freshness: satelliteData?.no2.rawValue || satelliteData?.aerosolIndex.rawValue ? "fresh" : "stale",
          hazardWeight: satelliteAnomaly,
          industrialTrafficWeight: satelliteData?.hazardWeights.industrialTraffic ?? 0,
          computedAt: satelliteData?.computedAt ?? new Date().toISOString(),
          lastPassTime: satelliteData
            ? `window ${satelliteData.windowStart} to ${satelliteData.windowEnd}`
            : "unavailable",
          windowEnd: satelliteData?.windowEnd ?? null,
          windowStart: satelliteData?.windowStart ?? null,
          no2Anomaly: satelliteData?.no2.anomalyScore ?? 0,
          rawNo2: satelliteData?.no2.rawValue ?? null,
          selectedChannel: satelliteChannel,
          currentProduct: satelliteData?.currentProduct.no2 ?? satelliteData?.currentProduct.aerosolIndex ?? null,
          firmsFireCount: fireContext && !fireContext.error ? fireContext.count : 0,
          firmsNearestKm: fireContext && !fireContext.error ? fireContext.nearestKm : null,
          signal: firmsSupportsFire
            ? `NASA FIRMS: ${fireContext!.count} active-fire detection(s) within ${fireContext!.radiusKm} km, nearest ${fireContext!.nearestKm} km`
            : satelliteUsable
              ? `Sentinel-5P ${satelliteChannel} score ${satelliteAnomaly}; NO2 ${satelliteData!.no2.anomalyScore}, aerosol ${satelliteData!.aerosolIndex.anomalyScore}`
              : (satelliteData?.error ?? "Satellite anomaly unavailable."),
          source: satelliteData?.source ?? "Earth Engine / Sentinel-5P",
        },
        sensor: sensorValidation,
        ...(windData
          ? {
              wind: {
                speedMs: windData.windSpeedMs,
                fromDeg: windData.windDegrees,
                fetchedAt: windData.fetchedAt,
              },
            }
          : {}),
      },
    });

    if (h3CellId && !integrity.excludeFromPromotion) {
      await withTimeout(promoteCellIfThresholdPassed(h3CellId), PROMOTION_TIMEOUT_MS, "Report promotion");
    }

    console.info(
      `Report ${reportId} classified as ${classification.type}; snapshot stored: ${snapshot.stored}.`,
    );
    return { ok: true, skipped: false, status: "classified", classification };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown classification error.";
    console.error(`Report ${reportId} classification failed`, error);

    // Once Gemini's answer is saved, enrichment/promotion failures are
    // non-fatal and must not revert the report.
    if (classificationSaved && savedClassification) {
      return { ok: true, skipped: false, status: "classified", classification: savedClassification, warning: message };
    }

    await reportRef
      .update(
        finalAttempt
          ? {
              classificationError: message,
              classificationFailedAt: adminServerTimestamp(),
              status: "classification_failed",
            }
          : {
              classificationAttemptError: message,
              classificationAttemptFailedAt: adminServerTimestamp(),
              status: "pending",
            },
      )
      .catch((updateError) => console.error("Could not record classification failure", updateError));
    throw error;
  }
}
