import { NextResponse } from "next/server";
import { applyResidentClosure } from "@/lib/server/closure";
import { enforceRateLimit, getClientIp, handleRoute, HttpError, readJson } from "@/lib/server/http";
import { verifyReportToken } from "@/lib/server/reportTokens";

export const runtime = "nodejs";

/**
 * The reporter answers "is it fixed?" for their own report. The token is the
 * one /api/reports handed to the browser that filed it.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const { id } = await params;
    const reportId = id?.trim();
    if (!reportId || reportId.includes("/")) throw new HttpError(400, "A valid report id is required.");

    await enforceRateLimit("closure", getClientIp(request), 20, 60 * 60 * 1000);
    const body = await readJson<{ token?: string; answer?: string }>(request);
    if (body.answer !== "fixed" && body.answer !== "not_fixed") {
      throw new HttpError(400, "answer must be fixed or not_fixed.");
    }
    if (!(await verifyReportToken(reportId, body.token))) {
      throw new HttpError(403, "Only the device that filed this report can answer for it.");
    }

    return NextResponse.json(await applyResidentClosure(reportId, body.answer, "web"));
  });
}
