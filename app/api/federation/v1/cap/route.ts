import { buildCapAtomFeed, type CapFeedEntry } from "@/lib/cap";
import {
  FEDERATION_CACHE_HEADERS,
  listOpenHotspots,
  publicOrigin,
  resolveCityParam,
} from "@/lib/server/federation";
import { enforceRateLimit, getClientIp, handleRoute, HttpError } from "@/lib/server/http";
import { getTransboundaryAdvisories } from "@/lib/server/transboundary";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Atom index of current CAP 1.2 alerts: transboundary advisories and promoted hotspots. */
export async function GET(request: Request) {
  return handleRoute(async () => {
    await enforceRateLimit("federation", getClientIp(request), 60, 60 * 1000);
    const url = new URL(request.url);
    const cityParam = url.searchParams.get("city");
    const { cities, error } = resolveCityParam(cityParam);
    if (error) throw new HttpError(400, error);

    const origin = publicOrigin(request);
    const capBase = `${origin}/api/federation/v1/cap`;
    const ids = new Set(cities.map((city) => city.id));
    const [results, hotspots] = await Promise.all([
      Promise.all(cities.map((city) => getTransboundaryAdvisories(city.id))),
      listOpenHotspots().catch(() => []),
    ]);

    const entries: CapFeedEntry[] = [
      ...results.flatMap((result) =>
        result.advisories.map((advisory) => ({
          id: advisory.id,
          title: `Transboundary smoke: ${advisory.source.label} → ${advisory.cityName} (~${Math.round(advisory.etaHours)} h)`,
          updated: new Date(advisory.issuedAt),
          summary: `${advisory.fireCount} fire pixels, level ${advisory.level}, ${advisory.distanceKm} km away.`,
          capUrl: `${capBase}/${advisory.id}`,
        })),
      ),
      ...hotspots
        .filter((hotspot) => ids.has(hotspot.cityId))
        .map((hotspot) => ({
          id: `vayusetu-inc-${hotspot.id}`,
          title: `${hotspot.hazardType} hotspot in ${hotspot.cityName}`,
          updated: hotspot.updatedAt,
          summary: `Evidence: ${hotspot.tier}; status ${hotspot.status}.`,
          capUrl: `${capBase}/vayusetu-inc-${hotspot.id}`,
        })),
    ];

    const xml = buildCapAtomFeed({
      id: `urn:vayusetu:cap:${cityParam ?? "india"}`,
      title: `VayuSetu air-quality alerts (${cityParam ?? "india"})`,
      selfUrl: url.toString(),
      updated: new Date(),
      entries,
    });
    return new Response(xml, {
      headers: { ...FEDERATION_CACHE_HEADERS, "Content-Type": "application/atom+xml; charset=utf-8" },
    });
  });
}
