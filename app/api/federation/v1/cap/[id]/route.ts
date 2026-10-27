import { advisoryToCap, buildCapXml, hotspotToCap } from "@/lib/cap";
import { findCity } from "@/lib/cities";
import { FEDERATION_CACHE_HEADERS, listOpenHotspots, publicOrigin, senderFor } from "@/lib/server/federation";
import { enforceRateLimit, getClientIp, handleRoute, HttpError } from "@/lib/server/http";
import { getTransboundaryAdvisories } from "@/lib/server/transboundary";

export const runtime = "nodejs";
export const maxDuration = 120;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

/** One CAP 1.2 alert, by the identifier listed in the Atom index. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    await enforceRateLimit("federation", getClientIp(request), 60, 60 * 1000);
    const id = (await params).id;
    if (!ID_PATTERN.test(id)) throw new HttpError(400, "Invalid alert identifier.");

    const origin = publicOrigin(request);
    const sender = senderFor(origin);
    let xml: string | null = null;

    if (id.startsWith("tb-")) {
      // tb-<cityId>-<cluster>-<hour>; city ids may contain hyphens (abu-dhabi).
      const cityId = id.slice(3).replace(/--?[0-9p]+_-?[0-9p]+-\d{10}$/, "");
      const city = findCity(cityId);
      if (!city) throw new HttpError(404, "Unknown alert.");
      const advisory = (await getTransboundaryAdvisories(city.id)).advisories.find((entry) => entry.id === id);
      if (advisory) {
        xml = buildCapXml(
          advisoryToCap(advisory, { sender, web: `${origin}/federation#city-${city.id}`, cityCenter: city.center }),
        );
      }
    } else if (id.startsWith("vayusetu-inc-")) {
      const incidentId = id.slice("vayusetu-inc-".length);
      const hotspot = (await listOpenHotspots()).find((entry) => entry.id === incidentId);
      if (hotspot) {
        const web = hotspot.h3CellId ? `${origin}/zone/${hotspot.h3CellId}` : `${origin}/map`;
        xml = buildCapXml(hotspotToCap(hotspot, { sender, web }));
      }
    }

    if (!xml) throw new HttpError(404, "This alert has expired or does not exist.");
    return new Response(xml, {
      headers: { ...FEDERATION_CACHE_HEADERS, "Content-Type": "application/cap+xml; charset=utf-8" },
    });
  });
}
