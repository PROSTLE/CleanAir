import { NextResponse } from "next/server";
import { findCity } from "@/lib/cities";
import {
  autocompletePlaces,
  getPlaceLocation,
  isPlacesConfigured,
  reverseGeocode,
} from "@/lib/server/places";
import { enforceRateLimit, getClientIp, handleRoute, HttpError } from "@/lib/server/http";

export const runtime = "nodejs";

const MAX_QUERY_CHARS = 120;

/**
 * Location search for the report form, backed by Google Places API (New) and
 * the Geocoding API on the server:
 *   ?q=<text>&city=<id>&session=<token>   → { suggestions: [{ placeId, text }] }
 *   ?placeId=<id>&session=<token>         → { lat, lng, label }
 *   ?lat=<n>&lng=<n>                      → { label }  (label null when unknown)
 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    if (!isPlacesConfigured()) throw new HttpError(503, "GOOGLE_PLACES_API_KEY is not set.");
    await enforceRateLimit("places", getClientIp(request), 300, 60 * 60 * 1000);

    const params = new URL(request.url).searchParams;
    const session = params.get("session")?.slice(0, 64) || null;

    const query = params.get("q")?.trim();
    if (query !== undefined) {
      if (query.length < 2) return NextResponse.json({ suggestions: [] });
      const city = findCity(params.get("city") ?? "delhi");
      if (!city) throw new HttpError(400, "Unknown city.");
      const suggestions = await autocompletePlaces(
        query.slice(0, MAX_QUERY_CHARS),
        { countryCode: city.countryCode, lat: city.center.lat, lng: city.center.lng },
        session,
      );
      return NextResponse.json({ suggestions });
    }

    const placeId = params.get("placeId")?.trim();
    if (placeId) {
      if (!/^[\w-]{10,300}$/.test(placeId)) throw new HttpError(400, "Invalid placeId.");
      return NextResponse.json(await getPlaceLocation(placeId, session));
    }

    const lat = Number(params.get("lat"));
    const lng = Number(params.get("lng"));
    if (params.has("lat") && params.has("lng") && Number.isFinite(lat) && Number.isFinite(lng)) {
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpError(400, "Coordinates out of range.");
      return NextResponse.json({ label: await reverseGeocode(lat, lng) });
    }

    throw new HttpError(400, "Pass q, placeId, or lat and lng.");
  });
}
