import { NextResponse } from "next/server";
import { findCity } from "@/lib/cities";
import { getRegionalFireHotspots } from "@/lib/earthEngineSatellite";

export const runtime = "nodejs";

/**
 * NASA FIRMS active fires (last 48 h) across one city's upwind region
 * (lib/cities.ts fireRegion), via Earth Engine. Cached server-side for an
 * hour per city, so this public route costs at most one Earth Engine
 * computation per city per hour per instance.
 */
export async function GET(request: Request) {
  const city = findCity(new URL(request.url).searchParams.get("city") ?? "delhi");
  if (!city) return NextResponse.json({ fires: [], error: "Unknown city." }, { status: 400 });

  const result = await getRegionalFireHotspots(city.id);
  return NextResponse.json(result, {
    status: result.error ? 503 : 200,
    headers: { "Cache-Control": "public, max-age=600" },
  });
}
