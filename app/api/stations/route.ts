import { NextResponse } from "next/server";
import { findCity } from "@/lib/cities";
import { isOpenAqConfigured } from "@/lib/server/openaq";
import { isWaqiConfigured } from "@/lib/server/waqi";
import { fetchCityStationDirectory } from "@/lib/stations";

export const runtime = "nodejs";

/**
 * Ground monitoring stations inside one city, at the coordinates their feed
 * publishes, merged from the city's feeds (OpenAQ, WAQI, CPCB). Stations that
 * haven't reported in the last day are included with `stale: true`, their
 * last-reported time and no values. Feeds are cached server-side.
 */
export async function GET(request: Request) {
  const city = findCity(new URL(request.url).searchParams.get("city") ?? "delhi");
  if (!city) return NextResponse.json({ stations: [], error: "Unknown city." }, { status: 400 });

  const stations = (await fetchCityStationDirectory(city)).map((station) => ({
    name: station.stationName,
    lat: station.lat,
    lng: station.lng,
    pm25: station.pm25,
    pm10: station.pm10,
    lastUpdated: station.lastUpdated,
    source: station.source,
    attribution: station.attribution,
    stale: station.stale,
  }));

  if (stations.length === 0) {
    const sources = city.stations.sources;
    const missing = [
      sources.includes("openaq") && !isOpenAqConfigured() && "OPENAQ_API_KEY",
      sources.includes("waqi") && !isWaqiConfigured() && "WAQI_API_TOKEN",
    ].filter(Boolean);
    const reason = missing.length
      ? `No station feed answered for ${city.name}; ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set.`
      : `No station feed answered for ${city.name}.`;
    return NextResponse.json({ stations: [], error: reason }, { status: 503 });
  }

  return NextResponse.json(
    { stations, network: city.stations.network },
    { headers: { "Cache-Control": "public, max-age=600" } },
  );
}
