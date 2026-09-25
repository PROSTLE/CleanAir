import "server-only";

import { haversineKm } from "@/lib/geo";

// Places API (New) Nearby Search: schools and hospitals near a hotspot, so
// operators can prioritise sites with vulnerable people and the work order
// can name who to warn.
const ENDPOINT = "https://places.googleapis.com/v1/places:searchNearby";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SENSITIVE_TYPES = ["school", "primary_school", "secondary_school", "hospital"];

export type SensitiveSite = {
  name: string;
  kind: "school" | "hospital";
  address: string | null;
  lat: number;
  lng: number;
  distanceKm: number;
};

type PlacesResponse = {
  places?: Array<{
    displayName?: { text?: string };
    formattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
    types?: string[];
  }>;
  error?: { message?: string };
};

const cache = new Map<string, { expiresAt: number; value: SensitiveSite[] }>();

function apiKey() {
  return process.env.GOOGLE_PLACES_API_KEY?.trim() || null;
}

export function isPlacesConfigured() {
  return apiKey() !== null;
}

export async function findSensitiveSites(lat: number, lng: number, radiusMeters = 1000): Promise<SensitiveSite[]> {
  const key = apiKey();
  if (!key) throw new Error("GOOGLE_PLACES_API_KEY is not set.");

  const cacheKey = `${lat.toFixed(3)},${lng.toFixed(3)},${radiusMeters}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const response = await fetch(ENDPOINT, {
    body: JSON.stringify({
      includedTypes: SENSITIVE_TYPES,
      maxResultCount: 12,
      rankPreference: "DISTANCE",
      locationRestriction: {
        circle: { center: { latitude: lat, longitude: lng }, radius: radiusMeters },
      },
    }),
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      // Field masks keep this on the cheapest SKU that has what we need.
      "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location,places.types",
    },
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await response.json().catch(() => ({}))) as PlacesResponse;
  if (!response.ok) {
    throw new Error(`Places API failed (${response.status}): ${json.error?.message ?? "no details"}`);
  }

  const sites = (json.places ?? [])
    .map((place) => {
      const siteLat = place.location?.latitude;
      const siteLng = place.location?.longitude;
      if (typeof siteLat !== "number" || typeof siteLng !== "number") return null;
      return {
        name: place.displayName?.text ?? "Unnamed site",
        kind: place.types?.includes("hospital") ? ("hospital" as const) : ("school" as const),
        address: place.formattedAddress ?? null,
        lat: siteLat,
        lng: siteLng,
        distanceKm: Number(haversineKm(lat, lng, siteLat, siteLng).toFixed(2)),
      };
    })
    .filter((site): site is SensitiveSite => site !== null)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value: sites });
  return sites;
}
