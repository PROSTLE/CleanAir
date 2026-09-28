import { NextResponse } from "next/server";
import { findCity } from "@/lib/cities";
import { fetchCityStationReadings } from "@/lib/stations";

export const runtime = "nodejs";

/**
 * Ground monitoring stations inside one city, at the coordinates their feed
 * publishes: CPCB (data.gov.in) for Delhi, WAQI for the other capitals.
 * Feeds are cached server-side for 15 minutes.
 */
export async function GET(request: Request) {
  const city = findCity(new URL(request.url).searchParams.get("city") ?? "delhi");
  if (!city) return NextResponse.json({ stations: [], error: "Unknown city." }, { status: 400 });

  const stations = (await fetchCityStationReadings(city)).map((station) => ({
    name: station.stationName,
    lat: station.lat,
    lng: station.lng,
    pm25: station.pm25,
    pm10: station.pm10,
    lastUpdated: station.lastUpdated,
    source: station.source,
    attribution: station.attribution,
  }));

  if (stations.length === 0) {
    const reason =
      city.stations.provider === "waqi" && !process.env.WAQI_API_TOKEN?.trim()
        ? "WAQI_API_TOKEN is not set."
        : `${city.stations.network} returned no stations.`;
    return NextResponse.json({ stations: [], error: reason }, { status: 503 });
  }

  return NextResponse.json(
    { stations, network: city.stations.network },
    { headers: { "Cache-Control": "public, max-age=600" } },
  );
}
