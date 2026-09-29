import { NextResponse } from "next/server";
import { enforceRateLimit, getClientIp, handleRoute, HttpError } from "@/lib/server/http";
import { getCellRecurrence } from "@/lib/server/incidentEvents";
import type { RecurrenceSummary } from "@/lib/recurrence";
import { resolveZoneCell } from "@/lib/server/zoneSummary";

export const runtime = "nodejs";

const MAX_CELLS = 20;

/** 30-day recurrence for several cells at once (dashboard queue chips). */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const raw = new URL(request.url).searchParams.get("cells") ?? "";
    const cells = [...new Set(raw.split(",").map((cell) => cell.trim()).filter(Boolean))];
    if (cells.length === 0) throw new HttpError(400, "Pass cells=<h3>,<h3>,…");
    if (cells.length > MAX_CELLS) throw new HttpError(400, `At most ${MAX_CELLS} cells per request.`);
    await enforceRateLimit("zone-recurrence", getClientIp(request), 30, 60 * 1000);

    const entries = await Promise.all(
      cells.map(async (raw): Promise<[string, RecurrenceSummary | { error: string }]> => {
        try {
          const cell = resolveZoneCell(raw);
          return [cell.h3CellId, await getCellRecurrence(cell.h3CellId)];
        } catch (error) {
          return [raw, { error: error instanceof Error ? error.message : String(error) }];
        }
      }),
    );
    return NextResponse.json({ cells: Object.fromEntries(entries) }, { headers: { "Cache-Control": "no-store" } });
  });
}
