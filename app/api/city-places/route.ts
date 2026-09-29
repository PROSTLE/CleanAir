import { NextResponse } from "next/server";
import { findCity } from "@/lib/cities";
import { getCityPlaces, getMonitoredAreas } from "@/lib/server/osmPlaces";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * The landfills, industrial areas and bus terminals mapped in OpenStreetMap
 * inside a city, and the subset the ambient scan watches. Each carries its
 * OSM id (e.g. way/76727509) so it can be checked on openstreetmap.org.
 */
export async function GET(request: Request) {
  const city = findCity(new URL(request.url).searchParams.get("city"));
  if (!city) return NextResponse.json({ error: "Unknown city." }, { status: 400 });
  const [places, monitored] = await Promise.all([getCityPlaces(city), getMonitoredAreas(city)]);
  return NextResponse.json(
    { cityId: city.id, source: "OpenStreetMap", places, monitored },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
