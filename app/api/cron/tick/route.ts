import { NextResponse } from "next/server";
import { runScheduledTick } from "@/lib/server/cron";
import { handleRoute, requireCronSecret } from "@/lib/server/http";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Scheduled pipeline run. Point Cloud Scheduler at this every 30 minutes:
 *   gcloud scheduler jobs create http vayusetu-tick --schedule="*\/30 * * * *" \
 *     --uri="https://<host>/api/cron/tick" --http-method=GET \
 *     --headers="Authorization=Bearer <CRON_SECRET>"
 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    requireCronSecret(request);
    const summary = await runScheduledTick(new URL(request.url).origin);
    return NextResponse.json(summary);
  });
}
