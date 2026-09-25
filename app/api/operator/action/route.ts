import { NextResponse } from "next/server";
import { handleRoute, readJson, requireOperator } from "@/lib/server/http";
import { loadTarget } from "@/lib/server/incidentContext";
import { applyOperatorAction, parseOperatorAction } from "@/lib/server/operatorActions";

export const runtime = "nodejs";

/** Dispatch / resolve / mark false positive. Operator-only; writes via Admin SDK. */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const operator = await requireOperator(request);
    const body = await readJson<{ collection?: string; id?: string; action?: string }>(request);
    const target = await loadTarget(body.collection, body.id);
    const result = await applyOperatorAction(target, parseOperatorAction(body.action), operator);
    return NextResponse.json(result);
  });
}
