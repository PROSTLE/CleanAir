import { NextResponse } from "next/server";
import { fetchAllStationReadings } from "@/lib/cpcbSensor";
import { isInOperationalRegion } from "@/lib/operationalRegion";

export const runtime = "nodejs";

/**
 * CPCB/DPCC continuous monitoring stations inside Delhi NCT, at the exact
 * coordinates the CPCB real-time feed (data.gov.in) publishes for them.
 * The feed is cached server-side for 15 minutes in lib/cpcbSensor.ts.
 */
export async function GET() {
  const stations = (await fetchAllStationReadings())
    .filter((station) => isInOperationalRegion(station.lat, station.lng))
    .map((station) => ({
      name: station.stationName,
      lat: station.lat,
      lng: station.lng,
      pm25: station.pm25,
      pm10: station.pm10,
      lastUpdated: station.lastUpdated,
    }));

  if (stations.length === 0) {
    return NextResponse.json(
      { stations: [], error: "CPCB station feed unavailable." },
      { status: 503 },
    );
  }

  return NextResponse.json(
    { stations },
    { headers: { "Cache-Control": "public, max-age=600" } },
  );
}
