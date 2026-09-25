import { NextResponse } from "next/server";
import { handleRoute, readJson, requireOperator } from "@/lib/server/http";
import { getAndStoreIncidentContext, loadTarget } from "@/lib/server/incidentContext";

export const runtime = "nodejs";

/**
 * Field context for one incident: live wind + upwind source ranking, NASA
 * FIRMS fires, schools/hospitals within 1 km, and the Google Air Quality
 * cross-check. Operator-only because it spends paid API quota.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    await requireOperator(request);
    const body = await readJson<{ collection?: string; id?: string }>(request);
    const target = await loadTarget(body.collection, body.id);
    const context = await getAndStoreIncidentContext(target);
    return NextResponse.json({ context });
  });
}
