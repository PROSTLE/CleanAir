import { NextResponse } from "next/server";
import { classifyReport } from "@/lib/server/classifyReport";
import { enforceRateLimit, getClientIp, handleRoute, HttpError, readJson } from "@/lib/server/http";

export const runtime = "nodejs";

/**
 * Classifies one report. Called by the WhatsApp bot after it stores a report,
 * and usable for manual retries. Web reports are classified server-side by
 * /api/reports and swept by /api/cron/tick, so browsers no longer drive this.
 * classifyReport() is idempotent, so replaying a request never re-bills Gemini.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const body = await readJson<{ finalAttempt?: boolean; reportId?: string }>(request);
    const reportId = body.reportId?.trim();
    if (!reportId) throw new HttpError(400, "Missing reportId.");

    await enforceRateLimit("classify", getClientIp(request), 60, 60 * 60 * 1000);

    try {
      const result = await classifyReport(reportId, {
        finalAttempt: body.finalAttempt,
        origin: new URL(request.url).origin,
      });
      return NextResponse.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown classification error.";
      throw new HttpError(message === "Report not found." ? 404 : 500, message);
    }
  });
}
