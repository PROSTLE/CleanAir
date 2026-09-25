import { NextResponse } from "next/server";
import { isGeminiConfigured } from "@/lib/server/gemini";
import { handleRoute, HttpError, readJson, requireOperator } from "@/lib/server/http";
import { buildIncidentContext, loadTarget, type IncidentContext } from "@/lib/server/incidentContext";
import { generateWorkOrder } from "@/lib/server/workOrder";

export const runtime = "nodejs";

const CONTEXT_REUSE_MS = 30 * 60 * 1000;

/** Gemini-drafted, bilingual (EN/HI) work order grounded in the incident's evidence. */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const operator = await requireOperator(request);
    if (!isGeminiConfigured()) throw new HttpError(503, "GEMINI_API_KEY is not set.");
    const body = await readJson<{ collection?: string; id?: string }>(request);
    const target = await loadTarget(body.collection, body.id);

    // Reuse context the operator already loaded if it's recent.
    const stored = target.data.operatorContext as IncidentContext | undefined;
    const storedAgeMs = stored?.fetchedAt ? Date.now() - Date.parse(stored.fetchedAt) : Infinity;
    const context =
      stored && storedAgeMs < CONTEXT_REUSE_MS
        ? stored
        : await buildIncidentContext(target).catch(() => null);

    // UID, not email: incident docs are publicly readable.
    const workOrder = await generateWorkOrder(target, context, operator.uid);
    return NextResponse.json({ workOrder });
  });
}
