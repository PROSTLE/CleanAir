import { NextResponse } from "next/server";
import { FEDERATION_CACHE_HEADERS, publicOrigin, resolveCityParam } from "@/lib/server/federation";
import { enforceRateLimit, getClientIp, handleRoute, HttpError } from "@/lib/server/http";
import { getTransboundaryAdvisories } from "@/lib/server/transboundary";
import { summarizeBySourceState } from "@/lib/transboundary";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Transboundary smoke advisories: fire clusters outside each city whose
 * smoke, on the forecast wind, reaches it within 48 h. GeoJSON, one
 * LineString (the estimated trajectory) per advisory, plus the same
 * advisories grouped by source state for the authorities there.
 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    await enforceRateLimit("federation", getClientIp(request), 60, 60 * 1000);
    const { cities, error } = resolveCityParam(new URL(request.url).searchParams.get("city"));
    if (error) throw new HttpError(400, error);

    const origin = publicOrigin(request);
    const results = await Promise.all(cities.map((city) => getTransboundaryAdvisories(city.id)));
    const advisories = results.flatMap((result) => result.advisories);
    return NextResponse.json(
      {
        type: "FeatureCollection",
        generatedAt: new Date().toISOString(),
        method:
          "NASA FIRMS fire pixels (48 h) within 400 km, grouped on a 0.5° grid; forward trajectory on Open-Meteo hourly forecast wind (120 m, else 10 m) with plume spread. Screening estimate, not a dispersion model.",
        cities: results.map((result) => ({
          cityId: result.cityId,
          cityName: result.cityName,
          computedAt: result.computedAt,
          advisories: result.advisories.length,
          clustersConsidered: result.clustersConsidered,
          firesConsidered: result.firesConsidered,
          firesTruncated: result.firesTruncated,
          fireWindow: result.fireWindow,
          windLevel: result.windLevel,
          error: result.error ?? null,
        })),
        bySourceState: summarizeBySourceState(advisories),
        features: advisories.map((advisory) => {
          const { path, ...properties } = advisory;
          return {
            type: "Feature",
            id: advisory.id,
            geometry: { type: "LineString", coordinates: path },
            properties: { ...properties, cap: `${origin}/api/federation/v1/cap/${advisory.id}` },
          };
        }),
      },
      { headers: FEDERATION_CACHE_HEADERS },
    );
  });
}
