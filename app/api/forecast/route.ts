import { NextResponse } from "next/server";
import { getForecastForCell } from "@/lib/server/forecastService";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const h3CellId = new URL(request.url).searchParams.get("h3CellId")?.trim();
  if (!h3CellId) {
    return NextResponse.json(
      {
        error: "Missing query parameter: h3CellId (an H3 resolution-8 cell inside a monitored city).",
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
