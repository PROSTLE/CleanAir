import "server-only";

import type { CityConfig } from "@/lib/cities";
import { adminDb, adminServerTimestamp } from "@/lib/firebaseAdmin";
import type { KnownSource, KnownSourceKind } from "@/lib/knownSources";
import { MONITORED_LIMITS, selectPlaces, type OsmPlace, type OverpassElement } from "@/lib/osmPlacesParse";

// Recurring emission sources for every city, read from OpenStreetMap through
// the Overpass API: mapped landfills, named industrial areas and named bus
// terminals inside the city boundary. Nothing is typed into the repo; a place
// appears because it is mapped, with its OSM id so anyone can check it.
// Results are stored in Firestore (`osmPlaces/{cityId}`) and refreshed weekly;
// if Overpass is unreachable and nothing is stored, a city simply has no
// places, and attribution falls back to fires and other incidents.
// Public Overpass instances, tried in order; some throttle shared cloud IPs.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const REFRESH_AFTER_MS = 7 * 24 * 3_600_000;
const MEMORY_TTL_MS = 6 * 3_600_000;
// After a failed fetch with nothing stored, wait before asking Overpass again.
const FAILURE_COOLDOWN_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 100_000;
const USER_AGENT = "VayuSetu/1.0 (air-quality hotspot research)";

const memory = new Map<string, { expiresAt: number; places: OsmPlace[] }>();
const inFlight = new Map<string, Promise<OsmPlace[]>>();
// Overpass allows few parallel requests per client; run them one at a time.
let queue: Promise<unknown> = Promise.resolve();

function overpassQuery(city: CityConfig) {
  const { minLat, minLng, maxLat, maxLng } = city.bounds;
  const bbox = [minLat, minLng, maxLat, maxLng].map((value) => value.toFixed(4)).join(",");
  return `[out:json][timeout:90];
(
  way["landuse"="landfill"](${bbox});
  relation["landuse"="landfill"](${bbox});
  way["landuse"="industrial"]["name"](${bbox});
  relation["landuse"="industrial"]["name"](${bbox});
  way["amenity"="bus_station"]["name"](${bbox});
  node["amenity"="bus_station"]["name"](${bbox});
);
out tags bb;`;
}

async function runOverpass(query: string): Promise<OverpassElement[]> {
  let lastError: unknown = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Overpass ${response.status}`);
      const payload = (await response.json()) as { elements?: OverpassElement[] };
      return payload.elements ?? [];
    } catch (error) {
      lastError = error;
      console.warn(`Overpass ${endpoint} failed`, error instanceof Error ? error.message : error);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Overpass unavailable.");
}

async function loadCityPlaces(city: CityConfig): Promise<OsmPlace[]> {
  const ref = adminDb.collection("osmPlaces").doc(city.id);
  const stored = await ref.get().catch(() => null);
  const storedData = stored?.data();
  const storedAt = storedData?.fetchedAt?.toDate?.()?.getTime?.() ?? 0;
  const storedPlaces = Array.isArray(storedData?.places) ? (storedData.places as OsmPlace[]) : null;
  if (storedPlaces && Date.now() - storedAt < REFRESH_AFTER_MS) return storedPlaces;

  try {
    const run = queue.then(() => runOverpass(overpassQuery(city)));
    queue = run.catch(() => undefined);
    const places = selectPlaces(city, await run);
    await ref.set({ fetchedAt: adminServerTimestamp(), places, source: "OpenStreetMap via Overpass API" }).catch(() => undefined);
    return places;
  } catch (error) {
    console.warn(`OpenStreetMap places for ${city.name} unavailable`, error instanceof Error ? error.message : error);
    // An older stored copy beats nothing; it is still real mapped data.
    return storedPlaces ?? [];
  }
}

/** Landfills, industrial areas and bus terminals mapped in OpenStreetMap inside the city. */
export async function getCityPlaces(city: CityConfig): Promise<OsmPlace[]> {
  const hit = memory.get(city.id);
  if (hit && hit.expiresAt > Date.now()) return hit.places;
  let pending = inFlight.get(city.id);
  if (!pending) {
    pending = loadCityPlaces(city).finally(() => inFlight.delete(city.id));
    inFlight.set(city.id, pending);
  }
  const places = await pending;
  memory.set(city.id, { expiresAt: Date.now() + (places.length > 0 ? MEMORY_TTL_MS : FAILURE_COOLDOWN_MS), places });
  return places;
}

/** The places the ambient scan watches even without a station: the largest of each kind. */
export async function getMonitoredAreas(city: CityConfig): Promise<Array<{ label: string; lat: number; lng: number; osmId: string }>> {
  const places = await getCityPlaces(city);
  return (Object.keys(MONITORED_LIMITS) as KnownSourceKind[]).flatMap((kind) =>
    places
      .filter((place) => place.kind === kind)
      .slice(0, MONITORED_LIMITS[kind])
      .map((place) => ({ label: place.name, lat: place.lat, lng: place.lng, osmId: place.osmId })),
  );
}

/** Every mapped source in the city, for upwind attribution. */
export async function getKnownSources(city: CityConfig | null | undefined): Promise<KnownSource[]> {
  if (!city) return [];
  return (await getCityPlaces(city).catch(() => [])).map(({ name, kind, lat, lng }) => ({ name, kind, lat, lng }));
}
