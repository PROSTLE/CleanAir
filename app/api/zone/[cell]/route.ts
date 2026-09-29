import { NextResponse } from "next/server";
import { enforceRateLimit, getClientIp, handleRoute } from "@/lib/server/http";
import { getZoneSummary, resolveZoneCell } from "@/lib/server/zoneSummary";

export const runtime = "nodejs";

/** Public summary of one H3 cell for the area page (/zone/[cell]). */
export async function GET(request: Request, { params }: { params: Promise<{ cell: string }> }) {
  return handleRoute(async () => {
    const cell = resolveZoneCell((await params).cell);
    await enforceRateLimit("zone", getClientIp(request), 30, 60 * 1000);
    return NextResponse.json(await getZoneSummary(cell), { headers: { "Cache-Control": "no-store" } });
  });
}
