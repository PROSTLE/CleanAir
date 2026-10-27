import "server-only";

import type { CapHotspot } from "@/lib/cap";
import { CITIES, cityForPoint, type CityConfig } from "@/lib/cities";
import { adminDb } from "@/lib/firebaseAdmin";
import { normalizeSeverity, resolveIncidentHazardType } from "@/lib/firestoreReports";
import { toCoordinate } from "@/lib/geo";

// Shared pieces of the open federation API (/api/federation/v1): any city or
// state system can read VayuSetu's hotspots, transboundary advisories and
// alerts in standard formats (GeoJSON, CAP 1.2) without an account.
//
// Only operational fields are published: location (cell centre), hazard,
// evidence tier, status and times. Citizen notes, photos, typed addresses
// and reporter details never leave the app.

export const FEDERATION_VERSION = "v1";
export const FEDERATION_CACHE_HEADERS = {
  "Cache-Control": "public, max-age=300",
  "Access-Control-Allow-Origin": "*",
};

/** Public origin, honouring the App Hosting proxy headers. */
export function publicOrigin(request: Request) {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

export function senderFor(origin: string) {
  return `vayusetu@${new URL(origin).hostname}`;
}

export type FederationHotspot = CapHotspot & {
  cityId: string;
  h3CellId: string | null;
  source: string;
  createdAt: string | null;
};

function toDate(value: unknown): Date | null {
  const date = (value as { toDate?: () => Date } | undefined)?.toDate?.();
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
}

/** Promoted, unresolved incidents, optionally limited to one city. */
export async function listOpenHotspots(city?: CityConfig): Promise<FederationHotspot[]> {
  const snapshot = await adminDb.collection("incidents").where("status", "!=", "resolved").limit(500).get();
  return snapshot.docs.flatMap((doc) => {
    const data = doc.data();
    const tier = (data.validation?.tier as string | undefined) ?? null;
    // Reports still under review stay inside the app until they are promoted.
    if (!tier) return [];
    const lat = toCoordinate(data.location?.lat);
    const lng = toCoordinate(data.location?.lng);
    const home = cityForPoint(lat, lng);
    if (!home || (city && home.id !== city.id)) return [];
    const updatedAt = toDate(data.updatedAt) ?? toDate(data.createdAt) ?? new Date();
    const confidence = data.validation?.fusion?.finalConfidence;
    return [
      {
        id: doc.id,
        cityId: home.id,
        cityName: home.name,
        lat: Number(lat.toFixed(5)),
        lng: Number(lng.toFixed(5)),
        h3CellId: (data.h3CellId as string | undefined) ?? (data.validation?.fusion?.h3CellId as string | undefined) ?? null,
        hazardType: resolveIncidentHazardType(data),
        tier,
        severity: normalizeSeverity(data.geminiClassification?.severity),
        status: String(data.status ?? "under_review"),
        confidencePct: typeof confidence === "number" ? Math.round(confidence) : null,
        source: String(data.source ?? "unknown"),
        createdAt: toDate(data.createdAt)?.toISOString() ?? null,
        updatedAt,
      },
    ];
  });
}

export function resolveCityParam(value: string | null): { cities: CityConfig[]; error?: string } {
  if (!value || value === "india") return { cities: CITIES.filter((city) => city.group === "india") };
  if (value === "all") return { cities: CITIES };
  if (value === "brics") return { cities: CITIES.filter((city) => city.group === "brics") };
  const city = CITIES.find((entry) => entry.id === value);
  return city ? { cities: [city] } : { cities: [], error: `Unknown city "${value}".` };
}
