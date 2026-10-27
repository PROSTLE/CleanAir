import { NextResponse } from "next/server";
import { CITIES } from "@/lib/cities";
import { FEDERATION_CACHE_HEADERS, FEDERATION_VERSION, publicOrigin } from "@/lib/server/federation";

export const runtime = "nodejs";

/**
 * Discovery document for the open federation API: which cities this node
 * covers and where each feed lives. A partner city or state system reads
 * this once, then polls the feeds it needs.
 */
export async function GET(request: Request) {
  const base = `${publicOrigin(request)}/api/federation/${FEDERATION_VERSION}`;
  return NextResponse.json(
    {
      publisher: "VayuSetu",
      version: FEDERATION_VERSION,
      generatedAt: new Date().toISOString(),
      description:
        "Open, read-only feeds of hyperlocal pollution hotspots and transboundary smoke advisories for interoperability between cities and states.",
      formats: {
        hotspots: "GeoJSON (RFC 7946)",
        advisories: "GeoJSON (RFC 7946), one LineString trajectory per advisory",
        alerts: "CAP 1.2 (OASIS), listed in an Atom index",
      },
      cityParam: "A city id, 'india' (default: the six Indian cities), 'brics' or 'all'.",
      feeds: {
        hotspots: `${base}/hotspots?city={city}`,
        advisories: `${base}/advisories?city={city}`,
        capIndex: `${base}/cap?city={city}`,
        capAlert: `${base}/cap/{identifier}`,
      },
      cities: CITIES.map((city) => ({
        id: city.id,
        name: city.name,
        region: city.region,
        country: city.country,
        group: city.group,
        center: city.center,
        standards: city.standards,
        aqiScale: city.aqiScale,
      })),
      dataSources: [
        "Citizen photo reports classified by Gemini",
        "CPCB / state-board stations via OpenAQ, WAQI and data.gov.in",
        "Sentinel-5P NO2 and aerosol index via Earth Engine",
        "NASA FIRMS active fires via Earth Engine",
        "Open-Meteo forecast wind",
      ],
      privacy: "No citizen notes, photos, typed addresses or reporter details are published.",
      caveats:
        "Transboundary advisories are screening estimates (forward trajectory on forecast wind), not a dispersion model.",
    },
    { headers: FEDERATION_CACHE_HEADERS },
  );
}
