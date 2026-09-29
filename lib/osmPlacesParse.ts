// Pure selection of OpenStreetMap places (lib/server/osmPlaces.ts does the
// fetching), kept free of server-only imports so it can be unit-tested.
import type { CityConfig } from "@/lib/cities";
import { isInCity } from "@/lib/cities";
import type { KnownSource, KnownSourceKind } from "@/lib/knownSources";

// How many of each kind a city keeps, largest mapped area first.
export const LIMITS: Record<KnownSourceKind, number> = { landfill: 6, industrial_area: 10, traffic_hub: 6 };
// The subset the ambient scan also watches, for spots with no station.
export const MONITORED_LIMITS: Record<KnownSourceKind, number> = { landfill: 3, industrial_area: 5, traffic_hub: 2 };

export type OsmPlace = KnownSource & { osmId: string; areaKm2: number };

export type OverpassElement = {
  type: string;
  id: number;
  tags?: Record<string, string>;
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  lat?: number;
  lon?: number;
};

function kindOf(tags: Record<string, string>): KnownSourceKind | null {
  if (tags.landuse === "landfill") return "landfill";
  if (tags.landuse === "industrial") return "industrial_area";
  if (tags.amenity === "bus_station") return "traffic_hub";
  return null;
}

/** Turns Overpass elements into ranked places inside the city. */
export function selectPlaces(city: CityConfig, elements: OverpassElement[]): OsmPlace[] {
  const candidates: OsmPlace[] = [];
  for (const element of elements) {
    const tags = element.tags ?? {};
    const kind = kindOf(tags);
    if (!kind) continue;
    const box = element.bounds;
    const lat = box ? (box.minlat + box.maxlat) / 2 : element.lat;
    const lng = box ? (box.minlon + box.maxlon) / 2 : element.lon;
    if (typeof lat !== "number" || typeof lng !== "number" || !isInCity(city, lat, lng)) continue;
    const name = tags["name:en"]?.trim() || tags.name?.trim() || (kind === "landfill" ? "Landfill (unnamed on OSM)" : "");
    if (!name) continue;
    const kmPerDegLat = 111.32;
    const areaKm2 = box
      ? (box.maxlat - box.minlat) * kmPerDegLat * (box.maxlon - box.minlon) * kmPerDegLat * Math.cos((lat * Math.PI) / 180)
      : 0;
    candidates.push({ name, kind, lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5)), osmId: `${element.type}/${element.id}`, areaKm2: Number(areaKm2.toFixed(3)) });
  }
  const byArea = (a: OsmPlace, b: OsmPlace) => b.areaKm2 - a.areaKm2;
  return (Object.keys(LIMITS) as KnownSourceKind[]).flatMap((kind) => {
    // A site mapped as several areas keeps only its largest; unnamed landfills stay separate.
    const seen = new Set<string>();
    return candidates
      .filter((place) => place.kind === kind)
      .sort(byArea)
      .filter((place) => {
        if (place.name.startsWith("Landfill (unnamed")) return true;
        const key = place.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, LIMITS[kind]);
  });
}

