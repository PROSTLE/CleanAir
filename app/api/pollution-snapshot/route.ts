import { NextResponse } from "next/server";
import { getNearestStationReading } from "@/lib/cpcbSensor";
import { getSatelliteDataForPoint } from "@/lib/earthEngineSatellite";
import { getWindData } from "@/lib/openWeather";
import { recordPollutionSnapshot } from "@/lib/pollutionSnapshots";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  const locationLabel = url.searchParams.get("label");

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json(
      { error: "lat and lng query params are required numbers." },
      { status: 400 },
    );
  }

  const [sensor, satellite, wind] = await Promise.all([
    getNearestStationReading(lat, lng),
    getSatelliteDataForPoint(lat, lng),
    getWindData(lat, lng),
  ]);
  const snapshot = await recordPollutionSnapshot({
    lat,
    lng,
    locationLabel,
    satellite,
    sensor,
    sourceContext: "manual_poll",
    wind,
  });

  return NextResponse.json(
    {
      ok: snapshot.stored,
      snapshotId: snapshot.id,
      reason: snapshot.reason,
      data: {
        satellite,
        sensor,
        wind,
      },
    },
    { status: snapshot.stored ? 200 : 502 },
  );
}
