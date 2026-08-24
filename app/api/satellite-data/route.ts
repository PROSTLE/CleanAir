import { NextResponse } from "next/server";
import { getSatelliteDataForPoint } from "@/lib/earthEngineSatellite";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json(
      {
        error: "lat and lng query params are required numbers.",
        rawValue: null,
        anomalyScore: 0,
        source: "Earth Engine / Sentinel-5P",
        timestamp: new Date().toISOString(),
      },
      { status: 400 },
    );
  }

  const result = await getSatelliteDataForPoint(lat, lng);
  return NextResponse.json(result, { status: result.error ? 502 : 200 });
}
