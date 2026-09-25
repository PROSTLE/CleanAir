import { NextResponse } from "next/server";
import { getRegionalFireHotspots } from "@/lib/earthEngineSatellite";

export const runtime = "nodejs";

/**
 * NASA FIRMS active fires (last 48 h) across Punjab, Haryana and Delhi NCR,
 * via Earth Engine. Cached server-side for an hour, so this public route
 * costs at most one Earth Engine computation per hour per instance.
 */
export async function GET() {
  const result = await getRegionalFireHotspots();
  return NextResponse.json(result, {
    status: result.error ? 503 : 200,
    headers: { "Cache-Control": "public, max-age=600" },
  });
}
