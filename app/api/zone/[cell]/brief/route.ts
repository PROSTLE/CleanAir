import { NextResponse } from "next/server";
import { enforceRateLimit, getClientIp, handleRoute, HttpError } from "@/lib/server/http";
import { getZoneBrief, isZoneBriefConfigured } from "@/lib/server/zoneBrief";
import { getZoneSummary, resolveZoneCell } from "@/lib/server/zoneSummary";
import { normalizeUiLanguage } from "@/lib/uiLanguages";

export const runtime = "nodejs";

/** Gemini's plain-language summary of a cell, in the viewer's UI language (cached). */
export async function GET(request: Request, { params }: { params: Promise<{ cell: string }> }) {
  return handleRoute(async () => {
    const cell = resolveZoneCell((await params).cell);
    if (!isZoneBriefConfigured()) throw new HttpError(503, "GEMINI_API_KEY is not set.");
    await enforceRateLimit("zone-brief", getClientIp(request), 10, 60 * 1000);
    const language = normalizeUiLanguage(new URL(request.url).searchParams.get("lang"));
    const summary = await getZoneSummary(cell);
    return NextResponse.json({ brief: await getZoneBrief(cell, summary, language) });
  });
}
