import { NextResponse } from "next/server";
import { getHealthAdvice, isAirQualityConfigured } from "@/lib/server/googleAirQuality";
import { enforceRateLimit, getClientIp, handleRoute, HttpError } from "@/lib/server/http";
import { resolveZoneCell } from "@/lib/server/zoneSummary";
import { normalizeUiLanguage } from "@/lib/uiLanguages";

export const runtime = "nodejs";

/** Google Air Quality health recommendations for the cell centre, in the UI language. */
export async function GET(request: Request, { params }: { params: Promise<{ cell: string }> }) {
  return handleRoute(async () => {
    const cell = resolveZoneCell((await params).cell);
    if (!isAirQualityConfigured()) throw new HttpError(503, "GOOGLE_AIR_QUALITY_API_KEY is not set.");
    await enforceRateLimit("zone-health", getClientIp(request), 20, 60 * 1000);
    const language = normalizeUiLanguage(new URL(request.url).searchParams.get("lang"));
    return NextResponse.json({ advice: await getHealthAdvice(cell.lat, cell.lng, language) });
  });
}
