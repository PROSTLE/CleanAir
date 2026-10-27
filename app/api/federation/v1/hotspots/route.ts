import { NextResponse } from "next/server";
import {
  FEDERATION_CACHE_HEADERS,
  listOpenHotspots,
  publicOrigin,
  resolveCityParam,
} from "@/lib/server/federation";
import { enforceRateLimit, getClientIp, handleRoute, HttpError } from "@/lib/server/http";

export const runtime = "nodejs";

/** Open, promoted hotspots as a GeoJSON FeatureCollection. */
export async function GET(request: Request) {
  return handleRoute(async () => {
    await enforceRateLimit("federation", getClientIp(request), 60, 60 * 1000);
    const { cities, error } = resolveCityParam(new URL(request.url).searchParams.get("city"));
    if (error) throw new HttpError(400, error);

    const origin = publicOrigin(request);
    const ids = new Set(cities.map((city) => city.id));
    const hotspots = (await listOpenHotspots()).filter((hotspot) => ids.has(hotspot.cityId));
    return NextResponse.json(
      {
        type: "FeatureCollection",
        generatedAt: new Date().toISOString(),
        cities: [...ids],
        features: hotspots.map((hotspot) => ({
          type: "Feature",
          id: hotspot.id,
          geometry: { type: "Point", coordinates: [hotspot.lng, hotspot.lat] },
          properties: {
            cityId: hotspot.cityId,
            h3CellId: hotspot.h3CellId,
            hazardType: hotspot.hazardType,
            evidenceTier: hotspot.tier,
            severity: hotspot.severity,
            status: hotspot.status,
            confidencePct: hotspot.confidencePct,
            detectedBy: hotspot.source,
            createdAt: hotspot.createdAt,
            updatedAt: hotspot.updatedAt.toISOString(),
            areaPage: hotspot.h3CellId ? `${origin}/zone/${hotspot.h3CellId}` : null,
            cap: `${origin}/api/federation/v1/cap/vayusetu-inc-${hotspot.id}`,
          },
        })),
      },
      { headers: FEDERATION_CACHE_HEADERS },
    );
  });
}
