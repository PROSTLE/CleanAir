import { NextResponse } from "next/server";
import { CITIES } from "@/lib/cities";
import { handleRoute, HttpError, requireCronSecret } from "@/lib/server/http";
import { backfillModelledHistory, isModelledHistoryConfigured } from "@/lib/server/modelledHistory";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Loads a week of Google Air Quality modelled PM history into BigQuery
 * (`google_aq_history`) for every city's forecast zones, so forecasts have
 * history before the station table has 12 hourly readings. Same bearer
 * secret as /api/cron/tick. ?city=beijing limits it to one city.
 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    requireCronSecret(request);
    if (!isModelledHistoryConfigured()) throw new HttpError(503, "GOOGLE_AIR_QUALITY_API_KEY is not set.");
    const city = new URL(request.url).searchParams.get("city");
    if (city && !CITIES.some((candidate) => candidate.id === city)) throw new HttpError(400, "Unknown city.");
    const result = await backfillModelledHistory(city ? [city] : undefined);
    return NextResponse.json({ at: new Date().toISOString(), cities: result });
  });
}
