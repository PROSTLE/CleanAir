import { NextResponse } from "next/server";
import { getWindData } from "@/lib/openWeather";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json(
      {
        error: "lat and lng query params are required numbers.",
        source: "OpenWeatherMap",
      },
      { status: 400 },
    );
  }

  const result = await getWindData(lat, lng);
  if (!result) {
    return NextResponse.json(
      {
        error: "OpenWeatherMap wind data is unavailable.",
        source: "OpenWeatherMap",
      },
      { status: 502 },
    );
  }

  return NextResponse.json(result);
}
