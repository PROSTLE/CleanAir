import { NextResponse } from "next/server";
import { DELHI_H3_CELLS } from "@/lib/forecastEngine";
import { getForecastForCell } from "@/lib/server/forecastService";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const h3CellId = new URL(request.url).searchParams.get("h3CellId")?.trim();
  if (!h3CellId) {
    return NextResponse.json(
      {
        error: `Missing query parameter: h3CellId. Example: /api/forecast?h3CellId=${DELHI_H3_CELLS[0]?.h3CellId}`,
      },
      { status: 400 },
    );
  }

  const result = await getForecastForCell(h3CellId);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, h3CellId, source: "unavailable" },
      { status: result.status, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { forecast, ok: _ok, ...rest } = result;
  void _ok;
  return NextResponse.json(
    { ...forecast, ...rest },
    { headers: { "Cache-Control": "no-store" } },
  );
}
