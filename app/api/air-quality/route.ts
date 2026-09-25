import { NextResponse } from "next/server";
import {
  getAirQualityForecast,
  getCurrentAirQuality,
  isAirQualityConfigured,
} from "@/lib/server/googleAirQuality";
import { enforceRateLimit, getClientIp, handleRoute, HttpError } from "@/lib/server/http";

export const runtime = "nodejs";

/** Google Air Quality API current conditions + 24 h forecast for one point. */
export async function GET(request: Request) {
  return handleRoute(async () => {
    if (!isAirQualityConfigured()) {
      throw new HttpError(503, "GOOGLE_AIR_QUALITY_API_KEY is not set.");
    }
    const url = new URL(request.url);
    const lat = Number(url.searchParams.get("lat"));
    const lng = Number(url.searchParams.get("lng"));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new HttpError(400, "lat and lng query params are required numbers.");
    }
    await enforceRateLimit("air-quality", getClientIp(request), 40, 60 * 60 * 1000);

    const [current, forecast] = await Promise.all([
      getCurrentAirQuality(lat, lng),
      getAirQualityForecast(lat, lng, 24),
    ]);
    return NextResponse.json(
      { current, forecast, source: "Google Air Quality API" },
      { headers: { "Cache-Control": "public, max-age=900" } },
    );
  });
}
