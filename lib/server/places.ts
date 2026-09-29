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

// ─── Location search for the report form ────────────────────────────────────
// Places API (New) Autocomplete + Place Details and the Geocoding API, called
// server-side with GOOGLE_PLACES_API_KEY. The legacy browser Autocomplete
// widget is closed to new Google Cloud projects, and this keeps the key off
// the client. A session token groups one search's calls for billing.
const AUTOCOMPLETE_ENDPOINT = "https://places.googleapis.com/v1/places:autocomplete";
const DETAILS_ENDPOINT = "https://places.googleapis.com/v1/places";
const GEOCODE_ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";
const SEARCH_BIAS_RADIUS_M = 50_000;

export type PlaceSuggestion = { placeId: string; text: string };

async function placesRequest<T>(url: string, init: RequestInit & { fieldMask?: string }) {
  const key = apiKey();
  if (!key) throw new Error("GOOGLE_PLACES_API_KEY is not set.");
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      ...(init.fieldMask ? { "X-Goog-FieldMask": init.fieldMask } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(`Places API failed (${response.status}): ${json.error?.message ?? "no details"}`);
  }
  return json;
}

/** Suggestions limited to one country and biased towards the city centre. */
export async function autocompletePlaces(
  input: string,
  scope: { countryCode: string; lat: number; lng: number },
  sessionToken: string | null,
): Promise<PlaceSuggestion[]> {
  const json = await placesRequest<{
    suggestions?: Array<{ placePrediction?: { placeId?: string; text?: { text?: string } } }>;
  }>(AUTOCOMPLETE_ENDPOINT, {
    method: "POST",
    body: JSON.stringify({
      input,
      includedRegionCodes: [scope.countryCode],
      locationBias: {
        circle: { center: { latitude: scope.lat, longitude: scope.lng }, radius: SEARCH_BIAS_RADIUS_M },
      },
      ...(sessionToken ? { sessionToken } : {}),
    }),
  });
  return (json.suggestions ?? [])
    .map((item) => ({ placeId: item.placePrediction?.placeId ?? "", text: item.placePrediction?.text?.text ?? "" }))
    .filter((item) => item.placeId && item.text)
    .slice(0, 5);
}

export async function getPlaceLocation(placeId: string, sessionToken: string | null) {
  const url = new URL(`${DETAILS_ENDPOINT}/${encodeURIComponent(placeId)}`);
  if (sessionToken) url.searchParams.set("sessionToken", sessionToken);
  const json = await placesRequest<{
    location?: { latitude?: number; longitude?: number };
    formattedAddress?: string;
    displayName?: { text?: string };
  }>(url.toString(), { method: "GET", fieldMask: "location,formattedAddress,displayName" });
  const lat = json.location?.latitude;
  const lng = json.location?.longitude;
  if (typeof lat !== "number" || typeof lng !== "number") throw new Error("Place has no location.");
  return { lat, lng, label: json.formattedAddress ?? json.displayName?.text ?? "" };
}

/** Street address for a dropped pin or GPS fix; null when Google has none. */
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const key = apiKey();
  if (!key) throw new Error("GOOGLE_PLACES_API_KEY is not set.");
  const url = new URL(GEOCODE_ENDPOINT);
  url.searchParams.set("latlng", `${lat},${lng}`);
  url.searchParams.set("key", key);
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const json = (await response.json().catch(() => ({}))) as {
    status?: string;
    error_message?: string;
    results?: Array<{ formatted_address?: string }>;
  };
  if (json.status === "ZERO_RESULTS") return null;
  if (json.status !== "OK") throw new Error(`Geocoding failed (${json.status}): ${json.error_message ?? "no details"}`);
  return json.results?.[0]?.formatted_address ?? null;
}
