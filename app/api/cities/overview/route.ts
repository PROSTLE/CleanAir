import { NextResponse } from "next/server";
import { AQI_SCALES, medianStationAqi } from "@/lib/aqiScales";
import { CITIES, isInCity } from "@/lib/cities";
import { adminDb } from "@/lib/firebaseAdmin";
import { fetchCityStationDirectory } from "@/lib/stations";

export const runtime = "nodejs";
export const maxDuration = 60;

// Every figure here is read live from the station feeds and Firestore; the
// response is cached briefly so a busy landing page doesn't refetch them.
const CACHE_TTL_MS = 5 * 60 * 1000;

type CityOverview = {
  id: string;
  name: string;
  region: string;
  group: string;
  liveStations: number;
  offlineStations: number;
  aqi: { value: number; category: string; color: string; dominant: string; basis: string; scaleLabelKey: string } | null;
  openHotspots: number | null;
  feedsAnswered: boolean;
};

let cached: { expiresAt: number; body: { at: string; cities: CityOverview[] } } | null = null;
let pending: Promise<{ at: string; cities: CityOverview[] }> | null = null;

async function openIncidentLocations(): Promise<Array<{ lat: number; lng: number }> | null> {
  try {
    const snapshot = await adminDb.collection("incidents").where("status", "!=", "resolved").get();
    // Incident locations are stored as strings or numbers depending on who wrote them.
    return snapshot.docs
      .map((doc) => {
        const location = doc.data().location as { lat?: number | string; lng?: number | string } | undefined;
        return { lat: Number(location?.lat), lng: Number(location?.lng) };
      })
      .filter((location) => Number.isFinite(location.lat) && Number.isFinite(location.lng));
  } catch (error) {
    console.warn("City overview: incidents unavailable", error instanceof Error ? error.message : error);
    return null;
  }
}

async function build() {
  const [directories, incidents] = await Promise.all([
    Promise.all(CITIES.map((city) => fetchCityStationDirectory(city).catch(() => null))),
    openIncidentLocations(),
  ]);
  const cities: CityOverview[] = CITIES.map((city, index) => {
    const stations = directories[index] ?? [];
    const scale = AQI_SCALES[city.aqiScale];
    const median = medianStationAqi(stations, scale);
    return {
      id: city.id,
      name: city.name,
      region: city.region,
      group: city.group,
      liveStations: stations.filter((station) => !station.stale).length,
      offlineStations: stations.filter((station) => station.stale).length,
      aqi: median
        ? {
            value: median.aqi.aqi,
            category: median.aqi.info.category,
            color: median.aqi.info.color,
            dominant: median.aqi.dominant,
            basis: median.aqi.basis,
            scaleLabelKey: scale.labelKey,
          }
        : null,
      openHotspots: incidents ? incidents.filter((location) => isInCity(city, location.lat, location.lng)).length : null,
      feedsAnswered: directories[index] !== null && stations.length > 0,
    };
  });
  return { at: new Date().toISOString(), cities };
}

/** Live station counts, city AQI and open hotspots for every monitored city. */
export async function GET() {
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.body, { headers: { "Cache-Control": "public, max-age=120" } });
  }
  pending ??= build().finally(() => (pending = null));
  const body = await pending;
  cached = { expiresAt: Date.now() + CACHE_TTL_MS, body };
  return NextResponse.json(body, { headers: { "Cache-Control": "public, max-age=120" } });
}
